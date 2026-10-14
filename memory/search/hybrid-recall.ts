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

import { loadL1RecordById } from "./embedding/record-loader.ts";
import { loadRecallConfig } from "./recall-config.ts";
// 静态导入（不得改回执行期 await import()）：jiti(moduleCache:false) 下并发首次调用会拿到
// 「求值未完成」的命名空间 → getter 读到未初始化的模块级绑定（2026-09-19 实测复现）
import { getEmbeddingService } from "./embedding/service.ts";
import { getVectorStore } from "./vector-store/store.ts";
import type { HitSource } from "../stats/l1-hit-stats-db.ts";
import { logEvent } from "../../util/notice.ts";
import { TOOL_RECALL_TOP_K_DEFAULT } from "../../config/thresholds.ts";
import { CROSS_PROJECT_WEIGHT, scoreRecord } from "../../util/recall-score.ts";
import { type L1TaskState, taskStateLabel, taskStateOf } from "../l1/record-types.ts";
import { t } from "../../i18n/index.ts";

/**
 * 项目加权时的**检索放大倍数**（2026-10-02）。
 *
 * 为什么：加权会把同项目记忆往前提，被压后的异项目记忆落到 topK 之外。
 * 若仍只取 topK，被压下去的同项目记忆就永远没机会参与竞争。
 * 取 2× 是折中 —— 向量库单次检索成本几乎不随 K 增长，但也不能无限放大
 * （后面闸门 2 的字符预算会按顺序截断，放大倍数只影响「参与排序的池子大小」）。
 *
 * 2026-10-08：`recall.hideClosedTasks` 开启时**同样需要放大**，理由同款 —— 已关闭的
 * 任务要先被滤掉，池子太小就补不上来（见闸门 1.5）。
 */
export const PROJECT_WEIGHT_FETCH_MULTIPLIER = 2;

/** L1 record 召回候选 */
export interface L1RecordCandidate {
  recordId: string;
  score: number;
  content: string;
  type?: string;
  priority?: number;
  scene_name?: string;
  createdAt?: string;
  /**
   * 任务生命周期状态（2026-10-08）：仅 `work_task` 记录带值；缺字段 = `open`。
   * 注入侧据此渲染 `[待办]` / `[已完成]` / `[已废弃]` 标签 —— 没有这一步，
   * 已完成的任务会与待办长得一模一样（历史教训：`metadata.status` 就是这么变成死字段的）。
   */
  taskState?: L1TaskState;
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
  /**
   * 是否在此处计命中（默认 true，保持既有行为）。
   *
   * 自动注入路径传 `false`（2026-09-15，L1_RECALL_ASYNC）：异步/就绪式注入下，
   * 「召回成功返回」≠「真的注入进了上下文」——单次答完的 turn 里块从未被读出。
   * 该路径的正确计数点在 `context` 事件**真正把块入列**的那一次（index.ts）。
   */
  countHits?: boolean;
  /**
   * 外部取消信号（2026-09-15 新增）：由召回调度闸门注入。
   * 超时/被新请求覆盖/profile 切换时 abort → 取消底层 embedding HTTP，避免悬留请求。
   */
  signal?: AbortSignal;
  /**
   * **当前会话判定的项目路径**（2026-10-02，项目加权排序用）。
   *
   * 来源：`state/judg-session-project.json` 里本 sessionKey 的条目，且**仅 `flag===true` 才传**。
   * 传空串 / 不传 ⇒ 全程系数 1.0，行为与项目加权上线前**完全一致**（安全回退）。
   *
   * 为什么不用 `flag=false` 的占位值：那意味着「判定器没能判出项目」（弃权），
   * 而不是「判定为不属于任何项目」——拿弃权当证据压低别人的记忆是误伤。
   */
  sessionProject?: string;
  /**
   * 异项目权重系数（默认 {@link CROSS_PROJECT_WEIGHT} = 0.75）。仅供测试/A-B 覆盖。
   */
  crossProjectWeight?: number;
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

  const topK = options.topK ?? TOOL_RECALL_TOP_K_DEFAULT;
  /**
   * 会话项目（2026-10-02 项目加权用）。**空串 = 无判定 ⇒ 系数全 1.0，退回改造前行为。**
   * 调用方（index.ts / 调度闸门）只应在判定表 `flag===true` 时传入。
   */
  const sessionProject = (options.sessionProject ?? "").trim();
  /** 异项目系数（允许 A-B 覆盖；默认 0.75，实测平台期起点）。 */
  const crossWeight = options.crossProjectWeight ?? CROSS_PROJECT_WEIGHT;
  // 闸门参数来源：recall-config.json（profile 级可覆盖），options 显式传参优先
  const cfg = loadRecallConfig(profilePath);
  const minScore = options.minScore ?? cfg.minScore;
  const shadowMode = cfg.shadowMode;
  /** 已关闭任务是否从召回里剔除（默认 false = 照常注入并加状态标签，见 recall-config.ts）。 */
  const hideClosed = cfg.hideClosedTasks === true;

  try {
    // 两个单例由文件头部静态导入（见那里的注释）；此处保持静态引用，避免半成品命名空间竞态

    // 已被取消（超时/被覆盖/profile 切换）→ 直接空结果，不做任何网络调用
    if (options.signal?.aborted) return result;

    const embService = await getEmbeddingService(profilePath);
    const vecStore = await getVectorStore(profilePath);

    if (await vecStore.isAvailable() && (await vecStore.count()) > 0) {
      const queryVec = await embService.embed(queryText, { signal: options.signal });
      // ⚠ 2026-10-02：项目加权排序需要**比 topK 更多的候选**。
      //   原来 topK=3 直接取前 3，加权后跨项目记忆被压后，留在候选里的同项目记忆
      //   可能不够 3 条（实测平台期：异项目被压到 6.7%），导致注入条数变少。
      //   故放大检索量再排序截断；放大倍数 2×，向量库单次检索的成本几乎不随 K 增长。
      const fetchK = sessionProject || hideClosed ? topK * PROJECT_WEIGHT_FETCH_MULTIPLIER : topK;
      const hits = await vecStore.search(queryVec, fetchK);

      // 同一次召回里每条记录只加载一次（闸门 1.5 / 加权 / 字符预算三处都要完整记录）。
      // 没有它，开关开启后每条候选会被读盘 2–3 次；2026-10-08 加闸门 1.5 时一并收束。
      const recCache = new Map<string, Awaited<ReturnType<typeof loadL1RecordById>>>();
      const loadRec = async (recordId: string) => {
        if (!recCache.has(recordId)) recCache.set(recordId, await loadL1RecordById(recordId, profilePath));
        return recCache.get(recordId) ?? null;
      };

      // ── 闸门 1：相关性阈值（**加权前**，按真余弦卡） ─────────
      // shadowMode=true：只统计会被滤掉多少，不真剔除（标定期观察用）
      let kept = hits;
      let filtered = 0;
      if (minScore > 0) {
        filtered = hits.filter((h) => h.score < minScore).length;
        if (!shadowMode) kept = hits.filter((h) => h.score >= minScore);
      }

      // ── 闸门 1.5：已关闭任务（`recall.hideClosedTasks`）───────────
      // 位置**必须在加权截断（下一段）之前**，刻意不照抄字符预算里 `deleted` 的处理位置：
      // 自动注入 topK 只有 3，若在截断之后再滤，3 条里滤掉 2 条就只剩 1 条，池中第 4 名
      // 永远补不上来 —— 那不是"静音"，而是"随机少注入记忆"。fetchK 因此同样放大（见上）。
      // 语义：**只滤已关闭的 work_task**；`open` 与其它类型一律照常。过滤后不足 topK 不回退
      // （宁可少注入，也不把"已关闭"当"待办"塞回去）。默认开关关闭时，本段整体不执行。
      if (hideClosed) {
        const keptOpen: typeof kept = [];
        for (const hit of kept) {
          const rec = await loadRec(hit.recordId);
          if (!rec || rec.deleted) continue;
          if (rec.type === "work_task" && taskStateOf(rec) !== "open") continue;
          keptOpen.push(hit);
        }
        kept = keptOpen;
      }

      // ── 项目加权排序（2026-10-02）─────────────────────────
      // 必须在闸门 1 **之后**、字符预算**之前**：minScore 卡的是真实余弦（用户可调），
      // 加权分只用于**相对排序**（同一批候选内部），两者语义不同不能混用同一阈值。
      //
      // 实测依据与权重取值见 `util/recall-score.ts` 文件头（25 条真 query 离线模拟，
      // w=0.75 是平台期起点，跨项目占比 24.0% → 6.7%）。
      // 会话 project 拿不到时（无判定 / flag=false）**全程系数 1.0**，行为与改造前一致。
      let classTally: Record<string, number> = { match: 0, mismatch: 0, generic: 0 };
      if (sessionProject) {
        const scored: { hit: (typeof hits)[number]; adj: number }[] = [];
        for (const hit of kept) {
          const rec = await loadRec(hit.recordId);
          if (!rec || rec.deleted) continue;
          const md = (typeof rec.metadata === "object" && rec.metadata !== null ? rec.metadata : {}) as Record<string, unknown>;
          const r = scoreRecord(
            hit.score,
            sessionProject,
            { scope: md.scope, project: md.project },
            crossWeight,
          );
          classTally[r.cls]++;
          scored.push({ hit, adj: r.score });
        }
        // 分数降序后截断回 topK
        scored.sort((a, b) => b.adj - a.adj);
        kept = scored.slice(0, topK).map((s) => ({ ...s.hit, score: s.adj }));
      }

      // ── 闸门 2：字符预算（单条截断 + 总量封顶） ─────────
      // 加载完整 record 内容
      let totalChars = 0;
      for (const hit of kept) {
        const rec = await loadRec(hit.recordId);
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
          taskState: rec.type === "work_task" ? taskStateOf(rec) : undefined,
        });
      }

      // 观测日志：调 minScore 的唯一依据（filtered 多 → 阈值偏低；0 且全进 → 可下调）
      // 2026-09-19 改道：原 console.log 在 interactive 下绕开 TUI 渲染器直接写终端
      //（实测在输入框上方留野行），且不落盘、事后无法查。现只落文件。
      //
      // ⚠ 2026-10-02 增补逐条明细：原日志只有汇总（recall/filtered/kept/minScore），
      // **看不到每条命中各是多少分**。于是「项目标签该不该参与排序、权重给多少」这类问题
      // 只能用猜的答案定权重 —— 而实测证明余弦本身分不开项目（得分密集在 0.4–0.8 无分界线），
      // 所以必须用真实分布算，不能拍。这里补打 `| hits: id@score …` 段。
      //
      // ⚠ `pf:` 段是**项目加权的观测口**（同日加）：`pf=启用/关闭(match=..,mismatch=..,generic=..)`。
      // 上线后靠它核对两件事：① 过滤是否真的生效（`pf=off` 说明会话没拿到 project）
      //   ② 实测的 mismatch 占比是不是接近离线模拟的 6.7%。**没有它就看不出加权在跑没跑。**
      const pfInfo = sessionProject
        ? `pf=on(w=${crossWeight},m=${classTally.match},x=${classTally.mismatch},g=${classTally.generic})`
        : "pf=off";
      if (hits.length > 0) {
        const detail = hits.map((h) => `${h.recordId}@${h.score.toFixed(4)}`).join(" ");
        logEvent(
          "recall",
          `recall=${hits.length} filtered=${filtered}` +
            ` kept=${result.l1Records.length} minScore=${minScore}` +
            (shadowMode ? " (shadow)" : "") +
            ` q="${queryText.slice(0, 40)}${queryText.length > 40 ? "…" : ""}"` +
            ` | hits: ${detail} | ${pfInfo}`,
          profilePath,
        );
      }
    }
  } catch (e) {
    logEvent("recall", `召回失败: ${e instanceof Error ? e.message : String(e)}`, profilePath);
  }

  // 命中计数：agent 面向召回 → 每条返回的 record 命中 +1
  // 仅此处（recallL1Records）统一负责；loop-start 自动注入与 recall_l1_records 工具都走本函数。
  // turn 级去重：传入 hitDedupSet 后，同一 turn 内已计过命中的 record 不再重复 +1
  // （自动注入 top-3 与工具 top-5 语义重叠，若不按 turn 去重会双重计数）。
  // （embed_and_search 走 l1-extractor 去重，不调用本函数，不计数）
  //
  // 2026-09-15（L1_RECALL_ASYNC）：自动注入路径传 `countHits: false` —— 「召回返回」≠「真的注入」
  // （异步/就绪式注入下，单次答完的 turn 里块从未被读出）。该路径改由 context 真正入列时计数。
  const shouldCountHits = options.countHits !== false;
  if (shouldCountHits && result.l1Records.length > 0) {
    try {
      const { getL1HitStatsDB } = await import("../stats/l1-hit-stats-db.ts");
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
      logEvent("recall", `命中计数失败（不影响召回）: ${e instanceof Error ? e.message : String(e)}`, profilePath);
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

  lines.push(t("ext.recall.header"));
  lines.push(t("ext.recall.summary", { n: result.l1Records.length }));

  for (let i = 0; i < Math.min(result.l1Records.length, limit); i++) {
    const r = result.l1Records[i];
    // 任务状态（2026-10-08）：与自动注入同一份标签文案（record-types.ts 的 L1_TASK_STATE_LABELS）
    const st = r.type === "work_task" ? taskStateLabel(r.taskState) : null;
    lines.push(
      `[${i + 1}] score=${r.score.toFixed(4)} | ${r.type || "?"}${st ? ` (${st})` : ""} | priority=${r.priority ?? "?"} | ${r.recordId}`
    );
    lines.push(
      `    ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`
    );
    if (r.scene_name) lines.push(`    scene: ${r.scene_name}`);
    lines.push("");
  }

  if (result.l1Records.length > limit) {
    lines.push(t("ext.recall.remainingHidden", { n: result.l1Records.length - limit }));
  }

  return lines.join("\n");
}