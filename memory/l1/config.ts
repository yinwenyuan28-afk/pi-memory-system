import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { decodeCwdFromSessionPath } from "../l0/index.js";
import { L1_CONFIG_FILE, L1_CURSOR_FILE, L1_RECORDS_DIR, L0_CONVERSATIONS_DIR, MEMORY_DB_DIR } from "../paths.js";

// ══════════════════════════════════════════════════════════════
//  L1 配置 / 游标 / 分片清单（纯函数，无 pi 依赖，可单测）
// ══════════════════════════════════════════════════════════════

/** 触发间隔：每 N 轮用户消息启动一次 L1 提取。 */
export const L1_INTERVAL = 5;
/** 子代理超时（L1 每轮只提取 ≤10 条，3 分钟足够；原 10 分钟过长，hung 子代理会长期占锁）。 */
export const SUBAGENT_TIMEOUT_MS = 180_000;
/** 连续失败多少次后熔断（暂停自动提取并通知用户）。 */
export const L1_FAILURE_THRESHOLD = 3;

/** 配置文件名（mode 持久化）。 */
export const CONFIG_FILE = "l1-config.json";
/** 游标文件名（全局 lastRecordedAt，子代理回写）。 */
export const CURSOR_FILE = "l1-cursor.json";
/** L0 分片目录名（{profilePath}/conversations）。 */
export const L0_DIR_NAME = "conversations";
/** L1 记忆输出目录名（{profilePath}/records）。 */
export const RECORDS_DIR_NAME = "records";

/** 规则文件目录（本模块同目录下的 prompts/）。 */
export const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

/** L1 提取模式（与腾讯 MemoryPromptMode 对齐）。 */
export type L1Mode = "code" | "chat";

/** l1-config.json 结构。 */
export interface L1Config {
	mode: L1Mode;
}

/** 读取 L1 配置；无配置/非法时返回默认 code。 */
export function loadL1Config(profilePath: string): L1Config {
	const filePath = join(profilePath, MEMORY_DB_DIR, CONFIG_FILE);
	if (!existsSync(filePath)) return { mode: "code" };
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<L1Config>;
		if (data.mode === "chat" || data.mode === "code") return { mode: data.mode };
	} catch {
		// 非法配置回退默认
	}
	return { mode: "code" };
}

/** 写入 L1 模式（原子写：tmp + rename）。 */
export function saveL1Mode(profilePath: string, mode: L1Mode): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, CONFIG_FILE);
	const tmpPath = join(profilePath, MEMORY_DB_DIR, `.tmp_l1_config_${Date.now()}`);
	writeFileSync(tmpPath, JSON.stringify({ mode } as L1Config, null, 2), "utf-8");
	try {
		rmSync(filePath, { force: true });
	} catch {
		// ignore
	}
	try {
		renameSync(tmpPath, filePath);
	} catch {
		writeFileSync(filePath, readFileSync(tmpPath, "utf-8"), "utf-8");
	}
	try {
		rmSync(tmpPath, { force: true });
	} catch {
		// ignore
	}
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

/** 构造 l1-extractor 子代理任务消息（供 setupL1Extractor 与手动触发共用）。 */
export function buildL1Task(profilePath: string): string | null {
	const cursor = loadL1Cursor(profilePath);
	const l0Files = listL0Files(profilePath, cursor);
	if (l0Files.length === 0) return null;
	const mode = loadL1Config(profilePath).mode;
	return [
		"L1 extraction task",
		`L0Files: ${l0Files.join(",")}`,
		`CursorPath: ${join(profilePath, MEMORY_DB_DIR, CURSOR_FILE)}`,
		`RecordsDir: ${join(profilePath, MEMORY_DB_DIR, RECORDS_DIR_NAME)}`,
		`PromptDir: ${PROMPT_DIR}`,
		`Mode: ${mode}`,
		`KnownProjects: ${listKnownProjects().join(",")}`,
	].join("\n");
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
