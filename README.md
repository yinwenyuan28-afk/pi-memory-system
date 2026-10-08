# pi-memory-system

L0–L3 记忆管线扩展。会话进行中自动提取原子记忆、整合进场景块、生成用户画像，并在后续轮次按需召回注入。

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| **操作系统** | **仅 Windows** | 停止子代理依赖 `taskkill /T /F` 的进程树语义；项目归属判定用盘符形状规则。见下方「已知限制」 |
| Node | `>= 22.13` | 用到内置的 `node:sqlite` |
| pi | **实测可用**：pi 0.84.2 + pi-coding-agent 0.83.0 + pi-ai 0.74.2 | 扩展 API。**不需要额外安装任何 `@earendil-works/*`**——pi 的扩展加载器通过 jiti 别名 / Bun 虚拟模块把这些包指向它自己 bundle 的副本，扩展 import 它们不落 `node_modules`。这条是实测的：发布产物装在一条向上五级都没有 `node_modules` 的路径上，仍 0 错误加载、工具与命令全在位（2026-10-08 用 `scripts/verify-tool-schemas.ts` 实测当前工作区：19 工具 / 18 命令） |

**不依赖 pi-subagents**（2026-10-01 起）。L1/L2/L3/review/skill-review 五条链的后台子代理由本扩展**自己 spawn 一个 pi 子进程**执行（`util/spawn.ts`），不需要安装、也不需要修改任何其它扩展的源码。

> 此前版本走 pi-subagents 的 `subagents:rpc:v1` 事件总线，已移除——该桥接层硬编码从自己缓存里取 ctx，而 pi 会在 session 替换/reload 时作废该缓存，导致派发必然失败（`This extension ctx is stale…`）。详见 `plan/memory-system/SELF_SPAWN_PLAN.md`。

## 安装

```bash
# 从 npm（发布后）
pi install npm:pi-memory-system

# 从本地路径（开发 / 未发布时）
pi install ./path/to/memory-system
```

装完执行 `/reload`（或重启 pi）生效。

> **`pi install` 不接受 `.tgz` 路径**（2026-10-02 实测）。喂 tarball 的话 pi 只是把
> `xxx.tgz` 原样写进 `settings.packages` 的相对路径，加载器随后报
> `Unknown file extension ".tgz"` —— 装是"成功"了，但扩展永远加载不上。
> 要用 tarball 就先解包，再按**目录**装：`tar -xzf x.tgz && pi install ./package`。

### ⚠ 只用一种安装方式

pi 会**同时**扫描 `~/.pi/agent/extensions/` 目录和 `settings.json` 的 `packages` 数组。如果扩展同时存在于两处，pi 会加载两次 ⇒ **同名工具重复注册**（pi 的去重按路径，两条路径不同不去重）。

从 `extensions/` 目录迁到包安装时，**先删掉旧目录**：

```bash
mv ~/.pi/agent/extensions/memory-system /path/to/backup
```

确认无误后再执行 `pi install`。

## 配置

配置文件在 profile 目录下（**首次运行自动创建**）：

```
<agentDir>/profiles/<profile>/memoryDB/config/application-propertis.json
```

JSONC 格式（支持 `//` 注释）。四个节：

| 节 | 作用 | 缺省会怎样 |
|---|---|---|
| `recall` | 召回闸门：相似度下限、注入条数上限、注入超时与模式、已关闭任务是否剔除（`hideClosedTasks`） | 全部回落到内置默认，**不崩** |
| `vectorization` | 向量化开关与触发阈值 | 默认关闭，**不崩** |
| `subagent` | 子代理存活门控：软/硬阈值、停止序列宽限 | 全部回落到内置默认 |
| `model` | `llm`（后台模型）与 `embedding`（向量化服务） | `llm` 缺省跟随前台模型；**`embedding` 的 `url` / `apiKey` 缺失时，用到向量化的功能会抛错** |

配置项的完整语义见各节源码注释（`config/app-config.ts`）。

### 交互配置命令

- `/my-memory:model`：交互选择后台 LLM（从 Pi 当前可用模型中选）、配置 Embedding 服务，以及明确开启/关闭向量化。后台 LLM 设置只影响记忆系统的后台调用，不会切换当前对话模型。向量化开启后，L1 提交按最近 365 天有效记录数执行阈值（默认 500 条）；已有未向量化记录需手动回填。
- `/my-memory:model:peek`：只读查看当前 profile 的后台模型来源、Embedding 配置状态、向量化开关/阈值、最近 365 天 L1 记录数和本地向量数。它不写配置或数据库、不请求远端，也不显示 API Key。
- Embedding API Key 通过 Pi 的输入框录入；Pi 当前扩展 UI 不提供密码掩码，输入过程中密钥可能可见。保存后密钥仍按现有格式存入 profile 配置文件。
- 修改 Embedding 配置后建议重启 Pi，以确保主进程和后台子代理都使用新服务配置。向量化默认关闭，配置 Embedding 不会自动开启，也不会自动回填历史记忆。
- 若本地向量库已存在，交互配置器会阻止把 Embedding 维度改成与向量表不同的值，以避免后续召回/写入错误；向导不自动迁移已有向量表。

## 任务生命周期（work_task）

L1 的 `work_task` 记录带一个开关状态，存在记录的**顶层**字段 `taskState`：`open`（待办，缺省）/ `done`（已完成）/ `dropped`（已废弃、不做了）。

- 召回块里每行都带编号与状态标签：`- [待办] (l1_1789097476492_xtah) 正文…`。agent 确认待办已完成后调 `l1_task_state` 工具标记（`{ids, state, reason?}`）；用户改主意要重做 → `state: "open"`。
- 用户侧等价入口：`/my-memory:l1:task [list|done|drop|reopen] [id…] [--all] [--reason "原因"]`，`list` 列出未关闭任务（`--all` 含已关闭）。
- 标记是**就地**改状态：正文、编号、向量、命中统计都不变 —— 任务照旧可被召回，默认带 `[已完成]` / `[已废弃]` 标签注入（"这件事做过"本身常是有用的答案）。想彻底不注入已关闭任务，把 `recall.hideClosedTasks` 设为 `true`（记录仍在库里、仍可 reopen）。
- **与 `deleted` 的区别**：`deleted` 表示"这条记录不该存在"（查重覆盖 / 纠错作废），会让记录退出召回与向量库；"任务关了"不是删除，两件事各有各的入口（前者 `l1_fix`，后者 `l1_task_state`）。
- 存量记录迁移（把历史 `metadata.status="done"` 升格成 `taskState`）：`node scripts/migrate-task-state.mts --profile <profileDir>` 先看 dry-run 报告，确认后加 `--apply`（自动备份；只映射明确的 `done`，其余不猜）。

## 已知限制

- **仅支持 Windows**。项目归属判定依赖盘符形状（`C:/`）识别「用户主目录类噪声路径」；在 Linux/macOS 上这些规则**静默失效**——不报错，但项目判定会变差。子代理停止序列同样按 Windows 的进程树语义设计。
- **不往 `~/.pi/agent/agents/` 写任何文件**。6 个子代理定义随包分发（`agents/*.md`），派发时由本扩展直接读取。
- **会往宿主 `~/.pi/agent/settings.json` 写，且只写一个键**：`memorySystem.activeProfile`（记录当前激活的记忆 profile，`/my-memory:profile switch` 会改它；没切过就完全不写）。**不做整文件覆写**——直接在原始文本上定位那个值、只替换那一段，其余字节原样保留；落盘走 tmp → rename 原子写。键挂在自己的命名空间下，将来要整个摘掉只需去掉那个对象。若该文件不可写，切换会**如实报错并回滚**（不会假装成功）。
- **pi 可执行文件的定位**优先用 `process.execPath` + pi 自己的入口（最可靠，因为扩展就跑在 pi 进程里）；PATH 里的 `pi` 位置带包管理器的会话哈希、跨窗口不稳定，只作回落。必要时可用 `PI_MEMORY_SYSTEM_PI_BIN` 指定。
- **`vectorization` 默认关闭**。开启需要自备 OpenAI 兼容的 embedding 端点。

## 开发

```bash
git clone git@github.com:yinwenyuan28-afk/pi-memory-system.git
cd pi-memory-system
npm install            # ← 必须先做，见下方「为什么 npm install 是必需的」
```

### 门禁

```bash
npm run check-types   # 类型门禁（无构建仓库里唯一能拦住「名字写错/模块写错」的东西）
npm test              # 提示词契约逐字节校验
```

回归脚本在 `scripts/verify-*.ts`，共 20 多个、1400+ 项断言。跑法（Node ≥ 22.13 自带类型剥离，**不需要 jiti**）：

```bash
# 单个
node --conditions=import --experimental-strip-types scripts/verify-xxx.ts

# 全部
for f in scripts/verify-*.ts scripts/verify-*.mts scripts/verify-prompt-contracts.mjs; do
  node --conditions=import --experimental-strip-types "$f" || echo "!! 失败: $f"
done
```

`--conditions=import` 不能省：`config/model-config.ts` 静态 import `@earendil-works/pi-ai/compat`，
该包的 `exports` 只声明了 `import` 条件。

### 为什么 `npm install` 是必需的

两个原因，都不会在加载时报错，只在运行时炸：

1. **原生模块**：`better-sqlite3` / `sqlite-vec` 是 `memory/search/vector-store/store.ts:134-135`
   的**运行时动态 import**。不装的话插件能正常加载、工具也都在，但**第一次写向量库时**
   （即 L1 提交记忆时）才失败——这种延迟失败极难归因。
2. **类型门禁的解析来源**：三个 `@earendil-works/*` 包声明为 `devDependencies`。

> ⚠ **不要把那三个 devDependencies 改成宿主正在用的版本。** 它们锁在 `0.83.0` 是有原因的：
> `@earendil-works/pi-ai/compat` 这个子路径**在 npm 发布的 0.74.2 里不存在**（`exports`
> 只有 `.`），只有 0.83.0 才有。改成 0.74.2 会让类型门禁报 29 处 `TS2307 Cannot find module`。
> 运行时不需要它们——pi 的扩展加载器通过 jiti 别名 / Bun virtualModules 把这些包指向 pi
> 自己 bundle 的副本，扩展 import 它们不落 `node_modules`。devDependencies 只为类型检查存在。

### 发布

```bash
node scripts/check-types.mjs                      # 先过门禁
npm version patch                                 # 版本号一旦占用即永久作废，务必先改
npm pack --pack-destination C:/temp/pi/release
npm publish C:/temp/pi/release/pi-memory-system-<版本>.tgz
```

三点：**发布前确认 `git status` 干净**；**README/LICENSE 在 `files` 白名单里，改过就要重打包**；
**`pi install` 不接受 `.tgz` 路径**（见「安装」一节）。
