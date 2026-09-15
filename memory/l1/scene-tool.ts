/**
 * `list_l1_scenes` 工具 —— 主代理按需查看 L1 工作场景池
 *
 * 背景（2026-09-15 L1_PROJECT_SIGNAL）：主代理写 L1 时原来的场景归属靠"猜"（取同 cwd 最近条目），
 * 而 cwd 是**会话工作台**不是项目（实测 memory-system 的记录 cwd 全是 pi fork 目录、34 条线程挤在
 * 一个 cwd 下），猜错会把记录贴进不相干的场景、污染 L2 分组。
 *
 * 为什么是工具而不是把清单塞进系统提示：`MEMORY_TOOL_REMINDER` 须保持常量以命中 provider
 * prefix cache，每轮变动的清单会让缓存失效；**按需工具调用完全不碰系统提示**。
 * 为什么不让主代理直接 `read` scenes.json：路径要它自己拼、JSON 要它自己解析、文件会随池增长——
 * 工具返回的正好是"当前该看的那几十条"（与子代理注入同窗口 60 天、同上限 40 条）。
 *
 * 只读：不写盘、不记日志、不影响命中统计。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderPrompt } from "../../prompts/registry.ts";
import { readScenePool, selectScenePoolEntries, SCENE_POOL_INJECT_LIMIT, SCENE_POOL_WINDOW_DAYS } from "./scene-pool.ts";

export function registerListL1ScenesTool(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): void {
	pi.registerTool({
		name: "list_l1_scenes",
		label: "List L1 Scenes",
		description: renderPrompt("tools#list_l1_scenes"),
		parameters: { type: "object", properties: {} },
		async execute() {
			const profilePath = getProfilePath();
			if (!profilePath) {
				return { content: [{ type: "text", text: JSON.stringify({ error: "No active profile" }) }], details: {} };
			}
			try {
				const pool = readScenePool(profilePath);
				const entries = selectScenePoolEntries(pool);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								scenes: entries.map((e) => ({
									id: e.id,
									name: e.name,
									cwd: e.cwds[0] ?? "",
									lastUsedAt: e.lastUsedAt,
									useCount: e.useCount,
								})),
								returned: entries.length,
								...(entries.length === 0
									? { hint: "场景池为空：请在 l1_commit 里给一个稳定标签 `{项目}｜{议题}` 作 scene_name（不要在名字里写当前活动）。" }
									: {}),
								note: `最多 ${SCENE_POOL_INJECT_LIMIT} 条，仅含 ${SCENE_POOL_WINDOW_DAYS} 天内活跃且未被合并的条目；复用请回传 id。`,
							}),
						},
					],
					details: {},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
					details: {},
				};
			}
		},
	});
}
