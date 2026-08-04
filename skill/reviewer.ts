import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  computeReviewRange,
  hasCompleteEnding,
  loadCursor,
  saveCursor,
  scanSessionFile,
} from "../memory/review-cursor.js";

/**
 * Skill 审查子代理调度模块。
 * 在 agent_settled 中计数，达到阈值时启动 skill-reviewer 后台审查。
 * 注册 /learn 命令。
 */

const REVIEW_INTERVAL = 10;
const CURSOR_KEY = "skillReviewer";

/** 后台审查子代理超时（毫秒）：10 分钟，防止 executor 卡死导致审查永久停摆（M7）。 */
const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;

export function setupSkillReviewer(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): () => string {
	let turnCount = 0;
	let reviewScheduled = false;

	function prepareReviewPaths(ctx: ExtensionContext): { sessionPath: string; profilePath: string } | null {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) return null;
		const profilePath = getProfilePath();
		if (!profilePath) return null;
		return { sessionPath: sessionFile, profilePath };
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
			ctx.ui.setStatus("memory", "Skill skip(进行中)");
			return null;
		}

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
			ctx.ui.setStatus("memory", "Skill skip(进行中)");
			return null;
		}

		// 无新增内容（游标已在末尾）→ 跳过
		if (range.userMessageLines.length === 0) {
			ctx.ui.setStatus("memory", `Skill ${REVIEW_INTERVAL - turnCount}t`);
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
			const built = buildReviewTask(ctx);
			if (!built) return; // 跳过本次（进行中/无新增），等下一轮 agent_settled
			reviewScheduled = true;
			ctx.ui.setStatus("memory", "Memory ⚙skill-review...");
			try {
				await runPiSubagent("skill-reviewer", built.task, ctx);
				// 审查成功 → 游标推进到末尾
				saveCursor(built.paths.profilePath, CURSOR_KEY, built.paths.sessionPath, built.endLine);
			} finally {
				reviewScheduled = false;
			}
		}
	});

	pi.registerCommand("learn", {
		description: "Learn a reusable skill from source code, docs, or conversation. Usage: /learn [source]",
		handler: async (args, ctx) => {
			if (reviewScheduled) {
				ctx.ui.notify("Skill review already in progress", "info");
				return;
			}
			reviewScheduled = true;
			const extra = (args || "").trim();
			const built = buildReviewTask(ctx);
			if (!built) {
				// 无新增内容或工作流未完成：仍走一次全量兜底
				const paths = prepareReviewPaths(ctx);
				if (paths) {
					const task = `Review session: ${paths.sessionPath}\nProfile: ${paths.profilePath}${extra ? `\nExtra context: ${extra}` : ""}`;
					try {
						await runPiSubagent("skill-reviewer", task, ctx);
					} finally {
						reviewScheduled = false;
					}
				} else {
					reviewScheduled = false;
				}
				ctx.ui.notify("Learning skill from your request...", "info");
				return;
			}
			try {
				await runPiSubagent("skill-reviewer", built.task + (extra ? `\nExtra context: ${extra}` : ""), ctx);
				saveCursor(built.paths.profilePath, CURSOR_KEY, built.paths.sessionPath, built.endLine);
			} finally {
				reviewScheduled = false;
			}
			ctx.ui.notify("Learning skill from your request...", "info");
		},
	});

	// 返回状态标签，供主入口组合显示
	return () => (reviewScheduled ? "⚙skill" : `${REVIEW_INTERVAL - turnCount}t`);
}
