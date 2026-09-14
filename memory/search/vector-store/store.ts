/**
 * sqlite-vec vector store 实现
 *
 * 存储 L1 records 的 embedding 向量
 * 位置：{profile}/memoryDB/.vectors/l1-vectors.sqlite
 *
 * ⚠️ POC 发现（2026-08-18）：
 * - sqlite-vec v0.1.9 vec0 虚拟表**不支持 prepared statement 参数绑定**
 * - 所有操作必须用 db.exec() + vec_f32() SQL 直接执行
 *
 * 数据模型：
 * - l1_vectors（vec0 虚拟表）：rowid(自增整数) + embedding(float[1024])
 * - l1_vector_index（辅助表）：rowid(自增整数) + record_id(TEXT UNIQUE)
 *   - record_id → rowid 映射（插入时分配 rowid，搜索后反查 recordId）
 *   - rowid → record_id 反向映射（搜索结果用）
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { loadEmbeddingConfig } from "../embedding/config.ts";

/** 搜索结果 hit */
export interface VectorHit {
  recordId: string;
  score: number;    // cosine similarity = 1 - distance
  distance: number; // 原始 cosine distance
}

/** VectorStore 接口 */
export interface VectorStore {
  insert(recordId: string, vector: number[]): Promise<void>;
  insertBatch(records: Array<{ recordId: string; vector: number[] }>): Promise<void>;
  delete(recordId: string): Promise<void>;
  deleteBatch(recordIds: string[]): Promise<void>;
  search(queryVector: number[], topK: number): Promise<VectorHit[]>;
  count(): Promise<number>;
  isAvailable(): Promise<boolean>;
  /** 返回所有已向量化的 record_id 列表（供 /vectorize-list 命令使用） */
  getAllVectorizedRecordIds(): Promise<string[]>;
  close(): void;
}

/** 全局单例 */
let storeInstance: VectorStore | null = null;

/**
 * 获取 VectorStore 实例（懒加载）
 */
export async function getVectorStore(profilePath?: string): Promise<VectorStore> {
  if (storeInstance) return storeInstance;

  const baseProfilePath = profilePath ?? process.env.PI_PROFILE_PATH ?? "";
  const vectorsDir = join(baseProfilePath, "memoryDB", ".vectors");

  if (!existsSync(vectorsDir)) {
    mkdirSync(vectorsDir, { recursive: true });
  }

  storeInstance = await createSqliteVecStore(vectorsDir);
  return storeInstance;
}

/**
 * 创建 sqlite-vec vector store
 */
async function createSqliteVecStore(vectorsDir: string): Promise<VectorStore> {
  const Database = (await import("better-sqlite3")).default;
  const sqliteVec = await import("sqlite-vec");

  const dbPath = join(vectorsDir, "l1-vectors.sqlite");
  const db: Database.Database = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);

  // 从 embedding 配置读取维度（与 embedding service 输出一致）
  // vectorsDir = {profilePath}/memoryDB/vectors → profilePath = join(vectorsDir, "..", "..")
  const dimensions = (() => {
    try {
      const cfg = loadEmbeddingConfig(join(vectorsDir, "..", ".."));
      return cfg?.dimensions ?? 1024;
    } catch {}
    return 1024; // 默认值
  })();

  // 创建辅助映射表（record_id → rowid）
  db.exec(`
    CREATE TABLE IF NOT EXISTS l1_vector_index (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT UNIQUE NOT NULL
    )
  `);

  // 创建 vec0 虚拟表（维度从 embedding config 读取）
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS l1_vectors
    USING vec0(embedding float[${dimensions}])
  `);

  // 完整性检查
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  if (integrity.integrity_check !== "ok") {
    throw new Error(`vector store 完整性检查失败：${integrity.integrity_check}`);
  }

  const count = db.prepare("SELECT count(*) as n FROM l1_vector_index").get() as { n: number };
  console.log(`[vector-store] sqlite-vec 初始化完成，${count.n} 条向量`);

  const store: VectorStore = {
    /**
     * 插入单条向量
     *
     * 步骤：1) 分配 rowid  2) 插入辅助表  3) 插入向量表
     */
    async insert(recordId: string, vector: number[]): Promise<void> {
      // 检查是否已存在（存在则先删再插 = 更新）
      const existing = db
        .prepare("SELECT rowid FROM l1_vector_index WHERE record_id = ?")
        .get(recordId) as { rowid: number } | undefined;

      if (existing) {
        // 先删旧向量
        db.exec(`DELETE FROM l1_vectors WHERE rowid = ${existing.rowid}`);
        db.exec(`DELETE FROM l1_vector_index WHERE rowid = ${existing.rowid}`);
      }

      // 插入辅助表获取 rowid
      db.prepare("INSERT INTO l1_vector_index (record_id) VALUES (?)").run(recordId);
      const row = db.prepare("SELECT rowid FROM l1_vector_index WHERE record_id = ?").get(recordId) as { rowid: number };

      // 插入向量（db.exec + vec_f32，不支持 prepared statement）
      const vecJson = JSON.stringify(vector);
      db.exec(
        `INSERT INTO l1_vectors (rowid, embedding) VALUES (${row.rowid}, vec_f32('${vecJson}'))`
      );
    },

    /**
     * 批量插入向量（事务内完成）
     */
    async insertBatch(records: Array<{ recordId: string; vector: number[] }>): Promise<void> {
      if (records.length === 0) return;

      // 事务
      const batchSql: string[] = [];

      for (const r of records) {
        // 先删旧的
        const existing = db
          .prepare("SELECT rowid FROM l1_vector_index WHERE record_id = ?")
          .get(r.recordId) as { rowid: number } | undefined;
        if (existing) {
          batchSql.push(`DELETE FROM l1_vectors WHERE rowid = ${existing.rowid}`);
          batchSql.push(`DELETE FROM l1_vector_index WHERE rowid = ${existing.rowid}`);
        }
      }

      // 插入辅助表
      for (const r of records) {
        batchSql.push(
          `INSERT OR IGNORE INTO l1_vector_index (record_id) VALUES ('${r.recordId}')`
        );
      }

      // 查找新分配的 rowid
      const rowidMap = new Map<string, number>();
      for (const r of records) {
        const row = db
          .prepare("SELECT rowid FROM l1_vector_index WHERE record_id = ?")
          .get(r.recordId) as { rowid: number } | undefined;
        if (row) rowidMap.set(r.recordId, row.rowid);
      }

      // 插入向量
      for (const r of records) {
        const rowid = rowidMap.get(r.recordId);
        if (rowid !== undefined) {
          const vecJson = JSON.stringify(r.vector);
          batchSql.push(
            `INSERT INTO l1_vectors (rowid, embedding) VALUES (${rowid}, vec_f32('${vecJson}'))`
          );
        }
      }

      if (batchSql.length > 0) {
        db.exec(batchSql.join(";"));
      }
    },

    /**
     * 删除单条向量
     */
    async delete(recordId: string): Promise<void> {
      const row = db
        .prepare("SELECT rowid FROM l1_vector_index WHERE record_id = ?")
        .get(recordId) as { rowid: number } | undefined;
      if (row) {
        db.exec(`DELETE FROM l1_vectors WHERE rowid = ${row.rowid}`);
        db.exec(`DELETE FROM l1_vector_index WHERE rowid = ${row.rowid}`);
      }
    },

    /**
     * 批量删除向量
     */
    async deleteBatch(recordIds: string[]): Promise<void> {
      if (recordIds.length === 0) return;
      const placeholders = recordIds.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT rowid FROM l1_vector_index WHERE record_id IN (${placeholders})`)
        .all(...recordIds) as Array<{ rowid: number }>;

      if (rows.length === 0) return;
      const rowids = rows.map((r) => r.rowid).join(",");
      db.exec(`DELETE FROM l1_vectors WHERE rowid IN (${rowids})`);
      db.exec(`DELETE FROM l1_vector_index WHERE rowid IN (${rowids})`);
    },

    /**
     * cosine 搜索 top-K
     */
    async search(queryVector: number[], topK: number): Promise<VectorHit[]> {
      const vecJson = JSON.stringify(queryVector);

      // 搜索向量表，得到 rowid + distance
      const vecRows = db
        .prepare(
          `SELECT rowid, distance FROM l1_vectors
           WHERE embedding MATCH vec_f32('${vecJson}')
           AND k = ${topK}
           ORDER BY distance`
        )
        .all() as Array<{ rowid: number; distance: number }>;

      if (vecRows.length === 0) return [];

      // 反查 recordId
      const rowids = vecRows.map((r) => r.rowid).join(",");
      const indexRows = db
        .prepare(`SELECT rowid, record_id FROM l1_vector_index WHERE rowid IN (${rowids})`)
        .all() as Array<{ rowid: number; record_id: string }>;

      const rowidToRecordId = new Map(indexRows.map((r) => [r.rowid, r.record_id]));

      return vecRows.map((r) => ({
        recordId: rowidToRecordId.get(r.rowid) ?? `unknown_${r.rowid}`,
        score: 1 - r.distance,
        distance: r.distance,
      }));
    },

    /**
     * 向量总数（真实存在的向量行数）
     *
     * 2026-09-02 修复：原实现查 l1_vector_index 映射表行数——当向量被清空（删除/重建失败）
     * 而映射表残留时，count()>0 会误导调用方走 search（恒空、白调 embedding API）。
     * 改为查 vec0 虚拟表真实行数：count=0 时调用方应跳过检索。
     */
    async count(): Promise<number> {
      const row = db.prepare("SELECT count(*) as n FROM l1_vectors").get() as { n: number };
      return row.n;
    },

    /**
     * 可用性检查
     */
    async isAvailable(): Promise<boolean> {
      try {
        const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
        return integrity.integrity_check === "ok";
      } catch {
        return false;
      }
    },

    /**
     * 返回已向量化的 record_id（映射表 ∩ vec0 实际有向量的行）
     *
     * 2026-09-02 修复：原实现只查 l1_vector_index——向量被清空但映射表残留时会误报
     * 「已向量化」，导致 backfill 永不补。现改为仅返回 vec0 中真实存在向量的 rowid
     * （插入时 index 与 vec0 共用同一 rowid，见 insert()）。
     * 供 /vectorize-list 与 backfill 使用：与 loadAllL1Records() 对比得出未向量化清单。
     */
    async getAllVectorizedRecordIds(): Promise<string[]> {
      const rows = db
        .prepare(
          `SELECT i.record_id FROM l1_vector_index i
           WHERE i.rowid IN (SELECT rowid FROM l1_vectors)
           ORDER BY i.rowid`
        )
        .all() as Array<{ record_id: string }>;
      return rows.map((r) => r.record_id);
    },

    /**
     * 关闭连接
     */
    close() {
      db.close();
      storeInstance = null;
    },
  };

  return store;
}
