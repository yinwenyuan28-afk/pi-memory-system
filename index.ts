import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MemoryManager,
} from "./memory/index.js";
import {
  SkillManager,
  setBundledSkillsPaths,
} from "./skill/index.js";
import { setupMemoryReviewer } from "./memory/reviewer.js";
import { setupSkillReviewer } from "./skill/reviewer.js";
import { LLMKeywordSearcher } from "./memory/searcher.js";
import { loadMemoryPrompts } from "./memory/prompts.js";
import { setupWorkflowSystem } from "./workflow/index.js";
import { handleSkillManageTool } from "./skill/skill-tool.js";
import { handleSkillViewTool } from "./skill/skill-view-tool.js";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const manager = new MemoryManager(agentDir);
  const searcher = new LLMKeywordSearcher();
  // workflow 保存系统控制器（扩展加载时注册命令/事件，session_start 时 init）
  const workflowController = setupWorkflowSystem(pi, {
    getProfilePath: () => manager?.getProfileManager().getActiveProfile()?.path,
    getSessionId: () => sessionId,
  });
  let skillManager: SkillManager | undefined;
  let profileSkillsPath: string | undefined;
  let loadedSkillsThisSession: Set<string> = new Set();
  // 当前 session id（workflow 模块用，session_start 写入）
  let sessionId = "";
  // M8：reviewer 只注册一次（防 session_start 重复触发时重复监听）
  let reviewersInitialized = false;

  // ── load_memory_rules 状态变量 ─────────────────────────────

  let _rulesState: {
    content: string | null;
    mode: "once" | "always" | null;
  } = { content: null, mode: null };

  // 子记忆路由缓存：before_agent_start 计算一次，context 事件直接读取。
  // 不在 agent_end/agent_start 重置（retry/compaction/followUp 续跑不再触发 before_agent_start），
  // 只在 before_agent_start 覆写——每次用户 turn 必然先触发它，queryText 永远新鲜。
  let _pendingContext: { queryText: string; subMemories: string; cwd: string } | null = null;

  // 提供懒引用给 reviewer，避免循环依赖
  let getMemoryStatus: () => string = () => "0t";
  let getSkillStatus: () => string = () => "0t";



  // ── Resource Discovery ──────────────────────────────────────

  pi.on("resources_discover", () => {
    if (!profileSkillsPath) return {};
    const skillsDir = resolve(profileSkillsPath, "skills");
    if (!existsSync(skillsDir)) return {};
    return { skillPaths: [skillsDir] };
  });

  // ── Session Lifecycle ───────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    manager.initialize();
    const profile = manager.getProfileManager().getActiveProfile();
    sessionId = ctx.sessionManager.getSessionId();
    skillManager = new SkillManager(profile.path, [
      resolve(agentDir, "skills"),
    ]);
    profileSkillsPath = profile.path;
    setBundledSkillsPaths(
      [resolve(process.cwd(), ".pi", "skills")].filter((p) => existsSync(p)),
    );
    loadedSkillsThisSession = new Set();

    // 初始化审查子代理调度器（单次注册，M8 guard）
    if (!reviewersInitialized) {
      getMemoryStatus = setupMemoryReviewer(pi, () => manager);
      getSkillStatus = setupSkillReviewer(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
      reviewersInitialized = true;
    }

    // 初始化工作流保存系统（session_start 时重建 db，跟随 profile）
    workflowController.init(ctx);

    ctx.ui.setStatus("memory", `Memory ${getMemoryStatus()} | Skill ${getSkillStatus()}`);

    // Wire up LLM filter for inverted index (async, non-blocking)
    const currentModel = ctx.model;
    manager.invertedIndexInstance.setLLMFilter(async (prompt: string) => {
      try {
        const result = await completeSimple(currentModel, {
          systemPrompt: "You respond only with JSON.",
          messages: [{ role: "user", content: prompt }],
        });
        return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      } catch {
        return "";
      }
    });

    // 初始化 LLMKeywordSearcher
    searcher.setModel(currentModel);
    searcher.setInvertedIndex(manager.invertedIndexInstance);
    searcher.setProfilePath(profile.path);
    searcher.resetTurn();
    // 首次刷新关键词缓存（非阻塞，超时不影响启动）
    const initContext = buildSearcherContext(ctx);
    searcher.refreshKeywords(initContext).catch(() => {});
  });

  pi.on("session_shutdown", async () => {
    manager.shutdown();
    skillManager = undefined;
    profileSkillsPath = undefined;
    workflowController.shutdown();
  });

  // ── 状态显示 + 关键词刷新 ──────────────────────────────────

  pi.on("agent_settled", async (_event, ctx) => {
    ctx.ui.setStatus("memory", `Memory ${getMemoryStatus()} | Skill ${getSkillStatus()}`);

    // LLM 关键词缓存：事件驱动刷新为主（before_agent_start 检测话题切换），
    // 此处为兜底：达到 REFRESH_INTERVAL（8 轮）仍强制刷新（异步不阻塞）
    if (searcher.incrementTurn()) {
      const ctxText = buildSearcherContext(ctx);
      searcher.refreshKeywords(ctxText).catch(() => {});
    }
  });

  // ── Context Injection ───────────────────────────────────────

  const MEMORY_TOOL_REMINDER = loadMemoryPrompts().toolReminder;

  pi.on("before_agent_start", async (event, ctx) => {
    // Build combined query: current user input + recent conversation history
    let queryText = event.prompt;
    try {
      const entries = ctx.sessionManager.getEntries();
      const recentMessages = entries
        .filter((e: any) => e.type === "message")
        .slice(-10)
        .map((e: any) => {
          const content = e.message?.content;
          if (typeof content === "string") return `[${e.message?.role}] ${content}`;
          if (Array.isArray(content)) {
            return content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join(" ");
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (recentMessages) {
        queryText = `${event.prompt}\n${recentMessages}`;
      }
    } catch {
      // sessionManager not available, fall back to prompt only
    }

    // 冻结快照（固定不变）→ system prompt 前缀稳定 → 命中 provider 前缀缓存
    const systemContext = manager.buildSystemPrompt();
    if (systemContext) {
      event.systemPrompt += `\n\n${systemContext}`;
    }

    // 子记忆（按 query 路由、每轮变化）→ context 事件注入消息末尾，不污染前缀
    // 流程：倒排索引粗选 top-10 候选 → LLM 语义去无关项（每 turn 1 次）→ 保留 2-4 个 → 缓存
    // jieba 只分词当前 prompt（历史消息不直接分词，避免记忆整理等旧话题词污染搜索结果）；
    // LLM 关键词提取（cachedKeywords）仍基于完整 queryText（LLM 有语义理解能过滤历史噪音）
    const candidates = searcher.searchTopCandidates(event.prompt);
    let subMemories = "";
    if (candidates.length > 0) {
      // LLM 语义去无关项：过滤掉字面重合但语义无关的候选（如含"流程"但非当前主题）
      const filtered = await searcher.filterMemories(candidates, queryText);
      const body = filtered.map((c) => c.content).join("\n\n");
      // 不带文件路径（用户拍板：可溯源性放弃），保留"非用户输入"声明（指令优先级缓解）
      subMemories = body
        ? `<memory-context>\n[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data.]\n\n${body}\n</memory-context>`
        : "";
    }
    _pendingContext = { queryText, subMemories, cwd: ctx.cwd };

    // 事件驱动刷新：话题切换（jieba(prompt) 与缓存关键词无交集）→ fire-and-forget 重建关键词
    // 不 await：本轮仍用旧缓存 + jieba(prompt) 保底（S3 合并），下轮起用新关键词
    searcher.maybeRefreshKeywords(event.prompt, queryText);

    event.systemPrompt += MEMORY_TOOL_REMINDER;
    const skillRefs = event.prompt.match(/<skill\s+name="([^"]+)"/g) || [];
    for (const ref of skillRefs) {
      const name = ref.match(/name="([^"]+)"/);
      if (name) loadedSkillsThisSession.add(name[1]);
    }
    const skillPlaceholders = event.prompt.match(/\[skill:\s*([^\]]+)\]/g) || [];
    for (const ref of skillPlaceholders) {
      const name = ref.match(/\[skill:\s*([^\]]+)\]/);
      if (name) loadedSkillsThisSession.add(name[1].trim());
    }

    // 必须 return 修改后的 systemPrompt，否则 pi 丢弃所有变更
    return { systemPrompt: event.systemPrompt };
  });

  // ── context 事件：规则 + 子记忆合并注入到消息末尾 ───────────
  //
  // 前缀缓存策略：system prompt（固定快照）+ 历史消息保持前缀稳定；
  // 变化内容（rules / 子记忆）append 到 event.messages 末尾，不破坏前缀命中。
  // context 事件修改的是 structuredClone 副本，不写回 state → 不进 session JSONL。

  pi.on("context", (event) => {
    const injected: { role: "user"; content: string }[] = [];

    // 1. 子记忆参考（背景信息，放前——recency 让规则贴近生成点权重更高）
    if (_pendingContext?.subMemories) {
      injected.push({
        role: "user",
        content: _pendingContext.subMemories,
      });
    }

    // 2. 保存规则（load_memory_rules 注入，行动指令放后——离 LLM 决策点近，遵循权重高）
    if (_rulesState.content) {
      injected.push({
        role: "user",
        content: "[Memory Classification Rules Loaded]\n" + _rulesState.content,
      });
    }

    if (injected.length > 0) {
      event.messages.push(...injected);
      return { messages: event.messages };
    }
  });

  // ── tool_execution_end：memory 调用后标记清理 ───────────────

  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "memory" && _rulesState.content) {
      if (_rulesState.mode === "once") {
        _rulesState.content = null;  // once：清空后 context 事件不再注入
      }
      // mode === "always" → 不清理，content 保持，每次 context 继续注入
    }
  });

  // ── agent_end：常驻规则随进程销毁 ───────────────────────────

  pi.on("agent_end", () => {
    _rulesState = { content: null, mode: null };
  });

  // ── Memory Tool ─────────────────────────────────────────────

  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "WRITE TO PERSISTENT MEMORY. Use the CORRECT target.\n" +
      "  1. User preference/habit → target='user'\n" +
      "  2. Global env fact → target='memory'\n" +
      "  3. Project-specific info → target='sub-memory', path='{category}/{name}.md'\n" +
      "  4. Workflow → create a skill, not memory\n" +
      "RULE: project path in message = sub-memory, NOT memory/user.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "replace", "remove"],
          description: "The operation to perform. Omit when using 'operations' for batch.",
        },
        target: {
          type: "string",
          enum: ["memory", "user", "sub-memory"],
          description:
            "CRITICAL — wrong target = routing system can never load it.\n" +
            "  'user'        = user attributes (preference, habit, role, style)\n" +
            "  'memory'      = global env facts (encoding, OS, universal paths)\n" +
            "  'sub-memory'  = project-specific (requires path param: '{category}/{name}.md')\n" +
            "项目路径/端口/版本/配置 -> sub-memory | 用户偏好 -> user | 全局常量 -> memory",
        },
        content: { type: "string", description: "Entry content for add/replace." },
        path: {
          type: "string",
          description:
            "REQUIRED for target='sub-memory': relative path under sub-memories/, " +
            "e.g. 'wangxin/A104527-java8-setup.md'.",
        },
        old_text: {
          type: "string",
          description: "Substring identifying the entry for replace/remove.",
        },
        operations: {
          type: "array",
          description: "Batch of operations applied atomically. Preferred for multiple changes.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "replace", "remove"] },
              content: { type: "string" },
              old_text: { type: "string" },
            },
            required: ["action"],
          },
        },
      },
      required: ["target"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!manager) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Memory system not initialized." }) }], details: {} };
      }
      const result = manager.handleToolCall("memory", params as Record<string, unknown>);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ── Get Memory Tool ────────────────────────────────────────────

  pi.registerTool({
    name: "get_memory",
    label: "Get Memory",
    description:
      "Search persistent memory for relevant context using keywords. " +
      "Returns matched memory entries and sub-memory content. " +
      "Use BEFORE writing to sub-memory to check if related content already exists, " +
      "so you can update/merge instead of creating duplicates.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keywords to search memory with. Be specific — use 3-8 keywords " +
            "that describe the topic you need context on.",
        },
      },
      required: ["query"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const query = String(params.query || "");
      if (!query.trim()) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "query is required." }) }], details: {} };
      }
      const searcherResult = await searcher.searchWithIntent(query);
      const result = manager.prefetchAll(query, ctx.cwd, searcherResult);
      if (!result) {
        return { content: [{ type: "text", text: JSON.stringify({ success: true, message: "No matching memories found.", content: "" }) }], details: {} };
      }
      return { content: [{ type: "text", text: JSON.stringify({ success: true, content: result }) }], details: {} };
    },
  });

  // ── Load Memory Rules Tool ───────────────────────────────────

  pi.registerTool({
    name: "load_memory_rules",
    label: "Load Memory Rules",
    description:
      "Load 记忆保存信号.md and 记忆分类框架.md into context (appended to the end of the message list). " +
      "Call this when you decide to save information to memory, BEFORE calling memory. " +
      "Params: mode=\"once\" (default, clean after one memory call) or mode=\"always\" (permanent for this session).",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["once", "always"],
          description:
            "'once' (default): rules removed after memory tool completes. " +
            "'always': rules stay for the entire session (for subagents doing batch saves).",
        },
      },
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const profile = manager?.getProfileManager().getActiveProfile();
        if (!profile) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active profile." }) }], details: {} };
        }
        const signalFile = readFileSync(join(profile.path, "记忆保存信号.md"), "utf-8");
        const frameworkFile = readFileSync(join(profile.path, "记忆分类框架.md"), "utf-8");
        _rulesState = {
          content: `__PI_RULES__\n=== \u8BB0\u5FC6\u4FDD\u5B58\u4FE1\u53F7 ===\n${signalFile}\n\n=== \u8BB0\u5FC6\u5206\u7C7B\u6846\u67B6 ===\n${frameworkFile}\n\n__PI_RULES_END__`,
          mode: params?.mode === "always" ? "always" : "once",
        };
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, mode: _rulesState.mode, message: "Rules loaded. Mode: " + _rulesState.mode }) }],
          details: {},
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: e instanceof Error ? e.message : String(e) }) }],
          details: {},
        };
      }
    },
  });

  // ── Skill Manage Tool ───────────────────────────────────────

  pi.registerTool({
    name: "skill_manage",
    label: "Skill Manage",
    description:
      "Manage skills (create, edit, delete, list). Skills are your procedural " +
      "memory — reusable approaches for recurring task types. " +
      "General memory (MEMORY.md / USER.md) is broad and declarative; skills are " +
      "narrow and actionable.\n\n" +
      "Create when: complex task succeeded (5+ calls), errors overcome, " +
      "user-corrected approach worked, non-trivial workflow discovered.\n" +
      "Update when: instructions stale/wrong, missing steps or pitfalls found " +
      "during use. If you used a skill and hit issues not covered by it, patch it immediately.\n\n" +
      "New skills go to profiles/<active>/skills/<category>/<name>/SKILL.md. Existing skills " +
      "can be modified wherever they live.\n\n" +
      "Pinned skills are protected from deletion only — edit and write_file still work. " +
      "Unpin first to delete. Bundled skills (system-level) cannot be modified at all.\n\n" +
      "Good skills include: concrete trigger conditions (When to Use), numbered steps " +
      "with exact commands, a pitfalls section, and verification steps. " +
      "Use skill_view() to see format examples.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "edit", "delete", "list", "write_file", "pin", "unpin"],
          description: "The operation to perform.",
        },
        name: {
          type: "string",
          description: "Skill name (lowercase-hyphenated, <=64 chars). Required for create/edit/delete/write_file.",
        },
        category: {
          type: "string",
          description: "Category folder (e.g. 'workflow', 'tool'). Required for create.",
        },
        content: {
          type: "string",
          description: "Full SKILL.md content for create/edit. Must include frontmatter and body sections.",
        },
        file_path: {
          type: "string",
          description: "Support file path for write_file. Must start with 'references/', 'templates/', or 'scripts/'.",
        },
      },
      required: ["action"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!skillManager) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Skill manager not initialized." }) }], details: {} };
      }
      const result = handleSkillManageTool(params as Record<string, unknown>, skillManager);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ── Skill View Tool ─────────────────────────────────────────

  pi.registerTool({
    name: "skill_view",
    label: "Skill View",
    description: "View the content of a skill's SKILL.md or support files. Use this to inspect a skill before deciding whether to update it.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (e.g. 'git-commit')." },
        file_path: { type: "string", description: "Optional: path to a support file (e.g. 'references/api.md')." },
      },
      required: ["name"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!skillManager) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Skill manager not initialized." }) }], details: {} };
      }
      const result = handleSkillViewTool(params as Record<string, unknown>, skillManager);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // ── /profile Command ────────────────────────────────────────

  pi.registerCommand("profile", {
    description: "List or switch memory profiles. Usage: /profile [list|switch <name>]",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0];

      if (sub === "list" || !sub) {
        const profiles = manager.listProfiles();
        const active = manager.activeProfile;
        const lines = profiles.map((p) => p.name === active ? `* ${p.name} (active)` : `  ${p.name}`);
        ctx.ui.notify(`Profiles:\n${lines.join("\n")}`, "info");
        return;
      }

      if (sub === "switch" && parts[1]) {
        try {
          manager.switchProfile(parts[1]);
          const profile = manager.getProfileManager().getActiveProfile();
          skillManager = new SkillManager(profile.path, [
            resolve(agentDir, "skills"),
          ]);
          profileSkillsPath = profile.path;
          // M3：切换 profile 后同步 searcher（路径 + 清缓存防串档）
          searcher.setProfilePath(profile.path);
          searcher.clearKeywords();
          searcher.resetTurn();
          // workflow 系统跟随 profile 重建（数据库文件在 profile 目录下）
          workflowController.shutdown();
          workflowController.init();
          ctx.ui.notify(`Switched to profile: ${parts[1]}`, "info");
        } catch (e) {
          ctx.ui.notify(`Failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      ctx.ui.notify("Usage: /profile [list|switch <name>]", "info");
    },
  });

  // ── /rebuild-index Command ─────────────────────────────────

  pi.registerCommand("rebuild-index", {
    description: "Rebuild inverted index from all memory files (deletes old index). Usage: /rebuild-index",
    handler: async (_args, ctx) => {
      const profile = manager.getProfileManager().getActiveProfile();
      const index = manager.invertedIndexInstance;

      const entries: Array<{ filePath: string; content: string }> = [];

      // MEMORY.md/USER.md 不走索引（store 快照常驻注入，避免重复），
      // 只索引 sub-memories/ 下的按需检索文件
      const subDir = join(profile.path, "sub-memories");
      if (existsSync(subDir)) {
        const walk = (dir: string, prefix: string) => {
          for (const item of readdirSync(dir)) {
            const full = join(dir, item);
            const s = statSync(full);
            if (s.isDirectory()) {
              walk(full, `${prefix}${item}/`);
            } else if (item.endsWith(".md")) {
              entries.push({ filePath: `sub-memories/${prefix}${item}`, content: readFileSync(full, "utf-8") });
            }
          }
        };
        walk(subDir, "");
      }

      index.rebuild(entries);
      ctx.ui.notify(`倒排索引已重建：${entries.length} 个文件，${index.size} 个关键词`, "info");
    },
  });
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

function getAgentDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || process.env.HOMEDRIVE + process.env.HOMEPATH || "";
  return process.env.PI_CODING_AGENT_DIR || `${home}/.pi/agent`;
}

/**
 * 为 LLM 关键词设计器构建上下文文本。
 * 从 session 中取最近有效轮次的对话摘要。
 */
function buildSearcherContext(ctx: any): string {
  try {
    const entries = ctx.sessionManager.getEntries();
    const messages = entries
      .filter((e: any) => e.type === "message")
      .slice(-20)
      .map((e: any) => {
        const c = e.message?.content;
        if (typeof c === "string") return `[${e.message?.role}] ${c}`;
        if (Array.isArray(c)) {
          return c
            .filter((x: any) => x.type === "text")
            .map((x: any) => x.text)
            .join(" ");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return messages || "No prior conversation.";
  } catch {
    return "No prior conversation.";
  }
}
