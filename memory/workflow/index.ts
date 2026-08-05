// ============================================================================
// workflow/index.ts — 工作流保存系统：扩展接线入口
//
// 功能：注册工具/命令/事件（扩展加载时一次），管理 WorkflowDB/Manager/Detector
//       生命周期（session_start 重建），接线 input → 状态机、tool_result →
//       改动采集 + 兜底补建、context → 续接注入
// 用途：由 memory-system/index.ts 在扩展加载时调用 setupWorkflowSystem()
// 设计：纯扩展零侵入 pi 源码；注册在加载时完成（TUI autocomplete 可见），
//       db/manager 每次 session_start 重建（profile 跟随）
// ============================================================================

import { WorkflowDB } from "./db.js";
import { WorkflowManager } from "./manager.js";
import { WorkflowDetector } from "./detector.js";
import { registerWorkflowTools } from "./tools.js";
import { registerWorkflowCommands } from "./commands.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 缓存最近一条"无产出意图"的用户消息（兜底补建需求来源）
let lastNoIntentMessage: { text: string; time: number } | null = null;

// 续接注入内容（session_start 构建，context 事件注入）
let resumeContext: string | null = null;

/**
 * setupWorkflowSystem — 初始化并接线工作流保存系统（扩展加载时调用一次）
 *
 * @param pi ExtensionAPI
 * @param deps 依赖注入（避免循环 import）：
 *   getProfilePath: () => string | undefined  活动 profile 路径
 *   getSessionId:   () => string | undefined  当前 session id
 * @returns controller：{ init, suspendActive, getManager, shutdown }
 */
export function setupWorkflowSystem(
  pi: ExtensionAPI,
  deps: {
    getProfilePath: () => string | undefined;
    getSessionId: () => string | undefined;
  },
) {
  let db: WorkflowDB | undefined;
  let manager: WorkflowManager | undefined;
  let detector: WorkflowDetector | undefined;

  // ── 注册工具/命令/事件（加载时一次，handler 懒取当前 manager） ──

  registerWorkflowTools(pi, () => manager);
  registerWorkflowCommands(pi, () => manager, () => detector);

  // 用户消息监听 → 生命周期状态机
  pi.on("input", (event) => {
    if (event.source !== "interactive") return; // M2：只处理用户交互输入
    const text = event.text?.trim();
    if (!text) return;
    if (text.startsWith("/")) return; // 命令不触发状态机
    if (text === "1") return; // M6：网络问题恢复消息，不触发
    const mgr = manager;
    const det = detector;
    if (!mgr || !det) return;
    const sessionId = deps.getSessionId();
    if (!sessionId) return;
    const dbInst = mgr.getDB();
    const active = dbInst.getActiveWorkflow();
    if (!active) {
      // 无活动工作流 → 创建判定（LLM 语义判断产出意图）
      void handleNoActiveWorkflow(mgr, det, text, sessionId);
      return;
    }
    void handleWithActiveWorkflow(mgr, det, text, sessionId, active.id);
  });

  // 工具执行结果监听 → 改动采集 + 兜底补建
  pi.on("tool_result", (event) => {
    const mgr = manager;
    if (!mgr) return;
    const dbInst = mgr.getDB();
    const sessionId = deps.getSessionId();
    if (!sessionId) return;
    // M1：失败工具不记录（isError 时跳过）
    if (event.isError) return;
    // 改动记录：edit/write 成功
    if (event.toolName === "edit" || event.toolName === "write") {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const filePath = typeof input.path === "string" ? input.path : undefined;
      if (!filePath) return;
      const summary = extractChangeSummary(event.toolName, input);
      const active = dbInst.getActiveWorkflow();
      if (active) {
        mgr.recordChange(active.id, filePath, event.toolName, summary);
        return;
      }
      // 兜底补建：无活动工作流但发生产出工具调用
      const fallbackTitle = lastNoIntentMessage?.text.slice(0, 100) ?? `工作流 ${filePath}`;
      const newId = mgr.createWorkflowFromMessage({
        sessionId,
        title: fallbackTitle,
        description: `由工具调用兜底补建（${event.toolName} ${filePath}）`,
      });
      mgr.getDB().setStatus(newId, "in_progress");
      mgr.recordChange(newId, filePath, event.toolName, summary);
      if (lastNoIntentMessage) {
        mgr.recordEvent(newId, "user_request", lastNoIntentMessage.text);
      }
      lastNoIntentMessage = null;
      return;
    }
    // 产出类工具（memory/skill_manage）兜底补建触发
    // 注意：bash 不参与补建（几乎每轮出现且多为只读 ls/cat/grep，误创建率高）
    const PRODUCTION_TOOLS = new Set(["memory", "skill_manage"]);
    if (PRODUCTION_TOOLS.has(event.toolName) && !dbInst.getActiveWorkflow()) {
      const fallbackTitle = lastNoIntentMessage?.text.slice(0, 100) ?? `工作流（${event.toolName}）`;
      const newId = mgr.createWorkflowFromMessage({
        sessionId,
        title: fallbackTitle,
        description: `由 ${event.toolName} 工具调用兜底补建`,
      });
      mgr.getDB().setStatus(newId, "in_progress");
      if (lastNoIntentMessage) {
        mgr.recordEvent(newId, "user_request", lastNoIntentMessage.text);
      }
      lastNoIntentMessage = null;
    }
  });

  // 续接注入（context 事件）
  pi.on("context", (event) => {
    if (!resumeContext) return;
    event.messages.push({
      role: "user",
      content: resumeContext,
    });
    return { messages: event.messages };
  });

  // session 关闭 → 挂起总结 + 清理
  pi.on("session_shutdown", async () => {
    if (manager) {
      const active = manager.getDB().getActiveWorkflow();
      if (active) void manager.suspendSummary(active.id);
    }
    resumeContext = null;
    lastNoIntentMessage = null;
    if (db) {
      db.close();
      db = undefined;
      manager = undefined;
      detector = undefined;
    }
  });

  // ── 返回控制器 ────────────────────────────────────────────────

  return {
    /**
     * 初始化数据库/管理器（session_start / profile switch 时调用）
     * @param ctx 可选：session_start 的 ctx（提供 model 引用）
     */
    init: (ctx?: ExtensionContext): void => {
      const profilePath = deps.getProfilePath();
      if (!profilePath) return;
      // 关闭旧连接（/profile switch 场景）
      if (db) db.close();
      db = new WorkflowDB(profilePath);
      manager = new WorkflowManager(db);
      detector = new WorkflowDetector();
      if (ctx?.model) {
        manager.setModel(ctx.model);
        detector.setModel(ctx.model);
      }
      // 续接注入：检测历史活动工作流
      resumeContext = buildResumeContext(manager);
    },
    /** 手动挂起当前活动工作流（供命令调用） */
    suspendActive: async (): Promise<void> => {
      const mgr = manager;
      if (!mgr) return;
      const active = mgr.getDB().getActiveWorkflow();
      if (active) await mgr.suspendSummary(active.id);
    },
    /** 获取 manager（供测试/调试） */
    getManager: (): WorkflowManager | undefined => manager,
    /** 关闭资源 */
    shutdown: (): void => {
      if (db) {
        db.close();
        db = undefined;
        manager = undefined;
        detector = undefined;
      }
      resumeContext = null;
    },
  };
}

// ---------------------------------------------------------------------------
// 状态机处理
// ---------------------------------------------------------------------------

/**
 * 无活动工作流时的创建判定：
 * detectCreate（正则初筛 + LLM 确认）→ 创建并立即执行（in_progress）
 * 无产出意图 → 缓存消息（兜底补建需求来源）
 */
async function handleNoActiveWorkflow(
  mgr: WorkflowManager,
  det: WorkflowDetector,
  text: string,
  sessionId: string,
): Promise<void> {
  const shouldCreate = await det.detectCreate(text);
  if (shouldCreate) {
    // 竞态保护：LLM 确认期间可能已被兜底补建（工具调用创建），不重复创建
    if (mgr.getDB().getActiveWorkflow()) {
      mgr.recordEvent(mgr.getDB().getActiveWorkflow()!.id, "user_request", text);
      return;
    }
    const id = mgr.createWorkflowFromMessage({
      sessionId,
      title: text.slice(0, 100),
      description: text.slice(0, 500),
    });
    mgr.getDB().setStatus(id, "in_progress");
    mgr.recordEvent(id, "user_request", text);
  } else {
    lastNoIntentMessage = { text, time: Date.now() };
  }
}

/**
 * 有活动工作流时的分支判定（顺序：pending 确认 → 验收 → 推翻双分支 →
 * 方案确认 → 需求调整 → 子任务 → 延续 → 新需求）
 */
async function handleWithActiveWorkflow(
  mgr: WorkflowManager,
  det: WorkflowDetector,
  text: string,
  sessionId: string,
  workflowId: number,
): Promise<void> {
  const dbInst = mgr.getDB();

  // 隐式完成待确认：下一条消息判断继续修改 vs 确认完成
  const pendingId = mgr.getPendingCompletionId();
  if (pendingId === workflowId) {
    const confirm = await det.detectImplicitConfirm(text);
    await mgr.confirmPendingCompletion(workflowId, confirm);
    mgr.recordEvent(workflowId, confirm ? "completion_signal" : "user_request", text);
    return;
  }

  // ① 验收信号 → completed
  if (await det.detectAccept(text)) {
    mgr.setStatus(workflowId, "completed");
    mgr.recordEvent(workflowId, "completion_signal", text);
    return;
  }

  // ② 推翻信号（双分支：放弃 vs 演化）
  const reject = await det.detectReject(text);
  if (reject === "abandon") {
    mgr.setStatus(workflowId, "abandoned");
    mgr.recordEvent(workflowId, "rejection_signal", text);
    return;
  }
  if (reject === "evolve") {
    const newId = mgr.createEvolutionWorkflow(workflowId, {
      sessionId,
      title: text.slice(0, 100),
      description: text.slice(0, 500),
    });
    mgr.recordEvent(workflowId, "rejection_signal", text);
    mgr.recordEvent(newId, "user_request", text);
    return;
  }

  // ③ 方案确认信号 → LLM 结构化回填
  if (PLAN_CONFIRM_REGEX.test(text)) {
    mgr.recordEvent(workflowId, "plan_confirm", text);
    const events = dbInst.listEvents(workflowId);
    const context = events
      .slice(-15)
      .map((e) => `[${e.event_type}] ${e.content}`)
      .join("\n");
    void mgr.fillStructuredFields(workflowId, context);
    return;
  }

  // ④ 需求/方案/目标调整（同一工作流语境）→ 仅记录事件（行更新由 agent 工具/方案确认回填）
  if (await det.detectAdjust(text)) {
    mgr.recordEvent(workflowId, "user_request", text);
    return;
  }

  // ⑤ 子任务拆分 → 创建子工作流（父挂起 + 挂起总结）
  if (await det.detectChild(text)) {
    const childId = mgr.createChildWorkflow(workflowId, {
      sessionId,
      title: text.slice(0, 100),
    });
    mgr.recordEvent(childId, "user_request", text);
    return;
  }

  // ⑥ 延续（"接着做/继续"）→ 追加事件
  if (await det.detectContinue(text)) {
    mgr.recordEvent(workflowId, "user_request", text);
    return;
  }

  // ⑥.5 重启续接/引用工作流（消息与活动工作流标题高度重合）→ 延续
  const active = dbInst.getWorkflow(workflowId);
  if (active?.title && isTitleMatch(text, active.title)) {
    mgr.recordEvent(workflowId, "user_request", text);
    return;
  }

  // ⑦ 兜底：新需求（非延续）→ 当前工作流挂起 + 创建新工作流
  mgr.recordEvent(workflowId, "user_request", text);
  void mgr.suspendSummary(workflowId);
  const newId = mgr.createWorkflowFromMessage({
    sessionId,
    title: text.slice(0, 100),
    description: text.slice(0, 500),
  });
  mgr.getDB().setStatus(newId, "in_progress");
  mgr.recordEvent(newId, "user_request", text);
}

// ---------------------------------------------------------------------------
// 工具方法
// ---------------------------------------------------------------------------

/**
 * 标题重合检测：消息与工作流标题是否高度重合（重启续接/引用场景）
 * 规则：去除空白后，短串是长串的子串，或字符重合度 >= 0.5
 */
function isTitleMatch(message: string, title: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, "");
  const m = norm(message);
  const t = norm(title);
  if (!m || !t) return false;
  if (m.includes(t) || t.includes(m)) return true;
  const short = m.length <= t.length ? m : t;
  const long = m.length <= t.length ? t : m;
  const common = [...short].filter((c) => long.includes(c)).length;
  return common / Math.max(short.length, 1) >= 0.5;
}

/** 方案确认信号正则（"方案可以"/"按这个来"） */
const PLAN_CONFIRM_REGEX = /方案可以|按这个来|按这个方案|就这么办|没问题，就|同意这个|采用这个|批准|就按|可以开始|确认方案/;

/**
 * 从 edit/write 工具输入提取改动摘要（代码层，零 LLM）
 * edit：取首个 edit 的 newText 首片段；write：取 content 首片段
 * @returns 首片段 80 字符（计划约定）
 */
function extractChangeSummary(toolName: string, input: Record<string, unknown>): string {
  let raw = "";
  if (toolName === "write") {
    raw = typeof input.content === "string" ? input.content : "";
  } else if (toolName === "edit") {
    const edits = input.edits;
    if (Array.isArray(edits) && edits.length > 0) {
      const first = edits[0] as Record<string, unknown>;
      raw = typeof first.newText === "string" ? first.newText : "";
    }
  }
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.slice(0, 80) || "(空改动)";
}

/**
 * 构建续接注入内容（session_start 时调用）：
 * 存在活动工作流时，注入 改动文件清单 + 最近 N 条改动摘要 + 最近 N 条辅助上下文
 * （verification/decisions 优先，pending 项优先）
 */
function buildResumeContext(mgr: WorkflowManager): string | null {
  const dbInst = mgr.getDB();
  const active = dbInst.getActiveWorkflow();
  if (!active) return null;
  const changes = dbInst.listChanges(active.id).slice(-10);
  const contextRows = dbInst.listContext(active.id);
  // 排序：verified=0 优先，再按类别优先级（verification/decisions > pitfalls > api/config/commands/dependency）
  const CATEGORY_PRIORITY = ["verification", "decisions", "pitfalls", "api", "commands", "config", "dependency"];
  const sortedContext = [...contextRows].sort((a, b) => {
    const pa = (a.verified === 0 ? 0 : 1) * 10 + CATEGORY_PRIORITY.indexOf(a.category);
    const pb = (b.verified === 0 ? 0 : 1) * 10 + CATEGORY_PRIORITY.indexOf(b.category);
    return pa - pb;
  });
  const contextSlice = sortedContext.slice(0, 5);

  const lines: string[] = [];
  lines.push("<workflow-resume>");
  lines.push(`[工作流续接] 活动工作流 #${active.id}「${active.title}」（${active.status}）`);
  if (active.progress) lines.push(`进度: ${active.progress}`);
  if (active.next_steps) lines.push(`下一步: ${active.next_steps}`);
  if (changes.length > 0) {
    lines.push("最近改动:");
    for (const c of changes) {
      lines.push(`  - ${c.change_type} ${c.file_path}: ${c.summary.slice(0, 60)}`);
    }
  }
  if (contextSlice.length > 0) {
    lines.push("辅助上下文:");
    for (const c of contextSlice) {
      lines.push(`  - [${c.category}${c.verified === 0 ? "待验证" : ""}] ${c.content.slice(0, 120)}`);
    }
  }
  lines.push("</workflow-resume>");
  return lines.join("\n");
}
