// ============================================================================
// workflow/index.ts — 工作流保存系统：扩展接线入口
//
// 功能：注册工具/命令/事件（扩展加载时一次），管理 WorkflowDB/Manager/Detector
//       生命周期（session_start 重建），接线 input → 状态机、context → 续接注入
// 用途：由 memory-system/index.ts 在扩展加载时调用 setupWorkflowSystem()
// 设计：纯扩展零侵入 pi 源码；注册在加载时完成（TUI autocomplete 可见），
//       db/manager 每次 session_start 重建（profile 跟随）
// ============================================================================

import { WorkflowDB } from "./db.ts";
import { WorkflowManager } from "./manager.ts";
import { WorkflowDetector } from "./detector.ts";
import { registerWorkflowTools } from "./tools.ts";
import { registerWorkflowCommands } from "./commands.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 续接注入内容（session_start 构建，context 事件注入）
let resumeContext: string | null = null;

/**
 * setupWorkflowSystem — 初始化并接线工作流保存系统（扩展加载时调用一次）
 *
 * @param pi ExtensionAPI
 * @param deps 依赖注入（避免循环 import）：
 *   getProfilePath:   () => string | undefined  活动 profile 路径
 *   getSessionId:     () => string | undefined  当前 session id
 *   getConfiguredModel: () => unknown          后台模型（memory-system 配置，默认 minimax-cn/MiniMax-M3）
 * @returns controller：{ init, suspendActive, getManager, shutdown }
 */
export function setupWorkflowSystem(
  pi: ExtensionAPI,
  deps: {
    getProfilePath: () => string | undefined;
    getSessionId: () => string | undefined;
    getConfiguredModel: () => unknown;
  },
) {
  let db: WorkflowDB | undefined;
  let manager: WorkflowManager | undefined;
  let detector: WorkflowDetector | undefined;

  // ── 注册工具/命令/事件（加载时一次，handler 懒取当前 manager） ──

  registerWorkflowTools(pi, () => manager);
  registerWorkflowCommands(pi, () => manager, () => detector);

  // 用户消息监听 → 生命周期状态机
  pi.on("input", (event, ctx) => {
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
    const active = dbInst.getActiveWorkflow(sessionId);
    if (!active) {
      // 方案 B：无活跃工作流时，检测到产出意图只提示用户手动创建（不自动创建）
      void handleNoActiveWorkflow(det, text, ctx);
      return;
    }
    void handleWithActiveWorkflow(mgr, det, text, sessionId, active.id, ctx);
  });

  // 续接注入（context 事件）：一次性注入后清空（重启提示，不每轮污染）
  pi.on("context", (event) => {
    if (!resumeContext) return;
    event.messages.push({
      role: "user",
      content: resumeContext,
    });
    // 只注入一次：防缓存过期（状态变化后旧内容每轮重复注入）
    resumeContext = null;
    return { messages: event.messages };
  });

  // session 关闭 → 挂起总结 + 清理
  pi.on("session_shutdown", async () => {
    if (manager) {
      const active = manager.getDB().getActiveWorkflow(deps.getSessionId());
      if (active) void manager.suspendSummary(active.id);
    }
    resumeContext = null;
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
      // 2026-08-08：后台模型走配置（不跟随前台切换）
      manager.setModel(deps.getConfiguredModel());
      detector.setModel(deps.getConfiguredModel());
      // 续接注入：优先当前 session，无则跨 session 按 cwd 找（重启续接）
      resumeContext = buildResumeContext(manager, deps.getSessionId(), ctx?.cwd);
    },
    /** 手动挂起当前活动工作流（供命令调用） */
    suspendActive: async (): Promise<void> => {
      const mgr = manager;
      if (!mgr) return;
      const active = mgr.getDB().getActiveWorkflow(deps.getSessionId());
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
 * 无活动工作流时的处理（方案 B：用户手动创建）：
 * detectCreate（正则初筛 + LLM 确认）→ 只提示用户可手动 /workflow-start，不自动创建
 */
async function handleNoActiveWorkflow(
  det: WorkflowDetector,
  text: string,
  ctx: { ui: { notify: (msg: string, type?: string) => void } },
): Promise<void> {
  const shouldCreate = await det.detectCreate(text);
  if (shouldCreate) {
    // 方案 B：不自动创建，提示用户手动创建
    ctx.ui.notify(
      `检测到新任务意图：「${text.slice(0, 50)}」\n如需记录为工作流，请使用 /workflow-start <标题> 创建`,
      "info",
    );
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
  ctx: { ui: { notify: (msg: string, type?: string) => void } },
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
    mgr.setStatus(workflowId, "completed", sessionId);
    mgr.recordEvent(workflowId, "completion_signal", text);
    return;
  }

  // ② 推翻信号（双分支：放弃 vs 演化）
  const reject = await det.detectReject(text);
  if (reject === "abandon") {
    mgr.setStatus(workflowId, "abandoned", sessionId);
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

  // ③ 方案确认信号 → 从计划文件同步任务 + 状态推进（计划本体在文件，不 LLM 总结入表）
  if (PLAN_CONFIRM_REGEX.test(text)) {
    mgr.recordEvent(workflowId, "plan_confirm", text);
    void mgr.syncTasksFromPlanFile(workflowId);
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

  // ⑦ 兜底：默认延续当前工作流（多数消息是讨论/执行/指示/收尾），
  // 明确全新需求信号 + LLM 确认 → 提示用户手动创建新工作流（方案 B：不自动创建）
  mgr.recordEvent(workflowId, "user_request", text);
  if (await det.detectNewRequest(text)) {
    ctx.ui.notify(
      `检测到新需求意图：「${text.slice(0, 50)}」\n如需记录为新工作流，请使用 /workflow-start <标题> 创建`,
      "info",
    );
  }
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
 * 构建续接注入内容（session_start 时调用）：
 * 存在活动工作流时，注入 最近 N 条辅助上下文
 * （verification/decisions 优先，pending 项优先）
 */
function buildResumeContext(mgr: WorkflowManager, sessionId?: string, cwd?: string): string | null {
  const dbInst = mgr.getDB();
  // 优先当前 session 的活跃工作流（指针）；无则按 cwd 找最近 in_progress（重启续接场景）
  const active = dbInst.getActiveWorkflow(sessionId) ?? dbInst.getActiveWorkflow();
  void cwd;
  if (!active) return null;
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
  if (active.plan_path) {
    lines.push(`计划文件: ${active.plan_path}（计划本体，改方案请直接编辑该文件）`);
  }
  if (active.progress) lines.push(`进度: ${active.progress}`);
  if (active.next_steps) lines.push(`下一步: ${active.next_steps}`);
  if (contextSlice.length > 0) {
    lines.push("辅助上下文:");
    for (const c of contextSlice) {
      lines.push(`  - [${c.category}${c.verified === 0 ? "待验证" : ""}] ${c.content.slice(0, 120)}`);
    }
  }
  lines.push("</workflow-resume>");
  return lines.join("\n");
}
