// ══════════════════════════════════════════════════════════════
//  skill/feed-types.ts — 5-role skill 原料类型定义
//
//  定位：skill-feed 是 skill-reviewer 的专用原料通道（与 L0 双通道并存）。
//  保留 tool_call/tool_result（对齐腾讯 skill 抽取原料的 5-role 语义），
//  供 skill 提取看到"用什么工具、怎么调、结果如何"的完整决策链。
// ══════════════════════════════════════════════════════════════

/** skill-feed 消息角色：user / assistant / tool_call / tool_result（system/thinking 清洗时丢弃）。 */
export type SkillFeedRole = "user" | "assistant" | "tool_call" | "tool_result";

/**
 * skill-feed 单条净化后消息（JSONL 一行一个）。
 *
 * 溯源字段对齐 L0（sessionKey/id/timestamp/cwd），工具字段对齐腾讯
 * normalize-conversation（tool_name + tool_call_id 配对，is_error 标记失败）。
 */
export interface SkillFeedEntry {
	sessionKey: string;
	/** 写入 skill-feed 的时间（ISO），增量读取游标用（对齐 L0 的 recordedAt 语义）。 */
	recordedAt: string;
	/** message.id（若存在，供溯源）。 */
	id: string | null;
	role: SkillFeedRole;
	content: string;
	/** tool_call / tool_result 携带（assistant 的 toolCall.name / toolResult 顶层 toolName）。 */
	tool_name?: string;
	/** tool_call / tool_result 配对锚点。 */
	tool_call_id?: string;
	/** tool_result 专用：工具是否报错。 */
	is_error?: boolean;
	/** 时间戳（epoch ms）。 */
	timestamp: number | null;
	/** 消息所在工作目录（ctx.cwd 精确值；缺省从 session 路径启发式解码）。 */
	cwd: string | null;
}

/** 一次 skill-feed 增量归档的结果。 */
export interface SkillFeedArchiveResult {
	/** 实际写入 skill-feed 分片的消息数。 */
	recorded: number;
	/** 解析到但被过滤/丢弃的消息数（非 4 角色、降噪后为空、thinking/compaction 等）。 */
	filtered: number;
	/** 非致命错误信息（如 session 文件不存在）；无错误时为 undefined。 */
	error?: string;
}
