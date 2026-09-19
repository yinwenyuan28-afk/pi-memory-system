// 配置模型解析链（resolveConfiguredModel）的回归基线
//
// **必须带 NODE_OPTIONS="--conditions=import" 跑**（与两条 agent-loop 脚本同因）：
//   `config/model-config.ts` 静态导入 `@earendil-works/pi-ai/compat`，而扩展包是
//   `"type": "commonjs"` → 该 `.ts` 被当 CJS 加载 → 该子路径**没有 require 条件** →
//   报 ERR_PACKAGE_PATH_NOT_EXPORTED。加上条件后按 import 解析即可（AGENTS.md「环境」有出处）。
//   （脚本本体用 .mts 只是为了不吃 CJS 顶层 await 限制，并不免除这个 flag。）
//
// 守的是 2026-09-20 的静默失效：旧 resolveConfiguredModel 只查 pi-ai 内置目录，而 pi-ai 对
// **未知 provider 返回 undefined 而不抛异常**（实测 getModel("command","deepseek/deepseek-v4.1-flash")
// === undefined）→ undefined 被当成"解析成功"返回、连 fallback 都丢了
// → runValueCheck 每批 skipped:"无可用模型"，L1 价值校验闸门静默失效数日（主对话却一直能用该模型，
//   因为它走的是宿主 registry）。
//
// 铁律：只用系统临时目录。
//
// 用 tsx 跑：NODE_OPTIONS="--conditions=import" tsx scripts/verify-model-config.mts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfiguredModel, readConfig } from "../config/model-config.ts";

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

/** 造带 model.llm 配置的临时 profile。 */
function makeProfile(llm?: { provider: string; modelId: string }): string {
	const root = mkdtempSync(join(tmpdir(), "modelcfg-"));
	mkdirSync(join(root, "memoryDB", "config"), { recursive: true });
	const cfg: Record<string, unknown> = { l1: { mode: "code" } };
	if (llm) cfg.model = { llm };
	writeFileSync(join(root, "memoryDB", "config", "application-propertis.json"), JSON.stringify(cfg), "utf-8");
	return root;
}

const FALLBACK = { provider: "fallback", id: "session-model", api: "x" };
const FAKE = { provider: "command", id: "deepseek/deepseek-v4.1-flash", api: "openai-completions" };

console.log("\n=== 1. readConfig：只认完整的 provider/modelId ===");
{
	const ok = makeProfile({ provider: "command", modelId: "deepseek/deepseek-v4.1-flash" });
	check("完整条目 → 读出", readConfig(ok)?.provider === "command" && readConfig(ok)?.modelId === "deepseek/deepseek-v4.1-flash");
	const noCfg = makeProfile();
	check("无 model.llm → null", readConfig(noCfg) === null);
	const empty = makeProfile({ provider: "", modelId: "x" });
	check("provider 空串 → null（不返回半成品）", readConfig(empty) === null);
	rmSync(ok, { recursive: true, force: true });
	rmSync(noCfg, { recursive: true, force: true });
	rmSync(empty, { recursive: true, force: true });
}

console.log("\n=== 2. resolveConfiguredModel：三段解析链 ===");
{
	const root = makeProfile({ provider: "command", modelId: "deepseek/deepseek-v4.1-flash" });

	// ① 宿主 registry 能解析 → 用配置模型（主对话走的就是这条：models.json 自定义 provider）
	const withReg = resolveConfiguredModel(root, FALLBACK, { find: () => FAKE });
	check("① registry 命中 → 用配置模型（不回退）", withReg === FAKE, JSON.stringify(withReg));

	// ② 无 registry：pi-ai 内置目录里没有 command → 必须回退 fallback（**旧代码返回 undefined**）
	const noReg = resolveConfiguredModel(root, FALLBACK);
	check("② 无 registry → fallback（不得返回 undefined）", noReg === FALLBACK, String(noReg));

	// ③ registry 查不到（模型名写错）→ fallback
	const miss = resolveConfiguredModel(root, FALLBACK, { find: () => undefined });
	check("③ registry 查不到 → fallback", miss === FALLBACK, String(miss));

	// ④ registry 抛错 → fallback（不得把异常抛出调用方）
	const boom = resolveConfiguredModel(root, FALLBACK, { find: () => { throw new Error("boom"); } });
	check("④ registry 抛错 → fallback（不抛）", boom === FALLBACK, String(boom));

	// ⑤ registry 形态不对（没有 find）→ fallback
	const weird = resolveConfiguredModel(root, FALLBACK, { hello: 1 });
	check("⑤ registry 无 find 方法 → fallback", weird === FALLBACK, String(weird));

	// ⑥ 内置 provider 仍能从 pi-ai 目录解析（无 ctx 的脚本路径）
	const builtinRoot = makeProfile({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	const builtin = resolveConfiguredModel(builtinRoot, FALLBACK) as { provider?: string } | undefined;
	check("⑥ 内置 provider 无 registry 也能解析（anthropic）", builtin !== FALLBACK && builtin?.provider === "anthropic", JSON.stringify(builtin));

	// ⑦ 无配置 → 直接 fallback
	const empty = makeProfile();
	check("⑦ 配置缺失 → fallback", resolveConfiguredModel(empty, FALLBACK) === FALLBACK);

	// ⑧ fallback 为空时返回空（调用方 runValueCheck 会报 skipped:"无可用模型"，不是崩）
	const nullFb = resolveConfiguredModel(root, null);
	check("⑧ fallback=null → 返回 null（由调用方 fail-open）", nullFb === null, String(nullFb));

	rmSync(root, { recursive: true, force: true });
	rmSync(builtinRoot, { recursive: true, force: true });
	rmSync(empty, { recursive: true, force: true });
}

console.log("\n=== 3. 与生产配置一致性（**只读**；读不到就跳过）===" );
{
	const realProfile = "C:/Users/leaf/.pi/agent/profiles/default";
	const cfg = readConfig(realProfile);
	if (!cfg) {
		console.log("  SKIP  生产 profile 未配置 model.llm（或路径不同）");
	} else {
		check("生产配置能被读出（provider/modelId 非空）", cfg.provider.length > 0 && cfg.modelId.length > 0, `${cfg.provider}/${cfg.modelId}`);
		// 本题只读：**不要**在这里跑一次必然失败的 resolveConfiguredModel —— 它会往真实 profile 的
		// logs/llm.log 写一行“已回退到会话模型”（2026-09-20 实测：回归跑两次就攒了 6 条误导性日志）。
		// “查不到必须回退、不得返回 undefined” 已由第 2 组（临时 profile）覆盖。
	}
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exit(1);
