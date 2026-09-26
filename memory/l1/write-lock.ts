// 跨进程原子写锁（memoryDB/.l1-admin-write.lock）
//
// 背景（2026-09-11 B2）：l1_commit 的就地标记是整分片 read-modify-write，
// 而写者不限于本进程——l1-extractor 子代理进程（l1_commit）、主进程（fix-tool
// exec mjs 子进程）、手动 l1-admin CLI 可能并发改写同一历史分片 → 需要跨进程锁。
//
// 实现：目录占位锁（mkdir 原子性；Windows 无 flock），owner.json 记录
// {pid, startedAt}；startedAt 超过 staleMs 视为崩溃残留可抢占。
//
// 双入口语义同构（**2026-09-26 更正**：本注释此前称 `scripts/l1-admin/lib.mjs` 有 `acquireWriteLock`
// 的同实现，实测**该函数不存在** —— CLI 侧从未实现这把提交级写锁，属已知缺口，需要时再补）。
// 与 CLI 真正有关的约束是另一把锁：CLI 的写入口（`lib.mjs` 的 `assertRunLockFree`）必须检查
// **运行级锁**（`memory/pipeline/run-lock.ts`），否则整分片改写会与子代理的 `l1_commit` 读-改-写交错。
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../paths.ts";

export interface WriteLock {
	release: () => void;
}

/**
 * 获取跨进程写锁；超时返回 null（调用方应放弃写并提示「库被其他写者占用」）。
 *
 * @param profilePath profile 根目录（memoryDB 的上级）
 * @param timeoutMs 获取超时（默认 10s）
 * @param staleMs 锁残留判定（默认 5 分钟；崩溃残留可抢占）
 */
export function acquireWriteLock(profilePath: string, timeoutMs = 10000, staleMs = 300000): WriteLock | null {
	const lockDir = join(profilePath, MEMORY_DB_DIR, ".l1-admin-write.lock");
	const ownerPath = join(lockDir, "owner.json");
	const owner = { pid: process.pid, startedAt: Date.now() };

	const tryAcquire = (): boolean => {
		try {
			mkdirSync(lockDir, { recursive: false });
			writeFileSync(ownerPath, JSON.stringify(owner), "utf8");
			return true;
		} catch {
			// 锁目录已存在：stale 检测（owner.json 缺失视作未知 → 不抢占）
			try {
				const o = JSON.parse(readFileSync(ownerPath, "utf8"));
				if (typeof o?.startedAt === "number" && Date.now() - o.startedAt > staleMs) {
					rmSync(lockDir, { recursive: true, force: true });
					return tryAcquire();
				}
			} catch {
				/* 不可读/损坏 → 不抢占 */
			}
			return false;
		}
	};

	if (tryAcquire()) return lock(lockDir);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		// 同步短轮询（150ms 步进，l1_commit 工具执行体为同步上下文）
		const end = Date.now() + 150;
		while (Date.now() < end) { /* busy wait */ }
		if (tryAcquire()) return lock(lockDir);
	}
	return null;
}

function lock(lockDir: string): WriteLock {
	return {
		release: () => {
			try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
		},
	};
}

/**
 * 强制释放写锁（2026-09-26，供"停掉子代理"后的杀后修复调用）。
 *
 * 为什么需要：锁的 stale 判定只看 `startedAt`（默认 5 分钟）—— 子代理被杀在持锁期间时，
 * 后续 L1 写入要白等最多 5 分钟。而"持有者进程已经不存在"是**确定性**判据，可以立刻清。
 *
 * 安全性：只在 ① 显式传入的 `pid` 正是持有者、或 ② 持有者 pid 已不存在 时才清。
 * owner.json 不可读或 pid 未知 → **不动**（宁可多等，不可误清：误清会让两个写者并发改同一分片）。
 *
 * @param pid 可选的"被杀进程 pid"；传入时仅当它正是锁持有者才清
 * @returns 是否清了锁
 *
 * 注：本函数**不改变锁协议**（仍是 `mkdir` 占位 + `owner.json`），只是多一个"确定性释放"入口，
 * 故 `scripts/l1-admin/lib.mjs` 侧无需同步实现（CLI 不会被停止序列杀掉）。
 */
export function forceReleaseWriteLock(profilePath: string, pid?: number): boolean {
	const lockDir = join(profilePath, MEMORY_DB_DIR, ".l1-admin-write.lock");
	const ownerPath = join(lockDir, "owner.json");
	let ownerPid: number | undefined;
	try {
		const o = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
		if (typeof o?.pid === "number" && o.pid > 0) ownerPid = o.pid;
	} catch {
		return false; // 不可读 → 不动
	}
	if (ownerPid === undefined) return false;
	const matchesKilled = pid !== undefined && ownerPid === pid;
	if (!matchesKilled) {
		// 持有者是不是已经不存在了？（EPERM = 存在但无权限 → 视为存活）
		let alive = true;
		try {
			process.kill(ownerPid, 0);
		} catch (err) {
			alive = (err as NodeJS.ErrnoException).code === "EPERM";
		}
		if (alive) return false;
	}
	try {
		rmSync(lockDir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}