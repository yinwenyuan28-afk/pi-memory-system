---
pageClass: ai-lite-guide
title: Session 的持久化
description: 从一次续聊开始，理解会话恢复、JDBC 持久化、Redis 缓存、版本冲突与历史压缩。
outline: [2, 3]
---

# Session 的持久化

> 给谁：已经跑通网关或 Agent，希望下一次请求接着聊的 Java 开发者。  
> 一句话：Session 保存跨请求的历史，AgentSessionLoop 负责恢复、执行和保存，存储实现决定这些历史能否跨进程保留。  
> 范围：模型与工具如何多轮执行见[编排层](./orchestration)。  
> 核对：2026-11-17，AgentSessionLoop、JDBC/Redis 模块及会话并发测试。

## 1. 先续聊：本次请求不必重新拼全部历史

同一个用户带着同一个会话 id 再次提问，运行时先加载历史，把本次新消息接上，再交给 AgentLoop。Agent 可能执行多轮模型与工具，结束后才统一保存本轮收集到的条目。

<AiLiteFlow kind="sessionResume" />

下面是业务方法中的片段，沿用[快速开始](./quickstart)的配置。由 Spring 注入 `AgentSessionLoop sessionLoop`，类型来自 `session.*`、`llm.*` 与 `java.util.Collections`。

```java
// 用途：为已认证用户创建会话；已有会话原样保留。
sessionLoop.ensureSession(userId, sessionId, "intro");
LlmCall call = LlmCall.profile("intro", "main", Collections.emptyList());

// 新消息从 newUserTurns 传入，运行时会把它与已保存的历史组合。
AgentSessionLoop.ResumeResult turn = sessionLoop.resume(
        userId, sessionId, call,
        ResumeOptions.builder()
                .newUserTurns(Collections.singletonList(
                        AgentSessionMessage.user("继续解释刚才的例子")))
                .build());
String answer = turn.getResult().getContent();
AgentSession saved = turn.getSession();
```

**这一步已经能跨请求续聊，但默认仍在内存里。**Starter 默认开启会话，最多保存 10000 个会话，保存后有效期为 604800 秒（七天）。超出容量时淘汰更新时间最早的会话；进程重启后这些历史丢失。

### 1.1 会话身份与本轮输入分别放在哪里？

存储用 `userId + sessionId` 定位会话；`bizId` 记录业务信息，不增加一层数据隔离，也不替应用做鉴权。应用应从认证结果取得用户身份，并检查当前用户能否操作该会话。

`resume` 要求会话已存在，所以先调用 `ensureSession`。传入的 `call.messages` 会被会话投影与 `newUserTurns` 替换；只把本次输入放进 `call.messages`，不能完成这里期待的追加操作。

> 实现依据：`ai-lite-agent/src/main/java/io/github/yinwenyuan28/ailite/session/AgentSessionLoop.java` 的 `ensureSession`、`prepare` 与 `finish` 分别处理创建、输入组合与最终保存。

## 2. 换成 JDBC：应用重启后仍能恢复历史

持久化时保持续聊 API 不变，只替换 `AgentSessionStore`。加入 JDBC 模块、提供数据源和 `JdbcTemplate`，并提前建好会话表，自动配置就会优先使用 JDBC 存储。

```xml
<dependency>
    <groupId>io.github.yinwenyuan28-afk</groupId>
    <artifactId>ai-lite-session-jdbc</artifactId>
    <version>0.1.15</version>
</dependency>
```

1. 按[模块 SQL](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-session-jdbc/src/main/resources/ai-lite-session.sql)建表；根据数据库调整 CLOB 等字段类型。模块不会自动执行建表。
2. 在现有 Spring Boot 工程中配置数据源、数据库驱动与 `JdbcTemplate`。
3. 启动后确认实际的 `AgentSessionStore` 为 `JdbcAgentSessionStore`。只加依赖而没有 `JdbcTemplate`，仍可能使用默认内存存储。

默认表名为 `AI_LITE_SESSION`。如需修改，配置与实际 SQL 必须一致；表名只允许字母、数字和下划线：

```yaml
ai-lite:
  session:
    jdbc:
      table-name: MY_AGENT_SESSION
```

应用自己提供的 `AgentSessionStore` 会优先使用。全局 `ai-lite.enabled` 或 `ai-lite.session.enabled` 关闭时，不会按以上路径自动装配。

### 2.1 数据库保存的是条目历史，发送给模型的是投影

一行保存一个会话，主键为 `USER_ID + SESSION_ID`。这里的“投影”指从持久条目中选取、组合本轮要发给模型的消息。

| 数据 | 用途 |
| --- | --- |
| `MESSAGES_JSON` | 完整条目流：消息、压缩摘要、用量和会话信息 |
| `VERSION` | 判断读出快照后，是否已有别的请求保存过 |
| `TITLE / MESSAGE_COUNT / TOTAL_TOKENS` | 会话列表和用量摘要 |
| `UPDATED_AT` | 最近更新时间 |
| `COMPACTION_LEASE_UNTIL` | 压缩租约的到期时间，用于减少重复摘要调用 |

持久历史与模型上下文是两份不同用途的数据。保存完整历史，不代表每轮都会原样发送所有条目。JDBC 记录不沿用内存存储的 TTL 和容量限制，清理与保留时间由应用安排。

> 实现依据：[JDBC 自动配置](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-session-jdbc/src/main/java/io/github/yinwenyuan28/ailite/session/jdbc/AiLiteSessionJdbcAutoConfiguration.java)验证装配条件；同目录 `JdbcAgentSessionStore.java` 与模块 SQL 定义实际保存内容。

## 3. 加 Redis：减少读取，不改变数据库的版本校验

`ai-lite-session-redis` 提供 `SessionCache`，保存会话快照缓存。它没有自动装配成 Redis 主存储；需要应用显式把它与持久存储组合。

<AiLiteFlow kind="sessionCache" />

下面是 Spring 配置方法中的构造片段。`jdbcTemplate` 和 `redisTemplate` 分别为现有的 `JdbcTemplate` 与 `StringRedisTemplate`；另需加入 `ai-lite-session-redis` 依赖，版本与 Starter 一致。该方法返回组合后的存储 bean 即可覆盖默认存储。

```java
// 用途：JDBC 负责持久化与版本校验，Redis 缓存会话快照七天。
AgentSessionStore durable =
        new JdbcAgentSessionStore(jdbcTemplate, "AI_LITE_SESSION");
SessionCache cache =
        new RedisSessionCache(redisTemplate, "ai-lite:session:", false);
return new CachingAgentSessionStore(durable, cache, 604800L);
```

读缓存未命中或发生异常时，组合存储继续查数据库；保存则先写数据库，成功才更新缓存。缓存更新失败会尝试删除旧缓存，记录日志后继续；数据库保存失败仍会使本次续聊失败。

### 3.1 缓存命中不等于锁住会话

缓存中的快照可能落后于数据库中的最新版本。最终能否保存，仍由数据库中的版本决定；Redis 不负责合并同时发生的两次续聊。缓存 TTL 只控制缓存保留多久，不会删除数据库记录。

`RedisSessionCache` 单独使用且 `requireRedis=true` 时，会因 Redis 不可用而抛错；经过 `CachingAgentSessionStore` 包装后，缓存异常会被包装器捕获。判断业务是否失败，要看实际使用哪一层。

> 实现依据：`ai-lite-agent/src/main/java/io/github/yinwenyuan28/ailite/session/CachingAgentSessionStore.java` 的 `find/save`，以及 `ai-lite-session-redis/src/main/java/io/github/yinwenyuan28/ailite/session/redis/RedisSessionCache.java`。

## 4. 深入保存时机：历史不会静默覆盖，工具操作也不会自动撤销

内存和 JDBC 存储都检查版本。A、B 同时读到版本 7，A 先保存后数据库变为版本 8；B 再用版本 7 保存会报告冲突，保留 A 已保存的内容。

<AiLiteFlow kind="sessionVersion" />

### 4.1 发生版本冲突以后该怎么办？

冲突发生在保存阶段，此时两次请求可能都已经调用模型，甚至执行了工具。存储不会自动合并历史，也不会自动重跑任务。应用可以让同一会话的请求按顺序执行，或者在冲突后重新加载并向用户说明；涉及有副作用的工具时，要先判断能否重复执行。

### 4.2 成功、取消和保存失败有什么区别？

| 本轮情况 | 会话保存行为 |
| --- | --- |
| Agent 返回且停止原因不是 `ABORTED` | `finish` 统一保存，再返回结果与会话 |
| 模型或运行过程抛出异常 | 不进入最终保存 |
| 返回 `ABORTED` | 保留取消结果，跳过保存 |
| 数据库写入失败或版本冲突 | 续聊报告失败，不能宣称历史已保存 |

`resumeAsync` 将会话加载、准备与最终保存放到注入的 I/O 执行器，模型部分由 `AgentLoop.runAsync` 推进。模型结束后、保存尚未执行时取消 future，可以阻止这一保存步骤；取消不能保证撤销已经开始的数据库写入、工具操作或模型费用。当前异步续聊拒绝 `deltaListener`，同步 `resume` 才支持该流式选项。

> 实现依据：`AgentSessionLoop.finish` 检查停止原因；`ai-lite-agent/src/test/java/io/github/yinwenyuan28/ailite/session/AgentSessionLoopAsyncTest.java` 覆盖指定执行器、保存前取消和并发版本冲突。

## 5. 历史变长以后：保留原文，缩短模型看到的上下文

启用压缩时，运行时可以追加一条摘要及保留历史的起点，再按“系统前缀 + 摘要 + 保留的近期消息”构造本轮上下文。原始消息仍在条目流中，关闭压缩后可以重新按完整历史投影；数据库体积不会因为生成摘要就自动减小。

摘要先追加到本次加载的会话快照，最终随 `finish` 一起保存。当前实现没有在准备阶段单独保存摘要；本轮取消跳过最终保存时，不能把该摘要说成已经持久化。

### 5.1 压缩租约控制什么？

内存与 JDBC 实现压缩租约，用于减少多个请求同时为同一段历史生成摘要；它不串行化整个会话执行，也不替代版本检查。

当前 `CachingAgentSessionStore` 没有向底层存储委托租约方法，组合 JDBC 与 Redis 后会使用接口默认行为。需要跨节点减少重复压缩时，应核对实际存储包装器是否支持该委托，不能只根据底层是 JDBC 判断。

> 实现依据：`AgentSessionLoop.projectEntries`、`ai-lite-agent/src/main/java/io/github/yinwenyuan28/ailite/internal/session/SessionCompactor.java` 与 `AgentSessionStore` 的默认租约方法。

接着阅读[限流熔断机制](./rate-limit-circuit)，理解多用户、多轮调用如何共享供应商的并发容量。