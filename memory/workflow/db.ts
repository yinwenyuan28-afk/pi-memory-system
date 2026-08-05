// ============================================================================
// workflow/db.ts — 工作流保存系统：SQLite 数据库层
//
// 功能：连接管理 + 建表（6 张表 + 索引）+ 全部 CRUD 方法
// 用途：工作流保存系统的唯一数据访问入口，manager/detector/工具/命令均通过
//       本类读写 workflows.db
// 技术：node:sqlite 内置 DatabaseSync（零 native 依赖），WAL + busy_timeout
//       应对多进程并发写（后台子代理 + 主代理同时读写）
// ============================================================================

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// 类型定义（与计划表结构 v3 一致）
// ---------------------------------------------------------------------------

/** 工作流状态：6 态 */
export type WorkflowStatus =
  | "draft"
  | "approved"
  | "in_progress"
  | "completed"
  | "abandoned"
  | "superseded";

/** 任务状态 */
export type TaskStatus = "pending" | "in-progress" | "done" | "blocked" | "cancelled";

/** 事件类型 */
export type EventType =
  | "user_request"
  | "plan_confirm"
  | "execution_start"
  | "completion_signal"
  | "rejection_signal";

/** 改动类型 */
export type ChangeType = "edit" | "write" | "remove";

/** 辅助上下文类别：7 类 */
export type ContextCategory =
  | "api"
  | "commands"
  | "config"
  | "verification"
  | "pitfalls"
  | "decisions"
  | "dependency";

/** 提炼结果类型 */
export type SummaryType = "memory" | "skill";
export type SummaryStatus = "draft" | "promoted" | "rejected";

// ---------------------------------------------------------------------------
// 建表 SQL（6 张表 + 全部索引）
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
-- ① 工作流主表（对应 PLAN.md 标准章节 + 图结构）
CREATE TABLE IF NOT EXISTS workflows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  background    TEXT,
  goal          TEXT,
  approach      TEXT,
  decisions_json TEXT,
  steps         TEXT,
  file_changes  TEXT,
  not_doing     TEXT,
  risks         TEXT,
  extra_json    TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  pre_node_id   INTEGER,
  diff_from_prev TEXT,
  parent_node_id INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  completed_at  TEXT,
  refined       INTEGER NOT NULL DEFAULT 0,
  progress      TEXT,
  next_steps    TEXT
);

-- ② 任务步骤表（对应 PLAN 任务分解表）
CREATE TABLE IF NOT EXISTS workflow_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  task_no     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  detail      TEXT,
  updated_at  TEXT
);

-- ③ 事件表（讨论过程：用户消息流）
CREATE TABLE IF NOT EXISTS workflow_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  content     TEXT NOT NULL,
  msg_id      TEXT,
  created_at  TEXT NOT NULL
);

-- ④ 改动记录表（执行细节：每次 edit/write 一条，代码层提取）
CREATE TABLE IF NOT EXISTS workflow_changes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id    INTEGER NOT NULL,
  file_path      TEXT NOT NULL,
  change_type    TEXT NOT NULL,
  summary        TEXT NOT NULL,
  msg_id         TEXT,
  prev_change_id INTEGER,
  created_at     TEXT NOT NULL
);

-- ⑤ 辅助上下文表（开发中 agent 主动记录）
CREATE TABLE IF NOT EXISTS workflow_context (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  category    TEXT NOT NULL,
  content     TEXT NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- ⑥ 提炼结果表
CREATE TABLE IF NOT EXISTS workflow_summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  INTEGER NOT NULL,
  summary_type TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  created_at   TEXT NOT NULL
);

-- 索引（M3 修复：events/tasks/summaries/context 缺索引，查询全表扫描）
CREATE INDEX IF NOT EXISTS idx_workflows_status    ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_pre_node  ON workflows(pre_node_id);
CREATE INDEX IF NOT EXISTS idx_workflows_parent    ON workflows(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow      ON workflow_tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_events_workflow     ON workflow_events(workflow_id);
CREATE INDEX IF NOT EXISTS idx_changes_workflow    ON workflow_changes(workflow_id);
CREATE INDEX IF NOT EXISTS idx_changes_file        ON workflow_changes(file_path);
CREATE INDEX IF NOT EXISTS idx_context_workflow    ON workflow_context(workflow_id);
CREATE INDEX IF NOT EXISTS idx_summaries_workflow  ON workflow_summaries(workflow_id);
`;

// ---------------------------------------------------------------------------
// WorkflowDB 类
// ---------------------------------------------------------------------------

/**
 * WorkflowDB — SQLite 数据库层
 *
 * @param profilePath 活动 profile 目录（workflows.db 存放于此）
 * 生命周期：session_start 时构造；/profile switch 时旧实例 close、新实例重建
 */
export class WorkflowDB {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(profilePath: string) {
    mkdirSync(profilePath, { recursive: true });
    this.dbPath = join(profilePath, "workflows.db");
    this.db = new DatabaseSync(this.dbPath);
    // WAL + busy_timeout：多进程并发写（后台审查子代理 + 主代理）安全
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA_SQL);
  }

  /** 关闭数据库连接（profile 切换时调用） */
  close(): void {
    try {
      this.db.close();
    } catch {
      // 已关闭则忽略
    }
  }

  /** 获取数据库文件路径（调试/展示用） */
  getPath(): string {
    return this.dbPath;
  }

  // ────────────────────────── workflows 主表 ──────────────────────────

  /**
   * 创建工作流
   * @param input 创建字段（title/description/goal/background + 图结构）
   * @returns 新工作流 id
   */
  createWorkflow(input: {
    sessionId: string;
    title: string;
    description?: string;
    background?: string;
    goal?: string;
    preNodeId?: number;
    parentNodeId?: number;
    diffFromPrev?: string;
  }): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO workflows
        (session_id, title, description, background, goal, status,
         pre_node_id, diff_from_prev, parent_node_id, created_at, updated_at, refined)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 0)`,
    );
    const result = stmt.run(
      input.sessionId,
      input.title,
      input.description ?? null,
      input.background ?? null,
      input.goal ?? null,
      input.preNodeId ?? null,
      input.diffFromPrev ?? null,
      input.parentNodeId ?? null,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  /** 按 id 读取工作流 */
  getWorkflow(id: number): WorkflowRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM workflows WHERE id = ?")
      .get(id) as WorkflowRow | undefined;
    return row;
  }

  /** 更新工作流行数据（需求/方案调整只 UPDATE 行，不建 preNode） */
  updateWorkflow(id: number, fields: Partial<Record<string, string | number | null>>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (fields as Record<string, unknown>)[k]);
    this.db
      .prepare(`UPDATE workflows SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...values, new Date().toISOString(), id);
  }

  /** 转换状态（含 completed_at 记录） */
  setStatus(id: number, status: WorkflowStatus): void {
    const now = new Date().toISOString();
    if (status === "completed") {
      this.db
        .prepare("UPDATE workflows SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?")
        .run(status, now, now, id);
    } else {
      this.db
        .prepare("UPDATE workflows SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, id);
    }
  }

  /** 列表查询（可按状态过滤） */
  listWorkflows(status?: WorkflowStatus): WorkflowRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM workflows WHERE status = ? ORDER BY created_at DESC")
        .all(status) as WorkflowRow[];
    }
    return this.db
      .prepare("SELECT * FROM workflows ORDER BY created_at DESC")
      .all() as WorkflowRow[];
  }

  /**
   * 获取当前活动工作流（last_active 指针语义的简化实现）
   * 活动 = 未进入终态（非 completed/abandoned/superseded），取最近更新的一个
   */
  getActiveWorkflow(): WorkflowRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM workflows
         WHERE status NOT IN ('completed', 'abandoned', 'superseded')
         ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1`,
      )
      .get() as WorkflowRow | undefined;
  }

  /**
   * 全文检索工作流（检索范围覆盖全部 TEXT 字段 + events + context + changes summary）
   * —— 真实案例分析采纳：高价值业务设计（表结构/接口/状态机）存 extra_json 后仍可检索
   */
  searchWorkflows(keyword: string): Array<{ workflow: WorkflowRow; match: string }> {
    const kw = `%${keyword}%`;
    const rows = this.db
      .prepare(
        `SELECT w.*, 'workflows' AS match_src,
                COALESCE(w.title,'') || ' ' || COALESCE(w.description,'') || ' ' ||
                COALESCE(w.background,'') || ' ' || COALESCE(w.goal,'') || ' ' ||
                COALESCE(w.approach,'') || ' ' || COALESCE(w.decisions_json,'') || ' ' ||
                COALESCE(w.steps,'') || ' ' || COALESCE(w.file_changes,'') || ' ' ||
                COALESCE(w.not_doing,'') || ' ' || COALESCE(w.risks,'') || ' ' ||
                COALESCE(w.extra_json,'') || ' ' || COALESCE(w.diff_from_prev,'') || ' ' ||
                COALESCE(w.progress,'') || ' ' || COALESCE(w.next_steps,'') AS blob_all
         FROM workflows w
         WHERE COALESCE(w.title,'') LIKE ? OR COALESCE(w.description,'') LIKE ?
            OR COALESCE(w.background,'') LIKE ? OR COALESCE(w.goal,'') LIKE ?
            OR COALESCE(w.approach,'') LIKE ? OR COALESCE(w.decisions_json,'') LIKE ?
            OR COALESCE(w.steps,'') LIKE ? OR COALESCE(w.file_changes,'') LIKE ?
            OR COALESCE(w.not_doing,'') LIKE ? OR COALESCE(w.risks,'') LIKE ?
            OR COALESCE(w.extra_json,'') LIKE ? OR COALESCE(w.diff_from_prev,'') LIKE ?
            OR COALESCE(w.progress,'') LIKE ? OR COALESCE(w.next_steps,'') LIKE ?
            OR EXISTS (SELECT 1 FROM workflow_events e WHERE e.workflow_id = w.id AND e.content LIKE ?)
            OR EXISTS (SELECT 1 FROM workflow_context c WHERE c.workflow_id = w.id AND c.content LIKE ?)
            OR EXISTS (SELECT 1 FROM workflow_changes ch WHERE ch.workflow_id = w.id AND ch.summary LIKE ?)`,
      )
      .all(...Array(14).fill(kw), kw, kw, kw) as Array<WorkflowRow & { match_src: string }>;
    return rows.map((r) => ({
      workflow: {
        id: r.id,
        session_id: r.session_id,
        title: r.title,
        description: r.description,
        background: r.background,
        goal: r.goal,
        approach: r.approach,
        decisions_json: r.decisions_json,
        steps: r.steps,
        file_changes: r.file_changes,
        not_doing: r.not_doing,
        risks: r.risks,
        extra_json: r.extra_json,
        status: r.status,
        pre_node_id: r.pre_node_id,
        diff_from_prev: r.diff_from_prev,
        parent_node_id: r.parent_node_id,
        created_at: r.created_at,
        updated_at: r.updated_at,
        completed_at: r.completed_at,
        refined: r.refined,
        progress: r.progress,
        next_steps: r.next_steps,
      },
      match: r.match_src,
    }));
  }

  // ────────────────────────── workflow_tasks ──────────────────────────

  /** 批量添加任务（方案确认时 LLM 生成任务分解） */
  addTasks(workflowId: number, tasks: Array<{ task_no: number; title: string; detail?: string }>): void {
    const stmt = this.db.prepare(
      "INSERT INTO workflow_tasks (workflow_id, task_no, title, status, detail, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    );
    const now = new Date().toISOString();
    for (const t of tasks) {
      stmt.run(workflowId, t.task_no, t.title, t.detail ?? null, now);
    }
  }

  /** 读取任务列表 */
  getTasks(workflowId: number): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM workflow_tasks WHERE workflow_id = ? ORDER BY task_no")
      .all(workflowId) as TaskRow[];
  }

  /** 更新任务字段（agent 执行中主动更新状态/备注） */
  updateTask(workflowId: number, taskNo: number, fields: Partial<Record<string, string | null>>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (fields as Record<string, unknown>)[k]);
    this.db
      .prepare(`UPDATE workflow_tasks SET ${sets}, updated_at = ? WHERE workflow_id = ? AND task_no = ?`)
      .run(...values, new Date().toISOString(), workflowId, taskNo);
  }

  /** 检查是否全部任务完成（隐式完成检测用） */
  allTasksDone(workflowId: number): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM workflow_tasks WHERE workflow_id = ?")
      .get(workflowId) as { total: number; done: number | null };
    return row.total > 0 && row.done === row.total;
  }

  // ────────────────────────── workflow_events ──────────────────────────

  /** 追加事件（纯追加，无更新） */
  addEvent(workflowId: number, eventType: EventType, content: string, msgId?: string): void {
    this.db
      .prepare("INSERT INTO workflow_events (workflow_id, event_type, content, msg_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(workflowId, eventType, content.slice(0, 500), msgId ?? null, new Date().toISOString());
  }

  /** 读取事件流 */
  listEvents(workflowId: number): EventRow[] {
    return this.db
      .prepare("SELECT * FROM workflow_events WHERE workflow_id = ? ORDER BY id")
      .all(workflowId) as EventRow[];
  }

  // ────────────────────────── workflow_changes ──────────────────────────

  /**
   * 追加改动记录（append-only），自动计算 prev_change_id
   * prev_change_id = 该文件在本次改动之前的最近一次改动 id（跨工作流，NULL=链首）
   */
  addChange(workflowId: number, filePath: string, changeType: ChangeType, summary: string, msgId?: string): void {
    // 找该文件最近一次改动（任意工作流）
    const prev = this.db
      .prepare(
        "SELECT id FROM workflow_changes WHERE file_path = ? ORDER BY id DESC LIMIT 1",
      )
      .get(filePath) as { id: number } | undefined;
    this.db
      .prepare(
        "INSERT INTO workflow_changes (workflow_id, file_path, change_type, summary, msg_id, prev_change_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        workflowId,
        filePath,
        changeType,
        summary.slice(0, 200),
        msgId ?? null,
        prev?.id ?? null,
        new Date().toISOString(),
      );
  }

  /** 读取改动记录（可按文件过滤；不传 file_path = 全部，按 prev_change_id 链语义排序） */
  listChanges(workflowId: number, filePath?: string): ChangeRow[] {
    if (filePath) {
      return this.db
        .prepare("SELECT * FROM workflow_changes WHERE workflow_id = ? AND file_path = ? ORDER BY id")
        .all(workflowId, filePath) as ChangeRow[];
    }
    return this.db
      .prepare("SELECT * FROM workflow_changes WHERE workflow_id = ? ORDER BY id")
      .all(workflowId) as ChangeRow[];
  }

  /** 读取某文件的全量改动链（跨工作流，按 prev_change_id 指针链排序：旧 → 新） */
  getFileChangeChain(filePath: string): ChangeRow[] {
    const rows = this.db
      .prepare("SELECT * FROM workflow_changes WHERE file_path = ? ORDER BY id")
      .all(filePath) as ChangeRow[];
    // prev_change_id 指向"前一次同文件改动"：构建 nextByPrev 从链首正向遍历
    const nextByPrev = new Map<number, ChangeRow>();
    for (const r of rows) {
      if (r.prev_change_id !== null) nextByPrev.set(r.prev_change_id, r);
    }
    const chain: ChangeRow[] = [];
    const visited = new Set<number>();
    for (const start of rows) {
      if (start.prev_change_id !== null) continue; // 非链首跳过（从链首开始）
      if (visited.has(start.id)) continue;
      let cur: ChangeRow | undefined = start;
      while (cur && !visited.has(cur.id)) {
        chain.push(cur);
        visited.add(cur.id);
        cur = nextByPrev.get(cur.id);
      }
    }
    return chain;
  }

  // ────────────────────────── workflow_context ──────────────────────────

  /** 新增辅助上下文 */
  addContext(workflowId: number, category: ContextCategory, content: string, verified?: number): number {
    const result = this.db
      .prepare("INSERT INTO workflow_context (workflow_id, category, content, verified, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(workflowId, category, content, verified ?? 1, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  /** 更新辅助上下文 */
  updateContext(id: number, fields: Partial<Record<string, string | number>>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (fields as Record<string, unknown>)[k]);
    this.db.prepare(`UPDATE workflow_context SET ${sets} WHERE id = ?`).run(...values, id);
  }

  /** 删除辅助上下文 */
  removeContext(id: number): void {
    this.db.prepare("DELETE FROM workflow_context WHERE id = ?").run(id);
  }

  /** 读取辅助上下文（可按类别过滤） */
  listContext(workflowId: number, category?: ContextCategory): ContextRow[] {
    if (category) {
      return this.db
        .prepare("SELECT * FROM workflow_context WHERE workflow_id = ? AND category = ? ORDER BY id DESC")
        .all(workflowId, category) as ContextRow[];
    }
    return this.db
      .prepare("SELECT * FROM workflow_context WHERE workflow_id = ? ORDER BY id DESC")
      .all(workflowId) as ContextRow[];
  }

  /**
   * 按 category + 内容匹配查找辅助上下文（补充/修正同一主题）
   * 匹配规则：同类别 + 字符重合度（bag 不取重）>= 0.6；子串包含直接匹配
   */
  findContextMatch(workflowId: number, category: ContextCategory, content: string): ContextRow | undefined {
    const rows = this.db
      .prepare("SELECT * FROM workflow_context WHERE workflow_id = ? AND category = ?")
      .all(workflowId, category) as ContextRow[];
    const norm = (s: string) => s.replace(/\s+/g, "");
    const target = norm(content);
    let best: ContextRow | undefined;
    let bestScore = 0;
    for (const r of rows) {
      const a = norm(r.content);
      if (!a) continue;
      // 子串包含 → 直接命中
      if (target.includes(a) || a.includes(target)) {
        return r;
      }
      // 字符 bag 重合度（不去重，对称归一化）
      const common = [...target].filter((c) => a.includes(c)).length;
      const score = common / Math.max(a.length, target.length, 1);
      if (score >= 0.6 && score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    return best;
  }

  // ────────────────────────── workflow_summaries ──────────────────────────

  /** 新增提炼摘要（只写 draft） */
  addSummary(workflowId: number, summaryType: SummaryType, title: string, content: string): number {
    const result = this.db
      .prepare("INSERT INTO workflow_summaries (workflow_id, summary_type, title, content, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)")
      .run(workflowId, summaryType, title, content, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  /** 读取提炼摘要（可按状态过滤） */
  listSummaries(status?: SummaryStatus): SummaryRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM workflow_summaries WHERE status = ? ORDER BY created_at DESC")
        .all(status) as SummaryRow[];
    }
    return this.db
      .prepare("SELECT * FROM workflow_summaries ORDER BY created_at DESC")
      .all() as SummaryRow[];
  }

  /** 更新提炼摘要状态（/workflow review 确认提升） */
  updateSummaryStatus(id: number, status: SummaryStatus): void {
    this.db.prepare("UPDATE workflow_summaries SET status = ? WHERE id = ?").run(status, id);
  }
}

// ---------------------------------------------------------------------------
// 行类型定义
// ---------------------------------------------------------------------------

export interface WorkflowRow {
  id: number;
  session_id: string;
  title: string;
  description: string | null;
  background: string | null;
  goal: string | null;
  approach: string | null;
  decisions_json: string | null;
  steps: string | null;
  file_changes: string | null;
  not_doing: string | null;
  risks: string | null;
  extra_json: string | null;
  status: WorkflowStatus;
  pre_node_id: number | null;
  diff_from_prev: string | null;
  parent_node_id: number | null;
  created_at: string;
  updated_at: string | null;
  completed_at: string | null;
  refined: number;
  progress: string | null;
  next_steps: string | null;
}

export interface TaskRow {
  id: number;
  workflow_id: number;
  task_no: number;
  title: string;
  status: TaskStatus;
  detail: string | null;
  updated_at: string | null;
}

export interface EventRow {
  id: number;
  workflow_id: number;
  event_type: EventType;
  content: string;
  msg_id: string | null;
  created_at: string;
}

export interface ChangeRow {
  id: number;
  workflow_id: number;
  file_path: string;
  change_type: ChangeType;
  summary: string;
  msg_id: string | null;
  prev_change_id: number | null;
  created_at: string;
}

export interface ContextRow {
  id: number;
  workflow_id: number;
  category: ContextCategory;
  content: string;
  verified: number;
  created_at: string;
}

export interface SummaryRow {
  id: number;
  workflow_id: number;
  summary_type: SummaryType;
  title: string;
  content: string;
  status: SummaryStatus;
  created_at: string;
}
