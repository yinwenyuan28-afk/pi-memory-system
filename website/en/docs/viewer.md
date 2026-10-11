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

## Review profile proposals

Read the differences before deciding what to merge. The resulting formal profile affects background in later new sessions.

## Watch operation status

Use the pipeline page to see queued, running, and finished jobs. The bridge runs CLI operations synchronously; long backfills and rebuilds can block other requests. Wait for an explicit result before treating work as complete.
