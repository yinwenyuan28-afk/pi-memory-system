/**
 * config/thresholds.ts —— 需要被**提示词回显**的系统阈值（代码侧唯一真源）
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────────
 * 这些数字原本散在业务模块里硬编码，同时又被抄进提示词（工具 description / 每轮注入的
 * tool-reminder）。两边各写一份 ⇒ 改代码不会改提示词 ⇒ 模型收到的行为指令与实际行为不符，
 * 而这种漂移**看代码完全看不出来**（2026-10-01 独立发布整改 P1-13）。
 *
 * 修法是让提示词通过 prompts/registry.ts 的变量机制回显这里的值。但 registry 的设计
 * 约束是「零业务依赖」（不得 import 任何业务模块），而工具链
 * （scripts/verify-prompt-contracts.mjs、scripts/regen-golden.mts）只允许依赖
 * prompts/registry.ts 这一个轻量模块——若让它们去 import fix-tool.ts / hybrid-recall.ts
 * 就会把 sqlite、向量库、任务队列整条链拖进来。
 *
 * 所以本文件是**零 import 的叶子模块**：业务模块与提示词变量表都从它取数，
 * 任何一侧改动数字，另一侧自动跟随，工具链也保持轻量。
 *
 * ── 为什么这些不是可配置项 ──────────────────────────────────────────────────
 * 刻意**不进** application-propertis.json：调它们会直接改变每轮发给 provider 的 token
 * 预算或防抖强度，属于「先看实测数据再定」的事，不适合随手配置。
 * 真要调就改这里，然后 /reload。
 */

/** 自动注入 L1 原子记忆的条数上限（每轮无条件塞进上下文，条数要克制）。 */
export const AUTO_INJECT_TOP_K = 3;

/**
 * `recall_l1_records` 工具的默认返回条数。
 * 刻意**大于** AUTO_INJECT_TOP_K：工具召回是主代理主动问「还有没有相关的」，给更宽的
 * 候选池；自动注入是无条件的，条数要少。
 */
export const TOOL_RECALL_TOP_K_DEFAULT = 5;

/** l1_fix 护栏 1：evidence 最少字符数（修正必须附可复核证据）。 */
export const FIX_MIN_EVIDENCE_CHARS = 20;

/** l1_fix 护栏 2：同一条记录的重复修正防抖间隔（毫秒）。 */
export const FIX_DEBOUNCE_MS = 24 * 3600e3;

/** 提示词用的可读形态（防抖在提示词里说的是「24h」而不是 86400000ms）。 */
export const FIX_DEBOUNCE_HOURS = Math.round(FIX_DEBOUNCE_MS / 3600e3);

/** l1_fix 护栏 3：高价值保护的命中次数门槛（达到则拒绝自动修正，需 --force）。 */
export const FIX_HIGH_VALUE_HITS = 5;
