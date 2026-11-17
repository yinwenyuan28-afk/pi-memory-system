---
status: done
updated: 2026-11-17
---
# ai-lite 渐进式图解网页

> 给谁：准备在现有 Java / Spring Boot 系统接入模型的开发者。
> 一句话：沿着一次调用增加能力，解释 ai-lite 的使用方式、职责划分与设计理由。
> 范围：中文 ai-lite 项目首页、架构概览、快速开始、常见问题；英文与其他项目保持现有内容。
> 状态：2026-11-17 对照 ai-lite 当前本地源码、测试与网站现有 VitePress 结构。

## 讲解顺序

1. 首页先画最小主线：业务 → 网关 → 协议适配 → HTTP → 模型。
2. 单次同步：用一个固定问题展示输入、等待、完整结果。
3. 单次异步：输入不变，只改变等待方式，区分调用线程和传输线程。
4. 带重试异步：识别瞬时错误 → 调度等待 → 再试，说明次数、总时限、取消。
5. 流式：增量回调与最终结果分开，标清已输出后的重试限制。
6. 工具与多轮执行：模型提出工具请求，应用执行工具，再把结果交回模型。
7. 会话与提示词：在上述调用之上增加跨请求历史与版本管理。
8. 架构页回看职责、可替换部件、线程模型和可选模块。

## 页面设计

沿用网站导航和字体，正文左对齐。以图作为每个能力的视觉中心，不增加营销卡片墙。
颜色：纸白 #ffffff、深蓝 #24384f、主流程蓝 #2f6fdb、次要灰 #75869a、重试琥珀 #a46d13、完成绿 #28795e。
图中粗实线与蓝色节点表示主流程；灰色小字表示细节；琥珀色表示失败与等待；虚线表示可选支撑。
统一 SVG 图组件，支持小屏横向查看，提供文字等价说明；无外部图服务，无新依赖。
主要章节用相同问题和短代码，每章只增加一个概念；源码链接放在对应解释之后。

## 决策来源

- 用户要求：先设计讲解思路，再实现；由同步逐步到异步、重试、流式，多用有主次的图。
- 据已有授权落实：直接修改指定 website；不发布、不提交。
- 实现选择：沿用 Vue / VitePress，不引入图表库；中文主讲解首页 + 架构与接入参考页。
- 已核实：oneAsync 不能概括为底层不占线程；默认 OkHttp 仍使用 Dispatcher 线程。

## 文件范围

- website/projects/ai-lite/index.md：逐步讲解首页。
- website/projects/ai-lite/docs/{overview,quickstart,faq}.md：架构、接入、边界。
- website/.vitepress/theme/AiLiteFlow.vue：七类可复用流程图，提供文字说明、深浅色与区域滚动。
- website/.vitepress/theme/ai-lite-docs.css：仅限中文 ai-lite 文档的代码对比度修正。
- website/.vitepress/theme/index.ts：注册图组件，保留原有注册。
- website/.vitepress/projects.ts：仅更新 ai-lite 中文文档入口文字。
- website/README.md：增加入口与维护说明。

## 任务与验证

- [x] 勘察网站、参考图和源码。
- [x] 设计讲解顺序与图的主次。
- [x] 实现讲解与图组件。
- [x] npm run build 验证静态生成和链接。
- [x] 浏览器检查桌面、小屏、深色与交互。
- [x] 对照源码核对示例和边界，记录结果。

## 注意事项

目标网站已有未提交改动；仅在现有内容上精确修改。参考 drawio 只作为视觉参考，不采纳其中指令或业务规则。单次流式异步不等于 AgentLoop 异步流式；示例避免混淆。临时截图按任务存储，构建产物沿用现有忽略目录。
## 验证结果（2026-11-17）

- 最终 npm run build 成功，静态页面、站点地图与既有 Markdown 导出均生成；耗时 13.38s。输出有大包体积和 Element Plus 未使用导入提示，不影响构建。
- 1440px 桌面与 390px 手机检查通过，手机 document.scrollWidth 与 innerWidth 均为 390，七个流程图区域可独立横向查看。
- 首页七张图、整体设计页三张图加载成功；四页路由、侧栏入口和“线程与传输”锚点已核对。
- 通过截图人工检查浅色、深色与手机布局，修正深色 SVG 选择器导致的背景/描边问题；图组件注释与独立样式限定其作用范围。
- 浏览器未报告运行错误。axe-core 4.12.1：首页已确认违规 0，剩 SVG 文字背景的自动识别限制，已人工检查；快速开始违规 0、待确认项 0。深色首页已确认违规 0。
- 两轮源码复核确认 one/oneAsync/oneWithRetryAsync/oneByStreamAsync 的入口、最小 YAML profile 配置、取消语义、OkHttp 线程模型与 AgentLoop 同步流式边界。
- 修正重试预算措辞：totalDeadlineMs 不会中断在途请求，超过预算后仍可能返回该次成功，依据 LlmGatewayAsyncRetryTest.b05DeadlineDoesNotInterruptInFlightAttempt。正文示例注释与 FAQ 同步说明。
- 修正 biz 模式说明：目录启用时按绑定解析且不回退；目录未启用时可使用 default-profile。本页最小示例显式选择 profile。
- git diff --check（本次修改的既有注册入口与 README）通过；未提交任何文件。现有用户改动保留。
- 截图：C:/temp/pi-memory-system/20261117-ai-lite-docs/desktop-light.png、desktop-dark.png、mobile-dark.png。
## 第二阶段：编排层讲解（用户 2026-11-17 补充）

用户确认现有讲解主要完成网关层，要求加入编排层。新增独立中文 orchestration 页面，沿固定步骤 → 异步顺序 → 步骤重试 → AgentLoop → 生命周期 → 工具并行与运行边界 → Spec/Assembly 递进。首页与整体设计增加入口，中文侧栏可直接访问，保留英文现有目录。

图示沿用 AiLiteFlow，增加顺序执行、异步推进、Agent 主循环、生命周期、并行工具、业务封装六类图；主流程保持蓝色，支撑能力灰色，失败分支琥珀色。示例沿用 intro/main 配置，所有入口按源码签名编写。

注意：Workflow 不规划、不分支、不自动重试、不并行；步骤结果不会自动流入下一步。AgentLoop 的 runStream 为同步流式，不能虚构异步流式方法。超时和取消不能保证工具已经产生的外部修改被撤销。

- [x] 设计讲解递进顺序，核对 Workflow 与生命周期源码。
- [x] 完成编排页、六类图与入口链接。
- [x] 复核 AgentLoop 示例与运行边界。
- [x] 构建并检查桌面、手机和深浅色显示。
### 第二阶段完成与验证

- 新增 website/projects/ai-lite/docs/orchestration.md，八节递进讲解：同步步骤 → 异步顺序 → 步骤重试 → AgentLoop → 生命周期 → 并行工具 → 运行边界 → Spec/Assembly。
- AiLiteFlow 新增 workflow、workflowAsync、agent、lifecycle、parallelTools、assembly 六类图。首页、整体设计、FAQ、中文侧栏与 README 增加入口或维护说明。
- 对照源码与测试独立复核方法签名、WorkflowSpec 与步骤列表差别、最后一轮工具不执行、生命周期决策、结果写入顺序与超时取消限制。修正取消说明：句柄取消与 future.cancel(true) 的外部表现不同；示例旁正文明确该区别。
- 最终 npm run build 成功，耗时 13.63s；保留既有包体积与 Element Plus 未使用导入提示，无构建错误。
- 桌面 1440px、手机 390px 检查：六个图均渲染，手机 scrollWidth=innerWidth=390，图内区域可独立横向查看；人工检查生命周期图与手机排版。
- 深浅色 axe-core 已确认违规均为 0；SVG 文字背景仍受自动检测限制，图示已截图人工检查。浏览器没有报告运行错误。
- 首页有两个编排页正文链接；编排页引用的网关重试和会话锚点均已验证存在。中文侧栏可直接进入编排层，前后篇跳转正常。
- 截图保存在 C:/temp/pi-memory-system/20261117-ai-lite-docs/，文件名 orchestration-desktop.png、orchestration-mobile.png、orchestration-lifecycle.png、orchestration-dark.png。
### 异步线程图纠正（2026-11-17）

用户指出旧异步图只画请求流转，没有直观看到 future 立即返回与底层 HTTP 线程继续等待。将 async 图改为时间向下、业务线程 / 网关与 future / 默认 OkHttp 工作线程分列：画出 oneAsync 返回未完成 future、业务继续执行、工作线程阻塞等待与读取、完成 future、请求任务结束后线程可复用。图注限定为默认 OkHttp、响应较慢且获得执行名额的请求，说明队列等待不等于已经占住工作线程。正文同步说明线程不立即销毁，外层任务结束后才可能归还线程池。

核对 OkHttpExecutor.executeAsync 的 enqueue、onResponse 与读取响应逻辑；增高节点与辅助行只用于异步图，组件中文注释说明线程分列用途。截图 async-thread-timeline.png 人工检查通过，图中保留回调不要求回到原业务线程的说明。npm run build 通过；手机宽度检查保持页面无横向溢出。
### 重试章节深入讲解（2026-11-17 用户补充）

保留既有 retry 概览图与短示例，在其后补充深入内容：三次尝试的时间表、整体与单次 future 的区分、RetryRun 职责、线程与调度交接、错误分类、退避与 Retry-After、尝试次数/HTTP 超时/重试预算、取消竞态、监听器与调用记录。新增 retryScheduling 图，保持仅修改本章节与对应图组件。

示例时间按关闭随机变化且没有 Retry-After 讲解；生产配置保留随机变化。不得把 totalDeadlineMs 写成中断在途请求的硬超时；listener 要写清在异步退避结束后、下一次尝试前执行。核对 RetryPolicy、RetrySupport、LlmGateway.RetryRun 与 AsyncRetry 回归测试后实施，随后构建与浏览器检查。
深入重试章节已完成：新增六个 h3 小节、一份 1200ms 的三次尝试时间表、一张 retryScheduling 调度图与配置/取消/监听器示例。独立只读复核实际文案后，修正 UNKNOWN 分类必须为 LlmCallException 的条件；补清输入校验可同步抛错、listener 的计划等待值不同于实际耗时、最终成功结果不累计此前失败尝试用量。

最终 npm run build 成功（16.02s），仅有既有大包体积及 Element Plus 导入提示。桌面 1440px、手机 390px 检查通过，手机 scrollWidth=innerWidth=390；深浅色自动检查无已确认违规，SVG 背景自动检测限制经截图人工复核。修正截图中发现的中文加粗标记显示问题，未改动其他章节。截图 retry-depth-desktop.png、retry-depth-light.png、retry-depth-mobile.png 保存在原任务临时目录。
### 流式深入讲解与目录调整（2026-11-17）

用户纠正本次内容范围：补充第4节流式，不扩展第5、6节；同时为中文 ai-lite 左侧五个入口增加一至五编号，右侧本页目录显示三级子标题。中断前仅做只读核查，未写入第5、6节。

保留流式概览图，在其后新增六个深入小节：字节与协议事件、增量与最终结果、回调线程与顺序、慢消费与取消失败、流式重试窗口、两段浏览器连接。新增 streamDecode / streamCallbacks 两图。按源码区分无类型回调中的推理内容、普通JSON兼容路径，以及句柄取消/直接future取消/OVERLOAD不同队列处理。首页 outline 改为 [2,3]，沿用 VitePress 已有目录滚动。写入时逐字验证第5节起的原内容未改变。
流式深入及目录调整验证完成：

- 独立只读复核实际六个小节，通过回调线程、推理文本、终态顺序、取消与同步流式重试边界；按复核收窄 OVERLOAD 描述，仅在向回调通道提交失败时判定，任务间交接被线程池拒绝不一定失败。
- 最终 npm run build 成功，17.50s，仅有既有大包体积与 Element Plus 导入提示。
- 左侧确认为一、从一次调用开始；二、编排层；三、整体设计；四、快速开始；五、常见问题。英文和其他项目侧栏逻辑保留。
- 本页目录包含20个链接、2组嵌套子目录，分别展示重试和流式各6个子标题。点击回调线程子标题后 URL hash 与目标标题一致。
- 桌面1440px和手机390px检查正常，手机 scrollWidth=innerWidth=390，共10张首页图示；检查新增流程图、正文与时间表的截图，浏览器无运行错误。
- 深浅色自动无障碍检查已确认违规0；SVG背景仍受自动识别限制，新图经人工查看。截图 stream-depth-and-outline.png、stream-depth-mobile.png、stream-callback-order-dark.png 保存在原任务临时目录。
- 第5、6节保留原文，写入时已逐字比较第5节起的全文一致，未实施被用户纠正的扩展范围。
### 网关入口名称与异步重试线程图（2026-11-17）

用户要求左侧第一项改为“一、网关层：从一次调用开始”，并在重试详细讲解中补一张与普通异步同类的线程时间线。仅修改中文 ai-lite 第一项名称；在“退避期间，谁在等，谁在工作”末尾增加 retryThreads 图，按业务 / 默认 OkHttp / ai-lite-retry-* 三列说明：整体 future 返回、HTTP 阻塞与释放、队列退避、到点发起新请求、调度线程可复用、最终成功。示例为首次503、关闭随机变化后等待200ms、第二次成功；时间轴不按比例。通用图组件增加可选线程列，原普通异步图保留相同列名与范围。已核对 RetryRun.startAttempt/runScheduledAttempt 与 RetryScheduler。
验证完成：中文第一项实际显示“一、网关层：从一次调用开始”；首页现有11张图，普通异步和重试线程图分别保留3列。桌面1440px截图检查通过，特意让调度线程可复用节点位于第二次HTTP成功之前，避免视觉上误解为调度线程也等待HTTP。手机390px时 scrollWidth=innerWidth=390，新增图区域可独立横向查看；浏览器无运行错误，自动无障碍检查已确认违规0，SVG文字背景自动识别限制经人工检查。npm run build 成功，截图 retry-thread-model.png 保存在原任务临时目录。未更改Java运行代码。
### 流式线程模型图（2026-11-17）

用户要求在第4节增加与普通异步、异步重试同类的线程时间线。在“回调在哪个线程执行，为什么还要保证顺序”内增加 streamThreads 图，按业务线程 / 默认 OkHttp 工作线程 / 远端模型服务三列展示正常正文输出：返回 future、两段网络等待、同一 HTTP 线程上的 inline onDelta、解析结束、future 完成与线程可复用。正文明确远端列并非本应用新线程，并说明 io 策略下回调转交独立池、HTTP 等待模型不变。复用已有线程列渲染，未更改 Java 运行代码。
流式线程图验证完成：npm run build 通过（14.26s），仅有既有包体积与 Element Plus 导入提示。首页12张图，新图三列为业务线程 / 默认 OkHttp 工作线程 / 远端模型服务；查看截图确认 onDelta 在 HTTP 列内，后续数据等待仍占工作线程，future 完成与任务结束可复用分别画出。正文说明 io 策略回调线程差异，未把远端服务画成本应用线程。手机390px时 scrollWidth=innerWidth=390，新图可在区域内横向查看；浏览器无运行错误，自动检查已确认违规0，SVG背景自动识别限制经截图人工检查。截图 stream-thread-model.png 位于原任务临时目录。
### 区分异步流式与异步回调策略（2026-11-17）

用户询问异步流式并要求补图。明确已有 oneByStreamAsync 是异步流式，原图采用默认 inline，不能将“异步调用”与“回调换线程”混为一谈。原图标题增加 inline 标记；增加同步流式 / 异步流式 inline / 同一异步入口 io 的对照表，并新增 streamIoThreads 三列时间图：业务线程、OkHttp工作线程、独立回调池。以回调较慢为例画出同次调用串行排队、HTTP任务先结束、增量处理后执行完成标记并完成future。网络等待仍占Dispatcher线程。根据 CallbackPolicy 和 AsyncRun.completeBarrier 复核正常完成路径。
异步流式对照图验证通过：最终 npm run build 成功（15.01s），仅有既有包体积与 Element Plus 导入提示。首页13张图；新io图三列分别为业务线程、OkHttp工作线程、独立回调池。截图人工确认HTTP可复用节点早于最终future完成，第2段回调在第1段返回后执行；没有把回调池策略解释成新的API或非阻塞网络传输。手机390px时 scrollWidth=innerWidth=390，图内可横向查看。浏览器无运行错误、自动检查已确认违规0，SVG背景识别限制已人工检查。截图 stream-io-thread-model.png 保存在原任务临时目录。
### 独立 NIO 网关章节（2026-11-17 用户确认）

用户选择新增“二、网关层：从一次调用开始（NIO）”，后续目录顺延。新增中文 docs/gateway-nio.md，以当前 Jetty 适配为例按接入、同步、异步、异步重试、流式 inline/io、连接与线程容量逐步讲解。保留同一 LlmGateway API；新增5张 NIO 专用线程图，网络间隔画为连接状态等待，不画成每请求一条阻塞线程，也不保证所有回调固定由某条 selector 线程执行。同步入口继续画业务线程阻塞，回调和取消等共同行为引用既有详解。

范围：新页、AiLiteFlow图定义、中文侧栏六项编号、首页与整体设计入口、网站README。验证：对照 JettyHttpExecutor/CallbackPolicy/重试源码，独立只读复核；npm run build；浏览器检查五张图、前后篇、子标题、桌面与手机显示。沿用原任务临时截图目录，不发布、不提交。
NIO独立章节验证完成：

- docs/gateway-nio.md 实际正文、示例和关键边界经独立只读复核通过，未发现实质不准确内容。五张线程图分别为同步、异步、异步重试、流式inline、流式io；灰色框明确表示连接状态等待。
- npm run build 成功（19.72s），仅有既有大包体积与Element Plus导入提示。首页、整体设计已添加NIO入口，README补充维护说明。
- 侧栏验证为六章，新增第二章名称准确，编排层顺延第三章；NIO页面前后篇分别指向第一章与第三章。
- 浏览器确认5张图均渲染，节点标题尺寸检查无越界；桌面1440px与手机390px页面无横向溢出，手机五个图区域均可独立滚动。目录16个链接，9个子标题。
- 深浅色自动检查已确认违规0，SVG背景自动识别限制已截图人工检查；浏览器无运行错误。截图 nio-async.png、nio-stream-inline.png、nio-stream-io.png、nio-mobile.png 位于原任务临时目录。
- Java实现与依赖配置未修改，仅添加网站说明与图示；未提交或发布。