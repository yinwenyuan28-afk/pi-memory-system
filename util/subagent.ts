import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSubagent } from "./spawn.ts";

/** 派发选项。`profilePath` / `agentDir` 由调用方给（它们本来就有），不靠环境变量猜。 */
export interface RunSubagentOptions {
	/** profile 根目录（运行记录与子进程日志的落盘位置）。 */
	profilePath?: string;
	/** pi 的 agent 根目录（读 `settings.json` 的 `subagents.defaultModel`）。 */
	agentDir?: string;
	/** 哪一层（l1/l2/l3/skill/review）——写运行记录用。 */
	layer?: string;
	/** 对应 jobs.sqlite 的 jobId——写运行记录用（停止序列靠它找 pid）。 */
	jobId?: number;
	/** 子进程工作目录；缺省取 ctx.cwd。 */
	cwd?: string;
}

/**
 * 派发一个**后台**子代理（自建 spawn，**零 pi-subagents 依赖**）。
 *
 * ── 为什么不再走 pi-subagents 的 RPC ──────────────────────────────────────
 * 2026-10-01 之前这里走 `subagents:rpc:v1` 事件总线。它是上游官方集成面，但桥接层
 * （`pi-subagents/src/extension/index.ts:385`，0.74.0 的 `index.js:631` 逐字相同）
 * 硬编码 `getContext: () => state.lastUiContext`，**不接受调用方传入的 ctx**；
 * 而 pi 在 session 替换/reload 时会 `invalidate()` 该缓存 ⇒ 派发必然失败
 * （实测 `This extension ctx is stale after session replacement or reload`）。
 * 详见 `plan/memory-system/SELF_SPAWN_PLAN.md`。
 *
 * ── 为什么 `ctx` 只用来取 cwd ─────────────────────────────────────────────
 * 旧签名带 `ctx` / `timeoutMs` / `externalSignal` 三个参数，但**一个都没真正用上**：
 *   - `ctx`：RPC 桥接层根本不收它（旧实现白传）。现在只剩 cwd 有意义。
 *   - `timeoutMs`：RPC 版也没往上游传——6 个 agent 定义都没有 `timeoutMs`，上游在
 *     `config.timeoutMs === undefined` 时不设任何超时；传了反而会给长跑的 L1 引入一个
 *     未经确认的 10 分钟硬上限。子代理真正的停止线是配置中心 `subagent.hardMs`
 *     走活性门控（`waitJobWithLiveness`），与派发无关。
 *   - `externalSignal`：旧实现透传给 executor，但上游 `runAsyncPath` 解构的 16 个字段里
 *     **没有 signal** —— 异步子代理跑在独立子进程里由自己的 `config.timeoutMs` 判定，
 *     那个 abort 从来没生效过。
 * 这两个参数已从签名移除（它们是死参数，留着会误导后来人以为超时在这里管）。
 *
 * @param agent 子代理名（对应 `agents/<agent>.md`）
 * @param task  任务描述
 * @param ctx   扩展上下文——**只用来取 cwd**
 * @param opts  profile / agent 根 / layer / jobId
 * @returns 子代理 pid（停止序列与残留回收靠它）
 * @throws 找不到 agent 定义 / 找不到 pi 入口 / spawn 失败——都立即抛，
 *         由 `failFastOnSpawnFailure` 进调用方 catch 释放 job，绝不干等
 */
export async function runPiSubagent(
	agent: string,
	task: string,
	ctx?: ExtensionContext,
	opts: RunSubagentOptions = {},
): Promise<number> {
	const profilePath = opts.profilePath || process.env.PI_PROFILE_PATH || "";
	if (!profilePath) {
		throw new Error("无法派发子代理：profilePath 未设置（主进程应在 session_start 设好 PI_PROFILE_PATH）");
	}
	const agentDir = opts.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

	const spawned = spawnSubagent({
		agent,
		task,
		profilePath,
		agentDir,
		layer: opts.layer || layerOf(agent),
		jobId: opts.jobId ?? 0,
		cwd: opts.cwd || ctx?.cwd,
	});
	return spawned.pid;
}

/**
 * 由 agent 名推出层名（写运行记录 / 日志用；调用方也可在 opts.layer 显式覆盖）。
 */
function layerOf(agent: string): string {
	if (agent.startsWith("l1")) return "l1";
	if (agent.startsWith("l2")) return "l2";
	if (agent.startsWith("l3")) return "l3";
	if (agent.startsWith("skill")) return "skill";
	if (agent.startsWith("memory")) return "review";
	return agent;
}

/**
 * 把「派发子代理」与「等待 job 完成」赛跑：**派发失败要立刻冒泡，不能只记日志后干等。**
 *
 * ── 为什么需要它（2026-10-01 事故）──────────────────────────────────────────
 * l1 / l2 / l3 三层此前都是这个写法：
 *
 * ```ts
 * const spawnP = runPiSubagent(...);
 * void spawnP.catch((err) => logEvent("l1", `spawn later: ${err.message}`));  // 只记日志
 * const outcome = await waitP;                                                // 干等到硬阈值
 * ```
 *
 * 派发失败时子代理压根没起来，job 永远等不到完成信号，只能挂在 `running` 直到硬上限
 * ——**默认 45 分钟**。而管线是串行单飞的，这段时间内 L2 / L3 全部堵在 `queued`。
 * 一个派发失败被放大成整条记忆管线停摆。实测：L1 派发失败后 L2 卡在队列里，
 * jobs.sqlite 里一个 running + 一个 queued。
 *
 * 改成赛跑后，派发失败立刻进调用方的 catch —— 那里本来就有完整的失败处理
 * （失败计数 + 告警卡 + `db.complete(job.id,"failed")` 释放槽位），不用新写一套。
 *
 * ── 内部的 unhandled rejection 处理 ────────────────────────────────────────
 * 两条 Promise 赛跑，**落败的那条**如果之后 reject，在 Node 里就是 unhandledRejection。
 * 两种落败都要兜住：
 * - `waitP` 落败（派发先失败）：`waitP` 之后若 reject 无人接 ⇒ 加 `.catch()`；
 * - `spawnP` 落败（job 先完成）：`guard` 是 `spawnP` 的派生 Promise，reject 无人接 ⇒ 加 `.catch()`。
 *
 * @param spawnP  `runPiSubagent()` 的返回值（派发成功=已 spawn，失败=reject）
 * @param waitP   等待 job 完成的 Promise（如 `waitJobWithLiveness`）
 * @param onError 派发失败时的日志回调（无论它是否赢得赛跑都会调用，便于保留现场）
 * @returns 与 `waitP` 相同的产出；派发失败则以派发的错误 reject
 */
export function failFastOnSpawnFailure<T>(
	spawnP: Promise<unknown>,
	waitP: Promise<T>,
	onError?: (err: unknown) => void,
): Promise<T> {
	// 派发成功 → 永不 settle，把等待权完整交给 waitP；派发失败 → 以同一错误冒泡。
	const guard: Promise<T> = spawnP.then(() => new Promise<never>(() => {}));
	// 落败方的兜底。这一个 catch 同时干两件事：接住 reject（否则 job 先完成、派发后
	// 失败时就是 unhandledRejection）+ 记日志保留现场。
	void guard.catch((err: unknown) => {
		onError?.(err);
	});
	void waitP.catch(() => {});
	return Promise.race([waitP, guard]);
}
