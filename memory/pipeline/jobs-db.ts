import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { MEMORY_DB_DIR, PIPELINE_JOBS_FILE } from "../paths.ts";

export type PipelineJobType = "l1" | "l2" | "l3";
/**
 * `drain` = L1 收尾后因「L0 仍有积压」而连续排的下一批（2026-09-19）。
 * `trigger` = L3 的台账式触发（`agent_settled` 五级门控命中）或子代理 `personaSignal`。
 */
export type PipelineJobSource = "interval" | "manual" | "l1_commit" | "drain" | "trigger";
export type PipelineJobStatus = "queued" | "running" | "done" | "skipped" | "failed";

/** recoverStuckRunning 只回收 started_at 早于该阈值的 running（防子进程误杀刚启动的 job）。 */
export const PIPELINE_RECOVER_MIN_AGE_MS = 10 * 60 * 1000;

export interface PipelineJob {
	id: number;
	type: PipelineJobType;
	source: PipelineJobSource;
	status: PipelineJobStatus;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	error: string | null;
}

export interface EnqueueResult {
	id: number;
	duplicate: boolean;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  source      TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_id ON jobs(status, id);
`;

interface Row {
	id: number;
	type: string;
	source: string;
	status: string;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	error: string | null;
}

function mapRow(r: Row): PipelineJob {
	return {
		id: r.id,
		type: r.type as PipelineJobType,
		source: r.source as PipelineJobSource,
		status: r.status as PipelineJobStatus,
		createdAt: r.created_at,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		error: r.error,
	};
}

/**
 * L1/L2/L3 流水线队列（node:sqlite）。
 * 主进程 worker 与子代理进程（l1_commit / l2_commit / l3_commit）都会打开同一文件；WAL + busy_timeout 防并发写。
 * L3 自 2026-09-19 起也走这里（此前只有 L1/L2，L3 用 `l3/run.lock` 自己单飞）。
 */
export class PipelineJobsDB {
	private db: DatabaseSync;
	readonly dbPath: string;

	constructor(profilePath: string) {
		const memDir = join(profilePath, MEMORY_DB_DIR);
		mkdirSync(memDir, { recursive: true });
		this.dbPath = join(memDir, PIPELINE_JOBS_FILE);
		// 建到**文件所在目录**（PIPELINE_JOBS_FILE 是多段相对路径 `pipeline/jobs.sqlite`）：
		// 只建 memoryDB/ 的话，全新 profile 会 "unable to open database file"
		//（生产 profile 里 pipeline/ 恰好已存在，所以这个缺口一直没暴露）
		mkdirSync(dirname(this.dbPath), { recursive: true });
		this.db = new DatabaseSync(this.dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec(SCHEMA_SQL);
	}

	/** 已有同 type 的 queued 则不插入；running 也视为 duplicate（不堆第二条）。 */
	enqueue(type: PipelineJobType, source: PipelineJobSource): EnqueueResult {
		const existing = this.db
			.prepare("SELECT * FROM jobs WHERE type = ? AND status IN ('queued', 'running') ORDER BY id ASC LIMIT 1")
			.get(type) as Row | undefined;
		if (existing) return { id: existing.id, duplicate: true };

		const now = new Date().toISOString();
		const info = this.db.prepare("INSERT INTO jobs (type, source, status, created_at) VALUES (?, ?, 'queued', ?)").run(type, source, now);
		return { id: Number(info.lastInsertRowid), duplicate: false };
	}

	peekNext(): PipelineJob | undefined {
		// L3 永远排最后（2026-09-19 并入串行执行器时定）：L3 的输入是 L1/L2 的产物
		// （场景块），让它在 L1 还在啃 L0 积压、L2 还没组织场景时就插队跑，既浪费一次
		// 子代理，也会基于半成品画像。同 id 序里其它 type 一律优先于 l3。
		const row = this.db
			.prepare(
				"SELECT * FROM jobs WHERE status = 'queued' ORDER BY CASE type WHEN 'l3' THEN 1 ELSE 0 END ASC, id ASC LIMIT 1",
			)
			.get() as Row | undefined;
		return row ? mapRow(row) : undefined;
	}

	/** queued → running；id 已被别人 claim 则返回 undefined。 */
	claim(id: number): PipelineJob | undefined {
		const now = new Date().toISOString();
		const info = this.db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(now, id);
		if (info.changes !== 1) return undefined;
		return this.getJob(id);
	}

	getJob(id: number): PipelineJob | undefined {
		const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
		return row ? mapRow(row) : undefined;
	}

	/** 当前 queued 的全部 job（按 peekNext 的优先级排序；观测/回归用）。 */
	listQueued(): PipelineJob[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM jobs WHERE status = 'queued' ORDER BY CASE type WHEN 'l3' THEN 1 ELSE 0 END ASC, id ASC",
			)
			.all() as Row[];
		return rows.map(mapRow);
	}

	hasActive(type: PipelineJobType): boolean {
		const row = this.db.prepare("SELECT 1 AS n FROM jobs WHERE type = ? AND status IN ('queued', 'running') LIMIT 1").get(type) as
			| { n: number }
			| undefined;
		return Boolean(row);
	}

	complete(id: number, status: "done" | "skipped" | "failed", error?: string): void {
		const now = new Date().toISOString();
		this.db
			.prepare("UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status IN ('queued', 'running')")
			.run(status, now, error ?? null, id);
	}

	/** l1_commit：把当前 running 的 l1 标 done（没有也不抛错）。 */
	completeRunningL1(): number {
		return this.completeRunning("l1");
	}

	/**
	 * l2_commit：把当前 running 的 l2 标 done。
	 *
	 * 为什么 L2 也需要它：`runPiSubagent` 是 async:true（派发后毫秒级返回），所以
	 * `l2/index.ts` 里 `await runPiSubagent(...)` 之后紧接着读游标**必然还没推进** ——
	 * 旧代码据此就把 job 标 done，于是任务在 0 秒"完成"、队列以为空闲、立刻又 claim 下一条
	 * → 2026-09-19 实测两个 L2 子代理并发改同一批场景块（与 L3 那次并发同源）。
	 * 真完成信号只能由子代理自己写：它提交成功时调这个方法。
	 */
	completeRunningL2(): number {
		return this.completeRunning("l2");
	}

	/**
	 * l3_commit：把当前 running 的 l3 标 done。
	 *
	 * 与 L2 同源：`runPiSubagent` 是 async:true（派发后毫秒级返回），所以"派发完就读游标"
	 * 必然还是旧值。L3 并入队列后，唯一可信的完成信号就是子代理自己提交时调的这一个
	 * （取代了此前的 `l3/run.lock` + 主进程观察游标那一套，见 §11.11）。
	 */
	completeRunningL3(): number {
		return this.completeRunning("l3");
	}

	/**
	 * 把当前 running 的指定层标 done（子代理提交成功时调用；没有匹配行返回 0）。
	 */
	completeRunning(type: PipelineJobType): number {
		const now = new Date().toISOString();
		const info = this.db
			.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE type = ? AND status = 'running'")
			.run(now, type);
		return Number(info.changes);
	}

	/**
	 * 是否有**任何** job 处于 running（跨层、跨进程）。
	 *
	 * 用途：串行执行器 claim 下一个 job 前先看它。`peekNext()` 只挑 `queued`，
	 * 所以两个 pi 进程同时开着时各自都能 claim 走一条 queued → 两个子代理并发。
	 * 有这个判断后，"同一时刻只有一个 L1/L2/L3 子代理"才在**全局**成立，而不只是单进程内。
	 */
	hasAnyRunning(): boolean {
		const row = this.db.prepare("SELECT 1 AS n FROM jobs WHERE status = 'running' LIMIT 1").get() as
			| { n: number }
			| undefined;
		return Boolean(row);
	}

	/**
	 * l1_commit：认领「超时误判」的 l1 job —— 把最近被标 failed 的超时 job 纠正为 done。
	 *
	 * 背景（2026-09-15 实测）：子代理实际耗时可达 561s，曾远超 SUBAGENT_TIMEOUT_MS（当时 180s，现已调为 600s）。
	 * executeJob 等满超时后把 job 标 failed，但**不杀子进程**（abort 只 reject 主进程的
	 * wait promise）；子代理随后仍正常调用 l1_commit。此时：
	 *   - completeRunningL1() 的 `status='running'` 匹配不到（job 已 failed）→ 空操作；
	 *   - l1/index.ts 的计数重置分支（`after.status==='done'`）在此场景永远进不去
	 *     → consecutiveFailures 只增不减，累计 3 次即熔断，自动提取停摆。
	 *
	 * 本方法给晚到的提交一个纠正机会：只认领**最近 N 分钟内**、error 恰为超时文案的
	 * failed l1 job，避免把真正的失败（如 recovered / 其他错误）洗成成功。
	 *
	 * @param withinMs 只认领 finished_at 在此时长内的 failed job（默认 15 分钟）
	 * @returns 被纠正的 job 数
	 */
	reclaimTimedOutL1(withinMs = 15 * 60_000): number {
		const now = new Date();
		const cutoff = new Date(now.getTime() - withinMs).toISOString();
		const info = this.db
			.prepare(
				`UPDATE jobs SET status = 'done', finished_at = ?, error = NULL
				 WHERE type = 'l1' AND status = 'failed'
				   AND error = 'timeout without l1_commit'
				   AND finished_at IS NOT NULL AND finished_at >= ?`,
			)
			.run(now.toISOString(), cutoff);
		return Number(info.changes);
	}

	/** 进程重启：只回收「足够旧」的 running，避免 L1 子进程 session_start 误杀刚 spawn 的 job。 */
	recoverStuckRunning(minAgeMs = PIPELINE_RECOVER_MIN_AGE_MS): number {
		const cutoff = Date.now() - minAgeMs;
		const rows = this.db.prepare("SELECT * FROM jobs WHERE status = 'running'").all() as Row[];
		const finishedAt = new Date().toISOString();
		let n = 0;
		const upd = this.db.prepare(
			"UPDATE jobs SET status = 'failed', finished_at = ?, error = 'recovered: leftover running' WHERE id = ? AND status = 'running'",
		);
		for (const r of rows) {
			const started = r.started_at ? Date.parse(r.started_at) : NaN;
			if (Number.isFinite(started) && started > cutoff) continue;
			if (upd.run(finishedAt, r.id).changes === 1) n++;
		}
		return n;
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// already closed
		}
	}
}

const instances = new Map<string, PipelineJobsDB>();

export function getPipelineJobsDB(profilePath?: string): PipelineJobsDB {
	const p = profilePath ?? process.env.PI_PROFILE_PATH ?? "";
	if (!p) throw new Error("PipelineJobsDB: profilePath 未提供且 PI_PROFILE_PATH 未设置");
	let db = instances.get(p);
	if (!db) {
		db = new PipelineJobsDB(p);
		instances.set(p, db);
	}
	return db;
}

export function closePipelineJobsDB(profilePath?: string): void {
	const p = profilePath ?? process.env.PI_PROFILE_PATH ?? "";
	const db = instances.get(p);
	if (db) {
		db.close();
		instances.delete(p);
	}
}
