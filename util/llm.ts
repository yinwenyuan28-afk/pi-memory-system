/**
 * 后台 LLM 调用公共封装（2026-08-19）。
 *
 * 背景：index.ts（inverted index filter）、memory/search/searcher.ts（关键词提取 /
 * 相关性过滤）两处原本各自复制粘贴
 * 同一段样板——AbortController + setTimeout 超时 + completeSimple + content 提取
 * + catch 兜底。此处是单一真相源。（原先还有 workflow/detector、workflow/manager
 * 两处，2026-10-02 随 workflow 系统一并删除。）
 *
 * 职责边界：
 *   - 只做「超时 + content 提取 + 错误兜底」，返回**模型的文本输出**或 null；
 *   - JSON 解析、业务语义（关键词数组 / keep keys / 布尔判定）留在各调用点。
 *
 * 模型来源：由调用方传 `resolveConfiguredModel(profilePath, ctx.model, ctx.modelRegistry)` 的结果
 * （config/model-config.ts，读统一配置中心的 `model.llm` 条目；第三个参数是宿主 registry，
 *   少了它解析不了 models.json 里的自定义 provider），或 ctx.model 本身；传 null/undefined 直接返回 null。
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";

/** 默认超时（毫秒），对齐各调用点原有 LLM_TIMEOUT_MS = 5000。 */
const DEFAULT_TIMEOUT_MS = 5000;

/** completeSimple 要求的模型类型（provider + api 配置对象）。 */
type LLMModel = Parameters<typeof completeSimple>[0];

export interface CallLLMOptions {
	/** 超时毫秒数，默认 5000；超时 abort 并返回 null。 */
	timeoutMs?: number;
	/**
	 * 本次请求的输出 token 上限；不传则由模型自己的 `maxTokens` 决定。
	 *
	 * 加它的唯一动因（2026-09-30）：`judg-session-project` 用的配置模型是**推理模型**，
	 * token 会先花在 `reasoning_content` 上 —— `max_tokens:120` 会得到
	 * `finish_reason:"length"` 且 **content 是空串**（实测 24/30 全空）。
	 * 底层 `completeSimple` 的 options 继承 `StreamOptions`，而 `StreamOptions.maxTokens`
	 * 本来就存在（pi-ai dist/types.d.ts:48），所以这里只是透传，不需要新写 fetch。
	 *
	 * ⚠ 推理模型上给小了不会报错、只会静默返回空串 —— 调用点必须把"content 为空"当失败处理。
	 */
	maxTokens?: number;
	/**
	 * 显式 API key；不传则由 pi-ai 从**环境变量**里按 provider 名去找
	 * （`completeSimple` → `getEnvApiKey(model.provider, options.env)`）。
	 *
	 * 加它的动因（2026-09-30）：`judg-session-project` 的判定在**主进程**里跑，
	 * 生产路径有 `ctx.modelRegistry` 能解析出完整模型对象，但**独立脚本没有** ——
	 * 脚本里只能自己从 `{agentHome}/models.json` + `auth.json` 组装模型对象，
	 * 那里没有环境变量兜底，必须显式带 key。
	 *
	 * ⚠ 别把 key 写进代码或日志：`auth.json` 里的值一旦被回显进会话记录就会被 L0 归档持久化
	 * （与已知的 skill-feed 密钥泄漏同类）。本仓所有脚本一律只从文件读、不打印。
	 */
	apiKey?: string;
}

/** 从 `completeSimple` 的 `content` 里取出**文本部分**。 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content);
	// content 是分片数组：`{type:"thinking"|"text"|"toolCall", …}`。
	// ⚠ **只要 text 段** —— 推理模型会先产出一大段 `thinking`（本机配置的
	// `deepseek/deepseek-v4.1-flash` 就是），把它一起 JSON.stringify 出去等于
	// 让调用方 `JSON.parse` 到一个**分片数组**而不是模型自己的 JSON 答案。
	// 既有调用点（migrate-sub-memories、judg-session-project）全都是
	// `JSON.parse(raw)` 期望模型输出，所以这不是新需求，是修一个一直存在的错。
	return content
		.filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
		.map((p) => String((p as { text?: unknown }).text ?? ""))
		.join("");
}

/**
 * 发起一次 LLM 调用，返回**模型的文本输出**。
 *
 * - 模型为空 → 直接返回 null（防御性双保险，调用点守卫仍保留）；
 * - 超时（默认 5s）自动 abort；
 * - content 为字符串直接返回；为分片数组时拼接其中的 `text` 段（见 {@link extractText}）；
 * - 拿不到任何文本（推理模型把 token 全花在 reasoning 上、撞上 max_tokens 上限时
 *   会只返回 `thinking` 段）→ 返回**空串**，调用点按失败处理；
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
			{
				signal: controller.signal,
				...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
				...(options?.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
			} as any,
		);
		return extractText(result.content);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
