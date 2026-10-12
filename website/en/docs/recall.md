---
title: Configure semantic recall
description: Set up Embedding, enable vectorization, and backfill existing records.
---

# Configure semantic recall

Semantic recall finds L1 records relevant to the current question. It needs a working Embedding service and matching local vectors.

::: tip Vectorization is recommended
If you want the extension to find related memories by meaning, configure an Embedding service and enable vectorization. Regular memory extraction and saving do not depend on it; vectorization makes semantic recall available. The author currently uses [Alibaba Cloud Bailian](https://bailian.console.aliyun.com/) for Embedding. Bailian currently lists a **1 million token free quota** for some text embedding models, generally valid for **90 days**. It is limited to the Beijing region and subject to account eligibility. Check the [official Embedding documentation](https://docs.bailian.console.aliyun.com/zh/model-studio/embedding), [free quota rules](https://docs.bailian.console.aliyun.com/zh/model-studio/new-free-quota), and console for current models, regions, eligibility, and remaining quota.
:::

::: info Default behavior
Vectorization is off by default. Automatic vectorization has a default threshold of **500 valid L1 records from the last 365 days**. Service configuration, enabling the switch, meeting the threshold, and backfilling historical records are separate steps.
:::

## Configure the service and switch

```text
/my-memory:model
```

Use the wizard to choose a background LLM, configure an OpenAI-compatible Embedding service, and enable vectorization. Enabling it is recommended; changing the background LLM does not change the foreground conversation model. With a remote service, memory text is sent to the service you configure. Read [Data and privacy](./data) first.

Restart Pi after changing Embedding settings. Existing vector tables constrain the dimension you can select; the wizard does not migrate the table automatically.

::: warning API keys
Pi's current input field does not mask passwords. Keys may be visible while entered and are stored in your profile configuration. Check recordings and shared configuration files.
:::

## Inspect existing records

```text
/my-memory:model:peek
/my-memory:l1:embedding:list
```

Check configuration, vectorization, and vector counts. The second command lists records without vectors.

## Backfill historical records

```text
/my-memory:l1:embedding:backfill
```

Enabling vectorization does not automatically backfill existing records. Backfill calls your configured Embedding service; costs depend on your provider and usage. The local viewer also provides vector management.

Manual backfill does not need to wait for 500 records. It can build vectors for a smaller collection. `vectorization.enabled` controls automatic vectorization of newly submitted records; turning it off neither clears existing vectors nor directly disables recall from them. Recall still needs a working query Embedding service.

## Understand the result

Continue with a question clearly related to a saved fact. Recall is bounded by relevance, record count, character budget, and timing. It can return nothing and does not guarantee a hit for every turn.

Project ownership influences ranking rather than imposing strict isolation. Read [Limits and data handling](./limits).

## A saved record is not recalled

Check whether the record has a vector, then whether the query is related. Automatic injection includes at most 3 records, with 300 characters per record and a total text budget of 2,000 characters. It does not load the entire library into an answer.

Automatic recall initially waits up to 1 second by default; a timeout discards that automatic result. Async mode does not wait. A result still belonging to the turn can enter later context assembly, but a turn completed in one model call may never use it. The foreground agent can also query `recall_l1_records` explicitly, returning 5 records by default.

Inputs such as “agreed” or “continue” may use a recent substantive discussion to form a query. Without an available topic, recall is skipped. A question naming the project, problem, and object is easier to use for checking results than repeatedly asking “do you remember?”

See the [Configuration guide](./configuration) for parameters, [Projects and profiles](./projects) for ranking, and [Context and progressive loading](./context-design) for injection placement and history boundaries.
