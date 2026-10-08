#!/usr/bin/env node
// l1-admin rewrite：改写一条 L1 记忆 = 新 id 追加 + 旧行就地标记
// （loader 为 LWW：同 id 取最后一行 ⇒ 就地标记旧行才能让它不再存活，同时保留 content 溯源。
//  2026-10-08 更正：本行原写「loader 无 LWW」，那是 2026-09-11 之前的形态。）
// 语义（本次 L1 清理验证并定版）：
//   - 新 id 规范 l1_{Date.now()}_{4位}，批内唯一
//   - 新行 createdAt=now（保 quality 7 天保护），原 createdAt 入 metadata.origCreatedAt
//   - 旧行保留原 content（溯源），就地标记 deleted:true
// 用法：
//   node rewrite.mjs <l1_id> --content "<新内容>"                # dry-run
//   node rewrite.mjs <l1_id> --content "<新内容>" --apply         # 实写（自动备份）
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanRecords, parseArgs, autoBackup, atomicRewrite, genNewId, ensureLocalShard } from './lib.mjs';

const { profileDir, apply, dryRun, rest } = parseArgs(process.argv.slice(2));
const id = rest[0];
const contentIdx = rest.indexOf('--content');
if (!id || contentIdx < 0 || !rest[contentIdx + 1]) {
  console.error('用法：node rewrite.mjs <l1_id> --content "<新内容>" [--priority <n>] [--apply] [--profile <dir>]');
  process.exit(2);
}
const newContent = rest[contentIdx + 1];
if (newContent.length < 10) { console.error('NG content 过短（<10 字符）'); process.exit(2); }
// --priority：可选重估（数字 0-100 校验）；缺省继承旧值（fix-tool 场景在审计标注注明「未重估」）
let newPriority = null;
const priIdx = rest.indexOf('--priority');
if (priIdx >= 0) {
  const v = Number(rest[priIdx + 1]);
  if (!Number.isFinite(v) || v < 0 || v > 100) { console.error('NG --priority 须为 0-100 数字'); process.exit(2); }
  newPriority = Math.round(v);
}

const { dir, rows, byId, lww } = scanRecords(profileDir);
const NOW = new Date().toISOString();

// LWW（2026-09-11）：以追加序最后一行判定活跃（与 loader 同口径）
const last = lww.get(id);
if (!last || last.obj.deleted === true) { console.error(`NG ${id} 不存在或已 deleted（LWW 最后一行${last ? '为 deleted' : '不存在'}）`); process.exit(1); }
const oldRow = last;
const oldObj = last.obj;

// 生成新行
const existing = new Set(rows.filter(r => !r.broken).map(r => r.obj.id));
const newId = genNewId(existing);
const newObj = {
  id: newId,
  content: newContent,
  type: oldObj.type,
  priority: newPriority ?? oldObj.priority,
  scene_name: oldObj.scene_name,
  scene_id: oldObj.scene_id, // 2026-09-15：场景池链路——漏拷会让改写后的记录脱离池（静默断链）
  // 2026-10-08：任务生命周期（work_task）——本表是**白名单重建**，漏拷即静默丢字段：
  // 一次改写就会让已标记完成/废弃的任务退回「待办」（同 scene_id 的教训）。
  taskState: oldObj.taskState,
  source_message_ids: oldObj.source_message_ids,
  timestamps: oldObj.timestamps,
  createdAt: NOW,
  updatedAt: NOW,
  version: (oldObj.version || 1) + 1,
  sessionKey: oldObj.sessionKey,
  sessionId: oldObj.sessionId,
  cwd: oldObj.cwd,
  metadata: { ...oldObj.metadata, origCreatedAt: oldObj.createdAt, l1Cleanup: { action: 'rewrite', tool: 'l1-admin', sourceId: id, newId, appliedAt: NOW } },
};
if (newPriority !== null) newObj.metadata.l1Cleanup.priorityReassessed = { from: oldObj.priority, to: newPriority };

console.log(`${dryRun ? '[dry] ' : ''}旧行标记：${id} @ ${oldRow.file}:${oldRow.line + 1}`);
console.log(`${dryRun ? '[dry] ' : ''}新行追加：${newId}（type=${newObj.type} pri=${newObj.priority}${newPriority === null ? '（继承）' : '（重估）'} origCreatedAt=${oldObj.createdAt}）`);
console.log(`${dryRun ? '[dry] ' : ''}新内容（前 80 字符）：${newContent.slice(0, 80)}…`);
if (dryRun) { console.log('\n[dry-run] 未写盘。加 --apply 实写（会自动备份）。'); process.exit(0); }

autoBackup(profileDir, 'rewrite');

// 1) 旧行就地标记
{
  const fp = join(dir, oldRow.file);
  const lines = readFileSync(fp, 'utf8').split('\n');
  const out = lines.map(l => {
    const t = l.trim(); if (!t) return l;
    let o; try { o = JSON.parse(t); } catch (e) { return l; }
    if (o.id !== id || o.deleted === true) return l;
    o.deleted = true;
    o.updatedAt = NOW;
    o.metadata = { ...o.metadata, l1Cleanup: { ...(o.metadata?.l1Cleanup || {}), action: 'rewrite-superseded', tool: 'l1-admin', replacedBy: newId } };
    return JSON.stringify(o);
  });
  atomicRewrite(fp, out);
  console.log(`已就地标记旧行 ${oldRow.file}`);
}

// 2) 新行追加到本地今日分片（与管线 l1_commit 同规则：localDate 分片名）
const shard = ensureLocalShard(dir);
appendFileSync(join(dir, shard), JSON.stringify(newObj) + '\n', 'utf8');
console.log(`已追加新行（${shard} 行尾）`);

// 3) 写后校验
const after = scanRecords(profileDir);
const stillAlive = after.alive.some(r => r.obj.id === id);
const newAlive = after.alive.some(r => r.obj.id === newId);
console.log(stillAlive ? '校验 NG：旧 id 仍活跃' : '校验 OK：旧 id 已停用');
console.log(newAlive ? '校验 OK：新 id 存活' : '校验 NG：新 id 未找到');
if (stillAlive || !newAlive) process.exit(1);
console.log(`完成：${id} → ${newId}`);