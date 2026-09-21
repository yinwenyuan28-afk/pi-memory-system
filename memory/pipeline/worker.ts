import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closePipelineJobsDB, getPipelineJobsDB, type PipelineJob, type PipelineJobType } from "./jobs-db.ts";
import { drainNoticeCards, logEvent } from "../../util/notice.ts";

export const PIPELINE_POLL_MS = 2000;
const JOB_WAIT_POLL_MS = 400;

export type PipelineJobResult = "done" | "skipped" | "failed";

export interface PipelineExecutors {
	runL1: (ctx: ExtensionContext, job: PipelineJob) => Promise<PipelineJobResult>;
	runL2: (ctx: ExtensionContext, job: PipelineJob) => Promise<PipelineJobResult>;
	/** L3 自 2026-09-19 起也走队列（此前由主进程 `setupL3Persona` 自行拉起，见 §11.11）。 */
	runL3: (ctx: ExtensionContext, job: PipelineJob) => Promise<PipelineJobResult>;
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
	enqueueL3: (source: "trigger" | "manual") => { id: number; duplicate: boolean } | undefined;
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
 * 从按优先级排好的队列里挑下一个**可以跑**的 job（纯函数，可离线测）。
 *
 * 为什么不是"取队首、它熔断就整条队列歇着"（2026-09-21 实测事故）：L2 连败 3 次熔断后，
 * 队列里排着 `l2(68)` 和它后面的 `l1(69)`，而 `drain` 每 2s 取队首 → 是 L2 → 熔断 → 直接 return。
 * 结果 **L1 被堵在后面 5 个多小时**（job 69 一直 queued），用户手动 `/l1-trigger` 又被
 * `hasActive("l1")` 拦下（"已在队列或运行中"）—— 看起来就是"L1 子代理卡死了"。
 * 熔断的语义是"这一层别跑"，不是"整条流水线停摆"：跳过熔断层，让它后面的照常跑；
 * 被跳过的 job 留在队列里，等这一层被手动复位（`/my-memory:l2-trigger` 之类）。
 */
export function pickNextClaimable(
	queued: PipelineJob[],
	isCooledDown: (type: PipelineJobType) => boolean,
): PipelineJob | undefined {
	return queued.find((j) => !isCooledDown(j.type));
}

/**
 * 手动触发（`/my-memory:l*-trigger`）面对"队列里已经有本层 job"时的裁决（纯函数，可离线测）。
 *
 * 为什么需要它（2026-09-21 实测）：L2 连败熔断后，队列里还压着一条 L2 job（L1 收尾时排进来的），
 * 于是 `/l2-trigger` 被 `hasActive("l2")` 拦下、提示"已在队列或运行中" —— **熔断把它自己的恢复入口
 * 也堵死了**（用户能看到的只有"点了没反应"）。熔断要人工复位是设计，但"人工复位"这条路必须通。
 *
 *   · `proceed`        —— 队列里没有本层 job，照常入队
 *   · `unpause-queued` —— 本层熔断 + 队列里那条正被熔断按着 → 复位熔断 + kick，让它按队序跑
 *   · `refuse-busy`    —— 真有 running（或未熔断的排队）→ 维持原提示
 */
export type ManualTriggerVerdict = "proceed" | "unpause-queued" | "refuse-busy";

export function decideManualTrigger(input: {
	hasActive: boolean;
	queuedOfType: boolean;
	cooledDown: boolean;
}): ManualTriggerVerdict {
	if (!input.hasActive) return "proceed";
	if (input.queuedOfType && input.cooledDown) return "unpause-queued";
	return "refuse-busy";
}

/**
 * 主进程单飞行 worker：2s 轮询 + kick；同时只跑 1 个 job（L1/L2/L3 共用一条队列）。
 * 任一 job 占用未结束（running）时不会 claim 下一个 —— 这是"同一时刻只有一个 L1-L3 子代理"的执行侧。
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
			logEvent("pipeline", err instanceof Error ? err.message : String(err), p);
			return undefined;
		}
	}

	function enqueueL1(source: "interval" | "manual") {
		return withDb((db) => db.enqueue("l1", source));
	}

	function enqueueL2(source: "manual" | "l1_commit") {
		return withDb((db) => db.enqueue("l2", source));
	}

	function enqueueL3(source: "trigger" | "signal" | "manual") {
		return withDb((db) => db.enqueue("l3", source));
	}

	/** 三层共用一个派发表（新增层时只改这里）。 */
	function runJob(executors: PipelineExecutors, ctx: ExtensionContext, job: PipelineJob): Promise<PipelineJobResult> {
		if (job.type === "l1") return executors.runL1(ctx, job);
		if (job.type === "l2") return executors.runL2(ctx, job);
		return executors.runL3(ctx, job);
	}

	async function drain(): Promise<void> {
		if (busy) return;
		const executors = getExecutors();
		if (!executors) return;
		if (!cachedCtx) return;
		const profilePath = getProfilePath();
		if (!profilePath) return;

		const db = getPipelineJobsDB(profilePath);
		// 全局单飞（2026-09-19）：两个 pi 进程同时开着时各自都能 claim 走一条 queued
		// → 两个子代理并发（实测过 L2 并发改场景块）。这里要求"当前没有任何 running"。
		if (db.hasAnyRunning()) return;
		// 跳过熔断层（2026-09-21 修）：取队首会让"队首那一层熔断"变成整条流水线停摆，
		// 把后面别的层（实测是 L1）永久堵在队列里。熔断的语义是"这一层别跑"，不是"全停"。
		const job0 = pickNextClaimable(db.listQueued(), executors.isCooledDown);
		if (!job0) return;

		const job = db.claim(job0.id);
		if (!job) return;

		busy = true;
		try {
			const result = await runJob(executors, cachedCtx, job);
			// l1/l2/l3 的真完成信号都来自子代理里的 commit 工具（completeRunningL1/L2/L3）；
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
							logEvent(
								"pipeline",
								next === "l1"
									? `L0 仍有积压 → 继续排 L1（job ${q.id}）`
									: `L1 已排空 → 排 L2（job ${q.id}）`,
								getProfilePath(),
							);
						}
					}
				} catch (err) {
					logEvent("pipeline", `下一步编排失败: ${err instanceof Error ? err.message : String(err)}`, getProfilePath());
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logEvent("pipeline", `${job.type} job ${job.id} failed: ${msg}`, getProfilePath());
			db.complete(job.id, "failed", msg);
		} finally {
			busy = false;
			// 子代理写的卡片（notices.jsonl）在每个 job 收尾时就地渲染——
			// 不能等下一轮 agent_settled：那可能隔很久，用户会以为“什么都没发生”。
			try {
				drainNoticeCards();
			} catch (e) {
				logEvent("notice", `job 收尾 drain 失败: ${e instanceof Error ? e.message : String(e)}`, getProfilePath());
			}
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
			if (n > 0) logEvent("pipeline", `recovered ${n} leftover running job(s)`, p);
		} catch (err) {
			logEvent("pipeline", `recover failed: ${err instanceof Error ? err.message : String(err)}`, p);
		}
	});

	return {
		enqueueL1,
		enqueueL2,
		enqueueL3,
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
