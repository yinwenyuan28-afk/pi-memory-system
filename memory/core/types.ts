// ─── 记忆条目 ───

export interface MemoryEntry {
	content: string;
	timestamp: number;
}

// ─── 档案 ───

export interface Profile {
	name: string;
	path: string;
	createdAt?: number;
}

// ─── 记忆目标类型 ───

export type Target = "memory" | "user" | "sub-memory";

// ─── 质量 ───

/** ContentFilter 的检查结果（content-filter.ts 是保留的孤儿，等待接入 L1 写链）。 */
export interface FilterResult {
	blocked: boolean;
	reason?: string;
	ruleId?: string;
	warning?: string;
	suggestTarget?: string;
}

export interface MemoryManagerConfig {
	memoryCharLimit: number;
	userCharLimit: number;
	profilesDir: string;
	activeProfile: string;
}

// ─── 常量 ───

export const ENTRY_DELIMITER = "\n§\n";
export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_USER_CHAR_LIMIT = 1375;
export const DEFAULT_PROFILE = "default";
export const MEMORY_DIR_NAME = "memories";
export const PROFILES_DIR_NAME = "profiles";

// 2026-09-12 检索链退役时删除的死类型：RoutesFile / Route / RouteMatch / RouteResult /
// InvertedIndexData / DuplicateResult / QualityCheckCallback / MemorySaveLog / ToolSchema /
// MemoryProvider（对应实现已删，见 plan/memory-system/LEGACY_RETRIEVAL_RETIREMENT/）。
