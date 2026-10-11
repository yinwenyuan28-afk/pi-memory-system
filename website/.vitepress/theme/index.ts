import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme-without-fonts';
import { defineAsyncComponent } from 'vue';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/segmented/style/css';
import 'element-plus/es/components/tag/style/css';
import 'element-plus/es/components/tabs/style/css';
import 'element-plus/es/components/collapse/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('MemoryHome', defineAsyncComponent(() => import('./MemoryHome.vue')));
  }
} satisfies Theme;
