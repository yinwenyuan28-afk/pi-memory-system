<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElButton } from 'element-plus';
import { Check, Layers, Pause, Play, RotateCcw } from '@lucide/vue';

const props = defineProps<{ english: boolean }>();
const text = computed(() => props.english ? {
  title: 'Remember a method. Use it again.', previous: 'Previous session', next: 'New session',
  user: 'You', agent: 'Pi agent', first: 'Keep the method', second: 'Use it again',
  before: 'For payment callbacks, check the order ID, then the signature, then the idempotency record.',
  acknowledgement: 'Got it. Let’s follow that order.',
  saved: 'Method saved in the background', memory: 'Order ID → signature → idempotency',
  question: 'Another duplicate callback. How do we investigate?', recalled: 'Relevant method retrieved',
  answer: 'Let’s use our previous approach:\n1. Compare the order ID\n2. Verify the signature\n3. Inspect the idempotency record',
  pause: 'Pause', play: 'Continue', replay: 'Replay',
} : {
  title: '方法记一次，下次接着用。', previous: '上一次会话', next: '新会话',
  user: '你', agent: 'Pi agent', first: '记下方法', second: '再次用上',
  before: '排查支付回调时，先对照订单号，再检查签名和幂等记录。',
  acknowledgement: '好，这次按这个顺序排查。',
  saved: '后台整理，方法已记下', memory: '订单号 → 签名 → 幂等记录',
  question: '又出现一笔重复回调，怎么查？', recalled: '找回了相关的排查方法',
  answer: '沿用我们之前的排查顺序：\n1. 对照订单号\n2. 检查签名\n3. 查看幂等记录',
  pause: '暂停', play: '继续播放', replay: '重播',
});

const panel = ref<HTMLElement>();
const elapsed = ref(0);
const paused = ref(false);
const inView = ref(true);
const pageVisible = ref(true);
const reducedMotion = ref(false);
const nextSession = computed(() => elapsed.value >= 7300);
const userStart = computed(() => nextSession.value ? 7900 : 600);
const userEnd = computed(() => nextSession.value ? 9050 : 1800);
const agentStart = computed(() => nextSession.value ? 10400 : 2900);
const agentEnd = computed(() => nextSession.value ? 12600 : 3800);
const userText = computed(() => nextSession.value ? text.value.question : text.value.before);
const agentText = computed(() => nextSession.value ? text.value.answer : text.value.acknowledgement);
const cueVisible = computed(() => nextSession.value ? elapsed.value >= 9750 : elapsed.value >= 4600);
const typing = computed(() => elapsed.value >= agentStart.value - 800 && elapsed.value < agentStart.value);

function reveal(message: string, start: number, end: number) {
  const progress = Math.max(0, Math.min(1, (elapsed.value - start) / (end - start)));
  return Array.from(message).slice(0, Math.ceil(Array.from(message).length * progress)).join('');
}
const visibleUser = computed(() => reveal(userText.value, userStart.value, userEnd.value));
const visibleAgent = computed(() => reveal(agentText.value, agentStart.value, agentEnd.value));

let timer: ReturnType<typeof setInterval> | undefined;
let observer: IntersectionObserver | undefined;
let motionPreference: MediaQueryList | undefined;

function syncPlayback() {
  clearInterval(timer);
  timer = undefined;
  if (paused.value || !inView.value || !pageVisible.value || reducedMotion.value) return;
  timer = setInterval(() => {
    elapsed.value = elapsed.value >= 19500 ? 0 : elapsed.value + 50;
  }, 50);
}
function updateVisibility() { pageVisible.value = !document.hidden; }
function updateMotion() {
  reducedMotion.value = Boolean(motionPreference?.matches);
  if (reducedMotion.value) elapsed.value = 16000;
}
function replay() {
  // Show the complete example when the visitor prefers reduced motion.
  elapsed.value = reducedMotion.value ? 16000 : 0;
  paused.value = false;
}
watch([paused, inView, pageVisible, reducedMotion], syncPlayback);
watch(() => props.english, replay);

onMounted(() => {
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  updateMotion();
  updateVisibility();
  motionPreference.addEventListener('change', updateMotion);
  document.addEventListener('visibilitychange', updateVisibility);
  observer = new IntersectionObserver(([entry]) => { inView.value = entry.isIntersecting; }, { threshold: 0.15 });
  if (panel.value) observer.observe(panel.value);
  syncPlayback();
});
onUnmounted(() => {
  clearInterval(timer);
  observer?.disconnect();
  motionPreference?.removeEventListener('change', updateMotion);
  document.removeEventListener('visibilitychange', updateVisibility);
});
</script>

<template>
  <section ref="panel" class="memory-demo chat-demo" :aria-label="text.title">
    <div class="demo-heading"><strong>{{ text.title }}</strong></div>
    <div class="chat-session"><span class="chat-status-dot" /><span>{{ nextSession ? text.next : text.previous }}</span><span class="chat-session-number">{{ nextSession ? '02' : '01' }} / 02</span></div>

    <div class="chat-stage" :aria-label="nextSession ? text.next : text.previous">
      <div :key="nextSession ? 'next' : 'previous'" class="chat-transcript">
        <div class="chat-message chat-user" :class="{ 'is-visible': elapsed >= userStart }">
          <span class="chat-speaker">{{ text.user }}</span>
          <p class="chat-bubble">{{ visibleUser }}<span v-if="elapsed < userEnd" class="chat-caret" aria-hidden="true" /></p>
        </div>

        <div v-if="nextSession" class="chat-recall" :class="{ 'is-visible': cueVisible }"><Layers :size="13" /><span>{{ text.recalled }}</span></div>

        <div class="chat-message chat-agent" :class="{ 'is-visible': typing || elapsed >= agentStart }">
          <span class="chat-speaker"><span class="chat-avatar">π</span>{{ text.agent }}</span>
          <p v-if="typing" class="chat-bubble chat-typing" :aria-label="english ? 'Pi is typing' : 'Pi 正在输入'"><i /><i /><i /></p>
          <p v-else class="chat-bubble">{{ visibleAgent }}<span v-if="elapsed < agentEnd" class="chat-caret" aria-hidden="true" /></p>
        </div>

        <div v-if="!nextSession" class="chat-saved" :class="{ 'is-visible': cueVisible }"><span class="chat-saved-label"><Check :size="14" />{{ text.saved }}</span><span>{{ text.memory }}</span></div>
      </div>
    </div>

    <div class="chat-controls">
      <div class="chat-chapters" :aria-label="english ? 'Demo stages' : '演示步骤'"><span :class="{ active: !nextSession }">{{ text.first }}</span><span :class="{ active: nextSession }">{{ text.second }}</span></div>
      <div class="chat-buttons">
        <ElButton v-if="!reducedMotion" text size="small" :aria-label="paused ? text.play : text.pause" :title="paused ? text.play : text.pause" @click="paused = !paused"><Play v-if="paused" :size="15" /><Pause v-else :size="15" /></ElButton>
        <ElButton text size="small" :aria-label="text.replay" :title="text.replay" @click="replay"><RotateCcw :size="15" /></ElButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-demo { min-width: 0; }
.chat-session { display: flex; align-items: center; gap: 8px; padding-block: 12px; border-block: 1px solid var(--site-border); color: var(--site-muted); font-size: 12px; }
.chat-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--site-brand); }
.chat-session-number { margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; }
.chat-stage { height: 288px; padding-block: 8px; }
.chat-transcript { display: flex; flex-direction: column; gap: 18px; }
.chat-message { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; visibility: hidden; opacity: 0; transform: translateY(6px); transition: opacity .3s ease, transform .3s ease; }
.chat-message.is-visible { visibility: visible; opacity: 1; transform: none; }
.chat-speaker { display: flex; align-items: center; gap: 6px; color: var(--site-muted); font-size: 11px; }
.chat-avatar { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 5px; color: var(--site-brand); background: var(--site-soft); font-weight: 650; }
.chat-message .chat-bubble { max-width: 88%; min-height: 40px; padding: 11px 14px; border: 1px solid var(--site-border); border-radius: 3px 13px 13px; background: var(--site-bg); color: var(--site-ink); font-size: 13px; line-height: 1.8; white-space: pre-line; overflow-wrap: anywhere; text-align: left; }
.chat-user { align-items: flex-end; }
.chat-user .chat-bubble { border-radius: 13px 3px 13px 13px; background: var(--site-soft); border-color: color-mix(in srgb, var(--site-brand) 25%, var(--site-border)); }
.chat-caret { display: inline-block; width: 2px; height: 1em; vertical-align: -.12em; background: var(--site-brand); animation: caret-blink 1s step-end infinite; margin-left: 2px; }
.chat-recall, .chat-saved { visibility: hidden; opacity: 0; transition: opacity .4s ease; }
.chat-recall.is-visible, .chat-saved.is-visible { visibility: visible; opacity: 1; }
.chat-recall { display: flex; align-items: center; justify-content: center; gap: 6px; margin-block: -4px; font-size: 11px; color: var(--site-brand); }
.chat-saved { display: flex; flex-direction: column; align-items: center; gap: 5px; margin-top: 6px; padding-top: 16px; border-top: 1px dashed var(--site-border); font-size: 11px; color: var(--site-muted); }
.chat-saved-label { display: flex; align-items: center; gap: 6px; color: var(--site-brand); }
.chat-message .chat-typing { display: flex; gap: 5px; align-items: center; height: 42px; }
.chat-typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--site-muted); animation: typing-pulse 1s ease-in-out infinite; }
.chat-typing i:nth-child(2) { animation-delay: .15s; }
.chat-typing i:nth-child(3) { animation-delay: .3s; }
.chat-controls { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 12px; border-top: 1px solid var(--site-border); }
.chat-chapters { display: flex; gap: 12px; color: var(--site-muted); font-size: 11px; }
.chat-chapters > span { display: flex; align-items: center; gap: 5px; }
.chat-chapters > span::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--site-border); }
.chat-chapters > .active { color: var(--site-brand); }
.chat-chapters > .active::before { background: currentColor; }
.chat-buttons { display: flex; gap: 4px; }
.chat-buttons .el-button { width: 30px; height: 30px; padding: 0; color: var(--site-muted); }
@keyframes caret-blink { 50% { opacity: 0; } }
@keyframes typing-pulse { 50% { opacity: .35; transform: translateY(-2px); } }
@media (min-width: 1244px) {
  .chat-demo { width: calc(100% + 25vw - 295px); }
}
@media (max-width: 1100px) and (min-width: 801px), (max-width: 480px) {
  .chat-stage { height: 330px; padding-block: 8px; }
  .chat-message .chat-bubble { max-width: 95%; font-size: 12px; padding: 10px 12px; }
  .chat-transcript { gap: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before { animation: none !important; transition: none !important; }
}
</style>
