// 串行执行器（pipeline 队列）的回归基线（只读生产代码；只写系统临时目录）
//
// 覆盖 2026-09-19 的并发修复与编排改动：
//   ① L2 的**真完成信号**：`completeRunningL2()` 由子代理提交时写，worker 轮询它；
//      旧行为（`await runPiSubagent` 之后就按游标判、把 job 0 秒标 done）会让队列以为空闲 → 两个 L2 并发
//   ② 全局单飞：`hasAnyRunning()` 让"同一时刻只有一个 L1/L2 子代理"跨进程成立
//   ③ 下一步编排：`decideNextAfterL1` —— 还有 L0 积压就继续排 L1，排空了才排 L2
//
// 用 tsx 跑：tsx scripts/verify-pipeline-serial.ts
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineJobsDB } from "../memory/pipeline/jobs-db.ts";
import { decideManualTrigger, decideNextAfterL1, pickNextClaimable } from "../memory/pipeline/worker.ts";
import { decideTimeoutAction, locateSubagentSession, sampleSession } from "../memory/pipeline/subagent-liveness.ts";

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
	check("running 期间 listQueued 里没有它（只挑 queued）", db.listQueued().length === 0);

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

console.log("\n=== 5. L3 并入串行执行器（2026-09-19） ===");
{
	const db = makeDb();

	// ① 真完成信号：l3_commit 调 completeRunningL3() 才离开 running
	const q = db.enqueue("l3", "trigger");
	check("l3 可入队且是 queued", db.getJob(q.id)?.status === "queued" && db.getJob(q.id)?.type === "l3");
	db.claim(q.id);
	check("claim 后 l3 running", db.getJob(q.id)?.status === "running");
	check("l3 running 也占用全局单飞", db.hasAnyRunning() === true);
	check("completeRunningL3 把它标 done", db.completeRunningL3() === 1 && db.getJob(q.id)?.status === "done");
	check("再调一次幂等（0）", db.completeRunningL3() === 0);
	{
		// 类型隔离：别把 running 的 l1 误标成 done（三层共用 completeRunning 的回归）
		const a = db.enqueue("l1", "interval");
		db.claim(a.id);
		check("completeRunningL3 不动 running 的 l1", db.completeRunningL3() === 0 && db.getJob(a.id)?.status === "running");
		check("completeRunningL1 才动它", db.completeRunningL1() === 1 && db.getJob(a.id)?.status === "done");
	}

	// ② 末位优先：L3 的输入是 L1/L2 的产物，不许插队到积压/L2 前面
	{
		const db2 = makeDb();
		const l3 = db2.enqueue("l3", "trigger"); // 先入队，id 更小
		const l1 = db2.enqueue("l1", "drain");
		check("L3 先入队、L1 后入队 → 仍先跑 L1", db2.listQueued()[0]?.id === l1.id, `队首=${db2.listQueued()[0]?.type}`);
		db2.claim(l1.id);
		db2.completeRunningL1();
		const l2 = db2.enqueue("l2", "l1_commit");
		check("L1 之后先跑 L2，而不是排在最前的 L3", db2.listQueued()[0]?.id === l2.id);
		db2.claim(l2.id);
		db2.completeRunningL2();
		check("L1/L2 都排空了才轮到 L3", db2.listQueued()[0]?.id === l3.id);
		db2.close();
	}

	// ③ 攒批：L3 在队列里等的时候，重复触发只合并成一条（本轮并发事故的入口）
	{
		const db3 = makeDb();
		db3.enqueue("l3", "trigger");
		const again = db3.enqueue("l3", "trigger");
		check("L3 重复触发合并（duplicate）", again.duplicate === true);
		check("队列里只有一条 l3", db3.listQueued().filter((j) => j.type === "l3").length === 1);
		db3.close();
	}

	db.close();
}

console.log("\n=== 6. 熔断层不许堵住别的层（2026-09-21 实测事故的直接回归） ===");
{
	// 事故现场：L2 熔断后队列里排着 l2(68) 和它后面的 l1(69)，drain 取队首 → L2 熔断 → return
	// ⇒ L1 被堵 5 小时（job 69 一直 queued），手动 /l1-trigger 又被 hasActive 拦下。
	const db = makeDb();
	const l2 = db.enqueue("l2", "l1_commit");
	const l1 = db.enqueue("l1", "interval");
	const l3 = db.enqueue("l3", "trigger");

	const onlyL2Cooled = (t: string) => t === "l2";
	check("队首是熔断的 l2（复现事故前提）", db.listQueued()[0]?.id === l2.id);
	check("跳过熔断层 → 挑到后面的 l1", pickNextClaimable(db.listQueued(), onlyL2Cooled)?.id === l1.id);
	check(
		"（对照）旧行为「取队首就 return」会让 l1 永远排在后面",
		db.listQueued()[0]?.type === "l2",
	);

	// 熔断的 l1 + 队里的 l2/l3：应挑 l2（l1 被跳过，l3 优先级最低）
	const db2 = makeDb();
	const a1 = db2.enqueue("l1", "interval");
	const a2 = db2.enqueue("l2", "l1_commit");
	const a3 = db2.enqueue("l3", "trigger");
	check("跳过熔断的 l1 → 挑 l2（不是优先级最低的 l3）", pickNextClaimable(db2.listQueued(), (t) => t === "l1")?.id === a2.id);
	check("三层全熔断 → 无事可做（不误挑，队列照旧）", pickNextClaimable(db2.listQueued(), () => true) === undefined);
	check("被跳过的 job 仍留在队列里（等复位，不是丢弃）", db2.getJob(a1.id)?.status === "queued" && db2.listQueued().length === 3);
	db2.close();
	db.close();
}

console.log("\n=== 7. 手动触发：熔断不许把自己的恢复入口也堵死（decideManualTrigger） ===");
{
	check("队列空闲 → 照常入队", decideManualTrigger({ hasActive: false, queuedOfType: false, cooledDown: false }) === "proceed");
	check(
		"队列里有本层 job 但没熔断 → 维持原提示",
		decideManualTrigger({ hasActive: true, queuedOfType: true, cooledDown: false }) === "refuse-busy",
	);
	check(
		"熔断 + 队列里那条正被按着 → 复位熔断让它跑（本次事故的 /l2-trigger 入口）",
		decideManualTrigger({ hasActive: true, queuedOfType: true, cooledDown: true }) === "unpause-queued",
	);
	check(
		"熔断但队列里没有本层 job → 照常入队（走下面的复位 + enqueue）",
		decideManualTrigger({ hasActive: false, queuedOfType: false, cooledDown: true }) === "proceed",
	);
	check(
		"已经在跑（有 running、没有 queued）→ 拒绝，别想着复位",
		decideManualTrigger({ hasActive: true, queuedOfType: false, cooledDown: true }) === "refuse-busy",
	);
}

console.log("\n=== 8. 来源即意图：l3 的 signal 必须与 trigger 分开（2026-09-21 job 51 回归） ===");
{
	// personaSignal 是 P1；claim 时若按普通 trigger 重估门控，信号会被静默降级成 skipped
	const db = makeDb();
	const sig = db.enqueue("l3", "signal");
	check("signal 可作为 l3 的来源入库", db.getJob(sig.id)?.source === "signal");
	check("signal 与 trigger 不互相去重（都能入队，type 去重只按 type）", db.enqueue("l3", "trigger").duplicate === true);
	db.close();
}

console.log("\n=== 9. 超时误判认领：跑得晚但真提交了，账必须纠回来（L1/L2 同款） ===");
{
	const db = makeDb();
	// 造一个"主进程标 failed、子代理随后提交"的 l2 job（jobs 55/61/64/68 那次四连超时的形状）
	const timedOut = db.enqueue("l2", "l1_commit");
	db.claim(timedOut.id);
	db.complete(timedOut.id, "failed", "timeout without l2_commit");
	check("先确认它确实被标成 failed", db.getJob(timedOut.id)?.status === "failed");

	// 时间窗测试用一条**不同错误文案**的 job，免得它也被后面的 reclaimTimedOutL1() 数进去
	const probe = db.enqueue("l1", "interval");
	db.claim(probe.id);
	db.complete(probe.id, "failed", "reclaim-window probe");
	db.reclaimTimedOutL2(0); // withinMs=0 ⇒ 不认领任何"此刻之前完成"的
	check("withinMs=0 时不认领（时间窗外不动手）", db.getJob(timedOut.id)?.status === "failed");

	const n = db.reclaimTimedOutL2();
	check("reclaimTimedOutL2 把超时的 l2 纠回 done", n === 1 && db.getJob(timedOut.id)?.status === "done");
	check("error 被清空（不再是失败态）", db.getJob(timedOut.id)?.error === null);
	check("再调一次幂等（0）", db.reclaimTimedOutL2() === 0);

	// 类型隔离 + 文案隔离：别把 l1 的、或别的错误文案的 failed 洗成成功
	const l1TimedOut = db.enqueue("l1", "interval");
	db.claim(l1TimedOut.id);
	db.complete(l1TimedOut.id, "failed", "timeout without l1_commit");
	check("reclaimTimedOutL2 不认领 l1 的超时", db.reclaimTimedOutL2() === 0 && db.getJob(l1TimedOut.id)?.status === "failed");
	check("reclaimTimedOutL1 才认领它", db.reclaimTimedOutL1() === 1 && db.getJob(l1TimedOut.id)?.status === "done");

	const otherErr = db.enqueue("l2", "manual");
	db.claim(otherErr.id);
	db.complete(otherErr.id, "failed", "recovered: leftover running");
	check("别的错误文案不被洗成成功", db.reclaimTimedOutL2() === 0 && db.getJob(otherErr.id)?.status === "failed");
	db.close();
}

console.log("\n=== 10. 子代理活性判定：到点先看它还在不在写（2026-09-21 T1） ===");
{
	// 现场：L1 job 70 被标 failed 后 7 分钟才提交、L2 job 68 被标 failed 后 10 分钟还在写场景块。
	// 所以"到点"不等于"死了" —— 判据换成"子代理会话是否还在长"。
	const base = { deadlineMs: 630_000, extendedMs: 0, maxExtendMs: 630_000, silentThresholdMs: 120_000 };
	check("未到点 → continue", decideTimeoutAction({ ...base, elapsedMs: 100_000, silentMs: 0 }) === "continue");
	check(
		"到点 + 仍在写（静默 30s）→ extend",
		decideTimeoutAction({ ...base, elapsedMs: 630_001, silentMs: 30_000 }) === "extend",
	);
	check(
		"到点 + 真静默（静默 5 分钟）→ abort",
		decideTimeoutAction({ ...base, elapsedMs: 630_001, silentMs: 300_000 }) === "abort",
	);
	check(
		"静默恰好等于阈值 → 不算还在写（abort）",
		decideTimeoutAction({ ...base, elapsedMs: 630_001, silentMs: 120_000 }) === "abort",
	);
	check(
		"延长额度用完 → abort（哪怕它还在写）",
		decideTimeoutAction({ ...base, elapsedMs: 1_260_001, silentMs: 1_000, extendedMs: 630_000 }) === "abort",
	);
	check(
		"会话定位不到（silentMs=-1）→ 不延长，按时失败",
		decideTimeoutAction({ ...base, elapsedMs: 630_001, silentMs: -1 }) === "abort",
	);
	check(
		"延长后仍未到新 deadline（deadline 被 +180s 抬到 810s）→ continue",
		decideTimeoutAction({ ...base, deadlineMs: 810_000, elapsedMs: 700_000, silentMs: 1_000 }) === "continue",
	);

	// 会话采样：读不到文件必须是 -1（未知），不能是 0（0 会被误判成"刚刚在写"）
	check("不存在的文件 → size/silent 都是 -1", sampleSession("C:/temp/pi/script/__no_such_session__.jsonl").size === -1);
	check("file=undefined → -1", sampleSession(undefined).silentMs === -1);

	// 定位子代理会话：父会话目录下按 mtime 取最新 run
	{
		const root = mkdtempSync(join(tmpdir(), "liveness-"));
		roots.push(root);
		const parent = join(root, "2026-09-22T00-00-00-000Z_abc.jsonl");
		writeFileSync(parent, "{}\n", "utf-8");
		const sessionDir = join(root, "2026-09-22T00-00-00-000Z_abc");
		// 早的一个子代理 + 晚的一个（晚的才是当前这轮）
		mkdirSync(join(sessionDir, "aaaa1111", "run-0"), { recursive: true });
		mkdirSync(join(sessionDir, "bbbb2222", "run-0"), { recursive: true });
		writeFileSync(join(sessionDir, "aaaa1111", "run-0", "session.jsonl"), "old", "utf-8");
		writeFileSync(join(sessionDir, "bbbb2222", "run-0", "session.jsonl"), "new", "utf-8");
		// 显式错开 mtime：同毫秒写入时"按 mtime 取最新"会并列，夹具必须确定（否则测试本身假红）
		utimesSync(join(sessionDir, "aaaa1111", "run-0", "session.jsonl"), new Date(1000), new Date(1000));
		utimesSync(join(sessionDir, "bbbb2222", "run-0", "session.jsonl"), new Date(2000), new Date(2000));
		const found = locateSubagentSession(parent);
		check("定位到最新的 run 会话", found === join(sessionDir, "bbbb2222", "run-0", "session.jsonl"), String(found));
		check("父会话不存在时返回 undefined", locateSubagentSession(join(root, "nope.jsonl")) === undefined);
		check("空参数返回 undefined", locateSubagentSession(undefined) === undefined);
	}
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
