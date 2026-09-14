/**
 * 记忆系统数据路径中央常量
 *
 * 背景（2026-08-17 首次收束）：L0-L3 运行数据原本散落在 {profilePath} 根目录，
 * 与注入画像（MEMORY.md/USER.md）、sub-memories/、skills/ 等混杂，统一收进
 * {profilePath}/memoryDB/ 一处定义、各模块引用。
 *
 * 2026-09-14 二次重整（方案 A · 分层重排）：memoryDB 内部从「扁平混排」改为按层分组——
 * 游标与所属层同处、散件（stats / viewer / backup）各自归目录。目标布局：
 *
 *   memoryDB/
 *   ├── config/                              （统一配置中心，见 config/app-config）
 *   ├── l0/{conversations/, cursor.json}
 *   ├── l1/{records/, cursor.json, anchor-log.jsonl, hit-stats.sqlite, hit-stats.json}
 *   ├── l2/{scene-blocks/, cursor.json, index/{scene_index.json, scene_members.json}}
 *   ├── l3/{cursor.json}
 *   ├── skill/{feed/, cursor.json}
 *   ├── search/vectors/                      （l1-vectors.sqlite）
 *   ├── pipeline/jobs.sqlite
 *   ├── state/failure-state.json
 *   ├── viewers/                             （records-viewer.html / vue-viewer/）
 *   └── backups/{l1-admin/, user-backups/}
 *
 * 边界（不归 memoryDB）：
 *   - MEMORY.md / USER.md：注入画像，保持 profile 根目录
 *   - sub-memories/ skills/ memory-index.json memory-save-log.jsonl：旧记忆系统
 *   - review-cursor.json：review 模块独立游标（非 L0-L2 产物）
 *
 * 用法：所有数据文件路径 = join(profilePath, MEMORY_DB_DIR, <常量>)
 *       —— 常量值可为**多段相对路径**，`join` 会自动拼斜杠，调用点无需感知层级。
 */
import { join } from "node:path";

/** 统一数据目录名（{profilePath}/memoryDB）。 */
export const MEMORY_DB_DIR = "memoryDB";

// ── L0 对话分片 ─────────────────────────────────────────────
/** L0 对话分片目录（{memoryDB}/l0/conversations）。 */
export const L0_CONVERSATIONS_DIR = join("l0", "conversations");
/** L0 游标文件（{memoryDB}/l0/cursor.json）。 */
export const L0_CURSOR_FILE = join("l0", "cursor.json");

// ── L1 原子记忆 ─────────────────────────────────────────────
/** L1 记忆输出目录（{memoryDB}/l1/records）。 */
export const L1_RECORDS_DIR = join("l1", "records");
/** L1 游标文件（{memoryDB}/l1/cursor.json）。 */
export const L1_CURSOR_FILE = join("l1", "cursor.json");
/** L1 情境锚点注入日志（{memoryDB}/l1/anchor-log.jsonl）。 */
export const L1_ANCHOR_LOG_FILE = join("l1", "anchor-log.jsonl");
/** L1 命中统计 sqlite（{memoryDB}/l1/hit-stats.sqlite）。 */
export const L1_HIT_STATS_SQLITE = join("l1", "hit-stats.sqlite");
/** L1 命中统计 JSON 侧车（{memoryDB}/l1/hit-stats.json，供 records-viewer.html fetch）。 */
export const L1_HIT_STATS_JSON = join("l1", "hit-stats.json");

// ── L2 场景 ────────────────────────────────────────────────
/** L2 场景块目录（{memoryDB}/l2/scene-blocks）。 */
export const L2_SCENE_DIR = join("l2", "scene-blocks");
/** L2 游标文件（{memoryDB}/l2/cursor.json）。 */
export const L2_CURSOR_FILE = join("l2", "cursor.json");
/** L2 索引目录（{memoryDB}/l2/index）。 */
export const L2_INDEX_DIR = join("l2", "index");
/** L2 场景索引（{memoryDB}/l2/index/scene_index.json；由 syncSceneIndex() 全量重建）。 */
export const L2_SCENE_INDEX_PATH = join("l2", "index", "scene_index.json");
/**
 * L2 场景块 → 成员 L1 记录 id 的 sidecar（{memoryDB}/l2/index/scene_members.json）。
 *
 * 为什么不直接写进 `scene_index.json`：该索引由 `syncSceneIndex()` 在每次提交后**从块文件全量重建**，
 * 任何只存在于索引里的字段都会在下次重建时丢失。所以成员清单需要独立的持久化载体，由
 * `syncSceneIndex()` 读取并并进索引条目 —— 对外表现仍是"成员的机读入口在索引里"，块文件保持轻量。
 */
export const L2_SCENE_MEMBERS_PATH = join("l2", "index", "scene_members.json");

// ── L3 画像 ────────────────────────────────────────────────
/** L3 游标文件（{memoryDB}/l3/cursor.json）。 */
export const L3_CURSOR_FILE = join("l3", "cursor.json");

// ── skill-feed ─────────────────────────────────────────────
/** skill-feed 原料输出目录（{memoryDB}/skill/feed，按 session 一文件）。 */
export const SKILL_FEED_DIR = join("skill", "feed");
/** skill-feed 游标文件（{memoryDB}/skill/cursor.json，独立于 L0）。 */
export const SKILL_FEED_CURSOR_FILE = join("skill", "cursor.json");

// ── 检索 / 流水线 / 状态 ────────────────────────────────────
/** 向量库目录（{memoryDB}/search/vectors，内含 l1-vectors.sqlite）。 */
export const VECTORS_DIR = join("search", "vectors");
/** L1/L2 流水线 job 队列（{memoryDB}/pipeline/jobs.sqlite）。 */
export const PIPELINE_JOBS_FILE = join("pipeline", "jobs.sqlite");
/** 各层失败状态（{memoryDB}/state/failure-state.json）。 */
export const FAILURE_STATE_FILE = join("state", "failure-state.json");

// ── viewer / 备份 ──────────────────────────────────────────
/** 查看器目录（{memoryDB}/viewers：records-viewer.html / vue-viewer/）。 */
export const VIEWER_DIR = "viewers";
/** 备份目录（{memoryDB}/backups：l1-admin/ 与 user-backups/）。 */
export const BACKUP_DIR = "backups";
