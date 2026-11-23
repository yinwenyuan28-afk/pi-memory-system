<script setup lang="ts">
import { computed } from 'vue';

type Node = { x: number; y: number; title: string; sub?: string; tone?: string; w?: number; h?: number };
type Edge = { d: string; label?: string; x?: number; y?: number; tone?: string };
type Diagram = { title: string; description: string; height: number; nodes: Node[]; edges: Edge[] };

// 用途：按 kind 展示经源码核对的结构与流程；输入为图类型，输出为带说明的本地 SVG，不依赖远程绘图。
const props = defineProps<{ kind: string }>();

const diagrams: Record<string, Diagram> = {
  // 用途：一页看清两条路径——前台召回辅助本轮回答，后台整理把对话逐层变成记忆。
  architecture: {
    title: '两条路径共用同一份记忆库',
    description: '上半部分是本轮回答：问题先构造查询，再经过向量检索和四道筛选，把已就绪的记录插到本轮用户消息之后。下半部分是后台整理：每轮对话结束后归档，累计到阈值才排队，子代理逐层整理并把进度写回。前台只读，后台只写，两者通过 L1 记录与向量索引交接。',
    height: 700,
    nodes: [
      { x: 25, y: 20, title: '本轮用户问题', sub: '可能被噪声替换' },
      { x: 245, y: 20, title: '召回调度', sub: '会话内单飞执行', tone: 'main' },
      { x: 465, y: 20, title: '向量检索', sub: '取 topK 的 2 倍', tone: 'main' },
      { x: 465, y: 140, title: '四道筛选', sub: '阈值 → 任务 → 项目 → 预算', tone: 'main' },
      { x: 245, y: 140, title: '注入块', sub: '每条带记录编号', tone: 'main' },
      { x: 25, y: 140, title: '本轮模型上下文', sub: '回答时参考', tone: 'success' },
      { x: 25, y: 290, title: 'agent_settled', sub: '每轮活动结束触发', tone: 'muted' },
      { x: 25, y: 410, title: 'L0 归档', sub: '只留用户与助手正文' },
      { x: 245, y: 410, title: 'L1 提取子代理', sub: '计数达 10 次后排队', tone: 'main' },
      { x: 465, y: 410, title: 'L1 记录与向量', sub: '写盘即生效', tone: 'main' },
      { x: 465, y: 530, title: 'L2 场景块', sub: '把多条记录编成经历' },
      { x: 245, y: 530, title: 'L3 提议稿', sub: 'USER-temp.md' },
      { x: 25, y: 530, title: '用户审阅并入', sub: '才写正式 USER.md', tone: 'muted' }
    ],
    edges: [
      { d: 'M205 55H245' },
      { d: 'M425 55H465' },
      { d: 'M555 90V140' },
      { d: 'M465 175H425' },
      { d: 'M245 175H205' },
      { d: 'M115 210V290' },
      { d: 'M115 360V410' },
      { d: 'M205 445H245' },
      { d: 'M425 445H465' },
      { d: 'M555 480V530' },
      { d: 'M465 565H425' },
      { d: 'M245 565H205' },
      { d: 'M645 445H662V55H645', label: '向量供召回', x: 620, y: 250, tone: 'muted' }
    ]
  },

  // 用途：把 L1 从计数到收尾的时序画出来，区分"排队"和"完成"两个时刻。
  background: {
    title: 'L1：从计数到收尾',
    description: '计数只发生在用户交互输入上，且 L1 没有排队或运行中的任务时才加一。达到 10 次后，等当前代理活动结束才检查 L0 是否存在增量，然后入队。worker 认领后启动子代理，真正的完成信号来自子代理调用的 l1_commit，而不是子进程退出。收尾时再决定继续消化积压、安排 L2，还是结束。',
    height: 560,
    nodes: [
      { x: 25, y: 30, title: '用户交互输入', sub: '工具调用与自动跟进不算' },
      { x: 245, y: 30, title: '计数加一', sub: 'L1 空闲时才计', tone: 'main' },
      { x: 465, y: 30, title: '达到 10 次', sub: '等本轮活动结束', tone: 'main' },
      { x: 465, y: 170, title: '检查 L0 增量', sub: '无增量则清零计数', tone: 'muted' },
      { x: 245, y: 170, title: '入队 jobs.sqlite', sub: '同层已有任务则不重复', tone: 'main' },
      { x: 25, y: 170, title: 'worker 认领', sub: '每 2 秒轮询或事件触发', tone: 'main' },
      { x: 25, y: 310, title: '子代理读增量', sub: '每批最多 25 条消息' },
      { x: 245, y: 310, title: 'l1_commit 提交', sub: '写记录并推进游标', tone: 'main' },
      { x: 465, y: 310, title: '收尾编排', sub: '决定下一步', tone: 'main' },
      { x: 465, y: 450, title: '继续 L1 / 排 L2 / 结束', sub: 'decideNextAfterL1 三选一', tone: 'success' }
    ],
    edges: [
      { d: 'M205 65H245' },
      { d: 'M425 65H465' },
      { d: 'M555 100V170' },
      { d: 'M465 205H425' },
      { d: 'M245 205H205' },
      { d: 'M115 240V310' },
      { d: 'M205 345H245' },
      { d: 'M425 345H465' },
      { d: 'M555 380V450' }
    ]
  },

  // 用途：说明队列的认领规则和"被阻塞的层不拖住整条队列"。
  pipeline: {
    title: '队列：同一时刻只有一个子代理在跑',
    description: '三层共用一条持久队列。入队时同层已有排队或运行中的任务就返回原任务，不新增。取任务前先按"这一层是否被熔断或持有"过滤，被挡住的层留在队列里，后面的层照常执行。认领与"全局空闲"检查写在同一条原子语句里，所以多个进程也只能认领一个。',
    height: 720,
    nodes: [
      { x: 245, y: 20, title: '自动或手动触发', sub: 'interval / manual / drain' },
      { x: 245, y: 140, title: '入队', sub: '同层去重', tone: 'main' },
      { x: 245, y: 260, title: '按顺序取候选', sub: 'L3 永远排在最后', tone: 'main' },
      { x: 245, y: 380, title: '跳过被阻塞的层', sub: '熔断或未确认停止', tone: 'main' },
      { x: 245, y: 500, title: '原子认领', sub: '全局空闲才改为 running', tone: 'main' },
      { x: 245, y: 620, title: '执行一个子代理', sub: 'L1 / L2 / L3 三选一', tone: 'success' },
      { x: 25, y: 380, title: '被跳过的任务', sub: '留在队列等人工复位', tone: 'warn' }
    ],
    edges: [
      { d: 'M335 90V140' },
      { d: 'M335 210V260' },
      { d: 'M335 330V380' },
      { d: 'M335 450V500' },
      { d: 'M335 570V620' },
      { d: 'M245 415H205', tone: 'warn' }
    ]
  },

  // 用途：把一次召回从输入到注入的四道筛选画成一条线，标出每道筛选的取舍。
  recall: {
    title: '一次召回要过四道筛选',
    description: '每个筛选解决不同问题：阈值去掉明显不相关的候选；隐藏已关闭任务避免把做完的事当成待办；项目加权只调整相对顺序，不删掉跨项目记录；字符预算控制最终占用。任何一道都可能让结果为空，空结果也是合法结果，不会阻塞回答。',
    height: 640,
    nodes: [
      { x: 245, y: 20, title: '本轮输入', sub: '斜杠命令与纯符号跳过' },
      { x: 245, y: 130, title: '构造查询', sub: '有内容 / 替换噪声 / 跳过', tone: 'main' },
      { x: 245, y: 240, title: '召回调度', sub: '注入单槽，工具排队', tone: 'main' },
      { x: 245, y: 350, title: '向量检索', sub: '有项目时取 2 倍候选', tone: 'main' },
      { x: 245, y: 460, title: '阈值 + 隐藏已关闭任务', sub: '真余弦门槛，默认 0.2', tone: 'main' },
      { x: 245, y: 570, title: '项目加权 + 字符预算', sub: '异项目 ×0.75，单条 300 字', tone: 'main' },
      { x: 465, y: 460, title: 'shadow 模式', sub: '只统计会被滤掉多少', tone: 'muted' },
      { x: 25, y: 460, title: '超时或失败', sub: '本轮不注入，不阻塞回答', tone: 'warn' }
    ],
    edges: [
      { d: 'M335 90V130' },
      { d: 'M335 200V240' },
      { d: 'M335 310V350' },
      { d: 'M335 420V460' },
      { d: 'M335 530V570' },
      { d: 'M425 495H465', tone: 'muted' },
      { d: 'M335 420H305V460H245', tone: 'warn' }
    ]
  },

  // 用途：说明记忆块插在哪里、为什么不写回会话文件。
  injection: {
    title: '记忆块的插入位置与会话边界',
    description: '正式背景在会话开始时读成快照，放进 system prompt 前缀。本轮的召回结果通过 context 事件插入到"消息副本"，位置固定在最后一条用户消息之后。副本用于本次模型调用，不写回主会话文件；所以工具轮到下一轮时，历史里不会堆积一串过期记忆块。',
    height: 430,
    nodes: [
      { x: 25, y: 30, title: 'MEMORY.md / USER.md', sub: '会话开始时读取' },
      { x: 245, y: 30, title: '冻结快照', sub: '会话内不再变化', tone: 'main' },
      { x: 465, y: 30, title: 'system prompt 前缀', sub: '利于前缀缓存', tone: 'main' },
      { x: 465, y: 150, title: '每轮模型调用', sub: '工具轮次也一样', tone: 'main' },
      { x: 245, y: 150, title: 'context 事件', sub: '修改的是消息副本', tone: 'main' },
      { x: 25, y: 150, title: 'l1-records 记忆块', sub: '每行带记录编号', tone: 'main' },
      { x: 25, y: 280, title: '插在最后一条用户消息后', sub: '没有用户消息才追加末尾', tone: 'success' },
      { x: 245, y: 280, title: '不写回会话 JSONL', sub: '下一轮重新插入', tone: 'success' },
      { x: 465, y: 280, title: '工具结果仍会保留', sub: '主动召回不是自动注入', tone: 'muted' }
    ],
    edges: [
      { d: 'M205 65H245' },
      { d: 'M425 65H465' },
      { d: 'M555 100V150' },
      { d: 'M465 185H425' },
      { d: 'M245 185H205' },
      { d: 'M115 220V280' },
      { d: 'M205 315H245' },
      { d: 'M425 315H465' }
    ]
  },

  // 用途：解释追加写、就地删除标记和"同编号最后一行有效"的读取规则。
  l1write: {
    title: '改一条记忆：追加新版本，就地作废旧版本',
    description: '记忆分片只追加，不回头改写正文。update 或 merge 时，旧行在原文件里就地把 deleted 改成 true（保留正文供溯源），新版本带新编号追加到当天分片。读取时按编号取最后一行状态，所以同一编号的历史行不会互相干扰。这样做的代价是分片会变大，收益是任何一步中断都能靠"最后状态"重新判断。',
    height: 400,
    nodes: [
      { x: 25, y: 30, title: '新记录', sub: '提交时生成编号', tone: 'main' },
      { x: 245, y: 30, title: '追加到当天分片', sub: 'records/YYYY-MM-DD.jsonl', tone: 'main' },
      { x: 465, y: 30, title: '读取按编号取最后状态', sub: '最后一行决定是否存活', tone: 'main' },
      { x: 465, y: 160, title: 'update / merge', sub: '候选被要求改写' },
      { x: 245, y: 160, title: '旧行就地标 deleted', sub: '正文与编号保留', tone: 'warn' },
      { x: 25, y: 160, title: '新版本追加', sub: '新编号、版本号加一', tone: 'main' },
      { x: 245, y: 290, title: 'L2 只读存活记录', sub: '已删除的不再进入场景整理', tone: 'muted' }
    ],
    edges: [
      { d: 'M205 65H245' },
      { d: 'M425 65H465' },
      { d: 'M555 230V260H335V290', tone: 'muted' },
      { d: 'M465 195H425' },
      { d: 'M245 195H205' },
      { d: 'M115 160V100', label: '旧版本作废', x: 115, y: 132, tone: 'warn' }
    ]
  },

  // 用途：区分三把锁各自防什么，说明为什么一把不够。
  locks: {
    title: '三把锁，各管一段',
    description: '队列锁决定"谁有资格执行"，运行锁决定"谁有资格写这一层"，提交写锁保证"同一次文件改写不交错"。三者作用范围不同：队列锁跨进程但只覆盖认领；运行锁跨整个子代理运行并定期续期；提交写锁只覆盖一次写入，等待时间短。',
    height: 340,
    nodes: [
      { x: 245, y: 20, title: '一次后台写入', sub: '可能来自不同进程' },
      { x: 25, y: 140, title: '队列锁', sub: 'jobs.sqlite 原子认领', tone: 'main' },
      { x: 245, y: 140, title: '运行锁', sub: '每层一把，跨整个运行', tone: 'main' },
      { x: 465, y: 140, title: '提交写锁', sub: '只覆盖一次文件改写', tone: 'main' },
      { x: 25, y: 255, title: '防重复派发', sub: '同一时刻只有一个任务' },
      { x: 245, y: 255, title: '防两个同层写者', sub: '监督者误判后仍有效' },
      { x: 465, y: 255, title: '防读改写交错', sub: '分片重写不重叠' }
    ],
    edges: [
      { d: 'M335 90V110H115V140' },
      { d: 'M335 90V140' },
      { d: 'M335 90V110H555V140' },
      { d: 'M115 210V255' },
      { d: 'M335 210V255' },
      { d: 'M555 210V255' }
    ]
  },

  // 用途：说明主代理与后台子代理的上下文互不继承，以及通知如何回到主会话。
  subagent: {
    title: '后台子代理用自己的上下文',
    description: '子代理用独立 system prompt、工具白名单和会话目录启动，不继承主代理的召回块，也不加载项目指令文件与技能。进程内用环境变量区分身份，子代理自己不会启动第二套调度。它写出的通知先落到文件，由主进程在任务收尾时取出显示，所以长任务期间主会话不会被后台过程占满。',
    height: 430,
    nodes: [
      { x: 25, y: 30, title: '主进程', sub: '注入与调度都在这里', tone: 'main' },
      { x: 245, y: 30, title: '子代理进程', sub: 'spawn 一个 pi 实例', tone: 'main' },
      { x: 465, y: 30, title: '独立会话文件', sub: '只留本次任务过程' },
      { x: 25, y: 150, title: '冻结快照 + 召回块', sub: '不传给子代理', tone: 'muted' },
      { x: 245, y: 150, title: '独立 system prompt', sub: '加工具白名单', tone: 'main' },
      { x: 465, y: 150, title: '工具调用与提交', sub: '提交结果才是完成信号', tone: 'main' },
      { x: 245, y: 280, title: '环境变量标记身份', sub: '跳过注入与调度' },
      { x: 25, y: 280, title: '通知落文件', sub: '主进程收尾时取出', tone: 'success' }
    ],
    edges: [
      { d: 'M205 65H245' },
      { d: 'M425 65H465' },
      { d: 'M555 100V150' },
      { d: 'M335 100V150', tone: 'muted' },
      { d: 'M115 100V150', tone: 'muted' },
      { d: 'M335 220V280' },
      { d: 'M245 315H205' }
    ]
  },

  // 用途：串起三层数据的关系：场景块是正文，成员清单是权威关联，索引可重建，画像需要人工确认。
  scenes: {
    title: '场景与画像：正文、成员、索引各管一件事',
    description: '场景正文写在 Markdown 块里，便于人直接阅读和编辑。成员清单单独保存在 sidecar，记录这个场景收录了哪些记录，是权威数据，不能从正文重建。场景索引每次提交后从块文件全量重建，只做展示和快速查找。画像先生成提议稿，用户确认后才写正式文件，下一次新会话才读到更新。',
    height: 480,
    nodes: [
      { x: 25, y: 30, title: 'L1 记录', sub: '原子记忆与编号' },
      { x: 245, y: 30, title: 'L2 场景块', sub: 'Markdown 九段正文', tone: 'main' },
      { x: 465, y: 30, title: '九段结构', sub: '场景 / 条件 / SOP / 禁忌…' },
      { x: 245, y: 150, title: '成员清单 sidecar', sub: '收录了哪些记录', tone: 'main' },
      { x: 465, y: 150, title: '场景索引', sub: '每次提交后全量重建' },
      { x: 245, y: 280, title: 'L3 读变化场景', sub: '只处理上次之后的更新' },
      { x: 465, y: 280, title: 'USER-temp.md', sub: '提议稿，可编辑', tone: 'main' },
      { x: 25, y: 280, title: 'USER.md', sub: '用户确认后才更新', tone: 'success' }
    ],
    edges: [
      { d: 'M205 65H245' },
      { d: 'M425 65H465' },
      { d: 'M335 100V150' },
      { d: 'M555 100V150' },
      { d: 'M335 220V280' },
      { d: 'M425 315H465', tone: 'muted' },
      { d: 'M465 350V390H115V280', label: '人工并入', x: 290, y: 380, tone: 'muted' }
    ]
  }
};

const diagram = computed(() => diagrams[props.kind] || diagrams.architecture);
</script>

<template>
  <figure class="memory-flow">
    <figcaption>
      <strong>{{ diagram.title }}</strong>
      <span>沿箭头阅读，蓝色是主要动作，灰色是支撑或旁路</span>
    </figcaption>
    <div class="memory-flow-scroll" role="region" tabindex="0" :aria-label="diagram.title + '，小屏可横向滚动'">
      <svg :viewBox="'0 0 675 ' + diagram.height" role="img" :aria-label="diagram.description">
        <defs>
          <marker :id="'mf-arrow-' + kind" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10Z" fill="context-stroke" />
          </marker>
        </defs>
        <g v-for="(edge, i) in diagram.edges" :key="'e' + i" :class="['mf-edge', edge.tone]">
          <path :d="edge.d" :marker-end="'url(#mf-arrow-' + kind + ')'" />
          <text v-if="edge.label" :x="edge.x" :y="edge.y" text-anchor="middle">{{ edge.label }}</text>
        </g>
        <g
          v-for="(node, i) in diagram.nodes"
          :key="'n' + i"
          :transform="'translate(' + node.x + ',' + node.y + ')'"
          :class="['mf-node', node.tone]"
        >
          <rect :width="node.w || 180" :height="node.h || 70" rx="10" />
          <text :x="(node.w || 180) / 2" y="29" text-anchor="middle" class="mf-title">{{ node.title }}</text>
          <text :x="(node.w || 180) / 2" y="51" text-anchor="middle" class="mf-sub">{{ node.sub }}</text>
        </g>
      </svg>
    </div>
    <p class="mf-description">{{ diagram.description }}</p>
  </figure>
</template>

<style scoped>
.memory-flow {
  --mf-ink: var(--vp-c-text-1);
  --mf-sub: var(--vp-c-text-2);
  --mf-line: var(--vp-c-divider);
  --mf-paper: var(--vp-c-bg);
  --mf-fill: var(--vp-c-bg-soft);
  --mf-blue: var(--vp-c-brand-1);
  margin: 28px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--mf-paper);
  overflow: hidden;
}
.memory-flow figcaption {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 16px;
  padding: 16px 20px 10px;
  color: var(--mf-ink);
}
.memory-flow figcaption strong { font-size: 15px; }
.memory-flow figcaption span { font-size: 12px; color: var(--mf-sub); }
.memory-flow-scroll { overflow-x: auto; padding: 0 10px; }
.memory-flow-scroll:focus-visible { outline: 3px solid var(--mf-blue); outline-offset: -3px; }
svg { display: block; width: 100%; min-width: 570px; font-family: var(--vp-font-family-base); }
.mf-edge path { fill: none; stroke: var(--mf-blue); stroke-width: 2; }
.mf-edge text {
  font-size: 11px;
  fill: var(--mf-sub);
  paint-order: stroke;
  stroke: var(--mf-paper);
  stroke-width: 5px;
  stroke-linejoin: round;
}
.mf-edge.warn path { stroke: #a46d13; }
.mf-edge.muted path { stroke: #75869a; stroke-width: 1.4; stroke-dasharray: 5 4; }
.mf-node rect { fill: var(--mf-paper); stroke: var(--mf-line); stroke-width: 1.3; }
.mf-node.main rect { fill: var(--mf-fill); stroke: var(--mf-blue); stroke-width: 2; }
.mf-node.warn rect { fill: #fff8e9; stroke: #a46d13; }
.mf-node.success rect { fill: #eef6f0; stroke: #247a52; }
html.dark .mf-node.warn rect { fill: #3a2f1a; }
html.dark .mf-node.success rect { fill: #17301f; }
.mf-node.muted rect { stroke-dasharray: 5 4; }
.mf-node .mf-title { font-size: 12.5px; font-weight: 600; fill: var(--mf-ink); }
.mf-node .mf-sub { font-size: 11px; fill: var(--mf-sub); }
.mf-description { margin: 0; padding: 12px 20px 16px; font-size: 13px; line-height: 1.7; color: var(--mf-sub); }
</style>
