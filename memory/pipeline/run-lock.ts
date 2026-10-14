// 运行级锁：**谁写谁持锁**（2026-09-26，SUBAGENT_RUN_LOCK）
// 计划：`plan/memory-system/SUBAGENT_RUN_LOCK/`
//
// ── 要解决的问题 ───────────────────────────────────────────────
// job 的 `running` 状态就是"谁在干活"的锁，但它由**监督者代持**：worker claim 后替子代理拿，
// 子代理用"把 job 写成 done"通知释放 —— 于是"何时算结束"由监督者判断，判错就提前放锁。
// 残留洞：`recoverStuckRunning()` 按**年头**回收（10 分钟），pi 被强杀/重启而 detached 子代理
// **还活着在写** ⇒ 新子代理起来，两个写者改同一批文件。
//
// ── 本模块的做法 ───────────────────────────────────────────────
// 让写者自己持锁：`mkdir` 原子占位 + `owner.json`（含 `heartbeatAt` / `expiresAt`）。
// 抢锁判据三层、**确定性优先**（`runLockAcquirable`）：
//   ① 持有者 pid 已不存在      → 抢（秒级回收；确定性）
//   ② 心跳不新鲜（默认 60s）   → 抢（**免疫 pid 复用**）
//   ③ 超过 expiresAt（2×硬上限）→ 抢（兜底；唯一"按时间猜"的一层，所以排最后）
// 持有一整段运行，每 30s 心跳续期（等 LLM 响应时事件循环空闲 ⇒ 续期可靠），
// 正常退出由 `process.on("exit")` 释放；被杀（Windows TerminateProcess 不跑退出钩子）靠 ①②回收。
//
// 与 job 锁**互补**：job 锁管"谁被调度"，本锁管"谁是写者"。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MEMORY_DB_DIR, RUN_LOCK_FILE_PREFIX } from "../paths.ts";
import { loadSubagentTimeouts, type SubagentTimeouts } from "./timeout-config.ts";
import { logEvent } from "../../util/notice.ts";
import { t } from "../../i18n/index.ts";

/** 进程是否还活着（EPERM = 存在但无权限 → 视为存活）。 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface RunLockOwner {
	pid: number;
	layer: string;
	/** 诊断用（子代理不知道自己的 job id 时为 0）。 */
	jobId: number;
	startedAt: number;
	heartbeatAt: number;
	expiresAt: number;
}

/** 抢锁判定的结论（`steal-*` 都表示"可以抢，但要落 warning 便于事后追））。 */
export type AcquireVerdict = "free" | "steal-dead" | "steal-stale-heartbeat" | "steal-expired" | "held";

function finiteMs(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * 这份 owner 记录现在能不能抢？**纯函数**（判据顺序即优先级）。
 *
 * 关于"心跳字段缺失"（老版本写下的记录 / 文件被手工改坏）：
 * 那时无法证明持有者还活着，所以**不放宽**——只有当它同时超过 `expireMs` 时才允许抢，
 * 否则宁可当成"有人持有"（多等，不双写）。
 */
export function runLockAcquirable(input: {
	owner: RunLockOwner | undefined;
	nowMs: number;
	holderAlive: boolean;
	staleHeartbeatMs: number;
	expireMs: number;
}): AcquireVerdict {
	const { owner, nowMs, holderAlive, staleHeartbeatMs, expireMs } = input;
	if (!owner) return "free";
	if (!holderAlive) return "steal-dead";
	const hb = finiteMs(owner.heartbeatAt);
	if (hb === undefined) {
		const started = finiteMs(owner.startedAt);
		return started !== undefined && nowMs - started > expireMs ? "steal-expired" : "held";
	}
	if (nowMs - hb > staleHeartbeatMs) return "steal-stale-heartbeat";
	const expires = finiteMs(owner.expiresAt);
	if (expires !== undefined && nowMs > expires) return "steal-expired";
	return "held";
}

export function runLockDir(profilePath: string, layer: string): string {
	return join(profilePath, MEMORY_DB_DIR, `${RUN_LOCK_FILE_PREFIX}${layer}.lock`);
}

function ownerPath(profilePath: string, layer: string): string {
	return join(runLockDir(profilePath, layer), "owner.json");
}

/** 读 owner（损坏/缺失 → undefined）。 */
export function readRunLockOwner(profilePath: string, layer: string): RunLockOwner | undefined {
	const p = ownerPath(profilePath, layer);
	if (!existsSync(p)) return undefined;
	try {
		const d = JSON.parse(readFileSync(p, "utf-8")) as Partial<RunLockOwner>;
		const pid = finiteMs(d?.pid);
		if (pid === undefined) return undefined;
		return {
			pid,
			layer: typeof d.layer === "string" ? d.layer : layer,
			jobId: Number(d.jobId) || 0,
			startedAt: Number(d.startedAt) || 0,
			heartbeatAt: Number(d.heartbeatAt) || 0,
			expiresAt: Number(d.expiresAt) || 0,
		};
	} catch {
		return undefined;
	}
}

export interface RunLockHandle {
	layer: string;
	acquired: boolean;
	verdict: AcquireVerdict;
	owner?: RunLockOwner;
	release: () => void;
}

/** 进程内单例：同一子代理进程多次提交复用同一把锁。 */
const heldLocks = new Map<string, RunLockHandle>();
let exitHookRegistered = false;

/** 释放本进程持有的全部运行级锁（退出钩子与测试都用它）。 */
export function releaseAllRunLocks(): void {
	for (const h of [...heldLocks.values()]) h.release();
}

/**
 * 注册退出钩子（幂等）。**只在真正抢到锁的进程里注册** ⇒ 实际就是子代理进程。
 * 被杀时（Windows TerminateProcess）钩子不跑，那正是 ①② 两层回收存在的原因。
 */
export function registerRunLockExitHook(): boolean {
	if (exitHookRegistered) return false;
	exitHookRegistered = true;
	try {
		process.on("exit", () => releaseAllRunLocks());
	} catch {
		exitHookRegistered = false;
	}
	return exitHookRegistered;
}

function writeOwner(profilePath: string, layer: string, owner: RunLockOwner): void {
	// 小文件覆盖写；偶尔丢一拍无所谓（下一拍补上），所以不做 tmp+rename
	writeFileSync(ownerPath(profilePath, layer), JSON.stringify(owner), "utf-8");
}

/**
 * 抢本层运行级锁。
 *
 * @param jobId 诊断用（子代理不知道自己的 job id 时传 0）
 * @param nowMs 可注入的当前时间（离线测用）
 */
export function acquireRunLock(
	profilePath: string,
	layer: string,
	jobId = 0,
	nowMs = Date.now(),
): RunLockHandle {
	const existing = heldLocks.get(layer);
	if (existing?.acquired) {
		// 复用：但要确认锁还在我们手里（可能已被别人按 ②③ 收走）
		const cur = readRunLockOwner(profilePath, layer);
		if (cur?.pid === process.pid) return existing;
		existing.release();
	}

	const t: SubagentTimeouts = loadSubagentTimeouts(profilePath);
	const owner = readRunLockOwner(profilePath, layer);
	const dirExists = existsSync(runLockDir(profilePath, layer));
	// owner.json 读不出来但目录在（写坏/删了一半）：**不当 free、也不按时间抢** ——
	// 与 L1 写锁同款的保守取舍（误判"没锁"会让两个写者并存，比多等糟得多）。
	if (dirExists && !owner) {
		logEvent(
			"pipeline",
			`运行级锁 ${layer}：owner.json 不可读，按「有人持有」处理（确认无人写时手动删该目录，或用 /my-memory:subagent-kill）`,
			profilePath,
		);
		return { layer, acquired: false, verdict: "held", release: () => {} };
	}
	const verdict = runLockAcquirable({
		owner,
		nowMs,
		holderAlive: owner ? isProcessAlive(owner.pid) : false,
		staleHeartbeatMs: t.runLockStaleHeartbeatMs,
		expireMs: t.runLockExpireMs,
	});
	if (verdict === "held") {
		return { layer, acquired: false, verdict, owner, release: () => {} };
	}
	if (verdict !== "free") {
		// 按 ①②③ 之一收走：落 warning，便于事后统计"异常回收发生过几次"
		logEvent(
			"pipeline",
			`运行级锁 ${layer}：按 ${verdict} 收走旧持有者（pid=${owner?.pid ?? "?"}，` +
				`心跳 ${owner ? Math.max(0, Math.round((nowMs - owner.heartbeatAt) / 1000)) : "?"}s 前）`,
			profilePath,
		);
		try {
			rmSync(runLockDir(profilePath, layer), { recursive: true, force: true });
		} catch {
			// 忽略：下面 mkdir 会因目录仍在而失败 → 当作拿不到
		}
	}

	try {
		// 父目录（`state/`）可能还不存在（新建 profile / 临时 profile），先补上；
		// 真正抢锁仍是 `recursive:false` 的原子 mkdir。
		mkdirSync(dirname(runLockDir(profilePath, layer)), { recursive: true });
		mkdirSync(runLockDir(profilePath, layer), { recursive: false });
	} catch {
		// 竞态：有人比我们快
		return { layer, acquired: false, verdict: "held", owner: readRunLockOwner(profilePath, layer), release: () => {} };
	}

	const mine: RunLockOwner = {
		pid: process.pid,
		layer,
		jobId,
		startedAt: nowMs,
		heartbeatAt: nowMs,
		expiresAt: nowMs + t.runLockExpireMs,
	};
	writeOwner(profilePath, layer, mine);

	const timer = setInterval(() => {
		const cur = readRunLockOwner(profilePath, layer);
		if (cur?.pid !== process.pid) {
			// 锁被收走了：停止续期并放弃句柄（我们不再是写者，后续写入会被拒）
			clearInterval(timer);
			heldLocks.delete(layer);
			logEvent("pipeline", `运行级锁 ${layer}：确认已被他人收走（pid ${cur?.pid ?? "无"}），本进程放弃持有`, profilePath);
			return;
		}
		writeOwner(profilePath, layer, { ...cur, heartbeatAt: Date.now(), expiresAt: Date.now() + t.runLockExpireMs });
	}, t.runLockHeartbeatMs);
	// unref：心跳不该阻止子代理进程正常退出（退出时由 exit 钩子释放）
	(timer as unknown as { unref?: () => void }).unref?.();

	const handle: RunLockHandle = {
		layer,
		acquired: true,
		verdict,
		owner: mine,
		release: () => {
			clearInterval(timer);
			heldLocks.delete(layer);
			const cur = readRunLockOwner(profilePath, layer);
			if (cur && cur.pid !== process.pid) return; // 不是我们的锁，别删
			try {
				rmSync(runLockDir(profilePath, layer), { recursive: true, force: true });
			} catch {
				// 忽略
			}
		},
	};
	heldLocks.set(layer, handle);
	registerRunLockExitHook();
	return handle;
}

/**
 * 强制回收本层运行级锁（杀后修复用）：持有者 pid 已不存在、或正是被杀的 pid ⇒ 清。
 * `owner.json` 读不出来 → **不动**（误清会让两个写者并存，比多等糟得多）。
 *
 * @returns 被清掉的层名列表
 */
export function forceReleaseRunLock(profilePath: string, layer?: string, killedPid?: number): string[] {
	const layers = layer ? [layer] : discoverRunLockLayers(profilePath);
	const cleared: string[] = [];
	for (const l of layers) {
		const owner = readRunLockOwner(profilePath, l);
		if (!owner) continue;
		const matchesKilled = killedPid !== undefined && owner.pid === killedPid;
		if (!matchesKilled && isProcessAlive(owner.pid)) continue;
		try {
			rmSync(runLockDir(profilePath, l), { recursive: true, force: true });
			cleared.push(l);
		} catch {
			// 忽略
		}
	}
	return cleared;
}

function discoverRunLockLayers(profilePath: string): string[] {
	const dir = join(profilePath, MEMORY_DB_DIR, "state");
	try {
		return readdirSync(dir)
			.filter((f) => f.startsWith("run-lock-") && f.endsWith(".lock"))
			.map((f) => f.slice("run-lock-".length, -".lock".length));
	} catch {
		return [];
	}
}

/** 被拒绝时给子代理的文案（它读到就会收尾）。 */
export function runLockBusyMessage(layer: string, owner: RunLockOwner | undefined, nowMs = Date.now()): string {
	const age = owner && owner.heartbeatAt > 0 ? Math.max(0, Math.round((nowMs - owner.heartbeatAt) / 1000)) : undefined;
	if (owner) {
		return t("ext.lock.busyWithOwner", { layer, pid: owner.pid, age: age ?? "?" });
	}
	return t("ext.lock.busy", { layer });
}
