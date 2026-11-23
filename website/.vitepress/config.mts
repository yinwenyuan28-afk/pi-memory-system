import { defineConfig } from 'vitepress';
import { projectSidebars } from './projects';

const repo = 'https://github.com/yinwenyuan28-afk/pi-memory-system';
// 用途：中文侧栏按"从整体到细节"的阅读顺序组织；英文侧栏沿用既有页面，避免引用未翻译的新页。
const sidebar = (prefix: string, en = false) => en ? [
  {
    text: 'Start here',
    items: [
      { text: 'Quick start', link: `${prefix}/docs/quickstart` },
      { text: 'Configure recall', link: `${prefix}/docs/recall` }
    ]
  },
  {
    text: 'Understand the system',
    items: [
      { text: 'How memory works', link: `${prefix}/docs/memory` },
      { text: 'Context and progressive loading', link: `${prefix}/docs/context-design` },
      { text: 'Projects and profiles', link: `${prefix}/docs/projects` },
      { text: 'Background work and recovery', link: `${prefix}/docs/pipeline` }
    ]
  },
  {
    text: 'Work with your memory',
    items: [
      { text: 'Inspect and correct', link: `${prefix}/docs/viewer` },
      { text: 'Learn reusable skills', link: `${prefix}/docs/skills` }
    ]
  },
  {
    text: 'Configuration and reference',
    items: [
      { text: 'Configuration guide', link: `${prefix}/docs/configuration` },
      { text: 'Command reference', link: `${prefix}/docs/commands` },
      { text: 'Data, privacy, and backups', link: `${prefix}/docs/data` },
      { text: 'Current limitations', link: `${prefix}/docs/limits` }
    ]
  }
] : [
  {
    text: '开始使用',
    items: [
      { text: '快速开始', link: `${prefix}/docs/quickstart` },
      { text: '整体设计', link: `${prefix}/docs/overview` }
    ]
  },
  {
    text: '理解记忆系统',
    items: [
      { text: '记忆模型', link: `${prefix}/docs/memory-model` },
      { text: '记忆如何工作', link: `${prefix}/docs/memory` },
      { text: '后台流水线', link: `${prefix}/docs/pipeline` },
      { text: '召回与注入', link: `${prefix}/docs/recall` },
      { text: '上下文与渐进式设计', link: `${prefix}/docs/context-design` },
      { text: '工程质量', link: `${prefix}/docs/engineering` },
      { text: '项目归属与记忆空间', link: `${prefix}/docs/projects` }
    ]
  },
  {
    text: '日常使用',
    items: [
      { text: '查看与修正记忆', link: `${prefix}/docs/viewer` },
      { text: '沉淀可复用技能', link: `${prefix}/docs/skills` }
    ]
  },
  {
    text: '配置与参考',
    items: [
      { text: '配置与运行参数', link: `${prefix}/docs/configuration` },
      { text: '常用命令', link: `${prefix}/docs/commands` },
      { text: '数据、隐私与备份', link: `${prefix}/docs/data` },
      { text: '限制与已知问题', link: `${prefix}/docs/limits` }
    ]
  }
];

export default defineConfig({
  title: 'Pi Memory',
  description: '让每次对话都成为下一次工作的起点。',
  cleanUrls: true,
  sitemap: { hostname: 'https://pi-memory.com' },
  srcExclude: ['README.md', '设计方案.md', '文档内容梳理.md', 'design-preview/**', 'agent-content/**'],
  appearance: true,
  markdown: {
    config(md) {
      // 用途：正文开头的「给谁 / 一句话 / 不管 / 状态」等作者备注只留在 Markdown 源文件，不进公开页面。
      md.core.ruler.after('block', 'hide-author-meta', (state) => {
        const isMeta = (text: string) => /^(给谁|一句话|不管|状态|范围|核对|Who this is for|In one sentence|Not here|Checked|Audience|Scope)[:：]/.test(text.trim());
        for (let index = 0; index < state.tokens.length; index++) {
          if (state.tokens[index].type !== 'blockquote_open') continue;
          let end = index + 1;
          let text = '';
          while (end < state.tokens.length && state.tokens[end].type !== 'blockquote_close') {
            if (state.tokens[end].type === 'inline') text += state.tokens[end].content;
            end += 1;
          }
          if (!isMeta(text) || end >= state.tokens.length) continue;
          state.tokens.splice(index, end - index + 1);
          index -= 1;
        }
      });
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const html = fence(tokens, index, options, env, self);
        return env.relativePath?.startsWith('en/') ? html : html.replace('title="Copy Code"', 'title="复制代码"');
      };
      const link = md.renderer.rules.link_open || ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
      md.renderer.rules.link_open = (tokens, index, options, env, self) => {
        const label = tokens[index].attrGet('aria-label');
        if (!env.relativePath?.startsWith('en/') && label?.startsWith('Permalink to ')) {
          tokens[index].attrSet('aria-label', label.replace('Permalink to ', '跳转到 '));
        }
        return link(tokens, index, options, env, self);
      };
    }
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/brand/icon.svg' }],
    ['link', { rel: 'alternate', type: 'text/plain', href: '/llms.txt', title: 'Agent documentation map' }]
  ],
  locales: {
    root: {
      label: '简体中文', lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '产品', link: '/' },
          { text: '工作方式', link: '/#how-it-works' },
          { text: '文档', link: '/docs/quickstart' },
          { component: 'ProjectsNav' }
        ],
        sidebar: { '/docs/': sidebar(''), ...projectSidebars(false) },
        outline: { level: [2, 3], label: '本页内容' },
        docFooter: { prev: '上一篇', next: '下一篇' },
        darkModeSwitchLabel: '外观', lightModeSwitchTitle: '切换为浅色', darkModeSwitchTitle: '切换为深色',
        sidebarMenuLabel: '文档目录', returnToTopLabel: '返回顶部', langMenuLabel: '语言',
        lastUpdatedText: '最近更新', skipToContentLabel: '跳转到正文',
        footer: { message: '让每次对话都成为下一次工作的起点。 · <a href="mailto:email@pi-memory.com">email@pi-memory.com</a>', copyright: 'pi-memory-system · MIT License' }
      }
    },
    en: {
      label: 'English', lang: 'en', description: 'Give your next Pi session a head start.',
      themeConfig: {
        nav: [
          { text: 'Product', link: '/en/' },
          { text: 'How it works', link: '/en/#how-it-works' },
          { text: 'Docs', link: '/en/docs/quickstart' },
          { component: 'ProjectsNav' }
        ],
        sidebar: { '/en/docs/': sidebar('/en', true), ...projectSidebars(true) },
        outline: { level: [2, 3], label: 'On this page' },
        footer: { message: 'Give your next session a head start. · <a href="mailto:email@pi-memory.com">email@pi-memory.com</a>', copyright: 'pi-memory-system · MIT License' }
      }
    }
  },
  themeConfig: {
    logo: '/brand/icon.svg', siteTitle: 'Pi Memory',
    socialLinks: [{ icon: 'github', link: repo }],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '没有找到相关内容', resetButtonTitle: '清空搜索',
                backButtonTitle: '关闭搜索', displayDetails: '显示详细结果',
                footer: { selectText: '选择', selectKeyAriaLabel: '回车', navigateText: '切换', navigateUpKeyAriaLabel: '上箭头', navigateDownKeyAriaLabel: '下箭头', closeText: '关闭', closeKeyAriaLabel: 'Esc' }
              }
            }
          }
        }
      }
    }
  },
  vite: {
    ssr: { noExternal: ['element-plus'] },
    optimizeDeps: {
      include: [
        'element-plus', '@lucide/vue',
        'element-plus/es/locale/lang/zh-cn', 'element-plus/es/locale/lang/en',
        ...['button', 'segmented', 'tag', 'tabs', 'collapse', 'dialog', 'drawer'].map(name => `element-plus/es/components/${name}/style/css`)
      ]
    }
  }
});
