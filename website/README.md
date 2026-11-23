# Pi Memory 网站设计原型

使用 VitePress、Vue 3、Element Plus 和 Lucide，包含中英文首页，以及安装、记忆原理、配置、日常管理、恢复和数据说明。

- 设计说明：[设计方案](./设计方案.md)
- 文档来源、取舍与源码核验：[文档内容梳理](./文档内容梳理.md)（维护资料，不发布到网站）
- 本地启动：`npm install` 后执行 `npm run dev`
- 地址：`http://127.0.0.1:5188/`，英文首页 `/en/`
- 构建：`npm run build`
- 构建预览：`npm run preview`

这是本地设计原型。交互中的项目记录是标注过的示例，不连接真实记忆数据库。视频、封面和产品图标在启动与构建前从仓库 `assets/` 同步，生成副本不纳入版本控制。

## ai-lite 图解介绍

中文入口：`/projects/ai-lite/`。中文侧栏按快速开始 → 整体设计 → 默认网关 → NIO 网关 → 编排层 → Session 的持久化 → 限流熔断机制 → Provider 与运行时配置 → 常见问题阅读。网关正文仍沿同步 → 异步 → 显式重试 → 流式逐步深入，已有 URL 与线程图锚点保留。

流程图由 `.vitepress/theme/AiLiteFlow.vue` 本地绘制，支持深浅色、小屏横向查看和文字说明。修改 API 示例、默认策略或线程模型时，应同时核对 ai-lite 源码；检查方式为 `npm run build` 和浏览器查看对应页面。英文页面保持独立维护。

讲解方案和验证记录见 [AI_LITE_WEBSITE_PLAN](../plan/pi-memory-system/AI_LITE_WEBSITE_PLAN.md)。
编排层入口：`/projects/ai-lite/docs/orchestration`，从固定步骤、异步顺序与步骤重试，逐步讲到 AgentLoop、七个生命周期时机、工具并行和 Spec/Assembly。新增六类流程图，例子与当前编排层源码核对。
NIO 网关入口：`/projects/ai-lite/docs/gateway-nio`。以 Jetty 为例，沿同步、异步、异步重试、流式 inline/io 递进，配五张独立线程图；中文侧栏中列为第四章。维护时按真实事件处理路径核对，不将 NIO 等同于同步入口不等待或所有回调固定在 selector 线程。
Session 持久化入口：`/projects/ai-lite/docs/session-persistence`。讲解默认内存、JDBC 主存储、Redis 快照缓存、版本冲突、最终保存及压缩租约边界，配恢复、缓存和版本竞争三张图。

限流熔断入口：`/projects/ai-lite/docs/rate-limit-circuit`。讲解供应商级并发、异步排队、熔断三态、重试和多 key；配准入、排队线程与状态图。当前保护是单 JVM 的并发限制，没有 QPS/RPM/TPM 配额实现。

Provider 与运行时配置入口：`/projects/ai-lite/docs/provider-runtime`，位于限流熔断后、FAQ前。按Provider/Model/Profile、运行时业务绑定、字段来源与合并、缓存刷新和诊断递进，配三张关系与生效流程图；核对目录装配、READY、NULL与空Map、事务及跨节点更新边界。

## Agent 站点地图

- 远程内容地图：[public/llms.txt](./public/llms.txt)，对外路径 `/llms.txt`，包含全站中英文入口及 ai-lite 九章阅读顺序。新增或调整页面后同步维护。
- 仓库维护地图：[agent-content/site-map.md](./agent-content/site-map.md)，标明页面、导航、组件、图示、源码核验和构建位置；该目录不发布为文档页面。
- `npm run build` 在生成 HTML 后复制中英文 docs 与 projects 到内部 Markdown 资源目录。生产 Worker 支持相同页面 URL 的 `Accept: text/markdown`；本地 VitePress dev/preview 不运行 Worker。内部 `/_markdown/` 路径不作为公开链接。

## AgentCenter 首屏背景

`/projects/agentcenter/` 与英文对应页面在首屏用静态网络图做背景：右侧圆环主节点、直线连到各 Agent 图标，相邻射线之间交替浅/深色块。组件为 `.vitepress/theme/AgentCenterNetwork.vue`。这是概念示意，实际能力以支持的 Agent 文档为准。修改后执行 `npm run build` 并检查中英文与深浅色页面。
