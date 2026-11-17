---
pageClass: ai-lite-guide
title: Provider 与运行时配置
description: 从 Provider、Model 和 Profile 开始，理解业务绑定、配置覆盖、缓存刷新与一次调用的模型选择。
outline: [2, 3]
---

# Provider 与运行时配置

> 给谁：已经能调用模型，希望知道请求如何选中模型、管理页修改何时生效的 Java 开发者。  
> 一句话：Provider 定义服务端点，Profile 选择 YAML 中的模型组合，运行时目录让业务 id 通过数据库绑定选择模型。  
> 范围：请求怎样等待见网关章节，供应商并发与密钥冷却见[限流熔断机制](./rate-limit-circuit)。  
> 核对：2026-11-17，ModelResolver、LlmGateway、JdbcRuntimeCatalog、自动配置与解析测试。

## 1. 先看三个名称：服务、模型、配置档

沿用[快速开始](./quickstart)：`primary` 是应用给供应商端点起的名称，模型 id 是供应商实际接受的模型名称，`main` 是应用为常用组合起的配置档名。它们不能互相代替。

| 配置 | 回答什么问题 | 主要内容 |
| --- | --- | --- |
| Provider，供应商端点 | 请求发到哪里、用什么协议和凭证？ | `api`、`base-url`、密钥、超时、公共请求参数 |
| Model，模型 | 该端点下调用哪个模型、按什么能力构造请求？ | 模型 id、输入类型、推理能力、上下文窗口、输出上限 |
| Profile，配置档 | 业务常用哪一套组合？ | provider id、模型 id、思考档 |

<AiLiteFlow kind="providerProfile" />

### 1.1 协议与 HTTP 客户端分别配置

Provider 的 `api` 决定请求体、路径和响应格式；`ai-lite.http.transport` 决定使用 OkHttp、Jetty 等哪种 HTTP 客户端。切换 Jetty 不需要把 OpenAI 兼容协议改成别的协议。

| `api` | 自动追加的路径 | `base-url` 示例形态 |
| --- | --- | --- |
| `openai-completions` | `/chat/completions` | 服务根地址通常到 `/v1` |
| `openai-responses` | `/responses` | 服务根地址通常到 `/v1` |
| `anthropic-messages` | `/v1/messages` | 服务根地址不要再带 `/v1` |

模型的 `input: [text, image]`、`reasoning` 和 `context-window` 是应用声明的能力参数，不会仅凭这些字段自动探测远端是否支持。声明需要与实际模型一致；上下文窗口未知时，会影响会话预算检查与自动压缩。

> 实现依据：`ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/config/AiLiteConfig.java` 的 `Provider/Model/Profile`，以及同模块 `transport/` 中的协议实现。

## 2. 先用 YAML：业务显式选择 Profile

最小配置已经在快速开始给出。这里保留已有 `primary` 的地址、密钥与模型，只看选择关系：

```yaml
ai-lite:
  llm:
    biz-ids: [intro]
    profiles:
      main:
        provider: primary
        model: ${AI_LITE_MODEL}
        thinking-level: "off"
```

```java
// 用途：按 main 配置档选模型；消息是本次用户输入。
List<LlmMessage> messages = Collections.singletonList(
        LlmMessage.user("用一句话介绍你自己"));
LlmCall call = LlmCall.profile("intro", "main", messages);
LlmResult result = gateway.one(call);
```

Profile 保存的是模型选择，不包含会话历史、工具实现或系统提示词。`intro` 仍须登记在 `ai-lite.llm.biz-ids`，用于网关调用检查与业务归属；业务登记不等同于模型绑定。

### 2.1 三种调用方式到底读哪里？

| 调用方式 | 运行时目录未启用 | 运行时目录已启用 |
| --- | --- | --- |
| `LlmCall.profile(bizId, profile, messages)` | 读 YAML 的指定 Profile | 仍读 YAML 的指定 Profile |
| `LlmCall.explicit(bizId, provider, model, level, messages)` | 读 YAML 的指定 Provider 与模型 | 普通业务入口仍读 YAML，不自动套用目录覆盖 |
| `LlmCall.biz(bizId, messages)` | 使用 YAML 的 `default-profile`；没配则失败 | 读取该业务的数据库绑定；缺绑定或模型未就绪则失败 |

如果只使用 YAML，又希望业务调用不写 Profile 名，可以在 `ai-lite.llm` 下设置 `default-profile: main`。它只参与未启用目录时的无显式模型调用。**目录启用后，缺少业务绑定不会退回默认 Profile。**

管理页的模型测试是另一条入口，可以显式请求使用目录里的模型参数；不要根据管理页测试结果推断普通 `LlmCall.explicit` 也会读取相同覆盖。

> 实现依据：[LlmGateway](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/LlmGateway.java) 的 `resolve`，以及 `ModelResolver.resolveProfile/resolveExplicit/resolveBiz`。`ModelResolverCatalogTest` 覆盖目录开启后 Profile 仍读 YAML、缺少绑定不回退。

## 3. 再引入运行时目录：代码固定业务 id，模型选择交给绑定

希望在管理侧切换某个业务使用的模型时，业务可以只传 `intro`，目录记录 `intro → primary → 某个模型 → 思考档`。调整绑定后，后续读取新配置的调用就能选到另一个模型，业务代码不必修改模型 id。

<AiLiteFlow kind="providerRuntime" />

```java
// 用途：模型选择来自运行时业务绑定；该业务和模型必须已完成配置。
LlmCall call = LlmCall.biz("intro", messages);
LlmResult result = gateway.one(call);
```

### 3.1 内置 JDBC 目录需要哪些条件？

在已有 Starter 工程中加入 `ai-lite-admin-api` 与 `ai-lite-prompt-jdbc`，版本与 Starter 一致；当前核对版本为 0.1.15。提供数据源和 `JdbcTemplate`，提前执行目录及提示词模块的建表 SQL。

| 前置项 | 作用 |
| --- | --- |
| YAML 的 `providers` 与 `biz-ids` | 登记允许使用的供应商和业务 id |
| `ai-lite-admin-api` | 提供 JDBC 目录与管理接口 |
| `ai-lite-prompt-jdbc` 及其 `JdbcPromptStore` | 满足内置目录对提示词持久存储的装配要求 |
| [目录 SQL](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-admin-api/src/main/resources/ai-lite-catalog.sql) | 供应商覆盖、模型、业务绑定及管理设置表 |
| [提示词 SQL](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/ai-lite-prompt-jdbc/src/main/resources/ai-lite-prompt.sql) | 提示词版本与当前发布指针等表 |

这不是加一个 `catalog.enabled: true` 就完成的配置。当前内置装配会检查 JDBC 提示词存储与表是否存在，缺少条件可能使应用启动失败；任意自定义 `PromptStore` 也不等同于满足该实现的装配检查。

目录启用后，YAML 可以不列模型，模型改由目录管理；但保留的 YAML Profile 仍必须指向 YAML 中确实存在的模型。管理 REST 默认关闭，需要单独设置 `ai-lite.admin.enabled: true`；可选页面还需 `ai-lite-admin-ui` 与 `ai-lite.admin.page-enabled: true`。关闭管理页面或管理接口，不会因此关闭已装配的运行时目录。

### 3.2 模型列表里有一行，为什么仍不能调用？

目录里的模型需要显式启用 `READY`，业务也必须有有效绑定。保存能力参数不等于开启 READY，开启 READY 也不证明参数已经正确或远端已经验证成功。管理侧启用动作会检查数据库模型行的能力字段，不能因为同名 YAML 模型有值，就认为数据库留空也一定能启用。

供应商 id 仍须先在 YAML 登记，数据库覆盖不能单独创建一个可调用的新供应商。业务 id 在目录模式下还会用作提示词 key，需要符合提示词编码规则。

> 实现依据：`ai-lite-admin-api/src/main/java/io/github/yinwenyuan28/ailite/admin/jdbc/AiLiteCatalogAutoConfiguration.java` 与 `CatalogBizIds.java` 检查装配和业务编码；`ModelResolver.resolveBiz` 检查绑定、供应商与模型 READY。

## 4. 深入配置：先确定来源，再处理同名字段

运行时目录不是把所有 YAML 一次性替换掉。先按调用方式选择配置来源，再逐类处理未填写的值、整份 Map 替换和请求参数合并，才能判断真正发送的内容。

### 4.1 模型字段：数据库没填时，沿用同名 YAML 模型

以 `context-window`、`max-tokens`、推理能力和模型请求参数为例：目录字段有值就用目录；未填写时查找同一 Provider 下的同名 YAML 模型；两边都没有才使用内置默认值。数据库里新建、YAML 中不存在的模型也可使用，但必须正确填写能力参数。

模型输出上限未配置时通常为 8192；上下文窗口未配置时为未知，而不是自动取得供应商实际窗口。思考档还会按推理能力与档位映射调整，不保证业务请求的档位原样发给模型。

### 4.2 NULL 与空 Map，分别表示沿用和清空

供应商覆盖可替换协议、地址、单密钥、连接与读取超时。配置了 `api-keys` 密钥池时，数据库的单密钥覆盖不会替代该池；轮换与冷却见前一章。

数据库里的 Provider `headers/extra-body` 为 NULL，表示沿用 YAML 的这一整份值；非 NULL 时使用数据库那份 Map，空 Map 表示清空。模型级的请求参数 Map 也有类似规则：**没有填写**与**明确写了空对象**不是同一件事。

例如 YAML Provider 有 `X-Team` 和 `X-Region` 两个请求头，数据库覆盖只保存 `X-Team`，替换后不会自动保留 YAML 的 `X-Region`。这是选择来源时的整份替换。

### 4.3 Provider、Model、单次调用之间怎样合并？

来源确定以后，Provider 和 Model 才一起组成有效配置：

| 字段 | 合并或覆盖规则 |
| --- | --- |
| 自定义 `headers` | Provider 在前、Model 在后，同名头忽略大小写，Model 覆盖 |
| `extra-body` | Provider → Model → 本次调用；嵌套对象按子键递归合并，后者覆盖同名值 |
| 采样参数 | 模型默认值，再套用生效思考档对应的参数 |
| 本次调用的超时、正数 `maxTokens` | 覆盖对应的供应商超时或模型输出上限 |

例如附加请求体依次提供下面三份值，最终保留三个子字段：

```text
Provider: {"options": {"a": 1, "b": 2}}
Model:    {"options": {"b": 3}}
Call:     {"options": {"c": 4}}
结果:     {"options": {"a": 1, "b": 3, "c": 4}}
```

单次覆盖可以这样写；变量 `call` 是上面创建的本次请求：

```java
// 用途：只调整本次请求，不修改 Provider 或模型的长期配置。
call.timeouts(10000, 180000).maxTokens(1024);
call.extraBody(Collections.singletonMap("options",
        Collections.singletonMap("c", 4)));
```

`extra-body` 最后进入协议请求体，能覆盖协议层已构造的同名字段；它不是任意参数都能安全通用的校验接口，应只放实际供应商支持的字段。`headers` 里的 `Authorization` 与 `Content-Type` 则由库管理，不应通过自定义头配置。

> 实现依据：`ModelResolver.applyOverlay/toConfigModel/resolve/deepMerge`，以及 `ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/transport/TransportSupport.java`。`LlmRequest.effectiveMaxTokens` 与协议实现应用单次调用覆盖。

## 5. 修改之后：什么时候新调用能读到新配置？

JDBC 目录把模型、业务绑定与供应商覆盖缓存为当前节点的快照，默认缓存 5 秒。管理接口通过目录方法保存后会清除本机快照；其他节点没有收到主动推送，要在各自缓存过期后重读数据库。

<AiLiteFlow kind="providerRefresh" />

```yaml
ai-lite:
  catalog:
    cache-seconds: 5
```

`cache-seconds` 小于等于 0 时不使用这层缓存，每次目录读取都会查库。直接执行 SQL 修改数据库不会主动清除任何节点的缓存；需要等待过期，或通过 `RuntimeCatalog.invalidate()` 清当前实例缓存。这个开关只控制目录缓存，不是整个应用 YAML 的热加载开关。重新读库失败会传播异常，没有承诺用过期快照继续执行。

### 5.1 已在执行的调用会被切换模型吗？

一次网关调用在入口解析模型，内部执行继续使用已取得的解析结果；管理侧修改不会直接替换正在执行的请求。后续独立调用会重新解析，显式重试每一次重新发起调用时也会再次解析，因此不能承诺整个业务任务始终固定在同一份配置上。

修改 application.yml 本身也不等于自动更新运行中的配置对象；当前没有通用的文件监听与全量配置热加载承诺。运行时管理只覆盖目录支持的字段，Provider 并发数、HTTP 传输选择等启动装配项不要按同样方式理解。

### 5.2 多节点写入与多节点刷新，是两件事

`ai-lite.catalog.multi-node` 默认 false，添加模型时使用进程内锁做重复检查。多实例同时添加相同模型时，应按实现要求设置为 true 并提供 `StringRedisTemplate`，否则应用启动失败。这个锁用于减少同一 Provider、同一模型的重复添加，不会广播清除各节点缓存，也不负责分布式模型调用限流。

> 实现依据：`JdbcRuntimeCatalog.snapshot/invalidate`、`AiLiteCatalogProperties.cacheSeconds` 与 `AiLiteCatalogAutoConfiguration.resolveModelKeyLock`。缓存失效范围与配置值应以当前部署版本为准。

### 5.3 保存失败会保留旧配置吗？

供应商覆盖与业务绑定的保存包含多条 SQL。能取得合适的事务管理器时，这些语句在事务内执行，后续插入失败可以回滚前面的删除；没有事务管理器，或多个事务管理器无法确定采用哪个时，当前实现仍允许逐条提交，不能承诺整次修改全部成功或全部撤销。应用应为目录 JDBC 操作配置正确的事务管理器。

## 6. 怎样确认本次调用选中了什么？

排查时先看业务实际用了 `profile`、`explicit` 还是 `biz`，再检查它对应的数据来源。只修改数据库绑定而继续调用 `profile`，结果保持 YAML 选择是预期行为。

```java
// 用途：只查看模型解析结果；不发模型 HTTP 请求，不占并发许可。
ResolvedModel selected = gateway.resolveFor(call);
String provider = selected.getProvider();
String model = selected.getModelId();
String endpoint = selected.getBaseUrl();
```

这里检查的是模型解析结果，不替代正式调用中的业务登记、消息校验或远端连通性验证；单次 `timeouts/maxTokens/extraBody` 还会在请求构造时应用。不要输出完整解析对象或 API key。

| 现象 | 先检查什么 |
| --- | --- |
| “业务 id 未登记” | `ai-lite.llm.biz-ids` 是否包含实际业务 id |
| “业务未配置模型” | 目录模式下是否存在该业务绑定 |
| “模型未就绪” | 绑定指向的目录模型是否存在并已启用 READY |
| 管理侧改了模型，业务仍用旧模型 | 调用选择方式、当前节点缓存及请求是否已经开始 |
| 字段丢失或与 YAML 不同 | 是否先发生 Map 整份替换，再参与模型/调用级合并 |

更多接入与调用边界见[常见问题](./faq)。