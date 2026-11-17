---
title: AGENTS.md
description: 用一份 ~/.agents/AGENTS.md 映射到各 agent 自己的指令文件。
---

# AGENTS.md

> 给谁：要让几家 agent 读到同一份全局指令的人。
>
> 一句话：你只改 `~/.agents/AGENTS.md`，同步之后它出现在每家有指令文件的 agent 自己的位置上。
>
> 不管：哪些 agent 有这一项。见 [支持的 Agent](./agents)。
>
> 状态：2026-11-16 核对过 `src-tauri/src/doc.rs`、`config.rs` 和 `link.rs`。

母版默认是 `~/.agents/AGENTS.md`。窗口里直接改这一份。文件还不存在时，界面会引导你创建；已经有内容时，创建不会覆盖它。

点同步之后，这份母版会映射到各 agent 的指令文件。路径见 [支持的 Agent](./agents) 表里的「指令文件」列。Claude Code 读的是 `CLAUDE.md`，其余有这一项的 agent 读的是自己目录下的 `AGENTS.md`。没有单一指令文件的 agent 不参加这次映射。

目标位置如果已经是一份普通文件，同步会先把它移进 `~/.agents/backup/<时间戳>/`，再放下指向母版的链接。已有内容不会被直接删掉。

Windows 上按这个顺序尝试，哪一级成功就用哪一级，界面会写明实际用的方式：

1. 符号链接。需要开发者模式，或管理员权限。
2. 目录用 junction，文件用硬链接。不需要额外权限。
3. 再不行就复制一份。母版后来改了，要再同步一次，副本才会跟上。

可以只取消某一家。取消之后，那一家目标位置上的链接或副本会拿掉，以后的同步也会跳过它。恢复映射会立刻把链接建回来。

要改某家的目标路径，写进 `~/.agents/agentcenter.toml`。没写的 agent 仍用上表里的默认路径。

```toml
[source]
instructions = "~/.agents/AGENTS.md"

[[mappings]]
agent = "claude"
to    = "~/.claude/CLAUDE.md"
mode  = "auto"
disabled = false
```

命令行对应的是：

```powershell
agentcenter status
agentcenter sync --dry-run
agentcenter sync
agentcenter unmap claude
agentcenter remap claude
```

`status` 有需要处理的项时，退出码是 2。`--dry-run` 只列出要做的事，不写文件。
