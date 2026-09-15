/**
 * L1 工作场景池（scene pool）——场景归属的唯一真源
 *
 * 背景（2026-09-15）：L1 记录的 `scene_name` 一直由 `l1-extractor` 子代理自由造句，
 * 服务端零校验。上一轮改造（注入候选 + 要求「逐字复制」）实测无效——复用率 15.5%、
 * 命中 PreviousScene 仅 0.6%、连续三天为 0。根因有两处：
 *   ① 机制上无法约束：`l1_commit` 子代理分支压根不碰 `scene_name`，「逐字复制」是软约束；
 *   ② 候选选法本身错：候选按主进程 cwd 排序，而非本批 L0 消息的 cwd。
 *
 * 本模块把场景归属收归代码：子代理只能「回传 `scene_id`」或「提 `new_scene_name` + 理由」，
 * canonical 名字由本模块从池中取值。抄错、改写、同义替换这一类失败模式因此从机制上消失。
 *
 * 设计边界：
 *   - 池是 L1 自己的**细粒度工作线程表**，不是 L2 场景块（后者是聚合后的粗粒度主题域）。
 *   - `aliases` / `mergedInto` 只在**读取期**解析，不改历史记录（改记录要全量重嵌向量库）。
 *   - 任何 IO 异常一律降级为空池，**绝不阻断提取**。
 *   - 写入必须由调用方持 L1 跨进程写锁后调用（`l1_commit` 内），本模块自身不加锁。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { L1_SCENES_FILE, MEMORY_DB_DIR } from "../paths.ts";

// ══════════════════════════════════════════════════════════════
//  常量
// ══════════════════════════════════════════════════════════════

/** 池结构版本（不认识的版本一律当空池，避免误读未来格式）。 */
export const SCENE_POOL_VERSION = 1;

/**
 * 注入子代理任务消息的条目上限。
 *
 * 30 → 40（2026-09-15 实测校准）：把现有 69 个复现 ≥2 次的历史场景名聚类后，**单个项目**
 * （`C:\dev\ide\pi-agent\pi-0.80.10`）就有 34 条不同线程，按「同项目优先」排序时 K=30 会截掉 4 条。
 * 稳定标签比旧长句名短得多（约 20 vs 40 字符），40 行 ≈ 1200 字符，反而比原来 15 行长句（≈900）只多一点。
 */
export const SCENE_POOL_INJECT_LIMIT = 40;

/** 注入窗口（天）：`lastUsedAt` 早于窗口的条目不再注入（挡一次性任务）。 */
export const SCENE_POOL_WINDOW_DAYS = 60;

/** 新条目 id 前缀。 */
export const SCENE_ID_PREFIX = "sc";

/** 池为空且子代理既没给 id 也没给名字时的兜底名字（不丢弃记忆，只标未归类）。 */
export const SCENE_FALLBACK_NAME = "未分类场景";

// ══════════════════════════════════════════════════════════════
//  类型
// ══════════════════════════════════════════════════════════════

/** 场景条目的来源。 */
export type SceneOrigin = "seed" | "extract" | "main-agent";

export interface SceneEntry {
	/** 稳定 id（`sc0001` 形式，永不复用）。 */
	id: string;
	/** canonical 名字（稳定标签 `{项目}｜{议题}`，池内唯一）。 */
	name: string;
	/** 出现过的 cwd 集合（只累积非空值）。 */
	cwds: string[];
	/** 历史上的等价名字（读取期解析用）。 */
	aliases: string[];
	/** 非空表示本条已被合并进目标 id（读取期跳转，不参与注入）。 */
	mergedInto: string | null;
	origin: SceneOrigin;
	createdAt: string;
	lastUsedAt: string;
	useCount: number;
	/** 新建场景时子代理给出的理由（审计用；非 extract 来源不填）。 */
	newSceneReason?: string;
}

export interface ScenePool {
	version: number;
	updatedAt: string;
	scenes: SceneEntry[];
}

/** 单条记录的场景解析结果。 */
export interface SceneResolveResult {
	/** 写进记录的 `scene_name`（**一定非空**）。 */
	scene_name: string;
	/** 写进记录的 `scene_id`；降级且无候选时为 null。 */
	scene_id: string | null;
	kind: "reused" | "created" | "name-match" | "fallback";
	/** 降级原因（kind === "fallback" 时给出，供 commit 返回体透出）。 */
	warn?: string;
}

/** 一次 `l1_commit` 内的场景统计。 */
export interface SceneStats {
	reused: number;
	created: number;
	fallback: number;
}

/** 记录上承载场景信息的三个字段（`l1_commit` 消费后须从落盘内容中剥离后两个）。 */
export interface RecordSceneInput {
	scene_id?: unknown;
	new_scene_name?: unknown;
	new_scene_reason?: unknown;
	cwd?: unknown;
}

/** 任务消息注入块的构造结果。 */
export interface ScenePoolLines {
	/** 逐行文本（`- {id} | {name}`），空池时为空数组。 */
	lines: string[];
	/** 过滤后仍在窗口内的条目总数（截断前）。 */
	eligible: number;
	/** 实际注入条数。 */
	shown: number;
}

// ══════════════════════════════════════════════════════════════
//  读 / 写
// ══════════════════════════════════════════════════════════════

/** 场景池文件绝对路径。 */
export function scenePoolPath(profilePath: string): string {
	return join(profilePath, MEMORY_DB_DIR, L1_SCENES_FILE);
}

export function emptyPool(): ScenePool {
	return { version: SCENE_POOL_VERSION, updatedAt: "", scenes: [] };
}

/** 名字归一化：折叠空白、trim（与 `scene_name` 既有的显示口径一致）。 */
export function normalizeSceneName(name: string): string {
	return name.replace(/\s+/g, " ").trim();
}

function isSceneEntry(o: unknown): o is SceneEntry {
	if (typeof o !== "object" || o === null) return false;
	const e = o as Partial<SceneEntry>;
	return typeof e.id === "string" && e.id.length > 0 && typeof e.name === "string";
}

/**
 * 读取场景池。
 *
 * **任何异常都降级为空池**（文件不存在 / JSON 坏 / `version` 不认识 / 条目形状非法），
 * 并在条目层面逐条容错（坏条目跳过而不是整池丢弃）。调用方无需 try/catch。
 */
export function readScenePool(profilePath: string): ScenePool {
	const file = scenePoolPath(profilePath);
	if (!existsSync(file)) return emptyPool();
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<ScenePool>;
		if (!raw || typeof raw !== "object") return emptyPool();
		if (raw.version !== SCENE_POOL_VERSION) return emptyPool();
		const scenes = Array.isArray(raw.scenes) ? raw.scenes.filter(isSceneEntry) : [];
		return {
			version: SCENE_POOL_VERSION,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
			// 补齐可选字段，避免下游到处判空
			scenes: scenes.map((e) => ({
				...e,
				cwds: Array.isArray(e.cwds) ? e.cwds.filter((c) => typeof c === "string" && c) : [],
				aliases: Array.isArray(e.aliases) ? e.aliases.filter((a) => typeof a === "string" && a) : [],
				mergedInto: typeof e.mergedInto === "string" && e.mergedInto ? e.mergedInto : null,
				useCount: typeof e.useCount === "number" ? e.useCount : 0,
			})),
		};
	} catch {
		return emptyPool();
	}
}

/**
 * 原子写场景池（tmp + rename，与 `saveCursor` 同惯例）。
 *
 * @returns 是否写成功。**失败不抛错**——池写失败不该让整批记忆提交失败（记录已带正确名字）。
 */
export function writeScenePool(profilePath: string, pool: ScenePool): boolean {
	const file = scenePoolPath(profilePath);
	const tmp = join(dirname(file), `.tmp_scenes_${Date.now()}`);
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify({ ...pool, version: SCENE_POOL_VERSION }, null, 2)}\n`, "utf-8");
		try {
			rmSync(file, { force: true });
		} catch {
			// ignore
		}
		renameSync(tmp, file);
		return true;
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// ignore
		}
		return false;
	}
}

// ══════════════════════════════════════════════════════════════
//  查找
// ══════════════════════════════════════════════════════════════

/** 分配下一个 id（`sc0001` 起；扫描现有 id 取最大序号 +1，保证不复用）。 */
export function nextSceneId(pool: ScenePool): string {
	let max = 0;
	for (const e of pool.scenes) {
		const m = /^sc(\d+)$/.exec(e.id);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `${SCENE_ID_PREFIX}${String(max + 1).padStart(4, "0")}`;
}

/**
 * 解析 `mergedInto` 链，取最终条目（最多 8 跳防环）。
 * @returns 最终条目；链断或成环时返回 null。
 */
export function resolveMergedTarget(pool: ScenePool, id: string): SceneEntry | null {
	let cur = pool.scenes.find((e) => e.id === id) ?? null;
	const seen = new Set<string>();
	for (let hop = 0; cur && hop < 8; hop++) {
		if (!cur.mergedInto) return cur;
		if (seen.has(cur.id)) return null; // 成环
		seen.add(cur.id);
		cur = pool.scenes.find((e) => e.id === cur!.mergedInto) ?? null;
	}
	return null;
}

/** 按 canonical 名字精确查找存活条目（`aliases` 不参与——别名只在读取期解析）。 */
export function findSceneByName(pool: ScenePool, name: string): SceneEntry | null {
	const n = normalizeSceneName(name);
	if (!n) return null;
	return pool.scenes.find((e) => !e.mergedInto && e.name === n) ?? null;
}

/**
 * 按名字查找（先 canonical、后别名），供报告 / 历史记录归属使用。
 * 返回存活条目（命中别名时沿 `mergedInto` 跳到目标）。
 */
export function findSceneByNameOrAlias(pool: ScenePool, name: string): SceneEntry | null {
	const n = normalizeSceneName(name);
	if (!n) return null;
	const byName = findSceneByName(pool, n);
	if (byName) return byName;
	for (const e of pool.scenes) {
		if (!e.aliases.includes(n)) continue;
		if (!e.mergedInto) return e;
		const target = resolveMergedTarget(pool, e.id);
		if (target) return target;
	}
	return null;
}

/** 池内某个 cwd 最近使用过的存活条目（同 cwd 无则取全局最近）。 */
export function findMostRecentScene(pool: ScenePool, cwd: string): SceneEntry | null {
	const alive = pool.scenes.filter((e) => !e.mergedInto);
	if (alive.length === 0) return null;
	const byRecent = (a: SceneEntry, b: SceneEntry) => (a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0);
	if (cwd) {
		const sameCwd = alive.filter((e) => e.cwds.includes(cwd)).sort(byRecent);
		if (sameCwd.length > 0) return sameCwd[0];
	}
	return [...alive].sort(byRecent)[0];
}
/**
 * 稳定标签里的项目分隔符（`{项目}｜{议题}`）。
 *
 * 2026-09-15（L1_PROJECT_SIGNAL）：**项目标识从标签前缀派生，池不新增字段**。cwd 是"会话工作台"
 * 而不是项目（实测 memory-system 的记录 cwd 全是 pi fork 目录、34 条线程挤在同一个 cwd 下），
 * 所以排序不能用 cwd 当项目——用这个前缀。
 */
export const PROJECT_SEP = "｜";

/** 项目前缀的归一化：去全部空白 + 去尾部「扩展/项目/仓库」（不合同义合并，那是合并工具的活）。 */
export function normalizeProject(raw: string): string {
	return raw.replace(/\s+/g, "").replace(/(扩展|项目|仓库)$/, "");
}

/** 取条目的项目标识（`name` 的 `｜` 前缀）；缺 `｜` 时返回空串（不参与项目优先，只按 cwd/最近排）。 */
export function projectOf(entry: SceneEntry): string {
	const i = entry.name.indexOf(PROJECT_SEP);
	if (i <= 0) return "";
	return normalizeProject(entry.name.slice(0, i));
}

// ══════════════════════════════════════════════════════════════
//  注入行构造
// ══════════════════════════════════════════════════════════════

export interface ScenePoolLineOptions {
	/** 本批 L0 消息的众数 cwd（`detectBatchCwd`）；空串 → 不做 cwd 优先。 */
	batchCwd?: string;
	/** 本批疑似项目（`detectBatchProject`，取自标签前缀口径）；空串 → 不做项目优先。 */
	batchProject?: string;
}

/**
 * 构造注入子代理任务消息的池清单。
 *
 * 排序：**同项目（标签前缀）优先 → 同 cwd 优先 → `lastUsedAt` 倒序**；截断至 `SCENE_POOL_INJECT_LIMIT`。
 *
 * 为什么项目优先用标签前缀而不是 cwd：cwd 是**会话工作台**，不是项目——实测同一 cwd 下混着 34 条
 * 不同项目的线程，而记录 cwd 与"实际在动的代码仓库"常常不一致（memory-system 的记录 cwd 是 pi fork）。
 * `batchProject` / `batchCwd` 都取不到时退化为纯 `lastUsedAt` 倒序（与旧行为一致）。
 *
 * 行格式刻意不含 `cwd=`：同项目优先已由排序体现，逐行再带一遍是冗余。
 */
export function buildScenePoolLines(
	pool: ScenePool,
	opts: ScenePoolLineOptions = {},
	limit = SCENE_POOL_INJECT_LIMIT,
	windowDays = SCENE_POOL_WINDOW_DAYS,
): ScenePoolLines {
	const { batchCwd = "", batchProject = "" } = opts;
	const cutoffMs = Date.now() - windowDays * 86_400_000;
	const eligible = pool.scenes.filter((e) => {
		if (e.mergedInto) return false;
		const t = Date.parse(e.lastUsedAt);
		// lastUsedAt 不可解析时宁可注入（历史/手工池），不因脏值静默丢弃
		return Number.isNaN(t) ? true : t >= cutoffMs;
	});
	const byRecent = (a: SceneEntry, b: SceneEntry) => (a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0);
	const rankProject = (e: SceneEntry) => (batchProject && projectOf(e) === batchProject ? 0 : 1);
	const rankCwd = (e: SceneEntry) => (batchCwd && e.cwds.includes(batchCwd) ? 0 : 1);
	const sorted = [...eligible].sort((a, b) => rankProject(a) - rankProject(b) || rankCwd(a) - rankCwd(b) || byRecent(a, b));
	const shown = sorted.slice(0, limit);
	return {
		lines: shown.map((e) => `- ${e.id} | ${e.name}`),
		eligible: eligible.length,
		shown: shown.length,
	};
}

/**
 * 取注入/展示用的条目数组（结构化，供 `list_l1_scenes` 工具用）。
 *
 * 与 `buildScenePoolLines` **同窗口、同排序、同上限**——保证"主代理看到的"与"子代理看到的"是同一份东西。
 */
export function selectScenePoolEntries(
	pool: ScenePool,
	opts: ScenePoolLineOptions = {},
	limit = SCENE_POOL_INJECT_LIMIT,
	windowDays = SCENE_POOL_WINDOW_DAYS,
): SceneEntry[] {
	const lines = buildScenePoolLines(pool, opts, limit, windowDays);
	const byId = new Map(pool.scenes.map((e) => [e.id, e]));
	return lines.lines.map((l) => byId.get(l.slice(2, l.indexOf(" | ")))).filter((e): e is SceneEntry => !!e);
}

// ══════════════════════════════════════════════════════════════
//  批量解析器
// ══════════════════════════════════════════════════════════════

export interface SceneResolver {
	/** 解析一条记录的场景归属（同时就地更新池与统计）。 */
	resolve(input: RecordSceneInput): SceneResolveResult;
	/** 本批是否改动过池（决定是否需要写盘）。 */
	isDirty(): boolean;
	/** 本批统计。 */
	stats(): SceneStats;
}

/**
 * 创建一批记录的场景解析器（一次 `l1_commit` 用一个）。
 *
 * 分支顺序（对齐计划「流程」节）：
 *   ① `scene_id` 命中池且未被合并 → **复用**，canonical 名字由池给出（覆写子代理所填）
 *   ② `new_scene_name` 与池内 canonical 逐字相同 → **name-match**，解析到已有条目（不新建）
 *   ③ `new_scene_name` 为新名 → **新建**条目（登记 cwds / 理由）
 *   ④ 都没有 / id 未知 → **降级**：同 cwd 最近条目 → 全局最近条目 → 保留子代理自填名字 → `未分类场景`
 *
 * 计数规则：同一条目在本批内只累加一次 `useCount`（`lastUsedAt` 取本批时刻）。
 * `deleted:true` 标记行由调用方跳过（本解析器不感知 deleted）。
 */
export function createSceneResolver(pool: ScenePool, nowIso: string): SceneResolver {
	const stats: SceneStats = { reused: 0, created: 0, fallback: 0 };
	const touched = new Set<string>();
	let dirty = false;

	function touch(entry: SceneEntry): void {
		entry.lastUsedAt = nowIso;
		if (!touched.has(entry.id)) {
			touched.add(entry.id);
			entry.useCount += 1;
		}
		dirty = true;
	}

	function addCwd(entry: SceneEntry, cwd: string): void {
		if (!cwd) return;
		if (entry.cwds.includes(cwd)) return;
		entry.cwds.push(cwd);
		dirty = true;
	}

	return {
		resolve(input: RecordSceneInput): SceneResolveResult {
			const cwd = typeof input.cwd === "string" ? input.cwd : "";
			const rawId = typeof input.scene_id === "string" ? input.scene_id.trim() : "";
			const rawName = typeof input.new_scene_name === "string" ? normalizeSceneName(input.new_scene_name) : "";
			const reason = typeof input.new_scene_reason === "string" ? normalizeSceneName(input.new_scene_reason) : "";

			// ① 复用：id 命中（含被合并的 id 沿链跳转）
			if (rawId) {
				const direct = pool.scenes.find((e) => e.id === rawId);
				const target = direct ? (direct.mergedInto ? resolveMergedTarget(pool, rawId) : direct) : null;
				if (target) {
					touch(target);
					addCwd(target, cwd);
					stats.reused += 1;
					return { scene_name: target.name, scene_id: target.id, kind: "reused" };
				}
			}

			// ② 名字逐字命中已有 canonical → 等价免费复用
			if (rawName) {
				const existing = findSceneByName(pool, rawName);
				if (existing) {
					touch(existing);
					addCwd(existing, cwd);
					stats.reused += 1;
					return { scene_name: existing.name, scene_id: existing.id, kind: "name-match" };
				}
			}

			// ③ 新建
			if (rawName) {
				const entry: SceneEntry = {
					id: nextSceneId(pool),
					name: rawName,
					cwds: cwd ? [cwd] : [],
					aliases: [],
					mergedInto: null,
					origin: "extract",
					createdAt: nowIso,
					lastUsedAt: nowIso,
					useCount: 1,
				};
				if (reason) entry.newSceneReason = reason;
				pool.scenes.push(entry);
				touched.add(entry.id);
				dirty = true;
				stats.created += 1;
				return { scene_name: entry.name, scene_id: entry.id, kind: "created" };
			}

			// ④ 降级：**不猜场景**（2026-09-15 L1_PROJECT_SIGNAL）——没给标识就标未归类。
			//    旧实现在这里取「同 cwd 最近条目」，等于拿"同一工作台最近聊过的话题"当归属；
			//    实测 cwd 是会话工作台而不是项目（34 条线程挤一个 cwd），猜错的代价（污染 L2 分组）
			//    高于未归类（只产生一个明确的占位场景）。调用方若自填了名字则沿用（无 id，不可复用）。
			stats.fallback += 1;
			const carried = typeof (input as { scene_name?: unknown }).scene_name === "string"
				? normalizeSceneName((input as { scene_name?: string }).scene_name ?? "")
				: "";
			return {
				scene_name: carried || SCENE_FALLBACK_NAME,
				scene_id: null,
				kind: "fallback",
				warn: rawId
					? `scene_id "${rawId}" 不在池中且未给 new_scene_name → 未归类（请从 ScenePool 清单挑 id，或给 new_scene_name）`
					: "既未给 scene_id 也未给 new_scene_name → 未归类（同上）",
			};
		},
		isDirty: () => dirty,
		stats: () => ({ ...stats }),
	};
}
