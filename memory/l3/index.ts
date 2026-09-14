import { runPiSubagent } from "../../util/subagent.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildL3Task, L3_CURSOR_FILE, L3_SUBAGENT_TIMEOUT_MS, loadL3Cursor } from "./config.ts";
import { MEMORY_DB_DIR } from "../paths.ts";
import { evaluateTrigger } from "./trigger.ts";

function incrementMemoriesSince(profilePath: string, count: number): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE);
	let cursor = loadL3Cursor(profilePath);
	cursor = { ...cursor, memoriesSinceLastPersona: cursor.memoriesSinceLastPersona + count };
	writeFileSync(filePath, JSON.stringify(cursor, null, 2), "utf-8");
}

export interface L3Controls {
	onL1Committed: (recordCount: number) => void;
	onL2Committed: (opts?: { personaSignal?: boolean; personaReason?: string }) => void;
	triggerManual: (ctx?: ExtensionContext) => void | Promise<void>;
	reset: () => void;
}

/**
 * 注册 L3 persona 调度（单次调用）。
 */
export function setupL3Persona(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): L3Controls {
	let scheduled = false;
	let pendingTrigger = false;
	let pendingOpts: { personaSignal?: boolean; personaReason?: string; force?: boolean } | undefined;
	let cachedCtx: ExtensionContext | undefined;

	async function runTask(task: string, ctx: ExtensionContext): Promise<void> {
		scheduled = true;
		ctx.ui.setStatus("memory", "Memory ⚙L3...");
		try {
			await runPiSubagent("l3-persona-generator", task, ctx, L3_SUBAGENT_TIMEOUT_MS);
		} catch (err) {
			console.warn(`[memory-system][l3] persona failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			scheduled = false;
		}
	}

	function queueTrigger(opts: { personaSignal?: boolean; personaReason?: string; force?: boolean } = {}): void {
		const profilePath = getProfilePath();
		if (!profilePath || scheduled) return;

		const result = evaluateTrigger(profilePath, opts);
		if (!result.should) return;

		const task = buildL3Task(profilePath, result.reason, result.changedScenes);
		if (!task) return;

		if (cachedCtx) {
			void runTask(task, cachedCtx);
		} else {
			pendingTrigger = true;
			pendingOpts = opts;
		}
	}

	function onL1Committed(recordCount: number): void {
		const profilePath = getProfilePath();
		if (!profilePath || recordCount <= 0) return;
		try {
			if (!existsSync(join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE))) {
				writeFileSync(join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE), JSON.stringify(loadL3Cursor(profilePath), null, 2), "utf-8");
			}
			incrementMemoriesSince(profilePath, recordCount);
		} catch {
			// non-fatal
		}
	}

	function onL2Committed(opts?: { personaSignal?: boolean; personaReason?: string }): void {
		if (opts?.personaSignal) {
			queueTrigger({ personaSignal: true, personaReason: opts.personaReason });
			return;
		}
		queueTrigger({});
	}

	function triggerManual(ctx?: ExtensionContext): void {
		if (ctx) {
			void runTask({ personaSignal: true, personaReason: "手动 /persona 触发", force: true }, ctx);
		} else {
			queueTrigger({ force: true, personaReason: "手动 /persona 触发" });
		}
	}

	pi.on("agent_settled", (_e, ctx) => {
		cachedCtx = ctx;
		if (pendingTrigger) {
			pendingTrigger = false;
			const opts = pendingOpts || {};
			pendingOpts = undefined;
			queueTrigger(opts);
		}
	});

	return {
		onL1Committed,
		onL2Committed,
		triggerManual,
		reset: () => {
			scheduled = false;
			pendingTrigger = false;
			pendingOpts = undefined;
		},
	};
}
