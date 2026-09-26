import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { FAILURE_STATE_FILE, MEMORY_DB_DIR } from "./paths.ts";

// ══════════════════════════════════════════════════════════════
//  熔断状态持久化（跨进程重启）
//
//  原先 consecutiveFailures / cooledDown 是内存变量，进程重启即清零，
//  导致确定性失败在重启后重新累计、最多空烧 3 次才再熔断。
//  现落盘到 {profile}/memoryDB/state/failure-state.json，重启后仍能读到。
// ══════════════════════════════════════════════════════════════

export interface LayerFailureState {
	consecutiveFailures: number;
	cooledDown: boolean;
	/**
	 * 层持有到什么时候（ISO 时间；可选，2026-09-26 新增）。
	 *
	 * 用途：硬上限停掉子代理时，若**无法确认进程已死**（拿不到 pid / 杀完仍存活），
	 * 就不能让新的同层 job 起来（两个写者会同时改场景块）⇒ 持有该层到 `holdUntil`。
	 * 确认已死的情形**不写这个字段** —— 那种情况下该层立刻可跑（这正是"直接停掉"的收益）。
	 */
	holdUntil?: string;
}

export interface FailureState {
	l1: LayerFailureState;
	l2: LayerFailureState;
	/**
	 * L3 画像层（2026-09-16 新增）。
	 *
	 * 触发链路从"子代理回调"改成"主进程每轮评估"（见 `l3/index.ts`）之后，
	 * 一次失败不再只丢一次机会 —— 只要阈值条件（`memoriesSinceLastPersona >= 30` 且有变化场景）
     * 仍然成立，**每一轮 agent_settled 都会再拉起一个 10 分钟的子代理**。
	 * 所以 L3 必须有和 L1/L2 同款的熔断，否则"修好自动触发"会变成"每轮空烧 token"。
	 */
	l3: LayerFailureState;
}

const EMPTY: LayerFailureState = { consecutiveFailures: 0, cooledDown: false };

/** 取一层（含可选的 holdUntil，缺字段则省略）。 */
function pickLayer(d: Partial<LayerFailureState> | undefined): LayerFailureState {
	const layer: LayerFailureState = {
		consecutiveFailures: Number(d?.consecutiveFailures) || 0,
		cooledDown: Boolean(d?.cooledDown),
	};
	if (typeof d?.holdUntil === "string" && d.holdUntil) layer.holdUntil = d.holdUntil;
	return layer;
}

/** 该层是否被持有（`holdUntil` 未过期）。纯函数，可离线测。 */
export function isLayerHeld(state: LayerFailureState | undefined, nowMs = Date.now()): boolean {
	const t = state?.holdUntil ? Date.parse(state.holdUntil) : Number.NaN;
	return Number.isFinite(t) && t > nowMs;
}

/** 生成"持有到 `ms` 毫秒后"的 ISO 时间戳。 */
export function holdUntilFrom(nowMs: number, ms: number): string {
	return new Date(nowMs + ms).toISOString();
}

/** 读取熔断状态（跨重启持久）。无文件 / 损坏返回全零。 */
export function loadFailureState(profilePath: string): FailureState {
	const p = join(profilePath, MEMORY_DB_DIR, FAILURE_STATE_FILE);
	if (!existsSync(p)) return { l1: { ...EMPTY }, l2: { ...EMPTY }, l3: { ...EMPTY } };
	try {
		const d = JSON.parse(readFileSync(p, "utf-8")) as Partial<FailureState>;
		return { l1: pickLayer(d?.l1), l2: pickLayer(d?.l2), l3: pickLayer(d?.l3) };
	} catch {
		return { l1: { ...EMPTY }, l2: { ...EMPTY }, l3: { ...EMPTY } };
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
