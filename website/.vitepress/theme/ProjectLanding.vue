<script setup lang="ts">
import { computed } from 'vue';
import AgentCenterNetwork from './AgentCenterNetwork.vue';
import { useData, withBase } from 'vitepress';
import { ElButton } from 'element-plus';
import { ArrowRight, ArrowUpRight, BookOpen } from '@lucide/vue';
import { catalogCopy, projectById, projectHref, text } from '../projects';
import { openProjectsDrawer } from './projectsDrawerState';

const props = defineProps<{ slug: string }>();
const { lang } = useData();
const english = computed(() => lang.value === 'en');
const project = computed(() => projectById(props.slug));
const t = computed(() => english.value ? catalogCopy.en : catalogCopy.zh);
const headline = computed(() => project.value ? (english.value ? project.value.headline.en : project.value.headline.zh) : []);
const page = (docSlug?: string) => project.value ? withBase(projectHref(project.value.id, english.value, docSlug)) : '#';
</script>

<template>
  <main v-if="project" class="memory-site project-landing">
    <section class="project-hero site-width" :class="{ 'agentcenter-hero': slug === 'agentcenter' }" :aria-labelledby="'project-title'">
      <div class="project-hero-copy">
      <button type="button" class="product-context" @click="openProjectsDrawer"><span class="context-line" />{{ t.back }}</button>
      <h1 id="project-title"><span v-for="line in headline" :key="line">{{ line }}</span></h1>
      <p class="hero-intro">{{ text(project.summary, english) }}</p>
      <ul class="project-tags landing-tags"><li v-for="tag in project.tags" :key="tag">{{ tag }}</li></ul>
      <div class="actions">
        <ElButton tag="a" :href="page(project.docs[0].slug)" type="primary" size="large">{{ t.readDocs }}<ArrowRight :size="17" /></ElButton>
        <ElButton tag="a" :href="project.repo" target="_blank" rel="noopener noreferrer" size="large"><ArrowUpRight :size="16" />{{ t.source }}</ElButton>
      </div>
      </div>
      <AgentCenterNetwork v-if="slug === 'agentcenter'" :english="english" />
    </section>

    <section class="outcomes site-width" :aria-label="project.name">
      <article v-for="item in project.outcomes" :key="item.title.zh">
        <BookOpen :size="21" :stroke-width="1.7" />
        <div><h2>{{ text(item.title, english) }}</h2><p>{{ text(item.text, english) }}</p></div>
      </article>
    </section>

    <section class="docs-section site-width section-space">
      <div class="section-heading"><h2>{{ t.docsHeading }}</h2><p>{{ t.docsIntro }}</p></div>
      <div class="docs-grid">
        <a v-for="doc in project.docs" :key="doc.slug" class="doc-entry" :href="page(doc.slug)">
          <BookOpen :size="21" />
          <div><h3>{{ text(doc.title, english) }}</h3><p>{{ text(doc.summary, english) }}</p></div>
          <ArrowRight :size="18" />
        </a>
      </div>
    </section>
  </main>
</template>

<style scoped>
.agentcenter-hero { position: relative; display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); align-items: center; gap: 40px; padding-bottom: 45px; }
.agentcenter-hero > * { min-width: 0; }
.agentcenter-hero .project-hero-copy { position: relative; z-index: 2; }
.agentcenter-hero .hero-intro { max-width: 430px; }
@media (max-width: 900px) {
  .agentcenter-hero { grid-template-columns: minmax(0, 1fr); gap: 28px; }
  .agentcenter-hero .hero-intro { max-width: 600px; }
}
</style>
