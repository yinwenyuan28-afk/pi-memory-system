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
import { MEMORY_DB_DIR } from "../paths.js";
import { loadAppProps, saveAppSection } from "../../config/app-config.js";

/** 旧独立配置文件（已废弃，仅读取兜底兼容，不再写入）。 */
const LEGACY_RECALL_CONFIG_REL = "recall-config.json";

/** query 扩展模式（与 L1_RECALL_GATE_PLAN 任务 9 对应）。 */
export type ContextExpansion = "off" | "conditional" | "always";

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
  /** 召回整体超时（ms，预留；embedding 自带 30s 超时兜底）。 */
  timeoutMs: number;
  /** query 构造：off=裸 prompt；conditional=仅指代消解时扩展；always=无条件扩展（A/B 对照用）。 */
  contextExpansion: ContextExpansion;
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
  };
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
