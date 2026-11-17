export type LocaleText = { zh: string; en: string };

export type ProjectIcon = 'boxes' | 'fileCode' | 'waypoints';

export type ProjectDoc = {
  slug: string;
  title: LocaleText;
  summary: LocaleText;
};

export type ProjectEntry = {
  id: string;
  name: string;
  repo: string;
  icon: ProjectIcon;
  tags: string[];
  summary: LocaleText;
  headline: { zh: string[]; en: string[] };
  outcomes: { title: LocaleText; text: LocaleText }[];
  docs: ProjectDoc[];
};

export const catalogCopy = {
  zh: {
    navTitle: '所有项目',
    eyebrow: '同作者的项目',
    title: '站内项目。',
    intro: 'Pi Memory 仍是这个站的主产品。下面几个项目各自有一页介绍和一小套说明，仓库仍在 GitHub。',
    drawerIntro: '选择一个项目查看介绍与说明。',
    cardLink: '查看介绍',
    readDocs: '阅读说明',
    source: '查看仓库',
    docsHeading: '说明',
    docsIntro: '先看这几页，再按需要回仓库看完整说明。',
    back: '所有项目'
  },
  en: {
    navTitle: 'All projects',
    eyebrow: 'Projects from the author',
    title: 'Projects on this site.',
    intro: 'Pi Memory stays the main product on this site. Each project below has its own overview and a short guide. The repositories stay on GitHub.',
    drawerIntro: 'Pick a project to open its overview and guide.',
    cardLink: 'View the overview',
    readDocs: 'Read the guide',
    source: 'View the repository',
    docsHeading: 'Guide',
    docsIntro: 'Start with these pages, then use the repository for the full reference.',
    back: 'All projects'
  }
};

export const projects: ProjectEntry[] = [
  {
    id: 'ai-lite',
    name: 'ai-lite',
    repo: 'https://github.com/yinwenyuan28-afk/ai-lite',
    icon: 'boxes',
    tags: ['JDK 8', 'Spring Boot', 'LLM'],
    summary: {
      zh: '面向 Spring Boot 2.x / JDK 8 存量系统的 AI 接入层：统一模型网关、Agent 编排、跨请求会话和提示词版本中心。',
      en: 'An AI integration layer for existing Spring Boot 2.x / JDK 8 systems: one model gateway, agent orchestration, cross-request sessions, and versioned prompts.'
    },
    headline: {
      zh: ['把模型接入', '留在现有系统里。'],
      en: ['Add models', 'without leaving the old stack.']
    },
    outcomes: [
      { title: { zh: '一个网关', en: 'One gateway' }, text: { zh: '业务代码用同一入口访问不同模型供应商。', en: 'Application code reaches different model providers through one entry.' } },
      { title: { zh: '流程可编排', en: 'Orchestrated work' }, text: { zh: '多步任务收成可重复执行的 Agent 流程。', en: 'Multi-step work becomes an agent flow you can run again.' } },
      { title: { zh: '会话与提示词可管', en: 'Sessions and prompts you can track' }, text: { zh: '会话跨请求保留，提示词按版本留下来。', en: 'Session state survives the next request, and prompts keep a version history.' } }
    ],
    docs: [
      { slug: 'overview', title: { zh: '整体设计', en: 'What it covers' }, summary: { zh: '从主调用路径看协议、传输、编排和状态如何组合。', en: 'What the gateway, orchestration, sessions, and prompt versions each do.' } },
      { slug: 'quickstart', title: { zh: '快速开始', en: 'Quick start' }, summary: { zh: '最小 YAML 配置与一次可直接照写的模型调用。', en: 'Where to install it, and four checks after it is wired in.' } },
      { slug: 'faq', title: { zh: '常见问题', en: 'FAQ' }, summary: { zh: '异步、重试、流式、取消与配置方式的使用边界。', en: 'Which systems it targets, and how it sits next to the other projects.' } }
    ]
  },
  {
    id: 'cursor-encoding-fix',
    name: 'cursor-encoding-fix',
    repo: 'https://github.com/yinwenyuan28-afk/cursor-encoding-fix',
    icon: 'fileCode',
    tags: ['Windows', 'Cursor', 'UTF-8'],
    summary: {
      zh: '专治简体中文 Windows 上 Cursor Agent 把中文静默存成 GBK 的问题。通过 MCP 工具读写文件，一律落盘为无 BOM 的 UTF-8。',
      en: 'Stops Cursor Agent from silently saving Chinese text as GBK on Simplified Chinese Windows. MCP tools read and write files as UTF-8 without a BOM.'
    },
    headline: {
      zh: ['让 Cursor 写下的中文', '保持为 UTF-8。'],
      en: ['Keep Cursor files', 'in UTF-8.']
    },
    outcomes: [
      { title: { zh: '落盘编码固定', en: 'A fixed encoding on disk' }, text: { zh: '经过这套工具写出的文件是无 BOM 的 UTF-8。', en: 'Files written through these tools are UTF-8 without a BOM.' } },
      { title: { zh: '走 MCP 读写', en: 'Read and write through MCP' }, text: { zh: 'Agent 用 MCP 工具读写文件，避开会把中文存成 GBK 的那条路径。', en: 'The agent reads and writes through MCP tools, away from the path that saves Chinese as GBK.' } },
      { title: { zh: '可以再挂一道钩子', en: 'An optional hook' }, text: { zh: '钩子可以拦住官方写入工具，让写入继续走 UTF-8 路径。', en: 'A hook can block the built-in write tools so writes stay on the UTF-8 path.' } }
    ],
    docs: [
      { slug: 'install', title: { zh: '安装', en: 'Install' }, summary: { zh: '问题出在哪，以及安装步骤该去仓库哪里看。', en: 'Where the problem shows up, and where the install steps live.' } },
      { slug: 'usage', title: { zh: '用法', en: 'Usage' }, summary: { zh: 'MCP 读写和可选钩子各自在什么时候起作用。', en: 'When to rely on the MCP tools, and when to add the hook.' } },
      { slug: 'limits', title: { zh: '限制', en: 'Limits' }, summary: { zh: '它覆盖的系统和工具，以及它不处理的编码问题。', en: 'Which system and tools it covers, and which encoding problems it leaves alone.' } }
    ]
  },
  {
    id: 'agentcenter',
    name: 'agentcenter',
    repo: 'https://github.com/yinwenyuan28-afk/agent-center',
    icon: 'waypoints',
    tags: ['Agents', 'Skills', 'Provider'],
    summary: {
      zh: '把多个 AI coding agent 的全局配置收到一处：指令文件映射、skill 收集、provider 与 MCP 分配。',
      en: 'One place for the global config of several AI coding agents: instruction files, skills, providers, and MCP servers.'
    },
    headline: {
      zh: ['多个 Agent，', '一处配置。'],
      en: ['Many agents.', 'One config home.']
    },
    outcomes: [
      { title: { zh: '指令有母版', en: 'One instruction source' }, text: { zh: '一份 AGENTS.md 映射到各 agent 自己的指令文件位置。', en: 'One AGENTS.md maps onto each agent\'s own instruction file.' } },
      { title: { zh: 'Skill 收回中心库', en: 'Skills in one library' }, text: { zh: '扫描散落在各家目录里的 skill，再逐条决定移入、去重或采用哪一份。', en: 'Scan scattered skills, then move, dedupe, or keep a chosen copy.' } },
      { title: { zh: 'Provider 与 MCP 按需分配', en: 'Providers and MCP, assigned' }, text: { zh: '密钥和 MCP server 先进一个池子，再逐条选择注入哪些 agent。', en: 'Keys and MCP servers live in one pool, then get assigned to the agents that should use them.' } }
    ],
    docs: [
      { slug: 'quickstart', title: { zh: '下载与打开', en: 'Download and open' }, summary: { zh: '从 GitHub Releases 下载 Windows exe，双击打开窗口。', en: 'Download the Windows exe from GitHub Releases and open the window.' } },
      { slug: 'guide', title: { zh: '界面操作指南', en: 'UI guide' }, summary: { zh: '按菜单走一遍 AGENTS.md、Skill、Provider，以及 Claude、Codex、Cursor 的特殊步骤。', en: 'Walk the menus for AGENTS.md, Skills, Providers, and Claude, Codex, and Cursor special steps.' } },
      { slug: 'agents', title: { zh: '支持的 Agent', en: 'Supported agents' }, summary: { zh: '每家能管指令文件、Provider、Skill 和 MCP 中的哪几项。', en: 'Which agents accept instruction files, providers, skills, and MCP.' } },
      { slug: 'agents-md', title: { zh: 'AGENTS.md', en: 'AGENTS.md' }, summary: { zh: '一份母版映射到各 agent 自己的指令文件。', en: 'One source file mapped onto each agent\'s instruction file.' } },
      { slug: 'providers', title: { zh: 'Provider', en: 'Providers' }, summary: { zh: '密钥先进一个池子，再按 agent 分配并写入。', en: 'Keys live in one pool, then get assigned and written per agent.' } },
      { slug: 'skills', title: { zh: 'Skill', en: 'Skills' }, summary: { zh: '扫描散落副本，再逐条决定移入、去重或采用哪一份。', en: 'Scan scattered copies, then move, dedupe, or keep a chosen one.' } }
    ]
  }
];

export function projectById(id: string) {
  return projects.find(item => item.id === id);
}

export function text(value: LocaleText, english: boolean) {
  return english ? value.en : value.zh;
}

export function projectHref(id: string, english: boolean, docSlug?: string) {
  const prefix = english ? '/en' : '';
  const page = docSlug ? `/projects/${id}/docs/${docSlug}` : `/projects/${id}/`;
  return `${prefix}${page}`;
}

/**
 * 用途：生成项目文档侧栏；english 选择语言，返回以路径为键的侧栏配置。
 * 中文 ai-lite 按阅读顺序编号，并沿用相同链接生成前后篇导航。
 */
export function projectSidebars(english = false) {
  const prefix = english ? '/en' : '';
  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  return Object.fromEntries(projects.map(project => {
    const numbered = !english && project.id === 'ai-lite';
    const items = [
      ...(numbered ? [
        { text: '快速开始', link: '/projects/ai-lite/docs/quickstart' },
        { text: '整体设计', link: '/projects/ai-lite/docs/overview' },
        { text: '网关层：从一次调用开始', link: '/projects/ai-lite/' },
        { text: '网关层：从一次调用开始（NIO）', link: '/projects/ai-lite/docs/gateway-nio' },
        { text: '编排层：从步骤到任务', link: '/projects/ai-lite/docs/orchestration' },
        { text: 'Session 的持久化', link: '/projects/ai-lite/docs/session-persistence' },
        { text: '限流熔断机制', link: '/projects/ai-lite/docs/rate-limit-circuit' },
        { text: 'Provider 与运行时配置', link: '/projects/ai-lite/docs/provider-runtime' }
      ] : []),
      ...project.docs.filter(doc => !numbered || doc.slug === 'faq').map(doc => ({
        text: english ? doc.title.en : doc.title.zh,
        link: `${prefix}/projects/${project.id}/docs/${doc.slug}`
      }))
    ];
    return [
      `${prefix}/projects/${project.id}/`,
      [{
        text: project.name,
        items: items.map((item, index) => ({
          ...item,
          text: numbered ? `${numerals[index] || index + 1}、${item.text}` : item.text
        }))
      }]
    ];
  }));
}
