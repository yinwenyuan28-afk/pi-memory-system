#!/usr/bin/env node
// l1-admin health：L1 库健康指标一键输出（替代临时勘察脚本）
// 指标：超长 / test 残留 / 孤儿 hit-stats / 自造 id / 畸形 deleted / 错误串残留 / 类型与长度分布
// 用法：node health.mjs [--profile <dir>]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scanRecords, parseArgs, memoryDbDir } from './lib.mjs';

const { profileDir } = parseArgs(process.argv.slice(2));
const { dir, rows, alive, byId, lwwAlive } = scanRecords(profileDir);

console.log(`== L1 库健康 @ ${new Date().toISOString()}（profile=${profileDir}）==`);
console.log(`总行=${rows.length} | loader(LWW)存活=${lwwAlive.length}`);

// 1. 超长
const LONG = 600;
const longOnes = lwwAlive.filter(r => (r.obj.content || '').length > LONG).sort((a, b) => b.obj.content.length - a.obj.content.length);
console.log(`\n[1] 超长 >${LONG} 字符（${longOnes.length}）`);
for (const r of longOnes) console.log(`    ${r.obj.id} ${r.obj.content.length}字 @${r.file}`);

// 2. test 残留（仅活跃行为问题）
const testRes = rows.filter(r => !r.broken && r.obj.deleted !== true && (r.obj.id === 'test_full' || /test full schema|test scene/i.test(r.obj.content || '')));
console.log(`\n[2] test 残留（活跃 ${testRes.length}；已 deleted 不计）`);
for (const r of testRes) console.log(`    ${r.obj.id} deleted=${r.obj.deleted} @${r.file}:${r.line + 1}`);

// 3. 孤儿 hit-stats
try {
  const db = memoryDbDir(profileDir);
  const statsPath = join(db, 'l1-hit-stats.json');
  if (existsSync(statsPath)) {
    const raw = JSON.parse(readFileSync(statsPath, 'utf8'));
    const statIds = (raw.stats || []).map(s => s.record_id).filter(Boolean);
    const aliveIds = new Set(lwwAlive.map(r => r.obj.id));
    const orphans = statIds.filter(id => !aliveIds.has(id));
    const recalled = statIds.filter(id => aliveIds.has(id));
    console.log(`\n[3] hit-stats：条目=${statIds.length}，对应存活=${recalled.length}，孤儿=${orphans.length}`);
    console.log(`    仅展示前 8 个孤儿：${orphans.slice(0, 8).join(', ') || '无'}`);
  }
} catch (e) { console.log(`\n[3] hit-stats 读取失败：${e.message}`); }

// 4. 自造 id：前缀非「l1_<13位时间戳>_」的（l1_del_/l1_merged_ 为历史合法形态；早期手写后缀如 _diag1 前缀仍合规）
const ID_OK = /^l1_\d{13}_/;
const weird = rows.filter(r => !r.broken && r.obj.id && !ID_OK.test(r.obj.id) && !/^l1_del_/.test(r.obj.id) && !/^l1_merged_/.test(r.obj.id) && r.obj.id !== 'test_full');
console.log(`\n[4] 非规范 id（${weird.length}）`);
for (const r of weird.slice(0, 10)) console.log(`    ${r.obj.id} @${r.file}`);

// 5. 畸形 deleted
const malformed = rows.filter(r => !r.broken && typeof r.obj.deleted === 'string');
console.log(`\n[5] deleted 字符串畸形（${malformed.length}）${malformed.length ? ' -> ' + malformed.map(r => `${r.obj.id}@${r.file}`).join(', ') : ''}`);

// 6. 错误串残留（白名单豁免）
const AUDIT = '2026-09-11 L1 审计';
const PROBES = ['chat/anon', 'invalid_hits × 0.5', '!parentContractId', '三处断点'];
let unmarked = 0;
for (const r of lwwAlive) {
  for (const p of PROBES) {
    if (r.obj.content && r.obj.content.includes(p) && !r.obj.content.includes(AUDIT)) { unmarked++; console.log(`    ⚠ ${p} @ ${r.obj.id}（活跃且无审计标注）`); }
  }
}
console.log(`\n[6] 错误串无标注残留=${unmarked}`);

// 7. 分布
const byType = {};
for (const r of lwwAlive) byType[r.obj.type] = (byType[r.obj.type] || 0) + 1;
const lens = lwwAlive.map(r => (r.obj.content || '').length).sort((a, b) => a - b);
const q = p => lens[Math.max(0, Math.floor((lens.length - 1) * p))];
console.log(`\n[7] 类型分布=${JSON.stringify(byType)}`);
console.log(`    长度 min=${lens[0]} p50=${q(0.5)} p90=${q(0.9)} max=${lens[lens.length - 1]}`);
console.log('\n== 健康检查结束 ==');