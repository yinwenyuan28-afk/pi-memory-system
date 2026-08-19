import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../paths.js";

// ══════════════════════════════════════════════════════════════
//  L0 降噪规则（SanitizeRule 可扩展机制）
//
//  设计（对照 TencentDB-Agent-Memory sanitize.ts 裁剪 + pi 特有规则）：
//    - generic   ：跨框架通用（行首时间戳 / NUL / 换行压缩）
//    - memory    ：记忆注入标签（防反馈循环）
//    - framework ：pi 宿主特有（/skill: 展开块剥离、粘贴日志压缩）
//    - custom    ：外部 l0-sanitize-rules.json 追加的规则（后续遇新噪音改 JSON 不动代码）
//  有意不抄腾讯的：代码块剥离（编程场景代码块价值最高，用户拍板保留）、
//  OpenClaw 特有噪音（inbound 元数据块 / [[reply_to]] / ¥¥[]¥¥ / bootstrap / NO_REPLY 等，
//  勘察确认 pi 不注入，设了反而误伤——真实 session 验证 7 处 SYSTEM 命中全是对话内容）。
// ══════════════════════════════════════════════════════════════

/** 规则作用对象：user / assistant / both。 */
export type RuleApplyTo = "user" | "assistant" | "both";

/** 规则来源分组。 */
export type RuleGroup = "generic" | "memory" | "framework" | "custom";

/**
 * 单条降噪规则。
 *
 * 两种执行形态：
 *  - pattern + replace：普通正则替换（replace 可为字符串或函数）
 *  - handler：需要上下文的复杂规则（如跨行日志聚合），提供 text → text 转换
 */
export interface SanitizeRule {
	/** 规则唯一标识（外部规则重名时内置表让位给外部）。 */
	id: string;
	/** 匹配正则（与 replace 配合使用）。 */
	pattern?: RegExp;
	/** 替换目标：字符串直接替换；函数接收 (全文, ...捕获组) 返回替换结果。 */
	replace?: string | ((sub: string, ...groups: string[]) => string);
	/** 复杂规则处理器（优先级高于 pattern+replace）。 */
	handler?: (text: string) => string;
	/** 作用消息角色。 */
	applyTo: RuleApplyTo;
	/** 来源分组。 */
	group: RuleGroup;
	/** 是否启用（默认 true）。 */
	enabled?: boolean;
}

/** 外部规则文件（l0-sanitize-rules.json）的单项格式——JSON 无法表达函数，replace 仅字符串。 */
export interface ExternalSanitizeRule {
	id: string;
	pattern: string;
	flags?: string;
	replace?: string;
	applyTo: RuleApplyTo;
	enabled?: boolean;
}

/** 外部规则文件整体格式。 */
export interface ExternalRulesFile {
	rules: ExternalSanitizeRule[];
}

// ── 日志块压缩配置（编程场景特有：用户常整段粘贴后端日志） ──

/** 连续日志行达到此数量才视为日志块（防止误伤含时间戳的普通文本）。 */
export const MIN_LOG_BLOCK_LINES = 5;
/** 日志块压缩后保留的头部行数（保住报错上下文）。 */
export const KEEP_LOG_LINES = 3;

/** 单行日志识别：`15:39:33 [http-nio-19091-exec-6] INFO c.i.f...`（允许行前有少量前缀文本）。 */
const LOG_LINE_RE = /(?:\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s*\[[^\]]*\]\s+(?:INFO|WARN|ERROR|DEBUG|TRACE)\b/i;

/**
 * 日志块压缩处理器：识别连续日志行，聚合为「保留头部 N 行 + 块标记」。
 *
 * 背景（真实验证 2026-08-17）：A104527 会话中 user 消息含 46KB 整段后端日志，
 * 单条注入会撑爆 L0 分片、污染后续 L1 提取。压缩后既防膨胀又保住报错关键行。
 */
function compressLogBlock(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() && LOG_LINE_RE.test(line)) {
			// 收集连续日志行
			let j = i;
			let totalChars = 0;
			while (j < lines.length && lines[j].trim() && LOG_LINE_RE.test(lines[j])) {
				totalChars += lines[j].length;
				j++;
			}
			const blockCount = j - i;
			if (blockCount >= MIN_LOG_BLOCK_LINES) {
				out.push(...lines.slice(i, i + KEEP_LOG_LINES));
				out.push(`[log-block: ${blockCount} lines, ${totalChars} chars]`);
			} else {
				out.push(...lines.slice(i, j));
			}
			i = j;
		} else {
			out.push(line);
			i++;
		}
	}
	return out.join("\n");
}

// ── 框架噪音剥离（pi 特有，2026-08-19） ──────────────────────────

/**
 * pi TUI 终端状态回显噪音剥离。
 *
 * 背景（真实样本 2026-08-17 分片，12260 字 user 消息）：pi 的终端 UI 会把
 * 自身状态渲染（进度条、扩展 UI 请求、agent 生命周期事件）混入会话内容，
 * 形成 `{"type":"extension_ui_request",...}` / `{"type":"agent_start"}` /
 * `completed:──────` / `1.043 18.5%/1.0M (auto)` 这类框架噪音。对记忆/技能
 * 提取均无价值，整行剥离。
 *
 * 实现：逐行判断（比单条正则稳），命中以下任一形态整行删除：
 *   ① 框架事件 JSON 行（行首 `{"type":"<框架类型>"`，白名单防误伤对话中的
 *      普通 JSON 字面量，如 {"type":"text"}）
 *   ② 进度条行（completed:──）
 *   ③ 终端状态栏行（`1.043 18.5%/1.0M (auto)` 形态）
 * 注意：JSON 后跟状态栏杂讯（同一行）也会被整行删除——这类行本质就是 UI 回显。
 */
const FRAMEWORK_NOISE_TYPES = [
	"extension_ui_request",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"response",
	"request_start",
	"request_stop",
	"ping",
	"stream_event",
	"connection_init",
];

const FRAMEWORK_NOISE_JSON_RE = new RegExp(
	`^\\{\\s*"type"\\s*:\\s*"(?:${FRAMEWORK_NOISE_TYPES.join("|")})"`,
);
const FRAMEWORK_PROGRESS_BAR_RE = /^completed:[─\-—]+/;
// 终端状态栏行：`1.043 18.5%/1.0M (auto)` / `USER.md: 3 entries (unchanged)19.8%/1.0M (auto)`
// 特征：`%/<容量> (auto)` 之后是行尾或 ≥3 个空白再跟模型名（如 deepseek-v4-flash • high）。
// 行中文字（如"占比 15%/1.0M (auto) 这个先不管"）不含大段空白，不误伤。
const FRAMEWORK_STATUS_LINE_RE =
	/^.*?\d+(?:\.\d+)?%\/[\d.]+[KMGT]?\s+\(auto\)(?:[ \t]{3,}.*)?$/;

function stripFrameworkNoise(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const t = line.trim();
			if (!t) return line;
			if (FRAMEWORK_NOISE_JSON_RE.test(t)) return "";
			if (FRAMEWORK_PROGRESS_BAR_RE.test(t)) return "";
			if (FRAMEWORK_STATUS_LINE_RE.test(t)) return "";
			return line;
		})
		.join("\n");
}

// ── 内置规则表 ──

/** skill 块剥离：`<skill name="..." location="...">...</skill>`，保留块后 args（真实用户输入）。 */
function stripSkillBlock(sub: string, args?: string): string {
	return args ? args.trim() : "";
}

/** 内置默认规则（勘察收敛，2026-08-16/17）。 */
export const BUILTIN_RULES: SanitizeRule[] = [
	// ── framework：pi 特有 ──
	{
		id: "pi-skill-block",
		pattern: /<skill name="[^"]*" location="[^"]*">[\s\S]*?<\/skill>(?:\n\n([\s\S]+))?/,
		replace: stripSkillBlock,
		applyTo: "user",
		group: "framework",
	},
	{
		id: "log-block-compress",
		handler: compressLogBlock,
		applyTo: "user",
		group: "framework",
	},
	{
		id: "pi-framework-noise",
		// 2026-08-19：pi TUI 终端状态回显被混入 session（真实样本 12260 字 user 消息）。
		// 剥离框架事件 JSON（extension_ui_request / agent_start / turn_start / response 等）
		// 与终端进度条行（completed:── / 1.043 18.5%/1.0M (auto)）。
		handler: stripFrameworkNoise,
		applyTo: "both",
		group: "framework",
	},
	// ── memory：记忆注入标签（防反馈循环，照抄腾讯） ──
	{
		id: "tag-relevant-memories",
		pattern: /<relevant-memories(?:\s[^>]*)?>[\s\S]*?<\/relevant-memories>/g,
		replace: "",
		applyTo: "both",
		group: "memory",
	},
	{
		id: "tag-user-persona",
		pattern: /<user-persona(?:\s[^>]*)?>[\s\S]*?<\/user-persona>/g,
		replace: "",
		applyTo: "both",
		group: "memory",
	},
	{
		id: "tag-relevant-scenes",
		pattern: /<relevant-scenes(?:\s[^>]*)?>[\s\S]*?<\/relevant-scenes>/g,
		replace: "",
		applyTo: "both",
		group: "memory",
	},
	{
		id: "tag-scene-navigation",
		pattern: /<scene-navigation(?:\s[^>]*)?>[\s\S]*?<\/scene-navigation>/g,
		replace: "",
		applyTo: "both",
		group: "memory",
	},
	// ── generic：跨框架通用 ──
	{
		id: "line-leading-timestamp",
		pattern: /^\[[\w\d\-:+ ]+\]\s*/gm,
		replace: "",
		applyTo: "both",
		group: "generic",
	},
	{
		id: "nul-chars",
		pattern: /\0/g,
		replace: "",
		applyTo: "both",
		group: "generic",
	},
	{
		id: "collapse-newlines",
		pattern: /\n{3,}/g,
		replace: "\n\n",
		applyTo: "both",
		group: "generic",
	},
];

// ── base64 图片处理 ──

/** base64 图片数据 → [image] 占位符（保留"该消息含图"的信号，防污染后续索引）。 */
export function replaceBase64WithImage(text: string): string {
	return text.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, "[image]");
}

// ── 外部规则加载 ──

/**
 * 从 {memoryDB}/l0-sanitize-rules.json 加载外部追加规则。
 * 合并到内置表之后执行；重名 id 覆盖内置（外部优先）。
 * 文件不存在或非法时返回空数组（静默）。
 */
export function loadExternalRules(profilePath: string): SanitizeRule[] {
	const filePath = join(profilePath, MEMORY_DB_DIR, "l0-sanitize-rules.json");
	if (!existsSync(filePath)) return [];

	try {
		const raw = readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw) as ExternalRulesFile;
		if (!Array.isArray(data.rules)) return [];

		return data.rules
			.filter((r) => r && typeof r.id === "string" && typeof r.pattern === "string")
			.map((r) => ({
				id: r.id,
				pattern: new RegExp(r.pattern, r.flags || ""),
				replace: r.replace ?? "",
				applyTo: r.applyTo === "assistant" ? "assistant" : r.applyTo === "both" ? "both" : "user",
				group: "custom" as const,
				enabled: r.enabled !== false,
			}));
	} catch {
		return [];
	}
}

// ── 主流程 ──

/**
 * 组合规则集：内置表 + 外部表（外部重名覆盖内置）。
 */
export function buildRuleSet(profilePath?: string): SanitizeRule[] {
	const merged = new Map<string, SanitizeRule>();
	for (const r of BUILTIN_RULES) merged.set(r.id, r);
	if (profilePath) {
		for (const r of loadExternalRules(profilePath)) merged.set(r.id, r);
	}
	return [...merged.values()];
}

/**
 * 对单条消息应用降噪规则。
 *
 * @param text  原始文本（已做 base64 → [image]）
 * @param role  消息角色（决定 applyTo 过滤）
 * @param rules 规则集（buildRuleSet 产物，可缓存复用）
 * @returns 降噪后的文本（不做最终 trim——由调用方过滤层处理）
 */
export function sanitizeText(text: string, role: "user" | "assistant", rules: SanitizeRule[]): string {
	let result = text;
	for (const rule of rules) {
		if (rule.enabled === false) continue;
		if (rule.applyTo !== "both" && rule.applyTo !== role) continue;

		if (rule.handler) {
			result = rule.handler(result);
		} else if (rule.pattern && rule.replace !== undefined) {
			result = result.replace(rule.pattern, rule.replace as any);
		}
	}
	return result;
}

// ── L0 过滤层（宽松，对齐腾讯 shouldCaptureL0） ──

/**
 * L0 捕获过滤——刻意宽松：只丢"结构上无用"的。
 * 内容级质量门（长度/符号/prompt 注入）留给 L1 的 shouldExtractL1。
 *
 * 规则：空消息、纯 [image] 消息；斜杠命令过滤仅对 user 生效
 * （role 不传时按 user 处理，保持 L0 调用兼容；tool_call/tool_result
 * 等工具输出以 `/` 开头很常见——如 /usr/bin/bash、/C:/dev/...——传
 * 具体角色可避开误伤，2026-08-19 skill-feed 验证发现 17 条工具输出被误杀）。
 */
export function shouldCaptureL0(
	content: string,
	role?: "user" | "assistant" | "tool_call" | "tool_result",
): boolean {
	if (!content || !content.trim()) return false;
	const slashFilter = role === undefined || role === "user";
	if (slashFilter && content.startsWith("/")) return false; // 斜杠命令是框架指令（仅 user）
	if (/^\[image\]\s*$/.test(content)) return false; // 纯图片消息无文本价值
	return true;
}
