// ============================================================================
// workflow/manager.ts — 工作流管理器
//
// 功能：工作流生命周期核心逻辑（创建/状态转换/事件改动记录/方案确认回填/
//       挂起总结/隐式完成检测），全部通过 WorkflowDB 持久化
// 用途：index.ts 接线 + detector 信号检测 + 工具/命令都调用本类
// 设计：代码层零 LLM 成本操作直接做；需要语义总结的（方案确认回填/挂起总结/
//       diff 总结）调 completeSimple，5s 超时失败不阻塞主流程
// ============================================================================

import {
  WorkflowDB,
  type WorkflowRow,
  type EventType,
  type ContextCategory,
  type ChangeType,
  type WorkflowStatus,
  type TaskStatus,
} from "./db.js";
import { completeSimple } from "@earendil-works/pi-ai/compat";

const LLM_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// WorkflowManager 类
// ---------------------------------------------------------------------------

/**
 * WorkflowManager — 工作流生命周期管理器
 *
 * @param db WorkflowDB 实例（session 生命周期跟随）
 * 职责：创建/状态机/事件改动采集/结构化回填/挂起总结/隐式完成检测
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
   * @param input sessionId/title/description/goal/background + 图结构
   * @returns 新工作流 id
   */
  createWorkflowFromMessage(input: {
    sessionId: string;
    cwd?: string;
    title: string;
    description?: string;
    background?: string;
    goal?: string;
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
  }): number {
    const parent = this.db.getWorkflow(parentId);
    if (!parent) throw new Error(`父工作流 ${parentId} 不存在`);
    const childId = this.db.createWorkflow({
      ...input,
      parentNodeId: parentId,
    });
    // 父工作流挂起总结（异步不阻塞）
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
  }): number {
    const prev = this.db.getWorkflow(prevId);
    if (!prev) throw new Error(`前版本工作流 ${prevId} 不存在`);
    const newId = this.db.createWorkflow({
      ...input,
      cwd: input.cwd ?? prev.cwd ?? undefined, // 继承父层级 cwd（规则 1）
      preNodeId: prevId,
      parentNodeId: prev.parent_node_id,
    });
    if (newId === prev.parent_node_id) {
      throw new Error("preNode 与 parentNode 互斥冲突");
    }
    // 旧版本标记 superseded
    this.db.setStatus(prevId, "superseded");
    // 异步总结 diff_from_prev
    void this.summarizeDiff(prevId, newId);
    return newId;
  }

  // ────────────────────────── 状态转换 ──────────────────────────

  /** 状态转换（含 completed_at 记录） */
  setStatus(id: number, status: WorkflowStatus): void {
    this.db.setStatus(id, status);
    if (status === "completed") {
      this.pendingCompletion.delete(id);
    }
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

  // ────────────────────────── 事件/改动记录 ──────────────────────────

  /** 追加事件（纯追加） */
  recordEvent(workflowId: number, eventType: EventType, content: string, msgId?: string): void {
    this.db.addEvent(workflowId, eventType, content, msgId);
  }

  /** 追加改动记录（自动算 prev_change_id 链） */
  recordChange(workflowId: number, filePath: string, changeType: ChangeType, summary: string, msgId?: string): void {
    this.db.addChange(workflowId, filePath, changeType, summary, msgId);
  }

  // ────────────────────────── 结构化回填（方案确认） ──────────────────────────

  /**
   * 方案确认时 LLM 总结结构化字段并回填：
   * approach/not_doing/risks/tasks/steps/file_changes/decisions_json/extra_json
   * 同时状态 draft → approved（创建时若是 draft）或保持 in_progress
   *
   * @param workflowId 工作流 id
   * @param context 最近事件流文本（LLM 总结依据）
   * @returns 是否成功（LLM 失败返回 false，不阻塞）
   */
  async fillStructuredFields(workflowId: number, context: string): Promise<boolean> {
    if (!this.model) return false;
    const wf = this.db.getWorkflow(workflowId);
    if (!wf) return false;
    const prompt = `你是工作流信息提取助手。根据下面的工作流讨论记录，提取结构化字段，只输出合法 JSON（不要 markdown 代码块）。

输出格式（全部字段必须存在，缺失用 null 或 []）：
{
  "approach": "方案/设计原则/核心取舍（字符串）",
  "not_doing": "不做的事（字符串，多条用；分隔）",
  "risks": "风险/待确认（字符串，多条用；分隔）",
  "tasks": [{"task_no": 1, "title": "任务标题", "detail": "备注（可空）"}],
  "steps": [{"order": 1, "title": "步骤标题", "detail": "细节（可空）"}],
  "file_changes": [{"file": "文件路径", "change": "改动说明"}],
  "decisions": [{"decision": "决策", "reason": "理由"}],
  "extra": {"章节名": "内容"}  // 未映射章节（如接口设计/表结构/特有设计）
}

讨论记录：
${context.slice(0, 12000)}`;

    const result = await this.callLLM(prompt);
    if (!result) return false;
    try {
      const obj = JSON.parse(result);
      const now = new Date().toISOString();
      const fields: Record<string, string> = {};
      if (obj.approach !== undefined) fields.approach = String(obj.approach);
      if (obj.not_doing !== undefined) fields.not_doing = String(obj.not_doing);
      if (obj.risks !== undefined) fields.risks = String(obj.risks);
      if (obj.decisions !== undefined && Array.isArray(obj.decisions)) {
        fields.decisions_json = JSON.stringify(obj.decisions);
      }
      if (obj.steps !== undefined) fields.steps = JSON.stringify(obj.steps);
      if (obj.file_changes !== undefined) fields.file_changes = JSON.stringify(obj.file_changes);
      if (obj.extra !== undefined && obj.extra !== null) fields.extra_json = JSON.stringify(obj.extra);
      this.db.updateWorkflow(workflowId, fields);
      // 任务落库（先清空旧任务再写入）
      if (Array.isArray(obj.tasks) && obj.tasks.length > 0) {
        this.replaceTasks(workflowId, obj.tasks);
      }
      // 状态推进：draft → approved
      if (wf.status === "draft") this.db.setStatus(workflowId, "approved");
      this.db.updateWorkflow(workflowId, { updated_at: now });
      return true;
    } catch {
      return false;
    }
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
    const prompt = `你是工作流检查点总结助手。根据工作流当前状态总结进度和下一步，只输出 JSON：
{"progress": "进度摘要（做了什么，一两句话）", "next_steps": "下一步/待办（多条用；分隔）"}

当前任务：
${taskText}

最近事件：
${evText.slice(0, 8000)}`;

    const result = await this.callLLM(prompt);
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
    const prompt = `你是工作流版本差异总结助手。对比两个版本的同一工作流，总结新版本相对旧版本的需求/方案/范围变化，输出 JSON：
{"diff": "变化描述（两三句话：需求改动/方案改动/范围增减）"}

旧版本：${prev.title} — ${prev.approach ?? ""} ${prev.description ?? ""}
新版本：${next.title} — ${next.description ?? ""}`;

    const result = await this.callLLM(prompt);
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

  // ────────────────────────── LLM 工具方法 ──────────────────────────

  /**
   * 统一 LLM 调用（5s 超时，失败返回 null）
   * @param prompt 用户提示词（系统提示固定为 JSON 输出）
   */
  private async callLLM(prompt: string): Promise<string | null> {
    if (!this.model) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const result = await completeSimple(
        this.model,
        {
          systemPrompt: "You respond only with valid JSON.",
          messages: [{ role: "user", content: prompt }],
        },
        { signal: controller.signal } as any,
      );
      const raw = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      return raw;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
