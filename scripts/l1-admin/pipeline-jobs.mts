// pipeline-jobs.mts —— 只读转储 `pipeline/jobs.sqlite`（查看器「流水线」页的取数口）
//
// ── 为什么单独一个脚本、而不是复用 `memory/pipeline/jobs-db.ts` 的 PipelineJobsDB ──
//
// 那个类的**构造函数本身就是写动作**：mkdir + `PRAGMA journal_mode = WAL` + 建表。
// 对一个"看一眼队列"的只读端点来说这些都越界了 —— 在全新 profile 上它会凭空造出一个
// 空 jobs.sqlite，把"从未跑过流水线"变成"有一个空库"（两种事实，不该被工具抹平）。
// 所以这里用 `node:sqlite` 的 `readOnly` 打开。
//
// 实测（Node 24.17 / 2026-10-08，本机）：**主进程持写锁时只读打开仍能读** ——
// WAL 模式下读者不阻塞写者，只读连接的落点正是"pi 正在跑时看队列"这条主用途，
// 所以这条路可行；失败一律当失败报（不静默回空队列，那会把"读不到"说成"没有任务"）。
//
// ── 队列口径（谁下一个跑）──────────────────────────────────────────────
//
// 复刻 `memory/pipeline/jobs-db.ts` 的 `listQueued()`：`ORDER BY CASE type WHEN 'l3' THEN 1
// ELSE 0 END ASC, id ASC` —— L3 永远排在最后，其余按入队序。这是**展示口径**，
// 它必须与真正的认领逻辑一致，否则页面会指着一条根本轮不到的任务说"下一个是它"。
// 那边改了这里要同步改（两处都写了这条注释，便于 grep）。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/pipeline-jobs.mts [--limit 40] [--profile <dir>]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_DB_DIR, PIPELINE_JOBS_FILE } from "../../memory/paths.ts";
import { finish, flagValue, profileArg, run, usageError } from "./viewer-cli.mts";

const USAGE = "node --experimental-strip-types scripts/l1-admin/pipeline-jobs.mts [--limit 40] [--profile <dir>]";

/** 已结束任务回看的默认条数（队列本身不限量：queued 通常只有个位数）。 */
const DEFAULT_LIMIT = 40;
/** 上限：别让一个手滑的 --limit 把整张表拉进响应里。 */
const MAX_LIMIT = 200;

/** 五个状态必须是闭集：页面按状态上色，出现第六种就会渲染成"未知"。 */
const STATUSES = ["queued", "running", "done", "skipped", "failed"] as const;

/** jobs 表的一行（列名与 SCHEMA_SQL 一致；sqlite 给的是 snake_case）。 */
interface JobRow {
	id: number;
	type: string;
	source: string;
	status: string;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	error: string | null;
}

/** 行 → 界面口径的 job（camelCase；与 /api/subagent-runs 的字段风格一致）。 */
function mapJob(r: JobRow): Record<string, unknown> {
	return {
		id: r.id,
		type: r.type,
		source: r.source,
		status: r.status,
		createdAt: r.created_at,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		error: r.error,
	};
}

run(() => {
	const profilePath = profileArg();
	if (!profilePath) usageError(USAGE);

	const limitRaw = Number(flagValue("--limit"));
	const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.round(limitRaw)) : DEFAULT_LIMIT;

	const abs = join(profilePath, MEMORY_DB_DIR, PIPELINE_JOBS_FILE);
	// 展示用相对路径统一正斜杠：Windows 的 join 会给出 `pipeline\jobs.sqlite`，混在界面里很难看
	const relPath = `${MEMORY_DB_DIR}/${PIPELINE_JOBS_FILE.split(/[\\/]/).join("/")}`;
	const zeroCounts: Record<string, number> = { queued: 0, running: 0, done: 0, skipped: 0, failed: 0, total: 0 };

	// 库还不存在 = 这台机器从未跑过流水线。这是**正常态**（不是错误），用 exists:false 表达。
	if (!existsSync(abs)) {
		finish({
			success: true,
			exists: false,
			path: relPath,
			limit,
			counts: zeroCounts,
			queued: [],
			running: [],
			recent: [],
			note: "jobs.sqlite 还不存在：这个 profile 从未跑过流水线（首次提取后才会建库）。",
		});
	}

	let db: DatabaseSync;
	try {
		db = new DatabaseSync(abs, { readOnly: true });
	} catch (e) {
		// 只读打开失败要说清楚：多半是权限或半关闭的 WAL（-shm 缺失且目录不可写）。
		// **不能**退化成空队列 —— 那会把"读不到"说成"没有任务"，正是本项目反复踩的静默失真。
		finish({ success: false, error: `只读打开 ${relPath} 失败：${e instanceof Error ? e.message : String(e)}` });
	}

	try {
		const counts: Record<string, number> = { ...zeroCounts };
		for (const row of db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as Array<{ status: string; n: number }>) {
			if ((STATUSES as readonly string[]).includes(row.status)) counts[row.status] = row.n;
			counts.total += row.n;
		}

		const queued = db
			.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY CASE type WHEN 'l3' THEN 1 ELSE 0 END ASC, id ASC")
			.all() as unknown as JobRow[];
		const running = db.prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY id ASC").all() as unknown as JobRow[];
		// 已结束的按 id 倒序回看：id 是自增的，等于"最近的在前"，不必依赖时间字符串可比
		const recent = db
			.prepare("SELECT * FROM jobs WHERE status NOT IN ('queued', 'running') ORDER BY id DESC LIMIT ?")
			.all(limit) as unknown as JobRow[];

		finish({
			success: true,
			exists: true,
			path: relPath,
			limit,
			counts,
			queued: queued.map(mapJob),
			running: running.map(mapJob),
			recent: recent.map(mapJob),
			// 口径说明一律纯文本（不带 markdown 记号）：页面把它原样摆出来，出现字面 `**` 就是破相
			note:
				"jobs.sqlite 是跨进程的单一队列（主进程 worker 认领、子代理提交时标 done）；" +
				"queued 按认领顺序排列（L3 永远最后）。",
		});
	} finally {
		try {
			db.close();
		} catch {
			/* 关不掉不影响已读到的结论 */
		}
	}
});
