import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_MEMORY_CHAR_LIMIT,
	DEFAULT_USER_CHAR_LIMIT,
	ENTRY_DELIMITER,
	type MemoryEntry,
	type MemoryManagerConfig,
	type Target,
} from "./types.js";

const MEMORY_FILE = "MEMORY.md";
const USER_FILE = "USER.md";
const SUB_MEMORIES_DIR = "sub-memories";

interface MemoryOperationResult {
	success: boolean;
	error?: string;
	usage?: string;
	message?: string;
	path?: string;
}

/**
 * File-backed memory store with frozen-snapshot pattern.
 *
 * Two parallel states:
 * - _systemPromptSnapshot: frozen at loadFromDisk(), used for system prompt injection.
 *   Never mutated mid-session. Keeps prefix cache stable.
 * - entries: live state, mutated by tool calls, persisted to disk immediately.
 */
export class MemoryStore {
	private memoryEntries: MemoryEntry[] = [];
	private userEntries: MemoryEntry[] = [];

	private memoryCharLimit: number;
	private userCharLimit: number;

	/** Frozen snapshot for system prompt, set once at loadFromDisk() */
	private snapshot: Record<string, string> = { memory: "", user: "" };

	private profilePath = "";

	constructor(config?: Partial<Pick<MemoryManagerConfig, "memoryCharLimit" | "userCharLimit">>) {
		this.memoryCharLimit = config?.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT;
		this.userCharLimit = config?.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT;
	}

	// ── Initialization ──────────────────────────────────────────────

	loadFromDisk(profilePath: string): void {
		this.profilePath = profilePath;
		this.ensureDir(profilePath);

		this.memoryEntries = this.readFile(join(profilePath, MEMORY_FILE));
		this.userEntries = this.readFile(join(profilePath, USER_FILE));

		// Deduplicate (preserve order, keep first)
		this.memoryEntries = this.deduplicate(this.memoryEntries);
		this.userEntries = this.deduplicate(this.userEntries);

		// Freeze snapshot
		this.snapshot = {
			memory: this.renderBlock("memory", this.memoryEntries),
			user: this.renderBlock("user", this.userEntries),
		};
	}

	/** Re-read entries from disk (under lock). Used before mutations. */
	reloadFromDisk(target: Target): void {
		const path = this.filePath(target);
		const fresh = this.readFile(path);
		const deduped = this.deduplicate(fresh);
		if (target === "memory") {
			this.memoryEntries = deduped;
		} else if (target === "user") {
			this.userEntries = deduped;
		}
	}

	// ── Mutation API ────────────────────────────────────────────────

	add(
		target: Target,
		content: string,
		options?: { path?: string },
	): { success: boolean; error?: string; usage?: string; message?: string; path?: string } {
		content = content.trim();
		if (!content) {
			return { success: false, error: "Content cannot be empty." };
		}

		// Sub-memory writes go directly to a specific file
		if (target === "sub-memory") {
			return this.writeSubMemory(options?.path || "", content);
		}

		this.reloadFromDisk(target);
		const entries = this.entriesFor(target);
		const limit = this.charLimit(target);

		// Reject exact duplicates
		if (entries.some((e) => e.content === content)) {
			return {
				success: true,
				usage: this.currentUsage(target),
				message: "Entry already exists (no duplicate added).",
			};
		}

		const newEntries = [...entries, { content, timestamp: Date.now() }];
		const newTotal = this.totalChars(newEntries);

		if (newTotal > limit) {
			const current = this.currentChars(target);
			return {
				success: false,
				error: `Memory at ${current.toLocaleString()}/${limit.toLocaleString()} chars. Adding this entry (${content.length} chars) would exceed the limit. Use replace/remove to consolidate first.`,
				usage: `${current.toLocaleString()}/${limit.toLocaleString()}`,
			};
		}

		this.setEntries(target, newEntries);
		this.saveToDisk(target);
		return this.successResponse(target);
	}

	/** Write content to a sub-memory file (under sub-memories/). */
	private writeSubMemory(relativePath: string, content: string): MemoryOperationResult {
		if (!relativePath) {
			return {
				success: false,
				error: "path is required for sub-memory writes.",
			};
		}
		// Sanitize path: prevent directory traversal
		const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\.\//g, "");
		const fullPath = join(this.profilePath, SUB_MEMORIES_DIR, normalized);
		const dir = dirname(fullPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Append or create the sub-memory file
		let existing = "";
		try {
			existing = readFileSync(fullPath, "utf-8");
		} catch {
			// File doesn't exist yet, that's fine
		}

		const separator = existing.trim() ? "\n\n---\n\n" : "";
		const newContent = `${existing}${separator}${content}`;
		writeFileSync(fullPath, newContent, "utf-8");

		return {
			success: true,
			message: `Written to sub-memory: ${normalized}`,
			path: normalized,
		};
	}

	/**
	 * Replace text in a sub-memory file.
	 * Finds `oldText` as substring in the file, replaces first occurrence with `newContent`.
	 */
	private replaceInSubMemory(
		oldText: string,
		newContent: string,
		relativePath: string,
	): MemoryOperationResult {
		if (!relativePath) {
			return { success: false, error: "path is required for sub-memory replace." };
		}
		if (!oldText) {
			return { success: false, error: "old_text cannot be empty." };
		}
		if (!newContent) {
			return { success: false, error: "content cannot be empty." };
		}

		const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\.\//g, "");
		const fullPath = join(this.profilePath, SUB_MEMORIES_DIR, normalized);

		let existing: string;
		try {
			existing = readFileSync(fullPath, "utf-8");
		} catch {
			return { success: false, error: `Sub-memory file not found: ${normalized}` };
		}

		const idx = existing.indexOf(oldText);
		if (idx === -1) {
			return {
				success: false,
				error: `old_text not found in '${normalized}'.`,
			};
		}

		const newContent_full =
			existing.slice(0, idx) + newContent + existing.slice(idx + oldText.length);

		// Atomic write
		const tmpPath = join(this.profilePath, `.tmp_${randomUUID()}`);
		writeFileSync(tmpPath, newContent_full, "utf-8");
		renameSync(tmpPath, fullPath);

		return {
			success: true,
			message: `Replaced in sub-memory: ${normalized}`,
			path: normalized,
		};
	}

	/**
	 * Remove text from a sub-memory file.
	 * Finds `oldText` as substring, removes the section containing it (separated by \n\n---\n\n).
	 */
	private removeFromSubMemory(
		oldText: string,
		relativePath: string,
	): MemoryOperationResult {
		if (!relativePath) {
			return { success: false, error: "path is required for sub-memory remove." };
		}

		const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\.\//g, "");
		const fullPath = join(this.profilePath, SUB_MEMORIES_DIR, normalized);

		let existing: string;
		try {
			existing = readFileSync(fullPath, "utf-8");
		} catch {
			return { success: false, error: `Sub-memory file not found: ${normalized}` };
		}

		// Split into sections (separator: \n\n---\n\n or \n\n---\n)
		const sections = existing.split(/\n{2}---\n{1,2}/);
		const idx = sections.findIndex((s) => s.includes(oldText));

		if (idx === -1) {
			return {
				success: false,
				error: `old_text not found in any section of '${normalized}'.`,
			};
		}

		sections.splice(idx, 1);
		const newContent = sections.join("\n\n---\n\n").trim();

		// Atomic write
		const tmpPath = join(this.profilePath, `.tmp_${randomUUID()}`);
		writeFileSync(tmpPath, newContent, "utf-8");
		renameSync(tmpPath, fullPath);

		return {
			success: true,
			message: `Removed section from sub-memory: ${normalized}`,
			path: normalized,
		};
	}

	replace(
		target: Target,
		oldText: string,
		newContent: string,
		options?: { path?: string },
	): { success: boolean; error?: string; usage?: string; path?: string } {
		if (target === "sub-memory") {
			return this.replaceInSubMemory(oldText, newContent, options?.path || "");
		}
		oldText = oldText.trim();
		newContent = newContent.trim();

		if (!oldText) return { success: false, error: "old_text cannot be empty." };
		if (!newContent) {
			return { success: false, error: "new_content cannot be empty. Use 'remove' to delete." };
		}

		this.reloadFromDisk(target);
		const entries = this.entriesFor(target);
		const limit = this.charLimit(target);

		const idx = this.findEntry(entries, oldText);
		if (idx === -1) {
			return {
				success: false,
				error: `No entry matched '${oldText}'.`,
				usage: this.currentUsage(target),
			};
		}

		const testEntries = [...entries];
		testEntries[idx] = { content: newContent, timestamp: Date.now() };
		const newTotal = this.totalChars(testEntries);

		if (newTotal > limit) {
			return {
				success: false,
				error: `Replacement would exceed the ${limit.toLocaleString()} char limit. Shorten the content or remove other entries first.`,
				usage: this.currentUsage(target),
			};
		}

		this.setEntries(target, testEntries);
		this.saveToDisk(target);
		return this.successResponse(target);
	}

	remove(
		target: Target,
		oldText: string,
		options?: { path?: string },
	): { success: boolean; error?: string; usage?: string } {
		oldText = oldText.trim();
		if (!oldText) return { success: false, error: "old_text cannot be empty." };

		if (target === "sub-memory") {
			return this.removeFromSubMemory(oldText, options?.path || "");
		}

		this.reloadFromDisk(target);
		const entries = this.entriesFor(target);

		const idx = this.findEntry(entries, oldText);
		if (idx === -1) {
			return {
				success: false,
				error: `No entry matched '${oldText}'.`,
				usage: this.currentUsage(target),
			};
		}

		const newEntries = [...entries];
		newEntries.splice(idx, 1);
		this.setEntries(target, newEntries);
		this.saveToDisk(target);
		return this.successResponse(target);
	}

	applyBatch(
		target: Target,
		operations: Array<{ action: string; content?: string; oldText?: string; path?: string }>,
	): { success: boolean; error?: string; usage?: string } {
		if (!operations.length) {
			return { success: false, error: "operations list is empty." };
		}

		if (target === "sub-memory") {
			// Apply each operation as sequential sub-memory writes
			for (const op of operations) {
				let result: { success: boolean; error?: string };
				if (op.action === "add") {
					result = this.writeSubMemory(op.path || "", op.content || "");
				} else if (op.action === "replace") {
					result = this.replaceInSubMemory(op.oldText || "", op.content || "", op.path || "");
				} else if (op.action === "remove") {
					result = this.removeFromSubMemory(op.oldText || "", op.path || "");
				} else {
					return {
						success: false,
						error: `Unknown action '${op.action}' for sub-memory batch.`,
					};
				}
				if (!result.success) {
					return { success: false, error: result.error };
				}
			}
			return { success: true, message: `${operations.length} operations applied to sub-memory.` };
		}

		this.reloadFromDisk(target);
		const limit = this.charLimit(target);
		const working = [...this.entriesFor(target)];

		for (let i = 0; i < operations.length; i++) {
			const op = operations[i];
			const action = op.action;
			const pos = `Operation ${i + 1}`;

			if (action === "add") {
				if (!op.content?.trim()) {
					return this.batchError(target, `${pos}: content is required for add.`);
				}
				working.push({ content: op.content.trim(), timestamp: Date.now() });
			} else if (action === "replace") {
				if (!op.oldText?.trim()) {
					return this.batchError(target, `${pos}: old_text is required for replace.`);
				}
				if (!op.content?.trim()) {
					return this.batchError(target, `${pos}: content is required for replace (use 'remove' to delete).`);
				}
				const idx = this.findEntry(working, op.oldText.trim());
				if (idx === -1) {
					return this.batchError(target, `${pos}: no entry matched '${op.oldText}'.`);
				}
				working[idx] = { content: op.content.trim(), timestamp: Date.now() };
			} else if (action === "remove") {
				if (!op.oldText?.trim()) {
					return this.batchError(target, `${pos}: old_text is required for remove.`);
				}
				const idx = this.findEntry(working, op.oldText.trim());
				if (idx === -1) {
					return this.batchError(target, `${pos}: no entry matched '${op.oldText}'.`);
				}
				working.splice(idx, 1);
			} else {
				return this.batchError(target, `${pos}: unknown action '${action}'. Use add, replace, or remove.`);
			}
		}

		// Check final budget
		const newTotal = this.totalChars(working);
		if (newTotal > limit) {
			return {
				success: false,
				error: `After all ${operations.length} operations, memory would exceed the ${limit.toLocaleString()} char limit.`,
				usage: this.currentUsage(target),
			};
		}

		this.setEntries(target, working);
		this.saveToDisk(target);
		return this.successResponse(target);
	}

	// ── System Prompt ───────────────────────────────────────────────

	/** Return the frozen snapshot for system prompt injection. */
	formatForSystemPrompt(target: Target): string | undefined {
		const block = this.snapshot[target];
		return block || undefined;
	}

	/** Get the full context block (memory + user combined) */
	getFullContext(): string {
		const parts: string[] = [];
		const memory = this.snapshot.memory;
		const user = this.snapshot.user;
		if (memory) parts.push(memory);
		if (user) parts.push(user);
		return parts.length > 0 ? parts.join("\n\n") : "";
	}

	// ── Internal ────────────────────────────────────────────────────

	private entriesFor(target: Target): MemoryEntry[] {
		if (target === "memory") return this.memoryEntries;
		if (target === "user") return this.userEntries;
		return [];
	}

	private setEntries(target: Target, entries: MemoryEntry[]): void {
		if (target === "memory") {
			this.memoryEntries = entries;
		} else if (target === "user") {
			this.userEntries = entries;
		}
	}

	private charLimit(target: Target): number {
		if (target === "memory") return this.memoryCharLimit;
		if (target === "user") return this.userCharLimit;
		return 0;
	}

	private currentChars(target: Target): number {
		return this.totalChars(this.entriesFor(target));
	}

	private currentUsage(target: Target): string {
		const current = this.currentChars(target);
		const limit = this.charLimit(target);
		if (limit === 0) return "0/0";
		return `${current.toLocaleString()}/${limit.toLocaleString()}`;
	}

	private filePath(target: Target): string {
		if (target === "memory") return join(this.profilePath, MEMORY_FILE);
		if (target === "user") return join(this.profilePath, USER_FILE);
		// sub-memory writes use explicit paths, not this method
		return join(this.profilePath, MEMORY_FILE);
	}

	private totalChars(entries: MemoryEntry[]): number {
		if (!entries.length) return 0;
		return ENTRY_DELIMITER.length * (entries.length - 1) + entries.reduce((sum, e) => sum + e.content.length, 0);
	}

	private findEntry(entries: MemoryEntry[], oldText: string): number {
		return entries.findIndex((e) => e.content.includes(oldText));
	}

	private successResponse(target: Target): { success: boolean; usage: string } {
		const current = this.currentChars(target);
		const limit = this.charLimit(target);
		const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
		return {
			success: true,
			usage: `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`,
		};
	}

	private batchError(target: Target, message: string): { success: false; error: string; usage: string } {
		return {
			success: false,
			error: `${message} No operations were applied (batch is all-or-nothing).`,
			usage: this.currentUsage(target),
		};
	}

	private renderBlock(target: Target, entries: MemoryEntry[]): string {
		if (!entries.length) return "";
		const limit = this.charLimit(target);
		const total = this.totalChars(entries);
		const pct = limit > 0 ? Math.min(100, Math.round((total / limit) * 100)) : 0;
		let label: string;
		if (target === "user") {
			label = "USER PROFILE (who the user is)";
		} else if (target === "memory") {
			label = "MEMORY (your personal notes)";
		} else {
			label = "SUB-MEMORY";
		}
		const header = `${label} [${pct}% — ${total.toLocaleString()}/${limit.toLocaleString()} chars]`;
		const sep = "═".repeat(46);
		const content = entries.map((e) => e.content).join(ENTRY_DELIMITER);
		return `${sep}\n${header}\n${sep}\n${content}`;
	}

	private saveToDisk(target: Target): void {
		const path = this.filePath(target);
		this.ensureDir(dirname(path));
		const entries = this.entriesFor(target);
		const content = entries.map((e) => e.content).join(ENTRY_DELIMITER);

		// Atomic write: write to temp file, then rename
		const tmpPath = join(dirname(path), `.tmp_${randomUUID()}`);
		try {
			writeFileSync(tmpPath, content, "utf-8");
			renameSync(tmpPath, path);
		} catch (e) {
			// Cleanup temp file on failure
			try {
				if (existsSync(tmpPath)) renameSync(tmpPath, join(tmpdir(), `.mem_${randomUUID()}`));
			} catch {}
			throw e;
		}
	}

	private readFile(filePath: string): MemoryEntry[] {
		if (!existsSync(filePath)) return [];
		const raw = readFileSync(filePath, "utf-8").trim();
		if (!raw) return [];
		const parts = raw.split(ENTRY_DELIMITER);
		return parts
			.map((p) => p.trim())
			.filter(Boolean)
			.map((content) => ({ content, timestamp: 0 }));
	}

	private deduplicate(entries: MemoryEntry[]): MemoryEntry[] {
		const seen = new Set<string>();
		return entries.filter((e) => {
			if (seen.has(e.content)) return false;
			seen.add(e.content);
			return true;
		});
	}

	private ensureDir(dir: string): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}
