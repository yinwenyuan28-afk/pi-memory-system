/**
 * L1 质量评价体系 — 读侧质量分 + 排行（D1-D7）
 *
 * 公式（审查定版）：
 *   effective = hits - invalid（DB 已钳制 effective≥0，但计算侧用原始 invalid/hits）
 *   days      = (now - last_hit_at) 若无命中则 (now - createdAt)
 *   decay     = exp(-days / 14)          // D2 半衰 14 天
 *   penalty   = hits>0 ? (1 - min(invalid/hits, 0.8)) : 1  // D1 乘法失效率，封顶 0.8
 *   quality   = 新记录保护 ? max(priority/100, 0.3) : effective * decay * penalty  // D4
 *   标签：噪(失效率>50%) > 热(≥5) > 冷(0且>14天) > 新(<7天0命中) > 待观察(7-14天0命中) > 温(1-4)
 */

import { loadAllL1Records, type L1Record } from "../search/embedding/record-loader.js";
import { getL1HitStatsDB, type L1HitStat } from "../stats/l1-hit-stats-db.js";

/** 质量分计算结果 */
export interface QualityScore {
  quality: number;
  decay: number;
  days: number;
  tag: "热" | "温" | "冷" | "新" | "噪" | "待观察";
  effective: number;
  hits: number;
  invalid: number;
}

/** 排行项（record + hit + quality） */
export interface RankedL1Record extends L1Record, QualityScore {
  stat?: L1HitStat;
}

/**
 * 计算单条 L1 的质量分（纯函数，不读 DB）
 *
 * @param rec L1 record
 * @param stat 命中统计（无则视为 0 命中新记录）
 * @param nowMs 当前时间戳（测试可注入）
 */
export function calcQuality(rec: L1Record, stat?: L1HitStat, nowMs: number = Date.now()): QualityScore {
  const hits = stat?.hits ?? 0;
  const invalid = stat?.invalidHits ?? 0;
  const effective = stat?.effectiveHits ?? 0;

  const now = nowMs;
  const last = stat?.lastHitAt ? new Date(stat.lastHitAt).getTime() : NaN;
  const created = rec.createdAt ? new Date(rec.createdAt).getTime() : now;
  const baseTime = !isNaN(last) ? last : created;
  const days = Math.max(0, (now - baseTime) / 86400000);
  const decay = Math.exp(-days / 14); // D2

  // D4 新记录保护：<7天且 0 命中，用 priority 保底
  if (!stat && days < 7) {
    const pri = typeof rec.priority === "number" ? rec.priority : 50;
    const quality = Math.max(pri / 100, 0.3);
    return { quality, decay, days, tag: "新", effective, hits, invalid };
  }

  // 噪优先：失效率>50%（仅 hits>0 时）
  if (hits > 0 && invalid / hits > 0.5) {
    const penalty = 1 - Math.min(invalid / hits, 0.8);
    const quality = effective * decay * penalty;
    return { quality, decay, days, tag: "噪", effective, hits, invalid };
  }

  const penalty = hits > 0 ? 1 - Math.min(invalid / hits, 0.8) : 1;
  const quality = effective * decay * penalty;

  let tag: QualityScore["tag"] = "温";
  if (effective >= 5) tag = "热";
  else if (effective === 0 && days > 14) tag = "冷";
  else if (effective === 0 && days < 7) tag = "新";
  else if (effective === 0 && days >= 7 && days <= 14) tag = "待观察";
  else if (effective >= 1 && effective <= 4) tag = "温";

  return { quality, decay, days, tag, effective, hits, invalid };
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

  const ranked: RankedL1Record[] = records.map((rec) => {
    const stat = statsMap.get(rec.id);
    const q = calcQuality(rec, stat, nowMs);
    return { ...rec, ...q, stat };
  });

  ranked.sort((a, b) => b.quality - a.quality);
  return ranked.slice(0, topK);
}

/**
 * 汇总分布（用于 my-memory:l1:stats）
 */
export async function getQualityStats(profilePath: string, nowMs: number = Date.now()) {
  const records = await loadAllL1Records(profilePath, 365);
  let statsMap = new Map<string, L1HitStat>();
  try {
    const db = getL1HitStatsDB(profilePath);
    const stats = db.getAllStats();
    for (const s of stats) statsMap.set(s.recordId, s);
  } catch {}

  const ranked: RankedL1Record[] = records.map((rec) => {
    const stat = statsMap.get(rec.id);
    const q = calcQuality(rec, stat, nowMs);
    return { ...rec, ...q, stat };
  });

  const dist: Record<string, number> = { 热: 0, 温: 0, 冷: 0, 新: 0, 噪: 0, 待观察: 0 };
  for (const r of ranked) dist[r.tag] = (dist[r.tag] ?? 0) + 1;

  const cold = ranked.filter((r) => r.tag === "冷");
  const noisy = ranked.filter((r) => r.tag === "噪");
  const histogram = {
    "0-2": ranked.filter((r) => r.quality >= 0 && r.quality < 2).length,
    "2-4": ranked.filter((r) => r.quality >= 2 && r.quality < 4).length,
    "4-6": ranked.filter((r) => r.quality >= 4 && r.quality < 6).length,
    "6+": ranked.filter((r) => r.quality >= 6).length,
  };

  ranked.sort((a, b) => b.quality - a.quality);

  return { total: records.length, dist, cold, noisy, histogram, ranked };
}
