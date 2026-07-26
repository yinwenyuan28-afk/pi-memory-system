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

// ─── 路由规则文件（JSON 格式） ───

export interface RoutesFile {
	routes: Route[];
}

// ─── 记忆目标类型 ───

export type Target = "memory" | "user" | "sub-memory";

export interface RouteMatch {
	keywords: string[];
	pathContains?: string;
}

export interface Route {
	id: string;
	group: string;
	desc: string;
	match: RouteMatch;
	load: "sub-memory" | "skill";
	target: string;
	priority: number;
	mutexGroup?: string;
	disabled?: boolean;
}

export interface RouteResult {
	route: Route;
	content: string;
}

// ─── 倒排索引 ───

export interface InvertedIndexData {
	version: number;
	index: Record<string, string[]>;
}

// ─── 质量 ───

export interface FilterResult {
	blocked: boolean;
	reason?: string;
	ruleId?: string;
	warning?: string;
	suggestTarget?: string;
}

export interface DuplicateResult {
	isDuplicate: boolean;
	similarity: number;
	existingContent?: string;
	existingFile?: string;
	suggestion?: string;
}

export type QualityCheckCallback = (content: string, target: string, filePath: string) => Promise<void>;

/** 记忆保存日志（每行一条 JSONL） */
export interface MemorySaveLog {
	timestamp: number;
	target: string;
	action: string;
	content: string; // 截断至 200 字
	reason: string; // 为什么保存
	source: string; // 谁触发的：llm / memory-reviewer / skill-reviewer / remember / learn
	charLimit?: string; // 写入时的 char limit 状态
}

export interface ToolSchema {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface MemoryProvider {
	readonly name: string;
	isAvailable(): boolean;
	initialize(sessionId: string, profilePath: string): void;
	prefetch(query: string, sessionId?: string): string;
	syncTurn(userContent: string, assistantContent: string, sessionId?: string): void;
	getToolSchemas(): ToolSchema[];
	handleToolCall(toolName: string, args: Record<string, unknown>): string;
	shutdown(): void;
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
