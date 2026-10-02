// agent 根目录解析的回归基线（2026-10-01，STANDALONE_RELEASE_PLAN P1-7 / P1-8）
//
// 病根是「同一个概念三份实现」：index.ts 的 getAgentDir()、memory/l1/config.ts 的
// listKnownProjects()、util/judg-session-project/llm.ts 的 resolveJudgeModel() 各写一遍，
// 而三份对「PI_CODING_AGENT_DIR 给的是 agent 根还是家目录」的假设并不一致 —— 其中一份
// 因此在设了该环境变量时拼出 `~/.pi/agent/.pi/agent/sessions`，不存在 ⇒ 静默返回 [] ⇒
// L1/L2 的项目归属判定整体失效且不报错。现已收敛到 util/agent-dir.ts。
//
// 全部用临时 agentDir，不依赖本机真实 sessions 目录（干净机器上没有 sessions，
// 断言「非空」会假失败）。唯一读真实路径的是 A 组，只比对取值不比对内容。
//
// 用法：node --experimental-strip-types scripts/verify-agent-dir.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAgentDir, resolveSessionsDir } from "../util/agent-dir.ts";
import { listKnownProjects } from "../memory/l1/config.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

/** 分隔符归一：join 出的 "C:\a\b" 与模板串的 "C:/a/b" 是同一目录，只是形态不同。 */
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** 建一个带假 sessions 的临时 agentDir，让 listKnownProjects() 有东西可找。 */
function makeAgentDir(projects: string[]): string {
	const agentDir = mkdtempSync(join(tmpdir(), "agentdir-"));
	const sessions = join(agentDir, "sessions");
	mkdirSync(sessions, { recursive: true });
	for (const p of projects) {
		const dirName = `--${p.replace(/[:\\/]/g, "-")}--`;
		const dir = join(sessions, dirName);
		mkdirSync(dir, { recursive: true });
		// session 文件首行是 header，listKnownProjects 优先读它的 cwd
		writeFileSync(join(dir, "sess.jsonl"), JSON.stringify({ type: "session", cwd: p }) + "\n", "utf-8");
	}
	return agentDir;
}

const saved = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
const roots: string[] = [];

function restoreEnv(): void {
	for (const k of ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

function main(): void {
	try {
		// ── A 不设环境变量：与修复前的 getAgentDir() 指向同一目录 ────────────
		console.log("\n=== A. 默认解析（无环境变量）===");
		delete process.env.PI_CODING_AGENT_DIR;
		{
			const expected = join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent");
			check("A1 默认解析到 <home>/.pi/agent", norm(resolveAgentDir()) === norm(expected), resolveAgentDir());
			check("A2 sessions 目录直接挂在 agent 根下，没有多一层 .pi/agent",
				norm(resolveSessionsDir()) === norm(join(expected, "sessions")), resolveSessionsDir());
		}

		// ── B 设了 PI_CODING_AGENT_DIR：不得二次拼接 ────────────────────────
		console.log("\n=== B. 设了 PI_CODING_AGENT_DIR（原 bug 的触发条件）===");
		{
			const agentDir = makeAgentDir(["C:/proj/alpha", "C:/proj/beta"]);
			roots.push(agentDir);
			process.env.PI_CODING_AGENT_DIR = agentDir;

			const buggy = join(agentDir, ".pi", "agent", "sessions");
			check("B1 阳性对照：旧写法确实会拼出双层路径", norm(buggy) === norm(`${agentDir}/.pi/agent/sessions`), buggy);

			check("B2 环境变量给的就是 agent 根，不再追加 .pi/agent",
				norm(resolveAgentDir()) === norm(agentDir), resolveAgentDir());
			check("B3 sessions 目录没被二次拼接",
				norm(resolveSessionsDir()) === norm(join(agentDir, "sessions")) &&
					norm(resolveSessionsDir()) !== norm(buggy), resolveSessionsDir());

			const found = listKnownProjects();
			check("B4 listKnownProjects 能列出项目（修复前恒为 []）", found.length === 2, `found=${JSON.stringify(found)}`);
		}

		// ── C 环境变量优先于 HOME ──────────────────────────────────────────
		console.log("\n=== C. 优先级 ===");
		{
			const agentDir = makeAgentDir(["C:/proj/gamma"]);
			roots.push(agentDir);
			process.env.HOME = "C:/somewhere/else";
			process.env.USERPROFILE = "C:/somewhere/else";
			process.env.PI_CODING_AGENT_DIR = agentDir;
			check("C1 PI_CODING_AGENT_DIR 覆盖 HOME/USERPROFILE",
				norm(resolveAgentDir()) === norm(agentDir), resolveAgentDir());
		}

		// ── D HOME 与 USERPROFILE 全缺：不得退化成相对路径 ──────────────────
		console.log("\n=== D. HOME/USERPROFILE 全缺（服务化启动 / CI）===");
		{
			delete process.env.HOME;
			delete process.env.USERPROFILE;
			delete process.env.PI_CODING_AGENT_DIR;
			const got = resolveAgentDir();
			const isAbsolute = norm(got) === norm(resolve(homedir(), ".pi", "agent"));
			// 修复前：join("", ".pi", "agent") = ".pi/agent" —— 相对路径，跟着 cwd 跑偏
			check("D1 仍是绝对路径，不是相对路径 .pi/agent", isAbsolute, got);
			check("D2 不等于裸的 .pi/agent", norm(got) !== ".pi/agent", got);
		}

		// ── E sessions 目录不存在时返回空而不是抛错 ────────────────────────
		console.log("\n=== E. 边界 ===");
		{
			const empty = mkdtempSync(join(tmpdir(), "agentdir-empty-"));
			roots.push(empty);
			process.env.PI_CODING_AGENT_DIR = empty;
			check("E1 sessions 目录不存在时返回空数组", listKnownProjects().length === 0);
		}
	} finally {
		restoreEnv();
		for (const r of roots) {
			try {
				rmSync(r, { recursive: true, force: true });
			} catch {
				// 清理失败不影响结论
			}
		}
	}

	console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
	if (fail > 0) process.exit(1);
}

main();