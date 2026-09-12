// 旧记忆系统写/检索链自 2026-09-12 退役（plan/memory-system/LEGACY_RETRIEVAL_RETIREMENT/）：
// 只保留注入侧所需的 MemoryManager / ProfileManager / MemoryStore。
// 已删除：InvertedIndex（search/inverted-index）、checkDuplicate（core/duplicate-check）、
// handleMemoryTool / MEMORY_SCHEMA（core/tool）——均无活跃消费者。
// 保留 ContentFilter：孤儿代码，待注入点分析 §7 P1-1 接入 l1_commit / l1_fix（见 memory/core/content-filter.ts）。
export { ContentFilter } from "./core/content-filter.js";
export { MemoryManager } from "./core/manager.js";
export { ProfileManager } from "./core/profile.js";
export { MemoryStore } from "./core/store.js";
export {
	DEFAULT_MEMORY_CHAR_LIMIT,
	DEFAULT_PROFILE,
	DEFAULT_USER_CHAR_LIMIT,
	ENTRY_DELIMITER,
	MEMORY_DIR_NAME,
	type MemoryEntry,
	type MemoryManagerConfig,
	PROFILES_DIR_NAME,
	type Profile,
} from "./core/types.js";
