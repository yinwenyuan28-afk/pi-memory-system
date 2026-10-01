/**
 * util/spawn.ts —— 自建后台子代理派发
 *
 * ── 为什么不走 pi-subagents ────────────────────────────────────────────────
 * 2026-10-01 之前有两条路，都不通：
 *   1. 读 `globalThis.__piSubagentExecutor` —— 那是本机给 pi-subagents 源码打的私有补丁，
 *      pi 升级即失效，且绑死 pi-subagents ≤0.35.x（0.74 起只发编译后的 .js，补丁脚本失效）。
 *   2. `subagents:rpc:v1` 事件总线 —— 上游官方集成面，但桥接层
 *      （`pi-subagents/src/extension/index.ts:385`、0.74.0 的 `index.js:631` 逐字相同）
 *      硬编码 `getContext: () => state.lastUiContext`，**不接受调用方传入的 ctx**。
 *      而 pi 在 session 替换 / reload 时 `dispose()` → `invalidate()`，该缓存变废，
 *      派发必然失败（实测：`This extension ctx is stale after session replacement or reload`）。
 *
 * 本模块直接 `spawn` 一个 pi 子进程，**对 pi-subagents 零依赖**。可行性已由真实冒烟验证
 * （见 plan/memory-system/SELF_SPAWN_PLAN.md 的「冒烟结果」节）。
 *
 * ── 关键设计 ────────────────────────────────────────────────────────────────
 * - **完成信号不靠我们**：子代理自己调 `l1_commit` / `l2_commit` / `l3_commit`，
 *   那些工具内部会 `completeRunningL*()` 把 job 标 done（`l1/commit-tool.ts:784` 等）。
 *   本模块只负责「让它跑起来」和「记住它的 pid」。
 * - **pid 落盘**：见 `memory/pipeline/subagent-runs.ts`。主进程重启后据此回收残留子进程。
 * - **stdio 直落文件**：不用 pipe，避免长跑子代理写满管道缓冲区。
 * - **pi 可执行路径两级解析**：`pi` 在本机 PATH 里的位置带 fnm 会话哈希，跨会话不稳定，
 *   所以优先用 `process.execPath` + `process.argv[1]`（我们就跑在 pi 进程里，最可靠），
 *   再回落 PATH 的 `pi`。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MEMORY_DB_DIR, SUBAGENT_PROMPT_TMP_DIR, SUBAGENT_SESSION_DIR } from "../memory/paths.ts";
import { writeSubagentRun, type SubagentRunRecord } from "../memory/pipeline/subagent-runs.ts";
import { logEvent } from "./notice.ts";

/** 插件根目录（<插件>/util/spawn.ts → 上两级）。 */
const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 自带子代理定义的目录（<插件>/agents）。 */
export const BUNDLED_AGENTS_DIR = join(EXT_ROOT, "agents");

/** 一个已派发的子代理。 */
export interface SpawnedSubagent {
	/** 本次派发的 runId（自建 uuid，仅用于日志串联与 session 文件命名）。 */
	runId: string;
	/** 子进程 pid——停止与回收的唯一依据。 */
	pid: number;
	/** 实际派发的命令与参数（落日志用；task 本身不进日志，内容可能含会话）。 */
	command: string;
}

/** 解析 agent 定义文件（<插件>/agents/<name>.md）的 frontmatter 与正文。 */
export interface AgentDefinition {
	name: string;
	/** 逗号分隔的工具白名单。 */
	tools: string[];
	/** 正文 = system prompt。 */
	body: string;
	/** frontmatter 的 thinking 字段（可空）。 */
	thinking?: string;
}

/**
 * 极简 frontmatter 解析：只取 `key: value` 的扁平字段，body 是首个 `---` 之后的全部内容。
 *
 * 为什么不复用 pi-subagents 的 parseFrontmatter：那是第三方包内部实现，跨版本会变，
 * 而自建 spawn 的目标就是**零依赖**。本插件的 6 个 agent 定义都是扁平 `key: value`
 * （无嵌套块、无列表），这个解析器足够且行为可预测。
 */
export function parseAgentDefinition(filePath: string): AgentDefinition {
	const raw = readFileSync(filePath, "utf-8");
	const normalized = raw.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) {
		throw new Error(`agent 定义缺少 frontmatter: ${filePath}`);
	}
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) {
		throw new Error(`agent 定义 frontmatter 未闭合: ${filePath}`);
	}
	const fmBlock = normalized.slice(4, end);
	const body = normalized.slice(end + 4).replace(/^\n+/, "").replace(/\n+$/, "");

	const fields: Record<string, string> = {};
	for (const line of fmBlock.split("\n")) {
		const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
		if (m) fields[m[1]] = m[2].trim();
	}
	if (!fields.name) throw new Error(`agent 定义缺少 name: ${filePath}`);
	if (!fields.tools) {
		// 没有 tools 白名单就不能派发——裸奔会让子代理拿到全部工具（含删改记忆的写工具）
		throw new Error(`agent 定义缺少 tools 白名单（拒绝裸奔派发）: ${filePath}`);
	}
	return {
		name: fields.name,
		tools: fields.tools.split(",").map((t) => t.trim()).filter(Boolean),
		body,
		thinking: fields.thinking || undefined,
	};
}

/** 读插件自带的某个 agent 定义。 */
export function loadAgentDefinition(agent: string): AgentDefinition {
	const p = join(BUNDLED_AGENTS_DIR, `${agent}.md`);
	if (!existsSync(p)) {
		const have = existsSync(BUNDLED_AGENTS_DIR)
			? readdirSync(BUNDLED_AGENTS_DIR).filter((f: string) => f.endsWith(".md")).join(", ")
			: "（目录不存在）";
		throw new Error(`找不到子代理定义 ${agent}.md；${BUNDLED_AGENTS_DIR} 下现有：${have}`);
	}
	return parseAgentDefinition(p);
}

/** 列出插件自带的 agent 名（启动自检用）。 */
export function listBundledAgents(): string[] {
	if (!existsSync(BUNDLED_AGENTS_DIR)) return [];
	return readdirSync(BUNDLED_AGENTS_DIR)
		.filter((f: string) => f.endsWith(".md"))
		.map((f: string) => f.replace(/\.md$/, ""))
		.sort();
}

/**
 * 判断一个 .js/.mjs 路径**是不是 pi CLI 的入口**——向上找 package.json，
 * 要求 `name === "@earendil-works/pi-coding-agent"`。
 *
 * 为什么必须校验：`process.argv[1]` 只有在**跑在 pi 进程里**时才是 pi 的入口。
 * 本文件自己的测试脚本、任何 jiti 直跑的脚本，它的 argv[1] 指向的是那个脚本自己。
 * 不校验就会派发出 `node <某个不相干的脚本> <一串 pi 参数>`，那个脚本会把参数当
 * 自己的 argv 跑起来——实测会让验证脚本递归派发自己。
 * pi-subagents 的 resolvePiScript 也做了同样的校验（findPiPackageRootFromEntry）。
 */
function looksLikePiCli(scriptPath: string): boolean {
	let dir = dirname(scriptPath);
	for (let i = 0; i < 8; i++) {
		const pj = join(dir, "package.json");
		if (existsSync(pj)) {
			try {
				const meta = JSON.parse(readFileSync(pj, "utf-8")) as { name?: string };
				return meta?.name === "@earendil-works/pi-coding-agent";
			} catch {
				return false;
			}
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return false;
}

/**
 * 解析 pi 可执行入口。三级：环境变量 → `process.execPath` + `process.argv[1]` → PATH 的 `pi`。
 *
 * 为什么不能只查 PATH：本机 `pi` 位于 `~/AppData/Local/fnm_multishells/<会话哈希>/pi`，
 * 哈希随 pi 会话变化，换个窗口就找不到。而 memory-system 就跑在 pi 进程里，
 * `process.argv[1]` 正是 pi 自己的入口——用它最可靠（但**必须先经 looksLikePiCli 校验**，
 * 见该函数注释）。
 */
export function resolvePiCommand(): { command: string; prefixArgs: string[] } {
	const override = process.env.PI_MEMORY_SYSTEM_PI_BIN?.trim();
	if (override) {
		// 允许直接指向 pi 的 cli.js —— 这样调用方（尤其是跑在 pi 之外的验证脚本）
		// 能走**与生产完全相同**的那一档，而不是退到需要 shell 的 PATH 回落档。
		if (/\.m?js$/i.test(override) && existsSync(override) && looksLikePiCli(override)) {
			return { command: process.execPath, prefixArgs: [override] };
		}
		return { command: override, prefixArgs: [] };
	}
	const argv1 = process.argv[1];
	if (argv1 && /\.m?js$/i.test(argv1) && existsSync(argv1) && looksLikePiCli(argv1)) {
		return { command: process.execPath, prefixArgs: [argv1] };
	}
	return { command: "pi", prefixArgs: [] };
}

/** 读 `settings.json` 的 `subagents.defaultModel`（子代理模型与主模型分开配）。读不到返回 undefined。 */
function readSubagentModel(agentDir: string): string | undefined {
	try {
		const raw = readFileSync(join(agentDir, "settings.json"), "utf-8");
		const s = JSON.parse(raw) as { subagents?: { defaultModel?: string } };
		return s.subagents?.defaultModel?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** 组装一次派发的完整 argv（导出供验证脚本断言用）。 */
export function buildSpawnArgs(opts: {
	agentDef: AgentDefinition;
	promptFile: string;
	sessionDir: string;
	model?: string;
	extraExtensions?: string[];
}): string[] {
	const args = [
		"-p",                      // 非交互，跑完即退
		// ⚠ 用 text 而**不是** json（2026-10-02 实测修正）：`--mode json` 会对**每个 token
		// 增量**发一行 message_update——一次 181 秒的 L1 提取就写了 3608 行 / 1.3MB，
		// 99% 是无用的逐 token 流，长跑子代理能写到几十 MB。
		// 完整过程（含每次工具调用的入参/结果）在 `--session-dir` 指向的 .jsonl 里，
		// 那才是深挖该看的地方；stdout 只需要「子代理最后说了什么」这一句摘要。
		"--mode", "text",
		"--system-prompt", opts.promptFile,   // 完整替换系统提示（= systemPromptMode: replace）
		"--tools", opts.agentDef.tools.join(","),  // 工具白名单
		"--no-skills",              // = inheritSkills: false
		"--no-context-files",       // 不注入 AGENTS.md（replace 模式下等价于不继承 project context）
		"--no-approve",             // 后台跑不交互确认
		"--session-dir", opts.sessionDir,
	];
	if (opts.model) args.push("--model", opts.model);
	if (opts.agentDef.thinking) args.push("--thinking", opts.agentDef.thinking);
	for (const e of opts.extraExtensions ?? []) args.push("--extension", e);
	return args;
}

export interface SpawnOptions {
	/** 子代理名（对应 agents/<agent>.md）。 */
	agent: string;
	/** 任务描述（进 argv）。 */
	task: string;
	/** profile 根目录（记录与日志落盘用）。 */
	profilePath: string;
	/** pi 的 agent 根目录（读 settings.json 的 subagents.defaultModel）。 */
	agentDir: string;
	/** 哪一层 + jobId（写运行记录用）。 */
	layer: string;
	jobId: number;
	/** 子进程工作目录；缺省用当前进程 cwd。 */
	cwd?: string;
}

/**
 * 派发一个后台子代理。**同步返回**（毫秒级，不等子进程跑完）。
 *
 * @returns runId 与 pid；调用方用 pid 做停止，用 runId 串联日志
 * @throws 找不到 agent 定义 / 找不到 pi 入口 / spawn 同步失败——都立即抛，
 *         由调用方交给 `failFastOnSpawnFailure` 进 catch 释放 job，绝不干等
 */
export function spawnSubagent(opts: SpawnOptions): SpawnedSubagent {
	return spawnImpl(opts);
}

/**
 * 测试接缝：把派发实现换掉。
 *
 * 存在的理由：L1/L2/L3 的落盘与通知链路要能**离线验证**（scripts/verify-notice-routing.ts
 * 的第 9 组要模拟「子代理干完活并提交」），而生产实现会真的起一个 pi 子进程——
 * 测试里既慢又不可预测。
 *
 * 契约：传 `null` 恢复生产实现。生产代码路径**永不调用**它。
 */
export function setSpawnImplForTest(fn: ((opts: SpawnOptions) => SpawnedSubagent) | null): void {
	spawnImpl = fn ?? spawnSubagentReal;
}

let spawnImpl: (opts: SpawnOptions) => SpawnedSubagent = spawnSubagentReal;

function spawnSubagentReal(opts: SpawnOptions): SpawnedSubagent {
	const runId = randomUUID();
	const agentDef = loadAgentDefinition(opts.agent);

	// system prompt 落临时文件（pi 的 --system-prompt 吃文件路径，见 resource-loader.js:380-384）
	const promptDir = join(opts.profilePath, MEMORY_DB_DIR, SUBAGENT_PROMPT_TMP_DIR);
	mkdirSync(promptDir, { recursive: true });
	const promptFile = join(promptDir, `${runId}.md`);
	writeFileSync(promptFile, agentDef.body, "utf-8");

	// task 也落文件，用 `@<path>` 交给 pi（pi 支持 `pi [@files...] [messages...]`）。
	// 两个理由：
	//   1. **命令注入**：task 内容来自 L0 会话（含用户原话）。若直接进 argv，回落到
	//      `shell: true` 执行时（见 resolvePiCommand 的第三档）Node 不做转义，
	//      内容里的 `"` `&` `|` 会被 cmd 当元字符解释。走文件就没有这个面。
	//   2. **Windows 命令行长度上限**约 32K，task 长了会 spawn 失败（`EINVAL`）。
	const taskFile = join(promptDir, `${runId}.task.txt`);
	writeFileSync(taskFile, opts.task, "utf-8");

	// session 目录按 layer 分，避免同名覆盖
	const sessionDir = join(opts.profilePath, MEMORY_DB_DIR, SUBAGENT_SESSION_DIR, opts.layer);
	mkdirSync(sessionDir, { recursive: true });

	// 子进程日志直落文件（不用 pipe：长跑子代理会写满管道缓冲）
	const logDir = join(opts.profilePath, MEMORY_DB_DIR, "logs");
	mkdirSync(logDir, { recursive: true });
	const stdoutPath = join(logDir, `subagent-${opts.layer}-${opts.jobId}-${runId}.out.log`);
	const stderrPath = join(logDir, `subagent-${opts.layer}-${opts.jobId}-${runId}.err.log`);

	const { command, prefixArgs } = resolvePiCommand();
	const model = readSubagentModel(opts.agentDir);
	const args = [
		...prefixArgs,
		...buildSpawnArgs({
			agentDef,
			promptFile,
			sessionDir,
			model,
			// 子进程必须能加载本扩展的工具（l1_commit / l2_commit / l3_edit / read_* 等）。
			// 显式 -e 保证与 cwd 无关；子代理自己的 index.ts 顶部的子进程守卫会让它
			// 不再起调度器/管线worker，避免与主进程抢队列。
			extraExtensions: [join(EXT_ROOT, "index.ts")],
		}),
		`@${taskFile}`,
	];

	// 打开日志文件拿到 fd —— 传给 spawn 的 stdio，子进程直接继承这两个句柄。
	// ⚠ 不要写成 closeSync(openSync(...))：closeSync 没有返回值，会把 fd 变成
	// undefined，spawn 立刻抛 `The "fd" argument must be of type number`。
	// 子进程拿到句柄后父进程即可关闭（spawn 内部已 dup），放在 finally 里防 fd 泄漏。
	const stdoutFd = openSync(stdoutPath, "a");
	const stderrFd = openSync(stderrPath, "a");

	// 回落档（PATH 里的 `pi`）在 Windows 上是 shell 脚本 / .cmd，Node 不能直接 exec，
	// 必须走 shell。这里是**唯一**需要 shell 的地方——而我们所有经 shell 传的参数
	// 都是我们自己拼的常量（agent 名走 @file、路径无元字符），用户/会话内容一律走
	// 文件，所以没有注入面。前两档（生产实际走的）都不经过 shell。
	const useShell = prefixArgs.length === 0 && process.platform === "win32";

	let child: ChildProcess;
	try {
		child = spawn(command, args, {
			cwd: opts.cwd || process.cwd(),
			env: {
				...process.env,
				// 关键：不设这个，子代理会把自己的 session 归档进 L0 分片（2026-08-18 事故）
				PI_SUBAGENT_CHILD: "1",
				PI_PROFILE_PATH: opts.profilePath,
			},
			detached: true,   // 独立进程组：主进程退出不影响子代理；停止时按组杀
			windowsHide: true,
			shell: useShell,  // 仅 PATH 回落档需要（见上方注释）；生产实际走的前两档为 false
			stdio: ["ignore", stdoutFd, stderrFd],
		});
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}

	if (typeof child.pid !== "number") {
		throw new Error(`spawn 未拿到 pid（command=${command}）；见 ${stderrPath}`);
	}

	const rec: SubagentRunRecord = {
		layer: opts.layer,
		jobId: opts.jobId,
		pid: child.pid,
		runId,
		agent: opts.agent,
		startedAt: new Date().toISOString(),
		command: `${command} ${args.slice(0, -1).join(" ")} @<taskFile>`,
		stdoutPath,
		stderrPath,
	};
	writeSubagentRun(opts.profilePath, rec);

	logEvent(
		"store",
		`[self-spawn] ${opts.layer} job ${opts.jobId} → ${opts.agent} pid=${child.pid} run=${runId} ` +
		`model=${model ?? "(pi 默认)"} tools=${agentDef.tools.length} 日志=${stdoutPath}`,
		opts.profilePath,
	);

	// 早死检测：子进程非 0 退出码时通知调用方，由它决定是否把 job 标 failed。
	// 只在非 0 时回调——退出码 0 但没 commit 属于「可能正在收尾」，交给活性门控的硬阈值，
	// 避免误杀（2026-09-15 记录过同值尾巴被误判超时的事故）。
	child.on("exit", (code, signal) => {
		logEvent(
			"store",
			`[self-spawn] ${opts.layer} job ${opts.jobId} 子进程退出 pid=${child.pid} code=${code} signal=${signal ?? "-"}`,
			opts.profilePath,
		);
	});

	return { runId, pid: child.pid, command: rec.command };
}
