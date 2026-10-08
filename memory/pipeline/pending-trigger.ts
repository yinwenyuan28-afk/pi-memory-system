/**
 * 各层「外部触发信号」的跨进程载体（{memoryDB}/pipeline/pending-trigger-<layer>.json）。
 *
 * 为什么需要它：查看器的写盘桥（`scripts/l1-admin/viewer-bridge.mjs`）是**独立 Node 进程**，
 * 而"手动触发一层"在扩展里靠的是主进程的 `cachedCtx` + executors + `kick()`
 * （`memory/pipeline/worker.ts` 的 `drain` 在 `!cachedCtx` 时直接 return）。两个进程之间
 * 没有 IPC 通道，唯一能共享的就是盘上的文件 —— 这正是 L3 从 2026-09 起用的手法
 * （`memory/l3/signal.ts` 的 `l3/pending-trigger.json`），本模块把它泛化给 L1/L2。
 *
 * 语义：**写一次 = 请求一次**；消费方 `agent_settled` 里读后即删，保证一个信号只生效一次。
 * 它只负责"请求入队"，真正执行仍需一个**活着的 pi 会话**（子代理要 ctx 才能 spawn）——
 * 查看器界面必须如实这么写，不能承诺"点了就跑"。
 *
 * 与 `memory/l3/signal.ts` 的关系：路径与载荷刻意不同（那份带 `personaSignal`，要喂
 * `evaluateTrigger` 的 P1 闸）。两者并存，不合并 —— L3 那条已被 `verify-l3-*` 覆盖，
 * 搬动它只是徒增回归面。查看器要读的是两份文件，`scripts/verify-viewer-deploy.ts` 里有
 * 断言盯住这两条路径与 paths.ts 常量一致。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MEMORY_DB_DIR, PIPELINE_PENDING_TRIGGER_PREFIX } from "../paths.ts";

/** 可以请求外部触发的层。 */
export type TriggerLayer = "l1" | "l2" | "l3";

/** 信号载荷：谁会读它？只有日志和查看器的展示，行为完全由"文件存在与否"决定。 */
export interface PendingTrigger {
	layer: TriggerLayer;
	/** 请求方给的理由（查看器会带过来，便于事后在日志里对上人话）。 */
	reason?: string;
	/** 请求来源，如 "viewer" / "cli"。 */
	by?: string;
	at: string;
}

const LAYERS: readonly TriggerLayer[] = ["l1", "l2", "l3"];

/** 层名闭集校验（信号路径由它拼出来，非法层名会拼出一个不该存在的文件）。 */
export function isTriggerLayer(value: unknown): value is TriggerLayer {
	return typeof value === "string" && (LAYERS as readonly string[]).includes(value);
}

/** 信号文件绝对路径。 */
export function pendingTriggerPath(profilePath: string, layer: TriggerLayer): string {
	return join(profilePath, MEMORY_DB_DIR, `${PIPELINE_PENDING_TRIGGER_PREFIX}${layer}.json`);
}

/**
 * 写触发信号（查看器桥 / CLI 调用）。
 *
 * 返回是否写成功 —— 与 L3 那份"失败静默"不同：这里的调用方是交互式的（用户点了按钮），
 * 悄悄失败会变成"点了没反应"，正是本轮要消灭的失效模式，所以把结果回给调用方去提示。
 */
export function writePendingTrigger(
	profilePath: string,
	layer: TriggerLayer,
	opts: { reason?: string; by?: string } = {},
): boolean {
	const filePath = pendingTriggerPath(profilePath, layer);
	try {
		const dir = dirname(filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const payload: PendingTrigger = {
			layer,
			reason: typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim().slice(0, 200) : undefined,
			by: typeof opts.by === "string" && opts.by.trim() ? opts.by.trim().slice(0, 40) : undefined,
			at: new Date().toISOString(),
		};
		writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
		return true;
	} catch {
		return false;
	}
}

/** 只读探查（**不删**）：给查看器显示"已请求、等待 pi 会话消费"。 */
export function peekPendingTrigger(profilePath: string, layer: TriggerLayer): PendingTrigger | undefined {
	const parsed = readSignal(profilePath, layer);
	return parsed ?? undefined;
}

/** 读取并删除（**消费方专用**）。文件不存在或损坏 → undefined。 */
export function consumePendingTrigger(profilePath: string, layer: TriggerLayer): PendingTrigger | undefined {
	const filePath = pendingTriggerPath(profilePath, layer);
	if (!existsSync(filePath)) return undefined;
	const parsed = readSignal(profilePath, layer);
	removeSignal(filePath);
	return parsed ?? undefined;
}

/** 解析信号文件；损坏时返回 undefined（调用方负责在消费路径上删除它，避免坏文件永久卡住触发）。 */
function readSignal(profilePath: string, layer: TriggerLayer): PendingTrigger | undefined {
	const filePath = pendingTriggerPath(profilePath, layer);
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<PendingTrigger>;
		return {
			layer,
			reason: typeof data?.reason === "string" ? data.reason : undefined,
			by: typeof data?.by === "string" ? data.by : undefined,
			at: typeof data?.at === "string" ? data.at : "",
		};
	} catch {
		return undefined;
	}
}

function removeSignal(filePath: string): void {
	try {
		rmSync(filePath, { force: true });
	} catch {
		// 删不掉时下次还会被读到 —— 幂等入队（`enqueue` 的去重）会兜住第二次。
	}
}
