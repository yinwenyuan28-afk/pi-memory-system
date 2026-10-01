import { failFastOnSpawnFailure, runPiSubagent } from "../../util/subagent.ts";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildL3Task,
	L3_CURSOR_FILE,
	L3_FAILURE_THRESHOLD,
	L3_SUBAGENT_TIMEOUT_MS,
	loadL3Cursor,
	saveL3Cursor,
} from "./config.ts";
import { MEMORY_DB_DIR } from "../paths.ts";
import { holdUntilFrom, loadFailureState, saveFailureState, type LayerFailureState } from "../failure-state.ts";
import { evaluateTrigger } from "./trigger.ts";
import { consumePendingTrigger } from "./signal.ts";
import { getPipelineJobsDB, type PipelineJob } from "../pipeline/jobs-db.ts";
import { readSubagentRun } from "../pipeline/subagent-runs.ts";
import { startHeartbeat, waitJobWithLiveness } from "../pipeline/subagent-liveness.ts";
import { loadSubagentTimeouts } from "../pipeline/timeout-config.ts";
import { stopSubagent } from "../pipeline/subagent-kill.ts";
import { decideManualTrigger, type PipelineJobResult, type PipelineWorker } from "../pipeline/worker.ts";
import { logEvent, noticeCard } from "../../util/notice.ts";
import { readL3Proposal, USER_TEMP_FILE } from "./user-file.ts";

function incrementMemoriesSince(profilePath: string, count: number): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, L3_CURSOR_FILE);
	const cursor = loadL3Cursor(profilePath);
	cursor.memoriesSinceLastPersona = cursor.memoriesSinceLastPersona + count;
	writeFileSync(filePath, JSON.stringify(cursor, null, 2), "utf-8");
}

/** 熔断提示文案（notify 与卡片共用，避免两处漂移）。 */
function l3CoolDownMessage(failures: number): string {
	return `L3 画像连续失败 ${failures} 次，已暂停自动更新。用 /my-memory:l3-trigger 手动重试或检查日志。`;
}

/**
 * 读取提议稿原文的条目列表（temp 存在 = temp，否则 = live USER.md；解析失败按空处理：
 * 比对失败不得影响 L3 队列本身）。
 *
 * 为什么跑前跑后都用"提议稿原文"而不是播种形态（live ∪ temp 独有）：卡片要回答的是
 * "这次 run 把写入稿改成了什么样"。播种发生在**首次写盘时**，用原文口径取两次快照就正好
 * 覆盖住它；若跑前取播种形态，用户手工放进 temp 的候选会被算成 L3 的新增（跑前看到的是并集、
 * 跑后看到的是原文，两边基准不一致还会把"这一轮什么都没干"显示成一次删改）。
 */
function readProposalEntries(profilePath: string): string[] {
	try {
		return readL3Proposal(profilePath).entries;
	} catch {
		return [];
	}
}

/**
 * 输出一张“画像提议”卡片（L3 是本系统里唯一会改**用户画像**的一层，提了什么必须可见）。
 *
 * 为什么在主进程算而不是让子代理上报：L3 在**独立进程**里跑，子代理的 `appendEntry`
 * 只会写进它自己的 session，用户看不到（跨进程卡片本可走 notices.jsonl，但改动点只有一处，
 * 主进程 spawn 前后各读一次提议稿更直接，也能顺手处理“本轮什么都没改”）。
 *
 * 为什么是"提议"：2026-09-28 起 L3 写 `USER-temp.md`，live `USER.md` 由用户手工并入
 * ⇒ 卡片必须说清"这些改动还没生效"，否则用户会以为画像已经变了。
 *
 * 口径说明：集合比对，**同一位置的改写会同时计入新增与删除**（比如改一条 = +1/-1），
 * 不做逐条相似度匹配——那个成本远高于它带来的信息量。
 *
 * @param before spawn 前的提议稿条目快照
 * @param after  子代理提交后的提议稿条目快照
 */
function reportProposalDiff(before: string[], after: string[]): void {
	const beforeSet = new Set(before);
	const afterSet = new Set(after);
	const added = after.filter((e) => !beforeSet.has(e));
	const removed = before.filter((e) => !afterSet.has(e));
	const cut = (s: string, n = 56) => (s.length > n ? `${s.slice(0, n)}…` : s);

	if (added.length === 0 && removed.length === 0) {
		noticeCard({
			level: "info",
			title: "画像本轮无改动（L3 已跑完）",
			lines: [`提议稿（${USER_TEMP_FILE}）条目数 ${after.length}，与跑前一致`],
		});
		return;
	}

	const lines: string[] = [
		`条目数 ${before.length} → ${after.length}`,
		`写入 ${USER_TEMP_FILE}；live USER.md 未动，确认后手工并入`,
	];
	for (const e of added.slice(0, 3)) lines.push(`＋ ${cut(e)}`);
	if (added.length > 3) lines.push(`＋ …另 ${added.length - 3} 条`);
	for (const e of removed.slice(0, 3)) lines.push(`－ ${cut(e)}`);
	if (removed.length > 3) lines.push(`－ …另 ${removed.length - 3} 条`);

	const detail = [
		`提议稿：${USER_TEMP_FILE}（live USER.md 未被 L3 修改，并入由用户手工完成）`,
		`新增/改写 ${added.length} 条：`,
		...added.map((e) => `＋ ${e}`),
		"",
		`删除 ${removed.length} 条：`,
		...removed.map((e) => `－ ${e}`),
	].join("\n");

	noticeCard({
		level: "info",
		title: `画像提议（待并入 USER.md）：＋${added.length} / －${removed.length}`,
		lines,
		detail,
	});
}

export interface L3Controls {
	onL1Committed: (recordCount: number) => void;
	triggerManual: (ctx?: ExtensionContext) => void | Promise<void>;
	reset: () => void;
	executeJob: (ctx: ExtensionContext, job: PipelineJob) => Promise<PipelineJobResult>;
	isCooledDown: () => boolean;
}

/**
 * 注册 L3 persona 调度（单次调用，**只会在主进程执行**）。
 *
 * ── 2026-09-19：并入串行执行器（用户要求"L1–L3 全部交给串行执行器，同一时刻只有一个子代理"）
 *
 * 改动前 L3 是三层里唯一不排队的：主进程在 `agent_settled` 自行 `runPiSubagent`，用
 * `l3/run.lock` 文件锁单飞、靠后续 settle 观察游标推进来结算。那套能挡住并发，但**只挡 L3 自己** ——
 * 它挡不住 L3 与 L1/L2 重叠（同一时刻可能一个 L1 在啃 L0、一个 L3 在写 USER-temp.md）。
 *
 * 现在 L3 是 `pipeline/jobs.sqlite` 的第三种 job（`type='l3'`）：
 *   · 本模块只负责**触发判定**（五级门控）与**入队**，不再直接 spawn；
 *   · 由 worker 串行 claim/执行，`hasAnyRunning()` 保证跨进程/跨层单飞；
 *   · 真完成信号 = 子代理 `l3_commit` 里的 `completeRunningL3()`（与 L1/L2 同款，
 *     取代"主进程观察游标"——那是 `async:true` 时代没有队列时的替代品）；
 *   · 排队优先级最低（`jobs-db.listQueued` 的排序）：L3 的输入是 L1/L2 的产物，不该插队到积压前面。
 *
 * 于是 `l3/run.lock` 退役（`run-lock.ts` 已删）：队列的 running 状态就是那个跨进程真闸。
 *
 * ── 触发链路（两条通道，都不依赖跨进程闭包）
 *
 * 历史坑：旧实现只有 `registerL2CommitTool` 的 `onCommitted` → `onL2Committed` → `queueTrigger`
 * 一条通道，但那个回调在 **l2-scene-organizer 子代理进程**里求值，而本函数位于 `index.ts` 的
 * `PI_SUBAGENT_CHILD` 早退**之后** —— 子代理进程里恒为 undefined，静默 no-op
 * （实测 46/46 次 `l2_commit` 全在子代理进程 ⇒ 自动触发一次都没生效过）。
 *   1. **台账式评估**：主进程每次 `agent_settled` 都调一次 `queueTrigger({})`，
 *      是否真跑完全交给 `evaluateTrigger` 的五级门控（P1–P4 + 增量跳过）。无状态、不怕重启。
 *   2. **显式信号落盘**：子代理的 `personaSignal` 写 `l3/pending-trigger.json`，主进程读取后消费
 *      （读后即删）——保住 `l2-scene-organizer.md` 里那条此前永远无效的 P1 指令。
 *
 * 副作用与配套：熔断复用 `failure-state.ts` 的 l3 层（`L3_FAILURE_THRESHOLD`），
 * 由 `executeJob` 在队列侧记账；成功口径与 L1/L2 一致（跑完但没提交也算失败）。
 */
export function setupL3Persona(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
	pipeline: PipelineWorker,
): L3Controls {
	function logSkip(reason: string): void {
		// 静默是曾经最难查的根因之一：触发没发生却查不到原因，只能翻会话日志。
		// 2026-09-19 改道：这条每 turn 都会命中（五级门控大多数轮次不满足），
		// 属“用户不需要即时知道”的高频观测 → 只落文件。
		logEvent("l3", `未触发：${reason}`, getProfilePath());
	}

	function loadL3State(): LayerFailureState {
		const p = getProfilePath();
		return p ? loadFailureState(p).l3 : { consecutiveFailures: 0, cooledDown: false };
	}
	function saveL3State(s: LayerFailureState): void {
		const p = getProfilePath();
		if (!p) return;
		const all = loadFailureState(p);
		all.l3 = s;
		saveFailureState(p, all);
	}

	/** 熔断/失败记账（与 L1/L2 同款：连败 3 次自动暂停，手动触发可复位）。 */
	function recordFailure(ctx: ExtensionContext, detail: string): void {
		const st = loadL3State();
		st.consecutiveFailures++;
		logEvent("l3", `persona failed (${st.consecutiveFailures}/${L3_FAILURE_THRESHOLD}): ${detail}`, getProfilePath());
		noticeCard({
			level: "warning",
			title: "L3 画像更新失败",
			lines: [`连续失败 ${st.consecutiveFailures}/${L3_FAILURE_THRESHOLD}`, detail.slice(0, 80)],
			detail,
		});
		if (st.consecutiveFailures >= L3_FAILURE_THRESHOLD && !st.cooledDown) {
			st.cooledDown = true;
			ctx.ui.notify(l3CoolDownMessage(st.consecutiveFailures), "error");
		}
		saveL3State(st);
	}

	function recordSuccess(): void {
		const st = loadL3State();
		if (st.consecutiveFailures === 0 && !st.cooledDown) return;
		st.consecutiveFailures = 0;
		st.cooledDown = false;
		saveL3State(st);
	}

	/**
	 * 队列侧的 L3 执行器：由 pipeline worker 串行调用（同一时刻全队列只有它一个）。
	 *
	 * 门控在 **claim 时**重估一次，而不是沿用入队时的结论：job 可能排在队尾等了很久，
	 * 期间场景块/游标都可能已经变（例如前一个 L2 刚提交、或另一轮 L3 已把画像更新过）。
	 */
	async function executeJob(ctx: ExtensionContext, job: PipelineJob): Promise<PipelineJobResult> {
		const profilePath = getProfilePath();
		if (!profilePath) return "failed";

		const forced = job.source === "manual";
		// 来源即意图：`signal` 是 P1（l2_commit 的显式请求），必须在 claim 时还原成 personaSignal。
		// 少了这一句，重估只剩 P2–P4，信号会在 5ms 内被降级成 skipped（实测 job 51）。
		const signaled = job.source === "signal";
		const gate = evaluateTrigger(
			profilePath,
			forced
				? { force: true, personaReason: "手动 l3-trigger" }
				: signaled
					? { personaSignal: true, personaReason: "L2 personaSignal 显式请求" }
					: {},
		);
		if (!gate.should) {
			logEvent("l3", `入队但 claim 时门控已不成立，跳过：${gate.reason || "五级门控未命中"}`, profilePath);
			return "skipped";
		}
		const task = buildL3Task(profilePath, gate.reason, gate.changedScenes);
		if (!task) {
			logEvent("l3", "无场景可读（scene_index 为空），跳过", profilePath);
			return "skipped";
		}

		// 提议稿快照（跑前）：子代理跑完后比对，用于“提了什么”卡片（见 reportProposalDiff）
		const userEntriesBefore = readProposalEntries(profilePath);

		const cursor = loadL3Cursor(profilePath);
		saveL3Cursor(profilePath, { ...cursor, lastTriggeredAt: new Date().toISOString() });

		const db = getPipelineJobsDB(profilePath);
		ctx.ui.setStatus("memory", forced ? "Memory ⚙L3 (manual)..." : "Memory ⚙L3...");
		// 与 L1/L2 同款：真完成信号来自子代理的 `l3_commit`（completeRunningL3），
		// **不是** `await runPiSubagent` 的返回 —— 那是 async:true 的 fire-and-forget，毫秒级返回。
		// 2026-09-26（SUBAGENT_LIVENESS_FIX）：软阈值只提示、硬上限**停掉子代理**（旧实现到点判死 + abort 会误判）。
		const stopHeartbeat = startHeartbeat({
			layer: "l3",
			jobId: job.id,
			profilePath,
			// 心跳在派发之前就启动，pid 那时还没有 —— 从运行记录惰性取
			getPid: () => readSubagentRun(profilePath, "l3", job.id)?.pid,
			onTick: (info) =>
				ctx.ui.setStatus(
					"memory",
					`Memory ⚙L3 ${(info.elapsedMs / 60000).toFixed(1)}m（子代理 ${info.alive === undefined ? "派发中" : info.alive ? "存活" : "已退出"}）`,
				),
		});
		// 阈值来自配置中心 `subagent` 节（实测单轮生成可达 987s，硬上限要能边跑边调）

		const to = loadSubagentTimeouts(profilePath);
		const waitP = waitJobWithLiveness(() => db.getJob(job.id), {
				softMs: to.softMs,
				hardMs: to.hardMs,
			profilePath,
			layer: "l3",
			jobId: job.id,
		});
		try {
			const spawnP = runPiSubagent("l3-persona-generator", task, ctx, {
				profilePath,
				layer: "l3",
				jobId: job.id,
				// 早死检测：子进程非 0 退出且 job 仍 running ⇒ 立刻标 failed（详见 l1 同名注释）
				onEarlyExit: (info) => {
					if (db.getJob(job.id)?.status !== "running") return;
					const why = `子进程异常退出（code=${info.code}, signal=${info.signal ?? "-"}, pid=${info.pid}）`;
					db.complete(job.id, "failed", why);
					logEvent("l3", `job ${job.id} ${why} ⇒ 立即标 failed，不再等硬上限`, profilePath);
				},
			});
			// 派发失败立刻进 catch 释放 job，不干等活性门控（详见 failFastOnSpawnFailure 头注释）
			const outcome = await failFastOnSpawnFailure(spawnP, waitP, (err) => {
				logEvent("l3", `spawn later: ${err instanceof Error ? err.message : String(err)}`, profilePath);
			});

			const after = db.getJob(job.id);
			if (after?.status === "done") {
				recordSuccess();
				logEvent(
					"l3",
					`本轮完成（job ${job.id}，${gate.reason}，${(outcome.elapsedMs / 1000).toFixed(0)}s` +
						`${outcome.longestTurnMs !== undefined ? `，最长单轮 ${(outcome.longestTurnMs / 1000).toFixed(0)}s` : ""}）`,
					profilePath,
				);
				// 画像提议卡片：这是本系统唯一会改用户画像的层，提了什么必须可见
				//（2026-09-19 之前完全静默：连“跑完了没改任何东西”都无从得知）。
				reportProposalDiff(userEntriesBefore, readProposalEntries(profilePath));
				return "done";
			}
			if (after?.status === "skipped") {
				await spawnP.catch(() => {});
				return "skipped";
			}
			// 到硬上限仍是 running ⇒ 停掉子代理（先拦 → 宽限 → 杀进程树 → 杀后修复）
			const stop = await stopSubagent({
				graceMs: to.killGraceMs,
				profilePath,
				layer: "l3",
				jobId: job.id,
				reason: `L3 超过硬上限（${(to.hardMs / 60000).toFixed(0)} 分钟）未提交`,
			});
			await spawnP.catch(() => {});
			db.complete(job.id, "failed", stop.killConfirmed ? "killed at hard cap" : "hard cap: stop unconfirmed");
			recordFailure(ctx, `子代理超过硬上限被停掉（job ${job.id}）`);
			if (!stop.killConfirmed) {
				// 停不下来就不能放新 L3 进来（它会写 USER-temp.md，而停不下来的那个还在写同一份文件）⇒ 持有该层
				const st3 = loadFailureState(profilePath);
				st3.l3.holdUntil = holdUntilFrom(Date.now(), to.holdMsUnconfirmed);
				saveFailureState(profilePath, st3);
			}
			logEvent("l3", `round stopped at hard cap (job ${job.id}，${stop.note})`, profilePath);
			noticeCard({
				level: "warning",
				title: "L3 画像更新已在硬上限被停掉",
				lines: [
					`job ${job.id}（来源 ${job.source}）超过 ${(to.hardMs / 60000).toFixed(0)} 分钟未提交，已停止子代理`,
					stop.killConfirmed
						? `live USER.md 未被触碰（L3 只写 ${USER_TEMP_FILE}，原子写 + 每轮备份）`
						: `**未能确认停止**，本层已持有，暂不接受新任务`,
				],
				detail: `${stop.note}\n进程内日志：memoryDB/logs/l3.log`,
			});
			return "failed";
		} catch (err) {
			recordFailure(ctx, `派发失败：${err instanceof Error ? err.message : String(err)}`);
			const still = db.getJob(job.id);
			if (still?.status === "running") db.complete(job.id, "failed", err instanceof Error ? err.message : String(err));
			return "failed";
		} finally {
			stopHeartbeat();
			ctx.ui.setStatus("memory", "Memory");
		}
	}

	/** 门控 → 入队。**不 spawn**：谁来跑由串行执行器决定。 */
	function queueTrigger(opts: { personaSignal?: boolean; personaReason?: string; force?: boolean } = {}): void {
		const profilePath = getProfilePath();
		if (!profilePath) return;

		const st = loadFailureState(profilePath);
		if (st.l3.cooledDown && !opts.force) {
			logSkip(`已熔断（连续失败 ${st.l3.consecutiveFailures} 次），用 /my-memory:l3-trigger 手动重试`);
			return;
		}

		const result = evaluateTrigger(profilePath, opts);
		if (!result.should) {
			logSkip(result.reason || "五级门控未命中");
			return;
		}

		// 去重靠队列本身：同 type 已有 queued/running 时不堆第二条（重复触发 = 两个子代理交错写同一份提议稿）
		// source 要带上意图：executeJob 在 claim 时会照 source 还原 force / personaSignal（见那里的注释）
		const queued = pipeline.enqueueL3(opts.force ? "manual" : opts.personaSignal ? "signal" : "trigger");
		if (!queued) {
			// 队列不可用（无 profile / sqlite 打不开）→ 宁可少跑一轮，也不要绕过串行器直接 spawn
			logSkip("入队失败（队列不可用）");
			return;
		}
		if (queued.duplicate) {
			logSkip("队列里已有 L3（queued/running），本次触发合并");
			return;
		}
		// 触发时刻先记账：`lastTriggeredAt` 只用于可观测性，真正的推进在 l3_commit 里
		saveL3Cursor(profilePath, { ...loadL3Cursor(profilePath), lastTriggeredAt: new Date().toISOString() });
		logEvent("l3", `已入队（job ${queued.id}，${result.reason}）`, profilePath);
		pipeline.kick();
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

	function triggerManual(ctx?: ExtensionContext): void {
		const profilePath = getProfilePath();
		if (!profilePath) {
			if (ctx) ctx.ui.notify("L3 调度器未初始化（缺少有效 profile）", "error");
			return;
		}
		try {
			const db = getPipelineJobsDB(profilePath);
			const verdict = decideManualTrigger({
				hasActive: db.hasActive("l3"),
				queuedOfType: db.listQueued().some((j) => j.type === "l3"),
				cooledDown: loadL3State().cooledDown,
			});
			if (verdict === "refuse-busy") {
				if (ctx) ctx.ui.notify("L3 画像已在队列或运行中", "warning");
				return;
			}
			if (verdict === "unpause-queued") {
				// 队列里那条 L3 正被熔断按着：复位熔断 + kick（不排第二条）
				const st0 = loadL3State();
				st0.cooledDown = false;
				st0.consecutiveFailures = 0;
				saveL3State(st0);
				if (ctx) pipeline.setCachedCtx(ctx);
				pipeline.kick();
				logEvent("l3", "手动触发：复位熔断，队列中的 job 将执行", profilePath);
				if (ctx) ctx.ui.notify("L3 已复位熔断，排队中的任务将执行", "info");
				return;
			}
		} catch {
			// continue to enqueue
		}
		// 手动触发复位熔断 + 强制跑（P1）
		const st = loadL3State();
		st.cooledDown = false;
		st.consecutiveFailures = 0;
		saveL3State(st);
		if (ctx) pipeline.setCachedCtx(ctx);
		queueTrigger({ force: true, personaReason: "手动 l3-trigger" });
	}

	pi.on("agent_settled", (_e, ctx) => {
		// ctx 由 worker 缓存（它自己也在 agent_settled 里 setCachedCtx），本模块不再持有一份：
		// 曾经持有是为了直接 spawn，现在 spawn 归 worker。
		pipeline.setCachedCtx(ctx);
		const profilePath = getProfilePath();
		if (!profilePath) return;
		// 通道 2：消费子代理落盘的显式信号（读后即删 ⇒ 一个信号只生效一次）
		const signal = consumePendingTrigger(profilePath);
		// 通道 1：每轮台账式评估（无状态；跑不跑由 evaluateTrigger + 队列去重决定）
		queueTrigger(signal?.personaSignal ? { personaSignal: true, personaReason: signal.personaReason } : {});
	});

	return {
		onL1Committed,
		triggerManual,
		executeJob,
		isCooledDown: () => loadL3State().cooledDown,
		reset: () => {
			// 队列与 worker 由 pipeline.reset 处理。这里**什么都不做**，尤其不碰 sqlite 的
			// running 状态：`/reload` 不该杀掉正在跑的那一轮，也不该让新实例以为没人在跑
			//（那正是 2026-09-16 三个并发 L3 事故的成因）。
		},
	};
}
