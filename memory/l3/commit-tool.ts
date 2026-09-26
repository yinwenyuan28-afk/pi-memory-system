import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryManager } from "../core/manager.ts";
import { USER_CHAR_LIMIT, loadL3Cursor, saveL3Cursor } from "./config.ts";
import { entryBudget, parseUserFile } from "./entries.ts";
import { readUserFile } from "./user-file.ts";
import { getPipelineJobsDB } from "../pipeline/jobs-db.ts";
import { isStopRequested, stopRequestedMessage } from "../pipeline/stop-request.ts";
import { acquireRunLock, runLockBusyMessage } from "../pipeline/run-lock.ts";
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
				// 停止请求（2026-09-26）：硬上限停掉 L3 子代理时，入口拒写（把被杀点推到操作边界）
				if (isStopRequested(profilePath, "l3")) return reply({ success: false, error: stopRequestedMessage("l3") });
				// 运行级锁（2026-09-26）：谁写谁持锁 —— 两个 L3 同时改 USER.md 会互相覆盖
				const runLock = acquireRunLock(profilePath, "l3");
				if (!runLock.acquired) return reply({ success: false, error: runLockBusyMessage("l3", runLock.owner) });

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
				// 队列的**真完成信号**（2026-09-19 并入串行执行器）：只有子代理自己提交了才算这一轮跑成。
				// 子代理进程里做不了别的事 —— `runPiSubagent` 是 async:true，派发方等不到这个时刻。
				try {
					getPipelineJobsDB(profilePath).completeRunningL3();
				} catch {
					// 队列不可用不影响提交本身
				}
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
