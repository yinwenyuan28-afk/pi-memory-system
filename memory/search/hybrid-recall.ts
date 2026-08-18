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

  try {
    const { getEmbeddingService } = await import("./embedding/service.js");
    const { getVectorStore } = await import("./vector-store/store.js");

    const embService = await getEmbeddingService(profilePath);
    const vecStore = await getVectorStore(profilePath);

    if (await vecStore.isAvailable() && (await vecStore.count()) > 0) {
      const queryVec = await embService.embed(queryText);
      const hits = await vecStore.search(queryVec, topK);

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
            scene_name: rec.scene_name,
            createdAt: rec.createdAt,
          });
        }
      }
    }
  } catch (e) {
    console.warn(
      `[recall-l1Records] 召回失败: ${e instanceof Error ? e.message : String(e)}`
    );
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