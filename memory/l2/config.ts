import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { L2_CURSOR_FILE as PATHS_L2_CURSOR, L2_SCENE_DIR, L2_SCENE_INDEX_PATH, MEMORY_DB_DIR } from "../paths.js";

// ══════════════════════════════════════════════════════════════
//  L2 配置 / 游标 / 任务构造（纯函数，无 pi 依赖，可单测）
// ══════════════════════════════════════════════════════════════

/** L1 提交多少批后触发一次 L2（用户拍板攒批）。 */
export const L2_BATCH = 3;
/** 子代理超时（场景组织多步 read + 组织决策，放宽到 10 分钟）。 */
export const L2_SUBAGENT_TIMEOUT_MS = 600_000;
/** 场景数量上限（腾讯默认）。 */
export const MAX_SCENES = 15;

/** L2 游标文件名（lastRecordId）。 */
export const L2_CURSOR_FILE = PATHS_L2_CURSOR;
/** 场景文件目录名（{memoryDB}/scene_blocks）。 */
export const SCENE_DIR_NAME = L2_SCENE_DIR;
/** 场景索引路径（{memoryDB}/.metadata/scene_index.json）。 */
export const SCENE_INDEX_PATH = L2_SCENE_INDEX_PATH;

/** 规则文件目录（本模块同目录下的 prompts/）。 */
export const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

/** 读取 L2 游标 lastRecordId（字符串；无则空串）。 */
export function loadL2Cursor(profilePath: string): string {
	const filePath = join(profilePath, MEMORY_DB_DIR, L2_CURSOR_FILE);
	if (!existsSync(filePath)) return "";
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as { lastRecordId?: string };
		return typeof data.lastRecordId === "string" ? data.lastRecordId : "";
	} catch {
		return "";
	}
}

/** 构造 l2-scene-organizer 子代理任务消息。 */
export function buildL2Task(profilePath: string): string {
	// 枚举 records 下实际 JSONL 分片文件清单（子代理不需猜测 / 试错日期）——08-17 实测
	// l2-scene-organizer 子代理默认不知道 records 分片命名格式，枚举列出避免它反复试日期。
	const recordsDir = join(profilePath, MEMORY_DB_DIR, "records");
	const recordsFiles = existsSync(recordsDir)
		? readdirSync(recordsDir).filter((f) => /\.jsonl$/.test(f)).sort()
		: [];
	return [
		"L2 organization task",
		`RecordsDir: ${recordsDir}`,
		`RecordsFiles: ${recordsFiles.join(",") || "(none)"}`,
		`SceneDir: ${join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME)}`,
		`IndexPath: ${join(profilePath, MEMORY_DB_DIR, SCENE_INDEX_PATH)}`,
		`CursorPath: ${join(profilePath, MEMORY_DB_DIR, L2_CURSOR_FILE)}`,
		`PromptDir: ${PROMPT_DIR}`,
	].join("\n");
}
