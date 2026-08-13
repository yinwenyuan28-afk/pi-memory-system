// ============================================================================
// workflow/tools.ts — 工作流保存系统：agent 侧工具注册（5 个）
//
// 功能：get_workflow_record / workflow_update /
//       workflow_task / workflow_note / workflow_context
// 用途：agent 开发中主动查询/更新工作流记录（执行时可见、续接续做、备忘记录）
// 设计：全部为按需调用（非每轮注入），数据来自 WorkflowManager 的 WorkflowDB
// ============================================================================

import type { WorkflowManager } from "./manager.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextCategory, WorkflowStatus, TaskStatus } from "./db.js";
import { readFileSync } from "node:fs";

// 辅助上下文 7 类枚举（工具描述用）
const CONTEXT_CATEGORIES = ["api", "commands", "config", "verification", "pitfalls", "decisions", "dependency"];
const WORKFLOW_STATUSES = ["draft", "approved", "in_progress", "completed", "abandoned", "superseded"];
const TASK_STATUSES = ["pending", "in-progress", "done", "blocked", "cancelled"];

/**
 * registerWorkflowTools — 注册 5 个工作流工具
 * @param pi ExtensionAPI
 * @param getManager 获取 WorkflowManager（懒引用，session 生命周期跟随）
 */
export function registerWorkflowTools(
  pi: ExtensionAPI,
  getManager: () => WorkflowManager | undefined,
): void {
  // ── ① get_workflow_record：完整记录读取 ─────────────────────────

  pi.registerTool({
    name: "get_workflow_record",
    label: "Get Workflow Record",
    description:
      "读取工作流完整记录（标准信息 + 计划正文 + 任务 + 事件流 + 辅助上下文），渲染为文本。\n" +
      "计划正文从 plan_path 文件读取（人类可读可改），库只存标准信息/执行情况/辅助信息。\n" +
      "供主代理查看详情、workflow-refiner 子代理提炼依据（子代理 agent 定义需显式允许此工具）。",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "number", description: "工作流 id（不传=当前活动工作流）" },
      },
    },
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const _sid = _ctx?.sessionManager?.getSessionId?.() ?? "";
      const mgr = getManager();
      if (!mgr) return toolError("工作流系统未初始化");
      const dbInst = mgr.getDB();
      const wf = params.workflow_id
        ? dbInst.getWorkflow(Number(params.workflow_id))
        : dbInst.getActiveWorkflow(_sid);
      if (!wf) return toolOk({ success: false, error: "工作流不存在或当前无活动工作流" });
      const text = renderWorkflowRecord(mgr, wf);
      return toolOk({ success: true, record: text });
    },
  });

  // ── ② workflow_update：更新 workflows 主表执行/标准字段 ───────────

  pi.registerTool({
    name: "workflow_update",
    label: "Workflow Update",
    description:
      "主动更新当前工作流的标准信息/执行情况字段（开发中微调用）。\n" +
      "可更新: description(标准信息)/progress/next_steps(执行情况)/plan_path(计划文件关联)。\n" +
      "计划本体（方案/风险/不做的事等）在 plan_path 指向的文件里，微调请直接 edit 计划文件。\n" +
      "不改 title（title 是工作流标识，固定不变）。",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "number", description: "工作流 id（可选，默认当前活动工作流）" },
        description: { type: "string", description: "一句话概述（标准信息）" },
        progress: { type: "string", description: "进度摘要（执行情况）" },
        next_steps: { type: "string", description: "下一步/待办（执行情况）" },
        plan_path: { type: "string", description: "计划文件绝对路径（关联/更换计划文件）" },
      },
    },
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const _sid = _ctx?.sessionManager?.getSessionId?.() ?? "";
      const mgr = getManager();
      if (!mgr) return toolError("工作流系统未初始化");
      const dbInst = mgr.getDB();
      const wf = params.workflow_id
        ? dbInst.getWorkflow(Number(params.workflow_id))
        : dbInst.getActiveWorkflow(_sid);
      if (!wf) return toolOk({ success: false, error: "工作流不存在或当前无活动工作流" });
      const allowed = ["description", "progress", "next_steps", "plan_path"] as const;
      const fields: Record<string, string> = {};
      for (const k of allowed) {
        const v = params[k as keyof typeof params];
        if (v !== undefined && v !== null) fields[k] = String(v);
      }
      if (Object.keys(fields).length === 0) {
        return toolOk({ success: false, error: "没有可更新的字段" });
      }
      dbInst.updateWorkflow(wf.id, fields);
      return toolOk({ success: true, updated: Object.keys(fields), workflow_id: wf.id });
    },
  });

  // ── ③ workflow_task：更新任务状态 ───────────────────────────────

  pi.registerTool({
    name: "workflow_task",
    label: "Workflow Task",
    description:
      "主动更新工作流任务状态（执行中任务可见：标记 done/blocked/cancelled）。" +
      "任务列表在方案确认时由系统生成，agent 执行到某步时用本工具标记进度。",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "number", description: "工作流 id（可选，默认当前活动工作流）" },
        task_no: { type: "number", description: "任务编号" },
        status: { type: "string", enum: TASK_STATUSES, description: "新状态" },
        detail: { type: "string", description: "备注（可选更新）" },
      },
      required: ["task_no", "status"],
    },
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const _sid = _ctx?.sessionManager?.getSessionId?.() ?? "";
      const mgr = getManager();
      if (!mgr) return toolError("工作流系统未初始化");
      const dbInst = mgr.getDB();
      const wf = params.workflow_id
        ? dbInst.getWorkflow(Number(params.workflow_id))
        : dbInst.getActiveWorkflow(_sid);
      if (!wf) return toolOk({ success: false, error: "工作流不存在或当前无活动工作流" });
      const fields: Record<string, string> = { status: params.status as TaskStatus };
      if (params.detail !== undefined) fields.detail = String(params.detail);
      dbInst.updateTask(wf.id, Number(params.task_no), fields);
      return toolOk({ success: true, workflow_id: wf.id, task_no: Number(params.task_no), status: params.status });
    },
  });

  // ── ④ workflow_note：辅助上下文增/改/删 ─────────────────────────

  pi.registerTool({
    name: "workflow_note",
    label: "Workflow Note",
    description:
      "记录/更新/删除当前工作流的辅助上下文（开发中主动记录的备忘，续接时注入可见）。\n" +
      "7 类: api(接口/库名→用法→参数) | commands(用途→命令) | config(配置项→值/位置→作用) |\n" +
      "verification(验证什么→怎么验→通过标准) | pitfalls(错误现象→根因→修复) |\n" +
      "decisions(决策→理由) | dependency(类/接口→包/jar 位置→一句话说明)。\n" +
      "记录时机（认知闭环完成时刻）：集成点定位成功→dependency；外部接口契约→api(未联调标 verified=0)；\n" +
      "踩坑修复闭环→pitfalls；技术选型定夺→decisions；验证通过→verification；环境配置确认→config/commands。\n" +
      "完整规则（质量标准/读取时机/示例）见 read C:/Users/leaf/.pi/agent/extensions/memory-system/workflow/prompts/workflow-note-guide.md\n" +
      "全局环境/工具事实（跨工作流通用）→ 用 memory 工具存全局记忆，本项目/本工作流特定事实才用本工具。\n" +
      "update/remove 按 category + 内容重合度匹配同一主题（补充/修正）；verified=0 表示待验证契约（续接注入优先展示）。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "update", "remove"],
          description: "add=新增（默认）；update=按 category+内容匹配更新；remove=按匹配删除",
        },
        category: {
          type: "string",
          enum: CONTEXT_CATEGORIES,
          description: "类别（7 类）",
        },
        content: { type: "string", description: "内容（按类别格式约定）" },
        verified: {
          type: "number",
          enum: [0, 1],
          description: "0=待验证契约（外部依赖联调确认项），默认 1",
        },
      },
      required: ["category", "content"],
    },
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const _sid = _ctx?.sessionManager?.getSessionId?.() ?? "";
      const mgr = getManager();
      if (!mgr) return toolError("工作流系统未初始化");
      const dbInst = mgr.getDB();
      const active = dbInst.getActiveWorkflow(_sid);
      if (!active) return toolOk({ success: false, error: "当前无活动工作流，无法记录" });
      const action = (params.action as "add" | "update" | "remove") ?? "add";
      const category = params.category as ContextCategory;
      const content = String(params.content ?? "");
      const verified = params.verified !== undefined ? Number(params.verified) : undefined;
      const id = mgr.noteContext(active.id, action, category, content, verified);
      if (action === "remove" && id === 0) {
        return toolOk({ success: false, error: "未找到匹配的辅助上下文" });
      }
      return toolOk({
        success: true,
        action,
        category,
        context_id: id,
        workflow_id: active.id,
      });
    },
  });

  // ── ⑤ workflow_context：辅助上下文查询 ─────────────────────────

  pi.registerTool({
    name: "workflow_context",
    label: "Workflow Context",
    description:
      "查询当前工作流的辅助上下文（开发中/续接时读取备忘）。\n" +
      "action=list 返回全部（可按类别过滤）；action=get 按 id 返回单条。\n" +
      "读取时机：会话重启/续接后先读全部恢复备忘；开工新子任务前查相关类别\n" +
      "（如写转换代码前先读 pitfalls 的库坑）；遇到相似需求/报错时按类别检索避免重复踩坑。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get"],
          description: "list=列表（默认）；get=单条",
        },
        category: {
          type: "string",
          enum: CONTEXT_CATEGORIES,
          description: "按类别过滤（仅 list 有效）",
        },
        id: { type: "number", description: "上下文 id（仅 get 有效）" },
      },
    },
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const _sid = _ctx?.sessionManager?.getSessionId?.() ?? "";
      const mgr = getManager();
      if (!mgr) return toolError("工作流系统未初始化");
      const dbInst = mgr.getDB();
      const active = dbInst.getActiveWorkflow(_sid);
      if (!active) return toolOk({ success: false, error: "当前无活动工作流" });
      const action = params.action ?? "list";
      if (action === "get") {
        const rows = dbInst.listContext(active.id);
        const row = rows.find((r) => r.id === Number(params.id));
        if (!row) return toolOk({ success: false, error: "上下文不存在" });
        return toolOk({ success: true, context: row });
      }
      const category = params.category as ContextCategory | undefined;
      const rows = dbInst.listContext(active.id, category);
      return toolOk({
        success: true,
        workflow_id: active.id,
        count: rows.length,
        context: rows.map((r) => ({
          id: r.id,
          category: r.category,
          content: r.content,
          verified: r.verified,
          created_at: r.created_at,
        })),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// 渲染与工具方法
// ---------------------------------------------------------------------------

/**
 * 渲染工作流完整记录为文本（get_workflow_record 返回）
 * 供 refiner 子代理 + 主代理 /workflow show 复用
 * 计划本体从 plan_path 文件读取（人类可读可改），库只存标准信息/执行情况/辅助信息
 */
function renderWorkflowRecord(mgr: WorkflowManager, wf: import("./db.js").WorkflowRow): string {
  const dbInst = mgr.getDB();
  const lines: string[] = [];
  lines.push(`# 工作流 #${wf.id} ${wf.title}`);
  lines.push(`状态: ${wf.status} | 创建: ${wf.created_at}${wf.cwd ? ` | 目录: ${wf.cwd}` : ""}`);
  if (wf.pre_node_id) lines.push(`前版本: #${wf.pre_node_id}${wf.diff_from_prev ? `（${wf.diff_from_prev}）` : ""}`);
  if (wf.parent_node_id) lines.push(`父工作流: #${wf.parent_node_id}`);
  if (wf.description) lines.push(`\n概述: ${wf.description}`);
  lines.push(wf.plan_path ? `计划文件: ${wf.plan_path}` : `计划文件: （未关联，可用 workflow_update 设置 plan_path）`);
  if (wf.progress) lines.push(`进度: ${wf.progress}`);
  if (wf.next_steps) lines.push(`下一步: ${wf.next_steps}`);

  // 计划正文（文件本体，人类可读可改）
  if (wf.plan_path) {
    let planContent: string | null = null;
    try {
      planContent = readFileSync(wf.plan_path, "utf8");
    } catch {
      planContent = null;
    }
    if (planContent !== null) {
      lines.push(`\n## 计划正文（截断 2000 字符，完整内容见文件）`);
      lines.push(planContent.slice(0, 2000));
    } else {
      lines.push(`\n计划文件不可读（路径可能已失效）: ${wf.plan_path}`);
    }
  }

  const tasks = dbInst.getTasks(wf.id);
  if (tasks.length > 0) {
    lines.push(`\n任务:`);
    for (const t of tasks) lines.push(`  ${t.task_no}. [${t.status}] ${t.title}${t.detail ? ` — ${t.detail}` : ""}`);
  }

  const events = dbInst.listEvents(wf.id);
  if (events.length > 0) {
    lines.push(`\n事件流（最近 10 条）:`);
    for (const e of events.slice(-10)) {
      lines.push(`  [${e.event_type}] ${e.content.slice(0, 100)}`);
    }
  }

  const contextRows = dbInst.listContext(wf.id);
  if (contextRows.length > 0) {
    lines.push(`\n辅助上下文:`);
    for (const c of contextRows) {
      lines.push(`  [${c.category}${c.verified === 0 ? "待验证" : ""}] ${c.content}`);
    }
  }
  return lines.join("\n");
}

/** 成功响应 */
function toolOk(obj: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    details: {},
  };
}

/** 失败响应 */
function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }],
    details: {},
  };
}
