// ============================================================================
// workflow/detector.ts — 信号检测器
//
// 功能：生命周期分支判定（创建/验收/推翻双分支/需求调整/子任务/延续/隐式完成）
//       采用"信号词正则初筛（零成本）→ 命中才 LLM 语义确认（5s 超时）"
// 用途：index.ts 用户消息监听 → detector 判定 → manager 执行状态机动作
// 设计：正则不命中直接返回（零 LLM 成本）；命中才调 callLLM（util/llm.ts）确认，
//       LLM 超时/失败回退到正则结论（保守选择）
// ============================================================================

import { callLLM } from "../util/llm.js";
import { loadPrompts } from "./prompts.js";

// 全新需求信号正则（兜底分支：默认延续，只有明确新需求信号才创建新工作流）
const NEW_REQUEST_REGEX =
  /全新|另一个|换个.{0,6}(需求|任务|项目)|重新开|另起|新任务|下一个需求|重新做|别的项目|其他任务|换一个需求|新开一个|做另一个|完全不同的/;

// ---------------------------------------------------------------------------
// 信号词正则（初筛，零成本）
// ---------------------------------------------------------------------------

const SIGNAL_REGEX: Record<string, RegExp> = {
  // 创建：产出意图（实现功能/写代码/设计产品）
  create:
    /实现|开发|做(一|个|一|个)?|写(个|一个|一)?|设计|搭建|创建|构建|新增|做一个|写一个|开发一个|实现.{0,8}(功能|系统|模块)|把.{0,20}(改造|重构|升级)|接入|对接/,
  // 验收：确认完成
  accept:
    /可以了|完成了|搞定了|做好了|没问题了|验收|收工|完工|就这样|满意|好了|搞定|通过|结束|没有其他|先这样/,
  // 推翻：不对/换方式/放弃
  reject:
    /不对|错了|算了|不要|换方式|重来|推翻|砍掉|换个思路|不行|不好使|重新|撤销|作废|换个方案|别[这那]样/,
  // 需求/方案/目标调整（仍在同一工作流语境，仅 UPDATE 行）
  adjust:
    /改一下|调整|优化|补充|完善|加上|去掉|改改|微调|变更|修改为|改成|加个|减掉|细化/,
  // 子任务拆分
  child: /拆出来|单独做|作为.{0,15}(的子任务|的一部分)|子任务|分开做|拆分|先做.{0,10}(这块|这个|这部分)/,
  // 延续
  continue: /接着做|继续|往下|下一步|接着|紧接着/,
  // 隐式完成确认（下一条消息判断：继续修改 vs 新话题）
  implicitConfirm:
    /继续|修改|再|不行|还要|补充|接着|优化|调整|不对|加/,
};

// ---------------------------------------------------------------------------
// WorkflowDetector 类
// ---------------------------------------------------------------------------

/**
 * WorkflowDetector — 生命周期分支信号检测
 *
 * @param model LLM 模型引用（session_start 由 index.ts 注入）
 * 每个检测方法：正则初筛（未命中 → 快速返回默认值）→ 命中 → LLM 语义确认
 * LLM 确认失败时回退到正则结论（accept/reject 保守返回 false）
 */
export class WorkflowDetector {
  private model: unknown = null;

  /** 设置 LLM 模型引用 */
  setModel(model: unknown): void {
    this.model = model;
  }

  /**
   * 创建判定：这条消息是否表达产出意图（无活动工作流时调用）
   * 正则命中 → LLM 确认；正则未命中但后续有产出 → 兜底补建（index.ts 处理）
   */
  async detectCreate(message: string): Promise<boolean> {
    if (!SIGNAL_REGEX.create.test(message)) return false;
    if (!this.model) return true;
    const r = await this.confirm(message, loadPrompts().detect.create);
    return r === null ? true : r;
  }

  /**
   * 验收检测：这条消息是否在确认工作流完成
   * 正则命中 → LLM 确认（防误报："还没完成"等）
   */
  async detectAccept(message: string): Promise<boolean> {
    if (!SIGNAL_REGEX.accept.test(message)) return false;
    if (!this.model) return true;
    const r = await this.confirm(message, loadPrompts().detect.accept);
    return r === null ? true : r;
  }

  /**
   * 推翻检测（双分支）：放弃 vs 演化
   * @returns "abandon"（完全放弃）| "evolve"（推翻部分设计但需求仍在）| null（非推翻）
   */
  async detectReject(message: string): Promise<"abandon" | "evolve" | null> {
    if (!SIGNAL_REGEX.reject.test(message)) return null;
    if (!this.model) return "evolve";
    const r = await this.confirm(message, loadPrompts().detect.reject, true);
    if (r === null) return "evolve";
    return r;
  }

  /**
   * 需求/方案/目标调整检测（仍在同一工作流语境，只 UPDATE 行）
   * 优先于 reject 判定（reject 未命中时调用）
   */
  async detectAdjust(message: string): Promise<boolean> {
    if (!SIGNAL_REGEX.adjust.test(message)) return false;
    if (!this.model) return true;
    const r = await this.confirm(message, loadPrompts().detect.adjust);
    return r === null ? true : r;
  }

  /**
   * 子任务拆分检测：新需求是当前工作流的子任务还是独立工作流
   * @returns true=子任务 | false=独立工作流
   */
  async detectChild(message: string): Promise<boolean> {
    if (!SIGNAL_REGEX.child.test(message)) return false;
    if (!this.model) return false;
    const r = await this.confirm(message, loadPrompts().detect.child);
    return r === null ? false : r;
  }



  /**
   * 延续检测：这条消息是在延续当前工作流（追加需求）
   * @returns true=延续
   */
  async detectContinue(message: string): Promise<boolean> {
    if (!SIGNAL_REGEX.continue.test(message)) return false;
    if (!this.model) return true;
    const r = await this.confirm(message, loadPrompts().detect.continue);
    return r === null ? true : r;
  }

  /**
   * 全新需求检测：这条消息是否明确开启一个与当前工作流无关的新需求
   * 兜底分支使用：默认延续当前工作流，只有明确新需求信号 + LLM 确认才创建新工作流
   * @returns true=全新需求
   */
  async detectNewRequest(message: string): Promise<boolean> {
    if (!NEW_REQUEST_REGEX.test(message)) return false;
    if (!this.model) return false; // 保守：无模型时不创建
    const r = await this.confirm(message, loadPrompts().detect.newRequest);
    return r === null ? false : r;
  }

  /**
   * 隐式完成确认（pending_completion 后下一条消息）：
   * 继续修改当前工作流（回 in_progress）还是新话题/无异议（确认完成）
   * @returns true=确认完成 | false=继续修改
   */
  async detectImplicitConfirm(message: string): Promise<boolean> {
    // 明确验收信号直接确认完成
    if (SIGNAL_REGEX.accept.test(message)) return true;
    if (!this.model) return false;
    const r = await this.confirm(message, loadPrompts().detect.implicitConfirm);
    return r === null ? false : r;
  }

  // ────────────────────────── LLM 确认内部方法 ──────────────────────────

  /**
   * 统一 LLM 语义确认（5s 超时）
   * @param message 用户消息
   * @param instruction 判定指令（要求 JSON 输出）
   * @param rawMode true 时返回解析后的 JSON 值（用于多值判定）
   * @returns 布尔判定；失败返回 null
   */
  private async confirm(
    message: string,
    instruction: string,
    rawMode = false,
  ): Promise<boolean | null | "abandon" | "evolve"> {
    if (!this.model) return null;
    const raw = await callLLM(
      this.model,
      "You respond only with valid JSON.",
      `用户消息：${message.slice(0, 500)}\n\n${instruction}`,
    );
    if (raw === null) return null;
    try {
      const obj = JSON.parse(raw);
      if (rawMode) {
        const t = obj?.type;
        return t === "abandon" || t === "evolve" ? t : null;
      }
      const yes = obj?.yes;
      if (typeof yes === "boolean") return yes;
      if (typeof obj?.child === "boolean") return obj.child;
      if (typeof obj?.confirm === "boolean") return obj.confirm;
      return null;
    } catch {
      return null;
    }
  }
}
