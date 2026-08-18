/**
 * embedding 监控统计
 *
 * 位置：{profilePath}/memoryDB/embedding-stats.json
 * 内容：调用计数、缓存命中率、平均延迟、最后调用时间
 *
 * 每次 l1_commit 写入向量后更新（append 模式，不覆盖）
 * 每天自动清理 7 天前的记录
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EmbeddingStatsRecord {
  timestamp: string;
  event: "embed" | "search" | "cache_hit" | "cache_miss" | "error";
  model?: string;
  latencyMs?: number;
  dimensions?: number;
  batchSize?: number;
  errorMessage?: string;
}

export interface EmbeddingStatsSummary {
  totalEmbeds: number;
  totalSearches: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  lastCallTime: string | null;
  errorCount: number;
}

const STATS_DIR = "memoryDB";
const STATS_FILE = "embedding-stats.json";
const MAX_DAYS = 7;

/**
 * 追加一条统计记录
 */
export function appendEmbeddingStat(
  profilePath: string,
  record: EmbeddingStatsRecord
): void {
  try {
    const statsPath = join(profilePath, STATS_DIR, STATS_FILE);
    let stats: EmbeddingStatsRecord[] = [];

    if (existsSync(statsPath)) {
      try {
        stats = JSON.parse(readFileSync(statsPath, "utf-8"));
      } catch {
        stats = [];
      }
    }

    stats.push(record);

    // 清理 7 天前的记录
    const cutoff = Date.now() - MAX_DAYS * 86400000;
    stats = stats.filter((r) => {
      try {
        return new Date(r.timestamp).getTime() > cutoff;
      } catch {
        return true;
      }
    });

    writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf-8");
  } catch {
    // 统计写入失败不阻塞主流程
  }
}

/**
 * 获取统计摘要
 */
export function getEmbeddingStatsSummary(profilePath: string): EmbeddingStatsSummary {
  const statsPath = join(profilePath, STATS_DIR, STATS_FILE);
  const empty: EmbeddingStatsSummary = {
    totalEmbeds: 0,
    totalSearches: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheHitRate: 0,
    avgLatencyMs: 0,
    lastCallTime: null,
    errorCount: 0,
  };

  if (!existsSync(statsPath)) return empty;

  try {
    const stats: EmbeddingStatsRecord[] = JSON.parse(readFileSync(statsPath, "utf-8"));
    let totalLatency = 0;
    let latencyCount = 0;

    for (const r of stats) {
      if (r.event === "embed") {
        empty.totalEmbeds++;
        if (r.latencyMs !== undefined) {
          totalLatency += r.latencyMs;
          latencyCount++;
        }
      } else if (r.event === "search") {
        empty.totalSearches++;
      } else if (r.event === "cache_hit") {
        empty.cacheHits++;
      } else if (r.event === "cache_miss") {
        empty.cacheMisses++;
      } else if (r.event === "error") {
        empty.errorCount++;
      }
    }

    const totalCache = empty.cacheHits + empty.cacheMisses;
    empty.cacheHitRate = totalCache > 0 ? empty.cacheHits / totalCache : 0;
    empty.avgLatencyMs = latencyCount > 0 ? totalLatency / latencyCount : 0;
    empty.lastCallTime = stats.length > 0 ? stats[stats.length - 1].timestamp : null;

    return empty;
  } catch {
    return empty;
  }
}
