import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SCENE_DIR_NAME, SCENE_INDEX_PATH, SCENE_MEMBERS_PATH, saveL2Cursor, recordEpochMs, loadL2Config } from "./config.ts";
import { BACKUP_DIR, L2_INDEX_DIR, MEMORY_DB_DIR } from "../paths.ts";
import { writePendingTrigger } from "../l3/signal.ts";
import { getPipelineJobsDB } from "../pipeline/jobs-db.ts";
import { loadFailureState, saveFailureState } from "../failure-state.ts";
import { logEvent } from "../../util/notice.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";

// ══════════════════════════════════════════════════════════════
//  l2_commit 工具 —— 子代理场景写盘桥接
//
//  模式与 l1_commit 相同：子代理通过扩展工具提交场景写入（sceneWrites），
//  主进程落盘（工具调用不受 Plan Enforcer 拦截）。主进程负责：
//    1. 场景文件落盘（META 头 + 正文，原子写；delete 删文件）
//    2. 场景索引同步（扫描 scene_blocks/ 全量重建）
//    3. L2 游标推进（lastRecordId）
// ══════════════════════════════════════════════════════════════

/** 场景文件 META 分隔标记（腾讯格式 1:1）。 */
const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

/** 场景 META 元数据（腾讯 scene-format.ts 同构）。 */
export interface SceneMeta {
	created: string;
	updated: string;
	summary: string;
	heat: number;
}

/** 子代理提交的单条场景写入。 */
export interface SceneWrite {
	action: "create" | "update" | "merge" | "delete" | "consolidate";
	filename: string;
	/**
	 * `consolidate` 专用：被合并的源块文件名列表（≥2，且不含 `filename` 自身；目标块可已存在）。
	 * 代码原子完成：备份源块 → 完整性校验 → 写目标 → 删源块 → 合并成员 → 重建索引。
	 * 它存在的理由：`merge` 只是"写目标 + 另发 delete"两个独立动作，中间没有任何校验，
	 * 历史上由此发生过 3 次静默丢内容（-42.8% / -41.7%）。本动作把完整性校验交给代码。
	 */
	sources?: string[];
	meta?: Partial<SceneMeta>;
	content?: string;
	/**
	 * 该块收录的 L1 记录 id 列表（2026-09-10 新增，用于让"哪些记录属于这块"可机读）。
	 * `consolidate` 时缺省 → 代码自动取各源块成员的**并集**（兜底）；若显式传入，则**必须包含**
	 * 源并集，漏了会被完整性校验拒绝。`delete` 时忽略。其余动作缺省则保留原集合。
	 */
	members?: string[];
}

// 低置信合并候选**故意没有**机器可读出口（2026-09-16 删除了 MergeProposal / MERGE_PROPOSALS_FILE /
// renderMergeProposals：三者定义并导出后从未被任何调用方使用）。子代理按规则文件把候选写进块的
// 「待确认问题」段，等人工确认。若将来确实需要机器可读通道，应作为独立特性显式接线
// （子代理把候选传给 l2_commit，宿主落盘），而不是留一个看起来接好了的孤立渲染函数。

/** consolidate 在返回里的回报（可观测：用于验证完整性校验与自动备份确实生效）。 */
export interface ConsolidationReport {
	target: string;
	sources: string[];
	/** 备份目录（相对 `{profilePath}/memoryDB/`），回退用。 */
	backupDir: string;
	/** members 来源：explicit = 子代理显式传入并通过了覆盖校验；auto-union = 代码取源并集兜底。 */
	membersSource: "explicit" | "auto-union";
	lines: { sourceTotal: number; target: number; ratio: number };
	warnings: string[];
}

/** l2_commit 返回。 */
export interface L2CommitResult {
	success: boolean;
	sceneCount: number;
	/** 推进到的游标值（lastRecordId）。 */
	cursor?: string;
	error?: string;
	/** 本批中带了写入但未上报 `members` 的目标文件名（可观测用；不阻断）。 */
	membersMissing?: string[];
	/** 上限不变量被破坏的信号（落盘后场景数 > `maxScenes`；正常不出现）。 */
	warning?: string;
	/** 本批执行的 consolidate 动作回报。 */
	consolidations?: ConsolidationReport[];
	/**
	 * 本次子代理进程里的第几次成功提交（从 1 开始）。
	 *
	 * 为什么记它（2026-09-21 实测）：一次 L2 运行里模型自选了 **5 次** `l2_commit` —— 而每次提交
	 * 都要再走一轮"大 payload 生成"（实测 L2 单次生成中位 42s、最长 348s）。规则文件已改为
	 * "一轮一次提交"，这个字段只用于**观测与提示**：第 2 次起附 `commitHint`，并在 `logs/l2.log`
	 * 记一行。不拒绝 —— 确有必须分次的场景（例如先 create 再 consolidate 才不受上限拒绝），堵死会更糟。
	 */
	commitSeq?: number;
	/** 第 2 次起给出的提示文案（只提示，不阻断）。 */
	commitHint?: string;
}

/** 合法场景文件名（对齐腾讯命名规范）。 */
const FILENAME_RE = /^[\w\u4e00-\u9fff-]+\.md$/;

/** 块正文里的 L1 record id 形态（宽松：`l1_<可选字母前缀><10-13 位数字>`，匹配数字部分口径）。 */
const ID_TOKEN_RE = /l1_[A-Za-z_]{0,12}\d{10,13}/g;

/** consolidate 行数比硬阈值：目标正文非空行数低于源合计的这个比例 → 判为大段丢失，整批拒绝。 */
export const MIN_CONSOLIDATION_LINE_RATIO = 0.5;

/** consolidate 行数比警告阈值（低于此但高于硬阈值 → 放行并在返回里回报）。 */
export const WARN_CONSOLIDATION_LINE_RATIO = 0.8;

/** consolidate 自动备份保留份数（超出删最旧）。 */
export const CONSOLIDATE_BACKUP_KEEP = 5;

/** 场景数量硬上限预检结果。 */
export interface SceneLimitCheck {
	/** 通过为 true；否则本批写入应整体拒绝（不落盘）。 */
	ok: boolean;
	/** 预演到最后时的场景数（ok=false 时是超限那一刻的值）。 */
	count: number;
	error?: string;
}

/**
 * 硬上限预检（2026-09-10）：按提交顺序**预演**这批写入对场景数的影响，任一时刻超过上限即整批拒绝。
 *
 * **上限语义 = 场景数不得超过 `maxScenes`**（`maxScenes: 15` → 最多 15 个块）。这与两个规则文件
 * 现行措辞一致（2026-09-10 已把规则里"必须严格小于 {maxScenes}"统一为"不得超过"）。
 * 判定取比规则**不更宽松**的口径：规则禁止的状态，代码也拒绝——否则"硬上限"只是提示词守则。
 *
 * **计增长的唯一口径 = 落盘效果**（2026-09-16 更正）：只要目标文件名当前不在集合里就算 +1，
 * 不按 `action` 名区分。旧口径只把 `create` 算作增长、并假设"update / merge 的目标必然已存在"，
 * 而写入循环对三者一视同仁地落盘 —— 该假设没有校验兜住，形成"预检不增、实际增一个块"的绕过路径。
 *
 * **刻意不做"入口即拒绝"的预检**（2026-09-10 修正）：若在入口就把已达上限的批次整体拒掉，
 * 那么 `delete` / `merge` 这类**收缩**批次也会被挡——而收缩正是脱离上限的唯一途径，会形成
 * 死锁（L2 永远无法通过合并自愈）。因此只在写入推进过程中判定：**净增长越过上限才拒，
 * 净收缩一律放行**。
 *
 * 之所以先预演而不是边写边算：`merge` 在代码层等于「写目标 + 另发 delete」，只有按序推演
 * 才能判断"先合后建"（`[delete, delete, create]`）合法，而 `[create, delete, delete]` 若不合法
 * 应在 create 那一步就拒。整体拒绝也保证不会写出半批数据。
 *
 * 达上限时的动作是**触发合并评估**（错误信息里给出指引），而不是静默丢弃写入。
 */
export function checkSceneLimit(existing: Iterable<string>, writes: SceneWrite[], maxScenes: number): SceneLimitCheck {
	const set = new Set(existing);
	let count = set.size;
	for (const w of writes) {
		if (w.action === "delete") {
			if (set.delete(w.filename)) count--;
			continue;
		}
		if (w.action === "consolidate") {
			// 原子动作，内部顺序固定：先删源腾位、再落目标。
			// 净变化 = -(有效源数) + (目标原本不存在 ? 1 : 0)，故 sources ≥ 2 时必然是收缩，天然不会触发上限。
			for (const s of w.sources ?? []) {
				if (s !== w.filename && set.delete(s)) count--;
			}
			if (!set.has(w.filename)) {
				set.add(w.filename);
				count++;
			}
			if (count > maxScenes) {
				return { ok: false, count, error: limitReachedError(maxScenes, count) };
			}
			continue;
		}
		// create / update / merge：一律按**落盘效果**计增长 —— 写入循环对这三个动作同等对待（都 atomicWrite），
		// 所以只要目标文件名当前不在集合里，本批就会多出一个块，与调用方填的动作名无关。
		// 2026-09-16 更正：旧口径只认 action==="create"，于是"update / merge + 新文件名"能绕过上限
		// （预检说没长、实际长了：实测 cap=3 且目录已满时，merge / update 带新名落盘后目录变 4 块、返回仍 success=true）。
		if (!set.has(w.filename)) {
			set.add(w.filename);
			count++;
		}
		if (count > maxScenes) {
			return { ok: false, count, error: limitReachedError(maxScenes, count) };
		}
	}
	return { ok: true, count };
}

/**
 * 上限拒绝的指引文案。**只准指 `consolidate`**，不得提"merge 目标块 + 另发 delete"的两步式：
 * 那正是两个规则文件与 `agent/agents/l2-scene-organizer.md` 明令禁止的路径（两步之间无任何校验，
 * 历史上由此静默丢过内容），而它在代码层恰好是能过闸的 —— 写成指引等于把子代理推向它。
 * （2026-09-16 更正：旧文案写的正是这个两步式。）
 */
function limitReachedError(maxScenes: number, count: number): string {
	return (
		`场景块数量已达硬上限 ${maxScenes}（本批写入后会到 ${count}）。` +
		"请先执行合并评估：用 action=consolidate 把满足四条高置信判据（同项目 / 同主线 / 无互斥结论 / 成员无交集）的块合并 —— " +
		'{"action":"consolidate", "filename":"<目标块.md>", "sources":["<源1.md>","<源2.md>"], "content":"<合并后的完整正文>", "meta":{"summary":"…"}}，' +
		"主进程会原子完成（备份源块 → 完整性校验 → 写目标块 → 删源块），一次提交即可。腾出空位后重试。 " +
		"若确实没有满足判据、不该合并的块，就把内容并入最相关的现有块（update），不要新建。"
	);
}

/**
 * 第 2 次起提交时附的提示（只提示不阻断）。文案里给出"为什么慢"的量化依据，
 * 否则模型看不出"多提交一次"的代价 —— 它每轮只看得到自己的任务，看不到墙钟。
 */
function commitHintText(seq: number): string {
	return (
		`这是本轮第 ${seq} 次 l2_commit。每多提交一次就多一整轮模型生成` +
		`（实测单次 40s–350s），规则要求**把本轮所有 sceneWrites 攒好、只提交一次**。` +
		`确有必须分次的情况（例如先 create 腾位、再 consolidate）可以继续，否则请下次一次性提交。`
	);
}

/** consolidate 完整性校验结果。 */
export interface ConsolidationCheck {
	/** false = 整批拒绝（完整性硬失败，不落盘）。 */
	ok: boolean;
	error?: string;
	warnings: string[];
	/** 源块成员并集里、目标 members 未覆盖的 id（硬失败信号；目标未显式传 members 时不校验）。 */
	memberGaps: string[];
	/** 源块正文引用的 record id，在目标正文与目标 members 中都找不到的（丢条目信号，只警告）。 */
	droppedIdRefs: string[];
	/** 正文非空行数统计。 */
	lines: { sourceTotal: number; target: number; ratio: number };
}

function idTokensOf(text: string): Set<string> {
	const out = new Set<string>();
	const re = new RegExp(ID_TOKEN_RE.source, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) out.add(m[0]);
	return out;
}

function bodyLineCount(text: string): number {
	let n = 0;
	for (const l of text.split("\n")) if (l.trim().length > 0) n++;
	return n;
}

/**
 * consolidate 完整性校验（**纯函数**，可单测）。
 *
 * 它存在的理由：`merge` 动作只是"写目标 + 另发 delete"两个独立步骤，中间无任何校验，
 * 历史上由此发生过 3 次**静默**丢内容（对照外部备份：-42.8% / -41.7%）。本函数把"不丢条目"
 * 从"靠 LLM 自觉"变成"代码可判定"。三条判据分工如下：
 *
 * 1. **成员覆盖（硬失败）**：仅当目标**显式**传了 `members` 时校验——源并集里任何一条不在目标
 *    members 中即拒绝。缺省不校验（此时代码会用源并集兜底，见 `resolveConsolidationMembers`），
 *    这样既不脆弱也不放行"显式声明却漏条目"这种情况。
 * 2. **行数比（硬失败 + 警告）**：目标正文非空行数 / 源合计。低于 50% 判为大段丢失并拒绝；
 *    低于 80% 只警告（合并本就会因去重而缩短，不能一律拒绝）。
 * 3. **id 引用覆盖（警告）**：源正文里出现的 record id，若目标正文与 members 都找不到 → 回报。
 *    用"数字部分包含即算覆盖"的宽松口径，避免块内写去后缀形式导致误报。
 */
export function checkConsolidation(
	sources: Array<{ filename: string; content: string; members: string[] }>,
	target: { filename: string; content: string; members?: string[] },
): ConsolidationCheck {
	const warnings: string[] = [];

	const srcUnion = new Set<string>();
	for (const s of sources) for (const m of s.members) if (m) srcUnion.add(m);
	const targetMembers = Array.isArray(target.members) ? target.members : null;
	const memberGaps = targetMembers ? [...srcUnion].filter((m) => !targetMembers.includes(m)) : [];

	const srcRefs = new Set<string>();
	for (const s of sources) for (const t of idTokensOf(s.content)) srcRefs.add(t);
	const targetRefs = idTokensOf(target.content);
	// 只与**目标正文**比对，不把 members 算作"已覆盖"——否则由于 members 兜底会取源并集，
	// 这条检查将永不触发。宽松口径：数字部分（块内常写去后缀形式）命中即算保留。
	const droppedIdRefs = [...srcRefs].filter((t) => {
		if (targetRefs.has(t)) return false;
		const num = /\d{10,13}/.exec(t)?.[0];
		return num ? !target.content.includes(num) : true;
	});

	const sourceTotal = sources.reduce((n, s) => n + bodyLineCount(s.content), 0);
	const targetLines = bodyLineCount(target.content);
	const ratio = sourceTotal > 0 ? targetLines / sourceTotal : 1;

	if (srcUnion.size === 0) {
		warnings.push("源块没有任何 members 数据（历史块常见），成员覆盖校验已跳过，仅依赖行数比与 id 引用覆盖");
	}
	if (droppedIdRefs.length > 0) {
		warnings.push(
			`源块正文引用的 ${droppedIdRefs.length} 个 record id 在目标块中找不到（例：${droppedIdRefs
				.slice(0, 3)
				.join("、")}）——请确认这些条目已安置进目标块，或已并入 members`,
		);
	}
	if (ratio < WARN_CONSOLIDATION_LINE_RATIO) {
		warnings.push(
			`目标正文行数（${targetLines}）仅为源块合计（${sourceTotal}）的 ${Math.round(ratio * 100)}%，低于 ${Math.round(
				WARN_CONSOLIDATION_LINE_RATIO * 100,
			)}% 警戒线——请确认缩短来自去重而不是丢条目`,
		);
	}

	let ok = true;
	let error: string | undefined;
	if (memberGaps.length > 0) {
		ok = false;
		error =
			`合并完整性校验失败：目标 members 漏了 ${memberGaps.length} 条源块成员（例：${memberGaps
				.slice(0, 3)
				.join("、")}）。` +
			"请把各源块 members 的并集传给 members 字段，或省略该字段让代码自动取并集。";
	} else if (sources.length >= 3 && ratio < MIN_CONSOLIDATION_LINE_RATIO) {
		ok = false;
		error =
			`合并完整性校验失败：目标正文非空行数 ${targetLines} 不足源块合计 ${sourceTotal} 的 ${Math.round(
				MIN_CONSOLIDATION_LINE_RATIO * 100,
			)}%（比率 ${ratio.toFixed(2)}），疑似大段条目丢失。` +
			"请把源块每条结论都安置到目标块（被推翻的旧结论放进「演化记录」）后再提交。";
	}

	return { ok, error, warnings, memberGaps, droppedIdRefs, lines: { sourceTotal, target: targetLines, ratio } };
}

/**
 * 解析 consolidate 的目标成员：显式传入优先（其覆盖性已由 `checkConsolidation` 校验），
 * 缺省则取各源块成员的并集——代码兜底比"让 LLM 记得上报"可靠。
 */
export function resolveConsolidationMembers(
	sources: string[],
	memberMap: Record<string, string[]>,
	explicit?: string[],
): string[] {
	const union = new Set<string>();
	for (const s of sources) for (const m of memberMap[s] ?? []) if (m) union.add(m);
	if (Array.isArray(explicit)) for (const m of explicit) if (m) union.add(m);
	return [...union];
}

/**
 * consolidate 的 META 自动计算——把提示词里原先靠 LLM 自觉遵守的三条禁止项变成**代码不变量**：
 * - `created`：沿用最早的（目标块已存在则保留其原值），禁止改写
 * - `heat`：取各源块与既有目标的**最大值**，禁止重置为 0（实测发生过 32 → 0）
 * - `updated`：由调用方传入当前时间（保持纯函数）
 * - `summary`：仍由子代理提供（需要语义概括，代码无法生成）
 */
export function consolidationMeta(
	sources: Array<{ created: string; heat: number }>,
	existing: SceneMeta | null,
	now: string,
	summary: string,
): SceneMeta {
	const createdList = sources.map((s) => s.created).filter((c) => typeof c === "string" && c.length > 0).sort();
	const created = existing?.created || createdList[0] || now;
	const heats = sources.map((s) => (Number.isFinite(s.heat) ? s.heat : 0));
	if (existing && Number.isFinite(existing.heat)) heats.push(existing.heat);
	return {
		created,
		updated: now,
		summary: summary || existing?.summary || "",
		heat: heats.length > 0 ? Math.max(...heats) : 0,
	};
}

/** META 头 + 正文拼接（腾讯 formatSceneBlock）。 */
export function formatSceneBlock(meta: SceneMeta, content: string): string {
	const metaBlock = [
		META_START,
		`created: ${meta.created}`,
		`updated: ${meta.updated}`,
		`summary: ${meta.summary}`,
		`heat: ${meta.heat}`,
		META_END,
	].join("\n");
	return `${metaBlock}\n\n${content}`;
}

/** 解析场景文件为 META + 内容（腾讯 parseSceneBlock）。 */
export function parseSceneBlock(raw: string): { meta: SceneMeta; content: string } {
	const startIdx = raw.indexOf(META_START);
	const endIdx = raw.indexOf(META_END);
	if (startIdx === -1 || endIdx === -1) {
		return { meta: { created: "", updated: "", summary: "", heat: 0 }, content: raw.trim() };
	}
	const metaBlock = raw.slice(startIdx + META_START.length, endIdx).trim();
	const content = raw.slice(endIdx + META_END.length).trim();
	const field = (k: string): string => {
		const line = metaBlock.split("\n").find((l) => l.startsWith(`${k}: `));
		return line ? line.slice(k.length + 2).trim() : "";
	};
	return {
		meta: {
			created: field("created"),
			updated: field("updated"),
			summary: field("summary"),
			heat: parseInt(field("heat"), 10) || 0,
		},
		content,
	};
}

/** 原子写文件（tmp + rename，tmp 与目标同目录保证同盘 rename）。 */
function atomicWrite(filePath: string, content: string): void {
	const tmpPath = join(join(filePath, ".."), `.tmp_scene_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
	writeFileSync(tmpPath, content, "utf-8");
	try {
		renameSync(tmpPath, filePath);
	} catch {
		writeFileSync(filePath, content, "utf-8");
	}
	try {
		rmSync(tmpPath, { force: true });
	} catch {
		// ignore
	}
}

/** 场景索引条目（含成员清单）。 */
export interface SceneIndexEntry {
	filename: string;
	summary: string;
	heat: number;
	created: string;
	updated: string;
	/** 该块收录的 L1 记录 id（来自 sidecar；无记录时为 []）。 */
	members: string[];
}

/**
 * 读取成员清单 sidecar（`{memoryDB}/l2/index/scene_members.json`）。
 * 结构：`{ [filename]: string[] }`。不存在/损坏 → 空表。
 */
export function loadSceneMembers(profilePath: string): Record<string, string[]> {
	const filePath = join(profilePath, MEMORY_DB_DIR, SCENE_MEMBERS_PATH);
	if (!existsSync(filePath)) return {};
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
		const out: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(data)) {
			if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * 按本批写入更新成员清单（**纯函数**，便于测试）。
 *
 * 规则：
 * - `create` / `update` / `merge`：若写入带了 `members`（L1 记录 id 数组）→ **替换**该文件名的成员集合；
 *   未带 `members` → **保留**原有集合（不清空，宁缺勿乱）。
 * - `consolidate`：取各源块成员与显式 `members` 的**并集**写入目标，并移除所有源条目。
 *   并集必须在删除源条目**之前**计算，否则会读到已清空的表。
 * - `delete`：移除该文件名的成员条目。
 * - 同批内同一文件名多次写入 → 以最后一次为准（与落盘顺序一致）。
 *
 * 返回 `missing`：本批带了写入但**未提供任何成员可归因**的目标文件名，供调用方回传警告
 * （这样「子代理是否如实上报成员」是可观测的，而不是静默留空）。
 */
export function mergeSceneMembers(
	existing: Record<string, string[]>,
	writes: SceneWrite[],
): { members: Record<string, string[]>; missing: string[] } {
	const next: Record<string, string[]> = { ...existing };
	const missing: string[] = [];
	for (const w of writes) {
		if (w.action === "delete") {
			delete next[w.filename];
			continue;
		}
		if (w.action === "consolidate") {
			const sources = Array.isArray(w.sources) ? w.sources : [];
			const union = resolveConsolidationMembers(sources, next, w.members);
			for (const s of sources) delete next[s];
			next[w.filename] = union;
			if (union.length === 0) missing.push(w.filename);
			continue;
		}
		if (Array.isArray(w.members)) {
			// 去重、去空、保序
			next[w.filename] = [...new Set(w.members.filter((m) => typeof m === "string" && m))];
		} else if (!next[w.filename]) {
			missing.push(w.filename);
			next[w.filename] = [];
		}
	}
	return { members: next, missing };
}

/** 原子写成员清单 sidecar。 */
function saveSceneMembers(profilePath: string, members: Record<string, string[]>): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, SCENE_MEMBERS_PATH);
	const metaDir = join(profilePath, MEMORY_DB_DIR, L2_INDEX_DIR);
	if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true });
	const tmpPath = join(metaDir, `.tmp_scene_members_${Date.now()}`);
	writeFileSync(tmpPath, JSON.stringify(members, null, 2), "utf-8");
	try {
		renameSync(tmpPath, filePath);
	} catch {
		writeFileSync(filePath, readFileSync(tmpPath, "utf-8"), "utf-8");
	}
	try {
		rmSync(tmpPath, { force: true });
	} catch {
		// ignore
	}
}

/** consolidate 自动备份结果。 */
export interface ConsolidateBackup {
	/** 备份目录（相对 `{profilePath}/memoryDB/`）。 */
	dir: string;
	/** 实际写入备份的文件名。 */
	files: string[];
}

/**
 * 把即将被删除的源块整体备份到 `{memoryDB}/backups/l2-consolidate-<tag>/`。
 *
 * 为什么由代码做、而不是在规则里要求子代理先备份：合并是**破坏性**操作（删源块），备份是唯一
 * 回退手段，而"记得先备份"恰恰是 LLM 最不可靠的一类要求。放在 `backups/` 下与 memoryDB 主体
 * 隔离，只保留最近 `CONSOLIDATE_BACKUP_KEEP` 份以免无界增长。
 *
 * 刻意**不用 `git stash`** 做整体快照——该项目 08-18 有过 stash 丢密钥的事故。
 */
export function backupSceneBlocks(
	profilePath: string,
	files: Array<{ filename: string; raw: string }>,
	tag: string,
	manifest: Record<string, unknown>,
): ConsolidateBackup {
	const backupRoot = join(profilePath, MEMORY_DB_DIR, BACKUP_DIR);
	const dirName = `l2-consolidate-${tag}`;
	const dir = join(backupRoot, dirName);
	mkdirSync(dir, { recursive: true });
	const written: string[] = [];
	for (const f of files) {
		try {
			writeFileSync(join(dir, f.filename), f.raw, "utf-8");
			written.push(f.filename);
		} catch {
			// 单个文件失败不阻断整体（manifest 会如实记录实际写入清单）
		}
	}
	try {
		writeFileSync(join(dir, "_manifest.json"), JSON.stringify({ ...manifest, files: written }, null, 2), "utf-8");
	} catch {
		// ignore
	}
	pruneConsolidateBackups(backupRoot);
	return { dir: join(BACKUP_DIR, dirName), files: written };
}

/** 只保留最近 `CONSOLIDATE_BACKUP_KEEP` 份 consolidate 备份。 */
function pruneConsolidateBackups(backupRoot: string): void {
	try {
		if (!existsSync(backupRoot)) return;
		const dirs = readdirSync(backupRoot)
			.filter((d) => d.startsWith("l2-consolidate-"))
			.sort();
		while (dirs.length > CONSOLIDATE_BACKUP_KEEP) {
			const oldest = dirs.shift();
			if (oldest) rmSync(join(backupRoot, oldest), { recursive: true, force: true });
		}
	} catch {
		// 清理失败不影响主流程
	}
}

/**
 * 扫描 scene_blocks/ 全量重建场景索引（腾讯 syncSceneIndex 语义）。
 * 返回索引条目数组并写 scene_index.json。
 *
 * 成员清单不放在块文件里（块保持轻量），而是从 sidecar `scene_members.json` 读取后并入条目——
 * 索引本身是**派生物**（每次提交后重建），成员清单位于独立载体才能存活下来。
 */
export function syncSceneIndex(profilePath: string): SceneIndexEntry[] {
	const sceneDir = join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME);
	const memberMap = loadSceneMembers(profilePath);
	const entries: SceneIndexEntry[] = [];
	if (existsSync(sceneDir)) {
		for (const f of readdirSync(sceneDir)) {
			if (!f.endsWith(".md")) continue;
			try {
				const raw = readFileSync(join(sceneDir, f), "utf-8");
				const { meta } = parseSceneBlock(raw);
				entries.push({
					filename: f,
					summary: meta.summary,
					heat: meta.heat,
					created: meta.created,
					updated: meta.updated,
					members: memberMap[f] ?? [],
				});
			} catch {
				// 跳过坏文件
			}
		}
	}
	entries.sort((a, b) => b.heat - a.heat);
	const idxPath = join(profilePath, MEMORY_DB_DIR, SCENE_INDEX_PATH);
	const idxDir = join(profilePath, MEMORY_DB_DIR, L2_INDEX_DIR);
	if (!existsSync(idxDir)) mkdirSync(idxDir, { recursive: true });
	writeFileSync(idxPath, JSON.stringify(entries, null, 2), "utf-8");
	return entries;
}

/**
 * 注册 l2_commit 工具（扩展加载时调用一次）。
 *
 * 子代理调用参数：
 *  - sceneWrites: 场景写入数组 [{action, filename, meta, content}]
 *  - cursor: 推进到的 lastRecordId
 *  - personaSignal: 可选，true 表示请求 L3 persona 更新（P1 触发）
 *  - personaReason: 可选，persona 更新原因
 *
 * 【2026-09-16】`personaSignal` 的投递方式从"回调"改为"落盘信号"。
 * 回调在子代理进程里永远求值为 undefined（主进程的 l3Controls 没在这个进程初始化过），
 * 实测 46/46 次 l2_commit 全在子代理进程 ⇒ 那条 P1 指令此前从未生效。
 * 现在写 `l3/pending-trigger.json`，由主进程在 agent_settled 读取并消费（见 memory/l3/signal.ts）。
 */
export function registerL2CommitTool(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): void {
	// 本进程（= 一次子代理运行）内成功提交的次数。子代理每次运行都是新进程，所以它天然是"本轮第几次"。
	// 只用于观测与提示，见 L2CommitResult.commitSeq 的注释。
	let commitSeq = 0;
	pi.registerTool({
		name: "l2_commit",
		label: "L2 Commit Scene Writes",
		description: renderPrompt("tools#l2_commit"),
		parameters: {
			type: "object",
			properties: {
				sceneWrites: {
					type: "array",
					description: "Scene writes: action create/update/merge writes file (META header auto-added), delete removes file",
					items: {
						type: "object",
						properties: {
							action: { type: "string", enum: ["create", "update", "merge", "delete", "consolidate"] },
							filename: { type: "string" },
							sources: {
								type: "array",
								items: { type: "string" },
								description:
									"Only for action=consolidate: filenames of the blocks being merged into `filename` (>=2, must not include `filename`). The host backs them up, verifies no entry is dropped, writes the target, then deletes the sources — atomically. Prefer this over separate merge+delete writes, which carry no integrity check.",
							},
							meta: { type: "object" },
							content: { type: "string" },
							members: {
								type: "array",
								items: { type: "string" },
								description:
									"L1 record ids whose facts now live in this block. For action=consolidate omit it (the host takes the union of the sources automatically) or pass the full union — a list that misses source members is REJECTED. For other actions, omit to keep the existing set (a brand-new block omitting it leaves members empty and is reported back as a warning).",
							},
						},
						required: ["action", "filename"],
					},
				},
				cursor: { type: "string", description: "Advance L2 cursor to this record id" },
				personaSignal: { type: "boolean", description: "Set true to request L3 persona update (P1 trigger)" },
				personaReason: { type: "string", description: "Reason for persona update when personaSignal is true" },
			},
			required: ["sceneWrites", "cursor"],
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const profilePath = getProfilePath();
				if (!profilePath) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active profile" }) }], details: {} };
				}
				const writes = params?.sceneWrites as SceneWrite[] | undefined;
				const cursor = typeof params?.cursor === "string" ? params.cursor : "";
				if (!Array.isArray(writes) || !cursor) {
					return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "sceneWrites must be an array and cursor must be a string" }) }], details: {} };
				}

				const sceneDir = join(profilePath, MEMORY_DB_DIR, SCENE_DIR_NAME);
				if (!existsSync(sceneDir)) mkdirSync(sceneDir, { recursive: true });
				const now = new Date().toISOString();

				// 落盘前先做两项整体校验（此前文件名校验写在写入循环里，第二个写入非法时
				// 第一个已落盘 → 半批数据）。现在一律先全批校验、再全批落盘。
				for (const w of writes) {
					if (!FILENAME_RE.test(w.filename)) {
						return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `illegal filename: ${w.filename}` }) }], details: {} };
					}
				}
				const existingScenes = readdirSync(sceneDir).filter((f) => f.endsWith(".md"));
				const limit = loadL2Config(profilePath).maxScenes;
				const limitCheck = checkSceneLimit(existingScenes, writes, limit);
				if (!limitCheck.ok) {
					return {
						content: [{ type: "text", text: JSON.stringify({ success: false, sceneCount: existingScenes.length, error: limitCheck.error } satisfies Partial<L2CommitResult>) }],
						details: {},
					};
				}

				// ── consolidate 原子动作：结构校验 → 完整性校验 → 自动备份，三者全过才进入落盘循环 ──
				// 之所以放在代码里而不是留给子代理：`merge` 动作（写目标 + 另发 delete）是**两个独立步骤、
				// 中间无任何校验**，历史上由此发生过 3 次静默丢内容（对照外部备份 -42.8% / -41.7%）。
				// consolidate 把"不丢条目"和"可回退"这两件事从 LLM 的自觉变成代码的不变量。
				const memberMapBefore = loadSceneMembers(profilePath);
				const backupTag = `${now.replace(/\D/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
				const consolidations: Array<{
					write: SceneWrite;
					sourceFiles: string[];
					meta: SceneMeta;
					check: ConsolidationCheck;
					backup: ConsolidateBackup;
				}> = [];

				for (const w of writes) {
					if (w.action !== "consolidate") continue;
					const sources = Array.isArray(w.sources)
						? w.sources.filter((s): s is string => typeof s === "string" && s.length > 0)
						: [];
					if (sources.length < 2) {
						return {
							content: [{ type: "text", text: JSON.stringify({ success: false, sceneCount: existingScenes.length, error: `consolidate 需要至少 2 个源块，收到 ${sources.length} 个（目标 ${w.filename}）` } satisfies Partial<L2CommitResult>) }],
							details: {},
						};
					}
					if (sources.includes(w.filename)) {
						return {
							content: [{ type: "text", text: JSON.stringify({ success: false, sceneCount: existingScenes.length, error: `consolidate 的 sources 不得包含目标块自身（${w.filename}）` } satisfies Partial<L2CommitResult>) }],
							details: {},
						};
					}
					// 源块必须是目录中已存在的块（顺带挡住路径穿越）
					const missingFiles = sources.filter((s) => !existingScenes.includes(s));
					if (missingFiles.length > 0) {
						return {
							content: [{ type: "text", text: JSON.stringify({ success: false, sceneCount: existingScenes.length, error: `consolidate 的源块不存在：${missingFiles.join("、")}` } satisfies Partial<L2CommitResult>) }],
							details: {},
						};
					}

					const srcData = sources.map((s) => {
						const raw = readFileSync(join(sceneDir, s), "utf-8");
						const parsed = parseSceneBlock(raw);
						return { filename: s, raw, meta: parsed.meta, content: parsed.content, members: memberMapBefore[s] ?? [] };
					});

					const check = checkConsolidation(srcData, {
						filename: w.filename,
						content: typeof w.content === "string" ? w.content : "",
						members: w.members,
					});
					if (!check.ok) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										success: false,
										sceneCount: existingScenes.length,
										error: check.error,
										consolidation: {
											target: w.filename,
											sources,
											ok: false,
											memberGaps: check.memberGaps.slice(0, 10),
											lines: check.lines,
											warnings: check.warnings,
										},
									} satisfies Partial<L2CommitResult>),
								},
							],
							details: {},
						};
					}

					// 目标可能已存在（"把 A 并入 B"）——取其原 META，让 created 保留、heat 参与取最大
					const targetPath = join(sceneDir, w.filename);
					let existingMeta: SceneMeta | null = null;
					if (existsSync(targetPath)) {
						try {
							existingMeta = parseSceneBlock(readFileSync(targetPath, "utf-8")).meta;
						} catch {
							existingMeta = null;
						}
					}

					const backup = backupSceneBlocks(
						profilePath,
						srcData.map((s) => ({ filename: s.filename, raw: s.raw })),
						backupTag,
						{
							at: now,
							target: w.filename,
							sources,
							sourceMembers: Object.fromEntries(srcData.map((s) => [s.filename, s.members])),
							check: { lines: check.lines, warnings: check.warnings },
						},
					);

					consolidations.push({
						write: w,
						sourceFiles: sources,
						meta: consolidationMeta(
							srcData.map((s) => s.meta),
							existingMeta,
							now,
							w.meta?.summary ?? "",
						),
						check,
						backup,
					});
				}

				for (const w of writes) {
					const filePath = join(sceneDir, w.filename);
					if (w.action === "delete") {
						try {
							rmSync(filePath, { force: true });
						} catch {
							// ignore
						}
						continue;
					}
					if (w.action === "consolidate") {
						const info = consolidations.find((c) => c.write === w);
						if (!info) continue;
						// **顺序是关键**：先落目标块，再删源块。反过来的话，中途失败会得到
						// 「源已删、目标未建」= 内容真丢失；当前顺序最坏只是暂时多出一个块（可重试）。
						atomicWrite(filePath, formatSceneBlock(info.meta, typeof w.content === "string" ? w.content : ""));
						for (const s of info.sourceFiles) {
							if (s === w.filename) continue;
							try {
								rmSync(join(sceneDir, s), { force: true });
							} catch {
								// ignore
							}
						}
						continue;
					}
					// create/update/merge：META + content 落盘
					const meta: SceneMeta = {
						created: w.meta?.created || now,
						updated: w.meta?.updated || now,
						summary: w.meta?.summary || "",
						heat: typeof w.meta?.heat === "number" ? w.meta.heat : 0,
					};
					const content = typeof w.content === "string" ? w.content : "";
					atomicWrite(filePath, formatSceneBlock(meta, content));
				}

			// 成员清单落 sidecar —— 必须在 syncSceneIndex 之前（索引重建时会读取它并入条目）
			const memberUpdate = mergeSceneMembers(loadSceneMembers(profilePath), writes);
			saveSceneMembers(profilePath, memberUpdate.members);

			// 同步场景索引（全量重建）
			const entries = syncSceneIndex(profilePath);

			// 不变量观测（2026-09-16）：预检已按落盘效果计增长，正常到不了这里。若仍超限，说明存在
			// 未被预检覆盖的增长路径，或两次提交交错（工具自身无锁，串行靠 pipeline 的 hasActive("l2")）。
			// 留痕而不是静默超限——这个信号一出现就说明硬上限的假设被打破了。
			const overLimitWarning =
				entries.length > limit
					? `场景块数量 ${entries.length} 超过硬上限 ${limit}：本批增长未被上限预检覆盖，请复核本批写入，并在下次运行用 consolidate 收缩。`
					: undefined;

			// L2 游标推进：以子代理上报的 cursor 为真源（fc78374 已移除主进程 runTask 的
			// 预推进——fire-and-forget 下 runTask 在子代理真实加工前 resolve，预推进会把
			// 本批记录从 read_l1_increment 增量中滤掉造成空转）。
			// 此处写回 lastRecordId + 反推 epoch，供下次增量过滤使用。
			saveL2Cursor(profilePath, recordEpochMs(cursor), cursor);

			// personaSignal → 落盘信号（主进程 agent_settled 消费）。见 registerL2CommitTool 头注释。
			const personaSignal = params?.personaSignal === true;
			const personaReason = typeof params?.personaReason === "string" ? params.personaReason : undefined;
			if (personaSignal) {
				writePendingTrigger(profilePath, { personaSignal: true, personaReason });
			}

			// L2 job 的**真完成信号**（2026-09-19）：由子代理提交成功这一刻写下。
			// 主进程 worker 靠轮询这张表判断"L2 跑完了"，不再信 `await runPiSubagent` 的返回
			// （async:true 下它只代表"派出去了"）—— 那是两个 L2 并发改场景块的根因。
			try {
				const jobs = getPipelineJobsDB(profilePath);
				const doneNow = jobs.completeRunningL2();
				// 2026-09-21：与 L1 同款的「超时误判」认领。L2 的超时曾只有 180s，连续四次
				// （jobs 55/61/64/68）都是"主进程标 failed、子代理还在跑、最后照样提交" ——
				// 活与场景都落了盘，账上却记失败，三次即熔断（那是 L2 停摆的直接原因）。
				// 这里把刚被误判的 job 纠正为 done，并清零失败计数。
				const reclaimed = jobs.reclaimTimedOutL2();
				if (doneNow + reclaimed > 0) {
					try {
						const fs = loadFailureState(profilePath);
						if (fs.l2.consecutiveFailures > 0 || fs.l2.cooledDown) {
							fs.l2.consecutiveFailures = 0;
							fs.l2.cooledDown = false;
							saveFailureState(profilePath, fs);
							logEvent(
								"l2",
								`纠正超时误判：job done=${doneNow} reclaimed=${reclaimed}，L2 失败计数已重置`,
								profilePath,
							);
						}
					} catch {
						// 熔断状态写失败不影响提交
					}
				}
			} catch {
				// 队列不可用不影响写盘（记录/场景已落盘）
			}

			// 本轮第几次成功提交（见 L2CommitResult.commitSeq）。计数在**成功路径**上自增，
				// 第 2 次起落一行日志 —— 这一条是"L2 为什么慢"的可观测锚点（每次提交 = 一整轮大生成）。
			commitSeq += 1;
			if (commitSeq > 1) {
				logEvent("l2", `第 ${commitSeq} 次 l2_commit（本轮多次提交会多走 ${commitSeq - 1} 轮模型生成）`, profilePath);
			}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								sceneCount: entries.length,
								cursor,
								commitSeq,
								...(commitSeq > 1 ? { commitHint: commitHintText(commitSeq) } : {}),
								// 未上报 members 的目标文件（可观测：便于判断子代理是否如实填写）
								...(memberUpdate.missing.length > 0 ? { membersMissing: memberUpdate.missing } : {}),
								// 上限不变量被破坏的信号（正常不出现）
								...(overLimitWarning ? { warning: overLimitWarning } : {}),
								// consolidate 回报：备份路径 + 行数比 + 警告，供子代理自查"是否丢了条目"
								...(consolidations.length > 0
									? {
											consolidations: consolidations.map(
												(c): ConsolidationReport => ({
													target: c.write.filename,
													sources: c.sourceFiles,
													backupDir: c.backup.dir,
													membersSource: Array.isArray(c.write.members) ? "explicit" : "auto-union",
													lines: c.check.lines,
													warnings: c.check.warnings,
												}),
											),
										}
									: {}),
							} satisfies L2CommitResult),
						},
					],
					details: {},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ success: false, sceneCount: 0, error: err instanceof Error ? err.message : String(err) } satisfies L2CommitResult) }],
					details: {},
				};
			}
		},
	});
}
