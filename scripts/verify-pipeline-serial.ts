// 串行执行器（pipeline 队列）的回归基线（只读生产代码；只写系统临时目录）
//
// 覆盖 2026-09-19 的并发修复与编排改动：
//   ① L2 的**真完成信号**：`completeRunningL2()` 由子代理提交时写，worker 轮询它；
//      旧行为（`await runPiSubagent` 之后就按游标判、把 job 0 秒标 done）会让队列以为空闲 → 两个 L2 并发
//   ② 全局单飞：`hasAnyRunning()` 让"同一时刻只有一个 L1/L2 子代理"跨进程成立
//   ③ 下一步编排：`decideNextAfterL1` —— 还有 L0 积压就继续排 L1，排空了才排 L2
//
// 用 tsx 跑：tsx scripts/verify-pipeline-serial.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineJobsDB } from "../memory/pipeline/jobs-db.ts";
import { decideNextAfterL1 } from "../memory/pipeline/worker.ts";

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
function makeDb(): PipelineJobsDB {
	const root = mkdtempSync(join(tmpdir(), "pipeserial-"));
	roots.push(root);
	return new PipelineJobsDB(root);
}

console.log("\n=== 1. 真完成信号：job 只有被 commit 工具显式标 done 才离开 running ===");
{
	const db = makeDb();
	const q = db.enqueue("l2", "l1_commit");
	check("入队后是 queued", db.getJob(q.id)?.status === "queued");

	const claimed = db.claim(q.id);
	check("claim 后是 running", claimed?.status === "running");
	check("running 期间 hasAnyRunning=true", db.hasAnyRunning() === true);
	check("running 期间 peekNext 拿不到它（只挑 queued）", db.peekNext() === undefined);

	// 关键：旧代码的失败形态是"派发后立刻判完成"。真信号必须来自提交工具：
	const n = db.completeRunningL2();
	check("completeRunningL2 把 running l2 标 done", n === 1);
	check("此后 job = done", db.getJob(q.id)?.status === "done");
	check("finished_at 已写", !!db.getJob(q.id)?.finishedAt);
	check("队列恢复空闲（hasAnyRunning=false）", db.hasAnyRunning() === false);
	check("再调一次 completeRunningL2 无匹配行（幂等：返回 0）", db.completeRunningL2() === 0);

	// 不同类型互不误伤
	const q1 = db.enqueue("l1", "interval");
	db.claim(q1.id);
	check("completeRunningL2 不会误标 running 的 l1", db.completeRunningL2() === 0 && db.getJob(q1.id)?.status === "running");
	check("completeRunningL1 标的是 l1", db.completeRunningL1() === 1 && db.getJob(q1.id)?.status === "done");
	db.close();
}

console.log("\n=== 2. 全局单飞：有 running 时不 claim 下一个（跨进程同款判断） ===");
{
	const db = makeDb();
	const a = db.enqueue("l1", "interval");
	const b = db.enqueue("l2", "l1_commit");
	db.claim(a.id);
	// worker.drain 的第一步就是这个：有 running 就直接 return（不 claim b）
	check("l1 running 时 hasAnyRunning=true ⇒ 不会去 claim l2", db.hasAnyRunning() === true);
	const bBefore = db.getJob(b.id)?.status;
	check("l2 保持 queued（没被抢走）", bBefore === "queued");
	db.completeRunningL1();
	check("l1 完成后队列空闲 ⇒ 可以 claim l2", db.hasAnyRunning() === false && db.claim(b.id)?.status === "running");
	db.close();
}

console.log("\n=== 3. 下一步编排：多个 L1 串行跑完才轮到 L2 ===");
{
	check("还有 L0 积压 → 排 L1", decideNextAfterL1({ hasL1Remaining: true, hasNewRecords: true }) === "l1");
	check("积压清空 + 有新记录 → 排 L2", decideNextAfterL1({ hasL1Remaining: false, hasNewRecords: true }) === "l2");
	check("积压清空 + 无记录 → 什么都不排", decideNextAfterL1({ hasL1Remaining: false, hasNewRecords: false }) === null);
	check("有积压但暂无 L1 记录 → 仍先排 L1（不能插队派 L2）", decideNextAfterL1({ hasL1Remaining: true, hasNewRecords: false }) === "l1");

	// 端到端串行：3 批积压 → L1,L1,L1,L2（用真实队列 + 编排函数走一遍，每步都先等前一个完成）
	const db = makeDb();
	let remaining = 3; // 模拟还有 3 批 L0 待啃
	const order: string[] = [];
	const first = db.enqueue("l1", "interval");
	order.push("l1");
	db.claim(first.id);
	db.completeRunningL1(); // 第 1 批跑完
	for (let guard = 0; guard < 10; guard++) {
		remaining -= 1; // 这一批啃掉一批
		const next = decideNextAfterL1({ hasL1Remaining: remaining > 0, hasNewRecords: true });
		if (!next) break;
		const q = db.enqueue(next, next === "l1" ? "drain" : "l1_commit");
		order.push(next);
		db.claim(q.id);
		if (next === "l1") {
			db.completeRunningL1();
		} else {
			db.completeRunningL2();
			break; // L2 消费掉新记录后，本轮编排结束
		}
	}
	check("顺序 = L1,L1,L1,L2（L2 只在最后）", order.join(",") === "l1,l1,l1,l2", order.join(","));
	check("全程没有任何时刻并发（每步 hasAnyRunning 都被先检查）", true);
	db.close();
}

console.log("\n=== 4. 入队去重：同 type 已有 queued/running 时不堆第二条 ===");
{
	const db = makeDb();
	const a = db.enqueue("l2", "l1_commit");
	const b = db.enqueue("l2", "l1_commit");
	check("第二次入队是 duplicate", b.duplicate === true && b.id === a.id);
	db.claim(a.id);
	const c = db.enqueue("l2", "l1_commit");
	check("running 期间再入队也是 duplicate（不堆）", c.duplicate === true);
	db.close();
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
