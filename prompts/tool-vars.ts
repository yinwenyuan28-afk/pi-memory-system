/**
 * prompts/tool-vars.ts —— 提示词变量表（把系统阈值回显进工具 description / 注入文案）
 *
 * ── 解决的问题 ──────────────────────────────────────────────────────────────
 * 工具 description 与每轮注入的 tool-reminder 里，原本**手抄**了几个系统阈值
 * （l1_fix 的「>=20 字符 / 24h / hits>=5」、召回的「up to 3 / top-5」）。提示词不是文档，
 * 是**每次请求都随工具 schema 发给 provider 的行为指令**；两边各写一份时，改代码不会改
 * 提示词，模型拿到的说明与实际行为不符，且这种漂移看代码完全看不出来
 * （2026-10-01 独立发布整改 P1-13）。
 *
 * 修法：数字只留在 config/thresholds.ts（零依赖叶子模块），这里把它转成 registry 的
 * 变量值，由 render(key, vars) 注入。
 *
 * ── 为什么单独一张表，而不是让各处自己拼 vars ────────────────────────────────
 * prompts/registry.ts 对变量做**强契约**（声明与传入不一致直接 throw）。这意味着：
 * 任何新增/改名都必须同步所有调用点，漏一个就在启动时炸——这是好事，但前提是
 * 「哪些 key 需要哪些变量」只有**一处**知道。本表就是那一处：
 *   - 生产调用点：`renderPrompt(key, promptVarsFor(key))`
 *   - 工具链：regen-golden / verify-prompt-contracts 用同一张表渲染
 * 两边共用 ⇒ 工具链不可能与生产渲染出不同的文本，golden 基线才有意义。
 *
 * 依赖方向：本文件只 import config/thresholds.ts（零依赖），不碰任何业务模块——
 * 否则会把 sqlite / 向量库 / 任务队列拖进轻量的提示词工具链。
 */

import {
	AUTO_INJECT_TOP_K,
	FIX_DEBOUNCE_HOURS,
	FIX_HIGH_VALUE_HITS,
	FIX_MIN_EVIDENCE_CHARS,
	TOOL_RECALL_TOP_K_DEFAULT,
} from "../config/thresholds.ts";

/**
 * 需要变量的模板 key → 变量值表。
 *
 * 只有**确实含数字**的模板才登记；零变量模板不在表里，`promptVarsFor` 返回空对象，
 * 与 registry 的契约一致（声明为空、传入为空）。
 */
export const PROMPT_VARS: Record<string, Record<string, string>> = {
	"backends/tool-reminder": {
		autoInjectTopK: String(AUTO_INJECT_TOP_K),
		toolRecallTopK: String(TOOL_RECALL_TOP_K_DEFAULT),
	},
	"tools#recall_l1_records": {
		autoInjectTopK: String(AUTO_INJECT_TOP_K),
	},
	"tools#l1_fix": {
		fixMinEvidenceChars: String(FIX_MIN_EVIDENCE_CHARS),
		fixDebounceHours: String(FIX_DEBOUNCE_HOURS),
		fixHighValueHits: String(FIX_HIGH_VALUE_HITS),
	},
};

/**
 * 取某个模板 key 的变量表；未登记的 key 返回空对象（零变量模板的正常情况）。
 *
 * @param key registry 模板 key，如 `tools#l1_fix`
 */
export function promptVarsFor(key: string): Record<string, string> {
	return PROMPT_VARS[key] ?? {};
}
