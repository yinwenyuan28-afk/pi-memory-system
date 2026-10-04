// 真实独立进程 + 可控交错；只写自建临时 profile。node scripts/verify-pipeline-concurrency.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PipelineJobsDB } from "../memory/pipeline/jobs-db.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

if (process.argv[2] === "--competitor") {
	const db = new PipelineJobsDB(process.argv[3]);
	const releaseFile = process.argv[4];
	if (releaseFile) {
		// 暂停真实查重 SELECT 的返回：旧实现此时尚未持写锁；事务修复后 B 必须等 A。
		const sqlDb = (db as unknown as { db: DatabaseSync }).db;
		const prepare = sqlDb.prepare.bind(sqlDb);
		sqlDb.prepare = ((sql: string) => {
			const statement = prepare(sql);
			if (sql.startsWith("SELECT * FROM jobs WHERE type = ? AND status IN")) {
				const get = statement.get.bind(statement);
				statement.get = ((...args: unknown[]) => {
					const row = get(...args as any[]);
					process.send?.({ event: "selected" });
					const deadline = Date.now() + 10_000;
					while (!existsSync(releaseFile)) {
						if (Date.now() > deadline) throw new Error("查重交错夹具超时");
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
					}
					return row;
				}) as typeof statement.get;
			}
			return statement;
		}) as typeof sqlDb.prepare;
	}
	process.on("message", (msg: any) => {
		try {
			if (msg.op === "close") { db.close(); process.disconnect?.(); return; }
			process.send?.({ event: "started", id: msg.id });
			const value = msg.op === "probe" ? db.hasAnyRunning()
				: msg.op === "claim" ? db.claim(msg.jobId)?.id ?? null
				: msg.op === "choose" ? db.claim(db.listQueued()[0]?.id ?? -1)?.id ?? null
				: db.enqueue("l1", "interval");
			process.send?.({ id: msg.id, value });
		} catch (err) {
			process.send?.({ id: msg.id, error: String(err) });
		}
	});
	process.send?.({ event: "ready" });
} else {
	let passed = 0;
	let failed = 0;
	const roots: string[] = [];
	const children: { child: ChildProcess; ready: Promise<void>; selected: Promise<void>; started: Promise<void>; rpc: (op: string, jobId?: number) => Promise<any>; exit: Promise<void> }[] = [];
	function profile(): string { const p = mkdtempSync(join(tmpdir(), "pipe-concurrent-")); roots.push(p); return p; }
	function competitor(root: string, releaseFile?: string) {
		const child = spawn(process.execPath, [import.meta.filename, "--competitor", root, ...(releaseFile ? [releaseFile] : [])], {
			stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true,
		});
		const pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
		let serial = 0;
		let readyResolve!: () => void;
		let selectedResolve!: () => void;
		let startedResolve!: () => void;
		const ready = new Promise<void>((r) => { readyResolve = r; });
		const selected = new Promise<void>((r) => { selectedResolve = r; });
		const started = new Promise<void>((r) => { startedResolve = r; });
		child.on("message", (msg: any) => {
			if (msg.event === "ready") readyResolve();
			else if (msg.event === "selected") selectedResolve();
			else if (msg.event === "started") startedResolve();
			else {
				const request = pending.get(msg.id); pending.delete(msg.id);
				if (msg.error) request?.reject(new Error(msg.error)); else request?.resolve(msg.value);
			}
		});
		child.on("error", (err) => { for (const request of pending.values()) request.reject(err); });
		const exit = new Promise<void>((r) => child.once("exit", () => {
			for (const request of pending.values()) request.reject(new Error("竞争进程提前退出"));
			r();
		}));
		function rpc(op: string, jobId?: number): Promise<any> {
			const id = ++serial;
			return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, op, jobId }); });
		}
		const instance = { child, ready, selected, started, rpc, exit };
		children.push(instance);
		return instance;
	}
	async function check(name: string, run: () => void | Promise<void>) {
		try { await run(); passed++; console.log(`PASS ${name}`); }
		catch (err) { failed++; console.error(`FAIL ${name}: ${err}`); }
	}
	const watchdog = setTimeout(() => { console.error("竞争验证超时"); for (const c of children) c.child.kill(); process.exit(1); }, 25_000);
	try {
		await check("A/B 都查到空闲后，A 先认领，B 随后挑选其他任务仍不能认领", async () => {
			const root = profile(); const db = new PipelineJobsDB(root);
			try {
				const first = db.enqueue("l1", "interval"); db.enqueue("l2", "l1_commit");
				const a = competitor(root); const b = competitor(root); await Promise.all([a.ready, b.ready]);
				assert.deepEqual(await Promise.all([a.rpc("probe"), b.rpc("probe")]), [false, false]);
				assert.equal(await a.rpc("claim", first.id), first.id);
				assert.equal(await b.rpc("choose"), null);
				assert.equal(db.listQueued().length, 1);
			} finally { db.close(); }
		});
		await check("双进程同时认领不同任务，只有一个成功", async () => {
			const root = profile(); const db = new PipelineJobsDB(root);
			try {
				const aJob = db.enqueue("l1", "interval"); const bJob = db.enqueue("l2", "l1_commit");
				const a = competitor(root); const b = competitor(root); await Promise.all([a.ready, b.ready]);
				const claims = await Promise.all([a.rpc("claim", aJob.id), b.rpc("claim", bJob.id)]);
				assert.equal(claims.filter((id) => id !== null).length, 1);
			} finally { db.close(); }
		});
		await check("A 查重后暂停，B 并发入队同层只产生一个活动任务", async () => {
			const root = profile(); const db = new PipelineJobsDB(root); const releaseFile = join(root, "release");
			try {
				const a = competitor(root, releaseFile); const b = competitor(root); await Promise.all([a.ready, b.ready]);
				const aResult = a.rpc("enqueue"); await a.selected;
				const bResult = b.rpc("enqueue"); await b.started;
				await Promise.race([bResult, sleep(150)]);
				writeFileSync(releaseFile, "go");
				const [one, two] = await Promise.all([aResult, bResult]);
				assert.equal(one.id, two.id);
				assert.equal(Number(one.duplicate) + Number(two.duplicate), 1);
				assert.equal(db.listQueued().length, 1);
			} finally { writeFileSync(releaseFile, "go"); db.close(); }
		});
		await check("入队失败后回滚，连接仍能入队", () => {
			const db = new PipelineJobsDB(profile()); const sql = new DatabaseSync(db.dbPath);
			try {
				sql.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
				assert.throws(() => db.enqueue("l1", "interval"), /fixture failure/);
				sql.exec("DROP TRIGGER fail_insert;");
				assert.equal(db.enqueue("l1", "interval").duplicate, false);
			} finally { sql.close(); db.close(); }
		});
		await check("存量同层多个 running 不被一次完成信号全部标 done", () => {
			const db = new PipelineJobsDB(profile()); const sql = new DatabaseSync(db.dbPath);
			try {
				sql.exec("INSERT INTO jobs(type,source,status,created_at) VALUES ('l1','interval','running','fixture'),('l1','interval','running','fixture');");
				assert.throws(() => db.completeRunningL1(), /multiple running/);
				assert.equal((sql.prepare("SELECT count(*) AS n FROM jobs WHERE status='running'").get() as any).n, 2);
			} finally { sql.close(); db.close(); }
		});
	} finally {
		for (const c of children) if (c.child.connected) c.child.send({ op: "close" });
		await Promise.all(children.map((c) => c.exit));
		clearTimeout(watchdog);
		for (const root of roots) { assert.ok(root.startsWith(join(tmpdir(), "pipe-concurrent-"))); rmSync(root, { recursive: true, force: true }); }
	}
	console.log(`结果：PASS ${passed} / FAIL ${failed}`);
	if (failed) process.exitCode = 1;
}
