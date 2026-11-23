---
title: 上下文与渐进式设计
description: 记忆的注入位置、会话边界、按需加载，以及后台整理怎样不占主会话上下文。
---

# 上下文与渐进式设计

编码代理的上下文是有限预算。这个扩展的做法不是"把所有记忆都塞给模型"，而是按"这一轮到底需要什么"分层供给。

## 四种资料，四种进入方式

| 资料 | 进入方式 | 占用控制 |
| --- | --- | --- |
| 正式 `MEMORY.md` / `USER.md` | 会话开始时读成快照，拼进 system prompt | 会话内不变，长度固定 |
| 本轮相关 L1 记录 | 每次模型调用前召回，插在用户消息后 | 最多 3 条，单条 300 字，总量 2,000 字 |
| 完整保存规则 | 代理决定要记时调 `load_memory_rules` | 默认一次提交后清除 |
| 后台整理过程 | 独立子进程，自己的上下文 | 不进入主会话 |

前两项是自动的，后两项按需。这个顺序也说明了预算优先级：稳定背景每轮都在，但不变；相关记录每轮变化，但很短；规则和整理过程只在需要时展开。

## 记忆块插在哪儿

<MemoryFlow kind="injection" />

插入位置固定在**最后一条用户消息之后**，不是对话末尾。这个选择解决两个问题：

**注意力位置。** 如果把记忆块追加到末尾，工具轮次里它会紧贴工具结果，模型容易把它当成"最新到达的输入"，反复判断"这条记忆和当前任务是否相关"，浪费推理。

**前缀稳定。** 位置固定意味着每条消息的内容不会因为后续插入而位移，模型服务的前缀缓存更容易命中。

一次回答包含多次工具调用时，顺序是：历史 → 本轮用户问题 → 记忆块 → 助手工具调用 → 工具结果 → 下次模型调用。记忆块始终跟着它所辅助的那个问题。

> 实现依据：[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的 `context` 事件：从后往前找最后一条 `role === "user"` 作为锚点，`splice(anchorIdx + 1, 0, ...injected)`；没有用户消息时才 `push` 到末尾。

## 自动注入块不写回会话文件

`context` 事件处理的是**模型调用前的消息副本**。扩展在副本里插入记忆块并返回，主会话的 JSONL 文件不增加这条消息。

这个边界让长期会话不会因为每轮召回而不断膨胀：第 100 轮的历史里不会有 100 份记忆块。每轮从持久历史重新组装上下文，再插入当轮就绪的参考内容。

"不写回"专指**自动插入的记忆块**。下面这些仍然会进入会话历史：

- 主代理主动调用 `recall_l1_records` 的工具结果
- 助手基于这些结果生成的回答
- 界面通知（作为自定义条目保存，不作为模型消息）

L0 归档和 L1 记录也各自持久保存，不受这个边界影响。

> 实现依据：[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的 `context` 事件返回 `{ messages }` 但不写盘；[util/notice.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/notice.ts) 的 `noticeCard()` 使用自定义条目。

## 完整规则按需加载

主代理随时能看到"记忆工具怎么用"的简短提醒，但完整的类型判据、优先级分档、保存边界不在每轮提示里。

当代理判断需要记录时，调 `load_memory_rules` 获取完整契约：

| 模式 | 行为 | 什么时候清 |
| --- | --- | --- |
| `once`（默认） | 规则进入当前上下文 | 一次 `l1_commit` 完成后清除 |
| `always` | 规则持续存在 | 代理活动结束时清除 |

这个设计节省的是**写入时的上下文**。多数轮次根本不写记忆，没必要每轮都带着完整契约。

同样的思路用在后台：L2 需要腾场景名额或考虑归档时，才调 `l2_archive_guide` 拿完整规则和事实清单。普通整理不用每次都带归档指南。

> 实现依据：[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的 `load_memory_rules` 工具、`tool_execution_end`（`l1_commit` 后清 `once`）、`agent_end`（清全部）；[memory/l2/archive-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l2/archive-tool.ts) 的 `buildArchiveGuide()`。

## 后台用自己的上下文

<MemoryFlow kind="subagent" />

后台子代理不继承主代理的注入块、系统提示快照和待注入上下文。主进程只把任务说明、文件路径和进度位置发给它，它用自己的工具读取所需资料。

三个具体效果：

**执行过程不污染对话。** 子代理读了多少文件、调了几次提交工具，都不出现在主会话里。主会话只看到结果卡片或一行提示。

**不会重复学习。** 子代理自己的会话文件不会被 L0 归档，所以下一轮提取不会把"如何提取记忆"当作用户工作内容。

**通知要过一道文件。** 子代理进程不能直接在主会话弹卡片，通知先写入 `logs/notices.jsonl`，主进程在任务收尾时取出渲染。这样长任务期间主会话不会被后台过程占满。

> 实现依据：[util/spawn.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/spawn.ts) 的 `buildSpawnArgs()`；[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的 `PI_SUBAGENT_CHILD` 守卫与 `agent_settled` 中的 `drainNoticeCards()`。

## 召回不无限等待，也不用过期结果

自动召回默认最多等 1 秒，超时放弃本轮结果。异步模式直接放行回答，结果就绪后在下一次模型调用前插入。

三道限制共同保证"记忆不会拖住回答"：

| 限制 | 值 | 作用 |
| --- | --- | --- |
| 结果等待上限 | 1 秒（`injectTimeoutMs`） | 控制本轮首字延迟 |
| 闸门持有上限 | 35 秒（`maxHoldMs`） | 防止底层永不返回造成死锁 |
| 轮次校验 | 每轮递增 | 过期结果不填入新轮次 |

没有可用主题的输入直接跳过检索，不发 embedding。这不只是省一次调用，也避免"用噪声查询捞回一批不相关记录"。

> 实现依据：[memory/search/recall-config.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-config.ts) 的 `injectTimeoutMs` / `maxHoldMs`；[memory/search/recall-scheduler.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-scheduler.ts)；[util/query-noise.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/query-noise.ts)。

## 这些预算的真实边界

字符预算约束的是**召回正文**，不是扩展的全部上下文开销。以下内容不在这个预算里：

- `<l1-records>` 包裹说明和记录编号
- 记忆工具的描述与每轮固定提醒
- 正式背景 `MEMORY.md` / `USER.md` 全文
- 主动工具召回返回的结果
- 加载的完整规则契约

所以"单条 300 字、总量 2,000 字"不能当作扩展的总 token 上限宣传。它是"这一轮注入多少条相关记忆"的控制参数。

稳定快照有利于提示前缀复用，但实际缓存命中与计费仍取决于模型服务，扩展无法保证。

继续阅读：[召回与注入](./recall) · [记忆模型](./memory-model) · [配置与运行参数](./configuration)。
