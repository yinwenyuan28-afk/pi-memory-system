/**
 * clear_invalid_l1_records 工具注册
 *
 * 对应 L1HitStatsDB.recordInvalid：agent 主动判定某条「被召回」的 L1 原子记忆
 * 在当前任务下无参考价值时调用，标记一次无效命中（invalid_hits +1，
 * effective_hits 重算为 hits - invalid_hits）。
 *
 * 仅反馈统计信号，不删除记录本身：
 *   - 记录保留，质量分下降，recall_l1_records 仍可能返回它（质量信号持续累积），
 *     最终由 quality.ts 的「噪」标签 + 冷淘汰逻辑按 effective_hits 处理。
 *   - 与 recall_l1_records 形成命中反馈闭环：召回 +1（recordHits），无效则 +1（recordInvalid）。
 *
 * 守卫：仅对「真正被召回过」（hits > 0）的 record 计数；从未召回的 id 跳过，
 * 避免对不存在的命中产生脏 invalid_hits（recordInvalid 对 hits=0 也会被钳制为 0，无副作用，
 * 但显式跳过更清晰、且工具结果能如实反映）。
 *
 * recordInvalid 内部会自动把 sidecar l1-hit-stats.json 重写，records-viewer.html 直接 fetch，
 * 故标记后 viewer 的「质量分布」即时更新。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 工具参数 */
interface ClearInvalidL1RecordsArgs {
  recordIds: string[];
  reason?: string;
}

/**
 * 注册 clear_invalid_l1_records 工具
 *
 * @param pi ExtensionAPI
 */
export function registerClearInvalidL1RecordsTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "clear_invalid_l1_records",
    description:
      "Mark L1 atomic memories as INVALID (agent judged them irrelevant after recall). " +
      "For each recordId, increments invalid_hits and recomputes effective_hits = hits - invalid_hits " +
      "in the L1 hit-stats DB (auto-rewrites l1-hit-stats.json consumed by records-viewer). " +
      "Only records that were actually recalled (hits > 0) are counted; never-recalled ids are skipped. " +
      "This is a feedback signal ONLY — the record is NOT deleted, its quality drops and recall may still return it. " +
      "Call this when you recalled a memory via recall_l1_records but found it useless for the current task.",
    parameters: {
      recordIds: {
        type: "array",
        description: "要标记为无效命中的 L1 record id 列表（取自 recall_l1_records 返回的 recordId）",
      },
      reason: {
        type: "string",
        description: "可选：判定无效的理由（仅回显到工具结果，便于审计）",
      },
    },
    execute: async (_toolCallId: string, params: ClearInvalidL1RecordsArgs) => {
      const raw = Array.isArray(params.recordIds) ? params.recordIds : [];
      const ids = [...new Set(raw.map((x) => String(x)).filter(Boolean))];
      if (ids.length === 0) {
        return { incremented: 0, skipped: 0, error: "recordIds 为空" };
      }

      try {
        const profilePath = process.env.PI_PROFILE_PATH ?? "";
        if (!profilePath) {
          return { incremented: 0, skipped: 0, error: "PI_PROFILE_PATH 未设置" };
        }
        const { getL1HitStatsDB } = await import("../stats/l1-hit-stats-db.js");
        const db = getL1HitStatsDB(profilePath);

        const incremented: string[] = [];
        const skipped: string[] = [];
        for (const id of ids) {
          const stat = db.getStats(id);
          // 守卫：仅对真正被召回过的记录计数；从未召回（hits=0）的 id 跳过
          if (!stat || stat.hits === 0) {
            skipped.push(id);
            continue;
          }
          db.recordInvalid(id);
          incremented.push(id);
        }

        return {
          incremented: incremented.length,
          skipped: skipped.length,
          incrementedIds: incremented,
          skippedIds: skipped,
          reason: params.reason ?? null,
        };
      } catch (e: any) {
        return {
          incremented: 0,
          skipped: 0,
          error: `clear_invalid_l1_records 失败: ${e?.message ?? String(e)}`,
        };
      }
    },
  });
}
