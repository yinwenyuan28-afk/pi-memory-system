/**
 * verify-project-scope-backfill.mts — 用人工标注尺子评测 `metadata.project` / `metadata.scope` 回填结果
 *
 *   用法（`.mts` + tsx；仓库是 `type: commonjs`，跑脚本要用 tsx）：
 *     tsx scripts/verify-project-scope-backfill.mts                    # 从记录现状评测（--apply 之后的真值口径）
 *     tsx scripts/verify-project-scope-backfill.mts --cache <path>     # 从回填器的裁决缓存评测（dry-run 结果）
 *     tsx scripts/verify-project-scope-backfill.mts --profile <path>   # 换 profile
 *     tsx scripts/verify-project-scope-backfill.mts --ruler <path>     # 换尺子
 *     tsx scripts/verify-project-scope-backfill.mts --limit 20         # 只比对尺子前 20 条
 *
 * ── 这个脚本为什么必须存在 ──
 *
 * 没有尺子的时候改了好几轮参数，其中**至少两轮是负收益**而靠事后翻数据才发现
 * （见 `verify-judg-project-accuracy.mts` 的文件头）。本轮候选怎么排、提示词怎么写、
 * `knownProjects` 加不加扩展自身目录 —— 每一项都是"改完看不出好坏"的改动。所以评测是硬门槛。
 *
 * ── 脚体内置的三条防线（前一轮踩出来的）──
 *
 * ① **逐条比对 `id`，不许靠数组下标对齐**。抽样顺序会变（分片按日期、记录按行），
 *    一旦口径动了，下标对齐会**静默错位** —— 数字看着仍然合理，结论全反。
 *    比对一律通过 `id → 答案` 的 Map；尺子里出现结果里没有的 id 直接报出来（不静默跳过）。
 *
 * ② **禁止把带 `/g` 标志的正则喂给 `.test()`**。`lastIndex` 会跨调用保留，同一个正则对同一个
 *    字符串时对时错，**不报错**。历史事故：它让一度报出的「候选池召回 86%」是错的，真值 93%。
 *    本文件所有布尔判定的正则都写成**无 `g`** 的字面量或源串，不带 `g`。
 *
 * ③ **尺子文件可能被另一个进程正在写**（本轮尺子是并行子代理产出的）。`JSON.parse` 失败时
 *    **等几秒重试，最多 3 次**；三次都失败才退出并说清原因 —— 而不是拿半截文件算出一个
 *    看起来很合理但完全错误的准确率。
 *
 * ── 两个数据源 ──
 *
 *   - **默认（读记录）**：`{profile}/memoryDB/l1/records/*.jsonl` 里每条存活记录的
 *     `metadata.project` / `metadata.scope`。这是 `--apply` 之后的真值口径。
 *   - **`--cache <path>`**：读回填器的裁决缓存。缓存里除了 `entries`（裁决键 → 裁决）还有
 *     `idIndex`（记录 id → 裁决键），所以本模式是**两次查表**，**不复刻任何判定逻辑** ——
 *     回填器改了候选算法或提示词，评测器不需要跟着改。
 *     用途是 **`--apply` 之前**就能看到评测结果（本轮 memoryDB 只读，评测必须走这条路）。
 *
 * ── 三态 project 的处理（尺子的 `project` 字段有三种含义）──
 *
 *   - 非空字符串 ⇒ 该条应有 project。
 *   - `""` ⇒ 该条判成 global，所以**没有** project。
 *   - `null` ⇒ **连人读原文都定不了**。这类不计入 project 准确率的分母（单独计为"尺子未定"），
 *     但仍计入 scope 准确率与覆盖率 —— scope 在这种情况下仍然是可判的。
 *
 * ── 边界 ──
 *
 *   **只读**：本脚本不写任何仓库文件、不写 memoryDB、不调模型，只打印报告。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MEMORY_DB_DIR, L1_RECORDS_DIR } from "../memory/paths.ts";
import { normalizeScope, projectForScope, SCOPE_VALUES, type ScopeValue } from "../memory/l1/project-scope.ts";
import { projectKey } from "../util/judg-session-project/index.ts";

// ══════════════════════════════════════════════════════════════
//  参数与常量
// ══════════════════════════════════════════════════════════════

const argv = process.argv.slice(2);
/**
 * 取 `--name <value>` 形式的参数值。
 *
 * @param name 参数名（如 `--limit`）
 * @param dflt 缺省值
 * @returns 紧随参数名的值；参数不存在或后面没跟值时返回 `dflt`
 */
const argOf = (name: string, dflt: string): string => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const AGENT_HOME = process.env.PI_AGENT_HOME ?? join(homedir(), ".pi", "agent");
const PROFILE = argOf("--profile", process.env.PI_PROFILE_PATH ?? join(AGENT_HOME, "profiles", "default"));
/** 裁决缓存路径（给了就走"读缓存"模式，不给就读记录）。 */
const CACHE_FILE = argOf("--cache", "");
/** 只比对尺子前 N 条；0 = 全部。 */
const LIMIT = Math.max(0, Number(argOf("--limit", "0")) || 0);
/** 尺子文件路径。 */
const RULER = argOf("--ruler", join(import.meta.dirname, "fixtures", "l1-project-scope", "ruler.json"));
/** L1 记录分片目录。 */
const RECORDS_DIR = join(PROFILE, MEMORY_DB_DIR, L1_RECORDS_DIR);

/** 尺子重试次数（防线 ③：尺子可能正被另一个进程写）。 */
const RULER_READ_RETRIES = 3;
/** 两次重试之间的等待（毫秒）。 */
const RULER_RETRY_DELAY_MS = 3000;

/** 各层的含义（抄自尺子的 note —— 抽样设计是尺子自己的口径，不在代码里另立一套）。 */
const LAYER_DESC: Record<number, string> = {
	1: "有 scene_id（场景前缀可判）",
	2: "无 scene_id，靠 scene_name/正文文本",
	3: "work_method / 通用做法（预期多 global）",
	4: "脏 scope + 家目录 cwd（表层信号带偏区）",
};

// ══════════════════════════════════════════════════════════════
//  数据形状
// ══════════════════════════════════════════════════════════════

/** 尺子的一条标注。 */
interface RulerItem {
	/** 记录 id —— **唯一的对齐键**（防线 ①）。 */
	id: string;
	/** 抽样层（1~4）。 */
	layer: number;
	/** 真值是从哪条判定路径解出来的（尺子的自述，评测按它分组看误差）。 */
	derivedBy?: string;
	/** 项目路径三态：字符串=有项目；`""`=判成 global 所以没有；`null`=连人都定不了。 */
	project: string | null;
	/** 三值 scope（`self` / `global` / `unknown`）。 */
	scope: string;
	/** 真值存在与答案竞争的表层信号（尺子 v2 新增）。 */
	flagSuspect?: boolean;
	/** 标注理由（人读，脚本不解析）。 */
	reason?: string;
}

/** 尺子整份文件。 */
interface RulerFile {
	version?: number;
	note?: string;
	unclearCount?: number;
	items: RulerItem[];
}

/** 回填结果里的一条（已过契约模块归一化）。 */
interface Judgement {
	/** 三值 scope；`null` = 这条没有合法 scope 标签（未回填 / 旧值是脏数据）。 */
	scope: ScopeValue | null;
	/** 归一化后的 project（`scope` 为 `global` 或 `unknown` 时必为 `""`）。 */
	project: string;
	/** 数据来源（`records` / `cache`），报告里标明。 */
	from: string;
}

/** 一条的比对结果。 */
interface Row {
	/** 对应的尺子条目。 */
	item: RulerItem;
	/** 回填给出的 scope（`null` = 没有合法标签）。 */
	gotScope: ScopeValue | null;
	/** 回填给出的 project（已过 `projectForScope`）。 */
	gotProject: string;
	/** scope 是否相等。 */
	scopeOk: boolean;
	/** project 是否相等；`null` = 尺子未定，不进分母。 */
	projectOk: boolean | null;
	/** 回填是否给出了合法 scope（= 这一条是否被写入了）。 */
	answered: boolean;
}

// ══════════════════════════════════════════════════════════════
//  尺子读取（防线 ③）
// ══════════════════════════════════════════════════════════════

/**
 * 同步忙等（尺子重试时用；重试最多 3 次、总计约 9 秒，可以接受）。
 *
 * @param ms 等待毫秒数
 * 设计意图：读尺子的函数是同步的（`readFileSync` 出来的文本立刻要 parse），而这个脚本的
 * 顶层有 await、在 async 上下文里。用 `setTimeout` 会把 `readRulerWithRetry` 变成 async 并
 * 让整条读取链跟着异步化，收益只有几毫秒的等待，不值得。
 */
function sleepSync(ms: number): void {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		/* 忙等 */
	}
}

/**
 * 读尺子文件，`JSON.parse` 失败时重试（防线 ③）。
 *
 * @param file 尺子路径
 * @returns 尺子内容；三次都解析失败返回 `null`（调用方据此退出）
 * 设计意图：尺子由并行子代理产出，读到半截文件时 `JSON.parse` 会抛。拿半截内容算准确率
 * = 报一个**看起来很合理但完全错误**的数字。这里选择「等 + 重试」而不是「跳过继续」——
 * 三次还读不出来说明真出问题了，那就该带着原因退出，而不是给出一个假的 0%。
 */
function readRulerWithRetry(file: string): RulerFile | null {
	if (!existsSync(file)) {
		process.stderr.write(`✗ 尺子文件不存在：${file}\n`);
		return null;
	}
	let lastErr = "";
	for (let attempt = 1; attempt <= RULER_READ_RETRIES; attempt++) {
		try {
			const o = JSON.parse(readFileSync(file, "utf-8")) as RulerFile;
			if (o && Array.isArray(o.items) && o.items.length > 0) return o;
			lastErr = "items 为空或不是数组";
		} catch (e) {
			lastErr = (e as Error).message;
		}
		if (attempt < RULER_READ_RETRIES) {
			process.stderr.write(`  尺子读取失败（第 ${attempt}/${RULER_READ_RETRIES} 次：${lastErr}），${RULER_RETRY_DELAY_MS / 1000}s 后重试…\n`);
			sleepSync(RULER_RETRY_DELAY_MS);
		}
	}
	process.stderr.write(`✗ 尺子读取失败（重试 ${RULER_READ_RETRIES} 次）：${lastErr}\n  ${file}\n`);
	return null;
}

// ══════════════════════════════════════════════════════════════
//  回填结果读取（两个数据源）
// ══════════════════════════════════════════════════════════════

/**
 * 数据源一：从分片里读**记录现状**的标签（`--apply` 之后的真值口径）。
 *
 * @returns 记录 id → 裁决；外加分片扫描数与坏行数
 * 设计意图：
 *   - 只读存活记录（`deleted === true` 是墓碑行，不参与比对）。
 *   - 坏行只计数不中断：分片里出现半行/非法行是常态，为了 1 条坏行丢掉整批评测是不可接受的。
 *   - 归一化**一律走契约模块**（`normalizeScope` + `projectForScope`）。这一步顺带把
 *     「旧 `metadata.scope` 是脏值（`workflow` / `A104525` / `module`）」的记录判成
 *     `scope = null` —— 它们本来就不该被当合法标签，计入分母只会污染基线。
 */
function readJudgementsFromRecords(): { map: Map<string, Judgement>; badLines: number; scanned: number } {
	const map = new Map<string, Judgement>();
	let badLines = 0;
	let scanned = 0;
	if (!existsSync(RECORDS_DIR)) return { map, badLines, scanned };
	const files = readdirSync(RECORDS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
	for (const f of files) {
		for (const line of readFileSync(join(RECORDS_DIR, f), "utf-8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			let o: unknown;
			try {
				o = JSON.parse(line);
			} catch {
				badLines++;
				continue;
			}
			if (!o || typeof o !== "object" || Array.isArray(o)) {
				badLines++;
				continue;
			}
			const rec = o as Record<string, unknown>;
			if (rec.deleted === true) continue;
			scanned++;
			const id = typeof rec.id === "string" ? rec.id : "";
			if (!id) continue;
			const meta = rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata) ? (rec.metadata as Record<string, unknown>) : {};
			const scope = normalizeScope(meta.scope);
			const project = scope ? projectForScope(scope, typeof meta.project === "string" ? meta.project : "") : "";
			map.set(id, { scope, project, from: "records" });
		}
	}
	return { map, badLines, scanned };
}

/**
 * 数据源二：从回填器的**裁决缓存**读结果（`--cache` 模式，用于 `--apply` 之前评测）。
 *
 * ⚠ 缓存的 `entries` 是按 `sha1(模型 + 提示词版本 + 该条全部输入 + 已知根清单)` 建的索引，
 * **不可逆、也不能按 id 反查**。回填器为此额外落了一份 `idIndex`（记录 id → 裁决键），
 * 本函数只做两次查表 —— **不复刻候选算法、不重算键**。
 * 这一点是刻意的：一旦评测器自己复刻一份键计算，回填器改一行候选逻辑就会让命中率
 * 悄悄掉到 0，然后报出"准确率 0%"，而根因（键对不上）在报告里完全不可见。
 *
 * @param cacheFile 缓存文件路径
 * @returns 记录 id → 裁决（缓存里没有的 id 不会出现在结果里，由调用方报成"尺子有但结果无"）
 */
function readJudgementsFromCache(cacheFile: string): Map<string, Judgement> {
	const out = new Map<string, Judgement>();
	if (!existsSync(cacheFile)) {
		process.stderr.write(`✗ 缓存文件不存在：${cacheFile}\n`);
		return out;
	}
	let cache: {
		entries?: Record<string, { scope?: string; project?: string; reason?: string }>;
		idIndex?: Record<string, string>;
	};
	try {
		cache = JSON.parse(readFileSync(cacheFile, "utf-8")) as typeof cache;
	} catch (e) {
		process.stderr.write(`✗ 缓存解析失败：${(e as Error).message}\n`);
		return out;
	}
	const entries = cache.entries ?? {};
	const idIndex = cache.idIndex;
	if (!idIndex || typeof idIndex !== "object") {
		process.stderr.write(`✗ 缓存缺 idIndex（该缓存由旧版回填器产生，没有 id→键 的映射）。\n  请用回填器重跑一次以重建索引（命中已有 entries 时不会产生新的模型调用）。\n  ${cacheFile}\n`);
		return out;
	}
	for (const [id, key] of Object.entries(idIndex)) {
		const hit = entries[key];
		if (!hit) continue; // 键在但裁决没落（那一批模型失败）⇒ 评测算它"未覆盖"
		const scope = normalizeScope(hit.scope);
		if (!scope) continue;
		out.set(id, { scope, project: projectForScope(scope, hit.project ?? ""), from: "cache" });
	}
	return out;
}

// ══════════════════════════════════════════════════════════════
//  比对
// ══════════════════════════════════════════════════════════════

/**
 * 逐条比对尺子与回填结果（防线 ①：**只通过 id 对齐**）。
 *
 * @param rulerItems 尺子条目
 * @param answers    记录 id → 裁决
 * @returns 每条的比对结果，顺序与尺子一致
 * 设计意图：`answers` 是 Map，取值一律 `answers.get(item.id)`，任何地方都不出现下标算术。
 * 尺子里出现结果里没有的 id 时 `gotScope` 为 null、`answered` 为 false，由调用方在报告里
 * 显式列出 —— 静默跳过会让覆盖率虚高。
 */
function compare(rulerItems: RulerItem[], answers: Map<string, Judgement>): Row[] {
	const rows: Row[] = [];
	for (const item of rulerItems) {
		const got = answers.get(item.id);
		const gotScope = got?.scope ?? null;
		const gotProject = got?.project ?? "";
		const truthScope = normalizeScope(item.scope);
		rows.push({
			item,
			gotScope,
			gotProject,
			scopeOk: gotScope !== null && truthScope !== null && gotScope === truthScope,
			// ⚠ 尺子真值 scope 缺失/非法时**不能默认按 "self" 算**——那等于替尺子猜了个答案，
			//   会让 project 分母凭空多出几条。判 null = 不进分母，与 scopeOk 同一口径。
			projectOk:
				item.project === null || truthScope === null
					? null
					: gotScope !== null && projectKey(gotProject) === projectKey(projectForScope(truthScope, item.project)),
			answered: gotScope !== null,
		});
	}
	return rows;
}

/**
 * 打印 scope 混淆矩阵（行 = 尺子真值，列 = 回填结果，多出 "(未写)" 一列）。
 *
 * @param rows 比对结果
 * 设计意图：把"未写"做成**一列**而不是从分母里剔掉 —— fail-open 的量必须显式可见，
 * 否则一个只回填了 60% 的方案在准确率上和一个 100% 的方案长得一样。
 */
function printScopeMatrix(rows: Row[]): void {
	const cols = [...SCOPE_VALUES, "(未写)"];
	const counts = new Map<string, number>();
	for (const r of rows) {
		const t = normalizeScope(r.item.scope) ?? "(尺子非法)";
		const p = r.gotScope ?? "(未写)";
		counts.set(`${t}|${p}`, (counts.get(`${t}|${p}`) ?? 0) + 1);
	}
	const w = Math.max(14, ...cols.map((c) => c.length + 2), "(尺子非法)".length + 2);
	console.log("\n【scope 混淆矩阵】行 = 尺子真值，列 = 回填结果");
	console.log(`  ${"真值 \\ 结果".padEnd(w)}${cols.map((c) => c.padEnd(w)).join("")}`);
	for (const t of [...SCOPE_VALUES, "(尺子非法)"]) {
		console.log(`  ${t.padEnd(w)}${cols.map((p) => String(counts.get(`${t}|${p}`) ?? 0).padEnd(w)).join("")}`);
	}
}

/**
 * 打印 project 的错分明细（只列判错 / 未写出的；正确的条不列，避免刷屏）。
 *
 * @param rows 比对结果
 * 设计意图：列宽按**内容**算而不是写死 —— 项目路径最长 44 字符（memory-system 那条），
 * 固定宽度会把行挤乱、反而看不清错在哪。
 */
function printProjectDetail(rows: Row[]): void {
	console.log("\n【project 逐条明细】（只列判错 / 未写出的；正确的条不列，避免刷屏）");
	const wrong = rows.filter((r) => r.projectOk === false);
	if (wrong.length === 0) {
		console.log("  （全部正确）");
		return;
	}
	const cells = wrong.map((r) => ({
		id: r.item.id,
		layer: String(r.item.layer),
		truth: r.item.project === null ? "(尺子未定)" : r.item.project === "" ? "(空=global)" : r.item.project,
		got: !r.answered ? "(未写/fail-open)" : r.gotProject === "" ? "(空=global)" : r.gotProject,
		scopeTruth: r.item.scope,
		scopeGot: r.gotScope ?? "-",
		flag: r.item.flagSuspect ? "可疑" : "",
	}));
	const w = (a: string[], min: number): number => Math.max(min, ...a.map((x) => x.length));
	const wId = w(cells.map((c) => c.id), 24);
	const wTruth = w(cells.map((c) => c.truth), 12);
	const wGot = w(cells.map((c) => c.got), 12);
	console.log(`  ${"id".padEnd(wId)}${"层".padEnd(5)}${"真值".padEnd(wTruth)}${"回填".padEnd(wGot)}${"scope真".padEnd(10)}${"scope得".padEnd(10)}标记`);
	for (const c of cells) {
		console.log(`  ${c.id.padEnd(wId)}${c.layer.padEnd(5)}${c.truth.padEnd(wTruth)}${c.got.padEnd(wGot)}${c.scopeTruth.padEnd(10)}${c.scopeGot.padEnd(10)}${c.flag}`);
	}
}

/**
 * 打印一个分组的 project / scope / 覆盖率三元组。
 *
 * @param rows 该分组的比对结果
 * @returns `[project 对/分母, scope 对/分母, 覆盖/总数]`
 */
function triple(rows: Row[]): [string, string, string] {
	const pr = rows.filter((r) => r.item.project !== null);
	const pc = pr.filter((r) => r.projectOk === true).length;
	const sc = rows.filter((r) => r.scopeOk).length;
	const cov = rows.filter((r) => r.answered).length;
	return [`${pc}/${pr.length}`, `${sc}/${rows.length}`, `${cov}/${rows.length}`];
}

// ══════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
	// ── 尺子（防线 ③：可能被另一个进程正在写）──
	const ruler = readRulerWithRetry(RULER);
	if (!ruler) process.exit(1);
	const items = LIMIT > 0 ? ruler.items.slice(0, LIMIT) : ruler.items;

	// ── 取回填结果（两个数据源之一）──
	let answers: Map<string, Judgement>;
	let badLines = 0;
	let scanned = 0;
	let source: string;
	if (CACHE_FILE) {
		source = `裁决缓存 ${CACHE_FILE}`;
		answers = readJudgementsFromCache(CACHE_FILE);
	} else {
		source = `记录现状 ${RECORDS_DIR}`;
		const r = readJudgementsFromRecords();
		answers = r.map;
		badLines = r.badLines;
		scanned = r.scanned;
	}

	// ── 防线 ①：逐条按 id 比对（不是下标对齐）──
	const rows = compare(items, answers);
	const missing = items.filter((i) => !answers.has(i.id));

	console.log("=".repeat(72));
	console.log("L1 project/scope 回填评测");
	console.log("=".repeat(72));
	console.log(`profile : ${PROFILE}`);
	console.log(`数据源  : ${source}${CACHE_FILE ? "" : `（分片扫描 ${scanned} 条，坏行 ${badLines}）`}`);
	console.log(`尺子    : ${RULER}  version=${ruler.version ?? "?"}  条目 ${items.length}  unclearCount=${ruler.unclearCount ?? "?"}`);
	if (missing.length > 0) {
		console.log(`⚠ 尺子有 ${missing.length} 条在回填结果里找不到（fail-open 未写入 / 未判定）：`);
		for (const m of missing.slice(0, 8)) console.log(`    ${m.id}  layer${m.layer}`);
		if (missing.length > 8) console.log(`    … 还有 ${missing.length - 8} 条`);
	}

	// ── 覆盖率 ──
	const answered = rows.filter((r) => r.answered).length;
	console.log(`\n【覆盖率】  ${answered}/${rows.length} = ${rows.length ? ((answered / rows.length) * 100).toFixed(1) : "—"}%（回填给出了合法 scope 的条数）`);

	// ── project 准确率（真值为 null 的不进分母）──
	const projRows = rows.filter((r) => r.item.project !== null);
	const projCorrect = projRows.filter((r) => r.projectOk === true).length;
	const projUndecided = rows.length - projRows.length;
	console.log(`【project 准确率】${projCorrect}/${projRows.length} = ${projRows.length ? ((projCorrect / projRows.length) * 100).toFixed(1) : "—"}%（真值为 null 的 ${projUndecided} 条不进分母）`);

	// ── scope 准确率（尺子 scope 必须是合法取值才进分母）──
	const scopeRows = rows.filter((r) => normalizeScope(r.item.scope) !== null);
	const scopeCorrect = scopeRows.filter((r) => r.scopeOk).length;
	const scopeIllegal = rows.length - scopeRows.length;
	console.log(`【scope 准确率】  ${scopeCorrect}/${scopeRows.length} = ${scopeRows.length ? ((scopeCorrect / scopeRows.length) * 100).toFixed(1) : "—"}%（尺子里非法 scope 的 ${scopeIllegal} 条不进分母）`);

	printScopeMatrix(rows);
	printProjectDetail(rows);

	// ── 分层误差 ──
	const layers = [...new Set(items.map((i) => i.layer))].sort((a, b) => a - b);
	console.log("\n【分层误差】（按 ruler.layer 分组）");
	console.log(`  ${"层".padEnd(6)}${"条数".padEnd(8)}${"project".padEnd(16)}${"scope".padEnd(14)}${"覆盖率".padEnd(12)}说明`);
	for (const L of layers) {
		const rs = rows.filter((r) => r.item.layer === L);
		const [p, s, c] = triple(rs);
		console.log(`  ${String(L).padEnd(6)}${String(rs.length).padEnd(8)}${p.padEnd(16)}${s.padEnd(14)}${c.padEnd(12)}${LAYER_DESC[L] ?? ""}`);
	}

	// ── flagSuspect 子集（尺子 v2 新增：表层信号与答案竞争，预期最容易错）──
	const suspect = rows.filter((r) => r.item.flagSuspect === true);
	if (suspect.length > 0) {
		const [p, s] = triple(suspect);
		console.log(`\n【flagSuspect 子集】（表层信号 scene/cwd/旧 scope 与答案竞争，模型裁决的承重区）`);
		console.log(`  条数 ${suspect.length}   project ${p}   scope ${s}`);
	}
	const clean = rows.filter((r) => r.item.flagSuspect !== true);
	if (clean.length > 0) {
		const [p, s] = triple(clean);
		console.log(`【非可疑子集】（三方一致，理论上应当接近全对）`);
		console.log(`  条数 ${clean.length}   project ${p}   scope ${s}`);
	}

	// ── derivedBy 分组（真值是从哪条判定路径解出来的）──
	const byDerived = new Map<string, Row[]>();
	for (const r of rows) {
		const k = r.item.derivedBy ?? "(尺子未记)";
		byDerived.set(k, [...(byDerived.get(k) ?? []), r]);
	}
	console.log(`\n【按 derivedBy 分组】（真值是从哪条判定路径解出来的）`);
	for (const [k, rs] of [...byDerived.entries()].sort((a, b) => b[1].length - a[1].length)) {
		const [p, s] = triple(rs);
		console.log(`  ${k.padEnd(20)} n=${String(rs.length).padEnd(5)} project ${p.padEnd(8)} scope ${s}`);
	}

	console.log(`\n口径说明：`);
	console.log(`  · project 按 projectKey（小写 + 正斜杠 + 去尾分隔符）**严格相等**判，不做祖先/后代宽容。`);
	console.log(`  · 「真值为 null」= 尺子标注者自己也定不了 ⇒ 不进 project 分母，但仍进 scope 分母与覆盖率。`);
	console.log(`  · 「未写」= 回填 fail-open（模型没给 / 没过合法性闸门）⇒ 计入准确率分母，**不当作弃权放过**。`);
}

await main();
