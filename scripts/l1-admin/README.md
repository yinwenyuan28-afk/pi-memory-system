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

公共参数：`--profile <dir>`（默认 `C:/Users/leaf/.pi/agent/profiles/default`）、`--dry-run` / `--apply`。

## 用法示例

```bash
node scripts/l1-admin/tombstone.mjs l1_xxx l1_yyy          # 预览
node scripts/l1-admin/tombstone.mjs l1_xxx --apply         # 实写
node scripts/l1-admin/rewrite.mjs l1_xxx --content "新内容" --apply
node scripts/l1-admin/verify.mjs
node scripts/l1-admin/health.mjs
node scripts/l1-admin/rollback.mjs C:/temp/pi/backup/l1-cleanup-20260911 --apply
```

## 核心语义（两个实战踩坑，务必理解）

### 坑 1：loader 没有 LWW —— 追加墓碑行无效

`record-loader.ts`（loadAllL1Records / loadL1RecordById）与 `hybrid-recall.ts`、`backfill.ts` 都是**按行过滤 `!deleted`**，**不做同 id 最后一次写入合并**（LWW 只存在于 `l1/config.ts` 的场景锚点读者）。

因此「追加一条 `deleted:true` 的同 id 行」**不能**让旧行消失——旧行（`deleted:false`）仍会被加载、被召回、被回填。**必须就地标记**旧行本身：找到旧行 → 同一行内 `deleted:true` + `updatedAt` 更新（保留 `content` 原样供溯源，`createdAt` 保留原值）。

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