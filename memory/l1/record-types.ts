/**
 * memory/l1/record-types.ts —— L1 记录 `type` 取值空间的**单一定义**（零 import 纯常量）
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