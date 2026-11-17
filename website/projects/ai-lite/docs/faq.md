---
pageClass: ai-lite-guide
title: 常见问题
description: 异步、重试、流式、取消和配置档的常见边界。
---

# 常见问题

## 异步以后，就不占线程了吗？

调用线程可以释放，底层网络是否占线程取决于 HTTP 客户端。默认 OkHttp 每个在途请求仍占 Dispatcher 线程，流式会占到结束。Jetty NIO 等传输可改变网络等待的线程模型，见[整体设计](./overview#线程与传输)。

## 普通调用会自动重试吗？

`one` 和 `oneAsync` 只尝试一次。使用 `oneWithRetry` 或 `oneWithRetryAsync` 才启用显式重试。`maxAttempts(3)` 表示总共最多尝试三次，含第一次。

默认策略不限制重试时间预算。`totalDeadlineMs` 在开始尝试、失败和退避时控制是否继续重试，但不会主动中断在途请求；请求超时仍由连接与读取超时控制，即使成功发生在预算到期之后也可能正常返回。它不是严格的端到端超时。

## 取消句柄和 future.cancel 有什么区别？

`LlmCancelHandle.cancel()` 会向传输层传播取消，结果 future 正常完成并携带 `ABORTED` 状态。处理结果时需要检查状态。

`future.cancel(true)` 保留 JDK 的取消语义，也向当前底层请求传播取消。重试过程取消后，不再安排新的尝试。

取消不能保证供应商撤销已经完成的处理，也不能撤销业务工具已经产生的外部修改。

## 流式和异步有什么区别？

流式决定何时交付内容：生成过程中多次交付增量。异步决定调用方如何等待：先返回 future，稍后完成。

因此同步流式也成立。`oneByStream` 会回调增量，但方法本身等到结束才返回；`oneByStreamAsync` 则先返回 future。

## 流式断开以后可以直接重试吗？

`oneByStreamAsync` 不自动重试。同步 `oneByStreamWithRetry` 默认只在首个增量交付前重试；交付之后重新请求会导致文字重复或前后不一致，默认禁止重试。

高级策略允许调用方处理内容作废再重新输出，但必须同时处理界面已有文字。不要只在外层循环重调方法。

## final 结果和 onDelta 都要显示吗？

`onDelta` 用于逐段展示；最终 `LlmResult` 用于获取完整内容、完成状态与用量。已经追加增量时，不要把完整内容再追加一遍。

## 返回 future 给 Spring MVC 还需要配置吗？

需要确认 Servlet 和参与请求的每个过滤器都支持异步。Controller 返回 `CompletableFuture` 或 `SseEmitter` 会使用 Servlet 异步机制；仅使用 ai-lite 的回调并不等于已经配置好浏览器推送。

排查步骤见[异步支持说明](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/docs/guide-异步支持排查.md)。

## 为什么配置了模型，biz 调用仍然失败？

启用运行时目录时，`LlmCall.biz` 需要目录中的业务绑定；没有绑定不会回退 YAML。未启用目录时，它可以使用 YAML 的 `default-profile`；只写模型列表而未设置该字段仍然不足。首次接入可以按[快速开始](./quickstart)使用 `LlmCall.profile` 显式选择配置档，并先在 `biz-ids` 登记业务 id。

Profile 与业务绑定的路径对照、管理侧配置的生效时机，见 [Provider 与运行时配置](./provider-runtime)。

## AgentLoop 是否支持异步流式？

当前要分别看待三种能力：同步执行 `run`、异步执行 `runAsync`、同步流式执行 `runStream`。不能因为单次网关有 `oneByStreamAsync`，就推导出 AgentLoop 也有相同的异步流式接口。

固定步骤、Agent 循环、生命周期和运行边界，详见[编排层图解](./orchestration)。

## 会话是否就是长期记忆？

这里的会话用于恢复 Java 服务中的一次对话历史。它与 [Pi Memory](/docs/memory) 的项目长期记忆有不同职责，不能把两者视为同一套存储。

本页于 2026-11-17 对照本地 `LlmGateway`、`RetryPolicy`、`AgentLoop` 与传输实现核对。
