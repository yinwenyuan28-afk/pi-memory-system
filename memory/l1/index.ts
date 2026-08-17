import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	L1_INTERVAL,
	SUBAGENT_TIMEOUT_MS,
	buildL1Task,
	loadL1Config,
} from "./config.js";

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

// ── 子代理启动（globalThis 桥接，与 reviewer.ts 同模式） ──

async function runPiSubagent(agent: string, task: string, ctx: ExtensionContext): Promise<string> {
	const executor = (globalThis as any)["__piSubagentExecutor"] as
		| ((id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: ExtensionContext) => Promise<any>)
		| undefined;
	if (!executor) throw new Error("pi-subagents executor not available");
	const id = randomUUID();
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const executorPromise = executor(
		id,
		{ agent, task, async: true, clarify: false, agentScope: "both" },
		controller.signal,
		undefined,
		ctx,
	);
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(`subagent ${agent} timed out after ${SUBAGENT_TIMEOUT_MS}ms`));
		}, SUBAGENT_TIMEOUT_MS);
	});
	try {
		await Promise.race([executorPromise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
	return id;
}

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
): () => void {
	let turnCount = 0;
	let scheduled = false;

	pi.on("input", (event) => {
		if (event.source !== "interactive") return;
		if (!scheduled) turnCount++;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (turnCount < L1_INTERVAL || scheduled) return;
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
			await runPiSubagent("l1-extractor", task, ctx);
		} catch (err) {
			console.warn(`[memory-system][l1] extract failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			scheduled = false;
		}
	});

	return () => {
		turnCount = 0;
		scheduled = false;
	};
}

// 导出供 /l1-mode 命令与调试使用
export { loadL1Config } from "./config.js";
