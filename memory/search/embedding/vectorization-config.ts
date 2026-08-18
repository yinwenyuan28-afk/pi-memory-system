/**
 * vectorization.json 配置读取
 *
 * 位置：{profilePath}/memoryDB/config/vectorization.json
 * 内容：enabled（是否启用向量化）、triggerThreshold（触发阈值，L1 records 达到此数量后启用）
 *
 * 与 embedding.json 分离：
 * - embedding.json = 连接配置（apiKey/url/model/dimensions）→ 必须配
 * - vectorization.json = 业务策略（enabled/threshold）→ 可选，有默认值
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * 读取 vectorization.json 配置
 *
 * @param profilePath profile 根目录
 * @returns 配置对象（文件不存在时返回默认值）
 */
export function loadVectorizationConfig(profilePath: string): VectorizationConfig {
  const configPath = join(profilePath, "memoryDB", "config", "vectorization.json");
  if (!existsSync(configPath)) return { ...DEFAULTS };

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<VectorizationConfig>;
    return {
      enabled: raw.enabled ?? DEFAULTS.enabled,
      triggerThreshold: raw.triggerThreshold ?? DEFAULTS.triggerThreshold,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * 检查向量化是否应启用
 *
 * 条件：
 * 1. vectorization.json 中 enabled = true
 * 2. embedding.json 存在且可读（有 apiKey）
 * 3. L1 records 数量 ≥ triggerThreshold（可选，由调用方传入）
 */
export function isVectorizationReady(
  profilePath: string,
  recordCount?: number
): boolean {
  const vConfig = loadVectorizationConfig(profilePath);
  if (!vConfig.enabled) return false;

  // 检查 embedding.json 是否存在
  const embConfigPath = join(profilePath, "memoryDB", "config", "embedding.json");
  const embConfigPathAlt = join(profilePath, "memoryDB", "config", "embeding.json");
  if (!existsSync(embConfigPath) && !existsSync(embConfigPathAlt)) return false;

  // 检查阈值
  if (recordCount !== undefined && recordCount < vConfig.triggerThreshold) return false;

  return true;
}
