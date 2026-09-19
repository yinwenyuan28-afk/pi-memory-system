/**
 * 同步发起一次 agent loop（2026-09-16）。
 *
 * 三个层级的调用工具，按能力递增：
 *   - util/llm.ts（callLLM）    → 单次 LLM 调用（pi-ai completeSimple）：无工具、无循环；
 *   - 本文件（runAgentLoopOnce）→ 同进程一次完整 agent loop：可调工具、多 turn、有超时，阻塞到结束返回终答文本；
 *   - util/subagent.ts          → 跨进程跑 agent/agents/*.md 里定义好的子代理（是否等待由 pi-subagents 的 async 决定）。
 *
 * 循环内核**不重写**，直接委派 @earendil-works/pi-agent-core 的 runAgentLoop —— 那与 pi 主代理
 * 是同一份实现（工具并行预检、截断参数失败、steering/follow-up、agent_end 结算都在里面）。
 * 本文件只做四件事：参数收口、工具形状归一、整体超时、终答文本提取。
 *
 * 注意两个刻意的边界：
 *   1. 不传 getSteeringMessages / getFollowUpMessages —— 本函数语义是「一次跑完就回」，
 *      不能像主代理那样被外部中途插话续跑；
 *   2. 不做上下文压缩 —— 唯一的膨胀兜底是 maxTurns，长循环请自行调小或改用 createAgentSession。
 *
 * 与主代理同进程共享 event loop：本函数会真的 await，期间主代理的 UI 不会有输出。
 * 建议从 agent_end / 命令处理器里调，不要在流式输出中途调。
 *
 * 扩展里最省事的用法（工具传你交给 pi.registerTool 的同一个对象）：
 *
 * ```ts
 * const text = await runAgentLoopOnce(
 *   resolveConfiguredModel(profilePath, ctx.model, ctx.modelRegistry),  // 或直接 ctx.model
 *   // ↑ 第三个参数（宿主 registry）不能省：models.json 里的自定义 provider（本机 command /
 *   //   opencode-go）只有它能解析，pi-ai 内置目录里没有；省了就会静默回退到会话模型。
 *   "你是记忆提取器。只输出 JSON，不要解释。",
 *   "把下面这段对话拆成原子记忆：\n" + transcript,
 *   {
 *     tools: [l1CommitTool, listScenesTool],           // 与 registerTool 同一引用
 *     ctx,                                            // pi 注册工具的第 5 个参数
 *     getApiKey: (p) => ctx.modelRegistry.getApiKeyForProvider(p),
 *     maxTurns: 6,
 *     timeoutMs: 120_000,
 *   },
 * );
 * ```
 */

import {
	type AgentMessage,
	type AgentTool,
	type ThinkingLevel,
	runAgentLoop,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 默认最大 turn 数（一次 turn = 一次 LLM 调用 + 其工具执行）。 */
const DEFAULT_MAX_TURNS = 8;

/** 默认整体超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 可传入的工具：pi 扩展 registerTool() 的定义，或 pi-agent-core 原生 AgentTool。
 *
 * 两者的差别只在 execute 的**第 5 个参数**：pi 的 ToolDefinition 是
 * `execute(toolCallId, params, signal, onUpdate, ctx)`，原生 AgentTool 只到 onUpdate。
 * 本文件统一包一层把 ctx 补上（原生 AgentTool 多收一个被忽略的参数，无副作用）。
 */
export type CallableTool = AgentTool<any, any> | ToolDefinition;

export interface AgentLoopOnceOptions {
	/**
	 * 可调用的工具，通常来自 pi.registerTool() 注册过的定义。
	 *
	 * 这里只收「定义」不收「名字」：ExtensionContext 只暴露 ToolInfo 元数据
	 * （name/description/source），拿不到可执行定义，按名字解析得在扩展里有 runner。
	 *
	 * **请传交给 pi.registerTool() 的同一个对象**，不要另造一份类似的字面量：
	 * index.ts 的 registerTool 包装器是**就地改写**的（tool.parameters 补成正规 JSON Schema、
	 * tool.execute 包成标准 AgentToolResult），复用同一引用才能白拿这两项归一化。
	 * 自己另造的扁平 schema（{ 参数名: { type } }，缺顶层 type:"object"）会一路发到
	 * provider 才被 400 拒收 —— 那条容错路径不经过本函数。
	 */
	tools?: CallableTool[];

	/** 最大 turn 数，默认 8。必须 ≥ 1，否则直接返回 null（一次 LLM 都不发）。 */
	maxTurns?: number;

	/** 整体超时毫秒，默认 120000。超时 abort 循环并返回 null（不给半截文本）。 */
	timeoutMs?: number;

	/**
	 * 传给 pi 注册工具第 5 个参数（ExtensionContext）的上下文。
	 * 调 pi 注册的工具时**必须传**，否则工具内部的 ctx 为 undefined。
	 */
	ctx?: ExtensionContext;

	/**
	 * API key 解析，按 provider 每次 LLM 调用前都会问一次。
	 *
	 * 不传则退回 pi-ai 的默认行为：只查固定的环境变量映射表（如 OPENAI_API_KEY），
	 * **没有通用兜底**。所以 models.json 里的自定义 provider（本机是 command /
	 * opencode-go）必须自己传，否则 401。
	 *
	 * 两条实测可用的复用接法：
	 *   - 扩展内（ctx 在手，最省事）：
	 *       getApiKey: (p) => ctx.modelRegistry.getApiKeyForProvider(p)
	 *   - 扩展外（脚本；modelRuntime 由 auth.json + models.json 构造）：
	 *       getApiKey: async (p) => (await modelRuntime.getAuth(p))?.auth.apiKey
	 *     （2026-09-16 实测：provider=command、模型 deepseek/deepseek-v4.1-flash，
	 *       6.3s 返回「收到」）
	 */
	getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;

	/** 思考级别，直接映射到 pi-ai 的 reasoning。不传则用 provider 默认。 */
	thinkingLevel?: ThinkingLevel;

	/** 会话 id，透传给 provider 用于缓存。 */
	sessionId?: string;

	/**
	 * 失败旁路回调；返回值仍是 null，本函数不抛出。收到两类：
	 *   1. provider 侧失败 —— pi-ai 把请求失败**编码在流里**（stopReason:"error"）而非抛出，
	 *      最常见的就是「忘记传 getApiKey → 401」。不接这个回调，这类配置错误会静默变成 null。
	 *   2. 实现/工具层面真抛出来的异常。
	 */
	onError?: (error: unknown) => void;
}

/**
 * 同步跑一次 agent loop，返回终答文本。
 *
 * @param model         pi-ai 的 Model 对象；传 null/undefined 直接返回 null（同 callLLM 的防御）
 * @param systemPrompt  系统提示词（初始上下文）
 * @param userContent   起手的用户消息
 * @param options       工具 / turn 上限 / 超时等控制参数
 * @returns 最后一个 assistant 消息的文本（trim）；下列情况返回 null：
 *          model 为空、maxTurns < 1、provider 侧失败（stopReason:"error"，同时注入 onError）、
 *          超时被 abort、终答为空、或最后一个 assistant 消息只有工具调用/纯 thinking 没有文本
 *          （例如 maxTurns 正好卡在工具轮上）
 */
export async function runAgentLoopOnce(
	model: unknown,
	systemPrompt: string,
	userContent: string,
	options: AgentLoopOnceOptions = {},
): Promise<string | null> {
	if (!model) return null;

	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	if (!Number.isFinite(maxTurns) || maxTurns < 1) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	let turns = 0;

	try {
		const messages = await runAgentLoop(
			[{ role: "user", content: userContent, timestamp: Date.now() }],
			{
				systemPrompt,
				messages: [],
				tools: (options.tools ?? []).map((tool) => bindExtensionContext(tool, options.ctx)),
			},
			{
				model: model as Model<any>,
				convertToLlm: toLlmMessages,
				getApiKey: options.getApiKey,
				reasoning: options.thinkingLevel,
				sessionId: options.sessionId,
				// 计数式 turn 上限：每轮结束后问一次，到量就交 agent_end 退出，不再发下一次 LLM。
				shouldStopAfterTurn: () => ++turns >= maxTurns,
			},
			// 事件丢弃：本函数的产物是「终答文本」，不对外暴露流式事件。
			() => {},
			controller.signal,
		);

		// pi-ai 的契约是「provider / 请求失败编码在流里（stopReason:"error"），不抛异常」
		// （pi-ai types.ts: StreamFunction 的 contract）。所以这类失败**不会**进 catch ——
		// 必须自己看 stopReason，否则最常见的配置错误（忘记给自定义 provider 传 getApiKey
		// → 401）会静默变成一个没有任何线索的 null。2026-09-16 实测踩到。
		const lastAssistant = findLastAssistant(messages);
		if (lastAssistant?.stopReason === "error") {
			options.onError?.(new Error(lastAssistant.errorMessage ?? "provider error（流内无 errorMessage）"));
			return null;
		}

		// 超时/被 abort：不回半截答案（被截断的文本比明确的 null 更容易被误用）。
		if (controller.signal.aborted || lastAssistant?.stopReason === "aborted") return null;

		return extractFinalText(lastAssistant);
	} catch (error) {
		options.onError?.(error);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 把 pi 注册的工具定义补上第 5 个参数（ExtensionContext），得到 pi-agent-core 要的 AgentTool。
 *
 * 原生 AgentTool 多收一个参数会被 JS 忽略，所以这里不区分两种形状，统一包。
 */
function bindExtensionContext(tool: CallableTool, ctx: ExtensionContext | undefined): AgentTool<any, any> {
	const execute = tool.execute as (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx?: ExtensionContext,
	) => Promise<any>;

	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate) => execute(toolCallId, params, signal, onUpdate, ctx),
	} as AgentTool<any, any>;
}

/**
 * AgentMessage[] → pi-ai Message[]。
 *
 * pi-coding-agent 的 convertToLlm 还要处理它自己的私有消息类型（bashExecution / custom /
 * branchSummary / compactionSummary）；本函数的上下文里只会出现循环自己产出的
 * user / assistant / toolResult，所以只做「保留标准三种、丢弃其余」即可 ——
 * 好处是不必为此在运行时依赖 pi-coding-agent（该包目前在本扩展里只做 type 导入）。
 *
 * 契约（照抄上游）：不许抛异常。
 */
function toLlmMessages(messages: AgentMessage[]): Message[] {
	const converted: Message[] = [];
	for (const message of messages) {
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			converted.push(message);
		}
	}
	return converted;
}

/** 取最后一条 assistant 消息（循环正常/异常结束都一定有它）。 */
function findLastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

/**
 * 取该 assistant 消息的文本；它没有文本（纯工具调用 / 全烧在 thinking 上）则返回 null。
 */
function extractFinalText(message: AssistantMessage | undefined): string | null {
	if (!message || !Array.isArray(message.content)) return null;

	const text = message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();

	return text.length > 0 ? text : null;
}
