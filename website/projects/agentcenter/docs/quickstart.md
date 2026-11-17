---
title: 下载与打开
description: 从 GitHub Releases 下载 agentcenter 的 Windows exe，双击打开窗口。
---

# 下载与打开

> 给谁：要在 Windows 上装上 agentcenter、并打开它的人。
>
> 一句话：到 GitHub Releases 下载 Windows 单文件 exe，双击就能打开。
>
> 不管：从源码编译。那部分在仓库 README。
>
> 状态：2026-11-16 核对过 [v0.2.1](https://github.com/yinwenyuan28-afk/agent-center/releases/tag/v0.2.1) 的附件名。

打开 [Releases](https://github.com/yinwenyuan28-afk/agent-center/releases/latest)，下载名字像 `agentcenter-v0.2.1-windows-x64.exe` 的文件。版本号会变，文件名始终是 `agentcenter-<版本>-windows-x64.exe`。同一页上的 `SHA256SUMS.txt` 用来核对下载是否完整。

打开窗口后，先看 [界面操作指南](./guide)。窗口左侧菜单对应 AGENTS.md、Skill、Provider；Claude、Codex、Cursor 的特殊步骤也在那里。

各家 agent 能管哪些，见 [支持的 Agent](./agents)。

在终端里跑同一个文件，就是命令行。例如先进入下载所在的目录：

```powershell
.\agentcenter-v0.2.1-windows-x64.exe status
```

可以把它改名为 `agentcenter.exe`。改名之后，命令就是 `agentcenter status`。

目前只提供这一份 Windows exe。
