#!/usr/bin/env node
// ============================================================================
// l1-admin · scene-pool — L1 工作场景池的运维工具
//
// 用法（自包含 .mjs，**不 import 扩展 TS 模块**——见 sample-recall-scores.mjs 的同款说明：
// Node 的类型剥离处理不了 .js→.ts 的后缀映射）：
//
//   node scripts/l1-admin/scene-pool.mjs report        [--profile <dir>]
//   node scripts/l1-admin/scene-pool.mjs cluster       [--out <file.json>]   # 只读
//   node scripts/l1-admin/scene-pool.mjs seed --file <proposal.json>          # 默认 dry-run
//   node scripts/l1-admin/scene-pool.mjs seed --file <proposal.json> --apply  # 写盘（先备份）
//   node scripts/l1-admin/scene-pool.mjs merge-report                          # 只读
//
// 背景（2026-09-15 L1_SCENE_POOL 计划）：场景池 `memoryDB/l1/scenes.json` 是 L1 场景归属的
// 唯一真源，由 `l1_commit` 在写锁内维护。本工具只做**运维侧**的事：读侧报告、播种、合并候选。
//
// 安全约定（对齐本目录既有规矩）：
//   - 所有写操作默认 `--dry-run`，`--apply` 才落盘，且**先自动备份** scenes.json；
//   - `cluster` / `merge-report` / `report` 一律只读，不碰任何文件；
//   - 场景池的 id 永不复用，本工具不生成新 id 以外的东西。
// ============================================================================
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_DIR_NAME, memoryDbDir, parseArgs, scanRecords } from "./lib.mjs";
import { readEmbedConfig } from "../lib/embed-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 路径与扩展的 memory/paths.ts 同步（脚本无法 import TS，改动需手动对齐）
const POOL_REL = join("l1", "scenes.json");
const POOL_VERSION = 1;

/** 播种只收复现 ≥2 次的旧名（计划 Q2①：一次性任务不进池）。 */
const SEED_MIN_COUNT = 2;
/** 名字相似度阈值（余弦 / 字符二元组 Jaccard 共用）。 */
const SIM_THRESHOLD = 0.82;

// ── 池读写 ────────────────────────────────────────────────────────────────

function poolPath(profileDir) {
  return join(profileDir, "memoryDB", POOL_REL);
}

function readPool(profileDir) {
  const p = poolPath(profileDir);
  if (!existsSync(p)) return { version: POOL_VERSION, updatedAt: "", scenes: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (raw?.version !== POOL_VERSION || !Array.isArray(raw.scenes)) return { version: POOL_VERSION, updatedAt: "", scenes: [] };
    return raw;
  } catch {
    console.error(`WARN 场景池读取失败（按空池处理）：${p}`);
    return { version: POOL_VERSION, updatedAt: "", scenes: [] };
  }
}

function writePoolAtomic(profileDir, pool) {
  const p = poolPath(profileDir);
  const tmp = join(dirname(p), `.tmp_scenes_${Date.now()}`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify({ ...pool, version: POOL_VERSION }, null, 2)}\n`, "utf8");
  try {
    rmSync(p, { force: true });
  } catch {
    /* 忽略 */
  }
  renameSync(tmp, p);
}

function backupPool(profileDir, tag) {
  const src = poolPath(profileDir);
  if (!existsSync(src)) {
    console.log("（池文件尚不存在，无需备份）");
    return null;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(memoryDbDir(profileDir), BACKUP_DIR_NAME, `${ts}-${tag}`, POOL_REL);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`已自动备份场景池：${dest}`);
  return dest;
}

// ── 相似度（有 embedding 用余弦，没有退化到字符二元组） ──────────────────────

/** 字符二元组 Jaccard：中文短标签上比词袋稳，且完全离线。 */
function bigramSim(a, b) {
  const grams = (s) => {
    const t = s.replace(/\s+/g, "");
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    if (out.size === 0) out.add(t);
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** 单次 embedding 请求的文本条数。实测阿里云 MaaS 兼容端点的硬上限是 20
 *  （超过直接 400 `batch size is invalid, it should not be larger than 20`），取 16 留余量。 */
const EMBED_BATCH = 16;

/** 批量取名字向量；无配置/网络失败 → 返回 null，调用方退化到 bigram。 */
async function tryEmbedNames(profileDir, names) {
  const cfg = readEmbedConfig(profileDir);
  if (!cfg) {
    console.log("（未读到 embedding 配置 → 退化为字符二元组相似度，置信度较低）");
    return null;
  }
  const out = [];
  const intervalMs = Math.ceil(60_000 / (cfg.qpmLimit || 60)) + 300;
  let last = 0;
  try {
    for (let i = 0; i < names.length; i += EMBED_BATCH) {
      const wait = intervalMs - (Date.now() - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const resp = await fetch(`${cfg.url}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          input: names.slice(i, i + EMBED_BATCH),
          dimensions: cfg.dimensions,
          encoding_format: "float",
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`embedding API ${resp.status}: ${body.slice(0, 200)}`);
      }
      const data = await resp.json();
      const items = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const d of items) out.push(d.embedding);
    }
    return out.length === names.length ? out : null;
  } catch (e) {
    console.log(`（embedding 调用失败：${e.message} → 退化为字符二元组相似度）`);
    return null;
  }
}

// ── 历史名字统计（只读，LWW 口径） ──────────────────────────────────────────

/**
 * 从现有 L1 records 聚合历史场景名。
 *
 * 存活口径用 `scanRecords().lwwAlive`（同 id 最后一次写入）——与 `record-loader.ts`、
 * 场景池的 `readScenePool` 同口径。**不用逐行 `!deleted` 口径**（那会把被取代的旧行算作存活）。
 */
function historicalNames(profileDir) {
  const { lwwAlive } = scanRecords(profileDir);
  const byName = new Map(); // name -> {count, cwds:Set}
  for (const r of lwwAlive) {
    const name = typeof r.obj.scene_name === "string" ? r.obj.scene_name.replace(/\s+/g, " ").trim() : "";
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, { count: 0, cwds: new Set() });
    const e = byName.get(name);
    e.count++;
    if (typeof r.obj.cwd === "string" && r.obj.cwd) e.cwds.add(r.obj.cwd);
  }
  return { byName, records: lwwAlive };
}

function dominantCwd(cwds) {
  const arr = [...cwds];
  return arr.length > 0 ? arr[0] : "";
}

// ── 子命令 ────────────────────────────────────────────────────────────────

function cmdReport(profileDir) {
  const pool = readPool(profileDir);
  const alive = pool.scenes.filter((s) => !s.mergedInto);
  const merged = pool.scenes.length - alive.length;
  const { byName, records } = historicalNames(profileDir);

  console.log("=".repeat(72));
  console.log("L1 工作场景池 · 报告");
  console.log("=".repeat(72));
  console.log(`profile      : ${profileDir}`);
  console.log(`池文件       : ${poolPath(profileDir)}${existsSync(poolPath(profileDir)) ? "" : " （不存在）"}`);
  console.log(`池条目       : ${pool.scenes.length}（存活 ${alive.length} / 已合并 ${merged}）`);
  console.log(`池 updatedAt : ${pool.updatedAt || "(空)"}`);

  if (alive.length > 0) {
    const byOrigin = {};
    for (const s of alive) byOrigin[s.origin] = (byOrigin[s.origin] ?? 0) + 1;
    console.log(`来源分布     : ${Object.entries(byOrigin).map(([k, v]) => `${k}=${v}`).join(" / ")}`);
    const singles = alive.filter((s) => (s.useCount ?? 0) <= 1).length;
    console.log(`单次条目     : ${singles}/${alive.length}（useCount ≤ 1，占比 ${((singles / alive.length) * 100).toFixed(1)}%）`);
    const byCwd = {};
    for (const s of alive) {
      const c = dominantCwd(s.cwds ?? []) || "(无 cwd)";
      byCwd[c] = (byCwd[c] ?? 0) + 1;
    }
    console.log("按项目分布   :");
    for (const [c, n] of Object.entries(byCwd).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${c}`);
    const withReason = alive.filter((s) => s.newSceneReason).length;
    console.log(`带新建立由   : ${withReason}/${alive.length}（可审计面）`);
  }

  console.log("-".repeat(72));
  console.log("历史对照（现有 L1 records，LWW 口径）");
  console.log(`存活记录     : ${records.length}`);
  console.log(`distinct 场景名: ${byName.size}`);
  if (records.length > 0) {
    console.log(`全局收敛度   : ${(((1 - byName.size / records.length) * 100)).toFixed(1)}%  （= 1 - distinct/记录数）`);
  }

  console.log("-".repeat(72));
  console.log("未归类率（`metadata.sceneFallback === true`，2026-09-15 L1_PROJECT_SIGNAL）");
  const unclassified = records.filter((r) => r.obj.metadata?.sceneFallback === true);
  const mainAgent = records.filter((r) => r.obj.metadata?.origin === "main-agent");
  const unclassifiedMain = mainAgent.filter((r) => r.obj.metadata?.sceneFallback === true);
  const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");
  console.log(`全部记录   : ${records.length}，未归类 ${unclassified.length}（${pct(unclassified.length, records.length)}）`);
  console.log(`主代理记录 : ${mainAgent.length}，未归类 ${unclassifiedMain.length}（${pct(unclassifiedMain.length, mainAgent.length)}）`);
  console.log("  · 主代理未归类应在「记录前先调 list_l1_scenes」契约生效后下降；长期偏高说明契约没被执行，");
  console.log("    届时应考虑把清单并入系统提示（代价：provider prefix cache 每轮失效），属另开计划的取舍");
  if (records.some((r) => r.obj.metadata?.sceneFallback === true && r.obj.scene_id)) {
    console.log("  WARN 存在「标了未归类却带 scene_id」的记录——口径异常，值得核查");
  }

  // 批级派生指标：批边界 = 同一 commit 的记录共享同一 createdAt（commit-tool 用单个 nowStamp 落盘）
  const batches = new Map();
  for (const r of records) {
    const t = typeof r.obj.createdAt === "string" ? r.obj.createdAt : "";
    if (!t) continue;
    if (!batches.has(t)) batches.set(t, []);
    batches.get(t).push(r.obj);
  }
  if (batches.size > 0) {
    console.log("-".repeat(72));
    console.log("批级指标（新口径，池上线后才有意义）");
    const entryById = new Map(pool.scenes.map((s) => [s.id, s]));
    let attributed = 0;
    let reused = 0;
    const poolEra = [];
    for (const t of [...batches.keys()].sort()) {
      const recs = batches.get(t);
      const withId = recs.filter((r) => typeof r.scene_id === "string" && r.scene_id);
      const createdHere = pool.scenes.filter((s) => s.createdAt === t).length;
      const reusedHere = withId.filter((r) => {
        const e = entryById.get(r.scene_id);
        return e && e.createdAt < t;
      }).length;
      attributed += withId.length;
      reused += reusedHere;
      if (withId.length > 0 || createdHere > 0) poolEra.push({ t, recs: recs.length, withId: withId.length, createdHere, reusedHere });
    }
    // 历史批（池上线前）全部是「带 scene_id 0 条」，逐条打印没有信息量——只汇总
    const legacy = batches.size - poolEra.length;
    if (legacy > 0) console.log(`  （池机制上线前的历史批 ${legacy} 个已折叠：这些批没有 scene_id，不计入分母）`);
    for (const b of poolEra.slice(-20)) {
      console.log(`  ${b.t}  记录 ${String(b.recs).padStart(3)}  带 scene_id ${String(b.withId).padStart(3)}  新建条目 ${b.createdHere}  复用 ${b.reusedHere}`);
    }
    if (poolEra.length > 20) console.log(`  （仅显示最后 20 个池纪元批，共 ${poolEra.length} 个）`);
    console.log(`合计：带 scene_id 的记录 ${attributed}，其中复用既有条目 ${reused}${attributed > 0 ? `（${((reused / attributed) * 100).toFixed(1)}%）` : ""}`);
    if (attributed === 0) console.log("  （尚无带 scene_id 的记录——池机制上线前的历史记录不计入分母）");
  }
  console.log("");
}

async function cmdCluster(profileDir, outFile) {
  const { byName } = historicalNames(profileDir);
  const candidates = [...byName.entries()]
    .filter(([, v]) => v.count >= SEED_MIN_COUNT)
    .map(([name, v]) => ({ name, count: v.count, cwds: [...v.cwds] }))
    .sort((a, b) => b.count - a.count);

  const skipped = byName.size - candidates.length;
  console.log(`历史 distinct 场景名 ${byName.size} 个 → 复现 ≥${SEED_MIN_COUNT} 次的 ${candidates.length} 个参与聚类（跳过 ${skipped} 个一次性名称）`);

  const vecs = await tryEmbedNames(profileDir, candidates.map((c) => c.name));
  const sim = (i, j) => (vecs ? cosine(vecs[i], vecs[j]) : bigramSim(candidates[i].name, candidates[j].name));
  const mode = vecs ? "embedding 余弦" : "字符二元组 Jaccard";

  // 贪心并查集式聚类：只合并「同 cwd 交集 或 一方无 cwd」且相似度过阈的名字
  const parent = candidates.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { const a = find(i); const b = find(j); if (a !== b) parent[b] = a; };
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const cwdsA = new Set(candidates[i].cwds);
      const cwdsB = new Set(candidates[j].cwds);
      const shareCwd = candidates[i].cwds.length === 0 || candidates[j].cwds.length === 0 || [...cwdsA].some((c) => cwdsB.has(c));
      if (!shareCwd) continue;
      if (sim(i, j) >= SIM_THRESHOLD) union(i, j);
    }
  }

  const groups = new Map();
  candidates.forEach((c, i) => {
    const g = find(i);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ ...c, _i: i });
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    profile: profileDir,
    mode,
    threshold: SIM_THRESHOLD,
    skippedSingletons: skipped,
    groups: [...groups.values()]
      .map((members) => ({
        totalRecords: members.reduce((n, m) => n + m.count, 0),
        cwds: [...new Set(members.flatMap((m) => m.cwds))],
        names: members.sort((a, b) => b.count - a.count).map((m) => ({ name: m.name, count: m.count })),
      }))
      .sort((a, b) => b.totalRecords - a.totalRecords),
  };

  console.log(`相似度口径：${mode}，阈值 ${SIM_THRESHOLD}`);
  console.log(`聚成 ${payload.groups.length} 组（原始 ${candidates.length} 个名字）：`);
  payload.groups.slice(0, 20).forEach((g, i) => {
    console.log(`  [${i + 1}] ${g.totalRecords} 条 / ${g.names.length} 个名字 / cwd=${g.cwds.join(" | ") || "(无)"}`);
    g.names.slice(0, 3).forEach((n) => console.log(`        · ${n.count}× ${n.name}`));
    if (g.names.length > 3) console.log(`        · …另 ${g.names.length - 3} 个`);
  });
  if (payload.groups.length > 20) console.log(`  （仅显示前 20 组，完整结果见输出文件）`);

  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`\n已写出：${outFile}`);
  } else {
    console.log("\n（未指定 --out，未写文件；加 --out <file.json> 可导出机读结果）");
  }
}

/**
 * 播种：按「旧名 → 稳定标签」映射提案登记条目。
 *
 * 提案格式（由主代理起草、用户过目后落盘）：
 *   { "scenes": [ { "name": "A104527 后端｜合同签署流程 V2",
 *                   "aliases": ["旧名1", "旧名2"], "note": "可选" } ] }
 * 条目统计（cwds / useCount / lastUsedAt）由别名对应的历史记录推导，不写死。
 */
function cmdSeed(profileDir, file, apply) {
  if (!file) {
    console.error("NG seed 需要 --file <proposal.json>");
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`NG 提案文件不存在：${file}`);
    process.exit(2);
  }
  const proposal = JSON.parse(readFileSync(file, "utf8"));
  const items = Array.isArray(proposal?.scenes) ? proposal.scenes : null;
  if (!items) {
    console.error("NG 提案格式不对：需要 { scenes: [{ name, aliases: [] }] }");
    process.exit(2);
  }

  const pool = readPool(profileDir);
  const { byName, records } = historicalNames(profileDir);
  const existing = new Set(pool.scenes.filter((s) => !s.mergedInto).map((s) => s.name));
  const usage = new Map(); // alias -> {count, cwds:Set, lastUsedAt}
  for (const r of records) {
    const n = typeof r.obj.scene_name === "string" ? r.obj.scene_name.replace(/\s+/g, " ").trim() : "";
    if (!n) continue;
    if (!usage.has(n)) usage.set(n, { count: 0, cwds: new Set(), lastUsedAt: "" });
    const u = usage.get(n);
    u.count++;
    if (typeof r.obj.cwd === "string" && r.obj.cwd) u.cwds.add(r.obj.cwd);
    const t = typeof r.obj.createdAt === "string" ? r.obj.createdAt : "";
    if (t > u.lastUsedAt) u.lastUsedAt = t;
  }

  const maxSeq = pool.scenes.reduce((m, s) => {
    const mm = /^sc(\d+)$/.exec(s.id);
    return mm ? Math.max(m, Number(mm[1])) : m;
  }, 0);

  const planned = [];
  const skippedExisting = [];
  const unknownAliases = [];
  let seq = maxSeq;
  for (const it of items) {
    const name = typeof it?.name === "string" ? it.name.replace(/\s+/g, " ").trim() : "";
    const aliases = Array.isArray(it?.aliases) ? it.aliases.map((a) => String(a).replace(/\s+/g, " ").trim()).filter(Boolean) : [];
    if (!name) continue;
    if (existing.has(name)) {
      skippedExisting.push(name);
      continue;
    }
    let count = 0;
    let lastUsedAt = "";
    const cwds = new Set();
    for (const a of aliases) {
      const u = usage.get(a);
      if (!u) {
        unknownAliases.push(a);
        continue;
      }
      count += u.count;
      for (const c of u.cwds) cwds.add(c);
      if (u.lastUsedAt > lastUsedAt) lastUsedAt = u.lastUsedAt;
    }
    seq++;
    planned.push({
      id: `sc${String(seq).padStart(4, "0")}`,
      name,
      aliases,
      count,
      cwds: [...cwds],
      lastUsedAt: lastUsedAt || new Date().toISOString(),
      note: typeof it?.note === "string" ? it.note : "",
    });
  }

  console.log("=".repeat(72));
  console.log(`播种提案：${file}`);
  console.log(`待登记条目   : ${planned.length}`);
  console.log(`已在池中跳过 : ${skippedExisting.length}`);
  console.log(`别名未命中历史记录: ${unknownAliases.length}${unknownAliases.length ? `（例：${unknownAliases.slice(0, 3).join(" / ")}）` : ""}`);
  console.log("-".repeat(72));
  for (const p of planned) {
    console.log(`  ${p.id} | ${p.name}`);
    console.log(`        别名 ${p.aliases.length} 个 / 覆盖历史记录 ${p.count} 条 / cwd=${p.cwds.join(" | ") || "(无)"}`);
  }
  if (skippedExisting.length) {
    console.log(`  跳过（同名已在池中）：${skippedExisting.slice(0, 5).join(" / ")}${skippedExisting.length > 5 ? " …" : ""}`);
  }

  if (!apply) {
    console.log(`\n[dry-run] 未写盘。确认无误后加 --apply（会先自动备份 scenes.json）`);
    console.log(`（历史名总量 ${byName.size}，现有池条目 ${pool.scenes.length}）`);
    return;
  }

  backupPool(profileDir, "scene-pool-seed");
  const now = new Date().toISOString();
  for (const p of planned) {
    pool.scenes.push({
      id: p.id,
      name: p.name,
      cwds: p.cwds,
      aliases: p.aliases,
      mergedInto: null,
      origin: "seed",
      createdAt: now,
      lastUsedAt: p.lastUsedAt,
      useCount: p.count,
    });
  }
  pool.updatedAt = now;
  writePoolAtomic(profileDir, pool);
  console.log(`\n已写入 ${planned.length} 条（池条目共 ${pool.scenes.length} 条）→ ${poolPath(profileDir)}`);
}

/**
 * 合并候选报告（只读）：把池内存活条目里名字高度相似、且 cwd 有交集的成对列出。
 *
 * **本轮不提供 `merge --apply`**（计划 Q3①：先看报告再决定）。真合并要写
 * `mergedInto` + `aliases`，留到看过候选之后再单独做。
 */
async function cmdMergeReport(profileDir) {
  const pool = readPool(profileDir);
  const alive = pool.scenes.filter((s) => !s.mergedInto);
  if (alive.length < 2) {
    console.log(`池内存活条目 ${alive.length} 条，无需合并分析`);
    return;
  }
  const vecs = await tryEmbedNames(profileDir, alive.map((s) => s.name));
  const sim = (i, j) => (vecs ? cosine(vecs[i], vecs[j]) : bigramSim(alive[i].name, alive[j].name));
  console.log("=".repeat(72));
  console.log("场景池 · 合并候选（只读报告）");
  console.log(`存活条目 ${alive.length}，相似度口径：${vecs ? "embedding 余弦" : "字符二元组 Jaccard"}，阈值 ${SIM_THRESHOLD}`);
  console.log("=".repeat(72));

  const pairs = [];
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const s = sim(i, j);
      if (s < SIM_THRESHOLD) continue;
      pairs.push({ a: alive[i], b: alive[j], score: s });
    }
  }
  if (pairs.length === 0) {
    console.log("无候选（没有名字相似度过阈的条目对）");
    return;
  }
  pairs.sort((x, y) => y.score - x.score);
  for (const p of pairs) {
    console.log(`\n  ${p.score.toFixed(3)}`);
    console.log(`    A ${p.a.id} | ${p.a.name}  [useCount=${p.a.useCount} cwd=${p.a.cwds.join(" | ") || "(无)"}]`);
    console.log(`    B ${p.b.id} | ${p.b.name}  [useCount=${p.b.useCount} cwd=${p.b.cwds.join(" | ") || "(无)"}]`);
    const keep = (p.a.useCount ?? 0) >= (p.b.useCount ?? 0) ? p.a : p.b;
    const drop = keep === p.a ? p.b : p.a;
    console.log(`    建议：保留 ${keep.id}（useCount 更高），把 ${drop.id} 并入（写入 mergedInto + aliases）`);
  }
  console.log(`\n共 ${pairs.length} 组候选。本轮不提供自动合并——确认后另行处理。`);
}

// ── 入口 ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const sub = argv[0];
const rest = argv.slice(1);
const { profileDir, apply } = parseArgs(rest, {});

const outFlag = rest.indexOf("--out");
const outFile = outFlag >= 0 ? rest[outFlag + 1] : null;
const fileFlag = rest.indexOf("--file");
const proposalFile = fileFlag >= 0 ? rest[fileFlag + 1] : null;

switch (sub) {
  case "report":
    cmdReport(profileDir);
    break;
  case "cluster":
    await cmdCluster(profileDir, outFile);
    break;
  case "seed":
    cmdSeed(profileDir, proposalFile, apply);
    break;
  case "merge-report":
    await cmdMergeReport(profileDir);
    break;
  default:
    console.error(
      [
        "l1-admin · scene-pool — L1 工作场景池运维",
        "",
        "  report                     池状态 + 批级指标（只读）",
        "  cluster [--out f.json]     历史场景名聚类（只读；复现 ≥2 次的才参与）",
        "  seed --file p.json [--apply]  按「旧名→稳定标签」提案播种（默认 dry-run）",
        "  merge-report               池内合并候选（只读；不含 apply）",
        "",
        "公共参数：--profile <dir>（默认 C:/Users/leaf/.pi/agent/profiles/default）",
      ].join("\n"),
    );
    process.exit(sub ? 2 : 0);
}
