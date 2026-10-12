---
title: Command reference
description: Find model setup, extraction, task-state, and diagnostic commands by purpose.
---

# Command reference

Run slash commands in the **Pi conversation input**. `npm run viewer` is a terminal command run from the installed extension directory.

## Setup and profiles

| Command | Purpose |
| --- | --- |
| `/my-memory:model` | Configure background models, Embedding, and vectorization |
| `/my-memory:model:peek` | Inspect configuration and counts without remote calls |
| `/my-memory:profile list` | List profiles and the active one |
| `/my-memory:profile switch client-a` | Switch to a profile, creating it if needed |
| `/my-memory:l1-mode` | Show the extraction mode |
| `/my-memory:l1-mode code` | Use development-work extraction |

## Background requests

| Command | Purpose |
| --- | --- |
| `/my-memory:l1-trigger` | Request extraction, or resume paused L1 work |
| `/my-memory:l2-trigger` | Request scene organization, or resume paused L2 work |
| `/my-memory:l3-trigger` | Request profile proposals, or resume paused L3 work |
| `/my-memory:subagent-kill l1` | Stop a layer early; use `l2` or `l3` as appropriate |
| `/learn` | Request skill learning |
| `/learn Focus on the callback investigation method` | Add a focus to the learning request |

A successful request does not mean processing has finished. See [Background work and recovery](./pipeline) for trigger and stop behavior.

## Manage tasks

List tasks, then replace `<id>` with a real memory ID without angle brackets.

```text
/my-memory:l1:task list
/my-memory:l1:task list --all
/my-memory:l1:task done <id>
/my-memory:l1:task drop <id>
/my-memory:l1:task reopen <id>
```

`done` means completed, `drop` means no longer planned, and `reopen` opens the task again. These changes preserve text and IDs. Use the viewer's rewrite operation to correct inaccurate content.

## Vectors and diagnostics

| Command | Purpose and effect |
| --- | --- |
| `/my-memory:l1:embedding:list` | Inspect records with and without vectors |
| `/my-memory:l1:embedding:backfill` | Fill missing vectors using the Embedding service |
| `/my-memory:l1:embedding:rebuild` | Clear and rebuild vectors; may take time and incur costs |
| `/my-memory:l1:health` | Show library health |
| `/my-memory:l1:quality 20` | Show the top 20 quality-ranked records |
| `/my-memory:l1:stats` | Show quality distribution, cold records, and pruning candidates |
| `/my-memory:l2:archive-list` | List archived scenes |

For scene archiving and restoration, record rewrites, and full L1 restoration, use the [viewer](./viewer) to inspect targets, reasons, and scope. A low quality score alone does not justify deletion.

This page covers the main user entry points. Agents use background tools as part of their tasks. More maintenance scripts are documented in the [l1-admin reference](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/scripts/l1-admin/README.md); historical descriptions there still need checking against current code.
