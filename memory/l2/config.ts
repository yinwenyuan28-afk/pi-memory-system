import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { L1_RECORDS_DIR, L2_CURSOR_FILE as PATHS_L2_CURSOR, L2_SCENE_DIR, L2_SCENE_INDEX_PATH, MEMORY_DB_DIR } from "../paths.js";

// ══════════════════════════════════════════════════════════════
//  L2 配置 / 游标 / 任务构造（纯函数，无 pi 依赖，可单测）
// ══════════════════════════════════════════════════════════════

/** L1 提交多少批后触发一次 L2（08-18 改：3 → 1，每次 L1 立即 L2）。
 * 理由：L2_BATCH=3 时单批可能积压 30+ 条 L1 记录，l2-scene-organizer
 * 决策策环“如何映射到现有场景”会卡住（mimo-v2.5 推理不足）。
 * L2_BATCH=1 后每次 L1 commit 立即 L2；当前为**增量 + 串行**：
 * splitRecordsFiles 只把 L2 游标（lastProcessedAt）之后的新 records 写进
 * 临时 staging 文件，runTask 串行派发单个 l2-scene-organizer 处理该 staging
 * （每轮决策空间小、且写同一 scene_blocks 目录需串行避免 race）。
 */
export const L2_BATCH = 1;
/** 子代理超时（增量后每批只处理游标之后的新记录，3 分钟足够；原 10 分钟过长，hung 子代理会长期占锁）。 */
export const L2_SUBAGENT_TIMEOUT_MS = 180_000;
/** 连续失败多少次后熔断（暂停自动提取并通知用户）。 */
export const L2_FAILURE_THRESHOLD = 3;
/** 场景数量上限（腾讯默认）。 */
export const MAX_SCENES = 15;

/** L2 游标文件名（lastRecordId）。 */
export const L2_CURSOR_FILE = PATHS_L2_CURSOR;
/** 场景文件目录名（{memoryDB}/scene_blocks）。 */
export const SCENE_DIR_NAME = L2_SCENE_DIR;
/** 场景索引路径（{memoryDB}/.metadata/scene_index.json）。 */
export const SCENE_INDEX_PATH = L2_SCENE_INDEX_PATH;

/** 规则文件目录（本模块同目录下的 prompts/）。 */
export const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

/** 从 record id（格式 l1_{timestamp}_{random}）解析 epoch 毫秒；解析失败返回 0。 */
export function recordEpochMs(id: string): number {
	const parts = String(id).split("_");
	if (parts.length < 2) return 0;
	const n = Number(parts[1]);
	return Number.isFinite(n) ? n : 0;
}

/** L2 游标：lastRecordId（展示/透传）+ lastProcessedAt（epoch ms 水位，编排侧真正用于增量）。 */
export interface L2Cursor {
	lastRecordId: string;
	lastProcessedAt: number;
}

/** 读取 L2 游标。无文件或损坏返回空；旧版只有 lastRecordId 时反推 lastProcessedAt。 */
export function loadL2Cursor(profilePath: string): L2Cursor {
	const filePath = join(profilePath, MEMORY_DB_DIR, L2_CURSOR_FILE);
	const empty: L2Cursor = { lastRecordId: "", lastProcessedAt: 0 };
	if (!existsSync(filePath)) return empty;
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as { lastRecordId?: string; lastProcessedAt?: number };
		const lastRecordId = typeof data.lastRecordId === "string" ? data.lastRecordId : "";
		let lastProcessedAt = typeof data.lastProcessedAt === "number" ? data.lastProcessedAt : 0;
		if (!lastProcessedAt && lastRecordId) lastProcessedAt = recordEpochMs(lastRecordId); // 旧游标兼容
		return { lastRecordId, lastProcessedAt };
	} catch {
		return empty;
	}
}

/**
 * 主进程写 L2 游标（整批成功后由编排侧 runTask 调用，不信任子代理上报的 cursor）。
 * @param lastProcessedAt  epoch 水位 = 本批 staging 记录的真实最大 epoch（代码算出）
 * @param lastRecordId     展示用，可选
 */
export function saveL2Cursor(profilePath: string, lastProcessedAt: number, lastRecordId = ""): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, L2_CURSOR_FILE);
	const tmp = join(profilePath, MEMORY_DB_DIR, `.tmp_l2_cursor_${Date.now()}`);
	writeFileSync(tmp, JSON.stringify({ lastRecordId, lastProcessedAt }, null, 2), "utf-8");
	try {
		rmSync(filePath, { force: true });
	} catch {
		// ignore
	}
	try {
		renameSync(tmp, filePath);
	} catch {
		try {
			writeFileSync(filePath, readFileSync(tmp, "utf-8"), "utf-8");
		} catch {
			// ignore
		}
	}
	try {
		rmSync(tmp, { force: true });
	} catch {
		// ignore
	}
}

/** 构造 l2-scene-organizer 子代理任务消息。
 * @param recordsFilesOverride  指定该子代理要读取的 records 文件（增量模式下是 staging 临时文件，只含游标之后的新记录）
 * @param incremental           true=只处理新记录，子代理需把新记录 merge 进已有场景
 */
export function buildL2Task(profilePath: string, recordsFilesOverride?: string[], incremental = false): string {
	// 枚举 records 下实际 JSONL 分片文件清单（子代理不需猜测 / 试错日期）——08-17 实测
	const recordsDir = join(profilePath, MEMORY_DB_DIR, L1_RECORDS_DIR);
	const recordsFiles = recordsFilesOverride
		?? (existsSync(recordsDir)
			? readdirSync(recordsDir).filter((f) => /\.jsonl$/.test(f)).sort().map((f) => join(recordsDir, f))
			: []);
	return [
		"L2 organization task",
		`RecordsDir: ${recordsDir}`,
		`RecordsFiles: ${recordsFiles.join(",") || "(none)"}`,
		incremental
			? "NewRecordsOnly: true（仅含 L2 游标之后的新记录，请 merge 进 scene_index.json 已有场景，不要重建）"
			: "NewRecordsOnly: false（全量扫描）",
		`SceneDir: ${join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME)}`,
		`IndexPath: ${join(profilePath, MEMORY_DB_DIR, SCENE_INDEX_PATH)}`,
		`CursorPath: ${join(profilePath, MEMORY_DB_DIR, L2_CURSOR_FILE)}`,
		`PromptDir: ${PROMPT_DIR}`,
	].join("\n");
}

const L2_STAGING_DIR = ".l2-staging";

/** 读全部 records，返回 {id, epoch, raw}（导出：供编排侧计算游标推进水位）。 */
export function readAllRecords(profilePath: string): Array<{ id: string; epoch: number; raw: string }> {
	const recordsDir = join(profilePath, MEMORY_DB_DIR, L1_RECORDS_DIR);
	if (!existsSync(recordsDir)) return [];
	const out: Array<{ id: string; epoch: number; raw: string }> = [];
	for (const f of readdirSync(recordsDir).filter((f) => /\.jsonl$/.test(f)).sort()) {
		try {
			const text = readFileSync(join(recordsDir, f), "utf-8");
			for (const line of text.split(/\r?\n/)) {
				const t = line.trim();
				if (!t) continue;
				try {
					const obj = JSON.parse(t);
					const id = typeof obj?.id === "string" ? obj.id : "";
					if (id) out.push({ id, epoch: recordEpochMs(id), raw: t });
				} catch {
					// 跳过坏行
				}
			}
		} catch {
			// 跳过坏文件
		}
	}
	return out;
}

/** 游标之后还有多少未组织记录（不写盘，供调度判断，避免每次 mtime tick 都建 staging）。 */
export function countNewRecords(profilePath: string, watermarkMs: number): number {
	return readAllRecords(profilePath).filter((r) => r.epoch > watermarkMs).length;
}

/**
 * 增量拆 chunk：只把游标之后（epoch > watermarkMs）的 records 写入临时 staging 文件，
 * 返回 [[stagingPath]]；无新记录返回 []。staging 由调用方在 finally 清理。
 * 这修复了原先「每次 L2 都全量重扫所有 records」的问题——现在 L2 游标真正生效。
 */
export function splitRecordsFiles(profilePath: string, watermarkMs = 0): string[][] {
	const news = readAllRecords(profilePath).filter((r) => r.epoch > watermarkMs);
	if (news.length === 0) return [];
	const stagingDir = join(profilePath, MEMORY_DB_DIR, L2_STAGING_DIR);
	if (!existsSync(stagingDir)) mkdirSync(stagingDir, { recursive: true });
	const stagingPath = join(stagingDir, `input-${Date.now()}.jsonl`);
	writeFileSync(stagingPath, news.map((r) => r.raw).join("\n") + "\n", "utf-8");
	return [[stagingPath]];
}
