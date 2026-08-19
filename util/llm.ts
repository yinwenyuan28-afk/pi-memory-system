/**
 * 后台 LLM 调用公共封装（2026-08-19）。
 *
 * 背景：index.ts（inverted index filter）、memory/search/searcher.ts（关键词提取 /
 * 相关性过滤）、workflow/detector.ts、workflow/manager.ts 四处原本各自复制粘贴
 * 同一段样板——AbortController + setTimeout 超时 + completeSimple + content 提取
 * + catch 兜底。此处是单一真相源。
 *
 * 职责边界：
 *   - 只做「超时 + content 提取 + 错误兜底」，返回纯文本或 null；
 *   - JSON 解析、业务语义（关键词数组 / keep keys / 布尔判定）留在各调用点。
 *
 * 模型来源：由调用方传 `resolveConfiguredModel(profilePath, ctx.model)` 的结果
 * （config/model-config.ts，读 memory-system-model.json 的 type=llm 条目），
 * 或 ctx.model 本身；传 null/undefined 直接返回 null。
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";

/** 默认超时（毫秒），对齐各调用点原有 LLM_TIMEOUT_MS = 5000。 */
const DEFAULT_TIMEOUT_MS = 5000;

/** completeSimple 要求的模型类型（provider + api 配置对象）。 */
type LLMModel = Parameters<typeof completeSimple>[0];

export interface CallLLMOptions {
	/** 超时毫秒数，默认 5000；超时 abort 并返回 null。 */
	timeoutMs?: number;
}

/**
 * 发起一次 LLM 调用，返回文本结果。
 *
 * - 模型为空 → 直接返回 null（防御性双保险，调用点守卫仍保留）；
 * - 超时（默认 5s）自动 abort；
 * - content 为 string 直接返回，对象则 JSON.stringify；
 * - 任何异常（超时/网络/非法模型）返回 null，不抛出。
 */
export async function callLLM(
	model: unknown,
	systemPrompt: string,
	userContent: string,
	options?: CallLLMOptions,
): Promise<string | null> {
	if (!model) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const result = await completeSimple(
			model as LLMModel,
			{
				systemPrompt,
				messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
			},
			{ signal: controller.signal } as any,
		);
		return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
