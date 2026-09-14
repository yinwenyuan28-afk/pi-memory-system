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
//    - messages: 游标后新消息（按时间升序，全部增量；子代理按 maxNewMessages
//      规则自行截取最近 ≤10 条）
//    - background: 增量最前面一条的前 5 条背景消息（仅供理解，禁止提取）
//    - nextCursor: 增量最后一条的 recordedAt（子代理提交时作为 cursor）
//    - truncated: 增量超 200 条时截断标记（防上下文爆炸，子代理据此分轮处理）
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
 * 禁止从中提取）；messages = 游标后全部增量（按时间升序）。
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

	// 截断保护
	const truncated = all.length > MAX_INCREMENT;
	const slice = truncated ? all.slice(all.length - MAX_INCREMENT) : all;

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
