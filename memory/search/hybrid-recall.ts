/**
 * recallL1Records：仅召回 L1 原子记忆（vec store）
 *
 * 用户修正（2026-08-18）：
 * - 原误命名为 hybridRecall + 返回 {subMemories, l1Records}（沾边旧记忆系统 jieba/sub-memories）
 * - 修正为只召回 L1 records（vec store embedding cosine）
 * - 与旧记忆系统（LLMKeywordSearcher / jieba 倒排 / sub-memories）完全解耦
 *
 * 与 embed_and_search 工具的区别：
 * - embed_and_search：l1-extractor 子代理用（dedup 召回候选池）
 * - recall_l1_records：主代理 / agent 主动调（"我当前问题涉及哪些 L1 原子记忆"）
 *
 * 与 vectorize-list 命令的区别：
 * - vectorize-list：列出全部已/未向量化 record id（运维）
 * - recall_l1_records：基于 query 找 top-K 相关（召回）
 */

import { loadL1RecordById } from "./embedding/record-loader.js";
import { loadRecallConfig } from "./recall-config.js";
import type { HitSource } from "../stats/l1-hit-stats-db.js";

/** L1 record 召回候选 */
export interface L1RecordCandidate {
  recordId: string;
  score: number;
  content: string;
  type?: string;
  priority?: number;
  scene_name?: string;
  createdAt?: string;
}

/** recallL1Records 返回结果 */
export interface RecallL1RecordsResult {
  l1Records: L1RecordCandidate[];
}

/** recallL1Records 选项 */
export interface RecallL1RecordsOptions {
  /** top-K（默认 5） */
  topK?: number;
  /**
   * 相似度下限（cosine）。显式传入时覆盖 recall-config.json 的 minScore；
   * 未传则用配置默认值（默认 0 = 不过滤）。
   */
  minScore?: number;
  /**
   * 命中来源：区分自动注入（"inject"）与工具召回（"tool"）。
   * 2026-09-02 起写入 l1_hit_stats.inject_hits / tool_hits，用于量化两条路径的贡献。
   */
  source?: HitSource;
  /**
   * turn 级去重集合（可选）：同一 agent turn 内已计过命中的 recordId 集合。
   * 传入后，同一 turn 内重复召回（loop-start 自动注入 + 工具多次调用）只计一次命中；
   * 未传则保持「每次召回 +1」的原行为。
   */
  hitDedupSet?: Set<string>;
}

/**
 * 仅召回 L1 原子记忆（vec store cosine top-K + 加载完整 content）
 *
 * @param queryText 查询文本
 * @param profilePath profile 根目录
 * @param options 召回选项
 * @returns L1 records 召回结果
 */
export async function recallL1Records(
  queryText: string,
  profilePath: string,
  options: RecallL1RecordsOptions = {}
): Promise<RecallL1RecordsResult> {
  const result: RecallL1RecordsResult = {
    l1Records: [],
  };

  if (!queryText || !profilePath) return result;

  const topK = options.topK ?? 5;
  // 闸门参数来源：recall-config.json（profile 级可覆盖），options 显式传参优先
  const cfg = loadRecallConfig(profilePath);
  const minScore = options.minScore ?? cfg.minScore;
  const shadowMode = cfg.shadowMode;

  try {
    const { getEmbeddingService } = await import("./embedding/service.js");
    const { getVectorStore } = await import("./vector-store/store.js");

    const embService = await getEmbeddingService(profilePath);
    const vecStore = await getVectorStore(profilePath);

    if (await vecStore.isAvailable() && (await vecStore.count()) > 0) {
      const queryVec = await embService.embed(queryText);
      const hits = await vecStore.search(queryVec, topK);

      // ── 闸门 1：相关性阈值 ─────────────────────────────
      // shadowMode=true：只统计会被滤掉多少，不真剔除（标定期观察用）
      let kept = hits;
      let filtered = 0;
      if (minScore > 0) {
        filtered = hits.filter((h) => h.score < minScore).length;
        if (!shadowMode) kept = hits.filter((h) => h.score >= minScore);
      }

      // ── 闸门 2：字符预算（单条截断 + 总量封顶） ─────────
      // 加载完整 record 内容
      let totalChars = 0;
      for (const hit of kept) {
        const rec = await loadL1RecordById(hit.recordId, profilePath);
        if (!rec || rec.deleted) continue;
        let content = rec.content;
        if (cfg.maxCharsPerRecord > 0 && content.length > cfg.maxCharsPerRecord) {
          content = content.slice(0, cfg.maxCharsPerRecord) + "…";
        }
        totalChars += content.length + 2; // 每条加换行开销
        if (cfg.maxTotalChars > 0 && totalChars > cfg.maxTotalChars) break;
        result.l1Records.push({
          recordId: hit.recordId,
          score: hit.score,
          content,
          type: rec.type,
          priority: rec.priority,
          scene_name: rec.scene_name,
          createdAt: rec.createdAt,
        });
      }

      // 观测日志：调 minScore 的唯一依据（filtered 多 → 阈值偏低；0 且全进 → 可下调）
      if (hits.length > 0) {
        console.log(
          `[l1-recall] recall=${hits.length} filtered=${filtered}` +
            ` kept=${result.l1Records.length} minScore=${minScore}` +
            (shadowMode ? " (shadow)" : "") +
            ` q="${queryText.slice(0, 40)}${queryText.length > 40 ? "…" : ""}"`
        );
      }
    }
  } catch (e) {
    console.warn(
      `[recall-l1Records] 召回失败: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // 命中计数：agent 面向召回 → 每条返回的 record 命中 +1
  // 仅此处（recallL1Records）统一负责；loop-start 自动注入与 recall_l1_records 工具都走本函数。
  // turn 级去重：传入 hitDedupSet 后，同一 turn 内已计过命中的 record 不再重复 +1
  // （自动注入 top-3 与工具 top-5 语义重叠，若不按 turn 去重会双重计数）。
  // （embed_and_search 走 l1-extractor 去重，不调用本函数，不计数）
  if (result.l1Records.length > 0) {
    try {
      const { getL1HitStatsDB } = await import("../stats/l1-hit-stats-db.js");
      const dedupSet = options.hitDedupSet;
      const allIds = result.l1Records.map((r) => r.recordId);
      let ids = allIds;
      if (dedupSet) {
        ids = allIds.filter((id) => !dedupSet.has(id));
        // 本 turn 见过的都标记（含已计过的），后续调用不再计数
        for (const id of allIds) dedupSet.add(id);
      }
      if (ids.length > 0) getL1HitStatsDB(profilePath).recordHits(ids, options.source);
    } catch (e) {
      console.warn(
        `[recall-l1Records] 命中计数失败（不影响召回）: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return result;
}

/**
 * 格式化 recallL1Records 结果为可读字符串
 */
export function formatRecallL1Records(
  result: RecallL1RecordsResult,
  limit = 5
): string {
  const lines: string[] = [];

  lines.push(`=== L1 原子记忆召回 ===`);
  lines.push(`召回 ${result.l1Records.length} 条 L1 records：\n`);

  for (let i = 0; i < Math.min(result.l1Records.length, limit); i++) {
    const r = result.l1Records[i];
    lines.push(
      `[${i + 1}] score=${r.score.toFixed(4)} | ${r.type || "?"} | priority=${r.priority ?? "?"} | ${r.recordId}`
    );
    lines.push(
      `    ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`
    );
    if (r.scene_name) lines.push(`    scene: ${r.scene_name}`);
    lines.push("");
  }

  if (result.l1Records.length > limit) {
    lines.push(`... 还有 ${result.l1Records.length - limit} 条未显示`);
  }

  return lines.join("\n");
}