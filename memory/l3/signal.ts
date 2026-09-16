/**
 * L3 触发信号的跨进程载体（{memoryDB}/l3/pending-trigger.json）。
 *
 * 为什么需要它：`l2_commit` 只在 l2-scene-organizer **子代理进程**里执行（实测 46/46 次），
 * 而主进程的 `l3Controls` 在那个进程里恒为 undefined（`index.ts` 的 PI_SUBAGENT_CHILD 早退
 * 发生在 `setupL3Persona` 之前）—— 所以"回调"当通道是行不通的，落盘才是。
 * 这与 `l2/cursor.json` 由子代理直写同属一个手法，只是反过来（子代理写、主进程读）。
 *
 * 语义：写一次 = 请求一次 P1 触发；主进程**读后即删**，保证一个信号只生效一次。
 * 刻意只依赖 paths.ts（不 import L2/L3 其他模块），避免 L2 ↔ L3 的模块纠缠。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { L3_PENDING_TRIGGER_FILE, MEMORY_DB_DIR } from "../paths.ts";

export interface L3PendingTrigger {
	personaSignal: boolean;
	personaReason?: string;
	at: string;
}

function signalPath(profilePath: string): string {
	return join(profilePath, MEMORY_DB_DIR, L3_PENDING_TRIGGER_FILE);
}

/** 写触发信号（子代理进程调用）。失败静默：顶多晚一轮触发，P4 阈值仍会兜住。 */
export function writePendingTrigger(profilePath: string, signal: { personaSignal: boolean; personaReason?: string }): void {
	const filePath = signalPath(profilePath);
	try {
		const dir = join(filePath, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const payload: L3PendingTrigger = { ...signal, at: new Date().toISOString() };
		writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
	} catch {
		// non-fatal
	}
}

/** 读取并删除触发信号（主进程调用）。文件不存在或损坏 → undefined。 */
export function consumePendingTrigger(profilePath: string): L3PendingTrigger | undefined {
	const filePath = signalPath(profilePath);
	if (!existsSync(filePath)) return undefined;
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<L3PendingTrigger>;
		const out: L3PendingTrigger = {
			personaSignal: data?.personaSignal === true,
			personaReason: typeof data?.personaReason === "string" ? data.personaReason : undefined,
			at: typeof data?.at === "string" ? data.at : "",
		};
		removeSignal(filePath);
		return out;
	} catch {
		removeSignal(filePath);
		return undefined;
	}
}

function removeSignal(filePath: string): void {
	try {
		rmSync(filePath, { force: true });
	} catch {
		// ignore
	}
}
