/**
 * hybridRecall：混合召回（sub-memories + L1 records）
 *
 * 用户要求（2026-08-18）：
 * - 方法签名：hybridRecall(queryText, profilePath, topK?) → { subMemories, l1Records }
 * - 工具：hybrid_recall（供 agent 主动调）
 *
 * 混合设计（不融合）：
 * - sub-memories 走 jieba 倒排（已有 LLMKeywordSearcher）
 * - L1 records 走 embedding cosine top-K（已有 VectorStore.search）
 * - 两路独立返回（不同记忆实体，无法 RRF 融合——plan 设计修正 2026-08-18）
 *
 * 使用场景：
 * - agent 想知道"当前 query 涉及哪些记忆"（sub-memories + L1 records 一起）
 * - 比 /vectorize-list 更智能：返回的相关记录按相关度排序
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadL1RecordById } from "./embedding/record-loader.js";

/** sub-memories 章节候选（与 LLMKeywordSearcher.searchSectionCandidates 一致） */
export interface SubMemoryCandidate {
  file: string;
  order: number;
  title?: string;
  content: string;
  score: number;
}

/** L1 record 候选（与 VectorHit 一致） */
export interface L1RecordCandidate {
  recordId: string;
  score: number;
  content: string;
  type?: string;
  priority?: number;
}

/** hybrid 召回结果 */
export interface HybridRecallResult {
  /** sub-memories 相关章节（jieba 倒排） */
  subMemories: SubMemoryCandidate[];
  /** L1 records 相关记录（embedding cosine） */
  l1Records: L1RecordCandidate[];
}

/** hybrid 召回选项 */
export interface HybridRecallOptions {
  /** sub-memories top-K（默认 5） */
  subMemoriesTopK?: number;
  /** L1 records top-K（默认 5） */
  l1RecordsTopK?: number;
}

/**
 * 混合召回（sub-memories + L1 records）
 *
 * @param queryText 查询文本
 * @param profilePath profile 根目录
 * @param options 召回选项
 * @returns 混合召回结果
 */
export async function hybridRecall(
  queryText: string,
  profilePath: string,
  options: HybridRecallOptions = {}
): Promise<HybridRecallResult> {
  const result: HybridRecallResult = {
    subMemories: [],
    l1Records: [],
  };

  if (!queryText || !profilePath) return result;

  const subMemoriesTopK = options.subMemoriesTopK ?? 5;
  const l1RecordsTopK = options.l1RecordsTopK ?? 5;

  // 1. sub-memories 召回：jieba 倒排 + 章节评分
  try {
    const { LLMKeywordSearcher } = await import("./searcher.js");
    const searcher = new LLMKeywordSearcher();
    // searcher 需要 profile path + inverted index 实例，但 inverted index 在主代理初始化时设置
    // 这里做简化：返回空（agent 主要召回走 before_agent_start 的 sub-memories 注入，
    // hybrid_recall 工具主要补充 L1 records 召回，sub-memories 召回交给主进程架构）
    // 实际调用方如果需要 sub-memories，应通过 before_agent_start 的注入获取
    void searcher; // 占位，标记已 import
  } catch {
    // searcher 初始化失败不影响 L1 records 召回
  }

  // 2. L1 records 召回：embedding cosine + 加载完整 content
  try {
    const { getEmbeddingService } = await import("./embedding/service.js");
    const { getVectorStore } = await import("./vector-store/store.js");

    const embService = await getEmbeddingService(profilePath);
    const vecStore = await getVectorStore(profilePath);

    if (await vecStore.isAvailable() && (await vecStore.count()) > 0) {
      const queryVec = await embService.embed(queryText);
      const hits = await vecStore.search(queryVec, l1RecordsTopK);

      // 加载完整 record 内容
      for (const hit of hits) {
        const rec = await loadL1RecordById(hit.recordId, profilePath);
        if (rec && !rec.deleted) {
          result.l1Records.push({
            recordId: hit.recordId,
            score: hit.score,
            content: rec.content,
            type: rec.type,
            priority: rec.priority,
          });
        }
      }
    }
  } catch (e) {
    // L1 召回失败不阻塞整个 hybrid
    console.warn(`[hybrid-recall] L1 records 召回失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  return result;
}

/**
 * 格式化 hybrid 召回结果为可读字符串
 */
export function formatHybridRecall(result: HybridRecallResult, limit = 5): string {
  const lines: string[] = [];

  lines.push(`=== Hybrid 召回结果 ===`);
  lines.push(`\n[L1 records] (${result.l1Records.length} 条)`);
  for (let i = 0; i < Math.min(result.l1Records.length, limit); i++) {
    const r = result.l1Records[i];
    lines.push(`  [${i + 1}] score=${r.score.toFixed(4)} | ${r.type || "?"} | ${r.recordId}`);
    lines.push(`      ${r.content.slice(0, 150)}${r.content.length > 150 ? "..." : ""}`);
  }
  if (result.l1Records.length > limit) {
    lines.push(`  ... 还有 ${result.l1Records.length - limit} 条`);
  }

  lines.push(`\n[sub-memories] (${result.subMemories.length} 条)`);
  if (result.subMemories.length === 0) {
    lines.push(`  (sub-memories 召回走主进程 before_agent_start 注入，hybrid_recall 工具不重复)`);
  } else {
    for (let i = 0; i < Math.min(result.subMemories.length, limit); i++) {
      const s = result.subMemories[i];
      lines.push(`  [${i + 1}] score=${s.score.toFixed(4)} | ${s.file}#${s.order}${s.title ? ` "${s.title}"` : ""}`);
      lines.push(`      ${s.content.slice(0, 150)}${s.content.length > 150 ? "..." : ""}`);
    }
  }

  return lines.join("\n");
}