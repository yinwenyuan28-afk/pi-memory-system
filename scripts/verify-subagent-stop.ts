// 停止序列与杀后修复的回归基线（2026-09-26，SUBAGENT_LIVENESS_FIX 的 T5）
//
// 只读生产代码；只写系统临时目录 + 一个**自己 spawn 的假子进程**（绝不动真实子代理：
// `stopSubagent` 的"找 run"是注入的，不扫 %TEMP%）。
//
// 为什么这些断言值得单独成文件：杀后修复是"用户裁定直接停掉子代理"的**安全前提** ——
// 它坏了不会报错，只会静默留下不一致（孤儿临时文件 / 半成品备份 / 分片残行粘住下一条 /
// 过期写锁）。所以每一项都用夹具钉死。
//
// 用 tsx 跑：tsx scripts/verify-subagent-stop.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive, killProcessTree, repairAfterKill, stopSubagent } from "../memory/pipeline/subagent-kill.ts";
import { isStopRequested, stopRequestPath } from "../memory/pipeline/stop-request.ts";
import { forceReleaseWriteLock } from "../memory/l1/write-lock.ts";
import { L2_CURSOR_FILE } from "../memory/paths.ts";
import type { StopTarget } from "../memory/pipeline/subagent-kill.ts";

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

const roots: string[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 造一个临时 profile（含 scene-blocks / backups / l1 records / state）。 */
function makeProfile(): string {
	const root = mkdtempSync(join(tmpdir(), "stopfix-"));
	roots.push(root);
	for (const d of ["l2/scene-blocks", "backups", "l1/records", "state", "l2", "l3"]) {
		mkdirSync(join(root, "memoryDB", d), { recursive: true });
	}
	return root;
}

const block = (lines: string[]) =>
	`-----META-START-----\ncreated: 2026-09-01T00:00:00.000Z\nupdated: 2026-09-01T00:00:00.000Z\nsummary: s\nheat: 1\n-----META-END-----\n\n${lines.join("\n")}\n`;

async function main(): Promise<void> {
	console.log("\n=== 1. 杀进程：只杀我们自己 spawn 的假子进程 ===");
	{
		// 起一个什么都不做的子进程当靶子（真实子代理只会在真实 job 里被杀）
		const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore", windowsHide: true });
		const pid = child.pid;
		check("靶子已 spawn 且有 pid", typeof pid === "number" && pid > 0, String(pid));
		if (typeof pid === "number") {
			check("杀之前：进程存活", isProcessAlive(pid));
			killProcessTree(pid);
			await sleep(400);
			check("杀之后：确认为死（这就是 killConfirmed 的判据）", !isProcessAlive(pid));
		}
		// 不存在的 pid：视为已死（停止序列据此判定"确认已死"）
		check("不存在的 pid → isProcessAlive=false", !isProcessAlive(999_999_999));
	}

	console.log("\n=== 2. 杀后修复 5a：孤儿临时文件 / 半成品合并备份 ===");
	{
		const root = makeProfile();
		const sceneDir = join(root, "memoryDB", "l2", "scene-blocks");
		writeFileSync(join(sceneDir, "keep.md"), block(["- 正常块"]), "utf-8");
		writeFileSync(join(sceneDir, ".tmp_scene_123_ab"), "半截", "utf-8");
		writeFileSync(join(sceneDir, ".tmp_scene_456_cd"), "半截", "utf-8");
		// 完整备份（有 manifest）必须保留；半成品（无 manifest）必须清掉
		mkdirSync(join(root, "memoryDB", "backups", "l2-consolidate-20260901120000-aaaa"), { recursive: true });
		writeFileSync(join(root, "memoryDB", "backups", "l2-consolidate-20260901120000-aaaa", "_manifest.json"), "{}", "utf-8");
		mkdirSync(join(root, "memoryDB", "backups", "l2-consolidate-20260901130000-bbbb"), { recursive: true });
		writeFileSync(join(root, "memoryDB", "backups", "l2-consolidate-20260901130000-bbbb", "a.md"), "写了一半", "utf-8");

		const r = repairAfterKill(root);
		check("清掉 2 个孤儿临时文件", r.orphanTemps === 2, String(r.orphanTemps));
		check(
			"临时文件确实没了",
			!existsSync(join(sceneDir, ".tmp_scene_123_ab")) && !existsSync(join(sceneDir, ".tmp_scene_456_cd")),
		);
		check("正常场景块没被动", existsSync(join(sceneDir, "keep.md")));
		check("清掉 1 个半成品备份", r.incompleteBackups === 1, String(r.incompleteBackups));
		check(
			"完整备份（有 manifest）保留",
			existsSync(join(root, "memoryDB", "backups", "l2-consolidate-20260901120000-aaaa", "_manifest.json")),
		);
		check("半成品备份目录已删", !existsSync(join(root, "memoryDB", "backups", "l2-consolidate-20260901130000-bbbb")));
	}

	console.log("\n=== 3. 杀后修复 5b：L1 分片尾部（残行截断 / 缺换行补换行） ===");
	{
		// 3a 残行（写到一半被杀）：必须截断 —— 否则下次 append 会与残行粘成一行，**连坐毁掉下一条记录**
		const rootA = makeProfile();
		const recordsDirA = join(rootA, "memoryDB", "l1", "records");
		const good = JSON.stringify({ id: "l1_1790000000001_a", content: "甲" });
		writeFileSync(join(recordsDirA, "2026-09-01.jsonl"), `${good}\n{"id":"l1_1790000000002_b","cont`, "utf-8");
		const rA = repairAfterKill(rootA);
		const afterA = readFileSync(join(recordsDirA, "2026-09-01.jsonl"), "utf-8");
		check("5b 报告修了分片尾", rA.tornTailRepaired);
		check("残行被截断（只剩完整那条 + 换行）", afterA === `${good}\n`, JSON.stringify(afterA));
		check("好记录没丢", afterA.includes("l1_1790000000001_a"));
		// 关键性质：截断后再 append 一条，两行都能解析（这正是 5b 存在的理由）
		writeFileSync(
			join(recordsDirA, "2026-09-01.jsonl"),
			`${afterA}${JSON.stringify({ id: "l1_1790000000003_c", content: "丙" })}\n`,
			"utf-8",
		);
		const linesA = readFileSync(join(recordsDirA, "2026-09-01.jsonl"), "utf-8")
			.split("\n")
			.filter((l) => l.trim());
		check(
			"追加后两条都能解析（不粘连）",
			linesA.length === 2 &&
				linesA.every((l) => {
					try {
						JSON.parse(l);
						return true;
					} catch {
						return false;
					}
				}),
			String(linesA.length),
		);

		// 3b 完整记录但缺结尾换行：补换行（保留记录，同时防止下次 append 粘连）
		const rootB = makeProfile();
		const recordsDirB = join(rootB, "memoryDB", "l1", "records");
		writeFileSync(join(recordsDirB, "2026-09-02.jsonl"), good, "utf-8"); // 无结尾 \n
		const rB = repairAfterKill(rootB);
		check("5b 对缺换行也报告修复", rB.tornTailRepaired);
		check("补上了结尾换行且记录保留", readFileSync(join(recordsDirB, "2026-09-02.jsonl"), "utf-8") === `${good}\n`);

		// 3c 健康分片（以换行结尾）：不动
		const rootC = makeProfile();
		const recordsDirC = join(rootC, "memoryDB", "l1", "records");
		writeFileSync(join(recordsDirC, "2026-09-03.jsonl"), `${good}\n`, "utf-8");
		check("健康分片不动（不误报）", !repairAfterKill(rootC).tornTailRepaired);
	}

	console.log("\n=== 4. 杀后修复 5e/5f：写锁按 pid 释放 + 坏游标重置 ===");
	{
		const root = makeProfile();
		// 5e：持有者 pid 已不存在 → 立刻清（不必等 5 分钟 stale）
		const lockDir = join(root, "memoryDB", ".l1-admin-write.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 999_999_999, startedAt: Date.now() }), "utf-8");
		const r = repairAfterKill(root);
		check("5e 清掉「持有者已死」的写锁", r.lockCleared && !existsSync(lockDir));

		// 5e 反例：持有者活着（用我们自己的 pid）→ **不许清**（误清会导致两个写者并发改分片）
		const lockDir2 = join(root, "memoryDB", ".l1-admin-write.lock");
		mkdirSync(lockDir2, { recursive: true });
		writeFileSync(join(lockDir2, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
		check("持有者活着 → 不动锁", forceReleaseWriteLock(root) === false && existsSync(lockDir2));
		check("显式传匹配 pid → 才允许清", forceReleaseWriteLock(root, process.pid) === true);
		check(
			"owner.json 不可读 → 不动（宁可多等）",
			(() => {
				mkdirSync(join(root, "memoryDB", ".l1-admin-write.lock"), { recursive: true });
				rmSync(join(root, "memoryDB", ".l1-admin-write.lock", "owner.json"), { force: true });
				return forceReleaseWriteLock(root) === false;
			})(),
		);

		// 5f：坏游标（截断的 JSON）→ 删掉，让 loader 退回空游标（重做，方向安全）
		const l2c = join(root, "memoryDB", "l2", "cursor.json");
		writeFileSync(l2c, '{"lastRecordId":"l1_17900', "utf-8");
		const l3c = join(root, "memoryDB", "l3", "cursor.json");
		writeFileSync(l3c, "not json at all", "utf-8");
		const r2 = repairAfterKill(root);
		check("5f 两个坏游标都被重置", r2.cursorsReset.length === 2, JSON.stringify(r2.cursorsReset));
		check("坏游标文件已删", !existsSync(l2c) && !existsSync(l3c));
		// 好游标不动
		writeFileSync(l2c, JSON.stringify({ lastRecordId: "l1_1_a", lastProcessedAt: 1 }), "utf-8");
		check(
			"好游标不动",
			!repairAfterKill(root).cursorsReset.includes(L2_CURSOR_FILE),
			JSON.stringify(repairAfterKill(root).cursorsReset),
		);
	}

	console.log("\n=== 5. 停止序列（注入假 run）：先拦 → 杀 → 修复 → 清标记 ===");
	{
		const root = makeProfile();
		const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore", windowsHide: true });
		const pid = child.pid as number;
		// 假 run 指向我们自己起的靶子 —— 绝不触碰真实子代理
		const fakeRun: StopTarget = {
			state: "running",
			pid,
		};
		const hooksCalled: string[] = [];
		const out = await stopSubagent({
			profilePath: root,
			layer: "l2",
			jobId: 76,
			reason: "测试",
			skipGrace: true,
			findRun: () => fakeRun,
			hooks: {
				rebuildSceneIndex: () => hooksCalled.push("index"),
				repairSceneMembers: () => hooksCalled.push("members"),
			},
		});
		await sleep(400);
		check("报告 killConfirmed=true", out.killConfirmed, out.note);
		check("靶子确实死了", !isProcessAlive(pid));
		check("杀后修复已执行（索引 + 成员钩子都被调到）", hooksCalled.length === 2, JSON.stringify(hooksCalled));
		check("确认已死时清掉停止标记（否则下次运行全被拒写）", !isStopRequested(root, "l2") && !existsSync(stopRequestPath(root, "l2")));

		// 反例：拿不到 pid（run 找不到）→ 不确认、**保留标记**、不做修复（因为可能还有写者）
		const root2 = makeProfile();
		const out2 = await stopSubagent({
			profilePath: root2,
			layer: "l2",
			jobId: 77,
			reason: "测试",
			skipGrace: true,
			findRun: () => undefined,
		});
		check("拿不到 pid → killConfirmed=false", !out2.killConfirmed, out2.note);
		check("拿不到 pid → 不做修复（可能还有写者，修复本身就是第二个写者）", out2.repaired === undefined);
		check("拿不到 pid → 保留停止标记", isStopRequested(root2, "l2"));
		rmSync(stopRequestPath(root2, "l2"), { force: true });
	}

	for (const r of roots) {
		try {
			rmSync(r, { recursive: true, force: true });
		} catch {
			// 清理失败不影响结论
		}
	}
	console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
	if (fail > 0) process.exit(1);
}

void main();
