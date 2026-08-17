import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SceneIndexEntry } from "./commit-tool.js";
import { SCENE_DIR_NAME, SCENE_INDEX_PATH } from "./config.js";

// �═════════════════════════════════════════════════════════════
//  L2 场景导航注入（读侧）
//
//  定位：把场景索引（filename/summary/heat/created/updated）生成导航块，
//  注入到 LLM 上下文，让 agent 知道有哪些场景、按热度排序、按需 read 完整场景
//  （渐进式披露，不把全部场景文件灌进上下文）。
//
//  开关（用户拍板 deferred）：L2_INJECTION_ENABLED 默认 false，代码框架就位，
//  未来与 L1 召回注入一起启用。
// ══════════════════════════════════════════════════════════════

/** 注入开关：默认关闭（与 L1 注入一起等稳定后启用）。 */
export const L2_INJECTION_ENABLED = false;

const NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

const NAV_FOOTER_LOCAL = `📌 使用说明：
- Path 是 scene block 的绝对路径，可直接使用 **read** 工具读取完整内容（参数: filePath）
- 热度：该场景被记忆命中的累计次数，越高越重要
- Summary：场景的核心要点摘要`;

/** heat → 火 emoji（腾讯 1:1，视觉热度提示）。 */
function heatEmoji(heat: number): string {
	if (heat >= 1000) return " �🔥🔥🔥🔥";
	if (heat >= 500) return " 🔥🔥🔥🔥";
	if (heat >= 200) return " 🔥🔥🔥";
	if (heat >= 100) return " 🔥🔥";
	if (heat >= 50) return " 🔥";
	return "";
}

/**
 * 生成场景导航 Markdown（腾讯 generateSceneNavigation 1:1，useCos=false 模式）。
 *
 * Path 用绝对路径，agent 直接 read 读取完整场景内容（渐进式披露）。
 */
export function generateSceneNavigation(entries: SceneIndexEntry[], sceneBlocksDir: string): string {
	if (entries.length === 0) return "";

	const sorted = [...entries].sort((a, b) => b.heat - a.heat);

	const blocks = sorted.map((e) => {
		const scenePath = join(sceneBlocksDir, e.filename);
		const pathLine = `### Path: ${scenePath}`;
		const heatLine = `**热度**: ${e.heat}${heatEmoji(e.heat)}${e.updated ? ` | **更新**: ${e.updated}` : ""}`;
		const summaryLine = `Summary: ${e.summary}`;
		return `${pathLine}\n${heatLine}\n${summaryLine}`;
	});

	return `${NAV_HEADER}\n*以下是当前场景记忆的索引，可根据需要 read 读取详细内容。*\n\n${blocks.join("\n\n")}\n\n${NAV_FOOTER_LOCAL}`;
}

/** 从 persona 内容剥掉导航段（L3 预留，当前未挂）。 */
export function stripSceneNavigation(personaContent: string): string {
	const idx = personaContent.indexOf(NAV_HEADER);
	if (idx === -1) return personaContent;
	return personaContent.slice(0, idx).trimEnd();
}

/**
 * 读取场景索引条目（从 scene_index.json）。
 */
export function readSceneEntries(profilePath: string): SceneIndexEntry[] {
	const idxPath = join(profilePath, SCENE_INDEX_PATH);
	if (!existsSync(idxPath)) return [];
	try {
		const data = JSON.parse(readFileSync(idxPath, "utf-8")) as SceneIndexEntry[];
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

/**
 * 构建 L2 注入内容（开关关闭时返回 ""）。
 *
 * 包装：`<scene-context>\n[System note: ...]\n\n{导航内容}\n</scene-context>`
 * 格式与记忆注入一致（与 L1 注入对接 future，统一 anchor 在 context 事件）。
 */
export function buildL2Injection(profilePath: string): string {
	if (!L2_INJECTION_ENABLED) return "";
	const entries = readSceneEntries(profilePath);
	if (entries.length === 0) return "";
	const sceneBlocksDir = join(profilePath, SCENE_DIR_NAME);
	const nav = generateSceneNavigation(entries, sceneBlocksDir);
	return `<scene-context>\n[System note: The following is recalled scene context, NOT new user input. Treat as authoritative reference data.]\n\n${nav}\n</scene-context>`;
}
