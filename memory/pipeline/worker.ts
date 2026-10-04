import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closePipelineJobsDB, getPipelineJobsDB, retainPipelineJobsDB, type PipelineJob, type PipelineJobType } from "./jobs-db.ts";
import { isLayerHeld, loadFailureState } from "../failure-state.ts";
import { drainNoticeCards, logEvent } from "../../util/notice.ts";

export const PIPELINE_POLL_MS = 2000;
const JOB_WAIT_POLL_MS = 400;

export type PipelineJobResult = "done" | "skipped" | "failed";

export interface PipelineJobScope {
	profilePath: string;
	/** 持久化仍归原 profile；只有当前会话可接收 UI/卡片。 */
	isCurrent: () => boolean;
}

// 会话替换可能创建新的 worker，但旧执行器仍在收尾。共享登记避免启动恢复误杀它。
const executingProfiles = new Map<string, Set<number>>();

export interface PipelineExecutors {
	runL1: (ctx: ExtensionContext, job: PipelineJob, scope?: PipelineJobScope) => Promise<PipelineJobResult>;
	runL2: (ctx: ExtensionContext, job: PipelineJob, scope?: PipelineJobScope) => Promise<PipelineJobResult>;
	/** L3 自 2026-09-19 起也走队列（此前由主进程 `setupL3Persona` 自行拉起，见 §11.11）。 */
	runL3: (ctx: ExtensionContext, job: PipelineJob, scope?: PipelineJobScope) => Promise<PipelineJobResult>;
	isCooledDown: (type: PipelineJobType) => boolean;
	/**
	 * L1 的 L0 增量是否还没啃完（游标之后仍有消息）。
	 * 由调用方注入（worker 不依赖 l1 模块）——用于"积压时连续串行多个 L1"。
	 */
	hasL1Remaining?: (profilePath: string) => boolean;
	/** L1 游标之后是否有 L1 记录（含主代理写入的），决定要不要入队 L2。 */
	hasNewRecordsForL2?: (profilePath: string) => boolean;
}

export interface PipelineWorker {
	enqueueL1: (source: "interval" | "manual") => { id: number; duplicate: boolean } | undefined;
	enqueueL2: (source: "manual" | "l1_commit") => { id: number; duplicate: boolean } | undefined;
	enqueueL3: (source: "trigger" | "signal" | "manual") => { id: number; duplicate: boolean } | undefined;
	kick: () => void;
	setCachedCtx: (ctx: ExtensionContext) => void;
	reset: () => void;
	/** 当前进程仍监督的任务，不是启动恢复需要回收的孤儿。 */
	ownsJob: (profilePath: string, jobId?: number) => boolean;
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
 *
 * 判定谓词是"**这层现在被阻塞吗**"（2026-09-26 起广义化）：熔断 **或** 层持有
 * （`failure-state.json` 的 `holdUntil`，见 `isLayerHeld`）。持有只在"停了子代理但没能确认
 * 它已死"时出现 —— 那种情况下放新 job 进去会变成两个写者改同一批场景块。
 */
export function pickNextClaimable(
	queued: PipelineJob[],
	isLayerBlocked: (type: PipelineJobType) => boolean,
): PipelineJob | undefined {
	return queued.find((j) => !isLayerBlocked(j.type));
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
	let cachedProfile: string | undefined;
	let generation = 0;
	let sessionLease: ReturnType<typeof retainPipelineJobsDB> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const ownsJob = (p: string, id?: number) => id === undefined
		? (executingProfiles.get(p)?.size ?? 0) > 0
		: executingProfiles.get(p)?.has(id) === true;

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
	function runJob(executors: PipelineExecutors, ctx: ExtensionContext, job: PipelineJob, scope: PipelineJobScope): Promise<PipelineJobResult> {
		if (job.type === "l1") return executors.runL1(ctx, job, scope);
		if (job.type === "l2") return executors.runL2(ctx, job, scope);
		return executors.runL3(ctx, job, scope);
	}

	function guardContext(ctx: ExtensionContext, scope: PipelineJobScope): ExtensionContext {
		const ui = ctx.ui;
		const guardedUi = new Proxy(ui, {
			get(target, key) {
				const value = Reflect.get(target, key);
				if ((key === "setStatus" || key === "notify") && typeof value === "function") {
					return (...args: unknown[]) => {
						if (scope.isCurrent()) return Reflect.apply(value, target, args);
					};
				}
				return value;
			},
		});
		return new Proxy(ctx, { get: (target, key) => key === "ui" ? guardedUi : Reflect.get(target, key) });
	}

	async function drain(): Promise<void> {
		if (busy) return;
		const executors = getExecutors();
		if (!executors) return;
		if (!cachedCtx) return;
		const profilePath = cachedProfile;
		if (!profilePath) return;
		if (getProfilePath() !== profilePath || ownsJob(profilePath)) return;

		const db = getPipelineJobsDB(profilePath);
		// 仅为快速退出；真正互斥由 claim 的原子 UPDATE 保证，不能依赖先查再写。
		if (db.hasAnyRunning()) return;
		// 跳过"被阻塞的层"（2026-09-21 修熔断、2026-09-26 扩到层持有）：取队首会让"队首那一层熔断"
		// 变成整条流水线停摆，把后面别的层永久堵在队列里。语义是"这一层别跑"，不是"全停"。
		const failure = loadFailureState(profilePath);
		const blocked = (t: PipelineJobType) => executors.isCooledDown(t) || isLayerHeld(failure[t]);
		const job0 = pickNextClaimable(db.listQueued(), blocked);
		if (!job0) return;

		const job = db.claim(job0.id);
		if (!job) return;

		const lease = retainPipelineJobsDB(profilePath);
		const runGeneration = generation;
		const scope: PipelineJobScope = { profilePath, isCurrent: () =>
			runGeneration === generation && cachedProfile === profilePath && cachedCtx !== undefined && getProfilePath() === profilePath };
		const sourceCtx = cachedCtx;
		const jobs = executingProfiles.get(profilePath) ?? new Set<number>();
		jobs.add(job.id);
		executingProfiles.set(profilePath, jobs);
		busy = true;
		try {
			const ctx = guardContext(sourceCtx, scope);
			const result = await runJob(executors, ctx, job, scope);
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
						hasL1Remaining: executors.hasL1Remaining?.(profilePath) ?? false,
						hasNewRecords: executors.hasNewRecordsForL2?.(profilePath) ?? false,
					});
					if (next) {
						const q = db.enqueue(next, next === "l1" ? "drain" : "l1_commit");
						if (!q.duplicate) {
							logEvent(
								"pipeline",
								next === "l1"
									? `L0 仍有积压 → 继续排 L1（job ${q.id}）`
									: `L1 已排空 → 排 L2（job ${q.id}）`,
								profilePath,
							);
						}
					}
				} catch (err) {
					logEvent("pipeline", `下一步编排失败: ${err instanceof Error ? err.message : String(err)}`, profilePath);
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logEvent("pipeline", `${job.type} job ${job.id} failed: ${msg}`, profilePath);
			try { db.complete(job.id, "failed", msg); }
			catch (error) { logEvent("pipeline", `job ${job.id} 失败收尾也出错: ${String(error)}`, profilePath); }
		} finally {
			busy = false;
			jobs.delete(job.id);
			if (!jobs.size) executingProfiles.delete(profilePath);
			lease.release();
			// 子代理写的卡片（notices.jsonl）在每个 job 收尾时就地渲染——
			// 不能等下一轮 agent_settled：那可能隔很久，用户会以为“什么都没发生”。
			try {
				if (scope.isCurrent()) drainNoticeCards();
			} catch (e) {
				logEvent("notice", `job 收尾 drain 失败: ${e instanceof Error ? e.message : String(e)}`, profilePath);
			}
		}
		queueMicrotask(() => {
			kick();
		});
	}

	function kick(): void {
		const profilePath = cachedProfile;
		void drain().catch((error) => logEvent("pipeline", `调度失败: ${String(error)}`, profilePath));
	}

	function setCachedCtx(ctx: ExtensionContext): void {
		const p = getProfilePath();
		if (!p) return;
		if (cachedProfile !== p) {
			reset();
			sessionLease = retainPipelineJobsDB(p);
			cachedProfile = p;
		}
		cachedCtx = ctx;
		if (!timer) {
			timer = setInterval(kick, PIPELINE_POLL_MS);
			timer.unref?.();
		}
	}

	function reset(): void {
		generation++;
		cachedCtx = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (sessionLease && cachedProfile) {
			closePipelineJobsDB(cachedProfile, sessionLease.db);
			sessionLease.release();
		}
		sessionLease = undefined;
		cachedProfile = undefined;
		// busy 保留到在途 Promise 真结束；租约保护各执行器持有的同一个连接。
	}

	pi.on("agent_settled", (_e, ctx) => {
		setCachedCtx(ctx);
		kick();
	});

	pi.on("session_start", () => {
		const p = getProfilePath();
		if (!p || ownsJob(p)) return;
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
		setCachedCtx,
		reset,
		ownsJob,
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
