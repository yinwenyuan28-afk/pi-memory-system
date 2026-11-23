---
title: 配置与运行参数
description: 配置文件在哪、有哪些节、改哪个字段会改变什么行为。
---

# 配置与运行参数

绝大多数配置集中在一个文件里。理解它分哪几节，能解释"记忆已保存但召回不到"这类问题。

## 配置文件

```text
<agentDir>/profiles/<profile>/memoryDB/config/application-propertis.json
```

文件名里的 `propertis` 是实际拼写，不是笔误。文件是 JSONC，支持 `//` 注释。

几个使用约束：

- 每个 profile 一份，互不影响。
- 手工改完后重启 Pi，主进程与后台进程才会读到同一份配置。
- 已有的 `//` 注释在同一节被程序改写时会丢失，这是当前实现的已知取舍。

> 实现依据：[config/app-config.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/config/app-config.ts) 的 `loadAppProps()` / `saveAppSection()`；[util/jsonc.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/jsonc.ts) 的 `parseJsonc()`。

## 配置分节

| 节 | 管什么 | 默认行为 |
| --- | --- | --- |
| `model` | 后台 LLM 与 Embedding 的连接配置 | 后台 LLM 跟随前台模型；Embedding 未配置 |
| `vectorization` | 是否自动为新记录建向量 | 关闭；阈值 500 条 |
| `recall` | 召回筛选与等待 | 阈值 0.2、最多 3 条、单条 300 字 |
| `l1` | 提取模式与价值复核 | `code` 模式，复核开启 |
| `l2` | 场景数量上限与归档 | 上限 15，归档下限 7 天 |
| `subagent` | 超时与停止参数 | 软 10.5 分钟、硬 30 分钟 |
| `language` | 界面语言 | 跟随系统区域 |

## 模型配置

| 设置 | 用途 | 注意 |
| --- | --- | --- |
| `model.llm` | 后台整理使用哪个模型 | 未指定时跟随前台；切换前台不影响已配置的后台模型 |
| `model.embedding` | 向量化服务地址、密钥、模型、维度 | 必须配齐才能启用向量化 |

推荐用向导配置：

```text
/my-memory:model
```

::: warning 更换 Embedding 模型要重建
不同模型产生的向量不能混用，维度相同也不代表兼容。已有向量表时，向导会阻止直接改成不兼容的维度，但不会自动迁移。更换服务或模型前先备份，然后规划一次全量重建。
:::

## 向量化

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| `vectorization.enabled` | `false` | 新提交的记录是否自动建向量 |
| `vectorization.triggerThreshold` | `500` | 最近 365 天记录达到这个数量才自动启用 |

四个动作是分开的，容易混：

| 动作 | 做什么 | 命令 |
| --- | --- | --- |
| 配置服务 | 填地址、密钥、模型、维度 | `/my-memory:model` |
| 开启开关 | 允许新记录自动向量化 | 同一个向导 |
| 达到阈值 | 记录足够多时自动生效 | 自动判断 |
| 补齐历史向量 | 给已有记录补向量 | `/my-memory:l1:embedding:backfill` |

手动补齐不需要满足 500 条阈值，也不检查自动开关——它只要 Embedding 服务可用。

## 召回参数

| 字段 | 默认 | 改大的后果 |
| --- | --- | --- |
| `minScore` | `0.2` | 命中变少，但更相关 |
| `maxCharsPerRecord` | `300` | 单条注入更长，占用更多上下文 |
| `maxTotalChars` | `2000` | 注入条数可能增加 |
| `contextExpansion` | `conditional` | 更多轮次把历史拼进查询 |
| `injectMode` | `blocking` | 改成 `async` 可省首字延迟，但首跳无记忆 |
| `injectTimeoutMs` | `1000` | 等待更久，首字延迟增加 |
| `maxHoldMs` | `35000` | 闸门被占更久，异常时有更长恢复窗口 |
| `hideClosedTasks` | `false` | 已完成任务不再召回 |
| `timeoutMs` | `5000` | 主代理主动召回等待更久 |

`minScore` 是**真余弦相似度**，不是距离。这个默认值来自 40 条真实用户消息的 top-1 分布采样：P50 约 0.254，取 0.2 能滤掉明显低相关的一段。

::: tip 调整前先看日志
`memoryDB/logs/recall.log` 每次召回都会打一行，包含候选数、被阈值滤掉几条、最终保留几条、每条命中的分数。连续多轮 `filtered` 很多说明阈值偏高；`filtered=0` 且全部保留说明可以适当提高。
:::

自动注入 3 条、主动召回 5 条这两个数字不在配置文件里，它们是代码常量。理由是它们直接决定每轮发给模型的 token 预算，属于需要实测后再定的参数。

## 记忆整理参数

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `l1.mode` | `code` | 提取开发工作的事实、待办、方法与资产 |
| `l1.valueCheck.enabled` | `true` | 提交前用一次模型调用复核候选价值 |
| `l1.valueCheck.maxTurns` | `1` | 复核最多几轮，上限 3 |
| `l1.valueCheck.timeoutMs` | `60000` | 复核超时后放行并留痕 |
| `l2.maxScenes` | `15` | 活跃场景数量上限 |
| `l2.archive.enabled` | `true` | 是否允许归档场景 |
| `l2.archive.minAgeCalendarDays` | `7` | 允许归档的最低真实年龄 |
| `l2.archive.maxPerBatch` | `1` | 每批最多归档几个 |

::: warning chat 模式当前不可用
`l1.mode` 可以设成 `chat`，提示词也会按对话场景提取 `persona` / `episodic` / `instruction` 三类。但提交端只接受 `work_fact` / `work_task` / `work_method` / `work_artifact`，所以这些记录会被格式检查拒绝。

这是已知缺陷，不是配置问题。当前应使用默认的 `code` 模式。
:::

## 子代理超时

| 字段 | 默认 | 到点行为 |
| --- | --- | --- |
| `subagent.softMs` | `630000`（10 分 30 秒） | 只记日志并更新状态栏 |
| `subagent.hardMs` | `1800000`（30 分钟） | 进入停止流程 |
| `subagent.killGraceMs` | `10000` | 停止前留给提交收尾的时间 |
| `subagent.holdMsUnconfirmed` | `1800000` | 无法确认进程已死时隔离该层多久 |
| `subagent.stopRequestTtlMs` | `300000` | 停止标记有效期 |

默认值来自实测：单轮模型生成出现过 987 秒的情况，早期 3 分钟的上限会必然误杀。不要因为任务跑得久就直接压低硬上限，先用 `memoryDB/logs/` 区分是模型慢、网络失败，还是提交没成功。

## 语言

```text
/my-memory:language
/my-memory:language en
/my-memory:language zh-CN
/my-memory:language auto
```

也可以在配置里设 `language.locale`。切换后执行一次 `/reload`，命令描述和已渲染卡片才会刷新。

## 手工编辑示例

只把已关闭任务从召回里排除：

```jsonc
{
  "recall": {
    "hideClosedTasks": true
  }
}
```

这是节内的字段片段，要放进现有的 `recall` 对象里，不能只替换整个文件。其他字段保持原值。

改完重启 Pi。想确认生效，看 `recall.log` 里的 `kept` 是否变少，或在查看器里对比"任务已完成后仍被召回"的情况是否消失。

继续阅读：[召回与注入](./recall) · [后台流水线](./pipeline) · [常用命令](./commands)。
