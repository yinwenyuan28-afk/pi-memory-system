---
title: Configuration guide
description: Separate background models, Embedding, automatic vectorization, and recall budgets.
---

# Configuration guide

Use `/my-memory:model` for model and vectorization setup, then `/my-memory:model:peek` to inspect status. If you want memories recalled by meaning, configuring an Embedding service and enabling vectorization is recommended. Alibaba Cloud Bailian is one service the author uses; some of its text embedding models currently list free quotas. Check the [official documentation](https://docs.bailian.console.aliyun.com/zh/model-studio/embedding) and console for eligibility and current quota details. Understanding these groups explains why a saved memory may not yet be recalled for a question.

## Configuration location

The current profile's file is:

```text
<agentDir>/profiles/<profile>/memoryDB/config/application-propertis.json
```

`propertis` is the actual filename spelling. It is JSONC and supports `//` comments. Profiles have separate configuration. Preserve existing sections when editing manually, then restart Pi so the main and background processes use consistent settings.

## Two kinds of models

| Setting | Purpose | Default or caveat |
| --- | --- | --- |
| `model.llm` | Background memory processing | Follows the foreground model when unset; selecting it does not switch the conversation model |
| `model.embedding` | Convert records and queries into vectors | Requires service URL, key, model, and dimensions |
| `vectorization` | Automatic vectorization of newly submitted records | Off by default; separate from the connection settings |

Configuring Embedding, enabling automatic vectorization, meeting its threshold, and backfilling old vectors are different actions. The default automatic threshold is **500 valid L1 records from the last 365 days**. See [Configure semantic recall](./recall) for backfill.

::: tip First-time setup
Enabling the switch does not immediately vectorize every existing record. With a smaller collection, run `/my-memory:l1:embedding:backfill` to try semantic recall sooner. Before using a remote Embedding service, confirm that the memory content may be sent to that service. See [Data, privacy, and backups](./data).
:::

::: warning Changing Embedding models
Vectors from different models should not be mixed, even when dimensions match. Existing tables prevent incompatible dimension changes in the wizard, but the wizard does not migrate old vectors. Back up and plan a complete rebuild before changing services or models.
:::

## Recall settings

| `recall` field | Default | Effect |
| --- | --- | --- |
| `minScore` | `0.2` | Filters low-relevance candidates by original cosine similarity; increasing it can reduce hits |
| `maxCharsPerRecord` | `300` | Truncates recalled record text beyond this character limit |
| `maxTotalChars` | `2000` | Stops appending recalled text once the total character budget is exceeded |
| `contextExpansion` | `conditional` | Short or referential inputs can use recent user messages to form a query |
| `injectMode` | `blocking` | Waits first; `async` lets the answer start and adds ready results during later context assembly |
| `injectTimeoutMs` | `1000` | Initial automatic-recall wait limit, in milliseconds |
| `hideClosedTasks` | `false` | Closed tasks remain eligible with state labels; `true` excludes them |

Automatic injection includes at most 3 records; tool recall defaults to 5. These counts are source constants, not configurable JSONC fields.

To hide closed tasks, set this field inside the existing `recall` section:

```jsonc
"hideClosedTasks": true
```

This is a field fragment, not a replacement for the whole file. Keep the other sections and current values.

## Organization and task limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `l1.mode` | `code` | Extract work facts, tasks, methods, and artifacts |
| `l1.valueCheck.enabled` | `true` | Check background candidates' value before submission; not used for direct foreground saves |
| `l2.maxScenes` | `15` | Maximum active scene files |
| `subagent.softMs` | `630000` | Log slow work and continue waiting |
| `subagent.hardMs` | `1800000` | Begin the stop sequence at this limit |

The current `chat` mode has a type-contract defect; see [Limits and data handling](./limits). Inspect logs to distinguish a slow model, network failure, and missing commit before shortening task limits.

Continue with [Background work and recovery](./pipeline) or [Data, privacy, and backups](./data).
