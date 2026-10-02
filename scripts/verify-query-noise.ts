/**
 * `util/query-noise.ts` 契约回归（2026-10-02）
 *
 * 覆盖五组：
 *   A. 噪声识别：实测 20 种形态全识别
 *   B. **零误判**：L0 真实数据里长度 ≥12 的 user 消息，一条都不能被判噪声
 *   C. 三档决策：bare / replaced / skipped 的边界
 *   D. replaced 质量：替代出来的文本必须「非噪声、够长、来自正确来源」
 *   E. 纯函数性质：幂等、无副作用、对畸形输入不抛错
 *
 * ⚠ **B 组是本脚本的核心价值**：它锁住「保守优先」这个方向性。
 * 判噪声漏判只是走 replaced 档（无损失）；误判正常提问会让它丢召回（真损失）。
 * 这个不对称决定了阈值必须偏保守，而 B 组用真实数据把它钉死。
 *
 * 用法：tsx --conditions=import scripts/verify-query-noise.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_HISTORY_CHAR_LIMIT,
	NOISE_MAX_LEN,
	buildQueryText,
	isNoisePrompt,
} from "../util/query-noise.ts";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown): void {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (ok) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name} — 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
	}
}
function checkTrue(name: string, got: boolean): void {
	check(name, got, true);
}

// ══════════════════════════════════════════════════════════════
//  A. 噪声识别：实测形态
// ══════════════════════════════════════════════════════════════
console.log("\n=== A. 噪声识别（实测形态）===");
const MEASURED_NOISE = [
	"需要", "一并提交", "提交", "同意", "开始执行", "我已重启，1", "继续", "可以", "开始修复",
	"我已重启", "推送", "同意‘’", "开始实现", "继续修复", "继续执行", "开工",
	"按你说的来", "、", "行为正常", "同意，按你说的来",
];
let missed = 0;
for (const s of MEASURED_NOISE) {
	if (!isNoisePrompt(s)) {
		missed++;
		console.log(`    ✗ 漏判: ${JSON.stringify(s)}`);
	}
}
check(`A1 实测 ${MEASURED_NOISE.length} 种噪声形态全部识别`, missed, 0);

console.log("\n=== A2. 正常提问不得误判（零误判方向）===");
const NORMAL = [
	"推送你觉得要怎么做",
	"帮我解释一下快速排序",
	"我听不懂你解释一下",
	"现在的给别人祝福的卡片有没有和别的堆叠卡片统一",
	"能不能全部统一大小",
	"做一个页面出来用来查看我的所有愿望",
	"N个愿望每天都能注入一次，实现起来有没有困难",
	"给我解释一下快速排序，并给出复杂度分析",
	"把 A104527 的 ContractServiceImpl 补上幂等校验",
];
let falsePositive = 0;
for (const s of NORMAL) {
	if (isNoisePrompt(s)) {
		falsePositive++;
		console.log(`    ✗ 误判: ${JSON.stringify(s)}`);
	}
}
check(`A2 ${NORMAL.length} 条正常提问零误判`, falsePositive, 0);

console.log("\n=== A3. 边界与畸形输入 ===");
check("A3a 空串 → 噪声", isNoisePrompt(""), true);
check("A3b 纯标点「。」→ 噪声", isNoisePrompt("。"), true);
check("A3c 只有空白 → 噪声", isNoisePrompt("   \n  "), true);
check(`A3d 恰好 ${NOISE_MAX_LEN} 字的噪声（「提交提交提交提交提交提」）→ 噪声（长度不排除）`, isNoisePrompt("提交提交提交提交提交提"), true);
check("A3e 超长但全是应答词 → 不是噪声（长度优先，避免误杀长叙述）", isNoisePrompt("同意".repeat(20)), false);
// undefined / null 走「空串 ⇒ 噪声」分支是**正确**行为：prompt 缺失时必须判噪声，
// 否则会把 undefined 当成有效内容送去 embed（而不是直接跳过）。
check("A3f undefined 不抛错，且判噪声（防 prompt 缺失时被送去 embed）", isNoisePrompt(undefined as unknown as string), true);

// ══════════════════════════════════════════════════════════════
//  B. 真实数据零误判（核心）
// ══════════════════════════════════════════════════════════════
console.log("\n=== B. L0 真实数据零误判（核心价值）===");
const L0 = "C:/Users/leaf/.pi/agent/profiles/default/memoryDB/l0/conversations";
let normalTotal = 0;
let normalMisjudged = 0;
let noiseTotal = 0;
const longNoiseSamples: string[] = [];
try {
	const files = readdirSync(L0).filter((f) => f.endsWith(".jsonl")).sort();
	for (const f of files) {
		for (const line of readFileSync(join(L0, f), "utf8").split(/\r?\n/)) {
			const s = line.trim();
			if (!s) continue;
			let o: any;
			try {
				o = JSON.parse(s);
			} catch {
				continue;
			}
			const role = o.role ?? o.message?.role ?? "";
			if (role !== "user") continue;
			const c =
				typeof o.content === "string"
					? o.content
					: Array.isArray(o.content)
						? o.content.filter((x: any) => x?.type === "text").map((x: any) => x.text).join(" ")
						: "";
			if (typeof c !== "string" || !c.trim()) continue;
			if (c.trim().length >= NOISE_MAX_LEN) {
				normalTotal++;
				if (isNoisePrompt(c)) {
					normalMisjudged++;
					if (normalMisjudged <= 3) longNoiseSamples.push(c.slice(0, 50));
				}
			} else {
				noiseTotal++;
			}
		}
	}
	check(`B1 长度 ≥${NOISE_MAX_LEN} 的 user 消息零误判（共 ${normalTotal} 条）`, normalMisjudged, 0);
	checkTrue(`B2 数据集非空：扫到 ${normalTotal} 条正常 + ${noiseTotal} 条短消息`, normalTotal > 0);
} catch (e) {
	console.log(`  ⚠ L0 不可读（${e instanceof Error ? e.message : String(e)}），B 组跳过`);
}

// ══════════════════════════════════════════════════════════════
//  C. 三档决策
// ══════════════════════════════════════════════════════════════
console.log("\n=== C. 三档决策边界 ===");
{
	const r = buildQueryText({ prompt: "推送卡片怎么改" });
	check("C1 有实质内容 → bare", r.kind, "bare");
	check("C2 bare 的 text = 裸 prompt", r.text, "推送卡片怎么改");
}
{
	const r = buildQueryText({ prompt: "提交" });
	check("C3 噪声 + 无历史 → skipped", r.kind, "skipped");
	check("C4 skipped 的 text 必须为空串（调用方据此不发 embedding）", r.text, "");
}
{
	const r = buildQueryText({
		prompt: "同意，按你说的来",
		recentUser: ["我觉得可以，我们的还需要规范每一份plan的编写规范，生命周期"],
	});
	check("C5 噪声 + 有实质 user 历史 → replaced", r.kind, "replaced");
	check("C6 replaced 来源标为 user", r.from, "user");
	checkTrue("C7 replaced 文本**不含噪声原文**（这是提质的关键）", !r.text.includes("同意"));
	checkTrue("C8 replaced 文本就是那条实质历史", r.text.includes("plan的编写规范"));
}
{
	const r = buildQueryText({
		prompt: "提交",
		recentUser: ["需要", "好的"], // 都是噪声 ⇒ user 侧救不回
		lastAssistant: "## 实施完成，验证全部通过\n### 后端（A104527，ContractServiceImpl）已改幂等校验",
	});
	check("C9 user 侧全噪声 → 退到 assistant 兜底", r.kind, "replaced");
	check("C10 assistant 兜底时 from=assistant", r.from, "assistant");
	checkTrue("C11 assistant 兜底文本含实质内容", r.text.includes("实施完成"));
}
{
	const r = buildQueryText({ prompt: "同意", recentUser: ["好的", "继续"], lastAssistant: "嗯" });
	check("C12 全都救不回（user 与 assistant 都是噪声）→ skipped", r.kind, "skipped");
}
{
	// 噪声 + assistant 是实质 ⇒ 但应**优先 user**（实测 98.2% 的情况下 user 侧就有）
	const r = buildQueryText({
		prompt: "需要",
		recentUser: ["plan_approve是怎么维护一个变量，来明确标识用户是否已经同意了计划"],
		lastAssistant: "你说到关键点上了——光靠 LLM 调一个工具不可信",
	});
	check("C13 user 与 assistant 都可用 → 优先 user", r.from, "user");
}
{
	// expandContext 兼容旧行为
	const r = buildQueryText({
		prompt: "这个怎么处理",
		recentUser: ["上次那个报错", "还有别的问题吗"],
		expandContext: true,
	});
	check("C14 expandContext=true 时有实质 prompt 仍走 bare（兼容旧路径）", r.kind, "bare");
	checkTrue("C15 expandContext=true 时按旧行为追加历史", r.text.includes("上次那个报错"));
}
{
	const r = buildQueryText({ prompt: "这个怎么处理", expandContext: false });
	check("C16 expandContext=false → 纯裸 prompt，不拼历史", r.text, "这个怎么处理");
}
{
	// 噪声在 expandContext=true 下也应走 replaced（噪声判定优先于扩展）
	const r = buildQueryText({
		prompt: "同意",
		recentUser: ["统一所有plan的编写规范和生命周期定义"],
		expandContext: true,
	});
	check("C17 噪声判定**优先于** expandContext（噪声即替代，不追加）", r.kind, "replaced");
	checkTrue("C18 replaced 文本不含噪声原文", !r.text.includes("同意"));
}

// ══════════════════════════════════════════════════════════════
//  D. 替代质量
// ══════════════════════════════════════════════════════════════
console.log("\n=== D. 替代质量（replaced 不能产出垃圾）===");
{
	// 扫真实数据：所有 replaced 产物都必须「非噪声 + 有内容」
	const files = readdirSync(L0).filter((f) => f.endsWith(".jsonl")).sort();
	let replacedTotal = 0;
	let replacedIsNoise = 0;
	let replacedTooShort = 0;
	let replacedEchoesNoise = 0;
	const badSamples: string[] = [];
	for (const f of files) {
		const msgs: { role: string; content: string }[] = [];
		for (const line of readFileSync(join(L0, f), "utf8").split(/\r?\n/)) {
			const s = line.trim();
			if (!s) continue;
			try {
				const o = JSON.parse(s);
				const role = o.role ?? o.message?.role ?? "";
				const c =
					typeof o.content === "string"
						? o.content
						: Array.isArray(o.content)
							? o.content.filter((x: any) => x?.type === "text").map((x: any) => x.text).join(" ")
							: "";
				if (role && typeof c === "string") msgs.push({ role, content: c });
			} catch {
				/* 跳过 */
			}
		}
		for (let i = 0; i < msgs.length; i++) {
			const m = msgs[i];
			if (m.role !== "user" || !isNoisePrompt(m.content)) continue;
			const prevUser = msgs.slice(0, i).filter((x) => x.role === "user").slice(-2).reverse().map((x) => x.content);
			const prevAsst = [...msgs.slice(0, i)].reverse().find((x) => x.role === "assistant")?.content ?? "";
			const r = buildQueryText({ prompt: m.content, recentUser: prevUser, lastAssistant: prevAsst });
			if (r.kind !== "replaced") continue;
			replacedTotal++;
			if (isNoisePrompt(r.text)) {
				replacedIsNoise++;
				if (badSamples.length < 3) badSamples.push(`产出是噪声: ${JSON.stringify(r.text.slice(0, 40))}`);
			}
			if (r.text.trim().length < 8) {
				replacedTooShort++;
				if (badSamples.length < 3) badSamples.push(`产出太短: ${JSON.stringify(r.text.slice(0, 40))}`);
			}
			if (r.text.trim() === m.content.trim()) {
				replacedEchoesNoise++;
				if (badSamples.length < 3) badSamples.push(`原样返回了噪声: ${JSON.stringify(r.text.slice(0, 40))}`);
			}
		}
	}
	check(`D1 真实数据上 ${replacedTotal} 次 replaced，产出**不是噪声**`, replacedIsNoise, 0);
	check(`D2 replaced 产出**长度均 ≥8 字**`, replacedTooShort, 0);
	check(`D3 replaced **从不原样返回噪声原文**`, replacedEchoesNoise, 0);
	checkTrue(`D4 replaced 命中数 > 0（${replacedTotal} 次，否则说明替代路径形同虚设）`, replacedTotal > 0);
	for (const s of badSamples) console.log(`    ✗ ${s}`);
}

// ══════════════════════════════════════════════════════════════
//  E. 纯函数性质
// ══════════════════════════════════════════════════════════════
console.log("\n=== E. 纯函数性质与畸形输入 ===");
{
	check("E1 空 prompt + 空历史 → skipped", buildQueryText({ prompt: "" }).kind, "skipped");
	check("E2 undefined prompt 不抛错", buildQueryText({ prompt: undefined as unknown as string }).kind, "skipped");
	check(
		"E3 undefined recentUser 不抛错",
		buildQueryText({ prompt: "好的", recentUser: undefined }).kind,
		"skipped",
	);
	check(
		"E4 undefined lastAssistant 不抛错",
		buildQueryText({ prompt: "好的", lastAssistant: undefined }).kind,
		"skipped",
	);
	// 幂等：同一输入连续两次结果相同（纯函数不应有隐藏状态）
	const input = { prompt: "同意", recentUser: ["统一plan编写规范与生命周期定义"] };
	const r1 = buildQueryText(input);
	const r2 = buildQueryText(input);
	check("E5 纯函数幂等（同输入两次结果一致）", r1, r2);
	// 历史超长时按上限截断
	const long = "x".repeat(5000);
	const r3 = buildQueryText({ prompt: "好的", recentUser: [long] });
	check("E6 历史超长 → 按 historyCharLimit 截断", r3.text.length, DEFAULT_HISTORY_CHAR_LIMIT);
	// 历史里混噪声与实质，应跳过噪声取实质
	const r4 = buildQueryText({
		prompt: "好的",
		recentUser: ["需要", "把A104527的ContractServiceImpl补上幂等校验", "提交"],
	});
	check("E7 历史里混噪声 → 取到实质那条", r4.text, "把A104527的ContractServiceImpl补上幂等校验");
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
