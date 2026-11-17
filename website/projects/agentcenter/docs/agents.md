---
title: 支持的 Agent
description: agentcenter 能管哪些 agent 的指令文件、Provider、Skill 和 MCP。
---

# 支持的 Agent

> 给谁：要确认自己正在用的那家工具，agentcenter 能写进去的是哪一项。
>
> 一句话：每家能管的项不一样，以下两张表为准。
>
> 不管：每一项怎么操作。指令文件见 [AGENTS.md](./agents-md)，模型接入见 [Provider](./providers)，技能见 [Skill](./skills)。
>
> 状态：2026-11-16 核对过 `src-tauri/src/agents/` 下各家的能力实现。

「有」表示这一项能写进该 agent。「无」表示当前不做这一项。

## 已按本机文件核对过的

| Agent | 指令文件 | Provider | Skill | MCP |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` | 有，同时只能挂一家 | 有 | 有 |
| Codex CLI | `~/.codex/AGENTS.md` | 有，同时只能挂一家，协议只有 responses | 有，直接读中心库 | 有 |
| ZCode | `~/.zcode/AGENTS.md` | 有 | 有 | 有 |
| pi | `~/.pi/agent/AGENTS.md` | 有 | 有，直接读中心库 | 有 |
| opencode | `~/.config/opencode/AGENTS.md` | 有 | 有，直接读中心库 | 有 |
| DSH | `~/.dsh/AGENTS.md` | 有 | 有 | 有 |
| Hermes Agent | 无单一指令文件 | 有 | 有 | 有 |
| WorkBuddy | 无单一指令文件 | 有 | 有 | 有 |
| Cursor | `~/.cursor/AGENTS.md` | 不走通用同步，见 [Provider](./providers) | 有，直接读中心库 | 有 |
| Qoder | 无用户级指令文件 | 无 | 有 | 有 |
| Zed | `%APPDATA%\Zed\AGENTS.md` | 无 | 有 | 无 |

同步 Provider 或 MCP 之前，先退出正在运行的 ZCode、Pi 和 opencode。它们开着时会把内存里的配置写回磁盘，刚写入的文件会被盖掉。Cursor 要写自带密钥时，也要先完全退出 Cursor。

## 已接入，但本机还没按真实文件核对过的

这几家的写入形状是按其他工具的配置格式接上的。装上之后要再对一遍真实文件。

| Agent | 指令文件 | Provider | Skill | MCP |
| --- | --- | --- | --- | --- |
| Gemini CLI | `~/.gemini/AGENTS.md` | 有，同时只能挂一家 | 有 | 有 |
| Grok Build | 无 | 有，同时只能挂一家 | 有 | 有 |
| OpenClaw | 无 | 有 | 有 | 无 |
| Kimi Code | 无 | 有 | 有 | 有 |
| MiniMax Code | 无 | 有 | 有 | 有 |
| Qoder CN | `~/.qoder-cn/AGENTS.md` | 无 | 有 | 无 |
| Trae CN | `~/.trae-cn/AGENTS.md` | 无 | 有 | 无 |
| CodeBuddy | 无 | 无 | 有 | 无 |

配置目录存在，界面就把这家算作已经装了。没装的也可以先在母版里勾选分配，换到装了它的机器上再同步。
