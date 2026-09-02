/**
 * 向量化配置读取（2026-09-02 收束到 application-propertis.json 的 vectorization 节）
 *
 * 位置：{profile}/memoryDB/config/application-propertis.json 的 `vectorization` 节
 * 内容：enabled（是否启用向量化）、triggerThreshold（触发阈值，L1 records 达到此数量后启用）
 * 兜底：旧 {profile}/memoryDB/config/vectorization.json（迁移期兼容）
 *
 * 与 embedding 配置分离：
 * - embedding 配置（application-propertis.json 的 model.embedding 节）= 连接配置（apiKey/url/model/dimensions）→ 必须配
 * - vectorization 节 = 业务策略（enabled/threshold）→ 可选，有默认值
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../../../memory/paths.js";
import { loadAppProps } from "../../../config/app-config.js";
import { isEmbeddingConfigAvailable } from "./config.js";

export interface VectorizationConfig {
  /** 是否启用向量化（默认 false） */
  enabled: boolean;
  /** 触发阈值：L1 records 达到此数量后才启用向量化（默认 500） */
  triggerThreshold: number;
}

const DEFAULTS: VectorizationConfig = {
  enabled: false,
  triggerThreshold: 500,
};

function merge(raw: Partial<VectorizationConfig> | null | undefined): VectorizationConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    triggerThreshold:
      typeof raw.triggerThreshold === "number" ? raw.triggerThreshold : DEFAULTS.triggerThreshold,
  };
}

/** 读取旧独立 vectorization.json（迁移期兜底）。 */
function loadLegacyVectorizationConfig(profilePath: string): Partial<VectorizationConfig> | null {
  const configPath = join(profilePath, MEMORY_DB_DIR, "config", "vectorization.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<VectorizationConfig>;
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 读取向量化配置：application-propertis.json(.vectorization) → 旧 vectorization.json → 默认。
 */
export function loadVectorizationConfig(profilePath: string): VectorizationConfig {
  const appProps = loadAppProps(profilePath);
  const section = appProps?.vectorization;
  if (section && typeof section === "object") {
    return merge(section as Partial<VectorizationConfig>);
  }
  return merge(loadLegacyVectorizationConfig(profilePath));
}

/**
 * 检查向量化是否应启用
 *
 * 条件：
 * 1. vectorization.json 中 enabled = true
 * 2. embedding 配置存在（memory-system-model.json 的 type=embedding 条目，含 apiKey）
 * 3. L1 records 数量 ≥ triggerThreshold（可选，由调用方传入）
 */
export function isVectorizationReady(
  profilePath: string,
  recordCount?: number
): boolean {
  const vConfig = loadVectorizationConfig(profilePath);
  if (!vConfig.enabled) return false;

  // 检查 embedding 配置是否存在
  if (!isEmbeddingConfigAvailable(profilePath)) return false;

  // 检查阈值
  if (recordCount !== undefined && recordCount < vConfig.triggerThreshold) return false;

  return true;
}
