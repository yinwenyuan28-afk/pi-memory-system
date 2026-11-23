---
title: 工程质量
description: 这个记忆系统怎样保证不丢、不重、不错：进度、幂等、锁、失败隔离与可观测性。
---

# 工程质量

记忆系统比一般业务功能难写，因为它同时具备四个特征：长时间运行、调用外部模型、多进程写同一批文件、失败后必须能从原位继续。这一页讲这些约束怎么落到代码里。

如果你要讲清楚这个项目，这一页比功能列表更能体现设计判断。

## 一个核心不变量：进度只跟着提交走

所有层的处理进度都只由一个地方推进——提交工具成功执行。这带来三条推论：

1. **没有"猜"出来的进度。** 不用文件修改时间、不用进程存活时间、不用日志最后一行来判断"处理到哪儿了"。
2. **失败重做的代价是重复而不是丢失。** 进度停在旧位置，下次从同一批输入重新读。重复可以靠去重收敛，丢失无法恢复。
3. **超时误判可以纠正。** 子代理在超时判定之后仍然提交成功时，提交端会把已经标为 `failed` 的任务改回 `done`，并重置失败计数。否则"被判失败但还是干完了"会让计数只增不减，累计 3 次就熔断。

| 层 | 进度载体 | 推进条件 |
| --- | --- | --- |
| L0 归档 | `l0/cursor.json`，按会话文件记录行号 | 追加成功，或本轮没有可保存内容 |
| L1 提取 | `l1/cursor.json`，按分片记录字节偏移 | `l1_commit` 成功 |
| L2 整理 | `l2/cursor.json`，记录时间水位 | `l2_commit` 成功 |
| L3 画像 | `l3/cursor.json`，记录场景水位与累计新记忆 | `l3_commit` 成功 |
| 技能审查 | `state/review-cursor.json` | 审查子代理返回 |

字节偏移而不是时间戳，是为了让同一次写入的多条消息也能安全分批。时间戳在并发和批量 flush 场景下会切错边界；字节偏移只认完整的 JSONL 行。

> 实现依据：[memory/l1/read-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/read-tool.ts) 的 `readL0Increment()`：按行扫描、只消费换行符结尾的行、游标指向行尾字节；[memory/l1/commit-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/commit-tool.ts) 的 `reclaimTimedOutL1()`。

## 幂等在哪些地方做

"同一次操作执行两遍"在这个系统里是常态：重试、误判后重提、用户手动补触发。所以关键写入都要幂等：

| 场景 | 幂等做法 |
| --- | --- |
| 归档重复执行 | 行号游标，只处理游标之后的行 |
| L1 任务重复入队 | 同层已有排队或运行任务时返回原任务 |
| 删除同一条记录两次 | 目标已删除时直接跳过，不报错 |
| 正文重复提交 | 提交端计算内容哈希，同批内按哈希去重 |
| 位置写入中途崩溃 | 写临时文件再重命名，避免半个文件 |

有一处刻意的例外：**删除标记是就地改写**，不是追加墓碑行。早期设计是追加一条标删的行，后来改成在原行上把 `deleted` 改成 `true`，正文和编号保留。代价是分片会被反复重写，收益是"同一编号取最后一行"这条规则可以同时覆盖新版本和删除标记。

> 实现依据：[memory/l1/commit-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/commit-tool.ts) 中 `lastAliveById` / `markByFile` / `contentHash()` 的处理；[memory/l1/in-place-mark.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/in-place-mark.ts) 的 `rewriteShardRows()` 使用临时文件加重命名。

## 三把锁的分工

<MemoryFlow kind="locks" />

锁的粒度不是拍出来的，每一把对应一个真实的错误场景：

| 锁 | 曾经的错误 | 现在的保障 |
| --- | --- | --- |
| 队列锁 | 两个触发同时插入同层任务 | 查重和插入在同一个写事务里 |
| 运行锁 | 监督者误判释放队列后，旧子代理仍在写 | 锁由真正写入方持有，跨整个运行，按 PID、心跳、过期时间依次判断 |
| 提交写锁 | 两个进程同时读-改-写同一分片，后写覆盖前写 | 目录占位锁，一次只允许一个改写 |

回收锁的顺序很重要：先看持有进程是否还活着，再看心跳是否过期，最后才看总过期时间。持有者信息不可读时**保守等待**，不贸然放行——误清的代价是两个写者并发改同一批文件，比多等几分钟严重。

## 失败隔离：一层坏不拖垮全部

| 失败类型 | 影响范围 | 恢复方式 |
| --- | --- | --- |
| 单批未提交 | 该层进度不动 | 下次触发重读同一批 |
| 连续失败 3 次 | 该层暂停自动执行 | 手动触发复位 |
| 硬上限未提交 | 停止子代理并标失败 | 修复后手动触发 |
| 停止后无法确认进程已死 | 隔离该层 30 分钟 | 到期自动解除 |
| 向量写入失败 | 记录已写入磁盘，只缺向量 | 运行补齐命令 |
| 场景池写入失败 | 记录已写入磁盘，场景名仍在 | 下批重建同名条目 |

注意最后两行：这些是**非致命失败**，已经写入磁盘的部分不回滚，缺的部分留给后续修复。设计判断是"写进去的数据比没写进去的值钱"，所以宁可能部分成功。

相反的情况是合并场景：那里要求整批成功或整批拒绝，因为合并会删除源块，半成功会留下重复或丢失。

> 实现依据：[memory/failure-state.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/failure-state.ts) 的 `isLayerHeld()` / `holdUntilFrom()`；[memory/l2/commit-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l2/commit-tool.ts) 的 `checkConsolidation()` 与备份逻辑。

## 写盘前的两道检查

记忆一旦写进去就会被后续召回使用，所以写入路径上有一道格式检查和一道价值检查。

**格式检查用代码做。** 存活记录必须有非空正文、合法类型、0–100 的优先级；`taskState` 只能是三个取值之一，且只对 `work_task` 有意义。违反这些直接拒绝整批，并指出是第几条。它们都是"确定错了"，不该花一次模型调用去判断。

有几项是软检查：来源消息编号缺失、正文超过召回预算、非任务记录带了任务状态。这些只报告数量、不阻止写入，避免因为一条瑕疵让整批重做。

**价值检查用一次模型调用。** 判据直接摘自提取规则里的标记段，保证"规则说该记的"和"复核认为该记的"同源。它只判断保留、丢弃还是改类型，不重写内容。

价值检查跑在取写锁之前，避免抱着锁等模型。判据抽取失败、调用失败或解析失败时一律放行并留痕——它是附加判断，不能把写入这条主链拖垮。

> 实现依据：[memory/l1/commit-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/commit-tool.ts) 的确定性闸门段与价值校验段；[memory/l1/value-check.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/value-check.ts) 的 `runValueCheck()` / `applyVerdicts()`；[util/agent-loop.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/agent-loop.ts) 的 `runAgentLoopOnce()`，默认 1 轮、上限 3 轮。

## 可观测性：出问题时能查什么

系统有四层可观察信息，用途不同：

| 层 | 位置 | 适合查 |
| --- | --- | --- |
| 状态栏 | Pi 底部 `memory` 项 | 距离触发还有几次、当前哪层在跑 |
| 查看器 | 本地页面 | 记录、场景、画像、队列的整体状态 |
| 日志 | `memoryDB/logs/{scope}.log` | 某次召回的分数、某批提交的数量、失败原因 |
| 子代理会话 | `memoryDB/subagent-sessions/<layer>/` | 后台那一次到底做了什么 |

日志按范围分文件：`recall`、`l1`、`l2`、`l3`、`pipeline`、`store`、`l0`、`skill`、`notice`、`judg`。每份到 5 MB 轮转一代，不会无限增长。

召回日志尤其值得看，它把一次召回的全过程压在一行里：

```text
recall=8 filtered=3 kept=3 minScore=0.2 q="订单回调为什么要用事件编号…"
| hits: l1_...@0.71 l1_...@0.65 ... | pf=on(w=0.75,m=2,x=1,g=0)
```

`filtered` 说明阈值滤掉几条，`kept` 是最终注入几条，`pf=` 说明项目加权有没有真的生效。

## 验证：33 个离线脚本

项目用 `verify-*` 脚本覆盖可以离线验证的部分，不依赖真实模型和真实记忆库：

| 类别 | 例子 |
| --- | --- |
| 纯函数逻辑 | `verify-query-noise.ts`、`verify-recall-score.ts`、`verify-l2-config.ts` |
| 队列与锁 | `verify-pipeline-serial.ts`、`verify-pipeline-concurrency.ts`、`verify-run-lock.ts` |
| 提交与数据 | `verify-l1-value-check.ts`、`verify-l2-consolidate.ts`、`verify-l3-commit.ts` |
| 子代理派发 | `verify-self-spawn.mts`、`verify-subagent-stop.ts` |
| 提示词契约 | `verify-prompt-contracts.mjs`、`verify-tool-schemas.ts` |
| 查看器 | `verify-viewer-deploy.ts`、`verify-viewer-write-paths.ts` |

两个值得注意的验证思路：

**提示词契约逐字节比对。** 提示词模板有变量渲染，改动一处很容易让模型收到与实际行为不符的指令。验证脚本用固定输入渲染，与内嵌的基线逐字节比对，同时检查所有引用可解析、所有变量都有值。

**提示词里的数字来自代码。** 召回条数、纠错证据长度、防抖间隔这些会同时出现在代码和提示词里的值，集中在一个零依赖的常量文件里，两边都从它读取。这样改代码不会漏改提示词。

这套验证不覆盖真实模型的提取质量、网络性能和恢复效果，这些只能靠实际使用观察。文档不应把"脚本通过"说成"功能验证完毕"。

> 实现依据：[scripts/](https://github.com/yinwenyuan28-afk/pi-memory-system/tree/main/scripts) 下的 `verify-*.ts` / `verify-*.mjs`；[config/thresholds.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/config/thresholds.ts) 是"需要被提示词回显的阈值"的单一来源；[prompts/registry.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/prompts/registry.ts) 提供渲染与变量检查。

## 已知缺口

诚实列出当前没做到的地方：

| 缺口 | 表现 | 影响 |
| --- | --- | --- |
| `chat` 模式类型不匹配 | 提示词产出 `persona` / `episodic` / `instruction`，提交端只接受 `work_*` | 该模式记录提交会被拒 |
| 命令行工具未实现提交写锁 | `scripts/l1-admin/` 的 `.mjs` 写者只检查运行锁（`task-state.mts` 除外，它走 `task-state.ts` 会取写锁） | 手动批量改写与子代理提交可能交错 |
| 活跃日时钟是全局的 | 不区分项目 | 多项目并行时，休眠项目的记录仍会衰减 |
| 查看器桥无鉴权 | CORS 允许任意来源 | 只适合本机可信环境 |
| L2 导航未接入 | 模块存在但无调用点 | 场景内容不进前台上下文 |

这些不影响主要使用路径，但会限制边界场景。面试讨论时，能说清"哪里没做、为什么先不做"比声称全都实现了更有说服力。

继续阅读：[后台流水线](./pipeline) · [召回与注入](./recall) · [限制与数据说明](./limits)。
