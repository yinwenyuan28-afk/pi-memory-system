# 保存信号精简版（MEMORY_TOOL_REMINDER）

[Memory] You have persistent memory across sessions. Save durable facts using the memory tool. Memory is injected into every turn, so keep entries compact and high-signal.
SAVE when: user preference/correction, root-cause analysis (causal structure), non-obvious API behavior (pitfalls verified), reusable workflow pattern (→ skill).
DO NOT save: task progress / temporary TODO, one-shot fix without root cause, version/release logs, facts directly inferable from code/docs.
If you decide to save → call load_memory_rules for full classification rules and scope list.
Uncertain → stage in .staging/, do not write directly.

[Protected Files] C:\Users\leaf\.pi\agent\agents\*.md (memory-reviewer, skill-reviewer, memory-organizer) are protected. ONLY use edit, NEVER write on these files.
[Protected Files] C:\Users\leaf\.pi\agent\extensions\memory-system\memory\prompts\*.md (keyword-extraction, filter, filter-relevance, save-guidelines, tool-reminder) are protected. ONLY use edit, NEVER write on these files.
