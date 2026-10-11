import { defineConfig } from 'vitepress';

const repo = 'https://github.com/yinwenyuan28-afk/pi-memory-system';
const sidebar = (prefix: string, en = false) => [
  {
    text: en ? 'Start here' : '开始使用',
    items: [
      { text: en ? 'Quick start' : '快速开始', link: `${prefix}/docs/quickstart` },
      { text: en ? 'How memory works' : '记忆如何工作', link: `${prefix}/docs/memory` },
      { text: en ? 'Configure recall' : '配置语义召回', link: `${prefix}/docs/recall` }
    ]
  },
  {
    text: en ? 'Work with your memory' : '日常使用',
    items: [
      { text: en ? 'Inspect and correct' : '查看与修正记忆', link: `${prefix}/docs/viewer` },
      { text: en ? 'Learn reusable skills' : '沉淀可复用技能', link: `${prefix}/docs/skills` },
      { text: en ? 'Limits and data handling' : '限制与数据说明', link: `${prefix}/docs/limits` }
    ]
  }
];

export default defineConfig({
  title: 'Pi Memory',
  description: '让每次对话都成为下一次工作的起点。',
  cleanUrls: true,
  srcExclude: ['README.md', '设计方案.md', 'design-preview/**'],
  appearance: true,
  markdown: {
    config(md) {
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
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/brand/icon.svg' }]],
  locales: {
    root: {
      label: '简体中文', lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '产品', link: '/' },
          { text: '工作方式', link: '/#how-it-works' },
          { text: '文档', link: '/docs/quickstart' }
        ],
        sidebar: { '/docs/': sidebar('') },
        outline: { level: [2, 3], label: '本页内容' },
        docFooter: { prev: '上一篇', next: '下一篇' },
        darkModeSwitchLabel: '外观', lightModeSwitchTitle: '切换为浅色', darkModeSwitchTitle: '切换为深色',
        sidebarMenuLabel: '文档目录', returnToTopLabel: '返回顶部', langMenuLabel: '语言',
        lastUpdatedText: '最近更新', skipToContentLabel: '跳转到正文',
        footer: { message: '让每次对话都成为下一次工作的起点。', copyright: 'pi-memory-system · MIT License' }
      }
    },
    en: {
      label: 'English', lang: 'en', description: 'Give your next Pi session a head start.',
      themeConfig: {
        nav: [
          { text: 'Product', link: '/en/' },
          { text: 'How it works', link: '/en/#how-it-works' },
          { text: 'Docs', link: '/en/docs/quickstart' }
        ],
        sidebar: { '/en/docs/': sidebar('/en', true) },
        outline: { level: [2, 3], label: 'On this page' },
        footer: { message: 'Give your next session a head start.', copyright: 'pi-memory-system · MIT License' }
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
        ...['button', 'segmented', 'tag', 'tabs', 'collapse', 'dialog'].map(name => `element-plus/es/components/${name}/style/css`)
      ]
    }
  }
});
