/**
 * util/agent-dir.ts —— 宿主 agent 根目录（`~/.pi/agent`）的**单一定义**
 *
 * 为什么要有这个模块（2026-10-01，P1-7）：这个路径原先在三个地方各写一遍，而三份
 * 对「`PI_CODING_AGENT_DIR` 是什么」的假设并不一致 ——
 *
 *   1. `index.ts` 的 `getAgentDir()`：`PI_CODING_AGENT_DIR ?? \`${HOME}/.pi/agent\``
 *   2. `memory/l1/config.ts` 的 `listKnownProjects()`：拿 `PI_CODING_AGENT_DIR` 当**家目录**，
 *      后面又拼了一段 `.pi/agent/sessions`
 *   3. `util/judg-session-project/llm.ts` 的 `resolveJudgeModel()`：用的是另一个变量
 *      `PI_AGENT_HOME`，且只认 `USERPROFILE`
 *
 * 第 2 处因此在设了 `PI_CODING_AGENT_DIR` 时拼出 `~/.pi/agent/.pi/agent/sessions` ——
 * 不存在，`listKnownProjects()` 静默返回 `[]`，L1/L2 的项目归属判定整体失效且不报错。
 * 「同一个概念三份实现」本身就是缺陷来源，所以这里不是加第四份而是把三份并成一份。
 *
 * 语义约定：**`PI_CODING_AGENT_DIR` 给的就是 agent 根本身**（与 pi 宿主的 `getAgentDir()`
 * 同口径），调用方不要再在其后拼接 `.pi/agent`。
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** agent 根的环境变量覆盖名（与 pi 宿主同名同义：给的是 agent 根，不是家目录）。 */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * 解析宿主 agent 根目录。
 *
 * 取值顺序：`PI_CODING_AGENT_DIR` → `HOME` → `USERPROFILE` → `homedir()` → 相对路径兜底。
 *
 * 前三位的顺序**刻意保持原样**（`HOME` 在 `USERPROFILE` 之前）：在 Git Bash 下 `HOME` 是
 * `/c/Users/leaf` 而 `USERPROFILE` 是 `C:\Users\leaf`，两者指向同一个目录但字符串不同。
 * 保持既有顺序 = 不改变本机任何现有路径的形态，只在三者都缺时（服务化启动、部分 CI）
 * 才落到 `homedir()` —— 那时若还用 `join("", ".pi", "agent")` 会得到**相对路径** `.pi/agent`，
 * 跟着进程 cwd 跑偏，静默读到另一个 agent 根的配置。
 */
export function resolveAgentDir(): string {
	const override = process.env[AGENT_DIR_ENV];
	if (override) return override;
	const home = process.env.HOME || process.env.USERPROFILE || homedir() || "";
	return home ? join(home, ".pi", "agent") : ".pi/agent";
}

/** agent 根下的会话目录（`listKnownProjects()` 遍历的就是它）。 */
export function resolveSessionsDir(): string {
	return join(resolveAgentDir(), "sessions");
}