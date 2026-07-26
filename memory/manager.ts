import { ProfileManager } from "./profile.js";
import { MemoryRouter } from "./router.js";
import { MemoryStore } from "./store.js";
import { handleMemoryTool, MEMORY_SCHEMA } from "./tool.js";
import type { MemoryManagerConfig, MemoryProvider } from "./types.js";

export { MEMORY_SCHEMA } from "./tool.js";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InvertedIndex } from "./inverted-index.js";

/**
 * MemoryManager — coordinates memory storage, routing, and providers.
 *
 * All operations are bound to the current active profile.
 */
export class MemoryManager {
	private store: MemoryStore;
	private router: MemoryRouter;
	private profileManager: ProfileManager;
	private externalProvider: MemoryProvider | null = null;
	private invertedIndex: InvertedIndex;
	private _initialized = false;

	constructor(agentDir: string, config?: Partial<Pick<MemoryManagerConfig, "memoryCharLimit" | "userCharLimit">>) {
		this.store = new MemoryStore(config);
		this.router = new MemoryRouter();
		this.profileManager = new ProfileManager(agentDir);
		this.invertedIndex = new InvertedIndex();
	}

	get invertedIndexInstance(): InvertedIndex {
		return this.invertedIndex;
	}

	// ── Initialization ──────────────────────────────────────────────

	initialize(): void {
		const profile = this.profileManager.getActiveProfile();
		this.store.loadFromDisk(profile.path);
		this.router.loadRoutes(profile.path);
		this.invertedIndex.load(profile.path);
		this._initialized = true;
	}

	/** Re-initialize after switching profile. */
	switchProfile(name: string): void {
		const profile = this.profileManager.switchProfile(name);
		this.store.loadFromDisk(profile.path);
		this.router.loadRoutes(profile.path);
		this.invertedIndex.load(profile.path);
	}

	// ── Provider Registration ───────────────────────────────────────

	/** Register an external memory provider (at most one allowed). */
	setExternalProvider(provider: MemoryProvider): void {
		if (this.externalProvider) {
			console.warn(
				`External memory provider '${this.externalProvider.name}' already registered. ` +
					`'${provider.name}' rejected. Only one external provider is allowed.`,
			);
			return;
		}
		this.externalProvider = provider;
	}

	// ── System Prompt ───────────────────────────────────────────────

	/** Build the full memory context block for system prompt injection. */
	buildSystemPrompt(): string {
		if (!this._initialized) return "";
		const parts: string[] = [];

		// MEMORY.md + USER.md frozen snapshot
		const storeContext = this.store.getFullContext();
		if (storeContext) parts.push(storeContext);

		return parts.length > 0 ? parts.join("\n\n") : "";
	}

	// ── Prefetch / Route ────────────────────────────────────────────

	/**
	 * Prefetch all relevant memory context for the incoming user message.
	 *
	 * 1. Returns the MEMORY.md/USER.md frozen snapshot.
	 * 2. Runs route resolution (inverted index first, then routes.md).
	 * 3. Loads matching sub-memories.
	 * 4. Queries external provider (if configured).
	 */
	prefetchAll(query: string, cwd: string): string {
		if (!this._initialized) return "";

		const parts: string[] = [];

		// 1. Store snapshot
		const storeContext = this.store.getFullContext();
		if (storeContext) parts.push(storeContext);

		// 2. Inverted index search (primary)
		const indexResults = this.invertedIndex.search(query);
		const loadedPaths = new Set<string>();
		if (indexResults.length > 0) {
			const indexParts: string[] = [];
			for (const filePath of indexResults) {
				loadedPaths.add(filePath);
				const fullPath = join(this.profileManager.getActiveProfile().path, filePath);
				if (existsSync(fullPath)) {
					const content = readFileSync(fullPath, "utf-8").trim();
					if (content) {
						indexParts.push(`[INDEX MATCH: ${filePath}]\n${content}`);
					}
				}
			}
			if (indexParts.length > 0) {
				parts.push(indexParts.join("\n\n"));
			}
		}

		// 3. Route matching (supplementary, for paths not already loaded by index)
		const routeResults = this.router.resolve(query, cwd);
		if (routeResults.length > 0) {
			// Filter out routes whose targets were already loaded by index
			const newResults = routeResults.filter((r) => !loadedPaths.has(r.route.target));
			if (newResults.length > 0) {
				const routeContext = this.router.renderContext(newResults);
				if (routeContext) parts.push(routeContext);
			}
		}

		// 3. External provider
		if (this.externalProvider) {
			try {
				const extContext = this.externalProvider.prefetch(query);
				if (extContext) parts.push(extContext);
			} catch {
				// non-fatal
			}
		}

		return parts.length > 0
			? `<memory-context>\n[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data.]\n\n${parts.join("\n\n")}\n</memory-context>`
			: "";
	}

	// ── Sync ────────────────────────────────────────────────────────

	/** Sync a completed turn to all providers. */
	syncAll(userContent: string, assistantContent: string): void {
		if (!this._initialized) return;

		try {
			this.externalProvider?.syncTurn(userContent, assistantContent);
		} catch {
			// non-fatal
		}
	}

	// ── Tool Handling ───────────────────────────────────────────────

	/** Get tool schemas from built-in memory + external provider. */
	getToolSchemas(): Array<Record<string, unknown>> {
		const schemas: Array<Record<string, unknown>> = [{ type: "function", function: MEMORY_SCHEMA }];

		if (this.externalProvider) {
			try {
				const extSchemas = this.externalProvider.getToolSchemas();
				for (const s of extSchemas) {
					schemas.push({ type: "function", function: s });
				}
			} catch {
				// non-fatal
			}
		}

		return schemas;
	}

	/** Route a memory tool call to the correct handler. */
	handleToolCall(toolName: string, args: Record<string, unknown>): string {
		if (toolName === "memory") {
			const profilePath = this._initialized ? this.profileManager.getActiveProfile().path : undefined;
			const saveLogPath = profilePath ? join(profilePath, "memory-save-log.jsonl") : undefined;
			const resultStr = handleMemoryTool(args, this.store, this.invertedIndex, profilePath, saveLogPath);
			// After successful write, update inverted index
			this.updateIndexAfterWrite(args, resultStr);
			return resultStr;
		}

		if (this.externalProvider) {
			try {
				return this.externalProvider.handleToolCall(toolName, args);
			} catch {
				return JSON.stringify({
					success: false,
					error: `Memory tool '${toolName}' failed.`,
				});
			}
		}

		return JSON.stringify({
			success: false,
			error: `Unknown memory tool '${toolName}'.`,
		});
	}

	/** Check if a tool name is handled by the memory system. */
	hasTool(toolName: string): boolean {
		if (toolName === "memory") return true;
		return this.externalProvider?.getToolSchemas().some((s) => s.name === toolName) ?? false;
	}

	/**
	 * After a successful memory write, update the inverted index.
	 * Parses the result JSON to determine success/failure.
	 */
	private updateIndexAfterWrite(args: Record<string, unknown>, resultStr: string): void {
		let result: Record<string, unknown>;
		try {
			result = JSON.parse(resultStr);
		} catch {
			return;
		}
		if (!result.success) return;

		const target = String(args.target || "memory");
		const action = String(args.action || "");
		const content = args.content !== undefined ? String(args.content) : undefined;
		const oldText = args.old_text !== undefined ? String(args.old_text) : undefined;
		const subMemoryPath = args.path !== undefined ? String(args.path) : undefined;

		// Determine file path
		let filePath = "";
		if (target === "memory") filePath = "MEMORY.md";
		else if (target === "user") filePath = "USER.md";
		else if (target === "sub-memory" && subMemoryPath) filePath = `sub-memories/${subMemoryPath}`;
		else return;

		if (action === "add" && content) {
			this.invertedIndex.addEntry(filePath, content);
		} else if (action === "replace" && oldText && content) {
			this.invertedIndex.updateEntry(filePath, oldText, content);
		} else if (action === "remove" && oldText) {
			this.invertedIndex.removeEntry(filePath);
			// re-index remaining content if replace/remove leaves other entries
			// For simplicity, just remove and let next write rebuild
		}

		// Batch operations
		const operations = args.operations;
		if (Array.isArray(operations) && operations.length > 0) {
			// For batch, just rebuild the affected file's index from disk
			// This is the safest approach for batch operations
			const profilePath = this.profileManager.getActiveProfile().path;
			const fullPath = join(profilePath, filePath);
			if (existsSync(fullPath)) {
				const content = readFileSync(fullPath, "utf-8");
				this.invertedIndex.addEntry(filePath, content);
			}
		}
	}

	// ── Profile Management ──────────────────────────────────────────

	get activeProfile() {
		return this.profileManager.getActiveProfileName();
	}

	listProfiles() {
		return this.profileManager.listProfiles();
	}

	getProfileManager() {
		return this.profileManager;
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	shutdown(): void {
		try {
			this.externalProvider?.shutdown();
		} catch {
			// non-fatal
		}
		this._initialized = false;
	}
}
