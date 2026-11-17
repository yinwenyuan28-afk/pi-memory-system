---
title: Quick start
description: Install ai-lite from the repository README, then check four things after it is wired in.
---

# Quick start

Install, build, and the steps that attach it to an existing Spring Boot app live in the repository README:

[yinwenyuan28-afk/ai-lite](https://github.com/yinwenyuan28-afk/ai-lite)

This site does not keep a second copy of those commands.

The published target is **Spring Boot 2.x** and **JDK 8**.

## Four checks after wiring it in

1. Application code reaches models through one gateway, and the endpoints share that entry.
2. Multi-step work can be orchestrated as an agent flow and run again.
3. Session state can survive the next HTTP request.
4. Prompts have a version history, so you can see which version is current.

See [What it covers](./overview) for the boundary, and [FAQ](./faq) for the short answers.
