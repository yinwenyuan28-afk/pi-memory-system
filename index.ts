import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MemoryManager,
} from "./memory/index.js";
import {
  SkillManager,
  setBundledSkillsPaths,
} from "./skill/index.js";
import { setupMemoryReviewer } from "./memory/review/reviewer.js";
import { setupSkillReviewer } from "./skill/reviewer.js";
import { LLMKeywordSearcher } from "./memory/search/searcher.js";
import { loadMemoryPrompts } from "./memory/prompts.js";
import { resolveConfiguredModel } from "./config/model-config.js";
// [DISABLED] workflow 保存系统已禁用（保留代码，恢复时取消注释即可）
// import { setupWorkflowSystem } from "./workflow/index.js";
import { archiveSessionIncrement } from "./memory/l0/index.js";
import { loadL1Config, saveL1Mode, setupL1Extractor } from "./memory/l1/index.js";
import { registerL1CommitTool } from "./memory/l1/commit-tool.js";
import { registerReadL0IncrementTool } from "./memory/l1/read-tool.js";
import { setupL2Organizer } from "./memory/l2/index.js";
import { registerL2CommitTool } from "./memory/l2/commit-tool.js";
import { setupL3Persona } from "./memory/l3/index.js";
import { registerL3CommitTool } from "./memory/l3/commit-tool.js";
import { registerEmbedAndSearchTool } from "./memory/search/embedding/tool.js";
import { handleSkillManageTool } from "./skill/skill-tool.js";
import { handleSkillViewTool } from "./skill/skill-view-tool.js";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const manager = new MemoryManager(agentDir);
  const searcher = new LLMKeywordSearcher();
  // [DISABLED] workflow 保存系统控制器已禁用（保留代码，恢复时取消注释）
  // const workflowController = setupWorkflowSystem(pi, {
  //   getProfilePath: () => manager?.getProfileManager().getActiveProfile()?.path,
  //   getSessionId: () => sessionId,
  // });
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

  // L1 提取调度器（单次注册，与 reviewersInitialized 同模式）
  let l1Initialized = false;
  let l1Controls: { reset: () => void; triggerManual: (ctx?: ExtensionContext) => void } | undefined;

  // L2 场景组织调度器（单次注册）：主进程轮询 l1-cursor.json mtime 变化触发计数（08-17 修复回调跨进程断裂）
  let l2Initialized = false;
  let l2Controls: { reset: () => void; triggerManual: (ctx?: ExtensionContext) => void } | undefined;

  // L3 persona 调度器（单次注册）：L2 提交后评估触发
  let l3Initialized = false;
  let l3Controls: {
    onL1Committed: (recordCount: number) => void;
    onL2Committed: (opts?: { personaSignal?: boolean; personaReason?: string }) => void;
    triggerManual: () => void;
    reset: () => void;
  } | undefined;

  // l1_commit 工具：l1-extractor 子代理的写盘桥接（工具调用不受 Plan Enforcer 拦截）。
  // 回调仅供主进程内（其他扩展模块）同步用，不依赖回调通知 L2 调度：
  // L2 调度已改为主进程轮询 l1-cursor.json mtime 变化（08-17 修复回调跨进程断裂）。
  registerL1CommitTool(
    pi,
    () => manager?.getProfileManager().getActiveProfile()?.path,
    (written) => {
      // l2Controls?.onL1Committed(); // 已废弃：回调闭包在子代理进程 = undefined，静默丢弃
      l3Controls?.onL1Committed(written);
    },
  );
  // l2_commit 工具：l2-scene-organizer 子代理的场景写盘桥接；personaSignal → L3 P1
  registerL2CommitTool(
    pi,
    () => manager?.getProfileManager().getActiveProfile()?.path,
    (opts) => l3Controls?.onL2Committed(opts),
  );
  // l3_commit 工具：l3-persona-generator 子代理的 USER.md 写盘桥接
  registerL3CommitTool(
    pi,
    () => manager?.getProfileManager().getActiveProfile()?.path,
    () => manager,
  );
  // read_l0_increment 工具：l1-extractor 子代理一次读取游标后增量（替代逐段 read，性能修复）
  registerReadL0IncrementTool(pi);
  // embed_and_search 工具：l1-extractor 子代理自主调用 embedding + vector store search（方案 B，用户拍板 2026-08-18）
  registerEmbedAndSearchTool(pi);

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

    // 初始化 L1 提取调度器（单次注册）：每 L1_INTERVAL 轮启动 l1-extractor 子代理
    if (!l1Initialized) {
      l1Controls = setupL1Extractor(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
      l1Initialized = true;
    }

    // 初始化 L2 场景组织调度器（单次注册）：L1 提交 L2_BATCH 批后触发
    if (!l2Initialized) {
      l2Controls = setupL2Organizer(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
      l2Initialized = true;
    }

    // 初始化 L3 persona 调度器（单次注册）：L2 提交后评估触发
    if (!l3Initialized) {
      l3Controls = setupL3Persona(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
      l3Initialized = true;
    }

    // [DISABLED] 初始化工作流保存系统已禁用（保留代码，恢复时取消注释）
    // workflowController.init(ctx);

    ctx.ui.setStatus("memory", `Memory ${getMemoryStatus()} | Skill ${getSkillStatus()}`);

    // 2026-08-08：后台 LLM 调用统一用配置模型（默认 minimax-cn/MiniMax-M3），
    // 不跟随前台会话切换。配置缺失/无效 → fallback ctx.model。
    const configuredModel = resolveConfiguredModel(agentDir, ctx.model) as Parameters<typeof completeSimple>[0];

    // Wire up LLM filter for inverted index (async, non-blocking)
    manager.invertedIndexInstance.setLLMFilter(async (prompt: string) => {
      try {
        const result = await completeSimple(configuredModel, {
          systemPrompt: "You respond only with JSON.",
          messages: [{ role: "user", content: prompt }],
        });
        return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      } catch {
        return "";
      }
    });

    // 初始化 LLMKeywordSearcher
    searcher.setModel(configuredModel);
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
    l1Controls?.reset();
    l2Controls?.reset();
    l3Controls?.reset();
    // [DISABLED] workflowController.shutdown();
  });

  // ── model_select：后台调用不跟随前台切换（2026-08-08）────────
  // 背景：记忆系统后台 LLM 调用走配置模型（默认 minimax-cn/MiniMax-M3），
  // 用户在 TUI 切换前台模型不应影响后台。预留 hook 不重写 searcher/wf 模型。
  pi.on("model_select", (_event) => {
    /* no-op by design: 后台模型与前台模型解耦 */
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

    // L0 净化归档：每轮增量把 session 新消息写入 {profile}/conversations/YYYY-MM-DD.jsonl
    // （去重=行号游标；降噪=SanitizeRule 规则集；分片=本地日期；cwd=ctx.cwd 精确值）。
    // 同步执行（毫秒级），异常不阻塞主流程。
    //
    // 子代理进程守卫：pi-subagents 启动子代理时设 PI_SUBAGENT_CHILD=1，子代理加载本扩展后
    // 同样会触发 before_agent_start。若不守卫，子代理自己的 sessionFile（长路径：
    // {sessionId}/{runId}/run-0/session.jsonl）会被当主会话归档，导致 L0 分片污染
    // （子代理的 thinking / tool_call / l1_commit 响应都进入 conversations/），
    // 下轮 L1 提取读到上一轮 L1 自身执行痕迹（“框架噪音”）。
    // 根因验证：2026-08-18 l0-cursor.json 含大量 /\run-0\session.jsonl/ entry，
    // 对应子代理 session 文件（id 与主会话不同，modelId=mimo-v2.5）。
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const profile = manager?.getProfileManager().getActiveProfile();
      if (sessionFile && profile) {
        const result = archiveSessionIncrement(sessionFile, profile.path, ctx.cwd);
        if (result.error) {
          console.warn(`[memory-system][l0] ${result.error}`);
        }
      }
    } catch (e) {
      console.warn(`[memory-system][l0] archive failed: ${e instanceof Error ? e.message : String(e)}`);
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
    // 流程：倒排索引粗选 top-10 文件 → splitSections 切章节 → 逐章 jaccard 评分
    //       → LLM 语义去无关项（每 turn 1 次）→ 保留相关章节（≤5 章/4KB）→ 缓存
    // jieba 只分词当前 prompt（历史消息不直接分词，避免记忆整理等旧话题词污染搜索结果）；
    // LLM 关键词提取（cachedKeywords）仍基于完整 queryText（LLM 有语义理解能过滤历史噪音）
    const candidates = searcher.searchSectionCandidates(event.prompt);
    let subMemories = "";
    if (candidates.length > 0) {
      // LLM 语义去无关项：过滤掉字面重合但语义无关的候选章节（如含"流程"但非当前主题）
      const filtered = await searcher.filterMemories(candidates, queryText);
      // 拼接：带章节标题上下文（用户拍板：只给章节标题，不扩展相邻章节）
      // 同文件多章节合并连续；无标题（前言/整文件）直接拼正文
      const parts: string[] = [];
      let totalChars = 0;
      for (const sec of filtered) {
        const block = sec.title ? `## ${sec.title}\n${sec.content}` : sec.content;
        totalChars += block.length + 2;
        if (totalChars > 4096) break; // ≤4KB 截断（按 LLM 相关度降序，丢尾部最不相关的）
        parts.push(block);
      }
      const body = parts.join("\n\n");
      // 不带文件路径（用户拍板：可溯源性放弃），保留"非用户输入"声明（指令优先级缓解）
      subMemories = body
        ? `<memory-context>\n[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data.]\n\n${body}\n</memory-context>`
        : "";
    }
    _pendingContext = { queryText, subMemories: "", cwd: ctx.cwd }; // 赋值空占位，L1 召回后重新赋值

    // L1 records 向量召回注入（与 sub-memories jieba 注入并行，独立实体不融合）
    // 仅当 vector store 可用且 embedding.json 已配置时触发；失败静默降级（不注入）
    // 设计修正（2026-08-18）：plan 原 Step 4 想 RRF 融合 L1 records 与 sub-memories，
    // 但两者是不同记忆实体（原子记忆 vs 项目文档），path 维度不同无法融合，改为独立注入。
    try {
      const { getVectorStore } = await import("./memory/search/vector-store/store.js");
      const { getEmbeddingService } = await import("./memory/search/embedding/service.js");
      const profile = manager?.getProfileManager().getActiveProfile();
      if (profile) {
        const vecStore = await getVectorStore(profile.path);
        if (await vecStore.isAvailable() && (await vecStore.count()) > 0) {
          const embService = await getEmbeddingService(profile.path);
          const queryVec = await embService.embed(event.prompt);
          const hits = await vecStore.search(queryVec, 3);
          if (hits.length > 0) {
            const parts: string[] = [];
            for (const hit of hits) {
              const { loadL1RecordById } = await import("./memory/search/embedding/record-loader.js");
              const rec = await loadL1RecordById(hit.recordId, profile.path);
              if (rec && !rec.deleted) {
                parts.push(`- ${rec.content}`);
              }
            }
            if (parts.length > 0) {
              const l1Block = subMemories
                ? `${subMemories}\n<l1-records>\n${parts.join("\n")}\n</l1-records>`
                : `<l1-records>\n${parts.join("\n")}\n</l1-records>`;
              subMemories = l1Block;
              // 同步更新 _pendingContext（否则 context 事件拿不到 L1 注入）
              _pendingContext.subMemories = l1Block;
            }
          }
        }
      }
    } catch (e) {
      // L1 向量召回失败静默降级（不阻塞主流程，不注入）
      console.warn(`[memory-system][l1-recall] ${e instanceof Error ? e.message : String(e)}`);
    }

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

  // ── context 事件：规则 + 子记忆合并注入（锚点注入，2026-08-08） ──
  //
  // 前缀缓存策略：system prompt（固定快照）+ 历史消息保持前缀稳定。
  // context 事件修改的是 structuredClone 副本，不写回 state → 不进 session JSONL。
  //
  // 锚点注入：context 每轮 LLM 调用前触发，注入不持久化 → 必须每轮重新注入。
  // 若一律 push 到末尾，工具轮次中记忆块紧贴工具结果，LLM 注意力集中在末尾（recency）
  // 把记忆当"最新到达的输入"反复评估相关性 → 产生"记忆上下文与当前任务无关，忽略"的思考，
  // 浪费 token 和注意力。改为以本轮 user 消息（最后一条 role=user）为锚点 splice 到其后：
  //   第 1 轮: [..., user msg, 记忆块]
  //   第 2 轮: [..., user msg, 记忆块, assistant, toolResult]
  // 记忆块固定紧跟用户消息 → 语义上是"本条用户消息的背景参考"，工具轮次不再出现在末尾；
  // 记忆块位置固定也有利于 provider prefix cache 前缀稳定。

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
      const messages = event.messages;
      // 锚点：最后一条 user 消息（多轮历史中最后一条 user 仍是本轮用户输入）
      let anchorIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          anchorIdx = i;
          break;
        }
      }
      if (anchorIdx >= 0) {
        messages.splice(anchorIdx + 1, 0, ...injected);
      } else {
        messages.push(...injected); // 兜底：无 user 消息（followUp 等特殊场景）追加末尾
      }
      return { messages };
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
      "  1. User preference/habit/style correction → target='user'\n" +
      "  2. Global env fact or behavior constraint → target='memory'\n" +
      "  3. Project-specific info → target='sub-memory', path='{category}/{name}.md'\n" +
      "  4. Bounded-task-class executable SOP → skill_manage, NOT memory\n" +
      "RULE: preferences/instructions → memory; executable workflows → skill; project path → sub-memory.",
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

  // ── L1 Mode Command ───────────────────────────────────────

  pi.registerCommand("my-memory:l1-mode", {
    description: "Switch L1 extraction mode: code (work_fact/work_task/work_method/work_artifact) or chat (persona/episodic/instruction). Usage: /my-memory:l1-mode [code|chat]",
    usage: "Usage: /my-memory:l1-mode [code|chat]",
    handler: async (args, ctx) => {
      const profile = manager?.getProfileManager().getActiveProfile();
      if (!profile) {
        ctx.ui.notify("No active profile", "error");
        return;
      }
      const mode = (args || "").trim().toLowerCase();
      if (mode !== "code" && mode !== "chat") {
        ctx.ui.notify(`Current L1 mode: ${loadL1Config(profile.path).mode}. Usage: /my-memory:l1-mode [code|chat]`, "info");
        return;
      }
      saveL1Mode(profile.path, mode as "code" | "chat");
      ctx.ui.notify(`L1 mode switched to: ${mode}`, "info");
    },
  });

  // ── L3 Persona Command ─────────────────────────────────────

  pi.registerCommand("my-memory:persona", {
    description: "Manually trigger L3 persona generation (updates USER.md from L2 scenes).",
    usage: "Usage: /my-memory:persona",
    handler: async (_args, ctx) => {
      if (!l3Controls) {
        ctx.ui.notify("L3 persona scheduler not initialized", "error");
        return;
      }
      ctx.ui.notify("L3 persona generation queued", "info");
      l3Controls.triggerManual();
    },
  });

  // ── /profile Command ────────────────────────────────────────

  pi.registerCommand("my-memory:profile", {
    description: "List or switch memory profiles. Usage: /my-memory:profile [list|switch <name>]",
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
          // [DISABLED] workflow 系统跟随 profile 重建已禁用（保留代码，恢复时取消注释）
          // workflowController.shutdown();
          // workflowController.init();
          ctx.ui.notify(`Switched to profile: ${parts[1]}`, "info");
        } catch (e) {
          ctx.ui.notify(`Failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      ctx.ui.notify("Usage: /my-memory:profile [list|switch <name>]", "info");
    },
  });

  // /l2-trigger：手动触发一次 L2 场景组织（绕过攒批）——供调试/验证使用。
  // 需 setupL2Organizer 已初始化，否则提示重启 pi 加载新扩展。
  pi.registerCommand("my-memory:l2-trigger", {
    description: "手动触发一次 L2 场景组织（绕过 L2_BATCH 攒批）。Usage: /my-memory:l2-trigger",
    handler: async (_args, ctx) => {
      if (!l2Controls) {
        ctx.ui.notify("L2 调度器未初始化（扩展加载中或未启用）", "error");
        return;
      }
      ctx.ui.notify("正在手动触发 L2 场景组织...", "info");
      // 传 ctx 绕过 cachedCtx 依赖（命令路径保证 ctx 可用）
      l2Controls.triggerManual(ctx);
    },
  });

  // /l1-trigger：手动触发一次 L1 提取（绕过 L1_INTERVAL 攒轮数）——供调试/验证使用。
  // 需 setupL1Extractor 已初始化，否则提示重启 pi 加载新扩展。
  pi.registerCommand("my-memory:l1-trigger", {
    description: "手动触发一次 L1 提取（绕过 L1_INTERVAL 攒轮数）。Usage: /my-memory:l1-trigger",
    handler: async (_args, ctx) => {
      if (!l1Controls) {
        ctx.ui.notify("L1 调度器未初始化（扩展加载中或未启用）", "error");
        return;
      }
      ctx.ui.notify("正在手动触发 L1 提取...", "info");
      l1Controls.triggerManual(ctx);
    },
  });

  // ── /vectorize-list Command ─────────────────────────────────
  // 查询 L1 records 向量化状态：哪些已向量化、哪些未向量化。
  // 从 vector store 的 l1_vector_index 辅助映射表读已向量化清单，与 records/ JSONL 对比。
  pi.registerCommand("my-memory:l1:embedding:list", {
    description: "查询 L1 records 向量化状态。Usage: /my-memory:l1:embedding:list [limit=10]",
    handler: async (args, ctx) => {
      const profile = manager.getProfileManager().getActiveProfile();
      if (!profile) {
        ctx.ui.notify("No active profile", "error");
        return;
      }
      const limit = parseInt((args || "").trim(), 10) || 10;
      try {
        const { getVectorizationStatus, formatStatus } = await import("./memory/search/embedding/backfill.js");
        const status = await getVectorizationStatus(profile.path);
        ctx.ui.notify(formatStatus(status, limit), "info");
      } catch (e) {
        ctx.ui.notify(`查询失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // ── /vectorize-backfill Command ─────────────────────────────
  // 批量回填未向量化的 L1 records。
  // 前置条件：vectorization.json 中 enabled=true + embedding.json 可读。
  // 注意：需重启 pi 才能使用本命令（memory-system.ts 改动需重启加载）。
  pi.registerCommand("my-memory:l1:embedding:backfill", {
    description: "批量将未向量化的 L1 records 嵌入向量并入库。Usage: /my-memory:l1:embedding:backfill",
    handler: async (_args, ctx) => {
      const profile = manager.getProfileManager().getActiveProfile();
      if (!profile) {
        ctx.ui.notify("No active profile", "error");
        return;
      }
      try {
        const { backfillMissingVectors, getVectorizationStatus } = await import("./memory/search/embedding/backfill.js");
        const status = await getVectorizationStatus(profile.path);
        if (status.unVectorizedCount === 0) {
          ctx.ui.notify(`✅ 所有 ${status.totalRecords} 条 L1 records 都已向量化，无需回填`, "info");
          return;
        }
        if (!status.readyForBackfill) {
          ctx.ui.notify(
            `❌ 回填前置条件不满足：检查 embedding.json + vectorization.json（enabled=true）。未向量化 ${status.unVectorizedCount} 条`,
            "error",
          );
          return;
        }
        ctx.ui.notify(`开始回填：${status.unVectorizedCount} 条待向量化`, "info");
        const result = await backfillMissingVectors(profile.path, (p) => {
          ctx.ui.notify(`回填进度: ${p.done}/${p.total}`, "info");
        });
        const msg = `✅ 回填完成: 成功 ${result.embedded}/${result.total}，耗时 ${result.durationMs}ms${result.failed > 0 ? `，失败 ${result.failed}` : ""}${result.errors.length > 0 ? `\n错误:\n${result.errors.slice(0, 3).join("\n")}` : ""}`;
        ctx.ui.notify(msg, result.failed > 0 ? "error" : "info");
      } catch (e) {
        ctx.ui.notify(`回填失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // ── /my-memory:l1:embedding:rebuild Command ────────────────────────────
  // 清空 vector store + 重新嵌入所有 L1 records。
  // 用途：embedding 模型/维度变更后重算、修复 vector store 污染（如 POC 残留）、修复未归一化旧嵌入。
  // 注意：需重启 pi 加载归一化后的 service.ts 才能使新嵌入生效。
  pi.registerCommand("my-memory:l1:embedding:rebuild", {
    description: "清空 vector store 并重新嵌入所有 L1 records（解决旧嵌入污染）。Usage: /my-memory:l1:embedding:rebuild",
    handler: async (_args, ctx) => {
      const profile = manager.getProfileManager().getActiveProfile();
      if (!profile) {
        ctx.ui.notify("No active profile", "error");
        return;
      }
      try {
        const { rebuildAllVectors, getVectorizationStatus } = await import("./memory/search/embedding/backfill.js");
        const status = await getVectorizationStatus(profile.path);
        if (status.totalRecords === 0) {
          ctx.ui.notify("❌ 没有 L1 records 可重建", "error");
          return;
        }
        ctx.ui.notify(`开始 rebuild：清空 vector store + 重新嵌入 ${status.totalRecords} 条 records`, "info");
        const result = await rebuildAllVectors(profile.path, (p) => {
          ctx.ui.notify(`rebuild 进度: cleared=${p.cleared}, embedded=${p.embedded}/${p.total}`, "info");
        });
        const msg = `✅ rebuild 完成: 清空 ${result.cleared} 条旧向量，重新嵌入 ${result.embedded}/${result.total} 条${result.failed > 0 ? `，失败 ${result.failed}` : ""}，耗时 ${result.durationMs}ms${result.errors.length > 0 ? `\n错误:\n${result.errors.slice(0, 3).join("\n")}` : ""}`;
        ctx.ui.notify(msg, result.failed > 0 ? "error" : "info");
      } catch (e) {
        ctx.ui.notify(`rebuild 失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // ── /rebuild-index Command ─────────────────────────────────

  pi.registerCommand("my-memory:rebuild-index", {
    description: "Rebuild inverted index from all memory files (deletes old index). Usage: /my-memory:rebuild-index",
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
