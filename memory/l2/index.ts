import { failFastOnSpawnFailure, runPiSubagent } from "../../util/subagent.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { L2_SUBAGENT_TIMEOUT_MS, buildL2Task, loadL2Cursor, L2_FAILURE_THRESHOLD, readAllRecords } from "./config.ts";
import { holdUntilFrom, loadFailureState, saveFailureState, type LayerFailureState } from "../failure-state.ts";
import { getPipelineJobsDB, type PipelineJob } from "../pipeline/jobs-db.ts";
import { readSubagentRun } from "../pipeline/subagent-runs.ts";
import { startHeartbeat, waitJobWithLiveness } from "../pipeline/subagent-liveness.ts";
import { loadSubagentTimeouts } from "../pipeline/timeout-config.ts";
import { stopSubagent } from "../pipeline/subagent-kill.ts";
import { repairSceneMembers, syncSceneIndex } from "./commit-tool.ts";
import { decideManualTrigger, type PipelineJobResult, type PipelineWorker } from "../pipeline/worker.ts";
import { logEvent, noticeCard } from "../../util/notice.ts";

/** 熔断提示文案（notify 与卡片共用，避免两处漂移）。 */
function l2CoolDownMessage(failures: number): string {
	return `L2 场景组织连续失败 ${failures} 次，已暂停自动提取。用 /my-memory:l2-trigger 手动重试或检查日志。`;
}

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
			logEvent("l2", "skip: no new records", profilePath);
			return "skipped";
		}
		ctx.ui.setStatus("memory", job.source === "manual" ? `Memory ⚙L2 (manual, ${staged.length} records)...` : "Memory ⚙L2...");
		const abortCtl = new AbortController();
		// 2026-09-26（SUBAGENT_LIVENESS_FIX）：不再"到点判死"，改为**软阈值只提示、硬上限停掉子代理**。
		// 旧实现到 600+30s 就标 failed + abort，实测把"跑了 987 秒还在长生成"的子代理误判四次
		// （jobs 55/61/64/68），并**提前释放队列槽位**（子代理仍在写场景块）。
		const stopHeartbeat = startHeartbeat({
			layer: "l2",
			jobId: job.id,
			profilePath,
			// 心跳在派发之前就启动，pid 那时还没有 —— 从运行记录惰性取
			getPid: () => readSubagentRun(profilePath, "l2", job.id)?.pid,
			onTick: (info) =>
				ctx.ui.setStatus(
					"memory",
					`Memory ⚙L2 ${(info.elapsedMs / 60000).toFixed(1)}m（子代理 ${info.alive === undefined ? "派发中" : info.alive ? "存活" : "已退出"}）`,
				),
		});
		try {
			const task = buildL2Task(profilePath, undefined, true);
			// 真完成信号 = 子代理里的 l2_commit 调 completeRunningL2()（把本 job 标 done）。
			// **不能**在 `await runPiSubagent(...)` 之后就下结论：那是 async:true 的 fire-and-forget，
			// 毫秒级返回，此刻"游标没推进"只说明子代理还没干完，不代表失败
			//（2026-09-19 实测：旧写法把 job 在 0 秒标 done → 队列以为空闲 → 两个 L2 并发改场景块）。
			const db = getPipelineJobsDB(profilePath);
			// 阈值来自配置中心 `subagent` 节（实测单轮生成可达 987s，硬上限要能边跑边调）

			const to = loadSubagentTimeouts(profilePath);
			const waitP = waitJobWithLiveness(() => db.getJob(job.id), {
				softMs: to.softMs,
				hardMs: to.hardMs,
				profilePath,
				layer: "l2",
				jobId: job.id,
			});
			const spawnP = runPiSubagent("l2-scene-organizer", task, ctx, {
				profilePath,
				layer: "l2",
				jobId: job.id,
			});
			// 派发失败立刻进 catch 释放 job，不干等活性门控（详见 failFastOnSpawnFailure 头注释）
			const outcome = await failFastOnSpawnFailure(spawnP, waitP, (err) => {
				logEvent("l2", `spawn later: ${err instanceof Error ? err.message : String(err)}`, profilePath);
			});

			const after = db.getJob(job.id);
			if (after?.status === "done") {
				const st = loadL2State();
				st.consecutiveFailures = 0;
				saveL2State(st);
				logEvent(
					"l2",
					`job ${job.id} 完成：${(outcome.elapsedMs / 1000).toFixed(0)}s` +
						`${outcome.longestTurnMs !== undefined ? `，最长单轮 ${(outcome.longestTurnMs / 1000).toFixed(0)}s` : ""}`,
					profilePath,
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
				layer: "l2",
				jobId: job.id,
				reason: `L2 超过硬上限（${(to.hardMs / 60000).toFixed(0)} 分钟）未提交`,
				hooks: { rebuildSceneIndex, repairSceneMembers },
			});
			abortCtl.abort(); // 尽力而为：async 路径实测无效（见 subagent-kill.ts 头注释），杀靠 pid
			await spawnP.catch(() => {});
			db.complete(job.id, "failed", stop.killConfirmed ? "killed at hard cap" : "hard cap: stop unconfirmed");
			const st = loadL2State();
			st.consecutiveFailures++;
			if (!stop.killConfirmed) {
				// 停不下来就不能放新 L2 进来（两个写者会同时改场景块）⇒ 持有该层
				st.holdUntil = holdUntilFrom(Date.now(), to.holdMsUnconfirmed);
			}
			const l2StopDetail = `job ${job.id}，${stop.note}`;
			logEvent("l2", `organize stopped at hard cap (${l2StopDetail})`, profilePath);
			noticeCard({
				level: "warning",
				title: "L2 场景组织已在硬上限被停掉",
				lines: [
					`job ${job.id}（来源 ${job.source}）超过 ${(to.hardMs / 60000).toFixed(0)} 分钟未提交，已停止子代理`,
					`本批未提交 ⇒ 游标未推进，下一轮重做；连续失败 ${st.consecutiveFailures}/${L2_FAILURE_THRESHOLD}`,
					stop.killConfirmed ? "杀后修复已完成（临时文件/索引/成员/写锁已核）" : "**未能确认停止**，本层已持有，暂不接受新任务",
				],
				detail: `${stop.note}\n进程内日志：memoryDB/logs/l2.log`,
			});
			if (st.consecutiveFailures >= L2_FAILURE_THRESHOLD && !st.cooledDown) {
				st.cooledDown = true;
				ctx.ui.notify(l2CoolDownMessage(st.consecutiveFailures), "error");
			}
			saveL2State(st);
			return "failed";
		} catch (err) {
			abortCtl.abort();
			const st = loadL2State();
			st.consecutiveFailures++;
			const l2FailMsg = err instanceof Error ? err.message : String(err);
			logEvent("l2", `organize failed: ${l2FailMsg}`, profilePath);
			noticeCard({
				level: "warning",
				title: "L2 场景组织派发失败",
				lines: [`job ${job.id}，连续失败 ${st.consecutiveFailures}/${L2_FAILURE_THRESHOLD}`],
				detail: l2FailMsg,
			});
			if (st.consecutiveFailures >= L2_FAILURE_THRESHOLD && !st.cooledDown) {
				st.cooledDown = true;
				ctx.ui.notify(l2CoolDownMessage(st.consecutiveFailures), "error");
			}
			saveL2State(st);
			// 释放 job 槽位：光 return "failed" 不够——worker 只看 DB 里的 status，
			// job 留在 running 会一直占着串行单飞的槽位，直到 recoverStuckRunning
			// 满 10 分钟才回收，期间 L1/L3 全被堵在 queued。
			// （L1 / L3 的 catch 一直有这一步，唯独 L2 漏了。）
			// 注意：上面 try 块里的 `db` 是块级作用域，catch 里看不到，这里重新取。
			const catchDb = getPipelineJobsDB(profilePath);
			const still = catchDb.getJob(job.id);
			if (still?.status === "running") catchDb.complete(job.id, "failed", l2FailMsg);
			return "failed";
		} finally {
			stopHeartbeat();
		}
	}

	async function triggerManual(ctx?: ExtensionContext): Promise<void> {
		const profilePath = getProfilePath();
		if (!profilePath) {
			if (ctx) ctx.ui.notify("L2 调度器未初始化（缺少有效 profile）", "error");
			return;
		}
		try {
			const db = getPipelineJobsDB(profilePath);
			const verdict = decideManualTrigger({
				hasActive: db.hasActive("l2"),
				queuedOfType: db.listQueued().some((j) => j.type === "l2"),
				cooledDown: loadL2State().cooledDown,
			});
			if (verdict === "refuse-busy") {
				if (ctx) ctx.ui.notify("L2 场景组织已在队列或运行中", "warning");
				return;
			}
			if (verdict === "unpause-queued") {
				// 队列里那条 L2 正被熔断按着（熔断把恢复入口也堵死了）：复位 + kick，让它按队序跑。
				// 不再排第二条 —— 排队那条的 source 是 l1_commit，本来就是要干的活。
				const st0 = loadL2State();
				st0.cooledDown = false;
				st0.consecutiveFailures = 0;
				saveL2State(st0);
				if (ctx) pipeline.setCachedCtx(ctx);
				pipeline.kick();
				logEvent("l2", "manual trigger: 复位熔断，队列中的 job 将执行", profilePath);
				if (ctx) ctx.ui.notify("L2 已复位熔断，排队中的任务将执行", "info");
				return;
			}
		} catch {
			// continue to enqueue
		}
		const watermark = loadL2Cursor(profilePath).lastProcessedAt;
		const stageCount = readAllRecords(profilePath).filter((r) => r.epoch > watermark).length;
		if (stageCount === 0) {
			if (ctx) ctx.ui.notify("L2 无新 records（cursor 已是最新）", "info");
			logEvent("l2", "manual trigger: no new records", profilePath);
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
			if (ctx) ctx.ui.notify("L2 场景组织已在队列或运行中", "warning");
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
