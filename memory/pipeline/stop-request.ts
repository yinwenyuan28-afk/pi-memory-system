// 停止请求标记（2026-09-26，SUBAGENT_LIVENESS_FIX 的 T2 第 1–2 步）
//
// 为什么需要它：Windows 上进程没有可捕获的优雅信号（`SIGTERM` 即 TerminateProcess），
// 所以"让子代理体面停下"只能靠协作 —— 主进程先落一个标记，该层的**写工具在入口**检查它，
// 命中就拒绝本次写入并让子代理立即收尾。这样"被杀点"被推到操作边界，
// 而不是落在一次多步写入（校验 → 备份 → 写块 → 删源 → 成员 sidecar → 索引 → 游标）的中间。
//
// **生效窗口**（`STOP_REQUEST_TTL_MS`）：更旧的标记视为崩溃残留并忽略 ——
// 否则一个残留标记会把该层的所有写入永久堵死，那比"漏停一次"严重得多。
//
// 与 notices / failure-state 同款的取舍：标记不是关键数据，写失败静默降级（停止本来就尽力而为）。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MEMORY_DB_DIR, STOP_REQUEST_FILE_PREFIX } from "../paths.ts";
import { DEFAULT_STOP_REQUEST_TTL_MS, loadSubagentTimeouts } from "./timeout-config.ts";
import { t } from "../../i18n/index.ts";

/** 标记的默认有效期：超过它视为崩溃残留（可用配置中心 `subagent.stopRequestTtlMs` 覆盖）。 */
export const STOP_REQUEST_TTL_MS = DEFAULT_STOP_REQUEST_TTL_MS;

export interface StopRequest {
  layer: string;
  jobId: number;
  requestedAt: number;
  reason: string;
}

/** 纯时间判定：`requestedAt` 是否在 `[now - ttl, now + 容差]` 内（可离线测）。 */
export function stopRequestActive(requestedAt: number, nowMs: number, ttlMs = STOP_REQUEST_TTL_MS): boolean {
	if (!Number.isFinite(requestedAt)) return false;
	const age = nowMs - requestedAt;
	// 未来时间戳（时钟被改）留 60s 容差即视为生效，超出则视为异常数据、忽略
	return age <= ttlMs && age >= -60_000;
}

export function stopRequestPath(profilePath: string, layer: string): string {
	return join(profilePath, MEMORY_DB_DIR, `${STOP_REQUEST_FILE_PREFIX}${layer}.json`);
}

/** 落标记（原子写；失败静默 —— 停止是尽力而为，写不进去不该让调用方崩）。 */
export function writeStopRequest(profilePath: string, layer: string, jobId: number, reason: string): void {
	const p = stopRequestPath(profilePath, layer);
	try {
		mkdirSync(dirname(p), { recursive: true });
		const tmp = `${p}.tmp`;
		writeFileSync(tmp, JSON.stringify({ layer, jobId, requestedAt: Date.now(), reason } satisfies StopRequest), "utf-8");
		renameSync(tmp, p);
	} catch {
		// 尽力而为
	}
}

/** 清标记。**必须在放行该层之前调用**，否则下次运行的所有写入都会被拒。 */
export function clearStopRequest(profilePath: string, layer: string): void {
	try {
		rmSync(stopRequestPath(profilePath, layer), { force: true });
	} catch {
		// 忽略
	}
}

/** 读标记（**不**判 TTL；损坏返回 undefined）。 */
export function readStopRequest(profilePath: string, layer: string): StopRequest | undefined {
	const p = stopRequestPath(profilePath, layer);
	if (!existsSync(p)) return undefined;
	try {
		const d = JSON.parse(readFileSync(p, "utf-8")) as Partial<StopRequest>;
		if (typeof d?.requestedAt !== "number") return undefined;
		return {
			layer,
			jobId: Number(d.jobId) || 0,
			requestedAt: d.requestedAt,
			reason: typeof d.reason === "string" ? d.reason : "",
		};
	} catch {
		return undefined;
	}
}

/**
 * 标记当前是否**生效**（TTL 内）。写工具入口就用这一个。
 * TTL 取自配置中心（`subagent.stopRequestTtlMs`）—— 每次提交读一次小 JSON，可接受。
 */
export function isStopRequested(profilePath: string, layer: string, nowMs = Date.now()): boolean {
	const r = readStopRequest(profilePath, layer);
	if (!r) return false;
	return stopRequestActive(r.requestedAt, nowMs, loadSubagentTimeouts(profilePath).stopRequestTtlMs);
}

/** 给写工具用的统一拒绝文案（子代理读到它会收尾）。 */
export function stopRequestedMessage(layer: string): string {
	return t("ext.lock.stopRequested", { layer });
}
