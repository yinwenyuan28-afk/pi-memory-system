---
title: Provider
description: 把各家模型接入收进一个池子，再按 agent 分配并写入。
---

# Provider

> 给谁：要把同一把模型密钥分给多家 agent，又不想在每家的配置文件里各写一遍的人。
>
> 一句话：密钥先进一个池子，你勾选哪些 agent 用它，点应用之后才写进各家的配置文件。
>
> 不管：哪些 agent 能接受这次写入。见 [支持的 Agent](./agents)。
>
> 状态：2026-11-16 核对过 `src-tauri/src/agents/` 的 provider 能力，以及仓库 README 的分配流程。

池子写在 `~/.agents/providers.toml`。每一条 provider 只留一把 key，再加上名字、地址、默认协议和模型列表。

窗口里默认只列出这些条目。改某一条要两步：

1. 点该行的「分配」，勾选哪些 agent 使用它。这一步只改母版里的分配关系。
2. 点右上角「应用到各 agent」，才写各家的配置文件。

同一个地址在不同 agent 里可能要用不同协议。每条 provider 有一个默认协议，已经分配的 agent 可以单独改。下拉列表只出现这家 agent 真能发出去的协议：Codex 只有 responses，Claude Code 可以是 anthropic、OpenAI Chat 或 OpenAI Responses。

Claude Code 和 Codex 同时只能挂一家 provider。给它们勾上新的一条时，原先那条上的分配会被拿掉。

模型一行可以填上下文窗口、输出上限、输入类型和推理档位。留空表示这一项不改，应用时沿用该 agent 配置里已有的值。

## 应用之前

先退出 ZCode、Pi 和 opencode。它们运行时会用内存里的配置覆盖磁盘。

命令行先看差异，再写入：

```powershell
agentcenter providers diff
agentcenter providers sync --dry-run
agentcenter providers sync
```

新增一条可以用：

```powershell
agentcenter providers set minimax --name "MiniMax" --base-url "https://api.minimax.cn/anthropic" --kind anthropic --api-key "sk-..." --models "MiniMax-M3" --agents "zcode,pi"
```

`--agent-kind pi=openai-responses` 用来给已分配的某一家单独指定协议。

## Cursor 不走这次同步

Cursor 的自带密钥在 `state.vscdb` 里，并且要先完全退出 Cursor 才能写。`providers sync` 不会动它。

在 Provider 页的「Cursor 自带密钥」里操作，或用：

```powershell
agentcenter providers cursor status
agentcenter providers cursor plan command
agentcenter providers cursor apply command --models a,b
agentcenter providers cursor reset
```

只填了 key、没打开「Use OpenAI API Key」时，Cursor 会报 `Model name is not valid`。`plan` 会先列出还差哪一步。
