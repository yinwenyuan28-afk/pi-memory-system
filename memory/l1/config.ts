import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { decodeCwdFromSessionPath } from "../l0/index.ts";
import { L1_CURSOR_FILE, L1_RECORDS_DIR, L0_CONVERSATIONS_DIR, MEMORY_DB_DIR } from "../paths.ts";
import { buildScenePoolLines, readScenePool, SCENE_POOL_INJECT_LIMIT } from "./scene-pool.ts";
import { loadAppProps, saveAppSection } from "../../config/app-config.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";
import { resolveSessionsDir } from "../../util/agent-dir.ts";

// ══════════════════════════════════════════════════════════════
//  L1 配置 / 游标 / 分片清单（纯函数，无 pi 依赖，可单测）
// ══════════════════════════════════════════════════════════════

/** 触发间隔：每 N 轮用户消息启动一次 L1 提取。 */
export const L1_INTERVAL = 10;
/**
 * 子代理超时。
 *
 * 2026-09-15 由 180s 调整为 600s。原判断「每轮只提取 ≤10 条，3 分钟足够」与实测不符：
 * 一次真实提取实测耗时 **561s**（session 记录），主要消耗在
 *   ① 3 个并发 embed_and_search 失败后的空转（约 200s，并发单例缺陷，已修）
 *   ② 去重降级为手动扫描最近 30 天分片（约 224s）
 * 而 180s 上限会导致**必然误判**：job 被标 failed，但子进程并未被 abort 终止，
 * 随后仍正常提交 —— 计数虚增、3 次即熔断。
 * 600s 高于实测上界留出余量；仍保留 reclaimTimedOutL1 兜底，以应对更慢的批。
 */
export const SUBAGENT_TIMEOUT_MS = 600_000;
/** 连续失败多少次后熔断（暂停自动提取并通知用户）。 */
export const L1_FAILURE_THRESHOLD = 3;
/** 本批 cwd 探测：从最新的 L0 分片尾部取多少行做众数。 */
export const SCENE_BATCH_CWD_TAIL_LINES = 50;
/** 本批 cwd 探测最多回溯几个分片（最新的分片整片缺 `cwd` 时向前找）。 */
export const SCENE_BATCH_CWD_MAX_FILES = 3;

/** 配置文件名（mode 持久化）。 */
export const CONFIG_FILE = "l1-config.json"; // [DEPRECATED 2026-09-14] 旧独立配置文件已迁入 config/application-propertis.json；本常量仅作 loadL1Config 的迁移期兜底（文件实际已不存在）
/** 游标文件名（全局 lastRecordedAt，子代理回写）。 */
export const CURSOR_FILE = L1_CURSOR_FILE; // 单一来源见 paths.ts（2026-09-14 收束）
/** L0 分片目录名（{profilePath}/memoryDB/l0/conversations，单一来源见 paths.ts）。 */
export const L0_DIR_NAME = L0_CONVERSATIONS_DIR;
/** L1 记忆输出目录名（{profilePath}/memoryDB/l1/records，单一来源见 paths.ts）。 */
export const RECORDS_DIR_NAME = L1_RECORDS_DIR;

/** 规则文件目录（本模块同目录下的 prompts/）。 */
export const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

/** L1 提取模式（与腾讯 MemoryPromptMode 对齐）。 */
export type L1Mode = "code" | "chat";

/**
 * L1 价值校验（2026-09-17）：l1_commit 在写盘前跑一次 agent loop，只判"值不值得留"。
 *
 * 为什么放在写盘路径里而不是"子代理自觉去调一个工具"：跳过工具调用是可能的，跳过写盘闸不可能。
 * 为什么是 agent loop 而不是 `callLLM`：判据要跟着提取规则同源演进，且需要能升级成多轮（如让它
 * 自己查证），所以走 `util/agent-loop.ts`；**但 turn 数必须封顶**（用户要求），默认 1。
 *
 * 只对 `source=subagent` 生效 —— 主代理那条路是同步调用，不能让它等一次 LLM。
 */
export interface L1ValueCheckConfig {
	/** 总开关；关掉则完全不跑（写盘行为与从前一致）。 */
	enabled: boolean;
	/** agent loop 的 turn 上限。**1 = 纯判定、不给工具**；放开到 2+ 必须同时想清楚给它什么工具。 */
	maxTurns: number;
	/** 单次校验的整体超时。超时即 fail-open（照写 + 留痕），不能拖住写盘。 */
	timeoutMs: number;
	/** 单条候选在提示词里的截断长度（防止一条超长记录把校验上下文吃掉）。 */
	maxRecordChars: number;
}

/** 价值校验默认值（配置中心 `l1.valueCheck` 缺省时用它）。 */
export const DEFAULT_VALUE_CHECK: L1ValueCheckConfig = {
	enabled: true,
	maxTurns: 1,
	timeoutMs: 60_000,
	maxRecordChars: 400,
};

/** l1-config.json 结构。 */
export interface L1Config {
	mode: L1Mode;
	valueCheck: L1ValueCheckConfig;
}

/** 取 valueCheck 子节并按类型逐字段兜底（配置写成字符串/负数都不该让校验层失控）。 */
function readValueCheck(section: unknown): L1ValueCheckConfig {
	const v = (section && typeof section === "object" ? (section as { valueCheck?: unknown }).valueCheck : undefined) ?? {};
	const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
	const num = (x: unknown, d: number, min: number, max: number) =>
		typeof x === "number" && Number.isFinite(x) ? Math.min(max, Math.max(min, Math.floor(x))) : d;
	return {
		enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_VALUE_CHECK.enabled,
		// 上限硬封在 1..3：放更大就等于允许它自己展开成一个不受控的循环
		maxTurns: num(o.maxTurns, DEFAULT_VALUE_CHECK.maxTurns, 1, 3),
		timeoutMs: num(o.timeoutMs, DEFAULT_VALUE_CHECK.timeoutMs, 5_000, 300_000),
		maxRecordChars: num(o.maxRecordChars, DEFAULT_VALUE_CHECK.maxRecordChars, 100, 4000),
	};
}

/**
 * 读取 L1 配置（2026-09-02 起收束到 application-propertis.json 的 l1 节）；
 * 无配置/非法时返回默认 code。兜底链：app 配置 l1.mode → 旧 l1-config.json → code。
 */
export function loadL1Config(profilePath: string): L1Config {
	// 1) 统一配置中心 l1 节
	const appProps = loadAppProps(profilePath);
	const section = appProps?.l1 as Partial<L1Config> | undefined;
	if (section && typeof section === "object") {
		if (section.mode === "chat" || section.mode === "code") {
			return { mode: section.mode, valueCheck: readValueCheck(section) };
		}
		return { mode: "code", valueCheck: readValueCheck(section) };
	}
	// 2) 旧独立 l1-config.json（迁移期兜底）
	const filePath = join(profilePath, MEMORY_DB_DIR, CONFIG_FILE);
	if (existsSync(filePath)) {
		try {
			const data = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<L1Config>;
			if (data.mode === "chat" || data.mode === "code") {
				return { mode: data.mode, valueCheck: readValueCheck(data) };
			}
		} catch {
			// 非法配置回退默认
		}
	}
	return { mode: "code", valueCheck: { ...DEFAULT_VALUE_CHECK } };
}

/**
 * 写入 L1 模式（收束：写 application-propertis.json 的 l1 节）。
 *
 * 注意 `saveAppSection` 是**整节替换**（`appProps[section] = value`，不做深合并），
 * 所以这里必须先读出 l1 节已有字段再合并 —— 否则 `/l1-mode chat` 会把同节的 `valueCheck` 冲掉。
 */
export function saveL1Mode(profilePath: string, mode: L1Mode): void {
	const cur = loadAppProps(profilePath)?.l1;
	const merged = (cur && typeof cur === "object" ? { ...(cur as Record<string, unknown>) } : {}) as Record<string, unknown>;
	merged.mode = mode;
	saveAppSection(profilePath, "l1", merged);
}

/** 读取 L1 游标 lastRecordedAt（ISO 字符串；无则返回空串）。 */
export function loadL1Cursor(profilePath: string): string {
	const filePath = join(profilePath, MEMORY_DB_DIR, CURSOR_FILE);
	if (!existsSync(filePath)) return "";
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as { lastRecordedAt?: string };
		return typeof data.lastRecordedAt === "string" ? data.lastRecordedAt : "";
	} catch {
		return "";
	}
}

/**
 * 计算本次 L1 要处理的分片文件清单。
 * 游标为空 → 全部；有游标 → 只列游标日期及之后的分片（子代理再按行级 recordedAt 过滤）。
 */
export function listL0Files(profilePath: string, lastRecordedAt: string): string[] {
	const l0Dir = join(profilePath, MEMORY_DB_DIR, L0_DIR_NAME);
	if (!existsSync(l0Dir)) return [];
	let files: string[];
	try {
		files = readdirSync(l0Dir)
			.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
			.sort();
	} catch {
		return [];
	}
	// 游标日期：lastRecordedAt 前 10 字符即 YYYY-MM-DD
	const cursorDate = lastRecordedAt.length >= 10 ? lastRecordedAt.slice(0, 10) : "";
	if (!cursorDate) return files.map((f) => join(l0Dir, f));
	return files.filter((f) => f.slice(0, 10) >= cursorDate).map((f) => join(l0Dir, f));
}

/**
 * 探测本批 L0 增量所属的项目 cwd——**只用于池清单的「同项目优先」排序**。
 *
 * 从最新分片向上回溯最多 `SCENE_BATCH_CWD_MAX_FILES` 个，取尾部 `SCENE_BATCH_CWD_TAIL_LINES`
 * 行里非空 `cwd` 的众数。取不到（老分片缺 `cwd` 字段，实测 2026-08-17 分片仅 83.6% 行有值）
 * 返回空串，调用方退化为「不按项目过滤，全池按 lastUsedAt 排序」。
 *
 * **不能用 `process.cwd()`**：那是主进程 cwd，而本批要提取的可能是另一个项目——这正是旧锚点
 * 机制失效的结构性原因之一（候选按错误的 cwd 排序，最相关的场景常常进不了名单）。
 */
export function detectBatchCwd(
	l0Files: string[],
	tailLines = SCENE_BATCH_CWD_TAIL_LINES,
	maxFiles = SCENE_BATCH_CWD_MAX_FILES,
): string {
	const start = Math.max(0, l0Files.length - maxFiles);
	for (let i = l0Files.length - 1; i >= start; i--) {
		let lines: string[];
		try {
			lines = readFileSync(l0Files[i], "utf-8").split(/\r?\n/).filter(Boolean).slice(-tailLines);
		} catch {
			continue;
		}
		const counts = new Map<string, number>();
		for (const line of lines) {
			try {
				const o = JSON.parse(line) as { cwd?: unknown };
				if (typeof o.cwd === "string" && o.cwd) counts.set(o.cwd, (counts.get(o.cwd) ?? 0) + 1);
			} catch {
				// 坏行跳过
			}
		}
		if (counts.size > 0) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
	}
	return "";
}

/**
 * 判断一个 `KnownProjects` 项是否**过宽**、不该用来做项目匹配。
 *
 * 实测该列表里有 `C:\`、`C:\temp`、`C:\Users\leaf` 这类项——**`C:\` 是所有 Windows 路径的开头**，
 * 不滤掉的话任何正文都会命中它，"本批疑似项目"变成恒等于 `C:\`。滤除规则（都可断言）：
 *   ① 盘根（`C:`）；② 只有盘符一级；③ `C:\<常见宽目录>`（temp/tmp/users/home/...）；
 *   ④ 家目录本身（`C:\Users\leaf`——它是父目录而不是项目）。
 * 更具体的项（`C:\Users\leaf\.pi`、`C:\dev\code\xianhua`）一律保留。
 */
export function isBroadProjectPath(p: string): boolean {
	const t = p.replace(/[\\/]+$/, "").toLowerCase();
	if (/^[a-z]:$/.test(t)) return true;
	const segs = t.split(/[\\/]/).filter(Boolean); // ['c:','users','leaf']
	if (segs.length <= 1) return true;
	const last = segs[segs.length - 1];
	if (segs.length === 2 && ["temp", "tmp", "users", "home", "windows", "program files", "documents"].includes(last)) return true;
	if (segs.length === 3 && (segs[1] === "users" || segs[1] === "home")) return true;
	return false;
}

/**
 * 探测**本批 L0 增量所属的项目**——只用于池清单的「同项目优先」排序与给子代理的一句提示。
 *
 * 与 `detectBatchCwd` 的区别：cwd 是**会话工作台**（pi 从哪启动），本函数则从正文里出现的
 * **绝对路径**去匹配 `KnownProjects`，更接近"这批对话实际在动哪个仓库"。实测两者经常不一致：
 * memory-system 的记录 cwd 全是 pi fork 目录，而扩展本体在 `~/.pi`。
 *
 * 做法：从最新分片向前回溯最多 `maxFiles` 个，取尾部 `tailLines` 行，逐条消息 `content` 做
 * **子串包含**匹配（两侧统一小写、`/`→`\`；`~` 不展开、相对路径不参与）。按命中消息数取众数；
 * 并列时取**路径最长**者（更具体），再并列取字典序最小（结果稳定可复现）。
 *
 * 取不到（含全部被 `isBroadProjectPath` 滤掉）返回空串 → 调用方退化为按 cwd / 最近排序。
 */
export function detectBatchProject(
	l0Files: string[],
	knownProjects: string[],
	tailLines = SCENE_BATCH_CWD_TAIL_LINES,
	maxFiles = SCENE_BATCH_CWD_MAX_FILES,
): string {
	const projects = knownProjects
		.map((p) => p.replace(/[\\/]+$/, ""))
		.filter((p) => p.length > 0 && !isBroadProjectPath(p));
	if (projects.length === 0) return "";
	const needles = projects.map((p) => ({ raw: p, needle: p.toLowerCase().replace(/\//g, "\\") }));
	const start = Math.max(0, l0Files.length - maxFiles);
	for (let i = l0Files.length - 1; i >= start; i--) {
		let lines: string[];
		try {
			lines = readFileSync(l0Files[i], "utf-8").split(/\r?\n/).filter(Boolean).slice(-tailLines);
		} catch {
			continue;
		}
		const counts = new Map<string, number>();
		for (const line of lines) {
			let content = "";
			try {
				const o = JSON.parse(line) as { content?: unknown };
				content = typeof o.content === "string" ? o.content : "";
			} catch {
				continue;
			}
			if (!content) continue;
			const hay = content.toLowerCase().replace(/\//g, "\\");
			for (const { raw, needle } of needles) {
				if (hay.includes(needle)) counts.set(raw, (counts.get(raw) ?? 0) + 1);
			}
		}
		if (counts.size > 0) {
			return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))[0][0];
		}
	}
	return "";
}

/** 构造 l1-extractor 子代理任务消息（供 setupL1Extractor 与手动触发共用）。
 *  模板：prompts/tasks/l1-task.md（registry 单源；`scenePoolLines` 为场景池清单的预拼行，
 *  属数据整形逻辑，留在代码侧——模板只管骨架与字段契约）。 */
export function buildL1Task(profilePath: string): string | null {
	const cursor = loadL1Cursor(profilePath);
	const l0Files = listL0Files(profilePath, cursor);
	if (l0Files.length === 0) return null;
	const mode = loadL1Config(profilePath).mode;
	// 场景池清单：**只读**；写入侧在 l1_commit（写锁内）。
	// 排序 key：本批疑似项目（来自正文路径）优先于 cwd——后者是"会话工作台"而不是项目。
	const knownProjects = listKnownProjects();
	const pool = readScenePool(profilePath);
	const batchCwd = detectBatchCwd(l0Files);
	const batchProject = detectBatchProject(l0Files, knownProjects);
	const poolLines = buildScenePoolLines(pool, { batchCwd, batchProject });
	const scenePoolLines =
		poolLines.lines.length > 0
			? [
					`ScenePool (id | name; ${batchProject ? `batchProject=${batchProject}; ` : ""}same-project first, recent first; max ${SCENE_POOL_INJECT_LIMIT}):`,
					...poolLines.lines,
				].join("\n")
			: "ScenePool: (无)";
	return renderPrompt("tasks/l1-task", {
		l0Files: l0Files.join(","),
		cursorPath: join(profilePath, MEMORY_DB_DIR, CURSOR_FILE),
		recordsDir: join(profilePath, MEMORY_DB_DIR, RECORDS_DIR_NAME),
		promptDir: PROMPT_DIR,
		mode,
		knownProjects: knownProjects.join(","),
		scenePoolLines,
	});
}

/**
 * 枚举 agent 根的 `sessions/` 下所有 cwd（跨前后端多项目场景：session 工作目录
 * 可能与被操作代码目录不同，子代理按消息内容匹配 KnownProjects 修正记忆归属）。
 *
 * 优先读 session 文件第一行（type=session 的 header.cwd，真实精确值）；
 * 读不到时回退 decodeCwdFromSessionPath（启发式解码，含 `-` 的路径会失真）。
 *
 * ⚠ `PI_CODING_AGENT_DIR` **已经是 agent 根**（`~/.pi/agent`，见 index.ts 的 getAgentDir），
 * 2026-10-01 修：原实现无条件在它后面再拼一段 `.pi/agent`，于是设了该环境变量时得到
 * `~/.pi/agent/.pi/agent/sessions` —— 不存在 ⇒ 静默返回 `[]` ⇒ L1/L2 的项目归属判定
 * 整体失效且无任何报错。现在按「该变量给什么就用什么」处理。
 */
export function listKnownProjects(): string[] {
	const sessionsDir = resolveSessionsDir();
	if (!existsSync(sessionsDir)) return [];
	const result: string[] = [];
	try {
		for (const d of readdirSync(sessionsDir)) {
			if (!d.startsWith("--") || !d.endsWith("--")) continue;
			const sessionDirPath = join(sessionsDir, d);
			// 优先读该目录下第一个 session 文件的 header.cwd（真实值）
			let cwd = "";
			try {
				const firstFile = readdirSync(sessionDirPath).find((f) => f.endsWith(".jsonl"));
				if (firstFile) {
					const header = JSON.parse(readFileSync(join(sessionDirPath, firstFile), "utf-8").split(/\r?\n/)[0]);
					if (typeof header?.cwd === "string" && header.cwd) cwd = header.cwd;
				}
			} catch {
				// 回退解码
			}
			if (!cwd) cwd = decodeCwdFromSessionPath(join(sessionDirPath, "x.jsonl"));
			if (cwd && cwd !== "/" && cwd !== "C:/") result.push(cwd);
		}
	} catch {
		return result;
	}
	return result;
}
