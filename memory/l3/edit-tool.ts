import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderPrompt } from "../../prompts/registry.ts";
import { USER_CHAR_LIMIT } from "./config.ts";
import {
	entryBudget,
	locateEntry,
	normalizeEntryText,
	serializeUserFile,
	usageText,
	type EntryOpResult,
} from "./entries.ts";
import {
	ensureRunBackup,
	l3RunEntries,
	markRunSeeded,
	readL3Proposal,
	readL3TargetFile,
	USER_TEMP_FILE,
	writeUserTempFile,
} from "./user-file.ts";
import { isStopRequested, stopRequestedMessage } from "../pipeline/stop-request.ts";
import { acquireRunLock, runLockBusyMessage } from "../pipeline/run-lock.ts";

/**
 * 注册 `l3_edit` 工具（扩展加载时一次）。
 *
 * 用户 2026-09-16 裁定：L3 可以管理整份 USER.md，但**每一次工具调用只能操作一条记忆**。
 * 本工具就是那条约束的落点 —— `content` 必须单行、不含 `§`，所以"整篇重写"在接口层
 * 就不可能发生；`update` / `delete` 的定位由代码裁决，模型只给特征片段。
 *
 * 2026-09-28（用户裁定）**落盘目标是 `USER-temp.md`（提议稿），不是 live `USER.md`**：
 * live 画像不再被自动改写，并入由用户手工完成（注入侧读的始终是 USER.md）。工作副本口径见
 * `user-file.ts` 的 `readL3Proposal`（live 条目在前 + temp 独有条目在后 ⇒ 首次提议以 live 播种，
 * `update`/`delete` 仍能定位 live 条目；同时不会清掉用户手工放进 temp 的候选）。
 *
 * @param onChanged 写盘成功后的回调（主进程用于刷新 USER.md 注入快照；此刻 L3 已不写 live，
 *                  该回调等价于 no-op，保留是为"未来多一个写入者"时不必再改签名）
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
				// 停止请求（2026-09-26）：硬上限停掉 L3 子代理时，入口拒写（提议稿会被用户并入
				// 受保护的 live 画像，"把被杀点推到操作边界"在这里尤其重要）
				if (isStopRequested(profilePath, "l3")) return reply({ success: false, error: stopRequestedMessage("l3") });
				// 运行级锁（2026-09-26）：谁写谁持锁 —— 两个 L3 交错提交会互相覆盖同一份提议稿
				const runLock = acquireRunLock(profilePath, "l3");
				if (!runLock.acquired) return reply({ success: false, error: runLockBusyMessage("l3", runLock.owner) });

				const action = typeof params?.action === "string" ? params.action : "";
				if (action !== "add" && action !== "update" && action !== "delete") {
					return reply({ success: false, error: `action 必须是 add / update / delete，收到 ${JSON.stringify(action)}。` });
				}

				const rawTarget = readL3TargetFile(profilePath);
				const proposal = readL3Proposal(profilePath);
				// 本轮工作副本：第一次写盘时以 live + temp 独有条目播种（见 user-file.ts 头注释第 2 条）
				const entries = [...l3RunEntries(profilePath)];
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
				// 口径按"并入 live 之后的整篇"算（工作副本 = live + 本轮改动），所以它直接等于
				// 用户把 temp 并进 USER.md 后的用量：不会出现"提议通过、合并超限"。
				//
				// 两种被拒形态（第二种是要命的死锁，别把它合回"一律 budget > LIMIT 就拒"）：
				//   ① 常规：改动把用量推过上限 → 拒，让模型先腾空间；
				//   ② 工作副本本来就超限（live 已近满 + temp 里还有用户未并入的条目）→ **只放行真能
				//      降低用量的改动**。若这里也一律拒，删除 op 的"改动后用量"仍在上限之上 ⇒ 恒拒
				//      ⇒ L3 连腾空间的第一步都做不了。
				const budget = entryBudget(next);
				if (budget > USER_CHAR_LIMIT && budget >= before) {
					const over = before > USER_CHAR_LIMIT;
					return reply({
						success: false,
						error:
							`本次改动会让画像达到 ${budget} 字符，超过上限 ${USER_CHAR_LIMIT}（改动前 ${before}）。` +
							`未做任何改动。` +
							(over
								? `当前工作副本本身就超限（live 画像 + ${USER_TEMP_FILE} 里尚未并入的条目），只有能**降低**用量的改动才放行。`
								: `写入稿是 ${USER_TEMP_FILE}，但它按"并入 USER.md 后的整篇"计价。`) +
							`请先用 l3_edit 删除或压缩其他条目腾出空间，再重试本次 ${action}。`,
						usage: usageText(before, USER_CHAR_LIMIT),
						entryCount: entries.length,
					});
				}

				ensureRunBackup(profilePath, rawTarget);
				writeUserTempFile(profilePath, serializeUserFile(next, proposal.eol, proposal.trailingNewline));
				// 写盘成功 ⇒ 本轮工作副本切口径到"temp 原文"（之后的删改立刻生效，见 user-file.ts）
				markRunSeeded();
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
