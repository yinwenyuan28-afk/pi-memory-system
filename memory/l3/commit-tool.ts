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

				// ── 结构完整性硬保护（防止 LLM 全量重写丢失 USER.md 历史信息）──
				// 读现有 USER.md，若存在则检查新 content 是否保留关键结构标记。
				// 冷启动（USER.md 不存在）时跳过校验（允许首次创建）。
				const userMdPath = join(profilePath, USER_FILE);
				if (existsSync(userMdPath)) {
					const existing = readFileSync(userMdPath, "utf-8");
					// 必须保留的结构标记（按 mode 分流）：
					//   chat 模式：Archetype / Chapter 1 / Chapter 3（腾讯四层深度扫描模板）
					//   code 模式：Operating Doctrine / Core Principles（腾讯 Team Operating Doctrine）
					const mode = (() => {
						try {
							return JSON.parse(readFileSync(join(profilePath, MEMORY_DB_DIR, "l1-config.json"), "utf-8"))?.mode;
						} catch {
							return "chat";
						}
					})();
					const requiredMarkers = mode === "code"
						? ["Operating Doctrine", "Core Principles"]
						: ["Archetype", "Chapter 1", "Chapter 3"];
					const missing = requiredMarkers.filter((m) => !sanitized.includes(m));
					if (missing.length > 0) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									success: false,
									error: `USER.md 结构不完整：缺失 ${missing.join(", ")}。禁止全量重写，必须保留现有 USER.md 的有效信息和结构骨架（${mode === "code" ? "Operating Doctrine/Core Principles" : "Archetype/Chapter 1-4"}）。请基于现有内容编辑后重试。`,
								} satisfies L3CommitResult),
							}],
							details: {},
						};
					}
				}

			// 写 USER.md：冷启动整体创建；增量仅尾部追加（保留已有骨架不覆盖）
			// 对齐腾讯步骤 7：write 前先备份原文件到 memoryDB/.metadata/user-backup-*.md（防 LLM/工程误改）
			if (existsSync(userMdPath)) {
				const existing = readFileSync(userMdPath, "utf-8");
				// 腾讯步骤 7：备份原 USER.md（防被 LLM 误改/磁盘错误）
				try {
					const metaDir = join(profilePath, MEMORY_DB_DIR, ".metadata");
					if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true });
					const backupPath = join(metaDir, `user-backup-${Date.now()}.md`);
					writeFileSync(backupPath, existing, "utf-8");
				} catch {
					// non-fatal
				}
				// 拼接策略：保留原内容 + 分隔符 + 新内容（用户偏好 2026-08-20：仅在尾部追加，
				// 避免 LLM 误整篇覆盖损坏骨架；与腾讯 LLM 自助压缩重写不同——更安全可控）
				const merged = existing.trimEnd() + "\n\n---\n\n" + sanitized;
				atomicWrite(userMdPath, merged);
			} else {
				atomicWrite(userMdPath, sanitized);
			}

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
