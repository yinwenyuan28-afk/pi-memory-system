/**
 * USER.md 的文件级读写与"每轮一次"备份（L3）。
 *
 * 备份策略与 8-22 的旧实现不同：旧实现是**每次提交前**备份，条目级操作下那会变成
 * "每个 op 一个备份文件"（一次 run 可能十几个 op）。改为 **每个子代理进程最多备份一次**
 * （第一次真正的写操作触发），等价于"每次 run 开始时的原状态留档"，既不爆炸也保住了可回退。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR, USER_BACKUPS_DIR } from "../paths.ts";

/** USER.md 文件名（profile 根目录，**不在** memoryDB 下）。 */
export const USER_FILE = "USER.md";

/** 本进程是否已经为这次 L3 run 备份过（模块级：一个子代理进程 = 一次 run）。 */
let backupTakenThisRun = false;

/** 测试用：复位"本轮已备份"标志。 */
export function resetBackupFlag(): void {
	backupTakenThisRun = false;
}

export function userFilePath(profilePath: string): string {
	return join(profilePath, USER_FILE);
}

/** 读取 USER.md 原文；不存在返回 null。 */
export function readUserFile(profilePath: string): string | null {
	const p = userFilePath(profilePath);
	if (!existsSync(p)) return null;
	try {
		return readFileSync(p, "utf-8");
	} catch {
		return null;
	}
}

/** 原子写 USER.md（rename 失败退化为直写）。 */
export function writeUserFile(profilePath: string, content: string): void {
	const filePath = userFilePath(profilePath);
	const dir = join(filePath, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmpPath = join(dir, `.tmp_l3_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
	writeFileSync(tmpPath, content, "utf-8");
	try {
		renameSync(tmpPath, filePath);
	} catch {
		writeFileSync(filePath, readFileSync(tmpPath, "utf-8"), "utf-8");
	}
	try {
		rmSync(tmpPath, { force: true });
	} catch {
		// ignore
	}
}

/**
 * 本轮第一次写盘前，把 USER.md 原状态留档到 `memoryDB/backups/user-backups/user-backup-*.md`。
 * 只成功备份一次；备份失败不阻塞写入（与旧行为一致，non-fatal）。
 */
export function ensureRunBackup(profilePath: string, raw: string | null): void {
	if (backupTakenThisRun || raw == null) return;
	backupTakenThisRun = true;
	try {
		const dir = join(profilePath, MEMORY_DB_DIR, USER_BACKUPS_DIR);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `user-backup-${Date.now()}.md`), raw, "utf-8");
	} catch {
		// non-fatal
	}
}
