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
import { readModelEntry } from "./memory-system-config.js";

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
 * 解析配置为模型对象。配置缺失或 provider/modelId 不在 builtin catalog → 返回 fallback。
 *
 * @param profilePath profile 根目录（配置从 {profilePath}/memoryDB/config/memory-system-model.json 读取）
 * @param fallback 配置不可用时的兜底模型（通常为 ctx.model）
 * @returns 模型对象（保证非空，因为 fallback 非空时一定有）
 */
export function resolveConfiguredModel(profilePath: string, fallback: unknown): unknown {
	const cfg = readConfig(profilePath);
	if (!cfg) return fallback;
	try {
		return resolveBuiltinModel(cfg.provider as any, cfg.modelId as any);
	} catch {
		// provider/modelId 组合不在 builtin catalog → fallback
		return fallback;
	}
}
