/**
 * 记忆系统 LLM 模型配置（2026-08-08 创建，2026-08-19 迁移）
 *
 * 目的：记忆系统后台 LLM 调用（keyword 提取 / inverted index filter /
 * workflow 信号确认 / workflow 总结）统一走"配置模型"，不跟随前台会话切换。
 *
 * 配置来源：{profilePath}/memoryDB/config/memory-system-model.json 的
 * `type: "llm"` 条目（profile 级，每个 profile 独立配置）。
 * 条目示例：{"type":"llm","provider":"opencode-go","modelId":"mimo-v2.5"}
 *
 * 设计：
 *   - 只读配置文件（不提供交互切换命令）
 *   - 配置缺失/无效 → fallback 到 ctx.model（不破坏现有行为）
 *   - model_select 事件不触发回写（保持"后台不跟随前台"语义）
 *   - 所有模型配置（含 embedding）集中在 memory-system-model.json（见 config/memory-system-config.ts）
 */

import { getModel as resolveBuiltinModel } from "@earendil-works/pi-ai/compat";
import { readModelEntry } from "./memory-system-config.ts";
import { logEvent } from "../util/notice.ts";

/** type=llm 条目结构。 */
export interface MemoryModelConfig {
	provider: string;
	modelId: string;
}

/**
 * 读取 type=llm 条目。返回 null 表示无条目或内容无效。
 *
 * 校验：provider/modelId 必须是非空字符串。
 */
export function readConfig(profilePath: string): MemoryModelConfig | null {
	const entry = readModelEntry(profilePath, "llm");
	if (!entry) return null;
	if (
		typeof entry.provider === "string" &&
		typeof entry.modelId === "string" &&
		entry.provider.length > 0 &&
		entry.modelId.length > 0
	) {
		return { provider: entry.provider, modelId: entry.modelId };
	}
	return null;
}

/**
 * 解析配置为模型对象。
 *
 * 解析顺序（2026-09-20 修）：① 传进来的宿主 `modelRegistry.find(provider, modelId)` ——
 * **models.json 里的自定义 provider（command / opencode-go）只有这条路能解析**，
 * 主对话能用它们正是因为走的是宿主 registry；
 * ② pi-ai 内置目录 `getModel()`（历史路径，只对内置 provider 有效）；
 * ③ 会话模型 fallback。
 *
 * 历史坑：旧实现只走 ②，而 pi-ai 对未知 provider **返回 undefined 不抛异常**，
 * 于是 undefined 被当成结果返回、fallback 也丢了 → `runValueCheck` 报 "无可用模型"。
 *
 * @param profilePath profile 根目录（配置从 {profilePath}/memoryDB/config 的 model 节读取）
 * @param fallback     配置不可用时的兜底模型（通常为 ctx.model）
 * @param registry     可选：扩展上下文里的 `ctx.modelRegistry`（能解析 models.json 自定义 provider）
 * @returns 模型对象（保证非空，因为 fallback 非空时一定有）
 */
export function resolveConfiguredModel(profilePath: string, fallback: unknown, registry?: unknown): unknown {
	const cfg = readConfig(profilePath);
	if (!cfg) return fallback;

	// ① **宿主 registry 优先**：models.json 里的自定义 provider（本机 command / opencode-go）
	// 只有它能解析——主对话能用 command/deepseek-v4.1-flash 走的正是这条；pi-ai 内置目录里没有它。
	const reg = registry as { find?: (provider: string, modelId: string) => unknown } | undefined;
	if (reg && typeof reg.find === "function") {
		try {
			const found = reg.find(cfg.provider, cfg.modelId);
			if (found) return found;
		} catch {
			// registry 查询自身出错 → 继续走下面的兜底链
		}
	}

	// ② pi-ai 内置目录（脚本无 ctx 时的历史路径）
	try {
		const builtin = resolveBuiltinModel(cfg.provider as any, cfg.modelId as any);
		// ⚠️ pi-ai 对**未知 provider 返回 undefined 而不抛异常**（2026-09-20 实测：
		// getModel("command", "deepseek/deepseek-v4.1-flash") → undefined）。旧代码写成
		// `return resolveBuiltinModel(...)` + catch 兜底，于是把 undefined 当成“解析成功”返回，
		// 连 fallback 都丢了 → runValueCheck 报 skipped:"无可用模型"（价值校验一直没跑）。
		if (builtin) return builtin;
	} catch {
		// provider/modelId 组合不在 builtin catalog → 继续兜底
	}

	// ③ 兜底到会话模型，但**必须留痕**（配置里的模型没生效不能静默）
	logEvent("llm", `配置模型无法解析，已回退到会话模型：${cfg.provider}/${cfg.modelId}`, profilePath);
	return fallback;
}
