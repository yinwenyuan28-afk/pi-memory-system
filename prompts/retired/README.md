# prompts/retired/ — 已失去消费方的提示词（归档保留）

> 归档日期：2026-09-12
> 来源计划：`plan/memory-system/PROMPT_REGISTRY_PHASE3/`（提示词目录归拢）+ `plan/memory-system/LEGACY_RETRIEVAL_RETIREMENT/`

## 为什么在这里

这 4 个模板原属 `memory/prompts/`，由旧加载器 `memory/prompts.ts` 加载，服务于**旧记忆系统的检索链**：

| 文件 | 原用途 | 原消费方（均已删除/退役） |
| --- | --- | --- |
| `keyword-extraction.md` | 后台 LLM 设计检索关键词 | `memory/search/searcher.ts` `refreshKeywords` |
| `filter.md` | 倒排索引关键词过滤 | `memory/search/inverted-index.ts` |
| `filter-relevance.md` | 候选记忆章节的 LLM 语义过滤 | `memory/search/searcher.ts` `filterMemories` |
| `save-guidelines.md` | memory 工具保存指南（`MEMORY_SCHEMA.description`） | `memory/core/tool.ts` |

随着 memory 工具退役（2026-09-11）、旧检索链删除（2026-09-12），这 4 个模板不再有任何消费者。**它们不在 `registry.ts` 的注册表内，不会被打包/渲染/注入**——放在 `prompts/retired/` 仅为人可读的归档（`registry` 只按显式 key 取文件，无目录扫描）。

## 恢复方式

若将来要恢复旧 sub-memory 检索链：`git revert` `LEGACY_RETRIEVAL_RETIREMENT` 的删码提交（恢复代码与引用），再把这里的 md 移回其历史位置或按 registry 的 key 约定接入。恢复前建议先读该计划的「不做的事」与 `content-filter.ts` 的孤儿保留说明。
