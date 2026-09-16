/**
 * L3 单飞锁与"运行结局"判定（跨进程、跨 /reload）。
 *
 * ── 为什么需要这两样（2026-09-16 实测事故）──────────────────────────
 *
 * `runPiSubagent` 是 async:true 的 fire-and-forget：**派发后立刻 resolve**，不等子代理做完
 * （实测子代理跑 56–118s，promise 毫秒级返回）。第一版实现把两件事都建在这个 promise 上，
 * 于是同时错了两次：
 *
 *   1. 互斥失效 —— `finally { scheduled = false }` 在 spawn 后毫秒级执行，闸门等于没有；
 *      而游标要等子代理**真提交**才推进，所以 P4 条件一直成立 ⇒ 每一轮 `agent_settled`
 *      都会再派一个。实测一窗口内派出了 **3 个并发 L3 子代理**，同时改同一份 USER.md。
 *   2. 结算错位 —— spawn 后立刻读游标必然"还没提交"，于是**每次启动都记一次失败**，
 *      连最终成功的运行也照记 ⇒ 3 次就误熔断（把好运行也停掉）。
 *
 * 修正后的模型：**锁在派发前落盘，结局由"观察"决定** ——
 *   派发 → 锁 {deadlineAt = now + TTL} → 之后每次 agent_settled 观察一次：
 *     · 游标 lastCommittedAt 推进了            → success（释放锁）
 *     · 超过 deadlineAt 仍未推进               → failure（释放锁，并 abort 掉挂死的子代理）
 *     · 其余                                   → running（继续等，期间不再派新的一轮）
 *
 * 这里的两个函数刻意拆成**纯函数**（`runLockState` / `evaluateRunOutcome`），
 * 好让回归直接测"promise 返回 ≠ 完成"这条最容易写错的语义。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { L3_RUN_LOCK_FILE, MEMORY_DB_DIR } from "../paths.ts";

export interface L3RunLock {
	/** 本轮唯一 id（释放时校验，避免误释放别人的锁）。 */
	runId: string;
	/** 锁写入时刻（ISO）。 */
	startedAt: string;
	/** 锁过期时刻（ISO）；超过即视为"子代理已死/挂死"，可被下一轮抢占。 */
	deadlineAt: string;
	/** 触发原因（可观测：为什么起了这一轮）。 */
	reason: string;
}

export type RunLockState = "none" | "running" | "stale";
export type RunOutcome = "running" | "success" | "failure";

function lockPath(profilePath: string): string {
	return join(profilePath, MEMORY_DB_DIR, L3_RUN_LOCK_FILE);
}

/** 读锁；无锁或损坏 → undefined。 */
export function readRunLock(profilePath: string): L3RunLock | undefined {
	const p = lockPath(profilePath);
	if (!existsSync(p)) return undefined;
	try {
		const d = JSON.parse(readFileSync(p, "utf-8")) as Partial<L3RunLock>;
		if (typeof d?.runId !== "string" || typeof d?.deadlineAt !== "string") return undefined;
		return {
			runId: d.runId,
			startedAt: typeof d.startedAt === "string" ? d.startedAt : "",
			deadlineAt: d.deadlineAt,
			reason: typeof d.reason === "string" ? d.reason : "",
		};
	} catch {
		return undefined;
	}
}

/**
 * 纯函数：锁当前状态。
 * `nowMs` 显式传入（不取 Date.now()）——让"过期"判定可测。
 */
export function runLockState(lock: L3RunLock | undefined, nowMs: number): RunLockState {
	if (!lock) return "none";
	const deadline = new Date(lock.deadlineAt).getTime();
	if (Number.isNaN(deadline)) return "stale";
	return nowMs < deadline ? "running" : "stale";
}

/** 剩余毫秒（负数/无锁 → 0；供日志与提示用）。 */
export function runLockRemainingMs(lock: L3RunLock | undefined, nowMs: number): number {
	if (!lock) return 0;
	const deadline = new Date(lock.deadlineAt).getTime();
	if (Number.isNaN(deadline)) return 0;
	return Math.max(0, deadline - nowMs);
}

/**
 * 尝试占锁。**只有 `none` / `stale` 能占到**；已有 `running` 锁 → 返回 undefined（拒绝派发）。
 * 占锁即写盘（先到先得；`runId` 用于后续释放校验）。
 */
export function acquireRunLock(
	profilePath: string,
	opts: { runId: string; reason: string; ttlMs: number; nowMs: number },
): L3RunLock | undefined {
	const existing = readRunLock(profilePath);
	if (runLockState(existing, opts.nowMs) === "running") return undefined;

	const lock: L3RunLock = {
		runId: opts.runId,
		startedAt: new Date(opts.nowMs).toISOString(),
		deadlineAt: new Date(opts.nowMs + opts.ttlMs).toISOString(),
		reason: opts.reason,
	};
	const p = lockPath(profilePath);
	try {
		const dir = join(p, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(p, JSON.stringify(lock, null, 2), "utf-8");
	} catch {
		// 锁写不进去就**不放行**：宁可少跑一轮，也不要并发改 USER.md
		return undefined;
	}
	return lock;
}

/** 释放锁。传 runId 时只有持有者能释放（防误释放别人刚抢到的锁）。 */
export function releaseRunLock(profilePath: string, runId?: string): void {
	const p = lockPath(profilePath);
	if (!existsSync(p)) return;
	if (runId !== undefined) {
		const cur = readRunLock(profilePath);
		if (cur && cur.runId !== runId) return;
	}
	try {
		rmSync(p, { force: true });
	} catch {
		// ignore
	}
}

/**
 * 纯函数：本轮跑成什么样了。
 *
 * **关键语义：`runPiSubagent` 返回 ≠ 完成。** 唯一可信的完成信号是子代理自己写的游标
 * （`l3_commit` 里的 `lastCommittedAt`）。所以这里只看游标有没有推进，不看 promise。
 */
export function evaluateRunOutcome(input: {
	committedBefore: string;
	committedAfter: string;
	deadlineAt: string;
	nowMs: number;
}): RunOutcome {
	if (input.committedAfter && input.committedAfter !== input.committedBefore) return "success";
	const deadline = new Date(input.deadlineAt).getTime();
	if (!Number.isNaN(deadline) && input.nowMs >= deadline) return "failure";
	return "running";
}
