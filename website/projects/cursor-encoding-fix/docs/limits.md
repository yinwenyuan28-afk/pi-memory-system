---
title: 限制
description: cursor-encoding-fix 覆盖的系统和工具，以及它不处理的编码问题。
---

# 限制

这个工具针对 **简体中文 Windows** 上的 **Cursor Agent**。它要拦住的是：Agent 写文件时把中文静默存成 GBK。

下面这些不在这套说明的范围内：

- 已经躺在磁盘上、编码是 GBK 的旧文件。要转码的话，按仓库 README 里的做法处理，本站不另给转换步骤。
- 系统区域格式、终端代码页，或其他编辑器自己的默认编码。
- Pi 的记忆数据，或 Java 服务里的模型接入。那两件事分别见 [Pi Memory](/docs/quickstart) 和 [ai-lite](/projects/ai-lite/)。

钩子和 MCP 的配置细节以 [仓库 README](https://github.com/yinwenyuan28-afk/cursor-encoding-fix) 为准。
