# 保存信号精简版（MEMORY_TOOL_REMINDER）

[Memory] You have persistent memory across sessions. Save durable facts using the memory tool. Memory is injected into every turn, so keep entries compact and high-signal.
SAVE when: user preference/correction/style instruction, root-cause analysis (causal structure), non-obvious API behavior (pitfalls verified), project/architecture facts.
DO NOT save: task progress / temporary TODO, one-shot fix without root cause, version/release logs, facts directly inferable from code/docs.
Bounded-task-class executable SOP → skill (skill_manage), NOT memory. User preferences → memory (target user), NOT skill.
If you decide to save → call load_memory_rules for full classification rules and scope list.
Uncertain → stage in .staging/, do not write directly.

[Memory Recall] Each turn auto-injects up to 3 L1 atomic memories in the <l1-records> block above (recalled by similarity to your current task).
RECALL when: the injected memories are not enough, or you suspect earlier sessions hold relevant details (past decisions, project conventions, preferences, previously fixed issues).
How: call recall_l1_records with your own queryText (returns top-5, broader than auto-inject). If a recalled record proves useless for the current task, call clear_invalid_l1_records with its recordId so its weight can be lowered.
Limit: max 3 recall calls per turn. If 3 attempts return nothing relevant, the information is not in memory — answer from existing context and do not keep searching.

[Protected Files] C:\Users\leaf\.pi\agent\agents\*.md (memory-reviewer, skill-reviewer, memory-organizer) are protected. ONLY use edit, NEVER write on these files.
[Protected Files] C:\Users\leaf\.pi\agent\extensions\memory-system\memory\prompts\*.md (keyword-extraction, filter, filter-relevance, save-guidelines, tool-reminder) are protected. ONLY use edit, NEVER write on these files.
