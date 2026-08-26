import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closePipelineJobsDB, getPipelineJobsDB, type PipelineJob, type PipelineJobType } from "./jobs-db.js";

export const PIPELINE_POLL_MS = 2000;
const JOB_WAIT_POLL_MS = 400;

export type PipelineJobResult = "done" | "skipped" | "failed";

export interface PipelineExecutors {
	runL1: (ctx: ExtensionContext, job: PipelineJob) => Promise<PipelineJobResult>;
	runL2: (ctx: ExtensionContext, job: PipelineJob) => Promise<PipelineJobResult>;
	isCooledDown: (type: PipelineJobType) => boolean;
}

export interface PipelineWorker {
	enqueueL1: (source: "interval" | "manual") => { id: number; duplicate: boolean } | undefined;
	enqueueL2: (source: "manual" | "l1_commit") => { id: number; duplicate: boolean } | undefined;
	kick: () => void;
	setCachedCtx: (ctx: ExtensionContext) => void;
	reset: () => void;
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
		const peek = db.peekNext();
		if (!peek) return;
		if (executors.isCooledDown(peek.type)) return;

		const job = db.claim(peek.id);
		if (!job) return;

		busy = true;
		try {
			const result = job.type === "l1" ? await executors.runL1(cachedCtx, job) : await executors.runL2(cachedCtx, job);
			if (job.type === "l1") {
				// l1_commit 已把 running l1 标 done；若仍 running 则执行器应已标 failed/skipped
				const after = db.getJob(job.id);
				if (after?.status === "running") db.complete(job.id, result === "failed" ? "failed" : result);
			} else {
				db.complete(job.id, result);
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
