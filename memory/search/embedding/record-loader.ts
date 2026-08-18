/**
 * L1 record 加载器（公共模块）
 *
 * 按 recordId 从 L1 records JSONL 分片加载完整记录
 * 供 embed_and_search 工具（tool.ts）和主代理 L1 recall 注入（index.ts）复用
 *
 * records/ 目录按日期分片：{YYYY-MM-DD}.jsonl
 * 每行一个 L1 record JSON：{id, content, type, priority, ...}
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../../paths.js";
import { RECORDS_DIR_NAME } from "../../l1/config.js";

/** L1 record 结构（与 agents/l1-extractor.md 第六步字段模板一致） */
export interface L1Record {
  id: string;
  content: string;
  type: string;
  priority: number;
  scene_name?: string;
  source_message_ids?: string[];
  metadata?: Record<string, unknown>;
  timestamps?: string[];
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  sessionKey?: string;
  sessionId?: string | null;
  cwd?: string;
  deleted?: boolean;
}

/**
 * 按 recordId 从 L1 records 加载完整记录
 *
 * @param recordId 目标 record id（l1_{epochMs}_{random}）
 * @param profilePath profile 根目录
 * @param days 搜索回溯天数（默认 30）
 * @returns 记录对象；未找到返回 null
 */
export async function loadL1RecordById(
  recordId: string,
  profilePath: string,
  days = 30
): Promise<L1Record | null> {
  if (!profilePath || !recordId) return null;

  const recordsDir = join(profilePath, MEMORY_DB_DIR, RECORDS_DIR_NAME);
  if (!existsSync(recordsDir)) return null;

  // 列出最近 days 天的分片文件（从最新到最旧搜索）
  const now = new Date();
  const files: string[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const date = new Date(now.getTime() - d * 86400000);
    const dateStr = date.toISOString().slice(0, 10);
    const filePath = join(recordsDir, `${dateStr}.jsonl`);
    if (existsSync(filePath)) {
      files.push(filePath);
    }
  }

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as L1Record;
          if (record.id === recordId) {
            return record;
          }
        } catch {
          // 跳过格式错误的行
        }
      }
    } catch {
      // 跳过读取失败的文件
    }
  }

  return null;
}

/**
 * 加载全部非 deleted 的 L1 records（最近 days 天）
 *
 * @param profilePath profile 根目录
 * @param days 搜索回溯天数（默认 30）
 * @returns 非 deleted 的 records 数组
 */
export async function loadAllL1Records(
  profilePath: string,
  days = 30
): Promise<L1Record[]> {
  if (!profilePath) return [];

  const recordsDir = join(profilePath, MEMORY_DB_DIR, RECORDS_DIR_NAME);
  if (!existsSync(recordsDir)) return [];

  const now = new Date();
  const files: string[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const date = new Date(now.getTime() - d * 86400000);
    const dateStr = date.toISOString().slice(0, 10);
    const filePath = join(recordsDir, `${dateStr}.jsonl`);
    if (existsSync(filePath)) {
      files.push(filePath);
    }
  }

  const records: L1Record[] = [];
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as L1Record;
          if (!record.deleted) {
            records.push(record);
          }
        } catch {
          // 跳过格式错误的行
        }
      }
    } catch {
      // 跳过读取失败的文件
    }
  }

  return records;
}