import {
	getChangedScenes,
	hasPersonaBody,
	hasSceneFiles,
	L3_INTERVAL,
	loadL3Cursor,
	readSceneIndex,
	type SceneIndexEntry,
} from "./config.js";

export interface TriggerResult {
	should: boolean;
	reason: string;
	priority: string;
	changedScenes: SceneIndexEntry[];
}

export interface TriggerOptions {
	/** P1 显式请求（l2_commit personaSignal 或 /persona） */
	personaSignal?: boolean;
	personaReason?: string;
	/** 跳过增量跳过检查（手动 /persona 强制跑） */
	force?: boolean;
}

/**
 * 5 级触发判断（对齐腾讯 persona-trigger.ts，按优先级顺序）。
 */
export function evaluateTrigger(profilePath: string, opts: TriggerOptions = {}): TriggerResult {
	const empty = (reason = ""): TriggerResult => ({
		should: false,
		reason,
		priority: "",
		changedScenes: [],
	});

	// P1: 显式请求
	if (opts.personaSignal || opts.force) {
		const cursor = loadL3Cursor(profilePath);
		const changed = getChangedScenes(profilePath, cursor.lastPersonaUpdate);
		return {
			should: true,
			reason: opts.personaReason || (opts.force ? "手动 /persona 触发" : "L2 personaSignal 显式请求"),
			priority: "P1",
			changedScenes: changed.length > 0 ? changed : readSceneIndex(profilePath),
		};
	}

	const cursor = loadL3Cursor(profilePath);
	const index = readSceneIndex(profilePath);
	const changed = getChangedScenes(profilePath, cursor.lastPersonaUpdate);
	const hasScenes = hasSceneFiles(profilePath);
	const hasBody = hasPersonaBody(profilePath);
	const hasGenerated = cursor.lastPersonaUpdate.length > 0 || hasBody;

	// 增量跳过：已有 persona 且无变化场景
	if (!opts.force && hasBody && changed.length === 0) {
		return empty("增量跳过：无变化场景且 persona 已存在");
	}

	// P2: 冷启动
	if (index.length > 0 && !hasGenerated && hasScenes) {
		return {
			should: true,
			reason: "P2 冷启动：有场景文件且无 persona",
			priority: "P2",
			changedScenes: index,
		};
	}

	// P2.5: 恢复（曾生成但正文丢失）
	if (hasGenerated && hasScenes && !hasBody) {
		return {
			should: true,
			reason: "P2.5 恢复：persona 曾生成但 USER.md 正文丢失",
			priority: "P2.5",
			changedScenes: index,
		};
	}

	// P3: 首次场景（P2 不满足时）
	if (index.length === 1 && cursor.memoriesSinceLastPersona > 0 && !hasBody) {
		return {
			should: true,
			reason: "P3 首次 Scene Block 提取完成",
			priority: "P3",
			changedScenes: index,
		};
	}

	// P4: 记忆阈值
	if (cursor.memoriesSinceLastPersona >= L3_INTERVAL) {
		return {
			should: true,
			reason: `P4 达到阈值：${cursor.memoriesSinceLastPersona} >= ${L3_INTERVAL}`,
			priority: "P4",
			changedScenes: changed.length > 0 ? changed : index,
		};
	}

	return empty();
}
