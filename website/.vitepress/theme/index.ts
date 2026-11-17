import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme-without-fonts';
import { defineAsyncComponent, h } from 'vue';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/tag/style/css';
import 'element-plus/es/components/tabs/style/css';
import 'element-plus/es/components/collapse/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/drawer/style/css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import './style.css';
import './ai-lite-docs.css';
import ProjectsDrawer from './ProjectsDrawer.vue';
import ProjectsNav from './ProjectsNav.vue';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'layout-bottom': () => h(ProjectsDrawer)
    });
  },
  enhanceApp({ app }) {
    // 用途：为 ai-lite 中文文档提供本地 SVG 图解；输入 kind，输出对应调用流程。
    app.component('AiLiteFlow', defineAsyncComponent(() => import('./AiLiteFlow.vue')));
    app.component('MemoryHome', defineAsyncComponent(() => import('./MemoryHome.vue')));
    app.component('ProjectLanding', defineAsyncComponent(() => import('./ProjectLanding.vue')));
    app.component('ProjectCatalog', defineAsyncComponent(() => import('./ProjectCatalog.vue')));
    app.component('ProjectsNav', ProjectsNav);
  }
} satisfies Theme;
