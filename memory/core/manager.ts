import { ProfileManager } from "./profile.ts";
import { MemoryStore } from "./store.ts";
import type { MemoryManagerConfig } from "./types.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

/**
 * 将记忆内容包装为标准的 <memory-context> 注入块。
 *
 * 供 buildSystemPrompt（快照）使用；模板见 prompts/injection/memory-context.md，
 * 保证注入外观可辨识、单源可改。
 */
function wrapMemoryContext(parts: string[]): string {
	return renderPrompt("injection/memory-context", { body: parts.join("\n\n") });
}

/**
 * MemoryManager —— 旧记忆系统「注入侧」的活链路载体。
 *
 * 2026-09-12 检索链退役后（plan/memory-system/LEGACY_RETRIEVAL_RETIREMENT/），本类只保留
 * 「MEMORY.md / USER.md 冻结快照 → system prompt 注入」所必需的部分（store + profile）。
 * 已删除：倒排索引（`invertedIndex`/`invertedIndexInstance`/`updateIndexAfterWrite`）、
 * 外部 provider（`externalProvider`/`setExternalProvider`/`prefetchSubMemories`/`prefetchAll`/
 * `syncAll`）、memory 工具路由（`handleToolCall`/`getToolSchemas`/`hasTool`）——均无活跃消费者。
 *
 * All operations are bound to the current active profile.
 */
export class MemoryManager {
	private store: MemoryStore;
	private profileManager: ProfileManager;
	private _initialized = false;

	constructor(agentDir: string, config?: Partial<Pick<MemoryManagerConfig, "memoryCharLimit" | "userCharLimit">>) {
		this.store = new MemoryStore(config);
		this.profileManager = new ProfileManager(agentDir);
	}

	// ── Initialization ──────────────────────────────────────────────

	initialize(): void {
		const profile = this.profileManager.getActiveProfile();
		this.store.loadFromDisk(profile.path);
		this._initialized = true;
	}

	/** Re-initialize after switching profile. */
	switchProfile(name: string): void {
		const profile = this.profileManager.switchProfile(name);
		this.store.loadFromDisk(profile.path);
	}

	// ── System Prompt ───────────────────────────────────────────────

	/**
	 * 构建 system prompt 注入块（仅 MEMORY.md + USER.md 冻结快照）。
	 *
	 * 快照会话内固定不变 → 放 system prompt 前缀稳定 → 命中 provider 前缀缓存。
	 */
	buildSystemPrompt(): string {
		if (!this._initialized) return "";
		const parts: string[] = [];

		// MEMORY.md + USER.md frozen snapshot
		const storeContext = this.store.getFullContext();
		if (storeContext) parts.push(storeContext);

		return parts.length > 0 ? wrapMemoryContext(parts) : "";
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

	/** Refresh USER.md frozen snapshot after L3 commit (intra-session injection). */
	refreshUserSnapshot(): void {
		if (!this._initialized) return;
		this.store.refreshSnapshot("user");
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	shutdown(): void {
		this._initialized = false;
	}
}
