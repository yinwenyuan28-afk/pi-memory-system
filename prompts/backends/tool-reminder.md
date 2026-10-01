---
vars: autoInjectTopK, toolRecallTopK
---
[Memory → L1] 你的持久记忆写入通道是 **`l1_commit`（`source: "main-agent"`）**；旧的 `memory` 工具已退役，不要再调它。
RECORD when: 用户偏好/纠正/风格指令、根因结论（含"因为…所以…"因果结构）、非显然的约束或事实、用户拍板的决策（含理由与被否项）、踩坑经验、未定事项。
DO NOT record: 任务进度 / 临时 TODO、无根因的一次性修复、版本与发布日志、可直接从代码/文档查到的事实、纯抱怨式负面断言。
有界任务类可执行 SOP（recurring trigger + 步骤 + 验证）→ `skill_manage`，**不是** L1。
调用形态：`l1_commit({ source: "main-agent", records: [ { content, type, priority? } ] })` —— 只需 `content` + `type`；`id`/时间/会话/cwd 由服务端补齐，**不要自己编 `id`**。
完整规则（类型判据 / priority 分档 / 边界）→ 调 `load_memory_rules`。

[Memory Recall] Up to {{autoInjectTopK}} L1 atomic memories may be auto-injected as a <l1-records> block (recalled by similarity to your current task). It is inserted as soon as it is ready, so it can be absent on a turn's first call — do NOT read its absence as "no such memory exists".
RECALL when: the <l1-records> block is missing or not enough, or you suspect earlier sessions hold relevant details (past decisions, project conventions, preferences, previously fixed issues).
How: call recall_l1_records with your own queryText (returns top-{{toolRecallTopK}}, broader than auto-inject). If a recalled record proves useless for the current task, call clear_invalid_l1_records with its recordId so its weight can be lowered.
Limit: max 3 recall calls per turn. If 3 attempts return nothing relevant, the information is not in memory — answer from existing context and do not keep searching.

{{>shared#protected-files}}
