import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { decodeCwdFromSessionPath } from "../l0/index.ts";
import { L1_ANCHOR_LOG_FILE, L1_CURSOR_FILE, L1_RECORDS_DIR, L0_CONVERSATIONS_DIR, MEMORY_DB_DIR } from "../paths.ts";
import { loadAppProps, saveAppSection } from "../../config/app-config.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

// ══════════════════════════════════════════════════════════════
//  L1 配置 / 游标 / 分片清单（纯函数，无 pi 依赖，可单测）
// ══════════════════════════════════════════════════════════════

/** 触发间隔：每 N 轮用户消息启动一次 L1 提取。 */
export const L1_INTERVAL = 10;
/** 子代理超时（L1 每轮只提取 ≤10 条，3 分钟足够；原 10 分钟过长，hung 子代理会长期占锁）。 */
export const SUBAGENT_TIMEOUT_MS = 180_000;
/** 连续失败多少次后熔断（暂停自动提取并通知用户）。 */
export const L1_FAILURE_THRESHOLD = 3;
/** 注入子代理任务消息的近期情境候选上限（跨批次复用 scene_name 用）。 */
export const RECENT_SCENE_LIMIT = 15;
/** 情境锚点扫描窗口（天）：与 loadAllL1Records 的窗口一致，避免无界同步读。 */
export const SCENE_LOOKBACK_DAYS = 30;
/** 锚点注入日志文件名——复用率度量的**分母口径**（每次提取提供了哪些候选）。 */
export const ANCHOR_LOG_FILE = L1_ANCHOR_LOG_FILE; // 单一来源见 paths.ts（2026-09-14 收束）
/** 锚点日志体积上限（超出则保留最后 500 条重写，避免无界增长）。 */
export const ANCHOR_LOG_MAX_BYTES = 1024 * 1024;

/** 配置文件名（mode 持久化）。 */
export const CONFIG_FILE = "l1-config.json"; // [DEPRECATED 2026-09-14] 旧独立配置文件已迁入 config/application-propertis.json；本常量仅作 loadL1Config 的迁移期兜底（文件实际已不存在）
/** 游标文件名（全局 lastRecordedAt，子代理回写）。 */
export const CURSOR_FILE = L1_CURSOR_FILE; // 单一来源见 paths.ts（2026-09-14 收束）
/** L0 分片目录名（{profilePath}/memoryDB/l0-conversations，单一来源见 paths.ts）。 */
export const L0_DIR_NAME = L0_CONVERSATIONS_DIR;
/** L1 记忆输出目录名（{profilePath}/memoryDB/l1-records，单一来源见 paths.ts）。 */
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

/** 情境锚点：上一批情境名 + 近期候选（各带 cwd）。 */
export interface SceneAnchor {
	/** 最后一条存活记录（全局追加序最大）的情境名与 cwd；无候选时为 null。 */
	previous: { name: string; cwd: string } | null;
	/** 近期情境候选（按追加序倒序去重、同 cwd 优先，≤limit 条）。 */
	recent: { name: string; cwd: string }[];
}

/**
 * 读取 L1 情境锚点——供子代理跨批次复用同一 `scene_name`（原设计靠提示词头部的
 * `{previous_scene_name}` 占位符，但主进程从未填充，自迁移起一直是死模板）。
 *
 * **排序依据是「全局追加序」，不是 `createdAt`/`updatedAt`**：后两者由子代理自填，
 * 粒度参差、同批大面积并列、个别缺失（实测 277 行中 57% 毫秒恰为 `.000`），
 * 无法作为次序依据。追加序 = 分片文件名升序 + 行序——两者都由代码生成。
 *
 * **存活判定用「同 id 最后一次写入」（last-write-wins），不读 `deleted` 字段**：
 * update/merge 的标记行与普通记录一样落在「提交当日」分片（见 `l1/commit-tool.ts`），
 * 只看单行的 `deleted` 会把「已被取代」的旧行当成存活记录（实测 7 个 id 存在双行）。
 *
 * 任何异常都降级为「无候选」，不抛错、不阻塞提取。
 */
export function readRecentSceneContext(
	profilePath: string,
	limit = RECENT_SCENE_LIMIT,
	currentCwd = process.cwd(),
): SceneAnchor {
	const empty: SceneAnchor = { previous: null, recent: [] };
	const recordsDir = join(profilePath, MEMORY_DB_DIR, RECORDS_DIR_NAME);
	if (!existsSync(recordsDir)) return empty;

	let files: string[];
	try {
		// 白名单：只要 YYYY-MM-DD.jsonl，排除 backup-*.zip 之类无关文件
		files = readdirSync(recordsDir)
			.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
			.sort();
	} catch {
		return empty;
	}
	// 扫描窗口：文件名前缀即本地日期，直接做字符串比较
	const cutoff = new Date(Date.now() - SCENE_LOOKBACK_DAYS * 86_400_000);
	const cutoffDate = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
	files = files.filter((f) => f.slice(0, 10) >= cutoffDate);

	// 按文件升序 + 行序逐行递增全局追加序；同 id 后写覆盖前写
	const byId = new Map<string, { seq: number; deleted: boolean; name: string; cwd: string }>();
	let seq = 0;
	for (const f of files) {
		let text: string;
		try {
			text = readFileSync(join(recordsDir, f), "utf-8");
		} catch {
			continue;
		}
		for (const line of text.split(/\r?\n/)) {
			const t = line.trim();
			if (!t) continue;
			let o: { id?: unknown; deleted?: unknown; scene_name?: unknown; cwd?: unknown };
			try {
				o = JSON.parse(t) as typeof o;
			} catch {
				continue;
			}
			if (typeof o.id !== "string") continue;
			byId.set(o.id, {
				seq: seq++,
				deleted: o.deleted === true,
				// 场景名折叠换行，避免破坏任务消息的一行一候选格式
				name: typeof o.scene_name === "string" ? o.scene_name.replace(/\s+/g, " ").trim() : "",
				cwd: typeof o.cwd === "string" ? o.cwd : "",
			});
		}
	}

	const alive = [...byId.values()].filter((r) => !r.deleted && r.name).sort((a, b) => a.seq - b.seq);
	if (alive.length === 0) return empty;

	// 倒序取 distinct 名字（近者优先），再稳定地把同 cwd 的排到前面
	const seen = new Set<string>();
	const picked: { name: string; cwd: string }[] = [];
	for (let i = alive.length - 1; i >= 0 && picked.length < limit; i--) {
		const r = alive[i];
		if (seen.has(r.name)) continue;
		seen.add(r.name);
		picked.push({ name: r.name, cwd: r.cwd });
	}
	const last = alive[alive.length - 1];
	return {
		previous: { name: last.name, cwd: last.cwd },
		recent: currentCwd
			? [...picked.filter((p) => p.cwd === currentCwd), ...picked.filter((p) => p.cwd !== currentCwd)]
			: picked,
	};
}

/**
 * 追加一条锚点注入日志（`memoryDB/l1-anchor-log.jsonl`）。
 *
 * 存在的唯一理由：**复用率指标需要分母**——新记录是否复用了情境名，判定基准是
 * 「本次提取实际提供了哪些候选」，而这只能记录在注入时刻。没有它，指标只能靠估算。
 * 日志写入失败一律吞掉，绝不阻塞提取。
 */
export function appendAnchorLog(profilePath: string, anchor: SceneAnchor): void {
	try {
		const file = join(profilePath, MEMORY_DB_DIR, ANCHOR_LOG_FILE);
		const entry = JSON.stringify({ at: new Date().toISOString(), previous: anchor.previous, recent: anchor.recent });
		if (existsSync(file) && statSync(file).size > ANCHOR_LOG_MAX_BYTES) {
			const kept = readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean).slice(-500);
			writeFileSync(file, `${kept.join("\n")}\n${entry}\n`, "utf-8");
			return;
		}
		appendFileSync(file, `${entry}\n`, "utf-8");
	} catch {
		// 日志失败不影响提取
	}
}

/** 构造 l1-extractor 子代理任务消息（供 setupL1Extractor 与手动触发共用）。
 *  模板：prompts/tasks/l1-task.md（registry 单源；anchorLines 为情境锚点块的预拼行，
 *  属数据整形逻辑，留在代码侧——模板只管骨架与字段契约）。 */
export function buildL1Task(profilePath: string): string | null {
	const cursor = loadL1Cursor(profilePath);
	const l0Files = listL0Files(profilePath, cursor);
	if (l0Files.length === 0) return null;
	const mode = loadL1Config(profilePath).mode;
	const anchor = readRecentSceneContext(profilePath);
	appendAnchorLog(profilePath, anchor);
	const anchorLines = (anchor.previous
		? [
				`PreviousScene: ${anchor.previous.name} | cwd=${anchor.previous.cwd}`,
				...(anchor.recent.length > 0
					? [
							"RecentScenes (latest first, same-cwd first):",
							...anchor.recent.map((r) => `- ${r.name} | cwd=${r.cwd}`),
						]
					: ["RecentScenes: (无)"]),
			]
		: ["PreviousScene: (无)", "RecentScenes: (无)"]).join("\n");
	return renderPrompt("tasks/l1-task", {
		l0Files: l0Files.join(","),
		cursorPath: join(profilePath, MEMORY_DB_DIR, CURSOR_FILE),
		recordsDir: join(profilePath, MEMORY_DB_DIR, RECORDS_DIR_NAME),
		promptDir: PROMPT_DIR,
		mode,
		knownProjects: listKnownProjects().join(","),
		anchorLines,
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
