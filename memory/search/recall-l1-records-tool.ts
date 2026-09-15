/**
 * recall_l1_records 工具注册
 *
 * 用户修正（2026-08-18）：
 * - 工具只召回 L1 原子记忆（vec store）
 * - 不沾边旧记忆系统（jieba 倒排 / LLMKeywordSearcher / sub-memories）
 * - 与 embed_and_search（l1-extractor dedup 用）区别：这是主代理/agent 主动调
 *
 * 2026-09-15（L1_RECALL_ASYNC）：改走**会话级召回闸门**的 `demand` 类请求。
 *   - demand = 请求-响应语义：**必须 settle**（结果或错误），绝不静默丢弃
 *     —— 被丢弃会让本工具的 promise 永悬、agent loop 的工具阶段挂死（R1 阻断 B2）；
 *   - 与自动注入共用同一闸门（用户约束：一个 session 只有一个召回活动）：
 *     因此本工具可能排在 in-flight 自动注入之后（≤ 闸门持有上限）；
 *   - 超时预算用配置的 `recall.timeoutMs`（工具路径比自动注入宽松）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadRecallConfig } from "./recall-config.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

/** 工具参数 */
interface RecallL1RecordsArgs {
  queryText: string;
  topK?: number;
}

/** 召回调度器的最小契约（结构类型，避免与 index.ts 循环依赖）。 */
interface DemandScheduler {
  request(req: {
    kind: "demand";
    turnToken: number;
    timeoutMs: number;
    payload: {
      queryText: string;
      profilePath: string;
      topK: number;
      source: "tool";
      countHits: boolean;
      hitDedupSet?: Set<string>;
    };
  }): Promise<{ outcome: string; value: unknown[] | null; error?: string }>;
}

/**
 * 注册 recall_l1_records 工具
 *
 * @param pi ExtensionAPI
 * @param hitDedupSet turn 级去重集合（index.ts 传入 currentTurnHitSet）：
 *                    与自动注入共用，同一 turn 内重复召回的记录只计 1 次命中。
 * @param scheduler 召回调度闸门（index.ts 传入）。缺省时退化为直接调用（健壮性兜底）。
 */
export function registerRecallL1RecordsTool(
  pi: ExtensionAPI,
  hitDedupSet?: Set<string>,
  scheduler?: DemandScheduler,
) {
  pi.registerTool({
    name: "recall_l1_records",
    description: renderPrompt("tools#recall_l1_records"),
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

      const profilePath = process.env.PI_PROFILE_PATH ?? "";
      const timeoutMs = loadRecallConfig(profilePath).timeoutMs;

      try {
        if (scheduler) {
          const s = await scheduler.request({
            kind: "demand",
            turnToken: -1, // demand 不参与「换轮作废」语义
            timeoutMs,
            payload: { queryText, profilePath, topK, source: "tool", countHits: true, hitDedupSet },
          });
          if (s.outcome !== "ok" || !s.value) {
            // 必须返回（不得抛/不得悬挂）：让模型知道这次没拿到，可自行决定是否放弃
            const detail = s.error ? `: ${s.error}` : "";
            return {
              candidates: [],
              error: `recall_l1_records 未取得结果（${s.outcome}${detail}）`,
            };
          }
          return {
            candidates: s.value,
            stats: {
              l1RecordsReturned: s.value.length,
              queryText: queryText.slice(0, 50) + (queryText.length > 50 ? "..." : ""),
            },
          };
        }

        // 兜底路径（未接调度器）：行为与改造前一致
        const { recallL1Records } = await import("./hybrid-recall.ts");
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
          error: `recall_l1_records 失败: ${e?.message ?? String(e)}`,
        };
      }
    },
  });
}
