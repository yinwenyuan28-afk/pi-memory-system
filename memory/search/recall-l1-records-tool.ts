/**
 * recall_l1_records 工具注册
 *
 * 用户修正（2026-08-18）：
 * - 工具只召回 L1 原子记忆（vec store）
 * - 不沾边旧记忆系统（jieba 倒排 / LLMKeywordSearcher / sub-memories）
 * - 与 embed_and_search（l1-extractor dedup 用）区别：这是主代理/agent 主动调
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 工具参数 */
interface RecallL1RecordsArgs {
  queryText: string;
  topK?: number;
}

/**
 * 注册 recall_l1_records 工具
 *
 * @param pi ExtensionAPI
 * @param hitDedupSet 可选：turn 级去重集合（index.ts 传入 currentTurnHitSet）。
 *                    与 loop-start 自动注入共用，同一 turn 内重复召回的记录只计 1 次命中。
 */
export function registerRecallL1RecordsTool(pi: ExtensionAPI, hitDedupSet?: Set<string>) {
  pi.registerTool({
    name: "recall_l1_records",
    description:
      "Search your L1 atomic memories (durable facts, work methods, tasks, and artifacts " +
      "extracted from past sessions) by semantic similarity. " +
      "Use when: (a) the auto-injected <l1-records> block at the top does not cover what you need; " +
      "(b) the user references something from earlier sessions — past decisions, project conventions, " +
      "preferences, or previously fixed issues; (c) you need more candidates than the injected top-3. " +
      "Returns top-K records as {recordId, score, content, type, priority, scene_name, createdAt}. " +
      "Call limit: max 3 times per turn total. " +
      "If 3 attempts return nothing relevant, the memory is not stored — answer from existing context. " +
      "Independent of the legacy memory system (jieba inverted index / sub-memories).",
    parameters: {
      queryText: {
        type: "string",
        description: "查询文本（一般是当前问题或想找的相关原子记忆主题）",
      },
      topK: {
        type: "number",
        description: "返回 top-K 候选（默认 5）",
      },
    },
    execute: async (toolCallId: string, params: RecallL1RecordsArgs) => {
      const { queryText, topK = 5 } = params;

      if (!queryText || queryText.trim().length === 0) {
        return { candidates: [], error: "queryText 为空" };
      }

      try {
        const { recallL1Records } = await import("./hybrid-recall.js");
        const profilePath = process.env.PI_PROFILE_PATH ?? "";

        const result = await recallL1Records(queryText, profilePath, { topK, hitDedupSet, source: "tool" });
        return {
          candidates: result.l1Records,
          stats: {
            l1RecordsReturned: result.l1Records.length,
            queryText: queryText.slice(0, 50) + (queryText.length > 50 ? "..." : ""),
          },
        };
      } catch (e: any) {
        return {
          candidates: [],
          error: `recall_l1_records 失败: ${e.message}`,
        };
      }
    },
  });
}