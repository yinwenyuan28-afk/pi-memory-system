---
title: Download and open
description: Download the agentcenter Windows exe from GitHub Releases and open it.
---

# Download and open

> Who this is for: someone installing agentcenter on Windows and opening it.
>
> In one sentence: download the Windows exe from GitHub Releases and double-click it.
>
> Not here: building from source. That stays in the repository README.
>
> Checked: 2026-11-16, against the asset name on [v0.2.1](https://github.com/yinwenyuan28-afk/agent-center/releases/tag/v0.2.1).

Open [Releases](https://github.com/yinwenyuan28-afk/agent-center/releases/latest) and download the file named like `agentcenter-v0.2.1-windows-x64.exe`. The version number changes. The name stays `agentcenter-<version>-windows-x64.exe`. `SHA256SUMS.txt` on the same page is the checksum.

After the window opens, start with the [UI guide](./guide). The left menu covers AGENTS.md, Skills, and Providers. Claude, Codex, and Cursor special steps are there too.

Which agents accept each setting is in [Supported agents](./agents).

The same file is the command-line tool. From the folder you downloaded it to:

```powershell
.\agentcenter-v0.2.1-windows-x64.exe status
```

You can rename it to `agentcenter.exe`. After that, the command is `agentcenter status`.

The published file is the Windows exe.
