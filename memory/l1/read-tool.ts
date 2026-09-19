import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderPrompt } from "../../prompts/registry.ts";

// ══════════════════════════════════════════════════════════════
//  read_l0_increment 工具 —— 子代理一次读取游标后增量（性能修复）
//
//  背景（2026-08-17 实测）：l1-extractor 之前用 read 工具逐段读 L0 分片
//  （每段 ≤240 行），L0 分片 2860+ 行时需 38 次串行 read，每次 read 都要
//  一次 LLM 往返（~8s）→ 单轮提取 12 分钟。根因：read 是通用文件读取，
//  子代理需要自己算 offset 逐段啃，且每次都要等 LLM 生成下一次调用。
//
//  解法：扩展工具一次调用返回游标后的全部增量（含 cwd），子代理不再逐段
//  read。保持"子代理自主读取"（对齐腾讯架构）而非主进程预读塞任务消息。
//
//  返回值约定：
//    - messages: 游标后新消息（按时间升序），**最多 MAX_INCREMENT 条，取最旧的**
//    - background: 游标之前最近 BG_COUNT 条背景消息（仅供理解，禁止提取）
//    - nextCursor: 返回的 messages 最后一条的 recordedAt —— **仅作参考**：子代理要提交的
//      cursor 是「本批实际处理的那几条里的最后一条」，不是它
//    - truncated: messages 被 MAX_INCREMENT 截断的标记（后面还有更晚的没返回）
//
//  ⚠ 2026-09-19 改正截断方向：原先取**最新**的 200 条，配合子代理「只提最新的 ≤10 条」，
//  会让比该批更旧的所有消息落到游标之后（下一轮 `recordedAt <= cursor` 归入 background、
//  永不提取）—— 实测积压 4 天时一次就静默跳过 190 条。现在取**最旧**的 200 条，配合
//  子代理「提最旧的 ≤25 条、游标推进到本批最后一条」，积压才是真正被串行消化掉的。
// ══════════════════════════════════════════════════════════════

/** 单次返回最大增量条数（超限截断，防上下文爆炸）。 */
const MAX_INCREMENT = 200;
/** 背景消息条数（对齐腾讯 maxBgMessages=5）。 */
const BG_COUNT = 5;

interface L0Line {
	sessionKey?: string;
	recordedAt?: string;
	id?: string | null;
	role?: string;
	content?: string;
	timestamp?: string;
	cwd?: string;
}

/** 解析 L0 分片行（宽容：坏行跳过）。 */
function parseL0Line(line: string): L0Line | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed) as L0Line;
	} catch {
		return null;
	}
}

/**
 * 从分片文件读游标后的增量行 + 游标前背景。
 *
 * @param l0Files 逗号分隔的 L0 分片绝对路径（listL0Files 输出，按游标日期过滤过）
 * @param cursor  上次 lastRecordedAt（ISO；空串=从最早开始）
 * @returns { messages, background, nextCursor, truncated }
 *
 * background = 游标之前最近 BG_COUNT 条（真正的历史上下文，供子代理理解语境，
 * 禁止从中提取）；messages = 游标后的增量（按时间升序），**超 MAX_INCREMENT 时取最旧的**。
 */
export function readL0Increment(
	l0Files: string,
	cursor: string,
): { messages: L0Line[]; background: L0Line[]; nextCursor: string; truncated: boolean } {
	const files = l0Files.split(",").map((s) => s.trim()).filter(Boolean);
	if (files.length === 0) return { messages: [], background: [], nextCursor: cursor, truncated: false };

	const prev: L0Line[] = [];
	const all: L0Line[] = [];
	for (const f of files) {
		if (!existsSync(f)) continue;
		try {
			const content = readFileSync(f, "utf-8");
			for (const line of content.split(/\r?\n/)) {
				const rec = parseL0Line(line);
				if (!rec) continue;
				if (rec.role !== "user" && rec.role !== "assistant") continue; // toolResult 等丢弃（对齐 l1-extractor 第三步）
				if (rec.recordedAt && cursor && rec.recordedAt <= cursor) {
					prev.push(rec);
				} else {
					all.push(rec);
				}
			}
		} catch {
			// 跳过坏分片
		}
	}
	// 按时间升序
	prev.sort((a, b) => (a.recordedAt ?? "").localeCompare(b.recordedAt ?? ""));
	all.sort((a, b) => (a.recordedAt ?? "").localeCompare(b.recordedAt ?? ""));

	// 背景：游标之前最近 BG_COUNT 条（无历史时为空）
	const background = prev.slice(-BG_COUNT);

	// 截断保护：**取最旧的**（与子代理"提最旧的一批、游标往前推"配套；取最新的会静默丢积压）
	const truncated = all.length > MAX_INCREMENT;
	const slice = truncated ? all.slice(0, MAX_INCREMENT) : all;

	const nextCursor = slice.length > 0 ? (slice[slice.length - 1].recordedAt ?? cursor) : cursor;

	return { messages: slice, background, nextCursor, truncated };
}

/**
 * 注册 read_l0_increment 工具（扩展加载时调用一次）。
 *
 * 子代理调用参数：
 *  - l0Files: 逗号分隔的 L0 分片绝对路径（buildL1Task 的 L0Files 行原样传入）
 *  - cursor: 上次 lastRecordedAt（ISO；空串=从最早开始）
 */
export function registerReadL0IncrementTool(
	pi: ExtensionAPI,
): void {
	pi.registerTool({
		name: "read_l0_increment",
		label: "Read L0 Increment",
		description: renderPrompt("tools#read_l0_increment"),
		parameters: {
			type: "object",
			properties: {
				l0Files: {
					type: "string",
					description: "Comma-separated absolute paths of L0 shard files (from the L0Files line of the task message).",
				},
				cursor: {
					type: "string",
					description: "Previous lastRecordedAt ISO string; empty string means start from the beginning.",
				},
			},
			required: ["l0Files", "cursor"],
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const l0Files = typeof params?.l0Files === "string" ? params.l0Files : "";
				const cursor = typeof params?.cursor === "string" ? params.cursor : "";
				if (!l0Files) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "l0Files is required" }) }], details: {} };
				}
				const result = readL0Increment(l0Files, cursor);
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
