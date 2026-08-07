import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryManager } from "./manager.js";
import {
  computeReviewRange,
  hasCompleteEnding,
  loadCursor,
  saveCursor,
  scanSessionFile,
} from "./review-cursor.js";

/**
 * 记忆审查子代理调度模块。
 * 在 agent_settled 中计数，达到阈值时启动 memory-reviewer 后台审查。
 * 注册 /remember 手动触发命令。
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
	 * 构建审查任务字符串：带游标计算出的行范围 + 用户消息行号。
	 * 返回 null 表示应跳过本次审查（无数据/工作流未完成/无新增）。
	 */
	function buildReviewTask(ctx: ExtensionContext): { task: string; paths: { sessionPath: string; profilePath: string }; endLine: number } | null {
		const paths = prepareReviewPaths(ctx);
		if (!paths) return null;

		// C：轻量未完成检测（快速跳过半途状态）
		if (!hasCompleteEnding(paths.sessionPath)) {
			ctx.ui.setStatus("memory", "Memory skip(进行中)");
			return null;
		}

		// 全量扫描（仅在真正触发时）
		const scanned = scanSessionFile(paths.sessionPath);
		if (!scanned) return null;

		// A：游标增量
		const cursor = loadCursor(paths.profilePath, CURSOR_KEY);
		const cursorLine = cursor && cursor.sessionPath === paths.sessionPath ? cursor.line : 0;

		const range = computeReviewRange(
			paths.sessionPath,
			cursorLine,
			scanned.totalLines,
			scanned.userMessageLines,
			scanned.lastAssistantHasText,
		);

		if (!range.complete) {
			ctx.ui.setStatus("memory", "Memory skip(进行中)");
			return null;
		}

		// 无新增内容（游标已在末尾）→ 跳过
		if (range.userMessageLines.length === 0) {
			ctx.ui.setStatus("memory", `Memory ${REVIEW_INTERVAL - turnCount}t`);
			return null;
		}

		const task = [
			`Review session: ${paths.sessionPath}`,
			`Profile: ${paths.profilePath}`,
			`Start line: ${range.startLine}`,
			`End line: ${range.endLine}`,
			`User message lines: ${range.userMessageLines.join(", ")}`,
		].join("\n");
		return { task, paths, endLine: range.endLine };
	}

	pi.on("agent_settled", async (_event, ctx) => {
		if (!reviewScheduled) turnCount++;
		if (turnCount >= REVIEW_INTERVAL && !reviewScheduled) {
			turnCount = 0;
			const built = buildReviewTask(ctx);
			if (!built) return; // 跳过本次（进行中/无新增），等下一轮 agent_settled
			reviewScheduled = true;
			ctx.ui.setStatus("memory", "Memory ⚙review...");
			try {
				await runPiSubagent("memory-reviewer", built.task, ctx);
				// 审查成功 → 游标推进到末尾（下次从末尾之后开始）
				saveCursor(built.paths.profilePath, CURSOR_KEY, built.paths.sessionPath, built.endLine);
			} finally {
				reviewScheduled = false;
			}
		}
	});

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

	pi.on("agent_settled", async (_event, ctx) => {
		if (!reviewScheduled) turnCount++;
		if (turnCount >= REVIEW_INTERVAL && !reviewScheduled) {
			turnCount = 0;
			reviewScheduled = true;
			ctx.ui.setStatus("memory", "Memory ⚙review...");
			const paths = prepareReviewPaths(ctx);
			const task = paths
				? `Review session: ${paths.sessionPath}\nProfile: ${paths.profilePath}`
				: "No new conversation data to review.";
			runPiSubagent("memory-reviewer", task, ctx)
				.then(() => {
					reviewScheduled = false;
				})
				.catch(() => {
					reviewScheduled = false;
				});
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
					const task = `Review session: ${paths.sessionPath}\nProfile: ${paths.profilePath}`;
					try {
						await runPiSubagent("memory-reviewer", task, ctx);
					} finally {
						reviewScheduled = false;
					}
				} else {
					reviewScheduled = false;
				}
				return;
			}
			try {
				await runPiSubagent("memory-reviewer", built.task, ctx);
				saveCursor(built.paths.profilePath, CURSOR_KEY, built.paths.sessionPath, built.endLine);
			} finally {
				reviewScheduled = false;
			}
		},
	});

	// 返回状态标签，供主入口组合显示
	return () => (reviewScheduled ? "⚙mem" : `${REVIEW_INTERVAL - turnCount}t`);
}
