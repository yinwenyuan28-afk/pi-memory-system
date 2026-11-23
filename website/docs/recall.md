---
title: 召回与注入
description: 从本轮问题到插进上下文的记忆块：查询怎么构造，四道筛选各去掉什么，超时和过期结果怎么处理。
---

# 召回与注入

召回回答一个问题：**本轮回答需要哪些历史记录**。它和后台整理是两条独立路径，只读不写。

## 一次召回要过四道筛选

<MemoryFlow kind="recall" />

四道筛选解决的是不同问题，不能互相替代：

| 筛选 | 解决什么 | 默认值 | 调大会怎样 |
| --- | --- | --- | --- |
| 相关性阈值 | 去掉明显不相关的候选 | `minScore = 0.2` | 命中变少，噪声也变少 |
| 隐藏已关闭任务 | 不让做完的事占待办名额 | `hideClosedTasks = false` | 命中变少，看不到已完成任务 |
| 项目加权 | 同项目排前面，但不删除异项目 | 异项目 ×0.75 | 权重越低同项目占比越高 |
| 字符预算 | 控制最终占用 | 单条 300、总量 2,000 字 | 单轮上下文变长 |

阈值卡的是**真余弦相似度**，加权分只用于同一批候选内部排序。两者语义不同，所以加权不能顺便改阈值：阈值是"够不够相关"，加权是"在都够相关的里面先给谁"。

> 实现依据：[memory/search/hybrid-recall.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/hybrid-recall.ts) 的 `recallL1Records()` 中闸门 1、1.5、加权段与闸门 2；默认值见 [memory/search/recall-config.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-config.ts) 的 `DEFAULT_RECALL_CONFIG`。

## 查询不是原样送进向量库

把用户原话直接拿去检索有个实测问题："同意""提交""需要"这类输入本身没有检索主题，但长度很短，会被当成"需要扩展上下文"，于是变成"噪声原文 + 真实历史"一起做 embedding。噪声占掉一半权重，把真实意图稀释了。

当前做法分三档：

| 档 | 条件 | 用什么当查询 |
| --- | --- | --- |
| `bare` | 输入本身有实质内容 | 原样使用（必要时追加最近两条用户消息帮助解析指代） |
| `replaced` | 输入是噪声，但历史里找得到实质内容 | **用历史替代**，不保留噪声原文 |
| `skipped` | 输入是噪声，历史也找不到 | 跳过本轮召回，不发 embedding |

`replaced` 会先看最近的用户消息，找不到再看上一条助手回复。理由很实际："提交"这类推进指令，意图往往写在助手的上一条回复里。

斜杠命令和纯符号输入走另一条判断，直接跳过。它们属于命令语法层面的判断，和语义噪声是两回事："`/skill:plan-ex`" 只有两个字，但意图明确。

> 实现依据：[util/query-noise.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/query-noise.ts) 的 `isNoisePrompt()` / `buildQueryText()`；[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的 `before_agent_start` 中斜杠与纯符号判断。

## 调度器：会话内单飞

同一会话里，任何时刻最多只有一个召回在真正执行。并发召回会重复消耗 embedding 配额，还会引入"旧结果覆盖新结果"的竞态。

请求分两类，语义不同：

| 类型 | 来源 | 丢弃策略 | 为什么 |
| --- | --- | --- | --- |
| `inject` | 每轮自动召回 | 单槽，新的覆盖旧的 | 旧结果对新一轮没有价值 |
| `demand` | 主代理主动调工具 | 每个都必须返回结果或错误 | 工具调用在等结果，永不返回会挂住循环 |

闸门释放绑定的是**底层真正结束**，不是等待超时。因为超时只意味着"这个结果不再值得用"，底层的网络请求可能还在跑。如果按超时释放，下一个请求就会和它并发，直接破坏单飞。

底层也可能永远不结束（不可取消的网络等待），所以还有一道最长持有上限，到点强制释放并记警告。

> 实现依据：[memory/search/recall-scheduler.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-scheduler.ts) 的 `createRecallScheduler()`：`start()` 里的结果定时器与闸门定时器分别管结果可用性和闸门占用。

## 阻塞与异步两种等待方式

| 模式 | 行为 | 代价 |
| --- | --- | --- |
| `blocking`（默认） | 最多等 1 秒，拿到结果就本轮注入 | 最多增加 1 秒首字延迟 |
| `async` | 立即放行回答，结果就绪后在下一次模型调用前插入 | 本轮首次调用一定没有记忆 |

默认值选 1 秒来自实测：召回链路的净耗时中位数约 457 毫秒、90 分位约 1,326 毫秒，1 秒上限能覆盖多数轮次。

::: warning 超时后不会补注入
阻塞模式超时后，本次请求会被结算为 `timeout` 并尽力取消底层请求。即使底层之后成功返回，也不会再写回本轮上下文——结果写入入口只接受 `ok`。

所以当前行为和早期文档写的"超时后仍可在后续调用补注入"不同。实测口径是：**超时就放弃本轮自动记忆**。需要记忆时可以让主代理主动调用 `recall_l1_records`。
:::

`async` 模式的补注入确实存在，但它只对"本轮还有后续模型调用"的情况有效。一次问答就结束的轮次没有机会使用这个结果。

> 实现依据：[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的 `before_agent_start` 中 `applyResult()` 只接受 `outcome === "ok"`，以及 `injectMode` 分支；[memory/search/recall-config.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-config.ts) 的 `injectTimeoutMs` 注释记录了 457ms / 1326ms 的实测值。

## 结果过期就不再使用

每轮开始时轮次编号加一。召回结果写回前检查编号是否仍是当前轮：不是就丢弃。

这解决异步模式下的一个具体问题：上一轮的召回可能在本轮开始后才返回。如果不丢弃，用户会看到"上一轮问题的答案背景"被塞进这一轮。

自动召回还只保留最新一项：新一轮开始时，上一轮还没执行的自动请求直接作废。主动工具查询不丢，它们排队依次执行。

> 实现依据：[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的 `turnToken` 递增与 `applyResult` 中的比对；[memory/search/recall-scheduler.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-scheduler.ts) 的 `pendingInject` 单槽语义。

## 命中在什么时候计数

"召回返回"和"真的用上"是两件事。命中统计只在记忆块真正进入上下文时加一：

| 路径 | 计数时机 | 原因 |
| --- | --- | --- |
| 自动注入 | `context` 事件把块插入副本时 | 召回返回后可能整轮都没被读出 |
| 工具召回 | 结果返回给主代理时 | 工具结果必然会进入对话 |
| 同轮重复 | 只计一次 | 自动注入和工具召回可能命中同一条 |

没有这条区分，异步和超时场景会把"算过但没用上"的记录也算成命中，质量分就会被虚高的命中次数带偏。

被用户从上下文清理掉的记录另记无效命中。有效命中 = 命中次数 − 无效次数。同一轮里注入和工具结果重复的记录只算一次。

> 实现依据：[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的 `context` 事件中 `hitsCounted` 标记与 `currentTurnHitSet`；[memory/search/hybrid-recall.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/hybrid-recall.ts) 的 `countHits` 选项；[memory/stats/l1-hit-stats-db.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/stats/l1-hit-stats-db.ts) 的 `recordHits()` / `recordInvalid()`。

## 项目加权为什么不是过滤

最初的设计是"项目不同就扔掉"。实测否掉了这个方案：同项目和异项目候选的余弦分布中位数几乎相同（0.605 对 0.599），扔掉异项目会连带扔掉真正相关的高分记录。

改成加权后保留强度信息：异项目记录仍能参与竞争，只是往后排。权重取 0.75 是离线模拟的平台期起点，再往下调跨项目占比不再下降，只会损害同项目低分记录。

代价是通用记录（`global` / `unknown`）占比上升。这是有意的取舍：通用做法换个项目依然成立，因为"不属于你的项目"就不告诉你是误伤。

**什么时候不加权**：会话项目判定拿不到、或判定器弃权（`flag = false`）时，所有系数为 1.0，完全退回原有行为。拿"不知道"当"不是"，会让判定覆盖率之外的会话平白损失召回质量。

加权生效时检索量放大一倍。原因是加权会把同项目记录往前提，如果只取最终条数，被压后的同项目记录根本没机会进入排序。

> 实现依据：[util/recall-score.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/recall-score.ts) 的 `scoreRecord()` 与文件头的权重对照表；[memory/search/hybrid-recall.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/hybrid-recall.ts) 的 `PROJECT_WEIGHT_FETCH_MULTIPLIER`。

## 主动召回与自动召回的区别

主代理也可以主动查记忆，走的是同一个检索函数，但行为有几处不同：

| 维度 | 自动注入 | 主动工具召回 |
| --- | --- | --- |
| 条数 | 最多 3 条 | 默认 5 条 |
| 项目加权 | 有会话判定时生效 | 不生效，保持余弦顺序 |
| 等待 | 最多 1 秒 | 按 `timeoutMs` 等待，默认 5 秒 |
| 结果去向 | 插在用户消息后 | 作为工具结果进入对话 |
| 是否可重复 | 每轮一次 | 每轮最多 3 次（提示词约定，非代码强制） |

主动召回条数多，是因为它回答"还有没有相关的"，需要更宽的候选池；自动注入是无条件插入，条数必须克制。

## 保存了却召回不到，按顺序查

| 检查 | 怎么看 | 常见原因 |
| --- | --- | --- |
| 记录是否存活 | 查看器 L1 页 | 被新版本覆盖成 `deleted` |
| 是否有向量 | `/my-memory:l1:embedding:list` | 向量化关闭或未达阈值，历史记录没有向量 |
| 查询是否相关 | 看 `memoryDB/logs/recall.log` | 阈值 0.2 过滤掉了低相关候选 |
| 是否被字符预算截掉 | 同上，看 `kept` 数量 | 候选够但总量超预算 |
| 是否被隐藏 | 检查 `hideClosedTasks` | 已关闭任务被排除 |
| 本轮是否超时 | 日志里的调度器记录 | 1 秒内没返回 |

日志里每条召回会打一行汇总：候选数、被阈值滤掉多少、最终保留几条、查询前 40 字、每条命中的分数，以及项目加权是否生效。调阈值和判断权重是否真的在跑，都靠这一行。

继续阅读：[记忆模型](./memory-model) · [上下文与渐进式设计](./context-design) · [配置与运行参数](./configuration)。
