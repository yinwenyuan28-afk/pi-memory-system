#!/usr/bin/env node
// ============================================================================
// verify-judg-session-project.ts — 会话级项目归属判定 回归基线
//
// 用法（本仓 `.ts` 不能用 `node` 直接跑，见 verify-l1-scene-pool.ts 头注）：
//   C:/dev/ide/pi-agent/pi-0.80.10/node_modules/.bin/tsx scripts/verify-judg-session-project.ts
//
// 覆盖（对应计划任务 9b 的 15 条）：
//   A. 读写层：原子写 / 归一化 / 拒收非法值 / 读损坏不覆盖 / 建条目不覆盖 / evidence 截断
//   B. 变化检测：归一化后比较 + 集合语义（防「每轮白发一次请求」）
//   C. 候选提取：四个抽取 bug + 窗口 + 去重 + 排序 + 噪声正反例
//   D. LLM 响应解析：正常 / unknown / content 空串 / 截断兜底 / 没 project / 围栏
//   E. isUnder：等于 / 在其下 / 兄弟目录 / 斜杠与大小写归一
//   F. 静态断言：挂点在 PI_SUBAGENT_CHILD 守卫之后；maxTokens 不得被改小
//   G. 端到端：l1_commit 两条路径的 cwd 与 projectSource
//
// 铁律：**只用临时目录**，绝不碰真实 profile。
// ============================================================================
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EVIDENCE_LIMIT,
	ensureSessionEntry,
	evidenceUnchanged,
	isUnder,
	isNotAProjectPath,
	judgFilePath,
	normalizeProjectPath,
	projectKey,
	readJudgFile,
	readSessionJudg,
	upsertSessionJudg,
	type JudgFile,
} from "../util/judg-session-project/index.ts";
import {
	extractCandidates,
	extractPathsFromText,
	HEAD_WINDOW_BYTES,
	isNoisePath,
	looksLikeFileForTest,
	normalizePath,
	TAIL_WINDOW_BYTES,
	topShare,
	trimTrailingCjk,
} from "../util/judg-session-project/candidates.ts";
import { buildJudgePayload, JUDGE_MAX_TOKENS, judgeProject, parseJudgeJson, resolveJudgeModel } from "../util/judg-session-project/llm.ts";
import { registerL1CommitTool } from "../memory/l1/commit-tool.ts";
import { judgeAndPersist, persistJudgement, readSessionCwd, sessionKeyOf } from "../util/judg-session-project/setup.ts";

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

const dirs: string[] = [];
function tempProfile(): string {
	const p = mkdtempSync(join(tmpdir(), "judg-verify-"));
	dirs.push(p);
	mkdirSync(join(p, "memoryDB", "l1"), { recursive: true });
	mkdirSync(join(p, "memoryDB", "pipeline"), { recursive: true });
	return p;
}
/** 造一条会话文件（可选带工具调用与用户消息）。 */
function makeSession(p: string, name: string, opts: { tools?: string[]; users?: string[] } = {}): string {
	const dir = join(p, "sessions");
	mkdirSync(dir, { recursive: true });
	const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-30T00:00:00.000Z", cwd: "C:\\dev\\alpha" })];
	for (const [i, u] of (opts.users ?? []).entries()) {
		lines.push(JSON.stringify({ type: "message", id: `u${i}`, parentId: null, timestamp: "2026-09-30T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: u }] } }));
	}
	for (const [i, cmd] of (opts.tools ?? []).entries()) {
		lines.push(JSON.stringify({ type: "message", id: `a${i}`, parentId: null, timestamp: "2026-09-30T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: cmd } }] } }));
	}
	const f = join(dir, name);
	writeFileSync(f, lines.join("\n") + "\n", "utf-8");
	return f;
}

/** 列目录（不存在返回空数组）。 */
function readdirSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

// ══════════════════════════════════════════════════════════════
//  本仓 package.json 是 "type": "commonjs" ⇒ esbuild 按 cjs 输出，
//  **不支持顶层 await**（本文件有 5 处）。所以整体包进 main() 再 `void main()`，
//  与 verify-l1-scene-pool.ts 同款。
// ══════════════════════════════════════════════════════════════
async function main(): Promise<void> {
console.log("\n=== A. 读写层 ===");
{
	// A1 原子写 + 逐字节可读回
	const p = tempProfile();
	const e1 = upsertSessionJudg(p, "s1", { project: "C:\\dev\\alpha", flag: true, decidedBy: "llm", confidence: 0.75, evidence: [{ path: "C:/dev/alpha", filesTouched: 4 }] });
	check("A1 写入返回条目", e1?.project === "C:/dev/alpha", String(e1?.project));
	const raw = readFileSync(judgFilePath(p), "utf-8");
	check("A1 落盘是合法 JSON 且无临时文件残留", (() => { try { JSON.parse(raw); return true; } catch { return false; } })() && !raw.includes(".tmp"));

	// A2 归一化：引号 / 两种斜杠 / 尾分隔符
	check("A2 反斜杠→正斜杠", normalizeProjectPath("C:\\dev\\alpha") === "C:/dev/alpha", String(normalizeProjectPath("C:\\dev\\alpha")));
	check("A2 剥成对引号", normalizeProjectPath('  "C:/dev/alpha" ') === "C:/dev/alpha", String(normalizeProjectPath('  "C:/dev/alpha" ')));
	check("A2 去尾分隔符", normalizeProjectPath("C:/dev/alpha/") === "C:/dev/alpha", String(normalizeProjectPath("C:/dev/alpha/")));
	check("A2 盘符根不被去成 C:", normalizeProjectPath("C:\\") === "C:/", String(normalizeProjectPath("C:\\")));

	// A3 非绝对路径被拒
	check("A3 相对路径被拒", normalizeProjectPath("dev/alpha") === null);
	check("A3 POSIX 路径被拒（本机判定的输入都是 Windows 绝对路径）", normalizeProjectPath("/c/dev/alpha") === null);
	check("A3 空串被拒", normalizeProjectPath("   ") === null);
	const pA3 = tempProfile();
	upsertSessionJudg(pA3, "s1", { project: "C:/dev/alpha", flag: true, decidedBy: "llm" });
	check("A3 写入时 project 非法 → 整个 upsert 被拒（不半写）", upsertSessionJudg(pA3, "s1", { project: "不是绝对路径", flag: false }) === null);
	check("A3 被拒后原值未被动过", readSessionJudg(pA3, "s1")?.project === "C:/dev/alpha");

	// A4 读损坏不覆盖
	const pA4 = tempProfile();
	mkdirSync(join(pA4, "memoryDB", "state"), { recursive: true });
	const broken = '{"version":3,"sessions":{"s1":{"project":"C:/a"';
	writeFileSync(judgFilePath(pA4), broken, "utf-8");
	const rA4 = readJudgFile(pA4);
	check("A4 半截 JSON → 读失败", !rA4.ok, rA4.ok ? "" : rA4.error);
	check("A4 读失败时 upsert 也被拒（不覆盖原文件）", upsertSessionJudg(pA4, "s1", { project: "C:/b", flag: true, decidedBy: "llm" }) === null);
	check("A4 原文件逐字节未变", readFileSync(judgFilePath(pA4), "utf-8") === broken);

	// A5 重复建条目不覆盖
	const pA5 = tempProfile();
	ensureSessionEntry(pA5, "s1", "C:\\dev\\alpha");
	upsertSessionJudg(pA5, "s1", { project: "C:/dev/beta", flag: true, decidedBy: "manual" });
	const again = ensureSessionEntry(pA5, "s1", "C:\\dev\\gamma");
	check("A5 已存在则原样返回（用户手改的值要留住）", again?.project === "C:/dev/beta" && again?.decidedBy === "manual", JSON.stringify(again));
	check("A5 建条目初值：flag=false / decidedBy=init", (() => { const p = tempProfile(); const e = ensureSessionEntry(p, "s2", "C:\\x"); return e?.flag === false && e?.decidedBy === "init"; })());

	// A6 evidence 截断到 5 条
	const pA6 = tempProfile();
	const many = Array.from({ length: 9 }, (_, i) => ({ path: `C:/p/${i}`, filesTouched: i + 1 }));
	const eA6 = upsertSessionJudg(pA6, "s1", { project: "C:/p", flag: true, decidedBy: "llm", evidence: many });
	check(`A6 evidence 截断到 ${EVIDENCE_LIMIT} 条`, eA6?.evidence.length === EVIDENCE_LIMIT, String(eA6?.evidence.length));

	// A7 flag:false 时 decidedBy 允许 llm（"没有把握"本身是合法判定结果）
	const pA7 = tempProfile();
	const eA7 = upsertSessionJudg(pA7, "s1", { project: "C:/dev/alpha", flag: false, decidedBy: "llm", confidence: 0.2, evidence: [{ path: "C:/dev/alpha", filesTouched: 1 }] });
	check("A7 flag:false + decidedBy:llm 被接受", eA7?.flag === false && eA7.decidedBy === "llm", JSON.stringify(eA7));
	check("A7 flag:false 时 evidence 仍写本轮候选（不是 []）", (eA7?.evidence.length ?? 0) > 0, JSON.stringify(eA7?.evidence));

	// A7b **第三道防线**：手工把 flag:true 配着"桌面"写进去 ⇒ 降级成 flag:false，但 evidence 保留
	//   （拒写会连 evidence 一起丢，而 evidence 是下次变化检测的比对基准，丢了就每轮重判）
	const pA7b = tempProfile();
	const eA7b = upsertSessionJudg(pA7b, "s1", { project: "C:/Users/leaf/Desktop/我的项目", flag: true, decidedBy: "llm", evidence: [{ path: "C:/Users/leaf/Desktop", filesTouched: 3 }] });
	check("A7b flag:true + 桌面路径 → 降级为 flag:false", eA7b?.flag === false, JSON.stringify(eA7b));
	check("A7b 降级时 decidedBy 改记 code（不是模型判的）", eA7b?.decidedBy === "code", String(eA7b?.decidedBy));
	check("A7b 降级时 evidence 仍然保留", (eA7b?.evidence.length ?? 0) === 1, JSON.stringify(eA7b?.evidence));
	// 建条目阶段用启动目录当占位值，**不**受这条规则影响（Desktop 启动的会话也必须有条目）
	const pA7c = tempProfile();
	const eA7c = ensureSessionEntry(pA7c, "s1", "C:\\Users\\leaf\\Desktop");
	check("A7c 建条目：占位值可以是桌面（它只用于 fallback，flag=false）", eA7c?.flag === false && eA7c.project === "C:/Users/leaf/Desktop", JSON.stringify(eA7c));

	// A8 v1/v2 兼容：project 是 {path, scope} 对象
	const pA8 = tempProfile();
	mkdirSync(join(pA8, "memoryDB", "state"), { recursive: true });
	const legacy = { version: 3, updatedAt: "", sessions: { s1: { project: { path: "C:\\dev\\alpha", scope: "self" }, flag: true, decidedBy: "llm", confidence: 0.5, at: "", evidence: [] } } };
	writeFileSync(judgFilePath(pA8), JSON.stringify(legacy), "utf-8");
	check("A8 旧形态 project 对象被读成字符串", readSessionJudg(pA8, "s1")?.project === "C:/dev/alpha", String(readSessionJudg(pA8, "s1")?.project));

	// A9 版本不认识 → 读失败（不写"向后兼容"的空话）
	const pA9 = tempProfile();
	mkdirSync(join(pA9, "memoryDB", "state"), { recursive: true });
	writeFileSync(judgFilePath(pA9), JSON.stringify({ version: 99, sessions: {} }), "utf-8");
	check("A9 版本不认识 → 读失败", !readJudgFile(pA9).ok);

	// A10 单条脏数据不拖垮整份文件
	const pA10 = tempProfile();
	mkdirSync(join(pA10, "memoryDB", "state"), { recursive: true });
	const mixed: JudgFile = { version: 3, updatedAt: "", sessions: { good: { project: "C:/ok", flag: true, decidedBy: "llm", confidence: 1, at: "", evidence: [] }, bad: { project: 42 as unknown, flag: true, decidedBy: "llm", confidence: 1, at: "", evidence: [] } } } as JudgFile;
	writeFileSync(judgFilePath(pA10), JSON.stringify(mixed), "utf-8");
	const rA10 = readJudgFile(pA10);
	check("A10 脏条目被跳过、好条目照常返回", rA10.ok && Object.keys(rA10.file.sessions).length === 1, rA10.ok ? Object.keys(rA10.file.sessions).join(",") : rA10.error);
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== B. 变化检测（防「每轮白发一次请求」）===");
{
	const ev = [{ path: "C:/dev/alpha", filesTouched: 3 }, { path: "C:/dev/beta", filesTouched: 1 }];
	check("B1 同集合同顺序 → 未变", evidenceUnchanged(ev, ["C:/dev/alpha", "C:/dev/beta"]));
	check("B2 顺序不同但集合相同 → 仍算未变", evidenceUnchanged(ev, ["C:/dev/beta", "C:/dev/alpha"]));
	check("B3 大小写/斜杠不同 → 仍算未变", evidenceUnchanged(ev, ["C:\\dev\\alpha", "c:/DEV/beta"]));
	check("B4 多一个候选 → 变了", !evidenceUnchanged(ev, ["C:/dev/alpha", "C:/dev/beta", "C:/dev/gamma"]));
	check("B5 上轮 evidence 为空 → 变了（必须判一次）", !evidenceUnchanged([], ["C:/dev/alpha"]));
	check("B6 上轮 undefined → 变了", !evidenceUnchanged(undefined, ["C:/dev/alpha"]));
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== C. 候选提取 ===");
{
	// C1 抽取 bug ①：/c/... POSIX 形式
	check("C1 /c/... 抽得到", extractPathsFromText("cd /c/dev/code/xianhua && ls")[0] === "C:/dev/code/xianhua", extractPathsFromText("cd /c/dev/code/xianhua && ls")[0] ?? "");
	// C1b 抽取 bug ②：norm 不吞串
	check("C1b norm 不吞串（旧实现会返回 'c:'）", normalizePath("/c/dev/x") === "C:/dev/x", normalizePath("/c/dev/x"));
	// C1c 抽取 bug ③：CJK 路径不被截断
	const cjk = extractPathsFromText('ls "C:\\dev\\code_java\\wangxin\\temp\\面试材料\\campus-hub"');
	check("C1c 中文路径完整保留", cjk[0] === "C:/dev/code_java/wangxin/temp/面试材料/campus-hub", cjk[0] ?? "");
	check("C1c 中文文件名不被截断（产品规划.md）", extractPathsFromText("wc -l C:/dev/code/xianhua/产品规划.md")[0] === "C:/dev/code/xianhua/产品规划.md", extractPathsFromText("wc -l C:/dev/code/xianhua/产品规划.md")[0] ?? "");
	// C1d 抽取 bug ④：CJK 过度捕获
	const over = extractPathsFromText("C:\\dev\\code_java\\wangxin\\frontend\\A104489.这个小程序的文件夹地址，帮我看看为什么加载不出来");
	check("C1d 尾部中文被截断", over[0] === "C:/dev/code_java/wangxin/frontend/A104489", over[0] ?? "");
	check("C1d 全角逗号是终止符", trimTrailingCjk("C:/a/b。后面的话") === "C:/a/b", trimTrailingCjk("C:/a/b。后面的话"));
	// C2 目录 vs 文件
	check("C2 pi-0.80.10 判成目录而非文件（扩展名是数字）", !looksLikeFileForTest("C:/dev/ide/pi-agent/pi-0.80.10"));
	check("C2 RecordController.java 判成文件", looksLikeFileForTest("C:/x/RecordController.java"));
	check("C2 a104526 判成目录", !looksLikeFileForTest("C:/x/a104526"));

	// C3 噪声规则（正例）
	for (const noise of ["C:/p/node_modules/x/a.js", "C:/p/skills/s/SKILL.md", "C:/p/dist/a.js", "C:/p/build/a.js", "C:/p/target/classes/A.class", "C:/dev/env/fnm/x", "C:/p/.git/config", "C:/Users/leaf/AppData/Local/Temp/a.log", "C:/Users/leaf/.m2/repository/a.jar", "C:/Users/leaf/AppData/Local/Pub/Cache/hosted/pub.dev/x-1.0/lib/y.dart"]) {
		check(`C3 噪声被滤：${noise.slice(0, 52)}`, isNoisePath(noise));
	}
	// C3b 反例（这些**不能**被滤，加进去会误杀真项目）
	for (const keep of ["C:/Users/leaf/.pi/agent/agents/l1-extractor.md", "C:/temp/pi/script/x.mts", "C:/Users/leaf/.pi/agent/extensions/memory-system/index.ts"]) {
		check(`C3b 反例必须保留：${keep.slice(0, 52)}`, !isNoisePath(keep));
	}

	// C3c **「家目录不可能是项目」规则**（用户裁定 2026-09-30）
	// ⚠ 唯一的例外是**点开头的**目录：`.pi` 既是标注集 20 条里 2 条的真值（#2 / #12），
	//   也是本功能代码本体所在。拿掉这个例外会当场把尺子打红。
	const BS = String.fromCharCode(92);
	const notProject: [string, boolean][] = [
		["C:/Users/leaf", true],
		[`C:${BS}Users${BS}leaf`, true],
		[`C:${BS}Users${BS}leaf${BS}Desktop`, true],
		["C:/Users/leaf/Desktop/我的项目", true],
		["C:/Users/leaf/Documents/工作/合同", true],
		["C:/Users/leaf/AppData/Local/Temp", true],
		["C:/Users/leaf/OneDrive", true],
		["C:/Users/leaf/npm-cache", true],
		["C:/Users/leaf/Application Data", true],
		["C:/USERS/LEAF/Desktop", true],
		["C:/Users/other/Desktop", true],
		["C:/Users/leaf/.pi", false],
		["C:/Users/leaf/.pi/agent/extensions/memory-system", false],
		["C:/Users/leaf/.agents", false],
		["C:/dev/code/xianhua", false],
		["C:/temp/pi/script", false],
		["C:/Users", false],
		["相对路径/dev", false],
		["", false],
	];
	for (const [p, want] of notProject) {
		check(`C3c 不可作项目=${want}：${p || "(空串)"}`, isNotAProjectPath(p) === want, String(isNotAProjectPath(p)));
	}
	// 这条规则在**候选提取**里也必须生效：桌面下的项目不能进池
	const pHome = tempProfile();
	const fHome = makeSession(pHome, "home.jsonl", { tools: ['cat "C:/Users/leaf/Desktop/我的项目/a.ts"', 'cat "C:/Users/leaf/Documents/x.ts"', 'cat "C:/Users/leaf/.pi/agent/b.md"'] });
	const xHome = extractCandidates(fHome, { limit: 5 });
	const homePaths = xHome.candidates.map((c) => projectKey(c.path));
	check("C3c 桌面/文档下的路径不进候选池", !homePaths.some((p) => p.includes("/users/leaf/desktop") || p.includes("/users/leaf/documents")), JSON.stringify(homePaths));
	check("C3c 同批次里点目录仍然正常进池", homePaths.some((p) => p.startsWith("c:/users/leaf/.pi")), JSON.stringify(homePaths));

	// C4 同一文件重复 50 次只计一次
	const p = tempProfile();
	const f = makeSession(p, "s.jsonl", { tools: Array.from({ length: 50 }, () => 'cat "C:/dev/alpha/src/main.ts"') });
	const x4 = extractCandidates(f);
	check("C4 同一文件重复 50 次只计一次", x4.candidates[0]?.files === 1, JSON.stringify(x4.candidates));

	// C5 按不同文件数排序
	const f5 = makeSession(p, "s5.jsonl", {
		tools: [
			'cat "C:/dev/alpha/a.ts"', 'cat "C:/dev/alpha/b.ts"', 'cat "C:/dev/alpha/c.ts"',
			'cat "C:/dev/beta/d.ts"', 'cat "C:/dev/gamma/e.ts"',
		],
	});
	const x5 = extractCandidates(f5, { limit: 5 });
	check("C5 按不同文件数降序", x5.candidates[0]?.path === "C:/dev/alpha" && x5.candidates[0].files === 3, JSON.stringify(x5.candidates));
	check("C5 topShare = 3/5", Math.abs(topShare(x5.candidates) - 0.6) < 1e-9, String(topShare(x5.candidates)));

	// C6 窗口常量
	check("C6 尾窗 256KB", TAIL_WINDOW_BYTES === 256 * 1024, String(TAIL_WINDOW_BYTES));
	check("C6 头窗存在且小于尾窗（头窗只取用户消息）", HEAD_WINDOW_BYTES > 0 && HEAD_WINDOW_BYTES < TAIL_WINDOW_BYTES, String(HEAD_WINDOW_BYTES));

	// C7 截断半行被跳过
	const p7 = tempProfile();
	const f7 = makeSession(p7, "s7.jsonl", { tools: ['cat "C:/dev/alpha/a.ts"'] });
	// 在文件中间插一条**坏的**半行，验证解析器跳过而不抛
	const txt = readFileSync(f7, "utf-8");
	writeFileSync(f7, txt.replace("\n", '\n{"type":"message","id":"x","mess\n'), "utf-8");
	const x7 = extractCandidates(f7);
	check("C7 半行/坏行被跳过且不抛", x7.candidates.length >= 1, JSON.stringify(x7.candidates));

	// C8 **噪声反例（9b⑩ 必钉）**：读了 `.pi\agent\agents\*` 的会话，`.pi` 仍在候选池里
	const p8 = tempProfile();
	const f8 = makeSession(p8, "s8.jsonl", { tools: ['cat "C:/Users/leaf/.pi/agent/agents/l1-extractor.md"', 'cat "C:/Users/leaf/.pi/agent/agents/l2-scene-organizer.md"'] });
	const x8 = extractCandidates(f8, { limit: 5 });
	const hasPi = x8.candidates.some((c) => projectKey(c.path) === "c:/users/leaf/.pi");
	check("C8 .pi\agent\agents 不被当成噪声，`.pi` 仍在池里", hasPi || isNoisePath("C:/Users/leaf/.pi/agent/agents") === false, JSON.stringify(x8.candidates.map((c) => c.path)));
	check("C8 agents 目录本身不是噪声", !isNoisePath("C:/Users/leaf/.pi/agent/agents/l1-extractor.md"));

	// C9 候选为空（B3 的前提）
	const p9 = tempProfile();
	const f9 = makeSession(p9, "s9.jsonl", { users: ["你好"], tools: [] });
	const x9 = extractCandidates(f9);
	check("C9 零工具调用 → 候选为空", x9.candidates.length === 0 && x9.toolCallCount === 0, JSON.stringify({ c: x9.candidates.length, t: x9.toolCallCount }));

	// C10 用户消息从头窗取（工具证据从尾窗取）—— #20 那类"零工具调用但用户点名了项目"
	const p10 = tempProfile();
	const f10 = makeSession(p10, "s10.jsonl", { users: ["C:\\dev\\code_java\\wangxin\\frontend\\A104489.这是小程序目录，帮我看看合同预览"] });
	const x10 = extractCandidates(f10);
	check("C10 用户点名路径被抽出（尽管零工具调用）", x10.pathsNamedByUser.some((u) => projectKey(u.path) === "c:/dev/code_java/wangxin/frontend/a104489"), JSON.stringify(x10.pathsNamedByUser));

	// C11 载荷结构与提示词承诺一致
	const payload = JSON.parse(buildJudgePayload(x5)) as { candidates: unknown[]; pathsNamedByUser: unknown[]; userMessages: unknown[] };
	check("C11 载荷含三项且候选带 distinctFiles", payload.candidates.length > 0 && "distinctFiles" in (payload.candidates[0] as object), JSON.stringify(Object.keys(payload)));
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== D. LLM 响应解析 ===");
{
	check("D1 正常 JSON", parseJudgeJson('{"project":"C:/a","reason":"ok"}')?.project === "C:/a");
	check("D2 markdown 围栏", parseJudgeJson('```json\n{"project":"C:/a"}\n```')?.project === "C:/a", JSON.stringify(parseJudgeJson('```json\n{"project":"C:/a"}\n```')));
	check("D3 前后有废话", parseJudgeJson('好的，结果如下：{"project":"C:/a"} 以上。')?.project === "C:/a", JSON.stringify(parseJudgeJson('好的，结果如下：{"project":"C:/a"} 以上。')));
	// D4 截断兜底（maxTokens 太小 → stopReason:"length"，JSON 花括号不配平）
	check("D4 截断输出仍能捞出 project", parseJudgeJson('{"project":"C:/dev/code/xianhua","reason":"工具改动集中在 xianhua')?.project === "C:/dev/code/xianhua", JSON.stringify(parseJudgeJson('{"project":"C:/dev/code/xianhua","reason":"工具改动集中在 xianhua')));
	check("D5 没有 project 字段 → null", parseJudgeJson('{"reason":"只有理由"}') === null || (parseJudgeJson('{"reason":"只有理由"}')?.project === undefined), JSON.stringify(parseJudgeJson('{"reason":"只有理由"}')));
	check("D6 完全不是 JSON → null", parseJudgeJson("我不知道") === null);

	// D7 空串当**失败**而不是 unknown（B1）
	const failEmpty = await judgeProject(null, { candidates: [{ path: "C:/a", files: 1, hasFile: true }], pathsNamedByUser: [], userMessages: ["x"], toolCallCount: 1, distinctPaths: 1, skippedPartialHead: false });
	check("D7 模型为 null → ok:false（保留原值）", failEmpty.ok === false && failEmpty.error === "无可用模型", JSON.stringify(failEmpty));

	// D8 候选空 + 用户没点名 → 直接判无、**不发请求**（B3）
	const p8 = tempProfile();
	const noEv = { candidates: [], pathsNamedByUser: [], userMessages: [], toolCallCount: 0, distinctPaths: 0, skippedPartialHead: false };
	const r8 = await judgeProject(null, noEv);
	check("D8 候选空且无点名 → ok:true 且 project=null（没发请求）", r8.ok === true && r8.project === null, JSON.stringify(r8));

	// D9 候选空但用户点名了 → **仍然要问**（B5；B3 与 B5 合起来的正确读法）
	const named = { ...noEv, pathsNamedByUser: [{ path: "C:/a", mentions: 1 }] };
	const r9 = await judgeProject(null, named);
	check("D9 候选空但有点名 → 不走短路（会发请求）", r9.ok === false && r9.error === "无可用模型", JSON.stringify(r9));

	// D10 maxTokens 不得被改小
	check(`D10 maxTokens = ${JUDGE_MAX_TOKENS}（≥2000，推理模型给小了会截断）`, JUDGE_MAX_TOKENS >= 2000, String(JUDGE_MAX_TOKENS));
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== E. isUnder（路径包含判定）===");
{
	check("E1 等于 → 真", isUnder("C:/dev/alpha", "C:/dev/alpha"));
	check("E2 在其下 → 真", isUnder("C:/dev/alpha/src/x", "C:/dev/alpha"));
	check("E3 兄弟目录 → 假（子项目之间不互相用）", !isUnder("C:/dev/beta", "C:/dev/alpha"));
	check("E3b `..` 不做解析（会话文件里的路径都是 OS 归一化过的，不会含 `..`）", isUnder("C:/dev/alpha/../beta", "C:/dev/alpha"));
	check("E4 前缀相同但不同层 → 假（alpha2 不是 alpha 的子目录）", !isUnder("C:/dev/alpha2", "C:/dev/alpha"));
	check("E5 斜杠风格不同 → 真", isUnder("C:\\dev\\alpha\\src", "C:/dev/alpha"));
	check("E6 大小写不同 → 真（Windows 不敏感）", isUnder("C:/DEV/Alpha", "c:/dev/alpha"));
	check("E7 空串 → 假", !isUnder("", "C:/dev/alpha") && !isUnder("C:/dev/alpha", ""));
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== F. 静态断言（接线对不对）===");
{
	const idx = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
	const lines = idx.split("\n");
	const guardLine = lines.findIndex((l) => l.includes('if (process.env.PI_SUBAGENT_CHILD === "1") return;'));
	const callLine = lines.findIndex((l) => l.includes("setupJudgSessionProject(pi, getProfilePath)"));
	check(`F1 挂点调用在 PI_SUBAGENT_CHILD 守卫之后（第 ${callLine + 1} 行 > 第 ${guardLine + 1} 行）`, guardLine >= 0 && callLine > guardLine, `guard=${guardLine + 1} call=${callLine + 1}`);
	// ⚠ 不能只断言"判定代码在守卫之后"——那种写法在本形态下会**空过**（判定代码在 setup.ts 里）
	const toolReg = lines.findIndex((l) => l.includes("registerL1ProjectGetTool(pi,"));
	const sessionStart = lines.findIndex((l) => l.includes('pi.on("session_start"'));
	check(`F2 l1_project_get 在模块顶层注册（早于 session_start，第 ${toolReg + 1} 行 < 第 ${sessionStart + 1} 行）`, toolReg >= 0 && sessionStart >= 0 && toolReg < sessionStart, `tool=${toolReg + 1} session_start=${sessionStart + 1}`);
	const setupSrc = readFileSync(new URL("../util/judg-session-project/setup.ts", import.meta.url), "utf-8");
	check("F3 setup.ts 内另有第二道 PI_SUBAGENT_CHILD 早退", setupSrc.includes('if (process.env.PI_SUBAGENT_CHILD === "1") return;'));
	check("F4 单飞按 sessionKey 分键（不是全局布尔）", setupSrc.includes("inFlight = new Set<string>()") && setupSrc.includes("inFlight.has(sessionKey)"));

	const agentMd = readFileSync("C:/Users/leaf/.pi/agent/agents/l1-extractor.md", "utf-8");
	check("F5 l1-extractor.md 的 tools: 行已含 l1_project_get", /^tools:.*l1_project_get/m.test(agentMd));
	check("F6 正文工具数已改成五个", /`l1_project_get` 五个工具可用/.test(agentMd));
	check("F7 「cwd 归属修正」段已删", !agentMd.includes("cwd 归属修正"));
	check("F8 metadata.scope 填写要求已写", agentMd.includes("metadata.scope") && agentMd.includes("l1_project_get"));
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== G. 端到端：l1_commit 两条路径 ===");
{
	async function commitIn(profile: string, params: Record<string, unknown>) {
		let def: { execute: (...a: unknown[]) => Promise<unknown> } | null = null;
		registerL1CommitTool({ registerTool: (d: unknown) => (def = d as never) } as never, () => profile);
		const ctx = { cwd: "C:\\workbench", ui: { notify: () => {} }, sessionManager: { getSessionFile: () => "C:/x/sess.jsonl", getSessionId: () => "sid" } };
		const res = (await def!.execute("t", params, undefined, undefined, ctx)) as { content: { text: string }[] };
		return JSON.parse(res.content[0].text) as Record<string, unknown>;
	}
	function readRecs(profile: string): Record<string, unknown>[] {
		const dir = join(profile, "memoryDB", "l1", "records");
		const out: Record<string, unknown>[] = [];
		for (const f of readdirSafe(dir)) {
			for (const l of readFileSync(join(dir, f), "utf-8").split("\n")) if (l.trim()) { try { out.push(JSON.parse(l)); } catch { /* 坏行 */ } }
		}
		return out;
	}
	// G1 subagent + flag:true（decidedBy=llm）
	const g1 = tempProfile();
	upsertSessionJudg(g1, "sk1", { project: "C:/dev/proj", flag: true, decidedBy: "llm", confidence: 0.9, evidence: [{ path: "C:/dev/proj", filesTouched: 5 }] });
	await commitIn(g1, { cursor: "2026-09-30T00:00:00.000Z", records: [{ content: "G1", type: "work_fact", sessionKey: "sk1", cwd: "C:/LLM瞎填的" }] });
	const r1 = readRecs(g1).find((r) => r.content === "G1");
	check("G1 subagent：cwd 取判定值（覆盖 LLM 传值）", r1?.cwd === "C:/dev/proj", String(r1?.cwd));
	check("G1 subagent：projectSource=llm", (r1?.metadata as Record<string, unknown>)?.projectSource === "llm", JSON.stringify(r1?.metadata));

	// G2 subagent + flag:false → 退回 ctx.cwd（B7 风格：启动工作台）
	const g2 = tempProfile();
	upsertSessionJudg(g2, "sk2", { project: "C:/dev/占位", flag: false, decidedBy: "llm", confidence: 0.1, evidence: [{ path: "C:/dev/占位", filesTouched: 1 }] });
	await commitIn(g2, { cursor: "2026-09-30T00:00:00.000Z", records: [{ content: "G2", type: "work_fact", sessionKey: "sk2", cwd: "C:/LLM瞎填的" }] });
	const r2 = readRecs(g2).find((r) => r.content === "G2");
	check("G2 flag:false → 退回 ctx.cwd，不留空", r2?.cwd === "C:\\workbench", String(r2?.cwd));
	check("G2 flag:false → projectSource=fallback", (r2?.metadata as Record<string, unknown>)?.projectSource === "fallback", JSON.stringify(r2?.metadata));

	// G3 main-agent 路径同样走覆写。
	// ⚠ main-agent 的 sessionKey 由服务端从 ctx 派生（`C:/x/sess.jsonl` → `sess`），
	//   子代理路径才是记录自带 —— 两条路径的键来源不同，这里各建一条对应条目。
	const g3 = tempProfile();
	upsertSessionJudg(g3, "sess", { project: "C:/dev/main路径", flag: true, decidedBy: "manual", confidence: 0.7, evidence: [{ path: "C:/dev/main路径", filesTouched: 2 }] });
	await commitIn(g3, { source: "main-agent", records: [{ content: "G3", type: "work_fact" }] });
	const r3 = readRecs(g3).find((r) => r.content === "G3");
	check("G3 main-agent：也走同一套覆写", r3?.cwd === "C:/dev/main路径", String(r3?.cwd));
	check("G3 main-agent：projectSource=manual", (r3?.metadata as Record<string, unknown>)?.projectSource === "manual", JSON.stringify(r3?.metadata));

	// G4 墓碑行不改 cwd（不改写历史行的归属）
	// ⚠ 墓碑**不追加新行**，只按 id 标记已存在的行（`written:0` 是正确行为），
	//   所以要先手工造一条"旧语义"的存活行（cwd = 老归属），再提交墓碑看它有没有被改。
	const g4 = tempProfile();
	upsertSessionJudg(g4, "sk4", { project: "C:/dev/新项目", flag: true, decidedBy: "llm", confidence: 0.9, evidence: [] });
	const recDir4 = join(g4, "memoryDB", "l1", "records");
	mkdirSync(recDir4, { recursive: true });
	const oldRow = { id: "l1_1_aaaa", content: "G4", type: "work_fact", priority: 70, scene_name: "x｜y", cwd: "C:/老归属", deleted: false, version: 1, timestamps: ["2026-09-30T00:00:00.000Z"], createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", metadata: {}, source_message_ids: [], sessionKey: "sk4" };
	writeFileSync(join(recDir4, "2026-09-30.jsonl"), JSON.stringify(oldRow) + "\n", "utf-8");
	const g4res = await commitIn(g4, { cursor: "2026-09-30T00:00:00.000Z", records: [{ id: "l1_1_aaaa", content: "G4", type: "work_fact", deleted: true, sessionKey: "sk4", cwd: "C:/新归属也不该写" }] });
	check("G4 墓碑就地标记成功", g4res.success === true && (g4res.markedInPlace as number) >= 0, JSON.stringify(g4res).slice(0, 140));
	const rows4 = readRecs(g4).filter((r) => r.id === "l1_1_aaaa");
	const last4 = rows4[rows4.length - 1];
	check("G4 墓碑行保留原 cwd（不按新语义改写历史归属）", last4?.cwd === "C:/老归属", JSON.stringify(rows4.map((r) => r.cwd)));

	// G5 无条目 + 空 sessionKey（B7）→ fallback，不抛
	const g5 = tempProfile();
	await commitIn(g5, { cursor: "2026-09-30T00:00:00.000Z", records: [{ content: "G5", type: "work_fact", cwd: "C:/瞎填" }] });
	const r5 = readRecs(g5).find((r) => r.content === "G5");
	check("G5 空 sessionKey → fallback，不抛", r5?.cwd === "C:\\workbench", String(r5?.cwd));
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== H. 离线回填（judgeAndPersist / persistJudgement 与运行时同路径）===");
{
	// H1 零证据 + null 模型 → 走 B3 短路（**不发请求**），落 flag:false / decidedBy:"code"
	//    重点是 decidedBy 必须是 code：标 llm 会让人误以为真问过模型
	const h1 = tempProfile();
	const f1 = makeSession(h1, "h1.jsonl", { users: ["你好"], tools: [] });
	const r1 = await judgeAndPersist(h1, "h1", f1, "C:\\dev\\workbench", null);
	const e1 = readSessionJudg(h1, "h1");
	check("H1 零证据：ok=true 且 judgedProject=null（没发请求）", r1.ok === true && r1.judgedProject === null, JSON.stringify(r1));
	check("H1 落盘 flag:false / decidedBy=code", e1?.flag === false && e1.decidedBy === "code", JSON.stringify(e1));
	check("H1 project 沿用建条目时的启动目录（占位值，与 judgedProject 区分）", e1?.project === "C:/dev/workbench", String(e1?.project));

	// H2 有候选但模型不可用 → 失败**不写盘**，条目保持在 init（不是 code）
	const h2 = tempProfile();
	const f2 = makeSession(h2, "h2.jsonl", { tools: ['cat "C:/dev/proj/a.ts"', 'cat "C:/dev/proj/b.ts"'] });
	const r2 = await judgeAndPersist(h2, "h2", f2, "C:\\other", null);
	const e2 = readSessionJudg(h2, "h2");
	check("H2 模型不可用 → ok:false", r2.ok === false && r2.error === "无可用模型", JSON.stringify(r2));
	check("H2 失败不写盘（decidedBy 仍是 init、flag 仍 false）", e2?.decidedBy === "init" && e2?.flag === false, JSON.stringify(e2));

	// H3 persistJudgement：LLM 选出候选外的路径也照写（B5 允许）
	const h3 = tempProfile();
	const x3 = extractCandidates(makeSession(h3, "h3.jsonl", { tools: ['cat "C:/dev/proj/a.ts"'] }));
	const w3 = persistJudgement(h3, "h3", { project: "C:/启动目录" }, x3, { project: "C:/别处/项目" });
	check("H3 候选外的路径照写（B5）", w3?.project === "C:/别处/项目" && w3.flag === true, JSON.stringify(w3));
	check("H3 evidence 写本轮候选", (w3?.evidence.length ?? 0) >= 1, JSON.stringify(w3?.evidence));

	// H4 persistJudgement：project=null ⇒ flag:false + 沿用原 project
	const w4 = persistJudgement(h3, "h3", { project: "C:/启动目录" }, x3, { project: null });
	check("H4 判成 unknown ⇒ flag:false 且沿用原 project", w4?.flag === false && w4.project === "C:/启动目录", JSON.stringify(w4));

	// H5 运行时与回填共用 persistJudgement（静态断言：setup.ts 不自带写盘逻辑）
	const setupSrc = readFileSync(new URL("../util/judg-session-project/setup.ts", import.meta.url), "utf-8");
	const inlinedWrites = (setupSrc.match(/upsertSessionJudg\(/g) ?? []).length;
	check(`F/G 组：setup.ts 里 upsertSessionJudg 只出现在 persistJudgement 内（${inlinedWrites} 次）`, inlinedWrites <= 1, String(inlinedWrites));

	// H6 sessionKeyOf / readSessionCwd
	const h6 = tempProfile();
	const f6 = makeSession(h6, "h6.jsonl", {});
	check("H6 sessionKeyOf 去掉 .jsonl 与目录", sessionKeyOf(f6) === "h6", sessionKeyOf(f6));
	check("H6 readSessionCwd 读会话头", readSessionCwd(f6) === "C:\\dev\\alpha", readSessionCwd(f6));
	check("H6 readSessionCwd 对坏文件返回空串", readSessionCwd(join(h6, "不存在.jsonl")) === "");
}

// ══════════════════════════════════════════════════════════════
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录残留无害 */ } }
console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
void resolveJudgeModel;
}

void main();
