// ============================================================================
// memory/l2/archive.ts — L2 场景块归档层内核（2026-09-27）
//
// 存在的理由：场景块满了（`maxScenes`）之后，今天只有两条出路 —— `consolidate`（把不同项目的块
// 搅成一个杂碎块）和 `delete`（不可逆、不留痕，成员条目也一并消失）。本模块提供第三条：
// **把冷块搬进 `l2/archive/`** —— 腾出名额、内容与成员清单完整保留、可逆、有账。
//
// 三层载体（与 live 侧同构）：
//   1. `l2/archive/*.md`                    —— **存在性真源**（目录扫描；索引是派生物）
//   2. `l2/archive/scene_members.json`      —— 成员 sidecar，**权威、不可重建**（见 paths.ts 注释）
//   3. `l2/archive/ledger.jsonl`            —— 追加式事件账（谁/何时/为什么），丢了可补账
//
// **刻意不复用 `commit-tool.ts` 的 `parseSceneBlock` / `loadSceneMembers`**：`commit-tool` 需要
// import 本模块来完成搬移，反向 import 会形成环（本项目在环形依赖上翻过车）。所以这里自带一个
// 最小 META 读取器；口径与 `parseSceneBlock` 一致（只认 `-----META-START-----` 段内的 key）。
//
// **本模块不做任何 `console.*` 输出**（硬性约定）：结果一律以返回值表达，由调用方决定怎么通知。
// ============================================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	L1_HIT_STATS_JSON,
	L2_ARCHIVE_DIR,
	L2_ARCHIVE_LEDGER_PATH,
	L2_ARCHIVE_MEMBERS_PATH,
	L2_SCENE_DIR,
	L2_SCENE_MEMBERS_PATH,
	MEMORY_DB_DIR,
} from "../paths.ts";

export const ARCHIVE_DIR_NAME = L2_ARCHIVE_DIR;
export const ARCHIVE_MEMBERS_PATH = L2_ARCHIVE_MEMBERS_PATH;
export const ARCHIVE_LEDGER_PATH = L2_ARCHIVE_LEDGER_PATH;

/**
 * 块正文里的**完整** L1 record id。
 *
 * 注意与 `commit-tool.ID_TOKEN_RE`（`l1_[A-Za-z_]{0,12}\d{10,13}`）的区别：那个是**宽松比对**口径，
 * 只取数字部分、用于"这条 id 在目标正文里算不算有落点"。**恢复成员必须用完整 id** —— 截断成
 * `l1_1789000000002` 之后对不上 hit-stats / `l1-fix` 的查表，等于把保护换成一张废纸。
 * 实测 bug：2026-09-27 本回归第 ⑦ 组抓到的就是"兜回 truncated id"。
 */
const FULL_ID_TOKEN_RE = /l1_\d{10,13}[A-Za-z0-9_]*/g;

/** 场景块 META（子集；本模块只需要这几个字段）。 */
export interface ArchivedMeta {
	created: string;
	updated: string;
	summary: string;
	heat: number;
}

/** 归档事件账的一行。 */
export interface ArchiveLedgerEntry {
	op: "archive" | "restore" | "ledger-missing";
	filename: string;
	at: string;
	reason: string;
	by: string;
	heat?: number;
	summary?: string;
	memberCount?: number;
}

/** 归档目录下的一个块。 */
export interface ArchivedBlock {
	filename: string;
	meta: ArchivedMeta;
	members: string[];
	/** 与该文件相关的账目事件（按时间序）。 */
	events: ArchiveLedgerEntry[];
}

// ── 路径 ────────────────────────────────────────────────────

export function sceneDirOf(profilePath: string): string {
	return join(profilePath, MEMORY_DB_DIR, L2_SCENE_DIR);
}

export function archiveDirOf(profilePath: string): string {
	return join(profilePath, MEMORY_DB_DIR, ARCHIVE_DIR_NAME);
}

/** 裸文件名校验（挡路径穿越 / 绝对路径 / 子目录）。与 `scene-read-tool.isPlainSceneFilename` 同口径。 */
export function isPlainBlockFilename(name: unknown): boolean {
	if (typeof name !== "string" || name.length === 0 || name.length > 200) return false;
	if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
	return name.endsWith(".md");
}

// ── 最小 META 读取 + 正文 id 兜底 ────────────────────────────

/**
 * 从块原文读 META（**最小实现，刻意不复用 commit-tool.parseSceneBlock**——见文件头注释）。
 * 解析不出来时返回空串/0，绝不抛错（归档列举不能因为一个坏文件整体失败）。
 */
export function readArchivedMeta(raw: string): ArchivedMeta {
	const start = raw.indexOf("-----META-START-----");
	const end = raw.indexOf("-----META-END-----");
	const seg = start >= 0 ? raw.slice(start, end > start ? end : undefined) : raw.slice(0, 600);
	const field = (k: string): string => {
		const m = new RegExp(`^\\s*${k}:\\s*(.+?)\\s*$`, "m").exec(seg);
		return m ? m[1] : "";
	};
	return {
		created: field("created"),
		updated: field("updated"),
		summary: field("summary"),
		heat: Number(field("heat")) || 0,
	};
}

/**
 * 从块正文抽 L1 record id —— 成员 sidecar 丢失时的**兜底**来源。
 * 口径与 `commit-tool` 的 `repairSceneMembers` 一致（正文里的 id token 就是事实）。
 */
export function memberIdsFromBody(raw: string): string[] {
	const out = new Set<string>();
	const re = new RegExp(FULL_ID_TOKEN_RE.source, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) out.add(m[0]);
	return [...out];
}

// ── sidecar / ledger 读写 ───────────────────────────────────

/** 原子写 JSON（tmp + rename；rename 失败退化为直接写）。 */
function writeJsonAtomic(filePath: string, value: unknown): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${filePath}.tmp_${process.pid}_${Date.now()}`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
	try {
		renameSync(tmp, filePath);
	} catch {
		try {
			writeFileSync(filePath, readFileSync(tmp, "utf-8"), "utf-8");
		} finally {
			try {
				rmSync(tmp, { force: true });
			} catch {
				// ignore
			}
		}
	}
}

function readJsonRecord(filePath: string): Record<string, string[]> {
	if (!existsSync(filePath)) return {};
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		if (!data || typeof data !== "object" || Array.isArray(data)) return {};
		const out: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
			out[k] = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
		}
		return out;
	} catch {
		return {};
	}
}

/** 读 live 成员 sidecar（{memoryDB}/l2/index/scene_members.json）。 */
export function loadLiveMembers(profilePath: string): Record<string, string[]> {
	return readJsonRecord(join(profilePath, MEMORY_DB_DIR, L2_SCENE_MEMBERS_PATH));
}

function saveLiveMembers(profilePath: string, members: Record<string, string[]>): void {
	writeJsonAtomic(join(profilePath, MEMORY_DB_DIR, L2_SCENE_MEMBERS_PATH), members);
}

/** 读归档成员 sidecar（权威）。 */
export function loadArchiveMembers(profilePath: string): Record<string, string[]> {
	return readJsonRecord(join(profilePath, MEMORY_DB_DIR, ARCHIVE_MEMBERS_PATH));
}

function saveArchiveMembers(profilePath: string, members: Record<string, string[]>): void {
	writeJsonAtomic(join(profilePath, MEMORY_DB_DIR, ARCHIVE_MEMBERS_PATH), members);
}

/** 读归档事件账；坏行跳过（不吃好行——与 notice relay 同款纪律）。 */
export function readArchiveLedger(profilePath: string): ArchiveLedgerEntry[] {
	const filePath = join(profilePath, MEMORY_DB_DIR, ARCHIVE_LEDGER_PATH);
	if (!existsSync(filePath)) return [];
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}
	const out: ArchiveLedgerEntry[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const o = JSON.parse(t) as ArchiveLedgerEntry;
			if (o && typeof o.filename === "string" && (o.op === "archive" || o.op === "restore" || o.op === "ledger-missing")) {
				out.push(o);
			}
		} catch {
			// 坏行跳过
		}
	}
	return out;
}

/** 追加一条账（append-only；失败不抛——账丢了可由目录扫描补）。 */
export function appendArchiveLedger(profilePath: string, entry: ArchiveLedgerEntry): boolean {
	const filePath = join(profilePath, MEMORY_DB_DIR, ARCHIVE_LEDGER_PATH);
	try {
		const dir = dirname(filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}

// ── 列举（存在性真源 = 目录扫描） ────────────────────────────

/** 归档目录里实际存在的 `.md` 文件名（升序）。 */
export function listArchivedFilenames(profilePath: string): string[] {
	const dir = archiveDirOf(profilePath);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
}

/**
 * 列举归档块（**只读，不改盘**）：以目录为存在性真源，并入成员 sidecar 与账目。
 *
 * 供只读工具与命令报告使用。**补账是 `reconcileArchive()` 的事**——只读入口不得写盘。
 */
export function listArchivedBlocks(profilePath: string): ArchivedBlock[] {
	const dir = archiveDirOf(profilePath);
	const members = loadArchiveMembers(profilePath);
	const ledger = readArchiveLedger(profilePath);
	const out: ArchivedBlock[] = [];
	for (const filename of listArchivedFilenames(profilePath)) {
		let raw = "";
		try {
			raw = readFileSync(join(dir, filename), "utf-8");
		} catch {
			continue;
		}
		out.push({
			filename,
			meta: readArchivedMeta(raw),
			members: members[filename] ?? memberIdsFromBody(raw),
			events: ledger.filter((e) => e.filename === filename),
		});
	}
	return out;
}

/** 归档一个块的当前概况（供提交前的冲突校验与返回值）。 */
export function archivedBlockExists(profilePath: string, filename: string): boolean {
	return existsSync(join(archiveDirOf(profilePath), filename));
}

// ── 补账 / 自愈 ─────────────────────────────────────────────

export interface ReconcileReport {
	/** 目录里有文件但账上没有 → 补的 `ledger-missing` 条数。 */
	ledgerBackfilled: string[];
	/** sidecar 里有条目但归档目录里没有该文件 → 剪掉的条目。 */
	sidecarPruned: string[];
	/** 归档块的成员在 sidecar 里缺失 → 从正文 id token 兜回来的条目。 */
	membersRecovered: string[];
	/** live sidecar 里残留着"文件已搬走"的孤儿成员条目 → 收回归档 sidecar 后剪掉的条目。 */
	strandedMembersCollected: string[];
}

/**
 * 归档侧自愈（**唯一允许写盘的修复入口**，由搬移/恢复/提交路径调用，不由只读工具调用）。
 *
 * 处理的四种中间态（都源于"进程在两步之间被杀"）：
 *   1. 文件已移入、账未写 → 补 `ledger-missing`（存在性以目录为准）
 *   2. sidecar 有条目、目录无文件 → 剪掉（那是"先写 sidecar 再移文件"时移文件那步失败的残留）
 *   3. 归档块成员缺失 → 从正文 id token 兜回（sidecar 权威，但正文也算事实来源）
 *   4. **搁浅成员**：live sidecar 里有条目、但该块既不在 live 目录也不在归档 sidecar 里
 *      （崩在"移文件成功、写 live sidecar 之前"）→ 先收回归档 sidecar 再剪 live 条目。
 *      不收回的话，`restore` 回来的块会带着空成员 ⇒ `l1/fix-tool` 的保护静默失效。
 */
export function reconcileArchive(profilePath: string, nowIso: string): ReconcileReport {
	const report: ReconcileReport = { ledgerBackfilled: [], sidecarPruned: [], membersRecovered: [], strandedMembersCollected: [] };
	const dir = archiveDirOf(profilePath);
	const archivedFiles = listArchivedFilenames(profilePath);
	const archivedSet = new Set(archivedFiles);
	const liveFiles = new Set(
		existsSync(sceneDirOf(profilePath))
			? readdirSync(sceneDirOf(profilePath)).filter((f) => f.endsWith(".md"))
			: [],
	);

	const ledger = readArchiveLedger(profilePath);
	// "账上已知" = 任何一条事件（含补记的 `ledger-missing`）。若只认 `archive`，补账会**每次运行都再补一条**
	// —— 账会无限膨胀且不幂等（2026-09-27 本模块回归第 ⑦ 组抓到的第二个 bug）。
	const ledgerKnown = new Set(ledger.map((e) => e.filename));
	const archiveMembers = loadArchiveMembers(profilePath);

	// 1 + 3：目录为真源，补账 + 兜成员
	let membersChanged = false;
	for (const f of archivedFiles) {
		if (!ledgerKnown.has(f)) {
			appendArchiveLedger(profilePath, {
				op: "ledger-missing",
				filename: f,
				at: nowIso,
				reason: "账目缺失，由目录扫描补记（可能是搬移中途进程被杀）",
				by: "reconcile",
			});
			report.ledgerBackfilled.push(f);
		}
		if (!archiveMembers[f] || archiveMembers[f].length === 0) {
			let raw = "";
			try {
				raw = readFileSync(join(dir, f), "utf-8");
			} catch {
				continue;
			}
			const recovered = memberIdsFromBody(raw);
			if (recovered.length > 0) {
				archiveMembers[f] = recovered;
				membersChanged = true;
				report.membersRecovered.push(f);
			}
		}
	}
	// 2：sidecar 有条目但目录无文件 → 剪
	for (const f of Object.keys(archiveMembers)) {
		if (!archivedSet.has(f)) {
			delete archiveMembers[f];
			membersChanged = true;
			report.sidecarPruned.push(f);
		}
	}
	// 4：搁浅成员 —— live sidecar 有条目、但文件已不在 live 目录。
	//    · 文件在归档目录里（崩在"移文件成功、清 live 条目之前"）⇒ 把成员并进**归档侧车**（先收再删，
	//      不收回的话 `restore` 回来的块会带空成员 ⇒ `l1/fix-tool` 的保护静默失效）；
	//    · 文件哪里都没有（块被删过）⇒ 直接剪掉 live 条目，无归档可收。
	//    2026-09-27 更正：原实现写成"块在归档目录里就跳过"，恰好把要收的那一类跳掉了（回归第 ⑦ 组抓到）。
	const liveMembers = loadLiveMembers(profilePath);
	let liveChanged = false;
	for (const [f, ids] of Object.entries(liveMembers)) {
		if (liveFiles.has(f)) continue;
		if (archivedSet.has(f) && ids.length > 0) {
			archiveMembers[f] = [...new Set([...(archiveMembers[f] ?? []), ...ids])];
			membersChanged = true;
			report.strandedMembersCollected.push(f);
		}
		delete liveMembers[f];
		liveChanged = true;
	}

	if (membersChanged) {
		try {
			saveArchiveMembers(profilePath, archiveMembers);
		} catch {
			// 修复失败不阻断主流程
		}
	}
	if (liveChanged) {
		try {
			saveLiveMembers(profilePath, liveMembers);
		} catch {
			// ignore
		}
	}
	return report;
}

// ── 搬移 ────────────────────────────────────────────────────

export interface ArchiveMoveResult {
	ok: boolean;
	error?: string;
	/** 成功时：被搬走/搬回块的成员清单。 */
	members: string[];
}

export interface ArchiveMoveOptions {
	filename: string;
	reason: string;
	/** 触发者标识：`subagent` / `command` / `main-agent`。 */
	by: string;
	nowIso?: string;
}

/**
 * 归档一个块：`scene-blocks/X.md` → `l2/archive/X.md`。
 *
 * **落盘顺序（顺序本身就是数据安全设计）**：
 *   1. 先算好成员（live sidecar → 正文兜底）并**原子写归档 sidecar**
 *   2. 追加账
 *   3. `renameSync` 移文件（同盘原子；失败即整体失败，内容不动）
 *   4. 从 live sidecar 移除该条目（原子写）
 *
 * 若崩在 3 之后 4 之前 ⇒ live sidecar 留下孤儿条目 —— `reconcileArchive` 的"搁浅成员"分支会把它
 * 收回归档 sidecar（不是丢掉）。若崩在 1 之后 3 之前 ⇒ 归档 sidecar 有条目、目录无文件 ——
 * reconcile 会剪掉它。**先写账再移文件**是为了"文件已经在归档目录里"这件事永远有账可查。
 */
export function archiveSceneBlock(profilePath: string, opts: ArchiveMoveOptions): ArchiveMoveResult {
	const nowIso = opts.nowIso ?? new Date().toISOString();
	const { filename, reason, by } = opts;
	if (!isPlainBlockFilename(filename)) {
		return { ok: false, error: `文件名非法（只接受 scene-blocks/ 下的裸 .md 名）：${filename}`, members: [] };
	}
	if (!reason || !reason.trim()) {
		return { ok: false, error: "归档必须给出 reason（这是写给未来的账）", members: [] };
	}
	const src = join(sceneDirOf(profilePath), filename);
	if (!existsSync(src)) {
		return { ok: false, error: `场景块不存在：${filename}`, members: [] };
	}
	if (archivedBlockExists(profilePath, filename)) {
		return { ok: false, error: `归档目录里已有同名块，拒绝覆盖：${filename}`, members: [] };
	}

	let raw = "";
	try {
		raw = readFileSync(src, "utf-8");
	} catch (e) {
		return { ok: false, error: `读取失败：${e instanceof Error ? e.message : String(e)}`, members: [] };
	}
	const meta = readArchivedMeta(raw);
	const liveMembers = loadLiveMembers(profilePath);
	const members = liveMembers[filename] && liveMembers[filename].length > 0 ? liveMembers[filename] : memberIdsFromBody(raw);

	const archiveMembers = loadArchiveMembers(profilePath);
	archiveMembers[filename] = members;

	try {
		mkdirSync(archiveDirOf(profilePath), { recursive: true });
	} catch (e) {
		return { ok: false, error: `建归档目录失败：${e instanceof Error ? e.message : String(e)}`, members: [] };
	}
	// 1. 归档 sidecar（权威成员）
	try {
		saveArchiveMembers(profilePath, archiveMembers);
	} catch (e) {
		return { ok: false, error: `写归档成员 sidecar 失败：${e instanceof Error ? e.message : String(e)}`, members: [] };
	}
	// 2. 账
	appendArchiveLedger(profilePath, {
		op: "archive",
		filename,
		at: nowIso,
		reason: reason.trim(),
		by,
		heat: meta.heat,
		summary: meta.summary,
		memberCount: members.length,
	});
	// 3. 移文件（同盘原子）
	try {
		renameSync(src, join(archiveDirOf(profilePath), filename));
	} catch (e) {
		return { ok: false, error: `移动文件失败：${e instanceof Error ? e.message : String(e)}`, members: [] };
	}
	// 4. live sidecar 去掉该条目
	if (liveMembers[filename]) {
		delete liveMembers[filename];
		try {
			saveLiveMembers(profilePath, liveMembers);
		} catch {
			// 失败由 reconcile 的"搁浅成员"分支兜底
		}
	}
	return { ok: true, members };
}

export interface RestoreOptions {
	filename: string;
	by: string;
	reason?: string;
	nowIso?: string;
}

/**
 * 恢复一个块：`l2/archive/X.md` → `scene-blocks/X.md`。
 *
 * **落盘顺序**：
 *   1. 归档 sidecar 取出成员，**先写进 live sidecar**（块还没落盘，但条目先就位）
 *   2. `renameSync` 移回
 *   3. 从归档 sidecar 移除
 *   4. 追账
 *
 * 崩在 2 之后 3 之前 ⇒ 归档 sidecar 残留 + live sidecar 两面都有条目；块在 live 侧，`reconcileArchive`
 * 会把归档侧那条剪掉（文件不在归档目录里）。崩在 1 之后 2 之前 ⇒ live 有条目、live 无文件、
 * 归档有待收 ⇒ 被"搁浅成员"分支收回归档侧。两种中间态都不丢成员。
 */
export function restoreSceneBlock(profilePath: string, opts: RestoreOptions): ArchiveMoveResult {
	const nowIso = opts.nowIso ?? new Date().toISOString();
	const { filename, by } = opts;
	if (!isPlainBlockFilename(filename)) {
		return { ok: false, error: `文件名非法：${filename}`, members: [] };
	}
	const src = join(archiveDirOf(profilePath), filename);
	if (!existsSync(src)) {
		return { ok: false, error: `归档里没有这个块：${filename}`, members: [] };
	}
	if (existsSync(join(sceneDirOf(profilePath), filename))) {
		return { ok: false, error: `场景目录里已有同名块，拒绝覆盖：${filename}`, members: [] };
	}
	let raw = "";
	try {
		raw = readFileSync(src, "utf-8");
	} catch (e) {
		return { ok: false, error: `读取失败：${e instanceof Error ? e.message : String(e)}`, members: [] };
	}
	const meta = readArchivedMeta(raw);
	const archiveMembers = loadArchiveMembers(profilePath);
	const members = archiveMembers[filename] && archiveMembers[filename].length > 0
		? archiveMembers[filename]
		: memberIdsFromBody(raw);

	// 1. 先把成员放进 live sidecar
	const liveMembers = loadLiveMembers(profilePath);
	liveMembers[filename] = members;
	try {
		mkdirSync(sceneDirOf(profilePath), { recursive: true });
		saveLiveMembers(profilePath, liveMembers);
	} catch (e) {
		return { ok: false, error: `写 live 成员 sidecar 失败：${e instanceof Error ? e.message : String(e)}`, members: [] };
	}
	// 2. 移回
	try {
		renameSync(src, join(sceneDirOf(profilePath), filename));
	} catch (e) {
		return { ok: false, error: `移动文件失败：${e instanceof Error ? e.message : String(e)}`, members: [] };
	}
	// 3. 归档 sidecar 去掉
	if (archiveMembers[filename]) {
		delete archiveMembers[filename];
		try {
			saveArchiveMembers(profilePath, archiveMembers);
		} catch {
			// 由 reconcile 剪除
		}
	}
	// 4. 账
	appendArchiveLedger(profilePath, {
		op: "restore",
		filename,
		at: nowIso,
		reason: opts.reason ?? "恢复（未给理由）",
		by,
		heat: meta.heat,
		summary: meta.summary,
		memberCount: members.length,
	});
	return { ok: true, members };
}

/** 供工具/命令复用：归档目录是否已存在（报告用，避免到处 existsSync）。 */
export function archiveDirExists(profilePath: string): boolean {
	try {
		return statSync(archiveDirOf(profilePath)).isDirectory();
	} catch {
		return false;
	}
}

/** 命中统计侧车路径（只读事实清单用；**不得**构造可写 DB —— 那会重写生产文件）。 */
export function hitStatsSidecarPath(profilePath: string): string {
	return join(profilePath, MEMORY_DB_DIR, L1_HIT_STATS_JSON);
}
