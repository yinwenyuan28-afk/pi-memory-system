import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_FILE, RECORDS_DIR_NAME } from "./config.js";
import { MEMORY_DB_DIR } from "../paths.js";
import { loadEmbeddingConfig } from "../search/embedding/config.js";
import { isVectorizationReady } from "../search/embedding/vectorization-config.js";

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

/** 内容归一化哈希（去重用）：去空白、转小写、sha1。 */
function contentHash(content: string): string {
	const norm = content.replace(/\s+/g, " ").trim().toLowerCase();
	return createHash("sha1").update(norm, "utf-8").digest("hex");
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

			// 0. 去重：扫描现有 records 建 id 集合 + 内容哈希集合（仅非 deleted）
			// 目的：重试 / 部分提交 / 子代理重新提取同一事实时，不产生重复 records。
			const recordsDir = join(profilePath, MEMORY_DB_DIR, RECORDS_DIR_NAME);
			const existingIds = new Set<string>();
			const existingHashes = new Set<string>();
			if (existsSync(recordsDir)) {
				for (const f of readdirSync(recordsDir).filter((f) => /\.jsonl$/.test(f))) {
					try {
						const text = readFileSync(join(recordsDir, f), "utf-8");
						for (const line of text.split(/\r?\n/)) {
							const t = line.trim();
							if (!t) continue;
							try {
								const o = JSON.parse(t);
								if (typeof o?.id === "string") existingIds.add(o.id);
								if (!o?.deleted && typeof o?.content === "string") existingHashes.add(contentHash(String(o.content)));
							} catch {
								// 跳过坏行
							}
						}
					} catch {
						// 跳过坏文件
					}
				}
			}

			// 1. 追加写 records 分片（按当前本地日期）；同 id 重投 / 内容重复 跳过
			let written = 0;
			const toEmbed: any[] = [];
			const toDelete: any[] = [];
			const appendedLines: string[] = [];
			for (const r of records) {
				const isDeleted = r.deleted === true;
				if (!isDeleted) {
					if (existingIds.has(r.id)) continue; // 同 id 重投（重试 / 部分提交）
					if (typeof r.content === "string" && existingHashes.has(contentHash(r.content))) continue; // 内容重复
				}
				appendedLines.push(JSON.stringify(r));
				if (isDeleted) toDelete.push(r);
				else toEmbed.push(r);
				existingIds.add(r.id); // 防止同批内重复
				if (!isDeleted && typeof r.content === "string") existingHashes.add(contentHash(r.content));
			}
			if (appendedLines.length > 0) {
				if (!existsSync(recordsDir)) mkdirSync(recordsDir, { recursive: true });
				const shardPath = join(recordsDir, `${localDate(new Date())}.jsonl`);
				appendFileSync(shardPath, appendedLines.join("\n") + "\n", "utf-8");
				written = appendedLines.length;
			}

			// 2. 同步写入向量（仅当 VECTORIZATION_ENABLED=true 且 embedding.json 可用）
			let vectorStats: { inserted: number; deleted: number } | null = null;
			try {
				const embConfig = loadEmbeddingConfig(profilePath);
				if (!embConfig) {
					// embedding.json 未配置，跳过向量写入
				} else if (!isVectorizationReady(profilePath)) {
					// VECTORIZATION_ENABLED=false 或未达阈值，跳过向量写入
				} else if (toEmbed.length > 0 || toDelete.length > 0) {
					const { getEmbeddingService } = await import("../search/embedding/service.js");
					const { getVectorStore } = await import("../search/vector-store/store.js");
					const embService = await getEmbeddingService(profilePath);
					const vecStore = await getVectorStore(profilePath);

					// 非 deleted 记录：embed content + insert 向量
					if (toEmbed.length > 0) {
						const vectors = await embService.embedBatch(toEmbed.map((r: any) => r.content));
						const batch = toEmbed.map((r: any, i: number) => ({ recordId: r.id, vector: vectors[i] }));
						await vecStore.insertBatch(batch);
					}
					// deleted 记录（update/merge 时旧记录）：删除向量
					if (toDelete.length > 0) {
						await vecStore.deleteBatch(toDelete.map((r: any) => r.id));
					}
					vectorStats = {
						inserted: toEmbed.length,
						deleted: toDelete.length,
					};
				}
			} catch (e) {
				// 向量写入失败不阻塞 records 写盘（业务级降级）
				const msg = e instanceof Error ? e.message : String(e);
				console.warn(`[l1_commit] 向量化写入失败: ${msg}`);
				ctx.ui.notify(`L1 commit 成功，但向量化写入失败: ${msg}`, "error");
			}

				// 3. 回写游标
				saveCursor(profilePath, cursor);

				// 4. 通知 L2 调度（L1 成功提交一批 → 攒批计数）
				try {
					onCommitted?.(written);
				} catch {
					// 非致命
				}

				// 5. TUI 通知（向量化状态）
				const vInfo = vectorStats
					? `，向量化写入 +${vectorStats.inserted}/-${vectorStats.deleted} 条`
					: "";
				ctx.ui.notify(`L1 commit: ${written} 条记录已提交${vInfo}`, "info");

				return {
					content: [{ type: "text", text: JSON.stringify({ success: true, written, cursor, vectorStats }) }],
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
