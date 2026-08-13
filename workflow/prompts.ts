// ============================================================================
// workflow/prompts.ts — 提示词加载器
//
// 功能：从 prompts/ 目录的 md 文件分节加载提示词，md 缺失/损坏时 fallback 到
//       代码内置默认值（不崩）
// 用途：detector.ts（8 个判定提示词）/ manager.ts（summary/diff）统一引用
// 设计：md 是覆盖层——编辑 md 即可微调提示词，不用动业务代码；内置默认兜底
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 默认提示词（fallback：md 缺失/损坏时使用）
// ---------------------------------------------------------------------------

export interface DetectPrompts {
  create: string;
  accept: string;
  reject: string;
  adjust: string;
  child: string;
  continue: string;
  implicitConfirm: string;
  newRequest: string;
}

export interface WorkflowPrompts {
  detect: DetectPrompts;
  summary: string;
  diff: string;
}

const DEFAULT_PROMPTS: WorkflowPrompts = {
  detect: {
    create:
      "这条用户消息是否表达【产出意图】（要实现一个功能、产出文件/代码、设计产品/方案）？回答 JSON {\"yes\": true/false}",
    accept:
      "这条用户消息是否在【确认工作流完成/验收】（例如\"可以了/完成了/就这样\"）？" +
      "注意：如果消息包含\"还要/再改/还没/不行\"则不是验收。回答 JSON {\"yes\": true/false}",
    reject:
      "这条用户消息是否在推翻当前工作流的方案/设计？如果是，属于哪种：\n" +
      "a) 完全放弃（\"不做了/算了，不要这个了\"）→ \"abandon\"\n" +
      "b) 推翻部分设计但需求仍在（\"重来但还要做/换方式实现\"）→ \"evolve\"\n" +
      "c) 不是推翻（只是普通否定/澄清）→ null\n" +
      "回答 JSON {\"type\": \"abandon\"|\"evolve\"|null}",
    adjust:
      "这条用户消息是否属于【对当前工作流的需求/方案/目标做调整】（仍在同一工作流语境，不是全新需求）？回答 JSON {\"yes\": true/false}",
    child:
      "这条用户消息提到的新需求，是【当前工作流的子任务/组成部分】，还是独立的新工作流？回答 JSON {\"child\": true/false}",
    continue:
      "这条用户消息是否在【延续当前工作流】（\"接着做/继续/下一步\"）？回答 JSON {\"yes\": true/false}",
    implicitConfirm:
      "之前的工作流疑似完成（所有任务已完成）。这条新消息是在【继续修改/补充当前工作流】" +
      "还是【转入新话题/没有异议】（可确认工作流完成）？回答 JSON {\"confirm\": true/false}",
    newRequest:
      "这条用户消息是否在【开启一个与当前工作流无关的全新需求】？" +
      "如果只是继续当前任务的讨论/指示/收尾（如提交、编译、检查），则不是。回答 JSON {\"yes\": true/false}",
  },
  summary:
    "你是工作流检查点总结助手。根据工作流当前状态总结进度和下一步，只输出 JSON：\n" +
    "{\"progress\": \"进度摘要（做了什么，一两句话）\", \"next_steps\": \"下一步/待办（多条用；分隔）\"}\n\n" +
    "当前任务：\n{{tasks}}\n\n最近事件：\n{{events}}",
  diff:
    "你是工作流版本差异总结助手。对比两个版本的同一工作流，总结新版本相对旧版本的需求/方案/范围变化，输出 JSON：\n" +
    "{\"diff\": \"变化描述（两三句话：需求改动/方案改动/范围增减）\"}\n\n" +
    "旧版本：{{prev}}\n新版本：{{next}}",
};

// ---------------------------------------------------------------------------
// 加载器（内存缓存，md 覆盖 + 默认兜底）
// ---------------------------------------------------------------------------

let cached: WorkflowPrompts | null = null;

/** 从 md 文件提取分节内容（`## 节名` 到下一个 `##`） */
function extractSection(md: string, section: string): string | undefined {
  const marker = `## ${section}`;
  const idx = md.indexOf(marker);
  if (idx === -1) return undefined;
  const start = idx + marker.length;
  const end = md.indexOf("\n## ", start);
  return md.slice(start, end === -1 ? undefined : end).trim();
}

/** 加载提示词（md 分节覆盖 + 默认兜底），缓存一次 */
export function loadPrompts(): WorkflowPrompts {
  if (cached) return cached;
  const loaded: WorkflowPrompts = {
    detect: { ...DEFAULT_PROMPTS.detect },
    summary: DEFAULT_PROMPTS.summary,
    diff: DEFAULT_PROMPTS.diff,
  };
  try {
    // 相对本文件的 prompts/ 目录（jiti/ESM 均可用）
    const base = fileURLToPath(new URL("./prompts/", import.meta.url));
    const detectMd = readFileSync(`${base}detect.md`, "utf-8");
    const summaryMd = readFileSync(`${base}summary.md`, "utf-8");
    // detect 分节覆盖
    (Object.keys(loaded.detect) as Array<keyof DetectPrompts>).forEach((k) => {
      const v = extractSection(detectMd, k);
      if (v) loaded.detect[k] = v;
    });
    // summary/diff 单节覆盖
    const summary = extractSection(summaryMd, "summary");
    if (summary) loaded.summary = summary;
    const diff = extractSection(summaryMd, "diff");
    if (diff) loaded.diff = diff;
  } catch {
    // md 缺失/损坏 → 用默认
  }
  cached = loaded;
  return cached;
}

/** 测试/调试：重置缓存（md 改动后重新加载） */
export function resetPromptsCache(): void {
  cached = null;
}

/** 渲染占位符（{{key}} → value） */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}
