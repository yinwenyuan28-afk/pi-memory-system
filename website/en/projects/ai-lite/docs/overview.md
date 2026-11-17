---
title: What it covers
description: What ai-lite takes on inside an existing Spring Boot 2.x / JDK 8 system.
---

# What it covers

ai-lite is an AI integration layer for systems that already run on Spring Boot 2.x and JDK 8. Model calls, agent orchestration, cross-request sessions, and prompt versions live in one service. Application code stays in the existing project.

## Four jobs

| Capability | What it does |
| --- | --- |
| Model gateway | Application code uses one calling style for different model providers |
| Agent orchestration | Multi-step work becomes a flow that can run again |
| Cross-request sessions | Conversation state continues across HTTP requests |
| Prompt versions | Prompts keep versions you can compare |

The call path uses async I/O and coroutines, so a smaller thread pool can wait on more model requests.

## Where it sits

ai-lite covers model access inside an existing Java system. Long-term memory for Pi is [Pi Memory](/en/). File encoding for Cursor on Simplified Chinese Windows is [cursor-encoding-fix](/en/projects/cursor-encoding-fix/).

How the modules split and how they attach to an existing app is in the [GitHub README](https://github.com/yinwenyuan28-afk/ai-lite).

Next: [Quick start](./quickstart).
