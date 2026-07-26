import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SkillManager } from "./skill-manager.js";

/**
 * Skill 审查子代理调度模块。
 * 在 agent_settled 中计数，达到阈值时启动 skill-reviewer 后台审查。
 * 注册 /learn 命令。
 */

const REVIEW_INTERVAL = 10;

const _AUTHORING_STANDARDS = `
Frontmatter:
- name: lowercase-hyphenated, <=64 chars, no spaces.
- description: ONE sentence, <=60 characters, ends with a period.
- version: 0.1.0
- author: Pi

Body sections:
1. "## When to Use" — concrete trigger phrases
2. "## Prerequisites" — exact env vars, install steps, credentials
3. "## How to Run" — the canonical invocation
4. "## Procedure" — numbered steps with exact commands
5. "## Pitfalls" — known limits, gotchas
6. "## Verification" — one check that proves it worked
`;

export function setupSkillReviewer(
	pi: ExtensionAPI,
	getManager: () => SkillManager | undefined,
	getLoadedSkills: () => Set<string>,
): () => string {
	let turnCount = 0;
	let reviewScheduled = false;

	function prepareReviewPaths(ctx: ExtensionContext): { sessionPath: string; profilePath: string } | null {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) return null;
		// Skill reviewer 不需要直接访问 MemoryManager 来获取 profile
		// 因为 session file 路径足够定位
		return { sessionPath: sessionFile, profilePath: "" };
	}

	async function runPiSubagent(agent: string, task: string, ctx: ExtensionContext): Promise<string> {
		const executor = (globalThis as any)["__piSubagentExecutor"] as
			| ((id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: ExtensionContext) => Promise<any>)
			| undefined;
		if (!executor) throw new Error("pi-subagents executor not available");
		const id = randomUUID();
		await executor(
			id,
			{ agent, task, async: true, clarify: false, agentScope: "both" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		return id;
	}

	pi.on("agent_settled", async (_event, ctx) => {
		if (!reviewScheduled) turnCount++;
		if (turnCount >= REVIEW_INTERVAL && !reviewScheduled) {
			turnCount = 0;
			reviewScheduled = true;
			ctx.ui.setStatus("memory", "Memory ⚙skill-review...");
			const paths = prepareReviewPaths(ctx);
			const task = paths
				? `Review session: ${paths.sessionPath}\nProfile: ${paths.profilePath}`
				: "No new conversation data to review.";
			runPiSubagent("skill-reviewer", task, ctx)
				.then(() => {
					reviewScheduled = false;
				})
				.catch(() => {
					reviewScheduled = false;
				});
		}
	});

	function buildLearnPrompt(userRequest: string): string {
		const req = (userRequest || "").trim() || "everything we accomplished in the current conversation";
		return (
			"[/learn] The user wants you to learn a reusable skill from the request below.\n\n" +
			`THE REQUEST:\n${req}\n\n` +
			"The request may mix SOURCES and REQUIREMENTS. Treat EVERY part as load-bearing.\n\n" +
			"Do this:\n" +
			"1. Gather every source using your existing tools.\n" +
			"2. Check for duplicates: use `skill_manage(list)` to list existing skills. " +
			"If the new content overlaps with an existing skill, UPDATE it with `skill_manage(edit)` instead of creating a new file.\n" +
			"3. Apply every requirement and constraint in the request.\n" +
			"4. Save the skill: `skill_manage(action=\"create\")` (only if no existing skill covers this).\n\n" +
			`${_AUTHORING_STANDARDS}\n\n` +
			"When done, tell the user the skill name, its category, and a one-line summary of what it captured."
		);
	}

	pi.registerCommand("learn", {
		description: "Learn a reusable skill from source code, docs, or conversation. Usage: /learn [source]",
		handler: async (args, ctx) => {
			const prompt = buildLearnPrompt(args || "");
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			ctx.ui.notify("Learning skill from your request...", "info");
		},
	});

	// 返回状态标签，供主入口组合显示
	return () => (reviewScheduled ? "⚙skill" : `${REVIEW_INTERVAL - turnCount}t`);
}
