<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

// 用途：AgentCenter 首屏静态背景。主节点扇形连线，相邻射线之间交替填浅/深色块。
defineProps<{ english: boolean }>();

const SHIFT_X = 40;
const ICON = 20;

const NODES = [
  { x: 0.18, y: 0.10, icon: 'claude' },
  { x: 0.48, y: 0.56, icon: 'openai' },
  { x: 0.28, y: 0.90, icon: 'gemini' },
  { x: 0.46, y: 0.10, icon: 'deepseek' },
  { x: 0.52, y: 0.84, icon: 'cursor' },
  { x: 0.66, y: 0.06, icon: 'pi' },
  { x: 0.86, y: 0.12, icon: 'zed' },
  { x: 0.95, y: 0.36, icon: 'grok' },
  { x: 0.94, y: 0.64, icon: 'kimi' },
  { x: 0.84, y: 0.90, icon: 'opencode' },
  { x: 0.66, y: 0.92, icon: 'minimax' }
];

const stageRef = ref<HTMLElement>();
const frame = ref({ w: 1000, h: 560, hx: 820, hy: 280 });

const placed = computed(() => {
  const box = frame.value;
  return NODES.map(node => ({
    x: node.x * box.w + SHIFT_X,
    y: node.y * box.h,
    icon: node.icon,
    href: `/agents/${node.icon}.svg`
  }));
});

const wedges = computed(() => {
  const box = frame.value;
  const sorted = placed.value
    .map(node => ({
      angle: Math.atan2(node.y - box.hy, node.x - box.hx)
    }))
    .sort((a, b) => a.angle - b.angle);
  if (sorted.length < 2) return [];
  const reach = Math.hypot(box.w, box.h) * 1.35;
  return sorted.map((item, index) => {
    const next = sorted[(index + 1) % sorted.length];
    const ax = box.hx + Math.cos(item.angle) * reach;
    const ay = box.hy + Math.sin(item.angle) * reach;
    const bx = box.hx + Math.cos(next.angle) * reach;
    const by = box.hy + Math.sin(next.angle) * reach;
    return {
      points: `${box.hx},${box.hy} ${ax},${ay} ${bx},${by}`,
      tone: index % 2 === 0 ? 'a' : 'b'
    };
  });
});

function spoke(node: { x: number; y: number }) {
  const box = frame.value;
  const dx = node.x - box.hx;
  const dy = node.y - box.hy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tip = ICON * 0.62;
  return {
    x1: box.hx + ux * 20,
    y1: box.hy + uy * 20,
    x2: node.x - ux * tip,
    y2: node.y - uy * tip
  };
}

function measure() {
  const stage = stageRef.value;
  const hero = stage?.closest('.agentcenter-hero') as HTMLElement | null;
  if (!stage || !hero) return;
  const hb = hero.getBoundingClientRect();
  const sb = stage.getBoundingClientRect();
  if (hb.width < 20 || hb.height < 20) return;
  const fx = sb.left - hb.left;
  const fy = sb.top - hb.top;
  frame.value = {
    w: hb.width,
    h: hb.height,
    hx: fx + sb.width * 0.70 + SHIFT_X,
    hy: fy + sb.height * 0.50
  };
}

let observer: ResizeObserver | undefined;
onMounted(() => {
  measure();
  const hero = stageRef.value?.closest('.agentcenter-hero');
  observer = new ResizeObserver(() => measure());
  if (hero) observer.observe(hero);
  if (stageRef.value) observer.observe(stageRef.value);
});
onUnmounted(() => observer?.disconnect());
</script>

<template>
  <figure class="agent-network">
    <svg
      class="network-rays"
      :viewBox="`0 0 ${frame.w} ${frame.h}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <clipPath id="ac-hero-clip">
          <rect x="0" y="0" :width="frame.w" :height="frame.h" />
        </clipPath>
        <linearGradient id="ac-wedge-fade" gradientUnits="userSpaceOnUse" :x1="0" y1="0" :x2="frame.w * 0.62" y2="0">
          <stop offset="0%" stop-color="#fff" stop-opacity="0" />
          <stop offset="48%" stop-color="#fff" stop-opacity="0" />
          <stop offset="78%" stop-color="#fff" stop-opacity="1" />
          <stop offset="100%" stop-color="#fff" stop-opacity="1" />
        </linearGradient>
        <mask id="ac-wedge-mask" maskUnits="userSpaceOnUse">
          <rect x="0" y="0" :width="frame.w" :height="frame.h" fill="url(#ac-wedge-fade)" />
        </mask>
        <linearGradient id="ac-line-fade" gradientUnits="userSpaceOnUse" :x1="0" y1="0" :x2="frame.w * 0.42" y2="0">
          <stop offset="0%" stop-color="#fff" stop-opacity="0.12" />
          <stop offset="55%" stop-color="#fff" stop-opacity="0.55" />
          <stop offset="100%" stop-color="#fff" stop-opacity="1" />
        </linearGradient>
        <mask id="ac-line-mask" maskUnits="userSpaceOnUse">
          <rect x="0" y="0" :width="frame.w" :height="frame.h" fill="url(#ac-line-fade)" />
        </mask>
      </defs>
      <g clip-path="url(#ac-hero-clip)" mask="url(#ac-wedge-mask)">
        <polygon
          v-for="(wedge, index) in wedges"
          :key="`w${index}`"
          class="wedge"
          :class="`wedge-${wedge.tone}`"
          :points="wedge.points"
        />
      </g>
      <g class="page-ink" fill="none" stroke-linecap="round" mask="url(#ac-line-mask)">
        <line v-for="(node, index) in placed" :key="`l${index}`" :x1="spoke(node).x1" :y1="spoke(node).y1" :x2="spoke(node).x2" :y2="spoke(node).y2" />
      </g>
      <g>
        <image
          v-for="(node, index) in placed"
          :key="`i${index}`"
          class="node-icon"
          :href="node.href"
          :x="node.x - ICON / 2"
          :y="node.y - ICON / 2"
          :width="ICON"
          :height="ICON"
        />
      </g>
      <g class="hub">
        <circle :cx="frame.hx" :cy="frame.hy" r="17" fill="var(--site-bg)" />
        <circle :cx="frame.hx" :cy="frame.hy" r="17" fill="none" stroke="var(--page-hub)" stroke-width="2.8" />
        <circle :cx="frame.hx" :cy="frame.hy" r="4" fill="var(--page-hub)" />
      </g>
    </svg>
    <div ref="stageRef" class="network-stage" role="img" :aria-label="english ? 'A core node linked to agent icons around the headline.' : '主节点连到散在文字周围的 Agent 图标。'">
      <svg class="network-card" viewBox="0 0 600 440" aria-hidden="true">
        <g class="card-wedges">
          <polygon class="wedge wedge-a" points="420,220 210,70 90,250" />
          <polygon class="wedge wedge-b" points="420,220 90,250 180,370" />
          <polygon class="wedge wedge-a" points="420,220 180,370 390,390" />
          <polygon class="wedge wedge-b" points="420,220 390,390 500,380" />
          <polygon class="wedge wedge-a" points="420,220 500,380 555,280" />
          <polygon class="wedge wedge-b" points="420,220 555,280 560,150" />
          <polygon class="wedge wedge-a" points="420,220 560,150 520,70" />
          <polygon class="wedge wedge-b" points="420,220 520,70 430,45" />
          <polygon class="wedge wedge-a" points="420,220 430,45 300,55" />
          <polygon class="wedge wedge-b" points="420,220 300,55 210,70" />
        </g>
        <g fill="none" stroke="var(--page-hub)" stroke-width="1.8" stroke-linecap="round" opacity="0.85">
          <line x1="420" y1="220" x2="210" y2="70" />
          <line x1="420" y1="220" x2="90" y2="250" />
          <line x1="420" y1="220" x2="180" y2="370" />
          <line x1="420" y1="220" x2="300" y2="55" />
          <line x1="420" y1="220" x2="330" y2="340" />
          <line x1="420" y1="220" x2="430" y2="45" />
          <line x1="420" y1="220" x2="520" y2="70" />
          <line x1="420" y1="220" x2="560" y2="150" />
          <line x1="420" y1="220" x2="555" y2="280" />
          <line x1="420" y1="220" x2="500" y2="380" />
          <line x1="420" y1="220" x2="390" y2="390" />
        </g>
        <g class="card-icons">
          <image href="/agents/claude.svg" x="198" y="58" width="20" height="20" />
          <image href="/agents/openai.svg" x="78" y="238" width="20" height="20" />
          <image href="/agents/gemini.svg" x="168" y="358" width="20" height="20" />
          <image href="/agents/deepseek.svg" x="288" y="43" width="20" height="20" />
          <image href="/agents/cursor.svg" x="318" y="328" width="20" height="20" />
          <image href="/agents/pi.svg" x="418" y="33" width="20" height="20" />
          <image href="/agents/zed.svg" x="508" y="58" width="20" height="20" />
          <image href="/agents/grok.svg" x="548" y="138" width="20" height="20" />
          <image href="/agents/kimi.svg" x="543" y="268" width="20" height="20" />
          <image href="/agents/opencode.svg" x="488" y="368" width="20" height="20" />
          <image href="/agents/minimax.svg" x="378" y="378" width="20" height="20" />
        </g>
        <circle cx="420" cy="220" r="15" fill="var(--site-bg)" />
        <circle cx="420" cy="220" r="16" fill="none" stroke="var(--page-hub)" stroke-width="2.6" />
        <circle cx="420" cy="220" r="3.8" fill="var(--page-hub)" />
      </svg>
    </div>
  </figure>
</template>

<style scoped>
.agent-network {
  margin: 0;
  min-width: 0;
  max-width: 100%;
  color: var(--site-ink);
  --page-stroke: rgba(45, 58, 68, 0.5);
  --page-hub: #2D3A44;
  --wedge-a: rgba(45, 58, 68, 0.028);
  --wedge-b: rgba(45, 58, 68, 0.11);
}
.network-rays {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
.wedge-a { fill: var(--wedge-a); }
.wedge-b { fill: var(--wedge-b); }
.page-ink { stroke: var(--page-stroke); stroke-width: 1.45; }
.node-icon,
.card-icons image {
  filter: brightness(0);
  opacity: 0.72;
}
.network-stage {
  position: relative;
  z-index: 0;
  width: 100%;
  aspect-ratio: 600 / 440;
}
.network-card { display: none; position: absolute; inset: 0; width: 100%; height: 100%; }
@media (max-width: 900px) {
  .network-rays { display: none; }
  .network-card { display: block; }
}
</style>

<style>
html.dark .agent-network {
  --page-stroke: rgba(229, 238, 232, 0.38);
  --page-hub: rgba(230, 238, 233, 0.92);
  --wedge-a: rgba(229, 238, 232, 0.025);
  --wedge-b: rgba(229, 238, 232, 0.11);
}
html.dark .agent-network .node-icon,
html.dark .agent-network .card-icons image {
  filter: brightness(0) invert(1);
  opacity: 0.78;
}
</style>
