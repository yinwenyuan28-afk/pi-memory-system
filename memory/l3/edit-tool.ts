import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderPrompt } from "../../prompts/registry.ts";
import { applyL3Edit, type L3EditParams } from "./edit-core.ts";

/**
 * 注册 `l3_edit` 工具（扩展加载时一次）。
 *
 * 用户 2026-09-16 裁定：L3 可以管理整份 USER.md，但**每一次工具调用只能操作一条记忆**。
 * 本工具就是那条约束的落点 —— `content` 必须单行、不含 `§`，所以"整篇重写"在接口层
 * 就不可能发生；`update` / `delete` 的定位由代码裁决，模型只给特征片段。
 *
 * 2026-09-28（用户裁定）**落盘目标是 `USER-temp.md`（提议稿），不是 live `USER.md`**：
 * live 画像不再被自动改写，并入由用户手工完成（注入侧读的始终是 USER.md）。
 *
 * **编排不在这里**（2026-10-08）：预算闸、定位裁决、备份与 `markRunSeeded` 的时点全部搬到了
 * `edit-core.ts` 的 `applyL3Edit` —— 因为查看器的写盘桥要复用同一段逻辑（它走 CLI，不能走工具），
 * 而两份实现必然分叉。工具现在只是参数透传的薄壳。
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
			const reply = (r: unknown) => ({
				content: [{ type: "text", text: JSON.stringify(r) }],
				details: {},
			});
			const profilePath = getProfilePath();
			if (!profilePath) return reply({ success: false, error: "No active profile" });
			// 与 `applyL3Edit` 的约定：它自己不抛（内部 try/catch 后结构化返回），失败原因原样回给模型。
			return reply(applyL3Edit(profilePath, params as L3EditParams, { onChanged }));
		},
	});
}
