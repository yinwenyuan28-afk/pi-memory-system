import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SCENE_DIR_NAME, SCENE_INDEX_PATH } from "../l2/config.js";
import { loadL1Config, type L1Mode } from "../l1/config.js";
import { L3_CURSOR_FILE as PATHS_L3_CURSOR, MEMORY_DB_DIR } from "../paths.js";

/** P4 记忆阈值（L2 尚未稳定，高于腾讯默认 20）。 */
export const L3_INTERVAL = 30;
/** 子代理超时。 */
export const L3_SUBAGENT_TIMEOUT_MS = 600_000;
/** USER.md 字符硬限额（与 DEFAULT_USER_CHAR_LIMIT 一致）。 */
export const USER_CHAR_LIMIT = 1375;
/** code 模式软限额（对齐腾讯 Team Operating Doctrine 1200 字）。 */
export const CODE_PERSONA_CHAR_LIMIT = 1200;

export const L3_CURSOR_FILE = PATHS_L3_CURSOR;
export const USER_FILE = "USER.md";

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
}

export function defaultL3Cursor(): L3Cursor {
	return { lastPersonaUpdate: "", memoriesSinceLastPersona: 0, lastTriggeredAt: "" };
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
		};
	} catch {
		return defaultL3Cursor();
	}
}

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

export function readUserPersonaBody(profilePath: string): string {
	const filePath = join(profilePath, USER_FILE);
	if (!existsSync(filePath)) return "";
	try {
		return readFileSync(filePath, "utf-8").trim();
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
	const filenames = scenes.map((e) => e.filename).join(",");
	return [
		"L3 persona generation task",
		`ProfilePath: ${profilePath}`,
		`UserMdPath: ${join(profilePath, USER_FILE)}`,
		`CursorPath: ${join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE)}`,
		`SceneDir: ${join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME)}`,
		`IndexPath: ${join(profilePath, MEMORY_DB_DIR, SCENE_INDEX_PATH)}`,
		`PromptDir: ${PROMPT_DIR}`,
		`PromptFile: persona-generation-${mode}.md`,
		`ChangedScenes: ${filenames}`,
		`TriggerReason: ${triggerReason}`,
		`Mode: ${mode}`,
	].join("\n");
}
