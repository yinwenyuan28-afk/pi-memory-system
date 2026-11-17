---
title: Usage
description: When the MCP tools and the optional hook in cursor-encoding-fix each apply.
---

# Usage

Day to day, have Cursor Agent read and write files through these **MCP tools**. The tools interpret the content they read, and they always write UTF-8 without a BOM. Chinese text is not silently saved as GBK.

If the agent still calls Cursor's built-in write tools, add the **hook** described in the README. The hook blocks that write path so the save stays on UTF-8.

| Path | When to use it |
| --- | --- |
| MCP read and write | The default path when the agent needs to read or write project files |
| Hook | Add it when the built-in write tools also need to be blocked |

The install entry is [Install](./install). Encoding problems outside this tool are in [Limits](./limits).
