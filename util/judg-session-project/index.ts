/**
 * 会话级项目归属的读写层（`{profilePath}/memoryDB/state/judg-session-project.json`）
 *
 * ── 这个文件是什么 ──
 *
 * 每个**正在使用的会话**一条记录，回答「这段会话实际在哪个项目目录上干活」。
 * 它的唯一生产者是主进程（`setupJudgSessionProject`），消费方有两个：
 *   ① `l1_commit` —— 记忆的 `cwd` 由它决定（见 `memory/l1/commit-tool.ts`）
 *   ② `l1_project_get` —— L1 提取子代理的只读工具，让它知道自己在哪个项目里
 *
 * ── 设计边界（刻意收窄）──
 *
 *   - **只管这一个文件**。不碰 L1 记录、不碰场景池、不发网络。
 *   - **只存 `project` 一个路径**。`scope` 是**每条记忆**的属性（`metadata.scope`），
 *     挂在会话上表达不了 —— 同一个会话里既有「只关于 A104527 接口」的记忆、
 *     也有「整个 wangxin 提交流程」的记忆。见计划「scope 的归属重构」。
 *   - **profile 路径一律由入参 `profilePath` 决定**，代码里不读 `process.env.PI_PROFILE_PATH`。
 *     fire-and-forget 的判定持有**触发时刻**的 profilePath，而消费侧用**调用时刻**的；
 *     两边都靠入参传递才不会在 profile 切换时读错文件（B23）。
 *
 * ── 写侧的三条硬规则 ──
 *
 *   1. **原子写**：写 `<同名>.tmp` → `renameSync` 覆盖，失败重试 3 次 / 间隔 50ms。
 *      Windows 上子代理 `readFileSync` 撞上主进程 `renameSync` 时，炸的是**写方**（B17）。
 *   2. **读失败不覆盖**：解析失败直接返回错误，**绝不**用默认值把原文件盖掉。
 *   3. **`evidence` 与 `flag` 无关，一律写本轮候选**。若 `flag:false` 时把 `evidence`
 *      写成 `[]`，下一轮「候选与上轮相同 → 跳过判定」的短路就永远失配 ⇒
 *      **每轮都白发一次 LLM 请求**。这是实现步骤 4 明确要验的一条。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR } from "../../memory/paths.ts";
import { JUDG_SESSION_PROJECT_FILE } from "../../memory/paths.ts";

// ══════════════════════════════════════════════════════════════
//  常量与类型
// ══════════════════════════════════════════════════════════════

/** 文件结构版本。不认识的版本一律当空文件读（不猜、不覆盖）。 */
export const JUDG_VERSION = 3;

/** `evidence` 最多写几条。 */
export const EVIDENCE_LIMIT = 5;

/** 判定是谁做的。**没有 `jev`** —— 决策模型已实测证伪并移出计划。 */
export type DecidedBy = "init" | "code" | "llm" | "manual";

/** 一条候选证据（本轮抽到的路径 + 命中的不同文件数）。 */
export interface Evidence {
	path: string;
	filesTouched: number;
}

/** 单个会话的条目。 */
export interface SessionJudg {
	/** 这个会话实际在哪个**目录**上干活。落盘统一**正斜杠**。非绝对路径拒收。 */
	project: string;
	/** 能不能用。`false` ⇒ 消费方按"未核对"处理，`l1_commit` 退回 `ctx.cwd`。 */
	flag: boolean;
	decidedBy: DecidedBy;
	/**
	 * top 候选的文件占比（0–1）。
	 *
	 * ⚠ 它衡量的是**证据集中度**，不是模型自报的置信度，别当校准过的概率用。
	 * ⚠ LLM 选的**可能不是 top1**（尺子 #20 就是），此时这个值描述的是它**没选**的那条。
	 */
	confidence: number;
	/** 最后一次变更时刻（ISO）。 */
	at: string;
	/**
	 * 本轮候选及各自命中的不同文件数。**兼作变化检测的比对基准**。
	 * 与 `flag` 无关，一律写 —— 见文件头「写侧的三条硬规则」第 3 条。
	 */
	evidence: Evidence[];
}

/** 整份文件。 */
export interface JudgFile {
	version: number;
	updatedAt: string;
	sessions: Record<string, SessionJudg>;
}

// ══════════════════════════════════════════════════════════════
//  路径与归一化
// ══════════════════════════════════════════════════════════════

/** 数据文件绝对路径。 */
export function judgFilePath(profilePath: string): string {
	return join(profilePath, MEMORY_DB_DIR, JUDG_SESSION_PROJECT_FILE);
}

/**
 * `project` 的落盘归一化：去首尾空白与成对引号 → 全部转正斜杠 → 去尾部 `/`。
 * 盘符根（`C:/`）不能被去成 `C:`（那是"当前盘的当前目录"，语义完全不同）。
 *
 * @returns 归一化后的路径；**不是绝对路径时返回 null**（写侧拒收，见 B22）
 */
export function normalizeProjectPath(raw: string): string | null {
	let s = (raw ?? "").trim();
	if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
		s = s.slice(1, -1).trim();
	}
	if (!s) return null;
	s = s.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	if (!/^[A-Za-z]:\//.test(s)) return null; // 非绝对路径（Windows 形态）直接拒
	if (!/^[A-Za-z]:\/?$/.test(s)) s = s.replace(/\/+$/, "");
	return s;
}

/** 变化检测用的比较键：小写 + 正斜杠 + 去尾分隔符（Windows 路径大小写不敏感）。 */
export function projectKey(p: string): string {
	let s = (p ?? "").replace(/\\/g, "/").toLowerCase();
	if (!/^[a-z]:\/?$/.test(s)) s = s.replace(/\/+$/, "");
	return s;
}

// ══════════════════════════════════════════════════════════════
//  「不可能是项目」的路径（用户裁定 2026-09-30）
// ══════════════════════════════════════════════════════════════

/**
 * 家目录（`C:\Users\leaf`）下**点开头**的目录不算在内 —— 它们是用户自己放的配置/工具树，
 * 而这台机器上 agent 工作的真身就在那儿（`.pi` / `.agents` / `.claude` / `.codex` / `.config` …）。
 * 拿掉这个例外就会误伤：分层标注集 20 条里有 **2 条真值是 `users/leaf/.pi`**（#2 / #12），
 * 场景池里家目录下的唯一条目也是 `C:/Users/leaf/.pi`。
 */
const HOME_DOT_PREFIX_EXEMPT = true;



/**
 * 这条路径**不可能是项目根**（用户裁定 2026-09-30：「`C:\Users\leaf` 或者它下面的目录不可能是
 * project，不可能把项目建在桌面」）。
 *
 * **规则**：任意 `C:\Users\<用户名>` 本身，以及它下面**任何非点开头的**一级目录及其所有子目录。
 * 命中的是标准内容目录（`Desktop` / `Documents` / `Downloads` / `Pictures` / `Music` /
 * `OneDrive` / `Saved Games` / `Contacts` / `Favorites` / `Links` / `Searches`）、
 * 工具缓存（`AppData` / `npm-cache`）与各种历史遗留的目录联接（`Application Data` /
 * `My Documents` / `Local Settings` / `Recent` / `SendTo` …）——
 * 没人会把代码仓库建在这些地方，而判定一旦落到它们上面，记忆就会挂到"桌面"去。
 *
 * **⚠ 唯一的例外是点开头的目录**（见 {@link HOME_DOT_PREFIX_EXEMPT}）。这条不是"放水"，
 * 是实测逼出来的：`.pi` 既是标注集里的正确答案（20 条里 2 条），也正是本功能的代码本体所在。
 * 若将来确认 `.pi` 之类也不该算项目，把那个常量改成 `false` 即可，但**必须同步改标注集**
 * （#2 / #12 的真值），否则尺子会立刻红给你看。
 *
 * 判定用 {@link projectKey} 归一化后再比，所以斜杠风格与大小写不同不影响结果。
 * 非绝对路径返回 false —— 那是"形状不合法"，由 {@link normalizeProjectPath} 管，不是这条规则的事。
 *
 * @param p 绝对路径
 */
export function isNotAProjectPath(p: string): boolean {
	const key = projectKey(p);
	if (!key || !/^[a-z]:\//.test(key)) return false;
	const segs = key.split("/"); // ['c:', 'users', 'leaf', …]
	if (segs.length < 3 || segs[1] !== "users") return false;
	if (segs.length === 3) return true; // C:/Users/<name> 本身
	const first = segs[3];
	if (!first) return true;
	if (HOME_DOT_PREFIX_EXEMPT && first.startsWith(".")) return false;
	return true;
}

// ══════════════════════════════════════════════════════════════
//  读
// ══════════════════════════════════════════════════════════════

export type ReadResult =
	| { ok: true; file: JudgFile }
	/** 文件不存在 = 还没写过，按空文件处理（不是错误）。 */
	| { ok: true; file: JudgFile; created: true }
	| { ok: false; error: string };

/** 空文件骨架。 */
export function emptyJudgFile(): JudgFile {
	return { version: JUDG_VERSION, updatedAt: "", sessions: {} };
}

/**
 * 读整份文件。
 *
 * **解析失败返回 `ok:false`，绝不返回空文件** —— 否则调用方会拿空骨架去写，把损坏的
 * 原始数据覆盖掉（数据不可恢复）。子代理侧撞上 rename 窗口时（B6）走这条路。
 */
export function readJudgFile(profilePath: string): ReadResult {
	const file = judgFilePath(profilePath);
	if (!existsSync(file)) return { ok: true, file: emptyJudgFile(), created: true };
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch (e) {
		return { ok: false, error: `读取失败：${(e as Error).message}` };
	}
	let o: unknown;
	try {
		o = JSON.parse(text);
	} catch (e) {
		return { ok: false, error: `JSON 解析失败（原文件未改动）：${(e as Error).message}` };
	}
	if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "根不是对象" };
	const raw = o as { version?: unknown; updatedAt?: unknown; sessions?: unknown };
	if (raw.version !== JUDG_VERSION) {
		// 不写"向后兼容"的空话：版本不认识就当读不了，让上层决定（当前只有 v3）
		return { ok: false, error: `版本不认识：${String(raw.version)}（期望 ${JUDG_VERSION}）` };
	}
	const sessions: Record<string, SessionJudg> = {};
	if (raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
		for (const [k, v] of Object.entries(raw.sessions as Record<string, unknown>)) {
			const e = coerceEntry(v);
			if (e) sessions[k] = e;
			// 单条脏数据不拖垮整份文件：跳过它，其余照常返回
		}
	}
	return { ok: true, file: { version: JUDG_VERSION, updatedAt: String(raw.updatedAt ?? ""), sessions } };
}

/**
 * 把一条原始值收敛成合法的 {@link SessionJudg}；不合法返回 null（调用方跳过这一条）。
 *
 * 兼容旧形态：v1/v2 的 `project` 可能是 `{path, scope}` 对象 ⇒ 统一读成字符串。
 */
function coerceEntry(v: unknown): SessionJudg | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	const o = v as Record<string, unknown>;
	// v1/v2：`project` 是 `{path, scope}` 对象
	const rawProject = typeof o.project === "object" && o.project !== null ? (o.project as { path?: unknown }).path : o.project;
	const project = normalizeProjectPath(typeof rawProject === "string" ? rawProject : "");
	if (!project) return null; // 非法值 → 当 flag:false（见 B22）
	const decidedBy = o.decidedBy;
	const db: DecidedBy = decidedBy === "init" || decidedBy === "code" || decidedBy === "llm" || decidedBy === "manual" ? decidedBy : "init";
	const evidence: Evidence[] = Array.isArray(o.evidence)
		? o.evidence
				.filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
				.map((e) => ({ path: String(e.path ?? ""), filesTouched: Number(e.filesTouched) || 0 }))
				.filter((e) => e.path)
				.slice(0, EVIDENCE_LIMIT)
		: [];
	return {
		project,
		flag: o.flag === true,
		decidedBy: db,
		confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0)),
		at: String(o.at ?? ""),
		evidence,
	};
}

/**
 * 读单个会话条目。
 *
 * @returns 条目；文件缺失 / 解析失败 / 该 key 不存在 ⇒ `null`（调用方走 `fallback` 分支）
 */
export function readSessionJudg(profilePath: string, sessionKey: string): SessionJudg | null {
	if (!sessionKey) return null; // B7：空 sessionKey 直接走 fallback
	const r = readJudgFile(profilePath);
	if (!r.ok) return null;
	return r.file.sessions[sessionKey] ?? null;
}

// ══════════════════════════════════════════════════════════════
//  写
// ══════════════════════════════════════════════════════════════

/** 原子写：写 `.tmp` → rename 覆盖；Windows 上 rename 可能撞 EBUSY/EPERM，重试 3 次 / 50ms（B17）。 */
function atomicWrite(file: string, text: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	const tmp = `${file}.tmp`;
	const delays = [0, 50, 50];
	let lastErr: unknown = null;
	for (const d of delays) {
		if (d > 0) {
			const t = Date.now() + d;
			while (Date.now() < t) { /* 忙等 50ms：这里不能 await，写侧是同步接口 */ }
		}
		try {
			writeFileSync(tmp, text, "utf-8");
			rmSync(file, { force: true });
			renameSync(tmp, file);
			return;
		} catch (e) {
			lastErr = e;
		}
	}
	try { rmSync(tmp, { force: true }); } catch { /* 临时文件残留不影响正确性 */ }
	throw new Error(`写入失败（已重试 ${delays.length} 次）：${(lastErr as Error)?.message ?? "未知"}`);
}

/**
 * 写单个会话条目（读-改-写整份文件）。
 *
 * **不覆盖已有条目的其它字段**：`upsertSessionJudg` 只改传入的字段。
 * `ensureSessionEntry` 才是"建条目"的那条路（已存在则原样返回，不覆盖 —— B10 用户手改的值要留住）。
 *
 * @param patch 要改的字段；`project` 非法（null）时该字段被拒，其余字段照写
 * @returns 写入后的条目；读失败或 project 非法时返回 null
 */
export function upsertSessionJudg(
	profilePath: string,
	sessionKey: string,
	patch: Partial<Omit<SessionJudg, "at">> & { at?: string },
): SessionJudg | null {
	if (!sessionKey) return null;
	const r = readJudgFile(profilePath);
	if (!r.ok) return null; // 读失败不覆盖（B6 / 读时解析失败 → 返回错误，不覆盖原文件）
	const file = r.file;
	const prev = file.sessions[sessionKey];

	let project = prev?.project ?? "";
	if (patch.project !== undefined) {
		const n = normalizeProjectPath(patch.project);
		if (!n) return null; // 非法 project → 拒写（B22）
		project = n;
	}
	// `flag:false` 允许的 decidedBy：init / code / llm / manual（"没有把握"本身是合法判定结果）
	let flag = patch.flag ?? prev?.flag ?? false;
	// 第三道防线：家目录 / 桌面 / 文档 / AppData 之类不可能是项目（B10 的手工编辑也走这里）。
	// **降级而不是拒写** —— 拒写会让整条判定连同 evidence 一起丢掉，而 evidence 是下次
	// 变化检测的比对基准，丢了就会每轮重判。
	if (flag && isNotAProjectPath(project)) {
		flag = false;
		patch = { ...patch, decidedBy: "code" };
	}
	const decidedBy: DecidedBy = patch.decidedBy ?? prev?.decidedBy ?? "init";
	const entry: SessionJudg = {
		project,
		flag,
		decidedBy,
		confidence: Math.min(1, Math.max(0, patch.confidence ?? prev?.confidence ?? 0)),
		at: patch.at ?? new Date().toISOString(),
		// evidence 一律写本轮候选（与 flag 无关）—— 见文件头「写侧的三条硬规则」第 3 条
		evidence: (patch.evidence ?? prev?.evidence ?? []).slice(0, EVIDENCE_LIMIT),
	};
	file.sessions[sessionKey] = entry;
	file.updatedAt = entry.at;
	try {
		atomicWrite(judgFilePath(profilePath), JSON.stringify(file, null, 2) + "\n");
	} catch {
		return null; // fail-open：写不了就当没写，不抛给事件处理器
	}
	return entry;
}

/**
 * 建条目（仅当不存在）。已存在 ⇒ **原样返回，一个字段都不改**。
 *
 * 存在的意义是让 `l1_commit` 侧永远查得到一条记录（`decidedBy:"init"` 表示"还没判过"）。
 */
export function ensureSessionEntry(profilePath: string, sessionKey: string, sessionCwd: string): SessionJudg | null {
	if (!sessionKey) return null;
	const r = readJudgFile(profilePath);
	if (!r.ok) return null;
	const prev = r.file.sessions[sessionKey];
	if (prev) return prev; // 不覆盖（B10）
	const project = normalizeProjectPath(sessionCwd) ?? "";
	if (!project) return null; // 连启动目录都没有 ⇒ 不建（无法比较）
	const entry: SessionJudg = {
		project,
		flag: false,
		decidedBy: "init",
		confidence: 0,
		at: new Date().toISOString(),
		evidence: [],
	};
	r.file.sessions[sessionKey] = entry;
	r.file.updatedAt = entry.at;
	try {
		atomicWrite(judgFilePath(profilePath), JSON.stringify(r.file, null, 2) + "\n");
	} catch {
		return null;
	}
	return entry;
}

// ══════════════════════════════════════════════════════════════
//  变化检测
// ══════════════════════════════════════════════════════════════

/**
 * 本轮候选与上一轮 `evidence` 是否**实质相同**（相同 ⇒ 不必再判一次）。
 *
 * 两边都按 {@link projectKey} 归一化后再比（B24）：斜杠风格与大小写不同**不算**变化，
 * 否则会每轮都误判成"变了"⇒ 每轮白发一次请求。
 * 集合比较（不看顺序）：候选的排序会随并列打平而变，顺序变了不代表项目变了。
 *
 * @param prevEvidence 上一轮落盘的 evidence
 * @param nowPaths     本轮候选路径
 */
export function evidenceUnchanged(prevEvidence: Evidence[] | undefined, nowPaths: string[]): boolean {
	if (!prevEvidence || prevEvidence.length === 0) return false;
	const prev = new Set(prevEvidence.map((e) => projectKey(e.path)));
	if (prev.size !== nowPaths.length) return false;
	for (const p of nowPaths) if (!prev.has(projectKey(p))) return false;
	return true;
}

// ══════════════════════════════════════════════════════════════
//  路径包含判定（任务 2b）
// ══════════════════════════════════════════════════════════════

/**
 * 会话目录 `sessionDir` 是否落在 `projectPath` 之下（含等于）。
 *
 * 这是**未来召回侧唯一需要的判定**。`scope`（`self` / `subtree`）**不参与**这个判定 ——
 * 两种 scope 的召回规则一模一样（见计划「关键性质：召回判定只有一个动作」），
 * 它只是"这条路径当时按叶子还是容器解释"的记录，供审计与将来收紧用。
 *
 * 比较前两边都归一化（正斜杠 + 小写 + 去尾分隔符），所以 `C:\A\B`、`c:/a/b/`、
 * `C:\a\b` 判为同一个目录。**兄弟目录返回 false**（`…/A104525` 不在 `…/A104527` 之下）——
 * 这正是用户裁定的「子项目之间不互相用」。
 *
 * @param sessionDir  会话的工作目录
 * @param projectPath 记忆/判定所挂的项目路径
 */
export function isUnder(sessionDir: string, projectPath: string): boolean {
	const a = projectKey(sessionDir);
	const b = projectKey(projectPath);
	if (!a || !b) return false;
	if (a === b) return true;
	return a.startsWith(`${b}/`);
}
