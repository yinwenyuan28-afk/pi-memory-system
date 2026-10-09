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

## 记录查看器

本地查看记忆库现状的网页工具：L1 记录（质量分 / 淘汰候选 / 任务状态 / 场景与项目归属 / 价值校验丢弃留痕）、L2 场景层（块 / 成员侧车 / 归档账本 / 对账）、L3 画像层（游标 / `MEMORY.md`、`USER.md`、`USER-temp.md` 的条目与字符预算 / 提议稿差异），外加一个总览页做数据健康与版本检查，以及一个**流水线页**（顶层第 5 个 tab）看作业队列与子代理：三层共用的 `pipeline/jobs.sqlite`（排队 / 在跑 / 最近结束，queued 按认领顺序、L3 永远最后）、三层的待消费触发信号、正在跑的子代理，以及「请求入队」与「停止子代理」两个动作。

> 「触发 / 待消费信号 / 停止子代理」原本分散在 L1、L2、L3 三页各自的管理区里（三份实现、同一个端点，只有文案不同）。2026-10-08 收拢到流水线页：三层合成一张表（每层一行），每页只留**本层自己的**写动作（L1 页剩提取模式 / 向量库 / 整库还原；L2 页剩块归档恢复 / 场景池报告 / 播种；L3 页剩提议稿编辑 / 还原 / 并入）。

**打开方式**（推荐经写盘桥，才有全部分片自动加载、目录列举与写盘）：

```bash
npm run viewer                                   # 一键：同步最新页面 → 起桥 → 开浏览器
# 等价于：node --experimental-strip-types scripts/l1-admin/viewer.mts
```

Windows 也可以直接双击 `scripts/l1-admin/启动查看器.cmd`。启动器会做三件每次都得记得做、忘了就出问题的事：

1. **先同步最新页面**（调用与激活时同一套部署逻辑，内容没变就零写入）—— 源码改过但还没重启 pi 会话时，不至于看到旧页面；
2. **自动避让占用端口**（从 5174 起往上找空闲端口，不再因为 5174 被占就直接退出）；
3. **打开浏览器**到 `viewers/index.html`。

profile 由扩展自己的 `ProfileManager` 解析（读宿主 `settings.json` 的 `memorySystem.activeProfile`），所以查看器与扩展永远看同一个 profile；也可用 `--profile <dir>` 覆盖。停止：关掉那个控制台窗口，或 Ctrl+C。

底层命令（需要自己控制端口/不自动开浏览器时）：

```bash
node scripts/l1-admin/viewer-bridge.mjs          # 默认端口 5174
# 然后打开终端打印的 http://localhost:5174/viewers/index.html?port=5174
```

**要在别的设备上打开（局域网调试）**：加 `--lan`（一键启动器同样支持：`npm run viewer -- --lan`，或 `启动查看器.cmd --lan`）：

```bash
node --experimental-strip-types scripts/l1-admin/viewer.mts --lan
# ✔ 别的设备打开这个地址（同一局域网）：http://172.16.10.4:5174/viewers/index.html?port=5174
```

它在环回之外**额外**监听本机那张局域网网卡（`--host <addr>` 可指定地址，`0.0.0.0` = 所有网卡），并把给别的设备用的地址打印出来。页面里的 `/api/*` 请求跟着**页面自身的地址**走，所以在别处打开时不需要任何额外配置。地址探测规则（优先 172.16.10.x，其次其它私有段）只在 `scripts/l1-admin/lan-addresses.mjs` 一份，启动器与桥共用。

> ⚠ 局域网地址上**没有鉴权**、CORS 仍是全开的：同网段的任何设备都能读走全部记忆（含对话内容），也能调用写端点（改任务状态 / 删除 / 并入 live 画像 / 整库还原）。只在可信网络里开，用完即关。`config/`（含 embedding API key）仍然留在静态托管之外，局域网访问也取不到。别的设备连不上时，先看 Windows 防火墙有没有放行 node 的入站（专用网络 / 该网段）。

直接双击 `{profile}/memoryDB/viewers/records-viewer.html` 也能打开页面，但浏览器禁止 `file://` 下的 fetch，所以**它取不到任何数据**（自动加载与写盘都不可用；`USER.md` 等 profile 根的画像文件也读不到），只会看到一句说明。**看数据必须经写盘桥**。

**为什么"必须经桥打开"**：桥不是可选的加速器，它提供四样浏览器自己给不了的东西 ——
① 全部分片的自动加载（浏览器不能列目录，没有桥只扫最近 90 天的探测窗口）；② L2 块文件、L3 备份、
profile 根画像文件的目录列举；③ 版本/漂移检查；④ 全部写回（任务状态、删除）。而**双击 HTML 直接开（`file://`）
是浏览器硬性禁止 `fetch`**，不是本项目的选择。原先 `file://` 下还留了一条"手动选 JSONL"的离线载入路径，
2026-10-08 按用户要求删掉了（那三个按钮只为这条路径存在，实际始终经桥打开，属死重量）。

**`?port=` 是这套设计里唯一能把"桥在哪"表达清楚的手段**（页面既要能在桥下跑、也要能从磁盘直接双击、还要能挂任意静态服务器只读浏览，三者共用同一份页面）。代价是它一旦丢了，页面**不报错、只是安静地退化成只读**，到处显示"无写盘桥"：自动加载没了一半、写回按钮点了没反应。所以：

- 所有页内跳转都带上 `location.search`（顶部导航也一样）；
- 桥的根路径 `/` 会 **302 到带 `?port=` 的总览页**（就地返回 `index.html` 会让相对引用的 `assets/*` 全 404）；
- 真丢了 query 时，页面顶部会给出提示并告诉你补什么，而不是只闷着降级。

顺带一提：**改了查看器源码后要重新部署才生效**（部署发生在 pi 会话激活 / `/reload` 时，或 `npm run viewer` 启动时）—— 否则页面右上角会标黄显示"源码已更新未部署"。



**它为什么不会像以前那样落后**：源码在插件仓库的 [`viewers/`](viewers/)（进 git、随包发布），扩展激活时由 `memory/viewers/deploy.ts` 按**内容哈希**逐文件比对，只把变了的原子写到 `{profile}/memoryDB/viewers/`，并写 `viewer-manifest.json`（版本 = 包版本 + 内容哈希前 8 位）。页面右上角显示已部署版本；当源码改过但还没重新部署时，经桥打开会标黄提示「源码已更新未部署」。此前它是 profile 里手维护的单个 HTML，不在 git、也没有任何代码生成它 —— 于是场景池、L2 归档、type 收束、`taskState` 四次 schema 变更它全都没跟上，页头却还写着「与 quality.ts 1:1」。
质量分与源码的一致性不再靠注释声明：`scripts/verify-viewer-quality-parity.ts` 把 JS 移植版与 `memory/l1/quality.ts` 喂同一批夹具逐例断言数值相等（含活跃日/日历两种时钟、`judgePrune` 六种 reason、保护带 P75）；`scripts/verify-viewer-deploy.ts` 守住部署机制本身（幂等、增量、退役、不碰用户文件），并做无浏览器也能跑的静态检查（JS 语法、HTML 引用的资源存在、页面调用的 `/api/*` 端点在桥里已声明，以及 ⑯ 设计契约）。

**界面约定**（改样式前先读 [`viewers/assets/viewer.css`](viewers/assets/viewer.css) 顶部的五条契约）：外壳一律无彩度，色相只属于数据 —— 六个「记忆温度」（热 温 冷 新 噪 待观察）是全页仅有的成组彩色，所以这一页的颜色本身就是它的信息；形状编码种类（实心彩色药丸 = 已确定的状态、虚线 = 未落定、点线 = 已搁置、无色方块 = 分类值、等宽 token = 度量值）；一层只有一条滚动轴（卡片正文只做截断预览，完整正文在弹层里）；数字一律等宽 + tabular-nums，字号只走六级令牌；**外壳只做「文字动作」，不做底色块** —— 按钮只有三个语义（默认文字动作 / `.primary` 墨色描边 = 写入内容 / `.danger` danger 描边 = 让既有内容消失或被替换）加一个选中状态（`.active` = 给一层 `--panel3` 底色、不画线），尺寸只有一档 31px（卡片脚与播种表行内两处紧凑档 25px），且**作用域只准覆盖尺寸与间距、不准决定按钮长相**。

滚动条这里有个反直觉的坑，改动时别踩回去：**不要写 `scrollbar-color`**。实测（Chrome 146 / Electron 41，2026-10-08）一指定它，引擎就退回 16px 的经典滚动条（带箭头），比完全不指定还宽 —— 而"一堆原生滚动条"正是这次要解决的问题；保持默认 `auto` 时 `::-webkit-scrollbar` 才会接管。变暗的职责交给 `:root` 的 `color-scheme: dark`，标准属性只在 `@supports not selector(::-webkit-scrollbar)` 里给 Firefox 兜底。同一类坑还有两个，都会静默失真：色值只允许出现在 `viewer.css` 的 `:root`（JS 里内联色值会与 CSS 漂移），以及 `:where(.bar-track) > i` 的兜底色必须让出特异度（写成 `.bar-track > i` 会用 (0,1,1) 压过 `.c-hot` 的 (0,1,0)，把所有条形图变成兜底灰）。这三条都由 `verify-viewer-deploy.ts` 的 ⑯ 节断言。

还有一个更坑的：**别在 `aside` 或 `.wrap-scroll` 上写 `overscroll-behavior: contain`**。实测只要容器带 `contain`，滚轮就被它吞掉，**哪怕这个容器根本没有可滚内容** —— L2 的块表格正是 `overflow:auto` 但内容不溢出、又占了内容列大半，于是表现为"鼠标滚动失效"（对照实验：改回 `auto` 后同一个手势立刻能滚页面）。`contain` 只保留在弹层上（打开弹层时拦住滚轮、别滚动背景，那才是它该在的地方）。

**能从界面写回的操作**（全部需要带 `?port=` 打开；每个动作都转发到 agent 侧同一份实现，桥里不复制业务逻辑）：

| 层 | 操作 | 要点 |
|---|---|---|
| L1 | 任务状态切换（单条 / 批量） | `done` / `dropped` / `open`，走 `l1_task_state` 同一实现：写锁 + 就地改写 + `metadata.taskStateChange` 审计 |
| L1 | 删除（墓碑，单条 / 批量） | `tombstone.mjs`：先自动备份，再就地标 `deleted:true` |
| L1 | 纠错（改写正文） | 详情弹层里的 `l1_fix` 面板，**只做 rewrite**：**证据 ≥20 字符**、新正文 ≥10 字符、24h 防抖、高价值保护（`force` 只解最后一道）。审计是**写进正文的文本标注**，不是独立审计键。**作废（tombstone）不在这块面板里**：它与上面那条「删除（墓碑）」写的是同一个字段、同一份备份、同一条 `l1Cleanup`，所以只保留那一个入口 |
| L1 | 整库还原 | `rollback.mjs`：**删掉当前全部 `.jsonl` 再复制备份**，不是单条撤销；要打字输入备份目录名 |
| L1 | 向量库回填 / 重建 | 重建会**先清空向量库**，要打字 `REBUILD`。两者都是长任务，**期间整座桥不响应**（单线程同步执行） |
| L1 | 提取模式切换 | 写 `application-propertis.json` 的 `l1.mode`（`code` / `chat`），可逆且幂等 |
| L1/L2/L3 | 请求触发一层 | 只写一份**待消费信号**，不是立即执行：要 pi 会话活着，并在下一轮结束（`agent_settled`）时由主进程消费，再经队列去重 |
| L1/L2/L3 | 停掉正在跑的子代理 | `stopSubagent` 同一序列：先拦（写停止标记）→ 杀进程树 → **确认已死才**做杀后修复；没确认则持有该层 |
| L2 | 块归档 / 恢复 | 持 **L2 运行级锁**，顺序是 `自愈 → 搬块 → 重建索引`；归档**必须给理由**（账本唯一凭据），恢复要占 `maxScenes` 名额 |
| L2 | 场景池报告 / 播种 | 报告只读、按需拉取（可能较慢）；播种写 `l1/scenes.json`（先自动备份）。`cluster` 仍需走 CLI |
| L3 | 条目增删改 | `l3_edit` 同一实现（`applyL3Edit`）：一次只动一条、单行、预算按"并入 live 之后的整篇"计价。**落盘目标是提议稿 `USER-temp.md`** |
| L3 | 提议稿还原 | 还原目标是提议稿（备份文件名不记"捕获自哪一份"），写前先把当前提议稿另存；要打字输入备份文件名 |
| L3 | 并入 live 画像 | **唯一会写 `USER.md` 的路径**。三道闸默认全开：提议稿比 live 旧 / 会删掉 live 过半条目 / 会清空 —— 每条都要**单独勾选放行**并打字 `MERGE`；写前自动备份。并入后运行中的会话仍注入旧快照，要 `/reload` 或新开会话 |

写盘桥的路由（**写端点默认 dry-run**，必须显式 `apply:true` 才落盘；破坏性动作另有 `confirm` 副验）：

| 端点 | 作用 |
|---|---|
| `POST /api/tombstone` | `{ids}` → 就地标记 `deleted:true`（备份 + 校验） |
| `POST /api/task-state` | `{ids, state, reason?}` → 就地改 `taskState`（**带跨进程写锁**） |
| `POST /api/l1/fix` | `{id, action, content?, evidence, reason?, priority?, force?, apply}` → 纠错四道闸 |
| `POST /api/l1/rollback` | `{backup, apply, confirm}` → 整库还原（`confirm` = 备份目录名） |
| `POST /api/l1/embedding` | `{op:"backfill"\|"rebuild", apply, confirm}` → 向量回填 / 重建（重建要 `confirm:"REBUILD"`） |
| `POST /api/l1/mode` | `{mode}` → `code` / `chat`（唯一没有 `apply` 的配置写入，可逆幂等） |
| `POST /api/trigger` | `{layer, reason?}` → 落一份待消费信号（**只入队**） |
| `POST /api/subagent/stop` | `{layer, job?, reason?}` → 停止序列（不可逆） |
| `POST /api/l2/archive` · `POST /api/l2/restore` | `{filename, reason?, apply}` → 块归档 / 恢复（L2 run-lock） |
| `POST /api/l2/scene-pool/seed` | `{scenes:[{name,aliases}], apply}` → 播种 `l1/scenes.json` |
| `POST /api/l3/edit` | `{action, content?, target?, apply}` → 提议稿条目增删改 |
| `POST /api/l3/restore` | `{file, apply, confirm, allowEmpty?}` → 还原到提议稿（`confirm` = 文件名） |
| `POST /api/l3/merge` | `{apply, confirm:"MERGE", allowStale?, allowMassRemoval?, allowEmpty?}` → 并入 live 画像 |
| `GET /api/l1/shards` | 分片清单 + 行数（解开前端日期窗口） |
| `GET /api/l1/backups` | L1 库备份目录清单（整库还原的候选） |
| `GET /api/l1/embeddings` | 向量库状态（只读、便宜） |
| `GET /api/l1/active-days` | 活跃会话日（权威源 `l0/conversations`；`hit-stats.json` 侧车会滞后） |
| `GET /api/l2/blocks` | L2 块目录列举 |
| `GET /api/l2/scene-pool/report` · `/merge-report` | 场景池只读报告（输出是**文本**不是 JSON；可能较慢，按需拉取） |
| `GET /api/l3/backups` | 画像备份清单（预览内容走静态路径 `/backups/user-backups/<file>`） |
| `GET /api/profile-files` | `MEMORY.md` / `USER.md` / `USER-temp.md`（在 profile 根，白名单读取） |
| `GET /api/limits` | 阈值与配置节（含 `l1.mode`，取值来自源码常量） |
| `GET /api/pending-triggers` | 三层待消费信号（**只读探查，不消费** —— 刷新页面不会把信号吃掉） |
| `GET /api/subagent-runs` | 正在跑的子代理（"停止"按钮的依据） |
| `GET /api/pipeline/jobs` | `pipeline/jobs.sqlite` 的**只读**转储（排队 / 在跑 / 最近结束；队列按认领顺序） |
| `GET /api/viewer-status` | 源码版本 vs 已部署版本（漂移检测） |

**两个会咬人的约定**（改桥或加页面前先读 `scripts/l1-admin/viewer-bridge.mjs` 头部）：桥把路径取成 `req.url.split("?")[0]`，所以**GET 端点不能带查询串**（需要参数的读操作走路径段，写操作一律 POST）；桥是**单线程 + `execFileSync`**，一次 CLI 调用期间整座桥都不响应任何请求，所以长任务在页面上必须显示"运行中"。

桥**默认只绑定 `127.0.0.1`**、只在手动运行时存在，但它的 CORS 是全开的（为了支持 `file://` 页面带 `?port=` 回连），所以**运行期间本机任何页面都能读到 `l1/records/*.jsonl` 等内容，也能调用上面这些写端点**（含写 live 画像与整库还原）；`config/` 已被显式挡在静态托管之外（那份 JSONC 含 embedding API key），需要配置节一律走 `/api/limits`。用完请关掉。

加 `--lan` / `--host <addr>` 时会额外监听局域网网卡（见上文「要在别的设备上打开」）——那是**显式**动作，因为它把上面这段风险从"本机"扩大到"同网段的任何设备"，且仍然没有鉴权。桥在启动时会把这个代价原样打印出来；`verify-viewer-deploy.ts` 的 ⑰ 节也钉住"默认只有环回"与"页面按自身 hostname 拼桥地址"两条，免得哪天被顺手改成默认监听 `0.0.0.0`。

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

改查看器（`viewers/`）时另有两个针对性门禁：

```bash
node --conditions=import --experimental-strip-types scripts/verify-viewer-quality-parity.ts  # 质量分 JS ↔ TS 数值全等
node --conditions=import --experimental-strip-types scripts/verify-viewer-deploy.ts          # 部署机制 + 静态完整性
```

后者包含三条**不需要浏览器**的检查，都是开发期真实踩到过的错：查看器 JS 的语法、
HTML 引用的资源是否存在、页面调用的 `/api/*` 端点在 `viewer-bridge.mjs` 里是否真的声明了。

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
