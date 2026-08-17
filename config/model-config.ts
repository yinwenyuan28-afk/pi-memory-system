/**
 * 记忆系统模型配置（2026-08-08）
 *
 * 目的：记忆系统后台 LLM 调用（keyword 提取 / inverted index filter /
 * workflow 信号确认 / workflow 总结）统一走"配置模型"，不跟随前台会话切换。
 * 默认 (minimax-cn) MiniMax-M3；可通过 {agentDir}/memory-model.json 修改。
 *
 * 设计：
 *   - 只读配置文件（不提供交互切换命令）
 *   - 全局 agentDir 级别（非 profile 隔离），所有 profile 共享同一配置
 *   - 配置缺失/无效 → fallback 到 ctx.model（不破坏现有行为）
 *   - model_select 事件不触发回写（保持"后台不跟随前台"语义）
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getModel as resolveBuiltinModel } from "@earendil-works/pi-ai/compat";

/** 配置文件名（位于 agentDir 根）。 */
const CONFIG_FILE_NAME = "memory-model.json";

/** 配置项结构。 */
export interface MemoryModelConfig {
	provider: string;
	modelId: string;
}

/**
 * 获取配置文件绝对路径。
 *
 * @param agentDir agent 配置目录（~/.pi/agent）
 */
export function getConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

/**
 * 读取配置。返回 null 表示文件不存在或内容无效。
 *
 * 校验：必须是合法 JSON 对象 + 字符串类型字段。无效不抛错（不阻塞启动）。
 */
export function readConfig(agentDir: string): MemoryModelConfig | null {
	const path = getConfigPath(agentDir);
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			typeof (parsed as any).provider === "string" &&
			typeof (parsed as any).modelId === "string" &&
			(parsed as any).provider.length > 0 &&
			(parsed as any).modelId.length > 0
		) {
			return {
				provider: (parsed as any).provider,
				modelId: (parsed as any).modelId,
			};
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * 解析配置为模型对象。配置缺失或 provider/modelId 不在 builtin catalog → 返回 fallback。
 *
 * @param agentDir agent 配置目录
 * @param fallback 配置不可用时的兜底模型（通常为 ctx.model）
 * @returns 模型对象（保证非空，因为 fallback 非空时一定有）
 */
export function resolveConfiguredModel(agentDir: string, fallback: unknown): unknown {
	const cfg = readConfig(agentDir);
	if (!cfg) return fallback;
	try {
		return resolveBuiltinModel(cfg.provider as any, cfg.modelId as any);
	} catch {
		// provider/modelId 组合不在 builtin catalog → fallback
		return fallback;
	}
}