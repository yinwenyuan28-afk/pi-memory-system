/**
 * 向量化回填工具
 *
 * 提供两个核心能力（供 /vectorize-list 和 /vectorize-backfill 命令调用）：
 * 1. getVectorizationStatus - 列出已向量化 vs 未向量化的 L1 records
 * 2. backfillMissingVectors - 批量将未向量化的 records 嵌入向量并入库
 *
 * 设计原则：
 * - "已向量化" = 存在于 vector store 的 l1_vector_index 辅助映射表中
 * - "未向量化" = 存在于 records/ JSONL 但不在 l1_vector_index 中
 * - deleted=true 的记录忽略（不算未向量化）
 * - 批量回填：每批 10 条，千问 API 限流
 */

import { loadAllL1Records } from "./record-loader.js";
import { getEmbeddingService } from "./service.js";
import { getVectorStore } from "../vector-store/store.js";
import { loadEmbeddingConfig } from "./config.js";
import { isVectorizationReady } from "./vectorization-config.js";
import type { L1Record } from "./record-loader.js";

/** 向量化状态查询结果 */
export interface VectorizationStatus {
  /** 总 records 数（不含 deleted）*/
  totalRecords: number;
  /** 已向量化 records 数 */
  vectorizedCount: number;
  /** 未向量化 records 数 */
  unVectorizedCount: number;
  /** 未向量化的 record id 列表 */
  unVectorizedIds: string[];
  /** 已向量化的 record id 列表 */
  vectorizedIds: string[];
  /** 是否已准备好回填（VECTORIZATION_ENABLED + embedding.json 都 OK）*/
  readyForBackfill: boolean;
}

/**
 * 查询向量化状态
 *
 * @param profilePath profile 根目录
 * @returns 状态对象
 */
export async function getVectorizationStatus(
  profilePath: string
): Promise<VectorizationStatus> {
  // 1. 加载所有非 deleted 的 L1 records
  const records = await loadAllL1Records(profilePath, 365); // 回溯 1 年
  const allRecordIds = records.map((r) => r.id);

  // 2. 加载已向量化的 record id 集合
  const vecStore = await getVectorStore(profilePath);
  const vectorizedIdsSet = new Set(await vecStore.getAllVectorizedRecordIds());

  // 3. 计算未向量化（注意：vector store 中的 id 可能在 records 中已 deleted；忽略）
  const vectorizedIds = allRecordIds.filter((id) => vectorizedIdsSet.has(id));
  const unVectorizedIds = allRecordIds.filter((id) => !vectorizedIdsSet.has(id));

  // 4. 检查回填前置条件
  const readyForBackfill =
    isVectorizationReady(profilePath) &&
    (await vecStore.isAvailable()) &&
    unVectorizedIds.length > 0;

  return {
    totalRecords: allRecordIds.length,
    vectorizedCount: vectorizedIds.length,
    unVectorizedCount: unVectorizedIds.length,
    unVectorizedIds,
    vectorizedIds,
    readyForBackfill,
  };
}

/** 回填进度回调 */
export interface BackfillProgress {
  total: number;
  done: number;
  currentBatchSize: number;
  currentBatchStart: number;
}

/** 回填结果 */
export interface BackfillResult {
  total: number;
  embedded: number;
  failed: number;
  durationMs: number;
  errors: string[];
}

/**
 * 批量回填未向量化的 records
 *
 * 流程：
 * 1. 查询未向量化 records
 * 2. 批量 embed content（每批 10 条，千问限流）
 * 3. 批量 insert 向量到 vector store
 * 4. 进度回调（供 UI 显示）
 *
 * @param profilePath profile 根目录
 * @param onProgress 进度回调（每完成一批触发）
 * @returns 回填结果
 */
export async function backfillMissingVectors(
  profilePath: string,
  onProgress?: (progress: BackfillProgress) => void
): Promise<BackfillResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  // 1. 检查前置条件
  const embConfig = loadEmbeddingConfig(profilePath);
  if (!embConfig) {
    return {
      total: 0,
      embedded: 0,
      failed: 0,
      durationMs: 0,
      errors: ["embedding.json 未配置，无法回填"],
    };
  }

  if (!isVectorizationReady(profilePath)) {
    return {
      total: 0,
      embedded: 0,
      failed: 0,
      durationMs: 0,
      errors: ["VECTORIZATION_ENABLED=false 或未达阈值，跳过回填"],
    };
  }

  // 2. 查询未向量化 records
  const status = await getVectorizationStatus(profilePath);
  if (status.unVectorizedCount === 0) {
    return {
      total: 0,
      embedded: 0,
      failed: 0,
      durationMs: 0,
      errors: [],
    };
  }

  // 3. 加载未向量化 records 的完整内容
  const allRecords = await loadAllL1Records(profilePath, 365);
  const unVectorizedRecords = allRecords.filter((r) =>
    status.unVectorizedIds.includes(r.id)
  );

  // 4. 初始化 embedding service 和 vector store
  const embService = await getEmbeddingService(profilePath);
  const vecStore = await getVectorStore(profilePath);

  // 5. 批量 embed + insert（每批 10 条）
  const BATCH_SIZE = 10;
  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < unVectorizedRecords.length; i += BATCH_SIZE) {
    const batch = unVectorizedRecords.slice(i, i + BATCH_SIZE);

    try {
      // embed 批量
      const contents = batch.map((r) => r.content);
      const vectors = await embService.embedBatch(contents);

      // insert 批量
      const recordsToInsert = batch.map((r, j) => ({
        recordId: r.id,
        vector: vectors[j],
      }));
      await vecStore.insertBatch(recordsToInsert);

      embedded += batch.length;
    } catch (e) {
      failed += batch.length;
      const msg = `batch ${i / BATCH_SIZE + 1} failed: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(msg);
    }

    // 进度回调
    onProgress?.({
      total: unVectorizedRecords.length,
      done: Math.min(i + BATCH_SIZE, unVectorizedRecords.length),
      currentBatchSize: batch.length,
      currentBatchStart: i,
    });
  }

  return {
    total: unVectorizedRecords.length,
    embedded,
    failed,
    durationMs: Date.now() - startTime,
    errors,
  };
}

/**
 * 格式化 status 为可读字符串（供 /vectorize-list 命令输出）
 */
export function formatStatus(status: VectorizationStatus, limit = 10): string {
  const lines: string[] = [];

  lines.push(`L1 向量化状态:`);
  lines.push(`  总 records: ${status.totalRecords}`);
  lines.push(`  已向量化: ${status.vectorizedCount}`);
  lines.push(`  未向量化: ${status.unVectorizedCount}`);
  lines.push(`  可回填: ${status.readyForBackfill ? "✅" : "❌"}`);
  lines.push("");

  if (status.unVectorizedCount > 0) {
    lines.push(`未向量化 record id（前 ${limit} 条）:`);
    for (const id of status.unVectorizedIds.slice(0, limit)) {
      lines.push(`  - ${id}`);
    }
    if (status.unVectorizedIds.length > limit) {
      lines.push(`  ... 还有 ${status.unVectorizedIds.length - limit} 条未显示`);
    }
    lines.push("");
    lines.push(`提示：使用 /vectorize-backfill 触发回填`);
  } else {
    lines.push(`✅ 所有 L1 records 都已向量化`);
  }

  return lines.join("\n");
}