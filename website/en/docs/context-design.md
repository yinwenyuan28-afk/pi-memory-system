---
title: Context and progressive loading
description: Understand injection placement, session-history boundaries, on-demand rules, and separate background contexts.
---

# Context and progressive loading

Memory should help Pi complete the current task. The extension separates stable background, records relevant to the current question, detailed rules loaded on demand, and background processing. This reduces the accumulation of unrelated material in the foreground agent's context.

## Memories follow the current user message

Before each model call, the `context` handler inserts ready L1 recall results immediately after the last user message. During a turn with multiple tool calls, the memory block stays beside that user message, while later assistant messages and tool results remain after it.

```text
First model call
  Earlier conversation → Current question → Relevant memories

Model call after tool execution
  Earlier conversation → Current question → Relevant memories → Assistant tool call → Tool result
```

This placement associates memory with the question it supports. Historical references do not repeatedly move to the end as the newest input after every tool result. In special cases without a user message, the block is appended.

The `<l1-records>` wrapper identifies the content as reference material rather than new user input or commands. Each record has an ID, and tasks carry state labels, so the agent can identify and correct a particular record. This is a prompt instruction and does not guarantee that a model will never misuse memory.

> **Implementation reference:** The `context` handler in [index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) locates the user-message anchor and inserts the block. The [recall template](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/prompts/injection/l1-records.md) defines its reference framing.

## Automatic blocks do not enter the main session JSONL

Pi's `context` event operates on a copy of messages prepared for the model call. The extension returns the augmented copy rather than appending the automatic memory block as a persistent session message.

The current model call can use the references without accumulating a new memory block in persistent history on every turn. Later calls assemble context from session history again and insert the currently ready references. The next turn prepares its own recall results.

```text
Persistent main-session history → Model-call message copy ← Ready recall results
               │                            │
               ↓                            ↓
       Main-session JSONL            Context sent to the model
```

This boundary applies specifically to **automatically inserted blocks**. Results from explicit `recall_l1_records` tool calls and the assistant's answers can still enter session history. UI notifications may also be saved as custom entries. L0 archives and L1 memories remain stored in their own JSONL files.

> **Implementation reference:** [index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) returns modified `event.messages` from `context` without writing automatic blocks to the session. [Explicit tool recall](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-l1-records-tool.ts) uses a separate path.

## Start with relevant records, expand when needed

The foreground agent uses L1 records selected for the current question. It does not automatically load the full conversation archive, every scene, or the background agents' processing traces.

| Material | How it enters context | How scope is controlled |
| --- | --- | --- |
| Formal `MEMORY.md` and `USER.md` | Session-start snapshots used as stable system background | Remain stable within the session, helping preserve reusable prompt prefixes |
| Current L1 memories | Relevant search results inserted into the message copy | At most 3 automatically, with relevance and text limits |
| Additional L1 candidates | Explicit foreground recall tool | Defaults to 5, without expanding the entire library |
| Full saving contract | `load_memory_rules` when the agent decides to save | Used for one submission by default |
| L2 scene text and archive rules | Read by the organizer as needed | Used in background context; automatic foreground scene navigation is currently disabled |
| Extraction and profile-generation traces | Separate agents | Do not inherit foreground memory blocks or return all traces to the main task |

Automatic recall defaults to **300 characters per record** and a **2,000-character total text budget**. Low-relevance candidates can be filtered out. No suitable results means no memory block; every question does not have to carry historical references.

These character limits apply to recalled text rather than the extension's entire context footprint. Wrappers, IDs, tool descriptions, usage reminders, formal background, and explicit tool results also consume context. Stable snapshots support prefix reuse, while actual cache hits and billing depend on the provider.

> **Implementation reference:** [Recall configuration](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-config.ts) defines text limits, and [recall execution](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/hybrid-recall.ts) filters, ranks, and truncates results. [MemoryStore](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/core/store.ts) holds background snapshots.

## Load full rules when needed, then release them

The foreground agent has memory usage reminders and tool descriptions. Detailed type criteria, priorities, saving conditions, and submission rules are loaded through `load_memory_rules` when it decides to record something.

In the default `once` mode, the contract enters the current call context and is cleared after an `l1_commit` tool call completes. It is then no longer automatically injected. Explicit `always` mode keeps it loaded; the end of agent activity also clears rule state. The tool returns load status, while the full contract enters through the message copy.

Background scene archiving follows a similar pattern. When the organizer needs room or considers archiving, it calls `l2_archive_guide` for detailed rules and facts. Ordinary organization does not always carry the full archive guide. This saves context in the **background organizer**.

> **Implementation reference:** `load_memory_rules`, `tool_execution_end`, and `agent_end` in [index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) manage rule state. [archive-tool.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/l2/archive-tool.ts) provides the archive guide on demand.

## Background processing has its own context

L1 extraction, L2 organization, and L3 profile work run in separate Pi child processes with their own instructions, tool scope, and data-reading entry points. The main conversation continues the user's task while background agents read the required increments, records, or scenes.

Children start with their own system prompts and disable automatic skill and project-context-file loading. A child-process flag also skips foreground memory injection and background scheduling, preventing a child from repeating the main session's setup.

The main conversation can show result or failure notifications. Notification cards are saved as custom UI entries rather than ordinary model messages. Relevant materials can still be read explicitly, without making the entire background trace mandatory context on every turn.

> **Implementation reference:** `buildSpawnArgs()` in [spawn.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/spawn.ts) sets a separate system prompt, tool scope, `--no-skills`, and `--no-context-files`. Child guards in [index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) skip foreground injection; [notice.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/notice.ts) presents custom-entry notifications.

## Recall has a wait limit and rejects stale results

Automatic recall initially waits at most **1 second** by default. A timeout or failure discards that automatic result and lets the main task proceed. Async mode proceeds immediately; a ready result still belonging to the same turn can be inserted before a later model call. A turn finished in one call may never use it.

Results from the previous turn cannot populate a new turn, even when they arrive late. Only the latest pending automatic request is retained. Explicit tool queries take priority over queued automatic queries. Responses without an available topic can skip retrieval instead of issuing a query without a meaningful target.

> **Implementation reference:** [index.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/index.ts) checks `turnToken` before applying results. [recall-scheduler.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/memory/search/recall-scheduler.ts) implements timeouts, latest-request handling, and explicit-query priority. [query-noise.ts](https://github.com/yinwenyuan28-afk/pi-memory-system/blob/main/util/query-noise.ts) replaces or skips queries without a topic.

These choices control historical accumulation, loaded material, and recall waiting time. Model calls, context, and background resources still have costs. They support the goal of preserving capacity for the current task; task-quality improvements require evaluation with your models and actual work.

Continue with [How memory works](./memory), [Configure semantic recall](./recall), or [Background work and recovery](./pipeline).
