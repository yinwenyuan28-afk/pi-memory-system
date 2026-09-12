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
// [DISABLED] workflow 保存系统已禁用（保留代码，恢复时取消注释即可）
// import { setupWorkflowSystem } from "./workflow/index.js";
import { archiveSessionIncrement } from "./memory/l0/index.js";
import { archiveSkillFeedIncrement } from "./skill/feed-cleaner.js";
import { loadL1Config, saveL1Mode, setupL1Extractor } from "./memory/l1/index.js";
import { registerL1CommitTool } from "./memory/l1/commit-tool.js";
import { registerReadL0IncrementTool } from "./memory/l1/read-tool.js";
import { registerReadL1IncrementTool } from "./memory/l2/read-tool.js";
import { registerReadSkillFeedIncrementTool } from "./skill/feed-reader.js";
import { setupL2Organizer } from "./memory/l2/index.js";
import { setupPipelineWorker, type PipelineExecutors, type PipelineWorker } from "./memory/pipeline/worker.js";
import { getPipelineJobsDB } from "./memory/pipeline/jobs-db.js";
import { registerL2CommitTool } from "./memory/l2/commit-tool.js";
import { setupL3Persona } from "./memory/l3/index.js";
import { registerL3CommitTool } from "./memory/l3/commit-tool.js";
import { registerEmbedAndSearchTool } from "./memory/search/embedding/tool.js";
import { registerRecallL1RecordsTool } from "./memory/search/recall-l1-records-tool.js";
import { registerClearInvalidL1RecordsTool } from "./memory/search/clear-invalid-l1-records-tool.js";
import { registerFixTool } from "./memory/l1/fix-tool.js";
import { loadRecallConfig } from "./memory/search/recall-config.js";
import { handleSkillManageTool } from "./skill/skill-tool.js";
import { handleSkillViewTool } from "./skill/skill-view-tool.js";
import { render as renderPrompt, checkPromptAssets } from "./prompts/registry.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ── L1 召回 query 条件式扩展（2026-09-02，L1_RECALL_GATE_PLAN 任务 9） ──────────
// 背景：无条件拼 10 条历史会向量稀释且语义自相矛盾（历史本就在 context 里），被否决。
// conditional 只在指代消解场景触发，把裸 prompt 扩成 prompt + 最近 2 条 user 消息。

/** 是否命中指代消解场景：prompt 过短（<12 字）或含指代词。 */
function needsContextExpansion(prompt: string): boolean {
  const t = (prompt || "").trim();
  if (!t) return false;
  if (t.length < 12) return true;
  return /(?:它|这个|那个|刚才|上面|同上|再|还是|前者|后者)/.test(t);
}

/** 提取一条 message entry 的纯文本（兼容 string content 与分段 content）。 */
function extractMessageText(e: any): string {
  const content = e?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ");
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const manager = new MemoryManager(agentDir);
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
  let _pendingContext: { subMemories: string } | null = null;

  // L1 命中计数 turn 级去重集合：before_agent_start 每 turn 开头清空。
  // 同一 turn 内，自动注入（top-3）与 recall_l1_records 工具（top-5）召回同一条记忆时只计 1 次命中。
  // 工具与注入共用同一引用（都在本进程闭包内）。retry/compaction/followUp 不重触发 before_agent_start，
  // Set 保留 → 同一 turn 的续跑仍去重，语义正确。
  const currentTurnHitSet = new Set<string>();

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
  let l1Controls: ReturnType<typeof setupL1Extractor> | undefined;

  // L2 场景组织调度器（单次注册）：由 pipeline-jobs 队列消费，不再 watchFile
  let l2Initialized = false;
  let l2Controls: ReturnType<typeof setupL2Organizer> | undefined;

  let pipelineInitialized = false;
  let pipelineWorker: PipelineWorker | undefined;
  let pipelineExecutors: PipelineExecutors | undefined;

  // L3 persona 调度器（单次注册）：L2 提交后评估触发
  let l3Initialized = false;
  let l3Controls: {
    onL1Committed: (recordCount: number) => void;
    onL2Committed: (opts?: { personaSignal?: boolean; personaReason?: string }) => void;
    triggerManual: (ctx?: ExtensionContext) => void | Promise<void>;
    reset: () => void;
  } | undefined;

  // ── Tool schema normalization（修复严格 OpenAI 兼容 provider 报错）────────────
  // pi 在转发工具给 OpenAI 兼容接口时，把 tool.parameters 原样当作函数 JSON Schema
  // 发出（openai-completions.ts: `parameters: tool.parameters`）。本扩展里部分工具的
  // parameters 写成了扁平 map：{ paramName: { type, description } }，缺顶层
  // type:"object"，导致 DeepSeek / opencode(Console Go) 等严格 provider 拒绝并报：
  //   "schema must be a JSON Schema of 'type: "object"', got 'type: null'"。
  // 这里把 registerTool 包一层，自动把扁平 map 升级成正规 JSON Schema 对象。
  // 已经是正规 JSON Schema（含 type:"object"）或 TypeBox schema（含 TypeBox.Kind）的
  // 工具不受影响，原样透传。
  const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
  const _origRegisterTool = pi.registerTool.bind(pi);
  (pi as { registerTool: (tool: any) => void }).registerTool = (tool: any) => {
    const params = tool?.parameters;
    const isFlatMap =
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      !params.type &&
      !Object.getOwnPropertySymbols(params).includes(TYPEBOX_KIND);
    if (isFlatMap) {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [key, spec] of Object.entries(params)) {
        properties[key] = spec;
        if ((spec as any)?.required === true) required.push(key);
      }
      tool.parameters = { type: "object", properties, required };
    }

    // Normalize execute result → AgentToolResult.
    // pi 把工具 execute 的返回值直接当作 AgentToolResult，必须含 content:[] 与 details
    // （packages/agent/src/types.ts: AgentToolResult）。本扩展多数工具的 execute 返回的是
    // 普通对象（如 { candidates, stats }），缺 content 字段，导致渲染工具结果时
    // getTextOutput 读 result.content.filter 崩溃：
    //   TypeError: Cannot read properties of undefined (reading 'filter')
    // 这里把 execute 包一层：若返回值没有 content 数组，则包成标准 AgentToolResult，
    // 把原对象放入 details，并用 JSON 文本作为 content 返回给模型（不丢数据）。
    // 已经是标准 AgentToolResult（含 content 数组）的工具原样透传。
    const originalExecute = tool.execute;
    if (typeof originalExecute === "function") {
      tool.execute = async (...args: any[]) => {
        const res = await originalExecute(...args);
        if (res && Array.isArray((res as any).content)) {
          return res; // 已是标准 AgentToolResult，原样透传
        }
        if (res == null) {
          return { content: [{ type: "text", text: "" }], details: {} };
        }
        const details = typeof res === "object" && !Array.isArray(res) ? res : { value: res };
        const text = typeof res === "string" ? res : JSON.stringify(res, null, 2);
        return { content: [{ type: "text", text }], details };
      };
    }

    return _origRegisterTool(tool);
  };

  // l1_commit 工具：l1-extractor 子代理的写盘桥接（工具调用不受 Plan Enforcer 拦截）。
  // L2 由 commit 进程直接写入 pipeline-jobs.sqlite；此处回调只给 L3 计数。
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
  // read_l1_increment 工具：l2-scene-organizer 子代理按游标取 L1 增量
  // 【2026-09-11 紧急修复】注册必须在这里（模块顶层、session_start 之前）：
  // 原注册点 setupL2Organizer 在 session_start 回调内、位于 PI_SUBAGENT_CHILD return 之后，
  // 子代理进程加载扩展时永远执行不到 → 工具从未在子代理注册（L2 管线死线，实测触发）。
  registerReadL1IncrementTool(pi, () => manager?.getProfileManager()?.getActiveProfile()?.path);
  // l3_commit 工具：l3-persona-generator 子代理的 USER.md 写盘桥接
  registerL3CommitTool(
    pi,
    () => manager?.getProfileManager().getActiveProfile()?.path,
    () => manager,
  );
  // read_l0_increment 工具：l1-extractor 子代理一次读取游标后增量（替代逐段 read，性能修复）
  registerReadL0IncrementTool(pi);
  // read_skill_feed_increment 工具：skill-reviewer 子代理读 5-role skill 原料增量（M4）
  registerReadSkillFeedIncrementTool(pi);
  // embed_and_search 工具：l1-extractor 子代理自主调用 embedding + vector store search（方案 B，用户拍板 2026-08-18）
  registerEmbedAndSearchTool(pi);
  // recall_l1_records 工具：agent 主动调用的 L1 原子记忆召回（与旧记忆系统解耦）
  registerRecallL1RecordsTool(pi, currentTurnHitSet);
  // clear_invalid_l1_records 工具：agent 主动标记无效召回（写入 invalid_hits 反馈信号，召回闭环）
  registerClearInvalidL1RecordsTool(pi);
  // l1_fix 工具：agent 自发纠错（护栏 + exec l1-admin；对应命令 /my-memory:l1:fix）——2026-09-11 A 档
  registerFixTool(pi, () => manager?.getProfileManager()?.getActiveProfile()?.path);

  pi.on("session_start", async (_event, ctx) => {
    manager.initialize();
    const profile = manager.getProfileManager().getActiveProfile();
    // 设置主代理进程的 profile 环境变量（供 recall_l1_records / embed_and_search 等工具用）
    // 子代理进程由 pi-subagents 注入，主代理进程需要在此显式设置
    if (profile) {
      process.env.PI_PROFILE_PATH = profile.path;
    }
    sessionId = ctx.sessionManager.getSessionId();

    // 子进程只需要模块顶层已注册的 commit/read 工具 + PI_PROFILE_PATH。
    // 不得 recoverStuckRunning / setupPipelineWorker / L1·L2 调度：否则会把父进程
    // 刚 claim 的 running l1 当成「崩溃残留」标 failed（2026-08-27 双 L1 假失败）。
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    // 提示词资产自检（PROMPT_REGISTRY）：md 被误删/改名/移走属仓库级损坏，
    // 离线逐字节校验见 scripts/verify-prompt-contracts.mjs；此处为每次启动的廉价兜底（console.warn）。
    for (const problem of checkPromptAssets()) {
      console.warn(`[memory-system][prompts] ${problem}`);
    }

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
      // [DISABLED 2026-09-11] memory-reviewer 停用：旧写入通道整体退役，其 `/remember` 命令、
      // 每 20 轮自动审查、memory 工具调用随之关闭。getMemoryStatus 保持默认值（状态栏显示 0t）。
      // memory-organizer 无代码调度入口，一并作废（见 agents/*.md 顶部停用横幅）。如需回退，取消注释。
      // getMemoryStatus = setupMemoryReviewer(pi, () => manager);
      getSkillStatus = setupSkillReviewer(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
      reviewersInitialized = true;
    }

    const getProfilePath = () => manager?.getProfileManager().getActiveProfile()?.path;

    // 流水线 worker（单次注册）：串行消费 pipeline-jobs.sqlite
    if (!pipelineInitialized) {
      pipelineWorker = setupPipelineWorker(pi, getProfilePath, () => pipelineExecutors);
      pipelineInitialized = true;
    }
    if (profile) {
      try {
        const n = getPipelineJobsDB(profile.path).recoverStuckRunning();
        if (n > 0) console.warn(`[memory-system][pipeline] recovered ${n} leftover running job(s)`);
      } catch (err) {
        console.warn(`[memory-system][pipeline] recover failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // L2 先于 L1：executors 需要两边的 executeJob
    if (!l2Initialized && pipelineWorker) {
      l2Controls = setupL2Organizer(pi, getProfilePath, pipelineWorker);
      l2Initialized = true;
    }

    if (!l1Initialized && pipelineWorker) {
      l1Controls = setupL1Extractor(pi, getProfilePath, pipelineWorker);
      l1Initialized = true;
    }

    if (l1Controls && l2Controls) {
      pipelineExecutors = {
        runL1: (ctx, job) => l1Controls!.executeJob(ctx, job),
        runL2: (ctx, job) => l2Controls!.executeJob(ctx, job),
        isCooledDown: (type) => (type === "l1" ? l1Controls!.isCooledDown() : l2Controls!.isCooledDown()),
      };
    }
    pipelineWorker?.setCachedCtx(ctx);
    pipelineWorker?.kick();

    // 初始化 L3 persona 调度器（单次注册）：L2 提交后评估触发
    if (!l3Initialized) {
      l3Controls = setupL3Persona(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
      l3Initialized = true;
    }

    // [DISABLED] 初始化工作流保存系统已禁用（保留代码，恢复时取消注释）
    // workflowController.init(ctx);

    ctx.ui.setStatus("memory", `Memory ${getMemoryStatus()} | Skill ${getSkillStatus()}`);

    // 2026-09-12：旧检索链（searcher 关键词设计 + 倒排索引接线）退役 —— 其产出只被已注释的
    // sub-memory / get_memory 路径消费，三处"关键词刷新"钩子（session_start / agent_settled /
    // before_agent_start）会向配置模型外发最近 20 条对话全文却无人使用。相关初始化与接线一并移除。
  });

  pi.on("session_shutdown", async () => {
    manager.shutdown();
    skillManager = undefined;
    profileSkillsPath = undefined;
    l1Controls?.reset();
    l2Controls?.reset();
    l3Controls?.reset();
    pipelineWorker?.reset();
    // [DISABLED] workflowController.shutdown();
  });

  // ── model_select：后台调用不跟随前台切换（2026-08-08）────────
  // 背景：记忆系统后台 LLM 调用走配置模型（默认 minimax-cn/MiniMax-M3），
  // 用户在 TUI 切换前台模型不应影响后台。预留 hook 不重写 searcher/wf 模型。
  pi.on("model_select", (_event) => {
    /* no-op by design: 后台模型与前台模型解耦 */
  });

  // ── 状态显示 ──────────────────────────────────────────────

  pi.on("agent_settled", async (_event, ctx) => {
    ctx.ui.setStatus("memory", `Memory ${getMemoryStatus()} | Skill ${getSkillStatus()}`);

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
        // skill-feed 原料清洗（5-role 高保真，喂 skill-reviewer；与 L0 双通道并存）
        const feedResult = archiveSkillFeedIncrement(sessionFile, profile.path, ctx.cwd);
        if (feedResult.error) {
          console.warn(`[memory-system][skill-feed] ${feedResult.error}`);
        }
      }
    } catch (e) {
      console.warn(`[memory-system][l0] archive failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // ── Context Injection ───────────────────────────────────────

  // 2026-09-12：模板迁入 prompts/registry 单源（prompts/backends/tool-reminder.md）；
  // 旧加载器 memory/prompts.ts 已删除。
  const MEMORY_TOOL_REMINDER = renderPrompt("backends/tool-reminder");

  pi.on("before_agent_start", async (event, ctx) => {
    // [subagent-guard] 子代理进程守卫：pi-subagents 启动子代理时设 PI_SUBAGENT_CHILD=1。
    // 子代理 turn 不应吃主代理注入 / 建 _pendingContext / 计 L1 命中（否则执行痕迹污染命中统计）。
    // 与 L0 归档守卫同款判断；此处显式返回原 systemPrompt（pi 要求 before_agent_start 返回对象）。
    if (process.env.PI_SUBAGENT_CHILD === "1") {
      return { systemPrompt: event.systemPrompt };
    }

    // 新 turn 开始：清空 L1 命中计数的 turn 级去重集合
    currentTurnHitSet.clear();

    // ── L1 召回 query 构造（2026-09-02 起条件式，取代无条件拼 10 条历史） ──
    // 默认裸 prompt = 本轮意图信号（腾讯三端同款）。
    // 仅当 contextExpansion=conditional 且 prompt 命中指代消解（含指代词 / 过短）时，
    // 追加最近 1-2 条 role=user 消息（排除 assistant/toolResult，它们含报错堆栈/文件内容，
    // 是向量稀释主因）。always 仅作 A/B 对照组，用于复现旧拼接行为。
    // 注意：最终 queryText 只在 recallL1Records()（下方 L1 召回）使用；
    // maybeRefreshKeywords 两个参数语义不变（话题检测用裸 prompt、关键词刷新用 queryText）。
    let queryText = event.prompt;
    try {
      const recallCfg = loadRecallConfig(
        manager?.getProfileManager().getActiveProfile()?.path ?? ""
      );
      if (recallCfg.contextExpansion === "always") {
        const entries = ctx.sessionManager.getEntries();
        const recentMessages = entries
          .filter((e: any) => e.type === "message")
          .slice(-10)
          .map((e: any) => `[${e.message?.role}] ${extractMessageText(e)}`)
          .filter(Boolean)
          .join("\n");
        if (recentMessages) queryText = `${event.prompt}\n${recentMessages}`;
      } else if (recallCfg.contextExpansion === "conditional" && needsContextExpansion(event.prompt)) {
        // 指代消解：只取最近 2 条 user 消息（slice(-3,-1) 排除本轮 prompt 自身），截断 200 字
        const entries = ctx.sessionManager.getEntries();
        const recentUser = entries
          .filter((e: any) => e.type === "message" && e.message?.role === "user")
          .slice(-3, -1)
          .map((e: any) => extractMessageText(e))
          .filter(Boolean)
          .slice(-2)
          .join("\n")
          .slice(0, 200);
        if (recentUser) {
          queryText = `${event.prompt}\n${recentUser}`;
          console.log(
            `[memory-system][l1-query] contextExpansion 触发: q="${event.prompt.slice(0, 40)}…" + ${recentUser.length}字历史`
          );
        }
      }
      // contextExpansion === "off" → queryText 保持裸 event.prompt
    } catch {
      // sessionManager / config 不可用 → fall back to prompt only
    }

    // 冻结快照（固定不变）→ system prompt 前缀稳定 → 命中 provider 前缀缓存
    const systemContext = manager.buildSystemPrompt();
    if (systemContext) {
      event.systemPrompt += `\n\n${systemContext}`;
    }

    // [RETIRED 2026-09-12] 旧 sub-memory（sub-memories/ jieba 倒排）自动注入已于 2026-08-20 废弃，
    // 其依赖的检索链（searcher / InvertedIndex）已随 LEGACY_RETRIEVAL_RETIREMENT 删除。
    // 恢复旧行为须 git revert 该计划的删码提交，块内引用符号已不存在（原注释块已移除）。
    _pendingContext = { subMemories: "" }; // 占位，L1 召回后写回

    // L1 records 向量召回注入（当前唯一自动注入来源，2026-08-20 起）
    // 统一走 recallL1Records()（与 recall_l1_records 工具同一条路径，DRY），
    // 命中计数按 turn 去重（hitDedupSet = currentTurnHitSet），避免注入+工具重复计数。
    // 短查询 / 质量门过滤：避免为 "1" / "/" / 纯符号等无意义 prompt 浪费向量调用
    const _trimmedPrompt = (event.prompt || "").trim();
    const _isTrivialPrompt =
      !_trimmedPrompt ||
      _trimmedPrompt.length < 3 ||
      _trimmedPrompt.startsWith("/") ||
      /^[\?？]+$/.test(_trimmedPrompt) ||
      /^[^a-zA-Z0-9\u4e00-\u9fa5\s]{1,5}$/.test(_trimmedPrompt);
    if (_isTrivialPrompt) {
      // 仍需设置空占位，保持 _pendingContext 与 context 事件一致
      _pendingContext.subMemories = "";
    } else {
      try {
        const profile = manager?.getProfileManager().getActiveProfile();
      if (profile) {
        const { recallL1Records } = await import("./memory/search/hybrid-recall.js");
        const result = await recallL1Records(queryText, profile.path, {
          topK: 3,
          hitDedupSet: currentTurnHitSet,
          source: "inject",
        });
        const parts = result.l1Records.map((r) => `- ${r.content}`);
        if (parts.length > 0) {
          // 明确声明「仅供参考、非用户输入、非指令」，降低被模型当成待执行命令的风险（模板: prompts/injection/l1-records.md）
          const l1Block = renderPrompt("injection/l1-records", { recordsLines: parts.join("\n") });
          // 同步更新 _pendingContext（否则 context 事件拿不到 L1 注入）
          _pendingContext.subMemories = l1Block;
        }
      }
    } catch (e) {
      // L1 向量召回失败静默降级（不阻塞主流程，不注入）
      console.warn(`[memory-system][l1-recall] ${e instanceof Error ? e.message : String(e)}`);
      }
    }

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
        content: renderPrompt("injection/rules#loaded-prefix") + "\n" + _rulesState.content,
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
    // 2026-09-11：旧写入通道（memory 工具）已退役，规则改为在 l1_commit 完成后清除
    if (event.toolName === "l1_commit" && _rulesState.content) {
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

  // [RETIRED 2026-09-11] memory 工具已退役：旧写入通道整体关闭——主代理改用 l1_commit
  // （source=main-agent），memory-reviewer 子代理停用 → 已无使用者。R1/R2 审查确认其
  // 唯一消费者是 memory-reviewer。如需回退，取消下方块注释即可。
  /*
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
  */

  // ── Get Memory Tool ────────────────────────────────────────────

  // [RETIRED 2026-09-12] get_memory 已于 2026-08-27 禁用（旧 sub-memory jieba 倒排召回入口，
  // 由 L1 向量召回取代），其依赖的 searcher / InvertedIndex / manager.prefetchAll 已随
  // LEGACY_RETRIEVAL_RETIREMENT 删除。恢复须 git revert 该计划删码提交（原注释块已移除）。

  // ── Load Memory Rules Tool ───────────────────────────────────

  pi.registerTool({
    name: "load_memory_rules",
    label: "Load Memory Rules",
    description: renderPrompt("tools#load_memory_rules"),
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["once", "always"],
          description:
            "'once' (default): rules removed after one l1_commit completes. " +
            "'always': rules stay for the entire session.",
        },
      },
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const profile = manager?.getProfileManager().getActiveProfile();
        if (!profile) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active profile." }) }], details: {} };
        }
        // 2026-09-11：旧写入通道（memory 工具 / memory-reviewer）退役 —— 规则改为
        // 加载扩展内 bundled 的 L1 记录契约（不读 profile 散落文件）。
        // 2026-09-12：契约迁入 prompts/registry 单源（模板 prompts/injection/l1-contract.md）。
        const contract = renderPrompt("injection/l1-contract", { mode: loadL1Config(profile.path).mode });
        _rulesState = {
          content: renderPrompt("injection/rules#pi-rules-wrap", { body: contract }),
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
    description: renderPrompt("tools#skill_manage"),
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
    description: renderPrompt("tools#skill_view"),
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
    description: "切换 L1 提取模式：code（work_fact/work_task/work_method/work_artifact）或 chat（persona/episodic/instruction）。用法：/my-memory:l1-mode [code|chat]",
    usage: "用法：/my-memory:l1-mode [code|chat]",
    handler: async (args, ctx) => {
      const profile = manager?.getProfileManager().getActiveProfile();
      if (!profile) {
        ctx.ui.notify("No active profile", "error");
        return;
      }
      const mode = (args || "").trim().toLowerCase();
      if (mode !== "code" && mode !== "chat") {
        ctx.ui.notify(`当前 L1 模式: ${loadL1Config(profile.path).mode}。用法：/my-memory:l1-mode [code|chat]`, "info");
        return;
      }
      saveL1Mode(profile.path, mode as "code" | "chat");
      ctx.ui.notify(`L1 mode switched to: ${mode}`, "info");
    },
  });

  // ── L3 Persona Command ─────────────────────────────────────

  pi.registerCommand("my-memory:l3-trigger", {
    description: "手动触发 L3 Persona 生成（从 L2 场景更新 USER.md）。用法：/my-memory:l3-trigger",
    usage: "用法：/my-memory:l3-trigger",
    handler: async (_args, ctx) => {
      if (!l3Controls) {
        ctx.ui.notify("L3 persona scheduler not initialized", "error");
        return;
      }
      ctx.ui.notify("L3 persona generation queued", "info");
      await l3Controls.triggerManual(ctx);
    },
  });

  // ── /profile Command ────────────────────────────────────────

  pi.registerCommand("my-memory:profile", {
    description: "列出或切换记忆 profile。用法：/my-memory:profile [list|switch <name>]",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0];

      if (sub === "list" || !sub) {
        const profiles = manager.listProfiles();
        const active = manager.activeProfile;
        const lines = profiles.map((p) => p.name === active ? `* ${p.name} (active)` : `  ${p.name}`);
        ctx.ui.notify(`Profiles（当前激活标 *）:\n${lines.join("\n")}`, "info");
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
          // [DISABLED] workflow 系统跟随 profile 重建已禁用（保留代码，恢复时取消注释）
          // workflowController.shutdown();
          // workflowController.init();
          ctx.ui.notify(`Switched to profile: ${parts[1]}`, "info");
        } catch (e) {
          ctx.ui.notify(`Failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      ctx.ui.notify("用法：/my-memory:profile [list|switch <name>]", "info");
    },
  });

  // /l2-trigger：手动入队一次 L2（由 pipeline worker 串行消费）。
  pi.registerCommand("my-memory:l2-trigger", {
    description: "手动入队一次 L2 场景组织。用法：/my-memory:l2-trigger",
    handler: async (_args, ctx) => {
      if (!l2Controls) {
        ctx.ui.notify("L2 调度器未初始化（扩展加载中或未启用）", "error");
        return;
      }
      await l2Controls.triggerManual(ctx);
    },
  });

  // /l1-trigger：手动触发一次 L1 提取（绕过 L1_INTERVAL 攒轮数）——供调试/验证使用。
  // 需 setupL1Extractor 已初始化，否则提示重启 pi 加载新扩展。
  pi.registerCommand("my-memory:l1-trigger", {
    description: "手动入队一次 L1 提取（绕过 L1_INTERVAL 攒轮数）。用法：/my-memory:l1-trigger",
    handler: async (_args, ctx) => {
      if (!l1Controls) {
        ctx.ui.notify("L1 调度器未初始化（扩展加载中或未启用）", "error");
        return;
      }
      l1Controls.triggerManual(ctx);
    },
  });

  // ── /vectorize-list Command ─────────────────────────────────
  // 查询 L1 records 向量化状态：哪些已向量化、哪些未向量化。
  // 从 vector store 的 l1_vector_index 辅助映射表读已向量化清单，与 records/ JSONL 对比。
  pi.registerCommand("my-memory:l1:embedding:list", {
    description: "查询 L1 records 向量化状态。用法：/my-memory:l1:embedding:list [limit=10]",
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
  // 前置条件：vectorization.json 中 enabled=true + embedding 配置可读。
  // 注意：需重启 pi 才能使用本命令（memory-system.ts 改动需重启加载）。
  pi.registerCommand("my-memory:l1:embedding:backfill", {
    description: "批量将未向量化的 L1 records 嵌入向量并入库。用法：/my-memory:l1:embedding:backfill",
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
            `❌ 回填前置条件不满足：检查 embedding 配置 + vectorization.json（enabled=true）。未向量化 ${status.unVectorizedCount} 条`,
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
    description: "清空 vector store 并重新嵌入所有 L1 records（解决旧嵌入污染）。用法：/my-memory:l1:embedding:rebuild",
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

  // ── /my-memory:l1:quality Command ───────────────────────────────
  pi.registerCommand("my-memory:l1:fix", {
    description: "手工修正/作废一条 L1 记忆。用法：/my-memory:l1:fix <id> --action rewrite|tombstone --content \"新内容\" --evidence \"证据\" [--force] [--priority 80] [--reason 理由]",
    handler: async (args, ctx) => {
      try {
        const profilePath = manager?.getProfileManager()?.getActiveProfile()?.path;
        if (!profilePath) { ctx.ui.notify("无活跃 profile", "error"); return; }
        const argv = (args || "").trim().split(/\s+/).filter(Boolean);
        const id = argv[0] || "";
        const rest = argv.slice(1);
        const get = (k: string) => {
          const i = rest.indexOf(k);
          return i >= 0 ? rest.slice(i + 1).join(" ") : undefined;
        };
        if (!id) { ctx.ui.notify("用法：/my-memory:l1:fix <id> --action ... --content ... --evidence ...", "error"); return; }
        const action = (get("--action") || "").trim() as any;
        const content = get("--content");
        const evidence = get("--evidence");
        const reason = get("--reason");
        const pv = get("--priority");
        const force = rest.includes("--force");
        const { runFix } = await import("./memory/l1/fix-tool.js");
        const params: any = { recordId: id, action, newContent: content, evidence, reason };
        if (pv !== undefined) params.priority = Number(pv);
        const text = await runFix(params, profilePath, { force });
        const parsed = JSON.parse(text);
        ctx.ui.notify(parsed.success ? "L1 修正成功" : `L1 修正被拒：${parsed.error}`, parsed.success ? "info" : "error");
        ctx.console?.log?.(text);
        return text;
      } catch (err) {
        ctx.ui.notify(`l1:fix 异常：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
  pi.registerCommand("my-memory:l1:health", {
    description: "L1 库健康指标（超长/test 残留/孤儿 stats/自造 id/畸形行/错误串）",
    handler: async (_args, ctx) => {
      try {
        const profilePath = manager?.getProfileManager()?.getActiveProfile()?.path;
        if (!profilePath) { ctx.ui.notify("无活跃 profile", "error"); return; }
        const { execFileSync } = await import("node:child_process");
        const { join, dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const toolDir = join(dirname(fileURLToPath(import.meta.url)), "scripts", "l1-admin");
        const stdout = execFileSync(process.execPath, ["health.mjs", "--profile", profilePath], { cwd: toolDir, encoding: "utf8", timeout: 60000 });
        ctx.console?.log?.(stdout);
        return stdout;
      } catch (err) {
        ctx.ui.notify(`l1:health 异常：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
  pi.registerCommand("my-memory:l1:quality", {
    description: "按质量分排行展示 L1 原子记忆（effective*decay*(1-min(invalid/hits,0.8))，days 按活跃会话日计）。用法：/my-memory:l1:quality [top=20]",
    handler: async (_args, ctx) => {
      const profile = manager.getProfileManager().getActiveProfile();
      if (!profile) { ctx.ui.notify("No active profile", "error"); return; }
      const top = Math.min(Math.max(parseInt((_args||"20").trim())||20, 1), 100);
      try {
        const { getQualityRanked } = await import("./memory/l1/quality.js");
        const ranked = await getQualityRanked(profile.path, top);
        if (ranked.length===0) { ctx.ui.notify("暂无 L1 records", "info"); return; }
        const clockNote = ranked.some(r=>r.activeDayClock) ? "days=活跃会话日" : "days=日历天(活跃日数据不可得)";
        const lines=[`L1 质量排行（quality = effective * exp(-days/14) * (1-min(invalid/hits,0.8)) | 新记录 max(priority/100,0.3) | ${clockNote}）:`, "rank | q | eff | hits/inv | decay | days | tag | pri | id | content(60)"];
        ranked.forEach((r,i)=>{
          const q=r.quality.toFixed(2).padStart(5), eff=String(r.effective).padStart(2), hi=`${r.hits}/${r.invalid}`.padStart(5);
          const dc=r.decay.toFixed(2), dy=r.days.toFixed(1).padStart(4), tag=r.tag.padEnd(4), pri=String(r.pri??r.priority??"?").padStart(2);
          const ct=(r.content||"").slice(0,60).replace(/\n/g," ");
          lines.push(`[${String(i+1).padStart(2)}] q=${q} eff=${eff} hits=${hi} decay=${dc} days=${dy} tag=${tag} pri=${pri} id=${r.id} | ${ct}`);
        });
        ctx.ui.notify(lines.join("\n"), "info");
      } catch(e){ ctx.ui.notify(`quality 失败: ${e instanceof Error?e.message:String(e)}`, "error"); }
    },
  });

  pi.registerCommand("my-memory:l1:stats", {
    description: "汇总 L1 质量分布与冷/噪清单。用法：/my-memory:l1:stats",
    handler: async (_args, ctx) => {
      const profile = manager.getProfileManager().getActiveProfile();
      if (!profile) { ctx.ui.notify("No active profile", "error"); return; }
      try {
        const { getQualityStats } = await import("./memory/l1/quality.js");
        const s=await getQualityStats(profile.path);
        const unit = s.clock.activeDayClock ? "活跃日" : "日历天";
        const lines=[`L1 质量汇总: 总数=${s.total} | 分布 热${s.dist["热"]??0}/温${s.dist["温"]??0}/冷${s.dist["冷"]??0}/新${s.dist["新"]??0}/待观察${s.dist["待观察"]??0}/噪${s.dist["噪"]??0}`,
                     `直方图 q 0-2:${s.histogram["0-2"]} 2-4:${s.histogram["2-4"]} 4-6:${s.histogram["4-6"]} 6+:${s.histogram["6+"]}`,
                     s.clock.activeDayClock
                       ? `时钟: 活跃会话日 ${s.clock.activeDays} 个 / 跨度 ${s.clock.spanDays.toFixed(0)} 日历天（停工期间 days 不增长，单位=${unit}）`
                       : `时钟: 退化为日历天（未找到 l0-conversations 分片）`];
        if(s.cold.length>0){ lines.push("", `冷清单 (>14${unit}0命中) ${s.cold.length}条 前5:`); s.cold.slice(0,5).forEach(r=> lines.push(` - q=${r.quality.toFixed(2)} days=${r.days.toFixed(1)} pri=${r.priority} id=${r.id} | ${r.content.slice(0,60)}`)); }
        else lines.push("", `冷清单: 0（>14${unit}0命中暂无，7-14${unit}为待观察）`);
        if(s.noisy.length>0){ lines.push("", `噪清单 (失效率>50%) ${s.noisy.length}条 前5:`); s.noisy.slice(0,5).forEach(r=> lines.push(` - q=${r.quality.toFixed(2)} eff=${r.effective} hits=${r.hits}/${r.invalid} id=${r.id} | ${r.content.slice(0,60)}`)); }
        else lines.push("", "噪清单: 0");
        lines.push("", `淘汰候选 ${s.prune.length} 条（已排除 priority>=${s.protectedPriority}(P75动态) / work_method / 有效命中过的记忆；quality 低只代表热度低，不代表可删）`);
        s.prune.slice(0,5).forEach(r=> lines.push(` - q=${r.quality.toFixed(2)} days=${r.days.toFixed(1)} pri=${r.priority} type=${r.type} id=${r.id} | ${r.content.slice(0,50)}`));
        lines.push("", `最早记录距今 ${s.ranked.length? Math.max(...s.ranked.map(r=>r.days)).toFixed(1):0} ${unit}，${s.total>0 && s.cold.length===0 ? `冷标签需等记录>14${unit}后可观测` : ""}`);
        ctx.ui.notify(lines.join("\n"), "info");
      } catch(e){ ctx.ui.notify(`stats 失败: ${e instanceof Error?e.message:String(e)}`, "error"); }
    },
  });

  // [RETIRED 2026-09-12] /my-memory:rebuild-index 已删除：倒排索引随旧检索链退役，
        // 索引不再被任何活跃路径读取/维护（见 plan/memory-system/LEGACY_RETRIEVAL_RETIREMENT/）。
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

function getAgentDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || process.env.HOMEDRIVE + process.env.HOMEPATH || "";
  return process.env.PI_CODING_AGENT_DIR || `${home}/.pi/agent`;
}
