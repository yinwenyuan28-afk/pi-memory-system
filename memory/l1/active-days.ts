/**
 * 活跃会话日 — 质量分的时间基准（memory/l1/active-days.ts）
 *
 * 活跃日 = 用户当天开过 pi 干过活。来源：L0 归档分片 `memoryDB/l0-conversations/YYYY-MM-DD.jsonl`
 * 的文件名，零新增写入。
 *
 * 用途：L1 质量分的 decay 以「活跃会话日」而非日历天为基准——停工期间不增长，
 * 避免把「用户多久没开工」误当成「记忆是否过时」。见 quality.ts 文件头说明。
 *
 * 独立成模块的原因：quality.ts（算分）与 l1-hit-stats-db.ts（导出 JSON 侧车给
 * records-viewer.html，后者跑在 file:// 下列不了目录）都要用，避免循环依赖。
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../paths.js";

/** 缓存：key = l0 分片目录，value = [目录 mtimeMs, 升序日期键数组] */
const cache = new Map<string, { mtimeMs: number; keys: string[] }>();

/**
 * 读取活跃会话日（YYYY-MM-DD 升序、去重）
 *
 * @param profilePath profile 根目录
 * @returns 日期键数组；目录不存在或读取失败返回 undefined（调用方退化为墙上时钟）
 */
export function loadActiveDayKeys(profilePath: string): string[] | undefined {
  const dir = join(profilePath, MEMORY_DB_DIR, "l0-conversations");
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    return undefined;
  }

  const cached = cache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.keys;

  let keys: string[];
  try {
    keys = readdirSync(dir)
      .map((f) => /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1])
      .filter((k): k is string => Boolean(k))
      .sort();
    keys = [...new Set(keys)];
  } catch {
    return undefined;
  }

  cache.set(dir, { mtimeMs, keys });
  return keys;
}

/** 活跃日键 → 本地日 0 点时间戳（升序） */
export function activeDayKeysToTimestamps(keys: string[]): number[] {
  return keys.map((k) => {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  });
}
