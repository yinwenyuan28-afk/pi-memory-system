---
title: Inspect and correct
description: Use the local viewer to inspect records, scenes, profiles, and pipeline jobs.
---

# Inspect and correct

The local viewer shows your memory store and lets you update it as your work changes.

## Open the viewer

Run this from the extension repository directory:

```powershell
npm run viewer
```

On Windows, you can also open `viewers/启动查看器.cmd`. The launcher syncs the latest pages, finds an available port starting at 5174, and opens your browser.

The viewer uses the extension's active profile. Open it through the launcher and bridge; opening the HTML file directly does not load your data.

::: warning Local access
The bridge listens on loopback by default. It currently has no authentication and allows all CORS origins. LAN mode expands access. Read [Limits and data handling](./limits).
:::

## Find the right page

| Page | Use |
| --- | --- |
| Overview | Data health and viewer version |
| L1 records | Content, sources, quality, project ownership, task states |
| L2 scenes | Scene blocks, members, archives, and organization |
| L3 profile | Formal profile, proposals, differences, and merging |
| Pipeline | Queued jobs, background agents, and processing status |

## Correct records and tasks

Correct inaccurate information. Mark tasks done or reopen them when needed. Deleting a record and closing a task have different meanings.

Rewriting requires at least 20 characters of verifiable evidence. A record has a 24-hour repeat-correction guard, plus protection when it has many hits or scene references. Read any refusal before deciding whether the correction is warranted.

Deleting marks a record invalid; its original text may remain for traceability. Restoring an L1 backup replaces the current shard collection and may remove records added since the backup. It is not a single-record undo. Inspect the preview and target scope first; see [Data, privacy, and backups](./data).

## Review profile proposals

Read the differences before deciding what to merge. The resulting formal profile affects background in later new sessions.

The default merge preserves formal-profile entries and appends proposal entries whose exact text is not already present. Reworded content usually counts as new text, so the old entry is not automatically removed. Resolve conflicting old and new statements after review. Full replacement is a separate explicit operation; inspect entries that would disappear before choosing it.

## Watch operation status

Use the pipeline page to see queued, running, and finished jobs. The bridge runs CLI operations synchronously; long backfills and rebuilds can block other requests. Wait for an explicit result before treating work as complete.

A trigger first saves a signal that the Pi main session must consume. Opening only the viewer cannot run background model work. See [Background work and recovery](./pipeline) for timing and recovery.
