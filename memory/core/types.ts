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
	// 原先这里还有 profilesDir / activeProfile 两个字段，2026-10-01 删除：
	// 两个构造点（MemoryManager / MemoryStore）都只 Pick 上面这两个，是彻底的死字段。
	// 特意点名 activeProfile —— 它**不走**这个配置对象，唯一真源是宿主 settings.json 的
	// memorySystem.activeProfile（见 memory/core/profile.ts）。留着这个字段会让下一个
	// 读代码的人以为激活 profile 是从这里来的。
}

// ─── 常量 ───

/**
 * profile 根目录下三个**注入画像**文件名（MEMORY.md / USER.md / routes.md）。
 *
 * 刻意放在 `core/types.ts` 而**不是** `memory/paths.ts`：后者集中的是 `{profile}/memoryDB/`
 * 下的运行数据路径，其文件头已明确写了边界「MEMORY.md / USER.md：注入画像，保持 profile
 * 根目录，不归 memoryDB」—— 把它们塞进 paths.ts 等于推翻那条已写明的边界。
 *
 * 收束原因（P1-11）：这三个名字原先散在 `core/store.ts` 的两个私有常量、
 * `l3/user-file.ts` 的一处导出、`core/profile.ts` 的一个数组字面量里。
 * `ProfileManager.ensureProfileStructure()` 建目录时用的是数组字面量，
 * 而 store 读盘用的是常量 —— 改名字只改一处就会「建了目录却读不到文件」。
 */
export const MEMORY_FILE = "MEMORY.md";
export const USER_FILE = "USER.md";
export const ROUTES_FILE = "routes.md";

export const ENTRY_DELIMITER = "\n§\n";
export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
/**
 * USER.md 的总长预算（用户 2026-09-16 拍板：1375 → 2200）。
 *
 * 为什么涨：1375 是腾讯 persona 单文件的口径，`USER.md` 已被 18 条手写规则占到 1302（95%），
 * 修好 L3 触发后它只剩 73 字符空间 —— 等于跑一次也写不进东西。
 * 口径与 `store.totalChars()` 一致（LF 归一化：条目正文 + `\n§\n` 分隔符），不是磁盘字节数。
 * 2026-09-28 起 L3 写的是提议稿 `USER-temp.md`，但限额仍按"并入 USER.md 后的整篇"计
 * （`l3_edit` 的工作副本 = live 条目 + 本轮改动）⇒ 这个数字同时是注入预算与写入预算。
 */
export const DEFAULT_USER_CHAR_LIMIT = 2200;
export const DEFAULT_PROFILE = "default";
export const MEMORY_DIR_NAME = "memories";
export const PROFILES_DIR_NAME = "profiles";

// 2026-09-12 检索链退役时删除的死类型：RoutesFile / Route / RouteMatch / RouteResult /
// InvertedIndexData / DuplicateResult / QualityCheckCallback / MemorySaveLog / ToolSchema /
// MemoryProvider（对应实现已删，见 plan/memory-system/LEGACY_RETRIEVAL_RETIREMENT/）。
