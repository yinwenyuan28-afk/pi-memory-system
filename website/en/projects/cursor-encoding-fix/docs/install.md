---
title: Install
description: What cursor-encoding-fix fixes, and where the install steps live.
---

# Install

On Simplified Chinese Windows, Cursor Agent can silently save files that contain Chinese as GBK. The file still opens. On another machine, or in a tool that reads UTF-8, the Chinese text breaks.

cursor-encoding-fix moves reading and writing onto MCP tools. Files written through those tools are UTF-8 without a BOM. An optional hook can also block Cursor's built-in write tools.

How to install the MCP server and how to attach the hook are in the repository README:

[yinwenyuan28-afk/cursor-encoding-fix](https://github.com/yinwenyuan28-afk/cursor-encoding-fix)

This site does not keep a second copy of those commands. After it is installed, see [Usage](./usage). Cases it does not cover are in [Limits](./limits).
