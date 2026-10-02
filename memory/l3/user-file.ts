/**
 * USER.md（live 注入画像，L3 **只读**）与 USER-temp.md（L3 的落盘目标 / 提议稿）的文件级读写，
 * 外加 L3 的"每轮一次"备份。
 *
 * 2026-09-28（用户裁定）：L3 **不再直接写 USER.md** —— 它写 `USER-temp.md`，live 画像的并入
 * 由用户手工完成（注入侧读的始终是 `USER.md`，见 `core/store.ts`）。起因是真实损失：L3 的
 * `update`/`delete` 直接作用于注入画像，用户手写的条目被删掉不可逆（2026-09-27 那轮删了 3 条，
 * 备份里还在、on-disk 已无）。
 *
 * 两件事必须分清（混淆过一次，代价是同一轮里删掉的条目又被并回来）：
 *
 * 1. **提议稿原文**（`readL3Proposal`）= 写盘目标里现在有什么：temp 存在就是 temp，否则就是 live
 *    （首次提议尚未建 temp）。主进程的变更卡片、`l3_commit` 的用量回传都用它。
 * 2. **本轮工作副本**（`l3RunEntries`）= **每轮只在第一次写盘时播种一次**：
 *      live USER.md 的条目在前（画像原有顺序不变），temp 中 live 没有的条目追加在后。
 *    这样 `update`/`delete` 既能定位到 live 里的条目，又不会清掉用户手工放进 temp 的候选与
 *    上一轮未并入的提议；**播种只发生一次**，之后一步写一步读，同一轮内的删改立刻生效
 *    （若每次读都按并集展开，"删掉的条目"会因它仍在 live 里而复活 —— 死循环）。
 *
 * 备份策略与 8-22 的旧实现不同：旧实现是**每次提交前**备份，条目级操作下那会变成
 * "每个 op 一个备份文件"（一次 run 可能十几个 op）。改为 **每个子代理进程最多备份一次**
 * （第一次真正的写操作触发），等价于"每次 run 开始时的原状态留档"，既不爆炸也保住了可回退。
 * 目标换成 temp 后备份的是 temp（若尚不存在则备 live）—— 即"这一轮要覆盖掉的那份提议稿"。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR, USER_BACKUPS_DIR } from "../paths.ts";
import { parseUserFile } from "./entries.ts";

/**
 * live 画像文件名（profile 根目录，**不在** memoryDB 下）。注入侧与去重读的都是它。
 *
 * 单源在 `core/types.ts`（P1-11：原先 store / user-file / profile 三处各写一遍，
 * 而 `ensureProfileStructure()` 建目录用的是数组字面量、改名字只改一处就会
 * 「建了目录却读不到文件」）。这里**再导出**是为了保住既有 import 路径 ——
 * `l3/index.ts`、`l3/edit-tool.ts`、`scripts/verify-l3-commit.ts` 都从这里取。
 */
export { USER_FILE } from "../core/types.ts";
import { USER_FILE } from "../core/types.ts";

/** L3 的落盘目标（staging 提议稿，profile 根目录）。L3 只写它。 */
export const USER_TEMP_FILE = "USER-temp.md";

/** 本进程是否已经为这次 L3 run 备份过（模块级：一个子代理进程 = 一次 run）。 */
let backupTakenThisRun = false;

/** 本轮是否已经切到"temp 原文"口径（同上：一个子代理进程 = 一次 run）。 */
let seededThisRun = false;

/** 测试用：复位"本轮已备份 / 已播种"两个标志（一个进程 = 一次 run 的前提由子代理进程保证）。 */
export function resetRunFlags(): void {
	backupTakenThisRun = false;
	seededThisRun = false;
}

export function userFilePath(profilePath: string): string {
	return join(profilePath, USER_FILE);
}

export function userTempFilePath(profilePath: string): string {
	return join(profilePath, USER_TEMP_FILE);
}

function readTextFile(filePath: string): string | null {
	if (!existsSync(filePath)) return null;
	try {
		return readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

/** 读取 live USER.md 原文；不存在返回 null。 */
export function readUserFile(profilePath: string): string | null {
	return readTextFile(userFilePath(profilePath));
}

/** 读取提议稿 USER-temp.md 原文；不存在返回 null（不是错误：首次提议尚无 temp）。 */
export function readUserTempFile(profilePath: string): string | null {
	return readTextFile(userTempFilePath(profilePath));
}

/** 原子写文件（rename 失败退化为直写）。 */
function atomicWrite(filePath: string, content: string): void {
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
 * 原子写 L3 的落盘目标 USER-temp.md。
 *
 * **L3 没有写 live USER.md 的路径**（`l3_edit` / `l3_commit` 都只走这里）：live 画像的写入者
 * 只有用户本人 —— 要么手工编辑，要么把本文件的条目并入。
 */
export function writeUserTempFile(profilePath: string, content: string): void {
	atomicWrite(userTempFilePath(profilePath), content);
}

/** L3 当前落盘目标的原文：temp 存在 → temp，否则 live USER.md（决定行尾/结尾换行与空文件语义）。 */
export function readL3TargetFile(profilePath: string): string | null {
	return readUserTempFile(profilePath) ?? readUserFile(profilePath);
}

/** 一份提议稿的解构结果。 */
export interface L3Proposal {
	/** 写盘目标里的条目（temp 存在 = temp 的，否则 = live 的）。 */
	entries: string[];
	/** 目标文件的既有行尾。 */
	eol: string;
	/** 目标文件是否以换行结尾。 */
	trailingNewline: boolean;
}

/** 读取提议稿原文（**不**并 live，见文件头注释第 1 条）。 */
export function readL3Proposal(profilePath: string): L3Proposal {
	const target = parseUserFile(readL3TargetFile(profilePath));
	return {
		entries: target.entries,
		eol: target.eol,
		trailingNewline: target.trailingNewline,
	};
}

/**
 * 提议稿的**播种形态**：live USER.md 的条目在前 + temp 中 live 没有的条目追加在后（精确文本去重）。
 *
 * 这是"一轮 L3 的工作副本起点"（`l3RunEntries` 未切口径时用它）。主进程的变更卡片**不用它** ——
 * 卡片两侧都用提议稿原文，基准才一致（见 `l3/index.ts` 的 `readProposalEntries`）。
 */
export function seedProposalEntries(profilePath: string): string[] {
	const live = parseUserFile(readUserFile(profilePath)).entries;
	const target = readL3Proposal(profilePath).entries;
	const liveSet = new Set(live);
	return [...live, ...target.filter((e) => !liveSet.has(e))];
}

/**
 * 本轮工作副本的条目。
 *
 * **第一次写盘前**返回播种形态（`seedProposalEntries`：live + temp 独有）；**写盘成功后**
 * （由 `markRunSeeded` 标记）直接返回 temp 原文 —— 于是同一轮内的删改立刻生效，不会因为
 * "被删的条目仍在 live 里"而复活。
 *
 * 为什么要等"写盘成功"才切口径：第一次 op 可能因为超限被拒（live 已近满 + temp 里还有
 * 用户未并入的条目），此时若已经切到"temp 原文"，用户放进 temp 的候选就在下一 op 里凭空消失。
 */
export function l3RunEntries(profilePath: string): string[] {
	if (seededThisRun) return readL3Proposal(profilePath).entries;
	return seedProposalEntries(profilePath);
}

/** 一次成功的写盘之后调用：本轮不再重新播种，之后读的就是 temp 原文。 */
export function markRunSeeded(): void {
	seededThisRun = true;
}

/** 测试/调试用：本轮工作副本是否已经切到"temp 原文"口径。 */
export function isRunSeeded(): boolean {
	return seededThisRun;
}

/**
 * 本轮第一次写盘前，把**将要被覆盖的那份**留档到 `memoryDB/backups/user-backups/user-backup-*.md`。
 * 只成功备份一次；备份失败不阻塞写入（与旧行为一致，non-fatal）。
 *
 * @param raw 落盘目标（`readL3TargetFile`）的原文：temp 存在 ⇒ 提议稿原文，否则 live USER.md。
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
