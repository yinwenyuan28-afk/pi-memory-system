/**
 * embedding 向量 LRU 缓存
 *
 * in-memory Map，key=文本 SHA-256 哈希，value=向量
 * 子代理进程短命——缓存在子代理进程生命周期内有效，不持久化
 * 主代理进程（L1 recall）缓存跨轮次复用（before_agent_start 每轮触发）
 */

import { createHash } from "node:crypto";

/** 向量类型（float 数组） */
export type Vector = number[];

/** 缓存统计 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number; // hits / (hits + misses)
}

/**
 * LRU 缓存实现（Map 迭代顺序即插入顺序，LRU 淘汰 = 删除第一个 entry）
 */
export class EmbeddingCache {
  private cache: Map<string, Vector> = new Map();
  private maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * 计算文本的缓存 key（SHA-256 前 16 位 hex，减少 key 长度）
   */
  private hash(text: string): string {
    return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
  }

  /**
   * 获取缓存向量
   * @returns 缓存命中返回向量，未命中返回 null
   */
  get(text: string): Vector | null {
    const key = this.hash(text);
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      // LRU：删除后重新插入，移到 Map 末尾
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    this.misses++;
    return null;
  }

  /**
   * 存入缓存
   */
  set(text: string, vector: Vector): void {
    const key = this.hash(text);
    // 已存在先删除（更新时保持 LRU 顺序）
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // 超容量：删除最老 entry（Map 迭代器第一个）
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, vector);
  }

  /**
   * 批量获取（减少 cache miss 时的重复 hash 计算）
   */
  getBatch(texts: string[]): Array<{ index: number; vector: Vector } | null> {
    return texts.map((t) => {
      const v = this.get(t);
      return v !== null ? { index: texts.indexOf(t), vector: v } : null;
    });
  }

  /**
   * 批量存入
   */
  setBatch(texts: string[], vectors: Vector[]): void {
    for (let i = 0; i < texts.length; i++) {
      this.set(texts[i], vectors[i]);
    }
  }

  /**
   * 获取缓存统计
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * 清空缓存（切模型时调用）
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * 当前缓存大小
   */
  get size(): number {
    return this.cache.size;
  }
}
