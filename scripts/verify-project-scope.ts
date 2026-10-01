#!/usr/bin/env node
// ============================================================================
// verify-project-scope.ts — L1 项目/适用范围标签（`metadata.project` + `metadata.scope`）回归基线
//
// 用法（本仓 `.ts` 不能用 `node` 直接跑：`agent/extensions/package.json` 是
// `"type": "commonjs"`；且脚本会间接拉 `config/model-config.ts` → 静态 import
// `@earendil-works/pi-ai/compat`，那个包的 exports **只声明了 import 条件**，
// 少写 `--conditions=import` 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED: './compat'`）：
//
//   C:/dev/ide/pi-agent/pi-0.80.10/node_modules/.bin/tsx --conditions=import scripts/verify-project-scope.ts
//
// 覆盖（计划 `plan/memory-system/completed/L1-项目与范围标签-计划.md` 任务 0/3/6 的契约层）：
//   A. 取值空间：`SCOPE_VALUES` 恰好三值（self / global / unknown），旧档 `subtree` 已作废
//   B. `normalizeScope` 零容错：只吃首尾空白 + 大小写，**不做同义词映射**
//      （`subtree` / `project` / `memory-system` / `workflow` / `module` 全必须 `null`）
//   C. `normalizeProjectTag`：形态归一 / 形状校验 / **幂等**
//   D. `projectForScope` **不变量**：`global` **与 `unknown`** ⇒ project 必空（哪怕传了路径也抹掉）
//   E. 写路径：`l1_commit` 把判定值写进 `metadata.project`，而 `cwd` 保持「会话工作台」语义
//   F. 提示词同步：`agents/l1-extractor.md` 里的 scope 词表与 `SCOPE_HELP` **逐字相同**
//      （防改了常量忘改 md —— 两个副本失同步，模型看到的就是旧词表）
//
// 为什么契约层要单独立一个门禁（而不是并进场景池/判定器两个脚本）：
//   ① `project-scope.ts` **零 import**（纯函数 + 纯常量），是本仓唯一能被子进程、
//      脚本、单测三处直接复用的模块 —— 一旦它被偷偷加上 pi 依赖，这些地方就一起塌；
//   ② `normalizeScope` 的「零容错」是一条**否定型**契约：任何一条同义词映射（比如
//      `subtree → self`）都能让全部门禁照绿，而词表会在第一天就被洗成看不出真假的合法值。
//      负向用例必须显式钉住，且要覆盖存量脏值的**真实分布**（199 条里混着 5 种词）。
//   ③ E/F 两节跨模块（写盘路径 / 提示词副本），放在一起才能看出「契约 → 落盘 → 提示词」
//      三者是否还讲同一个故事。
//
// 铁律：**只用临时目录**（`mkdtempSync`），绝不碰真实 profile 与 memoryDB。
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isScopeValue, normalizeProjectTag, normalizeScope, projectForScope, SCOPE_HELP, SCOPE_VALUES, type ScopeValue } from "../memory/l1/project-scope.ts";
import { registerL1CommitTool } from "../memory/l1/commit-tool.ts";
import { upsertSessionJudg } from "../util/judg-session-project/index.ts";

let pass = 0;
let fail = 0;
/**
 * 记一条断言并打印。
 *
 * @param name  断言名（中文，须自解释"在测什么契约"）
 * @param cond  判定结果
 * @param extra 失败时打印的实际值（成功时也打印，便于肉眼核对）
 */
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

const dirs: string[] = [];
/** 造一个临时 profile：`memoryDB/` 的子目录必须先建（跨进程写锁用 `mkdirSync` 占位，父目录缺失会直接拿不到锁）。 */
function tempProfile(): string {
	const p = mkdtempSync(join(tmpdir(), "projscope-verify-"));
	dirs.push(p);
	for (const sub of ["memoryDB/l1/records", "memoryDB/pipeline", "memoryDB/state"]) mkdirSync(join(p, sub), { recursive: true });
	return p;
}
/** 读出某 profile 的全部 L1 记录（所有分片展平）。 */
function readRecs(profile: string): Record<string, unknown>[] {
	const dir = join(profile, "memoryDB", "l1", "records");
	const out: Record<string, unknown>[] = [];
	for (const f of readdirSync(dir)) {
		if (!/\.jsonl$/.test(f)) continue;
		for (const l of readFileSync(join(dir, f), "utf-8").split(/\r?\n/)) {
			if (!l.trim()) continue;
			try {
				out.push(JSON.parse(l) as Record<string, unknown>);
			} catch {
				// 坏行跳过
			}
		}
	}
	return out;
}
/** 会话工作台（`ctx.cwd`）—— 与判定出的项目刻意取不同值，任何"写串味"立刻可见。 */
const WORKBENCH = "C:\\workbench";

// ══════════════════════════════════════════════════════════════
//  D–F 需要 await（l1_commit 的 execute 是异步的），而本仓 `.ts` 经 tsx 走 CJS 转换、
//  不支持顶层 await —— 故这几节收在一个 async main 里。
// ══════════════════════════════════════════════════════════════
async function main(): Promise<void> {
	// ── A. 取值空间 ───────────────────────────────────────────────
	console.log("\n=== A. 取值空间：SCOPE_VALUES 是三值闭集（self / global / unknown） ===");
	check("A1 SCOPE_VALUES 恰好三个值", SCOPE_VALUES.length === 3, JSON.stringify(SCOPE_VALUES));
	check("A2 SCOPE_VALUES = ['self','global','unknown']（顺序即提示词展示顺序）", SCOPE_VALUES[0] === "self" && SCOPE_VALUES[1] === "global" && SCOPE_VALUES[2] === "unknown", JSON.stringify(SCOPE_VALUES));
	check("A3 旧档 'subtree' 已从取值空间移除（2026-09-30 实测否掉）", !SCOPE_VALUES.includes("subtree" as never), JSON.stringify(SCOPE_VALUES));
	check("A4 存量脏值 project / memory-system / workflow / module 都不在取值空间里", !SCOPE_VALUES.includes("project" as never) && !SCOPE_VALUES.includes("memory-system" as never), JSON.stringify(SCOPE_VALUES));
	check("A5 isScopeValue 严格区分大小写（'SELF' 不是合法值，须先 normalize）", isScopeValue("SELF") === false && isScopeValue("self") === true);
	check("A6 isScopeValue 对非字符串安全", isScopeValue(null) === false && isScopeValue(1) === false && isScopeValue(["self"]) === false);
	// 三值契约本身：'unknown' 必须在闭集里（它是"判不了"的显式弃权档，缺了它这一整套就塌回二值 fail-open）
	check("A7 'unknown' 在取值空间里（显式弃权档，缺了它 = 又退回「判不了就不写字段」）", SCOPE_VALUES.includes("unknown" as never), JSON.stringify(SCOPE_VALUES));

	// ── B. normalizeScope 零容错 ──────────────────────────────────
	console.log("\n=== B. normalizeScope：只吃空白与大小写，其余一律 null ===");
	check("B1 合法值原样返回（三档全测）", normalizeScope("self") === "self" && normalizeScope("global") === "global" && normalizeScope("unknown") === "unknown", JSON.stringify([normalizeScope("self"), normalizeScope("global"), normalizeScope("unknown")]));
	check("B2 首尾空白 + 大小写差异被吃掉（传输噪声）", normalizeScope("  SELF  ") === "self" && normalizeScope("Global") === "global" && normalizeScope("UNKNOWN") === "unknown", JSON.stringify([normalizeScope("  SELF  "), normalizeScope("Global"), normalizeScope("UNKNOWN")]));
	// ↓ 以下是本节的重点：**否定型**契约。任何一条同义词映射都会让存量垃圾被"洗"成合法标签。
	const DIRTY: Array<[string, string]> = [
		["subtree", "已作废的第三档（2026-09-30 实测否掉）"],
		["project", "存量 41 条：填成了项目名"],
		["memory-system", "存量 36 条：填成了项目名"],
		["workflow", "存量 32 条：填成了场景类型"],
		["module", "存量 19 条：填成了模块名"],
		["general", "常见的英文同义词 temptation"],
		["global-only", "带修饰的同义词 temptation"],
		["共享", "中文同义词 temptation"],
	];
	for (const [raw, why] of DIRTY) check(`B3 '${raw}' → null（不做同义词映射：${why}）`, normalizeScope(raw) === null, JSON.stringify(normalizeScope(raw)));
	check("B4 非字符串（null/undefined/数字/对象/数组）→ null", [null, undefined, 42, {}, ["self"]].every((v) => normalizeScope(v) === null));
	check("B5 空串 / 纯空白 → null", normalizeScope("") === null && normalizeScope("   ") === null);
	// 穷举两条：① 近似串**不得**被映射成 self（防同义词表）；② 合法变体**必须**被接受（防把噪声也拒了）
	const NEAR_MISS: string[] = [...DIRTY.map((d) => d[0]), "", "  ", "selfs", "self global", "self-only", "本项目", "0", "true"];
	const leakedToSelf = NEAR_MISS.filter((s) => normalizeScope(s) === "self");
	check(`B6 近似串无一被映射成 self（${NEAR_MISS.length} 个输入）`, leakedToSelf.length === 0, JSON.stringify(leakedToSelf));
	check("B7 'self' 的空白/大小写变体仍被接受（噪声不能连合法值一起拒）", ["self", "SELF", "  self  ", "Self", "\tself\n"].every((s) => normalizeScope(s) === "self"));
	// 三值化后必须单独钉住 `unknown`：它是显式弃权档，最容易被"善意的"归一吞掉
	// （要么被大小写规则拒掉、要么被当成同义词映射到 self/global），任何一种都等于把三值打回二值。
	check("B8 normalizeScope('unknown') === 'unknown'（显式弃权档必须被接受，不能被吞）", normalizeScope("unknown") === "unknown", JSON.stringify(normalizeScope("unknown")));
	check("B9 normalizeScope('UNKNOWN') === 'unknown'（大小写噪声不能连合法值一起拒）", normalizeScope("UNKNOWN") === "unknown" && normalizeScope(" Unknown ") === "unknown" && normalizeScope("\tUNKNOWN\n") === "unknown", JSON.stringify([normalizeScope("UNKNOWN"), normalizeScope(" Unknown ")]));

	// ── C. normalizeProjectTag：形态 + 形状 + 幂等 ─────────────────
	console.log("\n=== C. normalizeProjectTag：唯一形态 / 形状校验 / 幂等 ===");
	check("C1 反斜杠全转正斜杠", normalizeProjectTag("C:\\dev\\x") === "C:/dev/x", normalizeProjectTag("C:\\dev\\x"));
	check("C2 去尾部多余斜杠", normalizeProjectTag("C:/dev/x/") === "C:/dev/x" && normalizeProjectTag("C:/dev/x///") === "C:/dev/x", normalizeProjectTag("C:/dev/x///"));
	check("C3 盘符根 C:\\ 保留成 C:/（削成 C: 会不再匹配形状校验）", normalizeProjectTag("C:\\") === "C:/", normalizeProjectTag("C:\\"));
	check("C4 成对引号被剥（模型常把路径当字符串再包一层）", normalizeProjectTag('"C:/dev/x"') === "C:/dev/x" && normalizeProjectTag("  'C:/dev/x'  ") === "C:/dev/x", normalizeProjectTag('"C:/dev/x"'));
	check("C5 嵌套引号吃到不动点", normalizeProjectTag('""C:/dev/x""') === "C:/dev/x", normalizeProjectTag('""C:/dev/x""'));
	check("C6 相对路径 → 空串（不同会话 cwd 下指向不同东西，存进标签等于存定时炸弹）", normalizeProjectTag("dev/x") === "" && normalizeProjectTag("./A104527") === "" && normalizeProjectTag("../A") === "", normalizeProjectTag("./A104527"));
	check("C7 POSIX 形态（/c/dev/x）→ 空串（本机标签一律 Windows 盘符形态）", normalizeProjectTag("/c/dev/x") === "", normalizeProjectTag("/c/dev/x"));
	check("C8 UNC 前缀被压成 /server/share，不匹配形状校验 → 空串", normalizeProjectTag("\\\\server\\share") === "", normalizeProjectTag("\\\\server\\share"));
	check("C9 非字符串 / 空 / 纯空白 → 空串", [null, undefined, 42, {}, ""].every((v) => normalizeProjectTag(v as never) === ""));
	check("C10 中文路径完整保留（不截断、不转义）", normalizeProjectTag("C:/dev/code_java/wangxin/temp/面试材料/campus-hub") === "C:/dev/code_java/wangxin/temp/面试材料/campus-hub", normalizeProjectTag("C:/dev/code_java/wangxin/temp/面试材料/campus-hub"));
	check("C11 保留原始大小写（标签要原样回显给用户；大小写比较交给 projectKey）", normalizeProjectTag("C:/Dev/Code/XianHua") === "C:/Dev/Code/XianHua", normalizeProjectTag("C:/Dev/Code/XianHua"));
	// 幂等：标签被反复读写（回填器重跑、写侧再归一、召回侧比较），不幂等就会每次跑出一批新字符串。
	const IDEM: unknown[] = ["C:\\dev\\x", "C:/dev/x/", '  "C:/dev/x"  ', '""C:/dev/x""', "C:\\", "C:/", "C://dev//x", "相对路径", "", "   ", "C:/dev/x/文件.md", "/c/dev/x"];
	const notIdem = IDEM.filter((x) => normalizeProjectTag(normalizeProjectTag(x as string)) !== normalizeProjectTag(x as string));
	check(`C12 幂等：normalize(normalize(x)) === normalize(x)（${IDEM.length} 个输入）`, notIdem.length === 0, JSON.stringify(notIdem));

	// ── D. projectForScope 不变量 ─────────────────────────────────
	console.log("\n=== D. projectForScope：global 与 unknown ⇒ project 必空 ===");
	check("D1 self + 合法路径 → 归一后原样返回", projectForScope("self", "C:\\dev\\x") === "C:/dev/x", projectForScope("self", "C:\\dev\\x"));
	check("D2 global + 合法路径 → 空串（哪怕调用方传了路径也照样抹掉）", projectForScope("global", "C:/dev/x") === "", JSON.stringify(projectForScope("global", "C:/dev/x")));
	check("D3 global + 脏路径（相对 / 引号 / 空 / 非字符串）→ 一律空串", ["相对路径", '"C:/dev/x"', "", "   ", "C:\\", null as never, 42 as never].every((p) => projectForScope("global", p as string) === ""));
	// ⚠ 三值化新增的最容易漏的一条：`unknown` 必须和 `global` 一样抹掉 project。
	//   实现是 `scope === "self" ? normalizeProjectTag(project) : ""` —— 只要有人把它改回
	//   `scope === "global" ? "" : ...` 之类，"判不了"的记录就会开始携带一个不可信的路径，
	//   下游拿它当过滤依据 ⇒ 把一条没判过的记忆悄悄藏进某个仓库。
	check("D7 unknown + 合法路径 → 空串（与 global 同档：判不了就不给路径，这条最易漏）", projectForScope("unknown", "C:/a/b") === "", JSON.stringify(projectForScope("unknown", "C:/a/b")));
	// 穷举不变量：`global` / `unknown` 时返回值与**传什么**无关；`self` 时恒等于 normalizeProjectTag。
	const PROJ_IN: unknown[] = ["C:/dev/x", "C:\\dev\\x\\", '  "C:/dev/x" ', "C:/", "相对路径", "", null, undefined, 42, {}];
	const globalLeak = PROJ_IN.filter((p) => projectForScope("global", p as string) !== "");
	check(`D4 不变量穷举：global 的返回值恒为 ''（${PROJ_IN.length} 个输入）`, globalLeak.length === 0, JSON.stringify(globalLeak));
	const unknownLeak = PROJ_IN.filter((p) => projectForScope("unknown", p as string) !== "");
	check(`D8 不变量穷举：unknown 的返回值恒为 ''（${PROJ_IN.length} 个输入）`, unknownLeak.length === 0, JSON.stringify(unknownLeak));
	const selfMismatch = PROJ_IN.filter((p) => projectForScope("self", p as string) !== normalizeProjectTag(p as string));
	check(`D5 self 分支恒等于 normalizeProjectTag（不多做一步归一）`, selfMismatch.length === 0, JSON.stringify(selfMismatch.map((p) => normalizeProjectTag(p as string))));
	check("D6 三个分支的结果集合互斥（global / unknown 恒 ''，self 可能是路径）", projectForScope("global", "C:/dev/x") !== projectForScope("self", "C:/dev/x") && projectForScope("unknown", "C:/dev/x") !== projectForScope("self", "C:/dev/x"));

	// ── E. 写路径：l1_commit 的落盘形态 ───────────────────────────
	console.log("\n=== E. 写路径：l1_commit 落 metadata.project，cwd 保持会话工作台 ===");
	/** 在临时 profile 上跑一次 l1_commit，返回解析后的返回体。 */
	async function commitIn(profile: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		let def: { execute: (...a: unknown[]) => Promise<unknown> } | null = null;
		registerL1CommitTool({ registerTool: (d: unknown) => (def = d as never) } as never, () => profile);
		const ctx = { cwd: WORKBENCH, ui: { notify: () => {} }, sessionManager: { getSessionFile: () => "C:/x/sess.jsonl", getSessionId: () => "sid" } };
		const res = (await def!.execute("t", params, undefined, undefined, ctx)) as { content: { text: string }[] };
		return JSON.parse(res.content[0].text) as Record<string, unknown>;
	}
	/** 种一条会话判定条目（`flag:true` = 真判出来的项目）。 */
	const seedJudg = (profile: string, key: string, project: string, decidedBy: string): void => {
		upsertSessionJudg(profile, key, { project, flag: true, decidedBy, confidence: 0.9, evidence: [] });
	};
	const mdOf = (r: Record<string, unknown> | undefined): Record<string, unknown> => (r?.metadata as Record<string, unknown> | undefined) ?? {};

	// E1 flag:true（llm 判定）→ project 落判定值；cwd 原样保留；既有 metadata 键不被吞
	{
		const p = tempProfile();
		seedJudg(p, "sk1", "C:/dev/proj", "llm");
		await commitIn(p, {
			cursor: "2026-09-30T00:00:00.000Z",
			records: [{ id: "l1_1_aaaa", content: "E1", type: "work_fact", sessionKey: "sk1", cwd: "C:/子代理填的工作台", metadata: { work_object: "w1", status: "doing", scope: "self" } }],
		});
		const r = readRecs(p).find((x) => x.content === "E1");
		check("E1 flag:true → metadata.project = 判定出的项目", mdOf(r).project === "C:/dev/proj", JSON.stringify(mdOf(r).project));
		check("E1 metadata.projectSource = decidedBy", mdOf(r).projectSource === "llm", JSON.stringify(mdOf(r).projectSource));
		check("E1 cwd 原样保留子代理填的工作台（永不被改写成项目）", r?.cwd === "C:/子代理填的工作台", String(r?.cwd));
		check("E1 既有 metadata 键（work_object/status/scope）全部保留", mdOf(r).work_object === "w1" && mdOf(r).status === "doing" && mdOf(r).scope === "self", JSON.stringify(mdOf(r)));
	}
	// E2 flag:false → 判定不可用 ⇒ project 空串（**不取占位值**）、source=fallback、cwd 不动
	{
		const p = tempProfile();
		upsertSessionJudg(p, "sk2", { project: "C:/dev/占位", flag: false, decidedBy: "llm", confidence: 0.1, evidence: [] });
		await commitIn(p, { cursor: "2026-09-30T00:00:00.000Z", records: [{ id: "l1_1_aaaa", content: "E2", type: "work_fact", sessionKey: "sk2", cwd: "C:/子代理填的工作台" }] });
		const r = readRecs(p).find((x) => x.content === "E2");
		check("E2 flag:false → metadata.project 为空串（占位 project 不取）", mdOf(r).project === "", JSON.stringify(mdOf(r).project));
		check("E2 projectSource = fallback（判定器没出结论，如实记）", mdOf(r).projectSource === "fallback", String(mdOf(r).projectSource));
		check("E2 flag:false 也不动 cwd", r?.cwd === "C:/子代理填的工作台", String(r?.cwd));
	}
	// E3 cwd 兜底：**只在缺字段或空串时**填会话工作台
	{
		const p = tempProfile();
		await commitIn(p, {
			cursor: "2026-09-30T00:00:00.000Z",
			records: [
				{ id: "l1_1_aaaa", content: "E3缺字段", type: "work_fact" },
				{ id: "l1_1_bbbb", content: "E3空串", type: "work_fact", cwd: "" },
			],
		});
		const recs = readRecs(p);
		check("E3 cwd 缺字段 → 兜底填 ctx.cwd（会话工作台，不留空）", recs.find((x) => x.content === "E3缺字段")?.cwd === WORKBENCH, String(recs.find((x) => x.content === "E3缺字段")?.cwd));
		check("E3 cwd 传空串 → 同样兜底填 ctx.cwd", recs.find((x) => x.content === "E3空串")?.cwd === WORKBENCH, String(recs.find((x) => x.content === "E3空串")?.cwd));
	}
	// E4 不变量落地：scope=global ⇒ 即使模型自己填了 project，也被 projectForScope 抹成空串
	{
		const p = tempProfile();
		seedJudg(p, "sk4", "C:/dev/proj", "llm");
		await commitIn(p, {
			cursor: "2026-09-30T00:00:00.000Z",
			records: [{ id: "l1_1_aaaa", content: "E4", type: "work_fact", sessionKey: "sk4", cwd: "C:/工作台", metadata: { scope: "global", project: "C:/我自己填的" } }],
		});
		const r = readRecs(p).find((x) => x.content === "E4");
		check("E4 global ⇒ project 被强制抹成空串（模型自填值也不采信）", mdOf(r).project === "", JSON.stringify(mdOf(r).project));
		check("E4 global ⇒ scope 原样保留（服务端只判 scope 值不合法，不代劳改写它）", mdOf(r).scope === "global", String(mdOf(r).scope));
		check("E4 projectSource 仍记录判定来源", mdOf(r).projectSource === "llm", String(mdOf(r).projectSource));
	}
	// E5 宽松 scope 归一：' SELF ' → self ⇒ project 照写；显式 `unknown` ⇒ project 被抹空；
	//    非法 scope（存量脏值 subtree）→ 同样按 **unknown** 处理（缺省不是 self！），但 scope 字段本身不被改写
	// ⚠ 两次提交必须用**不同 id**：子代理路径的「同 id 重投跳过」会让第二条静默不落盘
	//   （这也是「一条记录 id 缺失/重复时会被无声吞掉」的实测证据，见回报）。
	{
		const p = tempProfile();
		seedJudg(p, "sk5", "C:/dev/proj", "llm");
		await commitIn(p, { cursor: "2026-09-30T00:00:00.000Z", records: [{ id: "l1_1_aaaa", content: "E5宽松", type: "work_fact", sessionKey: "sk5", cwd: "C:/工作台", metadata: { scope: " SELF " } }] });
		seedJudg(p, "sk6", "C:/dev/proj", "llm");
		await commitIn(p, { cursor: "2026-09-30T00:00:00.000Z", records: [{ id: "l1_1_bbbb", content: "E5脏值", type: "work_fact", sessionKey: "sk6", cwd: "C:/工作台", metadata: { scope: "subtree" } }] });
		seedJudg(p, "sk7", "C:/dev/proj", "llm");
		await commitIn(p, { cursor: "2026-09-30T00:00:00.000Z", records: [{ id: "l1_1_cccc", content: "E5显式unknown", type: "work_fact", sessionKey: "sk7", cwd: "C:/工作台", metadata: { scope: "unknown", project: "C:/我自己填的" } }] });
		const recs = readRecs(p);
		const loose = recs.find((x) => x.content === "E5宽松");
		const dirty = recs.find((x) => x.content === "E5脏值");
		const unk = recs.find((x) => x.content === "E5显式unknown");
		check("E5a ' SELF ' 归一为 self ⇒ scope 归一后写回、project 原样写入", mdOf(loose).scope === "self" && mdOf(loose).project === "C:/dev/proj", JSON.stringify(mdOf(loose)));
		check("E5b 非法 scope（存量脏值 subtree）⇒ 按 **unknown** 处理，project 被抹空（缺省不是 self）", mdOf(dirty).project === "", JSON.stringify(mdOf(dirty).project));
		// ⚠ 2026-10-01 修正：原断言是「非法 scope 不被改写、原样落盘」，现反过来了。
		//   存量/新写入对齐体检实测发现：只判不写 ⇒ 没填 scope 的记录落盘后**该字段消失**而非
		//   变 `unknown`，`unknown` 成了只在存量回填里存在的死值。归一后必须写回。
		//   「缺省」这件事由 projectSource 留痕，不需要靠保留脏值来体现。
		check("E5c 非法 scope 被归一为 **unknown** 写回（不再让脏值落盘）", mdOf(dirty).scope === "unknown", String(mdOf(dirty).scope));
		check("E5d 显式 scope=unknown ⇒ project 被抹空（模型自填值也不采信）", mdOf(unk).project === "", JSON.stringify(mdOf(unk).project));
		check("E5e 显式 scope=unknown 原样保留，且 projectSource 仍记录判定来源", mdOf(unk).scope === "unknown" && mdOf(unk).projectSource === "llm", JSON.stringify(mdOf(unk)));
	}
	// E5f **完全没填 scope** ⇒ 必须落成 `unknown`，字段不能消失（存量/新写入取值空间对齐的硬要求）
	{
		const p = tempProfile();
		seedJudg(p, "sk8", "C:/dev/proj", "llm");
		await commitIn(p, { cursor: "2026-09-30T00:00:00.000Z", records: [{ id: "l1_1_dddd", content: "E5没填scope", type: "work_fact", sessionKey: "sk8", cwd: "C:/工作台" }] });
		const none = readRecs(p).find((x) => x.content === "E5没填scope");
		check("E5f 没填 scope ⇒ 落成 unknown（字段不得消失，否则弃权档形同虚设）", mdOf(none).scope === "unknown", String(mdOf(none).scope));
		check("E5g 没填 scope ⇒ project 被抹空（不默认挂到会话判定项目）", mdOf(none).project === "", JSON.stringify(mdOf(none).project));
	}
	// E6 main-agent 路径走同一套（sessionKey 由服务端从 ctx 派生）
	{
		const p = tempProfile();
		seedJudg(p, "sess", "C:/dev/main路径", "manual");
		await commitIn(p, { source: "main-agent", records: [{ content: "E6", type: "work_fact", metadata: { scope: "self" } }] });
		const r = readRecs(p).find((x) => x.content === "E6");
		check("E6 main-agent：metadata.project 写入", mdOf(r).project === "C:/dev/main路径", JSON.stringify(mdOf(r).project));
		check("E6 main-agent：projectSource = manual", mdOf(r).projectSource === "manual", String(mdOf(r).projectSource));
		check("E6 main-agent：origin 键没被 metadata 合并吃掉", mdOf(r).origin === "main-agent", String(mdOf(r).origin));
		check("E6 main-agent：cwd = ctx.cwd（会话工作台）", r?.cwd === WORKBENCH, String(r?.cwd));
	}
	// E7 墓碑行（deleted:true）不碰 cwd、不塞 project —— 改它的归属等于用新语义篡改历史行
	{
		const p = tempProfile();
		seedJudg(p, "sk8", "C:/dev/新项目", "llm");
		const recDir = join(p, "memoryDB", "l1", "records");
		const oldRow = {
			id: "l1_1_aaaa",
			content: "E7",
			type: "work_fact",
			priority: 70,
			scene_name: "x｜y",
			cwd: "C:/老归属",
			deleted: false,
			version: 1,
			timestamps: ["2026-09-30T00:00:00.000Z"],
			createdAt: "2026-09-30T00:00:00.000Z",
			updatedAt: "2026-09-30T00:00:00.000Z",
			metadata: { scope: "self" },
			source_message_ids: [],
			sessionKey: "sk8",
		};
		writeFileSync(join(recDir, "2026-09-30.jsonl"), `${JSON.stringify(oldRow)}\n`, "utf-8");
		await commitIn(p, { cursor: "2026-09-30T00:00:00.000Z", records: [{ id: "l1_1_aaaa", content: "E7", type: "work_fact", deleted: true, sessionKey: "sk8", cwd: "C:/新归属也不该写" }] });
		const rows = readRecs(p).filter((r) => r.id === "l1_1_aaaa");
		const last = rows[rows.length - 1];
		check("E7 墓碑行保留原 cwd", last?.cwd === "C:/老归属", JSON.stringify(rows.map((r) => r.cwd)));
		check("E7 墓碑行未被塞进 project 标签", last?.metadata === undefined || (last?.metadata as Record<string, unknown>).project === undefined, JSON.stringify(last?.metadata));
	}

	// ── F. 提示词副本同步 ─────────────────────────────────────────
	console.log("\n=== F. 提示词同步：l1-extractor.md 的词表 = SCOPE_HELP 逐字 ===");
	{
		// 这份 md 在 agent/agents/ 下、不在本扩展内 ⇒ 只能按已知路径读（同 verify-judg-session-project.ts 的 F5–F8）
		const mdPath = "C:/Users/leaf/.pi/agent/agents/l1-extractor.md";
		const md = readFileSync(mdPath, "utf-8");
		// 词表在 md 里以 blockquote 承载（每行前缀 "> "），按 SCOPE_HELP 的三行形态摘出来
		const lines = md.split(/\r?\n/).filter((l) => /^\s*>\s*(scope 三选一|- (self|global|unknown)：)/.test(l));
		const block = lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n");
		check("F1 md 里的词表与 SCOPE_HELP 逐字相同（改常量必须同步改 md）", block === SCOPE_HELP, block === SCOPE_HELP ? `${block.split("\n").length} 行` : `md=${JSON.stringify(block)} 常量=${JSON.stringify(SCOPE_HELP)}`);
		check("F2 md 无 'subtree' 残留（作废档不得出现在给模型看的词表里）", !md.includes("subtree"));
		check("F3 md 无 'scopePath' 残留（同族的未落地字段名）", !md.includes("scopePath"));
		// 词表里点名的档位集合必须与常量一致：少一档 → 模型看不到 self/global/unknown；多一档 → 词表说了但契约不认
		const named = [...SCOPE_HELP.matchAll(/^- ([a-z]+)：/gm)].map((m) => m[1]);
		check(`F4 词表点名的档位集合 = SCOPE_VALUES（${named.join(",")}）`, named.length === SCOPE_VALUES.length && SCOPE_VALUES.every((v: ScopeValue) => named.includes(v)), JSON.stringify(named));
		check("F5 SCOPE_HELP 显式交代 'global ⇒ project 留空'（模型不写这条就会自造矛盾组合）", SCOPE_HELP.includes("project 必须留空"));
		// 三值化后新增：`unknown` 这一行也必须自带"project 留空"，否则模型会给"判不了"配一个猜的路径
		check("F6 SCOPE_HELP 的 unknown 档同样显式交代 'project 留空'", /^- unknown：.*project 必须留空/m.test(SCOPE_HELP));
		check("F7 md 词表含三档标记（'scope 三选一' 标题行在位，防只同步了条目没同步标题）", md.includes("scope 三选一（配合 project 字段一起填）"));
	}

	// 清理必须留在 main 内：`void main()` 在此处只是启动 promise，函数体外同步执行的
	// 清理会把还没用完的临时 profile 删掉（首行 await 就让出控制权）。
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// 清理失败不影响结论
		}
	}
	console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
	process.exit(fail > 0 ? 1 : 0);
}

void main();
