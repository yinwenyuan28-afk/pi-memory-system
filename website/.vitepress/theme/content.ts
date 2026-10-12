export const repository = 'https://github.com/yinwenyuan28-afk/pi-memory-system';

export const copy = {
  zh: {
    forPi: '为持续工作的 Pi 用户而做',
    headline: ['为 Pi 提供', '长期记忆支持。'],
    intro: '把对话里的项目事实、工作方法和待办积累下来，在下一次相关工作中按需找回。少一点重复交代，多一点接着往下做。',
    start: '开始使用', watch: '观看 45 秒演示', windows: '目前支持 Windows', node: 'Node ≥ 22.13',
    outcomes: [
      { title: '项目背景，少重复一遍', text: '让已有事实和工作约定成为后续协作的起点。', icon: 'message' },
      { title: '有用经验，有机会再用', text: '按当前问题找回相关记录，带着待办状态继续工作。', icon: 'search' },
      { title: '长期画像，由你把关', text: '系统先提出更新，你审阅后再并入正式画像。', icon: 'shield' }
    ],
    workflowTitle: '对话结束，经验继续。',
    workflowIntro: '记忆在后台逐步整理，在相关问题出现时再回到工作中。',
    workflow: [
      { title: '归档对话', text: '保存经过净化的用户与助手正文。', meta: 'L0 · 对话来源' },
      { title: '提炼可用信息', text: '整理成事实、待办、方法与工作资产。', meta: 'L1 · 可复用记录' },
      { title: '按问题找回', text: '从已建立向量的记录中检索相关内容。', meta: '需配置 Embedding' }
    ],
    branch: '相关记录也会逐步整理成场景，并生成供你审阅的画像提议。', branchLink: '了解分层记忆',
    featuresTitle: '记得下来，也看得明白。', featuresIntro: '你能检查记忆、修正内容，把反复成功的流程沉淀成技能。',
    features: [
      { id: 'records', label: '检查与修正', heading: '每条记忆，都有可管理的记录。', text: '在本地查看器里检查记录与来源，纠正不准确的内容，管理待办状态。记忆可以随着工作的变化一起更新。', link: '了解查看器', doc: 'viewer', panelTitle: '项目记忆', panelCaption: '界面示意 · 支付模块', columns: ['类型', '内容', '状态'], rows: [['事实', '金额统一用整数分', '有效'], ['待办', '退款接口实现', '已完成'], ['待办', '重复退款测试', '待办']], foot: '记录可查看、可纠正，待办可重新打开。' },
      { id: 'profile', label: '审阅长期画像', heading: '哪些偏好留下来，由你决定。', text: '扩展会从积累的经历中形成画像提议。你检查并选择并入后，正式画像才会影响后续新会话的背景。', link: '了解画像更新', doc: 'memory', panelTitle: '画像提议', panelCaption: '界面示意 · 等待审阅', columns: ['状态', '提议内容', '生效方式'], rows: [['提议', '偏好先讨论边界再实现', '待审阅'], ['提议', '希望代码改动附带原因', '待审阅']], foot: '提议不会自动覆盖正式 USER.md。' },
      { id: 'skills', label: '沉淀工作技能', heading: '把熟悉的流程，变成下次的指南。', text: '让重复出现的排查、验证和操作流程整理成可复用技能。也可以用 /learn 主动从当前工作中提炼。', link: '了解技能学习', doc: 'skills', panelTitle: '可复用工作流程', panelCaption: '内容示意 · 从经历到指南', columns: ['步骤', '排查支付回调', '关注点'], rows: [['1', '核对订单号', '业务对象'], ['2', '检查回调签名', '请求来源'], ['3', '查看幂等记录', '重复处理']], foot: '技能需要满足复用与质量要求，并非每段对话都会生成。' }
    ],
    filmTitle: '用 45 秒，看懂一次接续。', filmText: '从分散的对话，到可复用记忆，再回到下一次工作。', filmButton: '播放宣传视频', filmDuration: '45 秒 · 中文配音', dialogTitle: 'Pi Memory · 45 秒演示',
    docsTitle: '从安装，到第一次找回记忆。', docsIntro: '先运行记忆管线，再按需要配置语义召回。每一步都有清楚的说明。',
    installLabel: '从本地插件目录安装', copy: '复制命令', copied: '已复制', copyFailed: '复制失败，请手动选择命令', installNote: '将示例路径替换为你的插件目录，安装后在 Pi 中执行 /reload。',
    docs: [
      { title: '快速开始', desc: '环境要求、安装方式与首次检查。', slug: 'quickstart', icon: 'terminal' },
      { title: '配置语义召回', desc: 'Embedding、向量化与已有记录回填。', slug: 'recall', icon: 'search' },
      { title: '查看与修正', desc: '查看记录、任务状态与画像提议。', slug: 'viewer', icon: 'layers' },
      { title: '限制与数据说明', desc: '兼容条件、服务调用与当前边界。', slug: 'limits', icon: 'shield' }
    ],
    faqTitle: '安装前，你可能想知道。',
    faqIntro: '兼容范围、召回配置和数据处理方式，安装前都可以先了解。',
    faqs: [
      { question: '适合什么样的用户？', answer: '最适合经常用 Pi 推进持续项目、有重复工作流程的开发者。多个会话里反复讨论的约定、决定和待办，是它能积累的主要价值。一次性问答中的收益相对有限。' },
      { question: '安装后就能自动语义召回吗？', answer: '语义召回需要配置 Embedding 服务并开启向量化。向量化默认关闭，默认触发阈值为 500 条有效记录；已有记录还需要回填向量。安装与配置是两个步骤。' },
      { question: '记忆数据会发送到外部服务吗？', answer: '记忆文件保存在 Pi profile 中。后台提取会使用配置的模型，向量化会调用配置的 Embedding 服务。实际数据发送范围取决于你的服务配置；保存在本地不代表全部处理都在本地。' },
      { question: '多个项目的记忆会严格隔离吗？', answer: '项目归属会在有效识别时参与排序，使相关项目的内容有机会优先出现。它目前不是严格的隔离过滤，也可能存在 unknown 项目归属。' },
      { question: '目前有哪些兼容与使用限制？', answer: '当前仅支持 Windows，需要 Node 22.13 或更高版本。场景层目前不会自动注入每轮回答，画像需要审阅并入。本地查看器桥目前没有鉴权，建议按默认方式在本机使用。详细信息见限制与数据说明。' }
    ],
    finalTitle: '让下一次会话，接着这一次。', finalText: '为持续推进的工作，留下一份可复用的起点。', github: '查看 GitHub',
    footerDocs: '文档', footerData: '数据与限制', footerIssue: '反馈问题'
  },
  en: {
    forPi: 'Built for ongoing work with Pi',
    headline: ['Long-term memory', 'for your Pi agent.'],
    intro: 'Keep useful project facts, working methods, and tasks from your conversations. Bring relevant context back when you continue the work.',
    start: 'Get started', watch: 'Watch the 45-second demo', windows: 'Currently for Windows', node: 'Node ≥ 22.13',
    outcomes: [
      { title: 'Explain the context less often', text: 'Use existing project facts and conventions as a starting point.', icon: 'message' },
      { title: 'Give useful experience another turn', text: 'Retrieve relevant records and continue with task states in view.', icon: 'search' },
      { title: 'Keep control of your profile', text: 'Review proposed changes before merging them into your profile.', icon: 'shield' }
    ],
    workflowTitle: 'The chat ends. The experience stays useful.',
    workflowIntro: 'Memory takes shape in the background and returns when a related question comes up.',
    workflow: [
      { title: 'Archive the conversation', text: 'Keep cleaned user and assistant text.', meta: 'L0 · Conversation source' },
      { title: 'Extract useful information', text: 'Organize facts, tasks, methods, and work artifacts.', meta: 'L1 · Reusable records' },
      { title: 'Recall for the question', text: 'Search relevant records that have vectors.', meta: 'Embedding setup required' }
    ],
    branch: 'Related records also form scenes and proposed profile updates for you to review.', branchLink: 'Explore memory layers',
    featuresTitle: 'Memory you can understand and manage.', featuresIntro: 'Inspect records, correct information, and turn repeatable workflows into reusable skills.',
    features: [
      { id: 'records', label: 'Inspect and correct', heading: 'Every memory is a record you can manage.', text: 'Use the local viewer to inspect records and sources, correct inaccurate content, and track tasks. Update memory as the work changes.', link: 'Explore the viewer', doc: 'viewer', panelTitle: 'Project memory', panelCaption: 'Illustrative view · Payments', columns: ['Type', 'Content', 'Status'], rows: [['Fact', 'Use integer cents for amounts', 'Active'], ['Task', 'Implement refund endpoint', 'Done'], ['Task', 'Test duplicate refunds', 'Open']], foot: 'Inspect and correct records. Reopen tasks when needed.' },
      { id: 'profile', label: 'Review your profile', heading: 'You decide which preferences stay.', text: 'The extension proposes profile updates from accumulated scenes. Review and merge them before they become background for future sessions.', link: 'Explore profile updates', doc: 'memory', panelTitle: 'Profile proposals', panelCaption: 'Illustrative view · Pending review', columns: ['State', 'Proposed preference', 'Activation'], rows: [['Proposal', 'Discuss boundaries before implementation', 'Review first'], ['Proposal', 'Explain the reasons for code changes', 'Review first']], foot: 'Proposals do not automatically overwrite USER.md.' },
      { id: 'skills', label: 'Learn reusable skills', heading: 'Turn familiar workflows into future guides.', text: 'Extract reusable skills from repeatable debugging and operating workflows. Use /learn to actively learn from the current work.', link: 'Explore skill learning', doc: 'skills', panelTitle: 'Reusable workflow', panelCaption: 'Illustrative content · A debugging guide', columns: ['Step', 'Debug payment callbacks', 'Focus'], rows: [['1', 'Compare order IDs', 'Business object'], ['2', 'Verify the signature', 'Request source'], ['3', 'Inspect idempotency records', 'Duplicate handling']], foot: 'Skills must meet reuse and quality requirements.' }
    ],
    filmTitle: 'See the next session take shape in 45 seconds.', filmText: 'From scattered conversations to useful memory, and back into your work.', filmButton: 'Play the product film', filmDuration: '45 seconds · English narration', dialogTitle: 'Pi Memory · 45-second demo',
    docsTitle: 'From installation to your first recall.', docsIntro: 'Start the memory pipeline, then configure semantic recall when you need it. Follow a clear guide for each step.',
    installLabel: 'Install from a local extension directory', copy: 'Copy command', copied: 'Copied', copyFailed: 'Copy failed. Select and copy the command manually.', installNote: 'Replace the example path with your extension directory. Run /reload inside Pi after installation.',
    docs: [
      { title: 'Quick start', desc: 'Requirements, installation, and first checks.', slug: 'quickstart', icon: 'terminal' },
      { title: 'Configure semantic recall', desc: 'Embedding, vectorization, and backfilling records.', slug: 'recall', icon: 'search' },
      { title: 'Inspect and correct', desc: 'Records, task states, and profile proposals.', slug: 'viewer', icon: 'layers' },
      { title: 'Limits and data handling', desc: 'Compatibility, service calls, and current limits.', slug: 'limits', icon: 'shield' }
    ],
    faqTitle: 'A few things to know before you install.',
    faqIntro: 'Check compatibility, recall setup, and data handling before you get started.',
    faqs: [
      { question: 'Who is this for?', answer: 'Pi users who work on ongoing projects or repeatable workflows. Decisions, conventions, and tasks discussed across sessions are the core use case. The benefit is smaller for occasional, one-off questions.' },
      { question: 'Does semantic recall work immediately after installation?', answer: 'It requires an Embedding service and enabled vectorization. Vectorization is off by default, with a default threshold of 500 valid records. Existing records need a vector backfill. Installation and recall setup are separate steps.' },
      { question: 'Is data sent to external services?', answer: 'Memory files live in your Pi profile. Background extraction uses your configured model; vectorization uses your configured Embedding service. What leaves your device depends on that configuration. Local files do not mean all processing is local.' },
      { question: 'Are projects strictly isolated?', answer: 'When the project is identified, its ownership can influence ranking. This is not a strict isolation filter, and some records may have unknown ownership.' },
      { question: 'What are the current compatibility and usage limits?', answer: 'Windows only, with Node 22.13 or later. Scenes are not automatically injected into each answer. Profile changes require review and merge. The local viewer bridge currently has no authentication; use its default local setup. Read the limits guide for details.' }
    ],
    finalTitle: 'Pick up where this conversation leaves off.', finalText: 'Keep a reusable starting point for the work you continue.', github: 'View on GitHub',
    footerDocs: 'Documentation', footerData: 'Data and limits', footerIssue: 'Report an issue'
  }
};
