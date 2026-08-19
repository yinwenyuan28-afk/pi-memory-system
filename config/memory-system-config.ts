/**
 * memory-system-model.json 公共读取模块（2026-08-19）。
 *
 * 定位：本扩展所有模型配置的单一集合文件（JSON 数组，每项带 type 字段）。
 * 位置：{profilePath}/memoryDB/config/memory-system-model.json（profile 级）
 *
 * 格式：每行一个 JSON 对象，`type` 字段区分用途：
 *   {"type":"llm","provider":"opencode-go","modelId":"mimo-v2.5"}
 *   {"type":"embedding","apiKey":"sk-xxx","url":"https://...","model":"qwen3.7-text-embedding","dimensions":1024}
 *
 * 消费者：model-config.ts（type=llm）、embedding/config.ts（type=embedding）。
 * 子代理进程独立读（不通过 globalThis 桥接），各进程自行解析本文件。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 配置文件相对 profile 的目录。 */
const CONFIG_DIR = join("memoryDB", "config");
/** 配置文件名。 */
export const MEMORY_SYSTEM_MODEL_FILE = "memory-system-model.json";

/** 单条条目：type 区分用途，其余字段按条目类型约定。 */
export type MemorySystemModelEntry = Record<string, unknown>;

/**
 * 配置文件绝对路径。
 *
 * @param profilePath profile 根目录（如 ~/.pi/agent/profiles/default）
 */
export function getMemorySystemConfigPath(profilePath: string): string {
	return join(profilePath, CONFIG_DIR, MEMORY_SYSTEM_MODEL_FILE);
}

/**
 * 读取全部条目。文件不存在返回空数组。
 *
 * 格式：标准 JSON 数组 `[{"type":"llm",...},{"type":"embedding",...}]`；
 * 兼容旧 JSONL（每行一个对象）——数组解析失败时按行回退。
 */
export function readModelEntries(profilePath: string): MemorySystemModelEntry[] {
	const path = getMemorySystemConfigPath(profilePath);
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf-8");

	// 优先：标准 JSON 数组
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.filter(
				(e): e is MemorySystemModelEntry => e !== null && typeof e === "object",
			);
		}
	} catch {
		// 非标准 JSON（如历史 jsonl 残留）→ 按行回退
	}

	const entries: MemorySystemModelEntry[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed !== null && typeof parsed === "object") {
				entries.push(parsed as MemorySystemModelEntry);
			}
		} catch {
			// 坏行跳过，不阻塞其它条目
		}
	}
	return entries;
}

/**
 * 按 type 取第一条匹配条目。
 *
 * @param type 条目类型（"llm" / "embedding" 等）
 * @returns 条目对象；无匹配返回 null
 */
export function readModelEntry(profilePath: string, type: string): MemorySystemModelEntry | null {
	return readModelEntries(profilePath).find((e) => e.type === type) ?? null;
}
