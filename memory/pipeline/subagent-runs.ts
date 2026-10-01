/**
 * memory/pipeline/subagent-runs.ts —— 自建子代理的运行记录（pid ↔ jobId ↔ layer）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 2026-10-01 之前，memory-system 取子代理 pid 的办法是去扫 pi-subagents 的**私有布局**：
 * 临时目录下 `pi-subagents-<scope>/async-subagent-runs/<runId>/status.json` 的 `pid` 字段
 * （`memory/pipeline/subagent-liveness.ts` 的 `findAsyncRun`）。自建 spawn 之后
 * 我们自己 `spawn` 子进程，pid 就在手上，但**主进程重启后内存态全丢**——
 * 没有落盘记录就永远无法清理那些还在跑的孤儿子进程。
 *
 * 所以这里落一份极简的落盘记录：谁（layer / jobId）在什么时候起了哪个 pid。
 * 三处消费：
 *   1. 停止序列（`subagent-kill.ts` 的 `findRun` 注入点）取 pid
 *   2. 主进程 `session_start` 回收残留子进程
 *   3. 手动停子代理命令 `/my-memory:subagent-kill`
 *
 * ── 设计取舍 ────────────────────────────────────────────────────────────────
 * - **单文件一个 run**（`subagent-run-<layer>-<jobId>.json`）而不是一个索引文件：
 *   避免并发写冲突，也避免索引与实际文件不一致。查「某 job 的 pid」是直接算文件名。
 * - **原子写**（tmp + rename）：主进程崩溃时不会留下半截 JSON。
 * - **不记 session 文件路径**：那套定位（`status.json.steps[].sessionFile` +
 *   子会话目录猜测）是纯观测用途，删掉后活性判定已经简化成「墙钟 + jobs.sqlite 状态」。
 * - **记录是「已派发」不是「已完成」**：完成信号由子代理自己调 `l*_commit` 写 jobs.sqlite
 *   （见 `l1/commit-tool.ts:784` 等），与本文件无关。文件在派发时写、job 收尾时删。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR, SUBAGENT_RUN_FILE_PREFIX } from "../paths.ts";

/** 一条运行记录。字段刻意保持最小——够定位 pid 与排查即可，不复制上游的 status.json。 */
export interface SubagentRunRecord {
	/** 哪一层（l1 / l2 / l3 / skill / review）。 */
	layer: string;
	/** 对应 jobs.sqlite 的 job id。 */
	jobId: number;
	/** 子进程 pid——停止与回收的唯一依据。 */
	pid: number;
	/** 本次派发的 runId（自建 uuid，仅用于日志串联与 session 文件命名）。 */
	runId: string;
	/** 子代理名（l1-extractor 等），排查用。 */
	agent: string;
	/** 派发时刻（ISO）。 */
	startedAt: string;
	/** 派发命令的可读摘要（不含完整 task——task 可能含会话内容，不落盘）。 */
	command: string;
	/** 子进程 stdout/stderr 落盘位置。 */
	stdoutPath: string;
	stderrPath: string;
}

function runFile(profilePath: string, layer: string, jobId: number): string {
	return join(profilePath, MEMORY_DB_DIR, `${SUBAGENT_RUN_FILE_PREFIX}${layer}-${jobId}.json`);
}

/**
 * 写一条运行记录（派发成功后立即调用）。
 *
 * @param profilePath profile 根目录
 * @param rec 记录内容（`jobId` 用于文件名）
 */
export function writeSubagentRun(profilePath: string, rec: SubagentRunRecord): void {
	const target = runFile(profilePath, rec.layer, rec.jobId);
	try {
		mkdirSync(join(profilePath, MEMORY_DB_DIR, "state"), { recursive: true });
		// 原子写：先写同目录 tmp 再 rename，避免崩溃留下半截 JSON
		const tmp = `${target}.tmp`;
		writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf-8");
		renameSync(tmp, target);
	} catch {
		// 记录失败不应阻断派发本身——最坏情况是重启后回收不到这个 pid
	}
}

/**
 * 读某个 job 的运行记录。
 *
 * @returns 记录；文件不存在或损坏时返回 undefined（fail-soft，与既有活性检测一致）
 */
export function readSubagentRun(profilePath: string, layer: string, jobId: number): SubagentRunRecord | undefined {
	const p = runFile(profilePath, layer, jobId);
	if (!existsSync(p)) return undefined;
	try {
		const rec = JSON.parse(readFileSync(p, "utf-8")) as SubagentRunRecord;
		return typeof rec?.pid === "number" ? rec : undefined;
	} catch {
		return undefined;
	}
}

/** 删掉某 job 的运行记录（job 收尾时调用，无论成功失败）。 */
export function clearSubagentRun(profilePath: string, layer: string, jobId: number): void {
	try {
		const p = runFile(profilePath, layer, jobId);
		if (existsSync(p)) unlinkSync(p);
	} catch {
		// 忽略：残留记录下次启动会被残留回收逻辑清掉
	}
}

/**
 * 列出该 profile 下**所有**运行记录（主进程重启后回收残留子进程时用）。
 *
 * 只认本模块自己写的文件名（`subagent-run-<layer>-<jobId>.json`），损坏的一律跳过——
 * 宁可漏回收也不要因为一条坏记录让整个扫描抛错。
 */
export function listSubagentRuns(profilePath: string): SubagentRunRecord[] {
	const dir = join(profilePath, MEMORY_DB_DIR, "state");
	if (!existsSync(dir)) return [];
	const out: SubagentRunRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(SUBAGENT_RUN_FILE_PREFIX) || !name.endsWith(".json")) continue;
		try {
			const rec = JSON.parse(readFileSync(join(dir, name), "utf-8")) as SubagentRunRecord;
			if (typeof rec?.pid === "number" && typeof rec?.layer === "string") out.push(rec);
		} catch {
			// 跳过损坏记录
		}
	}
	return out;
}
