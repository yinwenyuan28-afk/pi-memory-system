---
title: 记忆模型
description: 一条记忆长什么样，场景和画像如何组织，任务状态与删除有什么区别。
---

# 记忆模型

理解数据结构，才能解释为什么"记忆保存了却召回不到"或者"任务做完了还在提醒"。[记忆如何工作](./memory)讲使用视角，本页讲数据视角。

## 一条 L1 记录

L1 记录以 JSONL 追加保存，每行一条。按提交当天日期分片：

```text
memoryDB/l1/records/2026-11-18.jsonl
```

一条记录的主要字段：

```json
{
  "id": "l1_1790000000000_1234",
  "content": "回调事件使用事件编号做幂等键。",
  "type": "work_fact",
  "priority": 82,
  "scene_id": "sc0007",
  "scene_name": "订单服务｜回调幂等",
  "source_message_ids": ["msg_001"],
  "timestamps": ["2026-11-18T03:20:00.000Z"],
  "createdAt": "2026-11-18T03:21:10.000Z",
  "updatedAt": "2026-11-18T03:21:10.000Z",
  "version": 1,
  "sessionKey": "session_abc",
  "cwd": "C:/dev/work",
  "deleted": false,
  "taskState": "open",
  "metadata": { "scope": "self", "project": "C:/dev/work/order-service" }
}
```

| 字段 | 含义 | 谁写 |
| --- | --- | --- |
| `id` | 编号，格式 `l1_{毫秒时间戳}_{随机数}` | 提交端生成或校正 |
| `content` | 记忆正文，要能脱离上下文单独读懂 | 提取代理 |
| `type` | 四类之一，见下表 | 提取代理 |
| `priority` | 0–100，缺省补 70 | 提取代理 |
| `scene_id` / `scene_name` | 归属场景编号与写入时的名字快照 | 提交端解析 |
| `source_message_ids` | 支撑这条记忆的源消息编号 | 提取代理 |
| `timestamps` | 源消息的事件时间 | 提取代理 |
| `createdAt` / `updatedAt` | 记录写入时间 | 提交端覆写 |
| `deleted` | 这条记录是否还成立 | 提交或纠错 |
| `taskState` | 任务开/关状态，仅 `work_task` 有意义 | 提取、命令或工具 |
| `metadata.scope` / `metadata.project` | 适用范围与项目标签 | 提交端核验后写入 |

两个时间字段不能混用：`timestamps` 说明这条记忆对应哪段对话，`createdAt` 说明什么时候写进库。故障排查和溯源要用前者。

> 实现依据：[memory/l1/record-types.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/record-types.ts) 定义类型闭集；[memory/l1/commit-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/commit-tool.ts) 的 `registerL1CommitTool()` 补齐默认字段并覆写写入时间；[memory/search/embedding/record-loader.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/embedding/record-loader.ts) 的 `loadAllL1Records()` 按编号取最后状态。

## 四类记忆

`code` 模式（默认）把记忆分成四类。分类不是为了好看，而是为了后续按用途检索和淘汰：

| 类型 | 含义 | 例子 |
| --- | --- | --- |
| `work_fact` | 已确认的事实或约定 | 回调事件用事件编号去重 |
| `work_task` | 需要跟踪的工作 | 补充重试与重复投递测试 |
| `work_method` | 可迁移的判断原则 | 重放前先核对幂等边界 |
| `work_artifact` | 可复用的产物或位置 | 迁移脚本路径与用途 |

`work_method` 有特殊待遇：它永不自动淘汰，因为方法类记忆曝光少是常态，不能按热度判死刑。

`chat` 模式使用 `persona` / `episodic` / `instruction` 三类。需要注意：提交端只接受上面四个 `work_*` 类型，`chat` 模式产出的三类会被格式检查拒绝。这是当前已知缺陷，不是配置问题。

> 实现依据：[memory/l1/record-types.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/record-types.ts) 的 `L1_RECORD_TYPES` 与 `PROTECTED_L1_TYPES`；[memory/l1/commit-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/commit-tool.ts) 的硬闸 `isL1RecordType()`；`chat` 提示词见 [extract-chat.md](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/prompts/extract-chat.md)。

## 改一条记忆时发生了什么

分片只追加，正文不回头改写：

<MemoryFlow kind="l1write" />

`update` 和 `merge` 都走同一条路：旧行在原分片里就地标 `deleted: true`（正文和编号保留），新版本用新编号追加到当天分片。读取时同一编号取最后一行的状态，所以"最后一行标记删除"就等于这条不再存活。

这样做的好处是任何一步中断都能自愈：写入新行失败，旧行还没标删，记录仍然完整；标删成功但追加失败，下次读到的是"已删除"，可以重提。代价是分片只增不减，长期使用需要靠归档和备份管理。

> 实现依据：[memory/l1/in-place-mark.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/in-place-mark.ts) 的 `scanRecordShards()` / `rewriteShardRows()`；[memory/l1/commit-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/commit-tool.ts) 先追加新行、再重写历史分片。

## 任务状态与删除是两根轴

这两个字段经常被混为一谈，但它们回答不同问题：

| 字段 | 回答 | 影响 | 可回退 |
| --- | --- | --- | --- |
| `deleted` | 这条记录是否成立 | 退出召回、向量、L2 整理 | 不能，只能重新提交 |
| `taskState` | 这个任务还没做 / 做完了 / 不做了 | 记录照旧存活、照旧可召回，注入时带标签 | 能，随时 `reopen` |

`deleted` 用于查重覆盖和纠错作废。`taskState` 用于任务生命周期：

| 状态 | 含义 | 注入标签 |
| --- | --- | --- |
| `open` | 待办（缺省值） | `[待办]` |
| `done` | 已完成 | `[已完成]` |
| `dropped` | 已废弃，不再打算做 | `[已废弃]` |

已关闭的任务默认仍然被召回，因为"这件事已经做过了"本身常常就是答案。如果不想看到它们，把 `recall.hideClosedTasks` 设为 `true`。置为 `true` 时检索量会自动放大一倍，否则过滤掉几条后凑不满注入条数。

> 实现依据：[memory/l1/record-types.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/record-types.ts) 的 `taskStateOf()` / `formatInjectedRecordLine()`；[memory/l1/task-state.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/task-state.ts) 的 `applyTaskStateChanges()`；[memory/search/hybrid-recall.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/hybrid-recall.ts) 的闸门 1.5。

## 场景：把记录编成经历

L2 场景块是 Markdown 文件，顶部有元数据，正文固定九段：

```markdown
-----META-START-----
created: 2026-11-18T03:00:00.000Z
updated: 2026-11-18T05:20:00.000Z
summary: 订单回调幂等的判定与实现步骤。
heat: 3
-----META-END-----

# 订单服务回调幂等

## 工作场景
## 适用条件
## 核心 SOP
## 判断逻辑
## 禁忌与反模式
## 关键事实依据
## 相关任务与资产
## 演化记录
## 待确认问题
```

九段的作用是强制写清"什么时候适用、按什么步骤做、什么情况不该这么做、依据是哪条记录"。少了这些，场景就退化成一份摘要，下次读到时仍然要重新推理。

场景相关的三个文件各管一件事：

<MemoryFlow kind="scenes" />

| 文件 | 作用 | 能否重建 |
| --- | --- | --- |
| `l2/scene-blocks/*.md` | 场景正文 | 不能，这是原始内容 |
| `l2/index/scene_members.json` | 场景收录了哪些 L1 编号 | 不能，权威关联 |
| `l2/index/scene_index.json` | 摘要、热度、更新时间的汇总视图 | 能，每次提交后全量重建 |

成员清单必须单独保存，因为索引是派生物。把成员写进索引，下一次重建就丢了，而成员关系还承担着"高价值记录保护"的判断，丢了会让归档场景里的记录失去保护。

## 场景的合并与归档

场景数量有上限，默认 15 个。满了以后要先合并或归档才能新建：

| 动作 | 做什么 | 保障 |
| --- | --- | --- |
| `consolidate` | 多个源块合成一个目标块，保留全部事实 | 先备份、检查完整性，写好目标后才删源块 |
| `archive` | 把场景搬出活跃目录，保留正文、成员和操作记录 | 文件名决定存在性，可 `restore` 搬回 |

合并被拒绝的常见原因是内容压缩过度：新正文不足源块合计的 50% 会被拒，低于 80% 会警告。显式传成员时漏掉任何一个也会整批拒绝。这些限制是为了防止"合并"变成悄悄丢弃信息。

归档不是删除。归档目录里的 `.md` 文件、成员清单和 `ledger.jsonl` 操作账一起保留，之后可以恢复。刚创建不足 7 个日历天的场景不能归档，避免把"刚写完还没用"误判为"没价值"。

> 实现依据：[memory/l2/commit-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l2/commit-tool.ts) 的 `formatSceneBlock()` / `checkSceneLimit()` / `checkConsolidation()`；[memory/l2/archive.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l2/archive.ts) 的 `archiveSceneBlock()` / `restoreSceneBlock()`；归档下限见 [memory/l2/config.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l2/config.ts) 的 `L2_ARCHIVE_DEFAULTS`。

## 画像：提议与正式文件分离

正式 `USER.md` 是注入给新会话的背景，`USER-temp.md` 是待审阅的提议稿。L3 只写后者。

这个分离解决两个问题：后台模型判断错了不会直接污染背景；用户能逐条看过再决定。代价是画像不会自动生效，需要一次人工确认。

画像条目有两条硬限制：单条最多 500 字符，整篇工作副本最多 2,200 字符（分隔符也计入）。工作副本 = 正式画像 + 提议稿独有条目，所以这个预算对应的是"并入之后"的整体用量。

提议稿默认并入策略是追加：保留正式画像现有条目，只补充提议稿里尚未出现的条目。改写过的文本会被当成新条目，旧条目不会自动删除。看到新旧矛盾时需要人工整理。

> 实现依据：[memory/l3/user-file.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l3/user-file.ts) 的 `seedProposalEntries()` / `writeUserTempFile()`；[memory/l3/entries.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l3/entries.ts) 的 `SINGLE_ENTRY_CHAR_LIMIT`；总预算单源在 [memory/core/types.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/core/types.ts) 的 `DEFAULT_USER_CHAR_LIMIT`。

## 质量分不等于该不该删

质量分在读取时计算，不写回记录。它由三部分相乘：

```text
quality = 有效命中 × 时间衰减 × 反馈惩罚
```

时间用**活跃会话日**而不是日历天：`exp(-days / 14)`，其中 `days` 是自上次命中以来有会话归档的天数。休假期间不增长，所以"很久没用"和"很多天没工作"能区分开。

标签分六档：噪、热、温、新、冷、待观察。低分只说明最近没被用到，不说明内容有错。

淘汰资格是另一套判断，只有两类情况才进入候选：被反复召回后又被判为无效，或者长期闲置且内在价值低。高优先级记录、`work_method`、曾经有效使用过的记录受保护。

> 实现依据：[memory/l1/quality.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/quality.ts) 的 `calcQuality()` / `judgePrune()` / `PRUNE_RULES`；活跃日从 [memory/l1/active-days.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/active-days.ts) 的归档文件名推导。

## 项目与适用范围

每条记忆有两个配合的标签：

| 标签 | 取值 | 含义 |
| --- | --- | --- |
| `metadata.scope` | `self` | 只在这个项目成立 |
| | `global` | 明确可以跨项目复用 |
| | `unknown` | 证据不足，判不出来 |
| `metadata.project` | 路径或空串 | 仅 `self` 填，另两种必须留空 |

`global` 和 `unknown` 都留空项目，但含义不同：前者是"确认通用"，后者是"放弃判断"。召回时两者都不降权，代价是通用经验可能占用注入名额，收益是"不知道"不会被当成"不属于"。

判断顺序是正文路径证据优先，其次会话项目判定，最后才是 `unknown`。系统不会用会话启动目录去猜项目，因为从 A 目录启动后仍可能改 B 项目的代码。

> 实现依据：[memory/l1/project-scope.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l1/project-scope.ts) 的 `projectForScope()`；[util/recall-score.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/recall-score.ts) 的 `scoreRecord()`；逐条证据核验见 [agents/l1-extractor.md](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/agents/l1-extractor.md) 的「项目与会话」节。

## 数据都在哪里

路径相对于 `<profile>/memoryDB/`：

| 路径 | 内容 |
| --- | --- |
| `l0/conversations/*.jsonl` | 按天的对话正文 |
| `l0/cursor.json` | 每个会话归档到第几行 |
| `l1/records/*.jsonl` | 原子记忆 |
| `l1/cursor.json` | 每个 L0 分片消费到哪个字节 |
| `l1/scenes.json` | 场景池：编号、标签、别名 |
| `l2/scene-blocks/*.md` | 场景正文 |
| `l2/index/scene_members.json` | 成员清单（权威） |
| `l2/index/scene_index.json` | 场景索引（可重建） |
| `l2/archive/` | 归档场景、成员、操作账 |
| `l3/cursor.json` | 画像处理进度 |
| `search/vectors/l1-vectors.sqlite` | 向量索引 |
| `l1/hit-stats.sqlite` | 命中统计 |
| `pipeline/jobs.sqlite` | 串行任务队列 |
| `config/application-propertis.json` | 统一配置（JSONC，文件名是实际拼写） |
| `state/failure-state.json` | 失败计数与层持有 |
| `logs/` | 按范围分文件的运行日志 |

profile 根目录还有三个文件：`MEMORY.md`、`USER.md` 是正式背景，`USER-temp.md` 是画像提议稿。

继续阅读：[后台运行与故障恢复](./pipeline) · [召回与注入](./recall) · [数据、隐私与备份](./data)。
