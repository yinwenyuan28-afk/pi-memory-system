import type { FilterResult } from "./types.ts";

// ══════════════════════════════════════════════════════════════
// ⚠ 孤儿保留（2026-09-12）——本文件当前【无任何调用方】，删除前请先读下文。
//
// 背景：唯一调用链曾是 `handleMemoryTool`（core/tool.ts，已随旧写入通道退役删除）。
// 保留理由：`记忆系统提示词注入点分析.md` §7 缺口的 P1-1 明确将它列为**新写链内容过滤的候选实现**
// —— 建议在 `l1_commit` 写入循环与 `l1_fix` 的 runFix 入口复用其阻断规则。若在此删除，
// 该加固建议将失去现成实现（需重写）。
//
// 依赖：仅 `import type { FilterResult } from "./types.ts"`，无其他模块依赖，保留不影响编译。
// 处置：待 P1-1 落地接线，或经评估后另立计划删除。
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// 阻断规则（安全红线，强制拒绝）
// ══════════════════════════════════════════════════════════════

interface BlockRule {
	pattern: RegExp;
	id: string;
	reason: string;
	/** target 过滤：规则只在特定 target 下生效。空 = 所有 target */
	targets?: string[];
}

const BLOCK_RULES: BlockRule[] = [
	// ── 威胁规则 1：提示注入 ──
	{
		pattern: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i,
		id: "prompt-injection",
		reason: "检测到提示注入模式。",
	},
	// ── 威胁规则 2：敏感信息泄露 ──
	{
		pattern: /输出.*(?:密码|token|密钥|api.?key|secret|access_key)/i,
		id: "exfil-secret",
		reason: "检测到可能泄露敏感信息。",
	},
	// ── 威胁规则 3：角色劫持 ──
	{
		pattern: /(?:你是|你是|你现在是|从现在起你).{0,10}(?:免费|解放|自由|released|liberated|unshackled)/i,
		id: "role-hijack",
		reason: "检测到角色劫持模式。",
	},
];

// ══════════════════════════════════════════════════════════════
// 建议规则（不阻断，只 warning — 价值判断交给 LLM）
// ══════════════════════════════════════════════════════════════

interface AdvisoryRule {
	pattern: RegExp;
	id: string;
	message: string;
	targets?: string[];
}

const ADVISORY_RULES: AdvisoryRule[] = [
	// ── 规则 1：会话临时错误 ──
	{
		pattern:
			/(?:error|错误|失败|找不到|不是内部或外部命令|ENOENT|ETIMEOUT|ConnectTimeout)\s*(?:[,，]|。?\s*)?(?:重试|重新|已解决|恢复正常|第二次成功|装好|配置正确|修复了|好了)/i,
		id: "temp-error",
		message:
			"ADVISORY: This looks like a transient error that was retried to success.\n" +
			"  If it describes a root cause + fix (not just retry), it's worth saving.\n" +
			"  The LLM SAVE_GUIDELINES in MEMORY_SCHEMA can help decide.",
	},
	// ── 规则 2：负面工具断言 ──
	{
		pattern:
			/\b(?:browser|edit|bash|grep|read|write|find|ls|tool|工具|功能|命令)\s*(?:不\w{1,4}(?:用了?|行|好)?|坏了|无效|不能用|弄坏了?|出问题了?|not working|broken|failed)/i,
		id: "negative-tool",
		message:
			"ADVISORY: This looks like a negative tool assertion.\n" +
			"  If it describes a real constraint with a workaround, save the workaround.\n" +
			"  If it's just a complaint, skip it.",
	},
	// ── 规则 3：一次性任务 ──
	{
		pattern:
			/(?:分析|总结|审查|评估|检查|review|analyze|summarize)\s*(?:了)?\s*(?:今天|本周|这个月|这次|当前).{0,20}(?:走势|情况|报告|状态|变更|PR|issue|代码)/i,
		id: "oneoff-task",
		message:
			"ADVISORY: This looks like a one-off task narrative.\n" +
			"  If it describes a reusable workflow preference, save that.\n" +
			"  If it's just reporting task completion, skip.",
	},
	// ── 规则 4：环境依赖失败 ──
	{
		pattern:
			/(?:command not found|'[^']+' 不是内部或外部命令|没有安装|未安装|找不到命令|请检查.*(?:安装|环境变量|路径))/i,
		id: "env-failure",
		message:
			"ADVISORY: This looks like an environment setup failure.\n" +
			"  If it describes a non-trivial install procedure, save that.\n" +
			"  If it's just 'missing package', skip.",
	},
	// ── 规则 5：开发日志 / 修复记录 ──
	{
		pattern: /(?:开发记录|修复记录|设计迭代|版本迭代|v\d\s*[→-]\s*v\d|P\d\s*修复|本系统开发过程|迭代过程|改动过程)/i,
		id: "dev-log",
		message:
			"ADVISORY: This looks like a dev log or fix record.\n" +
			"  If it describes current architecture/strategy, save that.\n" +
			"  If it's version iteration notes, put in project docs instead.",
	},
	// ── 规则 6：项目配置 / 架构文档 ──
	{
		pattern:
			/(?:仓库信息|项目配置|构建命令|启动方式|源码目录|安装位置|已知 Bug|已知风险|架构概览|架构总览|系统架构|对比 Hermes|Hermes 对比|归档系统|Registry|Index)/i,
		id: "project-config",
		message:
			"ADVISORY: This looks like project config or architecture info.\n" +
			"  If it's a non-obvious config fact, save as sub-memory.\n" +
			"  If it's already in project docs (AGENTS.md / plan/), skip.",
	},
	// ── content-lint：memory target 但看起来像项目信息 ──
	{
		pattern: /(?:路径|配置|端口|版本|依赖|install|config|setup|部署|C:\\|\/mnt|server|localhost|:\d{4,5})/i,
		id: "looks-like-project",
		message:
			"WARNING: This content looks like project-specific info (path, config, version, deploy).\n" +
			"  Use target='sub-memory' with path='{scope}/{name}.md' so routing can auto-load it.\n" +
			"  Proceeding with target='memory'.",
		targets: ["memory"],
	},
	// ── content-lint：memory target 但看起来像用户属性 ──
	{
		pattern: /(?:喜欢|不喜欢|偏好|习惯|觉得|想要|希望|讨厌|prefer|like|风格|风格)/i,
		id: "looks-like-user",
		message:
			"WARNING: This content looks like a user attribute (preference, habit, style).\n" +
			"  Use target='user' for personalization; 'memory' is for global env facts.\n" +
			"  Proceeding with target='memory'.",
		targets: ["memory"],
	},
];

// ══════════════════════════════════════════════════════════════

/**
 * 内容过滤器 —— 代码级正则匹配，不调 LLM。
 *
 * 双层设计：
 *   1. BLOCK_RULES（安全红线）：prompt-injection / exfil-secret / role-hijack → 强制拒绝
 *   2. ADVISORY_RULES（建议规则）：价值判断类规则（temp-error / negative-tool 等）→ 只 warning，不阻断
 *
 * 价值判断规则已转为 LLM prompt 注入到 MEMORY_SCHEMA.description 和子代理 prompt 中，
 * 代码层不再做强制阻断。安全红线仍由代码兜底。
 *
 * 纯函数，不读磁盘，不产生副作用。
 */
export class ContentFilter {
	check(content: string, target?: string): FilterResult {
		if (!content) return { blocked: false };

		// 1. 阻断规则（安全红线）
		for (const rule of BLOCK_RULES) {
			if (rule.targets && target && !rule.targets.includes(target)) continue;
			if (rule.pattern.test(content)) {
				return { blocked: true, reason: rule.reason, ruleId: rule.id };
			}
		}

		// 2. 建议规则（只 warning，不阻断）
		let warning = "";
		let suggestTarget: string | undefined;
		for (const rule of ADVISORY_RULES) {
			if (rule.targets && target && !rule.targets.includes(target)) continue;
			if (rule.pattern.test(content)) {
				warning = rule.message;
				if (rule.id === "looks-like-project") suggestTarget = "sub-memory";
				if (rule.id === "looks-like-user") suggestTarget = "user";
				break;
			}
		}

		return { blocked: false, warning, suggestTarget };
	}
}
