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
import { render as renderPrompt } from "../../prompts/registry.js";

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
		description: renderPrompt("tools#l3_commit"),
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
					// 新格式校验：§ 分隔的单行规则，必须包含至少一个 § 分隔符
					if (!sanitized.includes("§")) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									success: false,
									error: `USER.md 内容格式错误：必须使用 § 分隔的单行规则格式。请使用 l3_commit 提交 § 分隔的规则条目。`,
								} satisfies L3CommitResult),
							}],
							details: {},
						};
					}
				}

			// 写 USER.md：冷启动整体创建；增量 upsert（替换已有 L3 段落，不盲目追加）
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
				// upsert 策略：检测已有 L3 段落标记，有则替换该段落到文件末尾，无则追加。
				// 标记优先级：<!-- L3 -->（新格式） > # Team Operating Doctrine / # User Narrative Profile（旧格式）
				const l3Sentinel = "<!-- L3 -->";
				const l3LegacyPattern = /^# (Team Operating Doctrine|User Narrative Profile)/m;
				let matchIdx = existing.indexOf(l3Sentinel);
				let legacyMatch = false;
				if (matchIdx === -1) {
					const m = existing.match(l3LegacyPattern);
					if (m && m.index !== undefined) {
						matchIdx = m.index;
						legacyMatch = true;
					}
				}
				let merged: string;
				if (matchIdx !== undefined && matchIdx >= 0) {
					// 找到已有 L3 段落：保留前面的用户内容，替换 L3 段落
					const beforeL3 = existing.slice(0, legacyMatch ? matchIdx : matchIdx + l3Sentinel.length).trimEnd();
					merged = beforeL3 + "\n\n§\n\n" + l3Sentinel + " " + sanitized;
				} else {
					// 首次触发：追加到末尾
					merged = existing.trimEnd() + "\n\n§\n\n" + l3Sentinel + " " + sanitized;
				}
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
