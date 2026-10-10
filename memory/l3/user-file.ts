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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { MEMORY_DB_DIR, USER_BACKUPS_DIR } from "../paths.ts";
import { entryBudget, parseUserFile, serializeUserFile } from "./entries.ts";

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

// ── 人工操作：并入 live / 还原备份（2026-10-08，查看器管理操作补齐）────────────
//
// 下面三个函数是**唯一会写 live `USER.md` 的代码路径**（`writeUserFile`），它们的调用方只有
// "用户主动发起的动作"（查看器按钮 / CLI）。L3 的自动化（子代理、commit、trigger）一律不走这里 ——
// 这条边界就是 2026-09-28 那次真实损失换来的（L3 的 update/delete 直接作用于注入画像，
// 用户手写的条目被删掉不可逆）。因此这三个函数都遵循同一条纪律：
//
//   ① 写之前一定先把**将被覆盖的那份**留档（备份文件名带后缀说明来由，见下）；
//   ② 干跑（`dryRun`）不做任何写盘，也不写备份；
//   ③ 会**清空**内容的动作（提议稿为空时并入、备份内容为空时还原）默认拒绝，必须显式放行 ——
//      这两个动作的破坏力不对称：多写一条容易补，整篇清空难察。

/** 备份文件名的前缀（与 `ensureRunBackup` 同族，于是查看器的备份清单能一并列出）。 */
const BACKUP_PREFIX = "user-backup-";

/** 备份文件名必须长这样才允许还原（basename 校验 + 后缀白名单 ⇒ 无路径遍历面）。 */
const BACKUP_NAME_RE = /^user-backup-[0-9A-Za-z_.-]+\.md$/;

/** 用户画像备份目录绝对路径（不存在不创建 —— 读取方不该有副作用）。 */
export function userBackupsDirPath(profilePath: string): string {
	return join(profilePath, MEMORY_DB_DIR, USER_BACKUPS_DIR);
}

/**
 * 列出现有备份文件名（按名升序；文件名以毫秒时间戳开头，字典序即时间序）。
 * 查看器只列不读：预览内容走静态托管的 `/backups/user-backups/<name>.md`。
 */
export function listUserBackups(profilePath: string): string[] {
	const dir = userBackupsDirPath(profilePath);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((n) => BACKUP_NAME_RE.test(n))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/** 写一份画像备份（内部用；`suffix` 说明这次快照的来由，如 `-live-premerge`）。返回路径，失败返回 undefined。 */
function writeBackup(profilePath: string, suffix: string, content: string | null, nowMs = Date.now()): string | undefined {
	if (content == null) return undefined;
	try {
		const dir = userBackupsDirPath(profilePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const file = `${BACKUP_PREFIX}${nowMs}${suffix}.md`;
		writeFileSync(join(dir, file), content, "utf-8");
		return file;
	} catch {
		return undefined;
	}
}

/**
 * 原子写 live `USER.md`。**只有人工动作走它**（见上方纪律说明）。
 *
 * 注意：注入侧读的是 `core/store` 里的**冻结快照**（`loadFromDisk` 时构建，
 * `refreshSnapshot` 才重建）。所以从进程外（查看器桥 / CLI）写完，**运行中的会话仍注入旧内容**，
 * 要等下一次会话或 `/reload` —— 界面必须把这句话说出来。
 */
export function writeUserFile(profilePath: string, content: string): void {
	atomicWrite(userFilePath(profilePath), content);
}

/** 并入/还原的共通报告。 */
export interface PersonaFileChange {
	/** 写入的目标文件名（恒为 USER.md 或 USER-temp.md，供界面展示"改了哪份"）。 */
	file: string;
	/** 改动前后的条目数与字符用量。 */
	beforeCount: number;
	afterCount: number;
	beforeChars: number;
	afterChars: number;
	/** 变更明细（精确文本比；最多各 20 条，够界面展示）。 */
	added: string[];
	removed: string[];
	/** 截断前的真实条数 —— 界面必须能说"共删 N 条"，只显示前 20 会把人骗过去。 */
	addedTotal: number;
	removedTotal: number;
	/** 改动前的留档备份文件名（undefined = 当时那个文件不存在，没什么可留）。 */
	backupFile?: string;
	/** 是否干跑（未落盘）。 */
	dryRun: boolean;
	/** 并入策略：追加新条目，或用提议稿完整替换。 */
	strategy?: "add" | "replace";
	/** 降级/拒绝判据用到的两个时间戳（ISO；文件不存在则 null）。 */
	liveMtime?: string | null;
	tempMtime?: string | null;
}

export interface MergeResult extends Partial<PersonaFileChange> {
	ok: boolean;
	error?: string;
}

const DIFF_LIMIT = 20;

/** 文件 mtime（ISO）；不存在/读不到 → null。 */
function mtimeOf(filePath: string): string | null {
	try {
		return existsSync(filePath) ? statSync(filePath).mtime.toISOString() : null;
	} catch {
		return null;
	}
}

/** 真实文件里有多少条；用于"共删 N 条"这类需要完整计数的场景。 */
function entryCountOf(raw: string | null): number {
	return parseUserFile(raw).entries.length;
}

/**
 * 把提议稿（`USER-temp.md`）并入 live `USER.md` —— 用户 2026-09-28 裁定的"手工并入"，
 * 这里只是把"手工"从手抄变成一次点击（内容判断仍归用户）。
 *
 * 语义：
 *   · 默认只把 temp 中 live 尚不存在的条目追加到 live，保留 live 的全部旧条目；
 *   · 只有明确指定 `strategy: "replace"` 时，才用 temp 的完整条目集替换 live；
 *   · 行尾/结尾换行沿用 **live 的**格式（写回的是 live 文件，格式该由它决定；live 不存在时用 temp 的）；
 *   · 写前把 live 现况留档到 `user-backup-<ts>-live-premerge.md`（本次并入因此可回退）。
 *
 * ⚠️ **三条安全闸**（2026-10-08 实测加的，别删）：
 *
 *   ① **陈旧拒绝**（`allowStale`）：temp 比 live 旧 ⇒ live 在那之后被改过，拿旧稿覆盖新稿会
 *      静默丢掉那些改动。实测触发过：真实 profile 里 `USER-temp.md` 是 09-28 的 3 条残留，
 *      而 `USER.md` 是 09-30 的 24 条 —— 旧的整份替换语义会删掉 21 条用户手写的画像。
 *      这条闸只对显式替换模式生效；追加模式不会覆盖 live 的后续改动。
 *   ② **过半删除拒绝**（`allowMassRemoval`）：要删掉 live 一半以上条目时，即使时间戳看着正常
 *      也要求再放行一次（时间戳能被"两边都在改"这种情况骗过，内容剧烈收缩骗不过）。
 *   ③ **清空拒绝**（`allowEmpty`）：live 有条目而 temp 为空的极端情形。
 *
 * ⚠️ 并入后**运行中的 pi 会话仍注入旧画像**（快照是冻结的），要等下一次会话或 `/reload`。
 */
export function mergeTempIntoLive(
	profilePath: string,
	opts: {
		dryRun?: boolean;
		strategy?: "add" | "replace";
		allowEmpty?: boolean;
		allowStale?: boolean;
		allowMassRemoval?: boolean;
		nowMs?: number;
	} = {},
): MergeResult {
	try {
		const tempRaw = readUserTempFile(profilePath);
		if (tempRaw == null) {
			return { ok: false, error: `没有提议稿：${USER_TEMP_FILE} 不存在。先让 L3 生成提议，或在查看器里加条目。` };
		}
		const liveRaw = readUserFile(profilePath);
		const temp = parseUserFile(tempRaw);
		const live = parseUserFile(liveRaw);

		const liveMtime = mtimeOf(userFilePath(profilePath));
		const tempMtime = mtimeOf(userTempFilePath(profilePath));

		// 先算差异，闸门与报告共用（报告里 removedTotal 必须是完整计数，不能是截断后的长度）。
		const liveSet = new Set(live.entries);
		const tempSet = new Set(temp.entries);
		const removedAll = live.entries.filter((e) => !tempSet.has(e));
		const addedSet = new Set<string>();
		const addedAll = temp.entries.filter((e) => {
			if (liveSet.has(e) || addedSet.has(e)) return false;
			addedSet.add(e);
			return true;
		});
		const strategy = opts.strategy ?? "add";
		const nextEntries = strategy === "replace" ? temp.entries : [...live.entries, ...addedAll];
		const removed = strategy === "replace" ? removedAll : [];

		const base: MergeResult = {
			ok: false,
			file: USER_FILE,
			beforeCount: live.entries.length,
			afterCount: nextEntries.length,
			beforeChars: entryBudget(live.entries),
			afterChars: entryBudget(nextEntries),
			added: addedAll.slice(0, DIFF_LIMIT),
			removed: removed.slice(0, DIFF_LIMIT),
			addedTotal: addedAll.length,
			removedTotal: removed.length,
			liveMtime,
			tempMtime,
			dryRun: opts.dryRun === true,
			strategy,
		};

		// 替换模式才有覆盖风险；追加不会覆盖 live 在提议稿生成后新增的内容。
		if (strategy === "replace" && !opts.allowStale && liveMtime && tempMtime && Date.parse(liveMtime) > Date.parse(tempMtime)) {
			return {
				...base,
				error:
					`提议稿比 live 画像旧（temp ${tempMtime} < live ${liveMtime}）—— 说明 live 在那之后被改过，` +
					`这次并入会删掉 ${removedAll.length} 条、其中可能包含之后手写的条目。` +
					`确认要用这份旧提议稿覆盖，请显式放行（viewer 端是那一栏的"仍要并入"）。`,
			};
		}
		// ③ 清空：live 有条目而提议稿为空
		if (strategy === "replace" && temp.entries.length === 0 && live.entries.length > 0 && !opts.allowEmpty) {
			return { ...base, error: `提议稿现在是空的（0 条），而 live USER.md 有 ${live.entries.length} 条 —— 并入等于把画像清空。确认要清空请显式放行。` };
		}
		// ② 过半删除：live 至少 5 条时，要删掉一半以上就再问一次
		if (strategy === "replace" && !opts.allowMassRemoval && live.entries.length >= 5 && removedAll.length * 2 > live.entries.length) {
			return {
				...base,
				error:
					`提议稿 USER-temp.md 是完整替换稿：执行后 USER.md 将只保留其中的条目，` +
					`这次会移除 ${removedAll.length}/${live.entries.length} 条现有条目（过半）。` +
					`若确实要大幅删减，请显式放行；否则先检查提议稿是否不完整或过期。`,
			};
		}

		// 格式沿用 live 的（并入的目标是 live 文件）；live 不存在时退回 temp 的格式。
		const eol = liveRaw != null ? live.eol : temp.eol;
		const trailingNewline = liveRaw != null ? live.trailingNewline : temp.trailingNewline;
		const nextRaw = serializeUserFile(nextEntries, eol, trailingNewline);

		const report: MergeResult = { ...base, ok: true };
		if (opts.dryRun) return report;

		report.backupFile = writeBackup(profilePath, "-live-premerge", liveRaw, opts.nowMs);
		writeUserFile(profilePath, nextRaw);
		return report;
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export interface RestoreResult extends Partial<PersonaFileChange> {
	ok: boolean;
	error?: string;
	/** 被还原的备份文件名。 */
	restoredFrom?: string;
}

/**
 * 从备份还原到提议稿 `USER-temp.md`。
 *
 * **为什么目标是 temp 而不是 live**：备份文件名只记时间戳，不记"当时捕获的是 temp 还是 live"
 * （`ensureRunBackup` 捕的是 `readL3TargetFile` = temp ?? live）。既然分不清，就统一还原到 L3
 * 唯一的写目标 temp —— 要上 live 再走一次"并入"。这条语义写在界面与 README 上，别让使用者猜。
 *
 * 写前把 temp 现况留档（`-pre-restore` 后缀），于是还原本身也可回退。
 * 备份内容为空（0 条）而当前 temp 有内容 ⇒ 默认拒绝。
 */
export function restoreFromBackup(
	profilePath: string,
	file: string,
	opts: { dryRun?: boolean; allowEmpty?: boolean; nowMs?: number } = {},
): RestoreResult {
	try {
		// 只接受 basename：调用方给的是文件名，任何目录成分都是越界企图。
		const name = basename(String(file ?? ""));
		if (!BACKUP_NAME_RE.test(name)) {
			return { ok: false, error: `备份文件名不合法：${JSON.stringify(String(file ?? ""))}（应形如 user-backup-<时间戳>.md）` };
		}
		const dir = userBackupsDirPath(profilePath);
		const full = join(dir, name);
		if (!existsSync(full)) {
			const avail = listUserBackups(profilePath);
			return { ok: false, error: `备份不存在：${name}${avail.length ? `（现有 ${avail.length} 份，最近一份 ${avail[avail.length - 1]}）` : "（备份目录为空）"}` };
		}

		const backupRaw = readFileSync(full, "utf-8");
		const backup = parseUserFile(backupRaw);
		const currentRaw = readL3TargetFile(profilePath);
		const current = parseUserFile(currentRaw);
		if (backup.entries.length === 0 && current.entries.length > 0 && !opts.allowEmpty) {
			return { ok: false, error: `这份备份是空的（0 条），而当前提议稿有 ${current.entries.length} 条 —— 还原等于清空。确认请显式放行。` };
		}

		const currentSet = new Set(current.entries);
		const backupSet = new Set(backup.entries);
		const addedAll = backup.entries.filter((e) => !currentSet.has(e));
		const removedAll = current.entries.filter((e) => !backupSet.has(e));
		const report: RestoreResult = {
			ok: true,
			restoredFrom: name,
			file: USER_TEMP_FILE,
			beforeCount: current.entries.length,
			afterCount: backup.entries.length,
			beforeChars: entryBudget(current.entries),
			afterChars: entryBudget(backup.entries),
			added: addedAll.slice(0, DIFF_LIMIT),
			removed: removedAll.slice(0, DIFF_LIMIT),
			addedTotal: addedAll.length,
			removedTotal: removedAll.length,
			dryRun: opts.dryRun === true,
		};
		if (opts.dryRun) return report;

		report.backupFile = writeBackup(profilePath, "-pre-restore", currentRaw, opts.nowMs);
		// 逐字还原备份原文（保留它自己的行尾/结尾换行），不做任何再序列化 —— "还原"要真的是还原。
		writeUserTempFile(profilePath, backupRaw);
		// 还原改了 temp ⇒ 本轮工作副本不该再按"live+temp 并集"播种（否则被还原掉的条目会复活）。
		markRunSeeded();
		report.dryRun = false;
		return report;
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
