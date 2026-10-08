/**
 * memory/l1/task-state.ts —— 「任务开/关状态」（`taskState`）的落盘与清单
 *
 * 背景：`work_task` 是四种记录类型里唯一有生命周期的（提取定义即"有后续动作/deadline 的待办"），
 * 但此前没有任何机制把任务标成已完成/已废弃——做完的任务永远停在待办，靠着纯相似度召回
 * 被反复注入。本模块提供标记入口的**唯一实现**，由 agent 工具 `l1_task_state` 与用户命令
 * `/my-memory:l1:task` 共用（两者只负责解析参数、渲染结果）。
 *
 * 方案与取舍见 plan/pi-memory-system/L1-任务生命周期标记-计划.md，三条关键决策：
 *
 *  1. **不复用 `deleted`**：`deleted` 的语义是"记录不成立"（查重覆盖/纠错作废），会让记录连同
 *     向量一起退出召回；而"任务做完了"本身往往有价值（"已经做过 X，走的是 Y 方案"）。
 *     两者是**两根独立的轴**。
 *  2. **就地改写**（保留 id / content / version）：不烧 embedding、不重置 hit-stats、
 *     不给 L2 场景块的成员清单制造死引用。只改 `taskState`、`updatedAt` 与审计键。
 *  3. **审计键独立**：写 `metadata.taskStateChange` 而**不是** `metadata.l1Cleanup` ——
 *     后者的 `appliedAt` 是 `l1_fix` 的 24h 防抖数据源（见 fix-tool.ts:109-115），
 *     复用会让刚标记过的任务在 24h 内无法纠正。
 *
 * 已知缺口（记录在案，不在本模块解决）：`scripts/l1-admin` 的 .mjs 脚本不取提交级写锁，
 * 因此本模块与 CLI 写者之间仍无互斥（见 write-lock.ts 头部）。批量标记/迁移应在无后台 L1 时执行。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { acquireWriteLock } from "./write-lock.ts";
import { recordsDirOf, rewriteShardRows, scanRecordShards } from "./in-place-mark.ts";
import { L1_TASK_STATES, L1_TASK_STATES_TEXT, type L1TaskState, isL1TaskState, normalizeTaskState, taskStateOf } from "./record-types.ts";
import { logEvent } from "../../util/notice.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

/** 标记来源：写进审计键，便于区分人工/agent/迁移脚本。 */
export type TaskStateActor = "agent" | "user" | "migration";

/** 一次状态标记请求。 */
export interface TaskStateChange {
	/** 目标记录 id（必须指向一条仍存活的 `work_task`） */
	id: string;
	/** 目标状态 */
	state: L1TaskState;
}

/** 单条 id 的处理结果。 */
export interface TaskStateChangeResult {
	id: string;
	ok: boolean;
	/** 是否真的改了盘；幂等命中（目标状态与现状相同）为 false */
	changed: boolean;
	/** 改前的状态（缺字段按 `open` 计） */
	from?: L1TaskState;
	/** 改后的状态 */
	to?: L1TaskState;
	/** 失败原因（ok=false 时必有） */
	error?: string;
}

/** 一次批量标记的汇总。 */
export interface ApplyTaskStateOutcome {
	results: TaskStateChangeResult[];
	changed: number;
	noop: number;
	failed: number;
	/** 实际被改写的分片文件数 / 行数（与"标记了几条"不是一回事：同分片多条只算 1 个文件） */
	changedFiles: number;
	changedRows: number;
	/** 写锁获取失败时的提示（此时**未写盘**，所有 id 都记为失败） */
	lockError?: string;
}

/**
 * 批量设置任务状态（就地改写，不追加新版本）。
 *
 * 语义边界（每一条都对应一个坑）：
 *  - 只接受**存活**的记录：id 不存在或最后一行 `deleted===true` → 该 id 失败并给出原因；
 *  - 只接受 **`work_task`**：`taskState` 在其它类型上没有读取者（注入侧只给任务渲染标签），
 *    允许写入等于制造"标了但看不见"的死数据，故直接拒绝并说明；
 *  - 幂等：目标状态与现状相同 → `changed:false` 的 no-op，不算失败；
 *  - **部分成功不回滚**：多 id 调用里个别失败不影响其余（与 `l1_fix` 的单 id 全成/全败不同，
 *    工具 description 已写明）。调用方据 `failed` 决定提示口径；
 *  - 写锁：整批共用一次跨进程写锁（10s 超时）。拿不到锁**一条都不写**，返回 `lockError`。
 *
 * @param profilePath profile 根目录
 * @param changes 目标 id 与状态（同一 id 重复出现时只按第一次处理，第二次报幂等）
 * @param opts.by 标记来源（写入审计键）
 * @param opts.reason 可选备注（写入审计键，供事后回看"为什么关掉它"）
 * @param opts.lockTimeoutMs 写锁等待上限（默认交给 write-lock 的 10s；回归测试用小值，避免忙等）
 */
export function applyTaskStateChanges(
	profilePath: string,
	changes: TaskStateChange[],
	opts: { by: TaskStateActor; reason?: string; lockTimeoutMs?: number } = { by: "agent" },
): ApplyTaskStateOutcome {
	const results: TaskStateChangeResult[] = [];
	const empty: ApplyTaskStateOutcome = { results, changed: 0, noop: 0, failed: 0, changedFiles: 0, changedRows: 0 };
	if (changes.length === 0) return empty;

	// 入参自检（调用方应已校验；这里兜底，避免把非法值写进库）
	for (const c of changes) {
		if (!c?.id || !isL1TaskState(c.state)) {
			results.push({ id: String(c?.id ?? ""), ok: false, changed: false, error: `非法入参：state 只能是 ${L1_TASK_STATES_TEXT}` });
		}
	}
	if (results.length > 0) {
		empty.failed = results.length;
		return empty;
	}

	const lock = acquireWriteLock(profilePath, opts.lockTimeoutMs ?? 10000);
	if (!lock) {
		const lockError = "L1 库被其他写者占用（写锁超时 10s），请稍后重试";
		for (const c of changes) results.push({ id: c.id, ok: false, changed: false, error: lockError });
		empty.failed = results.length;
		empty.lockError = lockError;
		return empty;
	}

	try {
		const recordsDir = recordsDirOf(profilePath);
		const scan = scanRecordShards(recordsDir);
		const markByFile = new Map<string, Set<number>>();
		const nowStamp = new Date().toISOString();
		// 待改写行的定位信息（id → 分片/行号），改盘前先收集，避免在回调里做查表
		const pending = new Map<string, { file: string; lineIdx: number; from: L1TaskState; to: L1TaskState }>();
		const seen = new Set<string>();

		for (const c of changes) {
			const id = c.id;
			const row = scan.lastById.get(id);
			if (!row) {
				results.push({ id, ok: false, changed: false, to: c.state, error: `记录不存在：${id}` });
				continue;
			}
			if (row.obj.deleted === true) {
				results.push({ id, ok: false, changed: false, to: c.state, error: `记录已被 deleted（任务状态不再有意义）：${id}` });
				continue;
			}
			const type = typeof row.obj.type === "string" ? row.obj.type : "";
			if (type !== "work_task") {
				results.push({
					id,
					ok: false,
					changed: false,
					to: c.state,
					error: `只有 work_task 承载任务状态（该记录 type=${type || "?"}）——注入侧不会给其它类型渲染状态标签，写入等于制造看不见的数据`,
				});
				continue;
			}
			const from = taskStateOf(row.obj);
			if (seen.has(id)) {
				results.push({ id, ok: false, changed: false, from, to: c.state, error: `同一批内重复出现：${id}（只处理第一次）` });
				continue;
			}			seen.add(id);
			if (from === c.state) {
				results.push({ id, ok: true, changed: false, from, to: c.state });
				continue;
			}
			if (!markByFile.has(row.file)) markByFile.set(row.file, new Set());
			markByFile.get(row.file)!.add(row.lineIdx);
			pending.set(id, { file: row.file, lineIdx: row.lineIdx, from, to: c.state });
		}

		const lineKey = (file: string, lineIdx: number) => `${file}#${lineIdx}`;
		const byLine = new Map<string, { id: string; from: L1TaskState; to: L1TaskState }>();
		for (const [id, p] of pending) byLine.set(lineKey(p.file, p.lineIdx), { id, from: p.from, to: p.to });

		const stats = rewriteShardRows(recordsDir, markByFile, (o, row) => {
			const hit = byLine.get(lineKey(row.file, row.lineIdx));
			if (!hit) return false;
			if (o.deleted === true) return false; // 扫描后被并入作废（并发写者）——宁可不写
			o.taskState = hit.to;
			o.updatedAt = nowStamp;
			const md = (typeof o.metadata === "object" && o.metadata !== null ? o.metadata : {}) as Record<string, unknown>;
			o.metadata = {
				...md,
				// 刻意不复用 l1Cleanup：那是 l1_fix 的 24h 防抖数据源（见文件头第 3 条）
				taskStateChange: {
					from: hit.from,
					to: hit.to,
					at: nowStamp,
					by: opts.by,
					...(opts.reason ? { reason: opts.reason } : {}),
				},
			};
			return true;
		});

		for (const [id, p] of pending) {
			results.push({ id, ok: true, changed: true, from: p.from, to: p.to });
		}

		const changed = results.filter((r) => r.changed).length;
		const failed = results.filter((r) => !r.ok).length;
		const noop = results.filter((r) => r.ok && !r.changed).length;
		if (changed > 0) {
			logEvent(
				"l1",
				`taskState 标记：${changed} 条（by=${opts.by}${opts.reason ? `，reason=${opts.reason}` : ""}；分片 ${stats.changedFiles} 个 / 行 ${stats.changedRows}；noop=${noop} failed=${failed}）`,
				profilePath,
			);
		}
		return { results, changed, noop, failed, changedFiles: stats.changedFiles, changedRows: stats.changedRows };
	} finally {
		lock.release();
	}
}

/** 清单行（供 `/my-memory:l1:task list` 渲染）。 */
export interface TaskListRow {
	id: string;
	state: L1TaskState;
	priority: number;
	createdAt: string;
	/** 状态最近一次变更时间（无审计则空） */
	stateChangedAt: string;
	scene: string;
	content: string;
}

/**
 * 列出 `work_task` 记录（清单入口；用户命令靠它拿到 id）。
 *
 * 与 `applyTaskStateChanges` 共用 `scanRecordShards` 的同一口径：**每个 id 只看最后一行**
 * （LWW），最后一行已 `deleted` 的不算存活。刻意不用 `loadL1RecordById` —— 它只回溯 30 天
 * 且按 UTC 日期枚举分片名，会漏掉本地日期分片与更早的存量（详见 in-place-mark.ts）。
 *
 * @param includeClosed 是否包含 `done` / `dropped`（默认只列 open）
 * @returns 按 createdAt 倒序（新任务在前）
 */
export function listTaskRecords(profilePath: string, includeClosed = false): TaskListRow[] {
	const scan = scanRecordShards(recordsDirOf(profilePath));
	const rows: TaskListRow[] = [];
	for (const [id, row] of scan.lastById) {
		if (row.obj.deleted === true) continue;
		if (row.obj.type !== "work_task") continue;
		const state = taskStateOf(row.obj);
		if (!includeClosed && state !== "open") continue;
		const md = (typeof row.obj.metadata === "object" && row.obj.metadata !== null ? row.obj.metadata : {}) as Record<string, unknown>;
		const audit = (typeof md.taskStateChange === "object" && md.taskStateChange !== null ? md.taskStateChange : {}) as Record<string, unknown>;
		rows.push({
			id,
			state,
			priority: typeof row.obj.priority === "number" ? row.obj.priority : 0,
			createdAt: typeof row.obj.createdAt === "string" ? row.obj.createdAt : "",
			stateChangedAt: typeof audit.at === "string" ? audit.at : "",
			scene: typeof row.obj.scene_name === "string" ? row.obj.scene_name : "",
			content: typeof row.obj.content === "string" ? row.obj.content : "",
		});
	}
	rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id)));
	return rows;
}

/**
 * 解析命令行/工具参数里的状态字（`done|dropped|open`，容忍大小写与空白）。
 *
 * @returns 合法状态；非法返回 `null`（调用方据此给出用法提示）
 */
export function parseTaskStateArg(raw: unknown): L1TaskState | null {
	return normalizeTaskState(raw);
}

/** 单次调用的 id 上限：防止一次误传整库（工具是 agent 驱动的，正常批量是几条到十几条）。 */
const MAX_BATCH = 50;

/**
 * 注册 agent 工具 `l1_task_state`（扩展加载时调用一次）。
 *
 * 与 `l1_fix` 的分工（刻意分开，别混）：
 *   - `l1_fix` = **纠错**（记录写错了），带证据门槛、24h 防抖、高价值保护；
 *   - `l1_task_state` = **生命周期**（记录没错，只是任务关了），无证据门槛、幂等、可回退。
 * 把生命周期塞进 `l1_fix` 会让例行动作被三道纠错闸挡住 —— 而挡住的后果是 agent 干脆不标。
 */
export function registerTaskStateTool(pi: ExtensionAPI, getProfilePath: () => string | undefined): void {
	pi.registerTool({
		name: "l1_task_state",
		label: "Set L1 Task State",
		description: renderPrompt("tools#l1_task_state"),
		parameters: {
			type: "object",
			properties: {
				ids: {
					type: "array",
					items: { type: "string" },
					description: "L1 work_task record ids to mark (from the recall block or recall_l1_records results).",
				},
				state: {
					type: "string",
					enum: [...L1_TASK_STATES],
					description: "Target state: done (completed) / dropped (abandoned, will not do) / open (reopen a closed task).",
				},
				reason: {
					type: "string",
					description: "Optional short reason, stored in metadata.taskStateChange for later review.",
				},
			},
			required: ["ids", "state"],
		},
		async execute(_toolCallId, params) {
			try {
				const profilePath = getProfilePath();
				if (!profilePath) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active profile" }) }], details: {} };
				}
				const rawIds = Array.isArray(params?.ids) ? params.ids : [];
				const ids = [...new Set(rawIds.map((x: unknown) => String(x ?? "").trim()).filter(Boolean))];
				if (ids.length === 0) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "ids 必须是非空字符串数组" }) }], details: {} };
				}
				if (ids.length > MAX_BATCH) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `一次最多 ${MAX_BATCH} 条（本次 ${ids.length} 条）` }) }], details: {} };
				}
				const state = parseTaskStateArg(params?.state);
				if (!state) {
					return {
						content: [{ type: "text", text: JSON.stringify({ success: false, error: `state 只能是 ${L1_TASK_STATES_TEXT}（收到 ${JSON.stringify(params?.state)}）` }) }],
						details: {},
					};
				}
				const reason = typeof params?.reason === "string" && params.reason.trim() ? params.reason.trim().slice(0, 200) : undefined;
				const out = applyTaskStateChanges(
					profilePath,
					ids.map((id) => ({ id, state })),
					{ by: "agent", reason },
				);
				const body = {
					success: out.failed === 0,
					changed: out.changed,
					noop: out.noop,
					failed: out.failed,
					...(out.lockError ? { error: out.lockError } : {}),
					results: out.results,
				};
				return { content: [{ type: "text", text: JSON.stringify(body) }], details: {} };
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }) }],
					details: {},
				};
			}
		},
	});
}
