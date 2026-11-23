---
title: 后台流水线
description: 一批对话怎样变成记忆：计数、排队、认领、提交、收尾，以及失败后从哪儿继续。
---

# 后台流水线

记忆不是发完一句话就出现的。它要经过一次完整链路：归档、计数、排队、子代理处理、提交、收尾。这中间任何一步都可能失败，所以每一步都要能回答"处理到哪儿了"和"重来会不会重复"。

## 先分清四个时刻

排查"记忆为什么还没出现"时，先确认卡在哪个时刻。这四个时刻含义完全不同：

| 时刻 | 你看到的 | 实际含义 |
| --- | --- | --- |
| 已归档 | L0 分片文件变长 | 正文已经写入磁盘，但还没被提取 |
| 已入队 | 流水线页有 `queued` 任务 | 排队成功，还没有子代理在跑 |
| 已派发 | 有 `running` 任务和子进程 | 子代理在跑，不代表会成功 |
| 已提交 | 任务变 `done`，游标前进 | 这一批真正完成 |

只有第四个时刻算完成。子进程退出、状态栏转完、通知卡片出现都不等于提交成功：真正的完成信号是子代理调用提交工具，把任务和游标一起推进。

> 实现依据：[memory/pipeline/jobs-db.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/pipeline/jobs-db.ts) 的 `claim()` / `complete()`；[memory/l1/commit-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/commit-tool.ts) 的 `completeRunningL1()` 与 `saveCursor()`。

## L1：从计数到收尾

<MemoryFlow kind="background" />

**计数有两个条件。** 输入必须来自交互界面（工具调用、自动跟进不算），并且 L1 当前既没有排队任务也没有运行任务。第二条容易被忽略：L1 忙碌期间的输入不会攒着，它们照常进 L0，等这批处理完由积压链继续消化。

**触发在活动结束后检查。** 达到 10 次时不会立刻派发，而是等当前代理活动结束（`agent_settled`）。这时才检查 L0 是否存在游标之后的增量：有增量就入队并清零计数，没有增量也只清零、不排队。

**入队有去重。** 同层已有排队或运行中的任务时，`enqueue()` 返回原任务而不是新建。所以手动连点触发不会堆出多个任务。

**每批最多 25 条消息。** 读取按分片字节偏移推进，只取完整 JSONL 行，游标之前最近 5 条作为背景供理解、不再提取。容量不按时间切，所以同一批写入的多条消息也能安全分批。

**提交后继续消化积压。** L1 收尾时检查两件事：L0 还有增量就再排一个 L1；积压清空且有新记录就排一个 L2；两者都没有才结束。这样积压不需要用户再聊够 10 轮，也不会每提交一批就启动一次完整的 L2。

> 实现依据：[memory/l1/index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/index.ts) 的 `setupL1Extractor()`；[memory/l1/config.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/config.ts) 的 `L1_INTERVAL` / `listL0Files()` / `buildL1Task()`；[memory/l1/read-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/read-tool.ts) 的 `readL0Increment()`；[memory/pipeline/worker.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/pipeline/worker.ts) 的 `decideNextAfterL1()`。

## 队列：三层共用一条

L1、L2、L3 不各跑各的，它们共用一条持久队列和一个 worker：

<MemoryFlow kind="pipeline" />

几个设计细节值得单独说明：

**被阻塞的层不拖住整条队列。** 早先的取法是"取队首，如果队首那层熔断就整条队列等着"。实测出过事故：L2 连败熔断后，排在它后面的 L1 被堵了 5 个多小时，用户手动触发又被"已在队列中"挡回，看起来像卡死。现在的语义是"这一层别跑"，跳过它继续看后面的任务。

**手动触发可以复位熔断。** 熔断要人工复位是设计，但复位入口不能也被挡住，否则用户无路可走。手动触发时如果本层有被熔断压着的排队任务，就复位熔断并让它按原队序执行；真有任务在跑时才拒绝。

**认领是原子的。** 检查"整条队列空闲"和"把任务改成 running"写在同一条 UPDATE 里。多个 Pi 进程共用同一个 profile 时，也只能有一个认领成功。

**L3 永远排在最后。** 它读的是 L2 的产物，先跑没有意义。

> 实现依据：[memory/pipeline/worker.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/pipeline/worker.ts) 的 `pickNextClaimable()` / `decideManualTrigger()` / `drain()`；[memory/pipeline/jobs-db.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/pipeline/jobs-db.ts) 的 `listQueued()` / `claim()` / `enqueue()`。

## 失败后从哪里继续

**进度只在提交成功时前进。** L1 的游标、L2 的水位、L3 的计数都是提交工具写的，不是 worker 估算的。子代理没提交就退出、被硬上限停掉、或者派发失败，进度都停在原位，下次读到同一批输入。

代价是重做，收益是不漏。这比"靠时间戳猜处理到哪儿"可靠，因为时间戳在批量写入和并发场景下会切错边界。

**连续失败 3 次后暂停该层。** 计数写在 `state/failure-state.json`，重启不会清零。暂停只影响自动执行：该层的排队任务留着，其他层照常跑，手动触发可以恢复。

**部分写入不会自动回滚。** 保留进度说的是"下次重读这批输入"，不是"上次的写入都撤销了"。一条批里可能有几条已经追加成功、几条失败，检查结果时要看实际写入数，不能只看任务状态。

> 实现依据：[memory/failure-state.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/failure-state.ts) 的 `loadFailureState()` / `isLayerHeld()`；[memory/l1/index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/index.ts) 的 `executeJob()` 中对失败计数与 `L1_FAILURE_THRESHOLD` 的处理。

## 慢任务：等待还是停止

模型一轮生成可能很久，会话文件在这段时间一个字节都不增长，所以"文件没变化"不能当卡死判据。

| 阈值 | 默认值 | 到点做什么 |
| --- | --- | --- |
| 软阈值 `softMs` | 10 分 30 秒 | 只记日志、更新状态栏，继续等 |
| 硬上限 `hardMs` | 30 分钟 | 进入停止流程 |

停止流程按顺序做四件事：先落停止标记，让该层的写工具在入口拒写；留 10 秒给正在进行的提交收尾；再终止进程树；最后确认退出并修复可能只写了一半的文件。

停止标记在入口拦写，而不是强杀在写入中间，是为了把"被杀点"推到一个操作边界。这样不会出现"记录追加了、游标没推进"这种需要人工判断的半成品。

**确认不了进程已死时，隔离该层 30 分钟。** 此时放新任务进去会产生两个写者同时改场景块。其他层不受影响。

> 实现依据：[memory/pipeline/timeout-config.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/pipeline/timeout-config.ts) 的 `DEFAULT_SOFT_MS` / `DEFAULT_HARD_MS`；[memory/pipeline/subagent-kill.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/pipeline/subagent-kill.ts) 的 `stopSubagent()`；[memory/pipeline/subagent-liveness.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/pipeline/subagent-liveness.ts) 的 `waitJobWithLiveness()`。

## 为什么需要三把锁

后台写入来自不同进程：主进程调度，子代理提交，命令行工具和查看器也可能写同一批文件。一把锁覆盖不了所有区间：

<MemoryFlow kind="locks" />

| 锁 | 位置 | 覆盖范围 | 防什么 |
| --- | --- | --- | --- |
| 队列锁 | `jobs.sqlite` 原子 UPDATE | 一次认领 | 同一任务被派发两次 |
| 运行锁 | `state/run-lock-<layer>.lock/` | 整个子代理运行，定期续期 | 监督者误判后两个同层写者 |
| 提交写锁 | `memoryDB/.l1-admin-write.lock/` | 一次文件改写，最长等 10 秒 | 分片读-改-写交错 |

运行锁的必要性容易低估：如果只靠队列锁，主进程重启或超时误判释放了队列槽位，旧子代理可能还在写，新子代理又起来写同一层。运行锁由真正要写的那一方持有，跨整个运行，回收时优先看持有进程是否还活着，其次看心跳，最后才看总过期时间。

主代理主动保存记忆不受运行锁阻挡（用户触发的记录不该被后台锁挡住），但仍要经过提交写锁，保证文件追加不交错。

> 实现依据：[memory/pipeline/run-lock.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/pipeline/run-lock.ts) 的 `acquireRunLock()` / `forceReleaseRunLock()`；[memory/l1/write-lock.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/write-lock.ts) 的 `acquireWriteLock()`；[memory/l1/commit-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/commit-tool.ts) 对 `source="main-agent"` 的例外处理。

## 子代理为什么用自己的上下文

<MemoryFlow kind="subagent" />

后台子代理是独立 Pi 进程，不是主代理的一个工具调用。它用独立的 system prompt、工具白名单和会话目录启动，并且明确不加载项目指令文件和技能。

不继承主代理上下文有具体原因：如果子代理带着主代理的召回块去提取记忆，上一轮注入的记忆会被当成"对话内容"再提取一遍，越滚越多。同理，子代理自己的执行过程（读文件、调提交工具）也不能进 L0，否则下一轮会把"如何提取记忆"当作用户工作内容学习。

进程身份用环境变量标记。子代理加载同一份扩展代码，但看到标记后跳过注入、调度和命中计数，只保留工具注册。

> 实现依据：[util/spawn.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/spawn.ts) 的 `buildSpawnArgs()`（`--system-prompt`、`--tools`、`--no-skills`、`--no-context-files`）；[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 中 `PI_SUBAGENT_CHILD` 的守卫。

## 怎样观察和干预

| 想知道什么 | 看哪里 |
| --- | --- |
| 距离 L1 触发还有几次输入 | 底部状态栏的 `memory` 项 |
| 当前哪一层在跑、跑了多久 | 状态栏、查看器「流水线」页 |
| 排队、运行、最近结束的作业 | 查看器「流水线」页 |
| 某层为什么失败 | `memoryDB/logs/{l1,l2,l3,pipeline}.log` |
| 失败计数与暂停状态 | `memoryDB/state/failure-state.json` |
| 子代理自己的完整过程 | `memoryDB/subagent-sessions/<layer>/` 下的会话文件 |

需要提前停止时用 `/my-memory:subagent-kill l1`（换层同理），它走同一套停止流程，比自己删锁文件安全。关闭主会话只停止新的派发，在途任务按原空间收尾；对应 profile 重新有活动会话后，之前保存的排队任务才继续。

继续阅读：[召回与注入](./recall) · [配置与运行参数](./configuration) · [数据、隐私与备份](./data)。
