import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closePipelineJobsDB, getPipelineJobsDB, type PipelineJob, type PipelineJobType } from "./jobs-db.ts";

export const PIPELINE_POLL_MS = 2000;
const JOB_WAIT_POLL_MS = 400;

export type PipelineJobResult = "done" | "skipped" | "failed";

export interface PipelineExecutors {
	runL1: (ctx: ExtensionContext, job: PipelineJob) => Promise<PipelineJobResult>;
	runL2: (ctx: ExtensionContext, job: PipelineJob) => Promise<PipelineJobResult>;
	isCooledDown: (type: PipelineJobType) => boolean;
	/**
	 * L1 的 L0 增量是否还没啃完（游标之后仍有消息）。
	 * 由调用方注入（worker 不依赖 l1 模块）——用于"积压时连续串行多个 L1"。
	 */
	hasL1Remaining?: () => boolean;
	/** L1 游标之后是否有 L1 记录（含主代理写入的），决定要不要入队 L2。 */
	hasNewRecordsForL2?: () => boolean;
}

export interface PipelineWorker {
	enqueueL1: (source: "interval" | "manual") => { id: number; duplicate: boolean } | undefined;
	enqueueL2: (source: "manual" | "l1_commit") => { id: number; duplicate: boolean } | undefined;
	kick: () => void;
	setCachedCtx: (ctx: ExtensionContext) => void;
	reset: () => void;
}

/**
 * L1 job 收尾后该排什么（纯函数，可离线测）。
 *
 * 用户 2026-09-19 定的语义：**积压时多个 L1 串行跑完，才轮到 L2**。
 *   ① L0 还有增量 → 再排一个 L1（不需要用户再聊够轮数，积压靠连续串行消化）
 *   ② 积压清空且有新记录 → 排一个 L2
 *   ③ 两者都不是 → 什么都不排
 *
 * 这条规则同时消掉了旧行为的一个副作用：一次 L1 运行里提交多批（每次 l1_commit 都入队）
 * 会让 L2 在 L1 还没啃完积压时就开跑、且"多 1 条也起一个完整 L2"。
 */
export function decideNextAfterL1(input: { hasL1Remaining: boolean; hasNewRecords: boolean }): "l1" | "l2" | null {
	if (input.hasL1Remaining) return "l1";
	if (input.hasNewRecords) return "l2";
	return null;
}

/**
 * 主进程单飞行 worker：2s 轮询 + kick；同时只跑 1 个 job。
 * L1 占用未结束（running）时不会 claim L2。
 */
export function setupPipelineWorker(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
	getExecutors: () => PipelineExecutors | undefined,
): PipelineWorker {
	let busy = false;
	let cachedCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	function withDb<T>(fn: (db: ReturnType<typeof getPipelineJobsDB>) => T): T | undefined {
		const p = getProfilePath();
		if (!p) return undefined;
		try {
			return fn(getPipelineJobsDB(p));
		} catch (err) {
			console.warn(`[memory-system][pipeline] ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	function enqueueL1(source: "interval" | "manual") {
		return withDb((db) => db.enqueue("l1", source));
	}

	function enqueueL2(source: "manual" | "l1_commit") {
		return withDb((db) => db.enqueue("l2", source));
	}

	async function drain(): Promise<void> {
		if (busy) return;
		const executors = getExecutors();
		if (!executors) return;
		if (!cachedCtx) return;
		const profilePath = getProfilePath();
		if (!profilePath) return;

		const db = getPipelineJobsDB(profilePath);
		// 全局单飞（2026-09-19）：peekNext 只挑 queued，两个 pi 进程同时开着时各自都能 claim
		// 走一条 → 两个子代理并发（实测过 L2 并发改场景块）。这里要求"当前没有任何 running"。
		if (db.hasAnyRunning()) return;
		const peek = db.peekNext();
		if (!peek) return;
		if (executors.isCooledDown(peek.type)) return;

		const job = db.claim(peek.id);
		if (!job) return;

		busy = true;
		try {
			const result = job.type === "l1" ? await executors.runL1(cachedCtx, job) : await executors.runL2(cachedCtx, job);
			// l1/l2 的真完成信号都来自子代理里的 commit 工具（completeRunningL1/L2）；
			// 若执行器返回时仍是 running，说明执行器已经尽力（超时/未提交）→ 按它的结论收尾。
			const after = db.getJob(job.id);
			if (after?.status === "running") db.complete(job.id, result === "failed" ? "failed" : result);

			// L1 收尾后的下一步由队列自己决定（2026-09-19）：
			//   ① 还有 L0 积压 → 再排一个 L1（积压靠连续串行消化，不需要再等用户聊够轮数）
			//   ② 积压已清空、且有新记录 → 排 L2
			// 这样"多个 L1 串行跑完，才轮到 L2"，而且一次 L1 运行里提交多批也只会排一次 L2。
			if (job.type === "l1" && db.getJob(job.id)?.status === "done") {
				try {
					const next = decideNextAfterL1({
						hasL1Remaining: executors.hasL1Remaining?.() ?? false,
						hasNewRecords: executors.hasNewRecordsForL2?.() ?? false,
					});
					if (next) {
						const q = db.enqueue(next, next === "l1" ? "drain" : "l1_commit");
						if (!q.duplicate) {
							console.log(
								next === "l1"
									? `[memory-system][pipeline] L0 仍有积压 → 继续排 L1（job ${q.id}）`
									: `[memory-system][pipeline] L1 已排空 → 排 L2（job ${q.id}）`,
							);
						}
					}
				} catch (err) {
					console.warn(`[memory-system][pipeline] 下一步编排失败: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[memory-system][pipeline] ${job.type} job ${job.id} failed: ${msg}`);
			db.complete(job.id, "failed", msg);
		} finally {
			busy = false;
		}
		queueMicrotask(() => {
			void drain();
		});
	}

	function kick(): void {
		void drain();
	}

	timer = setInterval(() => {
		void drain();
	}, PIPELINE_POLL_MS);

	pi.on("agent_settled", (_e, ctx) => {
		cachedCtx = ctx;
		kick();
	});

	pi.on("session_start", () => {
		const p = getProfilePath();
		if (!p) return;
		try {
			const n = getPipelineJobsDB(p).recoverStuckRunning();
			if (n > 0) console.warn(`[memory-system][pipeline] recovered ${n} leftover running job(s)`);
		} catch (err) {
			console.warn(`[memory-system][pipeline] recover failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	return {
		enqueueL1,
		enqueueL2,
		kick,
		setCachedCtx: (ctx) => {
			cachedCtx = ctx;
		},
		reset: () => {
			busy = false;
			cachedCtx = undefined;
			const p = getProfilePath();
			closePipelineJobsDB(p);
		},
	};
}

/** 等到指定 job 离开 running，或超时。供 L1 执行器：完成信号来自 l1_commit，不来自 await spawn。 */
export async function waitWhileRunning(
	getJob: () => PipelineJob | undefined,
	timeoutMs: number,
	pollMs = JOB_WAIT_POLL_MS,
): Promise<PipelineJob | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const job = getJob();
		if (!job || job.status !== "running") return job;
		if (Date.now() >= deadline) return job;
		await new Promise((r) => setTimeout(r, pollMs));
	}
}
