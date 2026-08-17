import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryManager } from "../core/manager.js";
import { DEFAULT_USER_CHAR_LIMIT } from "../core/types.js";
import {
	L3_CURSOR_FILE,
	USER_FILE,
	loadL3Cursor,
	type L3Cursor,
} from "./config.js";
import { MEMORY_DB_DIR } from "../paths.js";
import { escapeXmlTags } from "./sanitize.js";

export interface L3CommitResult {
	success: boolean;
	length?: number;
	cursor?: string;
	error?: string;
}

function atomicWrite(filePath: string, content: string): void {
	const dir = join(filePath, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmpPath = join(dir, `.tmp_l3_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
	writeFileSync(tmpPath, content, "utf-8");
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

function saveL3Cursor(profilePath: string, cursor: L3Cursor): void {
	atomicWrite(join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE), JSON.stringify(cursor, null, 2));
}

/**
 * 注册 l3_commit 工具（扩展加载时调用一次）。
 *
 * 子代理参数：
 *  - content: 最终 USER.md 正文（纯 persona，无导航）
 *  - cursor: 本次处理的最后场景 updated ISO 时间戳
 */
export function registerL3CommitTool(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
	getManager: () => MemoryManager | undefined,
	onCommitted?: () => void,
): void {
	pi.registerTool({
		name: "l3_commit",
		label: "L3 Commit Persona",
		description:
			"Commit generated persona to USER.md and advance L3 cursor. " +
			"Called by l3-persona-generator after generation. " +
			"Params: content (final USER.md body), cursor (last scene updated ISO string).",
		parameters: {
			type: "object",
			properties: {
				content: { type: "string", description: "Final USER.md persona content (no scene navigation)" },
				cursor: { type: "string", description: "Last processed scene updated ISO timestamp" },
			},
			required: ["content", "cursor"],
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const profilePath = getProfilePath();
				if (!profilePath) {
					return {
						content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active profile" } satisfies L3CommitResult) }],
						details: {},
					};
				}
				const raw = typeof params?.content === "string" ? params.content.trim() : "";
				const cursor = typeof params?.cursor === "string" ? params.cursor.trim() : "";
				if (!raw || !cursor) {
					return {
						content: [{ type: "text", text: JSON.stringify({ success: false, error: "content and cursor are required" } satisfies L3CommitResult) }],
						details: {},
					};
				}

				const sanitized = escapeXmlTags(raw);
				if (sanitized.length > DEFAULT_USER_CHAR_LIMIT) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: false,
								error: `content exceeds ${DEFAULT_USER_CHAR_LIMIT} chars (${sanitized.length}). Compress and retry.`,
							} satisfies L3CommitResult),
						}],
						details: {},
					};
				}

				// 写 USER.md（单条目文档，无 ENTRY_DELIMITER）
				atomicWrite(join(profilePath, USER_FILE), sanitized);

				// 更新 L3 游标
				const now = new Date().toISOString();
				saveL3Cursor(profilePath, {
					lastPersonaUpdate: cursor || now,
					memoriesSinceLastPersona: 0,
					lastTriggeredAt: now,
				});

				// 刷新 session 内 USER.md 快照
				getManager()?.refreshUserSnapshot();

				try {
					onCommitted?.();
				} catch {
					// non-fatal
				}

				return {
					content: [{ type: "text", text: JSON.stringify({ success: true, length: sanitized.length, cursor } satisfies L3CommitResult) }],
					details: {},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) } satisfies L3CommitResult) }],
					details: {},
				};
			}
		},
	});
}
