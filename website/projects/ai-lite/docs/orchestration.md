---
pageClass: ai-lite-guide
title: 编排层：把多次调用组织成任务
description: 从 Workflow 同步顺序、异步步骤与重试，逐步理解 AgentLoop、生命周期、工具并行和业务封装。
outline: [2, 2]
---

# 编排层，把多次调用组织成任务

[网关层](../)解决一次模型请求怎么发、怎么等、怎么交付结果。编排层继续回答：一次任务要调用几次模型、什么时候执行工具、哪一步失败后停止。

这一页沿用一个任务：**读一段文档，提炼要点，再补充需要的资料**。先把步骤写定，再把“下一步做什么”交给模型。示例沿用[快速开始](./quickstart)的 `intro` 业务 id 与 `main` 配置档。

| 你能否提前写定步骤 | 从哪里开始 |
| --- | --- |
| 能，例如提炼要点后再生成关键词 | Workflow |
| 不能，需要模型决定查什么、还要不要继续查 | AgentLoop |
| 已有一段固定流程，也有需要灵活查资料的部分 | 在应用的 Assembly 中组合两者 |

## 1. Workflow：先把两次调用按顺序排好

最初只想得到要点和关键词，可以把两个模型调用排成步骤。前一步完成，下一步才开始，最后按步骤顺序返回结果列表。

<AiLiteFlow kind="workflow" />

```java
// 示例片段使用 assembly.*、llm.*、java.util.* 中的类型。
// CompletableFuture 来自 java.util.concurrent。
// 输入是待处理文档；两个步骤各自读取同一份原文。
String source = "ai-lite 面向现有 Java 服务，提供模型网关与编排能力。";
LlmCall points = LlmCall.profile("intro", "main",
        Collections.singletonList(LlmMessage.user("提炼要点：" + source)));
LlmCall keywords = LlmCall.profile("intro", "main",
        Collections.singletonList(LlmMessage.user("提取关键词：" + source)));

Workflow workflow = new Workflow(gateway);
List<LlmResult> results = workflow.run(Arrays.asList(
        Workflow.oneStep(points),
        Workflow.oneStep(keywords)));
```

**这一步增加的是执行顺序。**`results.get(0)` 对应要点，`results.get(1)` 对应关键词。两个步骤在创建时已有自己的输入，Workflow 不会自动把第一个结果塞进第二个请求。

当第二步确实依赖第一步时，把数据传递明确写出来。例如先提炼要点，再只根据要点生成关键词：

```java
// 用途：接收原文，先生成要点，再据此生成关键词，返回关键词文本。
WorkflowSpec<String, String> digest = (wf, text) -> {
    LlmCall first = LlmCall.profile("intro", "main",
            Collections.singletonList(LlmMessage.user("提炼要点：" + text)));
    String summary = wf.one(first).getContent();

    LlmCall second = LlmCall.profile("intro", "main",
            Collections.singletonList(LlmMessage.user("从这些要点提取关键词：" + summary)));
    return wf.one(second).getContent();
};
String output = digest.run(workflow, source);
```

这里的 `WorkflowSpec` 是普通 Java 接口，用来封装输入与输出。它的函数体由应用编写，异常也按应用代码传播；下文关于步骤序号与已完成结果的说明，针对 `workflow.run` / `runAsync` 的步骤列表。

> 实现：[Workflow](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-agent/src/main/java/io/github/yinwenyuan28/ailite/assembly/Workflow.java) 的 `run`、`oneStep`；[WorkflowSpec](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-agent/src/main/java/io/github/yinwenyuan28/ailite/assembly/WorkflowSpec.java)。

## 2. 异步 Workflow：等待方式变了，顺序没变

把同步步骤换成 `AsyncStep`，再使用 `runAsync`。业务先拿到整体 future；步骤一完成后，才会发起步骤二。

<AiLiteFlow kind="workflowAsync" />

```java
CompletableFuture<List<LlmResult>> future =
        workflow.runAsync(Arrays.asList(
                Workflow.oneStepAsync(points),
                Workflow.oneStepAsync(keywords)));

future.thenAccept(results ->
        System.out.println(results.get(1).getContent()));
```

**这一步增加的是异步等待。**两个步骤不会同时执行；底层 HTTP 的线程占用仍取决于所选传输，和网关异步调用的规则一致。

同步和异步步骤有不同类型。若确实需要把一个 `SyncStep` 放入异步列表，可显式使用 `Workflow.adapt(step)`；这只是把阻塞工作交给执行器，并没有把阻塞代码变成非阻塞 I/O。自定义 `AsyncStep` 应快速返回 future。

## 3. 给某一步加重试，把失败限制在该步

假设提炼要点已成功，提取关键词时遇到短暂网络错误。可以只为第二步启用显式重试，成功后再完成整个 Workflow。

```java
RetryPolicy policy = RetryPolicy.builder()
        .maxAttempts(3) // 包含首次尝试。
        .build();

CompletableFuture<List<LlmResult>> future =
        workflow.runAsync(Arrays.asList(
                Workflow.oneStepAsync(points),
                Workflow.oneStepWithRetryAsync(keywords, policy)));
```

**这一步增加的是步骤自己的失败处理。**Workflow 不自动重试全部步骤。策略仍遵守网关的错误分类、退避和取消规则，详见[网关重试](../#_3-异步重试-偶发失败-按规则再试)。

| 执行中发生什么 | 后续行为 |
| --- | --- |
| 某步抛出异常或返回空结果 | 停止后续步骤，产生 `WorkflowStepException` |
| 通过取消句柄取消，或某步结果为 `ABORTED` | 停止后续步骤，产生 `WorkflowCancelledException` |
| 前面已有步骤完成 | 异常保留 `getCompletedResults()`，便于定位 |
| 要知道失败或取消发生在哪里 | 查看 `getStepIndex()`，序号从 0 开始 |

异步执行时，步骤失败通过 future 的异常完成表达；直接调用 `future.cancel(true)` 则保留 JDK 的 cancelled 语义，不包装为 `WorkflowCancelledException`。输入结构不合法可能在返回 future 前直接抛出。已完成结果用于诊断，并不提供自动续跑、事务回滚或外部修改撤销。

Workflow 的步骤列表只接受对应的步骤类型，不能直接放入一个 AgentLoop。需要组合两者时，由应用的业务封装显式调用。

## 4. AgentLoop：当下一步无法提前写定

任务变成“读文档，遇到不清楚的地方就查资料，直到能解释清楚”。需要查几次、查什么，执行前无法完全确定，适合使用 AgentLoop。

<AiLiteFlow kind="agent" />

AgentLoop 每轮只向网关发一次 `round` 请求。模型如果提出工具请求，应用执行工具，工具结果追加到本次上下文，再交给下一轮。默认没有工具请求时结束；生命周期也可以要求停止或再来一轮。

```java
AgentLoop agent = new AgentLoop(gateway);
LlmCall research = LlmCall.profile("intro", "main",
        Collections.singletonList(LlmMessage.user(
                "阅读文档，按需查资料解释要点：" + source)));
// tools 是应用已定义的 List<LlmTool>；工具实现由 ToolExecutor 提供。
LlmCancelHandle cancel = new LlmCancelHandle();

LlmResult result = agent.run(
        research, tools, Collections.emptyList(), 8, cancel);
System.out.println(result.getContent());
```

`tools` 不是只填工具名称就能使用的能力：需要定义模型可见的参数声明，并向工具执行器提供对应实现。工具的访问权限与参数校验由应用负责。

**这一步增加的是循环决策与上下文管理。**默认最多 8 轮模型调用，也可以像示例一样显式设置。当已经到最后一轮而模型仍请求工具时，该批工具不再执行，结果停止原因为 `MAX_ROUNDS`。

这里一轮是“一次模型响应及其允许执行的工具处理”，不是“执行一个工具”。同一轮可以提出多个工具请求。收到 `ERROR` 或 `ABORTED` 时，也不会因为结果中带工具请求就继续执行工具。

> 实现：[AgentLoop](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-agent/src/main/java/io/github/yinwenyuan28/ailite/assembly/AgentLoop.java) 的 `run`、`decideToolPhase` 与循环推进逻辑。

## 5. 生命周期：在关键步骤加入业务规则

工具循环有了以后，通常还需要控制“哪些工具允许执行”“工具结果交给模型前要不要处理”“什么时候结束”。`AgentLifecycle` 提供七个介入时机，多个实现按传入顺序执行。

<AiLiteFlow kind="lifecycle" />

| 时机 | 在什么时候运行 | 可以做什么 |
| --- | --- | --- |
| `beforeRun` | 整个循环开始，仅一次 | 准备消息，调整本次可用工具 |
| `beforeModel` | 每次模型请求前 | 调整本轮消息与工具 |
| `afterModel` | 模型返回、工具尚未执行 | 处理助手正文 |
| `beforeTool` | 每个工具执行前 | 校验参数、替换参数或拒绝执行 |
| `afterTool` | 每个工具执行后 | 修改交给模型的结果文本 |
| `afterTurn` | 本轮工具处理结束后 | 停止、继续，或交给模型决定 |
| `afterRun` | 整次运行停止后 | 观察最终结果或失败原因 |

例如，本任务只读资料，应拒绝具有写入作用的 `write_document` 工具：

```java
AgentLifecycle readOnly = new AgentLifecycle() {
    /** 接收本次工具请求；拒绝写入工具，其他工具按现有名单执行。 */
    @Override
    public ToolDecision beforeTool(AgentLoopContext ctx, AgentToolCall call) {
        if ("write_document".equals(call.getName())) {
            return ToolDecision.deny("当前任务只允许读取资料");
        }
        return ToolDecision.allow();
    }
};

LlmResult result = agent.run(research, tools,
        Collections.singletonList(readOnly), 8, new LlmCancelHandle());
```

示例只是按名称限制一个工具，实际权限规则应由应用补全。`deny` 会跳过执行，并把拒绝原因作为工具结果交给后续模型；它本身不会立即终止整个任务。

**这一步增加的是业务控制点。**拦截有副作用的工具应放在 `beforeTool`；`afterTurn` 在工具处理后才运行，此时要求停止无法撤销已经执行的操作。

多个 `afterTurn` 决策中，任一个要求停止就停止；没有停止且有人要求继续，才继续。默认交给模型决定。只有 `beforeRun` 成功完成后，运行的正常、取消和异常路径才保证 `afterRun` 执行一次；它是观察方法，抛出的异常只记录，不覆盖已确定结果。

> 实现：[AgentLifecycle](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-agent/src/main/java/io/github/yinwenyuan28/ailite/assembly/AgentLifecycle.java)、[ToolDecision](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-agent/src/main/java/io/github/yinwenyuan28/ailite/assembly/ToolDecision.java)。

## 6. 工具并行：缩短一批独立查询的等待

如果模型同一轮既要查术语解释，又要查配置说明，这两个只读查询可以独立执行。AgentLoop 默认串行，按需要选择 `PARALLEL`。

<AiLiteFlow kind="parallelTools" />

```java
// toolPool 是应用管理的 Executor；toolExecutor 是已有工具执行器。
AgentLoop parallelAgent = new AgentLoop(
        gateway, null, toolExecutor,
        AgentLoop.ToolRunMode.PARALLEL, toolPool);
```

**这一步增加的是同批工具的并发执行。**先按顺序运行各工具的 `beforeTool`，再并发执行允许的工具；完成后按模型原始顺序执行 `afterTool` 并写入上下文。即使 B 比 A 先返回，消息顺序仍为 A、B。

并行模式不会把不同模型轮次同时运行，也不表示存在多 Agent 协作。工具存在写入依赖时，应由应用选择合适的执行方式，避免并发修改冲突。

## 7. 再选择异步、超时、取消和流式

固定步骤和 Agent 循环解决“任务如何推进”，异步与流式决定“调用方如何等待、内容如何交付”。

```java
// 用途：异步执行本任务，最多 8 轮，并设置超时取消预算。
LlmCancelHandle runCancel = new LlmCancelHandle();
CompletableFuture<LlmResult> future = agent.runAsync(
        research, tools, Collections.singletonList(readOnly),
        8, runCancel, 30000L);

// 用户主动中止时，由应用调用 runCancel.cancel()。
```

带 `timeoutMs` 的异步重载会在超时到点后触发取消，覆盖模型轮次与工具执行；按取消路径返回 `ABORTED`。它与网关重试的 `totalDeadlineMs` 不同，后者主要决定是否继续安排下一次尝试。

超时取消通过协作停止运行，不保证能强制终止不响应取消的业务工具，也无法撤销已经发生的外部修改。每次运行使用独立取消句柄，取消后的句柄不能当作全新句柄复用。

::: tip 生命周期方法也要避免长时间阻塞
异步入口可能在调用线程或传输完成线程推进。生命周期里不要直接运行耗时阻塞工作；需要隔离时使用对应的回调执行策略。当前超时计时任务在异步运行启动后安排，也不能把它当作任意用户方法的强制中断器。
:::

需要逐段显示 Agent 生成内容时，使用当前提供的**同步流式**入口：

```java
LlmResult result = agent.runStream(
        research, tools, Collections.singletonList(readOnly),
        8, new LlmCancelHandle(),
        (round, kind, text) -> {
            if (kind == DeltaKind.CONTENT) {
                System.out.print(text);
            }
        });
```

回调携带轮次、增量类型与文本，在调用线程执行，方法等整次运行结束才返回。增量可能来自不同轮次或不同内容类型，生产界面应按 `round` / `kind` 区分展示；示例只演示接收方式。

| 入口 | 等待方式 | 内容交付 |
| --- | --- | --- |
| `run` | 同步等待 | 最终结果 |
| `runAsync` | future | 最终结果 |
| `runStream` | 同步等待 | 增量回调 + 最终结果 |

当前没有 `runStreamAsync` 公共入口。把同步流式放到线程池只会改变阻塞发生的位置，不能把它解释为原生异步流式。

## 8. 最后用 Spec 与 Assembly 封装业务

流程稳定后，把它整理成业务输入和输出，不必让 Controller 到处处理模型消息、工具名单和生命周期列表。

<AiLiteFlow kind="assembly" />

| 接口 | 接收什么 | 用来组织什么 |
| --- | --- | --- |
| `WorkflowSpec<I, O>` | Workflow 与业务输入 | 固定顺序、数据传递和结果转换 |
| `AgentSpec<I, O>` | AgentLoop 与业务输入 | 工具、生命周期和循环参数 |
| `Assembly<I, O>` | 业务输入 | 组合上述能力，对外返回业务结果 |

```java
// 用途：接收关键词，使用本任务的工具与只读规则，返回模型解释。
AgentSpec<String, String> explanationSpec = (loop, keywordsText) -> {
    LlmCall call = LlmCall.profile("intro", "main",
            Collections.singletonList(
                    LlmMessage.user("按需查阅资料，解释这些关键词：" + keywordsText)));
    return loop.run(call, tools, Collections.singletonList(readOnly),
            8, new LlmCancelHandle()).getContent();
};

// 用途：接收原文，先执行固定流程，再执行资料解释任务，返回业务结果。
Assembly<String, String> documentExplainer = text -> {
    String keywordsText = digest.run(workflow, text);
    return explanationSpec.run(agent, keywordsText);
};
String explanation = documentExplainer.run(source);
```


这些都是普通 Java 接口。`Assembly` 可以在应用代码里先调用一个 WorkflowSpec，再调用一个 AgentSpec；它不会自动创建执行图、注册后台任务、保存进度或提供断点恢复。

**这一层的设计：**网关处理一次请求，Workflow 处理固定顺序，AgentLoop 处理模型参与的循环，Spec 与 Assembly 保留业务自己的输入输出。跨请求历史再交给[Session 的持久化](./session-persistence)，一次 AgentLoop 的上下文不会自动成为长期保存的会话。

[继续阅读 Session 的持久化](./session-persistence) · [回到整体设计](./overview) · [查看接入配置](./quickstart) · [调用边界与常见问题](./faq)

本页于 2026-11-17 对照当前本地 `Workflow`、`AgentLoop`、生命周期接口和相应测试核对。
