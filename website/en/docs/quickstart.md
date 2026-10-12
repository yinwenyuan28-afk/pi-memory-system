---
title: Quick start
description: Install Pi Memory and check your pipeline and model configuration.
---

# Quick start

Pi Memory extracts useful information from Pi conversations so you can continue project work in later sessions. Install the extension first, then configure semantic recall when needed.

::: info Current requirements
**Windows only**, with **Node ≥ 22.13**. The project has tested Pi 0.84.2, pi-coding-agent 0.83.0, and pi-ai 0.74.2 together. This is a tested combination, not an exhaustive compatibility list.
:::

## Install the extension

### Install from npm

Once the package is published to npm, run:

```bash
pi install npm:pi-memory-system
```

**The package has not been published to npm yet**, so this command is not available yet. It will work after publication.

### Install from a local directory

For development or before publication, install from a local extension directory. Replace the example path with your actual directory.

```powershell
pi install ./path/to/memory-system
```

Then run this inside **Pi**, or restart Pi:

```text
/reload
```

The extension launches its own background agents; pi-subagents is not required.

::: warning Use one installation method
Do not keep both an extension-directory copy and a `pi install` copy. This can register duplicate tools. Extract `.tgz` archives before installing; the directory is the supported input.
:::

## Check your configuration

```text
/my-memory:model:peek
```

This read-only command shows the background model source, Embedding status, vectorization switch, threshold, and vector count. It does not show API keys or call a remote service.

Extraction follows the foreground model by default. L1 schedules extraction after 10 interaction inputs by default; completion depends on the queue, model, and configuration.

## Check a small example

Discuss a clear project fact or task during normal work. For example, state the project path, a confirmed idempotency key, and a task to add retry tests. Once the response finishes, request extraction if needed:

```text
/my-memory:l1-trigger
```

This schedules background work. After it completes, inspect the records and pipeline in the [local viewer](./viewer). A scheduled request is not a completed extraction.

First confirm that the L1 record exists and its content and source are correct. After vectors are ready, ask a related question to check recall. Checking these stages separately helps locate problems. See [Background work and recovery](./pipeline) if a stage has not happened.

## Set up recall

If you want to retrieve records by the meaning of your question, we recommend configuring an Embedding service and enabling vectorization in [Configure semantic recall](./recall). Vectorization is off by default, and installation does not configure Embedding automatically; regular memory extraction and saving still work. You can backfill a small set of existing records manually. The author uses Alibaba Cloud Bailian, which currently lists free quotas for some text embedding models; check the console for eligibility and expiry.

Continue with the [Configuration guide](./configuration), [Command reference](./commands), and [Data, privacy, and backups](./data). The [repository README](https://github.com/yinwenyuan28-afk/pi-memory-system#readme) includes implementation details.
