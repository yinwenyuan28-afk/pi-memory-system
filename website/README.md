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

中文入口：`/projects/ai-lite/`。内容按同步 → 异步 → 显式重试 → 流式 → 工具与多轮 → 会话与提示词递进，另有整体设计、快速开始和常见问题。

流程图由 `.vitepress/theme/AiLiteFlow.vue` 本地绘制，支持深浅色、小屏横向查看和文字说明。修改 API 示例、默认策略或线程模型时，应同时核对 ai-lite 源码；检查方式为 `npm run build` 和浏览器查看对应页面。英文页面保持独立维护。

讲解方案和验证记录见 [AI_LITE_WEBSITE_PLAN](../plan/pi-memory-system/AI_LITE_WEBSITE_PLAN.md)。
编排层入口：`/projects/ai-lite/docs/orchestration`，从固定步骤、异步顺序与步骤重试，逐步讲到 AgentLoop、七个生命周期时机、工具并行和 Spec/Assembly。新增六类流程图，例子与当前编排层源码核对。
NIO 网关入口：`/projects/ai-lite/docs/gateway-nio`。以 Jetty 为例，沿同步、异步、异步重试、流式 inline/io 递进，配五张独立线程图；中文侧栏中列为第二章，后续编号顺延。维护时按真实事件处理路径核对，不将 NIO 等同于同步入口不等待或所有回调固定在 selector 线程。