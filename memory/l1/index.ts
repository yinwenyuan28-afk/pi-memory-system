import { runPiSubagent } from "../../util/subagent.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	L1_INTERVAL,
	SUBAGENT_TIMEOUT_MS,
	buildL1Task,
	loadL1Config,
	L1_FAILURE_THRESHOLD,
} from "./config.js";
import { loadFailureState, saveFailureState, type LayerFailureState } from "../failure-state.js";

// ══════════════════════════════════════════════════════════════
//  L1 原子记忆 —— 主进程调度
//
//  职责（复刻腾讯 PipelineManager 的简化版）：
//    1. 触发：input 事件（source=interactive）计数，每 L1_INTERVAL 轮启动一次后台
//       l1-extractor 子代理（globalThis 桥接，与 memory-reviewer 同模式）
//    2. 任务构造：buildL1Task（读游标 → 列 cursor 日期及之后的分片 → 拼任务消息，
//       见 ./config.ts）
//    3. await 子代理完成后更新状态栏（游标/records 由子代理回写）
//
//  不做的事：召回注入（用户拍板推迟）、倒排索引（随注入计划一起做）——records
//  是 JSONL 且注入未接入，暂无检索消费方。
//
//  配置 / 游标 / 分片清单等纯函数在 ./config.ts（无 pi 依赖，可单测）。
// ══════════════════════════════════════════════════════════════

// ── 调度器 ──

/**
 * 注册 L1 提取调度（单次调用；session 生命周期内有效）。
 *
 * 触发链：input 事件（用户消息，source=interactive）计数 → 达 L1_INTERVAL 轮且
 * 无进行中任务 → 启动 l1-extractor 子代理 → await 完成 → 状态栏恢复。
 * 用 input 而非 agent_settled 计数：避免子代理完成通知（triggerTurn）误推阈值
 * （复用 08-11 reviewer 根因教训）。
 *
 * @param pi                ExtensionAPI
 * @param getProfilePath    当前 profile 路径（跟随 profile 切换）
 * @returns 重置函数（切换 profile / 会话结束时调用）
 */
export function setupL1Extractor(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
	l2ControlsRef?: { triggerManual: (ctx?: ExtensionContext) => void | Promise<void> },
): {
	reset: () => void;
	triggerManual: (ctx?: ExtensionContext) => void;
} {
	let turnCount = 0;
	let scheduled = false;

	// 熔断状态走磁盘持久（见 ../failure-state.js），不在内存里，重启后仍生效。
	function loadL1State(): LayerFailureState {
		const p = getProfilePath();
		return p ? loadFailureState(p).l1 : { consecutiveFailures: 0, cooledDown: false };
	}
	function saveL1State(s: LayerFailureState): void {
		const p = getProfilePath();
		if (!p) return;
		const all = loadFailureState(p);
		all.l1 = s;
		saveFailureState(p, all);
	}

	pi.on("input", (event) => {
		if (event.source !== "interactive") return;
		if (!scheduled) turnCount++;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (turnCount < L1_INTERVAL || scheduled) return;
		const st = loadL1State();
		if (st.cooledDown) return; // 熔断期间暂停自动提取
		const profilePath = getProfilePath();
		if (!profilePath) return;

		const task = buildL1Task(profilePath);
		if (!task) {
			turnCount = 0; // 无 L0 数据，重置计数避免空转
			return;
		}
		turnCount = 0;
		scheduled = true;
		ctx.ui.setStatus("memory", "Memory ⚙L1...");
		try {
			await runPiSubagent("l1-extractor", task, ctx, SUBAGENT_TIMEOUT_MS);
			const s2 = loadL1State();
			s2.consecutiveFailures = 0; // 子代理正常结束（含已 commit）才清零
			saveL1State(s2);
			// 串行修复（2026-08-20）：L1 子代理完成后再显式触发 L2。若因 watchFile
			// 抢跑导致 L2 已处理过部分 records，这里 triggerManual 会因 staged 空跳过；
			// 若 L1 提交的 records 尚未被 L2 处理，这里补一次整理。两者都避免 L1/L2 并行。
			if (l2ControlsRef?.triggerManual) {
				await l2ControlsRef.triggerManual(ctx);
			}
		} catch (err) {
			const s2 = loadL1State();
			s2.consecutiveFailures++;
			console.warn(`[memory-system][l1] extract failed: ${err instanceof Error ? err.message : String(err)}`);
			if (s2.consecutiveFailures >= L1_FAILURE_THRESHOLD && !s2.cooledDown) {
				s2.cooledDown = true;
				ctx.ui.notify(
					`L1 记忆提取连续失败 ${s2.consecutiveFailures} 次，已暂停自动提取。用 /my-memory:l1-trigger 手动重试或检查日志。`,
					"error",
				);
			}
			saveL1State(s2);
		} finally {
			scheduled = false;
		}
	});

	// 手动触发一轮 L1 提取（供 /l1-trigger 命令调用）
	const triggerManual = async (ctx?: ExtensionContext) => {
		if (scheduled) {
			console.warn("[memory-system][l1] 已有一个提取任务在进行中");
			return;
		}
		const profilePath = getProfilePath();
		if (!profilePath) {
			console.warn("[memory-system][l1] 无有效 profile，跳过手动触发");
			return;
		}
		const task = buildL1Task(profilePath);
		if (!task) {
			console.warn("[memory-system][l1] 无 L0 增量数据，跳过手动触发");
			return;
		}
		const s2 = loadL1State();
		s2.cooledDown = false; // 手动触发即恢复熔断
		s2.consecutiveFailures = 0;
		saveL1State(s2);
		scheduled = true;
		if (ctx) ctx.ui.setStatus("memory", "Memory ⚙L1 (manual)...");
		try {
			await runPiSubagent("l1-extractor", task, ctx, SUBAGENT_TIMEOUT_MS);
			const s3 = loadL1State();
			s3.consecutiveFailures = 0;
			saveL1State(s3);
			// 串行修复（2026-08-20）：手动触发 L1 完成后同样补一次 L2 整理
			if (l2ControlsRef?.triggerManual) {
				await l2ControlsRef.triggerManual(ctx);
			}
		} catch (err) {
			const s3 = loadL1State();
			s3.consecutiveFailures++;
			console.warn(`[memory-system][l1] manual extract failed: ${err instanceof Error ? err.message : String(err)}`);
			if (s3.consecutiveFailures >= L1_FAILURE_THRESHOLD && !s3.cooledDown) {
				s3.cooledDown = true;
				if (ctx)
					ctx.ui.notify(
						`L1 记忆提取连续失败 ${s3.consecutiveFailures} 次，已暂停自动提取。用 /my-memory:l1-trigger 手动重试或检查日志。`,
						"error",
					);
			}
			saveL1State(s3);
		} finally {
			scheduled = false;
		}
	};

	return {
		reset: () => {
			turnCount = 0;
			scheduled = false;
		},
		triggerManual,
	};
}

// 导出供 /l1-mode 命令与调试使用
export { loadL1Config } from "./config.js";
