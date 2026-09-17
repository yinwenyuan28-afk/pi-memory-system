// agent loop 真实 provider 冒烟（2026-09-16；**会联网、会花额度、不进回归基线**，手动跑）
//
// 为什么单独成文件：util/agent-loop.ts 的四项控制参数都能用 faux provider 离线验（见
// verify-agent-loop.ts），但「provider 认证复用 pi 配置」这条**只有真的发一次请求**才算验过 ——
// pi-ai 默认只查环境变量映射表，自定义 provider（本机 command / opencode-go 来自 models.json）
// 拿不到 key 就会 401。本脚本就是那条链路的可复现证据：
//   auth.json + models.json → ModelRuntime.getModel() → runAgentLoopOnce({ getApiKey })
//
// 用法（.mts 走 ESM 才有顶层 await；NODE_OPTIONS 让 util/agent-loop.ts 这个 CJS 模块也能
// 按 import 条件解析 @earendil-works/*）：
//   NODE_OPTIONS="--conditions=import" \
//     C:/dev/ide/pi-agent/pi-0.80.10/node_modules/.bin/tsx \
//     scripts/smoke-agent-loop-provider.mts [provider] [modelId]
//
// 默认 provider=command、modelId=deepseek/deepseek-v4.1-flash（2026-09-16 实测 6.3s 返回「收到」）。
import { join } from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";

// agent-loop.ts 按 extensions/package.json 是 CJS，从 ESM 具名导入探测不到导出，故动态导入兜底。
const mod = (await import("../util/agent-loop.ts")) as unknown as Record<string, unknown> & {
	default?: Record<string, unknown>;
};
const runAgentLoopOnce = (mod.runAgentLoopOnce ?? mod.default?.runAgentLoopOnce) as typeof import("../util/agent-loop.ts").runAgentLoopOnce;

const provider = process.argv[2] ?? "command";
const modelId = process.argv[3] ?? "deepseek/deepseek-v4.1-flash";

const agentDir = getAgentDir();
const modelRuntime = await ModelRuntime.create({
	authPath: join(agentDir, "auth.json"),
	modelsPath: join(agentDir, "models.json"),
});

const model = modelRuntime.getModel(provider, modelId);
if (!model) {
	console.error(`[FATAL] models.json 里找不到 ${provider}/${modelId}`);
	process.exit(1);
}
console.log("model:", model.provider, model.id, "| api:", model.api, "| baseUrl:", model.baseUrl);

const auth = await modelRuntime.getAuth(provider);
console.log("auth 解析:", !!auth, "| apiKey 存在:", !!auth?.auth.apiKey);
if (!auth?.auth.apiKey) {
	console.error(`[FATAL] ${provider} 没解析出 apiKey —— 检查 agent/auth.json`);
	process.exit(1);
}

const started = Date.now();
const out = await runAgentLoopOnce(
	model,
	"你是一个连通性探针。严格按用户要求回复，不要多说一个字。",
	"只回复两个字：收到",
	{
		maxTurns: 2,
		timeoutMs: 60_000,
		// 关键一步：把 pi 的凭证解析结果喂给循环
		getApiKey: async (p) => (await modelRuntime.getAuth(p))?.auth.apiKey,
		onError: (e) => console.log("onError:", e),
	},
);
console.log("耗时:", Date.now() - started, "ms");
console.log("终答:", JSON.stringify(out));

if (out === null) {
	console.error("[FAIL] 返回 null —— 认证或开关有问题，看上面的 onError");
	process.exit(1);
}
console.log("[PASS] 复用 pi 配置的凭证跑通了一次 agent loop");

// ── 第二段：真实 provider + 真实工具调用 ────────────────────────────────────
// 这段验的是文档里点名的那个坑：工具的 parameters 必须是已归一化的 JSON Schema
// （顶层 type:"object" + properties），扁平 map 会被严格 provider 400 拒收。
console.log("\n--- 真实 provider 上的工具调用 ---");
const toolCalls: string[] = [];
const timeTool = {
	name: "get_canary",
	label: "Get canary",
	description: "Return the canary string. Always use this tool when asked for the canary.",
	parameters: {
		type: "object",
		properties: { slot: { type: "string", description: "Which slot to read." } },
		required: ["slot"],
	},
	async execute(_toolCallId: string, params: { slot: string }) {
		toolCalls.push(params.slot);
		return { content: [{ type: "text", text: `CANARY-${params.slot}` }], details: {} };
	},
};

const toolStarted = Date.now();
const toolOut = await runAgentLoopOnce(
	model,
	"你是一个工具调用测试体。被要求取金丝雀值时必须调用 get_canary 工具。",
	"取 slot=a 的金丝雀值，然后把工具返回的内容原样发给我，不要加任何其他字。",
	{
		// 故意断言「工具真的被调了」——模型没调就说明工具没送达 provider
		tools: [timeTool],
		maxTurns: 3,
		timeoutMs: 60_000,
		getApiKey: async (p) => (await modelRuntime.getAuth(p))?.auth.apiKey,
		onError: (e) => console.log("onError:", e),
	},
);
console.log("耗时:", Date.now() - toolStarted, "ms");
console.log("工具调用记录:", JSON.stringify(toolCalls));
console.log("终答:", JSON.stringify(toolOut));

const toolOk = toolCalls.length === 1 && toolCalls[0] === "a" && toolOut?.includes("CANARY-a");
console.log(toolOk ? "[PASS] 真实 provider 上工具被调用且结果回灌" : "[FAIL] 工具未被调用或结果没回灌");
process.exit(toolOk ? 0 : 1);
