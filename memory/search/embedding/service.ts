/**
 * Embedding service 接口 + 远程 provider 实例化
 *
 * 接口抽象：embed(text) → Vector，embedBatch(texts) → Vector[]
 * 唯一 provider：阿里 DashScope qwen3.7-text-embedding（OpenAI-compatible）
 * 无本地 fallback：远程失败直接报错，业务流退回纯 LLM
 * 复用腾讯 OpenAIEmbeddingService 设计（白嫖限流/重试/分批/归一化能力）
 *
 * 子代理进程独立实例化：每个子代理进程各自读 memory-system-model.json 并初始化
 * （不通过 globalThis 桥接传递配置）
 */

import { createHash } from "node:crypto";
import { EmbeddingCache, type Vector } from "./cache.ts";
import { loadEmbeddingConfig, type EmbeddingConfig } from "./config.ts";

/** 监控统计 */
export interface EmbeddingStats {
  totalCalls: number;
  totalTokens: number;
  cacheHits: number;
  cacheMisses: number;
  avgLatencyMs: number;
}

/** 主接口 */
export interface EmbeddingService {
  /**
   * 单条文本 embed。
   * @param opts.signal 可选取消信号（2026-09-15：超时/被新请求覆盖/profile 切换时由召回调度闸门注入；
   *                    不传则行为与既有完全一致）
   */
  embed(text: string, opts?: { signal?: AbortSignal }): Promise<Vector>;
  /** 批量 embed（自动分批，每批 ≤ batchSize） */
  embedBatch(texts: string[]): Promise<Vector[]>;
  /** 返回向量维度 */
  getDimensions(): number;
  /** 返回模型标识 */
  getModelId(): string;
  /** 返回监控统计 */
  getStats(): EmbeddingStats;
  /** 清空 LRU 缓存（切模型时调用） */
  clearCache(): void;
}

/** L2 归一化（让 sqlite-vec v0.1.9 的 cosine 计算结果与手工 cosine 一致） */
function l2Normalize(vec: Vector): Vector {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * 进程级单例 holder —— 存在 globalThis 上，而不是模块级 `let`。
 *
 * ⚠️ 2026-09-19 修复（子代理 embed_and_search 报 TDZ 的根因，已实测复现）：
 * 模块级 `let` 在模块体执行到那一行之前处于 TDZ，而 `export function` 是 hoisted、一开始就能调用。
 * pi 用 jiti 加载扩展且 `moduleCache:false`，l1-extractor 同一回合并发发出多个
 * embed_and_search 时：先到的调用者触发模块求值，其余调用者在求值未完成时就拿到命名空间
 * 并调用 getter → 读未初始化的 `let` → `Cannot access 'serviceInstance' before initialization`。
 * 主代理有 session_start 预热；子代理 `PI_SUBAGENT_CHILD=1` 在预热前就 return，所以必踩。
 *
 * 与文件顶部「子代理进程独立实例化，不通过 globalThis 桥接传递配置」不矛盾：那句指
 * 父子**进程**间不共享（跨进程本就做不到）；globalThis 是进程内的，各子代理进程仍各自初始化。
 */
interface EmbeddingServiceHolder {
  instance: EmbeddingService | null;
  initPromise: Promise<EmbeddingService> | null;
}

/** 取进程级 holder；只碰 globalThis（语言全局，恒可用），不引用任何模块级绑定 → 不会 TDZ */
function getEmbeddingServiceHolder(): EmbeddingServiceHolder {
  const g = globalThis as unknown as { __piMemorySystem_embeddingService?: EmbeddingServiceHolder };
  if (!g.__piMemorySystem_embeddingService) {
    g.__piMemorySystem_embeddingService = { instance: null, initPromise: null };
  }
  return g.__piMemorySystem_embeddingService;
}

/**
 * 获取 EmbeddingService 实例（懒加载）
 *
 * 首次调用时读 memory-system-model.json（type=embedding 条目）+ 初始化远程 provider
 * 子代理进程：进程启动后首次 embed 调用时初始化
 * 主代理进程：before_agent_start 首次调用时初始化
 *
 * 历史：2026-09-15 曾用「缓存 in-flight promise」防并发重复初始化，但缓存本身也是模块级
 * `let`，在同一个竞态窗口里同样不可用，故未治到病（详见上方 holder 注释）。
 *
 * @param profilePath profile 根目录（子代理进程从环境变量或参数传入）
 */
export async function getEmbeddingService(profilePath?: string): Promise<EmbeddingService> {
  const holder = getEmbeddingServiceHolder();
  if (holder.instance) return holder.instance;
  if (holder.initPromise) return holder.initPromise;

  const config = loadEmbeddingConfig(profilePath ?? process.env.PI_PROFILE_PATH ?? "");
  if (!config) {
    throw new Error(
      "embedding 未配置。请在 memoryDB/config/application-propertis.json 的 model.embedding 节添加（apiKey + url）。\n" +
        "参考格式：{\"model\":{\"embedding\":{\"apiKey\":\"sk-xxx\",\"url\":\"https://xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1\"}}}" +
        "（迁移期仍兼容旧文件 memoryDB/config/memory-system-model.json 的 type=embedding 条目）"
    );
  }

  holder.initPromise = createRemoteEmbeddingService(config);
  try {
    holder.instance = await holder.initPromise;
    return holder.instance;
  } catch (e) {
    // 初始化失败：清空 in-flight 缓存，允许后续调用重试（不缓存失败态）
    holder.initPromise = null;
    throw e;
  }
}

/**
 * 远程 provider 实例化（阿里 DashScope qwen3.7-text-embedding）
 *
 * 千问 API 特点（用户确认）：
 * - OpenAI-compatible（/embeddings endpoint）
 * - 单批最多 10 条
 * - 60 QPM 限流
 * - dimensions 参数支持（1024/768/512）
 * - encoding_format: "float"
 */
async function createRemoteEmbeddingService(config: EmbeddingConfig): Promise<EmbeddingService> {
  const cache = new EmbeddingCache(config.cacheSize);
  const modelId = config.model ?? "qwen3.7-text-embedding";
  const dimensions = config.dimensions ?? 1024;
  const batchSize = config.batchSize ?? 10;

  // QPM 限流器（简单滑动窗口）
  const callTimestamps: number[] = [];
  const qpmLimit = config.qpmLimit ?? 60;

  /**
   * 可取消的 sleep：被 abort 时立即拒绝（而非白等一整段 QPM 间隔）。
   * 用于限流等待——否则取消信号无法缩短「排队 sleep」，闸门只能靠 maxHoldMs 兜底。
   */
  function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise((r) => setTimeout(r, ms));
    if (signal.aborted) return Promise.reject(new Error("embedding 已取消"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("embedding 已取消"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function waitForQpmSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("embedding 已取消");
    const now = Date.now();
    // 清理 1 分钟前的时间戳
    while (callTimestamps.length > 0 && callTimestamps[0] <= now - 60_000) {
      callTimestamps.shift();
    }
    if (callTimestamps.length >= qpmLimit) {
      const waitMs = callTimestamps[0] + 60_000 - now + 100; // +100ms 安全边际
      if (waitMs > 0) {
        await abortableSleep(waitMs, signal);
      }
    }
    callTimestamps.push(Date.now());
  }

  /**
   * 单条 embed（带缓存 + 限流 + 重试）
   */
  async function embedSingle(text: string, signal?: AbortSignal): Promise<Vector> {
    // 1. LRU 缓存命中（取消也走缓存？不——取消表示调用方已不需要，直接退出）
    if (signal?.aborted) throw new Error("embedding 已取消");
    const cached = cache.get(text);
    if (cached) return cached;

    // 2. 限流等待
    await waitForQpmSlot(signal);

    // 3. 调千问 API（带重试）
    const vec = await callDashScopeApi(config, text, modelId, dimensions, signal);

    // 4. 存缓存
    cache.set(text, vec);

    return vec;
  }

  let totalCalls = 0;
  let totalTokens = 0;
  let totalLatencyMs = 0;

  const service: EmbeddingService = {
    async embed(text: string, opts?: { signal?: AbortSignal }): Promise<Vector> {
      totalCalls++;
      const start = Date.now();
      const vec = await embedSingle(text, opts?.signal);
      totalLatencyMs += Date.now() - start;
      return vec;
    },

    async embedBatch(texts: string[]): Promise<Vector[]> {
      const results: Vector[] = new Array(texts.length);
      const uncachedIndices: number[] = [];
      const uncachedTexts: string[] = [];

      // 1. 先查缓存
      for (let i = 0; i < texts.length; i++) {
        const cached = cache.get(texts[i]);
        if (cached) {
          results[i] = cached;
        } else {
          uncachedIndices.push(i);
          uncachedTexts.push(texts[i]);
        }
      }

      // 2. 批量 embed 未缓存部分
      for (let i = 0; i < uncachedTexts.length; i += batchSize) {
        const batch = uncachedTexts.slice(i, i + batchSize);
        const batchVecs = await callDashScopeBatchApi(config, batch, modelId, dimensions);

        for (let j = 0; j < batchVecs.length; j++) {
          results[uncachedIndices[i + j]] = batchVecs[j];
          cache.set(uncachedTexts[i + j], batchVecs[j]);
        }
      }

      totalCalls += uncachedTexts.length;
      return results;
    },

    getDimensions: () => dimensions,
    getModelId: () => modelId,
    getStats: () => ({
      totalCalls,
      totalTokens,
      cacheHits: cache.getStats().hits,
      cacheMisses: cache.getStats().misses,
      avgLatencyMs: totalCalls > 0 ? totalLatencyMs / totalCalls : 0,
    }),
    clearCache: () => cache.clear(),
  };

  return service;
}

/**
 * 单条千问 API 调用
 */
async function callDashScopeApi(
  config: EmbeddingConfig,
  text: string,
  modelId: string,
  dimensions: number,
  signal?: AbortSignal
): Promise<Vector> {
  const url = config.url.replace(/\/$/, "") + "/embeddings";

  // 自带 30s 上界 + 外部取消信号（Node ≥20.3 支持 AbortSignal.any）；
  // 外部信号用于「超时/被新请求覆盖/profile 切换」时尽快释放连接。
  const timeoutSignal = AbortSignal.timeout(30_000); // 30s 超时
  const combined =
    signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([timeoutSignal, signal])
      : timeoutSignal;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      input: text,
      dimensions,
      encoding_format: "float",
    }),
    signal: combined,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "无法读取错误响应");

    // 4xx 客户端错误不重试
    if (response.status >= 400 && response.status < 500) {
      throw new Error(`DashScope API 客户端错误 (${response.status}): ${errorText}`);
    }

    // 429 / 5xx 可重试（透传 signal：取消后不再重试）
    if (response.status === 429 || response.status >= 500) {
      if (signal?.aborted) throw new Error("embedding 已取消");
      await new Promise((r) => setTimeout(r, 1000));
      return callDashScopeApi(config, text, modelId, dimensions, signal); // 单次重试
    }

    throw new Error(`DashScope API 错误 (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  if (!data.data?.[0]?.embedding) {
    throw new Error("DashScope API 返回格式异常：无 embedding 字段");
  }

  return l2Normalize(data.data[0].embedding);
}

/**
 * 批量千问 API 调用（单批 ≤ 10 条）
 */
async function callDashScopeBatchApi(
  config: EmbeddingConfig,
  texts: string[],
  modelId: string,
  dimensions: number
): Promise<Vector[]> {
  if (texts.length === 0) return [];

  const url = config.url.replace(/\/$/, "") + "/embeddings";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      input: texts,
      dimensions,
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(60_000), // 批量 60s 超时
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "无法读取错误响应");
    throw new Error(`DashScope 批量 API 错误 (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  // 按 index 排序（API 可能不保证顺序），并 L2 归一化（让 sqlite-vec cosine 公式匹配手工 cosine）
  return data.data
    .sort((a, b) => (a as any).index - (b as any).index)
    .map((d) => l2Normalize(d.embedding));
}
