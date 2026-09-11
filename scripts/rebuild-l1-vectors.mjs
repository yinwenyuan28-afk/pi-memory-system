/**
 * L1 向量全量重建脚本（2026-09-02）
 *
 * 背景：default profile 的 l1-vectors.sqlite 中 vec0 影子表 0 行（向量数据 8-27 被清空，
 *      freelist 1027/1041 页是删除痕迹），但 l1_vector_index 残留 208 行 → 线上召回空转。
 * 本脚本：清空映射表 + 全量重嵌所有非 deleted 的 L1 records。
 *
 * 记录本体在 l1-records/*.jsonl，向量只是可重算的索引 → 本操作不丢任何记忆。
 * 自包含 .mjs：不 import 扩展 TS 模块，逻辑与 memory/search/embedding/backfill.ts 的
 * rebuildAllVectors + vector-store/store.ts 的 insertBatch 对齐。
 *
 * 用法：
 *   node scripts/rebuild-l1-vectors.mjs --profile "C:/Users/leaf/.pi/agent/profiles/default"
 */

import { createRequire } from "node:module";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = { profile: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") args.profile = argv[++i];
  }
  if (!args.profile) {
    console.error("缺少 --profile 参数");
    process.exit(1);
  }
  return args;
}
const PROFILE = parseArgs(process.argv.slice(2)).profile;

// ── 1. 加载全部存活 records（LWW 语义，与 record-loader.ts 同口径；2026-09-11 同步） ──
// 同 id 按「追加序最后一行」判定：last.deleted === true → 不输出；否则输出最后一行。
// 旧实现逐行 !deleted 会把「已判死但旧行仍活跃」的残活行重新入向量，必须保持同口径。
function loadAliveRecords(profilePath) {
  const dir = join(profilePath, "memoryDB", "l1-records");
  if (!existsSync(dir)) {
    console.error(`l1-records 目录不存在: ${dir}`);
    process.exit(1);
  }
  const lastById = new Map();
  for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
    for (const line of readFileSync(join(dir, f), "utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.id) lastById.set(r.id, r); // 追加序覆盖 → 最后一行
      } catch { /* 跳过坏行 */ }
    }
  }
  const records = [];
  for (const r of lastById.values()) {
    if (r.deleted === true) continue;
    records.push({ id: r.id, content: r.content ?? "", createdAt: r.createdAt ?? "" });
  }
  records.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return records;
}

// ── 2. embedding 配置（2026-09-02 起读 application-propertis.json model.embedding 节） ──
import { readEmbedConfig as _readEmbedConfig } from "./lib/embed-config.mjs";

function loadEmbeddingConfig(profilePath) {
  const cfg = _readEmbedConfig(profilePath);
  if (!cfg) {
    console.error(
      "embedding 配置不可用：请在 memoryDB/config/application-propertis.json 的 model.embedding 节配置 apiKey + url" +
        "（或保留旧 memory-system-model.json）"
    );
    process.exit(1);
  }
  return cfg;
}

function l2Normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// ── 3. 批量 embed（每批 ≤10，批间限流） ──
async function embedBatch(cfg, texts, lastCallTs) {
  const intervalMs = Math.ceil(60_000 / cfg.qpmLimit) + 300;
  const waitMs = intervalMs - (Date.now() - lastCallTs.value);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  lastCallTs.value = Date.now();

  const resp = await fetch(`${cfg.url}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      input: texts,
      dimensions: cfg.dimensions,
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`embedding API ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  const items = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return items.map((d) => {
    if (!d?.embedding) throw new Error("embedding 返回格式异常");
    return l2Normalize(d.embedding);
  });
}

// ── 4. 向量库写入（与 vector-store/store.ts insertBatch 对齐） ──
function openWritableVectorDb(profilePath) {
  const dbPath = join(profilePath, "memoryDB", ".vectors", "l1-vectors.sqlite");
  if (!existsSync(dbPath)) {
    console.error(`向量库不存在: ${dbPath}`);
    process.exit(1);
  }
  const Database = require("better-sqlite3");
  const sqliteVecMod = require("sqlite-vec");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 8000");
  db.pragma("journal_mode = WAL");
  const loadFn = sqliteVecMod.load ?? sqliteVecMod.default?.load;
  if (!loadFn) throw new Error("sqlite-vec 无 load 方法");
  loadFn(db);
  return db;
}

function clearStore(db) {
  // 1. 清空 vec0（先取全部 rowid 再删；v0.1.9 vec0 需按 rowid 删）
  const vecRows = db.prepare("SELECT rowid FROM l1_vectors").all();
  for (const r of vecRows) {
    db.exec(`DELETE FROM l1_vectors WHERE rowid = ${r.rowid}`);
  }
  // 2. 清空映射表
  db.exec("DELETE FROM l1_vector_index");
  return vecRows.length;
}

function insertBatch(db, batch, dimensions) {
  // 先插 index 拿 rowid
  const sqls = [];
  for (const rec of batch) {
    sqls.push(`INSERT OR IGNORE INTO l1_vector_index (record_id) VALUES ('${rec.recordId}')`);
  }
  db.exec(sqls.join(";"));
  // 查 rowid
  const rowidMap = new Map();
  const stmt = db.prepare("SELECT rowid FROM l1_vector_index WHERE record_id = ?");
  for (const rec of batch) {
    const row = stmt.get(rec.recordId);
    if (row) rowidMap.set(rec.recordId, row.rowid);
  }
  // 插向量
  const vecSqls = [];
  for (const rec of batch) {
    const rowid = rowidMap.get(rec.recordId);
    if (rowid === undefined) continue;
    if (rec.vector.length !== dimensions) {
      console.error(`跳过 ${rec.recordId}: 维度 ${rec.vector.length} != ${dimensions}`);
      continue;
    }
    vecSqls.push(
      `INSERT INTO l1_vectors (rowid, embedding) VALUES (${rowid}, vec_f32('${JSON.stringify(rec.vector)}'))`
    );
  }
  if (vecSqls.length > 0) db.exec(vecSqls.join(";"));
  return vecSqls.length;
}

// ── main ────────────────────────────────────────────────
async function main() {
  const records = loadAliveRecords(PROFILE);
  console.log(`待重建记录: ${records.length} 条`);
  if (records.length === 0) {
    console.error("没有非 deleted 记录，退出");
    process.exit(1);
  }

  const cfg = loadEmbeddingConfig(PROFILE);
  const db = openWritableVectorDb(PROFILE);
  const cleared = clearStore(db);
  console.log(`已清空: ${cleared} 条残留向量, 映射表已重置`);

  const BATCH = 10;
  const lastCallTs = { value: 0 };
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    try {
      const vectors = await embedBatch(cfg, batch.map((r) => r.content), lastCallTs);
      const items = batch.map((r, j) => ({ recordId: r.id, vector: vectors[j] }));
      const inserted = insertBatch(db, items, cfg.dimensions);
      ok += inserted;
      console.log(`[${Math.min(i + BATCH, records.length)}/${records.length}] +${inserted}`);
    } catch (e) {
      fail += batch.length;
      console.error(`[${Math.min(i + BATCH, records.length)}/${records.length}] batch 失败: ${e.message.slice(0, 120)}`);
    }
  }

  // 校验
  const dbCount = db.prepare("SELECT count(*) n FROM l1_vectors").get().n;
  const idxCount = db.prepare("SELECT count(*) n FROM l1_vector_index").get().n;
  console.log(`\n完成: 插入 ${ok}, 失败 ${fail}`);
  console.log(`校验: l1_vectors=${dbCount} 行 | l1_vector_index=${idxCount} 行`);
  db.close();
}

main().catch((e) => {
  console.error("运行失败:", e);
  process.exit(1);
});
