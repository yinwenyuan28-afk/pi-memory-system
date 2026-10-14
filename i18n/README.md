# i18n —— 扩展运行时的界面语言

本目录是**扩展运行时**（`index.ts` + `memory/` + `util/` + `config/` + `skill/`）界面文案的唯一来源。
查看器 Web UI（`viewers/`）与官网（`website/`）有各自的机制，**不属于本目录**（查看器走
`viewers/assets/viewer-i18n.js`；官网走 VitePress 的 `locales` + `docs`/`en/docs` 目录镜像）。

```
i18n/
├── locales/
│   ├── zh-CN.json   # 源语言（所有键的权威出处）
│   └── en.json      # 同键集镜像
├── locale.ts        # 语言解析（纯函数：配置 → env → 系统区域 → 兜底）
├── index.ts         # t() / initI18n() / refreshLocaleFromConfig() / 读写配置
└── README.md        # 本文件
```

## 用法

```ts
import { t, refreshLocaleFromConfig } from "./i18n/index.ts";

ctx.ui.notify(t("ext.notify.noProfile"), "error");
ctx.ui.notify(t("ext.l2.archive.done", { name, n }), "info");
```

会话启动、拿到活跃 profile 后调一次，让配置生效：

```ts
refreshLocaleFromConfig(profile.path);
```

## 三条硬规矩

### 1. 整句做键 + `{{name}}` 命名参数

一句话就是一个键，参数用 `{{name}}` 占位：

```json
"archiveDone": "已搬进归档层：{{name}}（{{n}} 个成员随之保留）。"
```

**禁止**把句子拆成碎片键拼：

```ts
// ✗ 错：中英语序、复数一变就拼不出正确句子
t("l2.archive.prefix") + name + t("l2.archive.suffix", { n })
```

也**禁止** `%s` / `{0}` 这类位置参数（读代码时分不清哪个参数对应哪里）。

### 2. 缺失键可见，不静默回退

`t()` 查不到键时返回 `⟦key⟧`（如 `⟦ext.foo.bar⟧`）并记账，**不会**回退成中文。
这样漏翻在英文环境里会**看得见**，而不是悄悄冒中文。正确构建下运行时不该出现缺失键——
由 `scripts/verify-i18n.mjs` 的键对等检查保证。

### 3. 只翻给人看的

| 类别 | 处理 | 例子 |
|---|---|---|
| 给人看的提示 | **翻** | `ctx.ui.notify`、状态栏、卡片标题、命令说明、报告正文 |
| 展示层标签 | **翻**（展示层） | `待办/已完成/已废弃`（真数据是 `open/done/dropped`，见下） |
| 落盘成数据的中文值 | **不翻值** | 质量分 `热/温/冷/新/噪/待观察`：`memory/l1/quality.ts` 存的就是这几个字，翻译会破坏查表/筛选/统计。展示时用「值 → 键」映射换成标签 |
| 会进模型上下文的 | **不翻** | 注入块渲染、工具 description、`prompts/**`、`agents/**` |
| 诊断与开发 | **不翻** | `util/notice.ts` 的 `logEvent`、代码注释、`scripts/l1-admin/*` |

> 判据：**这段话是给人看的，还是给模型/数据库/日志看的？** 只有前者进词表。

## 语言怎么决定

优先级（高 → 低），实现见 `locale.ts`：

1. 配置 `<profile>/memoryDB/config/application-propertis.json` 的 `language.locale`
   （`auto` 或未配置 = 交给自动探测）
2. 环境变量 `LC_ALL` → `LC_MESSAGES` → `LANG`
3. 系统区域 `Intl.DateTimeFormat().resolvedOptions().locale`
4. 兜底 `zh-CN`

> Windows 上 `LANG` 一族通常**不存在**，所以实际生效的探测档是第 3 档（系统区域）：
> 英文 Windows → `en`，中文 Windows → `zh-CN`。

### 什么时候刷新

* 进程启动：`t()` 首次调用时用 env/系统区域初始化。
* `session_start`：`refreshLocaleFromConfig(profile.path)` 让配置生效。
* **命令 description / 已渲染的卡片要到下次 `/reload` 才刷新**；状态栏可以即时刷。
  这是诚实的能力边界，不承诺全量热切换。

## 新增一门语言（例如日语）

1. 复制 `locales/zh-CN.json` → `locales/ja.json`，翻译所有**值**（键不动）。
2. 跑 `node scripts/verify-i18n.mjs` 确认键集与源语言一致、没有残留中文。
3. 完成。**不需要改任何代码** —— 语言清单由 `locales/` 目录实时列举，
   用户在 `/my-memory:language ja`（或 `language.locale: "ja"`）即可启用。

> 语言名的匹配是宽松的：`ja_JP.UTF-8` / `ja-JP` 都会命中 `ja.json`；`zh-TW` 会命中 `zh-CN`。

## 键命名规范

按「面 → 区域 → 语义」点号分层，键用英文、语义化，**不要**用中文原句当键：

```
ext.notify.noProfile          # 通用提示
ext.command.l1Mode.description # 命令说明
ext.l2.archive.done           # 某条具体文案
ext.quality.tag.hot           # 展示层标签（数据值 热 → 显示用）
```

## 门禁

`scripts/verify-i18n.mjs`（已接入 `npm test`）：

1. **键对等**：每个非源语言与 `zh-CN.json` 的扁平键集完全一致（缺键/多键 → FAIL）。
2. **未译检测**：非源语言词表里不得残留汉字（技术 token 走白名单，如 `l1/scenes.json`）。
