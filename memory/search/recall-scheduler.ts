// ============================================================================
// memory/search/recall-scheduler.ts — L1 召回会话级调度闸门
//
// 存在理由（2026-09-15，plan/memory-system/L1_RECALL_ASYNC/）：
//   1. **串行**：同一 session 任一时刻至多一个召回活动在飞。并发召回会重复占用
//      embedding 配额、引入陈旧结果竞态、并发访问 sqlite。
//   2. **闸门释放绑定「底层真结束」**：不能用 race 结果释放——超时只意味着「这个结果
//      不再值得用」，底层 fetch / QPM 排队可能仍在跑。用 race 释放会让下一个请求与其并发，
//      直接违反串行（R1 阻断 B1）。
//   3. **请求语义分层**（R1 阻断 B2）：
//        - inject（自动注入）：可丢弃。单槽 latest-wins；被新请求覆盖者以 `superseded` settle。
//        - demand（`recall_l1_records` 工具 / blocking 等待）：**必须 settle**（结果或错误）。
//          请求-响应语义，promise 永不返回会挂死 agent loop 的工具阶段。
//   4. **兜底**（R1 阻断 B3）：底层可能永不 settle（取消不到的网络等待）；`maxHoldMs`
//      到点强制释放闸门并 warn，避免死锁级故障。
//   5. **优先级**：闸门空闲时 **demand 先于 inject** —— 有调用方在等（agent loop），
//      不能让工具阶段排在机会性的自动注入后面。
//
// 设计约束：本模块**零业务依赖**（不 import 扩展其他模块）；`run`、超时、时钟、定时器
// 全部由调用方注入，便于离线单测（scripts/test-recall-scheduler.mjs）。
// ============================================================================

/** 请求类型：inject 可丢弃；demand 必须 settle。 */
export type RecallKind = "inject" | "demand";

/** 结果落定方式。 */
export type RecallOutcome = "ok" | "timeout" | "superseded" | "error" | "reset";

export interface RecallRequest<P> {
	kind: RecallKind;
	/** 轮次编号（调用方维护）：结果写入前用于判断是否已过期。demand 可传 -1（不参与作废）。 */
	turnToken: number;
	/** 本次「结果可用性」预算（ms）：到点即 settle 为 timeout（底层仍在跑，闸门仍被持有）。 */
	timeoutMs: number;
	/** 传给 run 的载荷（查询文本、profile 路径、topK、是否计数等由调用方决定）。 */
	payload: P;
}

export interface RecallSettlement<T> {
	/** 命中结果；timeout/superseded/error/reset 时为 null。 */
	value: T | null;
	outcome: RecallOutcome;
	/** error 时的原因文本（便于日志/工具返回）。 */
	error?: string;
}

export interface RecallSchedulerOptions<P, T> {
	/** 实际执行体（如 recallL1Records 的封装）。抛错由调度器兜底转 error，不冒泡。 */
	run: (payload: P, signal: AbortSignal) => Promise<T | null>;
	/** 闸门最长持有时间（ms），超过强制释放 + warn（防底层永不 settle 死锁）。 */
	maxHoldMs: number;
	log?: (msg: string) => void;
	timers?: {
		setTimeout: (fn: () => void, ms: number) => unknown;
		clearTimeout: (handle: unknown) => void;
	};
}

export interface RecallScheduler<P, T> {
	/** 提交请求。返回的 promise **必定 settle**（任何 kind、任何路径）。 */
	request(req: RecallRequest<P>): Promise<RecallSettlement<T>>;
	/** 是否有活动在飞或排队。 */
	isBusy(): boolean;
	/** 观测计数。 */
	stats(): Record<RecallOutcome, number> & { maxHoldForced: number };
	/** 清空状态（profile 切换 / session 关闭）：在飞与排队的请求以 `reset` settle，并尽力 abort 底层。 */
	reset(): void;
}

interface Entry<P, T> {
	req: RecallRequest<P>;
	/** 已 settle 后重复调用为空操作（幂等）。 */
	resolve: (s: RecallSettlement<T>) => void;
	settled: boolean;
	abort: AbortController;
}

export function createRecallScheduler<P, T>(opts: RecallSchedulerOptions<P, T>): RecallScheduler<P, T> {
	const timers = opts.timers ?? {
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	};
	const log = opts.log ?? (() => {});
	const counts: Record<RecallOutcome, number> = { ok: 0, timeout: 0, superseded: 0, error: 0, reset: 0 };
	let maxHoldForced = 0;

	/** 当前在飞者：闸门由它持有，直到底层 settle 或 maxHoldMs 强制释放。 */
	let inflight: Entry<P, T> | null = null;
	/** inject 单槽（只保留最新；旧的立即 superseded）。 */
	let pendingInject: Entry<P, T> | null = null;
	/** demand FIFO（每个都会被执行并 settle）。 */
	const demandQueue: Entry<P, T>[] = [];
	let generation = 0;

	function settle(entry: Entry<P, T>, s: RecallSettlement<T>): void {
		if (entry.settled) return;
		entry.settled = true;
		counts[s.outcome]++;
		entry.resolve(s);
	}

	function makeEntry(req: RecallRequest<P>): { entry: Entry<P, T>; promise: Promise<RecallSettlement<T>> } {
		let raw!: (s: RecallSettlement<T>) => void;
		const promise = new Promise<RecallSettlement<T>>((r) => {
			raw = r;
		});
		const entry: Entry<P, T> = {
			req,
			abort: new AbortController(),
			settled: false,
			resolve: (s) => raw(s),
		};
		return { entry, promise };
	}

	/** 启动一个 entry：预算决定「结果是否还值得用」，闸门绑「底层真结束」。 */
	function start(entry: Entry<P, T>): void {
		const gen = generation;
		const signal = entry.abort.signal;

		let underlying: Promise<T | null>;
		try {
			underlying = Promise.resolve(opts.run(entry.req.payload, signal));
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			settle(entry, { value: null, outcome: "error", error: msg });
			underlying = Promise.resolve(null);
		}
		underlying = underlying.catch((e) => {
			// 主动 abort 引发的失败不算错误（超时/覆盖/重置都会 abort）
			if (!signal.aborted) {
				log(`[recall-scheduler] run 抛错: ${e instanceof Error ? e.message : String(e)}`);
			}
			return null;
		});

		// ── 结果可用性：预算内完成 → ok；到点 → timeout（底层继续跑，闸门不在此释放） ──
		const resultTimer = timers.setTimeout(() => {
			settle(entry, { value: null, outcome: "timeout" });
			try {
				entry.abort.abort(); // 尽力取消底层（HTTP 可取消；QPM sleep 不可取消，靠 maxHoldMs 兜底）
			} catch {
				/* ignore */
			}
		}, Math.max(1, entry.req.timeoutMs));

		// ── 闸门持有：等底层真结束；maxHoldMs 到点强制释放 ──
		const holdTimer = timers.setTimeout(() => {
			if (!inflight || inflight !== entry) return;
			maxHoldForced++;
			log(`[recall-scheduler] 闸门强制释放：底层超过 maxHoldMs=${opts.maxHoldMs}ms 未 settle`);
			release();
		}, Math.max(1, opts.maxHoldMs));

		inflight = entry;

		underlying.then((value) => {
			timers.clearTimeout(resultTimer);
			timers.clearTimeout(holdTimer);
			settle(entry, { value, outcome: "ok" }); // value===null → ok 但空结果
			if (inflight === entry) {
				release();
			}
		});

		function release(): void {
			if (gen !== generation) return; // reset 后不再续跑队列（generation 已变）
			if (inflight === entry) inflight = null;
			drain();
		}
	}

	/** 闸门空闲时取下一个：demand 优先（有 agent loop 在等），再取 inject。 */
	function drain(): void {
		if (inflight) return;
		if (demandQueue.length > 0) {
			start(demandQueue.shift()!);
			return;
		}
		if (pendingInject) {
			const e = pendingInject;
			pendingInject = null;
			start(e);
		}
	}

	return {
		request(req) {
			const { entry, promise } = makeEntry(req);
			if (req.kind === "demand") {
				demandQueue.push(entry);
			} else {
				if (pendingInject) settle(pendingInject, { value: null, outcome: "superseded" });
				pendingInject = entry;
			}
			drain();
			return promise;
		},

		isBusy: () => inflight !== null || pendingInject !== null || demandQueue.length > 0,

		stats: () => ({ ...counts, maxHoldForced }),

		reset() {
			generation++;
			try {
				inflight?.abort.abort();
			} catch {
				/* ignore */
			}
			if (inflight) settle(inflight, { value: null, outcome: "reset" });
			inflight = null;
			if (pendingInject) settle(pendingInject, { value: null, outcome: "reset" });
			pendingInject = null;
			for (const e of demandQueue.splice(0)) settle(e, { value: null, outcome: "reset" });
		},
	};
}
