---
pageClass: ai-lite-guide
title: 网关层：从一次调用开始（NIO）
description: 以 Jetty NIO 为例，从同步、异步、重试到流式，理解事件驱动的模型调用与线程占用。
outline: [2, 3]
---

# 网关层：从一次调用开始（NIO）

这一章把底层 HTTP 传输换成 Jetty NIO，继续从一句问答走到异步、重试和流式。业务仍使用同一个 `LlmGateway`，变化主要发生在“网络没有数据时，线程在做什么”。

与[默认 OkHttp 章节](../)对照：OkHttp 的执行中请求会持续占用 Dispatcher 工作线程；Jetty 异步请求等待网络就绪时，只保留连接与请求状态，由共享的 I/O / 事件处理线程在有工作时推进。

NIO 指非阻塞 I/O。它减少每个等待请求的线程占用，数据处理、解析与业务回调仍然需要线程。本页图中的灰色等待框表示**连接状态**，不表示一条线程正在为该请求睡眠。

正文和目录中的“★”表示该小节包含详细线程模型图。

## 先切换 HTTP 传输

保留 Starter，增加 Jetty 模块。下面使用当前本地源码核对的 0.1.15，两个依赖版本保持一致：

```xml
<dependency>
    <groupId>io.github.yinwenyuan28-afk</groupId>
    <artifactId>ai-lite-spring-boot-starter</artifactId>
    <version>0.1.15</version>
</dependency>
<dependency>
    <groupId>io.github.yinwenyuan28-afk</groupId>
    <artifactId>ai-lite-http-jetty</artifactId>
    <version>0.1.15</version>
</dependency>
```

模型与配置档沿用[快速开始](./quickstart)，另外设置传输：

```yaml
ai-lite:
  http:
    transport: jetty
    jetty:
      max-connections-per-destination: 64 # 示例连接上限，按实际需求调整。
      threads: 0                         # 使用 Jetty 默认线程池。
```

`max-connections-per-destination` 是单个目标地址的连接上限，64 仅用于示例。`dispatcher.*` 属于 OkHttp，切 Jetty 后不作为它的并发配置。选择 Jetty 但未引入对应模块时，会明确报错，不会静默切回其他传输。

本页假设已经注入 `LlmGateway gateway`，`intro` 已在业务 id 中登记，`main` 配置档指向可用模型。当前适配模块基于 Jetty 9.4，运行环境与依赖兼容范围以[仓库配置参考](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/docs/ref-配置.md)为准。

## 1. ★ 同步：底层是 NIO，调用方仍然等完整结果 {#_1-同步-底层是-nio-调用方仍然等完整结果}

先保持最简单的用法：问一次，得到完整文字后再继续。

```java
LlmCall call = LlmCall.profile("intro", "main",
        Collections.singletonList(
                LlmMessage.user("用一句话介绍你自己")));

LlmResult result = gateway.one(call);
System.out.println(result.getContent());
```

<AiLiteFlow kind="nioSync" />

`one` 的契约要求返回时已有结果。Jetty 的同步路径使用响应监听器等待响应，再在调用线程读取正文，因此这条业务线程仍然会等待。换成 NIO 传输，不会自动改变同步入口的行为。

**设计原因**：HTTP 传输模型与公共调用方式分别选择。需要释放调用线程时，还要使用下一节的异步入口；只切换客户端实现并不能替应用完成这一步。

> 实现：[JettyHttpExecutor.execute / executeStreaming](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-http-jetty/src/main/java/io/github/yinwenyuan28/ailite/http/jetty/JettyHttpExecutor.java) 使用同步等待与读取，异步路径则使用响应事件监听。

## 2. ★ 异步：等待连接就绪，共享线程处理事件 {#_2-异步-等待连接就绪-共享线程处理事件}

把 `one` 换成 `oneAsync`，输入和结果类型不变：

```java
CompletableFuture<LlmResult> future = gateway.oneAsync(call);
future.thenAccept(result ->
        System.out.println(result.getContent()));
```

<AiLiteFlow kind="nioAsync" />

这里释放了两种不同的等待：业务线程拿到 future 后可以继续工作；Jetty 侧也不需要为这个请求持续保留一条阻塞读流的线程。网络数据就绪后，事件处理线程才读取数据、解析响应、推进 future。

### 2.1 没有请求专属等待线程，状态放在哪里？ {#没有请求专属等待线程-状态放在哪里}

| 阶段 | 仍然保留什么 | 线程做什么 |
| --- | --- | --- |
| 请求已发送、模型还在生成 | 连接、请求、监听器与未完成 future | 共享线程可处理其他连接的事件 |
| 响应数据可读 | 同一请求的响应状态 | 执行读取与内容处理回调 |
| 响应结束 | 完整结果或失败信息 | 执行完成处理并结束这次任务 |

Jetty 仍需要共享的网络选择与事件处理线程。共享线程也会等待一组连接的就绪通知，区别在于多个连接共用这套机制，而不是每个请求各自等待。

图中的“Jetty I/O / 事件处理”表示执行职责，不承诺所有回调固定在某条 selector 线程，也不保证每次事件由同一条线程处理。

### 2.2 thenAccept 的耗时仍然需要考虑 {#thenaccept-的耗时仍然需要考虑}

`thenAccept` 可能直接在完成 future 的线程上执行。若在其中进行慢查询或重计算，仍会占用当时的 Jetty 响应处理线程；若 future 已经完成后才注册，执行线程也可能不同。

需要隔离耗时业务处理时，可明确使用应用管理的执行器：

```java
// businessExecutor 是应用已有的 Executor，用来承载自己的结果处理。
future.thenAcceptAsync(result ->
        System.out.println(result.getContent()), businessExecutor);
```

`ai-lite.callback.mode: io` 并不会自动把普通 `oneAsync` 的全部后续处理或协议解析搬走；它在流式调用中的作用见第 4 节。

> 实现：[JettyHttpExecutor.executeAsync](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-http-jetty/src/main/java/io/github/yinwenyuan28/ailite/http/jetty/JettyHttpExecutor.java) 通过 `onContent` 累计响应、`onComplete` 处理结果。

## 3. ★ 异步重试：网络等待和退避分别由谁管理？ {#_3-异步重试-网络等待和退避分别由谁管理}

显式重试入口保持相同：

```java
RetryPolicy policy = RetryPolicy.builder()
        .maxAttempts(3)
        .totalDeadlineMs(15000L) // 限制是否继续重试，不强制终止在途请求。
        .build();

CompletableFuture<LlmResult> future =
        gateway.oneWithRetryAsync(call, policy);
```

<AiLiteFlow kind="nioRetry" />

网络等待由 Jetty 的连接与事件机制负责；重试退避仍交给独立的 `ai-lite-retry-*` 调度器。一次失败事件处理完，Jetty 回调返回；定时任务到点后，调度线程检查取消与预算，再调用下一次 `oneAsync`。

### 3.1 两种等待都不需要为每次调用占住一条线程 {#两种等待都不需要为每次调用占住一条线程}

- **等网络**：连接保留状态，数据就绪时由共享事件处理线程推进。
- **等退避**：定时任务留在调度队列，到点才执行短小的发起动作。
- **真正执行回调时**：仍会占用执行它的线程，回调应保持短小。

业务拿到的仍然是一个整体 future，内部每次尝试有新的 future 和取消句柄。图示采用“第一次 503、关闭随机变化后退避 200ms、第二次成功”的简化过程，时间轴不按比例。

### 3.2 哪些规则与 OkHttp 相同？ {#哪些规则与-okhttp-相同}

`maxAttempts` 包含首次尝试，普通 `oneAsync` 不自动重试。默认瞬时错误分类、指数退避、随机变化和 `Retry-After` 的裁剪都由网关的公共重试实现决定，不随传输改变。

`totalDeadlineMs` 不主动中断已经在途的请求；预算到期后才返回的成功仍可能被接受。句柄取消结束整个重试过程，直接 `future.cancel(true)` 保留 JDK cancelled 语义。错误分类、时间表、监听器与失败记录的完整解释见[重试深入讲解](../#深入一层-两次失败以后-调用方到底在等什么)。

**设计原因**：Jetty 管连接，网关管重试，调度器只管何时发起下一次。换传输以后，业务侧不需要重写一套重试规则。

## 4. 流式：数据到来才处理，两段之间不独占线程

```java
LlmCancelHandle cancel = new LlmCancelHandle();
CompletableFuture<LlmResult> future =
        gateway.oneByStreamAsync(call,
                delta -> System.out.print(delta), cancel);
```

异步与流式仍是两个维度：方法先返回 future，内容在生成过程中逐段交付。变化在于 Jetty 不持续阻塞读取同一个请求，而是在收到内容事件时推进。

### 4.1 ★ inline：增量回调仍在事件处理路径里 {#inline-增量回调仍在事件处理路径里}

<AiLiteFlow kind="nioStream" />

每次 `onContent` 收到字节后，Jetty 适配器通过 UTF-8 行缓冲处理分片，再把文本行交给协议适配器。协议层拼装事件、累计结果，并交付文本增量；两段数据之间没有请求专属线程一直阻塞读取。

默认 `inline` 的 `onDelta` 直接在触发它的事件回调路径里执行。因此 NIO 并不会让一段慢数据库操作变得无害：它仍然占着当时的事件处理线程。

`oneByStream` 则是同步流式：即使每段都能显示，方法本身仍等待流结束。不要只根据“流式”二字判断调用线程是否会等待。

### 4.2 ★ io：将用户增量处理交给独立回调池 {#io-将用户增量处理交给独立回调池}

```yaml
ai-lite:
  callback:
    mode: io
    queue-capacity: 1024
```

<AiLiteFlow kind="nioStreamIo" />

Jetty 侧处理本次网络事件并投递增量，独立回调池再按本次调用的顺序运行 `onDelta`。同一调用的两段不并发执行，但前后回调也不保证使用同一条池线程。

如果用户回调比网络处理慢，本次网络事件处理可以先结束，整体 future 却仍未完成：正常成功路径必须先处理此前已入队增量，再执行队列中的完成标记。

这张图中的长方块表示第一段用户回调尚未返回，第二段先进入队列等待。网络事件间隔的灰色框表示连接状态，不是线程在执行睡眠。

### 4.3 最终结果、错误与取消怎么处理？ {#最终结果、错误与取消怎么处理}

与默认传输保持相同的业务约定：

| 情况 | 需要理解的边界 |
| --- | --- |
| 收到一段增量 | 不代表整个调用成功，future 可能仍未完成 |
| 最后拿到结果 | 检查停止原因，不把完整正文再次追加到已显示内容后面 |
| 模型返回推理内容 | 普通 onDelta 可能混合推理与正文，不能假设拼接等于 getContent() |
| 用户回调太慢 | 独立池仍可能忙满；提交失败可能以 OVERLOAD 结束 |
| 浏览器断开或用户停止 | 应用应连接到本次取消句柄，不让模型请求继续运行 |

Jetty 通过 `request.abort()` 中止网络请求，但不能撤回已经执行的用户代码。句柄取消和直接 future 取消对已排队回调的处理存在差别，详见[流式失败与取消](../#如果消费速度跟不上-或流中途失败了呢)。

流式重试仍是同步的 `oneByStreamWithRetry`，默认只在首个增量交付前允许重试。换成 Jetty 不会增加一个 `oneByStreamWithRetryAsync` 入口，也不会让同步退避自动变成异步调度。

> 实现：[JettyHttpExecutor.executeStreamingAsync](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-http-jetty/src/main/java/io/github/yinwenyuan28/ailite/http/jetty/JettyHttpExecutor.java) 的 `onContent / onComplete`、[CallbackPolicy](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/CallbackPolicy.java)。增量内容、完成顺序和浏览器输出的详解见[流式深入讲解](../#深入一层-一段增量是怎样到达-ondelta-的)。

## 5. 线程少了，为什么仍要限制并发与等待？

NIO 节省的是每个请求等待网络的线程，连接、缓冲区、模型上下文、解析与业务处理仍占资源。供应商配额、连接数、CPU 和内存都可能成为限制。

### 5.1 连接数与线程数是两种配置 {#连接数与线程数是两种配置}

`jetty.max-connections-per-destination` 控制单目标连接数。达到连接与上游容量后，继续增加请求并不一定增加吞吐，还可能增加排队时间。

`jetty.threads: 0` 保留 Jetty 默认线程池。若显式指定固定大小，当前实现会检查至少满足 `max(1, CPU核数 / 2) + 2`；过小可能在客户端首次懒创建时失败。不要把“NIO 用较少线程”理解成可以随意把线程池设成 1。

### 5.2 读取超时与整个任务的时限不同 {#读取超时与整个任务的时限不同}

当前 Jetty 适配将读取超时映射到请求的 `idleTimeout`，限制无数据活动的间隔；持续有数据的流，可能运行得更久。连接与读取超时非正数会取框架默认值，不表示无限等待。

需要结束整项任务时，还要在应用中安排取消或选择提供相应超时控制的上层入口。`RetryPolicy.totalDeadlineMs` 仍不是严格的在途请求中断器。

当前实现按连接超时值复用客户端，最多缓存 16 组。每组都有连接和线程资源，不宜给每次请求生成大量不同的连接超时值；这些容量也不意味着模型供应商会接受无限并发。

> 实现：[JettyHttpExecutor.newRequest / client / createClient](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-http-jetty/src/main/java/io/github/yinwenyuan28/ailite/http/jetty/JettyHttpExecutor.java)。完整字段见[HTTP 传输配置](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/docs/ref-配置.md)。

## 接下来继续到编排层

| 需要做什么 | 继续阅读 |
| --- | --- |
| 对照每个等待请求占线程的实现 | [一、网关层：从一次调用开始](../) |
| 把多次调用组织成任务 | [编排层：从步骤到任务](./orchestration) |
| 了解所有模块如何组合 | [整体设计](./overview) |

本页于 2026-11-17 对照本地 Jetty 传输、网关、回调策略与相关测试核对。图中使用“Jetty I/O / 事件处理”表示职责，不将所有回调绑定到同一个 selector 或工作线程。
