/**
 * 通知唯一出口（util/notice.ts）
 *
 * 用途：把 memory-system 里"给人看的运行信息"按「用户是否需要知道 / 事后是否需要回查」
 * 分流到三条出口：
 *
 *   1. `noticeCard()`  聊天区**卡片**（`pi.appendEntry` + entry renderer）
 *      —— 写进 session JSONL，重启可回查；官方明确**不进 LLM 上下文**（不烧 token）；支持展开看详情。
 *   2. `notice()`      聊天区**一行**（`ctx.ui.notify`）
 *      —— 即时提示；不落盘，且连续两条会在同一位置互相覆盖（**勿用于需留痕的信息**）。
 *   3. `logEvent()`    文件（`{profile}/memoryDB/logs/{scope}.log`，单文件 5MB 轮转一代）
 *      —— 高频观测 / 诊断；每 turn 级别的信息只许走这里。
 *
 * 为什么必须有这个模块（2026-09-19 实测）：interactive 模式 pi **不接管 stdout**
 * （`main.ts`: `shouldTakeOverStdout = appMode !== "interactive"`），而 TUI 的差分渲染完全依赖
 * 自己的光标账本（`previousLines` / `hardwareCursorRow`）。任何 `console.*` 都是"野生写终端"：
 * 光标账本失步 → 残留野行、TUI 内容错位；且这些信息既不落会话也不落盘，事后无从回查
 * （实例：`hybrid-recall.ts` 的召回观测行每 turn 在输入框上方留一行）。
 *
 * 跨进程（本模块的核心复杂度）：L1/L2/L3 子代理跑在**独立进程**（我们自建 spawn 的
 * `pi --mode text` 子进程，见 `util/spawn.ts`；2026-10-01 之前是 pi-subagents 的 spawn + `--mode json`），
 * 那里 `appendEntry` 只会写进子代理自己的 session，用户看不到。所以子代理进程里的 `noticeCard()`
 * 改为把载荷追加到 `{memoryDB}/logs/notices.jsonl`，由主进程 `drainNoticeCards()` 原子取走
 * （rename → 读 → 删）后再渲染成真正的聊天区卡片。drain 挂在 pipeline worker 每个 job 收尾 +
 * `agent_settled`（见 index.ts / pipeline/worker.ts）。
 *
 * 纪律：运行时代码**不得**再新增 `console.*`。仅两处豁免——`prompts/registry.ts`（加载期兜底）
 * 与 `memory/l2/config.ts`（deprecation）：它们发生时 profile 未知，无处落盘。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MEMORY_DB_DIR, MEMORY_LOGS_DIR, NOTICE_QUEUE_FILE } from "../memory/paths.ts";
import { t } from "../i18n/index.ts";

/** 通知级别（与 `ctx.ui.notify` 的枚举一致；调用方误传 `"warn"` 会被归一为 `"warning"`）。 */
export type NoticeLevel = "info" | "warning" | "error";

/** 卡片在 session 里的 entry 类型（`pi.appendEntry` 的 customType，也是 renderer 的注册键）。 */
export const NOTICE_ENTRY_TYPE = "memory-system/notice";

/** 卡片载荷：渲染所需的一切都在这里，renderer 不依赖任何外部状态。 */
export interface NoticePayload {
	level: NoticeLevel;
	/** 一行标题（卡片折叠态的首行，建议 < 60 字）。 */
	title: string;
	/** 摘要行（折叠态可见，建议 ≤ 12 行、每行短句）。 */
	lines?: string[];
	/** 详情全文（仅展开态渲染；报告类命令把完整输出放这里）。 */
	detail?: string;
	/** 生成时刻（ISO；drain 时也用于排序）。 */
	ts: string;
}

/** 日志单文件轮转阈值（5MB）：超过即重命名为 `{scope}.log.1`，只保留一代。 */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/** 卡片展开态最多渲染的 detail 行数（防止把几百行的报告灌进 TUI）。 */
const DETAIL_MAX_LINES = 80;

// ── profile 解析（由 index.ts 在模块顶层注入，避免 notice ↔ manager 循环依赖） ──

let profileResolver: (() => string | undefined) | undefined;

/**
 * 扩展 API 句柄（模块级单例）。
 *
 * 为什么不把 `pi` 一阶一阶当参数传：向量库（store.ts）这类深层模块也必须能发卡片，
 * 而它处于 `getVectorStore(profilePath)` 调用链上（被召回/回填/重建多处调用）。
 * 为发一张卡片去改那条链上所有签名不划算，故由 `initNotice(pi)` 在模块顶层装一次句柄。
 */
let extensionApi: ExtensionAPI | undefined;

/** 注入 profile 路径解析器（index.ts 模块顶层调一次；子代理进程同样会注入）。 */
export function setNoticeProfileResolver(fn: () => string | undefined): void {
	profileResolver = fn;
}

/** 取当前 profile 路径；解析器抛错一律当"未知"处理（通知模块不得影响主流程）。 */
function currentProfilePath(): string | undefined {
	try {
		return profileResolver?.();
	} catch {
		return undefined;
	}
}

/** 是否身处子代理进程（`util/spawn.ts` 在 spawn 时注入 `PI_SUBAGENT_CHILD=1`）。 */
function isSubagentChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1";
}

// ── 去重（同一条告警一个会话只发一次） ──────────────────────────

const emittedKeys = new Set<string>();

/** 清空去重集合（`session_start` 调用；保证新会话能重新看到一次性告警）。 */
export function resetNoticeDedup(): void {
	emittedKeys.clear();
}

// ── 行宽处理（自实现，刻意不引 @earendil-works/pi-tui） ─────────
//
// 为什么不复用 TUI 的组件：本扩展目录下装的 pi-tui 是 0.80.10，而宿主运行时是另一份
// （0.84.2），两份实例混用有风险；且它只是 extensions/ 的**传递依赖**（未在 package.json 声明）。
// 宿主对 renderer 返回值的唯一要求是鸭子类型的 `{ render(width): string[] }`
// （tui 的 `Component` 接口），所以自实现即可。
//
// 另一个纪律：**超宽行绝不能交给 TUI**——tui.ts 对 `visibleWidth(line) > width` 会写
// pi-crash.log 并触发整屏重绘。故所有行都先过 `fitWidth()`。

/** 判断一个码点是否占 2 列（East Asian Wide / Fullwidth 的主要区间）。 */
function isWideCodePoint(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 / 康熙部首 / CJK 符号
		(cp >= 0x3041 && cp <= 0x33ff) || // 假名 ~ CJK 兼容
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
		(cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
		(cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
		(cp >= 0xfe10 && cp <= 0xfe19) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) || // 全角形式
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以后
	);
}

/** 可见宽度（CJK 宽字符按 2 列计；组合符/零宽字符不额外计，本模块的文案里不出现）。 */
function displayWidth(text: string): number {
	let w = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		w += isWideCodePoint(cp) ? 2 : 1;
	}
	return w;
}

/**
 * 把一行文本截断到给定可见宽度（超出部分用 `…` 收尾）。
 *
 * @param text  纯文本（**不要**先插 ANSI 颜色码——测量会算进去；本模块的做法是先 fit 再上色）
 * @param width 终端列宽
 * @returns 宽度 ≤ width 的字符串
 */
export function fitWidth(text: string, width: number): string {
	if (width <= 0) return "";
	if (displayWidth(text) <= width) return text;
	const budget = Math.max(0, width - 1); // 留 1 列给省略号
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		const cw = isWideCodePoint(cp) ? 2 : 1;
		if (w + cw > budget) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

// ── 卡片渲染器 ────────────────────────────────────────────────

/** 级别的显示色名（theme.fg 的键）。 */
function levelColor(level: NoticeLevel): string {
	if (level === "error") return "error";
	if (level === "warning") return "warning";
	return "dim";
}

/**
 * 组装卡片的纯文本行（**不含 ANSI**，由 render 再上色 + fitWidth）。
 *
 * 折叠态：标题 + lines +（有 detail 时）一行"展开查看详情"提示。
 * 展开态：标题 + lines + detail 全文（最多 DETAIL_MAX_LINES 行，超出给省略提示）。
 */
function buildCardLines(data: NoticePayload, expanded: boolean): string[] {
	const out: string[] = [`[memory] ${data.title}`];
	for (const line of data.lines ?? []) out.push(`  ${line}`);
	if (data.detail) {
		if (!expanded) {
			out.push(`  ${t("ext.card.expandHint")}`);
		} else {
			const detailLines = data.detail.split(/\r?\n/);
			for (const line of detailLines.slice(0, DETAIL_MAX_LINES)) out.push(`  ${line}`);
			if (detailLines.length > DETAIL_MAX_LINES) {
				out.push(`  ${t("ext.card.detailOverflow", { n: detailLines.length - DETAIL_MAX_LINES })}`);
			}
		}
	}
	return out;
}

/**
 * 卡片渲染器（宿主在 interactive 模式下调用）。
 *
 * 返回鸭子类型的 `{ render(width) }`：宿主只依赖 `Component` 接口的 `render(width): string[]`，
 * 所以不需要 import TUI 组件（见文件头部关于 pi-tui 版本差异的说明）。
 */
function renderNoticeEntry(entry: { data?: unknown }, options: { expanded?: boolean }, theme: any) {
	const data = (entry.data ?? {}) as NoticePayload;
	const color = levelColor(data.level ?? "info");
	return {
		render(width: number): string[] {
			return buildCardLines(data, options?.expanded === true).map((line) =>
				theme?.fg ? theme.fg(color, fitWidth(line, width)) : fitWidth(line, width),
			);
		},
	};
}

/**
 * 初始化通知模块（index.ts 模块顶层调一次）：装 API 句柄 + 注册卡片渲染器。
 *
 * 用可选链调用：回归脚本里的假 pi、以及未来若被裁掉的版本都不该因此抛错。
 */
export function initNotice(pi: ExtensionAPI): void {
	extensionApi = pi;
	(pi as any)?.registerEntryRenderer?.(NOTICE_ENTRY_TYPE, renderNoticeEntry);
}

// ── 出口 1：卡片 ──────────────────────────────────────────────

/** 卡片入参（`noticeCard` 的公开形态，多一个去重键）。 */
export interface NoticeCardInput {
	level: NoticeLevel;
	title: string;
	lines?: string[];
	detail?: string;
	/**
	 * 去重键：给了就"同一会话只发一次"。
	 * 用于每次都会命中的告警（价值校验 fail-open、向量库一致性异常），避免会话里堆一摞同样的卡片。
	 */
	dedupKey?: string;
}

/**
 * 发一张聊天区卡片（重要事件的正规通道）。
 *
 * 主进程 → 直接 `pi.appendEntry()`（interactive 立即渲染，落 session）。
 * 子代理进程 → 追加到 `notices.jsonl`，等主进程 drain（子代理的 appendEntry 用户看不到）。
 *
 * @param input 载荷；`dedupKey` 命中时直接返回（不发也不记）
 */
export function noticeCard(input: NoticeCardInput): void {
	if (input.dedupKey && emittedKeys.has(input.dedupKey)) return;
	const payload: NoticePayload = {
		level: input.level,
		title: input.title,
		...(input.lines && input.lines.length > 0 ? { lines: input.lines } : {}),
		...(input.detail ? { detail: input.detail } : {}),
		ts: new Date().toISOString(),
	};

	if (isSubagentChild()) {
		const profilePath = currentProfilePath();
		if (!profilePath) return; // 无主可投：宁可丢一条通知，也不写进无主目录
		try {
			appendNoticeQueue(profilePath, payload);
		} catch {
			// 通知写失败不得影响主流程（子代理会照常提交自己的产物）
		}
	} else {
		try {
			extensionApi?.appendEntry?.(NOTICE_ENTRY_TYPE, payload);
		} catch {
			// 同上：缺 API 或写 entry 失败时静默跳过
		}
	}
	if (input.dedupKey) emittedKeys.add(input.dedupKey);
}

/**
 * 报告类卡片（命令输出专用便捷函数）。
 *
 * 把一段多行文本自动切成「前 N 行摘要 + 全文 detail」，调用方不必自己拆。
 *
 * @param maxSummaryLines 折叠态显示的行数（默认 12）
 */
export function noticeReport(
	title: string,
	text: string,
	options: { level?: NoticeLevel; maxSummaryLines?: number; dedupKey?: string } = {},
): void {
	const all = (text ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0);
	const max = options.maxSummaryLines ?? 12;
	noticeCard({
		level: options.level ?? "info",
		title,
		lines: all.slice(0, max),
		...(all.length > max ? { detail: text } : {}),
		...(options.dedupKey ? { dedupKey: options.dedupKey } : {}),
	});
}

/** notices.jsonl 的绝对路径（主进程与子进程都用它）。 */
function noticeQueuePath(profilePath: string): string {
	return join(profilePath, MEMORY_DB_DIR, NOTICE_QUEUE_FILE);
}

/** 子代理进程：把卡片载荷追加进队列文件（append-only JSONL）。 */
function appendNoticeQueue(profilePath: string, payload: NoticePayload): void {
	const file = noticeQueuePath(profilePath);
	mkdirSync(join(profilePath, MEMORY_DB_DIR, MEMORY_LOGS_DIR), { recursive: true });
	appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
}

/**
 * 主进程：把子代理落盘的卡片取出来渲染成聊天区卡片。
 *
 * 并发安全靠 **rename 原子性**：先把队列文件改名为 `.draining` 再读——子代理期间新追加的行
 * 会进到新的 `notices.jsonl`，不会丢也不会读到半个文件。上次崩溃残留的 `.draining` 会被清掉。
 *
 * @returns 实际渲染的卡片条数（0 = 无内容或不在主进程）
 */
export function drainNoticeCards(): number {
	if (isSubagentChild()) return 0;
	const profilePath = currentProfilePath();
	if (!profilePath) return 0;

	const file = noticeQueuePath(profilePath);
	const draining = `${file}.draining`;

	// 上次进程崩溃可能留下 .draining：直接丢弃（内容可以在 cards 从未渲染时重放，
	// 但残留文件把后续 drain 全部卡死才是更糟的故障）
	if (existsSync(draining)) {
		try {
			unlinkSync(draining);
		} catch {
			return 0;
		}
	}
	try {
		renameSync(file, draining); // ENOENT = 队列为空，正常路径
	} catch {
		return 0;
	}

	let rendered = 0;
	let raw = "";
	try {
		raw = readFileSync(draining, "utf8");
	} catch (e) {
		logEvent("notice", `读取 drain 文件失败（${e instanceof Error ? e.message : String(e)}）`, profilePath);
		return 0;
	}

	for (const line of raw.split(/\r?\n/)) {
		const text = line.trim();
		if (!text) continue;
		try {
			const payload = JSON.parse(text) as NoticePayload;
			if (!payload?.title || !payload?.level) throw new Error("载荷缺 title/level");
			extensionApi?.appendEntry?.(NOTICE_ENTRY_TYPE, { ...payload, ts: payload.ts ?? new Date().toISOString() });
			rendered++;
		} catch {
			// 坏行（半截 JSON / 字段缺失）不得吃掉其余通知
			logEvent("notice", `丢弃坏行：${text.slice(0, 120)}`, profilePath);
		}
	}

	try {
		unlinkSync(draining);
	} catch {
		// 删不掉也不致命：下次 drain 的残留清理会处理
	}
	return rendered;
}

// ── 出口 2：聊天区一行 ────────────────────────────────────────

/** 级别归一：兼容调用方写的 `"warn"`（pi 的枚举里没有它，会被当成 info 渲染成灰字）。 */
function normalizeLevel(level: NoticeLevel | "warn"): NoticeLevel {
	return level === "warn" ? "warning" : level;
}

/**
 * 发一条聊天区即时提示（`ctx.ui.notify`）。
 *
 * 注意：**不落盘**且连续两条会在同一位置互相覆盖 —— 需要留痕的信息用 `noticeCard()`。
 * 子代理进程里直接 no-op（子代理跑 `--mode json`，UI 方法本就无效）。
 */
export function notice(ctx: ExtensionContext | undefined, level: NoticeLevel | "warn", message: string): void {
	if (isSubagentChild()) return;
	const ui = (ctx as any)?.ui;
	if (typeof ui?.notify !== "function") return;
	ui.notify(message, normalizeLevel(level));
}

// ── 出口 3：文件日志 ──────────────────────────────────────────

/** scope 白名单化：只允许 `[a-z0-9_-]`，防止调用方把路径片段当 scope 传进来。 */
function sanitizeScope(scope: string): string {
	const cleaned = (scope ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 32) : "misc";
}

/** 超过阈值就把 `{scope}.log` 轮转为 `{scope}.log.1`（只留一代；Windows 下 rename 前须先删目标）。 */
function rotateIfNeeded(file: string): void {
	try {
		if (!existsSync(file)) return;
		if (statSync(file).size < LOG_ROTATE_BYTES) return;
		const rotated = `${file}.1`;
		if (existsSync(rotated)) unlinkSync(rotated);
		renameSync(file, rotated);
	} catch {
		// 轮转失败不阻塞写入（下次再来）
	}
}

/**
 * 写一条运行日志到 `{profile}/memoryDB/logs/{scope}.log`。
 *
 * 这是"高频观测"的唯一去处：每 turn 级别的信息（召回观测行、L3 未触发原因、编排决策）
 * 必须走这里，不许打终端、也不许进聊天区。
 *
 * @param scope       日志分类（recall / l3 / l1 / l2 / pipeline / store / l0 / skill / notice）
 * @param message     日志正文（自动加 ISO 时间戳前缀）
 * @param profilePath 可选；省略时用注入的 profile 解析器（子代理进程同样能解析）
 */
export function logEvent(scope: string, message: string, profilePath?: string): void {
	const profile = profilePath ?? currentProfilePath();
	if (!profile) return; // profile 未知（加载期）时无处落盘 —— 这类事件由启动期自检汇总成卡片
	const dir = join(profile, MEMORY_DB_DIR, MEMORY_LOGS_DIR);
	const file = join(dir, `${sanitizeScope(scope)}.log`);
	try {
		mkdirSync(dir, { recursive: true });
		rotateIfNeeded(file);
		appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, "utf8");
	} catch {
		// 日志写失败绝不能影响主流程（最坏情况是丢一条观测）
	}
}
