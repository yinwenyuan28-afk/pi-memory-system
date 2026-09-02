// ============================================================================
// memory/stats/l1-hit-stats-db.ts — L1 命中统计数据库层
//
// 记录每条 L1 原子记忆（record_id）的召回评估指标：
//   - hits：命中次数（被 agent 面向召回的次数）
//       · agent loop 启动时的自动注入（未来启用时应走 recallL1Records）
//       · agent 运行时主动 recall（recall_l1_records 工具）
//   - invalid_hits：无效命中次数
//       被召回后，LLM 判定「无参考价值」、由 clear_invalid_l1_records 工具（已实现）从上下文移除时标记。
//   - effective_hits：有效命中次数 = hits - invalid_hits（同事务维护，永不为负）
//
// 存储：{profile}/memoryDB/l1-hit-stats.sqlite
//   技术：node:sqlite 内置 DatabaseSync（零原生依赖，与 workflow/db.ts 同款）
//         WAL + busy_timeout 应对多进程并发写（后台子代理 + 主代理）
//   与 vector-store 的 l1-vectors.sqlite（better-sqlite3 + sqlite-vec）物理隔离，互不干扰。
//
// 计数语义（契约）：
//   - 命中：recallL1Records() 成功返回召回 record 后，每条 record_id 调 recordHits(+1)。
//       仅 agent 面向召回计数；embed_and_search（l1-extractor 去重）不调用 recallL1Records，不计数。
//   - 无效命中：clear_invalid_l1_records 工具（已实现）把某 record 从上下文移除时，调 recordInvalid(+1)。
//       约定：每次清除调用一次 recordInvalid(record_id)，使 invalid_hits 与一次 prior hits 对应。
// ============================================================================

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../paths.js";
import { loadActiveDayKeys } from "../l1/active-days.js";

/** 单条 L1 命中统计 */
export interface L1HitStat {
  recordId: string;
  /** 命中次数（被召回次数 = injectHits + toolHits） */
  hits: number;
  /** 自动注入路径命中次数（2026-09-02 起区分两条召回路径） */
  injectHits: number;
  /** 工具召回路径命中次数 */
  toolHits: number;
  /** 无效命中次数（召回后被判定无参考价值并清除） */
  invalidHits: number;
  /** 有效命中次数 = hits - invalid_hits（永不为负） */
  effectiveHits: number;
  /** 最近一次召回时间（ISO8601） */
  lastHitAt: string | null;
  /** 最近一次无效命中时间（ISO8601） */
  lastInvalidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS l1_hit_stats (
  record_id       TEXT PRIMARY KEY,
  hits            INTEGER NOT NULL DEFAULT 0,
  inject_hits     INTEGER NOT NULL DEFAULT 0,
  tool_hits       INTEGER NOT NULL DEFAULT 0,
  invalid_hits    INTEGER NOT NULL DEFAULT 0,
  effective_hits  INTEGER NOT NULL DEFAULT 0,
  last_hit_at     TEXT,
  last_invalid_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_l1_hit_effective
  ON l1_hit_stats(effective_hits DESC, hits DESC);
`;

interface Row {
  record_id: string;
  hits: number;
  inject_hits?: number;
  tool_hits?: number;
  invalid_hits: number;
  effective_hits: number;
  last_hit_at: string | null;
  last_invalid_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: Row): L1HitStat {
  return {
    recordId: r.record_id,
    hits: r.hits,
    injectHits: r.inject_hits ?? 0,
    toolHits: r.tool_hits ?? 0,
    invalidHits: r.invalid_hits,
    effectiveHits: r.effective_hits,
    lastHitAt: r.last_hit_at,
    lastInvalidAt: r.last_invalid_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 命中来源（区分自动注入 / 工具召回两条路径） */
export type HitSource = "inject" | "tool";

/**
 * L1HitStatsDB — L1 命中统计库（node:sqlite）
 *
 * @param profilePath 活动 profile 根目录（l1-hit-stats.sqlite 存于其 memoryDB/ 下）
 */
export class L1HitStatsDB {
  private db: DatabaseSync;
  private dbPath: string;
  private profilePath: string;

  constructor(profilePath: string) {
    const memDir = join(profilePath, MEMORY_DB_DIR);
    mkdirSync(memDir, { recursive: true });
    this.dbPath = join(memDir, "l1-hit-stats.sqlite");
    this.profilePath = profilePath;
    this.db = new DatabaseSync(this.dbPath);
    // WAL + busy_timeout：多进程并发写（后台子代理 + 主代理）安全
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA_SQL);
    // 存量库迁移：2026-09-02 起区分 inject/tool 命中来源。
    // CREATE TABLE IF NOT EXISTS 不会给已有表加列，需显式 ALTER（node:sqlite 下用 pragma_table_info 检测）。
    this.ensureSourceColumns();
    // 会话内首次拿到实例时刷新一次侧车：即使用户这轮没召回任何记忆，
    // 新产生的活跃日也会被写进侧车，records-viewer 的衰减时钟不会滞后。
    this.exportSidecar();
  }

  /** 迁移：给存量 l1_hit_stats 表补 inject_hits / tool_hits 列（幂等）。 */
  private ensureSourceColumns(): void {
    try {
      const cols = this.db
        .prepare("SELECT name FROM pragma_table_info('l1_hit_stats')")
        .all() as Array<{ name: string }>;
      const has = new Set(cols.map((c) => c.name));
      if (!has.has("inject_hits")) {
        this.db.exec("ALTER TABLE l1_hit_stats ADD COLUMN inject_hits INTEGER NOT NULL DEFAULT 0");
      }
      if (!has.has("tool_hits")) {
        this.db.exec("ALTER TABLE l1_hit_stats ADD COLUMN tool_hits INTEGER NOT NULL DEFAULT 0");
      }
    } catch {
      // 迁移失败不阻塞主流程（新库由 SCHEMA_SQL 直接建出两列）
    }
  }

  /**
   * 导出 JSON 侧车供 records-viewer.html 直接 fetch（file:// 可用）
   *
   * 结构：`{ generatedAt, activeDays, stats }`。activeDays 是活跃会话日（YYYY-MM-DD），
   * 供前端按与 quality.ts 一致的「活跃日时钟」计算 decay——前端跑在 file:// 下列不了
   * l0-conversations 目录，只能由后端喂。
   */
  private exportSidecar(): void {
    try {
      const rows = this.db.prepare("SELECT * FROM l1_hit_stats").all() as Row[];
      const jsonPath = this.dbPath.replace(/\.sqlite$/, ".json");
      const payload = {
        generatedAt: new Date().toISOString(),
        activeDays: loadActiveDayKeys(this.profilePath) ?? [],
        stats: rows,
      };
      writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf-8");
    } catch {}
  }

  /**
   * 召回命中：每条 record_id 命中 +1（同一批内去重）
   * 在 recallL1Records() 返回成功召回的 record 后调用。
   *
   * @param source 命中来源（"inject" 自动注入 / "tool" 工具召回）。
   *               2026-09-02 起区分两条路径，分别计入 inject_hits / tool_hits；
   *               未传 source（历史调用点）只加 hits，向后兼容。
   */
  recordHits(recordIds: string[], source?: HitSource): void {
    const ids = [...new Set(recordIds)].filter(Boolean);
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const injectDelta = source === "inject" ? 1 : 0;
    const toolDelta = source === "tool" ? 1 : 0;
    const insert = this.db.prepare(
      `INSERT INTO l1_hit_stats
         (record_id, hits, inject_hits, tool_hits, effective_hits, created_at, updated_at, last_hit_at)
       VALUES (?, 1, ${injectDelta}, ${toolDelta}, 1, ?, ?, ?)
       ON CONFLICT(record_id) DO UPDATE SET
         hits = l1_hit_stats.hits + 1,
         inject_hits = l1_hit_stats.inject_hits + ${injectDelta},
         tool_hits = l1_hit_stats.tool_hits + ${toolDelta},
         effective_hits = l1_hit_stats.hits + 1 - l1_hit_stats.invalid_hits,
         last_hit_at = excluded.last_hit_at,
         updated_at = excluded.updated_at`,
    );
    // node:sqlite(22.22) 无 db.transaction，用显式事务包裹
    this.db.exec("BEGIN");
    try {
      for (const id of ids) insert.run(id, now, now, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.exportSidecar();
  }

  /**
   * 无效命中：LLM 判定无参考价值并清除时调用，invalid_hits +1。
   * invalid_hits 钳制到 hits（不会超过已命中次数），effective_hits 同步重算。
   */
  recordInvalid(recordId: string): void {
    if (!recordId) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO l1_hit_stats (record_id, hits, invalid_hits, effective_hits, created_at, updated_at, last_invalid_at)
       VALUES (?, 0, 1, 0, ?, ?, ?)
       ON CONFLICT(record_id) DO UPDATE SET
         invalid_hits = MIN(l1_hit_stats.invalid_hits + 1, l1_hit_stats.hits),
         effective_hits = l1_hit_stats.hits - MIN(l1_hit_stats.invalid_hits + 1, l1_hit_stats.hits),
         last_invalid_at = excluded.last_invalid_at,
         updated_at = excluded.updated_at`,
    );
    stmt.run(recordId, now, now, now);
    this.exportSidecar();
  }

  /** 读取单条统计 */
  getStats(recordId: string): L1HitStat | undefined {
    const row = this.db
      .prepare("SELECT * FROM l1_hit_stats WHERE record_id = ?")
      .get(recordId) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** 读取全部（按有效命中降序，用于诊断） */
  getAllStats(): L1HitStat[] {
    const rows = this.db
      .prepare("SELECT * FROM l1_hit_stats ORDER BY effective_hits DESC, hits DESC")
      .all() as Row[];
    return rows.map(mapRow);
  }

  /** Top-K 有效命中（用于冷记忆降权 / 淘汰、重要性排序） */
  getTopEffective(limit = 50): L1HitStat[] {
    const rows = this.db
      .prepare("SELECT * FROM l1_hit_stats ORDER BY effective_hits DESC, hits DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(mapRow);
  }

  /** 数据库文件路径（调试/展示） */
  getPath(): string {
    return this.dbPath;
  }

  /** 关闭连接 */
  close(): void {
    try {
      this.db.close();
    } catch {
      // 已关闭则忽略
    }
  }
}

// ---------------------------------------------------------------------------
// 按 profile 的懒加载单例（profile 切换时旧实例应 closeL1HitStatsDB 后重建）
// ---------------------------------------------------------------------------

const instances = new Map<string, L1HitStatsDB>();

export function getL1HitStatsDB(profilePath?: string): L1HitStatsDB {
  const p = profilePath ?? process.env.PI_PROFILE_PATH ?? "";
  if (!p) throw new Error("L1HitStatsDB: profilePath 未提供且 PI_PROFILE_PATH 未设置");
  let db = instances.get(p);
  if (!db) {
    db = new L1HitStatsDB(p);
    instances.set(p, db);
  }
  return db;
}

export function closeL1HitStatsDB(profilePath?: string): void {
  const p = profilePath ?? process.env.PI_PROFILE_PATH ?? "";
  const db = instances.get(p);
  if (db) {
    db.close();
    instances.delete(p);
  }
}
