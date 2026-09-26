/**
 * L1 质量评价体系 — 读侧质量分 + 排行（D1-D7）
 *
 * 公式（审查定版）：
 *   effective = hits - invalid（DB 已钳制 effective≥0，但计算侧用原始 invalid/hits）
 *   days      = 自 last_hit_at（无命中则 createdAt）以来的【活跃会话日】数
 *   decay     = exp(-days / 14)          // D2 半衰 14 天
 *   penalty   = hits>0 ? (1 - min(invalid/hits, 0.8)) : 1  // D1 乘法失效率，封顶 0.8
 *   quality   = 新记录保护 ? max(priority/100, 0.3) : effective * decay * penalty  // D4
 *   标签：噪(失效率>50%) > 热(有效命中≥5) > 温(有效命中1-4) > 新(创建<7天)
 *        > 冷(0有效命中且>14活跃日未曝光) > 待观察(0有效命中且≤14活跃日未曝光)
 *
 *   注意区分两个时间量：
 *     days    = 活跃会话日，喂给 decay 与 冷/待观察 判定（"错过多少个工作日的曝光机会"）
 *     ageDays = 日历天真实年龄，只用于新记录保护与「新」标签（避免停工用户老记忆被误判为新）
 *
 * ── 关于 days：为什么用活跃会话日而不是墙上时钟 ──
 *
 * 原实现 days = (now - last_hit_at)/86400000，是纯日历天数。这会让 decay 度量的是
 * "用户多久没开工"，而不是"这条记忆是否过时"——两者是完全不同的量。
 * 典型失效：用户休假 60 天，一条 18 次命中的高价值记忆 quality 跌到 0.25，
 * 与废记忆同分；而事实上它从未获得过被重新验证的机会。
 *
 * 现改为统计 base 之后的【活跃会话日】数量，活跃日从 L0 归档分片
 * `memoryDB/l0/conversations/YYYY-MM-DD.jsonl` 的文件名推导（零新增写入）。
 * 停工期间 days 不增长 → decay 冻结，复工后按实际工作节奏继续衰减。
 *
 * 已知局限：活跃日是全局的，不区分项目。个人开发者单线工作场景下成立；
 * 若长期并行多项目，某项目休眠而全局活跃时，该项目记忆仍会衰减。
 *
 * ── 关于 quality 与淘汰权：为什么要分开 ──
 *
 * quality 是"热度"，长期不被命中就趋近 0 —— 这符合人类记忆的遗忘曲线，是对的。
 * 但人类遗忘表现为"提取变难"，不是"信息从脑中被删除"。
 * 因此删除资格不由 quality 单独决定，见 judgePrune()：
 * 只有【被真实证伪】或【长期闲置且内在价值低】的记忆才进入淘汰候选；
 * 高 priority 与 work_method 类记忆永不自动淘汰，只降权、不删除（仍可被向量召回）。
 */

import { loadAllL1Records, type L1Record } from "../search/embedding/record-loader.ts";
import { getL1HitStatsDB, type L1HitStat } from "../stats/l1-hit-stats-db.ts";
import { activeDayKeysToTimestamps, countActiveDaysAfter, loadActiveDayKeys, startOfLocalDay } from "./active-days.ts";

/** 质量分计算结果 */
export interface QualityScore {
  quality: number;
  decay: number;
  /** 自 last_hit_at（无命中则 createdAt）以来的活跃会话日数；无活跃日数据时退化为日历天数 */
  days: number;
  tag: "热" | "温" | "冷" | "新" | "噪" | "待观察";
  effective: number;
  hits: number;
  invalid: number;
  /** days 是否按活跃会话日计算（false = 退化为墙上时钟，仅当活跃日数据不可得） */
  activeDayClock: boolean;
}

/** 排行项（record + hit + quality） */
export interface RankedL1Record extends L1Record, QualityScore {
  stat?: L1HitStat;
}

/** 淘汰判定：quality 是热度，prune 是删除资格，两者分离 */
export interface PruneVerdict {
  eligible: boolean;
  reason: "falsified" | "idle-low-value" | "protected-priority" | "protected-type" | "verified" | "too-early";
}

/** 淘汰规则（可调参数集中在此） */
export const PRUNE_RULES = {
  /** 判定「被证伪」所需的最小曝光次数，避免单次误判即淘汰 */
  minHitsForFalsified: 3,
  /** 失效率阈值：超过即视为被真实证伪 */
  invalidRatio: 0.5,
  /** 长期闲置进入淘汰候选所需的活跃会话日数 */
  idleActiveDays: 30,
  /** 内在价值保护线：priority >= 此值永不自动淘汰（作为下限，实际阈值取分布 P75，见 getQualityStats） */
  protectedPriority: 60,
  /** 保护带分位：实测 L1 提取的 priority 存在通胀（全库最低 65、中位 85），
   *  绝对值阈值会保护 100% 记录使淘汰失效，故按分布取相对高位 */
  protectedPercentile: 75,
} as const;

/** 受保护的类型：编码方法类记忆低曝光是常态，不能按曝光量判定生死 */
const PROTECTED_TYPES: readonly string[] = ["work_method"];

/**
 * 读取活跃会话日时间戳（升序，本地日 0 点）
 *
 * @param profilePath profile 根目录
 * @returns 时间戳数组；无 L0 分片时返回 undefined（调用方退化为墙上时钟）
 */
export function loadActiveDays(profilePath: string): number[] | undefined {
  const keys = loadActiveDayKeys(profilePath);
  return keys ? activeDayKeysToTimestamps(keys) : undefined;
}

// `startOfLocalDay` / `countActiveDaysAfter` 2026-09-27 移入 `active-days.ts` 并导出（单源）：
// L2 归档的事实清单（"自 updated 起过了几个活跃日"）需要同一个量，放在那边才不会两处各写一份。

/**
 * 计算单条 L1 的质量分（纯函数，不读 DB）
 *
 * @param rec L1 record
 * @param stat 命中统计（无则视为 0 命中新记录）
 * @param nowMs 当前时间戳（测试可注入）
 * @param activeDays 活跃会话日时间戳（升序，本地日 0 点）；不传则 days 退化为日历天数
 */
export function calcQuality(
  rec: L1Record,
  stat?: L1HitStat,
  nowMs: number = Date.now(),
  activeDays?: number[],
): QualityScore {
  const hits = stat?.hits ?? 0;
  const invalid = stat?.invalidHits ?? 0;
  const effective = stat?.effectiveHits ?? 0;

  const now = nowMs;
  const last = stat?.lastHitAt ? new Date(stat.lastHitAt).getTime() : NaN;
  const created = rec.createdAt ? new Date(rec.createdAt).getTime() : now;
  const baseTime = !isNaN(last) ? last : created;

  // 活跃会话日时钟：停工期间不增长。无活跃日数据时退化为墙上时钟。
  const activeDayClock = Array.isArray(activeDays);
  const days = activeDayClock
    ? countActiveDaysAfter(activeDays, baseTime)
    : Math.max(0, (now - baseTime) / 86400000);
  const decay = Math.exp(-days / 14); // D2

  // 记录真实年龄（日历天）：新记录保护期与「新」标签只认它，不认活跃日——
  // 否则停工用户的老记忆会因活跃日少而被误判为新记录，拿回 priority 保底分。
  const ageDays = Math.max(0, (now - created) / 86400000);

  // D4 新记录保护：创建 <7 天且 0 命中，用 priority 保底
  if (!stat && ageDays < 7) {
    const pri = typeof rec.priority === "number" ? rec.priority : 50;
    const quality = Math.max(pri / 100, 0.3);
    return { quality, decay, days, tag: "新", effective, hits, invalid, activeDayClock };
  }

  // 噪优先：失效率>50%（仅 hits>0 时）
  if (hits > 0 && invalid / hits > 0.5) {
    const penalty = 1 - Math.min(invalid / hits, 0.8);
    const quality = effective * decay * penalty;
    return { quality, decay, days, tag: "噪", effective, hits, invalid, activeDayClock };
  }

  const penalty = hits > 0 ? 1 - Math.min(invalid / hits, 0.8) : 1;
  const quality = effective * decay * penalty;

  // 标签语义：热/温看有效命中数；新看真实年龄；冷/待观察看「错过多少个工作日的曝光机会」
  let tag: QualityScore["tag"] = "温";
  if (effective >= 5) tag = "热";
  else if (effective >= 1) tag = "温";
  else if (ageDays < 7) tag = "新";
  else if (days > 14) tag = "冷";
  else tag = "待观察";

  return { quality, decay, days, tag, effective, hits, invalid, activeDayClock };
}

/**
 * 淘汰资格判定（与 quality 解耦）
 *
 * quality 回答"这条记忆最近有多热"（会衰减到 0，符合遗忘曲线）；
 * judgePrune 回答"能不能删"——只有被真实证伪、或长期闲置且内在价值低的才可删。
 * 高 priority 与 work_method 类记忆永不自动淘汰：它们只是没被想起来，不是没价值。
 */
export function judgePrune(rec: L1Record, q: QualityScore, protectedPriority?: number): PruneVerdict {
  // 1. 被真实证伪：有足够曝光且失效率高（负反馈信号，优先淘汰）
  if (q.hits >= PRUNE_RULES.minHitsForFalsified && q.invalid / q.hits > PRUNE_RULES.invalidRatio) {
    return { eligible: true, reason: "falsified" };
  }

  // 2. 内在价值保护：提取时判定为高价值的记忆，不因曝光量少而删除
  const threshold = protectedPriority ?? PRUNE_RULES.protectedPriority;
  const pri = typeof rec.priority === "number" ? rec.priority : 50;
  if (pri >= threshold) return { eligible: false, reason: "protected-priority" };
  if (PROTECTED_TYPES.includes(rec.type ?? "")) return { eligible: false, reason: "protected-type" };

  // 3. 被有效使用过的记忆不因闲置淘汰
  if (q.effective > 0) return { eligible: false, reason: "verified" };

  // 4. 长期闲置 + 低内在价值 → 淘汰候选（对应人类记忆中真正被清理的部分）
  if (q.days >= PRUNE_RULES.idleActiveDays) return { eligible: true, reason: "idle-low-value" };

  return { eligible: false, reason: "too-early" };
}

/**
 * 按质量分排行（左连接 records + hit_stats，查询时算分，不持久化）
 *
 * @param profilePath profile 根目录
 * @param topK 取前 K 条（默认 20）
 * @param nowMs 当前时间（测试注入）
 */
export async function getQualityRanked(
  profilePath: string,
  topK: number = 20,
  nowMs: number = Date.now(),
): Promise<RankedL1Record[]> {
  const records = await loadAllL1Records(profilePath, 365);
  if (records.length === 0) return [];

  let statsMap = new Map<string, L1HitStat>();
  try {
    const db = getL1HitStatsDB(profilePath);
    const stats = db.getAllStats();
    for (const s of stats) statsMap.set(s.recordId, s);
  } catch {
    // 无 DB 时全视为新记录
  }

  const activeDays = loadActiveDays(profilePath);

  const ranked: RankedL1Record[] = records.map((rec) => {
    const stat = statsMap.get(rec.id);
    const q = calcQuality(rec, stat, nowMs, activeDays);
    return { ...rec, ...q, stat };
  });

  ranked.sort((a, b) => b.quality - a.quality);
  return ranked.slice(0, topK);
}

/** 质量汇总返回结构 */
export interface QualitySummary {
  total: number;
  dist: Record<string, number>;
  cold: RankedL1Record[];
  noisy: RankedL1Record[];
  /** 淘汰候选（已过保护带，可被自动清理） */
  prune: RankedL1Record[];
  histogram: Record<string, number>;
  ranked: RankedL1Record[];
  /** 活跃会话日信息（用于诊断时钟来源） */
  clock: { activeDayClock: boolean; activeDays: number; spanDays: number };
  /** 本次实际生效的保护带阈值（priority 分布 P75，供诊断） */
  protectedPriority: number;
}

/**
 * 汇总分布（用于 my-memory:l1:stats）
 */
export async function getQualityStats(profilePath: string, nowMs: number = Date.now()): Promise<QualitySummary> {
  const records = await loadAllL1Records(profilePath, 365);
  let statsMap = new Map<string, L1HitStat>();
  try {
    const db = getL1HitStatsDB(profilePath);
    const stats = db.getAllStats();
    for (const s of stats) statsMap.set(s.recordId, s);
  } catch {}

  const activeDays = loadActiveDays(profilePath);

  const ranked: RankedL1Record[] = records.map((rec) => {
    const stat = statsMap.get(rec.id);
    const q = calcQuality(rec, stat, nowMs, activeDays);
    return { ...rec, ...q, stat };
  });

  const dist: Record<string, number> = { 热: 0, 温: 0, 冷: 0, 新: 0, 噪: 0, 待观察: 0 };
  for (const r of ranked) dist[r.tag] = (dist[r.tag] ?? 0) + 1;

  // 保护带阈值：取 priority 分布 P75（并以 protectedPriority 为下限）。
  // 实测 L1 提取 priority 通胀（最低 65、中位 85），固定阈值 60 会保护 100% 记录使淘汰失效。
  const pris = ranked
    .map((r) => (typeof r.priority === "number" ? r.priority : 50))
    .sort((a, b) => a - b);
  const protectedPriority = Math.max(
    PRUNE_RULES.protectedPriority,
    percentile(pris, PRUNE_RULES.protectedPercentile),
  );

  const cold = ranked.filter((r) => r.tag === "冷");
  const noisy = ranked.filter((r) => r.tag === "噪");
  const prune = ranked.filter((r) => judgePrune(r, r, protectedPriority).eligible);
  const histogram = {
    "0-2": ranked.filter((r) => r.quality >= 0 && r.quality < 2).length,
    "2-4": ranked.filter((r) => r.quality >= 2 && r.quality < 4).length,
    "4-6": ranked.filter((r) => r.quality >= 4 && r.quality < 6).length,
    "6+": ranked.filter((r) => r.quality >= 6).length,
  };

  ranked.sort((a, b) => b.quality - a.quality);

  const spanDays =
    activeDays && activeDays.length > 0
      ? (startOfLocalDay(nowMs) - activeDays[0]) / 86400000 + 1
      : 0;

  return {
    total: records.length,
    dist,
    cold,
    noisy,
    prune,
    histogram,
    ranked,
    clock: {
      activeDayClock: Array.isArray(activeDays),
      activeDays: activeDays?.length ?? 0,
      spanDays,
    },
    protectedPriority,
  };
}

/** 取升序数组的第 p 百分位（p=75 即 P75） */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.min(Math.max(idx, 0), sortedAsc.length - 1)];
}
