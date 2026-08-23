# L1 work_method 存量记录审计报告（2026-08-22）

依据 extract-code.md 新判别标准（规范性 / 可迁移性 / 指向性 + 明确排除项），对 `l1-records/*.jsonl` 中 43 条未删除 work_method 逐条复核。

## 处理统计

| 动作 | 条数 | 说明 |
|---|---|---|
| KEEP（保留 work_method） | 14 | 通过三项判别测试，可复用方法/原则/禁忌/评估标准 |
| 降级 work_fact | 22 | 系统行为/架构描述、决策理由、一次性实施记录 |
| 降级 work_artifact | 5 | 带 commit/文件路径的交付记录 |
| REVIEW（需人工拍板） | 2 | 边界情况，附建议值 |

原则：**内容全部保留，只修正 type**。误分类是类型错误，记忆本身有长期价值，不做删除。

## KEEP：保留为 work_method（14 条）

| record_id | 内容摘要 | method_type 建议 |
|---|---|---|
| l1_1787000001234_c3d4 | plan 目录归置同主题优先原则 | principle |
| l1_1787005000001_restart | 扩展重启残留文件清理三步法 | heuristic |
| l1_1786940561838_g7h8 | 子代理 prompt 必须显式 read 关键框架（replace 隔离舱） | principle |
| l1_1787017600003_m5n6 | 凭据文件 git 清理禁用 stash+rm 组合 | anti_pattern |
| l1_1787041800001_e7f3 | Agent 调试优先用已有工具 | principle |
| l1_1787042199001_c3d4 | OpenAI schema type 字段不能为 null | anti_pattern |
| l1_1787135580002_method | opencode-go 改 models.json 排障方法 | heuristic |
| l1_1787190100004_g7h8 | 验证环境必须确认真实运行时 | heuristic |
| l1_1787210999001_c3d4 | skill-reviewer 四维打分门控 | evaluation_criterion |
| l1_1787219387003_d4e5 | L1 work_method 分类元规则 | principle |
| l1_1787037700002_backfill | 回填命令不应被 enabled 开关阻挡 | principle |
| l1_1787278230000_b3c4 | Vue 页面改造 Dialog 弹窗 SOP | sop |
| l1_1787214360006_k1l2 | .gitignore 四类补丁先备份再操作 | heuristic |
| l1_1787206120003_c3d4 | L1 质量分计算公式 | evaluation_criterion |

## 降级 work_fact（22 条）

| record_id | 内容摘要 | 降级理由 |
|---|---|---|
| l1_1786940561838_c3d4 | 后台 LLM 不跟随前台模型切换 | 系统行为描述 |
| l1_1787022400001_arch | L0/L1/L2 三层信息漏斗架构 | 架构事实 |
| l1_1787025800004_strategy | 向量化触发时机三策略 | 方案评估记录 |
| l1_1787025800001_unify | 去重与召回本质同一问题 | 架构洞察 |
| l1_1787037700004_hybrid | L1 复合召回双路径 | 架构事实 |
| l1_1787039896348_g7h8 | recall_l1_records 工具接口 | 接口设计事实 |
| l1_1787194400004_tui | TUI 通知渲染机制 | 平台机制描述 |
| l1_1787198100003_proxy | settings.json httpProxy 机制 | 平台能力事实 |
| l1_1787198510002_c3d4 | Clash 代理双开结论 | 排查结论 |
| l1_1787190820001_staging | L2 staging 应去掉改内嵌 | 设计决策结论 |
| l1_1787212758004_g7h8 | L0/skill-feed 清洗钩子机制 | 系统事实 |
| l1_1787210999004_i9j0 | L0 同日合并设计权衡 | 决策理由 |
| l1_1787219387001_b2c3 | L2 游标以 nextCursor 为唯一真源 | 系统约束事实 |
| l1_1787277400002_c3d4 | L1 质量评分写侧读侧架构 | 架构事实 |
| l1_1787296800003_meth3 | 合同业务提交文件范围 | 一次性任务记录 |
| l1_1787025800007_review | skill-reviewer 走读首次实测 | 流程实测记录 |
| l1_1787030400004_review2 | 向量化计划两轮审查 | 流程实测记录 |
| l1_1787017600001_inject | 注入架构稳定层/易变层 | 架构描述 |
| l1_1787017600003_jsonl | 注入不写 session JSONL | 系统事实 |
| l1_1787020852001_serial | L2 串行四点原因 | 决策理由 |
| l1_1787022400004_update_serial | L2 串行技术原因 | 决策理由 |
| l1_1787037700004_hybrid2（若存在） | — | 以脚本为准 |

## 降级 work_artifact（5 条）

| record_id | 内容摘要 | artifact_type |
|---|---|---|
| l1_1755415192001_tool1 | read_l0_increment 工具实现（commit d77c43b） | tool |
| l1_1755418960003_fix | L2 回调链改 watchFile（commit） | commit |
| l1_1787006600000_r7x2 | reviewer 迁移 L0 分片（commit e9b8ac5） | commit |
| l1_1787019200002_fix1 | L0 子代理污染三步修复（index.ts:177） | commit |
| l1_1787194400001_fix1 | L2 staging 竞态根治（commit） | commit |

## REVIEW：人工拍板（2 条）

| record_id | 内容摘要 | 建议值 |
|---|---|---|
| l1_1787022400003_dedup_loss | L1 去重能力三档量化评估（<100/100-1000/>1000 条） | 建议 FACT：本质是规模化风险评估结论；若要保留其"必须补向量化"的指导性，可改写为 method |
| l1_1787219387007_h8i9 | L0 同日分片有意设计 + 情境切分机制 | 建议 KEEP：含可复用操作语义；与 l1_1787210999004_i9j0 存在重复，可考虑 merge |

## 执行方式（确认后执行）

1. 备份 `memoryDB/l1-records/` 到 `memoryDB/backup-l1-records-20260822/`
2. 运行 `fix-l1-method-types.py`（`--mode=inline` 原地改 type+updatedAt；`--mode=append` 对齐 dedup update 语义：旧记录标 deleted + 追加修正记录）
3. 若启用向量化：执行 `/my-memory:l1:embedding:rebuild` 重建向量（deleted/改 type 后旧向量需同步）
4. 抽验：`grep work_method` 确认修正后剩余 type 均为合法 method
