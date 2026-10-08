// L1 任务状态（taskState）回归基线 —— plan/pi-memory-system/L1-任务生命周期标记-计划.md
//
// 覆盖：
//   ① 闭集与归一（record-types.ts）
//   ② 分片扫描口径（in-place-mark.ts：分片文件名升序 + LWW 最后一行）
//   ③ 就地标记（task-state.ts）：正文/id/version 不变、审计键独立、幂等、错误分支、部分成功、写锁占用
//   ④ l1_commit 闸门（commit-tool.ts）：闭集硬拒 / 缺省补 open / 非任务类型忽略 / 半角空白归一 /
//      继承观测计数 taskStateDroppedOnReplace
//
// 铁律：只用系统临时目录；**不发任何网络请求**（commit 走 main-agent 路径，价值校验那一段不运行）。
// 运行：node scripts/verify-l1-task-state.ts（Node ≥22.13 的类型剥离）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	L1_TASK_STATES,
	L1_TASK_STATE_LABELS,
	formatInjectedRecordLine,
	isL1TaskState,
	normalizeTaskState,
	taskStateLabel,
	taskStateOf,
} from "../memory/l1/record-types.ts";
import { recordsDirOf, scanRecordShards } from "../memory/l1/in-place-mark.ts";
import { applyTaskStateChanges, listTaskRecords, parseTaskStateArg } from "../memory/l1/task-state.ts";
import { registerL1CommitTool } from "../memory/l1/commit-tool.ts";
import { closePipelineJobsDB } from "../memory/pipeline/jobs-db.ts";

/** 关掉缓存里的 jobs.sqlite 再删目录：Windows 下句柄未释放时 rmSync 会 EPERM（同 verify-l1-value-check）。 */
function drop(dir: string): void {
	try {
		closePipelineJobsDB(dir);
	} catch {
		// 未打开过则忽略
	}
	rmSync(dir, { recursive: true, force: true });
}

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
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── 夹具 ────────────────────────────────────────────────────────────────────

function makeProfile(): string {
	const root = mkdtempSync(join(tmpdir(), "l1ts-"));
	mkdirSync(join(root, "memoryDB", "config"), { recursive: true });
	mkdirSync(recordsDirOf(root), { recursive: true });
	writeFileSync(join(root, "memoryDB", "config", "application-propertis.json"), JSON.stringify({ l1: { mode: "code" } }), "utf-8");
	return root;
}

/** 写一个分片（行数组，逐行 JSON）。 */
function writeShard(profilePath: string, date: string, rows: unknown[]): void {
	writeFileSync(join(recordsDirOf(profilePath), `${date}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

const taskRow = (over: Record<string, unknown> = {}) => ({
	id: "l1_1700000000000_a001",
	content: "需要为每条记录添加「和导师聊天」按钮，点击跳转到聊天页",
	type: "work_task",
	priority: 75,
	version: 1,
	scene_name: "就业网｜导师聊天",
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
	metadata: { scope: "self", project: "C:/dev/alpha", status: "todo" },
	taskState: "open",
	...over,
});

/** 读回某个 id 的最后一行（测试侧独立实现，刻意不复用被测代码）。 */
function lastRowOf(profilePath: string, id: string): Record<string, unknown> | null {
	const dir = recordsDirOf(profilePath);
	if (!existsSync(dir)) return null;
	let out: Record<string, unknown> | null = null;
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
		for (const line of readFileSync(join(dir, f), "utf-8").split(/\r?\n/)) {
			const t = line.trim();
			if (!t) continue;
			try {
				const o = JSON.parse(t) as Record<string, unknown>;
				if (o?.id === id) out = o;
			} catch {
				/* 坏行忽略 */
			}
		}
	}
	return out;
}

/** 按正文找一个记录（测试侧独立实现）。 */
function rowByContent(profilePath: string, content: string): Record<string, unknown> | undefined {
	const dir = recordsDirOf(profilePath);
	if (!existsSync(dir)) return undefined;
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
		for (const line of readFileSync(join(dir, f), "utf-8").split(/\r?\n/)) {
			const t = line.trim();
			if (!t) continue;
			try {
				const o = JSON.parse(t) as Record<string, unknown>;
				if (o?.content === content) return o;
			} catch {
				/* 坏行忽略 */
			}
		}
	}
	return undefined;
}

/** 用假 pi 捕获 l1_commit 并返回「调用一次 → 返回体」的函数（同 verify-l1-value-check 的写法）。 */
function makeCommit(profilePath: string) {
	let def: { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> } | undefined;
	registerL1CommitTool({ registerTool: (d: unknown) => (def = d as never) } as never, () => profilePath);
	if (!def) throw new Error("l1_commit 未注册");
	const ctx = {
		cwd: "C:/dev/alpha",
		ui: { notify: () => {} },
		sessionManager: { getSessionFile: () => "C:/x/sess.jsonl", getSessionId: () => "sid-1" },
	};
	return async (params: Record<string, unknown>) => {
		const res = await def!.execute("t1", params, undefined, undefined, ctx);
		return JSON.parse(res.content[0].text) as Record<string, unknown>;
	};
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 1. 闭集与归一（record-types.ts） ===");
	{
		check("取值闭集 = open/done/dropped", eq([...L1_TASK_STATES], ["open", "done", "dropped"]), L1_TASK_STATES.join("/"));
		check("合法值判定", isL1TaskState("open") && isL1TaskState("done") && isL1TaskState("dropped"));
		check("非法值判定", !isL1TaskState("DONE") && !isL1TaskState("todo") && !isL1TaskState(undefined) && !isL1TaskState(1));
		check("归一：大小写与空白", normalizeTaskState("  DONE ") === "done" && normalizeTaskState("Dropped") === "dropped");
		check("归一：非闭集值返回 null（区别于缺字段）", normalizeTaskState("todo") === null && normalizeTaskState(undefined) === null);
		check("缺字段 = open", taskStateOf({}) === "open" && taskStateOf({ taskState: "done" }) === "done");
		check("非法存量值按 open 处理（不炸）", taskStateOf({ taskState: "doing" }) === "open");
		check("注入标签 = 待办/已完成/已废弃", eq(L1_TASK_STATE_LABELS, { open: "待办", done: "已完成", dropped: "已废弃" }));
		check("标签只对合法值渲染", taskStateLabel("done") === "已完成" && taskStateLabel("doing") === null && taskStateLabel(undefined) === null);
		check("命令行参数解析（大小写/空白容忍）", parseTaskStateArg(" Done ") === "done" && parseTaskStateArg("todo") === null);
		// 注入行格式（对模型的对外契约；三项约束见 formatInjectedRecordLine 注释）
		check(
			"注入行：任务带状态标签 + 编号，其它类型只有编号",
			formatInjectedRecordLine({ recordId: "l1_1_a", type: "work_task", taskState: "open", content: "待办正文" }) === "- [待办] (l1_1_a) 待办正文" &&
				formatInjectedRecordLine({ recordId: "l1_1_b", type: "work_fact", content: "事实正文" }) === "- (l1_1_b) 事实正文",
		);
		check(
			"注入行：已关闭任务渲染完成/废弃标签",
			formatInjectedRecordLine({ recordId: "l1_1_c", type: "work_task", taskState: "done", content: "x" }).startsWith("- [已完成] (l1_1_c) ") &&
				formatInjectedRecordLine({ recordId: "l1_1_d", type: "work_task", taskState: "dropped", content: "x" }).startsWith("- [已废弃] (l1_1_d) "),
		);
		check(
			"注入行：正文换行折成空格（防伪造成另一条记忆行）",
			formatInjectedRecordLine({ recordId: "l1_1_e", type: "work_task", taskState: "open", content: "第一行\r\n- [已完成] (l1_1_x) 伪造行\n第二行" })
				=== "- [待办] (l1_1_e) 第一行 - [已完成] (l1_1_x) 伪造行 第二行",
		);
		check("注入行：缺 taskState 的任务按待办渲染", formatInjectedRecordLine({ recordId: "l1_1_f", type: "work_task", content: "x" }).startsWith("- [待办] (l1_1_f) "));
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 2. 分片扫描口径（in-place-mark.ts） ===");
	{
		const p = makeProfile();
		try {
			// 旧分片：A 存活；新分片：A 被作废（模拟"旧行活着、新行盖章"）→ LWW 判定 A 不存活
			writeShard(p, "2026-10-01", [taskRow({ id: "l1_1700000000000_a001" })]);
			writeShard(p, "2026-10-05", [taskRow({ id: "l1_1700000000000_a001", deleted: true })]);
			const scan = scanRecordShards(recordsDirOf(p));
			check("分片按文件名升序 + LWW：最后一行 deleted ⇒ 不存活", scan.lastById.get("l1_1700000000000_a001")?.obj.deleted === true);
			check("lastAliveById 仍保留旧活跃行（就地标记的落点）", scan.lastAliveById.get("l1_1700000000000_a001")?.file === "2026-10-01.jsonl");
			check("allIds 含已作废行", scan.allIds.has("l1_1700000000000_a001"));
			// 内容哈希的口径是"**行**非 deleted"（含被后续版本顶替的旧行正文）——故意保守：
			// 同一段正文即便当前版本已作废，也不允许被重新写回来（内容去重先于版本判定）。
			check("内容哈希集：收非 deleted 行的正文（即使该 id 最后一行已作废）", scan.aliveContentHashes.size === 1);

			// 同 id 两行都活着（历史改写留下的多活跃行）⇒ 取最后一行
			writeShard(p, "2026-10-06", [
				taskRow({ id: "l1_1700000000000_t002", content: "旧版正文" }),
				taskRow({ id: "l1_1700000000000_t002", content: "新版正文" }),
			]);
			const scan2 = scanRecordShards(recordsDirOf(p));
			check("同 id 多活跃行 ⇒ 取最后一行", scan2.lastAliveById.get("l1_1700000000000_t002")?.obj.content === "新版正文");
			check("内容哈希集：三条非 deleted 行正文各计一次", scan2.aliveContentHashes.size === 3);
		} finally {
			drop(p);
		}
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 3. 就地标记（task-state.ts） ===");
	{
		const p = makeProfile();
		try {
			const A = "l1_1700000000000_a001";
			const F = "l1_1700000000000_f001";
			const D = "l1_1700000000000_d001";
			const T = "l1_1700000000000_t002";
			writeShard(p, "2026-10-01", [
				taskRow({ id: A }),
				taskRow({ id: F, type: "work_fact", content: "L1 分类收为 3 类", taskState: undefined }),
				taskRow({ id: D, deleted: true }),
				taskRow({ id: T, content: "旧版正文" }),
				taskRow({ id: T, content: "新版正文" }),
			]);
			const shardBefore = readFileSync(join(recordsDirOf(p), "2026-10-01.jsonl"), "utf-8");
			const aBefore = lastRowOf(p, A)!;

			// 3.1 正常标记 open → done
			const out = applyTaskStateChanges(p, [{ id: A, state: "done" }], { by: "agent", reason: "走查后确认已完成" });
			const a = lastRowOf(p, A)!;
			check("标记成功计数", out.changed === 1 && out.failed === 0 && out.noop === 0, JSON.stringify({ changed: out.changed, failed: out.failed }));
			check("taskState 已写入", a.taskState === "done");
			check("updatedAt 已刷新", a.updatedAt !== aBefore.updatedAt && typeof a.updatedAt === "string");
			check("正文 / id / version / priority 不变", a.content === aBefore.content && a.id === A && a.version === aBefore.version && a.priority === aBefore.priority);
			check("场景名与既有 metadata 键保留", a.scene_name === aBefore.scene_name && (a.metadata as any).scope === "self" && (a.metadata as any).status === "todo");
			const audit = (a.metadata as any).taskStateChange;
			check(
				"审计键 taskStateChange = {from,to,at,by,reason}",
				audit?.from === "open" && audit?.to === "done" && typeof audit?.at === "string" && audit?.by === "agent" && audit?.reason === "走查后确认已完成",
				JSON.stringify(audit),
			);
			check("**不写** l1Cleanup（否则会触发 l1_fix 的 24h 防抖）", (a.metadata as any).l1Cleanup === undefined);
			check("同分片其它行未被改动（正文逐字比对）", readFileSync(join(recordsDirOf(p), "2026-10-01.jsonl"), "utf-8").includes(JSON.stringify({ id: F, type: "work_fact" }).slice(1, 20)));

			// 3.2 幂等：同状态再标一次
			const shardAfterDone = readFileSync(join(recordsDirOf(p), "2026-10-01.jsonl"), "utf-8");
			const out2 = applyTaskStateChanges(p, [{ id: A, state: "done" }], { by: "user" });
			check("幂等：ok=true / changed=false / noop=1", out2.results[0]?.ok === true && out2.results[0]?.changed === false && out2.noop === 1);
			check("幂等：未写盘（分片字节不变）", readFileSync(join(recordsDirOf(p), "2026-10-01.jsonl"), "utf-8") === shardAfterDone);

			// 3.3 同 id 多活跃行：只改最后一行
			const out3 = applyTaskStateChanges(p, [{ id: T, state: "dropped" }], { by: "agent" });
			const lines = readFileSync(join(recordsDirOf(p), "2026-10-01.jsonl"), "utf-8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
			const tRows = lines.filter((o) => o.id === T);
			check(
				"同 id 多活跃行：只改最后一行（首行状态与审计均未动）",
				out3.changed === 1 && tRows[0].taskState === "open" && tRows[0].metadata?.taskStateChange === undefined && tRows[1].taskState === "dropped",
			);
			check("被改写的行数口径 = 1 行", out3.changedRows === 1 && out3.changedFiles === 1);

			// 3.4 错误分支
			const out4 = applyTaskStateChanges(
				p,
				[
					{ id: "l1_1700000000000_none", state: "done" },
					{ id: D, state: "done" },
					{ id: F, state: "done" },
					{ id: A, state: "done" },
					{ id: A, state: "open" },
				],
				{ by: "agent" },
			);
			const errs = Object.fromEntries(out4.results.map((r) => [r.id + "|" + r.to, r.error ?? ""]));
			check("不存在 id → 失败", (errs["l1_1700000000000_none|done"] ?? "").includes("记录不存在"));
			check("已 deleted → 失败", (errs[`${D}|done`] ?? "").includes("deleted"));
			check("非 work_task → 失败并说明原因", (errs[`${F}|done`] ?? "").includes("只有 work_task"));
			check("同状态（done→done）→ 幂等成功", out4.results.find((r) => r.id === A && r.to === "done")?.ok === true);
			check("批内重复 → 后者失败", (errs[`${A}|open`] ?? "").includes("同一批内重复"));
			check("失败计数 = 4（不存在 / 已 deleted / 非任务 / 批内重复）", out4.failed === 4 && out4.noop === 1, JSON.stringify({ failed: out4.failed, noop: out4.noop, changed: out4.changed }));

			// 3.5 部分成功：一条成功 + 一条失败，成功的照常落盘
			const out5 = applyTaskStateChanges(p, [
				{ id: A, state: "open" },
				{ id: "l1_1700000000000_none", state: "dropped" },
			], { by: "user" });
			check("部分成功：1 成功 1 失败，无回滚", out5.changed === 1 && out5.failed === 1 && lastRowOf(p, A)!.taskState === "open");

			// 3.6 写锁被占用：一条都不写
			mkdirSync(join(p, "memoryDB", ".l1-admin-write.lock"), { recursive: true });
			writeFileSync(join(p, "memoryDB", ".l1-admin-write.lock", "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
			const shardBeforeLock = readFileSync(join(recordsDirOf(p), "2026-10-01.jsonl"), "utf-8");
			const out6 = applyTaskStateChanges(p, [{ id: A, state: "done" }], { by: "agent", lockTimeoutMs: 200 });
			check("写锁占用 → lockError 且未写盘", Boolean(out6.lockError) && out6.failed === 1 && readFileSync(join(recordsDirOf(p), "2026-10-01.jsonl"), "utf-8") === shardBeforeLock);
			rmSync(join(p, "memoryDB", ".l1-admin-write.lock"), { recursive: true, force: true });

			// 3.7 清单
			const openOnly = listTaskRecords(p);
			const withClosed = listTaskRecords(p, true);
			check("清单默认只列 open", openOnly.every((r) => r.state === "open") && openOnly.some((r) => r.id === A));
			check("清单 --all 含已关闭", withClosed.some((r) => r.id === T && r.state === "dropped"));
			check("清单不含 work_fact / 已 deleted", !withClosed.some((r) => r.id === F || r.id === D));
			check("清单按 createdAt 倒序", withClosed.every((r, i, arr) => i === 0 || arr[i - 1].createdAt >= r.createdAt));
			check("清单带状态审计时间", withClosed.find((r) => r.id === T)?.stateChangedAt !== "");
			void shardBefore;
		} finally {
			drop(p);
		}
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 4. l1_commit 闸门（commit-tool.ts） ===");
	{
		const p = makeProfile();
		try {
			const commit = makeCommit(p);

			// 4.1 硬拒：越出闭集
			const r1 = await commit({ source: "main-agent", records: [{ content: "某条待办", type: "work_task", taskState: "doing" }] });
			check("闭集外取值 → 拒绝整批", r1.success === false && String(r1.error).includes("taskState 越出枚举"), String(r1.error));

			// 4.2 缺省补 open
			const r2 = await commit({ source: "main-agent", records: [{ content: "缺省状态的待办", type: "work_task" }] });
			check("缺省 → 落盘 open", r2.success === true && r2.written === 1 && rowByContent(p, "缺省状态的待办")?.taskState === "open");

			// 4.3 归一：空白 + 大写
			const r3 = await commit({ source: "main-agent", records: [{ content: "空白大写的状态", type: "work_task", taskState: " DONE " }] });
			check("归一：\" DONE \" → done", r3.success === true && rowByContent(p, "空白大写的状态")?.taskState === "done", JSON.stringify(rowByContent(p, "空白大写的状态")?.taskState));

			// 4.4 非任务类型：忽略并计数
			const r4 = await commit({ source: "main-agent", records: [{ content: "一条事实不该带任务状态", type: "work_fact", taskState: "done" }] });
			const row4 = rowByContent(p, "一条事实不该带任务状态");
			check("非 work_task 带 taskState → 忽略字段", r4.success === true && row4 !== undefined && !("taskState" in row4));
			check("并回报 taskStateIgnored", r4.taskStateIgnored === 1, JSON.stringify(r4.taskStateIgnored));

			// 4.5 继承观测：作废一条已关闭任务、替代行没带状态 → 计数
			const tId = "l1_1712000000000_c001";
			writeShard(p, "2026-10-07", [taskRow({ id: tId, taskState: "done" })]);
			const r5 = await commit({
				source: "main-agent",
				records: [{ id: tId, content: "需要为每条记录添加按钮（被替换）", type: "work_task", deleted: true }],
			});
			check("作废已关闭任务 → taskStateDroppedOnReplace=1", r5.success === true && r5.taskStateDroppedOnReplace === 1, JSON.stringify({ v: r5.taskStateDroppedOnReplace }));
			const dead = lastRowOf(p, tId)!;
			check("墓碑行沿用原状态（不改 metadata / taskState）", dead.deleted === true && dead.taskState === "done");

			// 4.6 幂等：再投同一墓碑
			const r6 = await commit({
				source: "main-agent",
				records: [{ id: tId, content: "需要为每条记录添加按钮（被替换）", type: "work_task", deleted: true }],
			});
			check("重复墓碑 → 不写盘（markedInPlace=0）", r6.success === true && r6.markedInPlace === 0 && r6.written === 0);
		} finally {
			drop(p);
		}
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 5. l1-admin/rewrite.mjs 的字段继承（白名单重建，漏拷即静默丢失） ===");
	{
		const p = makeProfile();
		try {
			const id = "l1_1700000000000_r001";
			writeShard(p, "2026-10-01", [taskRow({ id, taskState: "done" })]);
			const toolDir = join(dirname(fileURLToPath(import.meta.url)), "l1-admin");
			execFileSync(
				process.execPath,
				["rewrite.mjs", id, "--content", "改写后的正文（够长以通过 rewrite.mjs 的 10 字符下限校验）", "--apply", "--profile", p],
				{ cwd: toolDir, encoding: "utf8", timeout: 60000 },
			);
			const all: Record<string, unknown>[] = [];
			for (const f of readdirSync(recordsDirOf(p)).filter((x) => x.endsWith(".jsonl"))) {
				for (const line of readFileSync(join(recordsDirOf(p), f), "utf-8").split(/\r?\n/)) {
					const t = line.trim();
					if (t) all.push(JSON.parse(t));
				}
			}
			const newRow = all.find((o) => o.id !== id && o.deleted !== true);
			check("改写后 taskState 继承（done 不丢）", newRow?.taskState === "done", JSON.stringify(newRow?.taskState));
			check("旧行就地作废", lastRowOf(p, id)?.deleted === true);
			check("新行版本号递增", newRow?.version === 2, JSON.stringify(newRow?.version));
		} finally {
			drop(p);
		}
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 6. 存量迁移脚本（scripts/migrate-task-state.mts） ===");
	{
		const p = makeProfile();
		try {
			const mDone = "l1_1700000000000_m001";
			const mTodo = "l1_1700000000000_m002";
			const mFact = "l1_1700000000000_m003";
			writeShard(p, "2026-10-01", [
				taskRow({ id: mDone, content: "合同页面改造完成", metadata: { status: "done" } }),
				taskRow({ id: mTodo, content: "待用户拍板：是否重构", metadata: { status: "todo" } }),
				taskRow({ id: mFact, content: "一条事实（不是任务）", type: "work_fact", taskState: undefined, metadata: { status: "done" } }),
			]);
			const script = join(dirname(fileURLToPath(import.meta.url)), "migrate-task-state.mts");
			const before = readFileSync(join(recordsDirOf(p), "2026-10-01.jsonl"), "utf-8");

			// 6.1 dry-run 默认不写盘
			execFileSync(process.execPath, [script, "--profile", p], { encoding: "utf8", timeout: 60000 });
			check("dry-run 默认不写盘", readFileSync(join(recordsDirOf(p), "2026-10-01.jsonl"), "utf-8") === before);

			// 6.2 --apply：只迁移 work_task 且 legacy status=done 的那条
			const applyOut = execFileSync(process.execPath, [script, "--profile", p, "--apply"], { encoding: "utf8", timeout: 60000 });
			check("--apply 前自动备份", applyOut.includes("已自动备份"));
			check("备份目录已生成", existsSync(join(p, "memoryDB", "backups", "l1-admin")));
			check("迁移 done 任务", lastRowOf(p, mDone)?.taskState === "done");
			check("不动 todo 任务（仍为 open）", taskStateOf(lastRowOf(p, mTodo) ?? {}) === "open");
			check("不动非任务记录（即使 metadata.status=done）", lastRowOf(p, mFact)?.taskState === undefined);
			const audit = (lastRowOf(p, mDone)?.metadata as any)?.taskStateChange;
			check("审计 by=migration 且不写 l1Cleanup", audit?.by === "migration" && (lastRowOf(p, mDone)?.metadata as any)?.l1Cleanup === undefined);
			check("不删存量 metadata.status", (lastRowOf(p, mDone)?.metadata as any)?.status === "done");
		} finally {
			drop(p);
		}
	}

	console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败 ===`);
	if (fail > 0) process.exitCode = 1;
}

await main();
