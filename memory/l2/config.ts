import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { L1_RECORDS_DIR, L2_CURSOR_FILE as PATHS_L2_CURSOR, L2_SCENE_DIR, L2_SCENE_INDEX_PATH, L2_SCENE_MEMBERS_PATH, MEMORY_DB_DIR } from "../paths.ts";
import { loadAppProps } from "../../config/app-config.ts";
import { loadL1Config } from "../l1/config.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

// ══════════════════════════════════════════════════════════════
//  L2 配置 / 游标 / 任务构造（纯函数，无 pi 依赖，可单测）
// ══════════════════════════════════════════════════════════════

/** L1 提交多少批后触发一次 L2（已停用：L2 改由 pipeline-jobs 队列在 l1_commit 后入队）。
 * 保留常量以免外部引用断裂。
 */
export const L2_BATCH = 1;
/** 子代理超时（增量后每批只处理游标之后的新记录，3 分钟足够；原 10 分钟过长，hung 子代理会长期占锁）。 */
export const L2_SUBAGENT_TIMEOUT_MS = 180_000;
/** 连续失败多少次后熔断（暂停自动提取并通知用户）。 */
export const L2_FAILURE_THRESHOLD = 3;
/**
 * 场景块数量硬上限的**兜底默认值**（配置缺失/非法时使用）。
 * 真正的取值来自统一配置中心 `application-propertis.json` 的 `l2.maxScenes`（见 `loadL2Config`）。
 * 2026-09-10 起不再用本常量直接约束行为——它只是 fallback，避免各自硬编码 15。
 */
export const MAX_SCENES_DEFAULT = 15;

/** L2 游标文件名（lastRecordId）。 */
export const L2_CURSOR_FILE = PATHS_L2_CURSOR;
/** 场景文件目录名（{memoryDB}/scene_blocks）。 */
export const SCENE_DIR_NAME = L2_SCENE_DIR;
/** 场景索引路径（{memoryDB}/l2/index/scene_index.json）。 */
export const SCENE_INDEX_PATH = L2_SCENE_INDEX_PATH;
/** 场景成员清单 sidecar 路径（{memoryDB}/l2/index/scene_members.json）。 */
export const SCENE_MEMBERS_PATH = L2_SCENE_MEMBERS_PATH;

/** 规则文件目录（本模块同目录下的 prompts/）。 */
export const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

/** `application-propertis.json` 的 `l2` 节结构。 */
export interface L2Config {
	/** 场景块数量硬上限。 */
	maxScenes: number;
}

/**
 * 读取 L2 配置（收束到 `application-propertis.json` 的 `l2` 节，2026-09-10）。
 * 无配置 / 非法 / 非正数 → 返回 `MAX_SCENES_DEFAULT`。
 *
 * 抽取动因：`scene-extraction-personal.md` 与 `scene-extraction.md` 都声明了 `{maxScenes}`
 * 占位符并写明"按任务消息中的实际值替换"，但**任务消息从未注入过该字段**（第四处死模板，
 * 与 L1 的 `{previous_scene_name}` 同类），结果 `l2-scene-organizer.md` 只能把 15 写死。
 * 现在由 `buildL2Task` 注入 `MaxScenes` 行，值统一来自本配置。
 */
export function loadL2Config(profilePath: string): L2Config {
	const section = loadAppProps(profilePath)?.l2 as Partial<L2Config> | undefined;
	const n = section?.maxScenes;
	if (typeof n === "number" && Number.isFinite(n) && n > 0) return { maxScenes: Math.floor(n) };
	return { maxScenes: MAX_SCENES_DEFAULT };
}

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
 *
 * 2026-08-20 改造：去掉 RecordsFiles 字段。子代理不再依赖 .l2-staging/ 临时文件，
 * 改用 read_l1_increment 工具（memory/l2/read-tool.ts）按需读 L1 records。
 * 任务消息现在只保留 SceneDir / IndexPath / CursorPath / PromptDir 四个定位点。
 *
 * @param incremental  保留参数（外部调用方仍按习惯传 true/false），目前不写进任务消息
 *                    （增量行为由子代理通过 read_l1_increment 工具 + l2/cursor.json 自然保证）
 */
export function buildL2Task(profilePath: string, _recordsFilesOverride?: string[], _incremental = false): string {
	return renderPrompt("tasks/l2-task", {
		recordsDir: join(profilePath, MEMORY_DB_DIR, L1_RECORDS_DIR),
		sceneDir: join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME),
		indexPath: join(profilePath, MEMORY_DB_DIR, SCENE_INDEX_PATH),
		cursorPath: join(profilePath, MEMORY_DB_DIR, L2_CURSOR_FILE),
		promptDir: PROMPT_DIR,
		mode: loadL1Config(profilePath).mode,
		maxScenes: String(loadL2Config(profilePath).maxScenes),
	});
}

const L2_STAGING_DIR = ".l2-staging"; // 2026-08-20 废弃：保留路径常量以备旧任务清理，但已不再使用

/** 读全部 records，返回 {id, epoch, raw}（导出：供编排侧计算游标推进水位）。 */
export function readAllRecords(profilePath: string): Array<{ id: string; epoch: number; raw: string }> {
	const recordsDir = join(profilePath, MEMORY_DB_DIR, L1_RECORDS_DIR);
	if (!existsSync(recordsDir)) return [];
	// LWW（2026-09-11）：同 id 取追加序最后一行（覆盖式聚合），
	// 避免墓碑/改写产生的同 id 多行被重复计数（countNewRecords 高估、L2 调度误触发）。
	const lastById = new Map<string, { id: string; epoch: number; raw: string }>();
	for (const f of readdirSync(recordsDir).filter((f) => /\.jsonl$/.test(f)).sort()) {
		try {
			const text = readFileSync(join(recordsDir, f), "utf-8");
			for (const line of text.split(/\r?\n/)) {
				const t = line.trim();
				if (!t) continue;
				try {
					const obj = JSON.parse(t);
					const id = typeof obj?.id === "string" ? obj.id : "";
					if (id) lastById.set(id, { id, epoch: recordEpochMs(id), raw: t });
				} catch {
					// 跳过坏行
				}
			}
		} catch {
			// 跳过坏文件
		}
	}
	return [...lastById.values()];
}

/** 游标之后还有多少未组织记录（不写盘，供调度判断，避免每次 mtime tick 都建 staging）。 */
export function countNewRecords(profilePath: string, watermarkMs: number): number {
	return readAllRecords(profilePath).filter((r) => r.epoch > watermarkMs).length;
}

// 2026-08-20 改造：splitRecordsFiles 函数已废弃（被 read_l1_increment 工具替代）。
// 子代理现在通过工具按需读 L1 records，无需主进程预生成 staging 文件。
// 保留函数实现（灰度回滚用），但不再被 l2/index.ts 调用。
// @deprecated since 2026-08-20; use read_l1_increment tool instead
export function splitRecordsFiles(profilePath: string, watermarkMs = 0): string[][] {
	console.warn("[memory-system][l2] splitRecordsFiles is deprecated; use read_l1_increment tool");
	const news = readAllRecords(profilePath).filter((r) => r.epoch > watermarkMs);
	if (news.length === 0) return [];
	const stagingDir = join(profilePath, MEMORY_DB_DIR, L2_STAGING_DIR);
	if (!existsSync(stagingDir)) mkdirSync(stagingDir, { recursive: true });
	const stagingPath = join(stagingDir, `input-${Date.now()}.jsonl`);
	writeFileSync(stagingPath, news.map((r) => r.raw).join("\n") + "\n", "utf-8");
	return [[stagingPath]];
}
