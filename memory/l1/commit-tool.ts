import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_FILE, RECORDS_DIR_NAME } from "./config.js";
import { MEMORY_DB_DIR } from "../paths.js";

// ══════════════════════════════════════════════════════════════
//  l1_commit 工具 —— 子代理写盘桥接
//
//  背景（2026-08-17 实测）：l1-extractor 子代理直接 write records/ 被
//  Plan Enforcer 拦截（子代理无 TUI/plan_approve，{profile}/records 也不在
//  plan/、temp/ 白名单）。解法与 memory-reviewer 用 memory 工具同模式：
//  子代理通过扩展工具提交产物，由主进程落盘（工具调用不受 edit/write 拦截）。
// ══════════════════════════════════════════════════════════════

/** 本地时区 YYYY-MM-DD（分片名，与 l0 一致）。 */
function localDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** 原子写 l1-cursor.json（tmp + rename）。 */
function saveCursor(profilePath: string, lastRecordedAt: string): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, CURSOR_FILE);
	const tmpPath = join(profilePath, MEMORY_DB_DIR, `.tmp_l1_cursor_${Date.now()}`);
	writeFileSync(tmpPath, JSON.stringify({ lastRecordedAt }, null, 2), "utf-8");
	try {
		rmSync(filePath, { force: true });
	} catch {
		// ignore
	}
	try {
		renameSync(tmpPath, filePath);
	} catch {
		writeFileSync(filePath, readFileSafe(tmpPath), "utf-8");
	}
	try {
		rmSync(tmpPath, { force: true });
	} catch {
		// ignore
	}
}

function readFileSafe(p: string): string {
	try {
		return readFileSync(p, "utf-8");
	} catch {
		return "";
	}
}

/**
 * 注册 l1_commit 工具（扩展加载时调用一次）。
 *
 * 子代理调用参数：
 *  - records: L1 记忆记录对象数组（schema 见 agents/l1-extractor.md 第六步）
 *  - cursor: 本次推进到的 lastRecordedAt（ISO 字符串）
 */
export function registerL1CommitTool(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
	onCommitted?: (written: number) => void,
): void {
	pi.registerTool({
		name: "l1_commit",
		label: "L1 Commit Records",
		description:
			"Commit extracted L1 memory records and advance the L1 cursor. " +
			"Called by the l1-extractor subagent after extraction and dedup. " +
			"Params: records (array of record objects per L1 schema), cursor (lastRecordedAt ISO string).",
		parameters: {
			type: "object",
			properties: {
				records: {
					type: "array",
					description: "L1 memory record objects: {id, content, type, priority, scene_name, source_message_ids, metadata, timestamps, createdAt, updatedAt, version, sessionKey, sessionId, deleted}",
					items: { type: "object" },
				},
				cursor: {
					type: "string",
					description: "Advance L1 cursor to this lastRecordedAt ISO string.",
				},
			},
			required: ["records", "cursor"],
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const profilePath = getProfilePath();
				if (!profilePath) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active profile" }) }], details: {} };
				}
				const records = params?.records;
				const cursor = typeof params?.cursor === "string" ? params.cursor : "";
				if (!Array.isArray(records) || !cursor) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "records must be an array and cursor must be a string" }) }], details: {} };
				}

				// 1. 追加写 records 分片（按当前本地日期）
				let written = 0;
				if (records.length > 0) {
					const recordsDir = join(profilePath, MEMORY_DB_DIR, RECORDS_DIR_NAME);
					if (!existsSync(recordsDir)) mkdirSync(recordsDir, { recursive: true });
					const shardPath = join(recordsDir, `${localDate(new Date())}.jsonl`);
					const lines = records.map((r) => JSON.stringify(r));
					appendFileSync(shardPath, lines.join("\n") + "\n", "utf-8");
					written = lines.length;
				}

				// 2. 同步写入向量（如 embedding.json 可用）
				try {
					const embConfig = loadEmbeddingConfig(profilePath);
					if (embConfig && records.length > 0) {
						const { getEmbeddingService } = await import("../search/embedding/service.js");
						const { getVectorStore } = await import("../search/vector-store/store.js");
						const embService = await getEmbeddingService(profilePath);
						const vecStore = await getVectorStore(profilePath);

						// 非 deleted 记录：embed content + insert 向量
						const toEmbed = records.filter((r: any) => !r.deleted);
						if (toEmbed.length > 0) {
							const vectors = await embService.embedBatch(toEmbed.map((r: any) => r.content));
							const batch = toEmbed.map((r: any, i: number) => ({ recordId: r.id, vector: vectors[i] }));
							await vecStore.insertBatch(batch);
						}
						// deleted 记录（update/merge 时旧记录）：删除向量
						const deleted = records.filter((r: any) => r.deleted);
						if (deleted.length > 0) {
							await vecStore.deleteBatch(deleted.map((r: any) => r.id));
						}
					}
				} catch (e) {
					// 向量写入失败不阻塞 records 写盘（业务级降级）
					console.warn(`[l1_commit] vector store sync failed: ${e instanceof Error ? e.message : String(e)}`);
				}

				// 3. 回写游标
				saveCursor(profilePath, cursor);

				// 3. 通知 L2 调度（L1 成功提交一批 → 攒批计数）
				try {
					onCommitted?.(written);
				} catch {
					// 非致命
				}

				return {
					content: [{ type: "text", text: JSON.stringify({ success: true, written, cursor }) }],
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
