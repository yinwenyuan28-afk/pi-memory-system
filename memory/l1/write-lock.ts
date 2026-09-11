// 跨进程原子写锁（memoryDB/.l1-admin-write.lock）
//
// 背景（2026-09-11 B2）：l1_commit 的就地标记是整分片 read-modify-write，
// 而写者不限于本进程——l1-extractor 子代理进程（l1_commit）、主进程（fix-tool
// exec mjs 子进程）、手动 l1-admin CLI 可能并发改写同一历史分片 → 需要跨进程锁。
//
// 实现：目录占位锁（mkdir 原子性；Windows 无 flock），owner.json 记录
// {pid, startedAt}；startedAt 超过 staleMs 视为崩溃残留可抢占。
//
// 双入口语义同构：scripts/l1-admin/lib.mjs acquireWriteLock 为 mjs 侧同实现
// （CLI 用），改动需两边同步并互指注释。
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../paths.js";

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