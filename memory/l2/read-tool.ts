import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { L1_RECORDS_DIR, L2_CURSOR_FILE, MEMORY_DB_DIR } from "../paths.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

// ══════════════════════════════════════════════════════════════
//  read_l1_increment 工具 —— l2-scene-organizer 子代理一次读取游标后增量
//
//  背景（2026-08-20 实测）：L2 子代理之前依赖主进程预生成的 .l2-staging/
//  input-XXX.jsonl，但该 staging 文件在 runTask 的 finally 块被立即清理，子代
//  理真正开始读取时已 ENOENT，必须自救去 scan l1-records/ 目录（多 read 调
//  用、且没有 L2 cursor 字段做精确过滤）。
//
//  解法（镜像 read_l0_increment 模式）：扩展工具一次调用返回游标后的全部增量
//  + nextCursor + truncated 标记。子代理主动调工具拿数据，main process 不再
//  预生成 staging 文件，staging 与 finally 清理的竞态根除。
//
//  返回值约定（与 read_l0_increment 对称）：
//    - records:    游标后的 L1 records JSON 对象数组（按 epoch 升序）
//    - nextCursor: 增量最后一条的 id（子代理提交 l2_commit 时作为 cursor）
//    - totalNew:   实际过滤到的总条数（不受 maxRecords 截断影响）
//    - returned:   本次实际返回的条数（≤ maxRecords）
//    - truncated:  增量超 cap 时为 true，子代理据此决定是否补调用
// ══════════════════════════════════════════════════════════════

/** 单次返回最大增量条数（防上下文爆炸；子代理可多次调用循环处理）。 */
const MAX_INCREMENT = 50;
/** 硬上限（防止参数滥用）。 */
const HARD_CAP = 200;

/** L1 record 精简字段（剔除大体积 source_message_ids / metadata，避免单条记录超 2KB）。 */
interface CompactL1Record {
	id: string;
	content: string;
	type: string;
	priority: number;
	scene_name?: string;
	createdAt: string;
	updatedAt: string;
	version: number;
	deleted: boolean;
}

/** 解析 L1 record，宽容坏行。 */
function parseL1Record(line: string): CompactL1Record | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const obj = JSON.parse(trimmed) as Record<string, unknown>;
		if (typeof obj?.id !== "string") return null;
		return {
			id: obj.id,
			content: typeof obj.content === "string" ? obj.content : "",
			type: typeof obj.type === "string" ? obj.type : "work_fact",
			priority: typeof obj.priority === "number" ? obj.priority : 0,
			scene_name: typeof obj.scene_name === "string" ? obj.scene_name : undefined,
			createdAt: typeof obj.createdAt === "string" ? obj.createdAt : "",
			updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : "",
			version: typeof obj.version === "number" ? obj.version : 1,
			deleted: obj.deleted === true,
		};
	} catch {
		return null;
	}
}

/** 从 record id 解析 epoch 毫秒（与 l2/config.ts recordEpochMs 同构）。 */
function recordEpochMs(id: string): number {
	const parts = String(id).split("_");
	if (parts.length < 2) return 0;
	const n = Number(parts[1]);
	return Number.isFinite(n) ? n : 0;
}

/**
 * 从 L1 records 目录读游标后的增量 records。
 *
 * @param l1Dir    L1 records 目录（{profile}/memoryDB/l1-records）
 * @param cursor   L2 cursor 的 lastRecordId（空串=从最早开始）
 * @param maxRecords 本次返回上限（默认 50，硬上限 200）
 * @returns { records, nextCursor, totalNew, returned, truncated }
 *
 * 过滤规则：epoch > cursorEpoch（保留 deleted=false 的；version>1 的当前版本）
 * —— 期望 l1-commit 已做 dedup，records 目录里出现的每条 id 是当前活跃版本。
 */
function readL1Increment(
	l1Dir: string,
	cursor: string,
	maxRecords: number,
): { records: CompactL1Record[]; nextCursor: string; totalNew: number; returned: number; truncated: boolean } {
	if (!existsSync(l1Dir)) return { records: [], nextCursor: cursor, totalNew: 0, returned: 0, truncated: false };
	const cursorEpoch = recordEpochMs(cursor);

	// 1. 读所有 jsonl 分片，按文件名升序
	const files = readdirSync(l1Dir).filter((f) => /\.jsonl$/.test(f)).sort();
	const all: CompactL1Record[] = [];
	for (const f of files) {
		try {
			const content = readFileSync(join(l1Dir, f), "utf-8");
			for (const line of content.split(/\r?\n/)) {
				const rec = parseL1Record(line);
				if (!rec) continue;
				all.push(rec);
			}
		} catch {
			// 跳过坏分片
		}
	}

	// 2. 按 epoch 升序、按 id 字符串升序（保证稳定排序）
	all.sort((a, b) => {
		const ea = recordEpochMs(a.id);
		const eb = recordEpochMs(b.id);
		if (ea !== eb) return ea - eb;
		return a.id.localeCompare(b.id);
	});

	// 3. 过滤 epoch > cursorEpoch（保留 deleted：因为 dedup 留下的 tombstone 也属于历史）
	const filtered = all.filter((r) => recordEpochMs(r.id) > cursorEpoch);

	const totalNew = filtered.length;
	const cap = Math.min(Math.max(maxRecords, 1), HARD_CAP);
	const truncated = filtered.length > cap;
	const slice = truncated ? filtered.slice(0, cap) : filtered;

	const nextCursor = slice.length > 0 ? slice[slice.length - 1].id : cursor;

	return {
		records: slice,
		nextCursor,
		totalNew,
		returned: slice.length,
		truncated,
	};
}

/**
 * 注册 read_l1_increment 工具（扩展加载时调用一次）。
 *
 * 子代理调用参数：
 *  - l1Dir: L1 records 目录绝对路径（buildL2Task 的 RecordsDir 行原样传入）
 *  - cursor: L2 cursor 的 lastRecordId（空串=从最早开始；通常子代理不传，
 *            工具内部从 l2-cursor.json 读默认）
 *  - maxRecords: 本次返回上限（可选，默认 50，硬上限 200）
 *
 * 返回：JSON 序列化的 { records, nextCursor, totalNew, returned, truncated }
 */
export function registerReadL1IncrementTool(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): void {
	pi.registerTool({
		name: "read_l1_increment",
		label: "Read L1 Increment",
		description: renderPrompt("tools#read_l1_increment"),
		parameters: {
			type: "object",
			properties: {
				l1Dir: {
					type: "string",
					description: "Absolute path of L1 records directory (from the RecordsDir line of the task message).",
				},
				cursor: {
					type: "string",
					description: "L2 cursor lastRecordId. Empty string or omit to read default from l2/cursor.json.",
					default: "",
				},
				maxRecords: {
					type: "number",
					description: "Max records to return this call. Default 50, hard cap 200.",
					default: 50,
				},
			},
			required: ["l1Dir"],
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const l1Dir = typeof params?.l1Dir === "string" ? params.l1Dir : "";
				if (!l1Dir) {
					return {
						content: [{ type: "text", text: JSON.stringify({ success: false, error: "l1Dir is required" }) }],
						details: {},
					};
				}
				const cursor = typeof params?.cursor === "string" ? params.cursor : "";
				const maxRecords = typeof params?.maxRecords === "number" ? params.maxRecords : MAX_INCREMENT;

				// cursor 为空时，从 l2-cursor.json 读默认
				let effectiveCursor = cursor;
				if (!effectiveCursor) {
					const profilePath = getProfilePath();
					if (profilePath) {
						const cursorPath = join(profilePath, MEMORY_DB_DIR, L2_CURSOR_FILE);
						if (existsSync(cursorPath)) {
							try {
								const data = JSON.parse(readFileSync(cursorPath, "utf-8")) as { lastRecordId?: string };
								if (typeof data.lastRecordId === "string") effectiveCursor = data.lastRecordId;
							} catch {
								// ignore parse error
							}
						}
					}
				}

				const result = readL1Increment(l1Dir, effectiveCursor, maxRecords);
				return {
					content: [{ type: "text", text: JSON.stringify({ success: true, ...result }) }],
					details: {},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }) }],
					details: {},
				};
			}
		},
	});
}
