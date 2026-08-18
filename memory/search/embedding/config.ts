/**
 * embedding.json 配置读取
 *
 * 位置：{profilePath}/memoryDB/config/embedding.json
 * 唯一来源：所有 embedding 连接配置（apiKey/url/model/dimensions）从此文件读取
 * profile 级：每个 profile 独立配置（如 default 指向千问，其他 profile 可指向其他服务）
 *
 * 子代理进程独立读：l1-extractor / l2-scene-organizer 子代理进程各自读此文件实例化 embedding service
 * （不通过 globalThis 桥接，避免依赖外部包）
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** embedding.json 结构 */
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

/**
 * embedding 配置文件名查找逻辑
 *
 * 优先级：
 * 1. embedding.json（D10 拍板的标准拼写）
 * 2. embeding.json（用户实际使用的历史拼写，兼容）
 */
const CONFIG_FILENAMES = ["embedding.json", "embeding.json"];

/** 配置缓存（进程级单例，避免重复读文件） */
let cachedConfig: EmbeddingConfig | null = null;

/** 实际使用的配置文件路径（用于日志） */
let actualConfigPath: string | null = null;

/**
 * 读取 embedding.json 配置
 *
 * @param profilePath profile 根目录（如 ~/.pi/agent/profiles/default）
 * @returns 配置对象，文件不存在返回 null
 * @throws 配置文件存在但 JSON 解析失败或必填字段缺失
 */
export function loadEmbeddingConfig(profilePath: string): EmbeddingConfig | null {
  if (cachedConfig) return cachedConfig;

  // 兼容两个文件名：优先 embedding.json，fallback embeding.json
  let configPath = "";
  let found = false;
  for (const name of CONFIG_FILENAMES) {
    const p = join(profilePath, "memoryDB", "config", name);
    if (existsSync(p)) {
      configPath = p;
      found = true;
      break;
    }
  }
  if (!found) return null;

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<EmbeddingConfig>;

    // 必填字段校验
    if (!raw.apiKey) throw new Error("embedding.json: apiKey 字段缺失");
    if (!raw.url) throw new Error("embedding.json: url 字段缺失（DashScope OpenAI-compatible endpoint）");

    const config: EmbeddingConfig = {
      apiKey: raw.apiKey,
      url: raw.url,
      model: raw.model ?? "qwen3.7-text-embedding",
      dimensions: raw.dimensions ?? 1024,
      batchSize: raw.batchSize ?? 10,
      qpmLimit: raw.qpmLimit ?? 60,
      cacheSize: raw.cacheSize ?? 1000,
    };

    cachedConfig = config;
    return config;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`embedding.json 解析失败：${e.message}`);
    }
    throw e;
  }
}

/**
 * 检查 embedding.json 是否存在且可读（不缓存结果，用于启动校验）
 */
export function isEmbeddingConfigAvailable(profilePath: string): boolean {
  const configPath = join(profilePath, "memoryDB", "config", CONFIG_FILENAME);
  return existsSync(configPath);
}
