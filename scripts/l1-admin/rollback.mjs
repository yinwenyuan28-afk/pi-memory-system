#!/usr/bin/env node
// l1-admin rollback：从备份目录恢复 l1-records
// 流程：校验备份完整（分片数/行数）→ [--apply] 当前库先自动备份 → 删除当前 jsonl → 复制备份 → verify 摘要
// 用法：
//   node rollback.mjs <backupDir>                 # dry-run：只比对
//   node rollback.mjs <backupDir> --apply         # 实恢复（当前库先自动备份）
import { existsSync, readdirSync, readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, memoryDbDir, autoBackup } from './lib.mjs';

const { profileDir, apply, dryRun, rest } = parseArgs(process.argv.slice(2));
const backupDir = rest[0];
if (!backupDir || !existsSync(backupDir)) {
  console.error('用法：node rollback.mjs <备份目录> [--apply] [--profile <dir>]');
  process.exit(2);
}

function shardStats(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(x => x.endsWith('.jsonl')).sort();
  let lines = 0;
  for (const f of files) lines += readFileSync(join(dir, f), 'utf8').split('\n').filter(x => x.trim()).length;
  return { files: files.length, lines };
}

const db = memoryDbDir(profileDir);
const cur = shardStats(join(db, 'l1-records'));
// 备份目录优先取 l1-records 子目录（根目录常有 *.jsonl 杂项如 l1-anchor-log）
const nested = join(backupDir, 'l1-records');
const bakDirActual = shardStats(nested) && shardStats(nested).files > 0 ? nested : backupDir;
const bak = shardStats(bakDirActual);
if (!bak || !bak.files) { console.error('NG 备份目录中没有 jsonl 分片'); process.exit(2); }

console.log(`当前库：分片=${cur.files} 行=${cur.lines}`);
console.log(`备份库：分片=${bak.files} 行=${bak.lines}`);
console.log(`备份实际路径：${bakDirActual}`);

if (bak.lines < cur.lines) {
  console.log(`⚠ 备份行数（${bak.lines}）少于当前（${cur.lines}）——恢复会丢失 ${cur.lines - bak.lines} 行，确认备份时间点后继续。`);
}

if (dryRun) {
  console.log('\n[dry-run] 未恢复。加 --apply 实恢复（当前库会先自动备份）。');
  console.log('注意：恢复将删除当前 l1-records 下所有 jsonl（含管线新写入），请确认备份时间点。');
  process.exit(0);
}

// 恢复
const autoBak = autoBackup(profileDir, 'pre-rollback');
console.log(`当前库已自动备份：${autoBak}`);
const target = join(db, 'l1-records');
for (const f of readdirSync(target).filter(x => x.endsWith('.jsonl'))) rmSync(join(target, f));
for (const f of readdirSync(bakDirActual).filter(x => x.endsWith('.jsonl'))) cpSync(join(bakDirActual, f), join(target, f));
console.log(`已从备份复制 ${bak.files} 个分片到 ${target}`);

// 复核
const after = shardStats(target);
console.log(`恢复后：分片=${after.files} 行=${after.lines}`);
console.log(after.files === bak.files && after.lines === bak.lines ? '恢复校验 OK' : '恢复校验 NG（分片数或行数不一致）');
if (after.files !== bak.files || after.lines !== bak.lines) process.exit(1);