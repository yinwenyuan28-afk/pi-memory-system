import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { L2_BATCH, L2_SUBAGENT_TIMEOUT_MS, buildL2Task } from "./config.js";

// ══════════════════════════════════════════════════════════════
//  L2 场景记忆 —— 主进程调度
//
//  触发链（用户拍板攒批）：L1 每成功提交一批（l1_commit 成功）回调
//  onL1Committed() 计数 → 累计 L2_BATCH 批且无进行中任务 → 启动
//  l2-scene-organizer 子代理（globalThis 桥接）→ await 完成。
//  游标/场景文件/索引由子代理通过 l2_commit 提交、主进程落盘。
//
//  ctx 获取：子代理桥接需要 ExtensionContext，缓存最近一次
//  agent_settled 的 ctx（l1_commit 总是发生在 agent 运行中，必然
//  有已缓存的 ctx；agent_settled 兜底执行挂起触发）。
//
//  配置/游标纯函数在 ./config.ts；写盘逻辑在 ./commit-tool.ts。
// ══════════════════════════════════════════════════════════════

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
			reject(new Error(`subagent ${agent} timed out after ${L2_SUBAGENT_TIMEOUT_MS}ms`));
		}, L2_SUBAGENT_TIMEOUT_MS);
	});
	try {
		await Promise.race([executorPromise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
	return id;
}

/**
 * 注册 L2 组织调度（单次调用）。
 *
 * @param pi                ExtensionAPI
 * @param getProfilePath    当前 profile 路径
 * @returns { onL1Committed, reset }：onL1Committed 由 l1_commit 成功后调用；
 *          reset 在切换 profile / 会话结束时调用
 */
export function setupL2Organizer(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): { onL1Committed: () => void; reset: () => void } {
	let pendingBatches = 0;
	let scheduled = false;
	let pendingTrigger = false;
	let cachedCtx: ExtensionContext | undefined;

	async function runTask(task: string, ctx: ExtensionContext): Promise<void> {
		scheduled = true;
		ctx.ui.setStatus("memory", "Memory ⚙L2...");
		try {
			await runPiSubagent("l2-scene-organizer", task, ctx);
		} catch (err) {
			console.warn(`[memory-system][l2] organize failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			scheduled = false;
		}
	}

	function queueTrigger(): void {
		const profilePath = getProfilePath();
		if (!profilePath) return;
		const task = buildL2Task(profilePath);
		if (!task) return;
		if (cachedCtx) {
			void runTask(task, cachedCtx);
		} else {
			pendingTrigger = true; // 等 agent_settled 提供 ctx 后执行
		}
	}

	/** L1 提交成功后调用：累计批数，达 L2_BATCH 触发一次 L2。 */
	function onL1Committed(): void {
		if (scheduled) return;
		pendingBatches++;
		if (pendingBatches >= L2_BATCH) {
			pendingBatches = 0;
			queueTrigger();
		}
	}

	// 缓存 ctx + 兜底执行挂起触发
	pi.on("agent_settled", (_e, ctx) => {
		cachedCtx = ctx;
		if (pendingTrigger) {
			pendingTrigger = false;
			queueTrigger();
		}
	});

	return {
		onL1Committed,
		reset: () => {
			pendingBatches = 0;
			scheduled = false;
			pendingTrigger = false;
		},
	};
}
