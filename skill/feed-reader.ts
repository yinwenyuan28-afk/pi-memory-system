// ══════════════════════════════════════════════════════════════
//  skill/feed-reader.ts — read_skill_feed_increment 工具
//
//  定位：skill-reviewer 消费端（M4）。对齐 read_l0_increment 的增量读取
//  语义，但**保留全部 4 角色**（user/assistant/tool_call/tool_result，
//  不丢工具链），供 skill 提取看到完整决策过程。
//
//  游标：entry.recordedAt（ISO 写入时间，feed-cleaner 写入时打戳）。
//  返回值约定（与 read_l0_increment 一致）：
//    - messages: 游标后新消息（时间升序；子代理按需自行截取）
//    - background: 增量前最近 5 条（仅供理解上下文，严禁提取）
//    - nextCursor: 增量最后一条的 recordedAt（子代理提交时作为新游标）
//    - truncated: 增量超 200 条时截断标记（子代理据此分轮处理）
// ══════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderPrompt } from "../prompts/registry.js";

/** 单次返回最大增量条数（超限截断，防上下文爆炸）。 */
const MAX_INCREMENT = 200;
/** 背景消息条数（对齐 read_l0_increment / 腾讯 maxBgMessages=5）。 */
const BG_COUNT = 5;

interface FeedLine {
	sessionKey?: string;
	recordedAt?: string;
	id?: string | null;
	role?: string;
	content?: string;
	tool_name?: string;
	tool_call_id?: string;
	is_error?: boolean;
	timestamp?: number | null;
	cwd?: string;
}

/** 解析 skill-feed 行（宽容：坏行跳过）。 */
function parseFeedLine(line: string): FeedLine | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed) as FeedLine;
	} catch {
		return null;
	}
}

/**
 * 从 skill-feed 文件读游标后的增量行 + 游标前背景。
 *
 * @param feedFiles 逗号分隔的 skill-feed 文件绝对路径（skill/reviewer.ts 列出）
 * @param cursor    上次 lastRecordedAt（ISO；空串=从最早开始）
 * @returns { messages, background, nextCursor, truncated }
 */
export function readSkillFeedIncrement(
	feedFiles: string,
	cursor: string,
): { messages: FeedLine[]; background: FeedLine[]; nextCursor: string; truncated: boolean } {
	const files = feedFiles.split(",").map((s) => s.trim()).filter(Boolean);
	if (files.length === 0) return { messages: [], background: [], nextCursor: cursor, truncated: false };

	const prev: FeedLine[] = [];
	const all: FeedLine[] = [];
	for (const f of files) {
		if (!existsSync(f)) continue;
		try {
			const content = readFileSync(f, "utf-8");
			for (const line of content.split(/\r?\n/)) {
				const rec = parseFeedLine(line);
				if (!rec) continue;
				if (rec.recordedAt && cursor && rec.recordedAt <= cursor) {
					prev.push(rec);
				} else {
					all.push(rec);
				}
			}
		} catch {
			// 跳过坏文件
		}
	}
	// 按时间升序
	prev.sort((a, b) => (a.recordedAt ?? "").localeCompare(b.recordedAt ?? ""));
	all.sort((a, b) => (a.recordedAt ?? "").localeCompare(b.recordedAt ?? ""));

	// 背景：游标之前最近 BG_COUNT 条（无历史时为空）
	const background = prev.slice(-BG_COUNT);

	// 截断保护
	const truncated = all.length > MAX_INCREMENT;
	const slice = truncated ? all.slice(all.length - MAX_INCREMENT) : all;

	const nextCursor = slice.length > 0 ? (slice[slice.length - 1].recordedAt ?? cursor) : cursor;

	return { messages: slice, background, nextCursor, truncated };
}

/**
 * 注册 read_skill_feed_increment 工具（扩展加载时调用一次）。
 *
 * 子代理调用参数：
 *  - feedFiles: 逗号分隔的 skill-feed 文件绝对路径（task 消息 SkillFeedFiles 行原样传入）
 *  - cursor: 上次 lastRecordedAt（ISO；空串=从最早开始）
 */
export function registerReadSkillFeedIncrementTool(
	pi: ExtensionAPI,
): void {
	pi.registerTool({
		name: "read_skill_feed_increment",
		label: "Read Skill Feed Increment",
		description: renderPrompt("tools#read_skill_feed_increment"),
		parameters: {
			type: "object",
			properties: {
				feedFiles: {
					type: "string",
					description: "Comma-separated absolute paths of skill-feed files (from the SkillFeedFiles line of the task message).",
				},
				cursor: {
					type: "string",
					description: "Previous lastRecordedAt ISO string; empty string means start from the beginning.",
				},
			},
			required: ["feedFiles", "cursor"],
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const feedFiles = typeof params?.feedFiles === "string" ? params.feedFiles : "";
				const cursor = typeof params?.cursor === "string" ? params.cursor : "";
				if (!feedFiles) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "feedFiles is required" }) }], details: {} };
				}
				const result = readSkillFeedIncrement(feedFiles, cursor);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ success: true, ...result }),
						},
					],
					details: {},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }) }],
					details: {},
				};
			}
		},
	});
}
