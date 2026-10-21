<script setup lang="ts">
import { computed, onUnmounted, provide, ref } from 'vue';
import { useData, withBase } from 'vitepress';
import { ElButton, ElCollapse, ElCollapseItem, ElConfigProvider, ElDialog, ElTabPane, ElTabs, ElTag, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import enLocale from 'element-plus/es/locale/lang/en';
import { ArrowRight, ArrowUpRight, BookOpen, Boxes, Check, ChevronRight, Copy, FileCode2, GitBranch, Layers as Layers3, Mail, MessageSquare, Monitor, Play, Search, ShieldCheck, Terminal } from '@lucide/vue';
import { copy, otherRepositories, repository } from './content';
import ConversationDemo from './ConversationDemo.vue';

const { lang } = useData();
provide(ID_INJECTION_KEY, { prefix: 7301, current: 0 });
provide(ZINDEX_INJECTION_KEY, { current: 0 });
const english = computed(() => lang.value === 'en');
const t = computed(() => english.value ? copy.en : copy.zh);
const selectedFeature = ref('records');
const feature = computed(() => t.value.features.find(item => item.id === selectedFeature.value) || t.value.features[0]);
const icons = { message: MessageSquare, search: Search, shield: ShieldCheck, terminal: Terminal, layers: Layers3 };
const docLink = (slug: string) => withBase(`${english.value ? '/en' : ''}/docs/${slug}`);
const videoOpen = ref(false);
const locale = computed(() => english.value ? enLocale : zhCn);
const videoPath = computed(() => withBase(`/media/promo-${english.value ? 'en' : 'zh'}.mp4`));
const posterPath = computed(() => withBase(`/media/poster-${english.value ? 'en' : 'zh'}.jpg`));
const installCommand = 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.83.0\npi install npm:pi-memory-system';
const copied = ref(false);
const copyError = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;
async function copyInstall() {
  try {
    await navigator.clipboard.writeText(installCommand);
    copied.value = true;
    copyError.value = false;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => copied.value = false, 2500);
  } catch {
    copyError.value = true;
  }
}
onUnmounted(() => clearTimeout(copyTimer));
</script>

<template>
  <ElConfigProvider :locale="locale">
    <main class="memory-site">
      <section class="hero site-width" aria-labelledby="hero-title">
        <div class="hero-copy">
          <div class="product-context"><span class="context-line" />{{ t.forPi }}</div>
          <h1 id="hero-title"><span v-for="line in t.headline" :key="line">{{ line }}</span></h1>
          <p class="hero-intro">{{ t.intro }}</p>
          <div class="actions">
            <ElButton tag="a" :href="docLink('quickstart')" type="primary" size="large">{{ t.start }}<ArrowRight :size="17" /></ElButton>
            <ElButton size="large" @click="videoOpen = true"><Play :size="16" />{{ t.watch }}</ElButton>
          </div>
          <div class="compatibility"><span><Monitor :size="14" />{{ t.windows }}</span><span>{{ t.node }}</span></div>
        </div>

        <ConversationDemo :english="english" />
      </section>

      <section class="outcomes site-width" :aria-label="english ? 'What changes for you' : '用户收益'">
        <article v-for="outcome in t.outcomes" :key="outcome.title">
          <component :is="icons[outcome.icon as keyof typeof icons]" :size="21" :stroke-width="1.7" />
          <div><h2>{{ outcome.title }}</h2><p>{{ outcome.text }}</p></div>
        </article>
      </section>

      <section id="how-it-works" class="workflow-section section-space">
        <div class="site-width">
          <div class="section-heading"><h2>{{ t.workflowTitle }}</h2><p>{{ t.workflowIntro }}</p></div>
          <div class="workflow">
            <article v-for="(step, index) in t.workflow" :key="step.title" class="workflow-step">
              <span class="step-index">{{ index + 1 }}</span>
              <h3>{{ step.title }}</h3><p>{{ step.text }}</p><span class="step-meta">{{ step.meta }}</span>
              <ArrowRight v-if="index < 2" class="step-arrow" :size="22" />
            </article>
          </div>
          <div class="workflow-branch"><GitBranch :size="20" /><p>{{ t.branch }}</p><a :href="docLink('memory')">{{ t.branchLink }}<ChevronRight :size="16" /></a></div>
        </div>
      </section>

      <section class="features site-width section-space">
        <div class="section-heading"><h2>{{ t.featuresTitle }}</h2><p>{{ t.featuresIntro }}</p></div>
        <ElTabs v-model="selectedFeature" class="feature-tabs">
          <ElTabPane v-for="item in t.features" :key="item.id" :label="item.label" :name="item.id" />
        </ElTabs>
        <div class="feature-content" aria-live="polite">
          <div class="feature-copy"><h3>{{ feature.heading }}</h3><p>{{ feature.text }}</p><a class="text-link" :href="docLink(feature.doc)">{{ feature.link }}<ArrowRight :size="17" /></a></div>
          <div class="viewer-preview">
            <div class="viewer-heading"><Layers3 :size="18" /><strong>{{ feature.panelTitle }}</strong><span>{{ feature.panelCaption }}</span></div>
            <table><thead><tr><th v-for="column in feature.columns" :key="column">{{ column }}</th></tr></thead><tbody><tr v-for="(row, index) in feature.rows" :key="index"><td>{{ row[0] }}</td><td>{{ row[1] }}</td><td><ElTag :type="index === 1 && feature.id === 'records' ? 'success' : 'info'" effect="plain" size="small">{{ row[2] }}</ElTag></td></tr></tbody></table>
            <div class="viewer-foot"><ShieldCheck :size="15" />{{ feature.foot }}</div>
          </div>
        </div>
      </section>

      <section class="film site-width">
        <div class="film-copy"><span class="film-icon"><Play :size="22" /></span><h2>{{ t.filmTitle }}</h2><p>{{ t.filmText }}</p><ElButton size="large" @click="videoOpen = true"><Play :size="15" />{{ t.filmButton }}</ElButton><span class="film-duration">{{ t.filmDuration }}</span></div>
        <button class="film-poster" :aria-label="t.filmButton" @click="videoOpen = true"><img :src="posterPath" :alt="t.filmTitle" loading="lazy" width="1920" height="1080" /><span class="play-circle"><Play :size="26" fill="currentColor" /></span></button>
      </section>

      <section class="docs-section site-width section-space">
        <div class="section-heading"><h2>{{ t.docsTitle }}</h2><p>{{ t.docsIntro }}</p></div>
        <div class="docs-grid"><a v-for="item in t.docs" :key="item.slug" :href="docLink(item.slug)" class="doc-entry"><component :is="icons[item.icon as keyof typeof icons]" :size="21" /><div><h3>{{ item.title }}</h3><p>{{ item.desc }}</p></div><ArrowRight :size="18" /></a></div>
        <div class="install-snippet"><div class="install-heading"><Terminal :size="16" /><span>{{ t.installLabel }}</span><ElButton size="small" :aria-label="t.copy" @click="copyInstall"><Check v-if="copied" :size="14" /><Copy v-else :size="14" />{{ copied ? t.copied : t.copy }}</ElButton></div><pre><code>{{ installCommand }}</code></pre><p>{{ t.installNote }}</p><p v-if="copyError" class="copy-error" role="alert">{{ t.copyFailed }}</p></div>
      </section>

      <section class="faq site-width section-space">
        <div class="faq-intro"><h2>{{ t.faqTitle }}</h2><p>{{ t.faqIntro }}</p></div>
        <ElCollapse class="faq-list" accordion>
          <ElCollapseItem v-for="(item, index) in t.faqs" :key="item.question" :name="index">
            <template #title><span class="faq-question">{{ item.question }}</span></template>
            <p>{{ item.answer }}</p>
          </ElCollapseItem>
        </ElCollapse>
      </section>

      <section class="final-cta site-width" aria-labelledby="final-title">
        <div class="final-main">
          <img :src="withBase('/brand/icon.svg')" alt="" width="56" height="56" />
          <div class="final-copy"><span>{{ t.contributeEyebrow }}</span><h2 id="final-title">{{ t.finalTitle }}</h2><p>{{ t.finalText }}</p></div>
        </div>
        <div class="actions final-actions">
          <ElButton tag="a" :href="docLink('quickstart')" type="primary" size="large">{{ t.start }}<ArrowRight :size="17" /></ElButton>
          <ElButton tag="a" :href="repository" target="_blank" rel="noopener noreferrer" size="large"><GitBranch :size="17" />{{ t.contributeCode }}</ElButton>
        </div>
      </section>

      <section class="more-projects site-width" :aria-labelledby="'more-projects-title'">
        <div class="more-heading">
          <span class="more-eyebrow">{{ t.otherProjects.eyebrow }}</span>
          <h2 id="more-projects-title">{{ t.otherProjects.title }}</h2>
        </div>
        <div class="project-grid">
          <a v-for="item in t.otherProjects.items" :key="item.id" class="project-card" :href="otherRepositories[item.id]" target="_blank" rel="noopener noreferrer">
            <span class="project-icon"><component :is="item.id === 'cursor-encoding-fix' ? FileCode2 : Boxes" :size="22" /></span>
            <div class="project-copy">
              <h3>{{ item.title }}</h3>
              <p>{{ item.text }}</p>
              <ul class="project-tags"><li v-for="tag in item.tags" :key="tag">{{ tag }}</li></ul>
              <span class="project-link">{{ t.otherProjects.link }}<ArrowUpRight :size="16" /></span>
            </div>
          </a>
        </div>
      </section>

      <nav class="home-footer site-width" :aria-label="english ? 'Footer links' : '页脚链接'"><a :href="docLink('quickstart')"><BookOpen :size="15" />{{ t.footerDocs }}</a><a :href="docLink('limits')">{{ t.footerData }}</a><a :href="`${repository}/issues`" target="_blank" rel="noopener noreferrer">{{ t.footerIssue }}</a><a href="mailto:email@pi-memory.com"><Mail :size="15" />email@pi-memory.com</a></nav>
    </main>

    <ElDialog v-model="videoOpen" :title="t.dialogTitle" class="promo-dialog" width="960px" align-center destroy-on-close>
      <video :key="videoPath" controls playsinline preload="none" :poster="posterPath" :src="videoPath" :aria-label="t.dialogTitle" />
    </ElDialog>
  </ElConfigProvider>
</template>
