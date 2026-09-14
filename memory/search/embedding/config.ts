/**
 * memory-system-model.json 的 embedding 配置读取（2026-08-19 迁移）
 *
 * 位置：{profilePath}/memoryDB/config/memory-system-model.json 的 `type: "embedding"` 条目
 * 唯一来源：所有 embedding 连接配置（apiKey/url/model/dimensions）从此条目读取
 * profile 级：每个 profile 独立配置（如 default 指向千问，其他 profile 可指向其他服务）
 *
 * 条目示例：
 *   {"type":"embedding","apiKey":"sk-xxx","url":"https://...","model":"qwen3.7-text-embedding","dimensions":1024,"batchSize":10,"qpmLimit":60,"cacheSize":1000}
 *
 * 子代理进程独立读：l1-extractor / l2-scene-organizer 子代理进程各自解析此文件实例化 embedding service
 * （不通过 globalThis 桥接，避免依赖外部包）
 */

import { readModelEntry } from "../../../config/memory-system-config.ts";

/** type=embedding 条目结构 */
export interface EmbeddingConfig {
  /** DashScope API key（必填） */
  apiKey: string;
  /** DashScope OpenAI-compatible endpoint（必填，含 WorkspaceId） */
  url: string;
  /** 模型名（可选，默认 qwen3.7-text-embedding） */
  model?: string;
  /** 输出维度（可选，默认 1024，千问支持 1024/768/512） */
  dimensions?: number;
  /** 每批最大条数（可选，默认 10，千问限 10） */
  batchSize?: number;
  /** QPM 限流上限（可选，默认 60） */
  qpmLimit?: number;
  /** LRU 缓存容量（可选，默认 1000） */
  cacheSize?: number;
}

/** 配置缓存（进程级单例，避免重复读文件） */
let cachedConfig: EmbeddingConfig | null = null;

/**
 * 读取 embedding 配置（memory-system-model.json 的 type=embedding 条目）
 *
 * @param profilePath profile 根目录（如 ~/.pi/agent/profiles/default）
 * @returns 配置对象，无条目返回 null
 * @throws 条目存在但必填字段缺失
 */
export function loadEmbeddingConfig(profilePath: string): EmbeddingConfig | null {
  if (cachedConfig) return cachedConfig;

  const entry = readModelEntry(profilePath, "embedding");
  if (!entry) return null;

  // 必填字段校验
  if (!entry.apiKey) throw new Error("memory-system-model.json: embedding 条目 apiKey 字段缺失");
  if (!entry.url) throw new Error("memory-system-model.json: embedding 条目 url 字段缺失（DashScope OpenAI-compatible endpoint）");

  const config: EmbeddingConfig = {
    apiKey: String(entry.apiKey),
    url: String(entry.url),
    model: typeof entry.model === "string" ? entry.model : "qwen3.7-text-embedding",
    dimensions: typeof entry.dimensions === "number" ? entry.dimensions : 1024,
    batchSize: typeof entry.batchSize === "number" ? entry.batchSize : 10,
    qpmLimit: typeof entry.qpmLimit === "number" ? entry.qpmLimit : 60,
    cacheSize: typeof entry.cacheSize === "number" ? entry.cacheSize : 1000,
  };

  cachedConfig = config;
  return config;
}

/**
 * 检查 embedding 配置条目是否存在（不缓存结果，用于启动校验）
 */
export function isEmbeddingConfigAvailable(profilePath: string): boolean {
  return readModelEntry(profilePath, "embedding") !== null;
}
