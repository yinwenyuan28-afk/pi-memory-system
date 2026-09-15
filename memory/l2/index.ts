import { runPiSubagent } from "../../util/subagent.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { L2_SUBAGENT_TIMEOUT_MS, buildL2Task, loadL2Cursor, L2_FAILURE_THRESHOLD, readAllRecords } from "./config.ts";
import { loadFailureState, saveFailureState, type LayerFailureState } from "../failure-state.ts";
import { getPipelineJobsDB, type PipelineJob } from "../pipeline/jobs-db.ts";
import type { PipelineJobResult, PipelineWorker } from "../pipeline/worker.ts";

/**
 * 注册 L2 组织调度。
 * 不再 watchFile l1/cursor.json；自动 L2 只由 l1_commit 入队，手动走 /l2-trigger 入队。
 */
export function setupL2Organizer(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
	pipeline: PipelineWorker,
): {
	reset: () => void;
	triggerManual: (ctx?: ExtensionContext) => void | Promise<void>;
	executeJob: (ctx: ExtensionContext, job: PipelineJob) => Promise<PipelineJobResult>;
	isCooledDown: () => boolean;
} {
	// 【2026-09-11】read_l1_increment 注册已上移至 index.ts 模块顶层（子代理可达）；
	// 本函数仅在主进程 session_start 后执行，若在此注册将造成子代理缺工具（死线，已修）。

	function loadL2State(): LayerFailureState {
		const p = getProfilePath();
		return p ? loadFailureState(p).l2 : { consecutiveFailures: 0, cooledDown: false };
	}
	function saveL2State(s: LayerFailureState): void {
		const p = getProfilePath();
		if (!p) return;
		const all = loadFailureState(p);
		all.l2 = s;
		saveFailureState(p, all);
	}

	async function executeJob(ctx: ExtensionContext, job: PipelineJob): Promise<PipelineJobResult> {
		const profilePath = getProfilePath();
		if (!profilePath) return "failed";
		const watermark = loadL2Cursor(profilePath).lastProcessedAt;
		const staged = readAllRecords(profilePath).filter((r) => r.epoch > watermark);
		if (staged.length === 0) {
			console.warn("[memory-system][l2] skip: no new records");
			return "skipped";
		}
		ctx.ui.setStatus("memory", job.source === "manual" ? `Memory ⚙L2 (manual, ${staged.length} records)...` : "Memory ⚙L2...");
		try {
			const task = buildL2Task(profilePath, undefined, true);
			await runPiSubagent("l2-scene-organizer", task, ctx, L2_SUBAGENT_TIMEOUT_MS);
			const cursorAfter = loadL2Cursor(profilePath);
			if (cursorAfter.lastProcessedAt <= watermark) {
				console.warn(
					`[memory-system][l2] 子代理未推进游标（lastProcessedAt ${cursorAfter.lastProcessedAt} ≤ watermark ${watermark}），保持游标原状；下一次 l1_commit 会再入队`,
				);
				return "done";
			}
			const st = loadL2State();
			st.consecutiveFailures = 0;
			saveL2State(st);
			return "done";
		} catch (err) {
			const st = loadL2State();
			st.consecutiveFailures++;
			console.warn(`[memory-system][l2] organize failed: ${err instanceof Error ? err.message : String(err)}`);
			if (st.consecutiveFailures >= L2_FAILURE_THRESHOLD && !st.cooledDown) {
				st.cooledDown = true;
				ctx.ui.notify(
					`L2 场景组织连续失败 ${st.consecutiveFailures} 次，已暂停自动提取。用 /my-memory:l2-trigger 手动重试或检查日志。`,
					"error",
				);
			}
			saveL2State(st);
			return "failed";
		}
	}

	async function triggerManual(ctx?: ExtensionContext): Promise<void> {
		const profilePath = getProfilePath();
		if (!profilePath) {
			if (ctx) ctx.ui.notify("L2 调度器未初始化（缺少有效 profile）", "error");
			return;
		}
		try {
			if (getPipelineJobsDB(profilePath).hasActive("l2")) {
				if (ctx) ctx.ui.notify("L2 场景组织已在队列或运行中", "warn");
				return;
			}
		} catch {
			// continue to enqueue
		}
		const watermark = loadL2Cursor(profilePath).lastProcessedAt;
		const stageCount = readAllRecords(profilePath).filter((r) => r.epoch > watermark).length;
		if (stageCount === 0) {
			if (ctx) ctx.ui.notify("L2 无新 records（cursor 已是最新）", "info");
			console.warn("[memory-system][l2] manual trigger: no new records");
			return;
		}

		const st = loadL2State();
		st.cooledDown = false;
		st.consecutiveFailures = 0;
		saveL2State(st);
		if (ctx) pipeline.setCachedCtx(ctx);
		const queued = pipeline.enqueueL2("manual");
		if (!queued) {
			if (ctx) ctx.ui.notify("L2 入队失败", "error");
			return;
		}
		if (queued.duplicate) {
			if (ctx) ctx.ui.notify("L2 场景组织已在队列或运行中", "warn");
			return;
		}
		if (ctx) ctx.ui.notify(`L2 场景组织已入队（${stageCount} records）`, "info");
		pipeline.kick();
	}

	return {
		reset: () => {
			// 队列与 worker 由 pipeline.reset 处理
		},
		triggerManual,
		executeJob,
		isCooledDown: () => loadL2State().cooledDown,
	};
}
