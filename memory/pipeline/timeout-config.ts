// 子代理超时的可配置项（2026-09-26，SUBAGENT_LIVENESS_FIX）
//
// 收束到统一配置中心 `{profile}/memoryDB/config/application-propertis.json` 的 `subagent` 节，
// 与 `recall` / `l1` / `l2` / `model` 同款做法（纯函数解析 + 非法值兜底默认）。
//
// 为什么要有这一层：这套阈值原来是代码里的常量（`subagent-liveness.ts` 的 `DEFAULT_*`、
// `subagent-kill.ts` 的 `KILL_GRACE_MS`、`stop-request.ts` 的 `STOP_REQUEST_TTL_MS`），
// 而它们全是"按实际观测调"的量 —— 用户实测单轮生成 987 秒，硬上限只能靠更大的样本再校准。
// 硬编码就得改代码，收到配置中心后可以边跑边调。
//
// 单位一律**毫秒**（与 `recall.injectTimeoutMs` 等既有键一致）。

import { loadAppProps } from "../../config/app-config.ts";

/** 软阈值默认值 = 各层子代理超时（600s）+ 30s 宽限：到点只提示。 */
export const DEFAULT_SOFT_MS = 600_000 + 30_000;
/** 硬上限默认值：到点由调用方停掉子代理（用户 2026-09-26 裁定）。 */
export const DEFAULT_HARD_MS = 30 * 60_000;
/** 停止序列的宽限期：给"正在进行的单次工具调用"收尾的时间（一次 l2_commit 实落盘 < 1 秒）。 */
export const DEFAULT_KILL_GRACE_MS = 10_000;
/** "停不下来"（拿不到 pid / 杀完仍存活）时持有该层的时长。 */
export const DEFAULT_HOLD_MS_UNCONFIRMED = 30 * 60_000;
/** 停止标记的有效期：更旧的标记视为崩溃残留。 */
export const DEFAULT_STOP_REQUEST_TTL_MS = 5 * 60_000;
/** 运行级锁的心跳间隔（持有者每隔这么久续一次期）。 */
export const DEFAULT_RUN_LOCK_HEARTBEAT_MS = 30_000;
/** 运行级锁的心跳新鲜阈值：超过它认为持有者不再续期（**可抢**）。 */
export const DEFAULT_RUN_LOCK_STALE_HEARTBEAT_MS = 60_000;

export interface SubagentTimeouts {
	/** 软阈值：到点只落一行日志 + 继续等。 */
	softMs: number;
	/** 硬上限：到点走停止序列（不变量：≥ `softMs`）。 */
	hardMs: number;
	/** 停止序列里"先拦"与"后杀"之间的宽限。 */
	killGraceMs: number;
	/** 未能确认停止时持有该层的时长（兜底）。 */
	holdMsUnconfirmed: number;
	/** 停止标记 TTL。 */
	stopRequestTtlMs: number;
	/** 运行级锁的心跳间隔。 */
	runLockHeartbeatMs: number;
	/** 运行级锁的心跳新鲜阈值（超过即可抢）。 */
	runLockStaleHeartbeatMs: number;
	/** 运行级锁的过期时刻跨度（兜底回收；缺省 = `2 × hardMs`）。 */
	runLockExpireMs: number;
}

function pickMs(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * 把 `subagent` 节解析成阈值（纯函数，可离线测）。
 *
 * 逐项独立校验（非法/缺失 → 该项用默认）；`hardMs` 额外钳到 `≥ softMs`，
 * 让"软 ≤ 硬"这个不变量在配置写错时也成立（而不是把 `waitJobWithLiveness` 弄成死循环）。
 */
export function resolveTimeoutSection(section: unknown): SubagentTimeouts {
	const s = (section ?? {}) as Record<string, unknown>;
	const softMs = pickMs(s["softMs"], DEFAULT_SOFT_MS);
	const hardMs = Math.max(pickMs(s["hardMs"], DEFAULT_HARD_MS), softMs);
	return {
		softMs,
		hardMs,
		killGraceMs: pickMs(s["killGraceMs"], DEFAULT_KILL_GRACE_MS),
		holdMsUnconfirmed: pickMs(s["holdMsUnconfirmed"], DEFAULT_HOLD_MS_UNCONFIRMED),
		stopRequestTtlMs: pickMs(s["stopRequestTtlMs"], DEFAULT_STOP_REQUEST_TTL_MS),
		runLockHeartbeatMs: pickMs(s["runLockHeartbeatMs"], DEFAULT_RUN_LOCK_HEARTBEAT_MS),
		runLockStaleHeartbeatMs: pickMs(s["runLockStaleHeartbeatMs"], DEFAULT_RUN_LOCK_STALE_HEARTBEAT_MS),
		// 缺省 = 2× 硬上限：保证兜底回收不早于任何合法运行结束，而 hardMs 又已被钳到 ≥ softMs
		runLockExpireMs: pickMs(s["runLockExpireMs"], 2 * hardMs),
	};
}

/** 读配置中心的 `subagent` 节；无文件/无该节/非法 → 全默认。 */
export function loadSubagentTimeouts(profilePath: string): SubagentTimeouts {
	return resolveTimeoutSection(loadAppProps(profilePath)?.["subagent"]);
}
