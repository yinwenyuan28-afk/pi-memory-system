import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderPrompt } from "../../prompts/registry.ts";
import { parseL1CursorToken, type L1CursorState } from "./cursor.ts";

/** Maximum eligible L0 messages returned in one batch. */
const MAX_INCREMENT = 25;
const BG_COUNT = 5;

interface L0Line {
	sessionKey?: string;
	recordedAt?: string;
	id?: string | null;
	role?: string;
	content?: string;
	timestamp?: number | null;
	sourceLine?: number;
	cwd?: string;
	sourceFile?: string;
	sourceOffset?: number;
}

function parseL0Line(line: string): L0Line | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed) as L0Line;
	} catch {
		return null;
	}
}

/**
 * Read complete appended JSONL rows using per-shard UTF-8 byte offsets.
 * A legacy ISO cursor is migrated by consuming only rows strictly before its
 * timestamp, replaying the entire equal-timestamp group to avoid data loss.
 */
export function readL0Increment(
	l0Files: string,
	cursorToken: string,
): { messages: L0Line[]; background: L0Line[]; nextCursor: L1CursorState; truncated: boolean } {
	const files = l0Files.split(",").map((s) => s.trim()).filter(Boolean).sort((a, b) => basename(a).localeCompare(basename(b)));
	const parsedCursor = parseL1CursorToken(cursorToken);
	if (!parsedCursor) throw new Error("Invalid L1 cursor token");
	const legacyCursor = typeof parsedCursor === "string" ? parsedCursor : null;
	const offsets: Record<string, number> = typeof parsedCursor === "string" ? {} : { ...parsedCursor.files };
	const prev: L0Line[] = [];
	const priorContext: L0Line[] = [];
	const messages: L0Line[] = [];
	let truncated = false;

	for (const file of files) {
		if (!existsSync(file)) continue;
		const name = basename(file);
		let bytes: Buffer;
		try {
			bytes = readFileSync(file);
		} catch {
			continue;
		}
		let offset = offsets[name] ?? 0;
		// Recover safely if a shard was rewritten or a cursor points into a row.
		if (offset > bytes.length || (offset > 0 && bytes[offset - 1] !== 0x0a)) offset = 0;
		if (!legacyCursor && offset > 0) {
			let priorPos = 0;
			while (priorPos < offset) {
				const newline = bytes.indexOf(0x0a, priorPos);
				if (newline < 0 || newline >= offset) break;
				const prior = parseL0Line(bytes.subarray(priorPos, newline).toString("utf8").replace(/\r$/, ""));
				if (prior && (prior.role === "user" || prior.role === "assistant")) {
					priorContext.push(prior);
					if (priorContext.length > BG_COUNT) priorContext.shift();
				}
				priorPos = newline + 1;
			}
		}
		let pos = offset;
		while (pos < bytes.length) {
			const newline = bytes.indexOf(0x0a, pos);
			if (newline < 0) break; // L0 appends newline-terminated rows; do not consume a partial write.
			const end = newline + 1;
			const line = bytes.subarray(pos, newline).toString("utf8").replace(/\r$/, "");
			const rec = parseL0Line(line);
			if (legacyCursor && rec?.recordedAt && rec.recordedAt < legacyCursor) {
				prev.push(rec);
				offset = end;
				pos = end;
				continue;
			}
			if (rec && (rec.role === "user" || rec.role === "assistant")) {
				if (messages.length >= MAX_INCREMENT) {
					truncated = true;
					break;
				}
				messages.push({ ...rec, sourceFile: name, sourceOffset: end });
			}
			offset = end;
			pos = end;
		}
		offsets[name] = offset;
		if (truncated) break;
	}

	const background = legacyCursor ? prev.slice(-BG_COUNT) : priorContext;
	return { messages, background, nextCursor: { version: 2, files: offsets }, truncated };
}

export function registerReadL0IncrementTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_l0_increment",
		label: "Read L0 Increment",
		description: renderPrompt("tools#read_l0_increment"),
		parameters: {
			type: "object",
			properties: {
				l0Files: { type: "string", description: "Comma-separated absolute paths of L0 shard files (from the L0Files line of the task message)." },
				cursor: { type: "string", description: "Serialized v2 per-shard cursor, a legacy ISO timestamp for migration, or empty string to start from the beginning." },
			},
			required: ["l0Files", "cursor"],
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const l0Files = typeof params?.l0Files === "string" ? params.l0Files : "";
				const cursor = typeof params?.cursor === "string" ? params.cursor : "";
				if (!l0Files) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "l0Files is required" }) }], details: {} };
				const result = readL0Increment(l0Files, cursor);
				return { content: [{ type: "text", text: JSON.stringify({ success: true, ...result }) }], details: {} };
			} catch (err) {
				return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }) }], details: {} };
			}
		},
	});
}
