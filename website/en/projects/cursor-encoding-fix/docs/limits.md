---
title: Limits
description: Which system and tools cursor-encoding-fix covers, and which encoding problems it leaves alone.
---

# Limits

This tool targets **Cursor Agent** on **Simplified Chinese Windows**. The failure it addresses is an agent write that silently stores Chinese text as GBK.

These sit outside this guide:

- Older files already stored as GBK. If you need to convert them, follow the repository README. This site does not add a second conversion procedure.
- The system locale, the terminal code page, or another editor's default encoding.
- Pi's memory store, or model access inside a Java service. Those are [Pi Memory](/en/docs/quickstart) and [ai-lite](/en/projects/ai-lite/).

Hook and MCP details stay in the [repository README](https://github.com/yinwenyuan28-afk/cursor-encoding-fix).
