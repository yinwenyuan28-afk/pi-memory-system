import { runPiSubagent } from "../../util/subagent.ts";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildL3Task,
	L3_CURSOR_FILE,
	L3_FAILURE_THRESHOLD,
	L3_SUBAGENT_TIMEOUT_MS,
	loadL3Cursor,
	saveL3Cursor,
} from "./config.ts";
import { consumePendingTrigger } from "./signal.ts";
import { MEMORY_DB_DIR } from "../paths.ts";
import { loadFailureState, saveFailureState } from "../failure-state.ts";
import { evaluateTrigger } from "./trigger.ts";

function incrementMemoriesSince(profilePath: string, count: number): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE);
	const cursor = loadL3Cursor(profilePath);
	cursor.memoriesSinceLastPersona = cursor.memoriesSinceLastPersona + count;
	writeFileSync(filePath, JSON.stringify(cursor, null, 2), "utf-8");
}

export interface L3Controls {
	onL1Committed: (recordCount: number) => void;
	triggerManual: (ctx?: ExtensionContext) => void | Promise<void>;
	reset: () => void;
}

/**
 * 注册 L3 persona 调度（单次调用，**只会在主进程执行**）。
 *
 * ── 2026-09-16 触发链路修复（实测根因）──────────────────────────────
 *
 * 旧实现只有一条触发通道：`registerL2CommitTool` 的 `onCommitted` 回调 → `onL2Committed`
 * → `queueTrigger`。但那个回调在 **l2-scene-organizer 子代理进程**里求值，而本函数位于
 * `index.ts` 的 `PI_SUBAGENT_CHILD` 早退**之后** —— 子代理进程里 `l3Controls` 恒为 `undefined`，
 * `l3Controls?.onL2Committed()` 静默 no-op。实测：**46/46 次 `l2_commit` 全部发生在子代理进程，
 * 主会话 0 次** ⇒ 自动触发一次都没生效过（L3 事实上只能靠 `/persona` 手动跑）。
 * 同类坑在 `index.ts` 有注释前科（`l2Controls?.onL1Committed()` 已因此废弃），`read_l1_increment`
 * 也因此在模块顶层注册，唯独 L3 这条漏了。
 *
 * 现结构（两条通道，都不依赖跨进程闭包）：
 *   1. **台账式评估**：主进程每次 `agent_settled` 都调一次 `queueTrigger({})`，
 *      是否真跑完全交给 `evaluateTrigger` 的五级门控（P1–P4 + 增量跳过）。无状态、不怕重启。
 *   2. **显式信号落盘**：子代理的 `personaSignal` 写 `l3/pending-trigger.json`，主进程读取后消费
 *      （读后即删）——保住 `l2-scene-organizer.md` 里那条此前永远无效的 P1 指令。
 *
 * 副作用与配套：通道 1 让"每轮都可能触发"，于是**失败必须熔断** —— 否则阈值条件一直成立，
 * 每轮都会再拉起一个 10 分钟的子代理。熔断复用 `failure-state.ts` 的 l3 层，
 * 判定口径与 L1 一致：**跑完但没提交也算失败**（看 `lastCommittedAt` 是否推进）。
 */
export function setupL3Persona(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): L3Controls {
	let scheduled = false;
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

	async function runTask(task: string, ctx: ExtensionContext): Promise<void> {
		const profilePath = getProfilePath();
		scheduled = true;
		ctx.ui.setStatus("memory", "Memory ⚙L3...");
		const committedBefore = profilePath ? loadL3Cursor(profilePath).lastCommittedAt : "";
		let threw = false;
		try {
			await runPiSubagent("l3-persona-generator", task, ctx, L3_SUBAGENT_TIMEOUT_MS);
		} catch (err) {
			threw = true;
			console.warn(`[memory-system][l3] persona failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			scheduled = false;
		}
		if (!profilePath) return;
		// 成功口径：本轮真的提交过（游标推进）。"跑完但没提交"与抛错同等对待 —— 同 L1 的
		// `extract ended without commit`（l1/index.ts），否则失败会被当成无事发生。
		const committedAfter = loadL3Cursor(profilePath).lastCommittedAt;
		if (!threw && committedAfter !== committedBefore && committedAfter) {
			recordSuccess(profilePath);
		} else {
			recordFailure(profilePath, threw ? "子代理抛错" : "子代理结束但未提交（未推进游标）", ctx);
		}
	}

	function queueTrigger(opts: { personaSignal?: boolean; personaReason?: string; force?: boolean } = {}): void {
		const profilePath = getProfilePath();
		if (!profilePath) return;
		if (scheduled) {
			logSkip("上一轮仍在跑");
			return;
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
			void runTask(task, cachedCtx);
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
			const result = evaluateTrigger(profilePath, { force: true, personaReason: "手动 l3-trigger" });
			const task = buildL3Task(profilePath, result.reason, result.changedScenes);
			if (!task) {
				ctx.ui.notify("L3 无场景可读（scene_index 为空），未触发", "error");
				saveL3Cursor(profilePath, { ...loadL3Cursor(profilePath), lastTriggeredAt: new Date().toISOString() });
				return;
			}
			void runTask(task, ctx);
		} else {
			queueTrigger({ force: true, personaReason: "手动 l3-trigger" });
		}
	}

	pi.on("agent_settled", (_e, ctx) => {
		cachedCtx = ctx;
		const profilePath = getProfilePath();
		if (!profilePath) return;
		// 通道 2：消费子代理落盘的显式信号（读后即删 ⇒ 一个信号只生效一次）
		const signal = consumePendingTrigger(profilePath);
		const opts = {
			...(pendingOpts ?? {}),
			...(signal?.personaSignal ? { personaSignal: true, personaReason: signal.personaReason } : {}),
		};
		pendingTrigger = false;
		pendingOpts = undefined;
		// 通道 1：每轮台账式评估（无状态；跑不跑由 evaluateTrigger 决定）
		queueTrigger(opts);
	});

	return {
		onL1Committed,
		triggerManual,
		reset: () => {
			scheduled = false;
			pendingTrigger = false;
			pendingOpts = undefined;
		},
	};
}
