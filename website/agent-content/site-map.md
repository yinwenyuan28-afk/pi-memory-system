# 网站维护地图（供 coding agent 使用）

> 给谁：在这个仓库修改网站内容、导航、图示或部署行为的 coding agent。  
> 一句话：先按下表定位源文件，再核对真实实现，最后验证页面与 Markdown 导出。  
> 范围：远程阅读网站的 agent 使用公开地图 [llms.txt](../public/llms.txt)；本文件不发布到网站。  
> 核对：2026-11-17，VitePress 配置、主题、构建脚本、Worker 与当前页面树。

## 1. 先按任务找源文件

以下路径相对 `website/`。页面正文以 Markdown 为源，构建目录是生成物。

| 要改什么 | 从哪里看 | 相关文件 |
| --- | --- | --- |
| 网站标题、语言、搜索、全站主导航与侧栏接入 | `.vitepress/config.mts` | 中文、英文分别配置；项目侧栏由 projects.ts 提供 |
| 项目元数据、介绍卡片、项目文档侧栏和前后篇 | `.vitepress/projects.ts` | 中文 ai-lite 的九章顺序在 projectSidebars 中显式声明 |
| Pi Memory 首页 | `.vitepress/theme/MemoryHome.vue` | `index.md`、`en/index.md`、`agent-content/zh-home.md`、`agent-content/en-home.md` |
| Pi Memory 文档 | `docs/*.md`、`en/docs/*.md` | 两种语言独立维护 |
| 项目集合页与项目介绍组件 | `projects/index.md`、`.vitepress/theme/ProjectCatalog.vue` | 项目介绍由 ProjectLanding.vue 渲染，卡片由 ProjectCards.vue 渲染 |
| ai-lite 中文讲解 | `projects/ai-lite/index.md`、`projects/ai-lite/docs/*.md` | 详细阅读顺序见下节 |
| ai-lite 英文介绍 | `en/projects/ai-lite/` | 当前只有独立概览、快速开始与 FAQ，不能假定中文新增章已有翻译 |
| 其他项目介绍与说明 | `projects/agentcenter/`、`projects/cursor-encoding-fix/` | 英文在 `en/projects/` 对应目录 |
| ai-lite SVG 流程与线程图 | `.vitepress/theme/AiLiteFlow.vue` | 按 kind 选择图；标题、描述、节点、箭头都在本组件 |
| ai-lite 局部样式 | `.vitepress/theme/ai-lite-docs.css` | pageClass 为 ai-lite-guide；主题注册见 index.ts |
| 远程 agent 的公开页面地图 | `public/llms.txt` | 新增、删改路由后同步更新；生产 URL 为 /llms.txt |
| 首页的纯文字等价内容 | `agent-content/zh-home.md`、`agent-content/en-home.md` | Vue 首页改功能说明时同步核对 |
| Markdown 资源导出 | `scripts/copy-markdown.mjs` | 复制首页等价内容、docs、projects 及中英文页面树 |
| 生产 Markdown 内容协商 | `worker.ts` | GET/HEAD 与 Accept: text/markdown；内部 /_markdown/ 禁止公开访问 |
| 静态媒体同步 | `scripts/sync-assets.mjs` | 从上级仓库 assets 复制，先读脚本再改 |
| 构建与部署入口 | `package.json`、`wrangler.jsonc` | 部署说明见上级 网站部署指南.md |

## 2. ai-lite 九章与文件对应

| 导航顺序 | 源文件（相对 projects/ai-lite/） | 讲解重点 |
| --- | --- | --- |
| 一、快速开始 | `docs/quickstart.md` | 最小配置与同步调用 |
| 二、整体设计 | `docs/overview.md` | 模块职责与可替换部件 |
| 三、网关层：从一次调用开始 | `index.md` | 默认 OkHttp，同步→异步→显式重试→流式 |
| 四、网关层：从一次调用开始（NIO） | `docs/gateway-nio.md` | Jetty 网络事件、回调与线程容量 |
| 五、编排层：从步骤到任务 | `docs/orchestration.md` | Workflow、AgentLoop、生命周期、并行工具 |
| 六、Session 的持久化 | `docs/session-persistence.md` | 加载、JDBC、Redis 缓存、版本、保存与压缩 |
| 七、限流熔断机制 | `docs/rate-limit-circuit.md` | 单进程供应商并发、排队、熔断、重试与多 key |
| 八、Provider 与运行时配置 | `docs/provider-runtime.md` | Provider/Model/Profile、业务绑定、字段合并与缓存生效 |
| 九、常见问题 | `docs/faq.md` | 入口选择与行为边界 |

路由通常为 `/projects/ai-lite/docs/<文件名>`；`index.md` 对应 `/projects/ai-lite/`。修改侧栏顺序不必移动文件或改变 URL。

### 2.1 修改内容前核对什么？

ai-lite 的实现位于独立仓库。当前机器的核验位置是 `C:/dev/code_java/MavenDependency/ai-lite-spring-boot-starter`，公开源码为 https://github.com/yinwenyuan28-afk/ai-lite 。本机路径是查源码入口，不是网站部署依赖。

| 主题 | 优先核对的实现位置（相对 ai-lite 仓库） |
| --- | --- |
| 网关、异步、重试与取消 | `ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/llm/` |
| HTTP 等待与流式处理 | `ai-lite-http-okhttp/`、`ai-lite-http-jetty/` |
| 编排与会话 | `ai-lite-agent/src/main/java/io/github/yinwenyuan28/ailite/assembly/`、`session/` |
| 会话主存储与缓存 | `ai-lite-session-jdbc/`、`ai-lite-session-redis/` |
| 并发与熔断 | `ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/guard/ProviderGuard.java` |
| Provider 与运行时目录 | `ai-lite-llm/src/main/java/io/github/yinwenyuan28/ailite/config/ModelResolver.java`、`ai-lite-admin-api/src/main/java/io/github/yinwenyuan28/ailite/admin/jdbc/` |
| 配置默认值与自动装配 | `AiLiteConfig.java`、Starter 的 `autoconfigure/` 与对应测试 |

先读当前源码，不将旧计划、旧文档或本文件的核验日期当作当前功能证明。功能文字需要同时写触发条件、执行者、结果和失败表现。

### 2.2 图示与标题约定

普通图沿箭头读，主步骤蓝色、结束绿色、等待或失败分支橙色、支撑能力灰色。线程图时间向下且不按比例，列标题写线程或状态的真实身份；等待记录、连接状态不能画成一条专属阻塞线程。

★ 只加在直接包含详细线程模型图的标题；三级标题使用所属主节的 3.1、3.2 等编号，并由 outline: [2, 3] 显示。已有标题使用自定义 id 保留旧锚点，改标题时保留这些 id。

## 3. 站点地图、网页与 Markdown 如何对应？

`public/llms.txt` 随 VitePress 原样进入构建产物，生产与本地都可直接读取。它列公开 URL 和简短用途，不包含本机路径、维护计划或私人数据。

构建结束后，`copy-markdown.mjs` 在 `.vitepress/dist/_markdown/` 生成正文副本。生产 Worker 根据 Accept 请求头选择 HTML 或 Markdown；本地 VitePress dev/preview 本身没有运行这个 Worker，因此请求头不会自动改变返回格式。测试内容协商时应直接测试 Worker，或运行对应部署环境。

带 Vue 自定义组件的 Markdown 可能保留组件标签。Agent 应结合邻近正文与表格阅读；不要假定文本导出会执行 Vue 或把 SVG 自动转成文字。项目集合页主要是组件入口，具体用途与下一页地址由 llms.txt 给出。

## 4. 改完如何检查？

1. 在 website 运行 `npm run build`，确认新增页面、链接与 Markdown 副本能生成。
2. 用已有本地服务检查对应页面、左右目录和前后篇；默认地址为 http://127.0.0.1:5188/ 。
3. 图或布局变更检查桌面、390px 小屏和深浅色。小屏由图自身横向滚动，不应扩大整页宽度。
4. 新增路由同时检查 llms.txt 和 `.vitepress/dist/_markdown/` 的对应文件。
5. Worker 或复制脚本变更，验证 GET/HEAD、Accept: text/markdown 与内部路径拒绝行为。

ai-lite 讲解的任务记录在上级 `plan/pi-memory-system/AI_LITE_WEBSITE_PLAN.md`。网站构建能验证页面生成，不等同于调用过真实模型或数据库。提交、部署与发布按用户本次授权执行。