import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * pi 后台子代理执行器桥接类型。
 *
 * 实际实现由宿主（pi-subagents）注入到 globalThis.__piSubagentExecutor，
 * 本扩展不持有其类型定义，故这里用最小契约描述其签名（参数载荷为宿主契约，
 * 以 any 承载是必要而非随意）。
 */
type PiSubagentExecutor = (
	id: string,
	params: any,
	signal: AbortSignal,
	onUpdate: any,
	ctx: ExtensionContext,
) => Promise<any>;

/**
 * 通过 globalThis.__piSubagentExecutor 启动一个后台子代理，并与之赛跑超时。
 *
 * 行为：
 * - 取不到 executor（宿主未注入）→ 直接 throw。
 * - 在 timeoutMs 内未结束 → AbortController.abort() + reject（错误含 agent 名与毫秒数）。
 * - 正常结束 → 返回子代理调用 id。
 *
 * 调用方通常不需要消费返回值：子代理的产出经各自的 commit 工具落盘（records /
 * scene_blocks / USER.md），而非通过此返回值回传。
 *
 * 这是 l1 / l2 / l3 / review 四处原本复制粘贴的同一段逻辑的单一真相源。
 *
 * @param agent     子代理名（如 "l1-extractor" / "l2-scene-organizer"）
 * @param task      任务描述文本
 * @param ctx       扩展上下文（含 ui / sessionManager 等）
 * @param timeoutMs 超时毫秒；超过则 abort 并 reject
 * @param externalSignal 可选；调用方稍后 abort 可取消已 spawn 的子代理（async:true 时函数可能已返回）
 */
export async function runPiSubagent(
	agent: string,
	task: string,
	ctx: ExtensionContext,
	timeoutMs: number,
	externalSignal?: AbortSignal,
): Promise<string> {
	const executor = (globalThis as unknown as { __piSubagentExecutor?: PiSubagentExecutor })[
		"__piSubagentExecutor"
	];
	if (!executor) throw new Error("pi-subagents executor not available");

	const id = randomUUID();
	const controller = new AbortController();
	const abortFromExternal = () => {
		if (!controller.signal.aborted) controller.abort();
	};
	if (externalSignal?.aborted) abortFromExternal();
	else externalSignal?.addEventListener("abort", abortFromExternal);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const executorPromise = executor(
		id,
		{ agent, task, async: true, clarify: false, agentScope: "both" },
		controller.signal,
		undefined,
		ctx,
	);

	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			abortFromExternal();
			reject(new Error(`subagent ${agent} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	try {
		await Promise.race([executorPromise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
		// 不 removeEventListener：async:true 时本函数在 spawn 后返回，调用方仍需能 abort。
	}
	return id;
}
