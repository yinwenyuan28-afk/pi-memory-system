import { runPiSubagent } from "../../util/subagent.ts";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildL3Task,
	L3_CURSOR_FILE,
	L3_FAILURE_THRESHOLD,
	L3_RUN_TTL_MS,
	L3_SUBAGENT_TIMEOUT_MS,
	loadL3Cursor,
	saveL3Cursor,
} from "./config.ts";
import { MEMORY_DB_DIR } from "../paths.ts";
import { loadFailureState, saveFailureState } from "../failure-state.ts";
import { evaluateTrigger } from "./trigger.ts";
import { consumePendingTrigger } from "./signal.ts";
import { acquireRunLock, evaluateRunOutcome, readRunLock, releaseRunLock, runLockRemainingMs, runLockState } from "./run-lock.ts";

function incrementMemoriesSince(profilePath: string, count: number): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE);
	const cursor = loadL3Cursor(profilePath);
	cursor.memoriesSinceLastPersona = cursor.memoriesSinceLastPersona + count;
	writeFileSync(filePath, JSON.stringify(cursor, null, 2), "utf-8");
}

/** 正在跑的那一轮（内存态；跨进程的真闸是 run.lock 文件）。 */
interface PendingRun {
	runId: string;
	committedBefore: string;
	deadlineAt: string;
	reason: string;
	/** 挂死到点后用来真的掐掉子代理进程。 */
	abort: AbortController;
}

export interface L3Controls {
	onL1Committed: (recordCount: number) => void;
	triggerManual: (ctx?: ExtensionContext) => void | Promise<void>;
	reset: () => void;
}

/**
 * 注册 L3 persona 调度（单次调用，**只会在主进程执行**）。
 *
 * ── 触发链路（2026-09-16 修）────────────────────────────────────────
 *
 * 旧实现只有一条触发通道：`registerL2CommitTool` 的 `onCommitted` 回调 → `onL2Committed`
 * → `queueTrigger`。但那个回调在 **l2-scene-organizer 子代理进程**里求值，而本函数位于
 * `index.ts` 的 `PI_SUBAGENT_CHILD` 早退**之后** —— 子代理进程里 `l3Controls` 恒为 `undefined`，
 * `l3Controls?.onL2Committed()` 静默 no-op。实测：**46/46 次 `l2_commit` 全部发生在子代理进程，
 * 主会话 0 次** ⇒ 自动触发一次都没生效过（L3 事实上只能靠 `/persona` 手动跑）。
 *
 * 现结构（两条通道，都不依赖跨进程闭包）：
 *   1. **台账式评估**：主进程每次 `agent_settled` 都调一次 `queueTrigger({})`，
 *      是否真跑完全交给 `evaluateTrigger` 的五级门控（P1–P4 + 增量跳过）。无状态、不怕重启。
 *   2. **显式信号落盘**：子代理的 `personaSignal` 写 `l3/pending-trigger.json`，主进程读取后消费
 *      （读后即删）——保住 `l2-scene-organizer.md` 里那条此前永远无效的 P1 指令。
 *
 * ── 为什么必须配"单飞锁 + 观察式结算"（同日第二次实测事故）──────────────
 *
 * `runPiSubagent` 是 **async:true 的 fire-and-forget**：派发后**立刻 resolve**，不等子代理做完
 * （子代理实测跑 56–118s）。第一版把互斥（`scheduled`）与成败结算都建在这个 promise 上，于是：
 *   · 闸门在 spawn 后毫秒级就放开了 ⇒ 一窗口内派出了 **3 个并发 L3 子代理**，同时改 USER.md；
 *   · spawn 后立刻读游标必然"没提交" ⇒ **每次启动都记一次失败**，连成功的运行也照记 ⇒ 误熔断。
 * 现在：派发前落 `l3/run.lock`，结局由 `observeRun()` 在后续 settle 里按**游标是否推进**判定。
 * 详见 `memory/l3/run-lock.ts` 的头注释。
 *
 * 副作用与配套：熔断复用 `failure-state.ts` 的 l3 层（`L3_FAILURE_THRESHOLD`），
 * 成功口径与 L1 一致（跑完但没提交也算失败，对齐 `extract ended without commit`）。
 */
export function setupL3Persona(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): L3Controls {
	let pending: PendingRun | undefined;
	let pendingTrigger = false;
	let pendingOpts: { personaSignal?: boolean; personaReason?: string; force?: boolean } | undefined;
	let cachedCtx: ExtensionContext | undefined;

	function logSkip(reason: string): void {
		// 静默是上一轮的根因之一：触发没发生却查不到原因，只能翻会话日志。
		console.log(`[memory-system][l3] 未触发：${reason}`);
	}

	function recordFailure(profilePath: string, detail: string, ctx: ExtensionContext): void {
		const st = loadFailureState(profilePath);
		st.l3.consecutiveFailures++;
		console.warn(
			`[memory-system][l3] persona failed (${st.l3.consecutiveFailures}/${L3_FAILURE_THRESHOLD}): ${detail}`,
		);
		if (st.l3.consecutiveFailures >= L3_FAILURE_THRESHOLD && !st.l3.cooledDown) {
			st.l3.cooledDown = true;
			ctx.ui.notify(
				`L3 画像连续失败 ${st.l3.consecutiveFailures} 次，已暂停自动更新。用 /my-memory:l3-trigger 手动重试或检查日志。`,
				"error",
			);
		}
		saveFailureState(profilePath, st);
	}

	function recordSuccess(profilePath: string): void {
		const st = loadFailureState(profilePath);
		if (st.l3.consecutiveFailures > 0 || st.l3.cooledDown) {
			st.l3.consecutiveFailures = 0;
			st.l3.cooledDown = false;
			saveFailureState(profilePath, st);
		}
	}

	/** 结算本轮：只有"游标未推进且已过时限"才算失败；期间一律 running。 */
	function observeRun(profilePath: string, ctx: ExtensionContext): void {
		if (!pending) return;
		const outcome = evaluateRunOutcome({
			committedBefore: pending.committedBefore,
			committedAfter: loadL3Cursor(profilePath).lastCommittedAt,
			deadlineAt: pending.deadlineAt,
			nowMs: Date.now(),
		});
		if (outcome === "running") return;

		releaseRunLock(profilePath, pending.runId);
		if (outcome === "success") {
			recordSuccess(profilePath);
			console.log(`[memory-system][l3] 本轮完成，游标已推进（${pending.reason}）`);
		} else {
			// 兜底真的掐掉挂死的子代理进程（async:true 下 runPiSubagent 的计时器不会触发 abort）
			try {
				pending.abort.abort();
			} catch {
				// ignore
			}
			recordFailure(profilePath, "子代理在时限内未提交（未推进游标）", ctx);
		}
		pending = undefined;
	}

	async function runTask(task: string, ctx: ExtensionContext, reason: string, force = false): Promise<void> {
		const profilePath = getProfilePath();
		if (!profilePath) return;

		// 派发前占锁：跨进程/跨 reload 的唯一闸门。占不到就不起（宁可少跑一轮，也不要并发改 USER.md）
		const runId = randomUUID();
		const lock = acquireRunLock(profilePath, { runId, reason, ttlMs: L3_RUN_TTL_MS, nowMs: Date.now() });
		if (!lock) {
			logSkip("已有另一轮在跑（run.lock 被占用）");
			return;
		}

		const abort = new AbortController();
		pending = {
			runId,
			committedBefore: loadL3Cursor(profilePath).lastCommittedAt,
			deadlineAt: lock.deadlineAt,
			reason,
			abort,
		};
		ctx.ui.setStatus("memory", "Memory ⚙L3...");
		if (force) logSkip(`手动触发，已占锁（${reason}）`);

		try {
			await runPiSubagent("l3-persona-generator", task, ctx, L3_SUBAGENT_TIMEOUT_MS, abort.signal);
			// ⚠ 走到这里**不代表子代理做完了**（async:true，派发后立刻 resolve）。
			// 结局交给 observeRun 在后续 agent_settled 里按游标判定。
		} catch (err) {
			// 派发阶段就抛错（executor 不可用等）= 真失败，立刻结算并放锁
			console.warn(`[memory-system][l3] persona spawn failed: ${err instanceof Error ? err.message : String(err)}`);
			releaseRunLock(profilePath, runId);
			pending = undefined;
			recordFailure(profilePath, `派发失败：${err instanceof Error ? err.message : String(err)}`, ctx);
		}
	}

	function queueTrigger(opts: { personaSignal?: boolean; personaReason?: string; force?: boolean } = {}): void {
		const profilePath = getProfilePath();
		if (!profilePath) return;
		if (pending) {
			logSkip("上一轮仍在跑（等它提交或超时）");
			return;
		}

		// 真闸：磁盘锁。跨进程/跨 reload 有效——`/reload` 不会清掉它，所以重载也不会造成双跑。
		const lock = readRunLock(profilePath);
		const lockState = runLockState(lock, Date.now());
		if (lockState === "running") {
			logSkip(`已有另一进程在跑（锁 ${lock?.runId?.slice(0, 8)}，${Math.ceil(runLockRemainingMs(lock, Date.now()) / 1000)}s 后过期）`);
			return;
		}
		if (lockState === "stale") {
			console.warn(`[memory-system][l3] 发现过期锁（${lock?.runId?.slice(0, 8)}），按子代理已死处理并继续`);
			releaseRunLock(profilePath);
		}

		const st = loadFailureState(profilePath);
		if (st.l3.cooledDown && !opts.force) {
			logSkip(`已熔断（连续失败 ${st.l3.consecutiveFailures} 次），用 /my-memory:l3-trigger 手动重试`);
			return;
		}

		const result = evaluateTrigger(profilePath, opts);
		if (!result.should) {
			logSkip(result.reason || "五级门控未命中");
			return;
		}

		const task = buildL3Task(profilePath, result.reason, result.changedScenes);
		if (!task) {
			logSkip("无场景可读（scene_index 为空）");
			return;
		}

		const cursor = loadL3Cursor(profilePath);
		saveL3Cursor(profilePath, { ...cursor, lastTriggeredAt: new Date().toISOString() });

		if (cachedCtx) {
			void runTask(task, cachedCtx, result.reason, opts.force === true);
		} else {
			pendingTrigger = true;
			pendingOpts = opts;
		}
	}

	function onL1Committed(recordCount: number): void {
		const profilePath = getProfilePath();
		if (!profilePath || recordCount <= 0) return;
		try {
			if (!existsSync(join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE))) {
				writeFileSync(join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE), JSON.stringify(loadL3Cursor(profilePath), null, 2), "utf-8");
			}
			incrementMemoriesSince(profilePath, recordCount);
		} catch {
			// non-fatal
		}
	}

	function triggerManual(ctx?: ExtensionContext): void {
		if (ctx) {
			const profilePath = getProfilePath();
			if (!profilePath) return;
			// 手动也不越过单飞锁：并发改 USER.md 的代价比"晚几分钟"大得多
			if (pending || runLockState(readRunLock(profilePath), Date.now()) === "running") {
				const lock = readRunLock(profilePath);
				const left = Math.ceil(runLockRemainingMs(lock, Date.now()) / 1000);
				ctx.ui.notify(`L3 已有一轮在跑（${left}s 后到时限），等它结束后再试`, "error");
				return;
			}
			const result = evaluateTrigger(profilePath, { force: true, personaReason: "手动 l3-trigger" });
			const task = buildL3Task(profilePath, result.reason, result.changedScenes);
			if (!task) {
				ctx.ui.notify("L3 无场景可读（scene_index 为空），未触发", "error");
				saveL3Cursor(profilePath, { ...loadL3Cursor(profilePath), lastTriggeredAt: new Date().toISOString() });
				return;
			}
			void runTask(task, ctx, result.reason, true);
		} else {
			queueTrigger({ force: true, personaReason: "手动 l3-trigger" });
		}
	}

	pi.on("agent_settled", (_e, ctx) => {
		cachedCtx = ctx;
		const profilePath = getProfilePath();
		if (!profilePath) return;
		// 先结算在飞的那一轮（只有它能清掉 pending / 放锁）
		observeRun(profilePath, ctx);
		// 通道 2：消费子代理落盘的显式信号（读后即删 ⇒ 一个信号只生效一次）
		const signal = consumePendingTrigger(profilePath);
		const opts = {
			...(pendingOpts ?? {}),
			...(signal?.personaSignal ? { personaSignal: true, personaReason: signal.personaReason } : {}),
		};
		pendingTrigger = false;
		pendingOpts = undefined;
		// 通道 1：每轮台账式评估（无状态；跑不跑由 evaluateTrigger + 单飞锁决定）
		queueTrigger(opts);
	});

	return {
		onL1Committed,
		triggerManual,
		reset: () => {
			// 刻意**不**清 pending / 不放锁：`/reload` 不该杀掉正在跑的那一轮，
			// 也不该让重载后的新实例以为"没有人在跑"（那正是并发事故的成因）。
			pendingTrigger = false;
			pendingOpts = undefined;
		},
	};
}
