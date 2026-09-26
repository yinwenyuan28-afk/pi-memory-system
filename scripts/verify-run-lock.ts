// 运行级锁（谁写谁持锁）的回归基线（2026-09-26，SUBAGENT_RUN_LOCK 的 T7）
//
// 只读生产代码；只写系统临时目录 + 一个**自己 spawn 的假进程**（拿真实存活 pid 当"持有者"，
// 不碰任何真实子代理）。
//
// 为什么这些断言值得单独成文件：运行级锁是"两个同层子代理交错提交会静默丢改动"的唯一防线，
// 而它的三层回收判据（pid 死 / 心跳不新鲜 / 过期）里，只有第一层是确定性的 ——
// 判错的方向必须是"多等"而不是"放行"，所以每一条都要钉死。
//
// 用 tsx 跑：tsx scripts/verify-run-lock.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireRunLock,
	forceReleaseRunLock,
	isProcessAlive,
	readRunLockOwner,
	registerRunLockExitHook,
	releaseAllRunLocks,
	runLockAcquirable,
	runLockBusyMessage,
	runLockDir,
	type RunLockOwner,
} from "../memory/pipeline/run-lock.ts";

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

function makeProfile(): string {
	const root = mkdtempSync(join(tmpdir(), "runlock-"));
	roots.push(root);
	mkdirSync(join(root, "memoryDB", "state"), { recursive: true });
	return root;
}

/** 直接往盘上放一份 owner（模拟"别人拿着锁"）。 */
function seedOwner(profilePath: string, layer: string, owner: RunLockOwner): void {
	mkdirSync(runLockDir(profilePath, layer), { recursive: true });
	writeFileSync(join(runLockDir(profilePath, layer), "owner.json"), JSON.stringify(owner), "utf-8");
}

const ownerAt = (over: Partial<RunLockOwner> = {}): RunLockOwner => ({
	pid: process.pid,
	layer: "l2",
	jobId: 0,
	startedAt: Date.now(),
	heartbeatAt: Date.now(),
	expiresAt: Date.now() + 3_600_000,
	...over,
});

async function main(): Promise<void> {
	// 这条必须在任何 acquire 之前跑：acquire 内部会惰性注册钩子（一次性）
	console.log("\n=== 0. 退出钩子注册（幂等） ===");
	{
		check("首次注册成功", registerRunLockExitHook());
		check("重复注册幂等（不重复挂 listener）", !registerRunLockExitHook());
	}

	console.log("\n=== 1. 纯函数：三层判据的顺序与真值表 ===");
	{
		const now = Date.now();
		const base = { nowMs: now, staleHeartbeatMs: 60_000, expireMs: 3_600_000 };
		check("没有 owner → free", runLockAcquirable({ ...base, owner: undefined, holderAlive: false }) === "free");
		check(
			"① 持有者 pid 已死 → steal-dead（不管心跳多新）",
			runLockAcquirable({ ...base, owner: ownerAt({ heartbeatAt: now }), holderAlive: false }) === "steal-dead",
		);
		check(
			"活 + 心跳新鲜 + 未过期 → held",
			runLockAcquirable({ ...base, owner: ownerAt({ heartbeatAt: now - 5_000 }), holderAlive: true }) === "held",
		);
		check(
			"② 活 + 心跳不新鲜（>60s）→ steal-stale-heartbeat（免疫 pid 复用）",
			runLockAcquirable({ ...base, owner: ownerAt({ heartbeatAt: now - 61_000 }), holderAlive: true }) ===
				"steal-stale-heartbeat",
		);
		check(
			"心跳恰好等于阈值 → 仍算新鲜（不给边界送分）",
			runLockAcquirable({ ...base, owner: ownerAt({ heartbeatAt: now - 60_000 }), holderAlive: true }) === "held",
		);
		check(
			"③ 活 + 心跳新鲜但已过期 → steal-expired",
			runLockAcquirable({
				...base,
				owner: ownerAt({ heartbeatAt: now - 1_000, expiresAt: now - 1 }),
				holderAlive: true,
			}) === "steal-expired",
		);
		check(
			"心跳字段缺失（老记录）+ 未到过期 → held（保守：证不了活着也不放行）",
			runLockAcquirable({ ...base, owner: ownerAt({ heartbeatAt: 0, startedAt: now - 1_000 }), holderAlive: true }) ===
				"held",
		);
		check(
			"心跳字段缺失 + 已超过 expireMs → steal-expired（只按过期兜底）",
			runLockAcquirable({ ...base, owner: ownerAt({ heartbeatAt: 0, startedAt: now - 4_000_000 }), holderAlive: true }) ===
				"steal-expired",
		);
	}

	console.log("\n=== 2. 夹具：抢 / 复用 / 释放 ===");
	{
		const root = makeProfile();
		check("初始无锁目录", !existsSync(runLockDir(root, "l2")));
		const a = acquireRunLock(root, "l2", 76);
		check("空闲时抢到", a.acquired, a.verdict);
		check("锁目录已建 + owner 是我们", existsSync(runLockDir(root, "l2")) && readRunLockOwner(root, "l2")?.pid === process.pid);
		const b = acquireRunLock(root, "l2", 76);
		check("同一进程二次抢 → 复用同一把（不冲突）", b.acquired && b.owner?.pid === process.pid);
		check("别层互不影响（l1 仍空闲）", acquireRunLock(root, "l1", 1).acquired);
		a.release();
		check("释放后目录消失（同时清掉 l1）", (() => {
			acquireRunLock(root, "l1", 1).release();
			return !existsSync(runLockDir(root, "l2")) && !existsSync(runLockDir(root, "l1"));
		})());
	}

	console.log("\n=== 3. 真进程三条回收路径（假进程的活 pid 当持有者） ===");
	{
		const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore", windowsHide: true });
		const pid = child.pid as number;
		await sleep(200);
		check("靶子进程活着", isProcessAlive(pid));

		// 路径 A：活 pid + 心跳新鲜 ⇒ 必须拒绝（这就是"pi 重启后老 detached 子代理还在写"的防线）
		const rootA = makeProfile();
		seedOwner(rootA, "l2", {
			pid,
			layer: "l2",
			jobId: 76,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
			expiresAt: Date.now() + 3_600_000,
		});
		const rA = acquireRunLock(rootA, "l2", 99);
		check("A 活 + 心跳新鲜 ⇒ 拒绝抢", !rA.acquired && rA.verdict === "held", rA.verdict);
		check("A 拒绝时保留原持有者（不误删）", readRunLockOwner(rootA, "l2")?.pid === pid);
		check("A 拒绝文案含占用人 pid 与心跳", /另一子代理正在写本层/.test(runLockBusyMessage("l2", rA.owner)));

		// 路径 B：活 pid + 心跳不新鲜 ⇒ 可抢（② 免疫 pid 复用）
		const rootB = makeProfile();
		seedOwner(rootB, "l2", {
			pid,
			layer: "l2",
			jobId: 76,
			startedAt: Date.now() - 300_000,
			heartbeatAt: Date.now() - 120_000,
			expiresAt: Date.now() + 3_600_000,
		});
		const rB = acquireRunLock(rootB, "l2", 99);
		check("B 活 + 心跳停 120s ⇒ 抢到（steal-stale-heartbeat）", rB.acquired && rB.verdict === "steal-stale-heartbeat", rB.verdict);
		check("B 抢到后 owner 换成我们", readRunLockOwner(rootB, "l2")?.pid === process.pid);
		rB.release();

		// 路径 C：pid 已死 ⇒ 秒级可抢
		kill(child);
		await sleep(400);
		check("靶子已被杀", !isProcessAlive(pid));
		const rootC = makeProfile();
		seedOwner(rootC, "l2", {
			pid,
			layer: "l2",
			jobId: 76,
			startedAt: Date.now(),
			heartbeatAt: Date.now(), // 心跳很新，但进程没了
			expiresAt: Date.now() + 3_600_000,
		});
		const rC = acquireRunLock(rootC, "l2", 99);
		check("C pid 已死 ⇒ 抢到（steal-dead）", rC.acquired && rC.verdict === "steal-dead", rC.verdict);
		rC.release();

		// 路径 D：owner.json 不可读 ⇒ 保守拒绝（与 L1 写锁同款取舍）
		const rootD = makeProfile();
		mkdirSync(runLockDir(rootD, "l2"), { recursive: true });
		writeFileSync(join(runLockDir(rootD, "l2"), "owner.json"), "{ 坏掉的 json", "utf-8");
		const rD = acquireRunLock(rootD, "l2", 99);
		check("D owner.json 坏了 ⇒ 拒绝（不当 free、不按时间抢）", !rD.acquired && rD.verdict === "held");
	}

	console.log("\n=== 4. 强制回收（杀后修复用）===");
	{
		const root = makeProfile();
		// 死 pid → 清
		seedOwner(root, "l1", { pid: 999_999_999, layer: "l1", jobId: 1, startedAt: Date.now(), heartbeatAt: Date.now(), expiresAt: Date.now() + 1000 });
		check("持有者已死 ⇒ 被清", forceReleaseRunLock(root).includes("l1") && !existsSync(runLockDir(root, "l1")));
		// 活 pid（自己）→ 不动
		seedOwner(root, "l2", { pid: process.pid, layer: "l2", jobId: 2, startedAt: Date.now(), heartbeatAt: Date.now(), expiresAt: Date.now() + 3_600_000 });
		check("持有者活着 ⇒ 不动", forceReleaseRunLock(root).length === 0 && existsSync(runLockDir(root, "l2")));
		// 显式传"被杀的 pid"且正是持有者 ⇒ 清
		check("传匹配的 killedPid ⇒ 才清", forceReleaseRunLock(root, "l2", process.pid).includes("l2"));
		// owner.json 不可读 ⇒ 不动
		mkdirSync(runLockDir(root, "l3"), { recursive: true });
		writeFileSync(join(runLockDir(root, "l3"), "owner.json"), "broken", "utf-8");
		check("owner.json 不可读 ⇒ 不动（误清会让两个写者并存）", forceReleaseRunLock(root).length === 0 && existsSync(runLockDir(root, "l3")));
	}

	console.log("\n=== 5. 退出路径：releaseAllRunLocks ===");
	{
		const root = makeProfile();
		const h = acquireRunLock(root, "l2", 1);
		check("抢占成功", h.acquired && existsSync(runLockDir(root, "l2")));
		releaseAllRunLocks();
		check("releaseAllRunLocks 清干净（process.on(\"exit\") 就用它）", !existsSync(runLockDir(root, "l2")));
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

/** 强杀靶子（Windows 上 process.kill 即 TerminateProcess）。 */
function kill(child: ReturnType<typeof spawn>): void {
	try {
		child.kill("SIGKILL");
	} catch {
		// 忽略
	}
}

void main();
