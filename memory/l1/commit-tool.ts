import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_FILE, PROMPT_DIR, RECORDS_DIR_NAME, loadL1Config } from "./config.ts";
import { applyVerdictsToBatch, loadChecklistFromFile, runValueCheck, splitBatch } from "./value-check.ts";
// 标签契约模块（零 import 的纯函数）：只取归一化与归属决策两件事，
// `SCOPE_HELP` 那一大段中文词表不进本模块——它由提示词侧（backfill 脚本 / l1-extractor.md）自己引用。
import { normalizeScope, projectForScope } from "./project-scope.ts";
import { loadRecallConfig } from "../search/recall-config.ts";
import { L1_RECORD_TYPES_TEXT, isL1RecordType } from "./record-types.ts";
import {
	createSceneResolver,
	findSceneByNameOrAlias,
	readScenePool,
	resolveMergedTarget,
	writeScenePool,
	type SceneStats,
} from "./scene-pool.ts";
import { countNewRecords, loadL2Cursor } from "../l2/config.ts";
import { MEMORY_DB_DIR, L1_VALUE_CHECK_LOG } from "../paths.ts";
import { logEvent, noticeCard } from "../../util/notice.ts";
import { readJudgFile } from "../../util/judg-session-project/index.ts";
import { getPipelineJobsDB } from "../pipeline/jobs-db.ts";
import { isStopRequested, stopRequestedMessage } from "../pipeline/stop-request.ts";
import { acquireRunLock, runLockBusyMessage } from "../pipeline/run-lock.ts";
import { loadFailureState, saveFailureState } from "../failure-state.ts";
import { acquireWriteLock } from "./write-lock.ts";
import { loadEmbeddingConfig } from "../search/embedding/config.ts";
import { isVectorizationReady } from "../search/embedding/vectorization-config.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";
// 静态导入（不得改回执行期 await import()）：jiti(moduleCache:false) 下并发首次调用会拿到
// 「求值未完成」的命名空间 → getter 读到未初始化的模块级绑定（2026-09-19 实测复现）
import { getEmbeddingService } from "../search/embedding/service.ts";
import { getVectorStore } from "../search/vector-store/store.ts";

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
 * main-agent 路径匹配不到场景时的占位名（2026-09-15 L1_PROJECT_SIGNAL 收紧了语义）。
 *
 * 契约（主代理的**系统提示里没有**池清单——`MEMORY_TOOL_REMINDER` 须保持常量以命中 provider
 * prefix cache；但主代理可以**按需**调只读工具 `list_l1_scenes`，那条路不碰系统提示）：
 *   - 给了 `scene_id` → 池内存在且未被合并则用它（canonical 名 + id）；
 *   - 给了 `scene_name` → 按名字/别名在池中匹配，命中用 canonical，未命中**原样保留且不登记进池**
 *     （主代理看不到清单时容易起自由文本，不该污染候选集）；
 *   - 都没给 → 落本占位 + `metadata.sceneFallback=true` + 返回体 `sceneHint` 提示先查清单。
 *
 * **刻意不再"猜"**：旧实现取「同 cwd 最近条目」（→ 全局最近 → 本占位），而 cwd 是会话工作台而不是
 * 项目（实测 34 条线程挤在一个 cwd），猜错会把记录贴进不相干的场景、污染 L2 分组。
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
			// 写锁句柄**必须声明在 try 之外**：catch 里要 `writeLock?.release()` 释放，
			// 而 `let` 在 try 块内声明时对同级的 catch 块不可见（2026-09-20 tsc TS2304 证实：
			// 旧写法在写盘异常路径会抛 “writeLock is not defined”，把真正的错误盖掉）。
			// 用 `| undefined` 标注：声明处未赋值，catch 里的 `writeLock?.release()` 靠可选链短路。
			let writeLock: ReturnType<typeof acquireWriteLock> | undefined;
			try {
				const profilePath = getProfilePath();
				if (!profilePath) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active profile" }) }], details: {} };
				}
				// 停止请求（2026-09-26）：硬上限要停掉 L1 子代理时，主进程先落标记，这里在**入口**拒写，
				// 把"被杀点"推到操作边界（而不是一次多步写入的中间）。
				// **不拦 main-agent**：标记针对的是那个卡住的子代理；主代理的记录来自用户，不该被连带拒掉。
				if (params?.source !== "main-agent" && isStopRequested(profilePath, "l1")) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: stopRequestedMessage("l1") }) }], details: {} };
				}
				// 运行级锁（2026-09-26）：谁写谁持锁 —— 防"监督者误判提前放锁"导致的两个同层写者。
				// 存在的理由不是文件写冲突（那由提交级写锁串行化），而是**读-改-写的交错**：
				// 两个子代理各自基于旧快照提交，后提交的那个会覆盖前者的改动。
				// **不拦 main-agent**：用户触发的记录不该被后台子代理的锁挡住（同停止标记的取舍）。
				if (params?.source !== "main-agent") {
					const runLock = acquireRunLock(profilePath, "l1");
					if (!runLock.acquired) {
						return {
							content: [
								{ type: "text", text: JSON.stringify({ success: false, error: runLockBusyMessage("l1", runLock.owner) }) },
							],
							details: {},
						};
					}
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
							return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `records[${i}].type is required (${L1_RECORD_TYPES_TEXT})` }) }], details: {} };
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

				// ── 项目标签 `metadata.project`（2026-09-30，取代 9-30 早先那版 `cwd` 覆写）──
				// 语义：**cwd 保持"会话工作台（pi 从哪启动）"，项目另开一个标签**。
				//   - `metadata.project` = 判定出的项目目录；判定不可用时写 `""`（= 没有项目，不猜）
				//   - `metadata.projectSource` = 判定来源（init/code/llm/manual），或 `"fallback"`
				//   - `metadata.scope` 为 `global` / `unknown` ⇒ project 被**强制抹成 `""`**
				//     （两档都走契约模块 `projectForScope`，写侧不自己判分支）
				//
				// 位置要求（三条都必要，与上一版相同）：
				//   ① 在 `isMainAgent` 块**之外** —— main-agent 与 subagent 两条路径都要经过；
				//   ② 在确定性闸门（下一个区块）**之前** —— 形式不合格的批不该浪费一次查表；
				//   ③ 在写锁内的场景解析**之前** —— 场景池登记的是 cwd，与本标签无关，但保持
				//      "写盘前先把 metadata 定型"的顺序，便于将来在池侧复用 project。
				//
				// 键取 `r.sessionKey`（记录自带），**不从 ctx 派生**：子代理进程里
				// `ctx.sessionManager.getSessionFile()` 恒为 `"session"`，派生必然查不到。
				// 空 sessionKey（实测 8/554 条）走 fallback 分支。
				//
				// ⚠ **为什么不再覆写 `r.cwd`（2026-09-30 撤回上一版自己的改动）**：
				//   上一版把判定出的 project 写进 `r.cwd`，但 `cwd` 在读侧有**另一套既定语义**——
				//   `scene-pool.ts` 的 `addCwd(entry, cwd)` 会把它塞进 `entry.cwds`，而排序侧
				//   `rankCwd` / `findMostRecentScene` 是拿 `entry.cwds` 去比 `batchCwd`
				//   （= L0 消息 cwd 的众数 = **会话工作台**）。写侧塞项目、读侧比工作台，
				//   两边对不上 ⇒「同 cwd 优先」对所有新记录**永不命中**，反而把池的 cwds 污染成混合语义。
				//   项目归属既然已有 `metadata.project` 这条正路，`cwd` 就没有必要承担它。
				//   ⇒ 现在这里**只对空值兜底**（见下），其余一律不动。
				//
				// 墓碑行（deleted:true）**不改**：`metadata` / `cwd` 都不碰 —— 它是"旧记录被改写/删除"
				// 的标记，不是新记忆，改它的归属等于用新语义篡改历史行
				// （与 l1-fix / rewrite.mjs 逐字继承旧字段是同一条原则，见 B15）。
				//
				// 为什么不写在 `recordsToWrite` 上（计划原写法）：那个变量声明在下面的
				// `:310`，而这里在它之前 —— 引用它是 use-before-declaration。
				// 就地改 `records` 的元素是安全的，已核对下游：
				// `splitBatch` 用 filter（保引用）、`applyVerdicts` 对 keep/drop **推同一引用**、
				// 对 retype 走 `{...rec}` 浅拷贝且 `metadata` 是 `{...旧, valueCheck}` ⇒ 覆写全部存活。
				{
					let judgedFile: ReturnType<typeof readJudgFile> | null = null;
					const ctxCwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
					const fallbackCwd = typeof ctxCwd === "string" ? ctxCwd : "";
					for (const row of records) {
						const r = row as Record<string, unknown>;
						if (r.deleted === true) continue;
						// cwd 兜底：**只在缺字段或空串时**填会话工作台，不覆盖模型传上来的值。
						// 理由：`cwd` 是场景池登记与「同 cwd 优先」排序的输入，留空会让新条目
						// 少登记一个工作台；而覆写又会踩上面那条读写语义错配。两者之间，
						// "缺了才补"是唯一同时满足两个约束的写法。
						if (typeof r.cwd !== "string" || !r.cwd) r.cwd = fallbackCwd;
						const rk = typeof r.sessionKey === "string" ? r.sessionKey : "";
						let project = "";
						let source = "fallback";
						if (rk && profilePath) {
							if (!judgedFile) judgedFile = readJudgFile(profilePath);
							if (judgedFile.ok) {
								const e = judgedFile.file.sessions[rk];
								if (e && e.flag) {
									project = e.project;
									source = e.decidedBy;
								}
							}
						}
						const md = typeof r.metadata === "object" && r.metadata !== null ? (r.metadata as Record<string, unknown>) : {};
						// scope 归一失败（**没填** / 填了非法值，如存量脏值 `workflow` / `subtree`）时
						// 按 **`unknown`** 处理 ⇒ project 被抹成 `""`。
						//
						// ⚠ **为什么缺省是 `unknown` 而不是 `self`**（2026-09-30 用户裁定）：
						//   `unknown` 这一档存在的**全部意义**就是显式表达「判不了」。缺省成 `self` 等于
						//   替模型做了它没做的判断：没填 scope = **没有表达任何范围信息**，而"没表达"绝
						//   不等于"确定属于当前会话那个项目"。默认 `self` 会让所有忘了填 scope 的记录被
						//   **静默**归到会话判定出的那个项目名下 —— 这正是 `unknown` 要消除的那种不可见：
						//   数据里看不出"这条其实没判过"，召回侧也无从把它与真正的项目记忆区分开。
						//   记 `unknown` 至少让它可计数、可被消费者识别（"不过滤，但标出来"）。
						//   注意：`projectForScope` 会把 `unknown` 与 `global` 一视同仁地抹空 project ——
						//   两者召回行为不同（`global` 无条件注入、`unknown` 只是不作过滤依据），
						//   但都不该挂到一个模型没确认过的路径上。
						//
						// ⚠ **归一后的 scope 必须写回 metadata**（2026-10-01 修正，存量/新写入对齐体检发现）：
						//   原实现「**只判不写**」，理由是"不代模型改写，免得把『判据没写』与『服务端改过』混成
						//   一个结果"。**这个理由不成立** —— 「缺省」这件事本来就可以在 `projectSource`
						//   上留痕（它已经记了来源），而**不写回**的直接后果是：没填 scope 的记录落盘后
						//   **该字段完全消失**，而不是变成 `unknown`。那等于把刚立起来的弃权档在写入
						//   路径上又废掉了——「判不了」重新变得不可见，`unknown` 成了只在存量回填里
						//   存在的死值，与存量的取值空间也对不齐。
						//   合法值原样写入（模型填对了不该被改），归一不了的**按 `unknown` 写入**
						//   （含大小写/空白差异，`" SELF "` ⇒ `self`）：既保证闭集，也不再有脏值落盘。
						const scope = normalizeScope(md.scope);
						// metadata 用展开合并：`work_object` / `status` / `activity_start_time` /
						// `sceneFallback` / `origin` / `valueCheck` 等既有键全部保留，
						// 只覆盖 scope 并新增 project 两键。
						r.metadata = {
							...md,
							scope: scope ?? "unknown",
							project: projectForScope(scope ?? "unknown", project),
							projectSource: source,
						};
					}
				}

				// ── 确定性闸门（2026-09-17）────────────────────────────────
				// 分工：**形式/格式问题一律在这里用代码拦**，不花 LLM 调用；价值问题
				// （流水账 / 表象 vs 方法论）才交给下一段的一次 agent loop。
				//
				// 硬闸（拒绝整批，因为都是"真错"，且改起来是确定动作）：
				//   · 非 deleted 记录 content 必须非空
				//   · type 必须在枚举内（旧代码只判"是非空字符串"，报错文案却写着枚举 —— 于是
				//     历史上有 type:"architecture" 这种越界值落库）
				//   · priority 若给就必须在 0..100
				// 软闸（不拒绝，只在返回体暴露 + 留痕，避免把写盘路径变脆）：
				//   · 子代理记录缺 source_message_ids（旧代码静默塞空数组，违反被无声吞掉）
				//   · content 超过召回预算（会被 recall 的 maxCharsPerRecord 截断成半句）
				const provenanceMissingList: string[] = [];
				const overBudget: number[] = [];
				let priorityMissing = 0;
				// 写锁句柄在 execute 作用域声明（见函数开头）：catch 里的 `writeLock?.release()` 才看得到
				{
					const recallBudget = loadRecallConfig(profilePath).maxCharsPerRecord;
					for (let i = 0; i < records.length; i++) {
						const r = records[i] as Record<string, unknown>;
						if (r.deleted === true) continue; // 标记行沿用原记录字段，不参与形态校验
						if (typeof r.content !== "string" || !r.content.trim()) {
							return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `records[${i}].content 必须是非空字符串` }) }], details: {} };
						}
						const t = typeof r.type === "string" ? r.type.trim() : "";
						if (!isL1RecordType(t)) {
							return {
								content: [{ type: "text", text: JSON.stringify({ success: false, error: `records[${i}].type 越出枚举：${JSON.stringify(r.type)}（只能是 ${L1_RECORD_TYPES_TEXT}）` }) }],
								details: {},
							};
						}
						r.type = t;
						// 子代理路径原先**不补**默认 priority（只有 main-agent 路径补），漏填就落成 undefined、
						// 让 quality.ts 的优先级权重失效。这里统一补 70 并计数（软闸，不改写盘行为）。
						if (r.priority === undefined) {
							r.priority = 70;
							priorityMissing++;
						}
						if (typeof r.priority !== "number" || r.priority < 0 || r.priority > 100) {
							return {
								content: [{ type: "text", text: JSON.stringify({ success: false, error: `records[${i}].priority 越界：${JSON.stringify(r.priority)}（必须是 0..100 的数字，或省略由服务端补 70）` }) }],
								details: {},
							};
						}
					}
					for (const r of records as Record<string, unknown>[]) {
						if (r.deleted === true) continue;
						if (!isMainAgent && (!Array.isArray(r.source_message_ids) || r.source_message_ids.length === 0)) {
							provenanceMissingList.push(String(r.id ?? ""));
							// 软闸：补上空数组（保持旧行为，不因缺来源就拒收整批），但**留下计数**
							r.source_message_ids = [];
						}
						if (typeof r.content === "string" && recallBudget > 0 && r.content.length > recallBudget) overBudget.push(r.content.length);
					}
				}

				// ── 价值校验（2026-09-17）：一次 agent loop，只判"值不值得留" ──────
				// 位置很关键：必须在 acquireWriteLock **之前** —— 那个锁只有 10s 超时且跨进程，
				// 抱着锁跑一次 LLM 会让并发的 l1-admin / fix-tool 直接失败。
				// 只对子代理路径生效：主代理 path 是同步工具调用，不能让它等一次 LLM。
				const l1CfgForCheck = loadL1Config(profilePath);
				let valueCheckReport: Record<string, unknown> | undefined;
				let recordsToWrite = records as Record<string, unknown>[];
				// 整段套 try：这一层是**附加**判断，任何失败（模型不可用 / 动态 import 失败 / 判据摘不出）
				// 都必须 fail-open（照写 + 留痕），绝不能把 L1 写盘拖垮 —— 它是 L2/L3 的唯一饲料。
				try {
				if (!isMainAgent && l1CfgForCheck.valueCheck.enabled && recordsToWrite.some((r) => r.deleted !== true)) {
					const cfgVC = l1CfgForCheck.valueCheck;
					// 候选集与回填必须是**同一个数组**（2026-09-21 修）：applyVerdicts 是按【数组下标】回填裁决的，
					// 而候选集把 deleted:true 墓碑行过滤掉了 —— 若把裁决回填到未过滤的 recordsToWrite，
					// 批内一旦混入墓碑行，其后所有裁决都会整体错位（drop/retype 落到别的记录上）。
					// 历史实测错位 7 次，见 plan/memory-system/L1价值校验索引错位与孤儿墓碑-PLAN.md。
					const { candidates: candidatesRecords } = splitBatch(recordsToWrite);
					const candidates = candidatesRecords
						.map((r) => ({ content: String(r.content ?? ""), type: String(r.type ?? ""), priority: typeof r.priority === "number" ? r.priority : undefined }));
					// 判据与提取规则同源：直接摘同一份 md（摘不出 → fail-open）
					const checklist = loadChecklistFromFile(join(PROMPT_DIR, `extract-${l1CfgForCheck.mode}-personal.md`));
					if (!checklist) {
						// fail-open 属于“闸门静默失效”：用户应该知道这次没有过滤（但不必每次都知道 → dedup）
						const skipMsg = `价值校验跳过：判据摘取失败（extract-${l1CfgForCheck.mode}-personal.md 的标记段落是否还在？）`;
						logEvent("l1", skipMsg, profilePath);
						noticeCard({
							level: "warning",
							title: "L1 价值校验未生效（fail-open，照写）",
							lines: [skipMsg],
							detail: "影响：本批记录未经过“值不值得留”的过滤。判据文件与提取规则同源，修好 md 后自动恢复。",
							dedupKey: "l1-value-check-failopen",
						});
						valueCheckReport = { skipped: "判据摘取失败" };
					} else {
						// 惰性导入：model-config 静态拉 `@earendil-works/pi-ai/compat`，那是 CJS 下
						// 没有 require 条件的包（AGENTS.md「环境」），静态导入会牵连所有间接引用本模块的脚本
						const { resolveConfiguredModel } = await import("../../config/model-config.ts");
						const outcome = await runValueCheck({
							model: resolveConfiguredModel(
								profilePath,
								(ctx as { model?: unknown } | undefined)?.model,
								// 必须把宿主 registry 传进去：models.json 里的自定义 provider（command / opencode-go）
								// 只能靠它解析（pi-ai 内置目录里没有），否则会静默回退到会话模型
								(ctx as { modelRegistry?: unknown } | undefined)?.modelRegistry,
							),
							checklist,
							candidates,
							ctx,
							getApiKey: (p) => (ctx as { modelRegistry?: { getApiKeyForProvider?: (x: string) => string | undefined } } | undefined)?.modelRegistry?.getApiKeyForProvider?.(p),
							maxTurns: cfgVC.maxTurns,
							timeoutMs: cfgVC.timeoutMs,
							maxRecordChars: cfgVC.maxRecordChars,
							sessionId: typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined,
							onError: (err) => {
								const vcErr = err instanceof Error ? err.message : String(err);
								logEvent("l1", `价值校验失败（fail-open，照写）: ${vcErr}`, profilePath);
								noticeCard({
									level: "warning",
									title: "L1 价值校验调用失败（fail-open，照写）",
									lines: [vcErr.slice(0, 120)],
									dedupKey: "l1-value-check-failopen",
								});
							},
						});
						// 收口点：裁决只作用于候选人，墓碑行原样拼回，且「替代行被 drop ⇒ 撤销其墓碑」
						// （实现与回归用例都在 value-check.ts 的 applyVerdictsToBatch）。
						const applied = applyVerdictsToBatch(recordsToWrite, outcome.verdicts);
						recordsToWrite = applied.kept;
						const revokedRows = applied.revokedTombstones;
						const tombstonesRevoked = revokedRows.length;
						valueCheckReport = {
							...(outcome.skipped ? { skipped: outcome.skipped } : {}),
							dropped: applied.dropped.length,
							retyped: applied.retyped.length,
							...(tombstonesRevoked > 0 ? { tombstonesRevoked } : {}),
							...(!outcome.verdicts && outcome.raw ? { rawHint: outcome.raw } : {}),
						};
						// 被丢弃的记录**不在库里**，必须落到侧车日志，否则"它拦了什么/有没有误杀"完全不可见
						if (applied.dropped.length > 0) {
							try {
								const logPath = join(profilePath, MEMORY_DB_DIR, L1_VALUE_CHECK_LOG);
								const at = new Date().toISOString();
								appendFileSync(
									logPath,
									[
										...applied.dropped.map((d) =>
											JSON.stringify({
												at,
												action: "drop",
												reason: d.reason,
												// 金丝雀：drop 的对象永远应当来自候选集（deleted!==true）。
												// 出现 false 即说明「候选集 ≠ 回填数组」的错位又回来了（2026-09-21 修复前实测 7 次）。
												inCandidates: (d.record as { deleted?: unknown })?.deleted !== true,
												record: d.record,
											}),
										),
										...revokedRows.map((row) =>
											JSON.stringify({ at, action: "revoke-tombstone", reason: "替代行未通过价值校验，墓碑一并撤销", id: row.id, replacedBy: row.replacedBy }),
										),
									].join("\n") + "\n",
									"utf-8",
								);
							} catch {
								// 留痕失败不阻塞写盘
							}
						}
					}
				}
				} catch (err) {
					// 价值校验层的任何异常都在这里止步：照写 + 留痕
					const msg = err instanceof Error ? err.message : String(err);
					logEvent("l1", `价值校验异常（fail-open，照写）: ${msg}`, profilePath);
					noticeCard({
						level: "warning",
						title: "L1 价值校验异常（fail-open，照写）",
						lines: [msg.slice(0, 120)],
						dedupKey: "l1-value-check-failopen",
					});
					valueCheckReport = { skipped: `校验层异常：${msg}` };
				}

				// B2（2026-09-11）：跨进程写锁——就地标记段是整分片 read-modify-write，
				// l1_commit（子代理进程）/ fix-tool（主进程 exec）/ 手动 l1-admin 可能并发改写同一分片。
				// 位置刻意在确定性闸门与价值校验**之后**：那个锁只有 10s 超时，
				// 抱着锁跑一次 LLM 会让并发的其他写者直接失败。
				writeLock = acquireWriteLock(profilePath);
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
				let mainAgentUnclassified = 0;
				for (const r of recordsToWrite) {
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
						// 未归类落进 metadata（与 main-agent 路径同口径），供度量"未归类率"
						if (res.kind === "fallback") {
							r.metadata = { ...((r.metadata as Record<string, unknown> | undefined) ?? {}), sceneFallback: true };
						}
						// 子代理填的中间字段不落盘
						delete r.new_scene_name;
						delete r.new_scene_reason;
						continue;
					}

					// main-agent 路径：`scene_id`（先查清单得到）→ 显式 `scene_name`（名字/别名匹配）→ 未归类。
					// **刻意不猜**（2026-09-15 L1_PROJECT_SIGNAL）：cwd 是会话工作台而不是项目
					// （实测 memory-system 的记录 cwd 全是 pi fork 目录、34 条线程挤在一个 cwd），
					// 旧实现「取同 cwd 最近条目」会把记录贴到不相干的场景上；贴错会污染 L2 分组，
					// 而未归类只产生一个明确的占位场景。主代理可用只读工具 `list_l1_scenes` 先拿到清单。
					const rawSceneId = typeof r.scene_id === "string" ? r.scene_id.trim() : "";
					if (rawSceneId) {
						const direct = scenePool.scenes.find((e) => e.id === rawSceneId);
						const target = direct ? (direct.mergedInto ? resolveMergedTarget(scenePool, rawSceneId) : direct) : null;
						if (target) {
							r.scene_name = target.name;
							r.scene_id = target.id;
							continue;
						}
					}
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
					r.scene_name = MAIN_AGENT_SCENE_FALLBACK;
					delete r.scene_id;
					sceneNameFallback = true;
					mainAgentUnclassified++;
					r.metadata = { ...(r.metadata as Record<string, unknown> | undefined ?? {}), sceneFallback: true };
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
			// 用校验后的集合（价值校验可能已剔除/改型若干条）
			for (const r of recordsToWrite) {
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
					// 两个单例由文件头部静态导入（见那里的注释）；此处保持静态引用，避免半成品命名空间竞态
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
				logEvent("l1", `向量化写入失败: ${msg}`, profilePath);
				// 卡片走 relay：主代理写入时直接 appendEntry；子代理进程则落 notices.jsonl 等主进程 drain
				noticeCard({
					level: "error",
					title: "L1 记录已落盘，但向量化写入失败",
					lines: [msg.slice(0, 120), "影响：这批记忆召回不到（向量库缺条目），需 /my-memory:l1:embedding:backfill 补"],
				});
			}

				// 2.5 场景池写回（2026-09-15）——**刻意放在所有记录落盘之后**：池写失败时记录
				//     仍带正确名字；池缺条目下批会重建同名条目（幂等）。池读写均在本锁内。
				let poolWriteFailed = false;
				if (sceneResolver?.isDirty()) {
					scenePool.updatedAt = new Date().toISOString();
					poolWriteFailed = !writeScenePool(profilePath, scenePool);
					if (poolWriteFailed) {
						logEvent("l1", "场景池写入失败（记录已落盘；池条目缺失将在下批重建）", profilePath);
						noticeCard({
							level: "warning",
							title: "场景池写入失败",
							lines: [
								"记录已落盘且带正确场景名；池条目缺失将在下批重建（幂等）",
								"影响：本批新场景不会立刻出现在 select-l1-scenes 清单里，可能多计未归类",
							],
						});
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
									logEvent(
										"l1",
										`纠正超时误判：job done=${doneNow} reclaimed=${reclaimed}，L1 失败计数已重置`,
										profilePath,
									);
								}
							} catch (e) {
								logEvent("l1", `重置失败计数出错: ${e instanceof Error ? e.message : String(e)}`, profilePath);
							}
						}
						// L2 入队**不在这里**（2026-09-19 移出）：一次 L1 运行可能提交多批，
						// 每批都入队会让 L2 在 L1 还没啃完积压时就开跑，且"多 1 条也起一个完整 L2"。
						// 现在由主进程 worker 在 L1 job 收尾后统一编排：还有 L0 积压 → 继续排 L1；
						// 积压清空且有新记录 → 排一个 L2（见 pipeline/worker.ts 的下一步编排）。
					}
				} catch (e) {
					logEvent("l1", `pipeline 完成信号/编排失败: ${e instanceof Error ? e.message : String(e)}`, profilePath);
				}

				// 5. 通知 L3 计数（L2 不再走此回调）
				try {
					onCommitted?.(written);
				} catch {
					// 非致命
				}

				// 6. 通知（向量化状态）
				// 主代理主动记录 → notify 一行（用户关心的动作）；子代理批次 → 只落文件
				//（2026-09-19 决策：后台每批都弹通知会吵；且子代理进程里 ui.notify 本就是 no-op）。
				const vInfo = vectorStats
					? `，向量化写入 +${vectorStats.inserted}/-${vectorStats.deleted} 条`
					: "";
				if (isMainAgent) {
					ctx.ui.notify(`L1 commit: ${written} 条记录已提交${vInfo}`, "info");
				} else {
					logEvent("l1", `提交 ${written} 条记录${vInfo}`, profilePath);
				}

				writeLock.release();


				return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									success: true,
									written,
									cursor,
									vectorStats,
									// 口径：被**改写的分片文件数**（Map 的 key 是文件名），不是墓碑条数——
									// 3 条墓碑全在同一分片时这里就是 1（2026-09-20 子代理据此误判“计数与落盘不一致”）。
									markedInPlace: markByFile.size,
									sceneStats,
									sceneWarns,
									poolWriteFailed,
									sceneNameFallback,
									// 价值校验结果（2026-09-17）：dropped 的条目不写库，所以这里必须回报，
									// 否则子代理无从知道"我提交的 N 条里有几条没进库"。
									...(valueCheckReport ? { valueCheck: valueCheckReport } : {}),
									// 软闸观测（硬闸已在前面直接拒绝）：本来只该是 0；非 0 即说明规则没被遵守
									...(provenanceMissingList.length > 0 ? { provenanceMissing: provenanceMissingList.length } : {}),
									...(priorityMissing > 0 ? { priorityDefaulted: priorityMissing } : {}),
									...(overBudget.length > 0 ? { overRecallBudget: overBudget.length, overBudgetMax: Math.max(...overBudget) } : {}),
									...(mainAgentUnclassified > 0 ? { sceneHint: `${mainAgentUnclassified} 条未归类：记录前请先调 list_l1_scenes 从清单里挑 scene_id（或给稳定的 scene_name），否则只能落占位 ${MAIN_AGENT_SCENE_FALLBACK}。` } : {}),
								}),
							},
						],
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
