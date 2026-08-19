// ============================================================================
// workflow/manager.ts — 工作流管理器
//
// 功能：工作流生命周期核心逻辑（创建/状态转换/事件改动记录/方案确认回填/
//       挂起总结/隐式完成检测），全部通过 WorkflowDB 持久化
// 用途：index.ts 接线 + detector 信号检测 + 工具/命令都调用本类
// 设计：代码层零 LLM 成本操作直接做；需要语义总结的（方案确认回填/挂起总结/
//       diff 总结）调 callLLM（util/llm.ts），5s 超时失败不阻塞主流程
// ============================================================================

import {
  WorkflowDB,
  type WorkflowRow,
  type EventType,
  type ContextCategory,
  type WorkflowStatus,
  type TaskStatus,
} from "./db.js";
import { readFileSync } from "node:fs";
import { callLLM } from "../util/llm.js";
import { loadPrompts, renderPrompt } from "./prompts.js";

// ---------------------------------------------------------------------------
// WorkflowManager 类
// ---------------------------------------------------------------------------

/**
 * WorkflowManager — 工作流生命周期管理器
 *
 * @param db WorkflowDB 实例（session 生命周期跟随）
 * 职责：创建/状态机/事件记录/结构化回填/挂起总结/隐式完成检测
 */
export class WorkflowManager {
  private db: WorkflowDB;
  /** LLM 模型引用（session_start 由 index.ts 注入） */
  private model: unknown = null;
  /** 隐式完成待确认集合（内存态：pending_completion 不加新状态） */
  private pendingCompletion = new Set<number>();

  constructor(db: WorkflowDB) {
    this.db = db;
  }

  /** 设置 LLM 模型引用（index.ts session_start 调用） */
  setModel(model: unknown): void {
    this.model = model;
  }

  /** 获取数据库实例（工具/命令读取用） */
  getDB(): WorkflowDB {
    return this.db;
  }

  // ────────────────────────── 创建 ──────────────────────────

  /**
   * 创建工作流（代码层，零 LLM）
   * @param input sessionId/title/description/planPath + 图结构
   * @returns 新工作流 id
   */
  createWorkflowFromMessage(input: {
    sessionId: string;
    cwd?: string;
    title: string;
    description?: string;
    planPath?: string;
    preNodeId?: number;
    parentNodeId?: number;
    diffFromPrev?: string;
  }): number {
    return this.db.createWorkflow(input);
  }

  /**
   * 创建子工作流（parentNode 挂载）：
   * 父工作流保持 in_progress（挂起）+ 触发挂起总结
   * @returns 子工作流 id
   */
  createChildWorkflow(parentId: number, input: {
    sessionId: string;
    cwd?: string;
    title: string;
    description?: string;
    planPath?: string;
  }): number {
    const parent = this.db.getWorkflow(parentId);
    if (!parent) throw new Error(`父工作流 ${parentId} 不存在`);
    const childId = this.db.createWorkflow({
      ...input,
      parentNodeId: parentId,
    });
    // 父工作流保持 in_progress（生命周期不变，只是活跃指针移向子工作流）
    // 触发挂起总结（异步不阻塞）
    this.db.setActive(input.sessionId, childId);
    void this.suspendSummary(parentId);
    return childId;
  }

  /**
   * 创建版本演化工作流（superseded → preNode 指向旧版本）：
   * 规则 1（继承）：W'.parentNode = W.parentNode
   * 规则 2（互斥）：preNode != parentNode
   */
  createEvolutionWorkflow(prevId: number, input: {
    sessionId: string;
    cwd?: string;
    title: string;
    description?: string;
    planPath?: string;
  }): number {
    const prev = this.db.getWorkflow(prevId);
    if (!prev) throw new Error(`前版本工作流 ${prevId} 不存在`);
    const newId = this.db.createWorkflow({
      ...input,
      cwd: input.cwd ?? prev.cwd ?? undefined, // 继承父层级 cwd（规则 1）
      planPath: input.planPath ?? prev.plan_path ?? undefined, // 演化继承前版本计划文件（用户在原文件上改）
      preNodeId: prevId,
      parentNodeId: prev.parent_node_id,
    });
    if (newId === prev.parent_node_id) {
      throw new Error("preNode 与 parentNode 互斥冲突");
    }
    // 旧版本标记 superseded
    this.db.setStatus(prevId, "superseded");
    // 新版本成为当前活跃（指针）
    this.db.setActive(input.sessionId, newId);
    // 异步总结 diff_from_prev
    void this.summarizeDiff(prevId, newId);
    return newId;
  }

  // ────────────────────────── 状态转换 ──────────────────────────

  /** 状态转换（含 completed_at 记录） */
  setStatus(id: number, status: WorkflowStatus, sessionId?: string): void {
    this.db.setStatus(id, status);
    // 终态（完成/放弃）：清除活跃指针（无活跃，不自动激活别的 in_progress）
    if (sessionId && (status === "completed" || status === "abandoned")) {
      this.db.clearActive(sessionId);
    }
    if (status === "completed") {
      this.pendingCompletion.delete(id);
    }
  }

  /** 恢复工作流为活动（in_progress + setActive 指针） */
  resumeWorkflow(id: number, sessionId: string): void {
    this.db.setStatus(id, "in_progress");
    this.db.setActive(sessionId, id);
  }

  /** 隐式完成检测：标记 pending（不立即关闭，下条消息 LLM 判断） */
  markPendingCompletion(id: number): void {
    this.pendingCompletion.add(id);
  }

  /** 取消 pending 标记（下条消息判断为继续修改时） */
  clearPendingCompletion(id: number): void {
    this.pendingCompletion.delete(id);
  }

  /** 当前是否有 pending 完成待确认的工作流 */
  getPendingCompletionId(): number | undefined {
    for (const id of this.pendingCompletion) {
      if (this.db.getWorkflow(id)) return id;
    }
    return undefined;
  }

  /** 推进完成确认：true=确认完成，false=继续修改（回 in_progress） */
  async confirmPendingCompletion(id: number, confirm: boolean): Promise<void> {
    if (confirm) {
      this.setStatus(id, "completed");
    } else {
      this.db.setStatus(id, "in_progress");
      this.pendingCompletion.delete(id);
    }
  }

  // ────────────────────────── 事件记录 ──────────────────────────

  /** 追加事件（纯追加） */
  recordEvent(workflowId: number, eventType: EventType, content: string, msgId?: string): void {
    this.db.addEvent(workflowId, eventType, content, msgId);
  }

  // ────────────────────────── 方案确认（计划文件同步） ──────────────────────────

  /**
   * 方案确认时从计划文件（plan_path）解析任务分解表落库：
   * 计划本体存文件（人类可读可改），本方法只同步任务快照 + 状态推进
   * 同时状态 draft → approved（创建时若是 draft）
   *
   * @param workflowId 工作流 id
   * @returns 是否成功（无计划文件/解析失败返回 false，不阻塞）
   */
  async syncTasksFromPlanFile(workflowId: number): Promise<boolean> {
    const wf = this.db.getWorkflow(workflowId);
    if (!wf || !wf.plan_path) return false;
    let content: string;
    try {
      content = readFileSync(wf.plan_path, "utf8");
    } catch {
      return false;
    }
    const tasks = parseTaskTable(content);
    if (tasks.length > 0) this.replaceTasks(workflowId, tasks);
    // 状态推进：draft → approved
    if (wf.status === "draft") this.db.setStatus(workflowId, "approved");
    this.db.updateWorkflow(workflowId, { updated_at: new Date().toISOString() });
    return true;
  }

  /** 替换任务列表（方案确认回填 / 需求调整重写时用） */
  private replaceTasks(workflowId: number, tasks: Array<{ task_no: number; title: string; detail?: string }>): void {
    const existing = this.db.getTasks(workflowId);
    for (const t of existing) {
      this.db.updateTask(workflowId, t.task_no, { status: "cancelled" as TaskStatus });
    }
    this.db.addTasks(
      workflowId,
      tasks.map((t) => ({
        task_no: t.task_no,
        title: String(t.title),
        detail: t.detail !== undefined ? String(t.detail) : undefined,
      })),
    );
  }

  // ────────────────────────── 挂起总结 ──────────────────────────

  /**
   * 挂起总结（三时机：session_shutdown / 切换新工作流 / 手动）
   * LLM 总结 progress + next_steps，失败保留现状
   */
  async suspendSummary(workflowId: number): Promise<void> {
    if (!this.model) return;
    const wf = this.db.getWorkflow(workflowId);
    if (!wf) return;
    const events = this.db.listEvents(workflowId);
    const tasks = this.db.getTasks(workflowId);
    const evText = events
      .slice(-15)
      .map((e) => `[${e.event_type}] ${e.content}`)
      .join("\n");
    const taskText = tasks
      .map((t) => `${t.task_no}. [${t.status}] ${t.title}`)
      .join("\n");
    const prompt = renderPrompt(loadPrompts().summary, {
      tasks: taskText,
      events: evText.slice(0, 8000),
    });

    const result = await callLLM(this.model, "You respond only with valid JSON.", prompt);
    if (!result) return;
    try {
      const obj = JSON.parse(result);
      const fields: Record<string, string> = {};
      if (obj.progress !== undefined) fields.progress = String(obj.progress).slice(0, 1000);
      if (obj.next_steps !== undefined) fields.next_steps = String(obj.next_steps).slice(0, 1000);
      this.db.updateWorkflow(workflowId, fields);
    } catch {
      // 解析失败保留现状
    }
  }

  // ────────────────────────── diff 总结（superseded） ──────────────────────────

  /** 版本演化时总结 diff_from_prev（相对上一版本的需求/方案/范围变化） */
  async summarizeDiff(prevId: number, newId: number): Promise<void> {
    if (!this.model) return;
    const prev = this.db.getWorkflow(prevId);
    const next = this.db.getWorkflow(newId);
    if (!prev || !next) return;
    const prompt = renderPrompt(loadPrompts().diff, {
      prev: `${prev.title} — ${prev.description ?? ""}`,
      next: `${next.title} — ${next.description ?? ""}`,
    });

    const result = await callLLM(this.model, "You respond only with valid JSON.", prompt);
    if (!result) return;
    try {
      const obj = JSON.parse(result);
      if (obj.diff) this.db.updateWorkflow(newId, { diff_from_prev: String(obj.diff).slice(0, 1000) });
    } catch {
      // 保留现状
    }
  }

  // ────────────────────────── 辅助上下文 ──────────────────────────

  /** workflow_note：add/update/remove（匹配更新 = 同类别 + 内容重合度阈值） */
  noteContext(
    workflowId: number,
    action: "add" | "update" | "remove",
    category: ContextCategory,
    content: string,
    verified?: number,
  ): number {
    if (action === "remove") {
      // remove 需要 id 或匹配；这里用 findContextMatch 找到则删
      const matched = this.db.findContextMatch(workflowId, category, content);
      if (matched) {
        this.db.removeContext(matched.id);
        return matched.id;
      }
      return 0;
    }
    if (action === "update") {
      const matched = this.db.findContextMatch(workflowId, category, content);
      if (matched) {
        this.db.updateContext(matched.id, {
          content,
          ...(verified !== undefined ? { verified } : {}),
        });
        return matched.id;
      }
    }
    // add（或 update 未匹配到 → 视为新增）
    return this.db.addContext(workflowId, category, content, verified);
  }
}

// ---------------------------------------------------------------------------
// 计划文件解析
// ---------------------------------------------------------------------------

/**
 * 从计划文件（PLAN.md）解析任务分解表
 * 格式（plan-execute 协议）：markdown 表格 `| # | 任务 | 涉及文件 | 状态 | 备注 |`
 * 只取编号+标题（+涉及文件作 detail），状态列以数据库为准不读
 * @param content 计划文件全文
 * @returns 任务列表（解析不到返回空数组，不阻塞）
 */
function parseTaskTable(content: string): Array<{ task_no: number; title: string; detail?: string }> {
  const tasks: Array<{ task_no: number; title: string; detail?: string }> = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    // 表头（#）与分隔行（---）跳过
    if (/^#+$/.test(cells[0]) || /^-+$/.test(cells[0])) continue;
    const num = Number(cells[0]);
    if (!Number.isInteger(num) || num <= 0) continue;
    const title = cells[1].replace(/\*\*/g, "").trim();
    if (!title) continue;
    tasks.push({ task_no: num, title, detail: cells[2] ?? undefined });
  }
  return tasks;
}
