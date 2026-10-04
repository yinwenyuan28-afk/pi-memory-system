import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MemoryManager,
} from "./memory/index.ts";
import {
  SkillManager,
  setBundledSkillsPaths,
} from "./skill/index.ts";
import { setupSkillReviewer, SKILL_REVIEW_INTERVAL } from "./skill/reviewer.ts";
import { archiveSessionIncrement } from "./memory/l0/index.ts";
import { archiveSkillFeedIncrement } from "./skill/feed-cleaner.ts";
import { loadL1Config, setupL1Extractor } from "./memory/l1/index.ts";
// saveL1Mode 的真实定义在 config.ts（l1/index.ts 不转出它）——2026-09-20 类型检查发现：
// 旧写法从 l1/index.ts 导入得到 undefined，/my-memory:l1-mode 一调用就 TypeError。
import { L1_INTERVAL, listL0Files, loadL1Cursor, saveL1Mode } from "./memory/l1/config.ts";
import { registerL1CommitTool } from "./memory/l1/commit-tool.ts";
import { registerListL1ScenesTool } from "./memory/l1/scene-tool.ts";
import { setupJudgSessionProject } from "./util/judg-session-project/setup.ts";
import { registerL1ProjectGetTool } from "./util/judg-session-project/tool.ts";
import { readSessionJudg } from "./util/judg-session-project/index.ts";
import { registerReadL0IncrementTool, readL0Increment } from "./memory/l1/read-tool.ts";
import { countNewRecords, countSceneBlocks, loadL2Config, loadL2Cursor } from "./memory/l2/config.ts";
import { acquireRunLock, isProcessAlive, runLockBusyMessage } from "./memory/pipeline/run-lock.ts";
import { archiveSceneBlock, listArchivedBlocks, reconcileArchive, restoreSceneBlock } from "./memory/l2/archive.ts";
import { registerReadL1IncrementTool } from "./memory/l2/read-tool.ts";
import { registerReadSceneBlocksTool } from "./memory/l2/scene-read-tool.ts";
import { registerL2ArchiveGuideTool } from "./memory/l2/archive-tool.ts";
import { registerReadSkillFeedIncrementTool } from "./skill/feed-reader.ts";
import { setupL2Organizer } from "./memory/l2/index.ts";
import { setupPipelineWorker, type PipelineExecutors, type PipelineWorker } from "./memory/pipeline/worker.ts";
import { getPipelineJobsDB, type PipelineJobType } from "./memory/pipeline/jobs-db.ts";
import { formatPipelineStatus, type PipelineStatusReporter } from "./memory/pipeline/status.ts";
import { clearSubagentRun, listSubagentRuns, readSubagentRun } from "./memory/pipeline/subagent-runs.ts";
import { stopSubagent } from "./memory/pipeline/subagent-kill.ts";
import { loadSubagentTimeouts } from "./memory/pipeline/timeout-config.ts";
import { resolveAgentDir } from "./util/agent-dir.ts";
import { holdUntilFrom, loadFailureState, saveFailureState } from "./memory/failure-state.ts";
import { registerL2CommitTool, repairSceneMembers, syncSceneIndex } from "./memory/l2/commit-tool.ts";
import { setupL3Persona } from "./memory/l3/index.ts";
import { registerL3CommitTool } from "./memory/l3/commit-tool.ts";
import { registerL3EditTool } from "./memory/l3/edit-tool.ts";
import { registerEmbedAndSearchTool } from "./memory/search/embedding/tool.ts";
import { registerRecallL1RecordsTool } from "./memory/search/recall-l1-records-tool.ts";
import { registerClearInvalidL1RecordsTool } from "./memory/search/clear-invalid-l1-records-tool.ts";
import { registerFixTool } from "./memory/l1/fix-tool.ts";
import { loadRecallConfig } from "./memory/search/recall-config.ts";
import { AUTO_INJECT_TOP_K } from "./config/thresholds.ts";
import { createRecallScheduler } from "./memory/search/recall-scheduler.ts";
import { handleSkillManageTool } from "./skill/skill-tool.ts";
import { handleSkillViewTool } from "./skill/skill-view-tool.ts";
import { render as renderPrompt, checkPromptAssets } from "./prompts/registry.ts";
import { promptVarsFor } from "./prompts/tool-vars.ts";
import {
  drainNoticeCards,
  logEvent,
  notice,
  noticeCard,
  noticeReport,
  initNotice,
  resetNoticeDedup,
  setNoticeProfileResolver,
} from "./util/notice.ts";
import { buildQueryText } from "./util/query-noise.ts";
import { listBundledAgents, resolvePiCommand, BUNDLED_AGENTS_DIR } from "./util/spawn.ts";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** 召回调度器载荷（2026-09-15，L1_RECALL_ASYNC）：把「查什么/怎么算」与「何时注入」解耦。 */
interface RecallPayload {
  queryText: string;
  profilePath: string;
  topK: number;
  source: "inject" | "tool";
  /** 是否在 recallL1Records 内计数（自动注入传 false —— 改由 context 真入列时计）。 */
  countHits?: boolean;
  /** turn 级命中去重集合（工具路径需要；自动注入路径的计数在 context 处另做）。 */
  hitDedupSet?: Set<string>;
  /**
   * 当前会话判定的项目路径（2026-10-02 项目加权排序用）。
   * **空串 / 缺省 = 无判定 ⇒ 系数全 1.0，完全退回项目加权上线前的行为。**
   * 只有判定表 `flag===true` 时才填（`flag=false` 是弃权，不是「不属于任何项目」）。
   */
  sessionProject?: string;
}

/** L1 召回候选（结构同 hybrid-recall 的返回元素；此处结构化声明避免循环依赖）。 */
interface L1RecordCandidate {
  recordId: string;
  score: number;
  content: string;
  type?: string;
  priority?: number;
  scene_name?: string;
  createdAt?: string;
}

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
  // ── 子代理派发：自建 spawn（2026-10-01）─────────────────────────────────────
  // L1/L2/L3/skill-review/memory-review 五条链的后台子代理，由本扩展**自己 spawn
  // 一个 pi 子进程**执行（util/spawn.ts），**对 pi-subagents 零依赖**。
  //
  // 为什么不用 pi-subagents（两条路都试过、都堵死）：
  //   1. 读 globalThis.__piSubagentExecutor —— 那是本机给 pi-subagents 源码打的私有
  //      补丁，pi 升级即失效；且绑死 pi-subagents ≤0.35.x（0.74 起只发编译后的 .js，
  //      补丁脚本的 .ts 锚点全部消失）。
  //   2. `subagents:rpc:v1` 事件总线（上游官方集成面）—— 桥接层硬编码
  //      `getContext: () => state.lastUiContext`，**不接受调用方传入的 ctx**；而 pi 在
  //      session 替换/reload 时会 invalidate() 该缓存 ⇒ 派发必然失败
  //      （实测 0.35.1 与 0.74.0 皆然，报 `This extension ctx is stale…`）。
  //
  // 派发能力在激活时无需任何注册动作（spawn 是惰性的），但这里先做一次**自检**：
  // 确认 agents/ 定义齐全、pi 入口可解析。缺任一项 → 启动即告警，而不是等第一次
  // 触发 L1 才发现（那时表现为「L1 已入队但没有子代理在跑」）。

  const agentDir = getAgentDir();
  const manager = new MemoryManager(agentDir);
  let skillManager: SkillManager | undefined;
  let profileSkillsPath: string | undefined;
  let loadedSkillsThisSession: Set<string> = new Set();
  // 当前 session id（judg-session-project 等消费者用，session_start 写入）
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
  //
  // 2026-09-15（L1_RECALL_ASYNC）：块可能**就绪晚于本轮首次 LLM 调用**（async 模式，或 blocking
  // 超时后的后台补注入）。`l1RecordIds` 与 `hitsCounted` 用于把命中计数推迟到「块真正入列」那一次。
  let _pendingContext: { subMemories: string; l1RecordIds: string[]; hitsCounted: boolean } | null = null;

  // L1 命中计数 turn 级去重集合：before_agent_start 每 turn 开头清空。
  // 同一 turn 内，自动注入（top-3）与 recall_l1_records 工具（top-5）召回同一条记忆时只计 1 次命中。
  // 工具与注入共用同一引用（都在本进程闭包内）。retry/compaction/followUp 不重触发 before_agent_start，
  // Set 保留 → 同一 turn 的续跑仍去重，语义正确。
  const currentTurnHitSet = new Set<string>();

  // 轮次编号：每 turn +1，用于作废「上一轮还在飞」的召回结果（异步注入下必需）。
  let turnToken = 0;

  // 召回调度闸门（会话级串行；闸门释放绑定底层 settle）。
  // 结果类型 = L1 候选数组（两条路径共用）：自动注入渲染成块、工具路径直接回传 candidates。
  let recallScheduler: ReturnType<typeof createRecallScheduler<RecallPayload, L1RecordCandidate[]>>;
  {
    const cfgForScheduler = () =>
      loadRecallConfig(manager?.getProfileManager().getActiveProfile()?.path ?? "");
    recallScheduler = createRecallScheduler<RecallPayload, L1RecordCandidate[]>({
      maxHoldMs: cfgForScheduler().maxHoldMs,
      log: (m) => logEvent("recall", `[recall-scheduler]${m}`),
      run: async (payload, signal) => {
        const { recallL1Records } = await import("./memory/search/hybrid-recall.ts");
        const r = await recallL1Records(payload.queryText, payload.profilePath, {
          topK: payload.topK,
          source: payload.source,
          hitDedupSet: payload.hitDedupSet,
          countHits: payload.countHits,
          signal,
          // 项目加权排序（2026-10-02）：payload 里没有 project ⇒ 系数全 1.0，退回原行为
          sessionProject: payload.sessionProject,
        });
        return r.l1Records.length > 0 ? r.l1Records : null;
      },
    });
  }

  // 所有状态共用 Pi 的 `memory` 项；用单一渲染器合并 L1/L2/L3 与 Skill，避免互相覆盖。
  let getSkillStatus: () => string = () => `${SKILL_REVIEW_INTERVAL}t`;
  let statusCtx: ExtensionContext | undefined;
  let activePipelineStatus: { layer: PipelineJobType; detail: string } | undefined;
  function refreshStatus(ctx = statusCtx): void {
    if (!ctx) return;
    const l1 = l1Controls?.getTurnStatus() ?? { remaining: L1_INTERVAL, paused: false };
    ctx.ui.setStatus("memory", formatPipelineStatus(l1, activePipelineStatus, getSkillStatus()));
  }
  const pipelineStatus: PipelineStatusReporter = {
    set: (ctx, layer, detail, scope) => {
      if (scope && !scope.isCurrent()) return;
      activePipelineStatus = { layer, detail };
      refreshStatus(ctx);
    },
    clear: (ctx, layer, scope) => {
      if (scope && !scope.isCurrent()) return;
      if (activePipelineStatus?.layer === layer) activePipelineStatus = undefined;
      refreshStatus(ctx);
    },
    refresh: (ctx) => refreshStatus(ctx),
  };
  const refreshSkillStatus = () => refreshStatus();



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

  // 会话级项目归属判定（单次注册）：挂点必须在 :382 的 PI_SUBAGENT_CHILD 早退**之后**调用
  let judgSessionProjectInitialized = false;

  // L2 场景组织调度器（单次注册）：由 pipeline-jobs 队列消费，不再 watchFile
  let l2Initialized = false;
  let l2Controls: ReturnType<typeof setupL2Organizer> | undefined;

  let pipelineInitialized = false;
  let pipelineWorker: PipelineWorker | undefined;
  let pipelineExecutors: PipelineExecutors | undefined;

  // L3 persona 调度器（单次注册）：由 pipeline 队列串行消费（`type='l3'`）——
  // 本模块只做五级门控 + 入队，spawn 在 worker 里（2026-09-19 并入，取代 l3/run.lock 自单飞）。
  let l3Initialized = false;
  let l3Controls: ReturnType<typeof setupL3Persona> | undefined;

  // ── Tool schema normalization（修复严格 OpenAI 兼容 provider 报错）────────────
  // pi 在转发工具给 OpenAI 兼容接口时，把 tool.parameters 原样当作函数 JSON Schema
  // 发出（openai-completions.ts: `parameters: tool.parameters`）。历史上有两类写法会让
  // 严格 provider（DeepSeek / opencode(Console Go) 等）直接 400：
  //
  //   A. 扁平 map：{ paramName: { type, description } }，缺顶层 type:"object"
  //      → "schema must be a JSON Schema of 'type: "object"', got 'type: null'"
  //   B. 属性子 schema 里写 `required: true`
  //      → 2026-09-16 实测："Invalid schema for function 'l3_edit': true is not of type \"array\""
  //        （`required` 的合法形态只有顶层的字符串数组；写在属性里等于发了个非法关键字。
  //          这类错误**炸在子代理侧**、主代理看不到、只看代码也看不出，必须在此兜住）
  //
  // 这里把 registerTool 包一层，把 A 升级成正规 schema、把 B 的 required 归并到顶层数组并留 warn。
  // 已经是正规 JSON Schema 或 TypeBox schema（含 TypeBox.Kind）的对象不受影响。
  const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
  const _origRegisterTool = pi.registerTool.bind(pi);
  (pi as { registerTool: (tool: any) => void }).registerTool = (tool: any) => {
    const params = tool?.parameters;
    const isTypeBox =
      params && typeof params === "object" && Object.getOwnPropertySymbols(params).includes(TYPEBOX_KIND);
    const isFlatMap =
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      !params.type &&
      !isTypeBox;
    if (isFlatMap) {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [key, spec] of Object.entries(params)) {
        const { required: inlineRequired, ...clean } = (spec ?? {}) as Record<string, any>;
        properties[key] = clean;
        if (inlineRequired === true) required.push(key);
      }
      tool.parameters = { type: "object", properties, required };
    }

    // B 类修复：属性子 schema 上的 `required`（非数组）一律上提到顶层 required 数组。
    // 只处理 depth-1（顶层 properties 的直接属性）—— 嵌套对象/数组项里的 `required: [...]`
    // 是合法的（如 l2_commit 的 sceneWrites.items.required），不能碰。
    {
      const p = tool?.parameters;
      const props = p && typeof p === "object" && !isTypeBox ? (p as any).properties : undefined;
      if (props && typeof props === "object" && !Array.isArray(props)) {
        const demoted: string[] = [];
        for (const [key, spec] of Object.entries(props as Record<string, any>)) {
          if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
          if (!("required" in spec) || Array.isArray((spec as any).required)) continue;
          const inline = (spec as any).required;
          delete (spec as any).required;
          if (inline === true) {
            const req = Array.isArray((p as any).required) ? (p as any).required : [];
            if (!req.includes(key)) req.push(key);
            (p as any).required = req;
            demoted.push(key);
          }
        }
        if (demoted.length > 0) {
          console.warn(
            `[memory-system][tool-schema] ${tool?.name}: 把属性上的 required:true 上提到顶层 required 数组（${demoted.join(", ")}）——` +
              `属性子 schema 里写 required 会被严格 provider 拒收（400: true is not of type "array"），请改源码`,
          );
        }
      }
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

  // 通知模块的 profile 解析器：在**模块顶层**注入（不能放到 session_start 之后——
  // 子代理进程在 session_start 里早退，那样子代理的 noticeCard 会因拿不到 profile 而丢通知）。
  setNoticeProfileResolver(() => manager?.getProfileManager().getActiveProfile()?.path);
  // 卡片渲染器（聊天区卡片 = pi.appendEntry + entry renderer；落 session、不进 LLM 上下文）
  initNotice(pi);

  // l1_commit 工具：l1-extractor 子代理的写盘桥接（工具调用不受 Plan Enforcer 拦截）。
  // L2 由 commit 进程直接写入 pipeline/jobs.sqlite；此处回调只给 L3 计数。
  registerL1CommitTool(
    pi,
    () => manager?.getProfileManager().getActiveProfile()?.path,
    (written) => {
      // l2Controls?.onL1Committed(); // 已废弃：回调闭包在子代理进程 = undefined，静默丢弃
      l3Controls?.onL1Committed(written);
    },
  );

  // list_l1_scenes 工具：主代理按需查场景池——记录前挑 scene_id，替代"猜场景"
  //（清单不进系统提示是出于 prefix cache；按需工具不吃这个代价，见 scene-tool.ts 头注释）。
  registerListL1ScenesTool(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
  // l1_project_get 工具：l1-extractor 子代理读「本会话属于哪个项目」，用来逐条判断 metadata.scope。
  // ⚠ **必须在这里（模块顶层、session_start 之前）注册**，与上面几个工具同款：
  //   注册点若落在 session_start 回调内的 `PI_SUBAGENT_CHILD` 早退之后，子代理进程就**根本没有**
  //   这个工具 —— 而 `agents/l1-extractor.md` 的 `tools:` 行只是软约束，调不到也不报错，
  //   整条 scope 设计会静默落空。同 read_l1_increment 的 2026-09-11 修复。
  registerL1ProjectGetTool(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
  // l2_commit 工具：l2-scene-organizer 子代理的场景写盘桥接。
  // personaSignal 不再走回调 —— 回调只在子代理进程求值，那里 l3Controls 恒为 undefined。
  // 改为工具内直接写 l3/pending-trigger.json，主进程 agent_settled 消费（见 memory/l3/signal.ts）。
  registerL2CommitTool(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
  // read_l1_increment 工具：l2-scene-organizer 子代理按游标取 L1 增量
  // 【2026-09-11 紧急修复】注册必须在这里（模块顶层、session_start 之前）：
  // 原注册点 setupL2Organizer 在 session_start 回调内、位于 PI_SUBAGENT_CHILD return 之后，
  // 子代理进程加载扩展时永远执行不到 → 工具从未在子代理注册（L2 管线死线，实测触发）。
  registerReadL1IncrementTool(pi, () => manager?.getProfileManager()?.getActiveProfile()?.path);
  // read_scene_blocks 工具：l2-scene-organizer 子代理**一次**读完候选场景块（T2，2026-09-21）
  // 注册点必须在这里（模块顶层）——子代理进程不会执行 session_start 之后的代码（read_l1_increment 踩过这个死线）
  registerReadSceneBlocksTool(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
  // l2_archive_guide 工具：归档规则 + 事实清单**按需**拉取（2026-09-27）——平时零注入，
  // 子代理判断"满了、要腾名额"时才调它。注册点同样必须在这里（模块顶层），理由同上。
  registerL2ArchiveGuideTool(pi, () => manager?.getProfileManager().getActiveProfile()?.path);
  // l3_edit 工具：l3-persona-generator 子代理的**条目级**写入（用户裁定：一次调用只动一条记忆）
  // 落盘目标是 USER-temp.md 而非 live USER.md（2026-09-28 用户裁定，见 memory/l3/user-file.ts），
  // 所以这个 onChanged（刷新注入快照）实际是 no-op —— 注入侧读的一直是 USER.md。
  registerL3EditTool(
    pi,
    () => manager?.getProfileManager().getActiveProfile()?.path,
    () => manager?.refreshUserSnapshot(),
  );
  // l3_commit 工具：l3-persona-generator 子代理的收尾动作（推进游标 + 刷新注入快照）
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
  registerRecallL1RecordsTool(pi, currentTurnHitSet, recallScheduler);
  // clear_invalid_l1_records 工具：agent 主动标记无效召回（写入 invalid_hits 反馈信号，召回闭环）
  registerClearInvalidL1RecordsTool(pi);
  // l1_fix 工具：agent 自发纠错（护栏 + exec l1-admin；对应命令 /my-memory:l1:fix）——2026-09-11 A 档
  registerFixTool(pi, () => manager?.getProfileManager()?.getActiveProfile()?.path);

  pi.on("session_start", async (_event, ctx) => {
    statusCtx = ctx;
    manager.initialize();
    const profile = manager.getProfileManager().getActiveProfile();
    // 设置主代理进程的 profile 环境变量（供 recall_l1_records / embed_and_search 等工具用）
    // 子代理进程由 util/spawn.ts 注入该变量，主代理进程需要在此显式设置
    if (profile) {
      process.env.PI_PROFILE_PATH = profile.path;
    }
    sessionId = ctx.sessionManager.getSessionId();

    // 子进程只需要模块顶层已注册的 commit/read 工具 + PI_PROFILE_PATH。
    // 不得 recoverStuckRunning / setupPipelineWorker / L1·L2 调度：否则会把父进程
    // 刚 claim 的 running l1 当成「崩溃残留」标 failed（2026-08-27 双 L1 假失败）。
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    // 提示词资产自检（PROMPT_REGISTRY）：md 被误删/改名/移走属仓库级损坏，
    // 离线逐字节校验见 scripts/verify-prompt-contracts.mjs；此处为每次启动的廉价兜底。
    // 2026-09-19 改道：从 console.warn（用户看不见）改为**聊天区卡片**——资产缺失属于“用户需要知道”的仓库级问题。
    const promptProblems = checkPromptAssets();
    if (promptProblems.length > 0) {
      noticeCard({
        level: "warning",
        title: `提示词模板缺失/损坏（${promptProblems.length} 项）`,
        lines: promptProblems.slice(0, 6),
        detail: promptProblems.join("\n"),
      });
    }

    // 子代理派发通道自检（独立发布整改 P0-2/P0-3）：
    // 自建 spawn 的两项前置：① agents/ 目录下的子代理定义齐全 ② pi 入口可解析。
    // 缺任一项 ⇒ L1/L2/L3/review/skill-review 五条链派发不出子代理。正常时不打扰，
    // 只在真出问题时发卡片——与上面提示词资产自检同一处理原则。
    const bundledAgentNames = listBundledAgents();
    const piCmd = resolvePiCommand();
    logEvent(
      "store",
      `[self-spawn] 自带子代理定义 ${bundledAgentNames.length} 个（${BUNDLED_AGENTS_DIR}）；` +
        `pi 入口 = ${piCmd.prefixArgs.length ? `${piCmd.command} ${piCmd.prefixArgs.join(" ")}` : piCmd.command}`,
      profile?.path,
    );
    const REQUIRED_AGENTS = ["l1-extractor", "l2-scene-organizer", "l3-persona-generator", "skill-reviewer"];
    const missingAgents = REQUIRED_AGENTS.filter((a) => !bundledAgentNames.includes(a));
    if (missingAgents.length > 0 || bundledAgentNames.length === 0) {
      const problems = [
        `子代理定义缺失：${BUNDLED_AGENTS_DIR} 下缺少 ${missingAgents.join(", ") || "全部定义"}`,
        "子代理定义需随插件分发，不能只存在于 ~/.pi/agent/agents/（发布包应含 agents/*.md 共 6 个）",
      ];
      noticeCard({
        level: "warning",
        title: "子代理派发不可用，L1/L2/L3 记忆提取将无法运行",
        lines: problems,
        detail: problems.join("\n") + "\n\n自建 spawn 只需要 agents/*.md 与 pi 入口，不依赖任何其它扩展。",
        dedupKey: "subagent-defs-missing",
      });
    }

    // 新会话：重置一次性告警去重（同一会话只报一次的那些，如价值校验 fail-open）
    resetNoticeDedup();

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
      // 每 20 轮自动审查、memory 工具调用随之关闭。状态栏 Memory 项改为显示 L1 触发计数。
      // memory-organizer 无代码调度入口，一并作废（见 agents/*.md 顶部停用横幅）。
      getSkillStatus = setupSkillReviewer(pi, () => manager?.getProfileManager().getActiveProfile()?.path, refreshSkillStatus);
      reviewersInitialized = true;
    }

    const getProfilePath = () => manager?.getProfileManager().getActiveProfile()?.path;

    // ── 召回预热（2026-09-15，L1_RECALL_ASYNC） ──
    // 向量库与 embedding 客户端均为懒加载单例，首个 turn 才初始化 → 把这段开销前移到会话启动。
    // 只开库/建客户端，**不发 embedding 请求**（零 API 成本）；失败静默，后续按懒加载路径工作。
    try {
      if (profile && loadRecallConfig(profile.path).prewarm) {
        void (async () => {
          try {
            const { getVectorStore } = await import("./memory/search/vector-store/store.ts");
            const { getEmbeddingService } = await import("./memory/search/embedding/service.ts");
            await getVectorStore(profile.path);
            await getEmbeddingService(profile.path);
          } catch (e) {
            logEvent("store", `预热失败（不影响后续懒加载）: ${e instanceof Error ? e.message : String(e)}`, profile.path);
          }
        })();
      }
    } catch {
      // 配置不可读 → 跳过预热
    }

    // 流水线 worker（单次注册）：串行消费 pipeline/jobs.sqlite
    if (!pipelineInitialized) {
      pipelineWorker = setupPipelineWorker(pi, getProfilePath, () => pipelineExecutors);
      pipelineInitialized = true;
    }
    if (profile) {
      try {
        const n = pipelineWorker?.ownsJob(profile.path) ? 0 : getPipelineJobsDB(profile.path).recoverStuckRunning();
        if (n > 0) logEvent("pipeline", `recovered ${n} leftover running job(s)`, profile.path);
      } catch (err) {
        logEvent("pipeline", `recover failed: ${err instanceof Error ? err.message : String(err)}`, profile.path);
      }

      // 残留子代理回收（自建 spawn，2026-10-01）：主进程重启后内存态全丢，但运行记录
      // 还在。若记录里的 pid 还活着，说明上一任主进程崩溃/被杀时留下了孤儿子进程 ——
      // 它们仍持有写工具，会和这一任抢着写同一层。逐个停掉（复用停止序列的杀进程树
      // 与杀后修复），然后清记录。
      try {
        const orphans = listSubagentRuns(profile.path);
        for (const rec of orphans) {
          if (pipelineWorker?.ownsJob(profile.path, rec.jobId)) continue;
          if (isProcessAlive(rec.pid)) {
            const out = await stopSubagent({
              profilePath: profile.path,
              layer: rec.layer,
              jobId: rec.jobId,
              reason: "主进程重启后回收残留子代理",
              skipGrace: true,
            });
            logEvent("pipeline", `回收残留子代理 ${rec.layer} job ${rec.jobId} pid=${rec.pid}：${out.note}`, profile.path);
          }
          clearSubagentRun(profile.path, rec.layer, rec.jobId);
        }
        if (orphans.length > 0) {
          logEvent("pipeline", `清理 ${orphans.length} 条子代理运行记录`, profile.path);
        }
      } catch (err) {
        logEvent("pipeline", `残留子代理回收失败: ${err instanceof Error ? err.message : String(err)}`, profile.path);
      }
    }

    // L2 先于 L1：executors 需要两边的 executeJob
    if (!l2Initialized && pipelineWorker) {
      l2Controls = setupL2Organizer(pi, getProfilePath, pipelineWorker, pipelineStatus);
      l2Initialized = true;
    }

    if (!l1Initialized && pipelineWorker) {
      l1Controls = setupL1Extractor(pi, getProfilePath, pipelineWorker, pipelineStatus);
      l1Initialized = true;
    }

    // 会话级项目归属判定（2026-09-30）：每轮抽候选 + 必要时问一次 LLM，结果写
    // memoryDB/state/judg-session-project.json，供 l1_commit 决定记忆的 cwd。
    //
    // ⚠ **必须留在 :382 的 `PI_SUBAGENT_CHILD` 早退之后**（与上面 setupL1Extractor 同一段）。
    //   放到守卫之前 = 子代理每轮都跑判定：sessionKey 恒为 "session"、每轮白发一次 LLM 请求、
    //   还会往子代理的 profile 里写条目。setup.ts 里另有一道同样的早退作为第二道防线。
    if (!judgSessionProjectInitialized) {
      setupJudgSessionProject(pi, getProfilePath);
      judgSessionProjectInitialized = true;
    }

    // L3 persona 调度器（单次注册）：只做触发判定 + 入队，spawn 归串行执行器（2026-09-19 并入）
    if (!l3Initialized && pipelineWorker) {
      l3Controls = setupL3Persona(
        pi,
        () => manager?.getProfileManager().getActiveProfile()?.path,
        pipelineWorker,
        pipelineStatus,
      );
      l3Initialized = true;
    }

    if (l1Controls && l2Controls && l3Controls) {
      pipelineExecutors = {
        runL1: (ctx, job, scope) => l1Controls!.executeJob(ctx, job, scope),
        runL2: (ctx, job, scope) => l2Controls!.executeJob(ctx, job, scope),
        runL3: (ctx, job, scope) => l3Controls!.executeJob(ctx, job, scope),
        isCooledDown: (type) =>
          type === "l1" ? l1Controls!.isCooledDown() : type === "l2" ? l2Controls!.isCooledDown() : l3Controls!.isCooledDown(),
        // L1 收尾后由 worker 决定下一步（2026-09-19）：还有 L0 积压就继续排 L1，
        // 排空了且有新记录才排 L2 —— 对应"多个 L1 串行跑完才轮到 L2"。
        hasL1Remaining: (p) => {
          try {
            const cursor = loadL1Cursor(p);
            const files = listL0Files(p, cursor);
            if (files.length === 0) return false;
            const cursorToken = typeof cursor === "string" ? cursor : JSON.stringify(cursor);
            return readL0Increment(files.join(","), cursorToken).messages.length > 0;
          } catch {
            return false;
          }
        },
        hasNewRecordsForL2: (p) => {
          try {
            return countNewRecords(p, loadL2Cursor(p).lastProcessedAt) > 0;
          } catch {
            return false;
          }
        },
      };
    }
    pipelineWorker?.setCachedCtx(ctx);
    pipelineWorker?.kick();

    // [DISABLED] 初始化工作流保存系统已禁用（保留代码，恢复时取消注释）
    // workflowController.init(ctx);

    statusCtx = ctx;
    refreshStatus(ctx);

    // 2026-09-12：旧检索链（searcher 关键词设计 + 倒排索引接线）退役 —— 其产出只被已注释的
    // sub-memory / get_memory 路径消费，三处"关键词刷新"钩子（session_start / agent_settled /
    // before_agent_start）会向配置模型外发最近 20 条对话全文却无人使用。相关初始化与接线一并移除。
  });

  pi.on("session_shutdown", async () => {
    activePipelineStatus = undefined;
    statusCtx = undefined;
    pipelineWorker?.reset(); // 先使旧会话的 UI/派发失效，在途任务租约仍保留数据库。
    manager.shutdown();
    skillManager = undefined;
    profileSkillsPath = undefined;
    l1Controls?.reset();
    l2Controls?.reset();
    l3Controls?.reset();
    recallScheduler.reset(); // 清召回闸门：在飞/排队请求以 reset settle（避免悬挂）
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
    statusCtx = ctx;
    refreshStatus(ctx);

    // L0 净化归档：每轮增量把 session 新消息写入 {profile}/conversations/YYYY-MM-DD.jsonl
    // （去重=行号游标；降噪=SanitizeRule 规则集；分片=本地日期；cwd=ctx.cwd 精确值）。
    // 同步执行（毫秒级），异常不阻塞主流程。
    //
    // 子代理进程守卫：util/spawn.ts 派发子代理时设 PI_SUBAGENT_CHILD=1，子代理加载本扩展后
    // 同样会触发 before_agent_start。若不守卫，子代理自己的 sessionFile（长路径：
    // {sessionId}/{runId}/run-0/session.jsonl）会被当主会话归档，导致 L0 分片污染
    // （子代理的 thinking / tool_call / l1_commit 响应都进入 conversations/），
    // 下轮 L1 提取读到上一轮 L1 自身执行痕迹（“框架噪音”）。
    // 根因验证：2026-08-18 l0/cursor.json 含大量 /\run-0\session.jsonl/ entry，
    // 对应子代理 session 文件（id 与主会话不同，modelId=mimo-v2.5）。
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    // 跨进程通知漏斗：子代理进程里的 noticeCard 落盘在 logs/notices.jsonl，
    // 在这里（每 turn 收尾）取出来渲染成真正的聊天区卡片。
    try {
      const drained = drainNoticeCards();
      if (drained > 0) logEvent("notice", `drained ${drained} card(s) from subagent`);
    } catch (e) {
      logEvent("notice", `drain failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const profile = manager?.getProfileManager().getActiveProfile();
      if (sessionFile && profile) {
        const result = archiveSessionIncrement(sessionFile, profile.path, ctx.cwd);
        if (result.error) {
          logEvent("l0", result.error, profile.path);
        }
        // skill-feed 原料清洗（5-role 高保真，喂 skill-reviewer；与 L0 双通道并存）
        const feedResult = archiveSkillFeedIncrement(sessionFile, profile.path, ctx.cwd);
        if (feedResult.error) {
          logEvent("skill", feedResult.error, profile.path);
        }
      } else {
        // 2026-09-21 补：这两个分支原先**静默跳过**，于是"L0 归档停了几小时、cursor 停在旧行数"
        // 这种情况在日志里一点痕迹都没有（实测：同一会话文件 815 → 956 行，无任何 L0 记录）。
        // 不猜原因，先把事实留下 —— 下次一眼能看出是"没有 sessionFile"还是"没有 profile"。
        logEvent("l0", `跳过归档：sessionFile=${sessionFile ? "有" : "无"}，profile=${profile ? "有" : "无"}`);
      }
    } catch (e) {
      logEvent("l0", `archive failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // ── Context Injection ───────────────────────────────────────

  // 2026-09-12：模板迁入 prompts/registry 单源（prompts/backends/tool-reminder.md）；
  // 旧加载器 memory/prompts.ts 已删除。
  const MEMORY_TOOL_REMINDER = renderPrompt("backends/tool-reminder", promptVarsFor("backends/tool-reminder"));

  pi.on("before_agent_start", async (event, ctx) => {
    // [subagent-guard] 子代理进程守卫：util/spawn.ts 派发子代理时设 PI_SUBAGENT_CHILD=1。
    // 子代理 turn 不应吃主代理注入 / 建 _pendingContext / 计 L1 命中（否则执行痕迹污染命中统计）。
    // 与 L0 归档守卫同款判断；此处显式返回原 systemPrompt（pi 要求 before_agent_start 返回对象）。
    if (process.env.PI_SUBAGENT_CHILD === "1") {
      return { systemPrompt: event.systemPrompt };
    }

    // 新 turn 开始：清空 L1 命中计数的 turn 级去重集合，并推进轮次编号
    // （turnToken++ 使上一轮仍在飞的召回结果作废 —— async 模式下必需）
    currentTurnHitSet.clear();
    turnToken++;

    // ── L1 召回 query 构造（2026-10-02 重构，取代 2026-09-02 的条件式拼接） ──
    //
    // 旧行为：裸 prompt，或（contextExpansion=conditional 且命中指代消解时）**追加**最近 2 条
    // user 历史。缺陷（实测）：噪声 prompt（"同意"/"提交"/"需要"，L0 1897 条 user 消息里 109 条
    // = 5.7%）**全部**因「过短 <12 字」命中指代消解，于是变成 `噪声原文 + 真实历史` 一起进
    // embedding —— **噪声占掉一半权重，把真实意图稀释了**。向量检索永远返回 top-K，哪怕库全是
    // 无关内容，所以噪声 query 照样拿 0.45–0.53 的「top-1 最佳命中」，看着像召回了，其实在捞
    // 最不相关的那几条（采样实测 30 条）。
    //
    // 新行为：决策逻辑收进 `util/query-noise.ts`（纯函数、可回归），三档：
    //   bare     —— prompt 有实质内容（conditional/always 时仍按旧行为追加历史，保持兼容）
    //   replaced —— prompt 是噪声但历史里捞得到实质内容 ⇒ **用历史替代噪声**，不保留噪声原文
    //                （同等 embedding 成本、信号强度提高；这是**提质**不是省时间）
    //   skipped  —— 噪声且历史也捞不到 ⇒ queryText 空串，调用方直接不发 embedding
    // replaced 必须同时看 user 与 assistant 历史：实测 8 个噪声样本有 4 个「前 3 条 user 内无
    // 实质内容」（"提交" ← 上一轮 assistant 正在写「## 实施完成，验证全部通过…」），意图在
    // assistant 那边，只看 user 会让一半场景无效。
    let queryText = event.prompt;
    /** true ⇒ 本轮噪声且无历史可救，跳过召回（不发 embedding、不占闸门）。 */
    let skipRecall = false;
    try {
      const recallCfg = loadRecallConfig(
        manager?.getProfileManager().getActiveProfile()?.path ?? ""
      );
      const expandContext =
        recallCfg.contextExpansion === "always" ||
        (recallCfg.contextExpansion === "conditional" && needsContextExpansion(event.prompt));
      const entries = ctx.sessionManager.getEntries();
      // 最近 2 条 user 历史（slice(-3,-1) 排除本轮 prompt 自身），**倒序**供替代逻辑从近处挑
      const recentUser = entries
        .filter((e: any) => e.type === "message" && e.message?.role === "user")
        .slice(-3, -1)
        .map((e: any) => extractMessageText(e))
        .filter(Boolean)
        .slice(-2)
        .reverse();
      // 上一条 assistant（噪声轮次的意图常写在这里，见上方 replaced 说明）
      const lastAssistant =
        entries
          .filter((e: any) => e.type === "message" && e.message?.role === "assistant")
          .slice(-1)
          .map((e: any) => extractMessageText(e))
          .join("") ?? "";

      const plan = buildQueryText({
        prompt: event.prompt,
        recentUser,
        lastAssistant,
        expandContext,
      });
      queryText = plan.text;
      skipRecall = plan.kind === "skipped";

      if (plan.kind === "replaced") {
        logEvent(
          "recall",
          `噪声 query 已替代: p="${event.prompt.slice(0, 24)}…" → 来自 ${plan.from}（${plan.text.length}字）`,
        );
      } else if (skipRecall) {
        logEvent("recall", `噪声 query 且无历史可救，跳过本轮召回: p="${event.prompt.slice(0, 24)}…"`);
      } else if (expandContext && recallCfg.contextExpansion === "conditional" && needsContextExpansion(event.prompt)) {
        logEvent(
          "recall",
          `contextExpansion 触发: q="${event.prompt.slice(0, 40)}…" + ${(queryText.length - event.prompt.length)}字历史`,
        );
      }
      // contextExpansion === "off" → expandContext=false → 纯裸 prompt
    } catch {
      // sessionManager / config 不可用 → fall back to prompt only（fail-open，不跳过召回）
    }

    // 冻结快照（固定不变）→ system prompt 前缀稳定 → 命中 provider 前缀缓存
    const systemContext = manager.buildSystemPrompt();
    if (systemContext) {
      event.systemPrompt += `\n\n${systemContext}`;
    }

    // [RETIRED 2026-09-12] 旧 sub-memory（sub-memories/ jieba 倒排）自动注入已于 2026-08-20 废弃，
    // 其依赖的检索链（searcher / InvertedIndex）已随 LEGACY_RETRIEVAL_RETIREMENT 删除。
    // 恢复旧行为须 git revert 该计划的删码提交，块内引用符号已不存在（原注释块已移除）。
    _pendingContext = { subMemories: "", l1RecordIds: [], hitsCounted: false };

    // ── L1 records 向量召回（2026-09-15 改造：串行闸门 + blocking/async 双模式） ──
    // 关键点：
    //   · 召回统一走调度闸门（会话级串行、闸门释放绑定底层 settle），不再直接 await recallL1Records；
    //   · blocking（默认）：等最多 injectTimeoutMs —— 实测 p50 457ms/p90 1326ms，多数 turn 首跳即有记忆；
    //     超时后请求仍在飞、结果可在后续 LLM 调用补注入（自动退化为 async 行为）；
    //   · async：不等待，立即放行 agent loop；结果就绪后由 context 在后续调用前插入；
    //   · 命中计数**不在此处**做（`countHits: false`）——「召回返回」≠「真的注入」，
    //     改由 context 事件在块真正入列时计数（见下）。
//   短查询 / 质量门过滤：避免为 "1" / "/" / 纯符号等无意义 prompt 浪费向量调用。
    //   ⚠ `length < 3` 这条已由 `util/query-noise.ts` 的噪声判定**取代**（它覆盖
    //   "同意"/"提交"/"需要" 等 5.7% 的元指令，旧的 3 字门槛漏掉了它们）；
    //   `skipRecall` 由上面的 buildQueryText 产出（噪声且历史救不回）。
    //   `_isTrivialPrompt` 保留「斜杠命令 / 纯符号」两条 —— 那是**命令行语法**层面的判断，
    //   与语义噪声是两回事（"/skill:plan-ex" 只有 2 字但有明确意图，必须走召回）。
    const _trimmedPrompt = (event.prompt || "").trim();
    const _isSlashOrSymbol =
      _trimmedPrompt.startsWith("/") ||
      /^[\?？]+$/.test(_trimmedPrompt) ||
      /^[^a-zA-Z0-9一-龥\s]{1,5}$/.test(_trimmedPrompt);
    const _activeProfile = manager?.getProfileManager().getActiveProfile();
    // ⚠ 2026-10-02：项目加权排序需要「当前会话属于哪个项目」。
    //   从判定表读，**只有 `flag===true` 才用** —— `flag=false` 是判定器弃权
    //   （没能判出项目），拿弃权当证据去压低别的项目的记忆是误伤。
    //   读不到 / 弃权 ⇒ 空串 ⇒ 召回侧系数全 1.0，**完全退回改造前行为**。
    let _sessionProject = "";
    try {
      const _sf = ctx.sessionManager?.getSessionFile?.();
      if (_sf && _activeProfile) {
        // sessionKey 取文件名去后缀（与 judg-session-project 的键口径一致）
        const _basename = _sf.replace(/\\/g, "/").split("/").pop() ?? "";
        const _key = _basename.replace(/\.jsonl$/i, "");
        const _e = readSessionJudg(_activeProfile.path, _key);
        if (_e?.flag === true && _e.project) _sessionProject = _e.project;
      }
    } catch {
      // 判定表不可读 ⇒ 保持空串（fail-safe：退回改造前行为）
    }
    if (!_isSlashOrSymbol && !skipRecall && _activeProfile) {
      try {
        const recallCfg = loadRecallConfig(_activeProfile.path);
        const myTurn = turnToken;
        // 结果就绪 → 仅当仍是本轮时写回（否则丢弃：上一轮的召回不该进这一轮）
        const applyResult = (settlement: { outcome: string; value: L1RecordCandidate[] | null }) => {
          if (myTurn !== turnToken || !_pendingContext) return;
          if (settlement.outcome !== "ok" || !settlement.value || settlement.value.length === 0) return;
          const records = settlement.value;
          _pendingContext.subMemories = renderPrompt("injection/l1-records", {
            recordsLines: records.map((r) => `- ${r.content}`).join("\n"),
          });
          _pendingContext.l1RecordIds = records.map((r) => r.recordId);
          _pendingContext.hitsCounted = false;
        };
        const request = recallScheduler.request({
          kind: "inject",
          turnToken: myTurn,
          // blocking：等待上界 = injectTimeoutMs；async：不等，结果预算放到闸门持有上限
          timeoutMs: recallCfg.injectMode === "blocking" ? recallCfg.injectTimeoutMs : recallCfg.maxHoldMs,
          payload: {
            queryText,
            profilePath: _activeProfile.path,
            topK: AUTO_INJECT_TOP_K,
            source: "inject",
            countHits: false, // 计数改由 context 真入列时做（见 context 事件）
            // 项目加权排序（2026-10-02）：空串 = 无判定 ⇒ 系数全 1.0，行为与改造前一致
            sessionProject: _sessionProject,
          },
        });

        if (recallCfg.injectMode === "blocking") {
          applyResult(await request);
        } else {
          // 不阻塞 agent loop 启动：后台等结果，就绪后由后续 context 事件注入
          void request
            .then(applyResult)
            .catch((e) =>
              logEvent("recall", `异步召回失败: ${e instanceof Error ? e.message : String(e)}`),
            );
        }
      } catch (e) {
        // 召回/配置失败静默降级（不阻塞主流程，不注入）
        logEvent("recall", `自动注入召回失败: ${e instanceof Error ? e.message : String(e)}`);
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

      // ── L1 命中计数：**只在块真正入列的这一处计**（2026-09-15，L1_RECALL_ASYNC） ──
      // 为什么不在召回返回时计：「召回成功」≠「真的注入」——async/超时补注入下，单次答完的
      // turn 里块可能从未被读出（本函数是该块的唯一读者）。每 turn 只计一次（hitsCounted）。
      // turn 级去重沿用 currentTurnHitSet（与 recall_l1_records 工具共用同一集合）。
      if (_pendingContext?.subMemories && !_pendingContext.hitsCounted && _pendingContext.l1RecordIds.length > 0) {
        _pendingContext.hitsCounted = true;
        const allIds = _pendingContext.l1RecordIds;
        const fresh = allIds.filter((id) => !currentTurnHitSet.has(id));
        for (const id of allIds) currentTurnHitSet.add(id);
        if (fresh.length > 0) {
          const profilePath = manager?.getProfileManager().getActiveProfile()?.path;
          if (profilePath) {
            void import("./memory/stats/l1-hit-stats-db.ts")
              .then(({ getL1HitStatsDB }) => getL1HitStatsDB(profilePath).recordHits(fresh, "inject"))
              .catch((e) =>
                logEvent("recall", `命中计数失败（不影响注入）: ${e instanceof Error ? e.message : String(e)}`),
              );
          }
        }
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
    description: "手动触发 L3 Persona 生成（从 L2 场景更新画像提议稿 USER-temp.md，再由用户并入 USER.md）。用法：/my-memory:l3-trigger",
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
          statusCtx = ctx;
          activePipelineStatus = undefined;
          process.env.PI_PROFILE_PATH = profile.path;
          pipelineWorker?.reset();
          pipelineWorker?.setCachedCtx(ctx);
          pipelineWorker?.kick();
          skillManager = new SkillManager(profile.path, [
            resolve(agentDir, "skills"),
          ]);
          profileSkillsPath = profile.path;
          refreshStatus(ctx);
          // 切 profile：召回闸门重置（清 in-flight/队列，避免跨 profile 混用召回结果）
          recallScheduler.reset();
          turnToken++;
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

  // /my-memory:subagent-kill：手动"提前停"。
  //
  // 自动路径在硬上限（默认 30 分钟）就会停掉子代理（见 memory/pipeline/subagent-kill.ts 的停止序列）；
  // 这条命令给"我已经确定它卡了，不想等满 30 分钟"的情形，复用同一套序列（跳过宽限）。
  // 为什么必须留人工口子：自动判定分不清"一次超长生成"与"真卡死"（实测 987 秒的单轮生成），
  // 而人知道上下文（网关刚挂了 / 我已经等了四十分钟）。
  pi.registerCommand("my-memory:subagent-kill", {
    description: "手动停掉某层的后台子代理（硬上限之外用）。用法：/my-memory:subagent-kill <l1|l2|l3> [jobId]",
    handler: async (args, ctx) => {
      const profilePath = manager?.getProfileManager().getActiveProfile()?.path;
      if (!profilePath) {
        ctx.ui.notify("未取得 profile，无法停止", "error");
        return;
      }
      const parts = (args || "").trim().split(/\s+/);
      const layer = parts[0];
      if (layer !== "l1" && layer !== "l2" && layer !== "l3") {
        ctx.ui.notify("用法：/my-memory:subagent-kill <l1|l2|l3> [jobId]", "warning");
        return;
      }
      // 自建 spawn（2026-10-01）：找子代理不再扫 pi-subagents 的私有布局，而是查我们
      // 自己的运行记录（spawn 时写、job 收尾时删）。指定 jobId 就精确取那个 job 的记录；
      // 不指定就取该层最近的一条。
      const jobIdArg = Number(parts[1]);
      const jobIdHint = Number.isFinite(jobIdArg) && jobIdArg > 0 ? jobIdArg : 0;
      const runs = jobIdHint
        ? [readSubagentRun(profilePath, layer, jobIdHint)].filter(Boolean)
        : listSubagentRuns(profilePath).filter((r) => r.layer === layer);
      const active = runs.length > 0 ? runs[runs.length - 1] : undefined;
      if (!active) {
        ctx.ui.notify(
          `没有正在运行的子代理（${layer} 层没有本扩展的运行记录）`,
          "info",
        );
        return;
      }
      const jobId = jobIdHint || active.jobId;
      const out = await stopSubagent({
        profilePath,
        layer,
        jobId,
        reason: "手动停止（/my-memory:subagent-kill）",
        skipGrace: true,
        hooks: layer === "l2" ? { rebuildSceneIndex: syncSceneIndex, repairSceneMembers } : undefined,
      });
      if (!out.killConfirmed) {
        const st = loadFailureState(profilePath);
        st[layer].holdUntil = holdUntilFrom(Date.now(), loadSubagentTimeouts(profilePath).holdMsUnconfirmed);
        saveFailureState(profilePath, st);
      }
      logEvent("pipeline", `手动停止 ${layer}（job ${jobId || "未指定"}）：${out.note}`, profilePath);
      ctx.ui.notify(
        out.killConfirmed ? `${layer} 子代理已停掉，杀后修复已完成` : `未能确认停止：${out.note}（该层已持有）`,
        out.killConfirmed ? "info" : "warning",
      );
    },
  });

  // ── /my-memory:l2:archive-list | :archive | :restore（2026-09-27 归档层的人工入口）──
  //
  // 为什么要人工入口：归档只由子代理在"库满且确实要腾名额"时才做，而人可能先看出「这个项目早就结了」
  // 而子代理没动；反过来，搬错了必须能立刻搬回来 —— `restore` 是整套设计能成立的前提（单向归档
  // 本质就是"有记账的 delete"）。
  //
  // 与子代理路径的两点不同：① 人工可以搬子代理搬不动的块（年龄/同名两条硬拦仍然生效，不绕过）；
  // ② 必须显式给 --reason。两条路径都持 L2 运行级锁，否则会与正在跑的子代理交错提交。
  pi.registerCommand("my-memory:l2:archive-list", {
    description: "列出 L2 归档层的内容与账目（谁在什么时候为什么搬的）。用法：/my-memory:l2:archive-list",
    handler: async (_args, ctx) => {
      const profilePath = manager?.getProfileManager().getActiveProfile()?.path;
      if (!profilePath) {
        ctx.ui.notify("未取得 profile", "error");
        return;
      }
      const blocks = listArchivedBlocks(profilePath);
      if (blocks.length === 0) {
        ctx.ui.notify("归档层是空的（还没搬过任何块）", "info");
        return;
      }
      const lines = blocks.map((b) => {
        const last = [...b.events].reverse().find((e) => e.op === "archive" || e.op === "ledger-missing");
        const when = last?.at ? last.at.slice(0, 10) : "?";
        const why = last?.reason ?? "（无记录）";
        return `${b.filename}｜${when}｜成员 ${b.members.length}｜${why}`;
      });
      ctx.ui.notify(`归档层 ${blocks.length} 个块：\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("my-memory:l2:archive", {
    description: "手工把一个场景块搬进归档层。用法：/my-memory:l2:archive <文件名.md> --reason \"为什么搬它\"",
    handler: async (args, ctx) => {
      const profilePath = manager?.getProfileManager().getActiveProfile()?.path;
      if (!profilePath) {
        ctx.ui.notify("未取得 profile", "error");
        return;
      }
      const rawArgs = (args || "").trim();
      const filename = rawArgs.split(/\s+/)[0] ?? "";
      const reasonMatch = /--reason\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(rawArgs);
      const reason = (reasonMatch?.[1] ?? reasonMatch?.[2] ?? reasonMatch?.[3] ?? "").trim();
      if (!filename) {
        ctx.ui.notify('用法：/my-memory:l2:archive <文件名.md> --reason "为什么搬它"', "warning");
        return;
      }
      if (!reason) {
        ctx.ui.notify("必须给 --reason（这是归档唯一的审计凭据）", "warning");
        return;
      }
      const lock = acquireRunLock(profilePath, "l2");
      if (!lock.acquired) {
        ctx.ui.notify(runLockBusyMessage("l2", lock.owner), "warning");
        return;
      }
      try {
        reconcileArchive(profilePath, new Date().toISOString());
        const out = archiveSceneBlock(profilePath, { filename, reason, by: "command" });
        if (!out.ok) {
          ctx.ui.notify(`归档失败：${out.error}`, "error");
          return;
        }
        syncSceneIndex(profilePath);
        logEvent("l2", `人工归档 ${filename}（${out.members.length} 个成员）：${reason}`, profilePath);
        ctx.ui.notify(`已搬进归档层：${filename}（${out.members.length} 个成员随之保留）。搬回来：/my-memory:l2:restore ${filename}`, "info");
      } finally {
        lock.release();
      }
    },
  });

  pi.registerCommand("my-memory:l2:restore", {
    description: "把一个归档的块搬回场景目录。用法：/my-memory:l2:restore <文件名.md>",
    handler: async (args, ctx) => {
      const profilePath = manager?.getProfileManager().getActiveProfile()?.path;
      if (!profilePath) {
        ctx.ui.notify("未取得 profile", "error");
        return;
      }
      const filename = (args || "").trim().split(/\s+/)[0] ?? "";
      if (!filename) {
        ctx.ui.notify("用法：/my-memory:l2:restore <文件名.md>", "warning");
        return;
      }
      const lock = acquireRunLock(profilePath, "l2");
      if (!lock.acquired) {
        ctx.ui.notify(runLockBusyMessage("l2", lock.owner), "warning");
        return;
      }
      try {
        reconcileArchive(profilePath, new Date().toISOString());
        // 恢复会往 live 目录加回一个块 ⇒ 受同一个上限约束（满库时须先腾位，否则拒绝）。
        const count = countSceneBlocks(profilePath);
        const limit = loadL2Config(profilePath).maxScenes;
        if (count + 1 > limit) {
          ctx.ui.notify(`场景目录已满（${count}/${limit}）：先把别的块归档或合并，腾出位置再恢复`, "warning");
          return;
        }
        const out = restoreSceneBlock(profilePath, { filename, by: "command", reason: "人工恢复" });
        if (!out.ok) {
          ctx.ui.notify(`恢复失败：${out.error}`, "error");
          return;
        }
        syncSceneIndex(profilePath);
        logEvent("l2", `人工恢复 ${filename}（${out.members.length} 个成员）`, profilePath);
        ctx.ui.notify(`已搬回场景目录：${filename}（${out.members.length} 个成员）`, "info");
      } finally {
        lock.release();
      }
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
        const { getVectorizationStatus, formatStatus } = await import("./memory/search/embedding/backfill.ts");
        const status = await getVectorizationStatus(profile.path);
        noticeReport("L1 向量化状态", formatStatus(status, limit), { level: "info" });
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
        const { backfillMissingVectors, getVectorizationStatus } = await import("./memory/search/embedding/backfill.ts");
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
        const { rebuildAllVectors, getVectorizationStatus } = await import("./memory/search/embedding/backfill.ts");
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
        const { runFix } = await import("./memory/l1/fix-tool.ts");
        const params: any = { recordId: id, action, newContent: content, evidence, reason };
        if (pv !== undefined) params.priority = Number(pv);
        const text = await runFix(params, profilePath, { force });
        const parsed = JSON.parse(text);
        notice(ctx, parsed.success ? "info" : "error", parsed.success ? "L1 修正成功" : `L1 修正被拒：${parsed.error}`);
        // 完整结果进卡片：以前这里是 `ctx.console?.log?.()`——pi 的 ExtensionContext 没有 console
        // 字段，可选链静默跳过，于是命令等于没输出（2026-09-19 核实）。
        noticeReport("L1 修正结果", text, { level: parsed.success ? "info" : "warning", maxSummaryLines: 8 });
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
        // 体检报告较长：进聊天区卡片（以前用 ctx.console?.log?.() = 静默 no-op）
        noticeReport("L1 库体检", stdout, { level: "info" });
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
        const { getQualityRanked } = await import("./memory/l1/quality.ts");
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
        noticeReport("L1 质量排行", lines.join("\n"), { level: "info", maxSummaryLines: 14 });
      } catch(e){ ctx.ui.notify(`quality 失败: ${e instanceof Error?e.message:String(e)}`, "error"); }
    },
  });

  pi.registerCommand("my-memory:l1:stats", {
    description: "汇总 L1 质量分布与冷/噪清单。用法：/my-memory:l1:stats",
    handler: async (_args, ctx) => {
      const profile = manager.getProfileManager().getActiveProfile();
      if (!profile) { ctx.ui.notify("No active profile", "error"); return; }
      try {
        const { getQualityStats } = await import("./memory/l1/quality.ts");
        const s=await getQualityStats(profile.path);
        const unit = s.clock.activeDayClock ? "活跃日" : "日历天";
        const lines=[`L1 质量汇总: 总数=${s.total} | 分布 热${s.dist["热"]??0}/温${s.dist["温"]??0}/冷${s.dist["冷"]??0}/新${s.dist["新"]??0}/待观察${s.dist["待观察"]??0}/噪${s.dist["噪"]??0}`,
                     `直方图 q 0-2:${s.histogram["0-2"]} 2-4:${s.histogram["2-4"]} 4-6:${s.histogram["4-6"]} 6+:${s.histogram["6+"]}`,
                     s.clock.activeDayClock
                       ? `时钟: 活跃会话日 ${s.clock.activeDays} 个 / 跨度 ${s.clock.spanDays.toFixed(0)} 日历天（停工期间 days 不增长，单位=${unit}）`
                       : `时钟: 退化为日历天（未找到 l0/conversations 分片）`];
        if(s.cold.length>0){ lines.push("", `冷清单 (>14${unit}0命中) ${s.cold.length}条 前5:`); s.cold.slice(0,5).forEach(r=> lines.push(` - q=${r.quality.toFixed(2)} days=${r.days.toFixed(1)} pri=${r.priority} id=${r.id} | ${r.content.slice(0,60)}`)); }
        else lines.push("", `冷清单: 0（>14${unit}0命中暂无，7-14${unit}为待观察）`);
        if(s.noisy.length>0){ lines.push("", `噪清单 (失效率>50%) ${s.noisy.length}条 前5:`); s.noisy.slice(0,5).forEach(r=> lines.push(` - q=${r.quality.toFixed(2)} eff=${r.effective} hits=${r.hits}/${r.invalid} id=${r.id} | ${r.content.slice(0,60)}`)); }
        else lines.push("", "噪清单: 0");
        lines.push("", `淘汰候选 ${s.prune.length} 条（已排除 priority>=${s.protectedPriority}(P75动态) / work_method / 有效命中过的记忆；quality 低只代表热度低，不代表可删）`);
        s.prune.slice(0,5).forEach(r=> lines.push(` - q=${r.quality.toFixed(2)} days=${r.days.toFixed(1)} pri=${r.priority} type=${r.type} id=${r.id} | ${r.content.slice(0,50)}`));
        lines.push("", `最早记录距今 ${s.ranked.length? Math.max(...s.ranked.map(r=>r.days)).toFixed(1):0} ${unit}，${s.total>0 && s.cold.length===0 ? `冷标签需等记录>14${unit}后可观测` : ""}`);
        noticeReport("L1 质量汇总", lines.join("\n"), { level: "info", maxSummaryLines: 14 });
      } catch(e){ ctx.ui.notify(`stats 失败: ${e instanceof Error?e.message:String(e)}`, "error"); }
    },
  });

  // [RETIRED 2026-09-12] /my-memory:rebuild-index 已删除：倒排索引随旧检索链退役，
        // 索引不再被任何活跃路径读取/维护（见 plan/memory-system/LEGACY_RETRIEVAL_RETIREMENT/）。
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

/**
 * 宿主 agent 根目录。解析规则收敛在 `util/agent-dir.ts`（P1-7）——
 * 原先这里、`memory/l1/config.ts`、`util/judg-session-project/llm.ts` 各写一份，
 * 三份对「`PI_CODING_AGENT_DIR` 给的是 agent 根还是家目录」的假设并不一致，
 * 其中一份因此拼出 `~/.pi/agent/.pi/agent/sessions` 而静默返回空列表。
 */
function getAgentDir(): string {
  return resolveAgentDir();
}
