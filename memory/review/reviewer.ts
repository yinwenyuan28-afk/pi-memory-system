import { runPiSubagent } from "../../util/subagent.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryManager } from "../core/manager.ts";
import { listL0Files, loadL1Cursor } from "../l1/config.ts";
import { MEMORY_DB_DIR } from "../paths.ts";
import { loadCursor, saveCursor } from "./review-cursor.ts";

/**
 * 记忆审查子代理调度模块。
 * 在 agent_settled 中计数，达到阈值时启动 memory-reviewer 后台审查。
 * 注册 /remember 手动触发命令。
 *
 * 数据源：从原始 session JSONL 改为读 L0 分片（净化后、按天分片），
 * 子代理通过 read_l0_increment 工具一次读取游标后全量增量，
 * 放弃原本逐次 read 原始 session 的方式（2026-08-17 改造）。
 */

const REVIEW_INTERVAL = 20;
const CURSOR_KEY = "memoryReviewer";

/** 后台审查子代理超时（毫秒）：10 分钟，防止 executor 卡死导致审查永久停摆（M7）。 */
const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;

export function setupMemoryReviewer(pi: ExtensionAPI, getManager: () => MemoryManager | undefined): () => string {
	let turnCount = 0;
	let reviewScheduled = false;

	function prepareReviewPaths(ctx: ExtensionContext): { sessionPath: string; profilePath: string } | null {
		const manager = getManager();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) return null;
		const profile = manager?.getProfileManager().getActiveProfile();
		if (!profile) return null;
		return { sessionPath: sessionFile, profilePath: profile.path };
	}

	/**
	 * 构建审查任务：读 L0 分片路径 + reviewer 游标，传给子代理用 read_l0_increment 读增量。
	 * 游标格式：recordedAt（ISO 字符串），增量 = recordedAt > 游标的所有 L0 行。
	 */
	function buildReviewTask(ctx: ExtensionContext): { task: string; paths: { profilePath: string }; cursor: string } | null {
		const paths = prepareReviewPaths(ctx);
		if (!paths) return null;

		// 枚举 L0 分片（复用 L1 的 listL0Files，传游标日期筛选分片）
		const cursor = loadCursor(paths.profilePath, CURSOR_KEY);
		const l1Cursor = loadL1Cursor(paths.profilePath); // L0 游标（recordedAt）
		const l0Files = listL0Files(paths.profilePath, l1Cursor);
		if (l0Files.length === 0) return null;

		// 未完成检测（简单版：读最后一个 L0 分片末尾看是否有完整 assistant 回复）
		const lastFile = l0Files[l0Files.length - 1];
		if (existsSync(lastFile)) {
			const raw = readFileSync(lastFile, "utf-8");
			const lines = raw.split(/\r?\n/).filter((l) => l.trim());
			const tail = lines.slice(-50);
			let hasCompleteReply = false;
			for (const line of tail) {
				try {
					const e = JSON.parse(line);
					if (e.role === "user") hasCompleteReply = false;
					else if (e.role === "assistant" && typeof e.content === "string" && e.content.trim()) hasCompleteReply = true;
				} catch { continue; }
			}
			if (!hasCompleteReply) {
				ctx.ui.setStatus("memory", "Memory skip(进行中)");
				return null;
			}
		}

		// reviewer 游标（上次审查时间戳）
		const reviewerCursor = cursor && cursor.sessionPath ? cursor.sessionPath : "";
		const task = [
			`L0Files: ${l0Files.join(",")}`,
			`CursorPath: ${join(paths.profilePath, MEMORY_DB_DIR, "l0-cursor.json")}`,
			`ReviewerCursor: ${reviewerCursor}`,
			`ProfilePath: ${paths.profilePath}`,
		].join("\n");

		return { task, paths, cursor: reviewerCursor };
	}

	// 用户轮次计数
	pi.on("input", (event) => {
		if (event.source !== "interactive") return;
		if (!reviewScheduled) turnCount++;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (turnCount >= REVIEW_INTERVAL && !reviewScheduled) {
			turnCount = 0;
			const built = buildReviewTask(ctx);
			if (!built) return;
			reviewScheduled = true;
			ctx.ui.setStatus("memory", "Memory ⚙review...");
			try {
				await runPiSubagent("memory-reviewer", built.task, ctx, SUBAGENT_TIMEOUT_MS);
				// 审查成功 → 游标推进到当前时间戳（下次从增量末尾开始）
				saveCursor(built.paths.profilePath, CURSOR_KEY, new Date().toISOString(), Date.now());
			} finally {
				reviewScheduled = false;
			}
		}
	});

	pi.registerCommand("remember", {
		description: "Manually trigger a full memory review of the entire conversation.",
		usage: "Usage: /remember",
		handler: async (_args, ctx) => {
			if (reviewScheduled) {
				ctx.ui.notify("Memory review already in progress", "info");
				return;
			}
			reviewScheduled = true;
			ctx.ui.setStatus("memory", "Memory ⚙remember...");
			ctx.ui.notify("Memory review started via pi-subagents", "info");
			const built = buildReviewTask(ctx);
			if (!built) {
				// 无新增内容或工作流未完成：仍走一次全量兜底（无游标时）
				const paths = prepareReviewPaths(ctx);
				if (paths) {
					const l1Cursor = loadL1Cursor(paths.profilePath);
					const l0Files = listL0Files(paths.profilePath, l1Cursor);
					if (l0Files.length > 0) {
						const task = `L0Files: ${l0Files.join(",")}\nCursorPath: ${join(paths.profilePath, MEMORY_DB_DIR, "l0-cursor.json")}\nReviewerCursor: \nProfilePath: ${paths.profilePath}`;
						try {
							await runPiSubagent("memory-reviewer", task, ctx, SUBAGENT_TIMEOUT_MS);
						} finally {
							reviewScheduled = false;
						}
					} else {
						reviewScheduled = false;
					}
				} else {
					reviewScheduled = false;
				}
				return;
			}
			try {
				await runPiSubagent("memory-reviewer", built.task, ctx, SUBAGENT_TIMEOUT_MS);
				saveCursor(built.paths.profilePath, CURSOR_KEY, new Date().toISOString(), Date.now());
			} finally {
				reviewScheduled = false;
			}
		},
	});

	// 返回状态标签，供主入口组合显示
	return () => (reviewScheduled ? "⚙mem" : `${REVIEW_INTERVAL - turnCount}t`);
}
