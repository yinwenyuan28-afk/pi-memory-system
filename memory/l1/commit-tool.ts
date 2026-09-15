import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_FILE, RECORDS_DIR_NAME } from "./config.ts";
import {
	createSceneResolver,
	findMostRecentScene,
	findSceneByNameOrAlias,
	readScenePool,
	writeScenePool,
	type SceneStats,
} from "./scene-pool.ts";
import { countNewRecords, loadL2Cursor } from "../l2/config.ts";
import { MEMORY_DB_DIR } from "../paths.ts";
import { getPipelineJobsDB } from "../pipeline/jobs-db.ts";
import { loadFailureState, saveFailureState } from "../failure-state.ts";
import { acquireWriteLock } from "./write-lock.ts";
import { loadEmbeddingConfig } from "../search/embedding/config.ts";
import { isVectorizationReady } from "../search/embedding/vectorization-config.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

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

/**
 * 用代码时间覆写记录的时间字段——时间字段归代码所有。
 *
 * 子代理自填的 `createdAt`/`updatedAt` 无代码来源、粒度参差（实测 277 行中 57% 毫秒恰为
 * `.000`，另有同批逐秒伪唯一、整批同值、个别缺失），故一律覆写：
 * - active 行：`createdAt` = `updatedAt` = 落盘时刻；
 * - `deleted: true` 标记行：只覆写 `updatedAt`，`createdAt` 保留原值（它表示「原记录创建于
 *   何时」，实测标记行确实沿用旧值），缺失或不可解析才取 `now`。
 *
 * `timestamps` 是源消息事件时刻（`l1-extractor.md` 约定），语义不同，**不在覆写范围**。
 */
export function stampRecordTimes(record: Record<string, unknown>, isDeleted: boolean, now: string): void {
	record.updatedAt = now;
	if (!isDeleted) {
		record.createdAt = now;
		return;
	}
	const created = record.createdAt;
	if (typeof created !== "string" || Number.isNaN(Date.parse(created))) record.createdAt = now;
}

/** 内容归一化哈希（去重用）：去空白、转小写、sha1。 */
function contentHash(content: string): string {
	const norm = content.replace(/\s+/g, " ").trim().toLowerCase();
	return createHash("sha1").update(norm, "utf-8").digest("hex");
}

/**
 * main-agent 路径的 `scene_name` 解析（2026-09-15 由锚点改为场景池）。
 *
 * 契约（主代理看不到池清单——`MEMORY_TOOL_REMINDER` 拼在系统提示里，须保持常量以命中
 * provider prefix cache，《架构说明》§5.3，故动态候选只能在写入时由服务端取）：
 *   - 主代理**显式给了** `scene_name`：按名字（canonical 或别名）在池中匹配——
 *     命中 → 用池的 canonical 名与 id；未命中 → **原样保留，且不登记进池**
 *     （主代理是自由文本、看不到池，若允许它登记会持续污染候选集；`origin` 也失去意义）。
 *   - **未给**：按 cwd 取池内最近条目 → 无则固定占位 `main-agent-live`（并标 `sceneNameFallback`）。
 */
const MAIN_AGENT_SCENE_FALLBACK = "main-agent-live";

/** 原子写 l1/cursor.json（tmp + rename）。 */
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
		description: renderPrompt("tools#l1_commit"),
		parameters: {
			type: "object",
			properties: {
				source: {
					type: "string",
					enum: ["subagent", "main-agent"],
					description:
						"'subagent' (default) = extractor path (advances cursor). " +
						"'main-agent' = proactive main-agent write; cursor optional, no cursor advance, no L2 enqueue.",
				},
				records: {
					type: "array",
					description: "L1 memory record objects: {id, content, type, priority, scene_name, source_message_ids, metadata, timestamps, createdAt, updatedAt, version, sessionKey, sessionId, deleted}. 注意 timestamps 与 createdAt 分工：timestamps = 源消息事件时刻（子代理填，用于追溯该记忆对应哪段对话）；createdAt/updatedAt = 记录落盘时刻（由 l1_commit 用代码时间覆写，子代理填的值会被忽略）；deleted:true 的标记行 createdAt 保留原记录的创建时刻。main-agent 模式下只需 {content, type}，其余缺省由服务端补齐。",
					items: { type: "object" },
				},
				cursor: {
					type: "string",
					description: "Advance L1 cursor to this lastRecordedAt ISO string. Required for source='subagent'; ignored for 'main-agent'.",
				},
			},
			required: ["records"],
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const profilePath = getProfilePath();
				if (!profilePath) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active profile" }) }], details: {} };
				}
				const source = params?.source === "main-agent" ? "main-agent" : "subagent";
				const isMainAgent = source === "main-agent";
				const records = params?.records;
				const cursor = typeof params?.cursor === "string" ? params.cursor : "";
				if (!Array.isArray(records)) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "records must be an array" }) }], details: {} };
				}
				// cursor 仅子代理路径需要（它是 L0 增量水位）；主代理不得推进。
				if (!isMainAgent && !cursor) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "cursor must be a non-empty string when source='subagent'" }) }], details: {} };
				}
				// main-agent：补齐缺省字段 + 必填校验。
				// id 必须服务端生成——格式不符会让 recordEpochMs 返回 0，该记录永久 ≤ L2 水位、永不可见。
				if (isMainAgent) {
					const nowIso = new Date().toISOString();
					let sessionKey = "";
					let sessionId: string | null = null;
					try {
						const sm = (ctx as { sessionManager?: { getSessionFile?: () => string; getSessionId?: () => string } } | undefined)?.sessionManager;
						const sf = sm?.getSessionFile?.();
						if (typeof sf === "string" && sf) {
							sessionKey = sf.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/, "") ?? "";
						}
						const sid = sm?.getSessionId?.();
						sessionId = typeof sid === "string" ? sid : null;
					} catch {
						// ctx 不可用时留空
					}
					const ctxCwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
					const cwd = typeof ctxCwd === "string" ? ctxCwd : "";
					for (let i = 0; i < records.length; i++) {
						const r = records[i] as Record<string, unknown>;
						if (typeof r.content !== "string" || !r.content.trim()) {
							return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `records[${i}].content is required (non-empty string)` }) }], details: {} };
						}
						if (typeof r.type !== "string" || !r.type.trim()) {
							return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `records[${i}].type is required (work_fact/work_task/work_method/work_artifact)` }) }], details: {} };
						}
						if (typeof r.id !== "string" || !/^l1_\d+_/.test(r.id)) {
							r.id = `l1_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
						}
						if (!Array.isArray(r.timestamps) || (r.timestamps as unknown[]).length === 0) r.timestamps = [nowIso];
						if (typeof r.priority !== "number") r.priority = 70;
						if (typeof r.version !== "number") r.version = 1;
						if (typeof r.deleted !== "boolean") r.deleted = false;
						if (typeof r.sessionKey !== "string" || !r.sessionKey) r.sessionKey = sessionKey;
						if (r.sessionId === undefined) r.sessionId = sessionId;
						if (typeof r.cwd !== "string") r.cwd = cwd;
						// scene_name / scene_id 统一在写锁内的「场景解析」段处理（2026-09-15），
						// 这里刻意不填——池是唯一真源，且解析必须在锁内做
						if (!Array.isArray(r.source_message_ids)) r.source_message_ids = [];
						const md = typeof r.metadata === "object" && r.metadata !== null ? (r.metadata as Record<string, unknown>) : {};
						r.metadata = { ...md, origin: "main-agent" };
					}
				}

				// B2（2026-09-11）：跨进程写锁——就地标记段是整分片 read-modify-write，
				// l1_commit（子代理进程）/ fix-tool（主进程 exec）/ 手动 l1-admin 可能并发改写同一分片。
				const writeLock = acquireWriteLock(profilePath);
				if (!writeLock) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "L1 库被其他写者占用（写锁超时 10s），请稍后重试" }) }], details: {} };
				}

				// ── 场景解析（2026-09-15）：**必须在写锁内**。池是场景归属的唯一真源，
				//    canonical 名字由池给出（覆写子代理自填值），新建条目当场登记。
				//    顺序：先解析内存态 →（下面第 1 步）记录落盘 →（第 2.5 步）写回池。
				const scenePool = readScenePool(profilePath);
				const sceneResolver = isMainAgent ? null : createSceneResolver(scenePool, new Date().toISOString());
				const sceneWarns: string[] = [];
				let sceneNameFallback = false;
				for (const r of records as Record<string, unknown>[]) {
					// `deleted:true` 标记行不参与池解析（不登记、不计数、不累积 cwds）
					if (r.deleted === true) continue;
					const recCwd = typeof r.cwd === "string" ? r.cwd : "";

					if (sceneResolver) {
						const res = sceneResolver.resolve({
							scene_id: r.scene_id,
							new_scene_name: r.new_scene_name,
							new_scene_reason: r.new_scene_reason,
							scene_name: r.scene_name,
							cwd: recCwd,
						});
						if (res.warn) sceneWarns.push(res.warn);
						r.scene_name = res.scene_name;
						if (res.scene_id) r.scene_id = res.scene_id;
						else delete r.scene_id;
						// 子代理填的中间字段不落盘
						delete r.new_scene_name;
						delete r.new_scene_reason;
						continue;
					}

					// main-agent 路径（契约见 main-agent-场景解析注释）
					const explicit = typeof r.scene_name === "string" ? r.scene_name.trim() : "";
					if (explicit) {
						const hit = findSceneByNameOrAlias(scenePool, explicit);
						if (hit) {
							r.scene_name = hit.name;
							r.scene_id = hit.id;
						} else {
							delete r.scene_id; // 未命中：原样保留名字，不登记进池
						}
						continue;
					}
					const near = findMostRecentScene(scenePool, recCwd);
					if (near) {
						r.scene_name = near.name;
						r.scene_id = near.id;
					} else {
						r.scene_name = MAIN_AGENT_SCENE_FALLBACK;
						delete r.scene_id;
						sceneNameFallback = true;
					}
				}

			// 0. 去重：扫描现有 records 建 id 集合 + 内容哈希集合（仅非 deleted）
			// 目的：重试 / 部分提交 / 子代理重新提取同一事实时，不产生重复 records。
			const recordsDir = join(profilePath, MEMORY_DB_DIR, RECORDS_DIR_NAME);
			const existingIds = new Set<string>();
			const existingHashes = new Set<string>();
			// B2（2026-09-11）：记录每个 id 追加序最后的活跃行位置（用于 deleted 行就地标记）
			const lastAliveById = new Map<string, { file: string; lineIdx: number }>();
			if (existsSync(recordsDir)) {
				for (const f of readdirSync(recordsDir).filter((f) => /\.jsonl$/.test(f))) {
					try {
						const text = readFileSync(join(recordsDir, f), "utf-8");
						const fileLines = text.split(/\r?\n/);
						for (let li = 0; li < fileLines.length; li++) {
							const t = fileLines[li].trim();
							if (!t) continue;
							try {
								const o = JSON.parse(t);
								if (typeof o?.id === "string") existingIds.add(o.id);
								if (!o?.deleted && typeof o?.content === "string") existingHashes.add(contentHash(String(o.content)));
								if (typeof o?.id === "string" && o.deleted !== true) lastAliveById.set(o.id, { file: f, lineIdx: li });
							} catch {
								// 跳过坏行
							}
						}
					} catch {
						// 跳过坏文件
					}
				}
			}

			// 1. 追加写 records 分片（按当前本地日期）；同 id 重投 / 内容重复 跳过。
			// B2（2026-09-11）：deleted 行不再追加墓碑——loader 为 LWW 语义（同 id 取最后一行），
			// 追加墓碑只会旧行仍在；改为就地标记旧活跃行（保留 content 溯源）。
			let written = 0;
			const toEmbed: any[] = [];
			const toDelete: any[] = [];
			const appendedLines: string[] = [];
			const markByFile = new Map<string, Set<number>>(); // 就地标记：file → 行索引集合
			const nowStamp = new Date().toISOString();
			for (const r of records) {
				const isDeleted = r.deleted === true;
				if (!isDeleted) {
					if (existingIds.has(r.id)) continue; // 同 id 重投（重试 / 部分提交）
					if (typeof r.content === "string" && existingHashes.has(contentHash(r.content))) continue; // 内容重复
				}
				const { embedding: _emb, ...clean } = r as any;
				if (isDeleted) {
					// 就地标记旧活跃行（不追加墓碑行）
					const target = lastAliveById.get(r.id);
					if (!target) continue; // 幂等：目标已死或不存在
					if (!markByFile.has(target.file)) markByFile.set(target.file, new Set());
					markByFile.get(target.file)!.add(target.lineIdx);
					toDelete.push(r); // 向量删除（按 id，deleteBatch）
					lastAliveById.delete(r.id); // 同批重复标记同一 id 只首次生效
				} else {
					stampRecordTimes(clean, false, nowStamp);
					appendedLines.push(JSON.stringify(clean));
					toEmbed.push(r);
					existingIds.add(r.id); // 防止同批内重复
					if (typeof r.content === "string") existingHashes.add(contentHash(r.content));
				}
			}
			if (appendedLines.length > 0) {
				if (!existsSync(recordsDir)) mkdirSync(recordsDir, { recursive: true });
				const shardPath = join(recordsDir, `${localDate(new Date())}.jsonl`);
				appendFileSync(shardPath, appendedLines.join("\n") + "\n", "utf-8");
				written = appendedLines.length;
			}

			// B2（2026-09-11）：就地标记段——对受影响历史分片整文件重写（原子 tmp+rename；已持跨进程锁）。
			// 顺序在后：等新行 append 完再重写历史分片（两者不冲突，但避免同日分片被两阶段写）。
			for (const [file, lineSet] of markByFile) {
				const fp = join(recordsDir, file);
				if (!existsSync(fp)) continue;
				const fileLines = readFileSync(fp, "utf-8").split(/\r?\n/);
				let changed = 0;
				const out = fileLines.map((l, i) => {
					const t = l.trim();
					if (!t || !lineSet.has(i)) return l;
					try {
						const o = JSON.parse(t);
						if (o.deleted === true) return l; // 幂等
						o.deleted = true;
						o.updatedAt = nowStamp;
						o.metadata = { ...(o.metadata || {}), l1Cleanup: { ...(o.metadata?.l1Cleanup || {}), action: "commit-deleted", tool: "l1_commit", appliedAt: nowStamp } };
						changed++;
						return JSON.stringify(o);
					} catch {
						return l;
					}
				});
				if (changed > 0) {
					writeFileSync(fp + ".tmp", out.join("\n"), "utf-8");
					renameSync(fp + ".tmp", fp);
				}
			}

			// 2. 同步写入向量（仅当 VECTORIZATION_ENABLED=true 且 embedding 配置可用）
			let vectorStats: { inserted: number; deleted: number } | null = null;
			try {
				const embConfig = loadEmbeddingConfig(profilePath);
				if (!embConfig) {
					// embedding 未配置，跳过向量写入
				} else if (!isVectorizationReady(profilePath)) {
					// VECTORIZATION_ENABLED=false 或未达阈值，跳过向量写入
				} else if (toEmbed.length > 0 || toDelete.length > 0) {
					const { getEmbeddingService } = await import("../search/embedding/service.ts");
					const { getVectorStore } = await import("../search/vector-store/store.ts");
					const embService = await getEmbeddingService(profilePath);
					const vecStore = await getVectorStore(profilePath);

					// 非 deleted 记录：优先复用子代理 dedup 已算好的向量（跨进程去重）
					if (toEmbed.length > 0) {
						const needEmbed = [];
						const batch = [];
						for (const r of toEmbed) {
							if (Array.isArray(r.embedding) && r.embedding.length === embService.getDimensions()) {
								batch.push({ recordId: r.id, vector: r.embedding });
							} else {
								needEmbed.push(r);
							}
						}
						if (needEmbed.length > 0) {
							const vectors = await embService.embedBatch(needEmbed.map((r) => r.content));
							for (let j=0;j<vectors.length;j++) batch.push({ recordId: needEmbed[j].id, vector: vectors[j] });
						}
						if (batch.length > 0) await vecStore.insertBatch(batch);
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

				// 2.5 场景池写回（2026-09-15）——**刻意放在所有记录落盘之后**：池写失败时记录
				//     仍带正确名字；池缺条目下批会重建同名条目（幂等）。池读写均在本锁内。
				let poolWriteFailed = false;
				if (sceneResolver?.isDirty()) {
					scenePool.updatedAt = new Date().toISOString();
					poolWriteFailed = !writeScenePool(profilePath, scenePool);
					if (poolWriteFailed) {
						console.warn("[l1_commit] 场景池写入失败（记录已落盘；池条目缺失将在下批重建）");
					}
				}
				const sceneStats: SceneStats | null = sceneResolver ? sceneResolver.stats() : null;

				// 3. 回写游标 —— 仅子代理路径。cursor 是 L0 增量水位，主代理推进会让
					//    l1-extractor 跳过对应 L0 消息（C1）。
				if (!isMainAgent) saveCursor(profilePath, cursor);

				// 4. 流水线 —— 仅子代理路径。main-agent 跳过两者（C2/C8）：
				//    completeRunningL1 是"子代理 job 完成"信号；入队 L2 会打开
				//    "提取器在途时 L2 越水位"的竞态窗口（C8）。
				//    C9（R1 阻断 B1）：入队条件不再只看本批 written——只要 L1 里存在游标之后的
				//    记录（含主代理写入的）就入队，否则主代理记录可能永不进 L2。
				try {
					if (!isMainAgent) {
						const jobs = getPipelineJobsDB(profilePath);
						const doneNow = jobs.completeRunningL1();
						// 2026-09-15：认领「超时误判」——子代理耗时可能远超 180s 超时，
						// 主进程标 failed 后子代理仍会提交。此处把该 failed 纠正为 done，
						// 并重置 L1 失败计数，否则计数只增不减、累计 3 次即熔断。
						const reclaimed = jobs.reclaimTimedOutL1();
						if (doneNow + reclaimed > 0) {
							try {
								const fs = loadFailureState(profilePath);
								if (fs.l1.consecutiveFailures > 0 || fs.l1.cooledDown) {
									fs.l1.consecutiveFailures = 0;
									fs.l1.cooledDown = false;
									saveFailureState(profilePath, fs);
									console.warn(
										`[l1_commit] 纠正超时误判：job done=${doneNow} reclaimed=${reclaimed}，L1 失败计数已重置`,
									);
								}
							} catch (e) {
								console.warn(`[l1_commit] 重置失败计数出错: ${e instanceof Error ? e.message : String(e)}`);
							}
						}
						if (countNewRecords(profilePath, loadL2Cursor(profilePath).lastProcessedAt) > 0) {
							jobs.enqueue("l2", "l1_commit");
						}
					}
				} catch (e) {
					console.warn(`[l1_commit] pipeline enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
				}

				// 5. 通知 L3 计数（L2 不再走此回调）
				try {
					onCommitted?.(written);
				} catch {
					// 非致命
				}

				// 6. TUI 通知（向量化状态）
				const vInfo = vectorStats
					? `，向量化写入 +${vectorStats.inserted}/-${vectorStats.deleted} 条`
					: "";
				ctx.ui.notify(`L1 commit: ${written} 条记录已提交${vInfo}`, "info");

				writeLock.release();


				return {
					content: [{ type: "text", text: JSON.stringify({ success: true, written, cursor, vectorStats, markedInPlace: markByFile.size, sceneStats, sceneWarns, poolWriteFailed, sceneNameFallback }) }],
					details: {},
				};
			} catch (err) {
				writeLock?.release();
				return {
					content: [{ type: "text", text: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }) }],
					details: {},
				};
			}
		},
	});
}
