// ══════════════════════════════════════════════════════════════
//  session JSONL 共享解析（parseSessionLines）
//
//  从 review/review-cursor.ts 拆出（2026-08-17 目录整理，方案 C）：
//  供 L0 归档（l0/index.ts）与未来 L1 提取共用；review 域保留原
//  scanSessionFile 实现不动（避免回归），两者解析语义对齐。
// ══════════════════════════════════════════════════════════════

/**
 * 单条已解析的 session 消息（L0 归档的原始输入）。
 *
 * 用途：memory/l0.ts 与未来 L1 提取共用；review-cursor 的 scanSessionFile
 * 保持原实现不动（避免回归），两者解析语义对齐（text 块提取 / hasText /
 * hasToolCall 判定一致）。
 */
export interface ParsedSessionMessage {
	/** 行号（1-indexed），L0 游标以此推进。 */
	line: number;
	/** message.role：user / assistant / toolResult / custom 等。 */
	role: string;
	/** 文本内容：字符串 content 直接取；数组 content 只拼 type="text" 块。 */
	content: string;
	/** message.id（若存在，供 L0 记录溯源）。 */
	id?: string;
	/** 时间戳（epoch ms）：优先 entry.timestamp，回退 message.timestamp。 */
	timestamp?: number;
	/** 是否含非空 text 块（与 scanSessionFile 的 lastAssistantHasText 语义对齐）。 */
	hasText: boolean;
	/** 是否含 toolCall 块（与 scanSessionFile 的完成检测语义对齐）。 */
	hasToolCall: boolean;
}

/**
 * 解析 session JSONL 的指定行段，提取 type === "message" 的结构化消息。
 *
 * @param lines session 文件按行分割后的数组（含空行，内部会跳过）
 * @param startLine 首行对应的实际行号（默认 1）；L0 增量解析时传游标+1，保证 line 字段对齐文件真实行号
 * @returns 按行序排列的消息数组；JSON 解析失败或非 message 条目跳过
 */
export function parseSessionLines(lines: string[], startLine = 1): ParsedSessionMessage[] {
	const result: ParsedSessionMessage[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;

		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // 格式容错：坏行跳过
		}

		if (entry?.type !== "message") continue; // compaction/custom/model_change 等条目跳过
		const msg = entry.message;
		if (!msg) continue;

		const role = typeof msg.role === "string" ? msg.role : "";
		const raw = msg.content;
		let content = "";
		let hasText = false;
		let hasToolCall = false;

		if (typeof raw === "string") {
			content = raw;
			hasText = raw.trim().length > 0;
		} else if (Array.isArray(raw)) {
			const parts: string[] = [];
			for (const p of raw) {
				if (!p || typeof p !== "object") continue;
				const blockType = (p as Record<string, unknown>).type;
				if (blockType === "text") {
					const text = (p as Record<string, unknown>).text;
					if (typeof text === "string") {
						parts.push(text);
						if (text) hasText = true; // 非空 text 才算“有回复”
					}
				} else if (blockType === "toolCall") {
					hasToolCall = true;
				}
			}
			content = parts.join("\n");
		}

		// 时间戳：优先 entry.timestamp（ISO 或 epoch），回退 message.timestamp
		let timestamp: number | undefined;
		if (typeof entry.timestamp === "number") {
			timestamp = entry.timestamp;
		} else if (typeof entry.timestamp === "string") {
			const parsed = Date.parse(entry.timestamp);
			if (!Number.isNaN(parsed)) timestamp = parsed;
		}
		if (timestamp === undefined && typeof msg.timestamp === "number") {
			timestamp = msg.timestamp;
		}

		result.push({
			line: startLine + i,
			role,
			content: content.trim(),
			id: typeof msg.id === "string" && msg.id ? msg.id : undefined,
			timestamp,
			hasText,
			hasToolCall,
		});
	}

	return result;
}
