---
pageClass: ai-lite-guide
title: 整体设计
description: ai-lite 如何把调用、协议、HTTP、编排与状态分开，让能力逐步组合。
---

# 整体设计

ai-lite 把“怎么调用模型”和“怎么组织业务任务”分开。先看主调用路径，再看围绕它按需组合的模块。

<AiLiteFlow kind="architecture" />

## 主调用路径：四层各做一件事

| 层次 | 负责什么 | 为什么分开 |
| --- | --- | --- |
| 业务代码 | 构造消息、选择业务 id 与调用方式、使用结果 | 业务接口不必跟随供应商协议变化 |
| LlmGateway | 解析模型配置、发起调用、统一结果与取消语义 | 同步、异步与流式共享调用约定 |
| 协议适配器 | 组织请求体、解析响应和流式事件 | OpenAI 与 Anthropic 的格式差异留在这里 |
| HTTP 客户端 | 连接、发送、读取、网络取消 | 可以按运行环境替换网络实现 |

协议与 HTTP 是两个独立选择。OpenAI Completions、OpenAI Responses、Anthropic Messages 负责“说哪种协议”；OkHttp、Jetty 等负责“怎么传输”。兼容某种协议，不等于承诺支持供应商的每个扩展参数。

> 实现：[LlmGateway](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/LlmGateway.java)、[协议接口 LlmTransport](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/LlmTransport.java)。

## 从一轮调用到一项任务

一次调用只处理模型的一次响应。模型返回工具请求时，应用执行工具，并把工具结果交给下一轮模型。

<AiLiteFlow kind="tools" />

`toolLoop` 适合简单循环。`AgentLoop` 在此基础上提供生命周期处理、工具执行策略、整轮超时等能力；`Workflow` 则顺序执行预先定义的步骤。工具循环的下一步由模型输出决定，Workflow 的步骤顺序由应用预先确定。

工具可以串行或并行执行；并行完成后仍按模型原始顺序写入上下文，避免线程完成先后改变消息顺序。业务工具的权限、参数校验和重复执行处理仍由应用负责。

固定步骤、异步重试、生命周期和并行工具的递进示例，见[编排层：把多次调用组织成任务](./orchestration)。

## 会话与提示词各管自己的状态

<AiLiteFlow kind="state" />

会话条目保存消息、压缩摘要、用量等信息；上下文预算决定给模型发送多少历史，自动压缩需要启用并配置。提示词中心则管理模板、版本、发布、回滚和审计，渲染后提供消息。

这种划分让单次调用不必依赖会话，也让提示词可以继续由现有平台提供。跨请求历史的恢复、JDBC 持久化与 Redis 缓存组合见 [Session 的持久化](./session-persistence)。

> 实现：[Agent 与会话模块](https://github.com/yinwenyuan28-afk/ai-lite/tree/main/ai-lite-agent)、[提示词模块](https://github.com/yinwenyuan28-afk/ai-lite/tree/main/ai-lite-prompt)。

## 线程与传输

先区分两个问题：调用线程能否继续工作，以及底层网络等待会占用什么线程。

| 选择 | 调用侧 | 网络传输侧 |
| --- | --- | --- |
| 默认 OkHttp + 异步入口 | 调用线程拿到 future 后返回 | 每个在途请求占 Dispatcher 线程，流式持续到结束 |
| Jetty NIO | 使用异步入口返回 future | 非阻塞 I/O，以事件处理网络读写 |
| WebClient / Ktor CIO | 使用异步入口 | 分别依赖响应式客户端 / 协程网络实现 |
| JDK 21 执行器 | 可选虚拟线程执行应用任务 | 单独切执行器不改变 OkHttp Dispatcher |
| OkHttp 虚拟线程传输 | JDK 21+ 可选 | 使用专门的虚拟线程 Dispatcher 模块 |

NIO 指非阻塞 I/O：等待网络时，不需要为每个连接一直占住一个平台线程。它仍需要线程处理网络事件与业务回调。

Kotlin 协程桥接让等待中的协程挂起，也不会自动改变所选 HTTP 客户端的线程模型。选择时先看现有技术栈与并发需求，再测真实工作负载；本页不把模拟传输的吞吐量当作真实供应商吞吐量。

> 实现：[默认 OkHttp](https://github.com/yinwenyuan28-afk/ai-lite/tree/main/ai-lite-http-okhttp)、[Jetty](https://github.com/yinwenyuan28-afk/ai-lite/tree/main/ai-lite-http-jetty)。完整选项见[配置参考](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/docs/ref-配置.md)。

Jetty NIO 的同步、异步、重试与流式线程图，见[网关层：从一次调用开始（NIO）](./gateway-nio)。

## 模块如何组合

| 需求 | 主要模块 |
| --- | --- |
| 单次模型调用、协议与配置 | `ai-lite-llm` |
| Agent、Workflow、会话抽象 | `ai-lite-agent` |
| Spring Boot 自动装配 | `ai-lite-spring-boot-starter` |
| 提示词版本与渲染 | `ai-lite-prompt`，按需加 `ai-lite-prompt-jdbc` |
| 默认 / 可选 HTTP | `ai-lite-http-okhttp` / `ai-lite-http-jetty` 等 |
| 会话缓存 / 会话存储 | `ai-lite-session-redis` / `ai-lite-session-jdbc` |
| 调用记录 | `ai-lite-store-jdbc` |
| 运行时目录、管理 REST / 页面 | `ai-lite-admin-api` / `ai-lite-admin-ui` |

`ai-lite-core` 当前是兼容用的聚合依赖，转而依赖 `ai-lite-llm` 和 `ai-lite-agent`，不应把它理解为另一个承载全部实现的代码模块。

管理目录模式与最小 YAML 配置模式的装配不同。先用[快速开始](./quickstart)跑通配置档调用，再按需要加入数据库目录与管理功能。

## 运行时还要关注什么

显式重试控制瞬时错误后的重新调用；[限流熔断机制](./rate-limit-circuit)按供应商限制并发、熔断、处理多 key 轮换，默认不限并发且不开熔断。调用记录和 Micrometer 指标帮助查看耗时、状态与用量；持久记录需要选择相应存储。

这些能力帮助管理调用，业务仍需设置合适的时限、成本约束与工具权限。取消、失败与流式的具体边界见[常见问题](./faq)。

本页于 2026-11-17 核对当前本地源码，模块边界以各模块 `pom.xml` 和实现为依据。

模型选择、数据库覆盖与缓存刷新见 [Provider 与运行时配置](./provider-runtime)。
