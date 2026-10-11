---
status: draft
created: 2026-10-11
updated: 2026-10-11
parent: ../README.md
reviewed_by: >
  第一轮（3 代理：事实复核 / 遗漏耦合 / 方案压测）；
  第二轮（3 代理：Windows 回归风险 / 计划可执行性 / 未验证前提）。结论均已折入本文。
---

# macOS 适配（从「仅 Windows」到双平台）

把本扩展从「只在 Windows 11 上可用」扩到 macOS。**核心不是在各处撒 `if (darwin)`，而是先把平台差异收敛到一处**，再把已经长进数据模型的两处 Windows 假设（项目归属按盘符路径判定、停子代理按进程树语义）改走它。

> 标 **[一轮修正]** 的来自第一轮审查，标 **[二轮修正]** 的来自第二轮。文末有「审查记录」。

## 背景与问题（2026-10-11 全仓实测）

README「环境要求」自述**仅 Windows**，给的两条理由是：① 停止子代理依赖 `taskkill /T /F` 的进程树语义；② 项目归属判定用盘符形状规则。

全仓扫描确认：**这两条只是最显眼的，实际耦合可分三档，且最危险的不是报错，而是静默降级**——扩展里**没有任何启动时平台守卫**（`process.platform` 全仓只有 4 处、3 个文件，全是局部判断：`util/spawn.ts:321`、`memory/pipeline/subagent-kill.ts:64`、`scripts/l1-admin/viewer.mts:93,95`）。在 macOS 上它不会崩，只会悄悄把项目归属判成空、可能把子代理进程组里的成员留成孤儿（**是否真有成员待实测**，见 §2），**且不报警**。

### 一档：阻断级（不做就是错的，且静默）

#### 1. 项目归属 / 路径形态按 Windows 盘符写死

「项目标签」的取值空间是 `^[A-Za-z]:/` 形态的 Windows 绝对路径。macOS 的 `/Users/…` 一律判为「非绝对路径 → 作废」，于是项目归属整体返回空 → 召回按项目过滤失效（不报错）。**至少 9 个生产模块**在这条假设上：

| 文件 | 位置 | 耦合 |
|---|---|---|
| `memory/l1/project-scope.ts` | `:128`、`:163` | `normalizeProjectTag` 只认 `^[A-Za-z]:/`，盘符根 `C:/` 当特例；POSIX 输入直接返 `""` |
| `memory/l1/project-evidence.ts` | `:51`、`:59`、`:63-67` | 证据核验同样要求盘符；`/c/…`→`C:/`；正文按 `C:\`/`/c/` 双形态匹配 |
| `util/recall-score.ts` | `:58-64` | `projectCompareKey` 去尾斜杠时对 `^[A-Za-z]:/` 特判 |
| `util/judg-session-project/index.ts` | `:99-109`、`:153-163` | `normalizeProjectPath` 非盘符形态返回 `null`（→ 条目被整条丢弃）；`isNotAProjectPath` 把 `C:/Users/<名>` 当噪声 |
| `util/judg-session-project/candidates.ts` | `:74`、`:131-143`、`:187-204`、`:277`、`:469` | **最致命**：`:74` 的 `PATH_RE_SRC` 抽取正则只匹配盘符或 `/c/`，**POSIX `/Users/…` 抽不出来 → macOS 上零候选**；`:277`/`:469` 再用 `^[A-Za-z]:/` 二次过滤 |
| `memory/l1/scene-pool.ts` | `:62-73` | `cwdCompareKey` 归一 + 小写（小写在 `:72`） |
| `memory/l1/config.ts` | `:232-241` | `isBroadProjectPath` 宽目录名单（名单在 `:238`） |
| `memory/l0/index.ts` | `:121-133` | session 目录名解码把「首字母后跟 `-`」当盘符；**POSIX `--Users-leaf-dev--` 解码后丢前导斜杠**（`:132`） |
| `prompts/tool-vars.ts` | `:57-58` | 用反斜杠拼 `[Protected Files]` 路径 |
| `agents/l1-extractor.md` | `:135` | 教模型「用盘符/反斜杠/Git Bash 写法」 |
| 下游消费侧 | `util/judg-session-project/index.ts:415`、`memory/search/hybrid-recall.ts:217`、`viewers/assets/records-app.js:104,474-476,498,663` | 标签消费者；双形态标签会让**查看器把同一项目拆成两组** |

**L2 不算在内**：`grep -rn project memory/l2` 无命中，L2 的项目分组走 `scene_name` 的 `｜` 前缀（`memory/l1/scene-pool.ts:307-319`），**不消费 `metadata.project`**。

存量数据：库里 `metadata.project` 已是 `C:/dev/…` 形态（见「二轮修正 · Windows 影响」第 1–5 条）。

#### 2. 停子代理 = 只杀了根进程（漏进程组）

`memory/pipeline/subagent-kill.ts:62-77`：win32 分支 `taskkill /PID <pid> /T /F`；非 win32 分支只有 **裸 `process.kill(pid, "SIGKILL")`**。而子代理是 `detached: true` 起的（`util/spawn.ts:333`，注释自述「按组杀」）。POSIX 上 `detached` 让子进程成为**会话 + 进程组组长**（`pgid == pid`），但停止分支**从不发组信号**（`kill(-pid, …)`）——**注释说「按组杀」，实现只杀了组长**。

**[一轮修正] 这条曾被讲过头**：是否真会留下「野孩子」，取决于子代理运行时有没有子进程。**[二轮修正] 而且当时的证据不完整**：仓库里有 **6** 个 agent 定义，上一轮只查了 3 个；`agents/memory-organizer.md:4` 的白名单**含 `bash`**（正是会另起进程的工具）。缓和事实：`index.ts:524-528` 明写 `memory-reviewer` 已停用、`memory-organizer` 无调度入口，实际挂载的是 `setupSkillReviewer`，而 `agents/skill-reviewer.md:4` 的白名单不含 bash。所以结论**可能**仍成立，但**证据必须补全到 6/6 并真机观测**，不能当作已验证。另：pi 宿主自身是否 spawn 子进程也未测。

#### 3. 「协作式停止标记」的设计前提在 macOS 不成立

`memory/pipeline/stop-request.ts:3-6` 与 `memory/paths.ts:185` 明说：整套「落停止标记 → 写工具入口拒写」的动机是 **Windows 上进程没有可捕获的优雅信号**。macOS 上信号可捕获，这个前提消失——需重新评估保留（无害但多余）还是改成真信号。

### 二档：适配级（能跑，但要小改或重装）

| 项 | 位置 | 说明 |
|---|---|---|
| `useShell` / `windowsHide` / `pi.cmd` | `util/spawn.ts:317-336` | `useShell` 已按 `win32` 判；POSIX 上带 shebang 的 `pi` 可被 Node 直接 exec |
| 硬编码 `C:/Users/leaf/…` | `scripts/l1-admin/{lib.mjs:19, active-days.mts:23, viewer-status.mts:22, viewer-limits.mts:28, scene-pool.mjs:550, viewer-bridge.mjs:77}` + 文档 `scripts/l1-admin/README.md:34` | 6 处绕过 `resolveAgentDir()` |
| 更多写死路径 | `scripts/migrate-memorydb-layout.mjs:36-37`、4 个 `.py`（`audit-l1-methods.py:13`、`fix-l1-method-types.py:15`、`l1-scene-reuse-rate.py:28`、`l2-extract-members.py:33`）、`scripts/test-recall-scheduler.mjs:41`、`scripts/check-types.mjs:44-72`（tsc 第 3 候选写死 Windows pi fork 路径） | `.py`/`.mjs` **无法 import TS 的 `resolveAgentDir()`**（见 T7 验收修正） |
| 仅开发/宣传 | `scripts/patches/*.mjs:55-59/80-84`（假定 pi-subagents 有 `.ts` 源码——≥0.74 只发 `.js`，与 OS 无关就失效）、`assets/promo/render.py:50-52`（读 `%WINDIR%\Fonts`） | 非阻断 |
| 启动器 | `viewers/启动查看器.cmd`、`viewers/assets/viewer-theme.css:81` | `.cmd` 需 `.sh` 等价物；`viewer.mts:93-95` 已判 darwin，`npm run viewer` 已跨平台 |
| 绑定 | `viewer.mts:235` 打开 `http://localhost:<port>`，桥只绑 `127.0.0.1`（`viewer-bridge.mjs:83`） | macOS 上可能被浏览器双栈回退掩盖；`waitHealthy` 用的是 `127.0.0.1`（`:108`）故脚本自身不误判 |
| 门禁断言 | `scripts/verify-viewer-deploy.ts:425` | **[一轮修正]** 现状在 macOS 上**仍通过**（断言的是仓库里有这个文件），删掉启动器才会红 |
| rename / EBUSY | `memory/review/review-cursor.ts:82-93`、`config/app-config.ts:66-75`、`scripts/backfill-project-scope.mts:903-921` | Windows 动机，POSIX 上多余但不致错 |
| CRLF 归一 | `prompts/registry.ts:236-246`、`memory/core/store.ts:568-572` | macOS 检出为 LF，归一逻辑仍正确 |
| `skill-manager.ts:411` / `:71` | 只按正斜杠切（Windows 上反而错）；目录名被 `normalizeName()` 小写化（`:292`） | **[二轮修正]** 后者此前无归属任务，见 T12 |

### 三档：无需工作 / 已是跨平台（好消息）

- **原生依赖不是障碍（[二轮修正] 已证成，属过度担心的项）**：`better-sqlite3` 的 `prebuilds/` 内含 `darwin-arm64.node`/`darwin-x64.node` 且 **无 `install`/`postinstall`/node-gyp**；`sqlite-vec` 用 `optionalDependencies` 声明 `sqlite-vec-darwin-{x64,arm64}`。**仓库提交的 `package-lock.json:3262-3284` 已记录这两个 darwin 包的 resolved URL**，npm 按 os/cpu 必拉。且 pi loader 的 `VIRTUAL_MODULES` 只 alias `@earendil-works/*` 与 `typebox*`（`loader.js:31-58`）——**`better-sqlite3`/`sqlite-vec` 不在其中，走常规 Node 解析**，装进 `~/.pi/agent/npm/node_modules`（该布局**跨平台一致**，不是 Windows 专有）。唯一约束：**不能把 Windows 的 `node_modules` 拷过去**。
- **锁机制通用**：`write-lock.ts`（mkdir 占位）、`run-lock.ts`、`process.kill(pid, 0)` 探活。
- **路径单源已做好**：`util/agent-dir.ts:44-49` 走 `HOME` → `USERPROFILE` → `homedir()`。

## 二轮修正：Windows 回归影响（专项）

**这是「做完会不会影响 Win11」的正面回答。**

**结论：架构上以「加平台分支」为主，Windows 不会被改坏；但计划原文有三处会让 Windows 出问题，必须修。**

### 🔴 必须修的三处（否则 Windows 真会被改坏）

1. **T4 的按组确认若不限定平台 → 灾难性破坏 Windows。**
   `process.kill(-pid, 0)` **是 POSIX 专有**；Windows 上会抛错。若照计划原文把 `killConfirmed` 无条件改成 `isGroupAlive(-pid,0)`，Windows 上 `killConfirmed` 恒为 `false` → `repairAfterKill` 永不执行、`clearStopRequest` 永不清除 → **该层写工具入口永久拒写，L1/L2/L3 全线停摆**（`subagent-kill.ts:344-349`）。
   **修**：`isGroupAlive` 严格 POSIX 分支；win32 保留 `killConfirmed = !isProcessAlive(pid)` 与 `:64-71` 的 `taskkill` 早退。此项列入 T4 验收。
2. **T1「合并四个比较键」会静默改 Windows 边界。**
   四个键**当前并不等价**：`projectCompareKey` 会 trim、`projectKey`/`pathKey` 不 trim；`cwdCompareKey` 剥成对引号，另三个不剥；都不压 `//`。合并成"唯一实现"会改变 `projectKey('"C:/a"')`、`pathKey("C://a")` 等 Windows 调用点的输出，而 **`npm test` 覆盖不到**。
   **修**：T1 必须把新键语义**显式定义为现有四个的超集**，并为每个现有键补逐条对照用例。
3. **`/c/…` 仲裁会改变 Windows 输出，与「逐字不变」自相矛盾。**
   现状 `normalizeProjectTag("/c/dev/x") === ""`（`verify-project-scope.ts:142` 断言）。计划的仲裁让它变成 `C:/dev/x`——**这是全平台变化，不是平台分支**，直接违反「所有改动必须是加平台分支」。

### 会**故意**改变的 Windows 输出（需你认账，共 9 处）

| # | 输入 | 旧（Windows） | 新 |
|---|---|---|---|
| 1 | `normalizeProjectTag("/c/dev/x")` | `""` | `C:/dev/x` |
| 2 | `normalizeProjectTag("/Users/x/dev/proj")` | `""` | `/Users/x/dev/proj` |
| 3 | `normalizeProjectPath("/c/dev/alpha")` | `null` | `C:/dev/alpha` |
| 4 | `normalizeProjectPath("/Users/leaf/proj")` | `null` | `/Users/leaf/proj` |
| 5 | `metadata.project:"/c/dev/x"` + 合法证据 | 拒绝 | `C:/dev/x` |
| 6 | `isNotAProjectPath("/Users/leaf")` | `false` | `true` |
| 7 | Windows 会话正文含 `/usr/local/x`、`/tmp/y` | 不抽取 | 可能进候选池（`candidates.ts:74,277,469`） |
| 8 | 非 UTC+8 的 Windows 机器，admin 分片 | UTC+8 日期文件 | 本地日期文件 |
| 9 | 加了 `.gitattributes` 后的 Windows 工作区 | CRLF | LF |

第 1–5 条方向上是「修复」（原先被降级成 `unknown` 的记录会拿到项目标签），但**不是「Windows 不变」**；第 7 条会改变既有 Windows 会话的候选名单。

### 会变绿的既有 Windows 断言（要同步改）

- `scripts/verify-project-scope.ts:142`（`/c/dev/x → ""`）→ 改。
- `scripts/verify-project-scope.ts:148` → **[二轮修正] 不用改**：C12 断言的是**幂等**，与取值无关（`/c/x → C:/x` 仍满足 `f(f(x))===f(x)`）。初稿说它要改，是错的。
- `scripts/verify-project-scope.ts:143`（UNC → `""`）→ 只有 POSIX 闸门写成 `^/(?!/)`（不把 `//server` 当 POSIX）才保持绿。
- `scripts/verify-judg-session-project.ts:126`（`normalizeProjectPath("/c/dev/alpha") === null`）→ 改；**[二轮修正] 该断言属 T3 的模块**（`normalizeProjectPath` 在 `judg-session-project/index.ts`），不在 T2。
- `scripts/verify-subagent-stop.ts:53` 与 `:189` → **[二轮修正] 是两处**假子进程 spawn，且都不 `detached`；计划原文写的 `:55` 不存在。

### 「逐字不变」的真实边界

**不可字面成立。** 成立范围只能是：「**不含 `/c/…` 等 POSIX 形态、且时区/检出未变**的 Windows 输入，输出不变」。文档应照此改写，而不是写「逐字不变」。

### 验证机制的真问题

- `npm test` **只跑一个脚本**（`package.json:31` = `verify-prompt-contracts.mjs`）；32 个 `verify-*` 脚本**没有任何统一 runner**，得手动 `tsx` 逐个跑。
- **无 CI**（`.github` 不存在）、**无 Windows job**。计划 T11 原本只打算加 macOS CI。
→ 结论：**风险不在设计，在验证机制**。见 T11。

## 目标

1. **项目归属在 macOS 上正确工作**：`/Users/…` 能被**抽取**（不只在归一环节）、识别、归一、比较。
2. **停子代理能真正杀干净**：POSIX 按组终止 + 按组确认；Windows 行为不变。
3. **平台差异收敛到一处**（必要时两处小模块），而不是散落 `if (darwin)`。
4. **加一道平台自检**：启动时能发现「平台/宿主/依赖不满足」，不再静默降级。
5. **脚本/门禁/文档收口**：管理 CLI、verify 脚本、启动器、README 在 macOS 可用且不误报；补仓库确定性（LF 约定、统一 runner、macOS CI job）。

## 非目标

- 不做 Linux 适配（二档多数项同样适用，但不在本轮承诺内）。
- 不改项目归属的**判定口径**，只改路径**形态**。
- **[二轮修正] 不再声称「Windows 行为逐字不变」**，改为：「**除 `/c/…` 形态（本项目既有的 Git-Bash 写法）外**，Windows 行为不变；所有其它改动必须是加平台分支。故意变化的完整清单见「二轮修正」表。」

## 建议方案（**待用户裁定**）

| 决策点 | 建议 | 理由 / 备选 |
|---|---|---|
| 收敛方式（**[一轮修正]** 拆两个模块） | `util/platform.ts`（纯叶子：`isAbsoluteTag`/`normalizeTag`/`tagCompareKey`/`isCaseInsensitiveFs`，**不 import `node:os`/`node:path`**）+ 进程生命周期助手就近放 `util/spawn.ts` | 家目录留 `agent-dir.ts`；宽目录名单留项目归属域；进程组杀与 `child_process` 同域 |
| **[二轮新增] `/c/` 仲裁与「逐字不变」冲突** | **二选一**：(a) 明确承认这个全平台变化（`/c/` 是 Git-Bash 写法，macOS 上同样不是真路径），同步改断言；(b) 用 `process.platform !== "win32"` 把仲裁限制在非 Windows，Windows 保持 `""`。**建议 (a)**（语义更一致），但需你拍板 | 从"不影响 Win11"角度，(b) 最保守 |
| 项目标签形态 | 两种绝对形态都合法；比较统一走**唯一** canonical key；**该键语义必须是现有四个键的超集**（逐条对照用例钉死） | 比较层本身已是 POSIX 安全，风险在合并时的边界漂移 |
| 大小写 | 保留小写比较（APFS 默认大小写不敏感）；「敏感与否」收敛进 `platform.ts` | 目标卷若为 Case-Sensitive APFS 再议 |
| 存量标签 | 本轮**不改**存量 `C:/…` 标签 | 跨机同步库是另一回事，见 T10 |
| 停子代理 | `writeStopRequest` → 宽限 → `SIGTERM(-pid)` → 另设短 `escalateMs` → `SIGKILL(-pid)`；**确认步 POSIX 用 `isGroupAlive`，win32 用 `isProcessAlive`** | **[二轮修正]** 初稿「SIGTERM→宽限→SIGKILL」会**双重计时**（`stopSubagent` 已在 `:328` sleep 过 `graceMs`）；且确认步必须分平台，见 §二轮修正 🔴1 |
| 平台自检 | ① 平台 ∉ {win32,darwin} 时 `notice`；② **仅 darwin** 时断言 `resolvePiCommand()` 没回落 PATH；③ 对合成平台路径跑一次 `normalizeProjectTag`/候选抽取（**须在 T2/T3 之后**，否则恒误报） | **[二轮修正]** ② 在 Windows 上会误报（PATH 回落对 win32 是合法的）；Bun 单文件运行时下 ② 也会误报 |
| 协作停止标记 | **保留**（Windows 需要），macOS 上叠加真信号 | 本轮不删机制 |

## 任务分解

> **[二轮修正] 排序**：T0 是**所有任务的前置**（形式化）。T4 与路径工作无依赖，可先做；但 T4 需 T0 的进程组观测作为 step 0。**T6 不能先于 T2**（先教模型 POSIX 例子而服务端不收，记录会被静默降级成 `unknown`）。**T2 单独上线安全**。原始 12 项**低估了约一倍工作量**（T3/T7/T11 各含多个可独立验收的单元）。

| # | 任务 | 涉及文件 | 状态 | 验收 |
|---|---|---|---|---|
| T0 | **验证前提**（前置，全计划之依赖） | — | todo | ① 目标 Mac 装 pi 并起会话；② **`node --version ≥ 22.13` 且 `node -e "require('node:sqlite')"` 通过**（**[二轮修正] 不是「pi 自带 Node」——install.sh 用的是系统 Node**）；③ 确认不是 Bun 单文件运行时；④ `npm install` 后 `better-sqlite3`/`sqlite-vec-darwin-*` 到位并跑一次 `getVectorStore()` 冒烟；⑤ **观测派发中真实子代理的进程组成员数**（`ps -o pid,pgid,command -g <pid>`），并补全 6/6 个 agent 的白名单核对 |
| T1 | 平台路径抽象（纯叶子）+ **canonical key 语义 = 现有四键超集** | `util/platform.ts`（新）、`memory/l1/project-scope.ts`（改契约措辞） | todo | **[二轮修正]** 新键对 `trim`/成对引号/`//` 的行为须逐条对齐并可断言；`project-scope.ts:8-13` 的「零 import」措辞改为「零 pi 运行时 import，只依赖纯叶子 `util/platform.ts`」 |
| T2 | 项目标签双形态（含 `/c/` 仲裁决策） | `memory/l1/project-scope.ts`、`memory/l1/project-evidence.ts`、`scripts/verify-project-scope.ts` | todo | POSIX 形状校验；`/c/` 仲裁按决策落地且是**第一道闸**；`:142` 同步改、`:143` 保持（POSIX 闸为 `^/(?!/)`）、`:148` **不改** |
| T3a | 抽取正则 + 二次过滤 + 噪声名单 | `util/judg-session-project/candidates.ts`、`memory/l1/config.ts` | todo | **POSIX 路径能被 `PATH_RE_SRC` 抽出**（当前零候选）；`^/` 不得放入 `/tmp`/`/usr`/`//server`（补 POSIX 噪声名单）；**[二轮修正] `isBroadProjectPath` 验收改用 `v` 真正会失败的值**（`/Users`、`/Library` 单段**现已为 true**，是空转；用 `/Users/<名>`、`/Users/<名>/Documents/x`） |
| T3b | 比较键收敛 | `util/recall-score.ts`、`util/judg-session-project/index.ts`、`memory/l1/scene-pool.ts` | todo | 四个键各自的现有语义都有对照用例（T1 的超集定义在此验证）；`verify-judg-session-project.ts:126` 在此改 |
| T3c | `decodeCwdFromSessionPath` 前导斜杠 | `memory/l0/index.ts:132` | todo | POSIX 形态解码后是**绝对路径**（现在丢前导斜杠） |
| T4 | 停子代理按组 + 信号升级（**POSIX 限定**） | `memory/pipeline/subagent-kill.ts`、`util/spawn.ts`、`scripts/verify-subagent-stop.ts` | todo | **step 0 = T0⑤ 的观测**；`kill(-pid)` 杀组 + `isGroupAlive` **严格 POSIX 分支**，win32 保留 `isProcessAlive` 与 `taskkill` 早退；`SIGTERM`→`escalateMs`→`SIGKILL`（不复用 `graceMs`）；**[二轮修正] fixture 是 `:53` 与 `:189` 两处**，都改 `detached:true` 并各自断言 |
| T5 | 平台自检（**OS 门**）+ 文档 | `index.ts`、`README.md`、`记忆系统架构说明.md`、`scripts/l1-admin/README.md` | todo | **[二轮修正]** 自检②仅 darwin 生效（否则 Windows 每次误报）；自检③**须在 T2/T3 之后**；架构说明的 `C:/Users/...` 死链去硬编码 |
| T6 | 提示词口径（**与 §1c 同批**） | `prompts/tool-vars.ts`（用 `path.sep`）、`agents/l1-extractor.md`、`scripts/verify-prompt-contracts.mjs:194-211` | todo | Windows 字节不变（`path.sep` 在 win32 即 `\`）；§1c 的 `bs()` 期望同步改；`npm test` 全绿 |
| T7a | 管理 CLI 去硬编码 | `scripts/l1-admin/*`（6 处 + 文档） | todo | **[二轮修正] 验收改为**：无机器专有绝对路径字面量；默认 profile 由 `PI_PROFILE_PATH`/`$HOME` 推导（`.mjs` 不能 import TS，故不能写「一律走 resolveAgentDir()」） |
| T7b | 开发脚本 / Python 工具 | `scripts/migrate-memorydb-layout.mjs:36-37`、4 个 `.py`、`scripts/test-recall-scheduler.mjs:41`、`scripts/check-types.mjs:44-72` | todo | 验收须覆盖 `C:/temp` 与 pi-fork 路径（原验收只 grep `C:/Users/...`，会漏） |
| T7c | verify 脚本 / fixtures | `verify-judg-session-project.ts:388`、`verify-self-spawn.mts:43`、`verify-judg-project-accuracy.mts:50` + 其余写死路径 | todo | **[二轮修正] 这三个是唯一在 macOS 上真会失败的**，必须逐个列出并修；其余以 `C:/` 为确定性输入者保持通过 |
| T8 | 启动器 macOS 入口 + 绑定 | `viewers/`（新增 `.sh`）、`scripts/verify-viewer-deploy.ts:425`、`viewer.mts:235`/`viewer-bridge.mjs:83` | todo | `npm run viewer` 可起、`curl 127.0.0.1:<port>` 通；`.cmd` 断言在 Windows 保持 |
| T9 | 时区统一（可先做） | `scripts/l1-admin/lib.mjs:131-135` 与 `memory/l1/commit-tool.ts:50-55` 共用 local-date 助手；`memory/l1/fix-tool.ts:153` | todo | 非 UTC+8 上 CLI 与管线指向**同一**分片；加时区无关用例；注意 `fix-tool.ts:153` 会改变审计日期（含 Windows） |
| T10 | 存储键策略（决策 + 修） | `memory/l0/index.ts:71,92`、`memory/pipeline/subagent-runs.ts`、CJK 场景名 NFD/NFC（`memory/l2/archive.ts:264-265`） | todo | 决策写成文档小节（L0 cursor key 明确「同机专用」）；场景名给出 NFD/NFC 或精确键策略 |
| T12 | skill 目录名小写化 | `skill/skill-manager.ts:71,292`（+ `:411` 正斜杠切分） | todo | **[二轮修正] 新增任务**（此前只被记录、无归属）；`create("MySkill")` 与按原名查找一致 |
| T11a | verify 平台化 + **统一 runner** | `package.json`、新增 `scripts/verify-all.mjs` | todo | **[二轮修正]** `npm test` 只跑一个脚本；需一个 runner 跑全部 `verify-*`，并列出平台跳过项 |
| T11b | `.gitattributes` | 仓库根 | todo | **[二轮修正] 不能对 `*.cmd` 用 `eol=lf`**（否则 `启动查看器.cmd` 在 LF 下是 cmd.exe 隐患）；只锁 `*.ts/*.mjs/*.md/*.json`，或给 `*.cmd` 显式 `eol=crlf` |
| T11c | CI（**macOS + Windows 两个 job**） | `.github/workflows/*` | todo | **[二轮修正]** 原计划只有 macOS job；Windows job 才能证明回归。与 T11a 配合给出基线产物 |
| T13 | 收口验收 | — | todo | 逐条命令化：`npm run check-types`、`npm test`、`verify-all`；macOS 全绿 + Windows 全绿（或列出平台跳过项与理由） |

## 不做的事

- 不改子代理 spawn 方式（`detached` + stdio 落文件保留）。
- 不重写项目归属判定口径，只改路径形态。
- 不迁移存量 `C:/…` 标签（跨机同步另开计划）。
- 不删 `stop-request` 协作停止机制。
- 不承诺 Linux。
- 不引入构建步骤。
- **[二轮修正]** 不再以「Windows 逐字不变」作为口径（改为「除 `/c/…` 外不变」）。

## 风险 / 待确认

- **T0 未过则全部作废**：pi 在 macOS 可运行这条，上游证据强（pi 文档、install.sh 的 `Darwin)` 分支、`engines.node >=22.19`），但**本仓库零 macOS 执行记录**。真正的前提是**系统 Node ≥ 22.13**（不是「pi 自带 Node」）。
- **进程组是否有成员**：决定 T4 是「修既有 bug」还是「防御性加固」；证据基础此前不完整（3/6 agent），已列为 T0⑤。
- **比较键合并的静默漂移**：无测试覆盖，靠 T1 的超集定义 + T3b 对照用例兜。
- **「逐字不变」的验证成本**：只能在 Windows 上跑一遍证明；当前无 CI、无 runner。
- **跨机同步假设**：「各机各自库」是**政策**不是技术保证；若真有人把 `~/.pi` 放 iCloud/跨机拷贝，L0 cursor key 与双形态标签会双双出问题（T10 要显式决策）。
- **`process.kill` 探活 pid 复用**、**NFD**、**`localhost`→`::1`** 三条：均为「机制成立、影响待真机确认」，已在 T0/T10 挂钩。

## 审查记录

**第一轮（2026-10-11）** —— 事实复核 / 遗漏耦合 / 方案压测。折入：`platform` 出现处（4 处/3 文件）、verify 脚本计数、行号修正、「≥9 模块」、L2 不消费 project、`candidates.ts:74`、时区、L0 cursor key、NFD、CI/`.gitattributes` 缺失、模块边界分拆、进程组双重宽限、平台自检重设计。

**第二轮（2026-10-11）** —— Windows 回归 / 可执行性 / 未验证前提。折入：
1. **[安全]** T4 的 `isGroupAlive` 必须限定 POSIX，否则 win32 上 `killConfirmed` 恒 false → 永久拒写；T4 fixture 是 `:53`+`:189` 两处（不是 `:55`）。
2. **[一致性]** 「逐字不变」与非靶标冲突；`/c/` 仲裁是全平台变化，列出 9 处故意变化；`verify-project-scope.ts:148` 不用改。
3. **[证据]** 上一轮只查 3/6 个 agent，`memory-organizer.md:4` 含 `bash`；原生依赖与 jiti 解析**已证成**（lockfile + prebuilds + loader 源码）。
4. **[任务]** 新增 T12（skill 小写化）、T7c（3 个真失败脚本）；拆 T3/T7/T11；`npm test` 只跑一个脚本 → 需统一 runner。
5. **[验收]** 多条验收不可证伪（T1 逐字不变、T5 三项自检、T8 一键启动、T10 决策）→ 改为点名脚本/命令/断言；`isBroadProjectPath` 原验收是空转。
6. **[措辞]** 「pi 自带 Node」错误（install.sh 用系统 Node）；`.gitattributes` 不得对 `.cmd` 用 LF；`resolveAgentDir()` 在 Git Bash 下会给 `\c\Users\...`。
