// ============================================================================
// workflow/commands.ts — 工作流保存系统：用户侧命令注册（/workflow）
//
// 功能：list/show/search/review/child/start/finish/status 共 8 个子命令
// 用途：用户侧主动控制工作流（查看/检索/手动开始结束/改变状态/创建子工作流/提炼确认）
// 设计：全部命令通过 ctx.ui.notify 输出，数据来自 WorkflowManager 的 WorkflowDB
// ============================================================================

import type { WorkflowManager } from "./manager.js";
import type { WorkflowDetector } from "./detector.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowStatus, SummaryStatus } from "./db.js";

const VALID_STATUSES: WorkflowStatus[] = ["draft", "approved", "in_progress", "completed", "abandoned", "superseded"];

/**
 * registerWorkflowCommands — 注册 /workflow 命令族
 * @param pi ExtensionAPI
 * @param getManager 获取 WorkflowManager
 * @param getDetector 获取 WorkflowDetector
 */
export function registerWorkflowCommands(
  pi: ExtensionAPI,
  getManager: () => WorkflowManager | undefined,
  getDetector: () => WorkflowDetector | undefined,
): void {
  pi.registerCommand("workflow", {
    description:
      "工作流保存系统。子命令: list [status] | show [id] | search <关键词> | review | " +
      "child <parentId> | start [title] | finish | status [新状态]",
    handler: async (args, ctx) => {
      const mgr = getManager();
      if (!mgr) {
        ctx.ui.notify("工作流系统未初始化", "error");
        return;
      }
      const dbInst = mgr.getDB();
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0];
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";

      switch (sub) {
        // ── list [status] ──
        case "list":
        case undefined:
        case "": {
          const status = (parts[1] as WorkflowStatus) || undefined;
          const rows = status && VALID_STATUSES.includes(status)
            ? dbInst.listWorkflows(status)
            : dbInst.listWorkflows();
          if (rows.length === 0) {
            ctx.ui.notify("暂无工作流记录", "info");
            return;
          }
          const lines = rows.map((w) => {
            const active = dbInst.getActiveWorkflow()?.id === w.id ? " ★" : "";
            return `#${w.id} [${w.status}] ${w.title.slice(0, 40)}${active}`;
          });
          ctx.ui.notify(`工作流 (${rows.length}):\n${lines.join("\n")}`, "info");
          return;
        }

        // ── show [id] ──
        case "show": {
          const id = parts[1] ? Number(parts[1]) : dbInst.getActiveWorkflow()?.id;
          if (!id) {
            ctx.ui.notify("无活动工作流，请指定 /workflow show <id>", "error");
            return;
          }
          const wf = dbInst.getWorkflow(id);
          if (!wf) {
            ctx.ui.notify(`工作流 #${id} 不存在`, "error");
            return;
          }
          const text = renderWorkflowRecord(mgr, wf);
          ctx.ui.notify(text.slice(0, 3000), "info");
          return;
        }

        // ── search <关键词> ──
        case "search": {
          const keyword = parts.slice(1).join(" ");
          if (!keyword) {
            ctx.ui.notify("用法: /workflow search <关键词>", "error");
            return;
          }
          const results = dbInst.searchWorkflows(keyword);
          if (results.length === 0) {
            ctx.ui.notify(`未找到含「${keyword}」的工作流`, "info");
            return;
          }
          const lines = results.map((r) => `#${r.workflow.id} [${r.workflow.status}] ${r.workflow.title.slice(0, 50)}`);
          ctx.ui.notify(`检索「${keyword}」命中 ${results.length} 个工作流:\n${lines.join("\n")}`, "info");
          return;
        }

        // ── review：提炼 draft 确认提升 ──
        case "review": {
          const drafts = dbInst.listSummaries("draft");
          if (drafts.length === 0) {
            ctx.ui.notify("暂无待确认的提炼摘要", "info");
            return;
          }
          const lines = drafts.map((s) => {
            const wf = dbInst.getWorkflow(s.workflow_id);
            return `#${s.id} [${s.summary_type}] (工作流 #${s.workflow_id} ${wf?.title ?? "?"})\n  ${s.title}\n  ${s.content.slice(0, 200)}`;
          });
          ctx.ui.notify(`提炼摘要 (${drafts.length}):\n${lines.join("\n")}\n\n确认: /workflow review <id> promote|reject`, "info");
          return;
        }

        // ── child <parentId>：手动创建子工作流 ──
        case "child": {
          const parentId = Number(parts[1]);
          if (!parentId || !dbInst.getWorkflow(parentId)) {
            ctx.ui.notify("用法: /workflow child <parentId>", "error");
            return;
          }
          const title = parts.slice(2).join(" ") || "子工作流";
          const childId = mgr.createChildWorkflow(parentId, { sessionId, title });
          ctx.ui.notify(`已创建子工作流 #${childId}（父 #${parentId}）`, "info");
          return;
        }

        // ── start [title]：手动开始工作流 ──
        case "start": {
          const existing = dbInst.getActiveWorkflow();
          if (existing) {
            ctx.ui.notify(`已有活动工作流 #${existing.id}「${existing.title.slice(0, 40)}」，可先 /workflow finish 或 /workflow status 调整`, "error");
            return;
          }
          const title = parts.slice(1).join(" ") || "未命名工作流";
          const id = mgr.createWorkflowFromMessage({ sessionId, title });
          dbInst.setStatus(id, "in_progress");
          ctx.ui.notify(`已手动开始工作流 #${id}「${title}」`, "info");
          return;
        }

        // ── finish：手动结束当前活动工作流 ──
        case "finish": {
          const active = dbInst.getActiveWorkflow();
          if (!active) {
            ctx.ui.notify("当前无活动工作流", "error");
            return;
          }
          mgr.setStatus(active.id, "completed");
          ctx.ui.notify(`工作流 #${active.id}「${active.title.slice(0, 40)}」已标记完成`, "info");
          return;
        }

        // ── status [新状态]：查看/手动改变状态 ──
        case "status": {
          const active = dbInst.getActiveWorkflow();
          if (!active) {
            ctx.ui.notify("当前无活动工作流", "error");
            return;
          }
          const newStatus = parts[1] as WorkflowStatus | undefined;
          if (!newStatus) {
            ctx.ui.notify(
              `工作流 #${active.id}「${active.title.slice(0, 40)}」\n` +
                `状态: ${active.status}\n` +
                `进度: ${active.progress ?? "（无）"}\n` +
                `下一步: ${active.next_steps ?? "（无）"}\n` +
                `改动: ${dbInst.listChanges(active.id).length} 条 | 任务: ${dbInst.getTasks(active.id).length} 个`,
              "info",
            );
            return;
          }
          if (!VALID_STATUSES.includes(newStatus)) {
            ctx.ui.notify(`无效状态: ${newStatus}。可选: ${VALID_STATUSES.join(" / ")}`, "error");
            return;
          }
          mgr.setStatus(active.id, newStatus);
          ctx.ui.notify(`工作流 #${active.id} 状态 → ${newStatus}`, "info");
          return;
        }

        default:
          ctx.ui.notify(
            "用法: /workflow [list|show|search|review|child|start|finish|status]\n" +
              "  list [status]          列出工作流\n" +
              "  show [id]              查看详情\n" +
              "  search <关键词>        全文检索\n" +
              "  review [id] promote|reject   提炼摘要确认\n" +
              "  child <parentId>       手动创建子工作流\n" +
              "  start [title]          手动开始工作流\n" +
              "  finish                 手动结束当前工作流\n" +
              "  status [新状态]        查看/改变当前工作流状态",
            "info",
          );
      }
    },
  });
}

/**
 * 渲染工作流完整记录为文本（复用 tools.ts 的渲染逻辑）
 * 注意：tools.ts 与 commands.ts 分离，这里独立实现（命令不依赖工具模块内部函数）
 */
function renderWorkflowRecord(mgr: WorkflowManager, wf: import("./db.js").WorkflowRow): string {
  const dbInst = mgr.getDB();
  const lines: string[] = [];
  lines.push(`# 工作流 #${wf.id} ${wf.title}`);
  lines.push(`状态: ${wf.status} | 创建: ${wf.created_at}`);
  if (wf.pre_node_id) lines.push(`前版本: #${wf.pre_node_id}${wf.diff_from_prev ? `（${wf.diff_from_prev}）` : ""}`);
  if (wf.parent_node_id) lines.push(`父工作流: #${wf.parent_node_id}`);
  if (wf.description) lines.push(`\n概述: ${wf.description}`);
  if (wf.background) lines.push(`背景: ${wf.background}`);
  if (wf.goal) lines.push(`目标: ${wf.goal}`);
  if (wf.approach) lines.push(`方案: ${wf.approach}`);
  if (wf.not_doing) lines.push(`不做的事: ${wf.not_doing}`);
  if (wf.risks) lines.push(`风险: ${wf.risks}`);
  if (wf.decisions_json) {
    lines.push(`决策:`);
    try {
      const decisions = JSON.parse(wf.decisions_json) as Array<{ decision: string; reason?: string }>;
      for (const d of decisions) lines.push(`  - ${d.decision}${d.reason ? `（${d.reason}）` : ""}`);
    } catch {
      lines.push(`  ${wf.decisions_json}`);
    }
  }
  if (wf.progress) lines.push(`\n进度: ${wf.progress}`);
  if (wf.next_steps) lines.push(`下一步: ${wf.next_steps}`);

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

  const changes = dbInst.listChanges(wf.id);
  if (changes.length > 0) {
    lines.push(`\n改动记录:`);
    for (const c of changes.slice(-10)) {
      lines.push(`  ${c.change_type} ${c.file_path}: ${c.summary.slice(0, 60)}`);
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
