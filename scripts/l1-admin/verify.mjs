#!/usr/bin/env node
// l1-admin verify：L1 库体检（输出清单式结果，非硬断言）
// 检查项：总行 / loader 存活 / 坏行 / 同 id 多行（告警）/ 错误串白名单（审计标注豁免）
// 用法：node verify.mjs [--profile <dir>] [--probes "串1,串2"]
import { scanRecords, parseArgs } from './lib.mjs';

const { profileDir, rest } = parseArgs(process.argv.slice(2));
const probesArg = rest[rest.indexOf('--probes') + 1];
const PROBES = probesArg ? probesArg.split(/[,，]/) : [
  'chat/anon', 'invalid_hits × 0.5', '!parentContractId', '三处断点', '命中 prefix cache',
];
const AUDIT = '2026-09-11 L1 审计';

const { rows, alive, lwwAlive, byId } = scanRecords(profileDir);
const NOW = new Date().toISOString();

console.log(`== L1 库体检 @ ${NOW}（profile=${profileDir}）==`);
console.log(`总行=${rows.length}`);
console.log(`loader（LWW）语义存活=${lwwAlive.length}`);
const broken = rows.filter(r => r.broken);
console.log(`坏行=${broken.length}${broken.length ? ' -> ' + broken.map(b => `${b.file}:${b.line + 1}`).join(', ') : ''}`);

// 同 id 多行（LWW 属正常——锚点读者按最后一行获胜）
const dupIds = [...byId.entries()].filter(([, v]) => v.length > 1);
console.log(`同 id 多行=${dupIds.length}（LWW 正常；仅当两行皆活跃时值得注意）`);
const dupBothAlive = dupIds.filter(([, v]) => v.filter(h => !h.obj.deleted).length > 1);
if (dupBothAlive.length) {
  console.log(`  ⚠ 同 id 多行且多行皆活跃=${dupBothAlive.length}：${dupBothAlive.map(([id]) => id).join(', ')}`);
}

// 畸形 deleted 类型
const malformed = rows.filter(r => !r.broken && typeof r.obj.deleted === 'string');
console.log(`deleted 为字符串（畸形）=${malformed.length}${malformed.length ? ' -> ' + malformed.map(r => `${r.obj.id}@${r.file}`).join(', ') : ''}`);

// 错误串白名单（遍历 LWW 存活行——内容以最后行为准）
let marked = 0, unmarked = 0;
const unmarkedList = [];
for (const r of lwwAlive) {
  for (const p of PROBES) {
    if (r.obj.content && r.obj.content.includes(p)) {
      if (r.obj.content.includes(AUDIT)) marked++;
      else { unmarked++; unmarkedList.push(`${r.obj.id}@${r.file}:${r.line + 1}`); }
    }
  }
}
console.log(`错误串扫描（${PROBES.length} 个探针）：带审计标注=${marked}（白名单内）、无标注=${unmarked}`);
if (unmarkedList.length) console.log(`  ⚠ 无标注命中：${unmarkedList.join(', ')}`);

console.log('== 体检结束 ==');