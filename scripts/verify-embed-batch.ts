// embed_and_search 批量模式（T4）的离线回归
//
// 为什么不测全链路：批量分支要真 embedding 服务 + 真向量库，离线跑会碰真实 profile 的库。
// 这里锁三件**能离线确定**的事：
//   ① 参数守卫（超条数 / 空输入 / 单条兼容）—— 不触及 embedding 就能判
//   ② 注册进 provider 的 schema 形状（queries 必须是 string[]）
//   ③ **静态**锁住批量分支的存在与关键形状（embedBatch + results + 预览裁剪 + queryVector），
//      防止有人把整段批量逻辑删了而回归不报（这条分支的收益是"少往返"，删了不会报错）
// 用 tsx 跑：tsx scripts/verify-embed-batch.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerEmbedAndSearchTool } from "../memory/search/embedding/tool.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

// 扩展根目录**从脚本自身位置推导**，不写死插件安装路径（2026-10-08 修，与 verify-tool-schemas.ts 同款问题）。
// 原值 `C:/Users/leaf/.pi/agent/extensions/memory-system` 是迁移前的安装位置；扩展改为从开发仓库加载后
// 该目录不存在，第 3 节的静态检查会直接 ENOENT 崩掉 —— 也就是说这段"防被无声删除"的断言一直没在跑。
const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(EXT, "memory", "search", "embedding", "tool.ts");

interface CapturedTool {
	name: string;
	parameters: { type?: string; properties: Record<string, Record<string, unknown>>; required?: string[] };
	execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }>;
}

async function main(): Promise<void> {
	const captured: CapturedTool[] = [];
	registerEmbedAndSearchTool({ registerTool: (t: unknown) => captured.push(t as CapturedTool) } as never);
	const tool = captured[0];
	const call = async (params: unknown) => {
		const res = (await tool.execute("t", params)) as unknown;
		// 裸调工具拿到的是**载荷对象**（包装成 AgentToolResult 是 index.ts 的 registerTool 包装器干的），
		// 所以两种形状都要认 —— 别把"包装器不在"当成测试失败
		const anyRes = res as { content?: Array<{ text: string }> };
		if (Array.isArray(anyRes?.content)) return JSON.parse(anyRes.content[0].text) as Record<string, unknown>;
		return res as Record<string, unknown>;
	};

	console.log("\n=== 1. 参数守卫（不触及 embedding）===");
	check("工具名正确", tool.name === "embed_and_search");
	{
		const tooMany = await call({ queries: Array.from({ length: 51 }, (_, i) => `q${i}`) });
		check("超批量上限（51 条）→ 明确报错", String(tooMany.error ?? "").includes("最多批量"), String(tooMany.error ?? ""));
		check("报错时 results 为空数组（不假装成功）", Array.isArray(tooMany.results) && (tooMany.results as unknown[]).length === 0);

		const empty = await call({});
		check("既无 queries 也无 queryText → 报错并指路 queries", String(empty.error ?? "").includes("queries"), String(empty.error ?? ""));
		const emptyArr = await call({ queries: [] });
		check("queries=[] → 落到单条分支并报错（不静默成功）", String(emptyArr.error ?? "").includes("queries"), String(emptyArr.error ?? ""));
	}

	console.log("\n=== 2. schema 形状（provider 面由 verify-tool-schemas 兜）===");
	{
		// 裸工具声明的是**扁平 map**（`{ queryText: {...} }`），归一化成正规 JSON Schema 是
		// index.ts 的 registerTool 包装器干的 —— 所以两种形状都认；provider 面另有 verify-tool-schemas 兜
		const raw = tool.parameters as unknown as Record<string, unknown>;
		const props = ((raw.properties as Record<string, Record<string, unknown>> | undefined) ?? raw) as Record<string, Record<string, unknown>>;
		check("queries 是 array<string>", props.queries?.type === "array" && (props.queries?.items as Record<string, unknown>)?.type === "string");
		check("queryText 保留（单条兼容）", props.queryText?.type === "string");
		check("topK 保留", props.topK?.type === "number");
		const required = (raw.required as string[] | undefined) ?? [];
		check("required 未强制 queries（二选一）", !required.includes("queries"));
	}

	console.log("\n=== 3. 静态：批量分支的关键形状（防被无声删除）===");
	{
		const src = readFileSync(SRC, "utf-8");
		check("批量分支走 embedBatch（一次嵌入多条）", src.includes("embeddingService.embedBatch(batch)"));
		check(
			"返回体是 results: [{index, queryText, queryVector, candidates}]",
			/results\.push\(\{\s*index: i,\s*queryText: batch\[i\],\s*queryVector,\s*candidates,?\s*\}\)/.test(src),
		);
		check("候选正文有预览裁剪常量", src.includes("BATCH_CANDIDATE_PREVIEW_CHARS"));
		check("裁剪只动 content、保留 record_id", src.includes("record_id: hit.recordId") && src.includes("contentTruncated: true"));
		check("单条分支仍在（queryVector 原样返回）", src.includes("queryVector: queryVec") && src.includes("candidates,"));
		check("批量失败留痕（fallback + 栈）", /results: \[\], fallback: true, reason: `embed_and_search\(批量\) 失败/.test(src));
	}

	console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
	if (fail > 0) process.exit(1);
}

main().catch((e: unknown) => {
	console.error("批量回归异常：", e);
	process.exit(1);
});
