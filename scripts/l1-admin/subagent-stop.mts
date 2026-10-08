// subagent-stop.mts —— 手动停掉某层后台子代理（查看器写盘桥 + 人工运维）
//
// 与 `/my-memory:subagent-kill` **同一套序列**（index.ts:1330）：
//   ① 从本扩展自己的运行记录里找目标（`state/subagent-run-<layer>-<jobId>.json`；不指定 job 就取该层最近一条）
//   ② `stopSubagent({skipGrace:true})`：落停止标记 → 杀进程树 → 确认已死 → 杀后修复
//   ③ 没确认死 ⇒ 按 `holdMsUnconfirmed` 持有该层（不让新任务与残留写者并存）
//   ④ L2 额外挂 `rebuildSceneIndex` / `repairSceneMembers` 两个杀后修复钩子（场景索引是子代理独占写的）
//
// 为什么要留这个人工口子（命令注释里的原话）：自动判定分不清"一次超长生成"与"真卡死"
// （实测 987 秒的单轮生成），而人知道上下文 —— 网关刚挂了、我已经等了四十分钟。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/subagent-stop.mts --layer l1|l2|l3 [--job N] [--reason "…"] [--profile <dir>]
// 停止是不可逆的（子代理被杀，本批未提交 ⇒ 游标不推进，下一轮重做），因此**没有 dry-run**：
// 本脚本要么停，要么报"没有在跑的子代理"。查询在跑哪些用 `--list`。
import { finish, flagValue, hasFlag, positionals, profileArg, run, usageError } from "./viewer-cli.mts";
import { listSubagentRuns, readSubagentRun, type SubagentRunRecord } from "../../memory/pipeline/subagent-runs.ts";
import { stopSubagent } from "../../memory/pipeline/subagent-kill.ts";
import { holdUntilFrom, loadFailureState, saveFailureState } from "../../memory/failure-state.ts";
import { loadSubagentTimeouts } from "../../memory/pipeline/timeout-config.ts";
import { repairSceneMembers, syncSceneIndex } from "../../memory/l2/commit-tool.ts";
import { logEvent } from "../../util/notice.ts";

const USAGE =
	'node --experimental-strip-types scripts/l1-admin/subagent-stop.mts --layer l1|l2|l3 [--job N] [--reason "…"] ' +
	"[--profile <dir>] ｜ --list";

/** 运行记录里对界面有用的那几列（stdoutPath/stderrPath 给"看日志"用）。 */
function summarize(r: SubagentRunRecord): Record<string, unknown> {
	return { layer: r.layer, jobId: r.jobId, pid: r.pid, agent: r.agent, startedAt: r.startedAt, runId: r.runId };
}

run(async () => {
	const profilePath = profileArg();
	if (!profilePath) usageError(USAGE);

	if (hasFlag("--list")) {
		finish({ success: true, runs: listSubagentRuns(profilePath).map(summarize) });
	}

	const layer = flagValue("--layer");
	if (layer !== "l1" && layer !== "l2" && layer !== "l3") usageError(USAGE);

	const jobRaw = flagValue("--job");
	const jobHint = jobRaw !== undefined && Number.isFinite(Number(jobRaw)) && Number(jobRaw) > 0 ? Number(jobRaw) : 0;
	const runs: SubagentRunRecord[] = jobHint
		? [readSubagentRun(profilePath, layer, jobHint)].filter((r): r is SubagentRunRecord => Boolean(r))
		: listSubagentRuns(profilePath).filter((r) => r.layer === layer);
	const active = runs.length > 0 ? runs[runs.length - 1] : undefined;

	if (!active) {
		// 这不是失败：没有在跑的子代理是常态。用 success:true + stopped:false 表达，界面上是"提示"而非"报错"。
		finish({
			success: true,
			stopped: false,
			layer,
			jobId: null,
			note: `${layer} 层没有本扩展的运行记录（没有正在跑的子代理）。要看全部：--list`,
		});
	}

	const jobId = jobHint || active.jobId;
	const outcome = await stopSubagent({
		profilePath,
		layer,
		jobId,
		reason: flagValue("--reason") ?? "手动停止（查看器）",
		skipGrace: true,
		hooks: layer === "l2" ? { rebuildSceneIndex: syncSceneIndex, repairSceneMembers } : undefined,
	});
	if (!outcome.killConfirmed) {
		const st = loadFailureState(profilePath);
		st[layer].holdUntil = holdUntilFrom(Date.now(), loadSubagentTimeouts(profilePath).holdMsUnconfirmed);
		saveFailureState(profilePath, st);
	}
	logEvent("pipeline", `查看器停止 ${layer}（job ${jobId}）：${outcome.note}`, profilePath);
	finish({
		success: true,
		stopped: outcome.killAttempted,
		layer,
		jobId,
		pid: outcome.pid ?? null,
		killConfirmed: outcome.killConfirmed,
		note: outcome.killConfirmed
			? `${layer} 子代理已停掉，杀后修复已完成。本批未提交 ⇒ 游标未推进，下一轮会重做。`
			: `未能确认停止：${outcome.note} —— 该层已被持有（在确认停止前不接受新任务）`,
	});
});
