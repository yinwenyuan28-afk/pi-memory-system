import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { decodeCwdFromSessionPath } from "../l0/index.ts";
import { L1_CURSOR_FILE, L1_RECORDS_DIR, L0_CONVERSATIONS_DIR, MEMORY_DB_DIR } from "../paths.ts";
import { buildScenePoolLines, readScenePool, SCENE_POOL_INJECT_LIMIT } from "./scene-pool.ts";
import { loadAppProps, saveAppSection } from "../../config/app-config.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

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

/** l1-config.json 结构。 */
export interface L1Config {
	mode: L1Mode;
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
		if (section.mode === "chat" || section.mode === "code") return { mode: section.mode };
	}
	// 2) 旧独立 l1-config.json（迁移期兜底）
	const filePath = join(profilePath, MEMORY_DB_DIR, CONFIG_FILE);
	if (existsSync(filePath)) {
		try {
			const data = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<L1Config>;
			if (data.mode === "chat" || data.mode === "code") return { mode: data.mode };
		} catch {
			// 非法配置回退默认
		}
	}
	return { mode: "code" };
}

/** 写入 L1 模式（收束：写 application-propertis.json 的 l1 节，合并保留其他节）。 */
export function saveL1Mode(profilePath: string, mode: L1Mode): void {
	saveAppSection(profilePath, "l1", { mode } as L1Config);
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

/** 构造 l1-extractor 子代理任务消息（供 setupL1Extractor 与手动触发共用）。
 *  模板：prompts/tasks/l1-task.md（registry 单源；`scenePoolLines` 为场景池清单的预拼行，
 *  属数据整形逻辑，留在代码侧——模板只管骨架与字段契约）。 */
export function buildL1Task(profilePath: string): string | null {
	const cursor = loadL1Cursor(profilePath);
	const l0Files = listL0Files(profilePath, cursor);
	if (l0Files.length === 0) return null;
	const mode = loadL1Config(profilePath).mode;
	// 场景池清单：**只读**；写入侧在 l1_commit（写锁内）。本批 cwd 仅用于「同项目优先」排序。
	const pool = readScenePool(profilePath);
	const poolLines = buildScenePoolLines(pool, detectBatchCwd(l0Files));
	const scenePoolLines =
		poolLines.lines.length > 0
			? [
					`ScenePool (id | name; same-project first, recent first; max ${SCENE_POOL_INJECT_LIMIT}):`,
					...poolLines.lines,
				].join("\n")
			: "ScenePool: (无)";
	return renderPrompt("tasks/l1-task", {
		l0Files: l0Files.join(","),
		cursorPath: join(profilePath, MEMORY_DB_DIR, CURSOR_FILE),
		recordsDir: join(profilePath, MEMORY_DB_DIR, RECORDS_DIR_NAME),
		promptDir: PROMPT_DIR,
		mode,
		knownProjects: listKnownProjects().join(","),
		scenePoolLines,
	});
}

/**
 * 枚举 ~/.pi/agent/sessions/ 下所有 cwd（跨前后端多项目场景：session 工作目录
 * 可能与被操作代码目录不同，子代理按消息内容匹配 KnownProjects 修正记忆归属）。
 *
 * 优先读 session 文件第一行（type=session 的 header.cwd，真实精确值）；
 * 读不到时回退 decodeCwdFromSessionPath（启发式解码，含 `-` 的路径会失真）。
 */
export function listKnownProjects(): string[] {
	const home = process.env.PI_CODING_AGENT_DIR ||
		process.env.HOME || process.env.USERPROFILE || "";
	const sessionsDir = join(home, ".pi", "agent", "sessions");
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
