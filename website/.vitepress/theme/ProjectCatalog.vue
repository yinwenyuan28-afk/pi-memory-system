<script setup lang="ts">
import { computed } from 'vue';
import { useData } from 'vitepress';
import { catalogCopy } from '../projects';
import ProjectCards from './ProjectCards.vue';

const { lang } = useData();
const english = computed(() => lang.value === 'en');
const t = computed(() => english.value ? catalogCopy.en : catalogCopy.zh);
</script>

<template>
  <main class="memory-site project-landing">
    <section class="project-hero site-width">
      <div class="product-context"><span class="context-line" />{{ t.eyebrow }}</div>
      <h1>{{ t.title }}</h1>
      <p class="hero-intro">{{ t.intro }}</p>
    </section>
    <section class="more-projects site-width" :aria-label="t.title">
      <ProjectCards />
    </section>
  </main>
</template>
