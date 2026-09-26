// ============================================================================
// memory/l2/archive-facts.ts — 归档决策的**事实清单**（2026-09-27）
//
// 为什么不是"冷度判据"：原设计想按「活跃日的未曝光时长」算出冷度并过滤候选。2026-09-27 两轮只读实测
// 证明这条路在本机不存在 ——
//   · 活跃日时钟总长只有 27 天（阈值 30 算术上不可达）
//   · 命中库 212/212 条 effective_hits > 0、invalid_hits 全 0（"用过就保护"覆盖全部块）
//   · 而 L1 召回是**自动注入**（按相似度每轮注入 top-k）⇒ 每条记忆的 last_hit_at 都被持续刷新
// 结论：任何阈值化的冷度都会恒空；把阈值调到能触发（≤9 个活跃日）等于武断地把"安静了一周半"
// 当成"该归档"，也违反用户最初的要求（不能单凭天数判断）。
//
// 所以本模块**只提供可复核的事实**，判断权交子代理（按"项目是否收尾"语义挑，必须写 reason）。
// 程序只保留**两条硬拦**：① 真实年龄（日历天）不足；② 同名冲突。见 `checkArchiveHardBlocks`。
//
// 只读纪律：命中数据一律读 **JSON 侧车**（`l1/hit-stats.json`），**绝不构造 `L1HitStatsDB`** ——
// 那个构造函数会建目录、开 WAL 并重写侧车（等于改生产文件）。代价是数字的鲜度以最近一次导出为准，
// 这对"给 LLM 看的事实"足够（且工具返回会把来源标出来）。
// ============================================================================

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { activeDayKeysToTimestamps, countActiveDaysAfter, loadActiveDayKeys } from "../l1/active-days.ts";
import { countSceneBlocks, gradeSceneCount, loadL2ArchiveConfig, loadL2Config, type L2ArchiveConfig, type SceneCountLevel } from "./config.ts";
import { listArchivedFilenames, loadLiveMembers, readArchivedMeta, sceneDirOf } from "./archive.ts";

/** 一个场景块的事实（全部可人工复核，不含任何"评分"）。 */
export interface SceneBlockFacts {
	filename: string;
	heat: number;
	/** 该块声明的成员数（来自 sidecar）。 */
	memberCount: number;
	/** 成员里在命中库里有记录的条数 —— 0 表示"从没被召回过的成员数据"。 */
	membersWithHits: number;
	/** 成员里最近一次被召回的日期（ISO 日期，仅日期部分）。 */
	lastHitAt: string | null;
	/** 自该块最后一次被写入（META.updated）起，过了**几个活跃会话日**（停工那几天不计）。 */
	activeDaysSinceUpdate: number | null;
	/** 该块的真实年龄（**日历天**，从 META.created 算）。 */
	ageCalendarDays: number | null;
	updated: string;
	summary: string;
}

export interface ArchiveFacts {
	blocks: SceneBlockFacts[];
	/** 当前场景数与上限（与上限预检同源）。 */
	count: number;
	maxScenes: number;
	level: SceneCountLevel;
	/** 归档层配置（含 `enabled`）。 */
	archive: L2ArchiveConfig & { archivedCount: number };
	/** 活跃日时钟总长（说明"事实"的时间尺子有多长）。 */
	activeDays: number;
	/** 命中数据的来源：`sidecar` = 读了 JSON 侧车；`none` = 侧车缺失（此时命中列全为 0）。 */
	statsSource: "sidecar" | "none";
	generatedAt: string;
}

interface HitStatRow {
	record_id: string;
	last_hit_at: string | null;
	hits: number;
	invalid_hits: number;
	effective_hits: number;
}

/** 只读命中侧车（缺失/损坏 → 空表，绝不抛）。 */
function loadHitStatsSidecar(profilePath: string): { rows: Map<string, HitStatRow>; ok: boolean } {
	const filePath = join(profilePath, "memoryDB", "l1", "hit-stats.json");
	if (!existsSync(filePath)) return { rows: new Map(), ok: false };
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		const arr = Array.isArray(data)
			? (data as HitStatRow[])
			: ((data as { stats?: HitStatRow[] } | null)?.stats ?? []);
		const rows = new Map<string, HitStatRow>();
		for (const r of arr) {
			if (r && typeof r.record_id === "string") rows.set(r.record_id, r);
		}
		return { rows, ok: true };
	} catch {
		return { rows: new Map(), ok: false };
	}
}

/** 本地日 0 点 → `YYYY-MM-DD`（给 LLM 看的日期，不带时分）。 */
function isoDateOf(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 装配事实清单（纯读）。
 *
 * @param nowMs 当前时间（测试可注入）
 */
export function buildArchiveFacts(profilePath: string, nowMs: number = Date.now()): ArchiveFacts {
	const cfg = loadL2Config(profilePath);
	const archive = loadL2ArchiveConfig(profilePath);
	const sceneDir = sceneDirOf(profilePath);
	const filenames = existsSync(sceneDir)
		? readdirSync(sceneDir).filter((f) => f.endsWith(".md")).sort()
		: [];
	const members = loadLiveMembers(profilePath);
	const { rows: hitById, ok: statsOk } = loadHitStatsSidecar(profilePath);
	const dayKeys = loadActiveDayKeys(profilePath);
	const activeDays = dayKeys ? activeDayKeysToTimestamps(dayKeys) : undefined;

	const blocks: SceneBlockFacts[] = [];
	for (const filename of filenames) {
		let raw = "";
		try {
			raw = readFileSync(join(sceneDir, filename), "utf-8");
		} catch {
			continue;
		}
		const meta = readArchivedMeta(raw);
		const ids = members[filename] ?? [];
		const stats = ids.map((id) => hitById.get(id)).filter((s): s is HitStatRow => Boolean(s));
		const withHits = stats.filter((s) => s.last_hit_at);
		const lastHitMs = withHits.length > 0
			? Math.max(...withHits.map((s) => Date.parse(s.last_hit_at as string)))
			: null;
		const createdMs = Date.parse(meta.created);
		const updatedMs = Date.parse(meta.updated);
		blocks.push({
			filename,
			heat: meta.heat,
			memberCount: ids.length,
			membersWithHits: stats.length,
			lastHitAt: lastHitMs !== null && Number.isFinite(lastHitMs) ? isoDateOf(lastHitMs) : null,
			activeDaysSinceUpdate:
				activeDays && Number.isFinite(updatedMs) ? countActiveDaysAfter(activeDays, updatedMs) : null,
			ageCalendarDays: Number.isFinite(createdMs) ? Math.floor((nowMs - createdMs) / 86_400_000) : null,
			updated: meta.updated,
			summary: meta.summary,
		});
	}

	return {
		blocks,
		count: countSceneBlocks(profilePath),
		maxScenes: cfg.maxScenes,
		level: gradeSceneCount(countSceneBlocks(profilePath), cfg.maxScenes),
		archive: { ...archive, archivedCount: listArchivedFilenames(profilePath).length },
		activeDays: dayKeys?.length ?? 0,
		statsSource: statsOk ? "sidecar" : "none",
		generatedAt: new Date(nowMs).toISOString(),
	};
}

/** 硬拦结论。 */
export interface HardBlockVerdict {
	ok: boolean;
	code?: "too-early" | "name-conflict";
	message?: string;
}

/**
 * 两条硬拦（**纯函数**）：唯一保留的数值判据 + 覆盖保护。
 *
 * 1. `too-early`：真实年龄（**日历天**）不足。必须用日历天 —— 活跃日时钟在停工期间不增长，
 *    否则"刚建完就休假"会被误判为冷。
 * 2. `name-conflict`：归档目录里已有同名块（拒绝覆盖）。
 *
 * `ageCalendarDays === null`（META.created 缺失/损坏）⇒ **放行**：判不了就不假装判得了，
 * 事实清单里会把 null 如实展示给子代理，且归档可逆。
 */
export function checkArchiveHardBlocks(input: {
	ageCalendarDays: number | null;
	minAgeCalendarDays: number;
	nameConflict: boolean;
}): HardBlockVerdict {
	if (input.nameConflict) {
		return { ok: false, code: "name-conflict", message: "归档目录里已有同名块，拒绝覆盖（请先 restore 或改名）" };
	}
	if (input.ageCalendarDays !== null && input.ageCalendarDays < input.minAgeCalendarDays) {
		return {
			ok: false,
			code: "too-early",
			message: `该块真实年龄只有 ${input.ageCalendarDays} 个日历天（下限 ${input.minAgeCalendarDays}）：刚建好的块即使最近没被写到也不该归档`,
		};
	}
	return { ok: true };
}
