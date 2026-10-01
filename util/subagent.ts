import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * pi-subagents 后台子代理派发通道（RPC 客户端）。
 *
 * ── 为什么走事件总线而不是直接调执行器 ──────────────────────────────────────
 * 旧实现读 `globalThis.__piSubagentExecutor`。那个全局变量**不是 pi-subagents
 * 上游提供的**，而是本机给其源码打的私有补丁（见 scripts/patches/README.md：
 * 「pi 升级 / 重装该包后 node_modules 被覆盖，补丁就没了」）。依赖它等于把插件
 * 钉死在作者本机，别人装上必然失效。
 *
 * 现实现改用上游 README 明确提供给第三方扩展的官方集成面 `subagents:rpc:v1`
 * 事件总线（README:263「Other Pi extensions can use the versioned in-process
 * event-bus RPC instead of ... calling internal modules」）。pi-subagents 激活时
 * 注册的 bridge（其 src/extension/index.ts 内 `registerSubagentRpcBridge`）**走的是
 * 与 `subagent` 工具完全相同的 executor**，因此 agent 发现、spawn 预算、子代理深度
 * 限制、session 归属、artifacts、async 状态**行为与旧路径一致**。
 *
 * ── 协议常量为何硬编码 ──────────────────────────────────────────────────────
 * pi-subagents 的 package.json `exports` 是封闭映射（只有 `.`、`./background-work`、
 * `./delegation` 三个入口，无 `./*` 通配），**无法 import** src/extension/rpc.ts 里的
 * 三个常量。以下三个字符串是协议标识，硬编码是上游唯一可行的接法（上游 README 自己的
 * 示例代码同样是硬编码字符串）。⚠ **升级 pi-subagents 大版本时必须重新核对这三个名字**，
 * 否则表现为「派发后收不到回复」——见下方 SPAWN_REPLY_TIMEOUT_MS 的错误文案。
 */
const RPC_PROTOCOL_VERSION = 1;
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_READY_EVENT = "subagents:rpc:v1:ready";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

/**
 * spawn 请求的**往返**超时（毫秒）。
 *
 * 注意与「子代理运行时长」是两件事：RPC 的 spawn 是异步派发，桥接层在子进程拉起后
 * 立刻回复（上游 `executeAsyncSingle` 返回 async-started 消息即 resolve），正常在
 * 毫秒级。所以这个值只需覆盖事件总线往返，不是子代理跑多久。
 *
 * 之所以要有它：若 pi-subagents 缺席 / 版本不兼容 / 扩展未激活，桥接层根本没注册监听，
 * 永远不会有回复——没有这个兜底就会**永久挂起**，调用方的 job 永远不返回。
 * 取 30s：够覆盖进程内事件往返，又不至于让失败场景长时间空等。
 */
const SPAWN_REPLY_TIMEOUT_MS = 30_000;

/** 进程内事件总线（由 initSubagentBridge 在扩展激活时注入）。 */
type EventBus = { on(channel: string, handler: (data: unknown) => void): () => void; emit(channel: string, data: unknown): void };

let eventBus: EventBus | undefined;
/** 是否观察到过桥接层的 ready 广播（pi-subagents 在 session_start 时发）。仅用于日志与错误文案。 */
let bridgeReadySeen = false;

/**
 * 注册子代理派发通道。**必须由扩展入口在激活时调用一次**（index.ts 的 default 导出里）。
 *
 * 传 pi（ExtensionAPI）而不是 ctx（ExtensionContext）：事件总线挂在 ExtensionAPI 上
 * （`ExtensionAPI.events`，见 pi-coding-agent 的 extensions/types.d.ts）。选择在这里
 * 存下来而不是把 pi 一路透传到 7 处调用点，是为了不改动那些调用点。
 *
 * **刻意 fail-soft**：宿主没给 events（或以不完整对象做冒烟测试）时**不抛错**，
 * 只是不注册通道。理由——这是扩展入口的第一行，一旦抛异常整个 memory-system
 * 加载失败，所有工具（l1_commit / recall 等）全部消失，代价远大于「子代理派不出去」。
 * 派发时的报错交给 runPiSubagent：它会明确告诉用户需要 pi-subagents 包。
 *
 * @param pi 扩展 API（仅用到其 events 字段）
 * @returns 是否成功注册（false = 宿主未提供 events，子代理派发将不可用）
 */
export function initSubagentBridge(pi: ExtensionAPI): boolean {
	if (eventBus) return true; // 幂等：/reload 或重复激活时不重复订阅
	const bus = pi?.events;
	if (!bus || typeof bus.on !== "function" || typeof bus.emit !== "function") return false;
	eventBus = bus;
	// ready 由桥接层在 session_start 广播（上游 src/extension/index.ts）。此处只置标记，
	// 不做「必须等到 ready 才允许派发」的强门禁——本扩展的派发点（agent_settled 与
	// slash 命令）都发生在 session_start 之后，强门禁只会引入无谓的失败路径。
	bus.on(RPC_READY_EVENT, () => {
		bridgeReadySeen = true;
	});
	return true;
}

/** 桥接层是否已就绪（供启动自检与日志使用）。 */
export function isSubagentBridgeReady(): boolean {
	return eventBus !== undefined;
}

/** 从 RPC 回复信封里取真实 runId（spawn 的 data.details.runId）。 */
function extractRunId(data: unknown): string | undefined {
	const details = (data as { details?: { runId?: unknown } } | undefined)?.details;
	return typeof details?.runId === "string" ? details.runId : undefined;
}

/** 把 RPC 错误信封转成人能读的一句话（供日志与 job 失败原因用）。 */
function describeRpcFailure(agent: string, error: unknown): string {
	const e = error as { code?: unknown; message?: unknown } | undefined;
	const code = typeof e?.code === "string" ? e.code : "unknown";
	const message = typeof e?.message === "string" ? e.message : JSON.stringify(error);
	return `subagent ${agent} spawn rejected by pi-subagents RPC [${code}]: ${message}`;
}

/**
 * 通过 pi-subagents 的 `subagents:rpc:v1` 事件总线派发一个**后台**子代理。
 *
 * 行为：
 * - 扩展未 initSubagentBridge → throw（提示本扩展需要 pi-subagents）。
 * - 发出 spawn 请求后等桥接层回复；`async: true` 下桥接层在子进程拉起后立即回复，
 *   因此本函数与旧实现一样是「派发即返回」，调用方随后靠各自的 job 等待逻辑轮询落盘结果。
 * - 超过 SPAWN_REPLY_TIMEOUT_MS 仍无回复 → reject（说明桥接层不存在/协议名不匹配）。
 * - 桥接层回错误信封 → reject（带上游 error code 与 message）。
 * - 正常 → 返回**真实的 runId**（旧实现返回的是本地 uuid，pi-subagents 侧根本不读它）。
 *
 * 调用方通常不需要消费返回值：子代理的产出经各自的 commit 工具落盘（records /
 * scene_blocks / USER-temp.md），而非通过此返回值回传。
 *
 * ── 关于 timeoutMs 与 externalSignal（重要语义说明）──────────────────────────
 * 这两个参数**保留是为了不改动 7 处调用点**，本通道不再用它们控制子代理生死：
 * - 旧实现把 AbortSignal 透传给 executor，但上游 `runAsyncPath` 解构的 16 个字段里
 *   **没有 signal**，异步子代理跑在独立 detached 子进程中、由子进程自己的
 *   `config.timeoutMs` 判定——所以旧代码那个 10 分钟 abort **从来没真正杀过子代理**，
 *   只是让本地 Promise reject 了一下。
 * - 因此这里**刻意不向 RPC 传 `timeoutMs`**：6 个子代理定义的 frontmatter 都没有
 *   `timeoutMs` 字段，上游 `subagent-runner` 在 `config.timeoutMs === undefined` 时
 *   **不设任何超时**。若这里传 600_000，等于给原本可以长跑的 L1 提取引入一个新的
 *   10 分钟硬上限，属于未经确认的行为变更（可能截断长批次）。
 *   「让超时配置真正生效」是独立议题（计划 P1-10：当前配置里的 hardMs 与代码里的
 *   600_000 是两套真源），需先收敛配置口径再改这里。
 *
 * @param agent     子代理名（如 "l1-extractor" / "l2-scene-organizer"）
 * @param task      任务描述文本
 * @param ctx       扩展上下文。**当前通道不使用**（桥接层自取 ExtensionContext 派发），
 *                  保留仅为不改动调用点；将来若需按会话差异化派发可在此接入。
 * @param timeoutMs 保留参数，当前通道不使用（见上方语义说明）
 * @param externalSignal 保留参数，当前通道不使用（见上方语义说明）
 * @returns 子代理的真实 runId（pi-subagents 侧可用于 status / stop RPC）
 */
export async function runPiSubagent(
	agent: string,
	task: string,
	ctx?: ExtensionContext,
	timeoutMs?: number,
	externalSignal?: AbortSignal,
): Promise<string> {
	if (!eventBus) {
		throw new Error(
			`subagent bridge not initialized: cannot dispatch "${agent}". ` +
				`memory-system requires the pi-subagents package (settings.json -> packages: ["npm:pi-subagents"]); ` +
				`call initSubagentBridge(pi) from the extension entry before dispatching.`,
		);
	}
	const bus = eventBus;
	const requestId = randomUUID();
	const replyEvent = RPC_REPLY_PREFIX + requestId;

	return new Promise<string>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (unsubscribe) unsubscribe();
			fn();
		};

		unsubscribe = bus.on(replyEvent, (raw) => {
			const reply = raw as {
				success?: unknown;
				data?: unknown;
				error?: unknown;
			};
			if (reply?.success === false) {
				finish(() => reject(new Error(describeRpcFailure(agent, reply.error))));
				return;
			}
			// 成功但拿不到 runId 时退回 requestId：调用方本就不消费该值，
			// 记日志比抛错更有用（派发其实已经成功）。
			const runId = extractRunId(reply?.data) ?? requestId;
			finish(() => resolve(runId));
		});

		timer = setTimeout(() => {
			finish(() =>
				reject(
					new Error(
						`subagent ${agent}: no RPC reply within ${SPAWN_REPLY_TIMEOUT_MS}ms from pi-subagents bridge. ` +
							`Likely causes: pi-subagents not installed/enabled, or its rpc event names changed ` +
							`(this client hardcodes "${RPC_REQUEST_EVENT}" for protocol v${RPC_PROTOCOL_VERSION}). ` +
							`bridge ready seen: ${bridgeReadySeen}.`,
					),
				),
			);
		}, SPAWN_REPLY_TIMEOUT_MS);

		bus.emit(RPC_REQUEST_EVENT, {
			version: RPC_PROTOCOL_VERSION,
			requestId,
			method: "spawn",
			// async / clarify 由桥接层强制为 true / false，这里不传（传 async:false 会被拒）。
			params: { agent, task },
		});
	});
}
