---
title: Data, privacy, and backups
description: Understand storage, model inputs, and the scope of backup and restore operations.
---

# Data, privacy, and backups

Memory files live locally in your Pi profile. Background processing and vectorization may send content to configured services. Processing location depends on your model choices.

## Storage locations

Paths below are relative to the active `<agentDir>/profiles/<profile>/`. Files are often created on demand, so a new profile may not contain every directory.

| Path | Content |
| --- | --- |
| `MEMORY.md`, `USER.md` | Formal background files loaded as a new-session snapshot |
| `USER-temp.md` | Profile proposals awaiting review |
| `memoryDB/l0/conversations/` | User and assistant text archived by date |
| `memoryDB/l1/records/` | Atomic memory JSONL shards |
| `memoryDB/l1/scenes.json` | Stable scene IDs and labels |
| `memoryDB/l2/scene-blocks/`, `memoryDB/l2/index/` | Active scenes, index, and member lists |
| `memoryDB/l2/archive/` | Archived scenes, members, and operation ledger |
| `memoryDB/skill/feed/` | Separate input for skill learning |
| `memoryDB/search/vectors/` | Local L1 vector database |
| `memoryDB/pipeline/`, `memoryDB/state/` | Jobs, runtime state, and failure state |
| `memoryDB/config/` | Model and processing configuration; may contain keys |
| `memoryDB/logs/`, `memoryDB/backups/` | Logs and backups for some operations |
| `state/review-cursor.json` | Skill-review progress |

Viewer pages are deployed copies in `memoryDB/viewers/`. They sync when page sources or installed versions change and are separate from memory records.

Automatic recall blocks enter a model-call message copy rather than the main session JSONL. L0 and L1 still persist their own data, and explicit tool results and assistant answers can enter session history. See [Context and progressive loading](./context-design) for the boundary.

## Content that may reach models

| Operation | Possible service input |
| --- | --- |
| L1 extraction, deduplication, value checking | Archived text, candidate memories, related records, and task materials |
| L2 organization | New records and related existing scenes |
| L3 proposals | Formal profile, proposals, and relevant scenes |
| Project judgment | Extracted path evidence and judgment materials |
| Embedding writes and queries | Record text and processed question queries |
| Skill review | The current session's incremental skill-feed, including tool arguments and results |
| Foreground answers | Formal background snapshots and recalled memories sent to the current Pi model |

This table covers the main paths; exact inputs depend on the implementation and task. Remote services may receive these inputs outside your device. When using local services, confirm that all actual calls use the intended settings.

## Cleaning boundaries

L0 cleans framework noise and retains user and assistant text. Ordinary extraction does not read tool calls and results. Skill learning keeps tool records in a separate skill-feed to understand execution. The two paths track progress independently.

Default cleaning does not guarantee removal of API keys, passwords, or bearer tokens. Truncation is not redaction. Secrets can appear in text, tool arguments, results, logs, or backups. Inspect sensitive materials and service settings before processing them.

## Viewer access

The bridge listens on loopback by default and runs only after manual startup. It has no authentication and permits all CORS origins. Browser permissions for local requests vary; loopback alone is not complete access protection.

Enabling `--lan` or `--host` expands network access. Anyone able to access it may read memories and invoke write operations. The configuration directory is excluded from static serving, but memory text can itself contain secrets. Use a trusted environment and close the bridge afterward.

## Back up a profile

For a full memory-space backup, copy the complete profile directory, including root profile files, `memoryDB`, scene members, and review state. L1 shards alone cannot restore all scene and profile relationships.

Let running tasks finish, close Pi processes using that profile and the viewer bridge, confirm that no background agents are still writing, then copy the directory. Copying active SQLite files can miss pending journal data or combine inconsistent points in time.

Profile configuration may include credentials, so keep backups private. Host sessions, shared skills, and host settings outside the profile need separate backups when required.

## Deletion and restoration scope

| Action | Meaning |
| --- | --- |
| Close a task | Keep the memory and change its task state |
| Delete an L1 record | Mark it invalid; original text may remain in shards for traceability |
| Archive a scene | Move it into the archive, with restoration available |
| Restore an L1 backup | Replace current L1 shards, affecting records created since the backup |
| Restore profile proposals | Recover the proposal file, distinct from changing the formal profile |
| Rebuild vectors | Clear old vectors and embed valid records again; does not recover lost memory text |

Deletion does not erase every archive, source session, log, or backup, and cannot retract data already received by a provider. Check the target and scope shown by the viewer and save current data before restoring.

Continue with [Inspect and correct](./viewer) or [Projects and profiles](./projects).
