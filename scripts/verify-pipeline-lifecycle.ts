// 延迟执行器与真实 L1/L2/L3（派发换桩），只写临时 profile，不调用 LLM。
// node scripts/verify-pipeline-lifecycle.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPipelineJobsDB, closePipelineJobsDB, retainPipelineJobsDB, type PipelineJob } from "../memory/pipeline/jobs-db.ts";
import { setupPipelineWorker, type PipelineExecutors, type PipelineJobResult, type PipelineJobScope, type PipelineWorker } from "../memory/pipeline/worker.ts";
import { setupL1Extractor } from "../memory/l1/index.ts";
import { setupL2Organizer } from "../memory/l2/index.ts";
import { setupL3Persona } from "../memory/l3/index.ts";
import { loadFailureState, saveFailureState } from "../memory/failure-state.ts";
import { setSpawnImplForTest } from "../util/spawn.ts";
import { initNotice, setNoticeProfileResolver } from "../util/notice.ts";

const roots: string[] = [];
const harnesses: { worker: PipelineWorker; runs: { done: ReturnType<typeof deferred> }[] }[] = [];
const unhandled: unknown[] = [];
const onUnhandled = (err: unknown) => unhandled.push(err);
process.on("unhandledRejection", onUnhandled);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean) {
	const deadline = Date.now() + 2_500;
	while (!check()) { if (Date.now() > deadline) throw new Error("生命周期验证超时"); await sleep(5); }
}
function profile() {
	const p = mkdtempSync(join(tmpdir(), "pipe-lifecycle-")); roots.push(p);
	mkdirSync(join(p, "memoryDB", "state"), { recursive: true });
	return p;
}
function deferred() {
	let resolve!: (value: PipelineJobResult) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<PipelineJobResult>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function context(label: string) {
	const state = { alive: true, events: [] as string[] };
	const write = (value: string) => { if (!state.alive) throw new Error(`stale UI ${label}`); state.events.push(value); };
	return { state, ctx: { cwd: tmpdir(), ui: {
		setStatus: (_key: string, text: string) => write(text), notify: (text: string) => write(text),
	} } as any };
}
function harness(root = profile(), realFactory?: (pi: any, getProfile: () => string, worker: any) => any) {
	let current = root;
	const handlers = new Map<string, Function[]>();
	const cards: unknown[] = [];
	const pi = {
		on: (event: string, fn: Function) => handlers.set(event, [...handlers.get(event) ?? [], fn]),
		appendEntry: (_type: string, value: unknown) => cards.push(value), registerEntryRenderer() {},
	};
	const runs: { job: PipelineJob; scope: PipelineJobScope; done: ReturnType<typeof deferred> }[] = [];
	const flags = { remaining: false, newRecords: false };
	const checkedProfiles: string[] = [];
	const run = async (ctx: any, job: PipelineJob, scope?: PipelineJobScope): Promise<PipelineJobResult> => {
		const done = deferred(); runs.push({ job, scope: scope!, done }); ctx.ui.setStatus("memory", `start ${job.type}`);
		try { return await done.promise; } finally { ctx.ui.setStatus("memory", "end"); }
	};
	const executors: PipelineExecutors = {
		runL1: run, runL2: run, runL3: run, isCooledDown: () => false,
		hasL1Remaining: (p) => { checkedProfiles.push(p); return flags.remaining; },
		hasNewRecordsForL2: (p) => { checkedProfiles.push(p); return flags.newRecords; },
	};
	const worker = setupPipelineWorker(pi as any, () => current, () => executors);
	if (realFactory) {
		const controls = realFactory(pi, () => current, worker);
		const execute = (ctx: any, job: PipelineJob, scope?: PipelineJobScope) => controls.executeJob(ctx, job, scope);
		executors.runL1 = execute; executors.runL2 = execute; executors.runL3 = execute;
	}
	const initial = context("old"); worker.setCachedCtx(initial.ctx);
	const h = { root, db: getPipelineJobsDB(root), worker, flags, runs, checkedProfiles, cards, initial, pi,
		setProfile: (p: string) => { current = p; }, emit: (event: string) => { for (const fn of handlers.get(event) ?? []) fn({}, initial.ctx); },
	};
	harnesses.push(h); return h;
}
async function end(h: ReturnType<typeof harness>, result: PipelineJobResult = "done", index = 0) {
	h.runs[index].done.resolve(result);
	await until(() => !h.worker.ownsJob(h.runs[index].scope.profilePath, h.runs[index].job.id));
}
function seed(root: string) {
	const write = (rel: string, value: unknown) => {
		const full = join(root, "memoryDB", rel); mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value));
	};
	write("config/application-propertis.json", { l1: { mode: "code" }, subagent: { softMs: 5_000, hardMs: 10_000 } });
	write("l0/conversations/2026-10-05.jsonl", JSON.stringify({ message_id: "fixture", role: "user", content: "fixture" }) + "\n");
	write("l1/records/2026-10.jsonl", JSON.stringify({ id: "l1_1791158400000_fixture", content: "fixture" }) + "\n");
	write("l2/index/scene_index.json", [{ filename: "fixture.md", summary: "fixture", heat: 1, created: "2026-10-01", updated: "2026-10-05" }]);
	write("l2/scene-blocks/fixture.md", "fixture");
}
let passed = 0;
let failed = 0;
async function check(name: string, run: () => void | Promise<void>) {
	try { await run(); passed++; console.log(`PASS ${name}`); }
	catch (err) { failed++; console.error(`FAIL ${name}: ${err}`); }
}
try {
	await check("运行中重复 reset 保留连接，结束后释放并记录完成", async () => {
		const h = harness(); const job = h.worker.enqueueL1("manual")!; h.worker.kick();
		h.worker.reset(); h.worker.reset(); h.initial.state.alive = false;
		assert.equal(h.db.getJob(job.id)?.status, "running");
		assert.equal(h.runs[0].scope.isCurrent(), false);
		await end(h);
		assert.throws(() => h.db.getJob(job.id), /not open|closed/i);
		assert.equal(getPipelineJobsDB(h.root).getJob(job.id)?.status, "done");
		assert.equal(h.initial.state.events.length, 1);
	});
	await check("空闲关闭释放连接，重复关闭幂等", () => {
		const h = harness(); h.worker.reset(); h.worker.reset();
		assert.throws(() => h.db.listQueued(), /not open|closed/i);
	});
	await check("立即重开保留在途任务，新任务与旧清理不互相覆盖", async () => {
		const h = harness(); h.worker.enqueueL1("manual"); h.worker.kick(); h.worker.reset(); h.initial.state.alive = false;
		const next = context("new"); h.worker.setCachedCtx(next.ctx);
		assert.equal(getPipelineJobsDB(h.root), h.db);
		const queued = h.worker.enqueueL2("manual")!; h.worker.kick(); assert.equal(h.runs.length, 1);
		await end(h); await until(() => h.runs.length === 2);
		assert.equal(h.db.getJob(queued.id)?.status, "running");
		assert.equal(h.initial.state.events.length, 1); assert.equal(next.state.events.length, 1);
		h.worker.kick(); assert.equal(h.runs.length, 2);
		await end(h, "done", 1); assert.equal(h.db.getJob(queued.id)?.status, "done");
	});
	await check("切换 profile 后，旧任务的账目与后续编排仍归原 profile", async () => {
		const h = harness(); h.flags.newRecords = true;
		const original = h.worker.enqueueL1("manual")!; h.worker.kick();
		const other = profile(); h.setProfile(other); h.worker.setCachedCtx(context("other").ctx);
		const next = h.worker.enqueueL3("manual")!; await end(h); await until(() => h.runs.length === 2);
		assert.equal(getPipelineJobsDB(h.root).getJob(original.id)?.status, "done");
		assert.equal(getPipelineJobsDB(h.root).listQueued()[0]?.type, "l2");
		assert.ok(h.checkedProfiles.every((p) => p === h.root));
		assert.equal(getPipelineJobsDB(other).getJob(next.id)?.status, "running");
		assert.equal(h.runs[1].scope.profilePath, other); await end(h, "done", 1);
	});
	await check("关闭期间 L1 完成仍落盘下一批，恢复后继续执行", async () => {
		const h = harness(); h.flags.remaining = true; h.worker.enqueueL1("manual"); h.worker.kick(); h.worker.reset();
		await end(h); const db = getPipelineJobsDB(h.root); const next = db.listQueued()[0];
		assert.equal(next?.source, "drain"); assert.equal(h.runs.length, 1);
		h.flags.remaining = false; h.worker.setCachedCtx(context("resume").ctx); h.worker.kick();
		assert.equal(h.runs.length, 2); await end(h, "done", 1);
		assert.equal(db.getJob(next.id)?.status, "done");
	});
	await check("关闭期间执行器拒绝仍记录失败，不产生未处理拒绝", async () => {
		const h = harness(); const job = h.worker.enqueueL1("manual")!; h.worker.kick(); h.worker.reset();
		h.runs[0].done.reject(new Error("fixture rejection")); await until(() => !h.worker.ownsJob(h.root));
		assert.equal(getPipelineJobsDB(h.root).getJob(job.id)?.status, "failed");
	});
	await check("认领前出错与错误收尾再次出错都有拒绝兜底", async () => {
		const h = harness(); h.worker.enqueueL1("manual");
		const claim = h.db.claim; h.db.claim = () => { throw new Error("claim fixture"); };
		h.worker.kick(); await sleep(10); assert.equal(h.runs.length, 0); h.db.claim = claim;
		h.worker.kick(); const complete = h.db.complete;
		h.db.complete = () => { throw new Error("complete fixture"); };
		h.runs[0].done.reject(new Error("executor fixture")); await until(() => !h.worker.ownsJob(h.root));
		h.db.complete = complete; assert.equal(h.db.hasAnyRunning(), true);
	});
	await check("会话启动恢复不回收本进程仍监督的旧任务", () => {
		const h = harness(); const job = h.worker.enqueueL1("manual")!; h.worker.kick(); h.worker.reset();
		const sql = new DatabaseSync(h.db.dbPath);
		try { sql.prepare("UPDATE jobs SET started_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", job.id); }
		finally { sql.close(); }
		h.emit("session_start"); assert.equal(h.db.getJob(job.id)?.status, "running");
	});
	await check("新 worker 与旧在途任务共存，旧 reset 不关闭新会话连接", async () => {
		const old = harness(); old.worker.enqueueL1("manual"); old.worker.kick(); old.worker.reset();
		const fresh = harness(old.root); fresh.emit("session_start");
		assert.equal(fresh.db, old.db); assert.equal(fresh.worker.ownsJob(old.root), true);
		const next = fresh.worker.enqueueL2("manual")!; fresh.worker.kick(); assert.equal(fresh.runs.length, 0);
		await end(old); fresh.worker.kick(); assert.equal(fresh.runs.length, 1);
		assert.equal(fresh.db.getJob(next.id)?.status, "running"); await end(fresh);
	});
	await check("数据库租约幂等释放，过期句柄的关闭请求不能关闭新实例", () => {
		const root = profile(); const lease = retainPipelineJobsDB(root);
		closePipelineJobsDB(root, lease.db); assert.deepEqual(lease.db.listQueued(), []);
		lease.release(); lease.release(); assert.throws(() => lease.db.listQueued(), /not open|closed/i);
		const fresh = getPipelineJobsDB(root); closePipelineJobsDB(root, lease.db);
		assert.deepEqual(fresh.listQueued(), []);
	});
	// 已有派发测试接缝驱动真实执行器，不起 Pi 子进程。
	for (const [layer, factory] of [["l1", setupL1Extractor], ["l2", setupL2Organizer], ["l3", setupL3Persona]] as const) {
		await check(`${layer} 真实执行器：切换后成功仍更新原 profile，晚到早退不访问关闭连接`, async () => {
			const original = profile(); seed(original); const other = profile();
			let exit: ((info: any) => void) | undefined;
			setSpawnImplForTest((opts) => { exit = opts.onEarlyExit; return { pid: 999999, runId: "fixture", command: "fixture" }; });
			const h = harness(original, factory); initNotice(h.pi as any);
			setNoticeProfileResolver(() => other);
			const before = loadFailureState(original); before[layer].consecutiveFailures = 2; saveFailureState(original, before);
			assert.equal(loadFailureState(original)[layer].consecutiveFailures, 2);
			const queued = getPipelineJobsDB(original).enqueue(layer, "manual"); h.worker.kick();
			assert.equal(h.worker.ownsJob(original, queued.id), true); assert.equal(typeof exit, "function");
			h.setProfile(other); h.worker.setCachedCtx(context("other").ctx);
			getPipelineJobsDB(original).complete(queued.id, "done");
			await until(() => !h.worker.ownsJob(original, queued.id));
			assert.equal(loadFailureState(original)[layer].consecutiveFailures, 0);
			assert.equal(loadFailureState(other)[layer].consecutiveFailures, 0);
			assert.deepEqual(h.cards, []);
			assert.throws(() => h.db.listQueued(), /not open|closed/i);
			assert.doesNotThrow(() => exit!({ code: 1, signal: null, pid: 999999, runId: "fixture" }));
		});
		await check(`${layer} 真实执行器：关闭期间早退更新原 profile 的失败计数`, async () => {
			const original = profile(); seed(original); const other = profile();
			let exit: ((info: any) => void) | undefined;
			setSpawnImplForTest((opts) => { exit = opts.onEarlyExit; return { pid: 999999, runId: "fixture", command: "fixture" }; });
			const h = harness(original, factory); initNotice(h.pi as any); setNoticeProfileResolver(() => other); const queued = getPipelineJobsDB(original).enqueue(layer, "manual"); h.worker.kick();
			h.worker.reset(); h.setProfile(other); exit!({ code: 1, signal: null, pid: 999999, runId: "fixture" });
			await until(() => !h.worker.ownsJob(original, queued.id));
			assert.equal(loadFailureState(original)[layer].consecutiveFailures, 1);
			assert.equal(loadFailureState(other)[layer].consecutiveFailures, 0);
			assert.deepEqual(h.cards, []);
			assert.equal(getPipelineJobsDB(original).getJob(queued.id)?.status, "failed");
		});
		await check(`${layer} 真实执行器：关闭期间硬超时仍完成停止及原 profile 收尾`, async () => {
			const original = profile(); seed(original);
			writeFileSync(join(original, "memoryDB/config/application-propertis.json"), JSON.stringify({ l1: { mode: "code" }, subagent: { softMs: 1, hardMs: 5, killGraceMs: 1 } }));
			setSpawnImplForTest(() => ({ pid: 999999, runId: "fixture", command: "fixture" }));
			const h = harness(original, factory); initNotice(h.pi as any); setNoticeProfileResolver(() => original);
			const queued = getPipelineJobsDB(original).enqueue(layer, "manual"); h.worker.kick(); h.worker.reset();
			await until(() => !h.worker.ownsJob(original, queued.id));
			assert.equal(loadFailureState(original)[layer].consecutiveFailures, 1);
			assert.deepEqual(h.cards, []);
			assert.throws(() => h.db.listQueued(), /not open|closed/i);
			assert.match(getPipelineJobsDB(original).getJob(queued.id)?.error ?? "", /hard cap/);
		});
		await check(`${layer} 真实执行器：派发失败同时关闭，落败轮询停止后才释放连接`, async () => {
			const original = profile(); seed(original); const h = harness(original, factory);
			initNotice(h.pi as any); setNoticeProfileResolver(() => original);
			setSpawnImplForTest(() => { h.worker.reset(); throw new Error("spawn fixture"); });
			const queued = getPipelineJobsDB(original).enqueue(layer, "manual"); h.worker.kick();
			await until(() => !h.worker.ownsJob(original, queued.id));
			assert.equal(loadFailureState(original)[layer].consecutiveFailures, 1);
			assert.deepEqual(h.cards, []);
			assert.throws(() => h.db.listQueued(), /not open|closed/i);
			assert.equal(getPipelineJobsDB(original).getJob(queued.id)?.status, "failed");
		});
	}
} finally {
	setSpawnImplForTest(null);
	for (const h of harnesses) { h.worker.reset(); for (const run of h.runs) run.done.resolve("skipped"); }
	await until(() => harnesses.every((h) => roots.every((p) => !h.worker.ownsJob(p))));
	for (const root of roots) { closePipelineJobsDB(root); assert.ok(root.startsWith(join(tmpdir(), "pipe-lifecycle-"))); rmSync(root, { recursive: true, force: true }); }
	await sleep(10);
	process.removeListener("unhandledRejection", onUnhandled);
}
await check("所有关闭、错误与晚到回调均无未处理拒绝", () => assert.deepEqual(unhandled, []));
console.log(`结果：PASS ${passed} / FAIL ${failed}`);
if (failed) process.exitCode = 1;
