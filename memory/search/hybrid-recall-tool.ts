/**
 * hybrid_recall 工具注册
 *
 * 供 agent 主动调用的混合召回工具：
 * - sub-memories：jieba 倒排（实际注入走主进程 before_agent_start，本工具不重复）
 * - L1 records：embedding cosine top-K
 *
 * 参数：
 * - queryText：查询文本（必填）
 * - topK：L1 records top-K（默认 5）
 *
 * 返回：
 * - candidates：L1 records 候选（含 record_id + content + type + priority + score）
 * - subMemoriesNote：提示 sub-memories 走主进程注入
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 工具参数 */
interface HybridRecallArgs {
  queryText: string;
  topK?: number;
}

/**
 * 注册 hybrid_recall 工具
 */
export function registerHybridRecallTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "hybrid_recall",
    description:
      "Mixed retrieval: embed queryText, cosine search top-K L1 records, return record_id + content + type + priority + score. " +
      "Use when you want to find related L1 atomic memories (work_fact/work_method/work_task/work_artifact) " +
      "without going through the full L1-extractor pipeline. " +
      "Returns {candidates, subMemoriesNote} — L1 records from vector store (immediate), " +
      "sub-memories are injected via before_agent_start (automatic, not via this tool).",
    parameters: {
      queryText: {
        type: "string",
        description: "查询文本（一般是用户当前问题或 LLM 想找相关记忆）",
      },
      topK: {
        type: "number",
        description: "返回 L1 records top-K 候选（默认 5）",
      },
    },
    execute: async (args: HybridRecallArgs) => {
      const { queryText, topK = 5 } = args;

      if (!queryText || queryText.trim().length === 0) {
        return { candidates: [], error: "queryText 为空" };
      }

      try {
        const { hybridRecall } = await import("./hybrid-recall.js");
        const profilePath = process.env.PI_PROFILE_PATH ?? "";

        const result = await hybridRecall(queryText, profilePath, { l1RecordsTopK: topK });
        return {
          candidates: result.l1Records,
          subMemoriesNote:
            "sub-memories 召回走主进程 before_agent_start 的 jieba 注入，不通过本工具返回",
          stats: {
            l1RecordsReturned: result.l1Records.length,
            queryText: queryText.slice(0, 50) + (queryText.length > 50 ? "..." : ""),
          },
        };
      } catch (e: any) {
        return {
          candidates: [],
          subMemoriesNote: "sub-memories 召回走主进程 before_agent_start 的 jieba 注入",
          error: `hybrid_recall 失败: ${e.message}`,
        };
      }
    },
  });
}