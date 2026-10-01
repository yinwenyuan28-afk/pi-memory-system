import { failFastOnSpawnFailure, runPiSubagent } from "../../util/subagent.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	L1_INTERVAL,
	SUBAGENT_TIMEOUT_MS,
	buildL1Task,
	L1_FAILURE_THRESHOLD,
	listL0Files,
	loadL1Cursor,
} from "./config.ts";
import { holdUntilFrom, loadFailureState, saveFailureState, type LayerFailureState } from "../failure-state.ts";
import { logEvent, noticeCard } from "../../util/notice.ts";
import { getPipelineJobsDB, type PipelineJob } from "../pipeline/jobs-db.ts";
import { readSubagentRun } from "../pipeline/subagent-runs.ts";
import { startHeartbeat, waitJobWithLiveness } from "../pipeline/subagent-liveness.ts";
import { loadSubagentTimeouts } from "../pipeline/timeout-config.ts";
import { stopSubagent } from "../pipeline/subagent-kill.ts";
import { decideManualTrigger, type PipelineJobResult, type PipelineWorker } from "../pipeline/worker.ts";

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
		// 比子代理超时多给 30s 宽限：子代理在最后时刻调 l1_commit 时，落盘 + 写游标 + 入队 L2
		// 仍需时间，同值会在这条尾巴上误判超时（2026-09-15）。
		// 2026-09-26（SUBAGENT_LIVENESS_FIX）：软阈值只提示、硬上限**停掉子代理**；
		// 旧实现到点判死 + abort 实测会误判（job 70 标 failed 后 7 分钟才提交）。
		const stopHeartbeat = startHeartbeat({
			layer: "l1",
			jobId: job.id,
			profilePath,
			// 心跳在派发之前就启动，pid 那时还没有 —— 从运行记录惰性取
			getPid: () => readSubagentRun(profilePath, "l1", job.id)?.pid,
			onTick: (info) =>
				ctx.ui.setStatus(
					"memory",
					`Memory ⚙L1 ${(info.elapsedMs / 60000).toFixed(1)}m（子代理 ${info.alive === undefined ? "派发中" : info.alive ? "存活" : "已退出"}）`,
				),
		});
		// 阈值来自配置中心 `subagent` 节（实测单轮生成可达 987s，硬上限要能边跑边调）

		const to = loadSubagentTimeouts(profilePath);
		const waitP = waitJobWithLiveness(() => db.getJob(job.id), {
				softMs: to.softMs,
				hardMs: to.hardMs,
			profilePath,
			layer: "l1",
			jobId: job.id,
		});
		try {
			const spawnP = runPiSubagent("l1-extractor", task, ctx, {
				profilePath,
				layer: "l1",
				jobId: job.id,
			});
			// 派发失败要立刻进下方 catch（那里已有计数 / 告警卡 / 释放 job 的完整处理），
			// 不能只记日志后干等活性门控——子代理压根没起来时 job 会挂到硬阈值
			// （默认 45 分钟），期间串行队列被单飞锁全堵死。
			const outcome = await failFastOnSpawnFailure(spawnP, waitP, (err) => {
				logEvent("l1", `spawn later: ${err instanceof Error ? err.message : String(err)}`);
			});
			const after = db.getJob(job.id);
			if (after?.status === "done") {
				const s2 = loadL1State();
				s2.consecutiveFailures = 0;
				saveL1State(s2);
				logEvent(
					"l1",
					`job ${job.id} 完成：${(outcome.elapsedMs / 1000).toFixed(0)}s` +
						`${outcome.longestTurnMs !== undefined ? `，最长单轮 ${(outcome.longestTurnMs / 1000).toFixed(0)}s` : ""}`,
				);
				return "done";
			}
			if (after?.status === "skipped") {
				abortCtl.abort();
				await spawnP.catch(() => {});
				return "skipped";
			}
			// 到硬上限仍是 running ⇒ 停掉子代理（先拦 → 宽限 → 杀进程树 → 杀后修复）
			const stop = await stopSubagent({
				graceMs: to.killGraceMs,
				profilePath,
				layer: "l1",
				jobId: job.id,
				reason: `L1 超过硬上限（${(to.hardMs / 60000).toFixed(0)} 分钟）未提交`,
			});
			abortCtl.abort(); // 尽力而为：async 路径实测无效（见 subagent-kill.ts 头注释），杀靠 pid
			await spawnP.catch(() => {});
			db.complete(job.id, "failed", stop.killConfirmed ? "killed at hard cap" : "hard cap: stop unconfirmed");
			const s2 = loadL1State();
			s2.consecutiveFailures++;
			if (!stop.killConfirmed) s2.holdUntil = holdUntilFrom(Date.now(), to.holdMsUnconfirmed);
			logEvent("l1", `extract stopped at hard cap (job ${job.id}，${stop.note})`);
			noticeCard({
				level: "warning",
				title: "L1 提取已在硬上限被停掉",
				lines: [
					`job ${job.id}（来源 ${job.source}）超过 ${(to.hardMs / 60000).toFixed(0)} 分钟未提交，已停止子代理`,
					`本批未提交 ⇒ 游标未推进，下一轮重做；连续失败 ${s2.consecutiveFailures}/${L1_FAILURE_THRESHOLD}`,
					stop.killConfirmed ? "杀后修复已完成（分片尾/写锁/游标已核）" : "**未能确认停止**，本层已持有，暂不接受新任务",
				],
				detail: `${stop.note}\n进程内日志：memoryDB/logs/l1.log`,
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
			stopHeartbeat();
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
