// ============================================================================
// memory/l2/archive-tool.ts — `l2_archive_guide`：**按需**给出归档规则 + 事实清单（2026-09-27）
//
// 形态照仓库既有的 `load_memory_rules`：平时**零注入**（规则文本不常驻在任务消息或规则文件里），
// 子代理判断"库满了、需要腾名额"时调一次，规则正文与当前事实一起进上下文。
//
// 为什么渐进式（而不是常驻）：常驻方案要把规则写进 `memory/l2/prompts/scene-extraction*.md`，
// 而那两份文件每轮都被**整份 read**（26–41 KB），等于每轮都付这段文本；改成按需则只在真要腾名额时才付。
// 代价是满库那一轮多一次工具往返（实测单次生成中位 42s、最长 348s），但那种情况一年也就十几次。
//
// **只读纪律**：本工具不得写任何文件。它经 `buildArchiveFacts()` 读事实，后者只读 JSON 侧车
// （**绝不构造 `L1HitStatsDB`** —— 那个构造函数会建目录、开 WAL 并重写生产侧车）。
// 补账/自愈是 `reconcileArchive()` 的事，只由搬移路径调用。
// ============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildArchiveFacts, checkArchiveHardBlocks, type SceneBlockFacts } from "./archive-facts.ts";
import { archivedBlockExists } from "./archive.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

/** 事实清单的渲染形态（给 LLM 看的表格；一列一个可复核的量）。 */
function renderFactsTable(blocks: SceneBlockFacts[]): string {
	const head = "文件名 | heat | 成员数 | 有命中记录的成员数 | 最近一次召回 | 自 updated 起活跃日 | 摘要";
	const rows = blocks.map((b) =>
		[
			b.filename,
			String(b.heat),
			String(b.memberCount),
			String(b.membersWithHits),
			b.lastHitAt ?? "从未",
			b.activeDaysSinceUpdate === null ? "未知" : String(b.activeDaysSinceUpdate),
			(b.summary || "（无摘要）").replace(/\|/g, "/"),
		].join(" | "),
	);
	return [head, "---", ...rows].join("\n");
}

export interface ArchiveGuideResult {
	enabled: boolean;
	level: string;
	sceneCount: number;
	maxScenes: number;
	archivedCount: number;
	activeDays: number;
	statsSource: string;
	/** 规则正文（registry 渲染）。 */
	guide: string;
	/** 事实清单（markdown 表格文本）。 */
	facts: string;
	/** 传了 filename 时：该块的硬拦结论。 */
	verdict?: { filename: string; ok: boolean; code?: string; message?: string };
	note: string;
}

/**
 * 组装工具返回（**纯函数**，供离线回归直调）。
 */
export function buildArchiveGuide(profilePath: string, filename?: string, nowMs: number = Date.now()): ArchiveGuideResult {
	const f = buildArchiveFacts(profilePath, nowMs);
	let verdict: ArchiveGuideResult["verdict"];
	if (filename) {
		const row = f.blocks.find((b) => b.filename === filename);
		if (!row) {
			verdict = { filename, ok: false, code: "not-found", message: "live 场景目录里没有这个块（它可能已经被归档了：用 restore 搬回）" };
		} else {
			const v = checkArchiveHardBlocks({
				ageCalendarDays: row.ageCalendarDays,
				minAgeCalendarDays: f.archive.minAgeCalendarDays,
				nameConflict: archivedBlockExists(profilePath, filename),
			});
			verdict = { filename, ok: v.ok, code: v.code, message: v.message };
		}
	}
	const notes: string[] = [];
	if (!f.archive.enabled) notes.push("⚠️ 归档层已被配置关闭（l2.archive.enabled=false）：本批不能新归档，改用合并或 UPDATE。");
	if (f.level === "none" || f.level === "yellow") notes.push("当前未到橙/红级 —— 名额不紧张时优先 UPDATE，别急着搬。");
	if (f.statsSource === "none") notes.push("⚠️ 没读到命中统计侧车，清单里的命中列不可信（不影响归档判断，主进程只按事实展示）。");
	notes.push(`最多可搬 ${f.archive.maxPerBatch} 个/批；搬走的块可用 {action:"restore"} 搬回。`);
	return {
		enabled: f.archive.enabled,
		level: f.level,
		sceneCount: f.count,
		maxScenes: f.maxScenes,
		archivedCount: f.archive.archivedCount,
		activeDays: f.activeDays,
		statsSource: f.statsSource,
		guide: renderPrompt("guides/l2-archive"),
		facts: renderFactsTable(f.blocks),
		...(verdict ? { verdict } : {}),
		note: notes.join(" "),
	};
}

/** 注册 `l2_archive_guide`（**必须在 index.ts 模块顶层调用**，否则子代理进程拿不到）。 */
export function registerL2ArchiveGuideTool(pi: ExtensionAPI, getProfilePath: () => string | undefined): void {
	pi.registerTool({
		name: "l2_archive_guide",
		label: "L2 Archive Guide",
		description: renderPrompt("tools#l2_archive_guide"),
		parameters: {
			type: "object",
			properties: {
				filename: {
					type: "string",
					description:
						"Optional: a scene block filename to check before spending a commit — returns whether it is archivable and why not (age / name conflict).",
				},
			},
			required: [],
		},
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const profilePath = getProfilePath();
			if (!profilePath) {
				return { content: [{ type: "text", text: JSON.stringify({ error: "No active profile" }) }], details: {} };
			}
			const raw = (params ?? {}) as { filename?: unknown };
			const filename = typeof raw.filename === "string" && raw.filename.trim().length > 0 ? raw.filename.trim() : undefined;
			try {
				return {
					content: [{ type: "text", text: JSON.stringify(buildArchiveGuide(profilePath, filename)) }],
					details: {},
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: JSON.stringify({ error: `读取归档事实失败：${e instanceof Error ? e.message : String(e)}` }) }],
					details: {},
				};
			}
		},
	});
}
