<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide } from 'vue';
import { useData, useRouter } from 'vitepress';
import { ElConfigProvider, ElDrawer, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import enLocale from 'element-plus/es/locale/lang/en';
import { catalogCopy } from '../projects';
import { projectsDrawerOpen } from './projectsDrawerState';
import ProjectCards from './ProjectCards.vue';

provide(ID_INJECTION_KEY, { prefix: 7401, current: 0 });
provide(ZINDEX_INJECTION_KEY, { current: 2000 });

const { lang } = useData();
const router = useRouter();
const english = computed(() => lang.value === 'en');
const t = computed(() => english.value ? catalogCopy.en : catalogCopy.zh);
const locale = computed(() => english.value ? enLocale : zhCn);

const previousAfterRouteChange = router.onAfterRouteChange;
onMounted(() => {
  router.onAfterRouteChange = async (to) => {
    projectsDrawerOpen.value = false;
    await previousAfterRouteChange?.(to);
  };
});
onUnmounted(() => {
  router.onAfterRouteChange = previousAfterRouteChange;
});
</script>

<template>
  <ElConfigProvider :locale="locale">
    <ElDrawer
      v-model="projectsDrawerOpen"
      :title="t.navTitle"
      direction="rtl"
      size="min(520px, 100%)"
      class="projects-drawer"
      append-to-body
    >
      <p class="projects-drawer-intro">{{ t.drawerIntro }}</p>
      <ProjectCards class="projects-drawer-cards" />
    </ElDrawer>
  </ElConfigProvider>
</template>
