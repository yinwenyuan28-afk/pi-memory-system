---
title: Projects and profiles
description: Understand projects, applicability, and profiles, including the limits of ranking and separate storage.
---

# Projects and profiles

When working on several projects, you want Pi to prioritize the current project's conventions while retaining useful general experience. Project ownership and applicability help rank memories. Use different profiles when you need separate memory stores.

## Projects, working directories, and scenes

| Concept | Question it answers | Example |
| --- | --- | --- |
| Working directory `cwd` | Where did the session start? | Pi starts in `C:/work` |
| Project `project` | Which independently deliverable unit does the record concern? | The actual changes are in `C:/work/order-service` |
| Scene | Which ongoing topic is being handled? | Callback idempotency in the order service |

A project is the smallest independently deliverable work unit with its own identity. A Git repository may contain several projects. Names such as `src` or `backend` alone do not establish a project.

A session started in directory A can modify project B. The starting directory does not prove each record's ownership.

## Three applicability scopes

| Scope | Meaning | Example |
| --- | --- | --- |
| `self` | Applies to a specific project | That service's callback idempotency key |
| `global` | Explicitly reusable across projects | A general investigation principle or stable preference |
| `unknown` | Insufficient evidence to decide | No verifiable path, or several competing candidates |

Both `global` and `unknown` have an empty project field. `unknown` means there is no reliable conclusion; it does not establish universal applicability.

## How ownership is determined

Extraction can attach source messages and absolute-path evidence from their text to each record. Submission checks that the paths occur in the matching source conversation and belong under the proposed project directory. Invalid explicit evidence does not fall back to guessing from the starting directory; a project-specific record may become `unknown`.

Older calls without per-record candidates or evidence can use a valid session project judgment. There is currently no complete runtime project registry. Labels can therefore be missing or wrong, and verifying a path alone cannot establish the smallest deliverable project root.

Clearly stating the project, path, and scope of a fact gives the system better evidence. Check the saved labels in the viewer.

## How projects affect recall

When the current session has a valid project judgment, automatic recall finds similar records and adjusts their ranking: same-project records keep their score; `self` records from other projects multiply their similarity by **0.75**. `global`, `unknown`, and records without scope labels are not downweighted.

Without a valid session judgment, all candidates keep their original similarity. Foreground tool queries through `recall_l1_records` currently also retain the original similarity order.

::: warning Multiple-project boundary
Other projects' records can still be recalled. Labels provide relevance ranking rather than access control or strict filtering. Do not rely on them to separate confidential client information.
:::

## Use separate profiles

Each profile has its own memory files, model configuration, vector store, and background queue. Switch profiles to accumulate separate sets of work.

Run these inside **Pi**:

```text
/my-memory:profile list
/my-memory:profile switch client-a
```

The second command switches to `client-a` and creates it if needed. Use a simple directory name. The viewer reads the same active-profile setting by default; restart it after switching to inspect the corresponding store.

Already running tasks finish in their original profile. Follow-up jobs saved there resume when that profile has an active session again. The viewer also accepts an explicit `--profile` directory.

Profiles separate extension data, but shared host skill directories may still be read. They do not establish operating-system permissions or provider-side data isolation. Check the host, model services, and viewer access when confidentiality matters.

Continue with [Data, privacy, and backups](./data) or [Configure semantic recall](./recall).
