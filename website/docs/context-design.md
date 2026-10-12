---
title: 上下文与渐进式设计
description: 从源码理解记忆的注入位置、会话历史边界、按需加载与后台上下文分离。
---

# 上下文与渐进式设计

记忆的价值在于帮助 Pi 完成当前任务。扩展围绕这个目标，把稳定背景、当前问题的相关记录、按需读取的完整规则和后台整理过程分开处理，减少无关资料在主代理上下文中的堆积。

## 记忆紧跟本轮用户消息

每次模型调用前，扩展通过 `context` 事件把已经就绪的 L1 召回块放在最后一条用户消息之后。一个回答包含多次工具调用时，记忆块仍跟在同一条用户消息后面，后续助手消息和工具结果保持在它之后。

```text
第一次模型调用
  之前的对话 → 本轮用户问题 → 本轮相关记忆

工具执行后的模型调用
  之前的对话 → 本轮用户问题 → 本轮相关记忆 → 助手工具调用 → 工具结果
```

这个位置把记忆与它所辅助的问题对应起来，避免每次工具返回后，历史记忆又出现在末尾、占据“最新输入”的位置。没有用户消息的特殊场景才追加到末尾。

召回块使用 `<l1-records>` 包裹，并提示模型把它视为背景参考，而不是新用户输入或待执行命令。每条记录带编号，任务还带完成状态，便于模型识别和修正具体记录。这是提示词约束，不能据此保证模型永远不会误用记忆。

> **实现依据：** [index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的 `context` 处理器查找用户消息锚点并插入召回块；[召回模板](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/prompts/injection/l1-records.md) 定义参考身份和记录格式。

## 自动注入块不写入主会话 JSONL

Pi 的 `context` 事件处理模型调用前的消息副本。扩展返回插入记忆后的副本，不把自动召回块追加成一条持久会话消息。

因此，本轮模型可以看到相关记忆，但主会话历史不会因为每轮自动召回而不断增加同类记忆块。后续模型调用需要从持久会话重新组装上下文，再插入当前就绪的参考内容；下一轮开始时，重新准备该轮的召回结果。

```text
持久主会话历史 ──→ 模型调用前的消息副本 ←── 当前就绪的召回记忆
       │                         │
       ↓                         ↓
主会话 JSONL                发给模型的上下文
```

这里的“不写入”专指**自动插入的记忆块**。主动使用 `recall_l1_records` 的工具结果、助手据此生成的回答仍可进入会话历史；界面通知也可作为自定义条目保存。L0 归档和 L1 记忆本身仍保存在各自的 JSONL 文件中。

> **实现依据：** [index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 在 `context` 中修改 `event.messages` 并返回，没有将自动召回块写入会话的操作。主代理主动查询走[工具召回入口](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-l1-records-tool.ts)，属于另一条路径。

## 先给相关记录，需要时再展开

主代理按当前问题使用 L1 记录，不会自动加载整个对话归档、全部场景或后台代理的处理过程。

| 资料 | 怎样进入上下文 | 控制占用的方式 |
| --- | --- | --- |
| 正式 `MEMORY.md`、`USER.md` | 会话开始时读取快照，作为稳定系统背景 | 会话内保持稳定，便于保留可复用的提示前缀 |
| 本轮 L1 记忆 | 查询相关记录，再插入消息副本 | 自动最多 3 条，限制相关性与正文长度 |
| 更多 L1 候选 | 主代理按需调用召回工具 | 默认取 5 条，不展开整个记忆库 |
| 完整保存规则 | 决定保存时调用 `load_memory_rules` | 默认只在一次提交前使用 |
| L2 场景全文与归档规则 | 整理代理按任务读取 | 在后台上下文中使用，当前场景导航未开启前台自动注入 |
| 后台提取与画像生成过程 | 独立子代理执行 | 不继承主代理注入块，也不把全部执行轨迹送回主任务 |

自动召回默认单条正文最多 **300 字符**，总正文预算 **2,000 字符**；低相关候选可以被筛掉。没有合适结果时可以不插入记忆，不要求每个问题都必须带上若干条历史资料。

这两个字符限制约束的是召回正文，不是扩展的全部上下文开销。包裹说明、编号、工具描述、固定使用提示、正式背景和主动工具结果还会占用上下文。稳定快照有利于提示前缀复用，实际缓存命中与计费仍取决于模型服务。

> **实现依据：** [召回配置](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-config.ts) 定义默认字符预算；[召回实现](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/hybrid-recall.ts) 筛选、排序并截断正文；[MemoryStore](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/core/store.ts) 保存会话背景快照。

## 完整规则按需加载，用完释放

主代理有记忆使用提示和工具说明。更完整的类型判据、优先级、保存条件与调用契约，等代理决定记录时再通过 `load_memory_rules` 加载。

默认 `once` 模式把规则放入当前调用上下文；一次 `l1_commit` 工具调用完成后清除规则，不再继续自动注入。显式选择 `always` 才会持续加载；代理活动结束时也会清理规则状态。工具返回的是加载状态，完整契约由消息副本注入。

同样的按需设计也用于后台场景归档：整理代理需要腾出场景名额或评估归档时，才调用 `l2_archive_guide` 获取完整规则与事实清单。普通整理不用每次都携带完整归档指南。这一项节省的是**后台整理代理**的上下文。

> **实现依据：** [index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 中的 `load_memory_rules`、`tool_execution_end` 和 `agent_end` 管理规则状态；[archive-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l2/archive-tool.ts) 提供按需归档指南。

## 后台整理使用自己的上下文

L1 提取、L2 整理和 L3 画像处理在独立 Pi 子进程中运行，使用各自的任务说明、工具范围和数据读取入口。主会话继续完成用户任务，后台代理读取它所需的增量对话、记录或场景。

子代理启动时使用自己的系统提示，关闭技能和项目上下文文件的自动加载。扩展也通过子进程标记跳过主代理的记忆注入与后台调度，避免子代理又运行一套主会话流程。

主会话可以显示结果或失败通知，通知卡片保存为界面自定义条目，不作为普通模型消息注入。需要解释某条记忆时，仍可以主动读取有关资料；不会把全部后台执行过程作为每轮必带背景。

> **实现依据：** [spawn.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/spawn.ts) 的 `buildSpawnArgs()` 设置独立系统提示、工具范围、`--no-skills` 和 `--no-context-files`；[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的子进程守卫跳过主代理注入；[notice.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/notice.ts) 用自定义条目呈现通知。

## 召回不无限等待，也不沿用过期结果

自动召回默认最多先等 **1 秒**。超时或失败时放弃这次自动结果，让主任务继续；异步模式则直接放行，仍属于本轮的结果准备好后，才能在后续模型调用前插入。本轮已经一次答完时，可能没有机会使用异步结果。

新轮次开始后，上轮结果即使迟到也不会填入新轮次。自动请求只保留最新待处理项；主代理主动调用的工具查询优先于排队的自动查询。没有可用主题的应答输入可跳过检索，减少没有明确检索目标的调用。

> **实现依据：** [index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 用 `turnToken` 检查结果轮次；[recall-scheduler.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-scheduler.ts) 实现超时、最新自动请求和主动查询优先；[query-noise.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/query-noise.ts) 决定替换或跳过无主题查询。

这些设计控制了历史累积、资料加载范围和召回等待时间，但仍有模型调用、上下文和后台资源成本。它们支持“尽量把预算留给当前任务”的设计目标；是否改善具体任务效果，需要结合所用模型和真实工作验证。

继续阅读：[记忆如何工作](./memory) · [配置语义召回](./recall) · [后台运行与故障恢复](./pipeline)。
