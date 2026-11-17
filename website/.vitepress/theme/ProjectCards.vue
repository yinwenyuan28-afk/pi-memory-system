<script setup lang="ts">
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';
import { Boxes, FileCode2, Waypoints, ArrowUpRight } from '@lucide/vue';
import { catalogCopy, projectHref, projects, text, type ProjectIcon } from '../projects';
import { closeProjectsDrawer } from './projectsDrawerState';

const { lang } = useData();
const english = computed(() => lang.value === 'en');
const label = computed(() => english.value ? catalogCopy.en.cardLink : catalogCopy.zh.cardLink);
const icons: Record<ProjectIcon, typeof Boxes> = { boxes: Boxes, fileCode: FileCode2, waypoints: Waypoints };
const href = (id: string) => withBase(projectHref(id, english.value));
</script>

<template>
  <div class="project-grid">
    <a v-for="item in projects" :key="item.id" class="project-card" :href="href(item.id)" @click="closeProjectsDrawer">
      <span class="project-icon"><component :is="icons[item.icon]" :size="22" /></span>
      <div class="project-copy">
        <h3>{{ item.name }}</h3>
        <p>{{ text(item.summary, english) }}</p>
        <ul class="project-tags"><li v-for="tag in item.tags" :key="tag">{{ tag }}</li></ul>
        <span class="project-link">{{ label }}<ArrowUpRight :size="16" /></span>
      </div>
    </a>
  </div>
</template>
