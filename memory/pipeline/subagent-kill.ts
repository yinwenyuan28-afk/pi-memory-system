// 停掉子代理 + 杀后一致性修复（2026-09-26，SUBAGENT_LIVENESS_FIX 的 T2 第 4–6 步）
//
// 用户裁定：到达硬上限（默认 30 分钟）**直接停掉子代理**，前提是数据安全。本文件承担"杀"与"修复"。
//
// ── 为什么"停下它"不丢数据（配合 stop-request 的"先拦"）──────────────
//   ① 写本身原子：`atomicWrite` = 写临时文件 + `renameSync`（`memory/l2/commit-tool.ts`）；
//      L3 的提议稿 `USER-temp.md` 同款，且每轮首次写盘前备份到 `backups/user-backups/` ⇒ 不会
//      出现半个坏文件（live `USER.md` 自 2026-09-28 起 L3 压根不写，见 `memory/l3/user-file.ts`）。
//   ② `consolidate` 的顺序是"先写目标、再删源"（代码注释明说是为此刻意排序）⇒ 被杀最多
//      "目标已写、源未删" = 内容重复，不是丢失。
//   ③ 游标随 commit 推进 ⇒ 未提交 = 游标不动 = **下一轮重做**（"重做"而非"丢内容"）。
//
// ── 为什么先拦再杀 ─────────────────────────────────────────────
//   Windows 上进程没有可捕获的优雅信号（`SIGTERM` 即 TerminateProcess），所以"体面停下"只能靠
//   `stop-request` 标记让写工具在**入口**拒写，把被杀点推到操作边界。本文件负责剩下的部分。
//
// ── 为什么"杀不确认就不修复" ────────────────────────────────────
//   修复要写盘（截断分片、重建索引）。若旧子代理可能还活着，修复本身就是第二个写者 ⇒
//   只在**确认 pid 已死**后才修复；确认不了就交给调用方"持有该层"（见 failure-state 的 holdUntil）。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_DIR, L1_RECORDS_DIR, L2_CURSOR_FILE, L2_SCENE_DIR, L3_CURSOR_FILE, MEMORY_DB_DIR } from "../paths.ts";
import { clearStopRequest, writeStopRequest } from "./stop-request.ts";
import { readSubagentRun } from "./subagent-runs.ts";
import { forceReleaseRunLock, isProcessAlive } from "./run-lock.ts";
import { DEFAULT_HOLD_MS_UNCONFIRMED, DEFAULT_KILL_GRACE_MS } from "./timeout-config.ts";
import { forceReleaseWriteLock } from "../l1/write-lock.ts";
import { logEvent } from "../../util/notice.ts";

/**
 * 停止序列要定位的目标——**只需要 pid**（外加一个可选 state 供日志/卡片措辞用）。
 *
 * 2026-10-01 之前这里是 pi-subagents 的 `AsyncRunInfo`（7 字段：asyncDir / runId /
 * state / pid / sessionFiles / …），靠扫它私有的 status.json 拿。自建 spawn 之后 pid
 * 由本扩展 spawn 时就拿到并落在 `subagent-runs.ts` 的运行记录里，其余字段全部无用。
 */
export interface StopTarget {
	pid: number;
	/** 仅用于日志与告警卡措辞（如「已停掉子代理（pid X，state=running）」）。 */
	state?: string;
}

/** 进程存活判定住在 `run-lock.ts`（那里是运行级锁的回收判据）；此处 re-export 保持旧引用可用。 */
export { isProcessAlive };

/**
 * 停止序列的宽限期默认值（可用配置中心 `subagent.killGraceMs` 覆盖）。
 * 给"正在进行的单次工具调用"收尾的时间 —— 一次 `l2_commit` 实际落盘 < 1 秒。
 */
export const KILL_GRACE_MS = DEFAULT_KILL_GRACE_MS;

/**
 * "停不下来"时持有该层的时长默认值（可用配置中心 `subagent.holdMsUnconfirmed` 覆盖）。
 *
 * 只在**无法确认进程已死**时使用：那种情况下放新 job 进去会变成两个写者改同一批场景块。
 * 确认已死的情形**不持有** —— 该层立刻可跑（这正是"直接停掉"换来的收益）。
 */
export const HOLD_MS_UNCONFIRMED = DEFAULT_HOLD_MS_UNCONFIRMED;

/** 杀进程树：Windows 用 `taskkill /T /F`（`/T` 连嵌套子进程，`fanout-child` 之类的孙进程一并带走）。 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 });
		} catch {
			// 可能已经退出了 —— 由调用方 isProcessAlive 复核
		}
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// 同上
	}
}

export interface RepairReport {
	/** 清掉的孤儿临时文件数（`scene-blocks/.tmp_scene_*`）。 */
	orphanTemps: number;
	/** 清掉的半成品合并备份目录数（无 `_manifest.json` 的 `l2-consolidate-*`）。 */
	incompleteBackups: number;
	/** 是否修了 L1 分片尾部（残行截断 / 补换行）。 */
	tornTailRepaired: boolean;
	/** 是否按 pid 清了 L1 写锁。 */
	lockCleared: boolean;
	/** 被清掉的**运行级锁**层名（2026-09-26 新增；`["l1"]` / `["l2"]` …）。 */
	runLocksCleared: string[];
	/** 被重置的游标（相对路径）。 */
	cursorsReset: string[];
	/** 由调用方钩子完成的重建（场景索引 / 成员 sidecar）。 */
	indexRebuilt: boolean;
	membersRepaired: boolean;
}

/**
 * 杀后修复的**场景侧**钩子。
 *
 * 为什么用钩子而不是直接 import：`memory/l2/commit-tool.ts` 已经 import 了 `pipeline/jobs-db.ts`，
 * pipeline 再反向 import 它就成了依赖环。所以由调用方（`memory/l2/index.ts`，它本来就依赖两侧）注入。
 */
export interface KillRepairHooks {
	rebuildSceneIndex?: (profilePath: string) => void;
	repairSceneMembers?: (profilePath: string) => void;
}

function cleanOrphanTemps(profilePath: string): number {
	const sceneDir = join(profilePath, MEMORY_DB_DIR, L2_SCENE_DIR);
	let n = 0;
	try {
		for (const f of readdirSync(sceneDir)) {
			if (!f.startsWith(".tmp_scene_")) continue;
			try {
				rmSync(join(sceneDir, f), { force: true });
				n++;
			} catch {
				// 忽略
			}
		}
	} catch {
		// 目录不存在
	}
	return n;
}

function cleanIncompleteBackups(profilePath: string): number {
	const backupDir = join(profilePath, MEMORY_DB_DIR, BACKUP_DIR);
	let n = 0;
	try {
		for (const d of readdirSync(backupDir)) {
			if (!d.startsWith("l2-consolidate-")) continue;
			const dir = join(backupDir, d);
			try {
				if (!statSync(dir).isDirectory()) continue;
				if (existsSync(join(dir, "_manifest.json"))) continue; // 完整备份，保留
				rmSync(dir, { recursive: true, force: true });
				n++;
			} catch {
				// 忽略
			}
		}
	} catch {
		// 目录不存在
	}
	return n;
}

/**
 * 修 L1 分片尾部。两种情形：
 *   · 最后一个分片**不以换行结尾** → 补一个换行。理由不是洁癖：下次 `append` 会直接接在最后一行后面，
 *     "完整记录 + 下一条记录"粘成一行后两条都无法解析（读侧逐行 parse），**连坐毁掉两条**。
 *   · 最后一行本身不是合法 JSON（写到一半被杀）→ 截断它。那条记录会被重新抽取（游标没推进，重做安全）。
 */
function repairTornTail(profilePath: string): boolean {
	const dir = join(profilePath, MEMORY_DB_DIR, L1_RECORDS_DIR);
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort();
	} catch {
		return false;
	}
	const newest = files[files.length - 1];
	if (!newest) return false;
	const p = join(dir, newest);
	let text: string;
	try {
		text = readFileSync(p, "utf-8");
	} catch {
		return false;
	}
	if (!text || text.endsWith("\n")) return false;
	const lastNl = text.lastIndexOf("\n");
	const tail = text.slice(lastNl + 1);
	let parses = false;
	try {
		JSON.parse(tail);
		parses = true;
	} catch {
		parses = false;
	}
	try {
		if (parses) {
			writeFileSync(p, `${text}\n`, "utf-8");
			return true;
		}
		writeFileSync(p, lastNl >= 0 ? text.slice(0, lastNl + 1) : "", "utf-8");
		return true;
	} catch {
		return false;
	}
}

/** 校验游标可解析；坏则删除（loader 会退回空游标 ⇒ 重做，方向安全）。 */
function validateCursor(profilePath: string, relPath: string): boolean {
	const p = join(profilePath, MEMORY_DB_DIR, relPath);
	if (!existsSync(p)) return false;
	try {
		JSON.parse(readFileSync(p, "utf-8"));
		return false;
	} catch {
		try {
			rmSync(p, { force: true });
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * 杀后修复（5a–5f）。**只在确认 pid 已死之后调用**（见文件头）。
 * 逐项 logEvent，并返回报告供卡片/日志展示。
 *
 * @param killedPid 被杀的进程 pid（传入时运行级锁/写锁只要"正是它持有"就直接清）
 */
export function repairAfterKill(profilePath: string, hooks: KillRepairHooks = {}, killedPid?: number): RepairReport {
	const orphanTemps = cleanOrphanTemps(profilePath);
	const incompleteBackups = cleanIncompleteBackups(profilePath);
	const tornTailRepaired = repairTornTail(profilePath);
	const lockCleared = forceReleaseWriteLock(profilePath, killedPid);
	const runLocksCleared = forceReleaseRunLock(profilePath, undefined, killedPid);
	const cursorsReset: string[] = [];
	if (validateCursor(profilePath, L2_CURSOR_FILE)) cursorsReset.push(L2_CURSOR_FILE);
	if (validateCursor(profilePath, L3_CURSOR_FILE)) cursorsReset.push(L3_CURSOR_FILE);

	let indexRebuilt = false;
	if (hooks.rebuildSceneIndex) {
		try {
			hooks.rebuildSceneIndex(profilePath);
			indexRebuilt = true;
		} catch (err) {
			logEvent("pipeline", `杀后修复：重建场景索引失败 ${err instanceof Error ? err.message : String(err)}`, profilePath);
		}
	}
	let membersRepaired = false;
	if (hooks.repairSceneMembers) {
		try {
			hooks.repairSceneMembers(profilePath);
			membersRepaired = true;
		} catch (err) {
			logEvent("pipeline", `杀后修复：补成员 sidecar 失败 ${err instanceof Error ? err.message : String(err)}`, profilePath);
		}
	}

	const report: RepairReport = {
		orphanTemps,
		incompleteBackups,
		tornTailRepaired,
		lockCleared,
		runLocksCleared,
		cursorsReset,
		indexRebuilt,
		membersRepaired,
	};
	logEvent(
		"pipeline",
		`杀后修复：孤儿临时文件 ${orphanTemps} / 半成品备份 ${incompleteBackups} / 分片尾 ${tornTailRepaired ? "已修" : "无"} /` +
			`写锁 ${lockCleared ? "已清" : "未动"} / 运行级锁 ${runLocksCleared.length > 0 ? `已清 ${runLocksCleared.join(",")}` : "未动"} /` +
			`游标重置 ${cursorsReset.length} / 索引 ${indexRebuilt ? "已重建" : "跳过"} / 成员 ${membersRepaired ? "已补" : "跳过"}`,
		profilePath,
	);
	return report;
}

export interface StopSubagentOptions {
	profilePath: string;
	layer: "l1" | "l2" | "l3";
	jobId: number;
	reason: string;
	/** 父会话文件（本扩展所在会话）—— 用来把 async run 认到自己的 job 上。 */
	parentSessionFile?: string;
	graceMs?: number;
	hooks?: KillRepairHooks;
	/** 注入 sleep（离线测用）。 */
	sleep?: (ms: number) => Promise<void>;
	/** 注入"找停止目标"（离线测用：测试注入假 pid 才不会误杀真进程）。默认读本扩展自己的运行记录。 */
	findRun?: () => StopTarget | undefined;
	/** 跳过标记/宽限（手动命令用："我已经确定它卡了"）。 */
	skipGrace?: boolean;
}

export interface StopSubagentOutcome {
	runInfo?: StopTarget;
	pid?: number;
	killAttempted: boolean;
	/** true = 已确认进程不存在（可以立即放行该层）；false = 停不下来（调用方应持有该层）。 */
	killConfirmed: boolean;
	repaired?: RepairReport;
	/** 给日志/卡片的一句话。 */
	note: string;
}

/**
 * 停止序列（T2 第 1–6 步的 1/3/4/5 部分；写 job 状态由调用方负责）。
 *
 *   ① 落停止标记（先拦：让写工具入口开始拒写）
 *   ② 定位 async run（`status.json`）→ 取 pid
 *   ③ 宽限 `graceMs`（让进行中的单次调用收尾）
 *   ④ 杀进程树 → 复核 `isProcessAlive`
 *   ⑤ **确认已死**才做杀后修复；确认不了**保留停止标记**（别让残留写者继续写）并交给调用方持有该层
 *   ⑥ 确认已死 → 清停止标记（否则下次运行会全被拒写）
 */
export async function stopSubagent(opts: StopSubagentOptions): Promise<StopSubagentOutcome> {
	const { profilePath, layer, jobId, reason } = opts;
	const graceMs = opts.graceMs ?? KILL_GRACE_MS;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	writeStopRequest(profilePath, layer, jobId, reason);
	// 自建 spawn：pid 落在我们自己的运行记录里（spawn 时写、job 收尾时删）。
	// 找不到记录通常意味着「派发从未成功」或「记录已被清」——两种都不该有活着的子进程。
	const findRun = opts.findRun ?? (() => {
		const rec = readSubagentRun(profilePath, layer, jobId);
		return rec ? { pid: rec.pid, state: "running" } : undefined;
	});
	const runInfo = findRun();
	const pid = runInfo?.pid;
	if (!runInfo) {
		logEvent(
			"pipeline",
			`job ${jobId} 停止序列：没找到本扩展的子代理运行记录（无法取 pid；` +
			`通常意味着派发就没成功或记录已清理）`,
			profilePath,
		);
	}
	if (!opts.skipGrace) await sleep(graceMs);

	let killAttempted = false;
	let killConfirmed = false;
	if (pid !== undefined) {
		killAttempted = true;
		killProcessTree(pid);
		killConfirmed = !isProcessAlive(pid);
		if (!killConfirmed) {
			// 再试一次（taskkill 偶发失败），仍不确认就如实上报
			killProcessTree(pid);
			killConfirmed = !isProcessAlive(pid);
		}
	}

	let repaired: RepairReport | undefined;
	if (killConfirmed) {
		// 确认已死 → 修复 → 清标记（顺序不能反：标记要先于"放行该层"消失，
		// 但修复期间还希望写工具保持拒写状态，所以修复放中间）
		repaired = repairAfterKill(profilePath, opts.hooks, pid);
		clearStopRequest(profilePath, layer);
	}

	const note = killConfirmed
		? `已停掉子代理（pid ${pid}，state=${runInfo?.state ?? "未知"}）并完成杀后修复`
		: pid === undefined
			? `未能取得子代理 pid ⇒ 无法停掉；已保留停止标记（写工具继续拒写）`
			: `杀进程后仍检测到 pid ${pid} 存活 ⇒ 未能确认停止；已保留停止标记`;
	logEvent("pipeline", `job ${jobId} 停止序列：${note}`, profilePath);
	logEvent(
		"pipeline",
		`job ${jobId} 停止序列明细：grace=${opts.skipGrace ? 0 : graceMs}ms / pid=${pid ?? "无"} / 修复=${repaired ? "已做" : "跳过"}`,
		profilePath,
	);
	return { runInfo, pid, killAttempted, killConfirmed, repaired, note };
}
