/**
 * backfill-project-scope.mts — 给存量 L1 原子记忆回填三个标签：
 *   `metadata.project` + `metadata.scope` + `metadata.projectSource`
 *
 *   用法（`.mts` + tsx，仓库是 `type: commonjs`，跑脚本要用 tsx）：
 *     tsx scripts/backfill-project-scope.mts                    # --dry-run 是默认值，只出报告不写盘
 *     tsx scripts/backfill-project-scope.mts --apply            # 真写（含改前快照 + 写锁 + 原子写）
 *     tsx scripts/backfill-project-scope.mts --limit 20         # 只处理前 20 条，调试用
 *     tsx scripts/backfill-project-scope.mts --profile <path>   # 换 profile
 *
 * ── 架构：代码提候选 + 模型裁决（与 `util/judg-session-project` 的 `judgeProject` 同构）──
 *
 *   纯代码提候选（4 路，按可信度排序，**每条候选都带证据来源名**）：
 *     ① `scene_id` → `l1/scenes.json` → 场景名里 `｜`（全角竖线）之前的**前缀**
 *        · 前缀必须过**伪项目校验**：能对上某个已知项目根（路径分段精确匹配 / 根名做前缀）
 *          ⇒ 是项目名，留；否则看该前缀下所有场景的 cwds 落在几个**互不相干**的已知根下：
 *          >1 个 ⇒ 伪项目（「协作规范」实例：6 个场景 cwds 横跨 .pi / xianhua / wangxin /
 *          campus-hub 四个目录，无条件取它会给 17 条记录安一个假项目）⇒ 丢弃；
 *          只有 1 个 ⇒ 降级为"隐含项目"候选，来源名标 `scene_prefix_implied` 并注明前缀不是项目名。
 *     ② `cwd` 落在某个已知根之下 ⇒ 取**最长的那个根**（实测覆盖 98.6%）
 *     ③ `content` 里的绝对路径 → 复用 `candidates.ts` 的 `extractPathsFromText`（路径识别 +
 *        噪声过滤，**不重写第二份**）→ 归到最长的已知根，按命中次数排序
 *     ④ `sessionKey` → `state/judg-session-project.json`，**只有 `flag === true` 的才用**
 *
 *   已知根 = `listKnownProjects()`（用户真的拿它开过会话的目录）过 `isBroadProjectPath`
 *   + `isNotAProjectPath` 之后，**再加本扩展自身的目录**。后者不是硬编码：从脚本自身位置
 *   （`<扩展>/scripts/`）往上两级推出来。`listKnownProjects()` 里没有它（用户从没在那个目录
 *   开过会话），而它是全库第二大项目（尺子 30 条里 10 条的真值），不加就只能退化到
 *   `C:/Users/leaf/.pi`——而 `.pi` 下还有 context-mode-plus / permission-gate 两个同级扩展，
 *   退化等于把三类扩展的记忆混成一类。
 *
 * ── 裁决（模型，一次调用一批）──
 *
 *   给模型：每条的 `id` + 正文前 ~800 字 + 上面算出的候选列表（每个带 `source`）+ 已知根清单。
 *   要它对每条返回 `{"id","scope","project","reason"}`。三条硬约束：
 *     - `scope=global` ⇒ `project` 必须是 `""`（`projectForScope` 强制，模型输出也查）
 *     - `scope=self` ⇒ `project` 不能为空（空即是自相矛盾的组合，算判失败）
 *     - 判不出来就**整条省略**，不猜（fail-open）
 *
 * ── 为什么必须模型裁决（尺子实测）──
 *
 *   `pi-0.80.10` 下 114 条里大半其实是 memory-system 的记忆（扩展装在 `.pi`、会话在 pi 源码仓跑，
 *   `cwd` 会稳定把答案带偏）；同时又有大量正文与场景无关的通用做法被挂在某个项目场景下
 *   （尺子里 13/30 真值是 `global`）。**两个方向都靠纯代码判不准**：正例要从错误 cwd 里救回来，
 *   反例要否掉看起来很齐整的 scene/cwd 证据。这与 `judgeProject` 是同一个问题。
 *
 * ── 三个标签（2026-09-30 补 `projectSource` 的原因）──
 *
 *   运行时（`l1_commit`）写的 `metadata.projectSource` 是**会话判定器的来源**：
 *   `init` / `code` / `llm` / `manual`，判不出时写 `fallback`。存量 554 条没有这个键，于是
 *   "按 projectSource 做统计"会**静默地只统计到新记录**——老的那 554 条被无声排除，而报告
 *   看上去仍然"有数据"。这正是本项目反复踩的坑（历史上"按 cwd 统计"就因为 cwd 的语义断层
 *   得出过错误结论）。所以本回填器必须把第三个键补齐，且**用能认出"这是离线回填"的前缀**，
 *   两个写入方才不会混成一团：`backfill:` 前缀与 `init/code/llm/manual/fallback` 在字符层面
 *   不可能碰撞，也不需要额外的白名单就能靠前缀过滤。
 *
 *   取值构成：`backfill:` + 最终取值来源（唯一真相源见 {@link pickSourceOf}）：
 *     `backfill:scene_id` / `backfill:cwd` / `backfill:content` / `backfill:session` /
 *     `backfill:scene_prefix_implied` —— 最终 project 恰好等于该路候选；
 *     `backfill:relocate(<来源>)` —— 模型把粒度挪了一层（选了候选的祖先/后代）；
 *     `backfill:known_root` —— 最终 project 本身是个已知根，但不是本条的候选；
 *     `backfill:global` —— 判成 global，project 是被契约 `projectForScope` **强制抹空**的。
 *   `backfill:global` 的必要性：光看 `project === ""` 分不清「按 global 契约抹空」与
 *   「判了个项目却写空了」。后者在本回填器里根本不会发生（`coerceVerdict` 对 self+空 project
 *   是判失败、不写），但判别式必须留在数据里，否则统计侧只能靠"猜"。
 *
 *   ⚠ **`projectSource` 不问模型**（`JUDGE_SYSTEM_PROMPT` 里没有这一项），由代码从
 *   「裁决 + 本条候选」**确定性地**推出来。两个理由：模型没有依据凭空说出"我从哪一路来的"
 *   （它只看到候选清单，说出来的多半是复述第一个）；而且它一旦进入裁决输出，就会变成裁决的
 *   一部分而进缓存 —— 同一份输入必须永远渲染出同一串，`{裁决, 候选}` 的纯函数才做得到。
 *
 * ── 边界（越界就是数据损坏）──
 *
 *   - **只写 `metadata.project` / `metadata.scope` / `metadata.projectSource` 这三个键**。
 *     `content` / `cwd` / `scene_id` / `scene_name` / `type` / `priority` / `timestamps` /
 *     `id` / `deleted` 一个字节都不动，**其余 metadata 键原样保留、也不新增任何别的键**。
 *   - **覆盖而非合并**：存量 199 条不受控的旧 `scope`（`agent` / `workflow` / `memory-system` /
 *     `A104525` 这类半自由文本）一律被新值覆盖，不试图保留。
 *   - **旧 `metadata.scope` 绝不进裁决载荷**（尺子明确：「回填器不能拿旧 scope 当项目依据」——
 *     它一半填的是项目名，拿它当证据等于把脏数据洗成合法标签）。
 *   - **fail-open**：模型判不了的条目**不写这三个键**，只计数上报，绝不猜。
 *   - **分片 read-modify-write 一律走 `memory/l1/write-lock.ts` 的跨进程写锁**（10s 超时），
 *     拿不到就跳过该分片并上报，不硬写。
 *   - **幂等**：裁决结果按 `sha1(模型 + 提示词版本 + 该条的全部输入)` 缓存到
 *     `C:/temp/pi/backfill-project-scope/cache.json`，同一份输入跑两次结果完全一致。
 *
 * ── 踩过的坑（全部实测，照抄）──
 *
 *   ① `model.llm` 是**推理模型**，`max_tokens` 太小不会报错、只会静默截断（`stopReason:"length"`、
 *      JSON 不配平）。这里一批 N 条 ⇒ 至少 `2000 + N*400`，默认给 8000。
 *   ② 独立脚本组装的模型对象**必须带 `cost`**，否则 pi-ai 结算时抛
 *      `Cannot read properties of undefined (reading 'tiers')`——流已收完才抛，把文本在最后一个
 *      字符处砍掉，看起来像模型自己停的。见 `resolveJudgeModel()`。
 *   ③ 输出解析：`parseJudgeJson` 同款三步（剥 ``` 围栏 → 括号切片 → 截断 salvage）。批量形状
 *      需要自己写一个 `parseVerdictBatch`（见下），但三步的配方一字不改。
 *   ④ 仓库是 `"type": "commonjs"` ⇒ `.mts` 可以有顶层 await，但 import 仓库里的 `.ts` 文件时
 *      **必须用 `file:///C:/...` 的 URL 形式**（Windows ESM 不接受裸绝对路径，报
 *      `ERR_UNSUPPORTED_ESM_URL_SCHEME`）。本文件在仓库内，用相对路径 import 即可。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MEMORY_DB_DIR, L1_RECORDS_DIR, BACKUP_DIR } from "../memory/paths.ts";
import { isBroadProjectPath, listKnownProjects } from "../memory/l1/config.ts";
import { acquireWriteLock } from "../memory/l1/write-lock.ts";
import { normalizeProjectTag, normalizeScope, projectForScope, SCOPE_HELP, SCOPE_VALUES, type ScopeValue } from "../memory/l1/project-scope.ts";
import { callLLM } from "../util/llm.ts";
import { resolveJudgeModel } from "../util/judg-session-project/llm.ts";
import { isNotAProjectPath, projectKey } from "../util/judg-session-project/index.ts";
import { extractPathsFromText } from "../util/judg-session-project/candidates.ts";

// ══════════════════════════════════════════════════════════════
//  参数与常量
// ══════════════════════════════════════════════════════════════

/** 命令行参数。 */
const argv = process.argv.slice(2);
/**
 * 取 `--name <value>` 形式的参数值。
 * @param name 参数名（如 `--limit`）
 * @param dflt 缺省值
 * @returns 紧随参数名的值；不存在或后面没跟值时返回 `dflt`
 */
const argOf = (name: string, dflt: string): string => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

/** 是否真写盘。**默认 `--dry-run`**（不传 `--apply` 就只出报告）。 */
const APPLY = argv.includes("--apply");
/** 只处理前 N 条；0 = 全部。 */
const LIMIT = Math.max(0, Number(argOf("--limit", "0")) || 0);
/** 每批交给模型的条数。 */
const BATCH_SIZE = Math.max(1, Number(argOf("--batch", "10")) || 10);
/** 单次模型调用失败后的重试次数（0 = 不重试）。 */
const RETRIES = Math.max(0, Number(argOf("--retries", "1")) || 0);

const AGENT_HOME = process.env.PI_AGENT_HOME ?? join(homedir(), ".pi", "agent");
const PROFILE = argOf("--profile", process.env.PI_PROFILE_PATH ?? join(AGENT_HOME, "profiles", "default"));
/** L1 记录分片目录。 */
const RECORDS_DIR = join(PROFILE, MEMORY_DB_DIR, L1_RECORDS_DIR);
/** 裁决缓存（**放 C:\temp，不落 memoryDB** —— memoryDB 在本轮是只读的，且它不是记忆数据）。 */
const CACHE_FILE = argOf("--cache", "C:/temp/pi/backfill-project-scope/cache.json");

/** 场景名前缀与议题之间的分隔符（全角竖线）。 */
const SCENE_SEP = "｜";
/** 正则里要显式写的全角竖线（`RegExp` 构造里直接用字符即可）。 */
const CONTENT_CHARS = 800;
/** 候选列表里 `content` 路最多给几条。 */
const CONTENT_CANDIDATE_LIMIT = 3;
/** 场景前缀与已知根做"根名是前缀词的前缀"匹配时的最小长度（太短容易乱认）。 */
const PREFIX_MATCH_MIN_LEN = 3;

/**
 * 判定输出的 token 上限。**不得调小。**
 *
 * 配置模型是推理模型，token 先花在 reasoning 上。这里一批 `BATCH_SIZE` 条，每条 JSON 约 60 token，
 * 2000 是**下界**（上轮实测单条 120 会得到不配平的 JSON），8000 是「10 条一批 + 推理」的余量。
 */
const JUDGE_MAX_TOKENS = Math.max(2000, 2000 + BATCH_SIZE * 600);
/** 单次模型调用超时（毫秒）。一批比一条慢，60s 不够。 */
const JUDGE_TIMEOUT_MS = 180_000;
/** 提示词版本。**改判据就把它 +1** —— 缓存键含它，改完提示词自动全量重判，不会复用旧结论。 */
const PROMPT_VERSION = 1;
/** 写锁等待上限（与 `write-lock.ts` 的默认值一致）。 */
const LOCK_TIMEOUT_MS = 10_000;

// ══════════════════════════════════════════════════════════════
//  数据形状
// ══════════════════════════════════════════════════════════════

/** 一条候选项目目录及其证据来源。 */
interface Candidate {
	/** 项目路径（正斜杠）。 */
	path: string;
	/** 证据来源名（同时是给模型看的说明词）。 */
	source: string;
	/** 权重，越大越可信；同权重按出现顺序稳定排序。 */
	weight: number;
}

/** 一条待判定的记忆（从分片行里抽出的判定输入）。 */
interface Target {
	/** 所在分片文件名。 */
	shard: string;
	/** 行号（0 起，仅用于报错定位）。 */
	line: number;
	/** 记录 id。 */
	id: string;
	/** 正文。 */
	content: string;
	/** 会话工作目录（可能为空串）。 */
	cwd: string;
	/** 场景 id（可能为空串）。 */
	sceneId: string;
	/** 场景名（可能为空串）。 */
	sceneName: string;
	/** 会话 key（可能为空串）。 */
	sessionKey: string;
	/** 代码算出的候选（已按权重降序）。 */
	candidates: Candidate[];
	/** 缓存键：`sha1(模型 + 提示词版本 + 本条全部输入)`，幂等的支点。 */
	key: string;
}

/** 模型对一条记忆的裁决结果。 */
interface Verdict {
	/** 三值 scope（`self` / `global` / `unknown`）。 */
	scope: ScopeValue;
	/** 归一化后的 project（`global` 时必为 `""`）。 */
	project: string;
	/** 模型给的理由（审计用）。 */
	reason: string;
}

// ══════════════════════════════════════════════════════════════
//  已知项目根
// ══════════════════════════════════════════════════════════════

/**
 * 已知项目根清单（`listKnownProjects()` 过滤后 + 本扩展自身目录）。
 *
 * @returns 正斜杠形态、去重、按长度降序（后面取"最长的根"时直接取第一个命中）的根列表。
 * 设计意图：
 *   - `isBroadProjectPath` 剔掉 `C:/` / `C:/temp` / `C:/Users/leaf` 这类**包住一切**的容器
 *     （不滤的话任何正文都会命中"盘根"，候选退化成恒等于 `C:/`）。
 *   - `isNotAProjectPath` 剔掉按用户裁定"不可能是项目"的路径（家目录及其非点开头子目录）。
 *   - 加本扩展自身目录：见文件头「已知根 = …再加本扩展自身的目录」那段实测理由。
 */
function buildKnownRoots(): string[] {
	const roots = new Map<string, string>();
	for (const p of listKnownProjects()) {
		const n = normalizeProjectTag(p);
		if (!n || isBroadProjectPath(n) || isNotAProjectPath(n)) continue;
		roots.set(projectKey(n), n);
	}
	// 扩展自身目录：脚本在 `<扩展>/scripts/` 下，往上一级就是扩展根。
	// 从脚本自身位置推导而不是写死路径，换个 checkout 位置也不会失效。
	const selfRoot = normalizeProjectTag(join(import.meta.dirname, ".."));
	if (selfRoot && !isBroadProjectPath(selfRoot) && !isNotAProjectPath(selfRoot)) {
		roots.set(projectKey(selfRoot), selfRoot);
	}
	return [...roots.values()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/** 全局已知根（进程内算一次）。 */
const KNOWN_ROOTS = buildKnownRoots();

/**
 * 取包住 `p` 的**最长**已知根。
 *
 * @param p 归一化后的绝对路径
 * @returns 已知根；不在任何根之下（含相等）时返回 `null`
 * 设计意图：同一个项目会以多个粒度出现在根清单里（`C:/dev/code_java/wangxin` 与
 * `…/backend/A104527`），文件落在 A104527 里就该归 A104527，否则仓库级根会把子项目的证据都吸走。
 * 比较用 `projectKey`（小写 + 正斜杠 + 去尾分隔符），所以斜杠风格与大小写不影响结果。
 */
function longestRootOf(p: string): string | null {
	const key = projectKey(p);
	if (!key) return null;
	for (const root of KNOWN_ROOTS) {
		const rk = projectKey(root);
		if (key === rk || key.startsWith(`${rk}/`)) return root;
	}
	return null;
}

/**
 * 场景名前缀能不能对上某个已知项目根。
 *
 * @param prefix 场景名 `｜` 之前的部分
 * @returns 命中的已知根；三种匹配都失败时返回 `null`（⇒ 前缀不是项目名）
 *   ① **分段精确匹配**（去空格/连字符后与根的任一分段相等）——覆盖 `xianhua`、
 *      `campus-hub`、`memory-system`、`pi-agent`。
 *   ② **根名做前缀词的前缀**（`wangxin` 是 `wangxin多仓` 的前缀）——覆盖 `wangxin 多仓` 这类
 *      带修饰词的前缀。
 *   ③ 都不中 ⇒ null。注意 `协作规范` 会落到这里：它不对应任何目录，正是要识别出来的伪项目。
 *
 * ⚠ **同类命中取最短（最外层）的那个根，不是最长的**。2026-09-30 实测踩到：
 *   `xianhua` 这个前缀同时命中 `C:/dev/code/xianhua` 与 `C:/dev/code/xianhua/plan/xianhua`
 *   （后者也在 `listKnownProjects()` 里，因为用户在那个目录开过会话），
 *   按"最具体优先"取到的是 **`plan/xianhua` —— 一个计划文档子目录，不是项目**，
 *   于是 173 条 xianhua 记忆会集体挂到一个文档目录上。
 *   语义上也该取最外层：前缀命名的是**项目**，项目根是那个名字所在的**最外层**目录；
 *   同一名字再往下的子目录（`plan/xianhua`、`src/xianhua`）是项目内部的分区。
 *   （注意这与 {@link longestRootOf} 的取法**故意相反** —— 那里的问题问的是
 *   「这个文件属于哪个项目」，粒度越细越准；这里问的是「这个名字是哪个项目的名字」。）
 */
function resolvePrefixToRoot(prefix: string): string | null {
	const word = prefix.replace(/[\s_\-]+/g, "").toLowerCase();
	if (!word) return null;
	const segMatch = KNOWN_ROOTS.filter((root) => root.split("/").some((seg) => seg.replace(/[\s_\-]+/g, "").toLowerCase() === word));
	if (segMatch.length > 0) return segMatch[segMatch.length - 1]; // KNOWN_ROOTS 按长度降序 ⇒ 末位最短
	const nameMatch = KNOWN_ROOTS.filter((root) => {
		const seg = root.slice(root.lastIndexOf("/") + 1).replace(/[\s_\-]+/g, "").toLowerCase();
		return seg.length >= PREFIX_MATCH_MIN_LEN && (word.startsWith(seg) || seg.startsWith(word));
	});
	if (nameMatch.length > 0) return nameMatch[nameMatch.length - 1];
	return null;
}

// ══════════════════════════════════════════════════════════════
//  场景前缀索引（含伪项目校验）
// ══════════════════════════════════════════════════════════════

/** 一个场景名前缀的统计结果。 */
interface PrefixStat {
	/** 前缀原文。 */
	prefix: string;
	/** 该前缀下的场景数。 */
	sceneCount: number;
	/** 该前缀下所有场景的 cwd 归到**已知根**后的去重集合（空串表示落在已知根之外）。 */
	roots: Set<string>;
	/** 该前缀是不是伪项目（cwds 横跨多个互不相干的已知根，且前缀本身不对应任何目录）。 */
	pseudo: boolean;
	/** 前缀能直接对上的已知根（对不上为 null）。 */
	resolvedRoot: string | null;
}

/**
 * 读 `l1/scenes.json` 并按前缀聚合，产出伪项目校验所需的统计。
 *
 * @param profilePath profile 根目录
 * @returns 前缀 → 统计。文件缺失/解析失败时返回空 Map（调用方全部落到"无场景候选"，
 *          **不猜**）。`mergedInto` 非空的场景条目仍参与统计 —— 记录里的 `scene_id` 指向的是
 *          合并前的 id，而 `scenes.json` 里那条依然带着原始 cwds。
 */
function buildPrefixStats(profilePath: string): Map<string, PrefixStat> {
	const out = new Map<string, PrefixStat>();
	const file = join(profilePath, MEMORY_DB_DIR, "l1", "scenes.json");
	if (!existsSync(file)) return out;
	let scenes: { id?: string; name?: string; cwds?: string[] }[];
	try {
		const o = JSON.parse(readFileSync(file, "utf-8")) as { scenes?: typeof scenes };
		scenes = Array.isArray(o.scenes) ? o.scenes : [];
	} catch {
		return out; // 读不了就不给候选，绝不用默认值覆盖
	}
	for (const s of scenes) {
		const name = typeof s.name === "string" ? s.name : "";
		const i = name.indexOf(SCENE_SEP);
		if (i <= 0) continue;
		const prefix = name.slice(0, i).trim();
		if (!prefix) continue;
		let st = out.get(prefix);
		if (!st) {
			st = { prefix, sceneCount: 0, roots: new Set<string>(), pseudo: false, resolvedRoot: null };
			out.set(prefix, st);
		}
		st.sceneCount++;
		for (const cwd of s.cwds ?? []) {
			const n = normalizeProjectTag(cwd);
			if (!n) continue;
			st.roots.add(longestRootOf(n) ?? "");
		}
	}
	for (const st of out.values()) {
		st.resolvedRoot = resolvePrefixToRoot(st.prefix);
		// 伪项目判定：前缀对不上任何目录 **且** 其场景的 cwd 横跨多个互不相干的已知根。
		// 两个条件缺一不可 —— `memory-system` 的 12 个场景里有 2 个被分到了 xianhua 目录，
		// 单看"cwds 不唯一"会把它误杀成伪项目（那是全库第二大项目）。
		st.pseudo = st.resolvedRoot === null && [...st.roots].filter(Boolean).length > 1;
	}
	return out;
}

// ══════════════════════════════════════════════════════════════
//  候选提取（纯代码）
// ══════════════════════════════════════════════════════════════

/**
 * 从记录里抽 `scene_id` / `sessionKey` 对应的外部信息。
 *
 * @param profilePath profile 根目录
 * @returns 场景 id → 场景条目；会话 key → 项目路径（**只含 `flag === true` 的**）
 */
function loadSceneAndSessionIndex(profilePath: string): { scenes: Map<string, { name: string }>; sessions: Map<string, string> } {
	const scenes = new Map<string, { name: string }>();
	const sfile = join(profilePath, MEMORY_DB_DIR, "l1", "scenes.json");
	if (existsSync(sfile)) {
		try {
			const o = JSON.parse(readFileSync(sfile, "utf-8")) as { scenes?: { id?: string; name?: string }[] };
			for (const s of o.scenes ?? []) if (typeof s.id === "string") scenes.set(s.id, { name: String(s.name ?? "") });
		} catch {
			// 读不了就当没有场景索引（候选少一条路，不影响其它三路）
		}
	}
	const sessions = new Map<string, string>();
	const jfile = join(profilePath, MEMORY_DB_DIR, "state", "judg-session-project.json");
	if (existsSync(jfile)) {
		try {
			const o = JSON.parse(readFileSync(jfile, "utf-8")) as { sessions?: Record<string, { project?: unknown; flag?: unknown }> };
			for (const [k, v] of Object.entries(o.sessions ?? {})) {
				// ⚠ 只有 flag===true 的才用：flag:false 的 project 是"建条目时的启动目录占位值"，
				//   拿它当证据等于把会话工作台当项目。
				if (v?.flag !== true) continue;
				const p = normalizeProjectTag(v.project);
				if (p) sessions.set(k, p);
			}
		} catch {
			// 同上：读不了就不给这条候选
		}
	}
	return { scenes, sessions };
}

/**
 * 给一条记录算候选（4 路，按可信度排序）。
 *
 * @param r            记录对象
 * @param prefixStats  场景前缀统计（伪项目校验）
 * @param sessionIdx   会话 key → 项目（只含 flag=true）
 * @returns 候选列表（已去重、按权重降序；`source` 即证据来源名）
 * 设计意图：代码擅长**枚举**、不擅长**裁决** —— 这里只负责把"可能的项目"连同"凭什么"摆出来，
 * 选哪个 / 判不判 global 交给模型。四路的可信度递减：场景前缀（有人工/模型建场时的归属判断）
 * > cwd（会话工作台，实测会稳定带偏但覆盖最广）> 正文绝对路径 > 会话判定（flag 才有）。
 */
function candidatesFor(
	r: Record<string, unknown>,
	prefixStats: Map<string, PrefixStat>,
	scenes: Map<string, { name: string }>,
	sessionIdx: Map<string, string>,
): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Set<string>();
	const push = (path: string, source: string, weight: number): void => {
		if (!path) return;
		const k = projectKey(path);
		if (seen.has(k)) return;
		seen.add(k);
		out.push({ path, source, weight });
	};

	// ① scene_id → 场景名前缀（过伪项目校验）
	const sceneId = typeof r.scene_id === "string" ? r.scene_id : "";
	const sceneName = typeof r.scene_name === "string" ? r.scene_name : "";
	const name = sceneId ? (scenes.get(sceneId)?.name ?? sceneName) : sceneName;
	const sep = name.indexOf(SCENE_SEP);
	if (sep > 0) {
		const prefix = name.slice(0, sep).trim();
		const st = prefixStats.get(prefix);
		if (st && !st.pseudo) {
			if (st.resolvedRoot) {
				push(st.resolvedRoot, "scene_id", 100);
			} else {
				// 前缀不是项目名但它的场景 cwd 只落在一个已知根里 ⇒ 降级为隐含项目
				const only = [...st.roots].filter(Boolean);
				if (only.length === 1) push(only[0], "scene_prefix_implied", 30);
			}
		}
	}

	// ② cwd 落在某个已知根之下 ⇒ 取最长的那个根
	const cwd = normalizeProjectTag(r.cwd);
	if (cwd) {
		const root = longestRootOf(cwd);
		if (root) push(root, "cwd", 80);
	}

	// ③ 正文里的绝对路径 → 复用 candidates.ts 的路径识别 + 噪声过滤
	const content = typeof r.content === "string" ? r.content : "";
	if (content) {
		const hits = new Map<string, number>();
		for (const p of extractPathsFromText(content)) {
			const root = longestRootOf(p);
			if (!root) continue;
			hits.set(root, (hits.get(root) ?? 0) + 1);
		}
		[...hits.entries()]
			.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))
			.slice(0, CONTENT_CANDIDATE_LIMIT)
			.forEach(([p], i) => push(p, "content", 60 - i));
	}

	// ④ sessionKey → 会话项目判定（只取 flag=true）
	const sk = typeof r.sessionKey === "string" ? r.sessionKey : "";
	if (sk && sessionIdx.has(sk)) push(sessionIdx.get(sk)!, "session", 40);

	out.sort((a, b) => b.weight - a.weight);
	return out;
}

// ══════════════════════════════════════════════════════════════
//  记录读取
// ══════════════════════════════════════════════════════════════

/** 读分片时的统计。 */
interface ReadStats {
	/** 扫描到的分片数。 */
	shards: number;
	/** 扫描到的总行数（含墓碑）。 */
	lines: number;
	/** `deleted === true` 的行数。 */
	deleted: number;
	/** JSON 解析失败的行数（**跳过并计数，不中断整批**）。 */
	badLines: number;
	/** 存活记录数。 */
	alive: number;
}

/**
 * 读全部分片，返回存活记录（按分片名升序、行号升序 —— **稳定顺序**，是 `--limit` 与幂等的基础）。
 *
 * @param profilePath profile 根目录（**未使用**，路径由模块级的 `RECORDS_DIR` 决定；
 *                        保留参数是为了让调用点的意图显式，也便于将来支持多 profile）
 * @returns 存活记录 + 读取统计
 * 设计意图：坏行只计数不抛 —— 分片里出现半行/非法行是常态（会话侧早就有同样的处理），
 * 为了 1 条坏行丢掉整天的 500 条是不可接受的。
 */
function readAliveRecords(profilePath: string): { records: { shard: string; line: number; raw: Record<string, unknown> }[]; stats: ReadStats } {
	const records: { shard: string; line: number; raw: Record<string, unknown> }[] = [];
	const stats: ReadStats = { shards: 0, lines: 0, deleted: 0, badLines: 0, alive: 0 };
	void profilePath; // 路径见模块级常量；显式吞掉未用参数，避免 lint 噪声
	if (!existsSync(RECORDS_DIR)) return { records, stats };
	const files = readdirSync(RECORDS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
	for (const f of files) {
		stats.shards++;
		const lines = readFileSync(join(RECORDS_DIR, f), "utf-8").split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i].trim()) continue;
			stats.lines++;
			let o: unknown;
			try {
				o = JSON.parse(lines[i]);
			} catch {
				stats.badLines++;
				continue;
			}
			if (!o || typeof o !== "object" || Array.isArray(o)) {
				stats.badLines++;
				continue;
			}
			const rec = o as Record<string, unknown>;
			if (rec.deleted === true) {
				stats.deleted++;
				continue;
			}
			stats.alive++;
			records.push({ shard: f, line: i, raw: rec });
		}
	}
	return { records, stats };
}

// ══════════════════════════════════════════════════════════════
//  提示词与载荷
// ══════════════════════════════════════════════════════════════

/** 判定提示词。判据顺序照抄 `judgeProject` 的实测结论，别自己重排。 */
const JUDGE_SYSTEM_PROMPT = [
	"你是 L1 记忆库的打标员。给定一批「原子记忆」，为每条判定两个标签：scope（适用范围）与 project（所属项目目录）。只输出 JSON，不要任何解释性前后缀。",
	"",
	"## 输入",
	"- items[i].content：记忆正文（截断到前 ~800 字）。",
	"- items[i].cwd：写下这条记忆时会话的工作目录。⚠ 它只是**工作台**、不是项目 —— 扩展装在",
	"  C:\\Users\\leaf\\.pi 而会话常在 pi 源码仓跑，cwd 会稳定把答案带偏，不要把它当结论。",
	"- items[i].scene：它挂的工作场景。前缀是场景名里 ｜ 之前的部分。",
	"  · sceneNameIsProject=false 表示这个前缀**不是项目名**（它是跨项目约定的分类标签），不要拿它当 project。",
	"- items[i].candidates：代码已经抽出的候选项目目录，按可信度降序，每个带 source 说明它从哪来。",
	"- knownProjects：用户真的拿它开过会话的目录清单（项目名 → 路径的唯一对照表）。",
	"",
	"## 判据（按顺序，先命中先答）",
	"1. 正文说的是**通用做法 / 个人习惯 / 通用约定** —— 换个项目同样成立、换个项目做也对",
	"   ⇒ scope=global，project 必须是空字符串。",
	"   ⚠ 正文里出现某个项目名或路径**只是举例**，不改变它的适用范围。",
	"2. 正文讲的是**某一个具体项目**的事实（它的一个配置文件、一个页面、一张表、一次提交）",
	"   ⇒ scope=self，project 填它真正所属的项目目录。",
	"3. 判 project 时的证据优先级：正文与场景名里点名的项目 > 正文里的文件路径反推的项目",
	"   > 会话判定（source=session）> cwd。",
	"   cwd 只在前三者都没有线索时才用，而且要检查：cwd 指向的仓库里，这条记忆讲的东西在不在。",
	"4. **粒度**：选最具体、又覆盖得住正文全部证据的那一层 —— 既不是只含一两个文件的深层子目录，",
	"   也不是把好几个项目合在一起的仓库根。若某层的候选里同时出现了它的兄弟目录，说明这层太大，往下选一层。",
	"5. 判不出来（正文太空、线索互相矛盾、看不出主线）⇒ **不要输出这一条**。不要猜。",
	"",
	"## 输出",
	'{"verdicts":[{"id":"<原样回填的 id>","scope":"self"|"global","project":"<路径字面量 或 空字符串>","reason":"<15 字内>"}]}',
	"",
	"## 硬性要求",
	"- project 必须是**路径字面量**（正斜杠、含盘符，如 C:/dev/code/xianhua），照抄 candidates /",
	"  knownProjects 里的形态。不要给项目名、简写、相对路径。",
	"- scope=global 时 project 必须是 \"\"；scope=self 时 project 不能为空。",
	"- 不许凭空编一个不在 candidates / knownProjects 里的路径。",
	"- 判不出来的条目**整条省略**，不要给占位值。",
	`${SCOPE_HELP}`,
].join("\n");

/**
 * 组装一批的载荷。
 *
 * @param batch 一批待判定记录
 * @param sceneNames 场景 id → 场景名（用于回显，不参与判定）
 * @returns JSON 字符串
 * 设计意图：**旧 `metadata.scope` 一律不进载荷**（尺子明确它是脏数据，一半填的是项目名，
 * 拿它当证据等于把脏标签洗成合法标签）。
 */
/**
 * 组装一批的载荷。
 *
 * @param batch     一批待判定记录
 * @param sceneNames 场景 id → 场景名（用于回显，不参与判定）
 * @returns JSON 字符串
 * 设计意图：
 *   - **旧 `metadata.scope` 一律不进载荷**（尺子明确它是脏数据，一半填的是项目名，
 *     拿它当证据等于把脏标签洗成合法标签）。
 *   - `scene.namePrefixIsProject` 是**三态**（`true` / `false` / `null`），不是布尔：
 *     `null` 表示「这个名字带 ｜ 但前缀不在 `scenes.json` 的任何场景里」，也就是**我们不知道**。
 *     把它写成 `true` 等于凭空告诉模型"这是个项目名" —— 而模型会拿它当证据。
 *
 *   **缓存键的覆盖性不变量**（改动本函数前必读）：载荷里的每一项，要么直接进
 *   {@link recordKey}（content / cwd / scene_id / scene_name / sessionKey / candidates /
 *   knownProjects），要么**经 `candidates` 间接进键** —— 伪项目标志翻转必然让
 *   `candidatesFor()` 的输出变化（`scene_id` 候选出现/消失），而 candidates 在键里。
 *   唯一例外是上面那个 `null` 分支：它只改"怎么说"、不改"给什么候选"。
 *   所以**若新增任何只影响措辞、不影响候选的字段，必须把 {@link PROMPT_VERSION} +1**，
 *   否则旧裁决会被当成新载荷的结论复用。
 */
function buildBatchPayload(batch: Target[], sceneNames: Map<string, { name: string }>): string {
	return JSON.stringify(
		{
			knownProjects: KNOWN_ROOTS,
			items: batch.map((t) => {
				const sceneName = t.sceneId ? (sceneNames.get(t.sceneId)?.name ?? t.sceneName) : t.sceneName;
				const sep = sceneName.indexOf(SCENE_SEP);
				const prefix = sep > 0 ? sceneName.slice(0, sep).trim() : "";
				const st = prefix ? PREFIX_STATS.get(prefix) : undefined;
				return {
					id: t.id,
					content: t.content.length > CONTENT_CHARS ? `${t.content.slice(0, CONTENT_CHARS)}…` : t.content,
					cwd: t.cwd,
					scene: { id: t.sceneId, name: t.sceneName, namePrefix: prefix, namePrefixIsProject: st ? !st.pseudo : null },
					candidates: t.candidates.map((c) => ({ path: c.path, source: c.source })),
				};
			}),
		},
		null,
		1,
	);
}

// ══════════════════════════════════════════════════════════════
//  模型输出解析
// ══════════════════════════════════════════════════════════════

/**
 * 从可能带 markdown 围栏 / 前后缀 / **被截断**的模型输出里抠出裁决数组。
 *
 * 三步配方与 `judg-session-project/llm.ts` 的 `parseJudgeJson` **一字不改**：
 * 剥 ``` 围栏 → 括号切片 → 截断 salvage。批量形状需要自己写（`parseJudgeJson` 只认单个
 * `{project, reason}`），但每一步的**理由**完全一样：
 *   - 围栏：模型爱把 JSON 包在 ```json 里；
 *   - 切片：前后缀说明文字很常见；
 *   - salvage：推理模型撞 `maxTokens` 上限会**静默截断**（`stopReason:"length"`、花括号不配平），
 *     严格 `JSON.parse` 会把**已经写完的那几条**一起丢掉 —— 逐条正则捞回来比全批丢弃划算得多。
 *
 * @param text 模型的原始文本输出
 * @returns 逐条 `{id, scope, project, reason}` 的原始对象数组（**未做合法性校验**）；
 *          一条都捞不回来时返回空数组
 */
function parseVerdictBatch(text: string): Record<string, unknown>[] {
	let s = text.trim();
	// ① ``` 围栏
	const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
	if (fence) s = fence[1].trim();
	// ② 方括号切片（容忍前后缀说明）
	if (!s.startsWith("[")) {
		const a = s.indexOf("[");
		const b = s.lastIndexOf("]");
		if (a >= 0 && b > a) s = s.slice(a, b + 1);
	}
	try {
		const o = JSON.parse(s) as unknown;
		const arr = Array.isArray(o) ? o : Array.isArray((o as { verdicts?: unknown })?.verdicts) ? (o as { verdicts: unknown[] }).verdicts : null;
		if (arr) return arr.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
	} catch {
		// 落到下面的截断兜底
	}
	// ③ 截断兜底：逐条捞 `{"id":...` 开始的平衡对象（只认 `{}`/`[]` 计数，路径里不会有裸括号）
	const out: Record<string, unknown>[] = [];
	for (const m of s.matchAll(/\{\s*"id"\s*:/g)) {
		const start = m.index ?? 0;
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let i = start; i < s.length; i++) {
			const ch = s[i];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				try {
					const o = JSON.parse(s.slice(start, i + 1));
					if (o && typeof o === "object" && !Array.isArray(o)) out.push(o as Record<string, unknown>);
				} catch {
					// 半条（截断在字段中间）→ 丢弃
				}
				break;
			}
		}
	}
	return out;
}

// ══════════════════════════════════════════════════════════════
//  裁决结果的合法性闸门
// ══════════════════════════════════════════════════════════════

/** 裁决被拒的原因分类（报告里逐项计数）。 */
type RejectReason =
	| "scope 非法"
	| "self 但 project 为空"
	| "project 不可作项目（家目录/内容目录）"
	| "编造路径（不在候选也不在已知根）"
	| "模型没给这条"
	| "模型失败";

/**
 * 把模型给的一条原始裁决收敛成合法的 {@link Verdict}，不合法返回 `null`。
 *
 * @param raw        模型给的原始对象
 * @param t          对应的记录（校验候选归属要用）
 * @param rejectOut  拒绝时把原因写进这里（报告计数）
 * @returns 合法裁决；不合法返回 `null`（调用方 fail-open：不写那三个键）
 * 设计意图 —— 四道闸门，每一道都对应一类真实事故：
 *   ① `scope` 必须过 `normalizeScope`（存量脏值 `workflow` / `A104525` 绝不能被当成合法档）。
 *   ② `scope=self` 而 `project` 为空是**自相矛盾**（契约里 `project === ""` 就是 global 的定义），
 *      当判失败而不是"降级成 global" —— 那是替模型改答案。
 *   ③ `isNotAProjectPath` 的路径（家目录/桌面/文档）不可能是项目，拒。
 *   ④ **不许编造路径**。放行两种"不在本条候选里"的写法：
 *      (a) 与某个候选存在祖先/后代关系（模型只是把粒度挪了一层，如候选 `C:/Users/leaf/.pi`
 *          而正文指的是 `C:/Users/leaf/.pi/agent/extensions/memory-system`）；
 *      (b) 它**本身就是某个已知根**（`listKnownProjects()` 里有这个目录 ⇒ 真实存在，
 *          不可能是凭空编的；模型能说出它，说明正文里那些符号/文件名把它钉住了）。
 *      两者都不满足 ⇒ 拒。代价是可能拒掉真答案，所以这一类**单独计数上报**，可事后复核。
 */
function coerceVerdict(raw: Record<string, unknown>, t: Target, rejectOut: { reason: RejectReason }): Verdict | null {
	const scope = normalizeScope(raw.scope);
	if (!scope) {
		rejectOut.reason = "scope 非法";
		return null;
	}
	const project = projectForScope(scope, typeof raw.project === "string" ? raw.project : "");
	if (scope === "global") {
		// projectForScope 已强制抹成 ""；这里只补一句审计信息
		return { scope, project: "", reason: typeof raw.reason === "string" ? raw.reason.slice(0, 60) : "" };
	}
	if (!project) {
		rejectOut.reason = "self 但 project 为空";
		return null;
	}
	if (isNotAProjectPath(project)) {
		rejectOut.reason = "project 不可作项目（家目录/内容目录）";
		return null;
	}
	const k = projectKey(project);
	const related = t.candidates.some((c) => {
		const ck = projectKey(c.path);
		return k === ck || k.startsWith(`${ck}/`) || ck.startsWith(`${k}/`);
	});
	const knownRoot = KNOWN_ROOTS.some((r) => projectKey(r) === k);
	if (!related && !knownRoot) {
		rejectOut.reason = "编造路径（不在候选也不在已知根）";
		return null;
	}
	return { scope, project, reason: typeof raw.reason === "string" ? raw.reason.slice(0, 60) : "" };
}

// ══════════════════════════════════════════════════════════════
//  最终取值来源（报告与 metadata.projectSource 的**唯一真相源**）
// ══════════════════════════════════════════════════════════════

/** `backfill:` 前缀 —— 与运行时 `l1_commit` 的 `init/code/llm/manual/fallback` 字面上不可能碰撞。 */
const BACKFILL_SOURCE_PREFIX = "backfill:";

/**
 * 一条裁决的"最终取值来源"归类。
 *
 * `kind` 决定语义，`source`（有的话）是**候选自带的那一路证据来源名**
 * （`scene_id` / `scene_prefix_implied` / `cwd` / `content` / `session`），
 * 原样复用 {@link candidatesFor} 里已经定义好的枚举 —— 不另立一套平行命名。
 */
type SourcePick =
	| { kind: "global" }
	| { kind: "exact"; source: string }
	| { kind: "relocate"; source: string }
	| { kind: "known_root" };

/**
 * 判定一条裁决的 `project` 最终是从哪一路来的。
 *
 * @param v 裁决（`scope` 已是合法取值，`project` 已过 `projectForScope`）
 * @param t 该条的目标（**必须带锁内重算过的 candidates**，与 {@link recordKey} 用的是同一份）
 * @returns 来源归类
 * 设计意图 —— **一个函数两个调用方**（报告打印 + 写盘写 `metadata.projectSource`）：
 *   以前报告里那段 `exact / related / 其它` 的推断只存在于 `main()` 的统计代码里，
 *   写盘那侧拿不到它；一旦以后两边各写一套，统计口径就会悄悄分叉（正是本项目反复踩的坑）。
 *   现在两边调同一个函数，报告里看到的分布**就是**写进数据的分布。
 * 四类的判定顺序：
 *   ① `global` —— `projectForScope` 已强制抹空，必须先判，否则它会掉进下面的候选匹配里；
 *   ② `exact` —— project 与某条候选**严格相等**（`projectKey` 口径，大小写/斜杠风格无关）；
 *   ③ `relocate` —— 与某条候选存在祖先/后代关系 ⇒ 模型只是把粒度挪了一层
 *      （候选 `C:/Users/leaf/.pi` 而正文指的是 `…/memory-system`），来源仍记那一条候选的路；
 *   ④ `known_root` —— 既不是候选、也不与任何候选沾亲，但**本身是个已知根**
 *      （`coerceVerdict` 已放行过，说明它真实存在）；这是"从正文符号反推出来"的答案，
 *      没有可归属的候选路，如实记成 `known_root` 而不是硬塞给某一路。
 */
function pickSourceOf(v: Verdict, t: Target | undefined): SourcePick {
	// ① global：project 是被契约抹空的，与"判了个项目却写空"必须可区分
	if (v.scope === "global") return { kind: "global" };
	const k = projectKey(v.project);
	// 防御分支，理论上到不了：`coerceVerdict` 已经拒掉空 project 与非绝对路径，
	// `projectForScope` 又把剩下的都归一成绝对路径 ⇒ 非 global 必有 k。
	// 留在这里是为了"任何输入都不抛"，而不是为了表达一种真实的取值来源。
	if (!k) return { kind: "known_root" };
	const exact = t?.candidates.find((c) => projectKey(c.path) === k);
	if (exact) return { kind: "exact", source: exact.source };
	const related = t?.candidates.find((c) => {
		const ck = projectKey(c.path);
		return k.startsWith(`${ck}/`) || ck.startsWith(`${k}/`);
	});
	if (related) return { kind: "relocate", source: related.source };
	return { kind: "known_root" };
}

/**
 * 把 {@link SourcePick} 渲染成 `metadata.projectSource` 的取值。
 *
 * @param pick 来源归类
 * @returns 形如 `backfill:cwd` / `backfill:relocate(cwd)` / `backfill:known_root` / `backfill:global`
 * 设计意图：**纯函数、只依赖 pick**，所以同一份裁决在任何时候渲染出的字符串都一样
 * —— 幂等（第二次跑 `nextText === text` ⇒ 不重写）靠的就是这一点，不依赖任何环境状态。
 */
function renderSourcePick(pick: SourcePick): string {
	switch (pick.kind) {
		case "global":
			return `${BACKFILL_SOURCE_PREFIX}global`;
		case "exact":
			return `${BACKFILL_SOURCE_PREFIX}${pick.source}`;
		case "relocate":
			return `${BACKFILL_SOURCE_PREFIX}relocate(${pick.source})`;
		case "known_root":
			return `${BACKFILL_SOURCE_PREFIX}known_root`;
	}
}

// ══════════════════════════════════════════════════════════════
//  裁决缓存（幂等的支点）
// ══════════════════════════════════════════════════════════════

/** 缓存文件结构。 */
interface CacheFile {
	/** 结构版本。 */
	version: number;
	/** 写入时刻（ISO，仅审计）。 */
	updatedAt: string;
	/** 裁决键（sha1）→ 裁决。 */
	entries: Record<string, { scope: ScopeValue; project: string; reason: string }>;
	/**
	 * 记录 id → 裁决键。
	 *
	 * 为什么需要这一层：键是 `sha1(模型 + 提示词版本 + 该条全部输入 + 已知根清单)`，
	 * **不可逆、也不能按 id 反查**。评测脚本（`verify-project-scope-backfill.mts --cache`）
	 * 要在 `--apply` 之前就拿到结果，就得自己复刻一遍键的计算 —— 那是**必然漂移**的
	 * （回填器改一行候选逻辑，评测器还按老算法算，命中率悄悄掉到 0，报出"准确率 0%"）。
	 * 落一份 id→键的索引，评测器就只需 `idIndex[id] → entries[key]` 两次查表，
	 * 不再复刻任何判定逻辑。两个脚本之间就只剩**数据契约**，没有**算法副本**。
	 */
	idIndex: Record<string, string>;
}

/**
 * 读裁决缓存。
 *
 * @param file 缓存文件路径
 * @returns 缓存内容；文件缺失/损坏时返回空缓存（**损坏不报错** —— 缓存只是加速，不是真相，
 *          重建一份的代价远小于让脚本起不来）
 */
function readCache(file: string): CacheFile {
	const empty: CacheFile = { version: 1, updatedAt: "", entries: {}, idIndex: {} };
	if (!existsSync(file)) return empty;
	try {
		const o = JSON.parse(readFileSync(file, "utf-8")) as CacheFile;
		if (o && typeof o === "object" && o.entries && typeof o.entries === "object") {
			return { ...empty, ...o, idIndex: o.idIndex && typeof o.idIndex === "object" ? o.idIndex : {} };
		}
	} catch {
		// 忽略：当作没有缓存
	}
	return empty;
}

/**
 * 原子写一个文本文件（临时文件 + rename）。
 *
 * @param file  目标路径
 * @param text  内容
 * 设计意图：照抄 `judg-session-project/index.ts` 的 `atomicWrite` —— 写 `<同名>.tmp` 再
 * `renameSync` 覆盖；Windows 上 rename 可能撞 EBUSY/EPERM，重试 3 次 / 间隔 50ms。
 * 写缓存也要用它：缓存被截断会让下一次跑**全量重判**（浪费 554 次模型调用）。
 */
function atomicWrite(file: string, text: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	const tmp = `${file}.tmp`;
	const delays = [0, 50, 50];
	let lastErr: unknown = null;
	for (const d of delays) {
		if (d > 0) {
			const t = Date.now() + d;
			while (Date.now() < t) {
				/* 忙等 50ms：与参照实现保持一致的同步语义 */
			}
		}
		try {
			writeFileSync(tmp, text, "utf-8");
			rmSync(file, { force: true });
			renameSync(tmp, file);
			return;
		} catch (e) {
			lastErr = e;
		}
	}
	try { rmSync(tmp, { force: true }); } catch { /* 临时文件残留不影响正确性 */ }
	throw new Error(`写入失败（已重试 ${delays.length} 次）：${(lastErr as Error)?.message ?? "未知"}`);
}

// ══════════════════════════════════════════════════════════════
//  写盘（--apply）
// ══════════════════════════════════════════════════════════════

/** 写盘阶段的统计。 */
interface WriteStats {
	/** 实际改写过的分片数。 */
	shardsWritten: number;
	/** 拿不到写锁而跳过的分片数。 */
	shardsLockFailed: number;
	/** 写盘时因内容已变（缓存键失配）而跳过的条数。 */
	staleSkipped: number;
	/** 写盘时读到的新坏行数。 */
	badLines: number;
	/** 改写前后内容完全一致、没动的条数。 */
	unchanged: number;
}

/**
 * 把裁决结果写回分片（read-modify-write，全程在跨进程写锁内）。
 *
 * @param profilePath profile 根目录
 * @param verdicts   记录 id → 裁决（**只含通过全部闸门的**）
 * @param targets    记录 id → 目标（用于算缓存键，检测"写之前内容被改过"）
 * @param modelId    本次用的模型标识（进缓存键）
 * @returns 写盘统计
 * 设计意图 —— 三条硬约束：
 *   ① **只写那三个键**：`r.metadata = { ...原 metadata, project, scope, projectSource }`，
 *      其余原样不动。三者的取值都是 (裁决 × 候选) 的纯函数，重跑必得同一串 ⇒ 幂等。
 *   ② **只重新序列化"真的变了"的行**：没变的行保留原始文本，避免整分片的 key 顺序/转义
 *      无谓地全部重排，diff 只剩该变的那几行。
 *   ③ **写锁内重新读盘 + 校验内容没变**：锁外面读到的内容到写的时候可能已经被 `l1_commit`
 *      改过。锁内重读后逐条重算缓存键，key 失配就跳过这一条（fail-open，不拿旧结论覆盖新内容）。
 */
function applyVerdicts(
	profilePath: string,
	verdicts: Map<string, Verdict>,
	targets: Map<string, Target>,
	modelId: string,
	sceneIdx: Map<string, { name: string }>,
	sessionIdx: Map<string, string>,
): WriteStats {
	const stats: WriteStats = { shardsWritten: 0, shardsLockFailed: 0, staleSkipped: 0, badLines: 0, unchanged: 0 };
	// 按分片分组
	const byShard = new Map<string, string[]>();
	for (const id of verdicts.keys()) {
		const t = targets.get(id);
		if (!t) continue;
		const arr = byShard.get(t.shard) ?? [];
		arr.push(id);
		byShard.set(t.shard, arr);
	}
	for (const [shard, ids] of byShard) {
		const file = join(RECORDS_DIR, shard);
		// ③ 写锁：跨进程，10s 超时；拿不到就跳过该分片并上报，不硬写
		const lock = acquireWriteLock(profilePath, LOCK_TIMEOUT_MS);
		if (!lock) {
			stats.shardsLockFailed++;
			console.warn(`  ⚠ 拿不到写锁，跳过分片：${shard}`);
			continue;
		}
		try {
			const lines = readFileSync(file, "utf-8").split(/\r?\n/);
			const out = lines.slice();
			let changed = 0;
			for (let i = 0; i < lines.length; i++) {
				const text = lines[i];
				if (!text.trim()) continue;
				let o: unknown;
				try {
					o = JSON.parse(text);
				} catch {
					stats.badLines++;
					continue;
				}
				if (!o || typeof o !== "object" || Array.isArray(o)) {
					stats.badLines++;
					continue;
				}
				const rec = o as Record<string, unknown>;
				if (rec.deleted === true) continue; // 墓碑行原样保留
				const id = typeof rec.id === "string" ? rec.id : "";
				const v = verdicts.get(id);
				if (!v) continue;
				// 内容被改过 ⇒ 缓存键失配 ⇒ 跳过（不拿旧结论覆盖新内容）
				const t = targets.get(id);
				if (!t) continue;
				const fresh = candidatesFor(rec, PREFIX_STATS, sceneIdx, sessionIdx);
				// ⚠ `freshTarget` 同时喂给**缓存键校验**与 {@link pickSourceOf}：两者必须是同一份
				//   候选，否则"按旧候选算出来源、写进新数据"就是又一次口径分叉。
				const freshTarget: Target = { ...t, candidates: fresh };
				if (recordKey(id, rec, freshTarget, modelId) !== t.key) {
					stats.staleSkipped++;
					continue;
				}
				// ① 只写这三个键，其余 metadata 原样保留（**不新增任何别的键**）。
				//    三个键的取值都是 (裁决 × 候选) 的**纯函数** ⇒ 第二次跑必然 `nextText === text`
				//    ⇒ `unchanged++` 且不重写，幂等性不因多写一个键而破。
				const meta = rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata) ? { ...(rec.metadata as Record<string, unknown>) } : {};
				meta.project = projectForScope(v.scope, v.project);
				meta.scope = v.scope;
				meta.projectSource = renderSourcePick(pickSourceOf(v, freshTarget));
				const next = { ...rec, metadata: meta };
				const nextText = JSON.stringify(next);
				if (nextText === text) {
					stats.unchanged++; // 幂等：已经是目标态就不动它
					continue;
				}
				out[i] = nextText;
				changed++;
			}
			if (changed > 0) {
				atomicWrite(file, out.join("\n"));
				stats.shardsWritten++;
			}
		} finally {
			lock.release();
		}
	}
	return stats;
}

/**
 * 把将要改的分片复制到 `{memoryDB}/backups/l1-admin/backfill-project-scope-<时间戳>/`。
 *
 * @param profilePath profile 根目录
 * @param shards      涉及的���片文件名列表
 * @returns 备份目录；无分片时返回空串
 * 设计意图：**改前快照**是这条链路上唯一的回滚手段（写锁防的是并发，不是写错）。
 * 目录名带时间戳，多次跑互不覆盖。
 */
function snapshotShards(profilePath: string, shards: string[]): string {
	if (shards.length === 0) return "";
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
	const dir = join(profilePath, MEMORY_DB_DIR, BACKUP_DIR, "l1-admin", `backfill-project-scope-${stamp}`);
	mkdirSync(dir, { recursive: true });
	for (const f of shards) {
		const src = join(RECORDS_DIR, f);
		if (existsSync(src)) copyFileSync(src, join(dir, f));
	}
	return dir;
}

// ══════════════════════════════════════════════════════════════
//  缓存键
// ══════════════════════════════════════════════════════════════

/** 本次运行用的模型标识（进缓存键，换模型 ⇒ 全量重判）。 */
let MODEL_TAG = "unknown";

/**
 * 算一条记录的缓存键。
 *
 * @param id      记录 id
 * @param rec     记录对象（只取参与判定的字段）
 * @param t       已算好的目标（候选、正文等）
 * @param modelId 模型标识
 * @returns sha1 十六进制串
 * 设计意图：键里必须含**全部会影响裁决的输入**（模型、提示词版本、正文、cwd、场景、候选）。
 * 少含一个就会在"输入已变、结论已旧"的情况下静默复用旧结论 —— 那比不缓存更危险。
 */
function recordKey(id: string, rec: Record<string, unknown>, t: Target, modelId: string): string {
	const payload = JSON.stringify({
		v: PROMPT_VERSION,
		model: modelId,
		id,
		content: typeof rec.content === "string" ? rec.content : "",
		cwd: typeof rec.cwd === "string" ? rec.cwd : "",
		sceneId: typeof rec.scene_id === "string" ? rec.scene_id : "",
		sceneName: typeof rec.scene_name === "string" ? rec.scene_name : "",
		sessionKey: typeof rec.sessionKey === "string" ? rec.sessionKey : "",
		candidates: t.candidates,
		roots: KNOWN_ROOTS,
	});
	return createHash("sha1").update(payload).digest("hex");
}

// ══════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════

/** 全局前缀统计（`buildBatchPayload` 要用，先于主流程算出来）。 */
let PREFIX_STATS: Map<string, PrefixStat> = new Map();

async function main(): Promise<void> {
	// ── 读数据 ──
	if (!existsSync(RECORDS_DIR)) {
		console.error(`✗ 找不到记录目录：${RECORDS_DIR}`);
		process.exit(1);
	}
	const { scenes: sceneIdx, sessions: sessionIdx } = loadSceneAndSessionIndex(PROFILE);
	PREFIX_STATS = buildPrefixStats(PROFILE);
	const { records, stats: readStats } = readAliveRecords(PROFILE);

	console.log(`profile    : ${PROFILE}`);
	console.log(`records    : ${RECORDS_DIR}`);
	console.log(`分片 ${readStats.shards} 个 / 总行 ${readStats.lines} / 墓碑 ${readStats.deleted} / 坏行 ${readStats.badLines} / 存活 ${readStats.alive}`);
	console.log(`已知项目根 : ${KNOWN_ROOTS.length} 个${KNOWN_ROOTS.some((r) => projectKey(r) === projectKey(normalizeProjectTag(join(import.meta.dirname, "..")))) ? "（含本扩展自身目录）" : ""}`);
	console.log(`模式       : ${APPLY ? "--apply（真写盘）" : "--dry-run（只读不写）"}`);
	if (LIMIT > 0) console.log(`limit      : ${LIMIT}`);

	// ── 解析模型 ──
	const judge = resolveJudgeModel(PROFILE, AGENT_HOME);
	if (!judge) {
		console.error(`\n✗ 解析不到配置模型。判定用 {profile}/memoryDB/config/application-propertis.json 的 model.llm 决定 provider/modelId，key 取 {agentHome}/auth.json 的同名条目。`);
		process.exit(1);
	}
	MODEL_TAG = `${judge.provider}/${judge.modelId}`;
	console.log(`model      : ${MODEL_TAG}  (maxTokens=${JUDGE_MAX_TOKENS}, 批 ${BATCH_SIZE} 条)`);
	console.log(`缓存       : ${CACHE_FILE}`);

	// ── 算目标 + 缓存键 ──
	let targets: Target[] = records.map(({ shard, line, raw }) => {
		const id = typeof raw.id === "string" ? raw.id : "";
		const content = typeof raw.content === "string" ? raw.content : "";
		const candidates = candidatesFor(raw, PREFIX_STATS, sceneIdx, sessionIdx);
		const t: Target = {
			shard,
			line,
			id,
			content,
			cwd: normalizeProjectTag(raw.cwd),
			sceneId: typeof raw.scene_id === "string" ? raw.scene_id : "",
			sceneName: typeof raw.scene_name === "string" ? raw.scene_name : "",
			sessionKey: typeof raw.sessionKey === "string" ? raw.sessionKey : "",
			candidates,
			key: "",
		};
		t.key = recordKey(id, raw, t, MODEL_TAG);
		return t;
	});
	if (LIMIT > 0) targets = targets.slice(0, LIMIT);

	// ── 候选命中统计（报告用，先于裁决统计）──
	const candHits: Record<string, number> = { scene_id: 0, scene_prefix_implied: 0, cwd: 0, content: 0, session: 0 };
	let noCandidate = 0;
	let pseudoScene = 0;
	for (const t of targets) {
		if (t.candidates.length === 0) noCandidate++;
		for (const c of t.candidates) candHits[c.source] = (candHits[c.source] ?? 0) + 1;
		if (t.sceneId || t.sceneName) {
			const name = t.sceneId ? (sceneIdx.get(t.sceneId)?.name ?? t.sceneName) : t.sceneName;
			const sep = name.indexOf(SCENE_SEP);
			if (sep > 0 && PREFIX_STATS.get(name.slice(0, sep).trim())?.pseudo) pseudoScene++;
		}
	}

	// ── 裁决（缓存优先）──
	const cache = readCache(CACHE_FILE);
	const verdicts = new Map<string, Verdict>();
	const rejects: Record<string, number> = {};
	const rejectSamples: Record<string, string[]> = {};
	const note = (r: RejectReason, msg: string): void => {
		rejects[r] = (rejects[r] ?? 0) + 1;
		const arr = (rejectSamples[r] ??= []);
		if (arr.length < 5) arr.push(msg);
	};
	let fromCache = 0;
	let pending: Target[] = [];
	for (const t of targets) {
		// id → key 的索引每轮都刷：即使这条是缓存命中、没进 pending，索引也要更新
		//（key 含全部输入，输入没变时 key 也不变，所以这行是幂等的）
		cache.idIndex[t.id] = t.key;
		const hit = cache.entries[t.key];
		if (hit && (SCOPE_VALUES as readonly string[]).includes(hit.scope)) {
			verdicts.set(t.id, { scope: hit.scope, project: projectForScope(hit.scope, hit.project), reason: hit.reason ?? "" });
			fromCache++;
		} else {
			pending.push(t);
		}
	}

	// 缓存键命中数只按"该条 target 的键"统计；pending 里再对"模型没给的 id"记 reject
	let modelCalls = 0;
	let modelFailures = 0;
	const batchCount = Math.ceil(pending.length / BATCH_SIZE);
	for (let i = 0; i < pending.length; i += BATCH_SIZE) {
		const batch = pending.slice(i, i + BATCH_SIZE);
		let raw: string | null = null;
		for (let attempt = 0; attempt <= RETRIES; attempt++) {
			modelCalls++;
			raw = await callLLM(judge.model, JUDGE_SYSTEM_PROMPT, buildBatchPayload(batch, sceneIdx), {
				timeoutMs: JUDGE_TIMEOUT_MS,
				maxTokens: JUDGE_MAX_TOKENS,
				apiKey: judge.apiKey,
			});
			if (raw !== null && raw.trim()) break;
			raw = null;
			if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1500));
		}
		// ⚠ 空串是配置模型的常见失败态（推理模型把 token 花在 reasoning 上 / 撞上 maxTokens 上限）。
		//   **当失败处理**，不当"判成 global"。
		if (raw === null) {
			modelFailures++;
			for (const t of batch) note("模型失败", `${t.id} (${t.shard}:${t.line})`);
			continue;
		}
		const parsed = parseVerdictBatch(raw);
		const byId = new Map<string, Record<string, unknown>>();
		for (const p of parsed) {
			const id = typeof p.id === "string" ? p.id : "";
			if (id) byId.set(id, p);
		}
		for (const t of batch) {
			const p = byId.get(t.id);
			if (!p) {
				note("模型没给这条", `${t.id} (${t.shard}:${t.line})`);
				continue;
			}
			const out = { reason: "" as RejectReason };
			const v = coerceVerdict(p, t, out);
			if (!v) {
				note(out.reason, `${t.id} → ${String(p.project ?? "")}`);
				continue;
			}
			verdicts.set(t.id, v);
			cache.entries[t.key] = { scope: v.scope, project: v.project, reason: v.reason };
			cache.idIndex[t.id] = t.key;
		}
		cache.updatedAt = new Date().toISOString();
		try {
			atomicWrite(CACHE_FILE, JSON.stringify(cache, null, 1));
		} catch (e) {
			console.warn(`  ⚠ 缓存写入失败（不影响本次结果）：${(e as Error).message}`);
		}
		const done = Math.min(i + BATCH_SIZE, pending.length);
		console.log(`  [裁决 ${done}/${pending.length}] 模型调用 ${modelCalls}，已定 ${verdicts.size}，批 ${batchCount}`);
	}

	// 收尾再落一次盘：**全命中缓存**时 pending 为空、批次循环一次都不进，
	// 但 idIndex 仍然需要落盘（否则评测脚本 `--cache` 模式读不到 id→key 的映射）。
	try {
		cache.updatedAt = new Date().toISOString();
		atomicWrite(CACHE_FILE, JSON.stringify(cache, null, 1));
	} catch (e) {
		console.warn(`  ⚠ 缓存收尾写入失败（不影响本次结果）：${(e as Error).message}`);
	}

	// ── 裁决结果统计 ──
	const scopeDist: Record<string, number> = { self: 0, global: 0 };
	const projectDist = new Map<string, number>();
	let globalCount = 0;
	for (const v of verdicts.values()) {
		scopeDist[v.scope]++;
		if (v.scope === "global") globalCount++;
		projectDist.set(v.project, (projectDist.get(v.project) ?? 0) + 1);
	}
	// ── 最终取值来源分布 ──
	// ⚠ 这里调用的是**与写盘同一个** {@link pickSourceOf} / {@link renderSourcePick}。
	//   以前这段推断只存在于报告里、写盘拿不到，两边一旦分头实现就会各说各话；
	//   现在报告里印出来的分布**逐条等于**将要写进 `metadata.projectSource` 的值。
	const sourcePick: Record<string, number> = {};
	const byIdTarget = new Map(targets.map((t) => [t.id, t]));
	for (const [id, v] of verdicts) {
		const src = renderSourcePick(pickSourceOf(v, byIdTarget.get(id)));
		sourcePick[src] = (sourcePick[src] ?? 0) + 1;
	}

	// ── 写盘 ──
	let writeStats: WriteStats | null = null;
	if (APPLY) {
		const shards = [...new Set(targets.filter((t) => verdicts.has(t.id)).map((t) => t.shard))].sort();
		const backupDir = snapshotShards(PROFILE, shards);
		console.log(`\n改前快照   : ${backupDir || "(无待改分片)"}`);
		writeStats = applyVerdicts(PROFILE, verdicts, new Map(targets.map((t) => [t.id, t])), MODEL_TAG, sceneIdx, sessionIdx);
	}

	// ── 报告 ──
	console.log(`\n${"=".repeat(60)}`);
	console.log(`回填报告（${APPLY ? "--apply 已执行" : "--dry-run，未写任何记录"}）`);
	console.log("=".repeat(60));
	console.log(`总记录数        : ${targets.length}（分片 ${readStats.shards} / 总行 ${readStats.lines} / 墓碑 ${readStats.deleted} / 坏行 ${readStats.badLines}）`);
	console.log(`成功写入（判定） : ${verdicts.size}   （fail-open 未写入：${targets.length - verdicts.size}）`);
	console.log(`模型调用次数    : ${modelCalls}   缓存命中 ${fromCache}   重试上限 ${RETRIES}`);
	console.log(`模型失败（批）  : ${modelFailures}`);
	console.log(`候选命中数      : ${Object.entries(candHits).map(([k, v]) => `${k}=${v}`).join("  ")}`);
	console.log(`零候选记录      : ${noCandidate}   伪项目场景前缀命中（已丢弃）: ${pseudoScene}`);
	console.log(`scope 分布      : self=${scopeDist.self}  global=${scopeDist.global}`);
	console.log(`判成 global     : ${globalCount}`);
	console.log(`project 分布    :`);
	for (const [p, n] of [...projectDist.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`   ${String(n).padStart(4)}  ${p === "" ? "(空 = global)" : p}`);
	}
	// ⚠ 这一行印出来的**就是** `--apply` 会写进每条记录的 `metadata.projectSource` 取值分布
	//   （同一个 {@link pickSourceOf} + {@link renderSourcePick}，逐条同值），不另设口径。
	console.log(`projectSource 分布: ${Object.entries(sourcePick).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);
	const rejTotal = Object.values(rejects).reduce((s, n) => s + n, 0);
	console.log(`拒绝/未写入明细 : ${rejTotal}`);
	for (const [k, n] of Object.entries(rejects)) {
		console.log(`   ${String(n).padStart(4)}  ${k}`);
		for (const s of (rejectSamples[k] ?? [])) console.log(`         · ${s}`);
	}
	if (writeStats) {
		console.log(`写盘            : 改写分片 ${writeStats.shardsWritten} / 写锁失败跳过 ${writeStats.shardsLockFailed} / 内容已变跳过 ${writeStats.staleSkipped} / 坏行 ${writeStats.badLines} / 幂等未动 ${writeStats.unchanged}`);
	} else {
		console.log(`写盘            : 无（--dry-run）`);
	}
	console.log(`\n提示词与判据的单一真相源：本文件 JUDGE_SYSTEM_PROMPT + memory/l1/project-scope.ts 的 SCOPE_HELP`);
}

await main();
