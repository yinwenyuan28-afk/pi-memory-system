---
title: 常用命令
description: 按目的查找配置、提取、任务状态和排查命令。
---

# 常用命令

以下斜杠命令都在 **Pi 会话输入框**中执行。`npm run viewer` 是终端命令，需要在已安装扩展的目录执行。

## 配置与记忆空间

| 命令 | 用途 |
| --- | --- |
| `/my-memory:model` | 配置后台模型、Embedding 和向量化开关 |
| `/my-memory:model:peek` | 只读检查配置状态和记录、向量数量，不请求远端 |
| `/my-memory:profile list` | 列出空间和当前激活项 |
| `/my-memory:profile switch client-a` | 切换到指定空间，不存在时创建 |
| `/my-memory:l1-mode` | 查看当前提取模式 |
| `/my-memory:l1-mode code` | 使用开发工作提取模式 |

## 后台请求

| 命令 | 用途 |
| --- | --- |
| `/my-memory:l1-trigger` | 请求提取未处理对话，也可恢复暂停的 L1 |
| `/my-memory:l2-trigger` | 请求场景整理，也可恢复暂停的 L2 |
| `/my-memory:l3-trigger` | 请求画像提议，也可恢复暂停的 L3 |
| `/my-memory:subagent-kill l1` | 提前停止指定后台层，层可换成 `l2` 或 `l3` |
| `/learn` | 请求技能学习 |
| `/learn 请重点整理本次回调排查的方法` | 给技能学习补充关注点 |

请求成功不等于处理完成。触发和停止的具体效果见[后台运行与故障恢复](./pipeline)。

## 管理待办

先列出任务，再把示例 `<id>` 换成真实记忆编号；不要保留尖括号。

```text
/my-memory:l1:task list
/my-memory:l1:task list --all
/my-memory:l1:task done <id>
/my-memory:l1:task drop <id>
/my-memory:l1:task reopen <id>
```

`done` 表示完成，`drop` 表示不再执行，`reopen` 表示重新打开。状态变化保留正文与编号；纠正错误内容使用查看器的改写操作。

## 向量与健康检查

| 命令 | 用途与影响 |
| --- | --- |
| `/my-memory:l1:embedding:list` | 查看已向量化与未向量化情况 |
| `/my-memory:l1:embedding:backfill` | 补齐历史记录向量，调用 Embedding 服务 |
| `/my-memory:l1:embedding:rebuild` | 清空向量库并重新嵌入有效记录，可能耗时和产生费用 |
| `/my-memory:l1:health` | 查看库健康报告 |
| `/my-memory:l1:quality 20` | 查看前 20 条质量排行 |
| `/my-memory:l1:stats` | 查看质量分布、冷记录与淘汰候选 |
| `/my-memory:l2:archive-list` | 查看已归档场景 |

场景归档、恢复、记录改写和整库还原优先通过[查看器](./viewer)检查对象、原因与操作范围。质量分低不表示可以直接删除。

本页列出主要用户入口，后台工具由代理按任务调用。更多维护脚本见 [l1-admin 参考](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/scripts/l1-admin/README.md)，其中历史语义仍需以当前源码为准。
