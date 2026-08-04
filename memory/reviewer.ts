import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryManager } from "./manager.js";

/**
 * 记忆审查子代理调度模块。
 * 在 agent_settled 中计数，达到阈值时启动 memory-reviewer 后台审查。
 * 注册 /remember 手动触发命令。
 */

const REVIEW_INTERVAL = 10;

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
			ctx.ui.notify("Full memory review started via pi-subagents", "info");
			const paths = prepareReviewPaths(ctx);
			const task = paths
				? `Review session: ${paths.sessionPath}\nProfile: ${paths.profilePath}`
				: "No new conversation data to review.";
			runPiSubagent("memory-reviewer", task, ctx)
				.then(() => { reviewScheduled = false; })
				.catch(() => { reviewScheduled = false; });
		},
	});

	// 返回状态标签，供主入口组合显示
	return () => (reviewScheduled ? "⚙mem" : `${REVIEW_INTERVAL - turnCount}t`);
}
