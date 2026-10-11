---
title: Configure semantic recall
description: Set up Embedding, enable vectorization, and backfill existing records.
---

# Configure semantic recall

Semantic recall finds L1 records relevant to the current question. It needs a working Embedding service and matching local vectors.

::: info Default behavior
Vectorization is off by default. Automatic vectorization has a default threshold of **500 valid L1 records from the last 365 days**. Service configuration, enabling the switch, meeting the threshold, and backfilling historical records are separate steps.
:::

## Configure the service and switch

```text
/my-memory:model
```

Use the wizard to choose a background LLM, configure an OpenAI-compatible Embedding service, and explicitly enable vectorization. Changing the background LLM does not change the foreground conversation model.

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

## Understand the result

Continue with a question clearly related to a saved fact. Recall is bounded by relevance, record count, character budget, and timing. It can return nothing and does not guarantee a hit for every turn.

Project ownership influences ranking rather than imposing strict isolation. Read [Limits and data handling](./limits).
