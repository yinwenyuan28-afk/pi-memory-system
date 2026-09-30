/**
 * 会话级项目归属判定的**主进程挂点**
 *
 * ── 为什么单独一个文件（偏离计划的一处，已记录）──
 *
 * 计划把 `setupJudgSessionProject` 放进 `util/judg-session-project/index.ts`，但同一条任务 1
 * 要求读写层「**不 import 需要 ctx 的东西**」。两者会打架：挂点必须 import `ExtensionAPI`
 * 与 `config/model-config`（它静态拉 pi-ai compat）。所以拆成两个文件：
 * `index.ts` = 纯读写 + `isUnder`（零 pi 依赖，可离线跑）；本文件 = 挂点。
 *
 * ── 挂点位置（这是最容易做错、后果最静默的一处）──
 *
 * `index.ts:382` 的 `if (process.env.PI_SUBAGENT_CHILD === "1") return;` 在 **`session_start`
 * 回调体内**，而全文件只在那一处做过早退。所以本函数必须**在 `:382` 之后**被调用
 * （与 `:462 setupL1Extractor` 同一段），子代理进程里它根本不会被调用 ——
 * 参照物是 `memory/l1/index.ts:68` 那个 `agent_settled`，它就是靠这个机制避开子代理的。
 *
 * ⚠ 反过来写（自己新 `pi.on("agent_settled")` 且**不**带守卫）会让子代理每轮都跑判定：
 *   sessionKey 恒为 `"session"`、每轮白发一次 LLM 请求、还会往子代理的 profile 里写条目。
 *   本文件里的 `PI_SUBAGENT_CHILD` 早退是**第二道**防线（第一道是调用点），留着是因为
 *   将来有人把调用点挪到守卫之前时，症状会静默到难以归因。
 *
 * ── 每轮做什么 ──
 *
 *   ① 建条目（仅当不存在）→ ② 抽候选（纯代码，只读会话文件）
 *   → ③ 变化检测（候选与上轮 evidence 相同就不发请求）
 *   → ④ 按 sessionKey 分键的单飞 + fire-and-forget（不 await，不阻塞 event handler）
 *   → ⑤ 兜底：距上次成功判定 ≥ 20 轮时无条件重判一次
 *
 * ⑤ 的理由：变化检测只在"候选变了"时触发，而一个会话可能**连续十几轮都不碰文件**
 * （一直在讨论方案），那样判定就永远停在初值。实测单轮生成期间 `session.jsonl`
 * 一个字节都不涨，所以"没变化"不等于"没进展"。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { extractCandidates, topShare } from "./candidates.ts";
import { judgeProject } from "./llm.ts";
import { ensureSessionEntry, evidenceUnchanged, upsertSessionJudg, type Evidence } from "./index.ts";
import { readConfig } from "../../config/model-config.ts";
import { logEvent } from "../notice.ts";

/** 距离上次成功判定多少轮后，无条件重判一次（兜底，见文件头 ⑤）。 */
export const REJUDGE_EVERY_ROUNDS = 20;

/** 在飞判定的 sessionKey 集合上限，防止无界增长（B19）。 */
const MAX_INFLIGHT = 64;

/** 从 session 文件路径取 sessionKey（文件名去掉 `.jsonl`）。 */
export function sessionKeyOf(sessionFile: string): string {
	return sessionFile.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/, "") ?? "";
}

/** 读会话文件头第一行的 `cwd`（建条目要用的启动目录）；读不到返回空串。 */
export function readSessionCwd(sessionFile: string): string {
	try {
		const first = readFileSync(sessionFile, "utf-8").split("\n", 1)[0];
		const o = JSON.parse(first) as { cwd?: unknown };
		return typeof o.cwd === "string" ? o.cwd : "";
	} catch {
		return "";
	}
}

/**
 * 注册判定挂点。**必须在 `index.ts:382` 的 `PI_SUBAGENT_CHILD` 早退之后调用。**
 *
 * @param pi              pi 扩展 API
 * @param getProfilePath  取当前 profile 路径（与其它 setup* 同一份）
 */
export function setupJudgSessionProject(pi: ExtensionAPI, getProfilePath: () => string | undefined): void {
	// B19：**按 sessionKey 分键**，不是全局一个布尔 —— `sendCustomMessage({triggerTurn:true})`
	// 也会触发 `agent_settled`，同进程两个回调可能交错，全局布尔会静默吞掉第二个会话的判定。
	const inFlight = new Set<string>();
	/** 上次成功判定之后又过了几轮（每 sessionKey 一个）。 */
	const roundsSinceSuccess = new Map<string, number>();
	/** 上一轮判定失败的 sessionKey ⇒ 下一轮**强制重试**，无视变化检测（B1）。 */
	const failedLastRound = new Set<string>();

	pi.on("agent_settled", async (_event, ctx) => {
		// 第二道防线（第一道是调用点在 index.ts:382 之后）。见文件头。
		if (process.env.PI_SUBAGENT_CHILD === "1") return;

		const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined)?.sessionManager;
		let sessionFile: string | undefined;
		try {
			sessionFile = sm?.getSessionFile?.();
		} catch {
			return;
		}
		if (!sessionFile) return; // B8：不做 join(undefined, …)
		const sessionKey = sessionKeyOf(sessionFile);
		if (!sessionKey) return;
		// profilePath 取**触发时刻**的值并一路带下去（B23：不读 process.env.PI_PROFILE_PATH）
		const profilePath = getProfilePath();
		if (!profilePath) return;

		if (inFlight.has(sessionKey)) return; // B2
		const rounds = (roundsSinceSuccess.get(sessionKey) ?? 0) + 1;
		roundsSinceSuccess.set(sessionKey, rounds);

		// ① 建条目（仅当不存在）
		let entry = ensureSessionEntry(profilePath, sessionKey, (ctx as { cwd?: string } | undefined)?.cwd ?? "");

		// ② 候选提取（纯代码，失败返回空结果而不是抛）
		let x: ReturnType<typeof extractCandidates>;
		try {
			x = extractCandidates(sessionFile);
		} catch (err) {
			logEvent("judg", `候选提取失败：${err instanceof Error ? err.message : String(err)}`, profilePath);
			return;
		}

		// ③ 变化检测（两边都归一化后比集合，B24）
		const nowPaths = x.candidates.map((c) => c.path);
		const forced = failedLastRound.has(sessionKey);
		if (!forced && rounds < REJUDGE_EVERY_ROUNDS && evidenceUnchanged(entry?.evidence, nowPaths)) {
			return; // 候选没变 ⇒ 不发任何请求
		}

		// ④ 单飞 + fire-and-forget：**不 await**，不阻塞 event handler
		if (inFlight.size >= MAX_INFLIGHT) return;
		inFlight.add(sessionKey);
		void (async () => {
			try {
				const model = await resolveModelForProfile(profilePath, ctx);
				const r = await judgeProject(model.model, x, { apiKey: model.apiKey });
				if (!r.ok) {
					// B1：失败**不写盘**、保留 flag 原值，记 __lastFailed 强制下一轮重试
					failedLastRound.add(sessionKey);
					logEvent("judg", `判定失败（保留原值，下一轮重试）：${r.error ?? "未知"} | session=${sessionKey}`, profilePath);
					return;
				}
				failedLastRound.delete(sessionKey);
				roundsSinceSuccess.set(sessionKey, 0);
				if (!persistJudgement(profilePath, sessionKey, entry, x, r)) {
					logEvent("judg", `判定结果写盘失败：session=${sessionKey}`, profilePath);
				}
			} catch (err) {
				failedLastRound.add(sessionKey);
				logEvent("judg", `判定异常（fail-open）：${err instanceof Error ? err.message : String(err)} | session=${sessionKey}`, profilePath);
			} finally {
				inFlight.delete(sessionKey);
			}
		})();
	});
}

// ══════════════════════════════════════════════════════════════
//  可复用件（运行时与离线回填共用同一条代码路径）
// ══════════════════════════════════════════════════════════════

/**
 * 解析判定要用的模型与 key。
 *
 * 生产路径走 `ctx.modelRegistry`（models.json 里的自定义 provider 只有它能解析），
 * 拿不到 key 时返回 `undefined` —— `callLLM` 会回落到 pi-ai 的环境变量查找。
 */
export async function resolveModelForProfile(
	profilePath: string,
	ctx?: unknown,
): Promise<{ model: unknown; apiKey?: string }> {
	// 惰性导入：model-config 静态拉 pi-ai compat，那是 CJS 下没有 require 条件的包
	const { resolveConfiguredModel } = await import("../../config/model-config.ts");
	const c = ctx as { model?: unknown; modelRegistry?: unknown } | undefined;
	const registry = c?.modelRegistry as
		| { find?: (p: string, m: string) => unknown; getApiKeyForProvider?: (p: string) => string | undefined }
		| undefined;
	const model = resolveConfiguredModel(profilePath, c?.model, registry);
	const provider = readConfig(profilePath)?.provider;
	const apiKey = provider && typeof registry?.getApiKeyForProvider === "function" ? registry.getApiKeyForProvider(provider) : undefined;
	return { model, apiKey };
}

/**
 * 把一次判定结果落盘。**运行时与离线回填共用** —— 回填脚本如果另写一份写盘逻辑，
 * 迟早会和线上行为漂移（`decidedBy` / `confidence` / `evidence` 的口径悄悄分叉）。
 *
 * @param entry  建条目阶段拿到的那条（判成 unknown 时要沿用它的 project 占位值）
 * @returns 写入后的条目；写失败返回 null（调用方负责记日志）
 */
export function persistJudgement(
	profilePath: string,
	sessionKey: string,
	entry: { project?: string } | null,
	x: ReturnType<typeof extractCandidates>,
	r: { project: string | null },
): ReturnType<typeof upsertSessionJudg> {
	const evidence: Evidence[] = x.candidates.map((c) => ({ path: c.path, filesTouched: c.files }));
	return upsertSessionJudg(profilePath, sessionKey, {
		// project 为 null（判成 unknown）⇒ 保留建条目时的启动目录，但 flag:false
		project: r.project ?? entry?.project ?? "",
		flag: !!r.project,
		// 判成「无」时 decidedBy 记 code：它本来就是"代码手里什么都没有、不必问模型"那条路
		// （judgeProject 对空证据直接短路返回），标 llm 会让人误以为真问过
		decidedBy: r.project ? "llm" : "code",
		confidence: topShare(x.candidates),
		evidence,
	});
}

/**
 * 判一个会话并落盘（离线回填脚本的入口；运行时不走这里，走上面带单飞/变化检测的版本）。
 *
 * @param sessionKey 会话 key（文件名去掉 `.jsonl`）
 * @param sessionFile 会话 jsonl 绝对路径
 * @param sessionCwd  建条目用的启动目录（会话头第一行的 `cwd`）
 */
export async function judgeAndPersist(
	profilePath: string,
	sessionKey: string,
	sessionFile: string,
	sessionCwd: string,
	model: unknown,
	apiKey?: string,
): Promise<{
	ok: boolean;
	/** **判定结论**：判出的项目目录；判成「无项目」或失败时为 `null`（与 `judgeProject` 同语义）。 */
	judgedProject: string | null;
	/** **落盘结果**：写进去的完整条目。`judgedProject` 为 null 时它的 `project` 是占位值（启动目录）。 */
	entry: ReturnType<typeof upsertSessionJudg>;
	flag: boolean;
	reason: string | null;
	error: string | null;
}> {
	const entry = ensureSessionEntry(profilePath, sessionKey, sessionCwd);
	let x: ReturnType<typeof extractCandidates>;
	try {
		x = extractCandidates(sessionFile);
	} catch (err) {
		return { ok: false, judgedProject: null, entry: null, flag: false, reason: null, error: `候选提取失败：${err instanceof Error ? err.message : String(err)}` };
	}
	const r = await judgeProject(model, x, { apiKey });
	if (!r.ok) {
		logEvent("judg", `回填判定失败（保留初值）：${r.error ?? "未知"} | session=${sessionKey}`, profilePath);
		return { ok: false, judgedProject: null, entry: null, flag: false, reason: null, error: r.error };
	}
	const written = persistJudgement(profilePath, sessionKey, entry, x, r);
	if (!written) return { ok: false, judgedProject: null, entry: null, flag: false, reason: null, error: "写盘失败" };
	return { ok: true, judgedProject: r.project, entry: written, flag: written.flag, reason: r.reason, error: null };
}

