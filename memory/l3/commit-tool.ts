import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryManager } from "../core/manager.ts";
import { USER_CHAR_LIMIT, loadL3Cursor, saveL3Cursor } from "./config.ts";
import { entryBudget, parseUserFile } from "./entries.ts";
import { readUserFile } from "./user-file.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

export interface L3CommitResult {
	success: boolean;
	cursor?: string;
	entryCount?: number;
	usage?: string;
	error?: string;
}

/**
 * 注册 `l3_commit` 工具（扩展加载时调用一次）。
 *
 * **2026-09-16 语义变更（用户拍板）**：旧的 `content` 参数（最终 USER.md 正文）已删除。
 * L3 现在只能通过 `l3_edit` 一次改一条记忆，`l3_commit` 退化为**收尾动作**：
 * 推进游标 + 重置记忆计数 + 刷新注入快照。
 *
 * 为什么游标不能挂在 `l3_edit` 上：L3 完全可能读完场景后判定"没东西要改"（提示词明确允许），
 * 那样就一次 `l3_edit` 都不会调 —— 游标不推进 ⇒ 下一轮又认为"有变化场景" ⇒ 反复触发。
 * 所以收尾必须是一次独立、必被调用的动作；主进程也以"游标是否推进"判定这一轮成功与否。
 */
export function registerL3CommitTool(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
	getManager: () => MemoryManager | undefined,
	onCommitted?: () => void,
): void {
	pi.registerTool({
		name: "l3_commit",
		label: "L3 Finish Persona Update",
		description: renderPrompt("tools#l3_commit"),
		parameters: {
			type: "object",
			properties: {
				cursor: {
					type: "string",
					description: "本批处理的场景中**最新**的 updated ISO 时间戳（从场景文件 META 头读取）",
					required: true,
				},
			},
			required: ["cursor"],
		},
		async execute(_toolCallId, params) {
			const reply = (r: L3CommitResult) => ({
				content: [{ type: "text", text: JSON.stringify(r) }],
				details: {},
			});
			try {
				const profilePath = getProfilePath();
				if (!profilePath) return reply({ success: false, error: "No active profile" });

				const cursor = typeof params?.cursor === "string" ? params.cursor.trim() : "";
				if (!cursor) return reply({ success: false, error: "cursor is required" });
				if (Number.isNaN(new Date(cursor).getTime())) {
					return reply({ success: false, error: `cursor 不是合法 ISO 时间戳: ${JSON.stringify(cursor)}` });
				}

				const entries = parseUserFile(readUserFile(profilePath)).entries;
				const now = new Date().toISOString();
				const prev = loadL3Cursor(profilePath);
				saveL3Cursor(profilePath, {
					lastPersonaUpdate: cursor,
					memoriesSinceLastPersona: 0,
					lastTriggeredAt: prev.lastTriggeredAt,
					lastCommittedAt: now,
				});

				getManager()?.refreshUserSnapshot();
				try {
					onCommitted?.();
				} catch {
					// non-fatal
				}

				return reply({
					success: true,
					cursor,
					entryCount: entries.length,
					usage: `${entryBudget(entries).toLocaleString()}/${USER_CHAR_LIMIT.toLocaleString()} chars`,
				});
			} catch (err) {
				return reply({ success: false, error: err instanceof Error ? err.message : String(err) });
			}
		},
	});
}
