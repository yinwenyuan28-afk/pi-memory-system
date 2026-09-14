import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { FAILURE_STATE_FILE, MEMORY_DB_DIR } from "./paths.ts";

// ══════════════════════════════════════════════════════════════
//  熔断状态持久化（跨进程重启）
//
//  原先 consecutiveFailures / cooledDown 是内存变量，进程重启即清零，
//  导致确定性失败在重启后重新累计、最多空烧 3 次才再熔断。
//  现落盘到 {profile}/memoryDB/failure-state.json，重启后仍能读到。
// ══════════════════════════════════════════════════════════════

export interface LayerFailureState {
	consecutiveFailures: number;
	cooledDown: boolean;
}

export interface FailureState {
	l1: LayerFailureState;
	l2: LayerFailureState;
}

const EMPTY: LayerFailureState = { consecutiveFailures: 0, cooledDown: false };

/** 读取熔断状态（跨重启持久）。无文件 / 损坏返回全零。 */
export function loadFailureState(profilePath: string): FailureState {
	const p = join(profilePath, MEMORY_DB_DIR, FAILURE_STATE_FILE);
	if (!existsSync(p)) return { l1: { ...EMPTY }, l2: { ...EMPTY } };
	try {
		const d = JSON.parse(readFileSync(p, "utf-8")) as Partial<FailureState>;
		return {
			l1: {
				consecutiveFailures: Number(d?.l1?.consecutiveFailures) || 0,
				cooledDown: Boolean(d?.l1?.cooledDown),
			},
			l2: {
				consecutiveFailures: Number(d?.l2?.consecutiveFailures) || 0,
				cooledDown: Boolean(d?.l2?.cooledDown),
			},
		};
	} catch {
		return { l1: { ...EMPTY }, l2: { ...EMPTY } };
	}
}

/** 原子写熔断状态（写失败静默降级，非关键路径）。 */
export function saveFailureState(profilePath: string, state: FailureState): void {
	const p = join(profilePath, MEMORY_DB_DIR, FAILURE_STATE_FILE);
	const tmp = `${p}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(state), "utf-8");
		renameSync(tmp, p);
	} catch {
		// 熔断状态非关键，写失败不阻塞正常流程
	}
}
