/** L1 对 L0 追加分片的消费位置。键为分片文件名，值为已完整消费的 UTF-8 字节数。 */
export interface L1CursorState {
	version: 2;
	files: Record<string, number>;
}

export type L1CursorInput = L1CursorState | string;

export function emptyL1Cursor(): L1CursorState {
	return { version: 2, files: {} };
}

/** 解析 L1 游标文件中的新格式；旧格式保留为 ISO 字符串供迁移读取。 */
export function parseL1CursorFile(value: unknown): L1CursorInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return emptyL1Cursor();
	const data = value as Record<string, unknown>;
	if (data.version === 2 && data.files && typeof data.files === "object" && !Array.isArray(data.files)) {
		const files: Record<string, number> = {};
		for (const [name, offset] of Object.entries(data.files as Record<string, unknown>)) {
			if (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0) files[name] = offset;
		}
		return { version: 2, files };
	}
	return typeof data.lastRecordedAt === "string" ? data.lastRecordedAt : emptyL1Cursor();
}

/** 子代理通过字符串参数传游标：旧 ISO 字符串或序列化的新格式对象。 */
export function parseL1CursorToken(value: string): L1CursorInput | null {
	if (!value) return emptyL1Cursor();
	if (!value.trimStart().startsWith("{")) return value;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (parsed?.version !== 2 || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) return null;
		const files: Record<string, number> = {};
		for (const [name, offset] of Object.entries(parsed.files as Record<string, unknown>)) {
			if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return null;
			files[name] = offset;
		}
		return { version: 2, files };
	} catch {
		return null;
	}
}
