---
title: FAQ
description: Who ai-lite is for, how to read its runtime target, and how it differs from the other projects here.
---

# FAQ

## Which systems is it for?

Existing services that still run Spring Boot 2.x and JDK 8 and need one or more model providers. The gateway, orchestration, sessions, and prompt versions are the four jobs in [What it covers](./overview).

## Why are the install commands not on this page?

The repository README is the source for install and wiring steps. This site keeps the product explanation. Use the [ai-lite repository](https://github.com/yinwenyuan28-afk/ai-lite) for commands.

## Does it remember Pi conversations?

No. Memory across Pi sessions is [Pi Memory](/en/docs/quickstart). A "session" in ai-lite is conversation state inside the Java service that survives the next HTTP request.

## What is the async I/O for?

Model calls wait on an outside service. Async I/O and coroutines keep that waiting off a large thread pool, so fewer threads can hold more concurrent requests.
