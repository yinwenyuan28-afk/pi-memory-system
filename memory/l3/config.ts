import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE_DIR_NAME, SCENE_INDEX_PATH } from "../l2/config.ts";
import { loadL1Config, type L1Mode } from "../l1/config.ts";
import { L3_CURSOR_FILE as PATHS_L3_CURSOR, MEMORY_DB_DIR } from "../paths.ts";
import { DEFAULT_USER_CHAR_LIMIT } from "../core/types.ts";
import { SINGLE_ENTRY_CHAR_LIMIT } from "./entries.ts";
import { readUserFile, userFilePath, userTempFilePath } from "./user-file.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

/** P4 记忆阈值（L2 尚未稳定，高于腾讯默认 20）。 */
export const L3_INTERVAL = 30;
/** 子代理超时。 */
export const L3_SUBAGENT_TIMEOUT_MS = 600_000;
/**
 * USER.md 总长预算 —— 单源是 `core/types.ts`（用户 2026-09-16 拍板 1375 → 2200）。
 * 这里只是给 L3 模块一个本地名字，**不要**再写一遍字面量。
 */
export const USER_CHAR_LIMIT = DEFAULT_USER_CHAR_LIMIT;
/** 单条规则长度上限（见 `entries.ts` 的 SINGLE_ENTRY_CHAR_LIMIT；透出给任务消息）。 */
export const L3_ENTRY_CHAR_LIMIT = SINGLE_ENTRY_CHAR_LIMIT;
/** 连续失败多少次熔断自动触发（对齐 L1_FAILURE_THRESHOLD / L2_FAILURE_THRESHOLD = 3）。 */
export const L3_FAILURE_THRESHOLD = 3;

export const L3_CURSOR_FILE = PATHS_L3_CURSOR;

export const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

export interface SceneIndexEntry {
	filename: string;
	summary: string;
	heat: number;
	created: string;
	updated: string;
}

export interface L3Cursor {
	lastPersonaUpdate: string;
	memoriesSinceLastPersona: number;
	lastTriggeredAt: string;
	/**
	 * 最近一次 `l3_commit` 成功的时间戳（2026-09-16 新增）。
	 *
	 * 为什么要独立于 `lastTriggeredAt`：子代理"跑完但没提交"（超时/提示词卡住/模型抽风）
	 * 必须能被主进程识别为**失败**，否则每轮都会重试（见 `l3/index.ts` 的熔断）。
	 * 用 `lastPersonaUpdate` 判不出这件事 —— force 触发时它可能等于提交前后的同一个值。
	 */
	lastCommittedAt: string;
}

export function defaultL3Cursor(): L3Cursor {
	return { lastPersonaUpdate: "", memoriesSinceLastPersona: 0, lastTriggeredAt: "", lastCommittedAt: "" };
}

export function loadL3Cursor(profilePath: string): L3Cursor {
	const filePath = join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE);
	if (!existsSync(filePath)) return defaultL3Cursor();
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<L3Cursor>;
		return {
			lastPersonaUpdate: typeof data.lastPersonaUpdate === "string" ? data.lastPersonaUpdate : "",
			memoriesSinceLastPersona:
				typeof data.memoriesSinceLastPersona === "number" ? data.memoriesSinceLastPersona : 0,
			lastTriggeredAt: typeof data.lastTriggeredAt === "string" ? data.lastTriggeredAt : "",
			lastCommittedAt: typeof data.lastCommittedAt === "string" ? data.lastCommittedAt : "",
		};
	} catch {
		return defaultL3Cursor();
	}
}

/** 原子写 L3 游标（写失败静默降级，非关键路径）。 */
export function saveL3Cursor(profilePath: string, cursor: L3Cursor): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE);
	try {
		const dir = join(filePath, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const tmpPath = join(dir, `.tmp_l3c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
		writeFileSync(tmpPath, JSON.stringify(cursor, null, 2), "utf-8");
		renameSync(tmpPath, filePath);
	} catch {
		// 游标非关键：失败不阻塞提交
	}
}

// ── 跨进程触发信号 ──────────────────────────────────────────
// 实现与语义在 ./signal.ts（刻意只依赖 paths.ts，供 l2/commit-tool 直接引用而不产生层间纠缠）。
export { writePendingTrigger, consumePendingTrigger, type L3PendingTrigger } from "./signal.ts";

export function readSceneIndex(profilePath: string): SceneIndexEntry[] {
	const idxPath = join(profilePath, MEMORY_DB_DIR, SCENE_INDEX_PATH);
	if (!existsSync(idxPath)) return [];
	try {
		const data = JSON.parse(readFileSync(idxPath, "utf-8"));
		return Array.isArray(data) ? (data as SceneIndexEntry[]) : [];
	} catch {
		return [];
	}
}

/**
 * live USER.md 的正文（**注入侧口径**，与 `core/store.ts` 读的是同一份文件）。
 *
 * 注意与 L3 的落盘目标区分：2026-09-28 起 L3 写的是 `USER-temp.md`（提议稿），本函数**不是**
 * 在读提议稿 —— 它回答的是"注入进 system prompt 的画像现在长什么样"，冷启动/恢复门控
 * （`trigger.ts` 的 P2/P2.5/P3）与"用户是否已并入"都该按这个口径判。
 */
export function readUserPersonaBody(profilePath: string): string {
	try {
		return (readUserFile(profilePath) ?? "").trim();
	} catch {
		return "";
	}
}

export function hasPersonaBody(profilePath: string): boolean {
	return readUserPersonaBody(profilePath).length > 0;
}

export function hasSceneFiles(profilePath: string): boolean {
	const sceneDir = join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME);
	if (!existsSync(sceneDir)) return false;
	try {
		return readdirSync(sceneDir).some((f) => f.endsWith(".md"));
	} catch {
		return false;
	}
}

/** 自 lastPersonaUpdate 以来 updated 变化的场景。 */
export function getChangedScenes(profilePath: string, lastPersonaUpdate: string): SceneIndexEntry[] {
	const index = readSceneIndex(profilePath);
	if (!lastPersonaUpdate) return index;
	const personaMs = new Date(lastPersonaUpdate).getTime();
	return index.filter((e) => {
		const updatedMs = new Date(e.updated).getTime();
		if (Number.isNaN(updatedMs) || Number.isNaN(personaMs)) return true;
		return updatedMs > personaMs;
	});
}

/** 构造 l3-persona-generator 子代理任务消息。Mode 与 L1 配置（/l1-mode）同步。 */
export function buildL3Task(profilePath: string, triggerReason: string, changedScenes: SceneIndexEntry[]): string | null {
	const scenes = changedScenes.length > 0 ? changedScenes : readSceneIndex(profilePath);
	if (scenes.length === 0) return null;
	const mode: L1Mode = loadL1Config(profilePath).mode;
	return renderPrompt("tasks/l3-task", {
		profilePath,
		// live 画像：**只读**，用于去重（条目已在正式画像里就不要重复提）
		userMdPath: userFilePath(profilePath),
		// 落盘目标：L3 的工作副本 / 提议稿，l3_edit 改的是它（首次写盘时以 live 播种）
		userTempMdPath: userTempFilePath(profilePath),
		cursorPath: join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE),
		sceneDir: join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME),
		indexPath: join(profilePath, MEMORY_DB_DIR, SCENE_INDEX_PATH),
		promptDir: PROMPT_DIR,
		promptFile: `persona-generation-${mode}.md`,
		changedScenes: scenes.map((e) => e.filename).join(","),
		triggerReason,
		mode,
		charLimit: String(USER_CHAR_LIMIT),
		entryCharLimit: String(L3_ENTRY_CHAR_LIMIT),
	});
}
