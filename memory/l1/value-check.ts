/**
 * L1 价值校验（2026-09-17）—— 在 `l1_commit` 写盘前跑**一次** agent loop，判定候选记忆值不值得留。
 *
 * ── 为什么是这个位置与这个形态 ───────────────────────────────
 *
 * 用户要解决的是**价值问题**（"有没有记流水账""存的是方法论还是表象"），不是形式问题 ——
 * 形式问题（type 越枚举 / priority 越界 / 长度超召回预算）由 `l1_commit` 的**代码闸**负责，
 * 不进这一层。理由：那些判断用正则做不了（实测本机 254 条记录上，纯正则给不出可信结论），
 * 而这层每次要花一次 LLM 调用 —— 只应该花在非判断不可的地方。
 *
 * 三个刻意的设计：
 *
 * 1. **判据不复制**：`buildChecklist()` 从 L1 提取规则**同一份 md** 里按标记摘出判据段落
 *    （`【首要原则 · 宁缺毋滥】`/`【三项判别测试】`/`【明确排除项】`/`### 不应该提取的内容`/
 *    `### 输出前自检`）。判据只有一份，改提取规则即同时改校验标准，不会分叉。
 *    摘不出足够内容 → 返回 null，调用方 fail-open（照写 + 留痕），不会把校验器变成橡皮图章。
 *
 * 2. **turn 数封顶**（用户要求）：默认 `maxTurns: 1` —— 纯判定、**不给工具**。
 *    这也是"只做判定"的最小形态；将来若要让校验器自己查证（如查重），再放开并同时想清楚给它什么工具。
 *
 * 3. **循环可注入**：`runValueCheck` 收一个 `loop` 参数（默认 `runAgentLoopOnce`）。
 *    这样裁决解析/应用策略/fail-open 全部可以离线测，不必真的发 LLM 调用。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render as renderPrompt } from "../../prompts/registry.ts";

/**
 * 循环函数类型。**只做类型导入**：`util/agent-loop.ts` 会静态拉进 `@earendil-works/pi-agent-core`，
 * 而那个包在 CJS 下没有 `require` 条件（见 AGENTS.md），一旦静态导入，所有间接引到本模块的东西
 * （`l1_commit`、进而 `verify-l1-scene-pool.ts`）都会被牵连。所以真调用走下面的惰性 `import()`。
 */
type LoopFn = (typeof import("../../util/agent-loop.ts"))["runAgentLoopOnce"];

/** 允许的裁决。`retype` 只改类型，不改内容 —— 校验器不负责重写。 */
export type ValueVerdictKind = "keep" | "drop" | "retype";

export interface ValueVerdict {
	/** 候选序号（与传入 records 的下标一致）。 */
	i: number;
	v: ValueVerdictKind;
	/** retype 时的目标类型。 */
	t?: string;
	/** drop / retype 的理由（要求必填，便于留痕与审计误杀）。 */
	r?: string;
}

export interface ValueCheckOutcome {
	/** 判定有效的裁决（按 i 升序）。null = 校验未执行（调用方 fail-open）。 */
	verdicts: ValueVerdict[] | null;
	/** 未执行/异常的原因（进返回体与日志，供排查）。 */
	skipped?: string;
	/** 原始终答（截断），仅在解析失败时保留作线索。 */
	raw?: string;
}

const RECORD_TYPES = new Set(["work_fact", "work_task", "work_method", "work_artifact"]);

/** 判据段落标记 → 终止条件。标记是字面量，改提取规则时这里会被回归盯住。 */
const CHECKLIST_SECTIONS: Array<{ start: string; kind: "bracket" | "heading" }> = [
	{ start: "【首要原则 · 宁缺毋滥】", kind: "bracket" },
	{ start: "【三项判别测试】", kind: "bracket" },
	{ start: "【明确排除项】", kind: "bracket" },
	{ start: "### 不应该提取的内容", kind: "heading" },
	{ start: '### 输出前自检（只对 type="work_method" 的记忆）', kind: "heading" },
];

/**
 * 从提取规则 md 里摘出价值判据（单一真源）。
 *
 * 终止规则：bracket 段遇到下一个 `【` 开头行即止；heading 段遇到 `---` 或下一个 `###`/`##` 即止。
 * 摘出的总长度不足 `MIN_CHECKLIST_CHARS` 视为失败（返回 null）—— 宁可 fail-open 也别让校验器拿着
 * 残缺判据去"审"，那比不审更危险（会以规则之名误杀）。
 */
export function buildChecklist(promptText: string, minChars = 200): string | null {
	const lines = String(promptText).replace(/\r\n/g, "\n").split("\n");
	const blocks: string[] = [];

	for (const sec of CHECKLIST_SECTIONS) {
		const startIdx = lines.findIndex((l) => l.startsWith(sec.start));
		if (startIdx === -1) continue;
		const body: string[] = [];
		for (let i = startIdx; i < lines.length; i++) {
			const l = lines[i];
			if (i > startIdx) {
				const isBracketStop = sec.kind === "bracket" && l.startsWith("【");
				const isHeadingStop = sec.kind === "heading" && (l.trim() === "---" || /^#{2,3}\s/.test(l));
				if (isBracketStop || isHeadingStop) break;
			}
			body.push(l);
		}
		const text = body.join("\n").trim();
		if (text) blocks.push(text);
	}

	const checklist = blocks.join("\n\n");
	return checklist.length >= minChars ? checklist : null;
}

/** 从 profile 读提取规则并摘判据。读不到 → null（fail-open）。 */
export function loadChecklistFromProfile(profilePath: string, mode: "code" | "chat"): string | null {
	const file = join(profilePath, "..", "..", "extensions", "memory-system", "memory", "l1", "prompts", `extract-${mode}-personal.md`);
	// 上面那条相对路径只在默认布局下成立；真正稳妥的是调用方传绝对路径（见 l1/commit-tool.ts 的用法）。
	if (!existsSync(file)) return null;
	try {
		return buildChecklist(readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

/** 从 md 文件绝对路径摘判据。 */
export function loadChecklistFromFile(file: string): string | null {
	if (!existsSync(file)) return null;
	try {
		return buildChecklist(readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

/** 候选记录的最小投影：只给校验器需要的东西，且**不给 L0 原料**（避免注意力被原料占满）。 */
export interface CandidateForCheck {
	content: string;
	type: string;
	priority?: number;
}

/** 渲染校验器的第一条 user 消息（判据 + 候选）。 */
export function buildCheckUserContent(checklist: string, candidates: CandidateForCheck[], maxChars: number): string {
	const shaped = candidates.map((c, i) => ({
		i,
		type: c.type,
		priority: c.priority,
		content: c.content.length > maxChars ? `${c.content.slice(0, maxChars)}…（已截断）` : c.content,
	}));
	return renderPrompt("injection/l1-value-check", {
		checklist,
		recordsJson: JSON.stringify(shaped, null, 1),
	});
}

/**
 * 解析校验器终答。契约（见提示词）：`{"verdicts":[{"i":0,"v":"keep"}]}`。
 *
 * 宽容但要安全：只接受合法裁决、`i` 必须在范围内、`drop`/`retype` 必须带理由（缺理由按 keep 处理 ——
 * 无理由的删除不可审计）；重复 `i` 取首次；**未覆盖到的记录一律按 keep**（不删没被判过的）。
 * 整体无法解析 → 返回 null（调用方 fail-open）。
 */
export function parseVerdicts(text: string, count: number): ValueVerdict[] | null {
	const raw = String(text ?? "").trim();
	if (!raw) return null;
	// 容忍模型加代码块或前后缀：取第一个 { 到最后一个 }
	const s = raw.indexOf("{");
	const e = raw.lastIndexOf("}");
	if (s === -1 || e === -1 || e <= s) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(s, e + 1));
	} catch {
		return null;
	}
	const list = (parsed as { verdicts?: unknown })?.verdicts;
	if (!Array.isArray(list)) return null;

	const seen = new Set<number>();
	const out: ValueVerdict[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const i = Number(o.i);
		if (!Number.isInteger(i) || i < 0 || i >= count || seen.has(i)) continue;
		const v = String(o.v ?? "");
		const reason = typeof o.r === "string" ? o.r.trim() : "";
		if (v === "keep") {
			seen.add(i);
			out.push({ i, v: "keep" });
			continue;
		}
		if (v === "drop") {
			// 无理由的删除不可审计 → 降级为 keep
			if (!reason) continue;
			seen.add(i);
			out.push({ i, v: "drop", r: reason });
			continue;
		}
		if (v === "retype") {
			const t = String(o.t ?? "");
			if (!reason || !RECORD_TYPES.has(t)) continue;
			seen.add(i);
			out.push({ i, v: "retype", t, r: reason });
		}
	}
	// 未覆盖的记录补 keep（显式补齐，便于调用方按 i 对齐）
	for (let i = 0; i < count; i++) if (!seen.has(i)) out.push({ i, v: "keep" });
	return out.sort((a, b) => a.i - b.i);
}

export interface RunValueCheckOptions {
	model: unknown;
	checklist: string;
	candidates: CandidateForCheck[];
	ctx?: unknown;
	getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
	maxTurns?: number;
	timeoutMs?: number;
	maxRecordChars?: number;
	sessionId?: string;
	/** 注入点：默认真调 agent loop（惰性导入，避免静态依赖 pi-agent-core）；测试传桩。 */
	loop?: LoopFn;
	/** 观测：失败时调用（fail-open 但必须留痕）。 */
	onError?: (error: unknown) => void;
}

/**
 * 跑一次价值校验。**任何失败都 fail-open**：返回 `verdicts: null` + `skipped` 原因，调用方照写库。
 *
 * 为什么 fail-open 而不是 fail-closed：这一层是**附加**判断，不能因为第二次 LLM 调用失败
 * （超时/401/模型抽风）就让整条 L1 链路停摆 —— L1 是 L2/L3 的唯一饲料。
 */
export async function runValueCheck(opts: RunValueCheckOptions): Promise<ValueCheckOutcome> {
	if (!opts.model) return { verdicts: null, skipped: "无可用模型" };
	if (!opts.checklist) return { verdicts: null, skipped: "判据为空" };
	if (opts.candidates.length === 0) return { verdicts: [], skipped: undefined };

	const loop = opts.loop ?? (await import("../../util/agent-loop.ts")).runAgentLoopOnce;
	const userContent = buildCheckUserContent(opts.checklist, opts.candidates, opts.maxRecordChars ?? 400);

	let text: string | null = null;
	let streamError: unknown = null;
	try {
		text = await loop(opts.model, SYSTEM_FRAMING, userContent, {
			// 不给工具：这一层只做判定（用户要求限制 turn 数；1 = 一次 LLM 调用）
			tools: [],
			ctx: opts.ctx as never,
			getApiKey: opts.getApiKey,
			maxTurns: Math.max(1, Math.min(3, opts.maxTurns ?? 1)),
			timeoutMs: opts.timeoutMs ?? 60_000,
			sessionId: opts.sessionId,
			onError: (err) => {
				streamError = err;
			},
		});
	} catch (err) {
		opts.onError?.(err);
		return { verdicts: null, skipped: `校验循环抛错：${err instanceof Error ? err.message : String(err)}` };
	}

	if (text === null) {
		const detail = streamError instanceof Error ? streamError.message : streamError ? String(streamError) : "返回空";
		opts.onError?.(streamError ?? new Error(`value-check 返回 null（${detail}）`));
		return { verdicts: null, skipped: `校验未产出终答（${detail}）` };
	}

	const verdicts = parseVerdicts(text, opts.candidates.length);
	if (!verdicts) return { verdicts: null, skipped: "校验终答无法解析为裁决 JSON", raw: text.slice(0, 300) };
	return { verdicts };
}

/** 校验器的系统提示（判据走 user 消息，避免与注入模板争语义）；保持极短，注意力全给判据与候选。 */
const SYSTEM_FRAMING =
	"你是后台记忆价值审查员，只输出 JSON，不解释。你的唯一判断标准是用户消息里给出的判据原文；" +
	"不评价事实对错、不评价格式、不重写内容。";

/** 供调用方按裁决切分 records（纯函数，可测）。 */
export interface AppliedVerdicts<T> {
	kept: T[];
	dropped: Array<{ record: T; reason: string }>;
	retyped: Array<{ record: T; from: string; to: string; reason: string }>;
}

/**
 * 按裁决切分候选记录：`drop` 剔除、`retype` 改类型并留痕、`keep` 原样。
 * 不修改入参（返回新数组），校验器**不负责重写内容**。
 */
export function applyVerdicts<T extends { type?: unknown }>(
	records: T[],
	verdicts: ValueVerdict[] | null,
): AppliedVerdicts<T> {
	if (!verdicts) return { kept: [...records], dropped: [], retyped: [] };
	const byIndex = new Map(verdicts.map((v) => [v.i, v]));
	const kept: T[] = [];
	const dropped: Array<{ record: T; reason: string }> = [];
	const retyped: Array<{ record: T; from: string; to: string; reason: string }> = [];

	records.forEach((rec, i) => {
		const v = byIndex.get(i);
		if (v?.v === "drop") {
			dropped.push({ record: rec, reason: v.r ?? "" });
			return;
		}
		if (v?.v === "retype" && v.t) {
			const from = String(rec.type ?? "");
			const next = { ...(rec as Record<string, unknown>), type: v.t } as T;
			const md = (next as { metadata?: unknown }).metadata;
			(next as { metadata?: unknown }).metadata = {
				...((md && typeof md === "object" ? md : {}) as Record<string, unknown>),
				valueCheck: { verdict: "retype", from, to: v.t, reason: v.r ?? "" },
			};
			retyped.push({ record: next, from, to: v.t, reason: v.r ?? "" });
			kept.push(next);
			return;
		}
		kept.push(rec);
	});
	return { kept, dropped, retyped };
}
