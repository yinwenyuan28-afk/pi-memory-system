<script setup lang="ts">
import { computed } from 'vue';

type Node = { x: number; y: number; title: string; sub?: string; tone?: string; w?: number; h?: number; detail?: string };
type Edge = { d: string; label?: string; x?: number; y?: number; tone?: string };
type Diagram = { title: string; description: string; height: number; nodes: Node[]; edges: Edge[] };
// 用途：按 kind 展示经源码核对的调用路径；输入为图类型，输出为含文字说明的 SVG，避免依赖远程绘图服务。
const props = defineProps<{ kind: string }>();
const diagrams: Record<string, Diagram> = {
  sync: {
    title: '一次同步调用', description: '业务线程进入网关，等待模型完成后取得完整结果；等待期间业务线程仍被占用。', height: 220,
    nodes: [{ x: 25, y: 65, title: '业务线程', sub: '发起调用并等待' }, { x: 245, y: 65, title: 'LlmGateway', sub: '校验与解析配置', tone: 'main' }, { x: 465, y: 65, title: '模型服务', sub: '生成完整回答' }],
    edges: [{ d: 'M205 100H245' }, { d: 'M425 100H465' }, { d: 'M555 135V180H115V135', label: '完成后返回 LlmResult', x: 330, y: 172 }]
  },
  async: {"title":"异步返回 future，底层网络等待仍占线程","description":"以默认 OkHttp、模型响应较慢的请求为例：oneAsync 返回未完成的 future，业务线程继续工作，外层任务结束后可归还线程池。请求获得执行名额后，Dispatcher 工作线程负责连接、等待和读取响应，期间仍被占用。响应读取完成后完成 future；结果回调不要求回到原业务线程。","height":620,"nodes":[{"x":25,"y":65,"title":"调用 oneAsync","sub":"在业务线程上发起","tone":"main"},{"x":245,"y":65,"title":"创建 future / enqueue","sub":"提交 HTTP 请求","tone":"main"},{"x":465,"y":65,"title":"执行网络请求","sub":"获得执行名额后连接、发送","tone":"main"},{"x":25,"y":205,"title":"拿到未完成的 future","sub":"oneAsync 已返回","tone":"success"},{"x":465,"y":205,"title":"阻塞等待模型响应","sub":"socket 等待 / 读取响应","detail":"Dispatcher 工作线程仍被占用","h":100,"tone":"warn"},{"x":25,"y":365,"title":"继续处理其他工作","sub":"外层任务结束后可归还线程池","tone":"success"},{"x":245,"y":365,"title":"future 完成","sub":"触发已注册的结果处理","tone":"success"},{"x":465,"y":365,"title":"收到并读取完响应","sub":"执行完成回调","tone":"main"},{"x":465,"y":505,"title":"结束该请求任务","sub":"工作线程可复用","tone":"muted"}],"edges":[{"d":"M205 100H245"},{"d":"M425 100H465"},{"d":"M335 135V170H115V205","label":"立即返回 future，不等待模型","x":225,"y":158},{"d":"M115 275V365"},{"d":"M555 135V205"},{"d":"M555 305V365","label":"响应到达","x":597,"y":343},{"d":"M465 400H425","label":"完成 future","x":445,"y":353},{"d":"M555 435V505"}]},
  retry: {
    title: '失败以后，有条件地再试', description: '每次尝试成功就完成；遇到可重试错误且预算允许时，调度等待后重新调用。不可重试、次数用尽、超时或取消时结束。', height: 340,
    nodes: [{ x: 25, y: 55, title: '一次尝试', sub: 'oneWithRetryAsync', tone: 'main' }, { x: 245, y: 55, title: '检查结果', sub: '成功 / 错误分类', tone: 'main' }, { x: 465, y: 55, title: '完成 future', sub: '返回完整结果', tone: 'success' }, { x: 245, y: 225, title: '调度后重试', sub: '不在 HTTP 回调中 sleep', tone: 'warn' }, { x: 465, y: 225, title: '异常结束', sub: '次数 / 时限 / 取消', tone: 'muted' }],
    edges: [{ d: 'M205 90H245' }, { d: 'M425 90H465', label: '成功', x: 445, y: 77 }, { d: 'M335 125V225', label: '瞬时错误，且预算允许', x: 335, y: 183, tone: 'warn' }, { d: 'M245 260H115V125', tone: 'warn' }, { d: 'M425 112H445V260H465', tone: 'muted' }]
  },
  // 用途：展开异步退避的线程交接，区分调度队列中的等待与 HTTP 网络等待。
  retryScheduling: {"title":"退避期间保留定时任务，到点再发起请求","description":"HTTP 完成回调判断错误并提交定时任务后返回。退避期间不为每个调用占住一条睡眠线程；到点后 ai-lite-retry-* 线程发起下一次 oneAsync，再由 HTTP 客户端承担网络等待。","height":335,"nodes":[{"x":25,"y":45,"title":"HTTP 完成回调","sub":"分类失败 / 计算退避","tone":"main"},{"x":245,"y":45,"title":"提交定时任务","sub":"回调随后返回","tone":"main"},{"x":465,"y":45,"title":"调度队列等待","sub":"到点前不为该任务占住线程","tone":"warn"},{"x":465,"y":205,"title":"ai-lite-retry-* 线程","sub":"到点后执行发起动作","tone":"main"},{"x":245,"y":205,"title":"下一次 oneAsync","sub":"新的 future 与取消句柄","tone":"main"},{"x":25,"y":205,"title":"HTTP 客户端接手","sub":"网络等待按客户端模型执行","tone":"main"}],"edges":[{"d":"M205 80H245"},{"d":"M425 80H465"},{"d":"M555 115V205","label":"退避到点","x":597,"y":170},{"d":"M465 240H425"},{"d":"M245 240H205"}]},
  stream: {
    title: '生成一段，交付一段', description: '模型响应经流式解析，多次调用 onDelta；流结束后 future 返回完整 LlmResult。增量与完整结果不能重复追加。', height: 270,
    nodes: [{ x: 25, y: 50, title: '模型服务', sub: '逐步生成内容' }, { x: 245, y: 50, title: '流式解析', sub: '协议事件 → 文本增量', tone: 'main' }, { x: 465, y: 50, title: 'onDelta', sub: '逐段更新界面', tone: 'main' }, { x: 245, y: 175, title: '流结束', sub: '完整 LlmResult', tone: 'success' }],
    edges: [{ d: 'M205 85H245' }, { d: 'M425 85H465', label: '多次回调', x: 445, y: 72 }, { d: 'M335 120V175' }]
  },
  streamDecode: {"title":"字节片段经过协议解析，才成为文本增量","description":"以 SSE 协议为例，HTTP 层按行交付文本，协议层组装事件并解析字段；正文或推理累积到内部结果后，再交付文本增量。一次网络读取、一个事件和一次 onDelta 并不一一对应。","height":320,"nodes":[{"x":25,"y":40,"title":"HTTP 字节片段","sub":"分片边界由网络决定"},{"x":245,"y":40,"title":"解码并按行读取","sub":"处理不完整字符与行","tone":"main"},{"x":465,"y":40,"title":"组装 SSE 事件","sub":"读取 data 等协议内容","tone":"main"},{"x":465,"y":205,"title":"解析并累计结果","sub":"正文 / 推理 / 停止原因","tone":"main"},{"x":245,"y":205,"title":"onDelta 文本增量","sub":"不是每个事件都有文本","tone":"main"},{"x":25,"y":205,"title":"应用处理文本","sub":"展示或写入输出通道","tone":"success"}],"edges":[{"d":"M205 75H245"},{"d":"M425 75H465"},{"d":"M555 110V205"},{"d":"M465 240H425"},{"d":"M245 240H205"}]},
  streamCallbacks: {"title":"io 策略：同一次调用先处理增量，再通知完成","description":"正常成功路径中，HTTP 解析产生的增量与完成标记进入同一次调用的队列，在共享回调池上按顺序执行。future 成功完成之前，已入队的增量处理先结束；取消和队列溢出走各自的终止处理。","height":320,"nodes":[{"x":25,"y":40,"title":"HTTP 解析线程","sub":"提交增量 / 流结束事件"},{"x":245,"y":40,"title":"本次调用的队列","sub":"第1段 → 第2段 → 完成标记","tone":"main"},{"x":465,"y":40,"title":"共享回调线程池","sub":"同次调用串行执行","tone":"main"},{"x":465,"y":205,"title":"onDelta 处理完毕","sub":"已入队的增量依次完成","tone":"main"},{"x":245,"y":205,"title":"执行完成标记","sub":"完成整体 future","tone":"success"},{"x":25,"y":205,"title":"调用方观察结果","sub":"最终内容与停止原因","tone":"success"}],"edges":[{"d":"M205 75H245"},{"d":"M425 75H465"},{"d":"M555 110V205"},{"d":"M465 240H425"},{"d":"M245 240H205"}]},
  tools: {
    title: '模型决定要什么，应用执行工具', description: '模型返回工具请求后，应用执行已注册的工具；工具结果作为消息返回模型，直到模型给出最终回答或达到轮数限制。', height: 290,
    nodes: [{ x: 25, y: 45, title: '消息与工具声明', sub: '可用工具及参数说明' }, { x: 245, y: 45, title: '模型一轮响应', sub: '回答，或请求工具', tone: 'main' }, { x: 465, y: 45, title: '最终回答', sub: '没有工具请求时结束', tone: 'success' }, { x: 245, y: 185, title: '应用执行工具', sub: '把工具结果加入消息', tone: 'main' }],
    edges: [{ d: 'M205 80H245' }, { d: 'M425 80H465' }, { d: 'M335 115V185', label: '工具请求', x: 335, y: 161 }, { d: 'M245 220H220V104H245', label: '下一轮', x: 170, y: 176 }]
  },
  state: {
    title: '在调用外管理历史与提示词', description: '会话加载历史，提示词中心提供渲染后的消息，交给网关调用；会话执行后追加条目并保存。提示词版本与会话历史分别管理。', height: 305,
    nodes: [{ x: 25, y: 40, title: '下一次用户请求', sub: '同一个会话 id' }, { x: 245, y: 40, title: '会话运行时', sub: '加载历史 / 追加新消息', tone: 'main' }, { x: 465, y: 40, title: '网关 / Agent', sub: '执行本次任务', tone: 'main' }, { x: 25, y: 200, title: '提示词中心', sub: '发布版本 → 渲染消息', tone: 'muted' }, { x: 245, y: 200, title: '会话存储', sub: '内存 / Redis / JDBC', tone: 'muted' }],
    edges: [{ d: 'M205 75H245' }, { d: 'M425 75H465' }, { d: 'M115 200V145H285V110', tone: 'muted' }, { d: 'M335 200V110', tone: 'muted' }, { d: 'M555 110V235H425', label: '追加条目并保存', x: 532, y: 220 }]
  },
  workflow: {"title":"固定顺序：前一步完成，才开始下一步","description":"Workflow 按应用声明的顺序执行步骤，成功后才推进；步骤抛出异常或被取消时停止后续步骤，并保留已完成结果供诊断。它不会自动把上一步输出改成下一步输入。","height":295,"nodes":[{"x":25,"y":40,"title":"步骤一：提炼要点","sub":"一次模型调用","tone":"main"},{"x":245,"y":40,"title":"步骤二：提取关键词","sub":"一次模型调用","tone":"main"},{"x":465,"y":40,"title":"汇总结果列表","sub":"按步骤顺序返回","tone":"success"},{"x":245,"y":190,"title":"停止后续步骤","sub":"保留步骤序号和已完成结果","tone":"warn"}],"edges":[{"d":"M205 75H245","label":"成功","x":225,"y":63},{"d":"M425 75H465","label":"成功","x":445,"y":63},{"d":"M115 110V225H245","tone":"warn"},{"d":"M335 110V190","label":"异常 / 取消","x":335,"y":158,"tone":"warn"}]},
  workflowAsync: {"title":"异步推进，顺序保持不变","description":"runAsync 先返回 future，步骤一完成后才发起步骤二。带重试的步骤在自身结束后才交给下一步；它不会自动并行执行，也不会自动重做整个 Workflow。","height":305,"nodes":[{"x":25,"y":35,"title":"业务线程","sub":"取得整体 future 后继续"},{"x":245,"y":35,"title":"步骤一 future","sub":"oneStepAsync","tone":"main"},{"x":465,"y":35,"title":"步骤二 future","sub":"可选显式重试","tone":"main"},{"x":245,"y":200,"title":"整体 future 完成","sub":"按顺序返回结果列表","tone":"success"},{"x":465,"y":200,"title":"该步内重试","sub":"失败分类 → 退避 → 再试","tone":"warn"}],"edges":[{"d":"M205 70H245"},{"d":"M425 70H465","label":"完成后再发起","x":445,"y":58},{"d":"M555 105V200","tone":"warn","label":"可重试错误","x":597,"y":180},{"d":"M465 235H425"},{"d":"M555 105V155H335V200","label":"成功后","x":375,"y":147}]},
  agent: {"title":"AgentLoop：根据每轮结果决定后续动作","description":"AgentLoop 每轮调用网关 round。模型返回可执行工具请求时，应用执行工具并把结果加入上下文，再进入下一轮；没有工具请求时通常结束，生命周期决策、轮数上限、错误和取消也会改变终止路径。","height":340,"nodes":[{"x":25,"y":40,"title":"本次运行上下文","sub":"消息 / 工具 / 取消句柄"},{"x":245,"y":40,"title":"模型一轮响应","sub":"gateway.round","tone":"main"},{"x":465,"y":40,"title":"任务结束","sub":"最终结果与停止原因","tone":"success"},{"x":245,"y":225,"title":"执行工具并追加结果","sub":"工具结果成为下一轮输入","tone":"main"}],"edges":[{"d":"M205 75H245"},{"d":"M425 75H465","label":"满足终止条件","x":445,"y":63},{"d":"M335 110V225","label":"允许继续且有工具请求","x":335,"y":173},{"d":"M245 260H215V96H245","label":"下一轮","x":165,"y":190}]},
  lifecycle: {"title":"七个介入时机，围绕同一条循环","description":"beforeRun 执行一次；每轮按 beforeModel、afterModel、工具前后、afterTurn 推进，必要时回到下一轮。运行正常结束、取消或异常时执行 afterRun；beforeRun 本身失败则不进入运行。","height":565,"nodes":[{"x":245,"y":20,"title":"beforeRun","sub":"准备本次消息与工具","tone":"muted"},{"x":245,"y":125,"title":"beforeModel","sub":"本轮请求发出前","tone":"main"},{"x":245,"y":230,"title":"afterModel","sub":"模型返回，工具尚未执行","tone":"main"},{"x":245,"y":335,"title":"beforeTool / afterTool","sub":"逐个工具执行前 / 后","tone":"main"},{"x":245,"y":455,"title":"afterTurn","sub":"停止 / 继续 / 交给模型","tone":"main"},{"x":465,"y":455,"title":"afterRun","sub":"观察结果或失败原因","tone":"muted"}],"edges":[{"d":"M335 90V125"},{"d":"M335 195V230"},{"d":"M335 300V335"},{"d":"M335 405V455"},{"d":"M425 490H465","label":"结束","x":445,"y":478},{"d":"M245 490H160V160H245","label":"继续下一轮","x":160,"y":430},{"d":"M425 265H450V430H335V455","label":"无工具","x":480,"y":350,"tone":"muted"}]},
  parallelTools: {"title":"只并行同一批工具，上下文仍按顺序写入","description":"模型同一轮请求工具 A、B；并行模式允许它们同时执行，成功后按模型原始顺序处理结果并写入上下文，才发起下一轮模型调用。并行不表示多轮模型同时推进。","height":330,"nodes":[{"x":25,"y":100,"title":"本轮工具请求","sub":"原始顺序 A → B","tone":"main"},{"x":245,"y":25,"title":"工具 A","sub":"可与 B 同时执行","tone":"main"},{"x":245,"y":180,"title":"工具 B","sub":"可能比 A 先完成","tone":"main"},{"x":465,"y":100,"title":"按 A → B 写入结果","sub":"完成顺序不改变消息顺序","tone":"main"},{"x":465,"y":230,"title":"下一轮模型","sub":"读取本批工具结果","tone":"success"}],"edges":[{"d":"M205 135H220V60H245"},{"d":"M205 135H220V215H245"},{"d":"M425 60H445V135H465"},{"d":"M425 215H445V135H465"},{"d":"M555 170V230"}]},
  assembly: {"title":"把执行机制组合成业务能力","description":"Assembly 是应用对外的业务入口，可以组合 WorkflowSpec 和 AgentSpec；两种 Spec 分别使用传入的 Workflow 和 AgentLoop。它们是普通 Java 接口，不会自动生成执行图、注册任务或恢复进度。","height":355,"nodes":[{"x":245,"y":20,"title":"业务接口 / Service","sub":"接收输入，返回业务结果"},{"x":245,"y":125,"title":"Assembly","sub":"组合业务步骤","tone":"main"},{"x":25,"y":245,"title":"WorkflowSpec","sub":"定义固定顺序与数据传递","tone":"main"},{"x":465,"y":245,"title":"AgentSpec","sub":"组合 Agent 与生命周期","tone":"main"}],"edges":[{"d":"M335 90V125"},{"d":"M335 195V220H115V245"},{"d":"M335 195V220H555V245"}]},
  architecture: {
    title: 'ai-lite 的职责与可替换部件', description: '业务通过 LlmGateway 调用模型。协议适配器负责请求和响应格式，HTTP 客户端负责网络传输。Agent、会话和提示词按需组合，调用记录与出口保护支撑运行。', height: 540,
    nodes: [{ x: 245, y: 20, title: '现有 Java 业务', sub: 'Spring Boot 2.x / JDK 8+' }, { x: 25, y: 130, title: 'Agent / 会话', sub: '多轮执行 / 跨请求历史', tone: 'muted' }, { x: 245, y: 130, title: 'LlmGateway', sub: '统一调用与错误语义', tone: 'main' }, { x: 465, y: 130, title: '提示词 / 运行时目录', sub: '消息渲染 / 模型绑定', tone: 'muted' }, { x: 245, y: 250, title: '协议适配器', sub: 'OpenAI / Anthropic', tone: 'main' }, { x: 25, y: 250, title: '运行支撑', sub: '记录 / 指标 / 出口保护', tone: 'muted' }, { x: 245, y: 365, title: 'HTTP 客户端', sub: 'OkHttp / Jetty / 其他实现', tone: 'main' }, { x: 465, y: 365, title: '模型服务', sub: '供应商 API' }],
    edges: [{ d: 'M335 90V130' }, { d: 'M205 165H245', tone: 'muted' }, { d: 'M465 165H425', tone: 'muted' }, { d: 'M335 200V250' }, { d: 'M115 250V190H245', tone: 'muted' }, { d: 'M335 320V365' }, { d: 'M425 400H465' }]
  }
};
const diagram = computed(() => diagrams[props.kind] || diagrams.architecture);
</script>

<template>
  <figure class="ai-flow">
    <figcaption><strong>{{ diagram.title }}</strong><span>{{ kind === "async" ? "时间向下；分开看业务线程与 HTTP 工作线程" : "沿箭头阅读，灰色为支撑能力" }}</span></figcaption>
    <div class="ai-flow-scroll" role="region" tabindex="0" :aria-label="diagram.title + '，小屏可横向滚动'">
      <svg :viewBox="'0 0 675 ' + diagram.height" role="img" :aria-label="diagram.description">
        <!-- 用途：异步图按线程分列并以时间向下推进，明确返回 future 与底层阻塞等待同时存在。 -->
        <g v-if="kind === 'async'" class="thread-lanes" aria-hidden="true">
          <path d="M115 45V450M335 45V450M555 45V590" />
          <text x="115" y="30" text-anchor="middle">业务线程</text>
          <text x="335" y="30" text-anchor="middle">网关 / future</text>
          <text x="555" y="30" text-anchor="middle">默认 OkHttp 工作线程</text>
        </g>
        <defs>
          <marker :id="'arrow-' + kind" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="context-stroke" /></marker>
        </defs>
        <g v-for="(edge, i) in diagram.edges" :key="'e' + i" :class="['flow-edge', edge.tone]">
          <path :d="edge.d" :marker-end="'url(#arrow-' + kind + ')'" />
          <text v-if="edge.label" :x="edge.x" :y="edge.y" text-anchor="middle">{{ edge.label }}</text>
        </g>
        <g v-for="(node, i) in diagram.nodes" :key="'n' + i" :transform="'translate(' + node.x + ',' + node.y + ')'" :class="['flow-node', node.tone]">
          <rect :width="node.w || 180" :height="node.h || 70" rx="10" />
          <text :x="(node.w || 180) / 2" y="29" text-anchor="middle" class="node-title">{{ node.title }}</text>
          <text :x="(node.w || 180) / 2" y="51" text-anchor="middle" class="node-sub">{{ node.sub }}</text>
          <text v-if="node.detail" :x="(node.w || 180) / 2" y="76" text-anchor="middle" class="node-sub">{{ node.detail }}</text>
        </g>
      </svg>
    </div>
    <p class="flow-description">{{ diagram.description }}</p>
  </figure>
</template>

<style scoped>
.ai-flow { --flow-ink: #24384f; --flow-sub: #52677f; --flow-blue: #2f6fdb; --flow-fill: #eef4ff; --flow-paper: #fff; --flow-line: #b9c8db; margin: 28px 0; border: 1px solid var(--vp-c-divider); border-radius: 12px; background: var(--flow-paper); overflow: hidden; }
.ai-flow figcaption { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; padding: 16px 20px 10px; color: var(--flow-ink); }
.ai-flow figcaption strong { font-size: 15px; }
.ai-flow figcaption span { font-size: 12px; color: var(--flow-sub); }
.ai-flow-scroll { overflow-x: auto; padding: 0 10px; }
.ai-flow-scroll:focus-visible { outline: 3px solid var(--flow-blue); outline-offset: -3px; }
svg { display: block; width: 100%; min-width: 570px; font-family: var(--vp-font-family-base); }
.thread-lanes path { fill: none; stroke: var(--flow-line); stroke-width: 1; stroke-dasharray: 3 6; }
.thread-lanes text { fill: var(--flow-sub); font-size: 12px; font-weight: 600; }
.flow-edge path { fill: none; stroke: var(--flow-blue); stroke-width: 2; }
.flow-edge text { font-size: 11px; fill: var(--flow-sub); paint-order: stroke; stroke: var(--flow-paper); stroke-width: 5px; stroke-linejoin: round; }
.flow-edge.warn path { stroke: #a46d13; }
.flow-edge.muted path { stroke: #75869a; stroke-width: 1.4; stroke-dasharray: 5 4; }
.flow-node rect { fill: var(--flow-paper); stroke: var(--flow-line); stroke-width: 1.3; }
.flow-node.main rect { fill: var(--flow-fill); stroke: var(--flow-blue); stroke-width: 2; }
.flow-node.warn rect { fill: #fff8e9; stroke: #a46d13; }
.flow-node.success rect { fill: #e8f6f0; stroke: #28795e; }
.flow-node.muted rect { fill: var(--vp-c-bg-soft); stroke-dasharray: 5 4; }
.node-title { stroke: none; fill: var(--flow-ink); font-size: 14px; font-weight: 650; }
.node-sub { stroke: none; fill: var(--flow-sub); font-size: 11px; }
.ai-flow .flow-description { margin: 0; padding: 12px 20px 16px; border-top: 1px solid var(--vp-c-divider); font-size: 13px; line-height: 1.8; color: var(--flow-sub); }
:global(html.dark .ai-flow) { --flow-ink: #e2eaf5; --flow-sub: #afbed0; --flow-blue: #8ab3ff; --flow-fill: #203656; --flow-paper: #1c2836; --flow-line: #57708c; }
:global(html.dark .ai-flow .flow-node.warn rect) { fill: #40341e; stroke: #ddb96f; }
:global(html.dark .ai-flow .flow-node.success rect) { fill: #203e34; stroke: #7bc8a9; }
@media (prefers-reduced-motion: reduce) { .ai-flow-scroll { scroll-behavior: auto; } }
</style>
