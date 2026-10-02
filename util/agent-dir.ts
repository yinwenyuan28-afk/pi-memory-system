/**
 * util/agent-dir.ts —— **路径单源**：宿主 agent 根 + 本插件自身根
 *
 * 分两半，因为两者来源完全不同、但都容易被写死：
 *   - `resolveAgentDir()`：宿主的 `~/.pi/agent`，由环境变量决定
 *   - `PLUGIN_ROOT`：本插件装在哪，由**本文件自身位置**决定（与安装形态无关）
 *
 * ── 为什么要有这个模块（2026-10-01，P1-7）──────────────────────────────
 * 宿主 agent 根原先在三个地方各写一遍，而三份对「`PI_CODING_AGENT_DIR` 是什么」的假设
 * 并不一致 ——
 *
 *   1. `index.ts` 的 `getAgentDir()`：`PI_CODING_AGENT_DIR ?? \`${HOME}/.pi/agent\``
 *   2. `memory/l1/config.ts` 的 `listKnownProjects()`：拿 `PI_CODING_AGENT_DIR` 当**家目录**，
 *      后面又拼了一段 `.pi/agent/sessions`
 *   3. `util/judg-session-project/llm.ts` 的 `resolveJudgeModel()`：用的是另一个变量
 *      `PI_AGENT_HOME`，且只认 `USERPROFILE`
 *
 * 第 2 处因此在设了 `PI_CODING_AGENT_DIR` 时拼出 `~/.pi/agent/.pi/agent/sessions` ——
 * 不存在，`listKnownProjects()` 静默返回 `[]`，L1/L2 的项目归属判定整体失效且不报错。
 * 「同一个概念多份实现」本身就是缺陷来源，所以这里不是加一份而是并成一份。
 *
 * 语义约定：**`PI_CODING_AGENT_DIR` 给的就是 agent 根本身**（与 pi 宿主的 `getAgentDir()`
 * 同口径），调用方不要再在其后拼接 `.pi/agent`。
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// ── 本插件自身的位置 ─────────────────────────────────────────────────────────
//
// 一切由「本文件在哪」推导，**不读环境变量、不读配置**。所以本地路径安装与 npm
// 全局安装都成立 —— 这正是 P1-9 要解决的事：`prompts/shared.md` 与 registry 里
// 那份硬编码的 `C:\Users\leaf\.pi\agent\...` 保护路径，在别人机器上（尤其 npm 装到
// 别的位置时）指向的根本不是插件自己的文件，而提示词还在让模型「保护」它们。

/** 本插件根目录（= 本文件所在 `util/` 的上一级）。 */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 随包分发的子代理定义目录（自建 spawn 之后，子代理定义**只**从这里读）。 */
export const BUNDLED_AGENTS_DIR = join(PLUGIN_ROOT, "agents");

/** 提示词模板目录（registry 从这里加载 md）。 */
export const PROMPTS_DIR = join(PLUGIN_ROOT, "prompts");

/**
 * 列出随包分发的子代理名（不含 `.md` 后缀），按目录列举得出。
 *
 * 为什么要动态列举：`shared#protected-files` 那段提示词原来手写了一份 agent 名单，
 * 而自建 spawn 之后那份名单既漏了 `memory-organizer` / `memory-reviewer`，
 * 指的目录（用户 agent 根）也早已不是真正在用的那一份（P1-9）。
 * 改成从目录读 ⇒ 以后增删 agent 定义，这段提示词自动跟上。
 *
 * @returns 目录不存在时返回空数组（提示词仍然可用，只是少了括号里的名单）
 */
export function listBundledAgentNames(): string[] {
	try {
		if (!existsSync(BUNDLED_AGENTS_DIR)) return [];
		return readdirSync(BUNDLED_AGENTS_DIR)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.slice(0, -3))
			.sort();
	} catch {
		return [];
	}
}