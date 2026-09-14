/**
 * embed_and_search 工具注册
 *
 * 让 l1-extractor 子代理有工具能力调 embedding + vector store search
 * 子代理自主执行，不占用主代理时间和上下文窗口
 *
 * 工具行为：embed queryText → cosine top-K → 返回 record 完整内容
 * 降级路径：embedding 不可用时返回空数组（子代理走全量 read 保底）
 *
 * 依赖：
 * - embedding/service.ts（EmbeddingService，懒加载）
 * - vector-store/store.ts（VectorStore，懒加载）
 * - L1 records JSONL（按 recordId 加载完整内容）
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadL1RecordById } from "./record-loader.ts";
import { render as renderPrompt } from "../../../prompts/registry.ts";

/** 工具参数 */
interface EmbedAndSearchArgs {
  queryText: string;
  topK?: number;
}

/**
 * 注册 embed_and_search 工具
 *
 * 用法：在扩展的 index.ts 中调用 registerEmbedAndSearchTool(pi)
 * 子代理 agent 定义的 tools: 加 embed_and_search 即可使用
 */
export function registerEmbedAndSearchTool(pi: { registerTool: (tool: any) => void }) {
  pi.registerTool({
    name: "embed_and_search",
    description: renderPrompt("tools#embed_and_search"),
    parameters: {
      queryText: {
        type: "string",
        description: "查询文本（一般是 L1 提取出的新记忆 content）",
      },
      topK: {
        type: "number",
        description: "返回 top-K 候选（默认 5）",
      },
    },
    execute: async (toolCallId: string, params: EmbedAndSearchArgs) => {
      const { queryText, topK = 5 } = params;

      // 防御：空输入
      if (!queryText || queryText.trim().length === 0) {
        return { candidates: [], error: "queryText 为空" };
      }

      try {
        // 1. 获取 embedding service 和 vector store（懒加载）
        const { getEmbeddingService } = await import("./service.ts");
        const { getVectorStore } = await import("../vector-store/store.ts");

        const embeddingService = await getEmbeddingService();
        const vectorStore = await getVectorStore();

        // 2. 可用性检查
        if (!(await vectorStore.isAvailable())) {
          return { candidates: [], fallback: true, reason: "vector store 不可用" };
        }

        // 3. Embed queryText
        const queryVec = await embeddingService.embed(queryText);

        // 4. Cosine search top-K
        const hits = await vectorStore.search(queryVec, topK);

        if (hits.length === 0) {
          return { candidates: [], fallback: true, reason: "无匹配候选" };
        }

        // 5. 加载完整 record 内容
        const candidates = await Promise.all(
          hits.map(async (hit) => {
            const profilePath = process.env.PI_PROFILE_PATH ?? "";
            const record = await loadL1RecordById(hit.recordId, profilePath);
            return {
              record_id: hit.recordId,
              score: hit.score,
              ...(record ?? { content: "(record not found)", type: "unknown", priority: 0 }),
            };
          })
        );

        return {
          candidates,
          queryVector: queryVec,
          stats: {
            embedding_model: embeddingService.getModelId(),
            dimensions: embeddingService.getDimensions(),
            search_latency_ms: Date.now(), // 近似
          },
        };
      } catch (e: any) {
        // 降级：返回空，子代理走全量 read 保底
        return {
          candidates: [],
          fallback: true,
          reason: `embed_and_search 失败: ${e.message}`,
        };
      }
    },
  });
}
