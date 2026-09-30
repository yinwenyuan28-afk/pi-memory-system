/**
 * 会话候选路径提取（纯代码，不发网络、不碰 pi API）
 *
 * 用途：给「这个会话实际在哪个项目目录上干活」这个判定提供**结构化证据**。判定本身由
 * `llm.ts` 的一个普通 LLM 调用完成（实测纯代码 top1 精确率只有 54%），本模块只负责
 * 确定性地把「这段会话动过哪些路径」抽出来。
 *
 * ── 设计要点（每条都有实测依据，见 plan/memory-system/JUDG_SESSION_PROJECT_PLAN.md）──
 *
 * 1. **窗口 = 会话文件尾部 256KB**。会话文件普遍很大（91 个主会话：中位 472KB、p75 1.8MB、
 *    最大 48.6MB），全量读既慢又会淹掉"最近在干什么"。实测 64KB 只含 4~24 个 toolCall，
 *    256KB 是「跨窗口稳定」的那一档（256KB 79.6% / 全文 76.8%）。
 *    窗口起点几乎必然落在行中间 ⇒ **首行必是半行，必须跳过**。
 *
 * 2. **认两种路径写法**。用户 90% 的路径是 `/c/...`（Git Bash 形式，实测 1941 次 vs 盘符
 *    形式 209 次），而 L0 / LLM 给的常是 `C:\...`。只认一种会漏掉绝大多数。
 *
 * 3. **字符集含 CJK，但要做尾部截断**。中文目录/文件名是真实的
 *    （`wangxin\temp\面试材料\campus-hub`、`产品规划.md`），但「路径后面紧跟一句中文散文」
 *    同样真实（`...\A104489.这个是小程序的文件夹地址，帮我看看`）—— 不截的话整句被吞成路径，
 *    归约失败 ⇒ 整个会话被判成「无」。见 `trimTrailingCjk()`。
 *
 * 4. **噪声按文件滤**（不是按根滤）。按根滤会误杀：实测 `.pi` 因为读了
 *    `.pi\agent\agents\*` 被整根剔掉。逐文件判断、只丢那个文件，目录本身照留。
 *
 * 5. **不做「归约成项目名」**。项目已重定义为「路径 + 适用范围」，路径本身就是标识。
 *    这里唯一的形态处理是**文件 → 它的父目录**（纯语法，不查任何登记表）。
 *
 * ── 两条必须记住的坑 ──
 *
 * - **带 `/g` 的正则不能直接喂给 `.test()` / `.exec()`**：会推进并保留 `lastIndex`，
 *   同一个文件在不同次运行里得到不同答案，不报错、只让结果悄悄偏掉。本文件所有需要
 *   布尔判定的正则都写成**无 `g`** 的形式（用 `PATH_RE_SRC` 源串 + 每次新建实例）。
 * - **抽取口径一改，被选中的样本集合就变了**：任何依赖本模块输出的统计（尤其标注集对齐）
 *   都必须在改口径后重做逐条比对，否则标签整体错位而数字看着仍然合理。
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isBroadProjectPath, listKnownProjects } from "../../memory/l1/config.ts";
import { isNotAProjectPath } from "./index.ts";

/** 尾窗字节数。256KB —— 见文件头第 1 条。 */
export const TAIL_WINDOW_BYTES = 256 * 1024;

/**
 * 头窗字节数（只用来取**前几条用户消息**）。
 *
 * 为什么工具证据读尾窗、用户消息读头窗（2026-09-30 评测逼出来的）：两者要的正好相反。
 * 工具证据要"最近在干什么"⇒ 尾窗；但实测**给前 3 条用户消息**效果远好于给最后几条
 * （覆盖率 79% vs 71% vs 完全不给 36%），而前几条用户消息躺在文件**开头** ——
 * 在中位 472KB、最大 48.6MB 的会话文件里，256KB 尾窗根本没覆盖到它们。
 * 实测：只读尾窗时 `pathsNamedByUser` 命中真值只有 2/15；头尾各读一段后恢复。
 */
export const HEAD_WINDOW_BYTES = 64 * 1024;

/** 候选上限（写入 state 的条数）。 */
export const CANDIDATE_LIMIT = 5;

/** 单条用户消息送进证据里的最大字符数（超了截断）。 */
export const USER_MESSAGE_CHARS = 3000;

/** 送进证据的用户消息条数。实测 first3 覆盖 79% / first1 50% / last3 71% / 不给 36%。 */
export const USER_MESSAGE_COUNT = 3;

// ══════════════════════════════════════════════════════════════
//  路径识别
// ══════════════════════════════════════════════════════════════

/**
 * 路径起点的正则**源串**（无 `g`，可安全直接 `.test()`）。
 *
 * 两种起点：`C:\` / `C:/`（盘符）与 `/c/`（Git Bash 形式）。用 `(?:...)` 而非字符类，
 * 是为了把"必须有盘符"这件事写死在模式里 —— 裸 `/usr/lib/x` 这类系统路径不是项目。
 */
const PATH_RE_SRC = "(?:[A-Za-z]:[\\\\/]|/[A-Za-z]/)[^\\s\"'<>|?*()[\\]{},;&`]+";

/** 一次匹配到的路径（未经后处理）。 */
function matchPaths(text: string): string[] {
	// 每次新建实例：见文件头「带 /g 的正则」那条坑
	const re = new RegExp(PATH_RE_SRC, "g");
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		out.push(m[0]);
		// 零宽匹配保护：模式首字符必是字母或 `/`，不会零宽，但显式防御避免将来改动踩坑
		if (m.index === re.lastIndex) re.lastIndex++;
	}
	return out;
}

/** CJK 表意文字（中日韩统一表意文字）区段。 */
const CJK_IDEOGRAPH_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** 全角 / 中文标点区段（U+3000–303F、U+FF00–FFEF）。命中即终止路径。 */
const CJK_PUNCT_RE = /[\u3000-\u303F\uFF00-\uFFEF]/;

/**
 * 截掉路径**尾部**那段没有下文的 CJK。
 *
 * 判定依据：路径中间/非末尾的 CJK 一定是目录或文件名的一部分（`面试材料/campus-hub`、
 * `产品规划.md`），而**结尾悬空**的 CJK 只可能是散文被顺手吞进来了
 * （`...\A104489.这个小程序的文件夹地址`）。所以只看"末尾那一段连续 CJK"，
 * 不看路径中间 —— 中间一刀切会误杀 `面试材料` 与 `产品规划.md`。
 *
 * @param p 归一化后的路径（正斜杠）
 * @returns 截掉悬空 CJK、再去掉尾部多余分隔符/点之后的路径
 */
export function trimTrailingCjk(p: string): string {
	let s = p;
	// 全角 / 中文标点出现即终止（这一层其实是防御性的：匹配用的字符集已经排除了它们，
	// 但手工传入的字符串会走到这里）
	const punct = s.search(CJK_PUNCT_RE);
	if (punct >= 0) s = s.slice(0, punct);
	// 末尾连续 CJK 段
	const m = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+$/.exec(s);
	if (m && m.index > 0) {
		const head = s.slice(0, m.index);
		// head 必须还像个路径（有盘符、且不是只剩分隔符）才截，否则说明整串就是中文 → 全丢
		if (head.replace(/[\\/:.]/g, "").length > 0) s = head;
	}
	// 去掉截断留下的尾部 `.` `/` `\`
	return s.replace(/[./\\]+$/, "") || p;
}

/**
 * 路径归一化：Git Bash 的 `/c/...` → `C:/...`，反斜杠 → 正斜杠，去首尾空白与成对引号。
 *
 * ⚠ **不要用 `match(/^\\([a-zA-Z])\\/.*$/)` 这类写法**（旧抽取器就是这么写的）：
 * `.*` 贪婪会把整串吞掉，`norm("/c/dev/x")` 返回 `"c:"`，于是 POSIX 路径永远匹配不上任何根。
 * 必须用带捕获组的 `replace`。
 */
export function normalizePath(raw: string): string {
	let s = (raw ?? "").trim();
	if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
		s = s.slice(1, -1).trim();
	}
	s = trimTrailingCjk(s);
	s = s.replace(/^\/([a-zA-Z])\//, (_m, d: string) => `${d.toUpperCase()}:/`);
	s = s.replace(/\\/g, "/");
	s = s.replace(/\/{2,}/g, "/");
	// 盘符根不能被去成 `C:`
	if (!/^[A-Za-z]:\/?$/.test(s)) s = s.replace(/\/+$/, "");
	return s;
}

/** 末段看起来像**文件名**（有真扩展名）还是像**目录名**。 */
function looksLikeFile(p: string): boolean {
	const last = p.slice(p.lastIndexOf("/") + 1);
	if (!last.includes(".")) return false;
	const ext = last.slice(last.lastIndexOf(".") + 1);
	// 扩展名必须是「字母开头」：这样 `pi-0.80.10`（末段 pi-0.80.10，扩展名 "10"）被判成目录，
	// `v24.17.0` 同理。而 `md` / `ts` / `java` / `vue` / `log` / `apk` 都是字母开头。
	if (!/^[A-Za-z][A-Za-z0-9]{0,7}$/.test(ext)) return false;
	// 末段整体就是一个版本号形态（`pi-0.80.10`）时也不当文件
	if (/^[A-Za-z][A-Za-z-]*\d[\d.]*$/.test(last)) return false;
	return true;
}

/** {@link looksLikeFile} 的测试出口（回归脚本要钉住 `pi-0.80.10` 判成目录这条）。 */
export function looksLikeFileForTest(p: string): boolean {
	return looksLikeFile(p);
}

/** 路径的比较键：小写 + 正斜杠 + 去尾分隔符（Windows 路径大小写不敏感）。 */
function pathKey(p: string): string {
	let s = p.replace(/\\/g, "/").toLowerCase();
	if (!/^[a-z]:\/?$/.test(s)) s = s.replace(/\/+$/, "");
	return s;
}

// ══════════════════════════════════════════════════════════════
//  噪声过滤（按文件滤，按根保留）
// ══════════════════════════════════════════════════════════════

/**
 * 明确**不**进规则的目录形态（每条都有实测依据，加进去会误杀真项目）：
 *
 * | 不含 | 为什么 |
 * |---|---|
 * | `agents` 目录 | 实测会误杀 `.pi`（它读了 `.pi\agent\agents\*`，整根被剔掉） |
 * | `temp` / `tmp` 目录 | 用户自己的脚本目录就在 `C:\temp\pi\script`；真实项目也可能在那儿 |
 * | `agent/extensions/` | 那就是 `.pi` 项目本体，不是依赖 |
 *
 * ⚠ 而 `AppData` 是**要**滤的（实测 61 条噪声，原规则只覆盖 `AppData\Local\Temp`；
 *   2026-09-30 评测时发现 `AppData\Local\Android\Sdk`、`AppData\Local\Pub\Cache`
 *   也在往候选池里灌水，于是改成整棵 `AppData` 都滤）—— 仍然**不是**裸匹配 `Temp`。
 */
const NOISE_ALWAYS = [
	/[/\\]node_modules[/\\]/i,
	/[/\\]skills?[/\\]/i,
	/[/\\]dist[/\\]/i,
	/[/\\]build[/\\]/i,
	/[/\\]target[/\\]classes[/\\]/i,
	/[/\\]fnm[/\\]/i,
	/[/\\]\.git[/\\]/i,
	/[/\\]\.cache[/\\]/i,
	// ↓ 以下三条是 2026-09-30 评测时补的（计划「噪声过滤规则」那张表是当时在
	//   归约后的路径上统计的最小集，评测暴露了三类漏网的工具缓存目录）。
	//   判据统一：**用户主目录下的包管理器 / 构建工具缓存**，不可能是项目代码。
	/[/\\]AppData[/\\]/i,
	/[/\\]\.m2[/\\]/i,
	/[/\\]\.(pub-cache|gradle|nuget|cargo|ivy2)[/\\]/i,
	// Dart 包缓存在 `AppData\Local\Pub\Cache` 与 `%LOCALAPPDATA%\Pub\Cache` 两处都有
	/[/\\]Pub[/\\]Cache[/\\]/i,
];

/** 这条路径是不是噪声（**逐条**判断，不是整根剔）。 */
export function isNoisePath(p: string): boolean {
	return NOISE_ALWAYS.some((re) => re.test(p));
}

// ══════════════════════════════════════════════════════════════
//  已知项目根（进程内缓存）
// ══════════════════════════════════════════════════════════════

let _knownRoots: string[] | null = null;

/**
 * 已知项目根 = `listKnownProjects()` 去掉过宽容器后的集合。
 *
 * 复用 L1 注入排序已经在用的同一份数据源（`memory/l1/config.ts`），不另立词表 ——
 * 计划删掉「分类词清单」的理由就是不该有手写词表，而"用户真的拿它开过会话的目录"
 * 恰好是这件事的数据驱动版本。
 *
 * 进程内缓存：一次 `extractCandidates` 只要算一次，而 `agent_settled` 每轮都会调。
 * 提供 `resetKnownRootsCache()` 给测试用。
 */
export function knownProjectRoots(): string[] {
	if (_knownRoots) return _knownRoots;
	try {
		_knownRoots = listKnownProjects()
			.map((p) => normalizePath(p))
			.filter((p) => p && !isBroadProjectPath(p) && !isNoisePath(p));
	} catch {
		_knownRoots = [];
	}
	return _knownRoots;
}

/** 清掉已知项目根缓存（测试与 profile 切换后用）。 */
export function resetKnownRootsCache(): void {
	_knownRoots = null;
}

/**
 * 取**最长**的那个包住 `p` 的已知项目根；没有则返回 null。
 *
 * 取最长而不是最短：`C:\dev\code_java\wangxin` 与 `C:\dev\code_java\wangxin\backend\A104527`
 * 都是已知根时，文件落在 A104527 里就该归 A104527（更具体的那个），
 * 否则仓库级根会把所有子项目的证据都吸走。
 */
export function toKnownRoot(p: string): string | null {
	const key = pathKey(p);
	if (!key) return null;
	let best: string | null = null;
	let bestLen = -1;
	for (const root of knownProjectRoots()) {
		const rKey = pathKey(root);
		if (rKey === key) return root;
		if (key.startsWith(`${rKey}/`) && rKey.length > bestLen) {
			best = root;
			bestLen = rKey.length;
		}
	}
	return best;
}

// ══════════════════════════════════════════════════════════════
//  会话文件读取
// ══════════════════════════════════════════════════════════════

/** 从一段文本里抽出所有归一化后的路径（去重、滤噪声）。 */
export function extractPathsFromText(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of matchPaths(text)) {
		const p = normalizePath(raw);
		if (!p || !/^[A-Za-z]:\//.test(p)) continue;
		if (isNoisePath(p)) continue;
		const k = pathKey(p);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(p);
	}
	return out;
}

/** 递归收集一个值里的所有字符串（工具 arguments 是任意嵌套对象）。 */
function collectStrings(v: unknown, depth = 0): string[] {
	if (depth > 8) return [];
	if (typeof v === "string") return [v];
	if (Array.isArray(v)) return v.flatMap((x) => collectStrings(x, depth + 1));
	if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).flatMap((x) => collectStrings(x, depth + 1));
	return [];
}

/** 一条消息里的文本（content 可能是字符串，也可能是 `[{type:"text",text}]`）。 */
function messageText(msg: Record<string, unknown>): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && c.type === "text")
			.map((c) => (typeof c.text === "string" ? c.text : ""))
			.join("\n");
	}
	return "";
}

/**
 * 读一段字节区间并逐行 JSON 解析。
 *
 * @param dropFirst 丢掉解析前的**第一行**（区间起点落在行中间时它是半行）
 * @param dropLast  丢掉解析前的**最后一行**（区间终点落在行中间时它是半行）
 *
 * ⚠ 必须**先切文本再 parse**，不能"先 parse 再 shift" —— 半行本来就 parse 不出来、
 * 根本不会进结果数组，那时 shift 掉的是一条**有效**行。（踩过一次：改写后
 * `pathsNamedByUser` 命中从 2/15 掉到 1/15。）
 */
function parseLines(file: string, from: number, to: number, dropFirst = false, dropLast = false): Record<string, unknown>[] {
	const len = to - from;
	if (len <= 0) return [];
	const buf = Buffer.alloc(len);
	const fd = openSync(file, "r");
	let n = 0;
	try {
		n = readSync(fd, buf, 0, len, from);
	} finally {
		closeSync(fd);
	}
	let text = buf.subarray(0, n).toString("utf-8");
	if (dropFirst) {
		const nl = text.indexOf("\n");
		text = nl >= 0 ? text.slice(nl + 1) : "";
	}
	if (dropLast) {
		const nl = text.lastIndexOf("\n");
		if (nl >= 0) text = text.slice(0, nl);
	}
	const rows: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const o = JSON.parse(line);
			if (o && typeof o === "object") rows.push(o as Record<string, unknown>);
		} catch {
			// 坏行跳过（不抛）：会话文件里出现半行/非法行是常态
		}
	}
	return rows;
}

/** 读会话文件的尾窗（工具证据）。窗口起点落在行中间 ⇒ 首行是半行，必须丢。 */
function readTailLines(sessionFile: string): { rows: Record<string, unknown>[]; skippedPartialHead: boolean } {
	const size = statSync(sessionFile).size;
	const start = Math.max(0, size - TAIL_WINDOW_BYTES);
	return { rows: parseLines(sessionFile, start, size, start > 0, false), skippedPartialHead: start > 0 };
}

/** 读会话文件的**头窗**（取前几条用户消息），丢掉末尾那半行。 */
function readHeadLines(sessionFile: string): Record<string, unknown>[] {
	const size = statSync(sessionFile).size;
	const to = Math.min(size, HEAD_WINDOW_BYTES);
	return parseLines(sessionFile, 0, to, false, to < size);
}

// ══════════════════════════════════════════════════════════════
//  主入口
// ══════════════════════════════════════════════════════════════

/** 一个候选目录及其证据强度。 */
export interface Candidate {
	/** 候选路径本身（正斜杠，原样大小写）。 */
	path: string;
	/** 落在它自己或它所有子目录下的**不同文件数**（目录也算一次，见文件头第 5 条）。 */
	files: number;
	/** 证据是否含"至少一个文件"（纯目录命中为 false）。 */
	hasFile: boolean;
}

/** 用户消息里点名过的路径。 */
export interface UserPath {
	path: string;
	mentions: number;
}

export interface ExtractResult {
	/** 按证据强度降序的候选（最多 `CANDIDATE_LIMIT` 个）。 */
	candidates: Candidate[];
	/** 用户消息里点名过的路径（按提及次数降序）。 */
	pathsNamedByUser: UserPath[];
	/** 前 `USER_MESSAGE_COUNT` 条用户消息正文（已截断）。 */
	userMessages: string[];
	/** 窗口内解析出的 toolCall 数。 */
	toolCallCount: number;
	/** 窗口内出现的候选总数（截断前）。 */
	distinctPaths: number;
	/** 窗口起点是否落在行中间（恒为 true，除非文件比窗口还小）。 */
	skippedPartialHead: boolean;
}

export interface ExtractOptions {
	/** 候选数上限，默认 `CANDIDATE_LIMIT`。 */
	limit?: number;
	/** 送进证据的用户消息条数，默认 `USER_MESSAGE_COUNT`。 */
	userMessages?: number;
	/**
	 * 计数时是否把**子目录**的证据并进父目录，默认 true。
	 *
	 * true  ⇒ `count(dir)` = dir 及其所有后代目录上的不同文件数（"在这棵树里干了多少活"）
	 * false ⇒ 只数锚点恰好等于 dir 的（"直接命中 dir 的有多少"）
	 *
	 * 两种口径实测都能到 90%+，默认取 true：它让"仓库根 + 若干子目录"这种真实形态
	 * 正确地压过单个叶子目录。
	 */
	rollup?: boolean;
}

/**
 * 从会话文件抽候选证据。
 *
 * @param sessionFile 会话 jsonl 的绝对路径
 * @param opts 见 {@link ExtractOptions}
 * @returns 候选 + 用户点名路径 + 前几条用户消息；文件不存在时返回全空（fail-open）
 */
export function extractCandidates(sessionFile: string, opts: ExtractOptions = {}): ExtractResult {
	const empty: ExtractResult = {
		candidates: [], pathsNamedByUser: [], userMessages: [],
		toolCallCount: 0, distinctPaths: 0, skippedPartialHead: false,
	};
	let rows: Record<string, unknown>[];
	let skippedPartialHead: boolean;
	try {
		const r = readTailLines(sessionFile);
		rows = r.rows;
		skippedPartialHead = r.skippedPartialHead;
	} catch {
		return empty;
	}

	// ── 工具调用：递归走 arguments 的所有字符串 ──
	const toolPaths: string[] = [];
	let toolCallCount = 0;
	for (const row of rows) {
		if (row.type !== "message") continue;
		const msg = row.message as Record<string, unknown> | undefined;
		if (!msg || msg.role !== "assistant") continue;
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const p = part as Record<string, unknown>;
			if (!p || p.type !== "toolCall") continue;
			toolCallCount++;
			for (const s of collectStrings(p.arguments)) toolPaths.push(...matchPaths(s).map(normalizePath));
		}
	}

	// ── 候选：路径 → 锚点目录 → 计数 ──
	//
	// `touched` 的键是**被触及的那条路径本身**（文件就是文件、目录就是目录），
	// `anchorOf` 把它映射到所属的锚点目录。两个粒度必须分开：
	//   · 键用路径本身 ⇒ 同一文件重复 50 次只计一次，而同一目录下的 3 个**不同**文件计 3 次
	//   · 锚点用父目录 ⇒ 计数聚合到目录上（`C:/dev/alpha/a.ts` 计入 `C:/dev/alpha`）
	// ⚠ 早先把键也用锚点，于是 `alpha/{a,b,c}.ts` 被算成 1 —— 「命中的**不同文件数**」
	//   变成了「命中了几个目录」，排序整体失真。回归 C5 钉的就是这条。
	const touched = new Set<string>();
	const anchorOf = new Map<string, string>(); // touchedKey → anchorKey
	const displayOf = new Map<string, string>(); // key → 展示用原串
	for (const p of toolPaths) {
		if (!p || !/^[A-Za-z]:\//.test(p)) continue;
		if (isNoisePath(p)) continue;
		// 家目录及其非点开头的子目录（桌面/文档/AppData/…）不可能是项目 —— 直接不进候选池。
		// 放在这里而不是只滤 top5：让模型看见"桌面"当候选，它就会选它。
		if (isNotAProjectPath(p)) continue;
		const isFile = looksLikeFile(p);
		const anchor = isFile ? p.slice(0, Math.max(p.lastIndexOf("/"), 3)) : p;
		const aKey = pathKey(anchor);
		if (!aKey) continue;
		const key = pathKey(p);
		if (touched.has(key)) continue;
		touched.add(key);
		anchorOf.set(key, aKey);
		if (!displayOf.has(aKey)) displayOf.set(aKey, anchor);
	}

	// 聚合：每个锚点的直接命中数
	const direct = new Map<string, number>();
	for (const key of touched) {
		const aKey = anchorOf.get(key)!;
		direct.set(aKey, (direct.get(aKey) ?? 0) + 1);
	}

	// ── 把「包住已触及路径的已知项目根」也放进候选池 ──
	//
	// 为什么需要（2026-09-30 评测实测逼出来的）：已触及路径**经常不是项目根**，而是根的子目录。
	// 尺子 #4 的真值是 `C:\dev\code\myLocation`，而工具动的是 `…\myLocation\app\lib\main.dart`
	// ⇒ 纯靠"已触及路径"永远选不到真值。同理 #2 / #12 / #13：会话读的是 `.pi\agent\agents\*`，
	// 真值是 `.pi`。计划 9b⑩ 钉的就是这条反例。
	//
	// 为什么用「已知项目根」而不是「把所有祖先目录都塞进去」：祖先里全是容器
	// （`C:\`、`C:\dev`、`C:\Users\leaf`），它们按定义包住一切，计数必然最高，会挤掉真值。
	// 而 `listKnownProjects()` 给出的正是**用户真的拿它当工作台开过会话的目录** ——
	// 数据驱动、不是手写词表，正是计划删掉「分类词清单」后要的东西。
	// `isBroadProjectPath` 顺手把 `C:\`、`C:\temp`、`C:\Users\leaf` 这类容器剔掉。
	//
	// ⚠ 这**不是**计划里删掉的那个「归约规则」：归约是把文件路径**替换**成项目名（要登记表），
	//   这里是把包住它们的已知根**追加**为并列选项，粒度仍由 LLM 选，路径仍是路径。
	const knownRoots = knownProjectRoots();
	for (const root of knownRoots) {
		const rKey = pathKey(root);
		if (!rKey || direct.has(rKey)) continue;
		if (isNotAProjectPath(root)) continue; // 同上：已知根里混进"桌面"时也不能进池
		// 只在确实有东西落在它下面时才算候选（否则等于把整个已知项目清单倒进证据）
		const prefix = `${rKey}/`;
		let under = 0;
		for (const key of touched) {
			const k = anchorOf.get(key)!;
			if (k === rKey || k.startsWith(prefix)) under++;
		}
		if (under > 0) {
			direct.set(rKey, 0); // 直接命中 0 次（不是它自己被点名的，是它的子树）
			displayOf.set(rKey, root);
		}
	}

	const rollup = opts.rollup !== false;
	const scored: Candidate[] = [];
	for (const [aKey, own] of direct) {
		let files = own;
		const prefix = `${aKey}/`;
		for (const key of touched) {
			const k = anchorOf.get(key)!;
			if (k !== aKey && (rollup ? k.startsWith(prefix) : k === aKey)) files++;
		}
		scored.push({ path: displayOf.get(aKey)!, files, hasFile: own > 0 });
	}
	// 排序：证据多者先；并列时取**路径更长**的（更具体的目录信息量更大，见 verify 里
	// 「并列取最长路径」那条断言）；再并列按字典序，保证结果稳定可复现。
	scored.sort((a, b) => b.files - a.files || b.path.length - a.path.length || (a.path < b.path ? -1 : 1));

	// ── 用户消息：**头窗**取（要"最前面"几条，尾窗里没有），正文 + 点名路径 ──
	const userTexts: string[] = [];
	try {
		for (const row of readHeadLines(sessionFile)) {
			if (row.type !== "message") continue;
			const msg = row.message as Record<string, unknown> | undefined;
			if (!msg || msg.role !== "user") continue;
			const t = messageText(msg).trim();
			if (t) userTexts.push(t);
		}
	} catch {
		// 头窗读失败不致命：LLM 少一条判断依据，纯代码证据仍在
	}
	const mentionCount = new Map<string, { path: string; mentions: number }>();
	for (const t of userTexts) {
		const seenInThisMsg = new Set<string>();
		for (const raw of extractPathsFromText(t)) {
			// 用户点名的是**文件**时，把它落到包住它的已知项目根上 ——
			// 「用户提到了 A104527\plan\…\PLAN.md」是关于项目 `A104527` 的证据，
			// 而不是一个叫 `…PLAN.md` 的项目。实测尺子里 15 条有 9 条是这个形态。
			// 找不到已知根时保留原路径（尺子 #20 就是：零工具调用、用户直接点名项目根）。
			const p = toKnownRoot(raw) ?? raw;
			const k = pathKey(p);
			if (seenInThisMsg.has(k)) continue;
			seenInThisMsg.add(k);
			const cur = mentionCount.get(k);
			if (cur) cur.mentions++;
			else mentionCount.set(k, { path: p, mentions: 1 });
		}
	}
	const pathsNamedByUser = [...mentionCount.values()].sort((a, b) => b.mentions - a.mentions || (a.path < b.path ? -1 : 1));

	const nMsg = opts.userMessages ?? USER_MESSAGE_COUNT;
	return {
		candidates: scored.slice(0, opts.limit ?? CANDIDATE_LIMIT),
		pathsNamedByUser,
		userMessages: userTexts.slice(0, nMsg).map((t) => (t.length > USER_MESSAGE_CHARS ? `${t.slice(0, USER_MESSAGE_CHARS)}…` : t)),
		toolCallCount,
		distinctPaths: touched.size,
		skippedPartialHead,
	};
}

/** top 候选的文件占比（0–1）。单候选时为 1。这是**证据集中度**，不是模型置信度。 */
export function topShare(candidates: Candidate[]): number {
	const total = candidates.reduce((s, c) => s + c.files, 0);
	if (total <= 0) return 0;
	return candidates[0].files / total;
}
