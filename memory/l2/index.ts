import { randomUUID } from "node:crypto";
import { statSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { L2_BATCH, L2_SUBAGENT_TIMEOUT_MS, buildL2Task } from "./config.js";
import { L1_CURSOR_FILE, MEMORY_DB_DIR } from "../paths.js";

// ══════════════════════════════════════════════════════════════
//  L2 场景记忆 —— 主进程调度
//
//  触发链：l1_commit 写入 {profile}/l1-cursor.json → 主进程 fs.watchFile 轮询
//  该文件 mtime 变化 → 累计 L2_BATCH 批且无进行中任务 → 启动 l2-scene-organizer
//  子代理（globalThis 桥接）→ await 完成。
//
//  为什么不用 l1_commit 的回调（onCommitted）：
//    l1-extractor 是【独立子进程】（pi-subagents 用 --extension 启动新进程，
//    pid 与主进程不同）。回调里的 l2Controls 闭包是子进程扩展实例的变量 =
//    undefined（子进程不跑 setupL2Organizer），可选链静默丢弃。
//    改为监听文件变化（l1-cursor.json 每次 L1 提交都原子写），跨进程天然
//    穿透，彻底绕开回调链断裂问题（2026-08-17 实测修复）。
//
//  游标/场景文件/索引由子代理通过 l2_commit 提交、主进程落盘。
//
//  ctx 获取：缓存最近一次 agent_settled 的 ctx，agent_settled 兜底执行挂起触发。
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
 * @returns { reset }：reset 在切换 profile / 会话结束时调用
 *
 * 取消 onL1Committed 回调（08-17 根因：子代理进程独立加载扩展，回调闭包
 * 跨进程断裂）；改为 fs.watchFile 轮询 l1-cursor.json mtime 变化触发计数。
 */
export function setupL2Organizer(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): { reset: () => void; triggerManual: () => void } {
	let pendingBatches = 0;
	let scheduled = false;
	let pendingTrigger = false;
	let cachedCtx: ExtensionContext | undefined;
	let watchedFile: string | undefined;
	let lastMtimeMs = 0;

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

	/** 文件变化计数：l1-cursor.json mtime 变了 → +1；达 L2_BATCH 触发 L2。 */
	function onCursorChanged(): void {
		if (scheduled) return;
		pendingBatches++;
		if (pendingBatches >= L2_BATCH) {
			pendingBatches = 0;
			queueTrigger();
		}
	}

	/** 启动轮询监听（切换 profile 时重新指向）。 */
	function startWatch(profilePath: string): void {
		if (watchedFile) {
			unwatchFile(watchedFile);
			watchedFile = undefined;
			lastMtimeMs = 0;
		}
		// l1 游标文件名与 l1/config.ts 的 CURSOR_FILE = "l1-cursor.json" 对齐
		const filePath = join(profilePath, MEMORY_DB_DIR, L1_CURSOR_FILE);
		watchedFile = filePath;
		try {
			lastMtimeMs = statSync(filePath).mtimeMs; // 启动时不计 "首次触发"
		} catch {
			lastMtimeMs = 0;
		}
		// interval=2000ms 轮询（够用且不耗 CPU）
		watchFile(filePath, { interval: 2000 }, (curr) => {
			const newMtime = curr.mtimeMs;
			if (newMtime !== lastMtimeMs) {
				lastMtimeMs = newMtime;
				onCursorChanged();
			}
		});
	}

	const initProfile = getProfilePath();
	if (initProfile) startWatch(initProfile);

	// profile 切换时重新监听（session_start 时 profile 可能换）
	pi.on("session_start", () => {
		const p = getProfilePath();
		if (p && join(p, MEMORY_DB_DIR, L1_CURSOR_FILE) !== watchedFile) startWatch(p);
	});

	// 缓存 ctx + 兜底执行挂起触发
	pi.on("agent_settled", (_e, ctx) => {
		cachedCtx = ctx;
		if (pendingTrigger) {
			pendingTrigger = false;
			queueTrigger();
		}
	});

	/** 手动触发一次 L2（绕过攒批 / 跳过 fs.watchFile 监听）。 */
	function triggerManual(): void {
		if (scheduled) return;
		queueTrigger();
	}

	return {
		reset: () => {
			pendingBatches = 0;
			scheduled = false;
			pendingTrigger = false;
			if (watchedFile) {
				unwatchFile(watchedFile);
				watchedFile = undefined;
			}
		},
		triggerManual,
	};
}
