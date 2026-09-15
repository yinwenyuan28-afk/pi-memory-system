import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR, PIPELINE_JOBS_FILE } from "../paths.ts";

export type PipelineJobType = "l1" | "l2";
export type PipelineJobSource = "interval" | "manual" | "l1_commit";
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
 * L1/L2 流水线队列（node:sqlite）。
 * 主进程 worker 与 l1-extractor 子进程（l1_commit）都会打开同一文件；WAL + busy_timeout 防并发写。
 */
export class PipelineJobsDB {
	private db: DatabaseSync;
	readonly dbPath: string;

	constructor(profilePath: string) {
		const memDir = join(profilePath, MEMORY_DB_DIR);
		mkdirSync(memDir, { recursive: true });
		this.dbPath = join(memDir, PIPELINE_JOBS_FILE);
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
		const row = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1").get() as Row | undefined;
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
		const now = new Date().toISOString();
		const info = this.db
			.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE type = 'l1' AND status = 'running'")
			.run(now);
		return Number(info.changes);
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
