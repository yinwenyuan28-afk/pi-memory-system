---
title: How memory works
description: Understand the relationship between conversation archives, records, scenes, and reviewed profiles.
---

# How memory works

The extension organizes useful conversation information into layers with different jobs. Foreground questions recall L1 records. Scenes and profiles develop through a separate organization path.

## The four layers

| Layer | Content | Purpose |
| --- | --- | --- |
| L0 archive | Cleaned user and assistant text | Source for extraction |
| L1 records | Facts, tasks, methods, and work artifacts | Retrieval for related questions |
| L2 scenes | Connected records with context | Organization and later profile generation |
| L3 profile | Proposed characteristics and collaboration preferences | Background for future sessions after review and merge |

The ordinary L0 archive excludes tool calls and tool results. Skill learning has a separate skill-feed.

## Two paths

**Question recall:** conversation → L1 records → vectors → question-based search → relevant context for the answer.

**Gradual organization:** L1 records → L2 scenes → L3 proposals → your review → the formal profile.

L2 scenes are not automatically injected into every answer.

## Tasks keep a state

Tasks can be `open`, `done`, or `dropped`. Completing a task does not delete its record; knowing it was done can still be useful.

Manage states through the viewer or `/my-memory:l1:task`. The `recall.hideClosedTasks` setting controls whether closed tasks are excluded from automatic recall.

## You approve profile updates

L3 writes proposals to `USER-temp.md`. It does not automatically overwrite `USER.md`. Inspect, edit, and merge proposals in the viewer.

Formal `MEMORY.md` and `USER.md` files are read at the start of a new session. Merged updates become part of that later background snapshot.

Continue with [Inspect and correct](./viewer) or [Limits and data handling](./limits).
