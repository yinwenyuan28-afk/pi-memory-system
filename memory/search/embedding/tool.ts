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
 *
 * ⚠️ 2026-09-19：上面两个模块必须用**静态 import**（曾经写在 execute 里 `await import()`）。
 * 原因：pi 用 jiti 加载扩展且 `moduleCache:false`，执行期动态 import 在**并发首次调用**时
 * 会把「求值未完成」的模块命名空间交给后到者，于是 getter 读到未初始化的模块级绑定：
 * 先报 `Cannot access 'storeInstance'/'serviceInstance' before initialization`；
 * 换成 globalThis holder 后又暴露出同一窗口的另一层：`Cannot read properties of
 * undefined (reading 'MEMORY_DB_DIR'/'loadEmbeddingConfig')`（import 绑定也还没赋值）。
 * 实测 3 并发 → 2 失败；线上 12 并发 → 11 失败。静态 import 让依赖在扩展加载期就求值完，
 * 工具执行时不可能再拿到半成品命名空间。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadL1RecordById } from "./record-loader.ts";
import { render as renderPrompt } from "../../../prompts/registry.ts";
// 静态导入（不得改回 execute 内的动态 import）：避免模块求值期的半成品命名空间竞态，见文件头注释
import { getEmbeddingService } from "./service.ts";
import { getVectorStore } from "../vector-store/store.ts";

/** 工具参数 */
interface EmbedAndSearchArgs {
  /** 单条查询（向后兼容） */
  queryText?: string;
  /** 批量查询（2026-09-21 新增，T4）：一次嵌入 + 一次返回多组候选，把 N 次往返压成 1 次 */
  queries?: string[];
  topK?: number;
}

/** 批量模式下一次最多几条查询（防参数滥用）。 */
const MAX_BATCH_QUERIES = 50;
/** 批量模式下候选正文的预览上限（字符）：裁决只需判"像不像"，不需要全文。 */
const BATCH_CANDIDATE_PREVIEW_CHARS = 200;

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
        description: "单条查询文本（一般是 L1 提取出的新记忆 content）。与 queries 二选一；两者都给时优先 queries",
      },
      queries: {
        type: "array",
        items: { type: "string" },
        description: "批量查询文本数组：一次嵌入 + 一次返回多组候选（推荐对整批新记忆一次调用，别逐条来回）",
      },
      topK: {
        type: "number",
        description: "每条查询返回 top-K 候选（默认 5）",
      },
    },
    execute: async (toolCallId: string, params: EmbedAndSearchArgs) => {
      const { topK = 5 } = params;
      const batch = Array.isArray(params?.queries) ? params.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0) : [];

      // ── 批量分支（2026-09-21，T4）────────────────────────────────────────
      // 为什么：实测一轮 L1 有 7–13 次 embed_and_search，每次后面都跟一整轮模型生成
      // （中位 18s）。裁决本来就是"批量判定"一次完成的，所以那十几次往返全花在"逐条检索"上 ——
      // 把检索并成一次，往返数直接降到 1，判定逻辑一个字都不用改。
      // 返回体保留每条查询自己的 queryVector（记录里的 embedding 字段要复用，避免 l1_commit 重复 embed）。
      if (batch.length > 0) {
        if (batch.length > MAX_BATCH_QUERIES) {
          return { results: [], error: `一次最多批量 ${MAX_BATCH_QUERIES} 条查询（收到 ${batch.length}）` };
        }
        try {
          const embeddingService = await getEmbeddingService();
          const vectorStore = await getVectorStore();
          if (!(await vectorStore.isAvailable())) {
            return { results: [], fallback: true, reason: "vector store 不可用" };
          }
          const vectors = await embeddingService.embedBatch(batch);
          const results = [];
          for (let i = 0; i < batch.length; i++) {
            const queryVector = vectors[i];
            const hits = await vectorStore.search(queryVector, topK);
            const candidates = await Promise.all(
              hits.map(async (hit) => {
                const profilePath = process.env.PI_PROFILE_PATH ?? "";
                const record = await loadL1RecordById(hit.recordId, profilePath);
                const full = record ?? { content: "(record not found)", type: "unknown", priority: 0 };
                // 批量模式裁剪正文预览：N 条 × topK 条完整记录会很大，而裁决只需判"像不像"。
                // **只裁剪预览，record_id 原样保留**（落盘/去重都靠 id）。
                const content = typeof (full as { content?: unknown }).content === "string" ? String((full as { content: string }).content) : "";
                return {
                  ...full,
                  ...(content.length > BATCH_CANDIDATE_PREVIEW_CHARS
                    ? { content: `${content.slice(0, BATCH_CANDIDATE_PREVIEW_CHARS)}…`, contentTruncated: true }
                    : {}),
                  record_id: hit.recordId,
                  score: hit.score,
                };
              }),
            );
            results.push({ index: i, queryText: batch[i], queryVector, candidates });
          }
          return {
            results,
            stats: {
              queries: batch.length,
              embedding_model: embeddingService.getModelId(),
              dimensions: embeddingService.getDimensions(),
              candidate_preview_chars: BATCH_CANDIDATE_PREVIEW_CHARS,
            },
          };
        } catch (e: any) {
          const stack =
            typeof e?.stack === "string"
              ? e.stack
                  .split("\n")
                  .slice(0, 7)
                  .map((s: string) => s.trim())
                  .join(" | ")
              : "";
          return { results: [], fallback: true, reason: `embed_and_search(批量) 失败: ${e.message}`, stack };
        }
      }

      // ── 单条分支（原有行为，未改）──────────────────────────────────────
      const queryText = params?.queryText;

      // 防御：空输入
      if (!queryText || queryText.trim().length === 0) {
        return { candidates: [], error: "queryText 为空（批量请用 queries 数组）" };
      }

      try {
        // 1. 获取 embedding service 和 vector store（均为懒加载单例；两个模块已在文件头部静态导入）
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
        // 2026-09-19：附带堆栈前 6 帧——此前只回 e.message，TDZ（Cannot access 'X' before
        // initialization）这类故障的真实调用路径被吞掉，只能靠猜。失败必须留下可诊断的痕迹。
        const stack =
          typeof e?.stack === "string"
            ? e.stack
                .split("\n")
                .slice(0, 7)
                .map((s: string) => s.trim())
                .join(" | ")
            : "";
        return {
          candidates: [],
          fallback: true,
          reason: `embed_and_search 失败: ${e.message}`,
          stack,
        };
      }
    },
  });
}
