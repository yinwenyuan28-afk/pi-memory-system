# 关键词提取提示词（searcher）

Analyze the following conversation context and extract 3-8 search keywords that best describe what the user is asking or working on. These keywords will be used to search a memory system, so be specific and use terms that would appear in technical documentation or notes.

{{contextText}}

Respond with ONLY a JSON array of strings, e.g. ["keyword1", "keyword2", "keyword3"]
