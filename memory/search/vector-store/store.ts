/**
 * sqlite-vec vector store 实现
 *
 * 存储 L1 records 的 embedding 向量
 * 位置：{profile}/memoryDB/search/vectors/l1-vectors.sqlite
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
import { MEMORY_DB_DIR, VECTORS_DIR } from "../../paths.ts";
import { logEvent, noticeCard } from "../../../util/notice.ts";

/** 搜索结果 hit */
export interface VectorHit {
  recordId: string;
  /** 余弦相似度 = 1 - d²/2（d 为 vec0 返回的 L2 距离；向量已 L2 归一化，详见 search 内注释，2026-09-19 修正） */
  score: number;
  /** vec0 返回的原始距离——**默认度量是 L2，不是 cosine**（2026-09-19 更正旧注释） */
  distance: number;
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
  /**
   * 清空向量表 + 映射表（同一事务），返回清空前的向量行数。
   *
   * 专供 rebuild 使用：**不依赖当前映射是否完好**。旧 rebuild 用
   * getAllVectorizedRecordIds()（两表交集）当清空清单，一旦两表已错位交集为空，
   * 等于什么都没清，重建后依旧错位（2026-09-19 故障即此因）。
   */
  clearAll(): Promise<number>;
  /**
   * 一致性自检：两表行数 / 可对齐行数 / 孤儿行数。
   *
   * 用于「拒绝静默失效」——错位时召回会恒空（命中反查不到 record_id，返回 unknown_<rowid> 或 "(record not found)"），
   * 必须在初始化与 rebuild 后留可见痕迹，而不是默默返回空结果。
   */
  checkConsistency(): Promise<{
    indexRows: number;
    vectorRows: number;
    aligned: number;
    orphanIndexRows: number;
    orphanVectorRows: number;
  }>;
  close(): void;
}

/**
 * 进程级单例 holder —— 存在 globalThis 上，而不是模块级 `let`。
 *
 * ⚠️ 2026-09-19 修复（子代理 embed_and_search 报 TDZ 的根因，已实测复现）：
 * 模块级 `let` 在模块体执行到那一行之前处于 TDZ，而 `export function` 是 hoisted、一开始就能调用。
 * pi 用 jiti 加载扩展且 `moduleCache:false`（dist/core/extensions/loader.js:358），因此
 * l1-extractor 在同一回合并发发出多个 embed_and_search 时：先到的调用者触发模块求值，
 * 其余调用者在求值未完成时就拿到了命名空间并调用 getter → 读未初始化的 `let` →
 * `ReferenceError: Cannot access 'storeInstance' before initialization`
 * （实测：3 并发 → 2 失败 1 成功；线上 12 并发 → 11 失败降级）。
 * 主代理有 session_start 预热所以不踩；子代理 `PI_SUBAGENT_CHILD=1` 在预热前就 return。
 *
 * 修法：单例与 in-flight promise 放 globalThis（恒已初始化，结构上不可能 TDZ），
 * 顺带让 `moduleCache:false` 造成的多份模块实例共享同一单例（同进程只初始化一次）。
 * 与 service.ts 顶部「不通过 globalThis 桥接传递配置」不矛盾：那句指父子**进程**间不共享
 * （跨进程本就做不到）；globalThis 是进程内的，各子代理进程仍各自初始化。
 */
interface VectorStoreHolder {
  instance: VectorStore | null;
  initPromise: Promise<VectorStore> | null;
}

/** 取进程级 holder；只碰 globalThis（语言全局，恒可用），不引用任何模块级绑定 → 不会 TDZ */
function getStoreHolder(): VectorStoreHolder {
  const g = globalThis as unknown as { __piMemorySystem_vectorStore?: VectorStoreHolder };
  if (!g.__piMemorySystem_vectorStore) {
    g.__piMemorySystem_vectorStore = { instance: null, initPromise: null };
  }
  return g.__piMemorySystem_vectorStore;
}

/**
 * 获取 VectorStore 实例（懒加载）
 *
 * 历史：2026-09-15 曾用「缓存 in-flight promise」防并发重复初始化；那次把 TDZ 的成因
 * 误判为并发重复初始化，而缓存本身也是模块级 `let`，在同一个竞态窗口里同样不可用，
 * 因此并未治到病（详见上方 holder 注释）。现在 in-flight promise 存在 holder 里。
 */
export async function getVectorStore(profilePath?: string): Promise<VectorStore> {
  const holder = getStoreHolder();
  if (holder.instance) return holder.instance;
  if (holder.initPromise) return holder.initPromise;

  const baseProfilePath = profilePath ?? process.env.PI_PROFILE_PATH ?? "";
  const vectorsDir = join(baseProfilePath, MEMORY_DB_DIR, VECTORS_DIR);

  if (!existsSync(vectorsDir)) {
    mkdirSync(vectorsDir, { recursive: true });
  }

  holder.initPromise = createSqliteVecStore(vectorsDir, baseProfilePath);
  try {
    holder.instance = await holder.initPromise;
    return holder.instance;
  } catch (e) {
    // 初始化失败：清空 in-flight 缓存，允许后续调用重试（不缓存失败态）
    holder.initPromise = null;
    throw e;
  }
}

/**
 * 创建 sqlite-vec vector store
 */
async function createSqliteVecStore(vectorsDir: string, profilePath: string): Promise<VectorStore> {
  const Database = (await import("better-sqlite3")).default;
  const sqliteVec = await import("sqlite-vec");

  const dbPath = join(vectorsDir, "l1-vectors.sqlite");
  const db: Database.Database = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);

  // 从 embedding 配置读取维度（与 embedding service 输出一致）。
  // 注意：**直接用 profilePath**，不要从 vectorsDir 反推层级 ——
  // 旧实现假设 vectorsDir = {profile}/memoryDB/.vectors，故取 "..",".." 得 profile 根；
  // 2026-09-14 布局改为 {profile}/memoryDB/search/vectors 后多了一层，反推只会得到 memoryDB/。
  const dimensions = (() => {
    try {
      const cfg = loadEmbeddingConfig(profilePath);
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

  // 一致性自检（拒绝静默失效）：映射表与向量表行数/可对齐行数不一致时必须显式告警。
  // 错位的典型症状是召回恒空（命中 rowid 反查不到 record_id，返回 unknown_<rowid> 或 "(record not found)"）。
  const indexCount = db.prepare("SELECT count(*) as n FROM l1_vector_index").get() as { n: number };
  const vectorCount = db.prepare("SELECT count(*) as n FROM l1_vectors").get() as { n: number };
  const alignedCount = db
    .prepare("SELECT count(*) as n FROM l1_vector_index i WHERE i.rowid IN (SELECT rowid FROM l1_vectors)")
    .get() as { n: number };
  if (indexCount.n !== vectorCount.n || alignedCount.n !== vectorCount.n) {
    // 一致性异常 = 「召回恒空」的静默失效：必须让用户看到（会话级去重，不重复刷）
    const detail =
      `映射表 ${indexCount.n} 行 / 向量表 ${vectorCount.n} 行 / 可对齐 ${alignedCount.n} 行`;
    logEvent("store", `⚠️ 一致性异常：${detail} —— 召回会失败（恒空），请执行 /my-memory:l1:embedding:rebuild`, profilePath);
    noticeCard({
      level: "error",
      title: "向量库一致性异常（召回会恒空）",
      lines: [detail, "执行 /my-memory:l1:embedding:rebuild 重建"],
      dedupKey: "vector-store-integrity",
    });
  } else {
    logEvent("store", `sqlite-vec 初始化完成，${vectorCount.n} 条向量（映射一致）`, profilePath);
  }

  const store: VectorStore = {
    /**
     * 插入单条向量
     *
     * 步骤：1) 分配 rowid  2) 插入辅助表  3) 插入向量表
     */
    async insert(recordId: string, vector: number[]): Promise<void> {
      // 单条插入同样放进事务：删旧行 → 写映射表 → 读回 rowid → 写向量（任一步失败整体回滚，不留孤儿）。
      const tx = db.transaction(() => {
        // 检查是否已存在（存在则先删再插 = 更新）
        const existing = db
          .prepare("SELECT rowid FROM l1_vector_index WHERE record_id = ?")
          .get(recordId) as { rowid: number } | undefined;

        if (existing) {
          // 先删旧向量
          db.exec(`DELETE FROM l1_vectors WHERE rowid = ${existing.rowid}`);
          db.exec(`DELETE FROM l1_vector_index WHERE rowid = ${existing.rowid}`);
        }

        // 插入辅助表获取 rowid（必须在插入**之后**读，见 insertBatch 的错位根因说明）
        db.prepare("INSERT INTO l1_vector_index (record_id) VALUES (?)").run(recordId);
        const row = db.prepare("SELECT rowid FROM l1_vector_index WHERE record_id = ?").get(recordId) as { rowid: number };

        // 插入向量（db.exec + vec_f32，不支持 prepared statement）
        const vecJson = JSON.stringify(vector);
        db.exec(
          `INSERT INTO l1_vectors (rowid, embedding) VALUES (${row.rowid}, vec_f32('${vecJson}'))`
        );
      });
      tx();
    },

    /**
     * 批量插入向量（事务内完成）
     */
    async insertBatch(records: Array<{ recordId: string; vector: number[] }>): Promise<void> {
      if (records.length === 0) return;

      // ⚠️ 2026-09-19 修复（召回恒空的根因）：
      // 旧实现先把所有 SQL 拼成 batchSql 再一次性 db.exec，但「读取新分配 rowid」这一步
      // 发生在 exec **之前**——此刻删除/重插尚未生效，读到的还是**旧 rowid**。于是
      // 映射表被重新分配了新 rowid（AUTOINCREMENT 不回退），向量却写进旧 rowid，
      // 两表自此永久错位（命中 rowid 反查不到 record_id → unknown_<rowid> 或 "(record not found)"）。
      // 修法：整个批次放进一个真事务，并严格分三段执行，rowid 必须在映射表写入**之后**读。
      const tx = db.transaction((items: Array<{ recordId: string; vector: number[] }>) => {
        // 第一段：清掉同 record_id 的旧行（向量 + 映射），避免唯一约束冲突
        for (const r of items) {
          const existing = db
            .prepare("SELECT rowid FROM l1_vector_index WHERE record_id = ?")
            .get(r.recordId) as { rowid: number } | undefined;
          if (existing) {
            db.exec(`DELETE FROM l1_vectors WHERE rowid = ${existing.rowid}`);
            db.exec(`DELETE FROM l1_vector_index WHERE rowid = ${existing.rowid}`);
          }
        }

        // 第二段：写映射表，并读回本次新分配的 rowid
        const rowidMap = new Map<string, number>();
        for (const r of items) {
          db.prepare("INSERT OR IGNORE INTO l1_vector_index (record_id) VALUES (?)").run(r.recordId);
          const row = db
            .prepare("SELECT rowid FROM l1_vector_index WHERE record_id = ?")
            .get(r.recordId) as { rowid: number } | undefined;
          if (row) rowidMap.set(r.recordId, row.rowid);
        }

        // 第三段：写向量，rowid 与映射表严格一致
        for (const r of items) {
          const rowid = rowidMap.get(r.recordId);
          if (rowid === undefined) continue;
          db.exec(
            `INSERT INTO l1_vectors (rowid, embedding) VALUES (${rowid}, vec_f32('${JSON.stringify(r.vector)}'))`
          );
        }
      });
      tx(records);
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
        // ⚠️ 2026-09-19 修正：vec0 建表未声明 distance_metric，默认返回的是 **L2 距离**（不是余弦距离）。
        // 向量由 embedding service 做 L2 归一化（模长恒为 1），故 cosine = 1 - d²/2。
        // 旧写法 `1 - d` 不是余弦：实测真实 cos=0.616 却算出 score=0.124，被 recall.minScore(0.2)
        // 静默滤掉（表现为「语义明显相关的记录召回为空」）；等效于阈值被抬高到 cos≈0.68。
        // 归一化保证 L2 排序 = 余弦排序，因此排序一直是对的，错的只是阈值语义——这也是它长期未被发现的原因。
        score: 1 - (r.distance * r.distance) / 2,
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
     * 清空向量表 + 映射表（同一事务）
     *
     * 供 rebuild 使用：清空不依赖当前映射是否完好——错位状态下两表交集为空，
     * 靠交集清单删除等于没清（2026-09-19 故障根因之一）。
     * 返回清空前的向量行数（供进度/报告展示）。
     */
    async clearAll(): Promise<number> {
      const before = (db.prepare("SELECT count(*) as n FROM l1_vectors").get() as { n: number }).n;
      const tx = db.transaction(() => {
        db.exec("DELETE FROM l1_vectors");
        db.exec("DELETE FROM l1_vector_index");
      });
      tx();
      return before;
    },

    /**
     * 一致性自检：两表行数 / 可对齐行数 / 孤儿行数
     *
     * 用于排查「召回恒空」：vectorRows 应等于 aligned，且 indexRows==vectorRows；
     * orphanIndexRows（有映射无向量）多于 0 说明插入半途失败或映射被重分配。
     */
    async checkConsistency() {
      const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      const indexRows = n("SELECT count(*) as n FROM l1_vector_index");
      const vectorRows = n("SELECT count(*) as n FROM l1_vectors");
      const aligned = n("SELECT count(*) as n FROM l1_vector_index i WHERE i.rowid IN (SELECT rowid FROM l1_vectors)");
      const orphanIndexRows = n("SELECT count(*) as n FROM l1_vector_index i WHERE i.rowid NOT IN (SELECT rowid FROM l1_vectors)");
      const orphanVectorRows = n("SELECT count(*) as n FROM l1_vectors v WHERE v.rowid NOT IN (SELECT rowid FROM l1_vector_index)");
      return { indexRows, vectorRows, aligned, orphanIndexRows, orphanVectorRows };
    },

    /**
     * 关闭连接
     */
    close() {
      db.close();
      const holder = getStoreHolder();
      holder.instance = null;
      holder.initPromise = null;
    },
  };

  return store;
}
