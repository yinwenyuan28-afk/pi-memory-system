#!/usr/bin/env node
/**
 * memoryDB 布局迁移：扁平混排 → 分层（方案 A，2026-09-14）
 *
 * 目标布局：
 *   memoryDB/{l0/{conversations,cursor.json}, l1/{records,cursor.json,anchor-log.jsonl,hit-stats.*},
 *             l2/{scene-blocks,cursor.json,index/*}, l3/cursor.json, skill/{feed,cursor.json},
 *             search/vectors/, pipeline/jobs.sqlite, state/failure-state.json,
 *             viewers/*, backups/*}
 *
 * 路径单一来源：扩展的 memory/paths.ts（本脚本无法 import TS，故在此复刻同一组相对路径；
 * 改动时需与 paths.ts 同步 —— 见 plan/memory-system/MEMORYDB_LAYOUT_PLAN.md §3.2-B）。
 *
 * 安全设计：
 *   1) 默认 --dry-run，必须显式 --apply 才落盘。
 *   2) 迁移前整目录备份（cpSync 递归）到 C:/temp/pi/backup-<ts>-memoryDB/，并校验文件数 + 总字节。
 *   3) 幂等：源存在→移；源不存在且目标存在→跳过；两者皆缺且非可选→报错。
 *   4) 逐项断言「源已消失 + 目标存在」；末尾做「文件总数守恒」校验。
 *   5) SQLite 的 -shm/-wal 必须与主库**成组移动**（否则丢未 checkpoint 的数据）。
 *
 * 用法：
 *   node scripts/migrate-memorydb-layout.mjs                      # dry-run，只打印计划
 *   node scripts/migrate-memorydb-layout.mjs --apply              # 实做（含备份）
 *   node scripts/migrate-memorydb-layout.mjs --apply --profile <dir> --backup-root <dir>
 */
import { existsSync, mkdirSync, readdirSync, renameSync, cpSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const getArg = (name, dflt) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PROFILE = getArg("--profile", "C:/Users/leaf/.pi/agent/profiles/default");
const BACKUP_ROOT = getArg("--backup-root", "C:/temp/pi");
const DB = join(PROFILE, "memoryDB");

// ── 迁移表（源 → 目标，均相对 memoryDB/）与 paths.ts 同步 ────────────────
const MOVES = [
	["l0-conversations", "l0/conversations"],
	["l0-cursor.json", "l0/cursor.json"],
	["l1-records", "l1/records"],
	["l1-cursor.json", "l1/cursor.json"],
	["l1-anchor-log.jsonl", "l1/anchor-log.jsonl"],
	["l1-hit-stats.json", "l1/hit-stats.json"],
	["l1-hit-stats.sqlite", "l1/hit-stats.sqlite"],
	["l1-hit-stats.sqlite-shm", "l1/hit-stats.sqlite-shm"],
	["l1-hit-stats.sqlite-wal", "l1/hit-stats.sqlite-wal"],
	["l2-scene-blocks", "l2/scene-blocks"],
	["l2-cursor.json", "l2/cursor.json"],
	[".metadata/scene_index.json", "l2/index/scene_index.json"],
	[".metadata/scene_members.json", "l2/index/scene_members.json"],
	["l3-cursor.json", "l3/cursor.json"],
	["skill-feed", "skill/feed"],
	["skill-feed-cursor.json", "skill/cursor.json"],
	[".vectors", "search/vectors"],
	["pipeline-jobs.sqlite", "pipeline/jobs.sqlite"],
	["pipeline-jobs.sqlite-shm", "pipeline/jobs.sqlite-shm"],
	["pipeline-jobs.sqlite-wal", "pipeline/jobs.sqlite-wal"],
	["failure-state.json", "state/failure-state.json"],
	["records-viewer.html", "viewers/records-viewer.html"],
	["vue-viewer", "viewers/vue-viewer"],
	[".l1-admin-backup", "backups/l1-admin"],
];
// 可选（缺失不报错）：SQLite 侧车在无写入时可能不存在
const OPTIONAL = new Set([
	"l1-hit-stats.sqlite-shm", "l1-hit-stats.sqlite-wal",
	"pipeline-jobs.sqlite-shm", "pipeline-jobs.sqlite-wal",
]);

// ── 工具 ────────────────────────────────────────────────────────────────
function walkStats(root) {
	let files = 0, bytes = 0;
	const stack = [root];
	while (stack.length) {
		const cur = stack.pop();
		let ents;
		try { ents = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
		for (const e of ents) {
			const p = join(cur, e.name);
			if (e.isDirectory()) stack.push(p);
			else { files++; try { bytes += statSync(p).size; } catch { /* ignore */ } }
		}
	}
	return { files, bytes };
}
const relStats = (rel) => walkStats(join(DB, rel));
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);

console.log("=== memoryDB 布局迁移 ===");
console.log("  profile :", PROFILE);
console.log("  模式    :", APPLY ? "APPLY（实做）" : "DRY-RUN（只打印，加 --apply 才落盘）");
if (!existsSync(DB)) { console.error("NG memoryDB 不存在:", DB); process.exit(2); }

// ── 0) 已迁移判定 ───────────────────────────────────────────────────────
const newDirs = ["l0", "l1", "l2", "l3", "skill", "search", "pipeline", "state", "viewers", "backups"];
const presentNew = newDirs.filter((d) => existsSync(join(DB, d)));
const presentOld = MOVES.filter(([s]) => existsSync(join(DB, s))).map(([s]) => s);
if (presentNew.length && presentOld.length === 0) {
	console.log("\n[skip] 目标布局已存在且无旧条目残留 → 无需迁移。");
	console.log("       已存在新目录:", presentNew.join(", "));
	process.exit(0);
}
console.log("\n  旧条目待迁移 %d 项；已存在新目录 %s", presentOld.length, presentNew.length ? presentNew.join(",") : "（无）");

// ── 1) pi 运行检测：对 SQLite 做「独占锁探测」 ──────────────────────────
// 为什么不用 wal mtime：pi 即使空闲（实测 2.3 天未写 WAL）仍持有文件句柄，
// rename 会 EBUSY —— mtime 判据会漏判，必须在迁移前真的试一次 rename。
function lockProbe(p) {
	if (!existsSync(p)) return "absent";
	const t = p + ".lockprobe";
	try {
		renameSync(p, t);
		renameSync(t, p);
		return "free";
	} catch {
		try { if (existsSync(t)) renameSync(t, p); } catch { /* 尽力还原 */ }
		return "locked";
	}
}
const DBS = [
	"pipeline-jobs.sqlite", "pipeline/jobs.sqlite",
	"l1-hit-stats.sqlite", "l1/hit-stats.sqlite",
	".vectors/l1-vectors.sqlite", "search/vectors/l1-vectors.sqlite",
];
const locked = [];
for (const d of DBS) {
	const st = lockProbe(join(DB, d));
	if (st === "absent") continue;
	console.log("  锁探测 %s -> %s", d, st);
	if (st === "locked") locked.push(d);
}
if (locked.length) {
	console.error("\n[阻断] 以下 SQLite 被占用（rename EBUSY）：%s", locked.join(", "));
	console.error("       pi（或其它进程）仍持有句柄。带锁迁移会损坏数据 ——");
	console.error("       请退出所有 pi 会话（含后台 worker）后重试。脚本已幂等，可直接重跑续完。");
	process.exit(3);
}

// ── 2) 计划清单（含 user-backup 动态项） ────────────────────────────────
const userBackups = existsSync(join(DB, ".metadata"))
	? readdirSync(join(DB, ".metadata")).filter((f) => f.startsWith("user-backup-") && f.endsWith(".md"))
	: [];
const plan = MOVES.map(([s, d]) => ({ src: s, dst: d, optional: OPTIONAL.has(s) }))
	.concat(userBackups.map((f) => ({ src: ".metadata/" + f, dst: "backups/user-backups/" + f, optional: false })));

let todo = 0, skip = 0, missing = 0;
console.log("\n=== 迁移清单 ===");
for (const it of plan) {
	const hasSrc = existsSync(join(DB, it.src));
	const hasDst = existsSync(join(DB, it.dst));
	const st = hasSrc && !hasDst ? "MOVE" : (hasDst ? "SKIP(已就位)" : (it.optional ? "SKIP(可选缺)" : "MISSING"));
	if (st === "MOVE") todo++; else if (st === "SKIP(已就位)" || st === "SKIP(可选缺)") skip++; else missing++;
	const info = hasSrc
		? (() => {
				const st = statSync(join(DB, it.src));
				if (st.isFile()) return `${(st.size / 1024).toFixed(1)}KB`;
				const s = relStats(it.src);
				return `${s.files}f/${s.bytes}B`;
			})()
		: "";
	console.log("  [%s] %s -> %s  %s", pad(st, 14), pad(it.src, 38), pad(it.dst, 34), info);
}
console.log("\n  MOVE=%d  SKIP=%d  MISSING(非可选缺失)=%d", todo, skip, missing);
if (missing > 0) {
	console.error("\nNG 有非可选源条目缺失，为免误判请人工确认后再迁移。");
	process.exit(4);
}
if (todo === 0) {
	console.log("\n[skip] 无待移动项（已迁移或空）。");
	process.exit(0);
}

if (!APPLY) {
	console.log("\n[dry-run] 未改动任何文件。确认无误后加 --apply 执行。");
	process.exit(0);
}

// ── 3) 整目录备份 + 校验 ────────────────────────────────────────────────
const before = walkStats(DB);
const BACKUP_DIR = join(BACKUP_ROOT, `backup-${ts()}-memoryDB`);
console.log("\n=== 备份 ===");
console.log("  源 :", DB, `(${before.files} files / ${before.bytes} bytes)`);
console.log("  目标:", BACKUP_DIR);
mkdirSync(BACKUP_ROOT, { recursive: true });
cpSync(DB, BACKUP_DIR, { recursive: true });
const afterCopy = walkStats(BACKUP_DIR);
console.log("  备份后: %d files / %d bytes", afterCopy.files, afterCopy.bytes);
if (afterCopy.files !== before.files || afterCopy.bytes !== before.bytes) {
	console.error("NG 备份校验失败（文件数或字节数不一致），已中止，未改动源目录。");
	process.exit(5);
}
console.log("  备份校验 OK（文件数与字节数一致）");

// ── 4) 执行移动（同盘 rename，原子） ────────────────────────────────────
console.log("\n=== 迁移 ===");
let moved = 0;
for (const it of plan) {
	const src = join(DB, it.src);
	const dst = join(DB, it.dst);
	if (!existsSync(src)) {
		if (existsSync(dst)) { console.log("  skip %s（目标已就位）", it.dst); continue; }
		if (it.optional) { console.log("  skip %s（可选缺）", it.src); continue; }
		console.error("  NG 源缺失且目标不存在:", it.src);
		process.exit(6);
	}
	if (existsSync(dst)) { console.error("  NG 目标已存在，拒绝覆盖:", it.dst); process.exit(7); }
	mkdirSync(dirname(dst), { recursive: true });
	renameSync(src, dst);
	moved++;
	console.log("  move %s -> %s", it.src, it.dst);
}
console.log("  共移动 %d 项", moved);

// ── 5) 断言：源全消失 + 目标全存在 + 文件数守恒 ─────────────────────────
console.log("\n=== 断言 ===");
let bad = 0;
for (const it of plan) {
	if (existsSync(join(DB, it.src))) { console.error("  NG 源仍存在:", it.src); bad++; }
	if (!existsSync(join(DB, it.dst))) { console.error("  NG 目标不存在:", it.dst); bad++; }
}
// 提示 .metadata 是否已清空（不自动删，保守）
const metaDir = join(DB, ".metadata");
if (existsSync(metaDir)) {
	const left = readdirSync(metaDir);
	if (left.length === 0) {
		console.log("  注意: .metadata 已空，可手动删除（未自动删，保守）");
	} else {
		console.log("  .metadata 仍余 %d 项: %s", left.length, left.join(", "));
	}
}
const after = walkStats(DB);
console.log("  文件数: 迁移前 %d -> 迁移后 %d（应相等；新建空目录不增文件）", before.files, after.files);
if (after.files !== before.files) { console.error("  NG 文件数不一致，可能丢文件！"); bad++; }
if (bad === 0) {
	console.log("\n  ✓ 全部断言通过。备份位于: %s", BACKUP_DIR);
	console.log("  下一步：重启 pi，验证 L0/L1/L2/L3/skill/viewer 六路。");
} else {
	console.error("\n  ✗ 有 %d 项断言失败；备份可用于回滚: %s", bad, BACKUP_DIR);
	process.exit(8);
}
