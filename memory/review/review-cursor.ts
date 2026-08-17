import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 审查游标管理模块。
 *
 * 解决后台审查子代理（memory-reviewer / skill-reviewer）的四个问题：
 *   1. 覆盖不完整：固定末尾 2400 行窗口会丢大型工作流的前半部分
 *   2. 多工作流混合：窗口内多条用户消息混在一起分析
 *   3. 半途状态：工作流未完成即触发审查，读到截断的工具调用序列
 *   4. 重复学习：无游标，同一工作流跨多次审查被反复读取学习
 *
 * 设计：
 *   - A. 审查游标：记录上次审查到的行号，每次只读增量（根治重复学习）
 *   - B. 数量硬上限：增量区间内用户消息数超限时只保留最近 N 条
 *      （任务边界识别交给 LLM agent，代码不做时间启发式——工作流可能横跨多天）
 *   - C. 未完成检测：末尾 user 消息无 assistant text 回复时跳过本次审查
 *
 * cursor 文件：{profilePath}/review-cursor.json
 * 结构：{ "memoryReviewer": { "sessionPath": "...", "line": 123 }, "skillReviewer": {...} }
 */

const CURSOR_FILE = "review-cursor.json";

/** 每次审查最多覆盖的用户消息数（防止审查间隔太久导致区间爆炸）。 */
export const MAX_USER_MSGS = 10;

/** 游标结构。 */
interface CursorEntry {
	sessionPath: string;
	line: number;
}

/** 审查范围计算结果。 */
export interface ReviewRange {
	/** 本次应审查的起始行（1-indexed，含）。 */
	startLine: number;
	/** 本次应审查的结束行（1-indexed，含）。 */
	endLine: number;
	/** 范围内所有用户消息的行号（供 agent 识别任务边界）。 */
	userMessageLines: number[];
	/** 末尾工作流是否已完成。false = 最后一条 user 消息无 assistant text 回复，应跳过本次审查。 */
	complete: boolean;
	/** 新会话（游标与当前 session 不匹配），startLine 从 1 开始。 */
	isNewSession: boolean;
}

/** 读取某 reviewer 的游标。 */
export function loadCursor(profilePath: string, key: string): CursorEntry | null {
	const filePath = join(profilePath, CURSOR_FILE);
	if (!existsSync(filePath)) return null;
	try {
		const raw = readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw) as Record<string, CursorEntry>;
		const entry = data[key];
		if (!entry || typeof entry.line !== "number") return null;
		return entry;
	} catch {
		return null;
	}
}

/** 写入某 reviewer 的游标（原子写）。 */
export function saveCursor(profilePath: string, key: string, sessionPath: string, line: number): void {
	const filePath = join(profilePath, CURSOR_FILE);
	let data: Record<string, CursorEntry> = {};
	if (existsSync(filePath)) {
		try {
			data = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, CursorEntry>;
		} catch {
			data = {};
		}
	}
	data[key] = { sessionPath, line };
	const tmpPath = join(profilePath, `.tmp_cursor_${Date.now()}`);
	writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
	// 重命名覆盖（Windows 上 renameSync 目标已存在会抛错，先删后写）
	try {
		rmSync(filePath, { force: true });
	} catch {
		// ignore
	}
	try {
		renameSync(tmpPath, filePath);
	} catch {
		// 目标可能被占用（罕见并发），回退为直接写
		writeFileSync(filePath, readFileSync(tmpPath, "utf-8"), "utf-8");
	}
	try {
		rmSync(tmpPath, { force: true });
	} catch {
		// ignore
	}
}

/**
 * 计算本次审查的读取范围。
 *
 * @param sessionPath 当前 session 文件路径
 * @param cursorLine 上次审查到的行号（0 表示无游标）
 * @param totalLines session 文件总行数（由调用方读取，避免重复 IO）
 * @param userMessageLines 所有用户消息行号（由调用方扫描传入）
 * @param lastAssistantHasText 最后一条 assistant 消息是否含 text 回复
 * @param maxUserMsgs 数量上限
 */
export function computeReviewRange(
	sessionPath: string,
	cursorLine: number,
	totalLines: number,
	userMessageLines: number[],
	lastAssistantHasText: boolean,
	maxUserMsgs = MAX_USER_MSGS,
): ReviewRange {
	// C：未完成检测——末尾无完整回复则跳过本次
	if (!lastAssistantHasText) {
		return {
			startLine: 1,
			endLine: totalLines,
			userMessageLines,
			complete: false,
			isNewSession: cursorLine === 0,
		};
	}

	// A：游标增量。新会话（cursorLine=0）从第 1 行开始
	const startFromCursor = cursorLine > 0 ? cursorLine + 1 : 1;

	// B：数量硬上限——只保留最近 maxUserMsgs 条用户消息
	let startLine = startFromCursor;
	const inRangeUserMsgs = userMessageLines.filter((l) => l >= startFromCursor);
	if (inRangeUserMsgs.length > maxUserMsgs) {
		startLine = inRangeUserMsgs[inRangeUserMsgs.length - maxUserMsgs];
	}

	const inRange = userMessageLines.filter((l) => l >= startLine);

	return {
		startLine,
		endLine: totalLines,
		userMessageLines: inRange,
		complete: true,
		isNewSession: cursorLine === 0,
	};
}

/**
 * 轻量检测：session 末尾工作流是否已完成。
 * 只读最后一段（默认 200 行），用于 agent_settled 快速跳过半途状态，避免全量扫描。
 * 返回 true 表示末尾有完整的 assistant text 回复（或文件过小无法判断）。
 */
export function hasCompleteEnding(sessionPath: string, tailLines = 200): boolean {
	if (!existsSync(sessionPath)) return true;
	try {
		const raw = readFileSync(sessionPath, "utf-8");
		const lines = raw.split(/\r?\n/).filter((l) => l.trim());
		const tail = lines.slice(-tailLines);

		let lastAssistantHasText = false;
		for (const line of tail) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;
			if (msg.role === "user") {
				lastAssistantHasText = false;
			} else if (msg.role === "assistant") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasText = content.some((p: any) => p?.type === "text" && p?.text);
					const hasToolCall = content.some((p: any) => p?.type === "toolCall");
					if (hasText) lastAssistantHasText = true;
					else if (hasToolCall) lastAssistantHasText = false;
				} else if (typeof content === "string" && content.trim()) {
					lastAssistantHasText = true;
				}
			}
		}
		return lastAssistantHasText;
	} catch {
		return true;
	}
}

/**
 * 读取 session 文件并解析审查所需的结构信息。
 * 返回 null 表示文件不可读。
 */
export function scanSessionFile(sessionPath: string): {
	totalLines: number;
	userMessageLines: number[];
	lastAssistantHasText: boolean;
} | null {
	if (!existsSync(sessionPath)) return null;
	try {
		const raw = readFileSync(sessionPath, "utf-8");
		const lines = raw.split(/\r?\n/);
		const userMessageLines: number[] = [];
		let lastAssistantHasText = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;
			if (msg.role === "user") {
				userMessageLines.push(i + 1);
				lastAssistantHasText = false; // 用户发言后重置
			} else if (msg.role === "assistant") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasText = content.some((p: any) => p?.type === "text" && p?.text);
					const hasToolCall = content.some((p: any) => p?.type === "toolCall");
					if (hasText) lastAssistantHasText = true;
					else if (hasToolCall) lastAssistantHasText = false; // 只有工具调用 → 未完成
				} else if (typeof content === "string" && content.trim()) {
					lastAssistantHasText = true;
				}
			}
		}

		return { totalLines: lines.length, userMessageLines, lastAssistantHasText };
	} catch {
		return null;
	}
}

