/**
 * L1 召回 query 构造：噪声识别 + 历史替代（2026-10-02）
 *
 * ── 为什么有这个模块 ──
 *
 * L1 自动注入的 queryText 原先只有两种形态：**裸 prompt**，或**裸 prompt + 拼 2 条 user 历史**
 * （`contextExpansion=conditional` 且 prompt「过短或含指代词」时）。实测发现一个缺陷：
 *
 *   噪声 prompt（"同意" / "提交" / "需要"）**全部**命中 `needsContextExpansion`（因为都 < 12 字），
 *   于是变成 `噪声原文 + 真实历史` 一起送进 embedding —— **噪声占掉一半权重，把真实意图稀释了**。
 *   向量检索永远返回 top-K，哪怕库全是无关内容，所以噪声 query 照样能拿 0.45–0.53 的
 *   「top-1 最佳命中」（实测采样 30 条），看着像召回了，其实在捞最不相关的那几条。
 *
 * ── 实测依据（2026-10-02，只读统计，脚本已清理）──
 *
 *   · L0 归档 30 个分片（08-17 → 10-02）1897 条 user 消息里，**噪声 109 条 = 5.7%**
 *   · 噪声去重后**只有 20 种**；形态：106 条 1–4 字、3 条 5–8 字、**0 条 > 12 字**
 *   · 噪声**零误判**：长度 ≥12 的 1339 条 user 消息，本模块判据下被判噪声 **0 条**
 *   · 噪声轮次的「前 2 条 user 历史」有实质内容的只占 **98.2%**（107/109）
 *
 * ── 为什么判定用文本匹配而不是向量 ──
 *
 * 判定发生在 **query 构造之前**。若判定本身要发 embedding，噪声轮次照样要发一次 embed ——
 * **用一次 embed 决定要不要省一次 embed，净收益为零**，还多了延迟与非确定性。
 * 这是成本方向决定的，不是「向量效果不好」。
 *
 * ── 三档决策 ──
 *
 *   | 档 | 何时 | queryText |
 *   |---|---|---|
 *   | `bare` | prompt 有实质内容 | 裸 prompt（历史仅在 needsContextExpansion 命中时追加，见 index.ts） |
 *   | `replaced` | prompt 是噪声，但**能**从历史里捞到实质内容 | **历史替代**噪声，不保留噪声原文 |
 *   | `skipped` | prompt 是噪声，且历史里也捞不到 | 空串 ⇒ 调用方跳过召回 |
 *
 * `replaced` 档是关键：**同等 embedding 成本，信号强度提高**（噪声那一半权重直接消失）。
 * 收益是**提质**不是省时间 —— 噪声只占 5.7%，全跳过也省不了多少。
 *
 * ── 为什么 `replaced` 必须同时看 user 和 assistant 历史 ──
 *
 * 实测预演：8 个噪声样本里 **4 个**「前 3 条 user 消息内无实质内容」，救不回。原因是这类
 * 消息本身就是连续推进的（"提交" ← 上一轮 assistant 正在写 "## 实施完成，验证全部通过…"）。
 * **意图在 assistant 那边，不在 user 那边** —— 只看 user 历史，方案一半场景无效。
 */

// ══════════════════════════════════════════════════════════════
//  噪声词表
// ══════════════════════════════════════════════════════════════

/**
 * 元指令词表：**只收实测出现过的形态**（L0 30 分片去重后 20 种）。
 *
 * 为什么不穷举全部中文元指令：那是无底洞，且引入了无法验证的猜测。
 * 维护策略：先覆盖实测集合，后续看 `recall.log` 里「判噪声但替代失败」的记录再按需补。
 *
 * 分三类：应答（无信息量）/ 推进（连续动作词）/ 状态陈述（"行为正常"这类不指向任何检索意图）。
 */
export const NOISE_WORDS: readonly string[] = [
	// 应答
	"同意", "好的", "好", "行", "是", "对", "可以", "需要", "不用", "算了",
	// 推进
	"继续", "开始", "开工", "提交", "推送", "重来", "再来", "下一步",
	// 状态陈述
	"行为正常", "重启了", "已重启", "测试正常", "没问题",
	// 元指令 / 引用 agent 上一轮
	"按你说的来", "按你推荐的来", "照你说的做", "就这样",
	// 推进 + 动词的组合（实测形态，含少量实词）
	"开始执行", "开始修复", "开始实现", "继续修复", "继续执行", "一并提交",
];

/** 噪声判定：长度上限。实测噪声**全部 ≤12 字**，≥12 的 1339 条正常消息零误判。 */
export const NOISE_MAX_LEN = 12;

/** 判定「有实质检索意图」的最小长度（历史消息用）。低于此值视为也不够格替代。 */
export const SUBSTANTIVE_MIN_LEN = 8;

/** 一条消息的纯文本归一化：去首尾空白 + 去中英文标点。 */
function normalize(text: string): string {
	return (text ?? "").trim().replace(/[\s，。！？、,.!?"'：:；;]/g, "");
}

// ══════════════════════════════════════════════════════════════
//  噪声识别
// ══════════════════════════════════════════════════════════════

/**
 * 判断一条 user 消息是否是「无检索意图的噪声」。
 *
 * 参数：`text` —— user 消息原文。
 * 返回：`true` 表示噪声（应答/推进/状态陈述），`false` 表示有实质检索意图。
 *
 * 判据（按顺序，短路）：
 *   1. 空串 / 归一化后为空（纯标点如 "、"）⇒ 噪声
 *   2. 长度 > {@link NOISE_MAX_LEN} ⇒ **一定不是噪声**（实测正常提问全在这一档，零误判的来源）
 *   3. 归一化后精确命中词表 ⇒ 噪声
 *   4. 包含某个 ≥2 字的词表词，且**去掉它之后剩余 ≤2 字** ⇒ 噪声
 *      （这样 "同意，按你说的来" 这种由多个虚词拼成的也能命中）
 *
 * 设计意图 —— 第 4 条为什么不按「实词数量」判：
 * 实测样本里 "开始修复" / "继续执行" / "行为正常" **含实词**。若按「剩余实词 ≤2 就判噪声」，
 * "开始修复" 会被误判。而它其实是推进信号，走 §replaced 档才是正确处理，不是该被跳过的对象。
 *
 * **保守优先**：宁可漏判（漏判只是走 replaced 档，无损失）也不误判正常提问
 * （误判会让正常消息丢召回）。这个方向性由 verify-query-noise.ts 的「零误判」断言锁住。
 */
export function isNoisePrompt(text: string): boolean {
	const t = (text ?? "").trim();
	if (!t) return true;
	const norm = normalize(t);
	if (!norm) return true; // 纯标点
	if (t.length > NOISE_MAX_LEN) return false; // 长的一定有内容
	if (NOISE_WORDS.includes(norm)) return true;
	for (const w of NOISE_WORDS) {
		if (w.length < 2) continue;
		if (norm.includes(w) && norm.replace(new RegExp(w, "g"), "").length <= 2) return true;
	}
	return false;
}

/** 一条历史消息是否「够格作为替代 query」（非噪声且长度达标）。 */
function isSubstantive(text: string): boolean {
	const t = (text ?? "").trim();
	return t.length >= SUBSTANTIVE_MIN_LEN && !isNoisePrompt(t);
}

// ══════════════════════════════════════════════════════════════
//  query 构造
// ══════════════════════════════════════════════════════════════

/** 三档决策结果。 */
export type QueryPlan =
	| { kind: "bare"; text: string }
	| { kind: "replaced"; text: string; from: "user" | "assistant" }
	| { kind: "skipped"; text: "" };

/** {@link buildQueryText} 的入参。 */
export interface BuildQueryInput {
	/** 本轮 user prompt 原文。 */
	prompt: string;
	/** 历史 user 消息，**按时间倒序**（最近的在前面）。 */
	recentUser?: readonly string[];
	/** 上一条 assistant 消息文本。 */
	lastAssistant?: string;
	/**
	 * 是否走旧的「裸 prompt + 追加历史」路径（`contextExpansion=always` / `conditional` 命中时）。
	 * `false` 时：有实质内容的 prompt 一律裸用，噪声仍走 replaced/skipped。
	 */
	expandContext?: boolean;
	/** 历史拼接的字符上限（沿用 index.ts 原值 200）。 */
	historyCharLimit?: number;
}

/** 历史拼接字符上限默认值。 */
export const DEFAULT_HISTORY_CHAR_LIMIT = 200;

/**
 * 构造 L1 召回 queryText。
 *
 * 参数：见 {@link BuildQueryInput}。
 * 返回：{@link QueryPlan} —— `bare` / `replaced` / `skipped` 三档，调用方据 `kind` 决定是否发起召回。
 *
 * 决策逻辑：
 *   1. prompt **有实质内容** ⇒ `bare`（若 `expandContext` 则按旧行为追加历史，保持兼容）
 *   2. prompt 是**噪声** ⇒ 找最近一条够格的 `recentUser`；找不到则退到 `lastAssistant`；
 *      找到 ⇒ `replaced`（**不保留噪声原文**）；都找不到 ⇒ `skipped`
 *
 * 设计意图 —— 为什么 `replaced` 要用 assistant 兜底：
 * 实测 8 个噪声样本里 4 个「前 3 条 user 内无实质内容」（"提交"、"一并提交"、"开始执行计划"、
 * 某条"需要"），因为这类消息本身是连续推进的，意图写在 assistant 上一条回复里。
 * 只看 user 历史会让一半场景救不回。
 *
 * 设计意图 —— 为什么不用向量判噪声：见文件头「为什么判定用文本匹配而不是向量」。
 *
 * 纯函数：不读文件、不调模型、无副作用，便于回归脚本直接 import 验证。
 */
export function buildQueryText(input: BuildQueryInput): QueryPlan {
	const { prompt, recentUser = [], lastAssistant = "", expandContext = false, historyCharLimit = DEFAULT_HISTORY_CHAR_LIMIT } = input;
	const p = (prompt ?? "").trim();

	// ── 1. 有实质内容：裸 prompt（conditional/always 时按旧行为追加历史）──
	if (!isNoisePrompt(p)) {
		if (!expandContext) return { kind: "bare", text: p };
		const hist = joinHistory(recentUser, historyCharLimit);
		return { kind: "bare", text: hist ? `${p}\n${hist}` : p };
	}

	// ── 2. 噪声：优先用最近一条实质 user 替代 ──
	for (const raw of recentUser) {
		const t = (raw ?? "").trim();
		if (isSubstantive(t)) return { kind: "replaced", text: clip(t, historyCharLimit), from: "user" };
	}

	// ── 3. user 历史救不回 → 退到 assistant 上一条 ──
	const a = (lastAssistant ?? "").trim();
	if (isSubstantive(a)) return { kind: "replaced", text: clip(a, historyCharLimit), from: "assistant" };

	// ── 4. 都救不回：跳过（本轮不召回）──
	return { kind: "skipped", text: "" };
}

/** 把历史 user 消息拼成一段（倒序输入，取到上限为止）。 */
function joinHistory(recentUser: readonly string[], limit: number): string {
	const parts: string[] = [];
	let used = 0;
	for (const raw of recentUser) {
		const t = (raw ?? "").trim();
		if (!t) continue;
		if (used + t.length > limit) break;
		parts.push(t);
		used += t.length;
	}
	return parts.join("\n");
}

/** 按字符上限截断。 */
function clip(text: string, limit: number): string {
	return text.length <= limit ? text : text.slice(0, limit);
}
