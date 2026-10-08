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

公共参数：`--profile <dir>`（默认 `C:/Users/leaf/.pi/agent/profiles/default`）、`--dry-run` / `--apply`。

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