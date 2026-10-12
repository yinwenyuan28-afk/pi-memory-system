---
title: How memory works
description: Understand the relationship between conversation archives, records, scenes, and reviewed profiles.
---

# How memory works

The extension organizes useful conversation information into layers with different jobs. Foreground questions recall L1 records. Scenes and profiles develop through a separate organization path.

## Follow a work example

Suppose you investigate duplicate callbacks in an order service with Pi. You confirm that event IDs should be used for deduplication and leave a task to add retry tests.

| Stage | Possible result | Later use |
| --- | --- | --- |
| Archive | Your discussion, reasoning, and confirmed decisions | Evidence for extraction |
| Extract | The deduplication convention and the retry-test task | Retrieve facts and tasks for related questions |
| Organize | The investigation's context, conditions, steps, and pitfalls | Read the connected experience in one scene |
| Propose a profile | Stable collaboration preferences observed across work | Background for new sessions after your review |

This is an illustrative example. What is actually saved depends on the discussion and model judgment. One fix may not justify a long-term profile entry.

## The four layers

| Layer | Content | Purpose |
| --- | --- | --- |
| L0 archive | Cleaned user and assistant text | Source for extraction |
| L1 records | Facts, tasks, methods, and work artifacts | Retrieval for related questions |
| L2 scenes | Connected records with context | Organization and later profile generation |
| L3 profile | Proposed characteristics and collaboration preferences | Background for future sessions after review and merge |

The ordinary L0 archive excludes tool calls and tool results. Skill learning has a separate skill-feed.

## What is worth remembering

Development mode uses four L1 types. Each record should make sense on its own, without phrases such as “that issue from earlier.”

| Type | Meaning | Example |
| --- | --- | --- |
| `work_fact` | A confirmed fact or convention | Callback events are deduplicated by event ID |
| `work_task` | Work to track | Add tests for retries and duplicate delivery |
| `work_method` | A transferable principle, constraint, or method | Check idempotency boundaries before deciding whether replay is safe |
| `work_artifact` | A reusable deliverable or reference | The purpose and location of a migration script |

Background extraction searches similar records to decide whether to add, update, merge, or skip. A separate value check is enabled by default. If that check fails, candidates may still be saved with a log entry. Model quality and your review remain relevant.

The foreground agent can also save L1 directly. You can explicitly ask it to remember a project convention, then confirm the result in the viewer. Direct saving does not wait for the automatic input count, but it does not mean vectors or scenes are already ready.

## Two paths

**Question recall:** conversation → L1 records → vectors → question-based search → relevant context for the answer.

**Gradual organization:** L1 records → L2 scenes → L3 proposals → your review → the formal profile.

L2 scenes are not automatically injected into every answer.

```text
Conversation → L0 archive → L1 records ──→ Vectors → Context for a related question
                                │
                                └──→ L2 scenes → L3 proposals
                                                       │
                                                Your review and merge
                                                       ↓
                                               New-session profile snapshot
```

See [Background work and recovery](./pipeline) for when each stage runs.

## How scenes connect experience

Records about the same topic can share a stable scene ID. L1 labels help reuse that topic during extraction. L2 scene files organize the background, applicable conditions, procedures, decision rules, pitfalls, supporting facts, tasks and artifacts, changes, and unresolved questions.

A scene label, project label, and L2 filename have different roles. One project can have several topics, and one topic can span investigation and implementation. The viewer shows scene content and member records.

The default limit is 15 active L2 scenes. Archive a temporarily unused scene to retain its content, members, and reason for archiving; restoring it requires a free slot. Scenes younger than 7 calendar days cannot be archived by default. Archiving a scene does not delete its L1 records.

## Tasks keep a state

Tasks can be `open`, `done`, or `dropped`. Completing a task does not delete its record; knowing it was done can still be useful.

Manage states through the viewer or `/my-memory:l1:task`. The `recall.hideClosedTasks` setting controls whether closed tasks are excluded from automatic recall.

## What quality scores mean

Viewer quality scores combine effective hits, invalid feedback, and time decay. Returning automatic search candidates does not count as an injection hit; the records must actually enter the answer context. Tool recall counts when its result returns.

New records have a 7-calendar-day protection period. Regular decay uses days with conversation archives, falling back to calendar time when archive data is unavailable. This clock is shared across the profile, so activity in another project can also age an inactive project's records.

A low score may simply mean a record has not been used recently. Pruning eligibility also considers priority, type, and feedback. A “cold” label alone does not establish that a record is wrong or should be deleted.

## You approve profile updates

L3 writes proposals to `USER-temp.md`. It does not automatically overwrite `USER.md`. Inspect, edit, and merge proposals in the viewer.

Formal `MEMORY.md` and `USER.md` files are read at the start of a new session. Merged updates become part of that later background snapshot.

Read [Context and progressive loading](./context-design) to understand injection placement, main-session history boundaries, on-demand rules, and separate background contexts.

Continue with [Projects and profiles](./projects), [Inspect and correct](./viewer), or [Limits and data handling](./limits).
