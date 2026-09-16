/**
 * USER.md 条目级操作内核（L3 · 2026-09-16 用户拍板改造）
 *
 * 用户裁定：**L3 可以管理整份 USER.md，但每一次工具调用只能操作一条记忆**，
 * 禁止 write/bash 之类的整篇重写。于是"提交完整正文"这套契约整体作废，改成：
 *
 *   l3_edit  {action: add|update|delete, content?, target?}   ← 每次调用只影响 1 条
 *   l3_commit{cursor}                                        ← 收尾：备份 + 推进游标
 *
 * 由此派生出的三条设计：
 *
 * 1. **定位由代码裁决，不让 LLM 逐字抄写**。`update` / `delete` 传的是"特征片段"（target），
 *    代码在现有条目里做子串匹配：**恰好命中 1 条才动手**，0 条/多条一律拒绝并回传候选清单。
 *    这是 L1 场景池踩过的坑（"逐字抄写"是一种失败模式，改用 `scene_id` 回传），此处同款处理。
 *
 * 2. **"整篇重写"在接口层不可能**。单条正文必须单行、不含 `§`、不含 HTML 注释 ——
 *    想塞整篇文档进来必然被拒。限额也因此在每次 op 后按"整篇"复核（见 entryBudget）。
 *
 * 3. **行尾只做解析宽容、不改造文件**。磁盘上 USER.md 是 CRLF（`core.autocrlf=true`），
 *    而历史解析用的是 `split("\n§\n")` —— CRLF 切不开，18 条被并成 1 条（实测）。
 *    这里解析按 `/\r?\n§\r?\n/` 容错，写回时沿用文件**既有**行尾，不把整份文件转成 LF
 *    （避免 `git diff` 整文件重写，也避免行尾核查假阳性）。
 */

import { escapeXmlTags } from "./sanitize.ts";

/** 磁盘上一份 USER.md 的解构结果。 */
export interface ParsedUserFile {
	/** 条目正文（已 trim、去空、未转义）。 */
	entries: string[];
	/** 文件既有行尾（首个 CRLF 命中即判为 CRLF，否则 LF）。 */
	eol: string;
	/** 原文件是否以换行结尾（写回时尽量保持一致）。 */
	trailingNewline: boolean;
}

/** 单条 op 的执行结果（工具返回体的公共部分）。 */
export interface EntryOpResult {
	success: boolean;
	error?: string;
	/** 命中的条目下标（update / delete）。 */
	position?: number;
	/** 改动后的用量展示，如 `"61% — 1,352/2,200 chars"`。 */
	usage?: string;
	/** 改动后的条目数。 */
	entryCount?: number;
	/** 0 条或多条候选时回传，供模型改传更长的 target。 */
	candidates?: Array<{ index: number; text: string }>;
}

// ── 解析 / 序列化 ───────────────────────────────────────────────

/** 条目分隔符（LF 口径，与 core/types 的 ENTRY_DELIMITER 同义；此处按行匹配以兼容 CRLF）。 */
const DELIMITER_RE = /\r?\n§\r?\n/;

/** 解构磁盘上的 USER.md。文件不存在或空 → entries 为空、eol 默认 LF。 */
export function parseUserFile(raw: string | null | undefined): ParsedUserFile {
	if (raw == null || raw.trim() === "") {
		return { entries: [], eol: "\n", trailingNewline: false };
	}
	const eol = raw.includes("\r\n") ? "\r\n" : "\n";
	return {
		entries: raw
			.split(DELIMITER_RE)
			.map((p) => p.trim())
			.filter(Boolean),
		eol,
		trailingNewline: /\r?\n$/.test(raw),
	};
}

/** 把条目序列化回文件文本（沿用既有行尾；保持原文件是否以换行结尾）。 */
export function serializeUserFile(entries: string[], eol: string, trailingNewline: boolean): string {
	const body = entries.join(eol + "§" + eol);
	if (!body) return "";
	return trailingNewline ? body + eol : body;
}

// ── 计价（与 store.totalChars 同口径）────────────────────────────

/**
 * 整篇用量：LF 归一化后的字符数 = 条目正文 + `\n§\n` 分隔符长度。
 *
 * 与 `core/store.ts` 的 `totalChars()` 同一算法（注入头部的 `N/2200 chars` 就是这个数），
 * 所以"限额校验"与"注入显示"永远对得上；磁盘上的 CRLF 只影响字节数，不影响预算。
 */
export function entryBudget(entries: string[]): number {
	if (entries.length === 0) return 0;
	const DELIM_LEN = 3; // "\n§\n"
	return entries.reduce((sum, e) => sum + e.length, 0) + DELIM_LEN * (entries.length - 1);
}

/** 用量展示串（与 store.successResponse 同款文案）。 */
export function usageText(total: number, limit: number): string {
	const pct = limit > 0 ? Math.min(100, Math.round((total / limit) * 100)) : 0;
	return `${pct}% — ${total.toLocaleString()}/${limit.toLocaleString()} chars`;
}

// ── 单条校验 ───────────────────────────────────────────────────

/** 单条规则正文的长度上限（远小于总预算，防止一条吃掉整篇、退化回"整篇重写"）。 */
export const SINGLE_ENTRY_CHAR_LIMIT = 500;

/**
 * 校验并规范化一条待写入的规则。返回转义后的存储文本。
 *
 * 拒绝的形态对应历史上真实发生过的失格：8-21 那次 L3 交上来的是
 * `# Team Operating Doctrine` + Markdown 列表的整篇文档，才有这条硬约束。
 */
export function normalizeEntryText(raw: string): { ok: true; text: string } | { ok: false; error: string } {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (!text) return { ok: false, error: "content 为空。" };
	if (/[\r\n]/.test(text)) {
		return {
			ok: false,
			error: "content 必须是**单行**：一次调用只写一条规则，行内不允许换行（多条规则请分多次 l3_edit）。",
		};
	}
	if (text.includes("§")) {
		return { ok: false, error: "content 不能包含 `§`（它是条目分隔符，会导致解析错位）。" };
	}
	if (text.includes("<!--") || text.includes("-->")) {
		return { ok: false, error: "content 不能包含 HTML 注释（会与文件结构标记混淆）。" };
	}
	const stored = escapeXmlTags(text);
	if (stored.length > SINGLE_ENTRY_CHAR_LIMIT) {
		return {
			ok: false,
			error: `单条规则超长：${stored.length} > ${SINGLE_ENTRY_CHAR_LIMIT} 字符。请拆成多条分别 l3_edit。`,
		};
	}
	return { ok: true, text: stored };
}

// ── 定位（update / delete 用）───────────────────────────────────

/**
 * 用特征片段定位条目。**恰好命中 1 条才算命中**。
 *
 * 返回 `{ ok: true, index }` 或 `{ ok: false, error, candidates }`：
 * 后者把当前清单（或本次命中集合）回传，模型据此改传更长的片段重试 —— 而不是靠猜。
 */
export function locateEntry(
	entries: string[],
	target: string,
): { ok: true; index: number } | { ok: false; error: string; candidates: Array<{ index: number; text: string }> } {
	const needle = typeof target === "string" ? target.trim() : "";
	const all = entries.map((text, index) => ({ index, text }));
	if (!needle) {
		return {
			ok: false,
			error: "target 为空：update / delete 必须给一段能唯一定位现有条目的文字（取该条里一段有区分度的片段即可，不需要全文照抄）。",
			candidates: all,
		};
	}
	const hits = all.filter((e) => e.text.includes(needle));
	if (hits.length === 1) return { ok: true, index: hits[0].index };
	if (hits.length === 0) {
		return {
			ok: false,
			error: `没有条目包含 ${JSON.stringify(needle)}。未做任何改动，当前条目清单见 candidates。`,
			candidates: all,
		};
	}
	return {
		ok: false,
		error: `${hits.length} 条条目都包含 ${JSON.stringify(needle)}，无法确定改哪一条。请传更长的片段。未做任何改动。`,
		candidates: hits,
	};
}
