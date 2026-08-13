// ============================================================================
// workflow/commands.ts — 工作流保存系统：用户侧命令注册（/workflow-* 命令族）
//
// 功能：workflow-list/show/search/review/child/start/finish/suspend/status
//       共 9 个独立命令（TUI autocomplete 输入 /workflow- 提示全部）
// 用途：用户侧主动控制工作流（查看/检索/手动开始结束/挂起/改变状态/创建子工作流/提炼确认）
// 设计：全部命令通过 ctx.ui.notify 输出，数据来自 WorkflowManager 的 WorkflowDB
// ============================================================================

import type { WorkflowManager } from "./manager.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowStatus, SummaryStatus, WorkflowRow } from "./db.js";
import { readFileSync, existsSync } from "node:fs";

const VALID_STATUSES: WorkflowStatus[] = ["draft", "approved", "in_progress", "completed", "abandoned", "superseded", "suspended"];

/** 公共上下文（命令 handler 统一取 manager/db/sessionId） */
function getCommon(getManager: () => WorkflowManager | undefined, ctx: { ui: { notify: (msg: string, type?: string) => void } }) {
  const mgr = getManager();
  if (!mgr) {
    ctx.ui.notify("工作流系统未初始化", "error");
    return undefined;
  }
  return {
    mgr,
    dbInst: mgr.getDB(),
    sessionId: ctx.sessionManager?.getSessionId?.() ?? "",
  };
}

/**
 * registerWorkflowCommands — 注册 /workflow-* 命令族（9 个独立命令）
 * @param pi ExtensionAPI
 * @param getManager 获取 WorkflowManager
 * @param getDetector 获取 WorkflowDetector
 */
export function registerWorkflowCommands(
  pi: ExtensionAPI,
  getManager: () => WorkflowManager | undefined,
  getDetector: () => WorkflowDetector | undefined,
): void {
  void getDetector;

  // ── /workflow-list [status] ─────────────────────────────────

  pi.registerCommand("workflow-list", {
    description: "列出工作流（可按状态过滤）。用法: /workflow-list [status]",
    handler: async (args, ctx) => {
      const common = getCommon(getManager, ctx);
      if (!common) return;
      const { dbInst } = common;
      const parts = (args || "").trim().split(/\s+/);
      const status = (parts[0] as WorkflowStatus) || undefined;
      const rows = status && VALID_STATUSES.includes(status)
        ? dbInst.listWorkflows(status)
        : dbInst.listWorkflows();
      if (rows.length === 0) {
        ctx.ui.notify("暂无工作流记录", "info");
        return;
      }
      const lines = rows.map((w) => {
        const active = dbInst.getActiveWorkflow(common.sessionId)?.id === w.id ? " ★" : "";
        const dir = w.cwd ? ` @ ${w.cwd.split(/[/\\]/).slice(-2).join("/")}` : "";
        return `#${w.id} [${w.status}] ${w.title.slice(0, 40)}${dir}${active}`;
      });
      ctx.ui.notify(`工作流 (${rows.length}):\n${lines.join("\n")}`, "info");
    },
  });

  // ── /workflow-show [id] ─────────────────────────────────────

  pi.registerCommand("workflow-show", {
    description: "查看工作流详情。用法: /workflow-show [id]",
    handler: async (args, ctx) => {
      const common = getCommon(getManager, ctx);
      if (!common) return;
      const { dbInst } = common;
      const parts = (args || "").trim().split(/\s+/);
      const id = parts[0] ? Number(parts[0]) : dbInst.getActiveWorkflow(common.sessionId)?.id;
      if (!id) {
        ctx.ui.notify("无活动工作流，请指定 /workflow-show <id>", "error");
        return;
      }
      const wf = dbInst.getWorkflow(id);
      if (!wf) {
        ctx.ui.notify(`工作流 #${id} 不存在`, "error");
        return;
      }
      ctx.ui.notify(renderWorkflowRecord(common.mgr, wf).slice(0, 6000), "info");
    },
  });

  // ── /workflow-search <关键词> ───────────────────────────────

  pi.registerCommand("workflow-search", {
    description: "全文检索工作流。用法: /workflow-search <关键词>",
    handler: async (args, ctx) => {
      const common = getCommon(getManager, ctx);
      if (!common) return;
      const { dbInst } = common;
      const keyword = (args || "").trim();
      if (!keyword) {
        ctx.ui.notify("用法: /workflow-search <关键词>", "error");
        return;
      }
      const results = dbInst.searchWorkflows(keyword);
      // 补充检索：计划文件正文全文匹配（计划本体在文件系统，不入库）
      const all = dbInst.listWorkflows();
      const fileMatches: Array<{ workflow: WorkflowRow; match: string }> = [];
      for (const w of all) {
        if (!w.plan_path || !existsSync(w.plan_path)) continue;
        try {
          if (readFileSync(w.plan_path, "utf8").includes(keyword)) {
            fileMatches.push({ workflow: w, match: "plan_file" });
          }
        } catch {
          // 文件不可读则跳过
        }
      }
      const seen = new Set(results.map((r) => r.workflow.id));
      for (const fm of fileMatches) {
        if (!seen.has(fm.workflow.id)) results.push(fm);
      }
      if (results.length === 0) {
        ctx.ui.notify(`未找到含「${keyword}」的工作流`, "info");
        return;
      }
      const lines = results.map((r) => `#${r.workflow.id} [${r.workflow.status}] ${r.workflow.title.slice(0, 50)}`);
      ctx.ui.notify(`检索「${keyword}」命中 ${results.length} 个工作流:\n${lines.join("\n")}`, "info");
    },
  });

  // ── /workflow-review [id] promote|reject ───────────────────

  pi.registerCommand("workflow-review", {
    description: "查看/确认提炼摘要。用法: /workflow-review（列出 draft）| /workflow-review <id> promote|reject",
    handler: async (args, ctx) => {
      const common = getCommon(getManager, ctx);
      if (!common) return;
      const { dbInst } = common;
      const parts = (args || "").trim().split(/\s+/);
      // 带参数：确认提升/拒绝
      if (parts.length >= 2) {
        const id = Number(parts[0]);
        const action = parts[1] as SummaryStatus;
        if (!id || (action !== "promote" && action !== "reject")) {
          ctx.ui.notify("用法: /workflow-review <id> promote|reject", "error");
          return;
        }
        dbInst.updateSummaryStatus(id, action);
        ctx.ui.notify(`提炼摘要 #${id} → ${action}`, "info");
        return;
      }
      // 无参数：列出 draft
      const drafts = dbInst.listSummaries("draft");
      if (drafts.length === 0) {
        ctx.ui.notify("暂无待确认的提炼摘要", "info");
        return;
      }
      const lines = drafts.map((s) => {
        const wf = dbInst.getWorkflow(s.workflow_id);
        return `#${s.id} [${s.summary_type}] (工作流 #${s.workflow_id} ${wf?.title ?? "?"})\n  ${s.title}\n  ${s.content.slice(0, 200)}`;
      });
      ctx.ui.notify(`提炼摘要 (${drafts.length}):\n${lines.join("\n")}\n\n确认: /workflow-review <id> promote|reject`, "info");
    },
  });

  // ── /workflow-child <parentId> [title] ──────────────────────

  pi.registerCommand("workflow-child", {
    description: "手动创建子工作流（parentNode 挂载）。用法: /workflow-child <parentId> [title]",
    handler: async (args, ctx) => {
      const common = getCommon(getManager, ctx);
      if (!common) return;
      const { dbInst, mgr, sessionId } = common;
      const parts = (args || "").trim().split(/\s+/);
      const parentId = Number(parts[0]);
      if (!parentId || !dbInst.getWorkflow(parentId)) {
        ctx.ui.notify("用法: /workflow-child <parentId>", "error");
        return;
      }
      const title = parts.slice(1).join(" ") || "子工作流";
      const childId = mgr.createChildWorkflow(parentId, { sessionId, title });
      ctx.ui.notify(`已创建子工作流 #${childId}（父 #${parentId}）`, "info");
    },
  });

  // ── /workflow-start [title] ─────────────────────────────────

  pi.registerCommand("workflow-start", {
    description: "手动开始工作流。用法: /workflow-start [title] [--plan <计划文件路径>]",
    handler: async (args, ctx) => {
      const common = getCommon(getManager, ctx);
      if (!common) return;
      const { dbInst, mgr, sessionId } = common;
      const existing = dbInst.getActiveWorkflow(common.sessionId);
      if (existing) {
        ctx.ui.notify(`已有活动工作流 #${existing.id}「${existing.title.slice(0, 40)}」，可先 /workflow-finish 或 /workflow-suspend 调整`, "error");
        return;
      }
      // 解析 [title] [--plan <path>]：title 可含空格，--plan 显式关联计划文件
      const argsStr = (args || "").trim();
      let title = argsStr;
      let planPath: string | undefined;
      const planMatch = argsStr.match(/\s--plan\s+(.+)$/);
      if (planMatch) {
        planPath = planMatch[1].trim();
        title = argsStr.slice(0, planMatch.index).trim();
      }
      title = title || "未命名工作流";
      const id = mgr.createWorkflowFromMessage({ sessionId, title, planPath });
      dbInst.setStatus(id, "in_progress");
      dbInst.setActive(common.sessionId, id);
      ctx.ui.notify(`已手动开始工作流 #${id}「${title}」${planPath ? `\n计划文件: ${planPath}` : ""}`, "info");
    },
  });

  // ── /workflow-finish ────────────────────────────────────────

  pi.registerCommand("workflow-finish", {
    description: "手动结束当前活动工作流（→ completed）。用法: /workflow-finish",
    handler: async (_args, ctx) => {
      const common = getCommon(getManager, ctx);
      if (!common) return;
      const { dbInst, mgr } = common;
      const active = dbInst.getActiveWorkflow(common.sessionId);
      if (!active) {
        ctx.ui.notify("当前无活动工作流", "error");
        return;
      }
      mgr.setStatus(active.id, "completed", common.sessionId);
      ctx.ui.notify(`工作流 #${active.id}「${active.title.slice(0, 40)}」已标记完成`, "info");
    },
  });

  // ── /workflow-suspend：挂起当前活动工作流（无活跃） ────────

  pi.registerCommand("workflow-suspend", {
    description: "挂起当前活动工作流（只清活跃指针，不改生命周期 status）。用法: /workflow-suspend",
    handler: async (_args, ctx) => {
      const common = getCommon(getManager, ctx);
      if (!common) return;
      const { dbInst, mgr } = common;
      const active = dbInst.getActiveWorkflow(common.sessionId);
      if (!active) {
        ctx.ui.notify("当前无活动工作流", "error");
        return;
      }
      // 方案 B 扩展：挂起只清当前 session 的活跃指针，不改生命周期 status
      dbInst.clearActive(common.sessionId);
      ctx.ui.notify(`工作流 #${active.id}「${active.title.slice(0, 40)}」已移出活跃（生命周期状态不变）`, "info");
    },
  });

  // ── /workflow-active <id>：将当前 session 的活跃指针指向指定工作流 ──

  pi.registerCommand("workflow-active", {
    description: "将当前 session 的活跃指针指向指定工作流。用法: /workflow-active <id>",
    handler: async (args, ctx) => {
      const common = getCommon(getManager, ctx);
      if (!common) return;
      const { dbInst } = common;
      const id = Number((args || "").trim());
      if (!id) {
        ctx.ui.notify("用法: /workflow-active <id>", "error");
        return;
      }
      const wf = dbInst.getWorkflow(id);
      if (!wf) {
        ctx.ui.notify(`工作流 #${id} 不存在`, "error");
        return;
      }
      if (wf.status === "completed" || wf.status === "abandoned" || wf.status === "superseded") {
        ctx.ui.notify(`工作流 #${id} 已是终态（${wf.status}），不能设为活跃`, "error");
        return;
      }
      dbInst.setActive(common.sessionId, id);
      ctx.ui.notify(`活跃指针 → 工作流 #${id}「${wf.title.slice(0, 40)}」`, "info");
    },
  });

  // ── /workflow-status [id] [新状态] ─────────────────────────

  pi.registerCommand("workflow-status", {
    description:
      "查看/恢复/改变工作流状态。用法: /workflow-status（当前活跃）| /workflow-status <id> | /workflow-status <id> <新状态>",
    handler: async (args, ctx) => {
      const common = getCommon(getManager, ctx);
      if (!common) return;
      const { dbInst, mgr } = common;
      const parts = (args || "").trim().split(/\s+/);
      // 支持 /workflow-status <id> [新状态]（恢复挂起的工作流）
      const firstArg = parts[0];
      const firstIsId = firstArg !== undefined && /^\d+$/.test(firstArg);
      if (firstIsId) {
        const targetId = Number(firstArg);
        const target = dbInst.getWorkflow(targetId);
        if (!target) {
          ctx.ui.notify(`工作流 #${targetId} 不存在`, "error");
          return;
        }
        const newStatus = parts[1] as WorkflowStatus | undefined;
        if (!newStatus) {
          ctx.ui.notify(
            `工作流 #${target.id}「${target.title.slice(0, 40)}」\n` +
              `状态: ${target.status}\n` +
              `计划: ${target.plan_path ?? "（未关联）"}\n` +
              `进度: ${target.progress ?? "（无）"}\n` +
              `下一步: ${target.next_steps ?? "（无）"}\n` +
              `任务: ${dbInst.getTasks(target.id).length} 个`,
            "info",
          );
          return;
        }
        if (!VALID_STATUSES.includes(newStatus)) {
          ctx.ui.notify(`无效状态: ${newStatus}。可选: ${VALID_STATUSES.join(" / ")}`, "error");
          return;
        }
        if (newStatus === "in_progress") {
          // 恢复为活动：自动挂起其他活动工作流
          mgr.resumeWorkflow(targetId, common.sessionId);
        } else {
          mgr.setStatus(targetId, newStatus, common.sessionId);
        }
        ctx.ui.notify(`工作流 #${targetId} 状态 → ${newStatus}`, "info");
        return;
      }
      const active = dbInst.getActiveWorkflow(common.sessionId);
      if (!active) {
        ctx.ui.notify("当前无活动工作流（可用 /workflow-status <id> in_progress 恢复挂起的工作流）", "error");
        return;
      }
      const newStatus = firstArg as WorkflowStatus | undefined;
      if (!newStatus) {
        ctx.ui.notify(
          `工作流 #${active.id}「${active.title.slice(0, 40)}」\n` +
            `状态: ${active.status}\n` +
            `计划: ${active.plan_path ?? "（未关联）"}\n` +
            `进度: ${active.progress ?? "（无）"}\n` +
            `下一步: ${active.next_steps ?? "（无）"}\n` +
            `任务: ${dbInst.getTasks(active.id).length} 个`,
          "info",
        );
        return;
      }
      if (!VALID_STATUSES.includes(newStatus)) {
        ctx.ui.notify(`无效状态: ${newStatus}。可选: ${VALID_STATUSES.join(" / ")}`, "error");
        return;
      }
      mgr.setStatus(active.id, newStatus, common.sessionId);
      ctx.ui.notify(`工作流 #${active.id} 状态 → ${newStatus}`, "info");
    },
  });
}

/**
 * 渲染工作流完整记录为文本（get_workflow_record 工具 / /workflow-show 复用）
 * 计划本体从 plan_path 文件读取（人类可读可改），库只存标准信息/执行情况/辅助信息
 */
function renderWorkflowRecord(mgr: WorkflowManager, wf: WorkflowRow): string {
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
