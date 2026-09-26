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

/**
 * 运行级锁检查（2026-09-26）：`{memoryDB}/state/run-lock-<layer>.lock/` 由**后台子代理进程**持有。
 *
 * 判据与 TS 侧 `memory/pipeline/run-lock.ts` 的 `runLockAcquirable` 同款、**顺序也一致**（改动要两边同步）：
 *   ① 持有者 pid 已不存在 → 视为可抢（确定性）
 *   ② 心跳不新鲜（默认 60s）→ 可抢（免疫 pid 复用）
 *   ③ 超过 expiresAt → 可抢（兜底）
 * 三者都不满足 ⇒ **抛错停手**。为什么 CLI 也要看这把锁：`atomicRewrite` 是整分片改写，
 * 与子代理的 `l1_commit` **读-改-写交错**会静默丢改动（提交级写锁只保证单次写不交叠，管不住交错）。
 *
 * 读不出 `owner.json` → 不动（与 TS 侧同款保守取舍：误判"没锁"会导致丢改动，多等只是慢）。
 */
export function assertRunLockFree(profileDir, layer = 'l1') {
  const ownerPath = join(memoryDbDir(profileDir), 'state', `run-lock-${layer}.lock`, 'owner.json');
  if (!existsSync(ownerPath)) return;
  let o = null;
  try { o = JSON.parse(readFileSync(ownerPath, 'utf8')); } catch { return; }
  if (!o || typeof o.pid !== 'number' || o.pid <= 0) return;
  let alive = true;
  try { process.kill(o.pid, 0); } catch (e) { alive = e?.code === 'EPERM'; }
  if (!alive) return;                                    // ① 持有者已死 → 可抢
  const now = Date.now();
  const hb = typeof o.heartbeatAt === 'number' && o.heartbeatAt > 0 ? o.heartbeatAt : 0;
  const expires = typeof o.expiresAt === 'number' && o.expiresAt > 0 ? o.expiresAt : 0;
  if (hb > 0 && now - hb > 60000) return;                 // ② 心跳不新鲜 → 可抢
  if (expires > 0 && now > expires) return;               // ③ 过期 → 可抢
  throw new Error(
    `L1 正在被后台子代理写入（pid=${o.pid}${hb > 0 ? `，最后心跳 ${Math.round((now - hb) / 1000)}s 前` : '，心跳缺失'}）：` +
      `请稍后重试；若确认它卡住，用 /my-memory:subagent-kill l1 停掉后再试`,
  );
}

/** 写操作前自动备份：copy L1 records 到 {memoryDB}/backups/l1-admin/{timestamp}/l1/records */
export function autoBackup(profileDir, tag = 'op') {
  // 备份本身也是写路径的第一步 ⇒ 先确认没有后台子代理在写这一层（2026-09-26）
  assertRunLockFree(profileDir, 'l1');
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