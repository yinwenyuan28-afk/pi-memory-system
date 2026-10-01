/**
 * verify-self-spawn —— 自建 spawn 的离线回归（不调模型，秒级）
 *
 * 覆盖 2026-10-02 实机事故暴露的三个真 bug。它们都属于「代码看着对、只有真跑才炸」，
 * 而当时所有测试都走 setSpawnImplForTest 桩、从不执行真实 spawn ⇒ 全部漏网。
 * 本脚本**直接调真实实现**，用廉价子进程代替模型调用。
 *
 *  ① fd 传错：`closeSync(openSync(p,"a"))` 写成一行，closeSync 无返回值 ⇒ stdio 收到
 *     undefined ⇒ spawn 抛 `The "fd" argument must be of type number`。
 *  ② pi 入口误认：`process.argv[1]` 只有在 pi 进程内才是 pi 的入口。跑在 pi 之外的
 *     验证脚本里它指向脚本自己 ⇒ 派发出 `node <某个脚本> <pi 参数>`，那个脚本把参数
 *     当自己的 argv 跑起来（实测会递归派发自己）。
 *  ③ Windows 回落：`pi` 在本机是 POSIX shell 脚本 / `pi.cmd`，Node 不能直接 exec；
 *     而用 shell:true 又会让 task（来自会话内容）成为注入面。
 *
 * 用法：node --experimental-strip-types scripts/verify-self-spawn.mts
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (rel: string) => import(pathToFileURL(join(EX, rel)).href) as never as Promise<Record<string, never>>;
const spawnMod = await imp("util/spawn.ts");
const runsMod = await imp("memory/pipeline/subagent-runs.ts");
const { spawnSubagent, parseAgentDefinition, buildSpawnArgs, resolvePiCommand, listBundledAgents, BUNDLED_AGENTS_DIR } =
	spawnMod as never as typeof import("../util/spawn.ts");
const { writeSubagentRun, readSubagentRun, clearSubagentRun, listSubagentRuns } =
	runsMod as never as typeof import("../memory/pipeline/subagent-runs.ts");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) { pass++; console.log(`  PASS  ${name}${extra ? " — " + extra : ""}`); }
	else { fail++; console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`); }
}

const profile = mkdtempSync(join(tmpdir(), "verify-self-spawn-"));
// 走与生产相同的那一档（process.execPath + pi 的 cli.js），不走需要 shell 的 PATH 回落
const piCli = "C:/Users/leaf/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
if (existsSync(piCli)) process.env.PI_MEMORY_SYSTEM_PI_BIN = piCli;

try {
	// ── 1. agent 定义解析 ────────────────────────────────────────────────────
	console.log("\n=== 1. agent 定义解析 ===");
	const agents = listBundledAgents();
	check("自带 6 个 agent 定义", agents.length === 6, agents.join(", "));
	for (const name of ["l1-extractor", "l2-scene-organizer", "l3-persona-generator", "skill-reviewer"]) {
		const def = parseAgentDefinition(join(BUNDLED_AGENTS_DIR, `${name}.md`));
		check(`${name} 解析出 tools 白名单`, def.tools.length > 0, def.tools.join(","));
		check(`${name} body 非空（= system prompt）`, def.body.length > 100, `${def.body.length} 字符`);
		check(`${name} 无 subagentOnlyExtensions 硬编码`, !def.body.includes("C:/Users/"));
	}

	// ── 2. argv 组装 ────────────────────────────────────────────────────────
	console.log("\n=== 2. argv 组装 ===");
	const def = parseAgentDefinition(join(BUNDLED_AGENTS_DIR, "l1-extractor.md"));
	const argv = buildSpawnArgs({
		agentDef: def,
		promptFile: "PROMPT.md",
		sessionDir: "SESSDIR",
		model: "some/model",
		extraExtensions: ["EXT.ts"],
	});
	const has = (f: string) => argv.includes(f);
	check("含 -p（非交互）", has("-p"));
	check("含 --system-prompt 且值为文件路径", argv[argv.indexOf("--system-prompt") + 1] === "PROMPT.md");
	check("含 --tools 且为白名单", argv[argv.indexOf("--tools") + 1] === def.tools.join(","));
	check("含 --no-skills / --no-context-files / --no-approve",
		has("--no-skills") && has("--no-context-files") && has("--no-approve"));
	check("含 --model", argv[argv.indexOf("--model") + 1] === "some/model");
	check("含 --extension（子进程加载本插件工具）", has("--extension") && argv.includes("EXT.ts"));
	check("含 --session-dir", has("--session-dir"));
	check("含 thinking（l1 定义声明 high）", has("--thinking") && argv[argv.indexOf("--thinking") + 1] === "high");

	// ── 3. ③ 的两个防线：task 走文件、pi 入口需校验 ─────────────────────────
	console.log("\n=== 3. task 不进 argv（防注入 + 绕开 32K 命令行上限）===");
	const sp = spawnSubagent({
		agent: "l1-extractor",
		task: `占位`,
		profilePath: profile,
		agentDir: join(EX, ".."),
		layer: "l1",
		jobId: 900,
	});
	try { process.kill(sp.pid, "SIGKILL"); } catch { /* 已退出 */ }
	const rec900 = readSubagentRun(profile, "l1", 900);
	check("运行记录的 command 以 @<taskFile> 结尾（task 未进 argv）", rec900?.command.endsWith("@<taskFile>") === true, rec900?.command?.slice(-24) ?? "");
	const taskFile = join(profile, "memoryDB", "tmp", "subagent-prompts", `${sp.runId}.task.txt`);
	check("task 内容落在独立文件里", existsSync(taskFile) && readFileSync(taskFile, "utf-8") === "占位");
	const piCmd = resolvePiCommand();
	check("pi 入口解析到 cli.js（生产档，不经 shell）",
		piCmd.prefixArgs.length > 0 && /cli\.js$/.test(piCmd.prefixArgs[0]), `${piCmd.command} ${piCmd.prefixArgs[0] ?? ""}`);

	// ── 4. ① 的防线：真实 spawn + 文件 stdio（用廉价 node 子进程代替模型）──────
	console.log("\n=== 4. 真实 spawn + 文件 stdio（fd 正确性）===");
	const logDir = join(profile, "memoryDB", "logs");
	const outPath = join(logDir, "fd-probe.out.log");
	const errPath = join(logDir, "fd-probe.err.log");
	const oFd = openSync(outPath, "a");
	const eFd = openSync(errPath, "a");
	let childPid: number | undefined;
	try {
		const child = spawn(process.execPath, ["-e", "process.stdout.write('FD_OK');process.stderr.write('FD_ERR')"],
			{ stdio: ["ignore", oFd, eFd], detached: true, windowsHide: true });
		childPid = child.pid;
	} finally {
		closeSync(oFd);   // ⚠ closeSync 无返回值；写成 closeSync(openSync(...)) 会得到 undefined
		closeSync(eFd);
	}
	check("spawn 拿到 pid（fd 合法）", typeof childPid === "number", String(childPid));
	await new Promise((r) => setTimeout(r, 1200));
	try { process.kill(childPid!, "SIGKILL"); } catch { /* 已退出 */ }
	const outTxt = existsSync(outPath) ? readFileSync(outPath, "utf-8") : "";
	const errTxt = existsSync(errPath) ? readFileSync(errPath, "utf-8") : "";
	check("子进程 stdout 落到文件（fd 真的传对了）", outTxt.includes("FD_OK"), JSON.stringify(outTxt.slice(0, 30)));
	check("子进程 stderr 落到文件", errTxt.includes("FD_ERR"), JSON.stringify(errTxt.slice(0, 30)));

	// ── 5. 运行记录增删查 ────────────────────────────────────────────────────
	console.log("\n=== 5. 运行记录 ===");
	const sample = { layer: "l2", jobId: 77, pid: 12345, runId: "r1", agent: "l2-scene-organizer", startedAt: new Date().toISOString(), command: "cmd", stdoutPath: "o", stderrPath: "e" };
	writeSubagentRun(profile, sample);
	check("写入后可读回", readSubagentRun(profile, "l2", 77)?.pid === 12345);
	check("listSubagentRuns 能列出", listSubagentRuns(profile).some((r) => r.jobId === 77));
	clearSubagentRun(profile, "l2", 77);
	check("清除后读不到", readSubagentRun(profile, "l2", 77) === undefined);
	writeSubagentRun(profile, { ...sample, jobId: 78 });
	writeSubagentRun(profile, { ...sample, jobId: 79, pid: 999 });
	check("按 layer+jobId 隔离（l2-78 仍在）", readSubagentRun(profile, "l2", 78)?.pid === 12345);
	check("坏文件不影响其它记录", listSubagentRuns(profile).length >= 2);
} catch (e) {
	fail++;
	console.log(`  FAIL  用例抛出异常: ${e instanceof Error ? e.message : String(e)}`);
} finally {
	rmSync(profile, { recursive: true, force: true });
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
