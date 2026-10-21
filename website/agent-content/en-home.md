---
title: Long-term memory for your Pi agent
description: Turn useful conversations into reusable project memory for Pi.
---

# Long-term memory for your Pi agent

Pi Memory is an extension for ongoing project work with Pi. It organizes useful project facts, working methods, and tasks from conversations so Pi can retrieve relevant context later and reduce repeated explanations.

## How it works

1. **Archive conversations:** Keep cleaned user and assistant text as source material.
2. **Extract useful information:** Organize conversations in the background into facts, tasks, methods, and work artifacts.
3. **Recall for the question:** Configure an Embedding service and create vectors for records to retrieve context related to the current question.

Related records can also be organized into scenes. Profile updates are presented as proposals for review and do not automatically overwrite the formal profile.

## What it offers

- Inspect records and sources in the local viewer, correct inaccurate content, and manage task states.
- Review profile proposals before merging them into the formal profile.
- Turn repeatable debugging or operating workflows into reusable skills.
- Memory files are stored in the Pi profile. Whether extraction or vectorization calls external services depends on the configured model and Embedding service.

## Install

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.83.0
pi install npm:pi-memory-system
```

Currently for Windows. The project-tested Pi 0.83.0 requires Node.js 22.19 or later. Semantic recall requires a separate Embedding setup, enabled vectorization, and a vector backfill for existing records.

## Documentation

- [Quick start](/en/docs/quickstart)
- [Configure semantic recall](/en/docs/recall)
- [How memory works](/en/docs/memory)
- [Context and progressive loading](/en/docs/context-design)
- [Limits and data handling](/en/docs/limits)

## More from the author

- [cursor-encoding-fix](https://github.com/yinwenyuan28-afk/cursor-encoding-fix): Fixes Cursor Agent silently saving non-ASCII text as GBK on Simplified Chinese Windows by reading and writing files through MCP tools as UTF-8 without BOM.

[GitHub repository](https://github.com/yinwenyuan28-afk/pi-memory-system) · [Contact](mailto:email@pi-memory.com)
