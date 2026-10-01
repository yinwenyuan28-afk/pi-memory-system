import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把插件自带的子代理定义目录注册进 pi-subagents 的发现范围。
 *
 * ── 背景：为什么需要这一步 ────────────────────────────────────────────────
 * memory-system 的 L1/L2/L3/review/skill-review 五条链都靠后台子代理执行，而这些
 * 子代理的定义（frontmatter + system prompt）原本**只存在于用户目录
 * `~/.pi/agent/agents/*.md`**，插件目录里没有。别人装上插件后没有这些文件 ⇒
 * 派发必然失败。这是与「改 pi-subagents 源码」并列的第二个发布阻断项。
 *
 * ── 为什么用环境变量而不是往用户目录拷文件 ────────────────────────────────
 * pi-subagents 提供 `PI_SUBAGENT_EXTRA_AGENT_DIRS`（其 src/agents/agents.ts 中
 * `EXTRA_AGENT_DIRS_ENV` + `extraUserAgentDirs()`），上游注释原文即为本场景而写：
 * 「Lets a hermetic wrapper (e.g. a Nix-store install) expose bundled agents
 * **without copying or symlinking them into the writable agent dir**」。
 * 该目录在每次 discoverAgents() 时从 process.env 读取（不是模块加载时），所以在扩展
 * 激活阶段写入即可赶上后续所有派发。
 *
 * 相比「把 md 拷进 ~/.pi/agent/agents/」的好处：
 * 1. **不写用户目录**——不污染、不覆盖用户可能自己改过的定义、不产生备份残留；
 * 2. **升级即生效**——改完插件里的 md，重新 /reload 即可，无需重跑安装脚本；
 * 3. 官方支持的环境变量，pi-subagents 升级不会失效（对比：往用户目录拷文件是自造机制）。
 *
 * 代价：优先级低于用户目录（上游 mergeAgentsForScope 与数组顺序都是
 * `userAgentsExtra` 先、`userDirOld` 后，后写入 Map 者胜）。即**用户目录里若存在同名
 * 定义，以用户的为准**。这是符合直觉的行为——用户显式放的文件优先于插件自带。
 * 副作用：本机若已在 ~/.pi/agent/agents/ 放过旧版定义，本插件自带的副本不会生效
 * （需用户自行删除旧文件才会切到插件版）。
 */

/** 上游常量名，见 pi-subagents/src/agents/agents.ts 的 EXTRA_AGENT_DIRS_ENV。 */
const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

/** 插件自带子代理定义的目录（<插件根>/agents）。用 import.meta.url 定位，与 cwd 无关。 */
export function bundledAgentsDir(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

export interface AgentRegistrationResult {
	/** 实际注册进去的目录绝对路径。 */
	dir: string;
	/** 该目录下的 .md 定义文件名（已排序）。 */
	files: string[];
	/** 注册前环境变量里是否已含本目录（true = 此前已注册过，本次为幂等空操作）。 */
	alreadyRegistered: boolean;
	/** 之前已有的其它目录（保持不动，仅返回供日志）。 */
	preservedDirs: string[];
}

/**
 * 把插件自带的 agents/ 目录追加进 PI_SUBAGENT_EXTRA_AGENT_DIRS。**幂等**，可重复调用。
 *
 * 注意是**追加**而非覆盖：环境变量可能已被用户或其它扩展设置过别的目录，
 * 直接赋值会把人家的配置抹掉。
 *
 * @returns 注册结果；若目录缺失或没有 .md 定义则返回 null（调用方应 fail-soft 告警，
 *          而不是让 pi 启动失败——子代理缺失是降级，不是致命错误）。
 */
export function registerBundledAgentDefinitions(): AgentRegistrationResult | null {
	const dir = bundledAgentsDir();
	if (!existsSync(dir)) return null;

	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((f) => f.endsWith(".md") && !f.endsWith(".chain.md"))
			.sort();
	} catch {
		return null;
	}
	if (files.length === 0) return null;

	const raw = process.env[EXTRA_AGENT_DIRS_ENV];
	const existing = (raw ?? "")
		.split(delimiter)
		.map((d) => d.trim())
		.filter((d) => d.length > 0);

	// 幂等：已含本目录则不重复追加（也避免 /reload 时环境变量越拼越长）。
	if (existing.some((d) => resolve(d) === dir)) {
		return { dir, files, alreadyRegistered: true, preservedDirs: existing.filter((d) => resolve(d) !== dir) };
	}

	process.env[EXTRA_AGENT_DIRS_ENV] = [...existing, dir].join(delimiter);
	return { dir, files, alreadyRegistered: false, preservedDirs: existing };
}

/** 仅供诊断/测试：读回当前注册的全部额外 agent 目录。 */
export function listRegisteredExtraAgentDirs(): string[] {
	return (process.env[EXTRA_AGENT_DIRS_ENV] ?? "")
		.split(delimiter)
		.map((d) => d.trim())
		.filter((d) => d.length > 0);
}

/** 供诊断：某个子代理定义文件在插件内的绝对路径（子代理自身需要 read 插件内文件时可用）。 */
export function bundledAgentDefinitionPath(fileName: string): string {
	return join(bundledAgentsDir(), fileName);
}
