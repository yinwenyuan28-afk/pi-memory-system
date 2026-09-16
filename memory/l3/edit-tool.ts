import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderPrompt } from "../../prompts/registry.ts";
import { USER_CHAR_LIMIT } from "./config.ts";
import {
	entryBudget,
	locateEntry,
	normalizeEntryText,
	parseUserFile,
	serializeUserFile,
	usageText,
	type EntryOpResult,
} from "./entries.ts";
import { ensureRunBackup, readUserFile, writeUserFile } from "./user-file.ts";

/**
 * 注册 `l3_edit` 工具（扩展加载时调用一次）。
 *
 * 用户 2026-09-16 裁定：L3 可以管理整份 USER.md，但**每一次工具调用只能操作一条记忆**。
 * 本工具就是那条约束的落点 —— `content` 必须单行、不含 `§`，所以"整篇重写"在接口层
 * 就不可能发生；`update` / `delete` 的定位由代码裁决，模型只给特征片段。
 *
 * @param onChanged 写盘成功后的回调（主进程用于刷新 USER.md 注入快照）
 */
export function registerL3EditTool(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
	onChanged?: () => void,
): void {
	pi.registerTool({
		name: "l3_edit",
		label: "L3 Edit One Persona Entry",
		description: renderPrompt("tools#l3_edit"),
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["add", "update", "delete"],
					description: "add: 追加一条新规则；update: 改写一条已存在的；delete: 删除一条已存在的。",
					required: true,
				},
				content: {
					type: "string",
					description:
						"action=add/update 必填：**一条**规则正文，必须单行、不含 `§`。一次调用只写一条。",
				},
				target: {
					type: "string",
					description:
						"action=update/delete 必填：一段能唯一定位现有条目的文字（取该条里有区分度的一小段即可，不需要全文照抄）。命中不唯一会被拒绝并回传候选清单。",
				},
			},
			required: ["action"],
		},
		async execute(_toolCallId, params) {
			const reply = (r: EntryOpResult) => ({
				content: [{ type: "text", text: JSON.stringify(r) }],
				details: {},
			});

			try {
				const profilePath = getProfilePath();
				if (!profilePath) return reply({ success: false, error: "No active profile" });

				const action = typeof params?.action === "string" ? params.action : "";
				if (action !== "add" && action !== "update" && action !== "delete") {
					return reply({ success: false, error: `action 必须是 add / update / delete，收到 ${JSON.stringify(action)}。` });
				}

				const raw = readUserFile(profilePath);
				const parsed = parseUserFile(raw);
				const entries = [...parsed.entries];
				const before = entryBudget(entries);

				let next: string[];
				let position: number;

				if (action === "add") {
					const norm = normalizeEntryText(params?.content);
					if (!norm.ok) return reply({ success: false, error: norm.error, usage: usageText(before, USER_CHAR_LIMIT), entryCount: entries.length });
					next = [...entries, norm.text];
					position = next.length - 1;
				} else {
					const located = locateEntry(entries, params?.target);
					if (!located.ok) {
						return reply({
							success: false,
							error: located.error,
							usage: usageText(before, USER_CHAR_LIMIT),
							entryCount: entries.length,
							candidates: located.candidates,
						});
					}
					position = located.index;
					if (action === "delete") {
						next = entries.filter((_, i) => i !== position);
					} else {
						const norm = normalizeEntryText(params?.content);
						if (!norm.ok) return reply({ success: false, error: norm.error, usage: usageText(before, USER_CHAR_LIMIT), entryCount: entries.length });
						next = [...entries];
						next[position] = norm.text;
					}
				}

				// 限额按**整篇**复核：单次 op 合法但总量超预算时，拒绝并要求先腾空间。
				// 这是"每次只动一条"的自然配套 —— 模型只能自己删/压缩别的条目来腾地方。
				const budget = entryBudget(next);
				if (budget > USER_CHAR_LIMIT) {
					return reply({
						success: false,
						error:
							`本次改动会让 USER.md 达到 ${budget} 字符，超过上限 ${USER_CHAR_LIMIT}（改动前 ${before}）。` +
							`未做任何改动。请先用 l3_edit 删除或压缩其他条目腾出空间，再重试本次 ${action}。`,
						usage: usageText(before, USER_CHAR_LIMIT),
						entryCount: entries.length,
					});
				}

				ensureRunBackup(profilePath, raw);
				writeUserFile(profilePath, serializeUserFile(next, parsed.eol, parsed.trailingNewline));
				try {
					onChanged?.();
				} catch {
					// non-fatal
				}

				return reply({
					success: true,
					position,
					usage: usageText(budget, USER_CHAR_LIMIT),
					entryCount: next.length,
				});
			} catch (err) {
				return reply({ success: false, error: err instanceof Error ? err.message : String(err) });
			}
		},
	});
}
