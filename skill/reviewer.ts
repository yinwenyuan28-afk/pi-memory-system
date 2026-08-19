import { runPiSubagent } from "../util/subagent.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MEMORY_DB_DIR, SKILL_FEED_DIR } from "../memory/paths.js";
import { loadCursor, saveCursor } from "../memory/review/review-cursor.js";

/**
 * Skill 审查子代理调度模块。
 * 在 agent_settled 中计数，达到阈值时启动 skill-reviewer 后台审查。
 * 注册 /learn 命令。
 *
 * 数据源：从 L0 分片（2-role）改为读 skill-feed（5-role，含 tool_call/tool_result），
 * 子代理通过 read_skill_feed_increment 工具一次读取游标后全量增量，
 * 保留工具决策链供 skill 提取（M4，2026-08-19 改造）。
 */

const REVIEW_INTERVAL = 20;
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
	 * 构建审查任务：列 skill-feed 文件路径 + reviewer 游标，传给子代理用 read_skill_feed_increment 读增量。
	 */
	function buildReviewTask(ctx: ExtensionContext): { task: string; paths: { profilePath: string }; cursor: string } | null {
		const paths = prepareReviewPaths(ctx);
		if (!paths) return null;

		// 枚举 skill-feed 文件（{memoryDB}/skill-feed/<sessionKey>.jsonl，按 session 一文件）
		const feedDir = join(paths.profilePath, MEMORY_DB_DIR, SKILL_FEED_DIR);
		if (!existsSync(feedDir)) return null;
		let feedFiles: string[] = [];
		try {
			feedFiles = readdirSync(feedDir)
				.filter((f) => f.endsWith(".jsonl"))
				.sort()
				.map((f) => join(feedDir, f));
		} catch {
			return null;
		}
		if (feedFiles.length === 0) return null;

		const cursor = loadCursor(paths.profilePath, CURSOR_KEY);

		// 未完成检测（简单版：读最后一个 skill-feed 文件末尾看是否有完整 assistant 回复；
		// tool_result/tool_call 结尾视为轮次进行中）
		const lastFile = feedFiles[feedFiles.length - 1];
		if (existsSync(lastFile)) {
			const raw = readFileSync(lastFile, "utf-8");
			const lines = raw.split(/\r?\n/).filter((l) => l.trim());
			const tail = lines.slice(-50);
			let hasCompleteReply = false;
			for (const line of tail) {
				try {
					const e = JSON.parse(line);
					if (e.role === "tool_result" || e.role === "tool_call") hasCompleteReply = false;
					else if (e.role === "user") hasCompleteReply = false;
					else if (e.role === "assistant" && typeof e.content === "string" && e.content.trim()) hasCompleteReply = true;
				} catch { continue; }
			}
			if (!hasCompleteReply) {
				ctx.ui.setStatus("memory", "Skill skip(进行中)");
				return null;
			}
		}

		const reviewerCursor = cursor && cursor.sessionPath ? cursor.sessionPath : "";
		const task = [
			`SkillFeedFiles: ${feedFiles.join(",")}`,
			`CursorPath: ${join(paths.profilePath, MEMORY_DB_DIR, "skill-feed-cursor.json")}`,
			`ReviewerCursor: ${reviewerCursor}`,
			`ProfilePath: ${paths.profilePath}`,
		].join("\n");

		return { task, paths, cursor: reviewerCursor };
	}

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
			ctx.ui.setStatus("memory", "Memory ⚙skill-review...");
			try {
				await runPiSubagent("skill-reviewer", built.task, ctx, SUBAGENT_TIMEOUT_MS);
				saveCursor(built.paths.profilePath, CURSOR_KEY, new Date().toISOString(), Date.now());
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
				const paths = prepareReviewPaths(ctx);
				if (paths) {
					const task = `Review session: ${paths.sessionPath}\nProfile: ${paths.profilePath}${extra ? `\nExtra context: ${extra}` : ""}`;
					try {
						await runPiSubagent("skill-reviewer", task, ctx, SUBAGENT_TIMEOUT_MS);
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
				await runPiSubagent("skill-reviewer", built.task + (extra ? `\nExtra context: ${extra}` : ""), ctx, SUBAGENT_TIMEOUT_MS);
				saveCursor(built.paths.profilePath, CURSOR_KEY, new Date().toISOString(), Date.now());
			} finally {
				reviewScheduled = false;
			}
			ctx.ui.notify("Learning skill from your request...", "info");
		},
	});

	return () => (reviewScheduled ? "⚙skill" : `${REVIEW_INTERVAL - turnCount}t`);
}
