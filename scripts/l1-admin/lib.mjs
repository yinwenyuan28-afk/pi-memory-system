// l1-admin 公共库：profile 解析 / 记录扫描 / 原子写 / 自动备份 / 新 id 生成
// 用法：import { ... } from './lib.mjs'
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 解析 --profile / --apply / --dry-run 参数；返回 { profileDir, apply, dryRun, ids, rest } */
export function parseArgs(argv, { needIds = false } = {}) {
  const a = [...argv];
  const out = { profileDir: null, apply: false, dryRun: !a.includes('--apply'), ids: [], rest: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--apply') out.apply = true;
    else if (a[i] === '--profile') out.profileDir = a[++i];
    else if (a[i] === '--dry-run') out.dryRun = true;
    else out.rest.push(a[i]);
  }
  if (!out.profileDir) out.profileDir = 'C:/Users/leaf/.pi/agent/profiles/default';
  if (!existsSync(out.profileDir)) { console.error(`NG profile 不存在：${out.profileDir}`); process.exit(2); }
  if (needIds) out.ids = out.rest.filter(x => /^l1_/.test(x) || x === 'test_full');
  return out;
}

/** 默认 memoryDB 目录 */
export function memoryDbDir(profileDir) {
  const d = join(profileDir, 'memoryDB');
  if (!existsSync(d)) { console.error('NG memoryDB 不存在：' + d); process.exit(2); }
  return d;
}

// 路径常量与扩展的 memory/paths.ts 同步（脚本无法 import TS，改动需手动对齐，见 plan MEMORYDB_LAYOUT_PLAN 3.2-B）
export const REC_DIR_NAME = join('l1', 'records');
export const BACKUP_DIR_NAME = join('backups', 'l1-admin');

/**
 * 扫描分片；返回：
 *  rows: [{file, line, obj}] 全部行（按分片名升序）
 *  byId: Map<id, rows[]>（同一 id 多行按追加序）
 *  alive: Map<id, obj>（loader 语义：!deleted 的最近…注意 loader 无 LWW，这里 alive=所有 !deleted 行）
 */
export function scanRecords(profileDir) {
  const dir = join(memoryDbDir(profileDir), REC_DIR_NAME);
  if (!existsSync(dir)) { console.error('NG L1 records 目录不存在：' + dir); process.exit(2); }
  const rows = [];
  const byId = new Map();
  const lww = new Map();
  for (const f of readdirSync(dir).filter(x => x.endsWith('.jsonl')).sort()) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      const t = l.trim();
      if (!t) return;
      let o; try { o = JSON.parse(t); } catch (e) { rows.push({ file: f, line: i, obj: null, broken: true }); return; }
      rows.push({ file: f, line: i, obj: o, broken: false });
      if (typeof o.id === 'string') {
        if (!byId.has(o.id)) byId.set(o.id, []);
        byId.get(o.id).push({ file: f, line: i, obj: o });
        lww.set(o.id, { file: f, line: i, obj: o }); // LWW：覆盖式 → 最后一行
      }
    });
  }
  const alive = rows.filter(r => !r.broken && !r.obj.deleted); // 逐行口径（历史档案统计用）
  const lwwAlive = [...lww.values()].filter(r => r.obj.deleted !== true); // LWW 口径（与 record-loader.ts 一致）
  return { dir, rows, byId, alive, lww, lwwAlive };
}

/** 写操作前自动备份：copy L1 records 到 {memoryDB}/backups/l1-admin/{timestamp}/l1/records */
export function autoBackup(profileDir, tag = 'op') {
  const db = memoryDbDir(profileDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(db, BACKUP_DIR_NAME, `${ts}-${tag}`);
  const src = join(db, REC_DIR_NAME);
  mkdirSync(dest, { recursive: true });
  cpSync(src, join(dest, REC_DIR_NAME), { recursive: true });
  console.log(`已自动备份：${dest}`);
  return dest;
}

/** 原子写回单个分片（tmp + rename） */
export function atomicRewrite(filePath, outLines) {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, outLines.join('\n'), 'utf8');
  renameSync(tmp, filePath);
}

/** 规范新 id：l1_{Date.now()}_{4位}，保证与 existing 集合不冲突 */
export function genNewId(existing) {
  const rand4 = () => Math.random().toString(36).slice(2, 6);
  let id;
  do { id = `l1_${Date.now()}_${rand4()}`; } while (existing.has(id));
  existing.add(id);
  return id;
}

export const TOOL_DESC = 'l1-admin：L1 原子记忆管理工具集（详见同目录 README.md）';

/** 本地今日（UTC+8）分片名；不存在则建空文件（与管线 l1_commit 同规则） */
export function ensureLocalShard(dir) {
  const name = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) + '.jsonl';
  const fp = join(dir, name);
  if (!existsSync(fp)) writeFileSync(fp, '', 'utf8');
  return name;
}