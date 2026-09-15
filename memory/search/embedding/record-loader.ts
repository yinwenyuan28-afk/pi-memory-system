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
import { MEMORY_DB_DIR } from "../../paths.ts";
import { RECORDS_DIR_NAME } from "../../l1/config.ts";

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

  // 枚举最近 days 天的分片文件（按日期升序 = 追加序前半段；行内顺序为后半段）
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

  // LWW（2026-09-11）：同一 id 取追加序最后一行（分片升序+行序），
  // 同分片多行也取最后一行；deleted 判定 strict === true（与 config.ts 锚点读者对齐）。
  let found: L1Record | null = null;
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as L1Record;
          if (record.id === recordId) {
            found = record; // 持续覆盖 → 循环结束时为最后一行
          }
        } catch {
          // 跳过格式错误的行
        }
      }
    } catch {
      // 跳过读取失败的文件
    }
  }

  return found;
}

/**
 * 加载全部存活的 L1 records（最近 days 天，LWW 语义）
 *
 * LWW（2026-09-11 改造，与 `l1-admin/lib.mjs` 的 scanRecords、场景池读取同口径）：
 * 同 id 按「追加序最后一行」（分片日期升序 + 行序）判定存活：
 *   last.deleted === true → 该 id 不输出；否则输出最后一行。
 * 背景：旧实现逐行 `!deleted` 过滤，导致「追加墓碑删不掉旧行」且同 id 多行重复输出；
 * 同 id 多行属历史档案（清理/改写产物），由本函数聚合裁决，无需物理清洗。
 *
 * @param profilePath profile 根目录
 * @param days 搜索回溯天数（默认 30）
 * @returns 存活的 records 数组（每 id 至多一条）
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

  // 追加序聚合：Map 覆盖式写入 → 保留每个 id 的最后一行
  const lastById = new Map<string, L1Record>();
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as L1Record;
          if (typeof record.id === "string") {
            lastById.set(record.id, record);
          }
        } catch {
          // 跳过格式错误的行
        }
      }
    } catch {
      // 跳过读取失败的文件
    }
  }

  const records: L1Record[] = [];
  for (const record of lastById.values()) {
    if (record.deleted === true) continue; // LWW：最后一行 deleted → 该 id 不存活
    records.push(record);
  }

  return records;
}