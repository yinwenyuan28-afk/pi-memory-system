/**
 * L1 召回排序打分：余弦 × 项目权重（2026-10-02）
 *
 * ── 为什么是加权排序而不是硬过滤 ──
 *
 * 原设计是硬过滤（项目不同就扔）。实测否掉了：**同项目与异项目的余弦分布中位数几乎相同**
 * （0.605 vs 0.599），扔掉异项目的高分必然连带扔掉真正相关的记忆。
 * 加权排序保留强度信息 —— 异项目记忆仍能参与竞争，只是被压后。
 *
 * ── 权重取值有实测依据（不是拍的）──
 *
 * 采样：5 个 `flag=true` 会话 × 每会话最近 5 条真 query = 25 条 query × top-8 命中 = 200 条，
 * 每条按「自身 sessionId 的 project」与「记忆的 metadata.project」配对分类。
 * 离线模拟不同 w 下 top-3 的构成（脚本见 §实测的可复现路径）：
 *
 *   | w    | 同项目 | 通用件 | 跨项目 |
 *   |------|--------|--------|--------|
 *   | 1.00（现状） | 55% | 21% | 24.0% |
 *   | 0.89  | 60% | 29% | 10.7% |
 *   | 0.85  | 63% | 29% | 8.0%  |
 *   | **0.75** | **63%** | **31%** | **6.7%** |
 *   | 0.60 / 0.50 / 0.30 | 63% | 31% | 6.7%（**与 0.75 完全相同**）|
 *
 * **0.75 是平台期起点**：再往下调跨项目占比不再下降，只会让同项目低分记忆受损。
 * 跨项目从 24.0% 降到 6.7%（降约 3/4），且是零额外代价。
 *
 * ⚠ **样本量诚实说明**：25 条 query、4 个**不同**项目（memory-system 有两个会话重复计入）。
 * 分布形状与趋势可信，**具体百分比不可当生产口径**。上线后靠 `recall.log` 的
 * `pf:` 观测段复核。
 *
 * ── 为什么通用件（global/unknown）不降权 ──
 *
 * `scope=global` 是「没有项目」——协作纪律、工具用法、通用方法，本来就跨项目成立。
 * 按项目降权它等于「因为不属于你的项目所以不告诉你通用做法」，是误伤。
 * `scope=unknown` 是「判不了」，标签本身不完备，更不该因标签问题被罚。
 * 代价：模拟里通用件占比 21% → 31%。这是**有意的取舍**。
 *
 * 边界（纯函数，不读文件、不调模型）：
 *   - 会话 project **拿不到时**（无判定 / `flag=false` / 空）⇒ 一律按「无信息」处理，
 *     **全部系数 = 1.0**，即完全退回改造前的行为。不猜、不降权、不报错。
 */

/** 异项目 self 记忆的权重系数。实测平台期起点，见文件头对照表。 */
export const CROSS_PROJECT_WEIGHT = 0.75;

/**
 * 项目比较键：归一化到「小写 + 正斜杠 + 去尾分隔符」。
 *
 * ⚠ **顺序至关重要：必须先转斜杠、再去尾分隔符**（2026-10-02 实测踩到）。
 * 反过来写时，`C:\dev\code\xianhua\` 的尾部是 `\` 而非 `/`，
 * 「去尾分隔符」那步的正则 `/\/+$/` 匹配不到，尾部残留；
 * 等转成正斜杠时已经错过清理，于是 `C:\dev\code\xianhua\` 与
 * `C:/dev/code/xianhua` 判成两个不同项目 —— **Windows 上最常见的写法被误判成跨项目**，
 * 后果是同项目记忆被降权。这类 bug 不报错、只是排序悄悄变差。
 *
 * 盘符根 `C:/` 的尾斜杠必须保留（削成 `C:` 语义不同，且不再匹配 `^[A-Za-z]:/`）。
 */
export function projectCompareKey(project: string): string {
	let s = (project ?? "").trim();
	if (!s) return "";
	s = s.replace(/\\/g, "/"); // ① 先统一斜杠
	if (!/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, ""); // ② 再去尾（盘符根除外）
	return s.toLowerCase();
}

/** 一条记忆在排序里的分类。 */
export type ScoreClass = "match" | "mismatch" | "generic";

/** 打分所需的最小信息。 */
export interface ScoreInput {
	/** 记忆的 `metadata.scope`（`self` / `global` / `unknown`）。缺失按 `unknown` 处理。 */
	scope?: unknown;
	/** 记忆的 `metadata.project`。 */
	project?: unknown;
}

/**
 * 给一条召回候选分类 + 算最终得分。
 *
 * 参数：
 *   - `cosine` —— 向量库返回的**真余弦相似度**（`store.ts` 已把 L2 距离换算好）
 *   - `sessionProject` —— 当前会话判定的项目路径（可能为空 / `flag=false` 的占位值）
 *   - `item` —— 该条记忆的 `scope` 与 `project`
 *   - `crossWeight` —— 异项目系数，默认 {@link CROSS_PROJECT_WEIGHT}
 *
 * 返回：分类 + 最终得分（= cosine × 系数）。
 *
 * 分类规则（顺序即优先级）：
 *   1. `scope` 为 `global` / `unknown` ⇒ `generic`（**不降权**，见文件头）
 *   2. 会话 project 为空 ⇒ `match`（系数 1.0；**无信息时退回改造前行为**）
 *   3. 记忆 project 与会话 project 归一化后相等 ⇒ `match`
 *   4. 其余 ⇒ `mismatch`
 *
 * 设计意图 —— 第 2 条为什么「会话没判定」不降权而不是「按异项目处理」：
 * 弃权（`flag=false`）意味着**判定器没做出判断**，不是「判定为不属于本项目」。
 * 拿弃权当证据去压低别人的记忆，是把「不知道」当成「不是」——那会让覆盖率之外的会话
 * （实测 15/20）平白损失召回质量。
 */
export function scoreRecord(
	cosine: number,
	sessionProject: string,
	item: ScoreInput,
	crossWeight: number = CROSS_PROJECT_WEIGHT,
): { score: number; cls: ScoreClass } {
	const scope = typeof item.scope === "string" ? item.scope.trim().toLowerCase() : "";
	if (scope === "global" || scope === "unknown" || scope === "") {
		// `""` = 缺字段 ≈ 判不了，与 unknown 同处理
		return { score: cosine, cls: "generic" };
	}
	const sessKey = projectCompareKey(sessionProject);
	if (!sessKey) return { score: cosine, cls: "match" };
	const recKey = projectCompareKey(typeof item.project === "string" ? item.project : "");
	if (recKey && recKey === sessKey) return { score: cosine, cls: "match" };
	return { score: cosine * crossWeight, cls: "mismatch" };
}

/** 对一批候选做加权排序（分数降序）。**原地**排序并返回同一数组。 */
export function sortByScore<T extends { score: number }>(items: T[]): T[] {
	return items.sort((a, b) => b.score - a.score);
}