import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ContentFilter } from "./content-filter.js";
import { checkDuplicate } from "./duplicate-check.js";
import type { InvertedIndex } from "../search/inverted-index.js";
import type { MemoryStore } from "./store.js";
import type { FilterResult, MemorySaveLog, Target } from "./types.js";
import { loadMemoryPrompts } from "../prompts.js";

const contentFilter = new ContentFilter();

// ══════════════════════════════════════════════════════════════
// 保存指南 —— 注入到 MEMORY_SCHEMA.description 和子代理 prompt
// 让 LLM 自行判断内容是否值得记忆，取代代码级强制阻断。
// 内容在 prompts/save-guidelines.md（编辑 md 即可微调，fallback 内置默认）
// ══════════════════════════════════════════════════════════════

const SAVE_GUIDELINES = loadMemoryPrompts().saveGuidelines;

/**
 * OpenAI Function-Calling schema for the `memory` tool.
 *
 * The LLM uses this to read/write/update persistent memory.
 */
export const MEMORY_SCHEMA = {
	name: "memory",
	description:
		"Save durable facts to persistent memory that survive across sessions. " +
		"Memory is injected into every turn, so keep entries compact and high-signal.\n\n" +
		"HOW: make ALL your changes in ONE call via the 'operations' array. " +
		"The batch applies atomically and the char limit is checked on the FINAL result — " +
		"so one call can remove stale entries to free room AND add new ones together. " +
		"Use bare action/content/old_text only for a single lone change.\n\n" +
		"WHEN: save proactively when the user states a preference, correction, or personal detail. " +
		"The best memory is one that prevents the user from having to correct or remind you again. " +
		"Priority: user preferences & corrections > environment facts > project specifics > procedures.\n\n" +
		"IF FULL: an add is rejected with current entries shown. Reissue as ONE batch " +
		"that removes or shortens stale entries and adds the new one together.\n\n" +
		"TARGETS:\n" +
		"  'user' = who the user is (preferences, style, role, habits)\n" +
		"  'memory' = global env facts (encoding, OS, tool versions, universal paths)\n" +
		"  'sub-memory' = project-specific info (requires path param: '{category}/{name}.md')\n" +
		"\n" +
		"SKIP: trivial/obvious info, task progress, completed-work logs, temporary TODO state. " +
		"Reusable procedures and workflows belong in a skill (use skill_manage), not memory.\n\n" +
		SAVE_GUIDELINES,

	// Append classification reference to description
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: ["add", "replace", "remove"],
				description: "The action to perform (single-op shape). Omit when using 'operations'.",
			},
			target: {
				type: "string",
				enum: ["memory", "user", "sub-memory"],
				description:
					"CRITICAL — wrong target = routing system can never load it.\n" +
					"  'user'        = user attributes (preference, habit, role, style)\n" +
					"  'memory'      = global env facts (encoding, OS, universal paths)\n" +
					"  'sub-memory'  = project-specific (requires path param: '{category}/{name}.md')\n" +
					"\n" +
					"项目路径/端口/版本/配置 -> sub-memory | 用户偏好 -> user | 全局常量 -> memory",
			},
			content: {
				type: "string",
				description: "The entry content. Required for 'add' and 'replace' (single-op shape).",
			},
			path: {
				type: "string",
				description:
					"REQUIRED for target='sub-memory': relative path under sub-memories/, e.g. " +
					"'wangxin/A104527-java8-setup.md'. Use a descriptive filename with category prefix.",
			},
			old_text: {
				type: "string",
				description:
					"REQUIRED for 'replace' and 'remove' (single-op shape): a short unique substring " +
					"identifying the existing entry to modify. Omit only for 'add'.",
			},
			operations: {
				type: "array",
				description:
					"Batch shape: a list of operations applied atomically in one call " +
					"against the final char budget. Preferred when making multiple changes " +
					"or consolidating to make room. Each item is {action, content?, old_text?, path?}.",
				items: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["add", "replace", "remove"],
						},
						content: {
							type: "string",
							description: "Entry content for add/replace.",
						},
						old_text: {
							type: "string",
							description: "Substring identifying the entry for replace/remove.",
						},
						path: {
							type: "string",
							description:
								"Required for target='sub-memory': relative path under sub-memories/, e.g. " +
								"'wangxin/A104527-java8-setup.md'.",
						},
					},
					required: ["action"],
				},
			},
			reason: {
				type: "string",
				description:
					"WHY this entry is being saved. What makes it worth persisting? " +
					"Examples: 'user corrected my format preference', 'env quirk that caused repeated errors', " +
					"'project-specific convention for this repo'. Helps optimize memory quality over time.",
			},
			source: {
				type: "string",
				enum: ["llm", "memory-reviewer", "skill-reviewer", "remember", "learn"],
				description: "Who or what triggered this memory save. Helps attribution for save-log analysis.",
			},
		},
		required: ["target"],
	},
};

/**
 * Handler for the `memory` tool call.
 * Returns a JSON string result.
 */
/** Weak signal: content looks like a project-specific path or config. */
/** 追加一条记忆保存日志到 save-log.jsonl。 */
function appendSaveLog(saveLogPath: string | undefined, entry: MemorySaveLog): void {
	if (!saveLogPath) return;
	try {
		const dir = dirname(saveLogPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(saveLogPath, JSON.stringify(entry) + "\n", "utf-8");
	} catch {
		// 日志写入失败不阻断记忆保存
	}
}

export function handleMemoryTool(
	args: Record<string, unknown>,
	store: MemoryStore,
	invertedIndex?: InvertedIndex,
	profilePath?: string,
	saveLogPath?: string,
): string {
	const target = (args.target as Target) || "memory";
	if (target !== "memory" && target !== "user" && target !== "sub-memory") {
		return JSON.stringify({
			success: false,
			error: `Invalid target '${target}'. Use 'memory', 'user', or 'sub-memory'.`,
		});
	}

	// Build the content to check from single or batch operations
	const contentToCheck =
		String(args.content || "") +
		(args.operations
			? (args.operations as Array<Record<string, unknown>>).map((op) => String(op.content || "")).join(" ")
			: "");

	// 1. Content filter (blocking rules + warning rules)
	const filterResult: FilterResult = contentFilter.check(contentToCheck, target);
	if (filterResult.blocked) {
		return JSON.stringify({
			success: false,
			error: `内容被过滤器阻断：${filterResult.reason}`,
			filterId: filterResult.ruleId,
		});
	}

	// 2. Duplicate check (semantic)
	const action = String(args.action || "");
	const content = args.content !== undefined ? String(args.content) : undefined;
	if (action === "add" && content && invertedIndex && profilePath) {
		const dupResult = checkDuplicate(content, invertedIndex, profilePath);
		if (dupResult.isDuplicate) {
			return JSON.stringify({
				success: false,
				error: `语义重复：${dupResult.existingContent}`,
				suggestion: dupResult.suggestion,
				similarity: dupResult.similarity,
			});
		}
	}

	// Batch path
	const operations = args.operations;
	if (Array.isArray(operations) && operations.length > 0) {
		const result = store.applyBatch(
			target,
			operations.map((op: unknown) => {
				const o = op as Record<string, unknown>;
				return {
					action: String(o.action || ""),
					content: o.content !== undefined ? String(o.content) : undefined,
					oldText: o.old_text !== undefined ? String(o.old_text) : undefined,
					path: o.path !== undefined ? String(o.path) : undefined,
				};
			}),
		);
		if (filterResult.warning) {
			return JSON.stringify({ ...result, routeWarning: filterResult.warning });
		}
		if (result.success) {
			appendSaveLog(saveLogPath, {
				timestamp: Date.now(),
				target,
				action: "batch",
				content: `${operations.length} ops`,
				reason: String(args.reason || ""),
				source: String(args.source || "llm"),
			});
		}
		return JSON.stringify(result);
	}

	// Single-op path
	const oldText = args.old_text !== undefined ? String(args.old_text) : undefined;
	const subMemoryPath = args.path !== undefined ? String(args.path) : undefined;

	if (action === "add") {
		if (!content) {
			return JSON.stringify({ success: false, error: "Content is required for 'add' action." });
		}
		const result = store.add(target, content, { path: subMemoryPath });
		if (filterResult.warning) {
			return JSON.stringify({ ...result, routeWarning: filterResult.warning });
		}
		// 记录保存日志
		if (result.success) {
			appendSaveLog(saveLogPath, {
				timestamp: Date.now(),
				target,
				action: "add",
				content: content.length > 200 ? content.slice(0, 200) + "..." : content,
				reason: String(args.reason || ""),
				source: String(args.source || "llm"),
				charLimit: (result as any).usage,
			});
		}
		return JSON.stringify(result);
	}

	if (action === "replace") {
		if (!oldText) {
			return JSON.stringify({ success: false, error: "old_text is required for 'replace' action." });
		}
		if (!content) {
			return JSON.stringify({ success: false, error: "content is required for 'replace' action." });
		}
		const result = store.replace(target, oldText, content, { path: subMemoryPath });
		if (result.success) {
			appendSaveLog(saveLogPath, {
				timestamp: Date.now(),
				target,
				action: "replace",
				content: content.length > 200 ? content.slice(0, 200) + "..." : content,
				reason: String(args.reason || ""),
				source: String(args.source || "llm"),
			});
		}
		return JSON.stringify(result);
	}

	if (action === "remove") {
		if (!oldText) {
			return JSON.stringify({ success: false, error: "old_text is required for 'remove' action." });
		}
		const result = store.remove(target, oldText, { path: subMemoryPath });
		return JSON.stringify(result);
	}

	return JSON.stringify({
		success: false,
		error: `Unknown action '${action}'. Use: add, replace, remove`,
	});
}
