---
pageClass: ai-lite-guide
title: 限流熔断机制
description: 从供应商并发保护开始，理解同步等待、异步排队、熔断恢复、重试、多密钥与运行指标。
outline: [2, 3]
---

# 限流熔断机制

> 给谁：已经接入模型，准备让多个用户或任务同时调用的 Java 开发者。  
> 一句话：网关在 HTTP 调用前限制供应商并发，异常集中出现时暂时拒绝新请求，再用一次探测判断是否恢复。  
> 范围：重试和 HTTP 线程的完整时间线见[默认网关](../)与 [NIO 网关](./gateway-nio)。  
> 核对：2026-11-17，ProviderGuard、LlmGateway、自动配置及相关测试。

## 1. 先限制并发：最多同时发出多少次模型调用？

假设一个供应商最多允许 8 次模型调用同时进行。前 8 次拿到许可后发请求，第 9 次先等待；有调用结束并归还许可，第 9 次才有机会继续。等待超过时限，或异步队列已满，就返回过载错误。

**当前“限流”控制并发数量和排队容量。**它没有 QPS（每秒请求数）、RPM（每分钟请求数）或 TPM（每分钟 token 数）限速算法。请求很快完成时，同样的并发上限也可能发出很多请求。

<AiLiteFlow kind="guardAdmission" />

### 1.1 保护按供应商共享，不按用户或 API key 分开

网关解析出 provider id 后，查找它对应的 `ProviderGuard`。同一 provider 下的模型、配置档、业务 id 和多把 API key 共享许可与熔断状态；不同 provider 分开计算。

这些状态保存在当前 JVM 中。部署三个应用实例，每个都配置并发 8，不能把它当作三个实例合计只有 8；当前没有 Redis 共享许可或分布式熔断实现。

> 实现依据：`ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/LlmGateway.java` 的 `guardFor` 按 provider 查找；同模块 `guard/ProviderGuard.java` 持有许可计数与状态。

## 2. 接入配置：先给现有供应商加保护

将下面片段**合并到快速开始的已有配置**，保留 `primary` 原有协议、地址、密钥、模型与配置档。示例并发设为 8，显式开启熔断；其他数字是当前默认值。

```yaml
ai-lite:
  llm:
    providers:
      primary:
        guard:
          concurrency: 8
  guard:
    concurrency-wait-ms: 2000
    async-queue-capacity: 100
    key-cooldown-seconds: 60
    circuit:
      enabled: true
      failure-rate: 50
      window-seconds: 60
      minimum-calls: 20
      open-seconds: 30
      probe-timeout-ms: 30000
```

| 配置 | 作用与默认行为 |
| --- | --- |
| `providers.<id>.guard.concurrency` | 当前供应商并发许可数；默认 0，不限并发 |
| `guard.concurrency-wait-ms` | 满额后的同步等待或异步排队时限；默认 2000ms，≤0 表示不等待 |
| `guard.async-queue-capacity` | 异步等待者的数量上限；默认 100，不限制同步等待线程数 |
| `guard.circuit.enabled` | 是否开启全局熔断；默认 false |
| `guard.key-cooldown-seconds` | 失败密钥的冷却期；默认 60 秒，详见第 5 节 |

默认既不限并发，也不开熔断时，网关不为该 provider 创建保护实例，直接进入传输。只开启全局熔断时，已配置的各 provider 都可获得熔断保护，未设置并发上限的仍不限并发。

> 实现依据：`ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/config/AiLiteConfig.java` 的 `Provider.GuardCfg`、`Guard` 与 `Guard.Circuit`；`ai-lite-spring-boot-starter/src/main/java/io/github/yinwenyuan28/ailite/autoconfigure/AiLiteAutoConfiguration.java` 的 `buildProviderGuards`。

## 3. 深入并发：等待名额和等待网络，是两个阶段

获得许可之前没有发出本轮 HTTP 请求。获得许可之后，默认 OkHttp 或 Jetty 才各自执行网络操作；换成 NIO 能改变网络等待方式，并不会增加配置中的并发名额。

### 3.1 同步等待会占调用线程，异步排队只保存状态

| 入口 | 并发满时的行为 | 超过限制 |
| --- | --- | --- |
| 同步调用 | 当前调用线程等待可用许可，最长为配置时限 | 抛 `OVERLOAD` |
| 异步调用 | 把等待回调与时限加入有界队列，调用方取得 future | future 异常完成为 `OVERLOAD` |
| 已熔断的调用 | 不进入本轮传输 | `CIRCUIT_OPEN` |

有空位时，异步快速路径也可能在当前调用线程立即发起后续动作；“异步”不表示每一步都另开线程。排过队的等待者取得许可后，续执行动作会提交到 `executor.io()`。异步队列内部按先入先出交接；同步与异步共享许可池，但没有两类等待者合计严格先入先出的保证。

### 3.2 ★ 线程模型：业务线程返回后，谁等许可、谁发请求？

图中假设并发已满，一条旧请求正在执行。中间列是等待记录，不是一条被占住的工作线程。旧请求归还许可后，续执行器才发起新请求；网络阶段以默认 OkHttp 为例。

<AiLiteFlow kind="guardQueueThreads" />

星标沿用网关章节的含义：此小节有详细线程模型图。Jetty 的后半段对应 [NIO 异步线程图](./gateway-nio#_2-异步-等待连接就绪-共享线程处理事件)，排队机制相同。

### 3.3 一个许可管到哪里？

许可粒度是一次模型传输。Agent 每一轮重新申请，工具执行期间不占名额；重试每一次尝试也重新申请，退避期间不占名额。

流式会一直占到这一轮的传输 future 完成。开启 `io` 增量回调后，HTTP 传输可能先结束、许可先归还，而已入队的用户回调还在继续，所以整体业务 future 未完成不能直接等同于仍占模型传输名额。

异步取消会归还该轮许可，避免不响应取消的第三方传输把名额永久占住；这不保证第三方实际网络连接已经停止。归还时还会跳过取消或超时的等待者，并重新检查熔断状态。

> 实现依据：`ProviderGuard.acquireSync/acquireAsync/transferOrReturnLocked`，以及 `LlmGateway.AsyncRun` 的 `next/startRound/abandonInFlightPermit`。`LlmGatewayGuardTest` 覆盖异步排队不阻塞提交线程、工具阶段释放许可和不配合取消的传输。

## 4. 再加熔断：连续出现瞬时失败时，先暂停请求

并发限制回答“同时做多少”，熔断回答“现在是否还适合继续请求”。默认参数下，近似 60 秒窗口内至少有 20 个样本，并且失败率达到或超过 50%，才会打开熔断。

<AiLiteFlow kind="guardCircuit" />

### 4.1 三个状态分别怎么放行？

| 状态 | 新请求的行为 | 什么时候离开 |
| --- | --- | --- |
| `CLOSED`，正常放行 | 继续受并发许可限制；记录完成的传输结局 | 样本数与失败率同时达到阈值后进入 OPEN |
| `OPEN`，暂停放行 | 返回 `CIRCUIT_OPEN`，不发 HTTP | 默认冷却 30 秒后，下一次准入检查触发单次探测 |
| `HALF_OPEN`，半开探测 | 只允许一条探测，其他请求仍拒绝 | 未出现计为失败的结局则恢复 CLOSED；失败则重新 OPEN |

恢复 CLOSED 时清空旧窗口。统计采用 6 片环形滑动窗口，默认每片约 10 秒，是近似窗口，不是为每个请求保存精确时间戳。

### 4.2 什么错误计入失败率？

熔断使用默认重试错误分类；它不根据应用自定义重试策略随意改变口径。

| 计为失败 | 传输结局被采样时，不计失败 |
| --- | --- |
| `TRANSPORT` 传输错误 | `PARSE`、`CONFIG`、取消等其他类别 |
| HTTP 408、429、500、502、503、504 | HTTP 400、401 及不在左列的状态 |
| `UNKNOWN`，且原因链包含 `IOException` | 其他未知错误 |

发送前校验失败、排队中取消等未形成传输结局的路径，不会因此增加样本。异步取消归还许可也不保证同时采样。

本地保护直接拒绝的 `OVERLOAD` 与 `CIRCUIT_OPEN` 没有发传输，不向窗口追加样本。否则拒绝越多，失败率反而越高，就无法正常恢复。

半开探测也沿用这份分类：例如 HTTP 401 不属于这里的瞬时失败，不能将“恢复 CLOSED”解读为凭证正确或业务已经成功。

### 4.3 探测超时不是强制中断 HTTP

`probe-timeout-ms` 默认 30000ms。超过时限后，后续准入检查会把未归来的探测视作失败，重新进入 OPEN；没有专门的定时任务在这一刻强制停止 HTTP。网络操作仍要依赖 HTTP 超时或取消机制结束。

> 实现依据：`ProviderGuard.admitCircuitLocked/sampleLocked/RoundPermit.verdict` 和 `RetryPolicy.defaultRetryable`；`LlmGatewayCircuitTest` 覆盖供应商隔离、解析错误不触发熔断及本地拒绝不采样。

## 5. 与重试、多密钥配合：各自解决哪一段问题？

重试负责本次失败后是否再试；并发限制负责每次尝试能否开始；熔断负责该供应商是否暂停放行。实际发出的每次尝试分别采样，最终重试 future 不是只算一个样本。

### 5.1 过载和熔断默认不再试

默认重试策略不重试 `OVERLOAD` 或 `CIRCUIT_OPEN`，所以显式调用带重试入口，也不会默认向本地保护连续重试。应用收到这些错误后，应降低提交量、延后任务或向用户说明稍后再试，而不是立刻无限重发。

### 5.2 多把 key 是失败后换用，不是成功后轮询

供应商配置 `api-keys` 后，HTTP 429 或 401 可以把当前 key 标记为冷却，后续模型解析改选其他未冷却 key；成功调用不会推进游标。当前失败不会因换 key 自动变成功，是否再试仍看重试策略。401 默认不重试，因此通常影响下一次独立调用。

所有 key 都在冷却时，当前实现会再使用第一把 key，并非停止全部请求等待冷却。多把 key 仍共享 provider 的熔断与并发名额，不能绕过已经打开的供应商熔断。

> 实现依据：`LlmGateway.markKeyFailure`、`ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/config/ModelResolver.java` 的 `pickKey/markKeyFailure`，以及 `ModelResolverKeyRotationTest`。

## 6. 如何确认保护正在生效？

先区分本地保护拒绝与远端 HTTP 429。前者没有发请求，后者已经到达供应商并被远端拒绝；处理方式和指标含义不同。

项目引入 Micrometer 且容器有 `MeterRegistry` 时，Starter 可以挂接以下指标。Micrometer 是 Java 的指标采集接口，实际展示由应用已有的监控系统完成。

| 指标 | 含义 |
| --- | --- |
| `ailite.llm.guard.rejected` | 本地拒绝数，按 provider 与 `reason=concurrency/circuit` 区分 |
| `ailite.llm.guard.circuit-state` | 熔断状态：0 正常、1 打开、2 半开 |
| `ailite.llm.guard.rate-limited` | 传输返回 HTTP 429 的次数 |

未建立保护实例的 provider 不经过这些采样；状态指标也不保证应用启动即出现，而是在状态变化时注册。指标不以密钥原文作为标签。

阅读到这里，可以按一个顺序排查：是本地容量满了、供应商熔断了，还是远端真正返回了错误；然后再检查排队时限、错误分类与重试配置。接着阅读 [Provider 与运行时配置](./provider-runtime)，理解供应商、模型选择与运行时业务绑定。其他调用边界见[常见问题](./faq)。