/**
 * 召回闸门配置（memory/search/recall-config.ts）
 *
 * 2026-09-02 新增，同日收束：
 * - 配置源从独立的 {profile}/memoryDB/recall-config.json 迁到统一配置中心
 *   {profile}/memoryDB/config/application-propertis.json 的「recall」节
 *   （读写底层在 config/app-config.ts，本模块只做类型化合并 + 旧文件兜底）。
 * - 读取回退链：application-propertis.json(.recall) → 旧 recall-config.json（兼容）→ 内置默认。
 *
 * 设计意图：
 * - 闸门必须能独立于召回调参（历史教训：recallL1Records 里召回与闸门混在一起，
 *   调阈值要改代码）。本模块是阈值/预算的唯一读入口，改参数不用碰代码。
 * - minScore 由 scripts/sample-recall-scores.mjs 采样标定，不可照抄他方取值。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../paths.ts";
import { loadAppProps, saveAppSection } from "../../config/app-config.ts";

/** 旧独立配置文件（已废弃，仅读取兜底兼容，不再写入）。 */
const LEGACY_RECALL_CONFIG_REL = "recall-config.json";

/** query 扩展模式（与 L1_RECALL_GATE_PLAN 任务 9 对应）。 */
export type ContextExpansion = "off" | "conditional" | "always";

/**
 * 自动注入模式（2026-09-15 新增，L1_RECALL_ASYNC）：
 *   - `blocking`（默认）：`before_agent_start` 内等待召回，上限 `injectTimeoutMs`。
 *     实测 p50 457ms / p90 1326ms ⇒ 1s 上限让多数 turn 首跳即有记忆；超时后请求仍在飞，
 *     可在后续 LLM 调用补注入（退化为 async 行为），严格优于纯 async。
 *   - `async`：不等待，立即放行 agent loop；结果就绪后由 `context` 在后续 LLM 调用前插入。
 *     代价：该 turn 首次调用必无记忆；「单次答完」（无工具轮次，实测 12.8%–14.6%）整轮无记忆。
 */
export type InjectMode = "blocking" | "async";

/** 召回闸门配置结构（application-propertis.json 的 recall 节）。 */
export interface RecallConfig {
  /** 相似度下限（cosine score = 1 - distance）。低于此值的候选不注入。0 = 不过滤。 */
  minScore: number;
  /**
   * shadow mode：true = 只统计「会被阈值滤掉多少」并打日志，不真剔除。
   * 标定期用；minScore 定值后置 false 正式启用。
   */
  shadowMode: boolean;
  /** 单条记忆注入字符上限（超长截断加省略号）。 */
  maxCharsPerRecord: number;
  /** 注入总字符预算（累计超出即停止追加）。 */
  maxTotalChars: number;
  /**
   * **工具/一般路径**的召回预算（ms）：`recall_l1_records`（demand 类）用。
   * 不含 embedding 自带的 30s 上界（单次 embed 最坏 ≈121s：QPM 排队 ≤60s + fetch 30s + 重试）。
   */
  timeoutMs: number;
  /** query 构造：off=裸 prompt；conditional=仅指代消解时扩展；always=无条件扩展（A/B 对照用）。 */
  contextExpansion: ContextExpansion;
  /** 自动注入模式：blocking（默认，等 `injectTimeoutMs`）/ async（不等，就绪后补注入）。 */
  injectMode: InjectMode;
  /** 自动注入路径的等待/预算上限（ms）。到点即放弃本轮该结果（底层仍在飞，可后续补注入）。 */
  injectTimeoutMs: number;
  /**
   * 召回闸门**最长持有时间**（ms）：底层可能因不可取消的等待（QPM sleep / 重试）长期不结束，
   * 到点强制释放闸门并 warn，避免「至多一个召回活动」演变成死锁。
   * 必须 > `injectTimeoutMs`（结果预算）——两者语义不同：前者约束闸门占用，后者约束结果可用性。
   */
  maxHoldMs: number;
  /** 会话启动是否后台预热向量库/embedding 客户端（只开库建客户端，不发 embedding 请求）。 */
  prewarm: boolean;
}

/** 内置默认值。minScore 由 scripts/sample-recall-scores.mjs 采样标定（2026-09-02）。 */
export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  // 标定依据：40 条真实 user 消息 top-1 分布 P25=0.058 P50=0.254 P75=0.389。
  // 取 0.2 滤掉 best<0.2 的明确低相关段（约 30% 样本本就无相关记忆）。
  minScore: 0.2,
  shadowMode: false,
  maxCharsPerRecord: 300,
  maxTotalChars: 2000,
  timeoutMs: 5000,
  contextExpansion: "conditional",
  // 实测标定（R2，2026-09-15）：召回链净成本 p50 457ms / p90 1326ms → 1s 上限覆盖约 80–85% turn。
  injectMode: "blocking",
  injectTimeoutMs: 1000,
  // 工折中：不追求覆盖 121s 最坏（会让闸门长期被占），取「远超正常、可脱离」。
  maxHoldMs: 35000,
  prewarm: true,
};

/** 从 JSON 解析 + 逐项校验回退默认（兼容 undefined / 类型错误 / 非法枚举）。 */
function mergeRecallConfig(raw: Partial<RecallConfig> | null | undefined): RecallConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_RECALL_CONFIG };
  const merged: RecallConfig = {
    minScore: typeof raw.minScore === "number" ? raw.minScore : DEFAULT_RECALL_CONFIG.minScore,
    shadowMode:
      typeof raw.shadowMode === "boolean" ? raw.shadowMode : DEFAULT_RECALL_CONFIG.shadowMode,
    maxCharsPerRecord:
      typeof raw.maxCharsPerRecord === "number"
        ? raw.maxCharsPerRecord
        : DEFAULT_RECALL_CONFIG.maxCharsPerRecord,
    maxTotalChars:
      typeof raw.maxTotalChars === "number"
        ? raw.maxTotalChars
        : DEFAULT_RECALL_CONFIG.maxTotalChars,
    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : DEFAULT_RECALL_CONFIG.timeoutMs,
    contextExpansion:
      raw.contextExpansion === "off" ||
      raw.contextExpansion === "conditional" ||
      raw.contextExpansion === "always"
        ? raw.contextExpansion
        : DEFAULT_RECALL_CONFIG.contextExpansion,
    injectMode:
      raw.injectMode === "blocking" || raw.injectMode === "async"
        ? raw.injectMode
        : DEFAULT_RECALL_CONFIG.injectMode,
    injectTimeoutMs:
      typeof raw.injectTimeoutMs === "number" && raw.injectTimeoutMs > 0
        ? raw.injectTimeoutMs
        : DEFAULT_RECALL_CONFIG.injectTimeoutMs,
    maxHoldMs:
      typeof raw.maxHoldMs === "number" && raw.maxHoldMs > 0
        ? raw.maxHoldMs
        : DEFAULT_RECALL_CONFIG.maxHoldMs,
    prewarm: typeof raw.prewarm === "boolean" ? raw.prewarm : DEFAULT_RECALL_CONFIG.prewarm,
  };
  // 语义约束：闸门持有上限必须大于结果预算，否则结果永远来不及用（配置写错时自动纠正并保留可解释性）
  if (merged.maxHoldMs <= merged.injectTimeoutMs) {
    merged.maxHoldMs = merged.injectTimeoutMs * 2;
  }
  return merged;
}

/** 读取旧独立 recall-config.json（仅兜底兼容，2026-09-02 前形态）。 */
function loadLegacyRecallConfig(profilePath: string): Partial<RecallConfig> | null {
  const filePath = join(profilePath, MEMORY_DB_DIR, LEGACY_RECALL_CONFIG_REL);
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<RecallConfig>;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** 读取召回配置：application-propertis.json(.recall) → 旧 recall-config.json → 内置默认。 */
export function loadRecallConfig(profilePath: string): RecallConfig {
  const appProps = loadAppProps(profilePath);
  const section = appProps?.recall;
  if (section && typeof section === "object") {
    return mergeRecallConfig(section as Partial<RecallConfig>);
  }
  return mergeRecallConfig(loadLegacyRecallConfig(profilePath));
}

/** 写回召回配置（application-propertis.json 的 recall 节，合并保留其他节）。 */
export function saveRecallConfig(profilePath: string, cfg: RecallConfig): void {
  saveAppSection(profilePath, "recall", { ...cfg });
}
