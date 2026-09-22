import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEMORY_DB_DIR } from "../paths.ts";
import { SCENE_DIR_NAME } from "./config.ts";
import { parseSceneBlock } from "./commit-tool.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

// ══════════════════════════════════════════════════════════════
//  read_scene_blocks —— l2-scene-organizer 子代理**一次**读完候选场景块
//
//  背景（2026-09-21 实测，SUBAGENT_THROUGHPUT 的 T2）：L2 的工具只有
//  `read` / `l2_commit` / `read_l1_increment`，读场景块只能一块一块 read ——
//  实测一轮 8 次 read，而每次 read 后面都跟着一整轮模型生成（中位 42s、最长 348s），
//  光"读"就吃掉 6 分钟以上，屡屡撞到子代理超时。
//
//  关键事实：这 8 次读的**内容本来就要进上下文**（其中 5 次是必须读 —— 要 update /
//  consolidate 的块必须先有全文，因为写契约是"整块重写"）。所以批量读**不增加上下文**，
//  只是把 N 次往返压成 1 次。收益全在往返数上。
//
//  返回值约定：
//    - blocks:  每块 { filename, ok, meta, content, truncated, omitted?, error? }
//    - returned / omitted / truncated: 计数（子代理据此决定要不要补读）
//    - totalChars: 本次实际返回的正文总字符数
//
//  两道闸（防单块过大 / 库变大把上下文打爆）：
//    单块 > SINGLE_BLOCK_CHAR_LIMIT  → 截断 + truncated 标记 + 提示可单独 read
//    累计 > TOTAL_CHAR_LIMIT        → 后续块 omitted，提示分次调用
// ══════════════════════════════════════════════════════════════

/** 单块正文上限（字符）。超过即截断 —— 本次实测最大的块 45.8 KB。 */
export const SINGLE_BLOCK_CHAR_LIMIT = 24_000;
/** 单次调用返回的正文总量上限（字符）。超过即把后续块标 omitted。 */
export const TOTAL_CHAR_LIMIT = 96_000;
/** 一次调用最多接受多少个文件名（防参数滥用）。 */
export const MAX_FILENAMES = 30;

export interface SceneBlockReadItem {
	filename: string;
	ok: boolean;
	/** 块不存在 / 文件名非法时的原因 */
	error?: string;
	meta?: { created: string; updated: string; summary: string; heat: number };
	content?: string;
	/** 正文被截断（单块上限） */
	truncated?: boolean;
	/** 因单次总量上限未返回 */
	omitted?: boolean;
	chars?: number;
}

export interface SceneBlocksReadResult {
	blocks: SceneBlockReadItem[];
	returned: number;
	omitted: number;
	truncated: number;
	totalChars: number;
	error?: string;
}

/**
 * 文件名白名单：只接受**裸文件名**（挡路径穿越与绝对路径）。
 * 场景块落在 `{profile}/memoryDB/l2/scene-blocks/` 下，任何含分隔符或 `..` 的输入都拒绝。
 */
export function isPlainSceneFilename(name: string): boolean {
	if (!name || name.length > 200) return false;
	if (name.includes("/") || name.includes("\\")) return false;
	if (name.includes("..")) return false;
	if (name !== basename(name)) return false;
	return name.endsWith(".md");
}

/**
 * 读取一批场景块（纯函数：给定 profilePath + 文件名列表 → 结果；只读，不写盘）。
 * 供子代理工具调用，也供离线回归直调。
 */
export function readSceneBlocks(
	profilePath: string,
	filenames: string[],
	opts: { singleLimit?: number; totalLimit?: number } = {},
): SceneBlocksReadResult {
	const singleLimit = opts.singleLimit ?? SINGLE_BLOCK_CHAR_LIMIT;
	const totalLimit = opts.totalLimit ?? TOTAL_CHAR_LIMIT;
	const sceneDir = join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME);

	const names = Array.isArray(filenames) ? filenames.filter((f): f is string => typeof f === "string" && f.trim().length > 0) : [];
	if (names.length === 0) {
		return { blocks: [], returned: 0, omitted: 0, truncated: 0, totalChars: 0, error: "filenames 为空" };
	}
	if (names.length > MAX_FILENAMES) {
		return {
			blocks: [],
			returned: 0,
			omitted: 0,
			truncated: 0,
			totalChars: 0,
			error: `一次最多读 ${MAX_FILENAMES} 块（收到 ${names.length} 个）——请分批，或先在索引里筛掉不相关的块`,
		};
	}

	const blocks: SceneBlockReadItem[] = [];
	let totalChars = 0;
	let omitted = 0;
	let truncated = 0;

	for (const rawName of names) {
		const filename = rawName.trim();
		if (!isPlainSceneFilename(filename)) {
			blocks.push({ filename, ok: false, error: "文件名非法（只接受 scene-blocks/ 下的裸 .md 文件名）" });
			continue;
		}
		const filePath = join(sceneDir, filename);
		if (!existsSync(filePath)) {
			blocks.push({ filename, ok: false, error: "场景块不存在" });
			continue;
		}
		if (totalChars >= totalLimit) {
			omitted++;
			blocks.push({
				filename,
				ok: false,
				omitted: true,
				error: `已达单次总量上限（${totalLimit} 字符），本块未返回 —— 请再发一次 read_scene_blocks（只带它）或单独 read：${join(sceneDir, filename)}`,
			});
			continue;
		}

		let content: string;
		let meta: SceneBlockReadItem["meta"];
		try {
			const parsed = parseSceneBlock(readFileSync(filePath, "utf-8"));
			content = parsed.content;
			meta = { created: parsed.meta.created, updated: parsed.meta.updated, summary: parsed.meta.summary, heat: parsed.meta.heat };
		} catch (e) {
			blocks.push({ filename, ok: false, error: `读取/解析失败：${e instanceof Error ? e.message : String(e)}` });
			continue;
		}

		let wasTruncated = false;
		if (content.length > singleLimit) {
			content = `${content.slice(0, singleLimit)}\n\n…（本块已截断：原文超过 ${singleLimit} 字符。需要完整内容请单独 read：${join(sceneDir, filename)}）`;
			wasTruncated = true;
			truncated++;
		}
		// 剩余额度装不下本块时**不截断到半块** —— 整块留给下一次调用更划算（子代理自己决定读哪块）
		if (totalChars + content.length > totalLimit) {
			omitted++;
			blocks.push({
				filename,
				ok: false,
				omitted: true,
				error: `加上本块会超过单次总量上限（${totalLimit} 字符；已返回 ${totalChars}）—— 请再发一次 read_scene_blocks（只带它）或单独 read：${join(sceneDir, filename)}`,
			});
			continue;
		}

		totalChars += content.length;
		blocks.push({ filename, ok: true, meta, content, ...(wasTruncated ? { truncated: true } : {}), chars: content.length });
	}

	return { blocks, returned: blocks.filter((b) => b.ok).length, omitted, truncated, totalChars };
}

/** 注册 `read_scene_blocks` 工具（**必须在 index.ts 模块顶层调用**，否则子代理进程拿不到）。 */
export function registerReadSceneBlocksTool(pi: ExtensionAPI, getProfilePath: () => string | undefined): void {
	pi.registerTool({
		name: "read_scene_blocks",
		label: "Read Scene Blocks (batch)",
		description: renderPrompt("tools#read_scene_blocks"),
		parameters: {
			type: "object",
			properties: {
				filenames: {
					type: "array",
					items: { type: "string" },
					description: "要读取的场景块文件名数组（scene-blocks/ 下的裸 .md 名，来自 IndexPath 条目）",
				},
			},
			required: ["filenames"],
		},
		execute: async (_toolCallId: string, params: { filenames?: unknown }) => {
			const reply = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], details: {} });
			const profilePath = getProfilePath();
			if (!profilePath) return reply({ error: "No active profile", blocks: [] } satisfies Partial<SceneBlocksReadResult>);
			const filenames = Array.isArray(params?.filenames) ? (params.filenames as string[]) : [];
			const result = readSceneBlocks(profilePath, filenames);
			return reply({
				...result,
				hint:
					result.omitted > 0 || result.truncated > 0
						? "有块被 omitted/truncated：对**你确定要改写的块**再单独 read 一次拿全文；不需要改的块有 meta+摘要足够判断"
						: undefined,
			});
		},
	});
}
