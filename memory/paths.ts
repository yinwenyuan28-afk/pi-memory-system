/**
 * 记忆系统数据路径中央常量（2026-08-17 重构）
 *
 * 背景：L0-L3 运行数据（conversations/ records/ scene_blocks/ 游标/配置）原本
 * 散落在 {profilePath} 根目录，与注入画像（MEMORY.md/USER.md）、sub-memories/、
 * skills/ 等混杂。统一收进 {profilePath}/memoryDB/ 子目录，一处定义、各模块引用。
 *
 * 边界（不归 memoryDB）：
 *   - MEMORY.md / USER.md：注入画像，保持根目录
 *   - sub-memories/ skills/ memory-index.json memory-save-log.jsonl：旧记忆系统
 *   - review-cursor.json：review 模块独立游标（非 L0-L2 产物）
 *
 * 用法：所有数据文件路径 = join(profilePath, MEMORY_DB_DIR, ...)
 */
import { join } from "node:path";

/** 统一数据目录名（{profilePath}/memoryDB）。 */
export const MEMORY_DB_DIR = "memoryDB";

/** L0 对话分片目录（{memoryDB}/l0-conversations）。 */
export const L0_CONVERSATIONS_DIR = "l0-conversations";
/** L0 游标文件名。 */
export const L0_CURSOR_FILE = "l0-cursor.json";

/** skill-feed 原料输出目录（{memoryDB}/skill-feed，按 session 一文件）。 */
export const SKILL_FEED_DIR = "skill-feed";
/** skill-feed 游标文件名（独立于 L0）。 */
export const SKILL_FEED_CURSOR_FILE = "skill-feed-cursor.json";

/** L1 记忆输出目录（{memoryDB}/l1-records）。 */
export const L1_RECORDS_DIR = "l1-records";
/** L1 游标文件名。 */
export const L1_CURSOR_FILE = "l1-cursor.json";
/** L1 模式配置文件名（chat/code）。 */
export const L1_CONFIG_FILE = "l1-config.json";

/** L2 场景文件目录（{memoryDB}/l2-scene-blocks）。 */
export const L2_SCENE_DIR = "l2-scene-blocks";
/** L2 场景索引路径（{memoryDB}/.metadata/scene_index.json）。 */
export const L2_SCENE_INDEX_PATH = join(".metadata", "scene_index.json");
/** L2 游标文件名。 */
export const L2_CURSOR_FILE = "l2-cursor.json";

/** L3 游标文件名。 */
export const L3_CURSOR_FILE = "l3-cursor.json";
