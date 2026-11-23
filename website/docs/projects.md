---
title: 项目归属与记忆空间
description: 工作目录、项目、场景三层概念的区别，以及 profile 怎样分开存储。
---

# 项目归属与记忆空间

同时处理多个项目时，你希望 Pi 优先想起当前项目的约定，也能复用通用经验。项目归属影响排序；需要彻底分开时用 profile。

## 三个概念，不能互相替代

| 概念 | 回答什么 | 来源 | 例子 |
| --- | --- | --- | --- |
| 工作目录 `cwd` | 会话从哪里启动 | 会话文件头或运行时上下文 | 从 `C:/dev` 启动 Pi |
| 项目 `project` | 这条记忆属于哪个可交付单元 | 项目判定 + 正文路径证据 | 实际改的是 `C:/dev/order-service` |
| 场景 | 正在处理哪个议题 | 提取时复用或新建 | 订单服务的回调幂等 |

会话从 A 目录启动后仍可能改 B 项目的代码，所以 cwd 不能代替项目标签。同理，一个 Git 仓库可能包含多个独立可交付的项目，仓库根也不一定就是项目边界。

## 三种适用范围

| 范围 | 含义 | 项目字段 | 召回时 |
| --- | --- | --- | --- |
| `self` | 只在这个项目成立 | 填写项目路径 | 跨项目时 ×0.75 |
| `global` | 明确可以跨项目复用 | 必须留空 | 不降权 |
| `unknown` | 证据不足，放弃判断 | 必须留空 | 不降权 |

`global` 和 `unknown` 都留空项目，但含义相反。前者是"确认通用"，后者是"判不出来"。混成一个会丢信息：前者应该永远可用，后者应该被标记出来以便后续补证据。

::: warning unknown 不等于通用
看到 `unknown` 不要理解成"适用于所有项目"。它表示系统没有可靠结论。这条记录可能只适用于某个项目，只是当时没找到证据。
:::

## 系统怎样判断归属

判断顺序是固定的：

1. **正文路径证据。** 提取代理可以为每条记忆提供 `projectEvidence`，形如 `[{"message_id":"msg1","path":"C:/dev/B/src/file.ts"}]`。提交端会到 L0 归档里核对：这条消息是否存在、路径是否真的出现在正文、是否位于候选项目目录下。三者都对才写入。
2. **会话项目判定。** 正文没有路径证据时，沿用该会话的有效判定结果。
3. **`unknown`。** 上两步都拿不到时显式弃权，不猜。

路径核验有几个细节值得知道：必须命中完整路径边界，`proj-b` 不会被当成 `proj`；兼容盘符、反斜杠和 Git Bash 的 `/c/` 写法；路径里不允许出现 `.` 或 `..` 段。

这套核验只证明"这条路径确实在正文里"，不能证明"哪个目录才是最小可交付单元"。项目定义本身仍需人工判断。

> 实现依据：[memory/l1/project-evidence.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/project-evidence.ts) 的 `createProjectEvidenceVerifier()`；[memory/l1/project-scope.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/project-scope.ts) 的 `normalizeScope()` / `projectForScope()`。

## 会话项目判定怎么做

主进程在每轮活动结束时做一次判定，分三步：

1. **抽候选**（纯代码，只读会话文件）：从会话里出现的路径收集候选项目目录。
2. **变化检测**：候选与上次相同时不发请求，避免每轮都调模型。
3. **模型判定**：候选变化时发起一次判定。同一会话同时只跑一个判定，失败不覆盖旧值。

还有一个保底处理：距上次成功判定超过 20 轮时，无论候选是否变化都重判一次。理由是一个会话可能连续十几轮不碰文件（一直在讨论方案），"候选没变化"不等于"没进展"。

判定结果的 `flag` 字段区分两种情况：`true` 是判出了项目，`false` 是弃权。召回只认 `flag === true`，弃权时所有候选系数为 1.0。

> 实现依据：[util/judg-session-project/setup.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/judg-session-project/setup.ts) 的 `setupJudgSessionProject()` 与 `REJUDGE_EVERY_ROUNDS`；[util/judg-session-project/candidates.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/judg-session-project/candidates.ts) 的 `extractCandidates()`。

## 项目如何影响召回

当前会话有有效判定时，召回会在阈值筛选之后、字符预算之前做一次加权排序：

```text
最终得分 = 余弦相似度 × 项目系数
```

| 记忆的情况 | 系数 |
| --- | --- |
| 同一项目 | 1.0 |
| 其他项目的 `self` 记录 | 0.75 |
| `global`、`unknown`、缺少范围标签 | 1.0 |

三个边界要说清：

- **这是排序，不是过滤。** 跨项目记录仍可能进入结果，只是往后排。
- **只影响自动注入。** 主代理主动调 `recall_l1_records` 时不传会话项目，保持余弦顺序。
- **没有判定就不加权。** 完全退回加权功能上线前的行为，不会因为"判不出来"惩罚任何记录。

::: danger 不是权限隔离
项目标签用于相关性排序，不提供访问控制。不要把客户 A 的机密资料和客户 B 的项目混在一个 profile 里，然后指望标签隔离它们。需要硬隔离时用不同 profile。
:::

## 用 profile 分开记忆空间

每个 profile 有独立的记忆文件、配置、向量库和任务队列。

```text
/my-memory:profile list
/my-memory:profile switch client-a
```

第二条切换到 `client-a`；不存在时创建。名称会变成目录名，用简单的英文与短横线。

切换时的几个边界：

| 情况 | 行为 |
| --- | --- |
| 切换前已运行的任务 | 按原 profile 收尾，写入原空间 |
| 原空间的后续排队任务 | 等该 profile 重新有活动会话才继续 |
| 查看器 | 默认读同一份激活设置，切换后要重启查看器 |
| 宿主技能目录 | 仍可能被读取，profile 不隔离宿主资源 |

profile 把扩展自己的数据分开，但它不是操作系统级权限边界，也不是模型服务的数据隔离。需要保密边界时还要检查宿主配置、模型服务的数据处理方式和查看器的访问范围。

> 实现依据：[memory/core/profile.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/core/profile.ts) 的 `ProfileManager`；[index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) 的 `my-memory:profile` 命令；切换写入 Pi 的 `settings.json` 中 `memorySystem.activeProfile`。

## 场景标签和项目的关系

场景名形如 `{项目}｜{议题}`，提取时用前缀判断同项目优先。但这只是**提示**，不是数据关系：场景池才是场景归属的权威来源，记录里的 `scene_name` 只是写入时的名字快照。

同一议题的多条记忆应该复用同一个场景编号。排查、实现、验证等活动变化时继续复用；议题改变时才新建。这条规则防止同一件事裂成十几个名字相近的场景。

继续阅读：[记忆模型](./memory-model) · [召回与注入](./recall) · [数据、隐私与备份](./data)。
