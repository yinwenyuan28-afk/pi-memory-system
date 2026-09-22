import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { waitWhileRunning } from "./worker.ts";
// 类型从 jobs-db 直接取：worker.ts 只是 import 了它、并没有 re-export（类型门禁会抓这个 —— 实测抓到了）
import type { PipelineJob } from "./jobs-db.ts";
import { logEvent } from "../../util/notice.ts";

/**
 * 子代理「活性」观测与超时判定（2026-09-21 新增，属 SUBAGENT_THROUGHPUT 的 T1）。
 *
 * ── 两个实测事故逼出来的两件事 ──────────────────────────────
 *
 * ① **到点就 abort 会掐死正在干活的子代理**：L1 job 70 在 00:03:27 被标 `failed`，子代理
 *    00:10:47 才提交（活没白干，靠 `reclaimTimedOutL1` 把账纠回来）；L2 job 68 在 00:36 标失败，
 *    00:46 还在写场景块。可见当时的"超时"判的是**墙钟到点**，不是"它死了"。
 * ② **用户看不出它在动**：TUI 只有 footer 一行，一次生成可以静默几分钟（实测最长 9.5 分钟零事件），
 *    "慢"与"死"从外观上无法区分 —— 那一晚因此被误判三次。
 *
 * 规则：到点先看**子代理会话文件是否还在长**（它是子代理自己写的落盘产物，与"真完成信号"
 * 同款原则 —— `runPiSubagent` 的 promise、主进程计时器都不代表它在干活）：
 *   · 仍在动（静默 < `silentThresholdMs`）且延长额度没用完 → 续期 `extendStepMs`，继续等；
 *   · 真静默 / 额度用完 / 会话定位不到 → 返回 job，由调用方走原失败路径（标 failed + abort）。
 * 全程每 `heartbeatMs` 打一行心跳（已运行时长 + 会话字节数 + 本段增长）—— 这是 ② 的可观测面。
 */

/** 一次采样：会话文件大小与"静默了多久"。定位不到时为 -1（未知，判定按不延长处理）。 */
export interface SessionSample {
	size: number;
	silentMs: number;
}

export type TimeoutAction = "continue" | "extend" | "abort";

/**
 * 纯函数：到点后该怎么办（可离线测）。
 *
 * `silentMs < 0`（定位不到会话）→ **不延长**：宁可按时失败，也不要凭未知信号拖住整条队列。
 */
export function decideTimeoutAction(input: {
	elapsedMs: number;
	deadlineMs: number;
	silentMs: number;
	extendedMs: number;
	maxExtendMs: number;
	silentThresholdMs: number;
}): TimeoutAction {
	if (input.elapsedMs < input.deadlineMs) return "continue";
	if (input.extendedMs >= input.maxExtendMs) return "abort";
	if (input.silentMs < 0) return "abort";
	return input.silentMs < input.silentThresholdMs ? "extend" : "abort";
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

/**
 * 找到"最近被创建的子代理 run 会话"：`<父会话目录>/<子代理id>/run-N/session.jsonl`，按 mtime 取最新。
 * 本机实测该布局成立（560dcec5 / f6aa63a8 / 6a0e3733 …）。
 *
 * ⚠ 已知风险：同一会话目录下若同时有**别的**子代理在跑（例如另一个 agent 任务），可能取到它的会话，
 * 于是活性判到了别人身上。后果仅限于"该失败的多等一会儿"（最多到 `maxExtendMs`），不会写错数据；
 * 定位不到时返回 undefined → 判定按"未知 = 不延长"处理。
 */
export function locateSubagentSession(parentSessionFile: string | undefined): string | undefined {
	if (!parentSessionFile) return undefined;
	const sessionDir = join(dirname(parentSessionFile), basename(parentSessionFile, ".jsonl"));
	let subdirs: string[];
	try {
		subdirs = readdirSync(sessionDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return undefined;
	}
	let best: { path: string; mtimeMs: number } | undefined;
	for (const sub of subdirs) {
		const subDir = join(sessionDir, sub);
		let runs: string[];
		try {
			runs = readdirSync(subDir, { withFileTypes: true })
				.filter((d) => d.isDirectory() && d.name.startsWith("run-"))
				.map((d) => d.name);
		} catch {
			continue;
		}
		for (const run of runs) {
			const file = join(subDir, run, "session.jsonl");
			try {
				const st = statSync(file);
				if (!best || st.mtimeMs > best.mtimeMs) best = { path: file, mtimeMs: st.mtimeMs };
			} catch {
				// 还没落盘 → 跳过
			}
		}
	}
	return best?.path;
}

export interface LivenessWaitOptions {
	/** 基础等待窗口（= 该层子代理超时 + 宽限）。 */
	baseMs: number;
	/** 每次延长的毫秒数（默认 180_000 = 3 分钟）。 */
	extendStepMs?: number;
	/** 延长总额度（默认 = baseMs，即"最多等到 2×"）。 */
	maxExtendMs?: number;
	/** 静默多久算"它没在动"（默认 120_000；须大于一次长生成的正常波动）。 */
	silentThresholdMs?: number;
	/** 轮询间隔（默认沿用 waitWhileRunning 的 400ms）。 */
	pollMs?: number;
	/** 惰性定位子代理会话（只在到点判定时调用，避免每次轮询都 readdir）。 */
	locate: () => string | undefined;
	/** 判定发生时的落盘上下文（日志用）。 */
	profilePath?: string;
	/** 层名（日志 scope，如 "l1"/"l2"/"l3"）。 */
	layer: string;
	/** job id（日志用）。 */
	jobId: number;
}

/**
 * 等 job 离开 `running`；到点先看活性，还在动就续期（见文件头注释）。
 * 返回最后一次读到的 job —— 仍是 `running` 表示"确实该失败"，调用方照原路径处理。
 */
export async function waitJobWithLiveness(
	getJob: () => PipelineJob | undefined,
	opts: LivenessWaitOptions,
): Promise<PipelineJob | undefined> {
	const extendStepMs = opts.extendStepMs ?? 180_000;
	const maxExtendMs = opts.maxExtendMs ?? opts.baseMs;
	const silentThresholdMs = opts.silentThresholdMs ?? 120_000;
	const startedAt = Date.now();
	let deadlineMs = opts.baseMs;
	let extendedMs = 0;

	for (;;) {
		const remaining = deadlineMs - (Date.now() - startedAt);
		const job = await waitWhileRunning(getJob, Math.max(500, remaining), opts.pollMs);
		if (!job || job.status !== "running") return job;

		const sample = sampleSession(opts.locate());
		const action = decideTimeoutAction({
			elapsedMs: Date.now() - startedAt,
			deadlineMs,
			silentMs: sample.silentMs,
			extendedMs,
			maxExtendMs,
			silentThresholdMs,
		});
		if (action === "extend") {
			extendedMs += extendStepMs;
			deadlineMs += extendStepMs;
			logEvent(
				opts.layer,
				`job ${opts.jobId} 到点但子代理仍在写盘（静默 ${(sample.silentMs / 1000).toFixed(0)}s，会话 ${sample.size} 字节）` +
					`→ 续期 ${(extendStepMs / 1000).toFixed(0)}s（已延 ${(extendedMs / 1000).toFixed(0)}s / 上限 ${(maxExtendMs / 1000).toFixed(0)}s）`,
				opts.profilePath,
			);
			continue;
		}
		return job;
	}
}

/** 心跳：纯观测（不参与判定），每 `heartbeatMs` 一行日志 + 可选回调（刷 footer）。 */
export function startHeartbeat(opts: {
	layer: string;
	jobId: number;
	profilePath?: string;
	locate: () => string | undefined;
	heartbeatMs?: number;
	onTick?: (info: { elapsedMs: number; sample: SessionSample; grewBytes: number }) => void;
}): () => void {
	const heartbeatMs = opts.heartbeatMs ?? 30_000;
	const startedAt = Date.now();
	let lastSize = sampleSession(opts.locate()).size;
	const timer = setInterval(() => {
		const now = Date.now();
		const sample = sampleSession(opts.locate(), now);
		const grew = sample.size >= 0 && lastSize >= 0 ? sample.size - lastSize : -1;
		opts.onTick?.({ elapsedMs: now - startedAt, sample, grewBytes: grew });
		logEvent(
			opts.layer,
			`job ${opts.jobId} 运行 ${((now - startedAt) / 1000).toFixed(0)}s` +
				`（子代理会话 ${sample.size >= 0 ? `${sample.size} 字节，本段 +${Math.max(0, grew)}` : "未定位到"}）`,
			opts.profilePath,
		);
		lastSize = sample.size;
	}, heartbeatMs);
	return () => clearInterval(timer);
}
