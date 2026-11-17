---
title: 安装
description: cursor-encoding-fix 解决什么问题，以及安装步骤去哪里看。
---

# 安装

在简体中文 Windows 上，Cursor Agent 有时会把含中文的文件静默存成 GBK。文件看起来还能打开，换一台机器或换一个按 UTF-8 读取的工具时，中文会乱。

cursor-encoding-fix 把读写改到 MCP 工具上。经过这些工具落下的文件是无 BOM 的 UTF-8。也可以再挂一道钩子，拦住 Cursor 自带的写入工具。

具体怎么装 MCP、钩子怎么挂，以仓库 README 为准：

[yinwenyuan28-afk/cursor-encoding-fix](https://github.com/yinwenyuan28-afk/cursor-encoding-fix)

本站不另写一套安装命令。装好之后的使用方式见 [用法](./usage)，它不覆盖的情况见 [限制](./limits)。
