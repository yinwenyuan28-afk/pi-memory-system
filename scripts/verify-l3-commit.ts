// L3 画像条目级操作的回归基线（只读生产代码；只写系统临时目录）
//
// 覆盖 2026-09-16 查实并修复的缺陷：
//   · 旧 upsert 不幂等（替换时把旧哨兵留在保留段又拼一次 ⇒ 文件里稳定留下 2 个
//     `<!-- L3 -->` + 1 个空 § 条目，且该空条目会被当规则注入）
//   · 首次提交整段追加（无哨兵、无旧标题 ⇒ 整篇重复）
//   · 限额只卡 content 不卡合并结果
//   · 结构校验只判 `content.includes("§")`
//   · CRLF 下 `split("\n§\n")` 把 18 条并成 1 条
//
// 覆盖 2026-09-28 的 staging 改造（第 15 组，L3 只写 USER-temp.md）：
//   · live `USER.md` **逐字不动**（含注入侧口径 `readUserPersonaBody` 不含 L3 新增）
//   · 播种 = live 条目在前 + temp 独有条目在后，且**每轮只在第一次成功写盘时做一次**
//     （初版把并集写进"每次读" ⇒ 同轮 `delete` 掉的条目会被并回来，删除恒无效）
//   · 跨 run 保住用户手工放进 temp 的候选；备份口径改成"temp 存在则备 temp 原文"
//   · **超限种子的死锁出口**：工作副本本来就超限时只放行"真能降低用量"的改动，
//     否则删除 op 的改动后用量仍在上限之上 ⇒ 恒拒 ⇒ 腾空间的第一步都做不了
//
// 用 tsx 跑（仓库约定：`.ts` 不能 node 直跑，也不用 tsc）：
//   tsx scripts/verify-l3-commit.ts
//
// 注：`agent/extensions/package.json` 是 `"type": "commonjs"`，**顶层 await 不可用** ——
// 用例体必须放在 `async function main()` 里（与 verify-l2-consolidate.ts 同款）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildL3Task,
	L3_ENTRY_CHAR_LIMIT,
	L3_FAILURE_THRESHOLD,
	USER_CHAR_LIMIT,
	loadL3Cursor,
	readUserPersonaBody,
} from "../memory/l3/config.ts";
import { consumePendingTrigger, writePendingTrigger } from "../memory/l3/signal.ts";
import { entryBudget, locateEntry, normalizeEntryText, parseUserFile, serializeUserFile } from "../memory/l3/entries.ts";
import { registerL3EditTool } from "../memory/l3/edit-tool.ts";
import { registerL3CommitTool } from "../memory/l3/commit-tool.ts";
import { isRunSeeded, readL3Proposal, resetRunFlags, seedProposalEntries, USER_FILE, USER_TEMP_FILE } from "../memory/l3/user-file.ts";
import { setupL3Persona } from "../memory/l3/index.ts";
import { closePipelineJobsDB, getPipelineJobsDB } from "../memory/pipeline/jobs-db.ts";
import { loadFailureState, saveFailureState } from "../memory/failure-state.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

/** 造一个临时 profile；`userMd` 为 null 表示不建 USER.md。 */
function makeProfile(userMd: string | null): string {
	const root = mkdtempSync(join(tmpdir(), "l3edit-"));
	if (userMd !== null) writeFileSync(join(root, USER_FILE), userMd, "utf-8");
	return root;
}

/**
 * 清临时目录。开了 pipeline 队列的用例必须走这里：Windows 下 sqlite 还开着句柄时
 * `rmSync` 会 EPERM（与 verify-l1-value-check / verify-l2-consolidate 同款）。
 */
function dropRoot(root: string): void {
	closePipelineJobsDB(root);
	rmSync(root, { recursive: true, force: true });
}

/** 抓取注册的工具，返回一个可直接调用的薄封装。 */
function toolsFor(profileRoot: string) {
	const captured: Array<Record<string, unknown>> = [];
	const fakePi = { registerTool: (t: unknown) => captured.push(t as Record<string, unknown>) };
	resetRunFlags(); // 一个子代理进程 = 一次 run：夹具里显式复位"已播种 / 已备份"两个标志
	registerL3EditTool(fakePi as never, () => profileRoot, () => {});
	registerL3CommitTool(fakePi as never, () => profileRoot, () => undefined);
	const call = async (name: string, params: unknown): Promise<Record<string, unknown>> => {
		const tool = captured.find((x) => x.name === name);
		if (!tool) throw new Error(`工具未注册: ${name}`);
		const res = (await (tool as { execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> }).execute("tc", params));
		return JSON.parse(res.content[0].text) as Record<string, unknown>;
	};
	return { call };
}

const FOUR = ["规则甲：先分析根因", "规则乙：精确范围提交", "规则丙：最简可行实现", "规则丁：验证按变更侧选手段"];
const LF_DOC = FOUR.join("\n§\n") + "\n";
const CRLF_DOC = FOUR.join("\r\n§\r\n") + "\r\n";
/** live 画像（USER.md）——**L3 一个字节都不该改它**。 */
const readLive = (root: string) => readFileSync(join(root, USER_FILE), "utf-8");
/** L3 的落盘结果：temp 存在读 temp，否则读 live（= 尚未写过盘时的"提议稿原文"口径）。 */
const readMd = (root: string) =>
	existsSync(join(root, USER_TEMP_FILE)) ? readFileSync(join(root, USER_TEMP_FILE), "utf-8") : readLive(root);
const backupDir = (root: string) => join(root, "memoryDB", "backups", "user-backups");

async function main(): Promise<void> {
	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 1. 解析 / 序列化（CRLF 回归） ===");
	{
		check("LF 文件解析出 4 条", parseUserFile(LF_DOC).entries.length === 4);
		const crlf = parseUserFile(CRLF_DOC);
		check("CRLF 文件解析出 4 条（旧实现只剩 1 条）", crlf.entries.length === 4, `实际 ${crlf.entries.length}`);
		check("CRLF 判定正确", crlf.eol === "\r\n");
		check("LF 判定正确", parseUserFile(LF_DOC).eol === "\n");
		check("序列化沿用 CRLF", serializeUserFile(crlf.entries, crlf.eol, crlf.trailingNewline).includes("\r\n§\r\n"));
		check("缺失文件 → 0 条", parseUserFile(null).entries.length === 0);
		check("空文件 → 0 条", parseUserFile("   \n").entries.length === 0);

		// 与生产 USER.md 对账（只读）
		const prodPath = "C:/Users/leaf/.pi/agent/profiles/default/USER.md";
		if (existsSync(prodPath)) {
			const prod = parseUserFile(readFileSync(prodPath, "utf-8"));
			check("生产 USER.md 解析出多条（>1）", prod.entries.length > 1, `实际 ${prod.entries.length} 条`);
			check("生产 USER.md 用量可计价", entryBudget(prod.entries) > 0, `${entryBudget(prod.entries)}/${USER_CHAR_LIMIT}`);
		} else {
			console.log("  SKIP  生产 USER.md 不存在（非本机环境）");
		}
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 2. 单条校验（整篇重写在接口层不可能） ===");
	{
		const cases: Array<[string, string, boolean]> = [
			["单行正常文本 → 过", "偏好最简可行实现", true],
			["含换行 → 拒", "第一条\n第二条", false],
			["含 CR → 拒", "第一条\r第二条", false],
			["含 § → 拒", "甲 § 乙", false],
			["含 HTML 注释 → 拒", "<!-- L3 --> 伪装", false],
			["空 → 拒", "   ", false],
			["超单条上限 → 拒", "甲".repeat(L3_ENTRY_CHAR_LIMIT + 1), false],
			["恰好单条上限 → 过", "甲".repeat(L3_ENTRY_CHAR_LIMIT), true],
		];
		for (const [label, text, expectOk] of cases) {
			check(label, normalizeEntryText(text).ok === expectOk);
		}
		check("整篇文档形态被拒（8-21 的失格形态）", !normalizeEntryText(FOUR.join("\n§\n") + "\n").ok);
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 3. 定位（代码裁决，不靠逐字抄写） ===");
	{
		const entries = parseUserFile(LF_DOC).entries;
		const ok = locateEntry(entries, "精确范围提交");
		check("唯一命中 → ok + 正确下标", ok.ok === true && ok.index === 1);
		const zero = locateEntry(entries, "不存在的片段");
		check("0 命中 → 拒绝 + 回传清单", !zero.ok && (zero as { candidates: unknown[] }).candidates.length === 4);
		const many = locateEntry(entries, "规则");
		check("多命中 → 拒绝且候选=命中集合", !many.ok && (many as { candidates: unknown[] }).candidates.length === 4);
		check("空 target → 拒绝", !locateEntry(entries, "  ").ok);
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 4. l3_edit · add ===");
	{
		const root = makeProfile(CRLF_DOC);
		const { call } = toolsFor(root);
		const before = readMd(root);

		const added = await call("l3_edit", { action: "add", content: "规则戊：新加的一条" });
		check("add 成功", added.success === true, String(added.usage));
		check("条目数 4 → 5", added.entryCount === 5);
		const entries = parseUserFile(readMd(root)).entries;
		check("只多一条", entries.length === 5 && entries[4] === "规则戊：新加的一条");
		check("前 4 条逐字未变", entries.slice(0, 4).join("|") === FOUR.join("|"));
		check("沿用 CRLF 未引入混排", readMd(root).includes("\r\n§\r\n"));
		check("原文是新增后内容的前缀（无整篇重写）", readMd(root).startsWith(before.trimEnd()));
		// 2026-09-28 staging：落盘目标是 temp，live 画像不该被碰
		check("temp 已建立（首次提议以 live 播种）", existsSync(join(root, USER_TEMP_FILE)));
		check("live USER.md 逐字未变", readLive(root) === CRLF_DOC);
		check("提议稿 = live 4 条 + 新增 1 条", parseUserFile(readMd(root)).entries.length === 5);

		check("add 换行 → 拒", (await call("l3_edit", { action: "add", content: "甲\n乙" })).success === false);
		check("add 含 § → 拒", (await call("l3_edit", { action: "add", content: "甲 § 乙" })).success === false);
		check("add 空 → 拒", (await call("l3_edit", { action: "add", content: "  " })).success === false);
		check("非法 action → 拒", (await call("l3_edit", { action: "replace-all", content: "x" })).success === false);
		check("被拒后文件未变", parseUserFile(readMd(root)).entries.length === 5);
		rmSync(root, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 5. l3_edit · update / delete ===");
	{
		const root = makeProfile(LF_DOC);
		const { call } = toolsFor(root);

		const up = await call("l3_edit", { action: "update", target: "精确范围提交", content: "规则乙（改写）：提交只 add 指定文件" });
		check("update 唯一命中成功", up.success === true, `position=${up.position}`);
		check("命中下标正确", up.position === 1);
		const e1 = parseUserFile(readMd(root)).entries;
		check("只有第 2 条被替换", e1[1] === "规则乙（改写）：提交只 add 指定文件" && e1[0] === FOUR[0] && e1[2] === FOUR[2] && e1[3] === FOUR[3]);
		check("条目数不变", e1.length === 4);

		const miss = await call("l3_edit", { action: "update", target: "根本没有这段", content: "x" });
		check("update 0 命中 → 拒 + 回传候选", miss.success === false && (miss.candidates as unknown[]).length === 4);
		const ambiguous = await call("l3_edit", { action: "update", target: "规则", content: "x" });
		check("update 多命中 → 拒 + 候选=命中集合", ambiguous.success === false && (ambiguous.candidates as unknown[]).length === 4, `实际 ${(ambiguous.candidates as unknown[])?.length}`);
		check("被拒的 update 未改动文件", parseUserFile(readMd(root)).entries[0] === FOUR[0]);

		const del = await call("l3_edit", { action: "delete", target: "最简可行实现" });
		check("delete 唯一命中成功", del.success === true, `position=${del.position}`);
		check("条目数 4 → 3", del.entryCount === 3);
		const e2 = parseUserFile(readMd(root)).entries;
		check("目标条目已消失", !e2.some((x) => x.includes("最简可行实现")));
		check("其余条目逐字未变", e2[0] === FOUR[0] && e2[1].startsWith("规则乙（改写）") && e2[2] === FOUR[3]);
		check("delete 0 命中 → 拒", (await call("l3_edit", { action: "delete", target: "不存在" })).success === false);

		for (const t of ["先分析根因", "提交只 add 指定文件", "验证按变更侧选手段"]) {
			await call("l3_edit", { action: "delete", target: t });
		}
		check("可删到空", parseUserFile(readMd(root)).entries.length === 0, `文件=${JSON.stringify(readMd(root))}`);
		const rebuild = await call("l3_edit", { action: "add", content: "从零重建的一条" });
		check("空文件后仍能 add", rebuild.success === true && parseUserFile(readMd(root)).entries.length === 1);
		check("live USER.md 全程未被触碰（update/delete 都只落在提议稿）", readLive(root) === LF_DOC);
		rmSync(root, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 6. 全篇限额（每次 op 后复核） ===");
	{
		// 4 条各 500（正好是单条上限）→ 全篇 2000 + 9 = 2009，此时单条合法的 add 也会撑破 2200
		const head = ["甲", "乙", "丙", "丁"].map((c) => c.repeat(L3_ENTRY_CHAR_LIMIT));
		const near = makeProfile(head.join("\n§\n") + "\n");
		const { call } = toolsFor(near);
		const used = entryBudget(parseUserFile(readMd(near)).entries);
		check("起始用量可计价", used === 4 * L3_ENTRY_CHAR_LIMIT + 3 * 3, `${used}/${USER_CHAR_LIMIT}`);

		// 单条上限之内（200 字符）却仍放不下 → 必须由"全篇"这道闸拦住
		const blocked = await call("l3_edit", { action: "add", content: "戊".repeat(200) });
		check("全篇超限的 add → 拒", blocked.success === false);
		check("错误信息含上限值", String(blocked.error).includes(String(USER_CHAR_LIMIT)), String(blocked.error).slice(0, 60));
		check("被拒后文件未变", readMd(near) === head.join("\n§\n") + "\n");

		check("先删除腾空间成功", (await call("l3_edit", { action: "delete", target: "丁".repeat(20) })).success === true);
		const afterFree = await call("l3_edit", { action: "add", content: "戊".repeat(200) });
		check("腾空间后同量 add 通过", afterFree.success === true, String(afterFree.usage));

		// 精确边界：补到恰好 2200 通过，再多 1 字符被拒
		const usedNow = entryBudget(parseUserFile(readMd(near)).entries);
		const pad = USER_CHAR_LIMIT - usedNow - 3;
		check("距上限的余量在单条上限之内", pad > 0 && pad <= L3_ENTRY_CHAR_LIMIT, `pad=${pad}`);
		const exact = await call("l3_edit", { action: "add", content: "己".repeat(pad) });
		check("加到恰好等于上限 → 通过", exact.success === true, String(exact.usage));
		check("用量确实等于上限", entryBudget(parseUserFile(readMd(near)).entries) === USER_CHAR_LIMIT);
		check("再多 1 字符 → 拒", (await call("l3_edit", { action: "add", content: "庚" })).success === false);
		check("差 1 超限被拒后文件未变", entryBudget(parseUserFile(readMd(near)).entries) === USER_CHAR_LIMIT);
		check("live USER.md 全程未被触碰", readLive(near) === head.join("\n§\n") + "\n");
		rmSync(near, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 7. 幂等 / 无残留（旧哨兵缺陷的直接回归） ===");
	{
		const root = makeProfile(LF_DOC);
		const { call } = toolsFor(root);
		for (let i = 0; i < 3; i++) {
			await call("l3_edit", { action: "add", content: `第${i + 1}轮追加的规则` });
		}
		const doc = readMd(root);
		check("无 `<!-- L3 -->` 残留", !doc.includes("<!-- L3 -->"));
		const entries = parseUserFile(doc).entries;
		check("条目数 = 4 + 3", entries.length === 7);
		check("无空条目", entries.every((e) => e.trim().length > 0));
		const seps = (doc.match(/\r?\n§\r?\n/g) || []).length;
		check("分隔符数 = 条目数 - 1", seps === entries.length - 1, `${seps} vs ${entries.length - 1}`);
		check("live USER.md 未被触碰", readLive(root) === LF_DOC);
		rmSync(root, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 8. 每轮一次备份 ===");
	{
		const root = makeProfile(LF_DOC);
		const { call } = toolsFor(root);
		check("起始无备份", !existsSync(backupDir(root)));
		await call("l3_edit", { action: "add", content: "第一次改动" });
		const files1 = readdirSync(backupDir(root));
		check("第一次改动产生 1 份备份", files1.length === 1, files1.join(","));
		check("备份内容是改动前原文", readFileSync(join(backupDir(root), files1[0]), "utf-8") === LF_DOC);
		await call("l3_edit", { action: "add", content: "第二次改动" });
		await call("l3_edit", { action: "delete", target: "第一次改动" });
		check("同一轮内不再新增备份", readdirSync(backupDir(root)).length === 1);
		rmSync(root, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 9. l3_commit 收尾 ===");
	{
		const root = makeProfile(LF_DOC);
		const { call } = toolsFor(root);
		const c0 = loadL3Cursor(root);
		check("初始游标为空", c0.lastPersonaUpdate === "" && c0.lastCommittedAt === "");

		check("缺 cursor → 拒", (await call("l3_commit", {})).success === false);
		check("非法 cursor → 拒", (await call("l3_commit", { cursor: "昨天" })).success === false);

		// 关键：一条都没改也必须能收尾（否则同一批场景每轮重喂 ⇒ 空转）
		const noop = await call("l3_commit", { cursor: "2026-09-16T00:00:00.000Z" });
		check("未做任何 edit 仍可 commit", noop.success === true);
		const c1 = loadL3Cursor(root);
		check("lastPersonaUpdate 已推进", c1.lastPersonaUpdate === "2026-09-16T00:00:00.000Z");
		check("lastCommittedAt 已写入（熔断判定依据）", c1.lastCommittedAt.length > 0);
		check("memoriesSinceLastPersona 归零", c1.memoriesSinceLastPersona === 0);
		check("条目数与用量回传", noop.entryCount === 4 && typeof noop.usage === "string");

		writeFileSync(
			join(root, "memoryDB", "l3", "cursor.json"),
			JSON.stringify({ ...c1, memoriesSinceLastPersona: 42 }, null, 2),
			"utf-8",
		);
		await call("l3_commit", { cursor: "2026-09-17T00:00:00.000Z" });
		check("再次 commit 把 42 归零", loadL3Cursor(root).memoriesSinceLastPersona === 0);

		// 队列的真完成信号（2026-09-19 并入串行执行器）：只有 l3_commit 能把 running 的 l3 job 标 done。
		// 派发方（worker）等不到这个时刻 —— runPiSubagent 是 async:true，所以这条断言就是"谁算跑完"的定义。
		const db = getPipelineJobsDB(root);
		const q = db.enqueue("l3", "trigger");
		db.claim(q.id);
		check("claim 后 l3 job 是 running", db.getJob(q.id)?.status === "running");
		check("running 期间队列非空闲（跨层单飞的前提）", db.hasAnyRunning() === true);
		const other = db.enqueue("l1", "interval");
		db.claim(other.id);
		await call("l3_commit", { cursor: "2026-09-18T00:00:00.000Z" });
		check("l3_commit 把 running 的 l3 标 done", db.getJob(q.id)?.status === "done" && !!db.getJob(q.id)?.finishedAt);
		check("l3_commit 不误标 running 的 l1", db.getJob(other.id)?.status === "running");
		check("再调一次无匹配行（幂等）", db.completeRunningL3() === 0);
		dropRoot(root);
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 10. 跨进程触发信号 ===");
	{
		const root = makeProfile(LF_DOC);
		mkdirSync(join(root, "memoryDB", "l3"), { recursive: true });
		check("未写信号时 consume → undefined", consumePendingTrigger(root) === undefined);
		writePendingTrigger(root, { personaSignal: true, personaReason: "场景发生实质变化" });
		const sig = consumePendingTrigger(root);
		check("读到信号且带原因", sig?.personaSignal === true && sig?.personaReason === "场景发生实质变化");
		check("读后即删（一个信号只生效一次）", consumePendingTrigger(root) === undefined);
		check("信号文件已不存在", !existsSync(join(root, "memoryDB", "l3", "pending-trigger.json")));
		rmSync(root, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 11. 熔断状态（l3 层） ===");
	{
		const root = makeProfile(LF_DOC);
		mkdirSync(join(root, "memoryDB", "state"), { recursive: true });
		const st0 = loadFailureState(root);
		check("默认含 l3 层", st0.l3.consecutiveFailures === 0 && st0.l3.cooledDown === false);
		check("l1/l2 未被破坏", st0.l1.consecutiveFailures === 0 && st0.l2.cooledDown === false);
		saveFailureState(root, { ...st0, l3: { consecutiveFailures: L3_FAILURE_THRESHOLD, cooledDown: true } });
		const st1 = loadFailureState(root);
		check("l3 熔断状态可持久化", st1.l3.cooledDown === true && st1.l3.consecutiveFailures === L3_FAILURE_THRESHOLD);
		check("阈值与 L1/L2 对齐（=3）", L3_FAILURE_THRESHOLD === 3);
		// 旧格式文件（只有 l1/l2）必须兼容
		writeFileSync(
			join(root, "memoryDB", "state", "failure-state.json"),
			JSON.stringify({ l1: { consecutiveFailures: 1, cooledDown: false }, l2: { consecutiveFailures: 0, cooledDown: true } }),
			"utf-8",
		);
		const st2 = loadFailureState(root);
		check("旧格式文件兼容（l3 补默认）", st2.l3.consecutiveFailures === 0 && st2.l2.cooledDown === true);
		rmSync(root, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 12. 任务消息（上限单源下发） ===");
	{
		const root = makeProfile(LF_DOC);
		mkdirSync(join(root, "memoryDB", "l2", "index"), { recursive: true });
		mkdirSync(join(root, "memoryDB", "l2", "scene-blocks"), { recursive: true });
		mkdirSync(join(root, "memoryDB", "config"), { recursive: true });
		writeFileSync(join(root, "memoryDB", "config", "application-propertis.json"), '{"l1":{"mode":"code"}}', "utf-8");
		writeFileSync(
			join(root, "memoryDB", "l2", "index", "scene_index.json"),
			JSON.stringify([{ filename: "s.md", summary: "x", heat: 1, created: "2026-09-01T00:00:00.000Z", updated: "2026-09-10T00:00:00.000Z" }]),
			"utf-8",
		);
		writeFileSync(join(root, "memoryDB", "l2", "scene-blocks", "s.md"), "x", "utf-8");
		const task = buildL3Task(root, "P4 达到阈值", []) ?? "";
		check("任务消息可构造", task.length > 0);
		check("含 CharLimit 单源值", task.includes(`CharLimit: ${USER_CHAR_LIMIT}`), `期望 ${USER_CHAR_LIMIT}`);
		check("含 EntryCharLimit 单源值", task.includes(`EntryCharLimit: ${L3_ENTRY_CHAR_LIMIT}`), `期望 ${L3_ENTRY_CHAR_LIMIT}`);
		check("含 ChangedScenes", task.includes("ChangedScenes: s.md"));
		check("含 PromptFile（code 模式）", task.includes("persona-generation-code.md"));
		// staging（2026-09-28）：两个路径都要给 —— live 用于去重、temp 是写盘目标
		check("含 UserMdPath（live 画像，去重参照）", task.includes(`UserMdPath: ${join(root, USER_FILE)}`));
		check("含 UserTempMdPath（写盘目标 / 提议稿）", task.includes(`UserTempMdPath: ${join(root, USER_TEMP_FILE)}`));
		check("CharLimit 行注释已改「并入 USER.md 后的整篇」口径", task.includes("并入 USER.md 后的整篇"));
		rmSync(root, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 13. 注入侧口径：注入的是 live USER.md，L3 改动进不去 ===");
	{
		const root = makeProfile(CRLF_DOC);
		check("readUserPersonaBody 非空", readUserPersonaBody(root).length > 0);
		const liveBefore = readLive(root);
		const raw = liveBefore.trim();
		check("CRLF 文档切分 = 4 条", raw.split(/\r?\n§\r?\n/).map((s) => s.trim()).filter(Boolean).length === 4);

		// L3 写一轮，注入侧必须一个字节都不变（这是这次改造的全部意义）
		const { call } = toolsFor(root);
		await call("l3_edit", { action: "add", content: "提议稿里的新条目" });
		check("live USER.md 逐字未变", readLive(root) === liveBefore);
		check("注入口径（readUserPersonaBody）不含 L3 新增", !readUserPersonaBody(root).includes("提议稿里的新条目"));
		check("提议稿里能读到 L3 的新增", parseUserFile(readMd(root)).entries.some((e) => e.includes("提议稿里的新条目")));
		rmSync(root, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 14. 触发 → 入队（2026-09-19 并入串行执行器，取代 run.lock 自单飞） ===");
	{
		// 造场景：P2 冷启动要求"有场景文件且无 persona"
		const root = makeProfile(null);
		mkdirSync(join(root, "memoryDB", "l2", "index"), { recursive: true });
		mkdirSync(join(root, "memoryDB", "l2", "scene-blocks"), { recursive: true });
		mkdirSync(join(root, "memoryDB", "config"), { recursive: true });
		writeFileSync(join(root, "memoryDB", "config", "application-propertis.json"), '{"l1":{"mode":"code"}}', "utf-8");
		writeFileSync(
			join(root, "memoryDB", "l2", "index", "scene_index.json"),
			JSON.stringify([
				{ filename: "s.md", summary: "x", heat: 1, created: "2026-09-01T00:00:00.000Z", updated: "2026-09-10T00:00:00.000Z" },
			]),
			"utf-8",
		);
		writeFileSync(join(root, "memoryDB", "l2", "scene-blocks", "s.md"), "x", "utf-8");

		// 假队列：记下入队请求；active 模拟"队列里已有一条 queued/running 的 l3"（去重语义）
		const log: Array<{ source: string; duplicate: boolean }> = [];
		let active = false;
		const fakePipeline = {
			enqueueL3: (source: "trigger" | "manual") => {
				const duplicate = active;
				log.push({ source, duplicate });
				if (!duplicate) active = true;
				return { id: log.length, duplicate };
			},
			setCachedCtx: () => {},
			kick: () => {},
		};
		const handlers: Record<string, Array<(e: unknown, ctx: unknown) => void>> = {};
		const fakePi = {
			on: (ev: string, fn: (e: unknown, ctx: unknown) => void) => {
				(handlers[ev] ??= []).push(fn);
			},
		};
		const ctx = { ui: { notify: () => {}, setStatus: () => {} } };
		const controls = setupL3Persona(fakePi as never, () => root, fakePipeline as never);
		const settle = () => (handlers.agent_settled ?? []).forEach((f) => f({}, ctx));

		// ① 冷启动门控命中 → 入队（本模块不再 spawn：spawn 归 worker，见 §11.11）
		check("agent_settled 已注册", (handlers.agent_settled ?? []).length === 1);
		settle();
		check("冷启动命中 → 入队 trigger", log.length === 1 && log[0].source === "trigger" && !log[0].duplicate);
		check("入队时写 lastTriggeredAt（可观测）", loadL3Cursor(root).lastTriggeredAt.length > 0);

		// ② 队列去重：同一轮触发不会堆第二条（重复改 USER.md 的入口在此堵死）
		settle();
		check("队列里已有 L3 时再触发 → duplicate（不堆第二条）", log.length === 2 && log[1].duplicate === true);

		// 模拟"那条 job 跑完了"
		active = false;

		// ③ 无变化场景 + 已有 persona → 增量跳过：一次 enqueue 都不该发生
		writeFileSync(join(root, USER_FILE), "现有画像正文", "utf-8");
		writeFileSync(
			join(root, "memoryDB", "l3", "cursor.json"),
			JSON.stringify({ lastPersonaUpdate: "2026-09-20T00:00:00.000Z", memoriesSinceLastPersona: 0, lastTriggeredAt: "", lastCommittedAt: "" }),
			"utf-8",
		);
		settle();
		check("无变化场景 → 门控不命中，不入队", log.length === 2);

		// ④ 熔断期间台账式评估不入队（否则每轮 settle 都白排一条）
		// 注意：saveFailureState 不建目录、写失败静默降级 —— 不先建 state/ 的话这组会因为
		// "状态根本没落盘"而通过，等于没测（第一次就是这么假绿的）。
		mkdirSync(join(root, "memoryDB", "state"), { recursive: true });
		saveFailureState(root, {
			...loadFailureState(root),
			l3: { consecutiveFailures: L3_FAILURE_THRESHOLD, cooledDown: true },
		});
		check("熔断状态已落盘（前置条件）", loadFailureState(root).l3.cooledDown === true);
		settle();
		check("熔断中 → 自动触发不入队", log.length === 2);

		// ⑤ 手动触发：越过熔断与门控，但**仍走队列**（不绕过串行执行器直接 spawn）
		controls.triggerManual(ctx as never);
		check("手动触发 → 入队 manual", log.length === 3 && log[2].source === "manual" && !log[2].duplicate);
		check("手动触发复位熔断", loadFailureState(root).l3.cooledDown === false);

		// ⑥ personaSignal（P1）→ 来源必须是 signal：执行器在 claim 时会照 source 还原 P1，
		//    若记成 trigger，重估只剩 P2–P4，信号会被静默降级成 skipped（2026-09-21 实测 job 51）。
		active = false; // 模拟上一条跑完
		writePendingTrigger(root, { personaSignal: true, personaReason: "场景发生实质变化" });
		settle();
		check(
			"personaSignal → 入队 source=signal",
			log.length === 4 && log[3].source === "signal" && !log[3].duplicate,
			`source=${log[3]?.source}`,
		);
		dropRoot(root);
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 15. staging 语义（写提议稿，不碰 live；播种 / 候选保护 / 限额死锁） ===");
	{
		// ① 首次提议：temp 不存在 ⇒ 工作副本以 live 播种，update/delete 能定位到 live 条目
		const root = makeProfile(LF_DOC);
		const { call } = toolsFor(root);
		check("播种形态 = live 4 条", seedProposalEntries(root).length === 4);
		check("尚未写盘时无 temp", !existsSync(join(root, USER_TEMP_FILE)));
		check("写盘前：本轮还没切口径（仍是播种形态）", isRunSeeded() === false);
		const up = await call("l3_edit", { action: "update", target: "先分析根因", content: "规则甲（改写）" });
		check("首次 op 就能 update 命中 live 条目（播种生效）", up.success === true);
		check("首次写盘成功后才切口径（之后读 temp 原文）", isRunSeeded() === true);
		check("写盘后 temp 建立，live 仍 4 条", existsSync(join(root, USER_TEMP_FILE)) && readLive(root) === LF_DOC);

		// ② 同一轮内的删除立刻生效：不能因为"该条目还在 live 里"被并回来（并集口径的死循环）
		check("delete 命中", (await call("l3_edit", { action: "delete", target: "规则乙" })).success === true);
		check("删掉的条目没有复活", !parseUserFile(readMd(root)).entries.some((e) => e.includes("规则乙")));
		check("live 里它还在（未确认前不动 live）", readLive(root).includes("规则乙"));
		rmSync(root, { recursive: true, force: true });

		// ③ 用户手工放进 temp 的候选：跨 run（新进程）不能被播种清掉
		const root2 = makeProfile(LF_DOC);
		writeFileSync(join(root2, USER_TEMP_FILE), "用户手放的候选规则\n", "utf-8");
		const t2 = toolsFor(root2);
		const seeded = seedProposalEntries(root2);
		check(
			"播种 = live 4 条 + temp 独有 1 条（live 在前）",
			seeded.length === 5 && seeded[0] === FOUR[0] && seeded[4].includes("用户手放的候选"),
			`${seeded.length} 条`,
		);
		check("temp 已有的 live 条目不会被重复追加", seedProposalEntries(root2).filter((e) => e === FOUR[1]).length === 1);
		await t2.call("l3_edit", { action: "add", content: "L3 本轮新增" });
		const staged = parseUserFile(readMd(root2)).entries;
		check("写盘后用户候选仍在", staged.some((e) => e.includes("用户手放的候选")));
		check("live 4 条 + 用户候选 1 条 + L3 新增 1 条 = 6", staged.length === 6, `实际 ${staged.length}`);
		check("live USER.md 未被触碰", readLive(root2) === LF_DOC);
		rmSync(root2, { recursive: true, force: true });

		// ④ 备份口径：temp 存在时备份 temp 原文（"这一轮要覆盖掉的那份提议稿"）
		const root3 = makeProfile(LF_DOC);
		writeFileSync(join(root3, USER_TEMP_FILE), "上一轮未并入的提议稿\n", "utf-8");
		const t3 = toolsFor(root3);
		await t3.call("l3_edit", { action: "add", content: "本轮改动" });
		const bf = readdirSync(backupDir(root3));
		check("temp 存在时备份的就是 temp 原文", bf.length === 1 && readFileSync(join(backupDir(root3), bf[0]), "utf-8") === "上一轮未并入的提议稿\n", bf.join(","));
		await t3.call("l3_edit", { action: "add", content: "本轮第二次改动" });
		check("同一轮内只备份一次", readdirSync(backupDir(root3)).length === 1);
		rmSync(root3, { recursive: true, force: true });

		// ⑤ 超限种子的死锁出口：live 已近满 + temp 还有未并入条目 ⇒ 只放行"真能降低用量"的改动。
		//    没有这条，删除 op 的"改动后用量"仍在上限之上 ⇒ 恒拒 ⇒ L3 连第一步都做不了。
		const head = ["甲", "乙", "丙", "丁"].map((c) => c.repeat(L3_ENTRY_CHAR_LIMIT));
		const root4 = makeProfile(head.join("\n§\n") + "\n"); // live = 2009 字符（< 2200）
		writeFileSync(join(root4, USER_TEMP_FILE), "戊".repeat(300) + "\n", "utf-8"); // 播种后 = 2312 > 2200
		const t4 = toolsFor(root4);
		const overSeed = entryBudget(seedProposalEntries(root4));
		check("播种形态已超限（前置条件）", overSeed > USER_CHAR_LIMIT, `${overSeed}/${USER_CHAR_LIMIT}`);
		const stillAdd = await t4.call("l3_edit", { action: "add", content: "己".repeat(10) });
		check("超限种子下的 add → 拒", stillAdd.success === false);
		check("被拒时不切口径（仍是播种形态，用户候选不会在下一 op 消失）", isRunSeeded() === false);
		check("错误文案点明超限与上限值", String(stillAdd.error).includes("超过上限") && String(stillAdd.error).includes(String(USER_CHAR_LIMIT)));
		check("被拒时不写盘（temp 原文未变）", readFileSync(join(root4, USER_TEMP_FILE), "utf-8") === "戊".repeat(300) + "\n");
		const del = await t4.call("l3_edit", { action: "delete", target: "甲".repeat(20) });
		check("超限种子下的 delete → 放行（不是死锁）", del.success === true, String(del.error));
		check("删除后用量确实下降", entryBudget(parseUserFile(readMd(root4)).entries) < overSeed);
		check("live USER.md 未被触碰", readLive(root4) === head.join("\n§\n") + "\n");
		rmSync(root4, { recursive: true, force: true });

		// ⑥ l3_commit 的口径 = 提议稿（= 用户并入后 USER.md 的形状）
		const root5 = makeProfile(LF_DOC);
		const t5 = toolsFor(root5);
		await t5.call("l3_edit", { action: "add", content: "提议稿里多出来的一条" });
		const c5 = await t5.call("l3_commit", { cursor: "2026-09-28T00:00:00.000Z" });
		check("commit 成功", c5.success === true);
		check("entryCount 口径 = 提议稿（live 4 + 1）", c5.entryCount === 5, `实际 ${c5.entryCount}`);
		check("live USER.md 未被编辑与提交触碰", readLive(root5) === LF_DOC);
		check("提议稿口径可独立复算（readL3Proposal）", readL3Proposal(root5).entries.length === 5);
		dropRoot(root5); // commit 会开 pipeline sqlite（Windows 下句柄未关时 rmSync 会 EPERM）
	}
}

main()
	.then(() => {
		console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
		if (fail > 0) process.exit(1);
	})
	.catch((err: unknown) => {
		console.error("\n用例执行异常：", err);
		process.exit(1);
	});
