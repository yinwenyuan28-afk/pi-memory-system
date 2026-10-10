# l1-admin —— L1 原子记忆管理工具集

L1 原子记忆（`{profile}/memoryDB/l1/records/*.jsonl`）的日常管理工具，沉淀自 2026-09-11「L1 全量审计 + 清理」实战（233 条逐条处置、两次踩坑后定版）。

## 工具一览

| 工具 | 作用 | 安全默认 |
|---|---|---|
| `tombstone.mjs` | 按 id 作废记录（就地标记 `deleted:true`） | `--dry-run` 默认；`--apply` 实写前自动备份 |
| `rewrite.mjs` | 改写记录（新 id 追加 + 旧行就地标记） | 同上 |
| `verify.mjs` | 库体检：行数/存活/坏行/同 id/畸形/错误串白名单 | 只读 |
| `health.mjs` | 健康指标：超长/test 残留/孤儿 stats/自造 id/畸形/错误串 | 只读 |
| `rollback.mjs` | 从备份目录恢复 L1 records | `--dry-run` 默认；实恢复前自动备份当前库 |
| `scene-pool.mjs` | **工作场景池**运维：`report`（池状态 + 批级指标）/ `cluster`（历史场景名聚类）/ `seed`（按映射提案播种）/ `merge-report`（合并候选） | 除 `seed --apply` 外全部只读；`seed` 默认 dry-run，实写前自动备份 `scenes.json` |
| `task-state.mts` | 标记任务生命周期（就地改顶层 `taskState`，与 `l1_task_state` 工具同一实现） | 默认 dry-run；`--apply` 写盘；`--backup` 可选（**默认不备份**，理由见下） |
| `l1-fix.mts` | L1 纠错（改写正文 / 作废），转发 `fix-tool.ts` 的 `runFix` | 默认 dry-run（走抽出来的 `checkFixGates`，**不含 IO 级校验**）；`--force` 只解高价值那道闸 |
| `embedding.mts` | 向量库 `status` / `backfill` / `rebuild` | `status` 只读且便宜；另两个要 `--apply`，`rebuild` 还要 `--confirm REBUILD`（会先清空向量库） |
| `trigger.mts` | **请求某层入队**（`--layer l1\|l2\|l3`）或 `--status` 探查三层信号 | 只落一份待消费信号，**不是立即执行**；落完回读确认 |
| `l1-mode.mts` | L1 提取模式读写（`--set code\|chat`） | 唯一不要求 `--apply` 的写操作（可逆、幂等）；写完回读确认 |
| `subagent-stop.mts` | 停掉某层子代理（`--layer`，`--list` 看在跑哪些） | 与 `/my-memory:subagent-kill` 同序列；不可逆，故**无 dry-run** |
| `l2-archive.mts` | L2 块 `list` / `archive --file --reason` / `restore --file` | 持 **L2 run-lock**；归档必须有 reason；默认 dry-run（预演不跑自愈） |
| `l3-edit.mts` | L3 提议稿条目 `add` / `update` / `delete`，转发 `applyL3Edit` | 默认 dry-run；写 `USER-temp.md`（提议稿），不碰 live |
| `l3-restore.mts` | 列出 / 还原画像备份到提议稿（`--list` / `--file --confirm`） | 写前先另存当前提议稿；空备份默认拒（`--allow-empty` 才放行） |
| `l3-merge.mts` | **把提议稿并入 live `USER.md`**（全仓库唯一写 live 画像的路径） | 三道闸默认全开（陈旧 / 过半删除 / 清空），每条要单独放行；实写要 `--confirm MERGE` |
| `viewer-cli.mts` | 上面那批包装的**共用骨架**（参数解析 / JSON 出口 / 哨兵收尾 / `run()`）；不是可执行入口 | — |
| `viewer.mts` | **一键启动查看器**：同步最新页面 → 起桥 → 开浏览器（自动避让占用端口） | 只绑 `127.0.0.1`；`--no-open` / `--no-sync` 可关掉两件事 |
| `启动查看器.cmd` | 上面的 Windows 双击入口（内容纯 ASCII，中文由 node 打印） | 同上 |
| `viewer-bridge.mjs` | **查看器写盘桥**：静态托管 `memoryDB` + 写盘端点 + 目录列举 + 诊断 | 只绑 `127.0.0.1`；写端点默认 dry-run，破坏性动作另有 `confirm` 副验 |
| `pipeline-jobs.mts` | **只读转储 `pipeline/jobs.sqlite`**（排队 / 在跑 / 最近结束；「流水线」页的取数口） | 只读（`node:sqlite` 的 `readOnly` 打开）；库不存在时报 `exists:false`，**不顺手建库** |
| `viewer-status.mts` | 查看器版本与漂移诊断（源码内容版本 vs 已部署版本） | 只读 |
| `viewer-limits.mts` | 查看器要展示的阈值（`l1.mode` / `l2.maxScenes` / L3 各限额），从源码常量透出 | 只读；**不暴露含密钥的 `config/` 整份文件** |
| `active-days.mts` | 活跃会话日清单（权威源 `l0/conversations`） | 只读 |

公共参数：`--profile <dir>`（默认 `C:/Users/leaf/.pi/agent/profiles/default`）、`--dry-run` / `--apply`。

> `.mts` 需 `node --experimental-strip-types` 执行（Node ≥22.13）。之所以有这几个 `.mts`：它们是
> 「网页 ↔ 扩展 `.ts` 实现」的桥 —— `.mjs` 不能 import `.ts`，而查看器用到的阈值、版本哈希、
> 活跃日口径必须与源码**同一份实现**，所以由 `.mts` 转发，绝不在 `.mjs` 里重写一遍。

### `task-state.mts` 为什么默认不备份

本目录其它写者（`tombstone` / `rewrite` / `migrate-task-state`）都是"实写前自动备份"，那是它们的安全默认。
`task-state` 刻意不同，因为这个动作的风险档次不一样：

- `tombstone` 让记录**死掉**（退出召回与向量）、`rewrite` 换掉正文 —— 从结果看不出原来的样子，必须能回滚；
- `taskState` 只是就地改一个状态字段：**可逆**（改回去即可）、幂等、留审计、不动正文/编号/向量。
  而且**查看器界面上的切换按钮**会随时调用它 —— 每次点击都把整个 `l1/records` 备份一遍，
  既拖慢交互又把 `backups/` 淹没。

所以备份改为显式 `--backup`（人工批量操作时加）。批量迁移另有 `scripts/migrate-task-state.mts`，自带 `--apply` 前备份。

## 查看器写盘桥（viewer-bridge.mjs）

```bash
# 一键（推荐）：同步页面 + 起桥 + 开浏览器
npm run viewer                       # 或 node --experimental-strip-types scripts/l1-admin/viewer.mts
# Windows 双击：scripts\l1-admin\启动查看器.cmd

# 只起桥（自己控制端口、不自动开浏览器）
node scripts/l1-admin/viewer-bridge.mjs [--port 5174] [--profile <dir>] [--lan] [--host <addr>]

# 局域网调试：别的设备也能打开（环回保留，额外听本机那张局域网网卡）
npm run viewer -- --lan                    # 或 启动查看器.cmd --lan
```

`viewer.mts` 的三件事，都是"每次都要做、忘了就出问题"的机械步骤：
① 调 `deployViewers` 同步最新页面（幂等，内容没变零写入）；② 从 5174 起探测空闲端口（**5174 被占时
不再直接退出**——实测被占过一次，之后每次都要手动 `taskkill`）；③ 打开浏览器到 `viewers/index.html`。
profile 用扩展的 `ProfileManager` 解析（读宿主 `settings.json` 的 `memorySystem.activeProfile`），
避免"查看器看 A profile、扩展写 B profile"这种无声错配。停止：关掉控制台窗口，或 Ctrl+C。

**`--lan` / `--host <addr>`（局域网调试，2026-10-09 按用户要求加）**：在环回之外**额外**监听本机那张
局域网网卡（`--host 0.0.0.0` = 所有网卡，那时它本就覆盖环回、不再重复听），并把给别的设备用的地址打印出来。
"哪块网卡算局域网"的规则只在 `lan-addresses.mjs` 一份（优先 `172.16.10.0/24`，其次其它私有段），
启动器与桥共用 —— 各写一份迟早出现"启动器打印 A 地址、桥实际听 B 地址"这类最难查的错配。
**它是显式开关而不是默认行为**：那个地址上**没有鉴权**、CORS 全开，写端点（改任务状态 / 删除 /
并入 live 画像 / 整库还原）同网段任何设备都能调 —— 启动时会把这段代价原样打印，⑰ 节也钉住
"默认只有环回"。`config/`（含 embedding API key）在静态托管之外，局域网也取不到。

| 端点 | 作用 |
|---|---|
| `POST /api/tombstone` | `{ids}` → `tombstone.mjs --apply`（备份 + 就地标记） |
| `POST /api/task-state` | `{ids, state, reason?}` → `task-state.mts --apply`（**取跨进程写锁**，拿不到锁一条都不写） |
| `POST /api/l1/fix` | 纠错（`l1-fix.mts` → `runFix`：证据门槛 / 24h 防抖 / 高价值保护） |
| `POST /api/l1/rollback` | 整库还原（`rollback.mjs`；`confirm` 必须等于备份目录名） |
| `POST /api/l1/embedding` | 向量回填 / 重建（`embedding.mts`；重建要 `confirm:"REBUILD"`；**长任务，期间整座桥不响应**） |
| `POST /api/l1/mode` | L1 提取模式 `code`/`chat`（唯一无 `apply` 的配置写入，可逆幂等） |
| `POST /api/trigger` · `POST /api/subagent/stop` | 请求某层入队（**只落信号**）/ 停掉某层子代理（不可逆） |
| `POST /api/l2/archive` · `/api/l2/restore` · `/api/l2/scene-pool/seed` | 块归档 / 恢复（L2 run-lock）/ 场景池播种 |
| `POST /api/l3/edit` · `/api/l3/restore` · `/api/l3/merge` | 提议稿条目增删改 / 还原到提议稿 / **并入 live 画像**（三道闸 + `confirm`） |
| `GET /api/l1/shards` · `/api/l1/backups` | `l1/records/*.jsonl` 清单 + 行数；`backups/l1-admin/*` 备份目录（浏览器列不了目录） |
| `GET /api/l1/embeddings` · `/api/l1/active-days` | 向量库状态（便宜）/ 活跃会话日（权威源；`hit-stats.json` 侧车会滞后，实测差过 1 天） |
| `GET /api/l2/blocks` · `/api/l2/scene-pool/report` · `/merge-report` | L2 块目录列举；场景池只读报告（**输出是文本不是 JSON**，且可能较慢 ⇒ 页面按需拉取） |
| `GET /api/l3/backups` · `/api/profile-files` | 画像备份清单 / profile 根的 `MEMORY.md`+`USER.md`+`USER-temp.md` |
| `GET /api/limits` | 阈值与配置节（含 `l1.mode`） |
| `GET /api/pending-triggers` · `/api/subagent-runs` | 三层待消费信号（**只读探查，不消费**）/ 在跑的子代理 |
| `GET /api/pipeline/jobs` | 作业队列只读转储（`pipeline-jobs.mts`；「流水线」页用） |
| `GET /api/health` · `/api/viewer-status` | 存活 / 版本与漂移 |

**写端点一律默认 dry-run**（必须显式 `apply:true`），破坏性动作另有 `confirm` 副验（还原要备份名、
重建要 `REBUILD`、并入要 `MERGE`）—— 桥里那道是**副验**，CLI 自己也会验一次，两道都在。
这条安全默认由 `verify-viewer-deploy.ts` 的 ⑱ 节逐端点断言。

二十个**实测踩过**的点，改动时别踩回去：
1. **`req.url` 必须 `decodeURIComponent`**。浏览器的 fetch 会把非 ASCII 文件名百分号编码，
   不解码就会去找字面名为 `%E4%B8%AA…` 的文件 → **L2 的块（全是中文名）整批 404**，而页面不报错、
   只是默默显示索引兜底值。
2. **`/api/profile-files` 是必需的**，不能靠相对路径。桥只挂载 `memoryDB`，而画像文件在 profile **根**
   （上一级）；页面里写 `../../USER.md` 只会解析回 `/USER.md` = `{memoryDB}/USER.md` → 404。
3. **CLI 的 stdout 要先跳过前置日志再解析 JSON**。`autoBackup` 会 `console.log` 一行
   「已自动备份：…」，整段 `JSON.parse` 会把一次**成功**的写盘报成 500。桥里用 `parseCliJson`
   从第一个 `{` 起解析。
4. **别用 `node --check <file.mts>` 做语法门禁 —— 它会对含 `import` 的 `.mts` 假绿**。
   Node 24 实测：`.mts` 带 import 时 `--check` 走 `cjs/loader.wrapSafe` 那条路径后**静默返回 0**，
   而同样内容写成 `.mjs` 才会真的报错。也就是说这个组合恰好对**本目录所有真实 CLI**（都以 import 开头）
   失效 —— 一条从不报警的门禁比没有门禁更糟。可行做法见 `verify-viewer-deploy.ts` 的检查 ⑮：
   先用 `module.stripTypeScriptTypes` 去类型，再把源码从 stdin 交给 `node --input-type=module --check -`。
5. **改查看器样式时别写 `scrollbar-color` —— 它会让滚动条变宽**。实测（Chrome 146 / Electron 41）：
   侧栏滚动条不指定 = 11px，一指定 `scrollbar-color` 就退回 16px 的经典滚动条（带箭头），
   比完全不指定更糟；让原生控件（滚动条 / select 弹层 / 复选框 / search 清除按钮）变暗的是
   `:root { color-scheme: dark }`，滚动条外形交给 `::-webkit-scrollbar`。
   同一类"静默失真"的坑还有：别在 JS 里内联十六进制色值（色值只留 `viewer.css` 的 `:root` 一份）、
   别用 `.bar-track > i` 这种 (0,1,1) 选择器给 `.c-*` 工具类兜底（会压过 (0,1,0)，把条形图变成兜底灰）。
   完整界面契约在 `viewers/assets/viewer.css` 文件头；以上三条由 `verify-viewer-deploy.ts` 的 ⑯ 节断言。
6. **别在 `aside` / `.wrap-scroll` 上写 `overscroll-behavior: contain`**（用户报过"L2 页鼠标滚动失效"）。
   实测只要容器带 `contain`，滚轮就被它吞掉，**哪怕它根本没有可滚内容** —— L2 的块表格是
   `overflow:auto` 但内容不溢出、又占了内容列大半，于是滚轮在那一大片区域完全没反应；
   把 `overscroll-behavior` 改回 `auto`，同一个手势立刻能把页面滚下去（同坐标对照实验）。
   `contain` 只保留在弹层上（打开弹层时拦住滚轮、别滚动背景）。这条同样由 ⑯ 节断言。
7. **`?port=` 丢了不会报错，只会静默变只读**（用户就是拿"无写盘桥"来问的）。页面靠 query 里的 `?port=`
   才知道桥在哪，所以：① 页内跳转必须带 `location.search`（顶部导航曾漏掉，在总览页点一下导航就中招，
   L2 会冒出 3 处"无写盘桥"）；② 桥的根路径 `/` 必须 **302 到带 `?port=` 的总览页** ——
   就地返回 `index.html` 会让相对引用的 `assets/*` 解析成 `/assets/*` 全 404、连 `window.V` 都没有，
   而桥启动打印的第一行正好是这个根路径（终端里可点）；③ 真丢了 query 时页面顶部要给出可操作提示，
   与 `file://` 的提示分开写（两种降级原因不同）。三条由 ⑰ 节断言。
8. **桥的 URL 是 `req.url.split("?")[0]` —— GET 端点接不了查询串**（2026-10-08 补齐管理操作时定的约定）。
   加 `?cmd=report` 这种参数不会报错，只会静默走到 404 分支。需要参数的**读**操作一律用**路径段**
   （`/api/l2/scene-pool/report`），**写**操作一律 POST + JSON body。⑱ 节断言这条约定还在，
   并且页面里不许出现给 `/api/*` 挂查询串的写法。
9. **收尾函数只写 JSON 不中止执行 ⇒ 脚本会输出第二个 JSON ⇒ 桥解析失败**（实测踩到）。
   `viewer-cli.mts` 的 `finish/fail/usageError` 现在是**抛哨兵异常**（`ExitSignal`），脚本主体必须包在
   `run(async () => …)` 里；否则守卫写完错误后代码会继续往下跑（`trigger.mts --layer l9` 甚至还会去写一个
   `pending-trigger-l9.json`），两个 JSON 首尾相连，`JSON.parse` 整段失败 —— 一次说得清清楚楚的拒绝
   被报成"CLI 未返回可解析的 JSON"。约定写在 `viewer-cli.mts` 头部。
10. **"说人话"的 CLI 不能走 JSON 解析**。`rollback.mjs` / `scene-pool.mjs` 输出的是文本报告（分隔线 + 表格），
   拿 `parseCliJson` 去啃要么得 null（把成功报成失败）、要么啃出半截对象。桥里为此单列了
   `passthroughText`，与 `passthrough` 分开。
11. **桥是单线程 + `execFileSync`：一次 CLI 调用期间整座桥不响应任何请求**（向量回填/重建、场景池报告）。
   这不是能靠并发解决的问题，所以页面必须显示"运行中、勿重复点"，长任务用长超时
   （回填/重建 30 分钟）。要真并发得把执行改成"子进程 + 轮询状态"，本轮没做。

12. **`.ops-note { grid-column: 2 }` 不能当全局规则写**（2026-10-09 视觉巡检）。`.ops` 是**单列**网格，
   只要它有一个**直接子级**被 `grid-column: 2` 推到第 2 列，隐式网格就会多出一列，之后所有自动放置的
   子级开始两列交替 —— 实测 L2 侧栏整块右移 106px，被 `aside`（`overflow: auto`）裁掉，
   而且按钮中心点正好落进主区表格的 `td` 上，**看得见一条白边、点不到**。
   结论：`grid-column` 只写 `.ops-row > .ops-note`，`.ops` 的直接子级保持 auto。
13. **`th { white-space: nowrap }` 只能点名给需要的那张表**。全局开会让播种表（`table-layout: fixed`
   + 三等分列，列宽 80px）的「别名（逗号分隔）」直接**溢出 18px 压到隔壁列** —— fixed 布局不会为了
   内容加宽列。场景块表的「成员」「updated」换行是另一个问题，用 `#blockTable th` 点名即可。
   配套：`td.day` 让「2026-09-12」不被拆成两行。
14. **`.full-content` 的 `max-height` 必须与 `-webkit-line-clamp` 对齐**。clamp 要 6 行、行高 1.55，
   6 × 1.55 = **9.3em**，原来写的 `8.8em` 比 6 行矮 —— 每张卡片第 6 行都被切掉下半截（连省略号一起）。
   另外 clamp 生效时 `scrollHeight` 报的是**截断前整篇**，别拿它判"有没有被裁"，要拿它和
   `行数 × 行高` 比。
15. **`.ops-ctl` 里的控件不许带固有宽度**。`select` 的固有宽度取**最长选项**、`input.confirm-input`
   写死 `min-width: 220px`，而 336px 侧栏的控件列只有 ~153px（危险区被 `.danger-zone` 的内边距再吃一圈，
   只剩 141px）—— 实测分别溢出 **441px / 79px**，`aside` 是 `overflow: auto`，表现为侧栏横向滚动条 +
   控件被裁。统一 `min-width: 0; max-width: 100%`，危险区的 `.ops-row` 改单列让控件拿满宽度。
   同理，备份下拉的选项文案要把**能区分彼此的部分放最前**：5 个 `backfill-*` 目录只有末尾时间戳不同，
   目录名打头的话它们在框里显示成一模一样的 `backfill-project-`。
16. **写死的 `max-width` 要对着真实容器量**。`.chip.scene` 原来写死 340px，实测 253 个未归类 chip 里
   **213 个被截**，而卡片头其实还有 ~130px 空位没用。改成 `max-width: 100%` 后只剩 12 个真放不下的
   （省略号 + `title` 悬停看全名是既有设计，保留）。同一类问题：`input[type=search]` 只有 `min-width`
   没有 `flex-grow`，占位符写的是可搜字段全清单，结果被裁成「搜索 content / 场景 / 项目 / id / ƒ」。
17. **断不开的长 token 会顶大表格列的 min-content，逼出整张表的横向滚动**。丢弃留痕表的正文列是
   `white-space: pre-wrap`，一个 `/my-memory:l2-trigger` 这种断不开的 token 把整表撑到 **1195px >
   容器 1014px** —— 于是右边被切，而滚动条远在 118 行之下的 `.wrap-scroll` 底部，等于"看不见能滚"。
   给正文列补 `overflow-wrap: anywhere` 后 min-content 回落，整表正好 1014px 放下，
   顺带那 8 处"文字比格子宽"也一起消失。判"有没有压到隔壁列"要用**边框盒**比，不是内容盒
   （内容盒到边框盒之间还有 9px padding，差几像素只是行尾空格的舍入）。
18. **"只读打开"一个 WAL 库也会留下痕迹，而"看一眼队列"不该顺手建库**（2026-10-09，`pipeline-jobs.mts`）。
   实测（Node 24.17）：`new DatabaseSync(p, { readOnly: true })` 打开一个 WAL 模式的 sqlite 后，
   目录里会多出 **0 字节的 `-wal` 与 `-shm`** —— 那是 WAL 机制的正常产物，不是写数据，
   所以门禁**不要**断言"调用后没有这两个文件"（会假红）；该断言的是库内容不变（字节数 + 行数）。
   真正要守的是另一件：**库不存在时不能建**。用 `PipelineJobsDB`（扩展里那个类）就会踩这一条 ——
   它的构造函数 `mkdir` + `PRAGMA journal_mode=WAL` + 建表，于是"从未跑过流水线"会被工具洗成
   "有一个空队列"，两种事实混成一种。`pipeline-jobs.mts` 因此先 `existsSync` 再以 `readOnly` 打开，
   不存在就回 `exists:false`（实测主进程持写锁时只读依然能读，WAL 下读者不阻塞写者）。
   同一条上还有两个小口径：`queued` 的排序是**认领顺序**（复刻 `jobs-db.ts:listQueued`：L3 永远最后），
   它决定页面上"下一个跑谁"，改了那边要同步改这边；`recent` 按 **id 倒序**而不是时间字符串排序
   （id 自增，等于"最近的在前"，不依赖 time 文本可比）。
19. **Blink 里 `<button>` 的宽度按内容收缩 —— 放进普通块容器里不会撑满**（2026-10-09，L1 侧栏二级菜单）。
   侧栏那套 `.btn-list` 一直是 flex 列，按钮作为 flex 项被 stretch 撑满，所以这个行为从没暴露；这次给
   `work_task` 行外面包了一层容器（`.type-branch`，里面再放二级列表），父行立刻缩到内容宽 ——
   实测 **140px 而容器 293px**：右侧空出一大截，展开把手飘在行中间。修法是让外层也 flex
   （`display: flex; flex-direction: column`），父行重新变成 flex 项被撑满。
   这条只能靠**量宽度**发现：它不溢出、不错位、体检脚本（越界/裁剪/重叠/对比度）全绿，
   336px 宽的侧栏里肉眼也很容易看成"本来就该这么宽"。
20. **"契约写在注释里"不算契约，得有 CSS 规则 + 断言**（2026-10-09，用户报"切换按钮与预演按钮和周围格格不入"）。
   `viewer.css` 的管理面板一节早写着「破坏性动作 = 描边按钮，预演/只读 = 文字动作」，但**没有任何规则落实它** ——
   每个按钮走的都是全局那条"实心块"基样式（`--panel2` 底 + 描边 + 13px/34px）。于是同一列 336px 侧栏里
   并存两套语言：类型菜单是 12px/31px 透明行、选中靠墨色竖条，操作区却是实心砖块，而「当前 code」
   还用 `.primary` 的整块浅色（`--ink`）—— 侧栏里最亮的元素居然是个只读状态。
   修法是把四种语义各写成一条规则（默认 = 透明底无描边；`.active` = 墨色横条，与页签同款；
   `.primary`/`.danger` = 只描边不填底），并把它们钉进 `verify-viewer-deploy.ts` 的 ⑯ 节 ——
   否则下次有人"顺手"给某个按钮加回来，还是没人拦得住。
   同一次用户报的还有一处同源问题：**分组标题别与行标签同名**（`h3.sub「提取模式」` + `行标签「提取模式」`
   = 同一句话连写两遍）。判断标准很简单：标题只有在比行标签**多给出信息**时才值得存在（L2 的
   「场景池报告（按需生成，不随页面加载）」就是），否则它只是把侧栏撑长 78px。
   **补充（同一天晚些时候）**：定完契约要**一次扫完所有页面**，否则同一语义在两处仍是两种样子 ——
   当时改了 L3 的 `#opsPreview`，漏了 L1 详情弹层里的 `#fixPreview`，于是两个「预演」一个描边一个透明。
   扫的办法就是 `grep -rn 'class="primary"' viewers/` 逐条看它在不在 `.ops-ctl` 里。
21. **同一份内容在两处渲染时，样式不会跟着走 —— 删掉其中一个视图会把另一个的旧缺陷暴露出来**
   （2026-10-09，L1 详情弹层）。卡片正文与弹层正文是同一个 class（`.full-content`），但只有卡片那条规则
   写了 `white-space: pre-wrap`（卡片那组还要 `-webkit-line-clamp: 6` 做截断）。弹层没有自己的规则，
   于是多行正文的换行被折成空格 —— 实测一条 3 行正文在弹层里 `textContent` 3 行、`innerText` **只有 1 行**、
   高度 81px（全是自动换行凑出来的）。这个缺陷存在很久却看不出来，因为弹层里另有一个 `textarea` 编辑框
   （textarea 天然保留换行），点一下「编辑正文」就能看到真身；本轮把那个"仅本页预览"的编辑框删掉后，
   弹层成了**唯一**的全文视图，缺陷立刻变成"看不到原文结构"。判断换行有没有被折，只需比
   `textContent.split("\n").length` 与 `innerText.split("\n").length`（`innerText` 是布局感知的，
   折过的换行在它那里就没有了）。
   同源教训：删掉一个视图时，除了问"还有谁在用这个 id"，还要问 **"它原来替谁兜住了什么"**。
22. **"定完契约"只改了一个作用域 ⇒ 只修了 1/7**（2026-10-10，用户报"UI 风格很不统一"）。
   10-09 那次诊断（按钮走的是全局"实心块"基样式）与修法都对，但**只覆盖了 `.ops-ctl`** ——
   于是同一页里 `.ops-ctl` 是 12px/31px 的透明行，而页头 / 页签 / 表格行 / 卡片脚 / 弹层页脚
   仍是 13px/34px 的实心砖块。第二天用户就报"很不统一"，量出来是 **7 种外观、4 档尺寸、
   三副"选中"**。根因不是漏了几个选择器，而是**语言被写在作用域里**：基样式替所有按钮做了
   一个决定，各作用域再各修各的，就必然分叉。修法是把语言收到基样式位置（默认 = 文字动作，
   `.primary` / `.danger` / `.active` 三个修饰），**作用域只准覆盖尺寸与间距**。
   可复用的量法（本轮就是它把问题变成数字的）：给每个可见按钮算一个"外观指纹"
   （背景色 + 描边色 + 描边样式 + 文字色 + 字号 + 高度），**去重后的组数就是"有几种外观"**；
   只算可见且不在关闭的 `details` 里的元素，否则会被隐藏页签里的按钮污染。
   **同日第二轮：方向搞错了一半。** 第一版把默认做成"无描边 + 静音色"的**文字动作**，当天就被
   用户否掉 ——「重新加载、清空、导出当前视图…看起来就像是没有样式，和背景融为一体了」。教训是
   **"统一"要先问清要统一成什么**：这一轮削掉的是**可点性**（描边），而"不统一"真正的病根是
   **底色块 + 尺寸分叉**。最终定版一句话判据：**描边给的是"这能点"，底色才决定轻重** ——
   默认 = 描边动作（透明底 + `--border` 描边 + 正文色）；文字动作只给 `.btn-list` 列表行 /
   卡片脚 / 播种表三处"读起来不是按钮"的地方；分段切换（`.seg`）用凹槽代替描边。
23. **给字段写样式别逐个点名 `input[type=...]`**（2026-10-10，同一次巡检顺手抓到）。
   字段样式原先只写了 `input[type="search"]` 与 `input[type="text"]`，于是详情弹层里
   `type="number"` 的 priority 框**从来没被覆盖过**，一直是浏览器原生样式：2px inset 灰边 /
   0 圆角 / 22px 高 / 13.33px 字 —— 紧挨着它的文本域却是 1px 描边 / 8px 圆角 / 34px 高。
   它不报错、不溢出、体检脚本也不查控件内部，**只有把两个框并排量才会发现**。
   修法是按"除了勾选类都算字段"写：`input:not([type="checkbox"]):not([type="radio"]), select, textarea`。
24. **选中态有两个隐形规则：线在不同朝向要写两套，而且 `.active` 的特异度比 hover 低**（2026-10-10）。
   用户报"按钮被点击之后的样式是在侧边多一条白线，不太好看"。那条线是 `box-shadow: inset 0 -2px 0
   var(--ink)`（横排）/ `inset 2px 0 0`（竖排）—— `--ink`(#c8d4e0) 在深底上读起来是一条**发白的
   线**，像渲染残留而不像"选中"，而且同一条状态因为朝向不同有两副样子。改成只给一层 `--panel3`
   底色、不画线（顺带把 `.nav a.item.active` 从"panel2 + 描边"收进同一档）。
   第二个坑是改完才发现的：`button:hover:not(:disabled)` 的特异度 (0,2,1) **高于** `.active` 的
   (0,1,1) —— 只写 `.active` 的话，鼠标划过选中项会把它从 `--panel3` 压回 `--panel2`（比选中更暗），
   看着像"选中丢了"。必须补一条 `button.active:hover:not(:disabled)`。
   量法：`cua.move` 悬停 → `el.matches(":hover")` + `getComputedStyle(el).backgroundColor` 前后对比。
25. **"一排按钮"会被读成状态展示，"一个下拉"才是可以改**（2026-10-10，用户："看起来就像是展示状态"）。
   任务状态原是三颗带虚线/实线/点线的描边按钮并排（当前那颗填充 + 禁用），设计意图是"三选一
   切换器"，但用户读成了"这条记录有这三种状态"，并要求收进下拉。根因：**形状编码让每颗都像在
   陈述某种状态**，而"当前值 = 禁用"这个约定只活在 CSS 里（`opacity:1` + `--panel3`），页面上
   没有任何"这里可以改"的控件级暗示。换成 `#taskState` 下拉后（字段外观 = 与页头那些 select 同一套），
   一眼就是"这是个值、能换"。**通则：就地改一个枚举值，用字段（select），不要用一排按钮。**
   下拉比按钮多一个坑：**失败时必须把控件拨回真实值**（判定 `row.taskState` 是否真的变了），
   否则下拉会停在一个"盘上并不存在"的状态上。
26. **字号层级要对着"同级内容"量；表单控件会继承 body 字号，容易在外壳里变成最大的那个**（2026-10-10）。
   用户报「左侧的菜单栏中出现了标题大小比下面的具体内容小的问题」，查出来是两处叠加：
   ① 侧栏分组标题与区段标题都写成 `--t-xs`(11px)，而内容行是 `--t-sm`(12px) —— **标题比正文小 1px**。
   那是按"eyebrow 标签"压的小字号，可既然当标题用，压小就是把层级写反了（读起来像注释）：
   改成 13px / 12px，层级靠"分隔线 + 字重 + 静音色"表达，不靠压小标题。
   ② 改完①才暴露的第二处：它们下面的**下拉框是 13px** —— 字段规则写的是 `font: inherit`，
   控件继承了 body 的 13px，而整页外壳（按钮/行/单元格/说明）都是 12px。把控件字号钉在 `--t-sm` 才根治。
   可复用的扫法：对每个 `h1–h4` 取**下一个兄弟元素**，算那棵子树里**带文字**节点的最大字号，
   比标题大就报出来（本轮 L1 报 3 处、改后全 0）。
27. **换架构时，为旧架构写的门禁会集体变成"假绿"**（2026-10-10，查看器改 Vue 3 + Element Plus）。
   `verify-viewer-deploy.ts` 里 ⑪ 查的是"页面 JS 里 `$("x")`/`getElementById("x")` 的 id 在 HTML 里存在"，
   ⑯ 查的是 `viewer.css` 里的按钮基样式、`.seg` 凹槽、`.ops-ctl button` 无背景 —— 换成 Vue 之后
   `$()` 全部消失、`viewer.css` 整个被替换。若只改页面不改门禁：⑪ **一个 id 都不查 = 恒真**，
   ⑯ 会直接读一个不存在的文件（或更糟：读到一个已无人引用的残留文件）而"全绿"。
   **通则：门禁断言的是"当前架构的失效模式"，架构一换，那一节必须同一轮重写，并在注释里写明
   旧断言为什么失效** —— 否则门禁本身变成新的静默误导来源。（本轮 ⑪ 改成"挂载点 `#app` 存在 /
   `#nav`·`#modeBanner` 在挂载点之外 / `active` 指向自身页面 / 六个脚本的加载顺序"，
   ⑯ 改成"EP 令牌桥 + 契约 2~5 + 三条新架构硬约束"。）
28. **Element Plus 的单向 `:current-page` 会把整个分页渲染成一个空注释节点**（2026-10-10 实测）。
   `<el-pagination :current-page="page" …>`（不带 `v-model:`）→ 组件标签在、DOM 全无，只剩一个
   `<!---->`；**不报错、不警告**，`#app` 里也看不出少了什么。同一个 `total/pageSize` 组合只要改成
   `v-model:current-page="page"` 就正常渲染。发现方式：隔离测试（在同一页里 `createApp` 一个
   只含分页的应用，对照不同属性组合）——**凡是"组件没报错但 DOM 是空的"，都该这样二分属性**，
   而不是盯着自己的页面猜。
29. **内置 UMD 库的加载顺序是硬约束，错了直接白屏**（2026-10-10）。Element Plus 的 UMD 包装是
   `(function(e,t){…t(e.ElementPlus={}, e.Vue)})(this,…)` —— 它在**加载时**就取全局 `Vue`，
   所以 `<script src="vue.global.prod.js">` 必须在 EP 之前；中文语言包挂在 `ElementPlusLocaleZhCn`，
   又要排在 EP 之后、`viewer-vue.js` 之前（后者在 `app.use()` 里用它）。顺序见
   `viewers/assets/vendor/README.md`，⑪ 逐页断言六个脚本的下标严格递增。
30. **引入组件库最需要防的回退，是它自带的强调色**（2026-10-10）。EP 的 `--el-color-primary` 默认
   `#409eff`（蓝），而本仓库的契约 1 是"外壳无彩度、色相只属于数据"—— 不映射就会往复选框、焦点环、
   选中项、链接上泼一层第二强调色，正是这次重构最想避免的风格回退。做法：`viewer-theme.css` 把
   `--el-color-primary` 指到墨色 `--ink`，并把 `--el-bg-color / --el-border-color / --el-text-color-* /
   --el-color-success|warning|danger / --el-component-size` 全部接到本仓库令牌。**风险点是它静默失效**：
   EP 大版本会重命名 `--el-*` 变量，主题桥于是什么都不做、页面悄悄回到默认蓝，而代码里一行都没改
   —— 所以 ⑯ 逐条断言这组映射，`vendor/README.md` 的升级步骤第 4 条也专门点了这一项。
31. **"没有构建步骤"不是省事，是这次重构能活下来的前提**（2026-10-10）。同一套页面在 2026-08-23
   已经 Vue 化过一版（`vue-viewer/`：Vite + `src/*.vue` + `package.json`），它死在没有 `node_modules`、
   没有 `dist` —— 而部署链路（`memory/viewers/deploy.ts` 按内容哈希逐文件同步）只认"仓库里的普通文件"，
   构建产物没有任何东西负责让它跟版，最后被 `RETIRED_PATHS` 移进 `backups/viewers-retired/`。
   这次改成**内置 UMD 文件 + classic script**：源文件本身就是产物，于是它自动被哈希清单、漂移检测、
   退役机制覆盖，一行部署代码都不用改。代价要记住：仓库里多 ~1.6 MB，升级第三方库要手工重下 +
   重跑门禁（步骤见 `viewers/assets/vendor/README.md`）。**通则：在"部署机制只认普通文件"的仓库里，
   任何要求构建产物的前端方案都要先回答"谁保证产物跟版"**，回答不了就别引入。
32. **`el-table` 的单元格不会因为表格数据**之外**的响应式状态而重渲染**（2026-10-10，L2 页实测，
   用户可见故障）。块表每行有一个"归档原因"输入框 + 预演结果块 + 「确认执行」按钮，它们的显示状态
   存在 `opState[filename]`（组件响应式数据，但不是 `el-table :data` 的一部分）。结果：输入框**打不进字**
   （打进去的值写进了"上一次渲染时捕获的那个旧对象"），预演结果永远不显示，而点「归档（预演）」会被
   本地校验拦下并提示"归档必须写原因"—— 用户填了原因却被告知没填。
   实测结论（EP 2.14.7）：**连父组件 `$forceUpdate()` 都不会让单元格重画**，只有 `:data` 的引用变化才会。
   修法：把每行的操作格状态注入表格数据本身，并给 `:data` 一个显式依赖 ——
   `pageRows` 里 `void this.opVersion`（版本号）＋ 每个行对象带 `op: opOf(filename)`（**同一个对象引用**，
   输入框直接写进 opState），凡是程序化改动操作格状态的地方都 `bumpOp()`。这样：敲键不触发重渲染
   （DOM 自己持有文本、不丢焦点），而预演结果/禁用态一变就整表重算一次。
   **为什么静态检查全绿也发现不了**：语法、端点集合、模板编译、逻辑冒烟（stub `V` 直接调 methods）
   全部通过 —— 这类 bug 只在"真在浏览器里敲一个字"的时候才现形。**页面上有输入控件时，验收必须包含
   一次真实输入**（`getByPlaceholder(...).fill(...)` 即可），并回读组件模型确认值真的进去了。

安全边界：桥**默认只绑 `127.0.0.1`**、只在手动运行时存在；但 CORS 全开（为了支持 `file://` 页面带 `?port=` 回连），
所以**运行期间本机任何页面都能读 `l1/records/*.jsonl` 等内容**。`config/` 已被挡在静态托管之外
（那份 JSONC 含 `model.embedding.apiKey`），需要配置节走 `/api/limits`。用完关掉。

加 `--lan` / `--host <addr>` 时这条边界会扩大到**同网段的任何设备**（且仍然无鉴权）——所以它是显式开关、
默认不开，启动时也会把代价打印出来。局域网调试的实测结论有两条值得记：① 页面里的 `/api/*` 必须
**跟着页面自身的主机名**走（原先写死 `127.0.0.1`，从别的设备打开时全部打到那台设备自己的回环上，
表现为"本机好好的、换台机器全空"——而本机用局域网地址打开时**照样正常**，所以这个 bug 在本机永远测不出来）；
② 改完 `viewer-core.js` 必须重新部署才生效，而"部署"发生在会话激活 / `--reload` / 启动器启动时，
忘了就会拿着旧 JS 得出错误结论（本轮实测：旧 JS 下请求仍打到 127.0.0.1，回环恰好也是本机，于是全绿）。

> **相邻工具**：`scripts/migrate-task-state.mts`（在仓库 `scripts/` 下，不在本目录）——把历史 `metadata.status="done"` 升格为顶层 `taskState="done"`。它复用本目录 `lib.mjs` 的 `autoBackup`，并走 `memory/l1/task-state.ts` 的写锁 + 就地改写；默认 dry-run，`--apply` 实写前自动备份，只映射明确的 `done`（其余取值语义不明，不猜）。

## 用法示例

```bash
node scripts/l1-admin/tombstone.mjs l1_xxx l1_yyy          # 预览
node scripts/l1-admin/tombstone.mjs l1_xxx --apply         # 实写
node scripts/l1-admin/rewrite.mjs l1_xxx --content "新内容" --apply
node scripts/l1-admin/verify.mjs
node scripts/l1-admin/health.mjs
node scripts/l1-admin/rollback.mjs C:/temp/pi/backup/l1-cleanup-20260911 --apply

node scripts/l1-admin/scene-pool.mjs report                # 池状态（只读）
node scripts/l1-admin/scene-pool.mjs cluster --out /tmp/聚类.json   # 聚类（只读）
node scripts/l1-admin/scene-pool.mjs seed --file 映射.json  # 播种预览
node scripts/l1-admin/scene-pool.mjs seed --file 映射.json --apply   # 播种实写
node scripts/l1-admin/scene-pool.mjs merge-report          # 合并候选（只读）
```

```bash
# 任务生命周期（与 l1_task_state 工具同一实现；默认 dry-run）
node --experimental-strip-types scripts/l1-admin/task-state.mts l1_xxx --state done          # 预览
node --experimental-strip-types scripts/l1-admin/task-state.mts l1_xxx --state done \
     --reason "已完成" --apply --backup                                                       # 实写 + 备份

# 查看器
node scripts/l1-admin/viewer-bridge.mjs                    # 起查看器（打印打开地址）
node --experimental-strip-types scripts/l1-admin/viewer-status.mts   # 版本/漂移诊断
node --experimental-strip-types scripts/l1-admin/viewer-limits.mts   # 阈值（来自源码常量）
node --experimental-strip-types scripts/l1-admin/active-days.mts     # 活跃会话日（权威源）
```

## 工作场景池（scene pool）

`{profile}/memoryDB/l1/scenes.json` —— **L1 场景归属的唯一真源**（记录里的 `scene_name` 只是落盘当时的历史快照）。
由扩展的 `l1_commit` 在**写锁内**维护；本目录的 `scene-pool.mjs` 只做运维侧的事。

- 条目结构：`{ id 稳定且不复用, name 稳定标签 {项目}｜{议题}, cwds[], aliases[], mergedInto, origin, createdAt, lastUsedAt, useCount, newSceneReason? }`
- 注入：`buildL1Task` 取「未合并 + `lastUsedAt` 在 60 天窗口内」的条目，**同 cwd 优先 → 近期优先**，上限 40 条（实测单个项目最多 34 条线程）。
- `aliases` / `mergedInto` **只在读取期解析**，不改历史记录。
- **本轮不含自动合并**：`merge-report` 只出候选，写操作（`mergedInto` + `aliases`）待确认后另行处理。

## 核心语义（两个实战踩坑，务必理解）

### 坑 1：loader 的存活语义 = LWW（2026-09-11 起；此前是逐行过滤）

> **本节 2026-09-15 更正**。原文写「loader 按行过滤 `!deleted`，不做同 id 合并」——**已不成立**：
> `memory/search/embedding/record-loader.ts` 的 `loadL1RecordById` / `loadAllL1Records` 自 2026-09-11
> 起均为 **LWW**（同 id 取追加序最后一行：分片名升序 + 行序），`deleted` 判定 strict `=== true`；
> 消费方 `hybrid-recall.ts:126` 走的就是这两个函数。旧口径只存在于 2026-09-11 之前的历史档案统计里。

**当前事实**：

- 判某 id 是否存活 = **看它追加序最后一行**，不是看有没有某一行带 `deleted:true`。
- **就地标记依然是本目录与 `l1_commit` 的既定做法**，理由不再是"追加墓碑无效"，而是：
  1. `l1_commit` 的去重逻辑会**跳过已存在的 id**，所以经 `l1_commit` 根本追加不了同 id 的墓碑行；
  2. 就地标记天然幂等，且不会在分片里堆积"一 id 多行"的档案；
  3. 历史统计脚本（`verify.mjs` / `health.mjs`）仍同时给逐行口径与 LWW 口径，两种读法都要能读懂。
- 因此：**作废必须就地改旧行本身**（`deleted:true` + 更新 `updatedAt`，保留 `content` 供溯源）。
- ⚠ 若将来新增按行过滤的消费方，旧墓碑模式会复发 —— 新增读 L1 records 的代码请**用 `record-loader.ts`**，不要自己 split 行。

历史先例：2026-08-20 治理批量就是就地标记（`l1_1787190820001_staging` 旧行至今带 `deleted:true`）。本工具遵循同一模式。

### 坑 2：同 id 重写不可行 —— 只能新 id + 旧行标记

`l1_commit` 的去重逻辑把**已存在的 id 跳过**（无论是否 deleted），且 loader 按行过滤 → 同 id 直改会变双活跃行。正确改写模式（管线 update/merge 自身即此模式）：

1. 旧行就地标记 `deleted:true`（保留原 content 溯源）
2. 追加**新 id** 行，id 规范 `l1_{Date.now()}_{4位小写字母数字}`（`_fix` 后缀是历史 LLM 自造形态，**不要再用**）
3. 新行 `createdAt = 落盘时刻`（保住 quality.ts 的 7 天保护），原创建时间放 `metadata.origCreatedAt`
4. `metadata.l1Cleanup` 记录 `sourceId`/`newId` 供追溯

## 与管线的边界

- 工具直接读写分片文件，**不触发** L2 队列（只有 `l1_commit` 工具内会入队）。
- 写操作前自动备份到 `{memoryDB}/backups/l1-admin/{timestamp}-{op}/`。
- 写入分片名 = 本地日期（UTC+8），与 `l1_commit` 的 `localDate` 规则一致。
- ⚠ 时区窗口：loader 按 **UTC 日期**枚举分片。本地 00:00–07:59 写入的今日分片要到本地 08:00 后才进入 30/365 天窗口（召回/回填不可见）。建议写操作在本地 08:00 后执行，或写后等待 08:00。
- ⚠ 向量一致性：经 `rewrite.mjs`/`tombstone.mjs` 改动后，旧 id 的向量库条目不会自动清理——执行 `/my-memory:l1:embedding:rebuild`（pi 命令）全量重嵌（清空 vecStore 并按存活记录重建）。
- 并发：`agent_settled` 可能同时向今日分片追加（管线提取）——工具写后请跑 `verify.mjs`。

## 已知历史形态（health.mjs 会提示，非本轮问题）

- `l1_del_*` / `l1_delete_*` / `l1_tombstone_*`：历史 LLM 自造删除标记（不同 id，**不改变原行存活**——见坑 1）
- `*_fix` / `*_fix_fix` 后缀 id：历史手工改写形态（新 id + 旧行标记），代码无此生成逻辑
- `deleted: "false"`（字符串）：2026-08-22 批畸形行，loader 视为删除、场景锚点读者视为存活（双口径），待代码侧计划修正
- 孤儿 hit-stats：记录作废/改写后 stats 条目无对应活跃 id，属预期，可由重建/整理自然淘汰

## 审计输出契约（配套）

子代理审计 L1 记录时，除 markdown 报告外必须附结构化 JSON（见 `audit-contract.md`），避免主代理解析 markdown 表格——本工具集诞生前，解析 12 份报告表格导致过两次列位错位事故。

## 演进注意

- 本目录脚本**不注册任何 pi 命令**（/my-memory:l1:health 等命令注册属扩展代码改动，另行计划）。
- 不动 loader / l1_commit / 场景锚点等运行逻辑；如有冲突以扩展源码为准。
- 工具变更需同步 README（语义说明是使用前提）。

## Agent 自发纠错（2026-09-11 起）

扩展侧已提供 `l1_fix` 工具与 `/my-memory:l1:fix` 命令（见 `memory/l1/fix-tool.ts`）：

- **触发**：L1 召回注入块尾部自带一行自纠提示（若记忆与当前事实矛盾且可复核 → l1_fix；仅可疑 → clear_invalid_l1_records）。
- **护栏**（四道，均在 fix-tool 内）：evidence ≥20 字符必填；审计标注自动追加；24h 防抖（无 appliedAt 字段放行一次）；高价值（hits≥5 或 L2 场景块 members 引用）拒改 + 提示 `--force`。
- **执行层**：复用本目录 rewrite.mjs / tombstone.mjs（单实现）；脚本变更会影响工具行为，注意两侧兼容。
- **priority 重估**：rewrite 支持 `--priority <0-100>`；缺省继承旧值（审计标注注明「未重估」）。

## LWW 写读语义（2026-09-11 定版，配套扩展代码）

- 读：`record-loader.ts` loadAllL1Records / loadL1RecordById 已改为**同 id 取追加序最后一行判定存活**（strict deleted===true 判死）；`l2/config.ts readAllRecords` 同口径；`rebuild-l1-vectors.mjs` 同口径。
- 写：`l1_commit` 对 deleted 行**就地标记旧活跃行**（不追加墓碑）；跨进程原子锁 `memoryDB/.l1-admin-write.lock`（本目录写操作暂未持锁，见下）。
- ⚠ 锁：l1-admin CLI（tombstone/rewrite）暂未实现跨进程锁接入（扩展侧 l1_commit/fix-tool 已持锁）；CLI 与管线并发写同分片时仍有极小竞态窗口——以 README 顶部「待办」为准，后续把锁逻辑同步进 lib.mjs。