---
title: 常用命令
description: 按目的查找配置、触发、任务管理、向量维护和排查命令。
---

# 常用命令

斜杠命令都在 **Pi 会话输入框**执行。`npm run viewer` 是终端命令，要在扩展目录运行。

## 配置与记忆空间

| 命令 | 用途 | 影响 |
| --- | --- | --- |
| `/my-memory:model` | 配置后台模型、Embedding、向量化开关 | 写配置文件 |
| `/my-memory:model:peek` | 只读查看配置与向量状态 | 不请求远端 |
| `/my-memory:profile list` | 列出记忆空间 | 只读 |
| `/my-memory:profile switch <name>` | 切换空间，不存在则创建 | 改 Pi 设置 |
| `/my-memory:l1-mode` | 查看当前提取模式 | 只读 |
| `/my-memory:l1-mode code` | 使用开发工作模式 | 写配置 |
| `/my-memory:language` | 查看或切换界面语言 | 写配置 |

## 触发后台处理

| 命令 | 用途 |
| --- | --- |
| `/my-memory:l1-trigger` | 请求提取未处理对话 |
| `/my-memory:l2-trigger` | 请求场景整理 |
| `/my-memory:l3-trigger` | 请求画像提议 |
| `/my-memory:subagent-kill l1` | 提前停止指定层，可换成 `l2`、`l3` |
| `/learn` | 请求技能学习 |

三个 `trigger` 共同的行为：

- 进入同一个串行队列，不会并行执行。
- 不绕过正在运行的任务。
- 如果该层正被熔断且队列里有任务，会复位熔断并让原任务执行。
- 不保证立即完成，只保证入队。

## 管理待办

```text
/my-memory:l1:task list
/my-memory:l1:task list --all
/my-memory:l1:task done <id>
/my-memory:l1:task drop <id>
/my-memory:l1:task reopen <id>
```

`<id>` 换成真实编号，不要保留尖括号。`list` 默认只列未关闭的，`--all` 包含已完成和已废弃。

状态变化不改正文、不改编号、不动向量。要纠正内容用查看器的改写操作。

## 向量维护

| 命令 | 用途 | 注意 |
| --- | --- | --- |
| `/my-memory:l1:embedding:list` | 查看已向量化与未向量化 | 只读 |
| `/my-memory:l1:embedding:backfill` | 补齐历史记录向量 | 调用 Embedding 服务，产生费用 |
| `/my-memory:l1:embedding:rebuild` | 清空向量库并重新嵌入 | 耗时长，先备份 |

`backfill` 不需要满足 500 条自动阈值，也不需要开启自动向量化；只要 Embedding 服务可用就能跑。

## 检查与诊断

| 命令 | 用途 |
| --- | --- |
| `/my-memory:l1:health` | 库健康报告：坏行、重复编号、畸形记录 |
| `/my-memory:l1:quality 20` | 前 20 条质量排行 |
| `/my-memory:l1:stats` | 质量分布、冷记录、淘汰候选 |
| `/my-memory:l2:archive-list` | 查看已归档场景 |

## 场景归档

| 命令 | 用途 |
| --- | --- |
| `/my-memory:l2:archive <file> --reason "…"` | 归档一个场景，必须写理由 |
| `/my-memory:l2:restore <file>` | 恢复归档场景 |

写操作会检查 L2 运行锁。归档不是删除，正文、成员和操作记录都保留。

## 纠错

| 命令 | 用途 |
| --- | --- |
| `/my-memory:l1:fix <id> --action rewrite --content "…" --evidence "…"` | 改写记录 |
| `/my-memory:l1:fix <id> --action tombstone --evidence "…"` | 作废记录 |

`--evidence` 必填且至少 20 字符，要写可复核的证据（文件行号、命令输出、报错原文）。高价值记录需要 `--force` 才能改。

日常纠错优先用查看器：能看到上下文、能对比差异、会提示影响范围。

## 命令没反应时

| 现象 | 常见原因 |
| --- | --- |
| 提示"已在队列或运行中" | 该层有任务在跑或排队，等它结束 |
| 提示"没有增量" | 游标之后没有新数据，先确认 L0 是否归档 |
| 触发后状态不变 | 信号需要 Pi 会话活动结束才消费；查看器单独点不会执行 |
| 命令不存在 | 扩展没加载成功，执行 `/reload` 或重启 Pi |

更完整的排查顺序见[后台流水线](./pipeline)，数据位置见[数据、隐私与备份](./data)。
