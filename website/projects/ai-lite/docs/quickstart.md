---
pageClass: ai-lite-guide
title: 快速开始
description: 用最小 YAML 配置与一次同步调用，把 ai-lite 接入现有 Spring Boot 工程。
---

# 快速开始

先在 **JDK 8+ / Spring Boot 2.1–2.7** 工程里跑通一句问答。本页选择 YAML 配置档模式，模型直接写在配置中，首次接入不需要数据库目录。

## 1. 引入 Starter

```xml
<dependency>
    <groupId>io.github.yinwenyuan28-afk</groupId>
    <artifactId>ai-lite-spring-boot-starter</artifactId>
    <version>0.1.15</version>
</dependency>
```

这里的版本来自 2026-11-17 核对的本地仓库。升级时请查看[仓库 README](https://github.com/yinwenyuan28-afk/ai-lite)和[变更记录](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/CHANGELOG.md)，并核对目标环境兼容性。

## 2. 配置供应商、模型和业务 id

在运行环境设置 `AI_LITE_BASE_URL`、`AI_LITE_API_KEY`、`AI_LITE_MODEL`。下面以 OpenAI Completions 兼容协议为例，base URL 通常写到 `/v1`，不要再拼接 `/chat/completions`。

```yaml
ai-lite:
  llm:
    biz-ids: [intro]
    providers:
      primary:
        api: openai-completions
        base-url: ${AI_LITE_BASE_URL}
        api-key: ${AI_LITE_API_KEY}
        models:
          - id: ${AI_LITE_MODEL}
            reasoning: false
            input: [text]
            max-tokens: 4096
    profiles:
      main:
        provider: primary
        model: ${AI_LITE_MODEL}
        thinking-level: "off"
```

`intro` 是登记的业务 id，`primary` 是供应商配置名，`main` 是模型配置档。它们是应用自己取的名称；模型 id 要填供应商实际提供的值，模型能力也应与配置一致。

密钥通过环境变量提供，不写入代码仓库。`"off"` 保留引号，避免 YAML 将其当作布尔值。

## 3. 注入网关，发起调用

```java
import io.github.yinwenyuan28.ailite.llm.LlmCall;
import io.github.yinwenyuan28.ailite.llm.LlmGateway;
import io.github.yinwenyuan28.ailite.llm.LlmMessage;
import io.github.yinwenyuan28.ailite.llm.LlmResult;
import org.springframework.stereotype.Service;
import java.util.Collections;

/** 用途：通过配置档调用模型；由 Spring 注入网关，供业务服务复用。 */
@Service
public class IntroService {
    private final LlmGateway gateway;

    /** 接收自动装配的网关；构造可供调用的业务服务。 */
    public IntroService(LlmGateway gateway) {
        this.gateway = gateway;
    }

    /** 接收用户问题，执行一次同步模型调用，返回完整回答文本。 */
    public String ask(String question) {
        LlmCall call = LlmCall.profile("intro", "main",
                Collections.singletonList(LlmMessage.user(question)));
        LlmResult result = gateway.one(call);
        return result.getContent();
    }
}
```

从现有业务代码调用 `introService.ask("用一句话介绍你自己")` 即可验证。该方法同步等待完整结果；超时、密钥错误或网络故障会使调用失败，应由应用处理。

## 4. 保留输入，替换调用方式

| 下一步需求 | 调用入口 |
| --- | --- |
| 等待期间释放调用线程 | `gateway.oneAsync(call)` |
| 瞬时失败时显式重试 | `gateway.oneWithRetryAsync(call, policy)` |
| 边生成边处理文本 | `gateway.oneByStreamAsync(call, onDelta, cancel)` |

图解与代码见[从一次调用开始](../)。异步参数校验仍可能同步抛出异常；收到 future 后，也要处理其异常完成。

## 什么时候再引入目录和数据库？

当你需要在运行时管理“业务使用哪个模型”，再引入 `ai-lite-admin-api` 等模块，并按仓库说明配置数据源、提示词存储、调用记录与 SQL 表。

启用目录模式后，`LlmCall.biz("intro", messages)` 会读取运行时绑定；没有绑定就失败，不会退回 YAML 默认配置档。未启用目录时，`biz` 可以使用 YAML 的 `default-profile`；本页没有设置该字段，所以用 `profile` 显式选择 `main`。

完整安装、目录装配与配置项见[仓库 README](https://github.com/yinwenyuan28-afk/ai-lite)和[配置参考](https://github.com/yinwenyuan28-afk/ai-lite/blob/main/docs/ref-配置.md)。
