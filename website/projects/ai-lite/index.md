---
pageClass: ai-lite-guide
title: ai-lite：从一次调用开始
description: 从同步、异步、重试到流式、工具和会话，用图解理解 ai-lite 的设计。
outline: [2, 3]
---

# ai-lite，从一次调用开始

把模型接入现有的 Java 服务，从一句问答开始，按需要增加异步、重试、流式和多轮执行。

ai-lite 面向 **Spring Boot 2.x / JDK 8** 存量系统。业务通过同一个网关调用模型，协议、网络传输、执行方式和状态存储分别处理。你可以先用最小调用，再逐步组合其他模块。

[动手接入](./docs/quickstart) · [查看整体设计](./docs/overview) · [GitHub 源码](https://github.com/yinwenyuan28-afk/ai-lite)

## 先看它放在哪里

<AiLiteFlow kind="architecture" />

先沿蓝色主线看：业务把消息交给网关，网关选择协议适配器，由 HTTP 客户端访问模型。左侧的 Agent 与会话负责组织多次调用，右侧的提示词与目录提供消息和模型配置；它们在需要时加入。

下面始终用“用一句话介绍你自己”这个问题，只改变调用方式。示例假设已注入 `LlmGateway gateway`，配置见[快速开始](./docs/quickstart)。

## 1. 同步：问一次，等完整回答

最简单的需求，是拿到一段完整文字再继续业务处理。`LlmCall` 描述本次输入，`LlmResult` 承载结果，`one` 完成一次模型调用。

<AiLiteFlow kind="sync" />

```java
// main 是预先配置的模型组合，intro 是已登记的业务 id。
LlmCall call = LlmCall.profile("intro", "main",
        Collections.singletonList(
                LlmMessage.user("用一句话介绍你自己")));

LlmResult result = gateway.one(call);
System.out.println(result.getContent());
```

业务线程会等到调用结束。适合任务量不大、需要立刻消费结果的逻辑。模型回答耗时长时，下一步要解决的是等待期间的线程占用。

**这一层的设计：**业务代码描述“调用哪个配置、发送什么消息”，协议字段和响应解析留给适配器；一次调用本身不自动执行工具循环。

> 源码：[LlmCall 与调用入口](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/LlmGateway.java)。后文的调用沿用上面的 `call`。

## 2. 异步：把等待交给 future

输入和最终结果都不变，把 `one` 换成 `oneAsync`。返回的 `CompletableFuture` 表示“结果稍后完成”，调用线程可以继续处理其他工作。

<AiLiteFlow kind="async" />

```java
CompletableFuture<LlmResult> future = gateway.oneAsync(call);

future.thenAccept(result ->
        System.out.println(result.getContent()));
future.exceptionally(error -> {
    System.err.println(error.getMessage());
    return null;
});
```

**这一层的设计：**把“发起调用”和“使用结果”分开。拿到 future 表示调用线程不必继续等模型，不是线程立即销毁；业务继续执行，外层任务结束后才可能归还线程池。如果紧接着执行 `join()` 或 `get()`，当前线程仍然会等待。

异步也不表示整个请求都不占线程：默认 OkHttp 使用 `enqueue` 释放调用线程，请求获得执行名额后，连接、等待响应和读取都仍占用 Dispatcher 工作线程；尚在调度队列里排队的请求不算已占住一个工作线程。需要减少传输层平台线程时，可选 Jetty NIO 等实现，详见[线程与传输](./docs/overview#线程与传输)。

回调里适合做短小的结果处理。耗时计算或阻塞操作应交给应用自己的执行器，避免拖慢响应处理。

## 3. 异步重试：偶发失败，按规则再试

网络抖动、供应商限流或短时故障，并不一定意味着这次任务必须失败。使用显式重试入口，让策略决定哪些错误可重试、最多尝试几次、何时不再继续重试。

<AiLiteFlow kind="retry" />

```java
RetryPolicy policy = RetryPolicy.builder()
        .maxAttempts(3)          // 包含首次调用，最多再试两次。
        .totalDeadlineMs(15000L) // 限制继续重试的时间预算。
        .build();

CompletableFuture<LlmResult> future =
        gateway.oneWithRetryAsync(call, policy);
```

**这一层的设计**：重试是调用方显式选择的能力。`oneAsync` 本身只尝试一次，应用不必承担隐藏的额外调用和费用。

默认策略重试传输错误和 HTTP 408、429、500、502、503、504 等瞬时错误；参数错误、解析错误等不会因此自动重试。默认退避从 200ms 开始、按 2 倍增长、最多 2s，并加入小幅随机变化，减少多个请求同时重发。

异步退避由专用调度器安排，不在 HTTP 回调线程里睡眠。策略默认不限制重试时间预算，建议像示例一样显式设置。此预算不会主动中断已经在途的请求，连接与读取超时需另行设置。取消则结束当前重试过程，不再继续安排尝试。

> 源码：[RetryPolicy](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/RetryPolicy.java)。即使没有收到结果，供应商也可能已处理请求；重试可能带来额外费用。


### 深入一层：两次失败以后，调用方到底在等什么？

先按一个具体过程看：允许总共尝试 3 次，退避从 200ms 开始、每次翻倍。为了让时间容易对照，下面暂按 `jitter(false)` 关闭随机变化，且假设没有 `Retry-After`。请求耗时为示例值。

| 相对时间 | 内部发生什么 | 调用方拿到的整体 future |
| --- | --- | --- |
| 0–120ms | 第 1 次请求返回 HTTP 503 | 尚未完成 |
| 120–320ms | 调度等待 200ms | 尚未完成 |
| 320–500ms | 第 2 次请求发生连接中断 | 尚未完成 |
| 500–900ms | 调度等待 400ms | 尚未完成 |
| 900–1200ms | 第 3 次请求成功 | 完成，交付本次成功结果 |

调用方只拿到**一个整体 future**，内部每次调用 `oneAsync` 都会产生**新的尝试 future**。第 1 次尝试的 future 异常完成后，不会“恢复成未完成”再复用；重试执行器接住这次失败，决定是否创建下一次尝试。

因此，调用方注册的 `future.exceptionally(...)` 观察的是整个重试过程最终失败，并不会在前两次可恢复的失败时各触发一次。若需要观察中间的重试，使用后面的策略监听器。

**设计原因**：把一次网络请求的生命周期，与业务等待的整个重试过程分开。网关内部的 `RetryRun` 记录已开始次数、当前尝试、下一次定时任务、历史失败和整体结果，决定“继续”还是“结束”。

> 实现：[LlmGateway.RetryRun](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/LlmGateway.java) 的 `startAttempt` 与 `onAttemptComplete`。

### 退避期间，谁在等，谁在工作？

如果直接在失败回调里 `Thread.sleep(200)`，HTTP 工作线程就会被这次退避占住。ai-lite 把“过多久再试”转换成定时任务：失败回调完成判断和投递后返回，到点再由专用调度线程发起下一次异步调用。

<AiLiteFlow kind="retryScheduling" />

第一次尝试在调用线程上发起；后续尝试由 `ai-lite-retry-*` 调度线程发起。等待到期的任务保存在队列里，不需要为每个退避中的调用占住一条睡眠线程。调度线程发起下一次请求后，也不在这里等待模型完整响应；网络等待仍按所选 HTTP 客户端的线程模型执行。

即使退避为 0，也会提交调度任务再推进。这样，连续立即失败的请求不会在同一条调用栈里递归地不断重试。

**设计原因**：把网络处理和退避安排分开，避免一次短暂故障进一步占满 HTTP 工作线程。前一节说的“默认 OkHttp 在网络等待期间仍占线程”依然成立，退避阶段和网络请求阶段要分开看。

### 什么错误能再试？下一次究竟等多久？

重试先判断错误类型，再检查尝试次数和时间预算。HTTP 401 往往需要修正密钥，参数错误需要改请求；不改变输入就重复发送，通常只会再次失败。

| 默认分类 | 行为 |
| --- | --- |
| 传输错误，例如连接中断 | 允许进入重试判断 |
| HTTP 408 / 429 / 500 / 502 / 503 / 504 | 允许进入重试判断 |
| 参数、配置、解析错误，以及其他 HTTP 状态 | 不按默认策略重试 |
| 已包装为 `LlmCallException`，分类为 `UNKNOWN`（未分类），且根因链中有 `IOException` | 兼容为可重试传输故障 |
| 取消，或结果为 ABORTED | 结束，不作为普通失败重试 |

这里的未分类兼容只针对上述异常类型；第三方传输直接抛出的普通异常不会因此自动重试。参数或配置校验也可能在返回 future 前同步抛出，应先修正输入。

“允许重试”还不等于一定会发下一次请求：次数耗尽、预算到期或取消都会阻止继续。自定义 `retryable(...)` 会替换默认判定；如果还要保留默认错误范围，需要在自己的判断中显式调用 `RetryPolicy.defaultRetryable(error)`。

没有服务端等待建议时，退避先按下面的顺序计算：

1. 按失败次数计算指数退避：`initialBackoffMs × multiplier^(失败次数 − 1)`。
2. 用 `maxBackoffMs` 限制上限；默认开启随机变化，在结果附近上下浮动约 20%，再限制上限。
3. 若设置了重试时间预算，再将等待裁剪到剩余预算内；到点后重新检查是否还能开始下一次尝试。

默认参数为：总尝试 3 次、初始退避 200ms、倍率 2、退避上限 2000ms、随机变化开启、重试时间预算未设置。因此默认最多只有两段退避，基准值为 200ms 和 400ms；上限并不意味着每次都等 2 秒。

`Retry-After` 是服务端建议多久以后再试的响应头。如果异常中带有已解析的这个值，它会优先于本次指数退避，但仍受 `maxBackoffMs` 和剩余预算限制。例如服务端建议 5 秒、策略上限 2 秒，本次按最多 2 秒计算；如果只剩 600ms 预算，就将定时等待裁剪到剩余时间，到期后结束，不再多发一次。

**设计原因**：通过递增等待降低连续重发的频率；随机变化减少多个调用同时失败后又同时重发。服务端建议、应用可接受的等待上限和整个过程的时间预算，共同决定何时继续。

> 实现：[RetryPolicy.delayMs / defaultRetryable](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/RetryPolicy.java)、[RetrySupport.backoffMs / clampDelayMs](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/internal/llm/RetrySupport.java)。

### 三个限制分别管什么？

`maxAttempts`、单次 HTTP 超时和 `totalDeadlineMs` 约束的对象不同，不能只配置其中一个就认为整个调用受到了完整限制。

| 限制 | 约束什么 | 不会自动做到什么 |
| --- | --- | --- |
| maxAttempts | 最多发起多少次尝试，包含第一次 | 不限制一次尝试等待多久 |
| 连接 / 读取超时 | 当前请求的连接与读取等待 | 不限制所有重试加起来的时长 |
| totalDeadlineMs | 根据已用时间决定是否继续尝试，并裁剪退避 | 不主动中断已经在途的请求 |

例如预算设为 50ms，第 1 次请求在 100ms 后才成功，当前实现仍会返回这次成功结果。如果请求在预算到期后失败，则不再开始下一次尝试。它不是到 50ms 必定完成 future 的定时器。

设置 `totalDeadlineMs(0L)` 表示立即到期，未取消的正常调用不会发起首次请求；不设置才表示不限制。开始尝试前、可重试失败后和退避到点时会检查预算。

下面展示如何分别配置这些限制。数值仅用于说明各自的作用，应按业务可接受的等待和供应商表现调整：

```java
// 单次连接与读取超时，单位毫秒；超时语义仍取决于 HTTP 实现。
call.timeouts(3000, 10000);

RetryPolicy configuredPolicy = RetryPolicy.builder()
        .maxAttempts(3)
        .initialBackoffMs(200L)
        .multiplier(2.0D)
        .maxBackoffMs(2000L)
        .jitter(true)
        .totalDeadlineMs(15000L) // 决定是否继续重试，不强制终止在途请求。
        .build();

CompletableFuture<LlmResult> retried =
        gateway.oneWithRetryAsync(call, configuredPolicy);
```

如果业务要求到点主动结束等待，还需要由应用安排取消，并设置合适的 HTTP 超时；取消也不能撤销供应商已经执行的请求。

> 验证：[LlmGatewayAsyncRetryTest.b05DeadlineDoesNotInterruptInFlightAttempt](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/test/java/io/github/yinwenyuan28/ailite/llm/LlmGatewayAsyncRetryTest.java) 专门覆盖“预算已到，在途请求随后成功”的行为。

### 取消如何同时管住当前请求和下一次重试？

```java
LlmCancelHandle cancel = new LlmCancelHandle();
CompletableFuture<LlmResult> future =
        gateway.oneWithRetryAsync(call, configuredPolicy, cancel);

// 用户中止时，由应用调用 cancel.cancel()。
```

外层取消句柄代表整个重试过程。每次真实尝试都使用新的内部取消句柄，外层只转发给当前尝试；不会让下一次请求复用已经取消过的句柄。

- **正在请求时取消**：向当前传输传播取消，整个过程按 ABORTED 结束。
- **正在退避时取消**：撤销尚未执行的定时任务，结束整个过程。
- **直接取消 future**（`future.cancel(true)`）：整体 future 保持 JDK 的 cancelled 语义，同时清理定时任务并传播底层取消。

HTTP 完成回调、定时任务和取消可能来自不同线程。内部在确定终态时使用原子状态控制，确保整体结果只确定一次；终态之后的迟到回调不能重新启动重试。正在发出的请求仍可能已被供应商处理，因此取消与重试都不等于撤销执行。

### 如何知道中间发生了什么？

整体 future 最终成功，不代表前面没有失败。需要记录“准备进行下一次尝试”时，可以配置监听器：

```java
RetryPolicy observedPolicy = RetryPolicy.builder()
        .maxAttempts(3)
        .totalDeadlineMs(15000L)
        // 参数依次为已失败次数、本次计划退避毫秒数和失败原因。
        .listener((failedAttempt, delayMs, error) ->
                System.out.println("准备第 " + (failedAttempt + 1)
                        + " 次尝试；计划退避 " + delayMs + "ms"))
        .build();
```

异步入口的监听器在退避到点、下一次尝试开始前执行，运行在线程名为 `ai-lite-retry-*` 的调度线程上；它并非失败发生瞬间的通知。若退避期间已取消或预算已到期，可能不会触发。`delayMs` 是本次安排的退避值；调度线程繁忙或监听器耗时，都会使实际发起时间更晚。这里只做短小记录，避免阻塞后续重试的发起。

每次真实尝试分别走单次调用的记录流程；启用对应记录存储后，可以看到多次尝试，而不是一条记录包住全部请求。最终成功结果中的用量不会自动累计此前失败尝试的用量，核算整个过程应结合每次记录。最终失败时，通常以最后一次失败作为主异常，前面的失败通过 `getSuppressed()` 附在异常上，便于排查。预算到期等路径则会构造相应异常并保留此前失败信息。

**回看最初的图**：“一次尝试”有自己的请求与结果；“检查结果”结合错误、次数和时间预算；“调度后重试”只保留定时任务；“完成”则结束调用方拿到的整体 future。重试放在单次调用外围，让这些规则保持一致，也让调用方明确决定是否承担额外请求和费用。


## 4. 流式：先看到一部分，再拿到完整结果

聊天界面往往不想等整段回答生成。流式入口在生成过程中把文本增量交给 `onDelta`，结束时仍然给出完整 `LlmResult`。

<AiLiteFlow kind="stream" />

```java
LlmCancelHandle cancel = new LlmCancelHandle();

CompletableFuture<LlmResult> future =
        gateway.oneByStreamAsync(call,
                delta -> System.out.print(delta), cancel);

future.thenAccept(result ->
        System.out.println("\n生成结束"));

// 用户中止时调用 cancel.cancel()。
```

**这一层的设计**：“如何等待”和“如何交付内容”是两件事。`oneByStreamAsync` 同时提供异步结果与增量回调；同步的 `oneByStream` 也能逐段输出，但调用方法仍要等到流结束。

不要把最终 `result.getContent()` 再追加到已经显示的增量后面，否则文字会重复。增量是文本片段，不承诺一段对应一个字或一个 token。

::: warning 流式重试要关心已经发出去的内容
`oneByStreamAsync` 不自动重试。同步的 `oneByStreamWithRetry` 默认只在尚未向外输出增量时允许重试；已经输出后，重新请求可能重复或改变前文，因此默认结束并报错。不能把普通异步重试直接视为异步流式重试。
:::

把增量推给浏览器，还需要应用接入 SSE（服务端向浏览器持续发送事件）等输出通道。Controller 返回 `SseEmitter` 或 future 时，要确认 Servlet 和参与的过滤器均支持异步。


### 深入一层：一段增量是怎样到达 onDelta 的？

以 OpenAI Completions 兼容协议为例，模型通过 SSE 事件陆续发送内容。SSE 是服务端在同一个 HTTP 响应里持续发送事件的格式；网络读到的字节片段、SSE 事件、业务收到的文本增量，是三个不同边界。

<AiLiteFlow kind="streamDecode" />

HTTP 客户端先处理字节与文本行的边界；协议适配器再把事件中的 JSON 解析成正文、推理、停止原因或用量等信息。只有适合展示的文本才交给 `onDelta`，并不是收到一个网络包就调用一次。

| 层次 | 可能收到什么 | 为什么不能直接当作完整回答 |
| --- | --- | --- |
| 网络读取 | 半行、多行，或分在多次读取里的字符字节 | 网络分片不按业务内容切割 |
| SSE 事件 | 文本变化、停止信息、用量等协议数据 | 不是每个事件都包含正文 |
| onDelta | 一段可交付的文本 | 不承诺对应一个字、一个 token 或一条完整句子 |

HTTP 200 只说明响应已经开始，仍要继续读取和解析。模型服务端也可能忽略流式请求而返回完整 JSON；当前 Completions 适配器有对应的完整响应解析路径，这时可能拿到最终结果却没有逐段回调。

**设计原因**：HTTP 层处理网络读取，协议层理解事件含义，业务层消费文本。业务代码不必自己拼接不完整的 SSE JSON，也不必跟随各家供应商的事件字段变化。

> 实现：[OpenAiCompletionsTransport.completeAsync / handleEvent](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/transport/OpenAiCompletionsTransport.java)、[OkHttpExecutor.executeStreamingAsync](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-http-okhttp/src/main/java/io/github/yinwenyuan28/ailite/http/okhttp/OkHttpExecutor.java)。

### 增量、最终正文和最终状态分别怎么用？

先看一个**只有正文**的例子。假设依次收到三次回调：

| 时刻 | onDelta 收到 | 当前可展示文字 | 结果 future |
| --- | --- | --- | --- |
| 第 1 段 | `你` | 你 | 尚未完成 |
| 第 2 段 | `好` | 你好 | 尚未完成 |
| 第 3 段 | `！` | 你好！ | 可能仍未完成 |
| 流读取、解析和正常收尾完成 | 不必再有文本增量 | 你好！ | 返回 LlmResult |

最后一段文字到达，不等于整个调用已经完成。协议尾部还可能包含停止原因和用量。业务可以先展示增量，再用最终结果确认状态；不要把完整正文再次追加到界面。

普通 `Consumer<String>` 回调是一条无类型的文本通道。在供应商支持推理输出时，它也可能收到推理内容及分隔符；最终结果则用 `getContent()` 和 `getThinkingText()` 分别提供正文与推理。因此不能对所有模型都假设“把 onDelta 全部拼起来，就等于 getContent()”。

如果需要在界面中区分正文与推理，应选择提供类型信息的上层入口，例如编排层同步流式的 `AgentDeltaListener`，并按 `DeltaKind` 分开处理；不能靠猜测字符串内容可靠地区分。

```java
// onDelta 负责增量交付；完成回调负责读取最终状态，不重复追加正文。
future.whenComplete((result, error) -> {
    if (error != null) {
        System.err.println("生成失败：" + error.getMessage());
    } else {
        System.out.println("停止原因：" + result.getStopReason());
    }
});
```

正常完成 future 也不保证文本已经满足业务要求，例如输出达到模型上限仍可能返回结果。结构化 JSON 输出在生成中可能是不完整片段，业务校验应结合最终内容与停止原因，不能要求每段增量都能单独解析。

### 回调在哪个线程执行，为什么还要保证顺序？

默认 `inline` 策略直接在触发增量的线程上运行 `onDelta`。异步流式使用默认 OkHttp 时，通常是读取响应的 Dispatcher 工作线程；同步流式则在调用线程上回调。

因此，回调里执行一次慢数据库操作，会拖住这一条响应的读取。需要把回调与 HTTP 处理分开时，可以为异步入口选择 `io` 策略：

```yaml
ai-lite:
  callback:
    mode: io
    queue-capacity: 1024 # 每次调用的待执行回调队列上限。
```

这个配置使用独立共享的回调线程池。同一次调用的回调按提交顺序串行执行，任意两段不会同时执行；不同调用仍可共享池内线程。串行保证顺序与不并发，不保证前后回调始终使用同一条池线程。同步入口保持原线程执行，不会因为这个开关就变为异步。

<AiLiteFlow kind="streamCallbacks" />

在正常成功路径中，网关会把“完成 future”的动作排在已入队的增量之后。例如队列中是 `第1段 → 第2段 → 完成标记`，必须先执行完前两段回调，再让调用方观察到成功完成。这样不会出现业务已经显示“完成”，队列却还在继续处理此前的正文。

**设计原因**：线程隔离需要和顺序约束一起做。直接把每个增量随意丢给普通线程池，可能让后面的文字先执行，或让完成通知早于文字处理。

不要在 `onDelta` 中对同一次流的 future 调用 `join()` 或 `get()`：完成动作正在等回调返回，回调却又等 future 完成，会形成相互等待。

> 实现：[CallbackPolicy](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/CallbackPolicy.java)、[SerialCallbackExecutor](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/SerialCallbackExecutor.java)、[LlmGateway.AsyncRun.completeBarrier](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/LlmGateway.java)。

### 如果消费速度跟不上，或流中途失败了呢？

`io` 策略把回调放入有上限的队列，不能让慢消费者无限积压内存。向回调通道提交失败，例如队列已满或初次调度被回调池拒绝时，调用会以 `OVERLOAD` 异常结束，并中止底层传输；它不会无限缓存，也不会自动让模型放慢生成速度。

独立回调池能减少慢回调直接阻塞 HTTP 线程的情况，但慢任务仍可能占满这个共享池，进而拖延其他调用。回调应保持短小，业务自身的输出队列也要有明确的容量与失败处理。

| 情况 | 调用结果与应用需要处理的事 |
| --- | --- |
| 网络或协议处理失败 | future 异常完成；界面可能已经显示部分文字 |
| onDelta 自身处理失败 | 可能使本次调用失败；不能把它当作一定会被忽略的观察日志 |
| 向 io 回调通道提交失败，例如队列满 | OVERLOAD 异常，并中止传输 |
| 调用取消句柄 cancel.cancel() | 正常完成 ABORTED 结果，传播底层取消 |
| 直接 future.cancel(true) | 保持 JDK cancelled 状态，同时传播底层取消 |

普通传输失败的完成处理，与取消、队列溢出等终止路径并不相同。使用取消句柄时，ABORTED 的完成动作也经过队列末尾，因此取消后仍可能处理已经入队的增量；直接取消 future 或队列溢出时，则会关闭队列并清除未执行增量。onDelta 自身的某些失败路径会直接异常完成，也不统一等待队列。已经开始执行的用户回调不能被强制撤回，仍可能运行到结束。

应用应保留明确的“生成中、完成、中止、失败”状态。已经显示的部分文字不能仅因存在就当作完整成功结果，也不能假设取消结果一定包含全部已展示内容。是否保留、标记为未完成或清除这部分内容，由产品流程决定。

### 为什么流式重试以“是否已经交付增量”为界？

普通非流式重试中，失败时业务通常还没有拿到答案；流式调用一旦交付文字，用户已经看到了这次尝试的一部分。重新发送请求会从头生成，内容可能与前一次不同，也没有自动从断开位置接着写的约定。

当前提供显式重试的是同步入口：

```java
LlmResult result = gateway.oneByStreamWithRetry(
        call, delta -> System.out.print(delta),
        RetryPolicy.defaults(), new LlmCancelHandle());
```

默认 `BEFORE_FIRST_DELTA` 策略的含义是：

- **尚未向 onDelta 交付增量**：仍按错误分类、尝试次数和时间预算判断能否重试。
- **已经交付过增量**：默认停止重试，向调用方报告失败。

这里判断的是“是否向回调交付”，不会等浏览器确认已经显示。也不能把“没有输出到界面”推导成“服务端未处理过请求”；首段之前重试仍可能产生额外费用。

高级模式 `ALWAYS` 允许在已经交付后重试，但应用需要通过 `onAttemptDiscarded` 处理上一尝试的输出作废，例如清除旧内容，再接收重新生成的答案。它不是断点续传，旧内容清理失败也可能导致重复展示。

`oneByStreamWithRetry` 的方法本身同步等待，退避也在同步路径中执行。当前没有 `oneByStreamWithRetryAsync` 公共入口，不能把上一节异步重试的调度机制直接套在它身上。

### 模型已经在流式输出，为什么浏览器仍然一次性显示？

从供应商到 Java 服务的流式响应，与从 Java 服务到浏览器的增量交付，是两段连接：

`模型服务 → ai-lite 解析与 onDelta → 应用输出通道 → 浏览器消费与渲染`

ai-lite 负责前一段的模型调用与回调。应用还要把增量写入 SSE 或其他可增量消费的 HTTP 响应，浏览器也要边读边展示；如果应用先收集完再返回，或者中间层缓冲整个响应，用户仍会一次性看到全部文字。

接入时需要把两个生命周期连起来：浏览器断开或用户点击停止，应用应调用当前模型请求的取消句柄；模型完成、取消或失败时，应用也应结束或更新对应的浏览器输出状态。

使用 Spring MVC 的 `SseEmitter` 或直接返回 future 时，Servlet 与参与的过滤器都需要支持异步。排查方法见[异步支持说明](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/docs/guide-异步支持排查.md)。单纯调用网关并收到 onDelta，并不会替应用完成浏览器推送的接入。


## 5. 从网关走向编排：把多次调用组织成任务

模型可能需要查订单、检索资料或调用应用能力。先声明可用工具，模型返回工具名称和参数，由应用执行工具，再把结果作为消息交回模型。

<AiLiteFlow kind="tools" />

| 需求 | 选择 |
| --- | --- |
| 只发一轮，读取回答或工具请求 | `round` / `roundAsync` |
| 自动推进简单工具循环 | `toolLoop` / `toolLoopAsync` |
| 定义多轮 Agent 行为与生命周期处理 | `AgentLoop` |
| 按固定顺序执行多个步骤 | `Workflow` |

**这一层的设计：**模型负责提出工具请求，应用负责工具的实现和权限。工具声明本身不会让模型直接访问数据库或执行任意方法。

简单循环可以设轮数上限；复杂任务再使用 Agent 编排。工具会修改外部数据时，应用还要考虑重复执行的后果，不能把“一次模型调用可重试”推导为“整个业务任务可以安全重做”。

**继续阅读：[编排层：从固定步骤到 Agent 任务](./docs/orchestration)。** 从两步同步 Workflow 开始，逐步增加异步、步骤重试、生命周期与并行工具，每一步都有图解和代码。

> 实现：[Agent 与 Workflow 源码](https://github.com/yinwenyuan28-afk/ai-lite/tree/main/ai-lite-agent/src/main/java/io/github/yinwenyuan28/ailite/assembly)。

## 6. 会话与提示词：让下一次请求接着说

前面的调用都围绕一次执行。用户下一次发来消息时，需要恢复对话历史；提示词调整时，需要知道用了哪个版本。这两种状态由不同模块管理。

<AiLiteFlow kind="state" />

**会话运行时**加载历史、追加执行条目，并保存对话进度。可按需要组合内存、Redis、JDBC；上下文预算与自动压缩用于控制发给模型的历史大小，需要显式配置。

**提示词中心**管理草稿、发布、回滚、审计和占位符渲染。渲染后得到普通消息，再交给网关。已有自己的提示词平台时，也可以直接传入消息。

**这一层的设计：**对话历史解决“之前说了什么”，提示词版本解决“这次按哪套要求执行”。两者独立管理，存储实现也可以替换。

## 接下来按需求接入

| 你现在要做什么 | 从哪里开始 |
| --- | --- |
| 在现有项目跑通一句问答 | [快速开始](./docs/quickstart) |
| 把多次调用组织成固定流程或 Agent 任务 | [编排层图解](./docs/orchestration) |
| 了解职责、模块与线程模型 | [整体设计](./docs/overview) |
| 确认取消、重试和流式的边界 | [常见问题](./docs/faq) |

本页以 2026-11-17 本地源码核对结果为依据；安装版本与完整参数请结合[仓库 README](https://github.com/yinwenyuan28-afk/ai-lite)查看。
