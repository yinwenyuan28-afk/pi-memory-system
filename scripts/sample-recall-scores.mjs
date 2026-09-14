/**
 * L1 recall cosine score 采样定标脚本（2026-09-02）
 *
 * 目的：为 recall-config.json 的 minScore 提供数据依据。
 * 方法：从 l0/conversations/*.jsonl 抽真实 user 消息作 query，
 *      对每条跑「embed(query) → sqlite-vec top-5」，
 *      统计 top-1 / top-3 / top-5 的 score 分布（P25/P50/P75/P90）+ 直方图。
 *
 * 纯观测：不写库、不计命中、不改任何线上行为。
 * 自包含 .mjs：不 import 扩展 TS 模块（extensions/ 无 tsx，Node type stripping
 * 处理不了 .js→.ts 后缀映射），直接读 sqlite-vec 库 + 调 embedding API。
 *
 * 用法：
 *   node scripts/sample-recall-scores.mjs \
 *     --profile "C:/Users/leaf/.pi/agent/profiles/default" \
 *     [--limit 40] [--topk 5]
 */

import { createRequire } from "node:module";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

// ── 参数解析 ─────────────────────────────────────────────
function parseArgs(argv) {
  const args = { profile: "", limit: 40, topk: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") args.profile = argv[++i];
    else if (argv[i] === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (argv[i] === "--topk") args.topk = parseInt(argv[++i], 10);
  }
  if (!args.profile) {
    console.error("缺少 --profile 参数");
    process.exit(1);
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));

const PROFILE = args.profile;
const LIMIT = args.limit;
const TOPK = args.topk;

// 路径与 memory/paths.ts 同步（脚本无法 import TS，改动需手动对齐，见 plan MEMORYDB_LAYOUT_PLAN 3.2-B）
const L0_CONVERSATIONS_REL = join("l0", "conversations");
const VECTORS_DB_REL = join("search", "vectors", "l1-vectors.sqlite");

// ── trivial prompt 过滤（与 index.ts before_agent_start 同款语义） ──
function isTrivial(text) {
  if (typeof text !== "string") return true;
  const t = text.trim();
  if (!t || t.length < 3) return true;
  if (t.startsWith("/")) return true;
  if (/^[\?？]+$/.test(t)) return true;
  if (/^[^a-zA-Z0-9\u4e00-\u9fa5\s]{1,5}$/.test(t)) return true;
  // 纯数字 / 单字回复（"1"、"好的" 之类无检索价值）
  if (/^[\d\s,.。]+$/.test(t)) return true;
  if (t.length < 6 && /^(好|嗯|对|是|ok|OK|行|可以|继续|再来|1|2|3)$/.test(t)) return true;
  return false;
}

// ── 1. 收集样本 query：跨日分片取最近 LIMIT 条非 trivial user 消息 ──
function collectSampleQueries(profilePath) {
  const l0Dir = join(profilePath, "memoryDB", L0_CONVERSATIONS_REL);
  if (!existsSync(l0Dir)) {
    console.error(`L0 目录不存在: ${l0Dir}`);
    process.exit(1);
  }
  const files = readdirSync(l0Dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();

  const all = [];
  for (const f of files) {
    const lines = readFileSync(join(l0Dir, f), "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.role === "user" && typeof rec.content === "string") {
          const content = rec.content.trim();
          if (!isTrivial(content)) {
            all.push({ content, recordedAt: rec.recordedAt || "" });
          }
        }
      } catch { /* 跳过坏行 */ }
    }
  }
  // 按时间排序取最近 LIMIT 条（无 recordedAt 的排后面兜底）
  all.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
  return all.slice(-LIMIT);
}

// ── 2. 读 embedding 配置（2026-09-02 起读 application-propertis.json model.embedding 节） ──
import { readEmbedConfig as loadEmbeddingConfig } from "./lib/embed-config.mjs";

function loadEmbeddingConfigOrExit(profilePath) {
  const cfg = loadEmbeddingConfig(profilePath);
  if (!cfg) {
    console.error(
      "embedding 配置不可用：请在 memoryDB/config/application-propertis.json 的 model.embedding 节配置 apiKey + url" +
        "（或保留旧 memory-system-model.json）"
    );
    process.exit(1);
  }
  return cfg;
}

// ── 3. 向量归一化 + API 调用（限流：按 QPM 睡满间隔） ──
function l2Normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

async function embedOne(cfg, text, lastCallTs) {
  // 限流：保证请求间隔 ≥ 60s/qpmLimit
  const intervalMs = Math.ceil(60_000 / cfg.qpmLimit) + 200;
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
      input: text,
      dimensions: cfg.dimensions,
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`embedding API ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data.data?.[0]?.embedding) throw new Error("embedding 返回格式异常");
  return l2Normalize(data.data[0].embedding);
}

// ── 4. sqlite-vec 检索 ──
function openVectorDb(profilePath) {
  const dbPath = join(profilePath, "memoryDB", VECTORS_DB_REL);
  if (!existsSync(dbPath)) {
    console.error(`向量库不存在: ${dbPath}（先跑向量化 backfill）`);
    process.exit(1);
  }
  const Database = require("better-sqlite3");
  const sqliteVecMod = require("sqlite-vec");
  const db = new Database(dbPath, { readonly: true });
  const loadFn = sqliteVecMod.load ?? sqliteVecMod.default?.load;
  if (!loadFn) {
    console.error("sqlite-vec 加载失败：无 load 方法");
    process.exit(1);
  }
  loadFn(db);
  const n = db.prepare("SELECT count(*) AS n FROM l1_vector_index").get().n;
  if (n === 0) {
    console.error("向量库为空（0 条向量），先跑向量化");
    process.exit(1);
  }
  return { db, n };
}

function vecSearch(db, queryVec, k) {
  const vecJson = JSON.stringify(queryVec);
  const rows = db
    .prepare(
      `SELECT rowid, distance FROM l1_vectors
       WHERE embedding MATCH vec_f32('${vecJson}')
       AND k = ${k} ORDER BY distance`
    )
    .all();
  return rows.map((r) => 1 - r.distance); // score = 1 - distance
}

// ── 5. 分位数 + 直方图 ──
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}
function summarize(sorted) {
  if (sorted.length === 0) return "n/a";
  return [
    `n=${sorted.length}`,
    `P25=${percentile(sorted, 0.25).toFixed(3)}`,
    `P50=${percentile(sorted, 0.5).toFixed(3)}`,
    `P75=${percentile(sorted, 0.75).toFixed(3)}`,
    `P90=${percentile(sorted, 0.9).toFixed(3)}`,
  ].join("  ");
}
function histogram(sorted) {
  const buckets = Array.from({ length: 10 }, () => 0); // 0.0-0.1 ... 0.9-1.0
  for (const s of sorted) {
    const b = Math.min(9, Math.floor(s * 10));
    buckets[b]++;
  }
  const lines = buckets.map((c, i) => {
    const lo = (i / 10).toFixed(1);
    const hi = ((i + 1) / 10).toFixed(1);
    const bar = "#".repeat(Math.min(40, Math.round((c / Math.max(1, sorted.length)) * 40)));
    return `  [${lo}-${hi}) ${String(c).padStart(4)} ${bar}`;
  });
  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────
async function main() {
  console.log(`profile: ${PROFILE}`);
  console.log(`limit: ${LIMIT}  topk: ${TOPK}`);

  const queries = collectSampleQueries(PROFILE);
  console.log(`L0 采样到 ${queries.length} 条非 trivial user 消息\n`);
  if (queries.length === 0) {
    console.error("没有可用的样本 query");
    process.exit(1);
  }

  const cfg = loadEmbeddingConfigOrExit(PROFILE);
  const { db, n } = openVectorDb(PROFILE);
  console.log(`向量库: ${n} 条 | embedding: ${cfg.model} dim=${cfg.dimensions}\n`);

  const rank1 = [];
  const top3 = [];
  const top5 = [];
  const lastCallTs = { value: 0 };

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    let vec;
    try {
      vec = await embedOne(cfg, q.content, lastCallTs);
    } catch (e) {
      console.error(`[${i + 1}/${queries.length}] embed 失败: ${e.message}`);
      continue;
    }
    const scores = vecSearch(db, vec, TOPK);
    const shown = q.content.slice(0, 40) + (q.content.length > 40 ? "…" : "");
    console.log(
      `[${i + 1}/${queries.length}] "${shown}" -> top${scores.length} ` +
      `best=${scores.length ? scores[0].toFixed(3) : "-"}`
    );
    if (scores.length >= 1) rank1.push(scores[0]);
    if (scores.length >= 1) top3.push(...scores.slice(0, 3));
    if (scores.length >= 1) top5.push(...scores);
    if (scores.length > 0) await new Promise((r) => setTimeout(r, 150)); // 轻微节流
  }

  console.log("\n═══════════════════════════════════════");
  console.log("score 分布摘要（cosine = 1 - distance）");
  console.log("═══════════════════════════════════════");
  console.log(`top-1 (best of top${TOPK}) : ${summarize(rank1.sort((a, b) => a - b))}`);
  console.log(`top-3 所有得分            : ${summarize(top3.sort((a, b) => a - b))}`);
  console.log(`top-${TOPK} 所有得分        : ${summarize(top5.sort((a, b) => a - b))}`);

  console.log("\ntop-1 直方图（0.1 分桶）:");
  console.log(histogram(rank1.sort((a, b) => a - b)));
  console.log("\ntop-3 全部得分直方图:");
  console.log(histogram(top3.sort((a, b) => a - b)));

  const p50 = percentile(rank1.sort((a, b) => a - b), 0.5);
  console.log(`\n建议 minScore 参考：top-1 的 P50 = ${p50.toFixed(3)}（再人工核对过滤掉的样本）`);
  console.log("回填到 recall-config.json 前，先看上面直方图确认分布形态。");
}

main().catch((e) => {
  console.error("运行失败:", e);
  process.exit(1);
});
