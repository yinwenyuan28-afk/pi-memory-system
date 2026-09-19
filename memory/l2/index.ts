import { runPiSubagent } from "../../util/subagent.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { L2_SUBAGENT_TIMEOUT_MS, buildL2Task, loadL2Cursor, L2_FAILURE_THRESHOLD, readAllRecords } from "./config.ts";
import { loadFailureState, saveFailureState, type LayerFailureState } from "../failure-state.ts";
import { getPipelineJobsDB, type PipelineJob } from "../pipeline/jobs-db.ts";
import { waitWhileRunning, type PipelineJobResult, type PipelineWorker } from "../pipeline/worker.ts";

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
		const abortCtl = new AbortController();
		try {
			const task = buildL2Task(profilePath, undefined, true);
			// 真完成信号 = 子代理里的 l2_commit 调 completeRunningL2()（把本 job 标 done）。
			// **不能**在 `await runPiSubagent(...)` 之后就下结论：那是 async:true 的 fire-and-forget，
			// 毫秒级返回，此刻"游标没推进"只说明子代理还没干完，不代表失败
			//（2026-09-19 实测：旧写法把 job 在 0 秒标 done → 队列以为空闲 → 两个 L2 并发改场景块）。
			const db = getPipelineJobsDB(profilePath);
			const waitP = waitWhileRunning(() => db.getJob(job.id), L2_SUBAGENT_TIMEOUT_MS + 30_000);
			const spawnP = runPiSubagent("l2-scene-organizer", task, ctx, L2_SUBAGENT_TIMEOUT_MS, abortCtl.signal);
			void spawnP.catch((err) => {
				console.warn(`[memory-system][l2] spawn later: ${err instanceof Error ? err.message : String(err)}`);
			});
			await Promise.race([spawnP, waitP]);
			if (db.getJob(job.id)?.status === "running") await waitP;

			const after = db.getJob(job.id);
			if (after?.status === "done") {
				const st = loadL2State();
				st.consecutiveFailures = 0;
				saveL2State(st);
				return "done";
			}
			if (after?.status === "skipped") {
				abortCtl.abort();
				await spawnP.catch(() => {});
				return "skipped";
			}
			// 仍在 running = 超过等待窗口仍没提交 → failed（并掐掉子代理）
			if (after?.status === "running") db.complete(job.id, "failed", "timeout without l2_commit");
			abortCtl.abort();
			await spawnP.catch(() => {});
			const st = loadL2State();
			st.consecutiveFailures++;
			console.warn(`[memory-system][l2] organize ended without l2_commit (job ${job.id}, status=${after?.status})`);
			if (st.consecutiveFailures >= L2_FAILURE_THRESHOLD && !st.cooledDown) {
				st.cooledDown = true;
				ctx.ui.notify(
					`L2 场景组织连续失败 ${st.consecutiveFailures} 次，已暂停自动提取。用 /my-memory:l2-trigger 手动重试或检查日志。`,
					"error",
				);
			}
			saveL2State(st);
			return "failed";
		} catch (err) {
			abortCtl.abort();
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
