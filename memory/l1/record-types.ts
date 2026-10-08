/**
 * memory/l1/record-types.ts —— L1 记录**闭集取值空间的单一定义**（零 import 纯常量）
 *
 * 目前承载两套：`type`（2026-10-02 收束）与 `taskState`（2026-10-08 新增，任务生命周期）。
 * 两者共用本文件的理由是同一条：闭集必须零 import 才能同时被主进程与子代理进程引用。
 *
 * 背景（STANDALONE_RELEASE_PLAN P1-12，2026-10-02）：这份白名单原先抄在 4 个地方 ——
 * `value-check.ts` 与 `commit-tool.ts` 各一份 `new Set([...])`，`commit-tool.ts` 另有两条
 * 错误文案把四个值手写进字符串，`quality.ts` 还有一份子集 `["work_method"]`。
 *
 * 为什么必须收：加一个合法 type 要改 4 处，漏一处不会报错 —— `value-check` 认了而
 * `commit` 不认（或反过来），于是「模型能产出的类型」和「写得进库的类型」悄悄分叉。
 * 错误文案那两处更糟：文案里少列一个，用户拿到「只能是 A/B/C」的提示却实际能填 D。
 *
 * 为什么不放 `l1/config.ts`：那个模块会拖进 `l0/index.ts` 与 `scene-pool.ts`，而
 * `value-check.ts` 是在 **L1 子代理进程**里跑的，没必要为拿四个字符串付这份依赖。
 * 与 `project-scope.ts` 同款定位：零 import 的纯常量模块。
 */

/** L1 记录的全部合法 type。顺序即报错文案里的展示顺序，勿随意调整。 */
export const L1_RECORD_TYPES = ["work_fact", "work_task", "work_method", "work_artifact"] as const;

/** L1 记录 type 的联合类型。 */
export type L1RecordType = (typeof L1_RECORD_TYPES)[number];

/** O(1) 判定用的 Set（模块级单例，别在热路径里 new）。 */
export const L1_RECORD_TYPE_SET: ReadonlySet<string> = new Set<string>(L1_RECORD_TYPES);

/** 斜杠连接的紧凑写法，专供错误文案（避免手写 4 遍又漏一遍）。 */
export const L1_RECORD_TYPES_TEXT = L1_RECORD_TYPES.join("/");

/** 是否是合法 type。 */
export function isL1RecordType(value: unknown): value is L1RecordType {
	return typeof value === "string" && L1_RECORD_TYPE_SET.has(value);
}

/**
 * 永不自动淘汰、只降权的 type 子集（`quality.ts` 的淘汰保护判据）。
 *
 * 理由（`quality.ts` 原文）：高 priority 与 `work_method` 类记忆不是"没价值"，
 * 只是"没被想起来" —— 直接删掉等于把还没被检索命中的好方法扔了。
 */
export const PROTECTED_L1_TYPES: readonly string[] = ["work_method"];

// ══════════════════════════════════════════════════════════════
//  任务生命周期取值（`taskState`）—— 与 type 同款「单一定义」
//
// 为什么和 type 放同一个模块：本文件是**零 import** 的记录字段取值空间单一定义处，
// 而 `taskState` 的校验要在两个进程里用 —— 主进程（`l1_task_state` 工具 / 用户命令）
// 与 **L1 子代理进程**（`l1_commit` 的 execute 在子代理里跑）。带 fs / profile 依赖的
// `task-state.ts` 不能进子代理，闭集常量必须留在这里（先例：`value-check.ts` 引本文件）。
//
// 语义边界（务必与 `deleted` 分清）：
//   - `deleted: true` = 「这条记录不成立」（查重覆盖 / 纠错作废），读完从召回、向量、L2 全部消失；
//   - `taskState` = 「记录成立，但任务开/关状态变了」，记录照旧存活、照旧被召回，靠标签区分。
//   二者是**两根独立的轴**，同一条记录可以既是 `done` 又是 `deleted` 之后的状态。
// ══════════════════════════════════════════════════════════════

/** `taskState` 的全部合法取值。顺序即报错文案与注入标签的展示顺序，勿随意调整。 */
export const L1_TASK_STATES = ["open", "done", "dropped"] as const;

/** `taskState` 的联合类型。 */
export type L1TaskState = (typeof L1_TASK_STATES)[number];

/** O(1) 判定用的 Set（模块级单例）。 */
export const L1_TASK_STATE_SET: ReadonlySet<string> = new Set<string>(L1_TASK_STATES);

/** 斜杠连接的紧凑写法，专供错误文案。 */
export const L1_TASK_STATES_TEXT = L1_TASK_STATES.join("/");

/** 是否是合法 taskState（不做归一化，`" DONE "` 判 false —— 归一交给 normalizeTaskState）。 */
export function isL1TaskState(value: unknown): value is L1TaskState {
	return typeof value === "string" && L1_TASK_STATE_SET.has(value);
}

/**
 * 归一化 taskState：去空白 + 转小写后判合法性。
 *
 * @returns 合法值；`null` = 不是合法取值（**注意与「缺字段」区分**：缺字段由调用方按 `open` 处理，
 *          本函数返回 `null` 一律是"写了但写错"，走硬闸拒绝）。
 */
export function normalizeTaskState(value: unknown): L1TaskState | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	return L1_TASK_STATE_SET.has(v) ? (v as L1TaskState) : null;
}

/**
 * 注入标签（给主代理看的短中文），`open` 之外的取值才值得在注入行里标出来。
 *
 * 为什么把标签放在这个零 import 模块：注入侧（`index.ts`）与工具侧都要用同一份文案，
 * 两处各写一份就会出现"工具说已完成、注入说 done"这种漂移。
 */
export const L1_TASK_STATE_LABELS: Readonly<Record<L1TaskState, string>> = {
	open: "待办",
	done: "已完成",
	dropped: "已废弃",
};

/** 取注入标签；非法值/未提供返回 `null`（调用方据此不渲染标签）。 */
export function taskStateLabel(value: unknown): string | null {
	return isL1TaskState(value) ? L1_TASK_STATE_LABELS[value] : null;
}

/** 记录的当前任务状态：缺字段 = `open`（存量记录无需迁移即语义正确）。 */
export function taskStateOf(record: { taskState?: unknown; type?: unknown }): L1TaskState {
	return normalizeTaskState(record?.taskState) ?? "open";
}

/**
 * 渲染注入块里的一行：`- [待办] (l1_…) 正文`（非任务记录没有标签，形如 `- (l1_…) 正文`）。
 *
 * 三个约束都是踩过的坑（详见 plan/pi-memory-system/L1-任务生命周期标记-计划.md）：
 *  1. **每行带编号**：注入块原先只有正文，模型即便判断"这条记忆与事实矛盾"也没有操作句柄
 *     （`l1-selffix-hint` 让它调 `l1_fix`，却拿不到 recordId）。带编号后，自纠与关任务都是一次调用。
 *  2. **只给 `work_task` 渲染标签**：只有任务有生命周期；`open` 也渲染（写「待办」），
 *     让"待办"与"已完成"一眼可分，不必去正文里猜时态。
 *  3. **正文换行折成空格**：正文来自对话与代码，可能自带换行；原样拼接时它能伪装成"另一条记忆行"，
 *     而带编号之后伪造行还附上了可直接操作的句柄。折成空格后严格一行一条。
 *
 * 抽成纯函数是为了可回归——这段格式是给模型看的对外契约，不能在 `index.ts` 里只靠肉眼。
 */
export function formatInjectedRecordLine(rec: { recordId: string; type?: string; taskState?: unknown; content: string }): string {
	// 用 `taskStateOf`（缺字段/非法值一律按 open）——与召回过滤、清单、剔除开关同一口径：
	// 少写一个字段不该让任务在注入里"看起来没有状态"。
	const label = rec.type === "work_task" ? taskStateLabel(taskStateOf(rec)) : null;
	const head = label ? `- [${label}] (${rec.recordId})` : `- (${rec.recordId})`;
	return `${head} ${String(rec.content ?? "").replace(/\s*\r?\n\s*/g, " ")}`;
}