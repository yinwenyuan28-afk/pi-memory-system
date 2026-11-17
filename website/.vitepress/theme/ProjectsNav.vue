<script setup lang="ts">
import { computed, inject } from 'vue';
import { useData } from 'vitepress';
import { catalogCopy } from '../projects';
import { openProjectsDrawer } from './projectsDrawerState';

defineProps<{
  screenMenu?: boolean;
}>();

const { lang } = useData();
const english = computed(() => lang.value === 'en');
const label = computed(() => english.value ? catalogCopy.en.navTitle : catalogCopy.zh.navTitle);
const closeScreen = inject('close-screen', null) as (() => void) | null;

function open() {
  closeScreen?.();
  openProjectsDrawer();
}
</script>

<template>
  <button
    type="button"
    class="projects-nav-trigger"
    :class="{ 'is-screen': screenMenu }"
    @click="open"
  >
    {{ label }}
  </button>
</template>

<style scoped>
.projects-nav-trigger {
  display: flex;
  align-items: center;
  padding: 0 12px;
  line-height: var(--vp-nav-height);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: color 0.25s;
}

.projects-nav-trigger:hover {
  color: var(--vp-c-brand-1);
}

.projects-nav-trigger.is-screen {
  display: block;
  width: 100%;
  padding: 12px 0 11px;
  line-height: 24px;
  text-align: left;
  border-bottom: 1px solid var(--vp-c-divider);
}
</style>
