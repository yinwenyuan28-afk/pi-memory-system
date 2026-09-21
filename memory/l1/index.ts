import { runPiSubagent } from "../../util/subagent.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	L1_INTERVAL,
	SUBAGENT_TIMEOUT_MS,
	buildL1Task,
	L1_FAILURE_THRESHOLD,
	listL0Files,
	loadL1Cursor,
} from "./config.ts";
import { loadFailureState, saveFailureState, type LayerFailureState } from "../failure-state.ts";
import { logEvent, noticeCard } from "../../util/notice.ts";
import { getPipelineJobsDB, type PipelineJob } from "../pipeline/jobs-db.ts";
import { decideManualTrigger, waitWhileRunning, type PipelineJobResult, type PipelineWorker } from "../pipeline/worker.ts";

/** 熔断提示文案（notify 与卡片共用，避免两处漂移）。 */
function l1CoolDownMessage(failures: number): string {
	return `L1 记忆提取连续失败 ${failures} 次，已暂停自动提取。用 /my-memory:l1-trigger 手动重试或检查日志。`;
}

/**
 * 注册 L1 提取调度。
 * 达 L1_INTERVAL 或手动命令只入队 l1 job，由 pipeline worker 串行执行。
 * L2 由 l1_commit 入队，本模块不再 triggerManual L2。
 */
export function setupL1Extractor(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
	pipeline: PipelineWorker,
): {
	reset: () => void;
	triggerManual: (ctx?: ExtensionContext) => void;
	executeJob: (ctx: ExtensionContext, job: PipelineJob) => Promise<PipelineJobResult>;
	isCooledDown: () => boolean;
} {
	let turnCount = 0;

	function loadL1State(): LayerFailureState {
		const p = getProfilePath();
		return p ? loadFailureState(p).l1 : { consecutiveFailures: 0, cooledDown: false };
	}
	function saveL1State(s: LayerFailureState): void {
		const p = getProfilePath();
		if (!p) return;
		const all = loadFailureState(p);
		all.l1 = s;
		saveFailureState(p, all);
	}

	function hasActiveL1(): boolean {
		const p = getProfilePath();
		if (!p) return false;
		try {
			return getPipelineJobsDB(p).hasActive("l1");
		} catch {
			return false;
		}
	}

	pi.on("input", (event) => {
		if (event.source !== "interactive") return;
		if (!hasActiveL1()) turnCount++;
	});

	pi.on("agent_settled", (_event, ctx) => {
		pipeline.setCachedCtx(ctx);
		if (turnCount < L1_INTERVAL) return;
		const st = loadL1State();
		if (st.cooledDown) return;
		const profilePath = getProfilePath();
		if (!profilePath) return;

		// 只做增量判空：真正的任务消息由 executeJob 构造一次。此前这里也调 buildL1Task，
		// 导致同一轮两次全目录同步读（且两次注入的锚点可能不一致）。
		if (listL0Files(profilePath, loadL1Cursor(profilePath)).length === 0) {
			turnCount = 0;
			return;
		}
		turnCount = 0;
		const queued = pipeline.enqueueL1("interval");
		if (queued && !queued.duplicate) pipeline.kick();
	});

	async function executeJob(ctx: ExtensionContext, job: PipelineJob): Promise<PipelineJobResult> {
		const profilePath = getProfilePath();
		if (!profilePath) return "failed";
		const task = buildL1Task(profilePath);
		if (!task) return "skipped";

		const db = getPipelineJobsDB(profilePath);
		ctx.ui.setStatus("memory", job.source === "manual" ? "Memory ⚙L1 (manual)..." : "Memory ⚙L1...");
		const abortCtl = new AbortController();
		// waitWhileRunning 比子代理超时多给 30s 宽限：子代理在最后时刻调 l1_commit 时，
		// 落盘 + 写游标 + 入队 L2 仍需时间，同值会在这条尾巴上误判超时（2026-09-15）。
		const waitP = waitWhileRunning(() => db.getJob(job.id), SUBAGENT_TIMEOUT_MS + 30_000);
		try {
			const spawnP = runPiSubagent("l1-extractor", task, ctx, SUBAGENT_TIMEOUT_MS, abortCtl.signal);
			void spawnP.catch((err) => {
				logEvent("l1", `spawn later: ${err instanceof Error ? err.message : String(err)}`);
			});
			await Promise.race([spawnP, waitP]);
			if (db.getJob(job.id)?.status === "running") await waitP;
			const after = db.getJob(job.id);
			if (after?.status === "done") {
				const s2 = loadL1State();
				s2.consecutiveFailures = 0;
				saveL1State(s2);
				return "done";
			}
			if (after?.status === "skipped") {
				abortCtl.abort();
				await spawnP.catch(() => {});
				return "skipped";
			}
			if (after?.status === "running") {
				db.complete(job.id, "failed", "timeout without l1_commit");
			}
			abortCtl.abort();
			await spawnP.catch(() => {});
			const s2 = loadL1State();
			s2.consecutiveFailures++;
			// 子代理超时未提交 = “记忆没写成”的实锤（以前只有 console.warn，用户完全看不见）
			const timeoutDetail = `job ${job.id}，status=${after?.status}`;
			logEvent("l1", `extract ended without commit (${timeoutDetail})`);
			noticeCard({
				level: "warning",
				title: "L1 提取未提交（超时/无 l1_commit）",
				lines: [
					`job ${job.id}（来源 ${job.source}）在时限内未调入 l1_commit`,
					`连续失败 ${s2.consecutiveFailures}/${L1_FAILURE_THRESHOLD}`,
				],
				detail: `status=${after?.status}\n进程内日志：memoryDB/logs/l1.log`,
			});
			if (s2.consecutiveFailures >= L1_FAILURE_THRESHOLD && !s2.cooledDown) {
				s2.cooledDown = true;
				ctx.ui.notify(l1CoolDownMessage(s2.consecutiveFailures), "error");
			}
			saveL1State(s2);
			return "failed";
		} catch (err) {
			abortCtl.abort();
			const s2 = loadL1State();
			s2.consecutiveFailures++;
			const failMsg = err instanceof Error ? err.message : String(err);
			logEvent("l1", `extract failed: ${failMsg}`);
			noticeCard({
				level: "warning",
				title: "L1 提取派发失败",
				lines: [`job ${job.id}，连续失败 ${s2.consecutiveFailures}/${L1_FAILURE_THRESHOLD}`],
				detail: failMsg,
			});
			if (s2.consecutiveFailures >= L1_FAILURE_THRESHOLD && !s2.cooledDown) {
				s2.cooledDown = true;
				ctx.ui.notify(l1CoolDownMessage(s2.consecutiveFailures), "error");
			}
			saveL1State(s2);
			const still = db.getJob(job.id);
			if (still?.status === "running") db.complete(job.id, "failed", err instanceof Error ? err.message : String(err));
			return "failed";
		} finally {
			ctx.ui.setStatus("memory", "Memory");
		}
	}

	const triggerManual = (ctx?: ExtensionContext) => {
		const profilePath = getProfilePath();
		if (!profilePath) {
			if (ctx) ctx.ui.notify("L1 调度器未初始化（缺少有效 profile）", "error");
			return;
		}
		try {
			const db = getPipelineJobsDB(profilePath);
			const verdict = decideManualTrigger({
				hasActive: db.hasActive("l1"),
				queuedOfType: db.listQueued().some((j) => j.type === "l1"),
				cooledDown: loadL1State().cooledDown,
			});
			if (verdict === "refuse-busy") {
				if (ctx) ctx.ui.notify("L1 提取已在队列或运行中", "warning");
				return;
			}
			if (verdict === "unpause-queued") {
				// 队列里那条 L1 正被熔断按着：复位熔断 + kick（不排第二条）
				const s0 = loadL1State();
				s0.cooledDown = false;
				s0.consecutiveFailures = 0;
				saveL1State(s0);
				if (ctx) pipeline.setCachedCtx(ctx);
				pipeline.kick();
				logEvent("l1", "manual trigger: 复位熔断，队列中的 job 将执行", profilePath);
				if (ctx) ctx.ui.notify("L1 已复位熔断，排队中的任务将执行", "info");
				return;
			}
		} catch {
			// 队列不可用 → 继续走下面的入队（失败会有提示）
		}
		// 同样只做增量判空，不与 executeJob 重复构造任务消息
		if (listL0Files(profilePath, loadL1Cursor(profilePath)).length === 0) {
			if (ctx) ctx.ui.notify("无 L0 增量数据，跳过手动触发", "info");
			return;
		}
		const s2 = loadL1State();
		s2.cooledDown = false;
		s2.consecutiveFailures = 0;
		saveL1State(s2);
		if (ctx) pipeline.setCachedCtx(ctx);
		const queued = pipeline.enqueueL1("manual");
		if (!queued) {
			if (ctx) ctx.ui.notify("L1 入队失败", "error");
			return;
		}
		if (queued.duplicate) {
			if (ctx) ctx.ui.notify("L1 提取已在队列或运行中", "warning");
			return;
		}
		if (ctx) ctx.ui.notify("L1 提取已入队", "info");
		pipeline.kick();
	};

	return {
		reset: () => {
			turnCount = 0;
		},
		triggerManual,
		executeJob,
		isCooledDown: () => loadL1State().cooledDown,
	};
}

export { loadL1Config } from "./config.ts";
