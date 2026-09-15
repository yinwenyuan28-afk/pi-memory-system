#!/usr/bin/env node
// l1-admin tombstone：按 id 就地标记 deleted:true
// 语义：loader（loadAllL1Records/hybrid-recall/backfill）按行过滤 `!deleted`、无同 id LWW，
//      追加墓碑行无效 → 必须就地标记旧行（先例：08-20 治理 fix1 行）。
// 用法：
//   node tombstone.mjs <l1_id...>                     # dry-run，只打印将标记的行
//   node tombstone.mjs <l1_id...> --apply             # 实写（自动备份到 memoryDB/backups/l1-admin/）
//   node tombstone.mjs <l1_id...> --apply --profile <dir>
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scanRecords, parseArgs, autoBackup, atomicRewrite } from './lib.mjs';

const { profileDir, apply, dryRun, ids } = parseArgs(process.argv.slice(2), { needIds: true });
if (ids.length === 0) {
  console.error('用法：node tombstone.mjs <l1_id...> [--apply] [--profile <dir>]');
  process.exit(2);
}
const { dir, rows } = scanRecords(profileDir);
const NOW = new Date().toISOString();

// 按分片归组待改行
const byFile = new Map();
const aliveAfter = new Set();
for (const id of ids) {
  const toMark = rows.filter(r => !r.broken && r.obj.id === id && !r.obj.deleted);
  if (toMark.length === 0) {
    console.log(`无操作（已 deleted 或不存在）：${id}`);
    aliveAfter.add(id); // 视为满足（保持幂等退出 0）
    continue;
  }
  for (const h of toMark) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h);
    console.log(`${dryRun ? '[dry] ' : ''}标记 ${id} → ${h.file}:${h.line + 1}（createdAt=${h.obj.createdAt || '?'}）`);
  }
}
if (byFile.size === 0) {
  console.log(`完成：${ids.length} 个 id 全部无操作（幂等 OK，退出 0）`);
  process.exit(0);
}
if (dryRun) {
  console.log('\n[dry-run] 未写盘。加 --apply 实写（会自动备份）。');
  process.exit(0);
}

autoBackup(profileDir, 'tombstone');
for (const [file, marks] of byFile) {
  const fp = join(dir, file);
  const lines = readFileSync(fp, 'utf8').split('\n');
  const idsInFile = new Set(marks.map(m => m.obj.id));
  let changed = 0;
  const out = lines.map(l => {
    const t = l.trim(); if (!t) return l;
    let o; try { o = JSON.parse(t); } catch (e) { return l; }
    if (typeof o.id !== 'string' || !idsInFile.has(o.id) || o.deleted === true) return l;
    o.deleted = true;
    o.updatedAt = NOW;
    o.metadata = { ...o.metadata, l1Cleanup: { ...(o.metadata?.l1Cleanup || {}), action: 'tombstone', tool: 'l1-admin', appliedAt: NOW } };
    changed++;
    return JSON.stringify(o);
  });
  atomicRewrite(fp, out);
  console.log(`已写回 ${file}（标记 ${changed} 行）`);
}

// 写后校验：重新扫描，目标 id 应无活跃行
const { alive } = scanRecords(profileDir);
const stillAlive = ids.filter(id => alive.some(r => r.obj.id === id));
console.log(stillAlive.length === 0 ? '校验 OK：全部目标 id 已无活跃行' : `校验 NG：仍有活跃行 -> ${stillAlive.join(', ')}`);
if (stillAlive.length > 0) process.exit(1);