// agent loop 工具函数回归（2026-09-16，只读；不触碰生产数据、不联网、不需要 API key）
//
// 为什么需要它：util/agent-loop.ts 的 runAgentLoopOnce 是「同进程里真发 LLM + 真跑工具 + 真受
// turn/超时约束」的东西，其中三件事只有跑起来才知道对不对：
//   1. 工具形状归一（pi 注册工具的 execute 第 5 参是 ExtensionContext，必须被补上）；
//   2. maxTurns 真的封顶（not 只影响日志）；
//   3. 超时真的会 abort 循环并返回 null（not 只是设了个定时器）。
// 用 pi-ai 自带的 faux provider 构造可控响应，全部离线可复现。
//
// 用 tsx 跑（package.json 是 commonjs，顶层 await 不可用）：
//   C:/dev/ide/pi-agent/pi-0.80.10/node_modules/.bin/tsx scripts/verify-agent-loop.ts
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { runAgentLoopOnce, type CallableTool } from "../util/agent-loop.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

const registrations: FauxProviderRegistration[] = [];
function faux(options: Parameters<typeof registerFauxProvider>[0] = {}): FauxProviderRegistration {
	const registration = registerFauxProvider(options);
	registrations.push(registration);
	return registration;
}

/** 假 ExtensionContext：只放一个哨兵字段，用来验证它被原样透传到了工具的第 5 个参数。 */
const CTX_SENTINEL = { marker: "extension-context-sentinel" };
const fakeCtx = CTX_SENTINEL as never;

/** 一个 pi registerTool() 形状的工具（execute 收 5 个参数，第 5 个是 ctx）。 */
function makeEchoTool(record: Array<{ text: string; ctx: unknown; toolCallId: string }>): CallableTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo back the given text.",
		parameters: {
			type: "object",
			properties: { text: { type: "string", description: "Text to echo back." } },
			required: ["text"],
		},
		async execute(toolCallId: string, params: { text: string }, _signal?: unknown, _onUpdate?: unknown, ctx?: unknown) {
			record.push({ text: params.text, ctx, toolCallId });
			return { content: [{ type: "text", text: `echoed:${params.text}` }], details: {} };
		},
	} as unknown as CallableTool;
}

async function main(): Promise<void> {
	console.log("\n=== 1. 基线：一次 LLM 调用直接返回文本 ===");
	{
		const f = faux();
		f.setResponses([fauxAssistantMessage("plain answer")]);
		const out = await runAgentLoopOnce(f.getModel(), "You are a test.", "say hi");
		check("返回终答文本", out === "plain answer", `got ${JSON.stringify(out)}`);
		check("LLM 恰好调 1 次", f.state.callCount === 1, `callCount=${f.state.callCount}`);
	}

	console.log("\n=== 2. 工具闭环：工具被调用、ctx 透传、结果回灌模型 ===");
	{
		const f = faux();
		const calls: Array<{ text: string; ctx: unknown; toolCallId: string }> = [];
		let sawToolResultInTurn2 = false;
		f.setResponses([
			fauxAssistantMessage([fauxText("let me echo"), fauxToolCall("echo", { text: "ping" }, { id: "call-1" })]),
			(context, _options, _state) => {
				// 第二次调用时，上下文里必须已经有上一轮的 toolResult 和那个 toolCall
				sawToolResultInTurn2 = context.messages.some(
					(m) => m.role === "toolResult" && m.toolCallId === "call-1",
				);
				return fauxAssistantMessage("final after tool");
			},
		]);

		const out = await runAgentLoopOnce(f.getModel(), "You are a test.", "echo ping", {
			tools: [makeEchoTool(calls)],
			ctx: fakeCtx,
		});

		check("工具被调用 1 次", calls.length === 1, `calls=${calls.length}`);
		check("工具收到正确参数", calls[0]?.text === "ping", `text=${calls[0]?.text}`);
		check("工具收到透传的 ctx（execute 第 5 参）", calls[0]?.ctx === CTX_SENTINEL);
		check("工具结果回灌到第二次 LLM 调用", sawToolResultInTurn2);
		check("返回工具之后的终答", out === "final after tool", `got ${JSON.stringify(out)}`);
		check("LLM 调 2 次（工具轮 + 收尾轮）", f.state.callCount === 2, `callCount=${f.state.callCount}`);
	}

	console.log("\n=== 3. maxTurns 封顶：模型永不收尾时必须停在上限 ===");
	{
		const f = faux();
		const calls: Array<{ text: string; ctx: unknown; toolCallId: string }> = [];
		// 每轮都只发工具调用、从不给终答；备 5 份，若封顶失效会跑到第 4 次并被断言抓到。
		f.appendResponses(
			Array.from({ length: 5 }, () =>
				fauxAssistantMessage([fauxToolCall("echo", { text: "again" })]),
			),
		);

		const out = await runAgentLoopOnce(f.getModel(), "You are a test.", "loop forever", {
			tools: [makeEchoTool(calls)],
			ctx: fakeCtx,
			maxTurns: 3,
		});

		check("LLM 恰好调 3 次（= maxTurns）", f.state.callCount === 3, `callCount=${f.state.callCount}`);
		check("工具恰好跑 3 次", calls.length === 3, `calls=${calls.length}`);
		check("末轮 assistant 无文本 → 返回 null", out === null, `got ${JSON.stringify(out)}`);
	}

	console.log("\n=== 4. 超时：真的 abort 循环，且不给半截文本 ===");
	{
		// tokenSize 1 + tokensPerSecond 5 → 每个 chunk 间隔 200ms，整条文本要 1.6s 才发完。
		const f = faux({ tokensPerSecond: 5, tokenSize: { min: 1, max: 1 } });
		f.setResponses([
			fauxAssistantMessage("one two three four five six seven eight nine ten eleven twelve"),
		]);

		const started = Date.now();
		const out = await runAgentLoopOnce(f.getModel(), "You are a test.", "slow", { timeoutMs: 100 });
		const elapsed = Date.now() - started;

		check("超时返回 null", out === null, `got ${JSON.stringify(out)}`);
		check("确实被 abort 截断（远早于自然结束的 1.6s）", elapsed < 1000, `elapsed=${elapsed}ms`);
	}

	console.log("\n=== 5. 工具抛错不逃逸到调用方 ===");
	{
		const f = faux();
		f.setResponses([
			fauxAssistantMessage([fauxToolCall("boom", {})]),
			fauxAssistantMessage("recovered after tool error"),
		]);
		const boomTool = {
			name: "boom",
			label: "Boom",
			description: "Always throws.",
			parameters: { type: "object", properties: {} },
			async execute() {
				throw new Error("intentional tool failure");
			},
		} as unknown as CallableTool;

		let escaped: unknown = null;
		const out = await runAgentLoopOnce(f.getModel(), "You are a test.", "trigger boom", {
			tools: [boomTool],
			ctx: fakeCtx,
			onError: (e) => {
				escaped = e;
			},
		});

		check("工具抛错未逃逸（onError 未被调用）", escaped === null);
		check("循环继续并返回终答", out === "recovered after tool error", `got ${JSON.stringify(out)}`);
		check("LLM 调 2 次", f.state.callCount === 2, `callCount=${f.state.callCount}`);
	}

	console.log("\n=== 6. 参数守卫：不该发 LLM 的情况一次都不发 ===");
	{
		const f = faux();
		f.setResponses([fauxAssistantMessage("should never be reached")]);

		const byNullModel = await runAgentLoopOnce(null, "sys", "hi");
		check("model 为空 → null", byNullModel === null, `got ${JSON.stringify(byNullModel)}`);

		const byZeroTurns = await runAgentLoopOnce(f.getModel(), "sys", "hi", { maxTurns: 0 });
		check("maxTurns=0 → null", byZeroTurns === null, `got ${JSON.stringify(byZeroTurns)}`);

		const byNegativeTurns = await runAgentLoopOnce(f.getModel(), "sys", "hi", { maxTurns: -3 });
		check("maxTurns 为负 → null", byNegativeTurns === null, `got ${JSON.stringify(byNegativeTurns)}`);

		check("三种守卫都没发 LLM", f.state.callCount === 0, `callCount=${f.state.callCount}`);
	}

	console.log("\n=== 7. provider 侧失败必须走 onError，不能静默成 null ===");
	{
		// pi-ai 把请求失败编码在流里（stopReason:"error"）而不是抛出，所以这类失败绕过了 catch。
		// 2026-09-16 实测踩到：忘记传 getApiKey → 401 → 调用方只看到一个无线索的 null。
		const f = faux();
		f.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" }),
		]);

		let reported: Error | null = null;
		const out = await runAgentLoopOnce(f.getModel(), "sys", "hi", {
			onError: (e) => {
				reported = e as Error;
			},
		});

		check("onError 被调用（不静默）", reported !== null);
		check(
			"带回 provider 的原始 errorMessage",
			reported?.message === "401 invalid api key",
			`got ${JSON.stringify(reported?.message)}`,
		);
		check("仍返回 null", out === null, `got ${JSON.stringify(out)}`);
	}

	console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
	process.exit(fail === 0 ? 0 : 1);
}

main()
	.catch((e) => {
		console.error("[FATAL]", e);
		process.exit(1);
	})
	.finally(() => {
		while (registrations.length > 0) registrations.pop()?.unregister();
	});
