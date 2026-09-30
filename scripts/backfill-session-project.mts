/**
 * backfill-session-project.mts — 给「最近 N 个活跃会话」补上项目归属判定
 *
 * 用法：
 *   tsx scripts/backfill-session-project.mts [--limit 20] [--dry-run] [--profile <path>]
 *
 * ── 为什么需要它 ──
 *
 * 运行时判定挂在 `agent_settled` 上，只覆盖**判定落地之后**的会话。刚装上时那份
 * `judg-session-project.json` 是空的，`l1_commit` 会连续走 `fallback`（退回会话工作台），
 * 也就是"等于今天的行为"——不算错，但要等两周才看得出效果。
 * 最近的会话往往正是现在还在用的那些，把它们先补上，功能立刻可用。
 *
 * ── 为什么"最近 N 个"而不是"全部 91 个" ──
 *
 * 计划明确裁定「只管正在使用的会话，91 个历史不补」：历史会话不会再被判定，
 * 补出来的是永远变不亮的空壳。**这条依然成立**，本脚本不推翻它 ——
 * 它只补 mtime 最近的 N 个（N 默认 20），且这批会话本来就会被运行时判定继续维护。
 *
 * ── 关键：与运行时走同一条代码路径 ──
 *
 * 调 `setup.ts` 导出的 `judgeAndPersist`（内含 `persistJudgement`），**不另写一份写盘逻辑**。
 * 否则 `decidedBy` / `confidence` / `evidence` 的口径会悄悄分叉，
 * 而这种分叉要等到几个月后对比数据才发现。
 *
 * ── 边界 ──
 *
 *   - **不删、不改任何已有条目**：`ensureSessionEntry` 对已存在的 key 原样返回，
 *     回填只覆盖它自己刚写下的那一批。真要重判请删掉对应 key 再跑。
 *   - 每个会话一次请求，串行执行（并发会撞网关限流，且失败率上升）。
 *   - 失败不重试、不中断：一条挂了就记下来，继续下一条（B1 的语义：保留初值）。
 *   - `--dry-run` 只读不写，用来先看会动哪些 key。
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { judgeAndPersist, readSessionCwd, sessionKeyOf } from "../util/judg-session-project/setup.ts";
import { resolveJudgeModel } from "../util/judg-session-project/llm.ts";
import { readSessionJudg } from "../util/judg-session-project/index.ts";

// ── 参数 ──
const argv = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LIMIT = Number(argOf("--limit", "20"));
const DRY_RUN = argv.includes("--dry-run");
const AGENT_HOME = process.env.PI_AGENT_HOME ?? join(homedir(), ".pi", "agent");
const PROFILE = argOf("--profile", process.env.PI_PROFILE_PATH ?? join(AGENT_HOME, "profiles", "default"));
const SESSIONS = join(AGENT_HOME, "sessions");

// ── 枚举会话文件，按 mtime 倒序（"最近活跃" = 最后一次被写）──
interface Sess { file: string; key: string; mtime: number; size: number }
const all: Sess[] = [];
for (const dir of readdirSync(SESSIONS)) {
	const d = join(SESSIONS, dir);
	let isDir = false;
	try { isDir = statSync(d).isDirectory(); } catch { continue; }
	if (!isDir) continue;
	for (const f of readdirSync(d)) {
		if (!f.endsWith(".jsonl")) continue;
		const file = join(d, f);
		try {
			const st = statSync(file);
			all.push({ file, key: f.slice(0, -".jsonl".length), mtime: st.mtimeMs, size: st.size });
		} catch { /* 读不到就跳过 */ }
	}
}
all.sort((a, b) => b.mtime - a.mtime);
const targets = all.slice(0, LIMIT);

console.log(`profile  : ${PROFILE}`);
console.log(`sessions : ${SESSIONS}（共 ${all.length} 个，取最近 ${targets.length} 个）`);
if (DRY_RUN) console.log("模式     : --dry-run（只读不写）");

// ── 已有条目先看一眼（回填会覆盖它们）──
const existing = targets.filter((t) => readSessionJudg(PROFILE, t.key) !== null);
if (existing.length > 0) {
	console.log(`\n⚠ 其中 ${existing.length} 个**已有条目**，本次会被覆盖：`);
	for (const e of existing) {
		const cur = readSessionJudg(PROFILE, e.key)!;
		console.log(`   ${e.key.slice(0, 30)}… 现值 flag=${cur.flag} decidedBy=${cur.decidedBy} project=${cur.project}`);
	}
	console.log("   （要保留原值就别跑；或先把这些 key 从 judg-session-project.json 里删掉）");
}
if (DRY_RUN) {
	console.log("\n将要处理：");
	for (const t of targets) console.log(`   ${new Date(t.mtime).toISOString()}  ${(t.size / 1024).toFixed(0).padStart(6)} KB  ${t.key}`);
	process.exit(0);
}

// ── 解析模型（与运行时同一个函数族；脚本没有 ctx，走 models.json + auth.json 自组装）──
const m = resolveJudgeModel(PROFILE);
if (!m) {
	console.error(`\n✗ 解析不到配置模型（profile=${PROFILE}）。判定用 {profile}/memoryDB/config/application-propertis.json 的 model.llm 决定 provider/modelId，key 取 {agentHome}/auth.json 的同名条目。`);
	process.exit(1);
}
console.log(`model    : ${m.provider}/${m.modelId}\n`);

// ── 串行判定 ──
let ok = 0;
let noProject = 0;
let failed = 0;
const failures: string[] = [];
for (const [i, t] of targets.entries()) {
	const cwd = readSessionCwd(t.file);
	const r = await judgeAndPersist(PROFILE, t.key, t.file, cwd, m.model, m.apiKey);
	const tag = r.ok ? (r.flag ? "✓" : "○") : "✗";
	// ⚠ 显示用 `judgedProject`（判定结论）而不是 `entry.project`（落盘值）：
	//   判成「无项目」时 entry.project 是建条目时的**启动目录占位值**，打印它会误导成"判出了这个项目"。
	const detail = r.ok ? (r.flag ? `${r.judgedProject}` : `无项目（${r.reason ?? "证据不足"}）`) : r.error;
	if (!r.ok) { failed++; failures.push(`${t.key} → ${r.error}`); }
	else if (r.flag) ok++;
	else noProject++;
	console.log(`  [${String(i + 1).padStart(2)}/${targets.length}] ${tag} ${t.key.slice(0, 30).padEnd(32)} cwd=${(cwd || "(无)").padEnd(42)} → ${detail}`);
	// 轻微节流：网关抖动时连发容易拿到空响应
	if ((i + 1) % 5 === 0) await new Promise((r2) => setTimeout(r2, 800));
}

console.log(`\n完成：判定出项目 ${ok} / 判为无项目 ${noProject} / 失败 ${failed}（共 ${targets.length}）`);
if (failures.length > 0) {
	console.log("\n失败的（保留建条目时的初值，运行时判定会继续覆盖它们）：");
	for (const f of failures) console.log(`  ${f}`);
}
console.log(`\n下一步：node scripts/judg-session-project-report.mjs  # 看分布、失败次数、fallback 占比`);
