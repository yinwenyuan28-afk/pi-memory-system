# 已知问题记录

## LEGACY-SUB-MEMORY-PATH：旧 sub-memory 路径限制可被绕过

- 记录日期：2026-10-05。
- 状态：已记录，暂不修复。
- 范围决策：用户明确指定第三个问题只记录、不修复；本轮两个流水线计划不包含它。
- 代码位置：`memory/core/store.ts:146`、`:195`、`:240`，涉及 add、replace 和 remove 的 sub-memory 分支。
- 原因：`replace(/^\.\.\//g, "")` 只移除一次起始 `../`，不验证最终解析路径仍处于 `sub-memories/`。
- 示例：`../../outside.md` 处理后为 `../outside.md`，可指向 profile 根下文件；更多 `../` 可继续逃出 profile。
- 影响：调用这些旧 API 时，可能在预期目录以外追加、替换或移除文件内容。
- 当前可达性：`index.ts` 中旧 `memory` 写入工具注册处于停用块注释内；`MemoryManager` 当前承担 MEMORY.md / USER.md 注入，没有活跃的旧写入工具入口。
- 证据边界：来自静态审查；未对生产文件执行写入复现。
- 后续触发条件：恢复旧 memory 工具、重新接入 MemoryStore 的 sub-memory 修改 API，或新增该路径的调用者之前，重新评估并处理路径限制。
- 将来修复方向：解析完整目标路径并验证其位于指定目录内；必要时处理链接指向目录外的情况。此条仅记录，不构成本轮实施任务。
