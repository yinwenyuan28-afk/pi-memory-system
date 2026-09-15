// ══════════════════════════════════════════════════════════════
//  skill/feed-cleaner.ts — skill 原料清洗管线
//
//  定位（对照 L0 与腾讯 skill 管道）：
//    - L0 是 2-role（user/assistant）净化分片，喂记忆提取；
//    - skill-feed 是 5-role（user/assistant/tool_call/tool_result）高保真原料，
//      喂 skill-reviewer，保留工具调用链（对齐腾讯 normalize-conversation 语义）。
//
//  管线（4 步，2026-08-19 设计评审确认）：
//    ① 行级类型过滤：只留 type="message"；丢 custom_message / compaction /
//       session / model_change / thinking_level_change / session_info
//    ② 角色归一化：user → user；assistant 的 text 块 → assistant，
//       toolCall 块 → tool_call（arguments 序列化），thinking 块 → 丢弃
//       （KEEP_THINKING 开关）；toolResult → tool_result（is_error 保留）
//    ③ 内容清洗：复用 l0/sanitize 规则集（base64→[image]、记忆标签剥离、
//       日志压缩、时间戳/NUL/换行）+ tool_result 4000 字头尾截断
//    ④ 过滤层：复用 shouldCaptureL0（空 / 纯[image] / 斜杠命令）
//
//  落盘：{profile}/memoryDB/skill/feed/<sessionKey>.jsonl（按 session 一文件，
//  append-only）。游标独立于 L0（skill/cursor.json，行号推进）。
// ══════════════════════════════════════════════════════════════

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { MEMORY_DB_DIR, SKILL_FEED_CURSOR_FILE, SKILL_FEED_DIR } from "../memory/paths.ts";
import { decodeCwdFromSessionPath } from "../memory/l0/index.ts";
import {
	buildRuleSet,
	replaceBase64WithImage,
	sanitizeText,
	shouldCaptureL0,
	type SanitizeRule,
} from "../memory/l0/sanitize.ts";
import type { SkillFeedArchiveResult, SkillFeedEntry, SkillFeedRole } from "./feed-types.ts";

// ── 可调参数（设计评审确认值） ──────────────────────────────────

/** thinking 块是否保留（默认丢弃，对齐腾讯；留开关供后续按需开启）。 */
export const KEEP_THINKING = false;
/** tool_result 单条内容上限（字符）。 */
export const TOOL_RESULT_MAX_CHARS = 4000;
/** 截断后保留头部字符数。 */
export const TOOL_RESULT_HEAD_CHARS = 2000;
/** 截断后保留尾部字符数。 */
export const TOOL_RESULT_TAIL_CHARS = 2000;

// ── 游标读写（独立文件，与 L0 游标互不干扰） ─────────────────────

interface SkillFeedCursorEntry {
	sessionPath: string;
	line: number;
}

function loadCursor(profilePath: string, sessionPath: string): number {
	const filePath = join(profilePath, MEMORY_DB_DIR, SKILL_FEED_CURSOR_FILE);
	if (!existsSync(filePath)) return 0;
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, SkillFeedCursorEntry>;
		const entry = data[sessionPath];
		if (!entry || entry.sessionPath !== sessionPath || typeof entry.line !== "number") return 0;
		return entry.line;
	} catch {
		return 0;
	}
}

function saveCursor(profilePath: string, sessionPath: string, line: number): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, SKILL_FEED_CURSOR_FILE);
	let data: Record<string, SkillFeedCursorEntry> = {};
	if (existsSync(filePath)) {
		try {
			data = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, SkillFeedCursorEntry>;
		} catch {
			data = {};
		}
	}
	data[sessionPath] = { sessionPath, line };
	const tmpPath = join(profilePath, MEMORY_DB_DIR, `.tmp_skill_feed_cursor_${Date.now()}`);
	writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
	try {
		rmSync(filePath, { force: true });
	} catch {
		// ignore
	}
	try {
		renameSync(tmpPath, filePath);
	} catch {
		writeFileSync(filePath, readFileSync(tmpPath, "utf-8"), "utf-8");
	}
	try {
		rmSync(tmpPath, { force: true });
	} catch {
		// ignore
	}
}

// ── 行级解析（5-role 展开，与 session-parser 的 2-role 语义不同） ──

interface ParsedFeedMessage {
	line: number;
	role: "user" | "assistant" | "toolResult";
	id?: string;
	timestamp?: number;
	/** text 块拼接（user/assistant/toolResult 通用）。 */
	text: string;
	/** assistant 的 toolCall 块。 */
	toolCalls: Array<{ id: string; name: string; argsJson: string }>;
	/** toolResult 顶层字段。 */
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

function parseTimestamp(entry: Record<string, unknown>, msg: Record<string, unknown>): number | undefined {
	if (typeof entry.timestamp === "number") return entry.timestamp;
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (!Number.isNaN(parsed)) return parsed;
	}
	if (typeof msg.timestamp === "number") return msg.timestamp;
	return undefined;
}

function textFromBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const p of content) {
		if (!p || typeof p !== "object") continue;
		const b = p as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

/**
 * 解析指定行段，展开成 5-role 基础形态（清洗前）。
 * 只处理 type="message"；custom_message / compaction 等整行丢弃。
 */
function parseFeedLines(lines: string[], startLine = 1): ParsedFeedMessage[] {
	const result: ParsedFeedMessage[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // 坏行跳过
		}
		if (entry?.type !== "message") continue; // compaction/custom_message/model_change 等丢弃
		const msg = (entry.message ?? {}) as Record<string, unknown>;
		if (!msg || typeof msg !== "object") continue;

		const role = typeof msg.role === "string" ? msg.role : "";
		const lineNo = startLine + i;
		const timestamp = parseTimestamp(entry, msg);

		if (role === "user") {
			const text = textFromBlocks(msg.content).trim();
			if (text) {
				result.push({
					line: lineNo,
					role: "user",
					id: typeof msg.id === "string" ? msg.id : undefined,
					timestamp,
					text,
					toolCalls: [],
				});
			}
			continue;
		}

		if (role === "assistant") {
			const parsed: ParsedFeedMessage = {
				line: lineNo,
				role: "assistant",
				id: typeof msg.id === "string" ? msg.id : undefined,
				timestamp,
				text: "",
				toolCalls: [],
			};
			const content = msg.content;
			if (typeof content === "string") {
				parsed.text = content.trim();
			} else if (Array.isArray(content)) {
				const textParts: string[] = [];
				for (const p of content) {
					if (!p || typeof p !== "object") continue;
					const b = p as Record<string, unknown>;
					if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
						textParts.push(b.text.trim());
					} else if (b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") {
						let argsJson = "";
						try {
							argsJson = JSON.stringify(b.arguments ?? {});
						} catch {
							argsJson = String(b.arguments ?? "");
						}
						parsed.toolCalls.push({ id: b.id, name: b.name, argsJson });
					}
					// thinking / 其它 block：KEEP_THINKING=false 时全部丢弃
				}
				parsed.text = textParts.join("\n");
			}
			// 空 assistant（无 text 无 toolCall）也保留？——丢弃（无信息量）
			if (!parsed.text && parsed.toolCalls.length === 0) continue;
			result.push(parsed);
			continue;
		}

		if (role === "toolResult") {
			const text = textFromBlocks(msg.content).trim();
			if (text) {
				result.push({
					line: lineNo,
					role: "toolResult",
					id: typeof msg.id === "string" ? msg.id : undefined,
					timestamp,
					text,
					toolCalls: [],
					toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
					toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
					isError: msg.isError === true ? true : undefined,
				});
			}
			continue;
		}

		// 其它 role（custom 等）丢弃
	}
	return result;
}

// ── 内容清洗 ────────────────────────────────────────────────────

/** tool_result 截断：超上限时保留头尾，中间加 [truncated N chars] 标记。 */
export function truncateToolResult(text: string): string {
	if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
	const head = text.slice(0, TOOL_RESULT_HEAD_CHARS);
	const tail = text.slice(-TOOL_RESULT_TAIL_CHARS);
	const cut = text.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;
	return `${head}\n\n[truncated ${cut} chars]\n\n${tail}`;
}

/**
 * 对单条已展开消息应用清洗：
 *  - base64 → [image]
 *  - sanitize 规则集（applyTo 匹配：user 用 user 规则；assistant/tool_call/tool_result 用 assistant 规则）
 *  - tool_result 额外截断
 */
function sanitizeEntry(entry: SkillFeedEntry, rules: SanitizeRule[]): SkillFeedEntry {
	let content = replaceBase64WithImage(entry.content);
	// tool_call / tool_result 视作 assistant 侧产出（只命中 both / assistant 规则，避开 user 特有规则）
	const ruleRole = entry.role === "user" ? "user" : "assistant";
	content = sanitizeText(content, ruleRole, rules);
	if (entry.role === "tool_result") {
		content = truncateToolResult(content);
	}
	return { ...entry, content };
}

// ── 主流程 ──────────────────────────────────────────────────────

/**
 * 增量清洗一个 session 的新增消息到 skill-feed。
 *
 * 幂等性：游标记录上次处理到的行号（与 L0 同机制）；写入成功才推进游标。
 *
 * @param sessionPath session JSONL 绝对路径
 * @param profilePath 活动 profile 目录（skill-feed 数据与游标都存这里）
 * @param cwd         工作目录（可选；优先 ctx.cwd，缺省从 session 路径启发式解码）
 * @returns SkillFeedArchiveResult
 */
export function archiveSkillFeedIncrement(
	sessionPath: string,
	profilePath: string,
	cwd?: string,
): SkillFeedArchiveResult {
	if (!existsSync(sessionPath)) {
		return { recorded: 0, filtered: 0, error: `session file not found: ${sessionPath}` };
	}

	const cursor = loadCursor(profilePath, sessionPath);
	const raw = readFileSync(sessionPath, "utf-8");
	const lines = raw.split(/\r?\n/);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const totalLines = lines.length;

	if (totalLines <= cursor) {
		return { recorded: 0, filtered: 0 }; // 无新增
	}

	const parsed = parseFeedLines(lines.slice(cursor), cursor + 1);
	const rules = buildRuleSet(profilePath);
	const effectiveCwd = cwd || decodeCwdFromSessionPath(sessionPath);
	const sessionKey = basename(sessionPath).replace(/\.jsonl$/, "");

	let recorded = 0;
	let filtered = 0;
	const records: string[] = [];
	const nowIso = new Date().toISOString();

	for (const msg of parsed) {
		// 展开成 entry（一个 assistant 可产生多条：text + tool_calls）
		const entries: SkillFeedEntry[] = [];
		const base = {
			sessionKey,
			recordedAt: nowIso,
			id: msg.id ?? null,
			timestamp: msg.timestamp ?? null,
			cwd: effectiveCwd,
		};

		if (msg.role === "user") {
			entries.push({ ...base, role: "user" as const, content: msg.text });
		} else if (msg.role === "assistant") {
			if (msg.text) entries.push({ ...base, role: "assistant" as const, content: msg.text });
			for (const tc of msg.toolCalls) {
				entries.push({
					...base,
					role: "tool_call" as const,
					content: tc.argsJson,
					tool_name: tc.name,
					tool_call_id: tc.id,
				});
			}
		} else {
			// toolResult
			entries.push({
				...base,
				role: "tool_result" as const,
				content: msg.text,
				tool_name: msg.toolName,
				tool_call_id: msg.toolCallId,
				is_error: msg.isError,
			});
		}

		for (const entry of entries) {
			const cleaned = sanitizeEntry(entry, rules);
			// 传角色避免斜杠过滤误伤工具输出（/usr/bin/bash、/C:/dev 等，见 sanitize.ts 注释）
			if (!shouldCaptureL0(cleaned.content, cleaned.role)) {
				filtered++;
				continue;
			}
			records.push(JSON.stringify(cleaned));
			recorded++;
		}
	}

	if (records.length > 0) {
		const feedDir = join(profilePath, MEMORY_DB_DIR, SKILL_FEED_DIR);
		if (!existsSync(feedDir)) mkdirSync(feedDir, { recursive: true });
		appendFileSync(join(feedDir, `${sessionKey}.jsonl`), records.join("\n") + "\n", "utf-8");
	}

	// 写成功（或无记录）→ 推进游标到文件末尾
	saveCursor(profilePath, sessionPath, totalLines);

	return { recorded, filtered };
}
