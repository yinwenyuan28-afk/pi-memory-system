import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { waitWhileRunning } from "./worker.ts";
import { isProcessAlive } from "./run-lock.ts";
// 类型从 jobs-db 直接取：worker.ts 只是 import 了它、并没有 re-export（类型门禁会抓这个 —— 实测抓到了）
import type { PipelineJob } from "./jobs-db.ts";
import { DEFAULT_HARD_MS, DEFAULT_SOFT_MS } from "./timeout-config.ts";
import { logEvent } from "../../util/notice.ts";

/**
 * 子代理「活性」观测与超时判定。
 *
 * ── 历史（2026-09-21，SUBAGENT_THROUGHPUT T1）──────────────────
 * 当时为两件事引入：① 到点就 abort 会掐死正在干活的子代理（L1 job 70、L2 job 68 都是"标失败后还在写"）；
 * ② 用户看不出它在动（一次生成可静默几分钟）。做法是"到点先看子代理会话文件是否还在长"。
 *
 * ── 2026-09-26 转向（SUBAGENT_LIVENESS_FIX）────────────────────
 * 实测（L2 job 76）证明那个判据**原理上不成立**：`session.jsonl` 是**按轮写入**的 ——
 * 一次 LLM 生成期间文件一个字节都不涨，生成结束才落一条。job 76 的单轮生成 **987 秒**，
 * 期间心跳 66 行全是 `本段 +0`，于是 630s 处被判「静默=已死」→ 假告警 + 失败计数 +1 +
 * **提前释放队列槽位**（子代理仍在写场景块；队列恰好为空才没并发两个写者）。
 *
 * 结论与现行语义：
 *   · **mtime 只能证「活着」，不能证「停了」** ⇒ 不再参与判死（`decideTimeoutAction` 已删）。
 *   · **软阈值**（`softMs`）到点：只落一行日志 + 继续等，不动计数、不发卡片、不放槽位。
 *   · **硬上限**（`hardMs`）到点：返回 `reason="hard"`，由调用方走"停掉子代理"的序列
 *     （见 `subagent-kill.ts`）。
 *   · 判定"它结束了"一律用**确定性落盘产物**：commit 工具把 job 标 done（真完成信号）/
 *     宿主的 `status.json`（`state` 进终态）。
 */

/** 一次采样：会话文件大小与"静默了多久"。定位不到时为 -1（未知）。 */
export interface SessionSample {
	size: number;
	silentMs: number;
}

/** 采样一个会话文件；`file` 为 undefined 或读不到 → `{ size: -1, silentMs: -1 }`。 */
export function sampleSession(file: string | undefined, nowMs = Date.now()): SessionSample {
	if (!file) return { size: -1, silentMs: -1 };
	try {
		const st = statSync(file);
		return { size: st.size, silentMs: Math.max(0, nowMs - st.mtimeMs) };
	} catch {
		return { size: -1, silentMs: -1 };
	}
}

// ══════════════════════════════════════════════════════════════
//  等待阶段判定（纯函数，可离线测）
// ══════════════════════════════════════════════════════════════

export type WaitPhase = "continue" | "suspect" | "over";

/**
 * 墙钟走到哪儿了。**注意这里没有 mtime 参数** —— 这是 2026-09-26 的有意删除：
 * 静默既不能证死、也不能证停，放在判定里只会误导（详见文件头）。
 */
export function decideWaitPhase(input: { elapsedMs: number; softMs: number; hardMs: number }): WaitPhase {
	if (input.elapsedMs >= input.hardMs) return "over";
	if (input.elapsedMs >= input.softMs) return "suspect";
	return "continue";
}

// ══════════════════════════════════════════════════════════════
//  最长单轮生成（观测：把"在慢慢想"变成数字）
// ══════════════════════════════════════════════════════════════

function entryTimestampMs(o: unknown): number | undefined {
	if (!o || typeof o !== "object") return undefined;
	const rec = o as { timestamp?: unknown; ts?: unknown };
	for (const v of [rec.timestamp, rec.ts]) {
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string") {
			const t = Date.parse(v);
			if (Number.isFinite(t)) return t;
		}
	}
	return undefined;
}

/**
 * 会话文件里**相邻条目的最大时间间隔**（= 最长单轮生成）。
 *
 * 为什么需要：job 76 的关键事实就是这个数（987 秒）——文件字节数看不出它，只有条目时间戳能算出来。
 * 解析不出（无文件 / 条目 < 2 / 时间戳缺失）→ `undefined`，调用方按"未知"处理。
 */
export function longestEntryGapMs(sessionFile: string | undefined): number | undefined {
	if (!sessionFile) return undefined;
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf-8");
	} catch {
		return undefined;
	}
	const times: number[] = [];
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (!t) continue;
		try {
			const ms = entryTimestampMs(JSON.parse(t));
			if (ms !== undefined) times.push(ms);
		} catch {
			// 坏行跳过
		}
	}
	if (times.length < 2) return undefined;
	let max = 0;
	for (let i = 1; i < times.length; i++) max = Math.max(max, times[i] - times[i - 1]);
	return max;
}

// ══════════════════════════════════════════════════════════════
//  宿主 async run 的 status.json（确定性信号）
//
//  宿主为每个后台子代理落一份 `{tmp}/pi-subagents-<scope>/async-subagent-runs/<runId>/status.json`，
//  字段含 `state`（`queued`/`running`/终态）、`pid`、`sessionId`（父会话）、`lastActivityAt`、
//  `steps[].sessionFile`（子代理自己的会话）。本机实测：`…/pi-subagents-user-leaf/async-subagent-runs/f6f00d9d…/status.json`。
//
//  三个用途：① 判"这趟真的结束了"（`state` 进终态）；② 取 `pid` 供停止序列杀进程树；
//  ③ 拿 `steps[].sessionFile` 确定性定位子代理会话（不再靠 mtime 猜）。
//  **它是宿主内部布局**（在系统临时目录下），跨版本可能变 ⇒ 全部 fail-soft：读不到按"未知"处理。
// ══════════════════════════════════════════════════════════════

// ── 以下原为 pi-subagents 私有布局的解析（AsyncRunInfo / readAsyncRunInfo /
// candidateAsyncRoots / findAsyncRun / locateSubagentSession / resolveSubagentSession），
// 2026-10-01 自建 spawn 后整体删除：子进程由本扩展自己 spawn，pid 落在
// `memory/pipeline/subagent-runs.ts` 的运行记录里，session 文件由 `--session-dir`
// 指定在我们自己的目录下，不需要再去猜宿主把文件放哪。
// 判定逻辑（decideWaitPhase / waitJobWithLiveness）与心跳（startHeartbeat）保持不变——
// 它们本来就只依赖「墙钟 + jobs.sqlite 的 job 状态」，不读任何 pi-subagents 产物。

// ══════════════════════════════════════════════════════════════
//  等待与心跳
// ══════════════════════════════════════════════════════════════

export interface LivenessWaitOptions {
	/** 软阈值：到点只提示（默认 10 分钟）。 */
	softMs?: number;
	/** 硬上限：到点返回 `reason="hard"`，由调用方停掉子代理（默认 30 分钟）。 */
	hardMs?: number;
	/** 轮询间隔（默认沿用 waitWhileRunning 的 400ms）。 */
	pollMs?: number;
	/** 落盘上下文（日志用）。 */
	profilePath?: string;
	/** 层名（日志 scope，如 "l1"/"l2"/"l3"）。 */
	layer: string;
	/** job id（日志用）。 */
	jobId: number;
}

export interface LivenessWaitOutcome {
	/** 最后一次读到的 job —— 仍是 `running` 表示"确实到硬上限了"。 */
	job: PipelineJob | undefined;
	reason: "settled" | "hard";
	elapsedMs: number;
	/**
	 * 最长单轮生成（观测）。自建 spawn 后不再从 session 文件算——那个定位依赖
	 * pi-subagents 的私有布局，已删除；调用方若需要可自行从 `--session-dir` 下的
	 * jsonl 统计。恒为 undefined，保留字段是为了不破坏既有调用点的解构。
	 */
	longestTurnMs?: number;
	/** 同上：恒为 undefined，仅保留字段形状。 */
	sessionFile?: string;
}

// 阈值的**默认值**住在 `timeout-config.ts`（可被配置中心 `subagent` 节覆盖；
// 2026-09-26 从本文件的常量搬过去，因为它们是"按实测观测调"的量，不该硬编码）。

/**
 * 等 job 离开 `running`；软阈值到点只提示，硬上限到点才交还控制权。
 *
 * 返回 `reason="hard"` 时 job **仍是 running**，调用方应走"停掉子代理"的序列
 * （`subagent-kill.ts`）——不要再自行 abort 了事（abort 停不掉它，只会把账记错）。
 */
export async function waitJobWithLiveness(
	getJob: () => PipelineJob | undefined,
	opts: LivenessWaitOptions,
): Promise<LivenessWaitOutcome> {
	const softMs = opts.softMs ?? DEFAULT_SOFT_MS;
	const hardMs = Math.max(opts.hardMs ?? DEFAULT_HARD_MS, softMs);
	const startedAt = Date.now();
	let softNoticed = false;

	for (;;) {
		const elapsed = Date.now() - startedAt;
		if (decideWaitPhase({ elapsedMs: elapsed, softMs, hardMs }) === "over") {
			return {
				job: getJob(),
				reason: "hard",
				elapsedMs: elapsed,
			};
		}
		// 本轮只等到"下一个里程碑"（软阈值或硬上限），避免软阈值被硬上限的整段等待吞掉
		const nextMilestone = softNoticed ? hardMs : Math.min(softMs, hardMs);
		const waitMs = Math.max(500, nextMilestone - elapsed);
		const job = await waitWhileRunning(getJob, waitMs, opts.pollMs);
		if (!job || job.status !== "running") {
			return {
				job,
				reason: "settled",
				elapsedMs: Date.now() - startedAt,
			};
		}
		if (!softNoticed && Date.now() - startedAt >= softMs) {
			softNoticed = true;
			logEvent(
				opts.layer,
				`job ${opts.jobId} 软阈值 ${(softMs / 1000).toFixed(0)}s：子代理仍在运行 → 继续等`,
				opts.profilePath,
			);
			continue;
		}
	}
}

/**
 * 心跳：纯观测（不参与判定），每 `heartbeatMs` 一行日志 + 可选回调（刷 footer）。
 *
 * **2026-10-01 自建 spawn 后改口径**：原先报的是「session 文件多大、本段涨了多少字节」，
 * 那个定位依赖 pi-subagents 的私有布局，已删除，于是每行都打成「子代理会话 未定位到」
 * ——纯粹是噪声。现在直接报**子进程是否还活着**：pid 是我们自己 spawn 时拿到的，
 * `isProcessAlive` 是确定性的判定，不需要任何猜测。
 *
 * 顺带说明：原先那句「静默≠已死」的经验依然成立（一次长生成期间 session 文件可以
 * 一个字节都不涨，实测 987s），只是现在不再需要靠文件大小去近似这个概念了。
 */
export function startHeartbeat(opts: {
	layer: string;
	jobId: number;
	profilePath?: string;
	/** 子进程 pid 的**惰性**读取：心跳在派发之前就启动了，那时 pid 还不存在。
	 *  不传就只报耗时、不报存活。 */
	getPid?: () => number | undefined;
	heartbeatMs?: number;
	onTick?: (info: { elapsedMs: number; alive: boolean | undefined }) => void;
}): () => void {
	const heartbeatMs = opts.heartbeatMs ?? 30_000;
	const startedAt = Date.now();
	const timer = setInterval(() => {
		const now = Date.now();
		const pid = opts.getPid?.();
		const alive = typeof pid === "number" ? isProcessAlive(pid) : undefined;
		opts.onTick?.({ elapsedMs: now - startedAt, alive });
		logEvent(
			opts.layer,
			`job ${opts.jobId} 运行 ${((now - startedAt) / 1000).toFixed(0)}s` +
				`（子进程 ${pid ?? "尚未派发"} ${alive === undefined ? "" : alive ? "存活" : "**已退出**"}）`,
			opts.profilePath,
		);
	}, heartbeatMs);
	return () => clearInterval(timer);
}
