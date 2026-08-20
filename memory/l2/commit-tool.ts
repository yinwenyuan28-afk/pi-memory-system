import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SCENE_DIR_NAME, SCENE_INDEX_PATH, saveL2Cursor, recordEpochMs } from "./config.js";
import { MEMORY_DB_DIR } from "../paths.js";

// ══════════════════════════════════════════════════════════════
//  l2_commit 工具 —— 子代理场景写盘桥接
//
//  模式与 l1_commit 相同：子代理通过扩展工具提交场景写入（sceneWrites），
//  主进程落盘（工具调用不受 Plan Enforcer 拦截）。主进程负责：
//    1. 场景文件落盘（META 头 + 正文，原子写；delete 删文件）
//    2. 场景索引同步（扫描 scene_blocks/ 全量重建）
//    3. L2 游标推进（lastRecordId）
// ══════════════════════════════════════════════════════════════

/** 场景文件 META 分隔标记（腾讯格式 1:1）。 */
const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

/** 场景 META 元数据（腾讯 scene-format.ts 同构）。 */
export interface SceneMeta {
	created: string;
	updated: string;
	summary: string;
	heat: number;
}

/** 子代理提交的单条场景写入。 */
export interface SceneWrite {
	action: "create" | "update" | "merge" | "delete";
	filename: string;
	meta?: Partial<SceneMeta>;
	content?: string;
}

/** l2_commit 返回。 */
export interface L2CommitResult {
	success: boolean;
	sceneCount: number;
	/** 推进到的游标值（lastRecordId）。 */
	cursor?: string;
	error?: string;
}

/** 合法场景文件名（对齐腾讯命名规范）。 */
const FILENAME_RE = /^[\w\u4e00-\u9fff-]+\.md$/;

/** META 头 + 正文拼接（腾讯 formatSceneBlock）。 */
export function formatSceneBlock(meta: SceneMeta, content: string): string {
	const metaBlock = [
		META_START,
		`created: ${meta.created}`,
		`updated: ${meta.updated}`,
		`summary: ${meta.summary}`,
		`heat: ${meta.heat}`,
		META_END,
	].join("\n");
	return `${metaBlock}\n\n${content}`;
}

/** 解析场景文件为 META + 内容（腾讯 parseSceneBlock）。 */
export function parseSceneBlock(raw: string): { meta: SceneMeta; content: string } {
	const startIdx = raw.indexOf(META_START);
	const endIdx = raw.indexOf(META_END);
	if (startIdx === -1 || endIdx === -1) {
		return { meta: { created: "", updated: "", summary: "", heat: 0 }, content: raw.trim() };
	}
	const metaBlock = raw.slice(startIdx + META_START.length, endIdx).trim();
	const content = raw.slice(endIdx + META_END.length).trim();
	const field = (k: string): string => {
		const line = metaBlock.split("\n").find((l) => l.startsWith(`${k}: `));
		return line ? line.slice(k.length + 2).trim() : "";
	};
	return {
		meta: {
			created: field("created"),
			updated: field("updated"),
			summary: field("summary"),
			heat: parseInt(field("heat"), 10) || 0,
		},
		content,
	};
}

/** 原子写文件（tmp + rename，tmp 与目标同目录保证同盘 rename）。 */
function atomicWrite(filePath: string, content: string): void {
	const tmpPath = join(join(filePath, ".."), `.tmp_scene_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
	writeFileSync(tmpPath, content, "utf-8");
	try {
		renameSync(tmpPath, filePath);
	} catch {
		writeFileSync(filePath, content, "utf-8");
	}
	try {
		rmSync(tmpPath, { force: true });
	} catch {
		// ignore
	}
}

/**
 * 扫描 scene_blocks/ 全量重建场景索引（腾讯 syncSceneIndex 语义）。
 * 返回索引条目数组并写 scene_index.json。
 */
export function syncSceneIndex(profilePath: string): Array<{ filename: string; summary: string; heat: number; created: string; updated: string }> {
	const sceneDir = join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME);
	const entries: Array<{ filename: string; summary: string; heat: number; created: string; updated: string }> = [];
	if (existsSync(sceneDir)) {
		for (const f of readdirSync(sceneDir)) {
			if (!f.endsWith(".md")) continue;
			try {
				const raw = readFileSync(join(sceneDir, f), "utf-8");
				const { meta } = parseSceneBlock(raw);
				entries.push({ filename: f, summary: meta.summary, heat: meta.heat, created: meta.created, updated: meta.updated });
			} catch {
				// 跳过坏文件
			}
		}
	}
	entries.sort((a, b) => b.heat - a.heat);
	const idxPath = join(profilePath, MEMORY_DB_DIR, SCENE_INDEX_PATH);
	const idxDir = join(profilePath, MEMORY_DB_DIR, ".metadata");
	if (!existsSync(idxDir)) mkdirSync(idxDir, { recursive: true });
	writeFileSync(idxPath, JSON.stringify(entries, null, 2), "utf-8");
	return entries;
}

/**
 * 注册 l2_commit 工具（扩展加载时调用一次）。
 *
 * 子代理调用参数：
 *  - sceneWrites: 场景写入数组 [{action, filename, meta, content}]
 *  - cursor: 推进到的 lastRecordId
 *  - personaSignal: 可选，true 表示请求 L3 persona 更新（P1 触发）
 *  - personaReason: 可选，persona 更新原因
 */
export function registerL2CommitTool(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
	onCommitted?: (opts: { personaSignal?: boolean; personaReason?: string }) => void,
): void {
	pi.registerTool({
		name: "l2_commit",
		label: "L2 Commit Scene Writes",
		description:
			"Commit scene block writes and advance the L2 cursor. Called by the l2-scene-organizer subagent. " +
			"Params: sceneWrites (array of {action: create|update|merge|delete, filename, meta: {created,updated,summary,heat}, content}), cursor (lastRecordId string), personaSignal (optional boolean), personaReason (optional string).",
		parameters: {
			type: "object",
			properties: {
				sceneWrites: {
					type: "array",
					description: "Scene writes: action create/update/merge writes file (META header auto-added), delete removes file",
					items: {
						type: "object",
						properties: {
							action: { type: "string", enum: ["create", "update", "merge", "delete"] },
							filename: { type: "string" },
							meta: { type: "object" },
							content: { type: "string" },
						},
						required: ["action", "filename"],
					},
				},
				cursor: { type: "string", description: "Advance L2 cursor to this record id" },
				personaSignal: { type: "boolean", description: "Set true to request L3 persona update (P1 trigger)" },
				personaReason: { type: "string", description: "Reason for persona update when personaSignal is true" },
			},
			required: ["sceneWrites", "cursor"],
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const profilePath = getProfilePath();
				if (!profilePath) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active profile" }) }], details: {} };
				}
				const writes = params?.sceneWrites as SceneWrite[] | undefined;
				const cursor = typeof params?.cursor === "string" ? params.cursor : "";
				if (!Array.isArray(writes) || !cursor) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "sceneWrites must be an array and cursor must be a string" }) }], details: {} };
				}

				const sceneDir = join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME);
				if (!existsSync(sceneDir)) mkdirSync(sceneDir, { recursive: true });
				const now = new Date().toISOString();

				for (const w of writes) {
					if (!FILENAME_RE.test(w.filename)) {
						return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `illegal filename: ${w.filename}` }) }], details: {} };
					}
					const filePath = join(sceneDir, w.filename);
					if (w.action === "delete") {
						try {
							rmSync(filePath, { force: true });
						} catch {
							// ignore
						}
						continue;
					}
					// create/update/merge：META + content 落盘
					const meta: SceneMeta = {
						created: w.meta?.created || now,
						updated: w.meta?.updated || now,
						summary: w.meta?.summary || "",
						heat: typeof w.meta?.heat === "number" ? w.meta.heat : 0,
					};
					const content = typeof w.content === "string" ? w.content : "";
					atomicWrite(filePath, formatSceneBlock(meta, content));
				}

			// 同步场景索引（全量重建）
			const entries = syncSceneIndex(profilePath);

			// L2 游标推进：以子代理上报的 cursor 为真源（fc78374 已移除主进程 runTask 的
			// 预推进——fire-and-forget 下 runTask 在子代理真实加工前 resolve，预推进会把
			// 本批记录从 read_l1_increment 增量中滤掉造成空转）。
			// 此处写回 lastRecordId + 反推 epoch，供下次增量过滤使用。
			saveL2Cursor(profilePath, recordEpochMs(cursor), cursor);

			const personaSignal = params?.personaSignal === true;
				const personaReason = typeof params?.personaReason === "string" ? params.personaReason : undefined;
				try {
					onCommitted?.({ personaSignal, personaReason });
				} catch {
					// non-fatal
				}

				return {
					content: [{ type: "text", text: JSON.stringify({ success: true, sceneCount: entries.length, cursor } satisfies L2CommitResult) }],
					details: {},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ success: false, sceneCount: 0, error: err instanceof Error ? err.message : String(err) } satisfies L2CommitResult) }],
					details: {},
				};
			}
		},
	});
}
