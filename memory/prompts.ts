// ============================================================================
// memory/prompts.ts — memory 子系统提示词加载器
//
// 功能：从 prompts/ 目录的 md 文件加载提示词，md 缺失/损坏时 fallback 到
//       代码内置默认值（不崩）
// 用途：searcher.ts（关键词提取）/ inverted-index.ts（关键词过滤）/
//       tool.ts（保存指南）/ index.ts（MEMORY_TOOL_REMINDER）统一引用
// 设计：md 是覆盖层——编辑 md 即可微调提示词，不用动业务代码；内置默认兜底
// 参照：workflow/prompts.ts（同模式，独立实现避免 workflow 回归）
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 默认提示词（fallback：md 缺失/损坏时使用）
// ---------------------------------------------------------------------------

export interface MemoryPrompts {
  /** searcher 关键词提取（{{contextText}}） */
  keywordExtraction: string;
  /** 倒排索引 refine 关键词过滤（{{content}} {{candidates}}） */
  filter: string;
  /** 保存指南（注入 MEMORY_SCHEMA.description 和子代理 prompt） */
  saveGuidelines: string;
  /** system prompt 内联的保存信号精简版 */
  toolReminder: string;
}

const DEFAULT_PROMPTS: MemoryPrompts = {
  keywordExtraction:
    "Analyze the following conversation context and extract 3-8 search keywords " +
    "that best describe what the user is asking or working on. " +
    "These keywords will be used to search a memory system, so be specific " +
    "and use terms that would appear in technical documentation or notes.\n\n" +
    "{{contextText}}\n\n" +
    'Respond with ONLY a JSON array of strings, e.g. ["keyword1", "keyword2", "keyword3"]',
  filter: `你是一个关键词过滤器。

从以下列表中选择应该作为搜索关键词保留的词。
规则：
- 只删不增：只能从列表中删除，不能添加不在列表中的词
- 保留的必须是能帮助用户搜索到这篇文章的重要词汇
- 删除无意义的通用词（的/了/是/有/在/我/你/他/这/那/它/和/与/就/都/还/也/很/到/去/做/用/把/被/让/给/对/从/向/按/将/以/为/因/由/于/及/并/或/既/又/还/更/最/略）
- 删除无关的词
- 如果保留的词太少（<3个），放宽限制多保留一些

原文：
{{content}}

候选词列表：
{{candidates}}

只输出 JSON 格式：{ "keep": ["词1", "词2"] }`,
  saveGuidelines: `SAVE GUIDELINES — what NOT to save (and when exceptions apply):

1. Transient session errors
   ❌ "Error X, retried and succeeded" — retry is generic, not persistent
   ✅ "Root cause + fix" — e.g. "node-gyp needs VS Build Tools on Windows, otherwise ENOENT"
   Boundary: if content has "because"/"needs"/"requires" (causal structure), it's root-cause knowledge, save it.

2. Negative tool assertions
   ❌ "Tool X is broken/not working" — complaint, not knowledge
   ✅ Real constraint + workaround — e.g. "edit tool corrupts binary files, use bash cp instead"
   Boundary: if content includes "because"/"instead"/"workaround", it's a real constraint, save the workaround.

3. One-off task narratives
   ❌ "Analyzed this week's trend" — task completion report
   ✅ Reusable workflow preference — e.g. "user wants architecture overview before analysis"
   Boundary: describes "what was done"→skip; describes "how/what user prefers"→save.

4. Environment setup failures
   ❌ "python: command not found" — user can apt-get install
   ✅ Non-trivial install procedure — e.g. "offline env: download node-v18 .tar.xz, extract to /usr/local"
   Boundary: standard single-command fix→skip; multi-step or non-standard install→save.

5. Dev logs / fix records
   ❌ "v1.2→v1.3: fixed login bug" — version iteration, put in project docs
   ✅ Current architecture/strategy — e.g. "default role is users-readonly, admin-only for writes"
   Boundary: version history→skip; current design fact→save.

6. Project config / architecture
   ❌ "repo at github.com/user/proj" — already in AGENTS.md
   ✅ Non-obvious config fact — e.g. "this project uses ESLint flat config, not .eslintrc"
   Boundary: obvious from package.json→skip; unexpected config decision→save.

7. Wrong-target classification
   Content with paths/ports/versions → likely belongs in sub-memory, not memory.
   Content with preferences/habits → likely belongs in user, not memory.
   When unsure, prefer sub-memory (narrowest scope).`,
  toolReminder:
    "\n\n[Memory] You have persistent memory across sessions. Save durable facts using the memory " +
    "tool. Memory is injected into every turn, so keep entries compact and high-signal.\n" +
    "SAVE when: user preference/correction, root-cause analysis (causal structure), " +
    "non-obvious API behavior (pitfalls verified), reusable workflow pattern (→ skill).\n" +
    "DO NOT save: task progress / temporary TODO, one-shot fix without root cause, " +
    "version/release logs, facts directly inferable from code/docs.\n" +
    "If you decide to save → call load_memory_rules for full classification rules and scope list.\n" +
    "Uncertain → stage in .staging/, do not write directly.\n" +
    "\n[Protected Files] C:\\Users\\leaf\\.pi\\agent\\agents\\*.md (memory-reviewer, skill-reviewer, memory-organizer) " +
    "are protected. ONLY use edit, NEVER write on these files.",
};

// ---------------------------------------------------------------------------
// 加载器（内存缓存，md 覆盖 + 默认兜底）
// ---------------------------------------------------------------------------

let cached: MemoryPrompts | null = null;

/** 加载提示词（md 覆盖 + 默认兜底），缓存一次 */
export function loadMemoryPrompts(): MemoryPrompts {
  if (cached) return cached;
  const loaded: MemoryPrompts = { ...DEFAULT_PROMPTS };
  try {
    // 相对本文件的 prompts/ 目录（jiti/ESM 均可用）
    const base = fileURLToPath(new URL("./prompts/", import.meta.url));
    const files: Array<{ file: string; key: keyof MemoryPrompts }> = [
      { file: "keyword-extraction.md", key: "keywordExtraction" },
      { file: "filter.md", key: "filter" },
      { file: "save-guidelines.md", key: "saveGuidelines" },
      { file: "tool-reminder.md", key: "toolReminder" },
    ];
    for (const { file, key } of files) {
      const md = readFileSync(`${base}${file}`, "utf-8").trim();
      // 去掉首行 "# 标题"（标题仅供阅读，不进提示词）
      if (md) loaded[key] = md.replace(/^# .*\n/, "").trim();
    }
  } catch {
    // md 缺失/损坏 → 用默认
  }
  cached = loaded;
  return cached;
}

/** 测试/调试：重置缓存（md 改动后重新加载） */
export function resetPromptsCache(): void {
  cached = null;
}

/** 渲染占位符（{{key}} → value） */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}
