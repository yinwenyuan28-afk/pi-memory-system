/**
 * verify-judg-project-accuracy.mts — 「会话级项目归属判定」四臂评测
 *
 *   用法（`.mts` 与 tsx 都需要，见文件尾的运行说明）：
 *     /c/dev/ide/pi-agent/pi-0.80.10/node_modules/.bin/tsx scripts/verify-judg-project-accuracy.mts
 *     node --experimental-strip-types scripts/verify-judg-project-accuracy.mts
 *
 * ── 为什么必须有这个脚本 ──
 *
 * 没有尺子的时候，本功能改了好几轮参数，其中**至少两轮是负收益**：
 * 「目录不计入文件数」把准确率从 97% 压到 93%，「仓库级 bash 调用次数单独计权」压到 90%。
 * 两轮都是**改完看不出好坏**、靠事后翻数据才发现。所以本脚本是硬门槛：
 * 改任何抽取/提示词逻辑之后必须重跑，比对基线。
 *
 * ── 脚体内置的三条防线（都是踩过坑之后加的）──
 *
 * ① **采样与标注用同一个数据源**：`ruler.json` 里存的是**完整 sessionKey**（不是截断前缀、
 *    不是按时间重新抽一遍），脚本只按 key 去磁盘上找文件。
 *    历史事故：抽样脚本和标注脚本各写一份，抽取口径一改被选中的会话集合就变了，
 *    标签整体错位而数字看着仍然合理 —— 本轮踩了五次。
 *
 * ② **跑之前先逐条比对 sessionKey 与 cwd**：任一条对不上 ruler 记录就直接退出。
 *    口径改了就必须重做这一步。
 *
 * ③ **带 `/g` 的正则不得直接喂 `.test()`**：`lastIndex` 会跨调用保留，同一个文件在不同次
 *    运行里得到不同答案，不报错。历史事故：它让一度报出的「候选池召回 86%」是错的，真值 93%。
 *    （`candidates.ts` 里所有布尔判定用的都是无 `g` 的正则。）
 *
 * ── 四臂 ──
 *
 *   A  纯代码 top1，不弃权
 *   B  纯代码三规则：单一候选 / top 占比 ≥60% 才敢定，否则弃权
 *   C  ~~代码 + 决策模型 Jev~~ **已删**（2026-09-30 实测：与 A 逐行完全相同，零增量）
 *   D  代码提候选 + 一个普通 LLM 判断（读前 3 条用户消息）
 *
 * 判定口径：truth 与答案都归一到「去盘符 + 小写」的相对路径再比。
 * `多义`（同时涉及多个项目且无主线）**按严格相等计**，也就是判错 —— 保守计法，
 * 好处是不给任何方案灌水；这一行在明细表里单独可见。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCandidates, topShare, USER_MESSAGE_CHARS, type ExtractResult } from "../util/judg-session-project/candidates.ts";
import { judgeProject, JUDGE_MAX_TOKENS, resolveJudgeModel } from "../util/judg-session-project/llm.ts";
import { parseJsonc } from "../util/jsonc.ts";

// ══════════════════════════════════════════════════════════════
//  常量
// ══════════════════════════════════════════════════════════════

const AGENT_HOME = process.env.PI_AGENT_HOME ?? "C:/Users/leaf/.pi/agent";
const PROFILE = process.env.PI_PROFILE_PATH ?? join(AGENT_HOME, "profiles", "default");
const SESSIONS = join(AGENT_HOME, "sessions");
const RULER = join(import.meta.dirname, "fixtures", "judg-session-project", "ruler.json");

/** 判定不弃权时的 top 占比阈值（B 臂专用）。 */
const TOP_SHARE_LOCK = 0.6;

interface RulerRow { n: number; sessionKey: string; dir: string; cwd: string | null; truth: string }

// ══════════════════════════════════════════════════════════════
//  归一：truth 与答案都变成「去盘符 + 小写」的相对路径
// ══════════════════════════════════════════════════════════════

function relKey(p: string | null | undefined): string | null {
	if (p === null || p === undefined) return null;
	const s0 = String(p).trim().replace(/\\/g, "/");
	if (!s0) return null;
	if (s0 === NONE) return NONE;
	// ⚠ 必须**先小写再判断盘符**：写成 `!/^[a-z]:\//.test(原串)` 的话，`C:/…` 会因为大写 C
	//    被判成"非绝对路径"而返回 null —— 于是 relKey(答案) 与 relKey(标准答案) 双双为 null，
	//    `null === null` 让精确率虚高成 100%（踩过一次）。
	let s = s0.toLowerCase().replace(/^[a-z]:\//, "").replace(/\/+$/, "");
	return s || null;
}

const NONE = "无";

/** A 臂：候选第一名，不弃权。 */
function armPureTop1(x: ExtractResult): string {
	return x.candidates[0]?.path ?? NONE;
}

/** B 臂：单一候选 或 top 占比达标才定，否则弃权。 */
function armPureRules(x: ExtractResult): string {
	if (x.candidates.length === 0) return NONE;
	if (x.candidates.length === 1) return x.candidates[0].path;
	return topShare(x.candidates) >= TOP_SHARE_LOCK ? x.candidates[0].path : NONE;
}

// ══════════════════════════════════════════════════════════════
//  统计
// ══════════════════════════════════════════════════════════════

interface Row { n: number; truth: string; answers: Record<string, string | null>; recallHit: boolean }

interface ArmStat {
	judged: number; correct: number;
	/** 有项目却被判成「无」。 */
	noneMissed: number;
	/** 有项目且调用失败（没答上来）。 */
	failuresInProject: number;
	/** 全部调用失败次数。 */
	failures: number;
}

function emptyStat(): ArmStat {
	return { judged: 0, correct: 0, noneMissed: 0, failuresInProject: 0, failures: 0 };
}

function tally(rows: Row[], arm: string): ArmStat {
	const s = emptyStat();
	for (const r of rows) {
		const a = r.answers[arm];
		const truthNone = r.truth === NONE;
		if (a === null) {
			// 调用失败：既不算答对、也不算"判成无"（那是两种不同的失败）
			s.failures++;
			if (!truthNone) s.failuresInProject++;
			continue;
		}
		s.judged++;
		const ok = relKey(a) === relKey(r.truth) || r.truth === NONE;
		if (ok) s.correct++;
		if (!truthNone && a === NONE) s.noneMissed++;
	}
	return s;
}

const pct = (n: number, d: number): string => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "—");

// ══════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
	if (!existsSync(RULER)) throw new Error(`尺子不在：${RULER}`);
	const ruler = JSON.parse(readFileSync(RULER, "utf-8")) as { sessions: RulerRow[] };
	const items = ruler.sessions;
	if (items.length === 0) throw new Error("尺子是空的");

	// ── 防线 ②：先逐条核对 sessionKey / cwd，对不上直接退出 ──
	console.log(`=== 防线②：尺子与磁盘逐条比对（${items.length} 条）===`);
	const loaded: { row: RulerRow; file: string; extract: ExtractResult }[] = [];
	for (const it of items) {
		const file = join(SESSIONS, it.dir, `${it.sessionKey}.jsonl`);
		if (!existsSync(file)) throw new Error(`#${it.n} 会话文件不存在：${file}\n  ⇒ 尺子与磁盘不同步，先重做逐条比对（计划「测量脚本踩过的两个坑」第 2 条）`);
		const first = readFileSync(file, "utf-8").split("\n", 1)[0];
		let cwd: string | null = null;
		try { cwd = (JSON.parse(first) as { cwd?: string }).cwd ?? null; } catch { /* 忽略 */ }
		const same = String(cwd).toLowerCase() === String(it.cwd).toLowerCase();
		console.log(`  ${same ? "OK  " : "✗   "} #${String(it.n).padStart(2)} ${it.sessionKey.slice(0, 26)}… cwd=${cwd}  truth=${it.truth}`);
		if (!same) throw new Error(`#${it.n} cwd 与尺子不符：磁盘 ${cwd} vs 尺子 ${it.cwd}`);
		loaded.push({ row: it, file, extract: extractCandidates(file) });
	}

	const withProject = items.filter((i) => i.truth !== NONE).length;
	const noneTruth = items.length - withProject;
	console.log(`\n有项目 ${withProject} 条 / 「无」${noneTruth} 条 / 合计 ${items.length} 条`);
	console.log(`候选池召回（真值出现在 top5 候选里）：`);
	let recallHit = 0;
	for (const { row, extract } of loaded) {
		if (row.truth === NONE) continue;
		const hit = extract.candidates.some((c) => relKey(c.path) === relKey(row.truth));
		if (hit) recallHit++;
		else console.log(`  ✗ #${row.n} 真值 ${row.truth} 不在候选池：${extract.candidates.map((c) => `${c.path}(${c.files})`).join(" | ") || "(空)"}`);
	}
	console.log(`  → ${recallHit}/${withProject} = ${pct(recallHit, withProject)}`);

	// ── 记忆系统里"用户点名路径"的召回（LLM 臂的兜底能力）──
	let namedHit = 0;
	for (const { row, extract } of loaded) {
		if (row.truth === NONE) continue;
		if (extract.pathsNamedByUser.some((p) => relKey(p.path) === relKey(row.truth))) namedHit++;
	}
	console.log(`用户消息点名了真值：${namedHit}/${withProject} = ${pct(namedHit, withProject)}`);

	// ── A / B 臂（纯代码，零成本）──
	const rows: Row[] = loaded.map(({ row, extract }) => ({
		n: row.n, truth: row.truth, recallHit: false,
		answers: { A: armPureTop1(extract), B: armPureRules(extract), D: null },
	}));

	// ── D 臂（LLM）──
	const runLlm = !process.argv.includes("--no-llm");
	if (runLlm) {
		const m = resolveJudgeModel(PROFILE);
		if (!m) {
			console.log(`\n⚠ D 臂跳过：解析不到配置模型（profile=${PROFILE}）`);
		} else {
			console.log(`\n=== D 臂：代码提候选 + LLM 判断（${m.provider}/${m.modelId}）===`);
			for (let i = 0; i < loaded.length; i++) {
				const { row, extract } = loaded[i];
				const r = await judgeProject(m.model, extract, { timeoutMs: 60_000, maxTokens: JUDGE_MAX_TOKENS, apiKey: m.apiKey });
				// ⚠ 调用失败 ≠ 判成「无」。前者是"没答"，后者是"答了没有项目" ——
				//   混在一起会同时虚高「无」识别、虚高"有项目被误判成无"。
				rows[i].answers.D = r.ok ? (r.project ?? NONE) : null;
				process.stdout.write(`  #${String(row.n).padStart(2)} ${r.ok ? "✓" : "✗"} ${rows[i].answers.D}  ${r.reason ?? r.error ?? ""}\n`);
			}
		}
	}

	// ── 汇总 ──
	const arms = runLlm && rows.some((r) => r.answers.D !== null) ? ["A", "B", "D"] : ["A", "B"];
	console.log(`\n=== 汇总 ===`);
	console.log(`精确率 = 答了的里面对的比例（调用失败不计入分母）`);
	console.log(`覆盖率 = 有项目的会话里答出了项目的比例（判「无」与调用失败都算没覆盖到）`);
	console.log(`\n方案   精确率                 覆盖率              「无」识别         有项目被判「无」  调用失败`);
	for (const arm of arms) {
		const s = tally(rows, arm);
		const covered = withProject - s.noneMissed - s.failuresInProject;
		const noneCorrect = rows.filter((r) => r.truth === NONE && r.answers[arm] === NONE).length;
		console.log(
			`  ${arm.padEnd(4)} ${`${s.correct}/${s.judged} ${pct(s.correct, s.judged)}`.padEnd(22)}` +
			`${`${covered}/${withProject} ${pct(covered, withProject)}`.padEnd(19)}` +
			`${`${noneCorrect}/${noneTruth} ${pct(noneCorrect, noneTruth)}`.padEnd(18)}` +
			`${String(s.noneMissed).padEnd(16)}${s.failures}`,
		);
	}

	console.log(`\n=== 逐条明细 ===`);
	console.log(`#   标准答案                                    A                          B                          D`);
	for (const r of rows) {
		const f = (v: string | null) => (v === null ? "(调用失败)" : (v === NONE ? "无" : String(relKey(v)))).padEnd(27);
		console.log(`${String(r.n).padStart(2)}  ${r.truth.padEnd(43)}${f(r.answers.A)}${f(r.answers.B)}${f(r.answers.D)}`);
	}
	if (process.argv.includes("--dump")) {
		const wide = Number(process.argv[process.argv.indexOf("--dump") + 1]);
		const limit = Number.isFinite(wide) && wide > 0 ? wide : 0;
		console.log(`\n=== 候选明细${limit ? `（前 ${limit} 个）` : ""} ===`);
		for (const { row, file } of loaded) {
			const extract = limit ? extractCandidates(file, { limit }) : loaded.find((x) => x.row.n === row.n)!.extract;
			const c = extract.candidates.map((x) => `${relKey(x.path)}(${x.files})`).join("  ");
			const u = extract.pathsNamedByUser.slice(0, 4).map((x) => `${relKey(x.path)}×${x.mentions}`).join("  ");
			console.log(`#${String(row.n).padStart(2)} tc=${String(extract.toolCallCount).padStart(4)} top占比=${topShare(extract.candidates).toFixed(2)}`);
			console.log(`     候选: ${c || "(空)"}`);
			console.log(`     点名: ${u || "(空)"}`);
		}
	}
}

await main();
