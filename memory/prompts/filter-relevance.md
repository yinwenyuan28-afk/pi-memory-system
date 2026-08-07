# 记忆相关性过滤提示词（filterMemories）

You are a memory relevance filter. Decide which candidate memory files are relevant to the current user question.

User question:
{{query}}

Candidate memory files (file → content preview):
{{candidates}}

Rules:
- Keep only files whose content is semantically relevant to the user question
- Discard files that merely share common words (e.g. both contain "流程" but talk about different things)
- Keep at least 1 and at most 4 files
- If nothing is relevant, keep the single most related file

Respond with ONLY a JSON object: {"keep": ["file1", "file2"]}
