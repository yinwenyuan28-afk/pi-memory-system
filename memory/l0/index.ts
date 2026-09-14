import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	appendFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseSessionLines } from "./session-parser.ts";
import { buildRuleSet, replaceBase64WithImage, sanitizeText, shouldCaptureL0 } from "./sanitize.ts";
import { L0_CONVERSATIONS_DIR, L0_CURSOR_FILE, MEMORY_DB_DIR } from "../paths.ts";

// ══════════════════════════════════════════════════════════════
//  L0 净化归档层
//
//  定位（对照腾讯 MemoryCore L0）：把 pi session JSONL 的脏原文，增量转换为
//  干净、按天分片、生命周期独立的长期资产。腾讯 L0 是对抗"宿主不可访问性"
//  （adapter 读不到宿主 session）；我们能直接读文件，所以不需要腾讯的
//  checkpoint 时间戳游标 + 位置切片 + 文件锁三重防护——行号游标（append-only
//  已勘察确认）即天然去重键，单进程 agent_settled 串行无并发窗口。
//
//  管线：读文件增量行 → parseSessionLines（角色/文本提取）→ base64 → [image]
//        → sanitizeText（可扩展规则集）→ shouldCaptureL0（宽松过滤）
//        → append 当日分片 → 推进游标
// ══════════════════════════════════════════════════════════════

/** 游标文件名（独立于 review-cursor.json——两个消费者推进节奏不同）。 */
const CURSOR_FILE = L0_CURSOR_FILE;
/** 分片目录（{memoryDB}/conversations/）。 */
const CONVERSATIONS_DIR = L0_CONVERSATIONS_DIR;

/** 一次 L0 增量归档的结果。 */
export interface L0ArchiveResult {
	/** 本次实际写入 L0 分片的消息数。 */
	recorded: number;
	/** 解析到但被过滤掉的消息数（非 user/assistant 角色、降噪后为空、斜杠命令等）。 */
	filtered: number;
	/** 非致命错误信息（如 session 文件不存在）；无错误时为 undefined。 */
	error?: string;
}

// ── 本地日期分片 ──

/**
 * 本地时区 YYYY-MM-DD（分片文件名用，照抄腾讯 formatLocalDate）。
 */
function localDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

// ── 游标读写 ──

interface L0CursorEntry {
	sessionPath: string;
	line: number;
}

/**
 * 读取某 session 的 L0 游标行号；无游标或 session 不匹配返回 0。
 */
function loadL0Cursor(profilePath: string, sessionPath: string): number {
	const filePath = join(profilePath, MEMORY_DB_DIR, CURSOR_FILE);
	if (!existsSync(filePath)) return 0;
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, L0CursorEntry>;
		const entry = data[sessionPath];
		if (!entry || entry.sessionPath !== sessionPath || typeof entry.line !== "number") return 0;
		return entry.line;
	} catch {
		return 0;
	}
}

/**
 * 原子写游标（tmp + rename，复用 review-cursor 的 saveCursor 模式）。
 */
function saveL0Cursor(profilePath: string, sessionPath: string, line: number): void {
	const filePath = join(profilePath, MEMORY_DB_DIR, CURSOR_FILE);
	let data: Record<string, L0CursorEntry> = {};
	if (existsSync(filePath)) {
		try {
			data = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, L0CursorEntry>;
		} catch {
			data = {};
		}
	}
	data[sessionPath] = { sessionPath, line };
	const tmpPath = join(profilePath, MEMORY_DB_DIR, `.tmp_l0_cursor_${Date.now()}`);
	writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
	try {
		rmSync(filePath, { force: true });
	} catch {
		// ignore
	}
	try {
		renameSync(tmpPath, filePath);
	} catch {
		// 目标可能被占用（罕见并发），回退为直接写
		writeFileSync(filePath, readFileSync(tmpPath, "utf-8"), "utf-8");
	}
	try {
		rmSync(tmpPath, { force: true });
	} catch {
		// ignore
	}
}

// ── 主流程 ──

/**
 * 从 session 文件路径启发式解码 cwd（pi 编码不可逆，仅兜底用）。
 *
 * pi 的编码（session-manager.ts getDefaultSessionDirPath）：
 *   `--${cwd.replace(/^[\/\\]/, "").replace(/[\/\\:]/g, "-")}--`
 * 即目录名 = `--C--dev-code_java-wangxin-backend-A104527--`（`/`、`\`、`:` 全→`-`）。
 * 解码：去首尾 `--` → 首个字母后跟 `-` 视为盘符冒号 → 其余 `-` 视为 `/`。
 * 局限：原路径含 `-` 时失真（如 my-project → my/project）；有 ctx.cwd 时勿用此路径。
 */
export function decodeCwdFromSessionPath(sessionPath: string): string {
	const parentDir = basename(dirname(sessionPath));
	if (!parentDir.startsWith("--") || !parentDir.endsWith("--")) return "";
	let inner = parentDir.slice(2, -2);
	// 盘符：首字母 + 紧跟的 `-` → `:`（如 C- → C:）
	if (/^[a-zA-Z]-/.test(inner)) {
		inner = inner[0] + ":" + inner.slice(2);
	}
	return inner.replace(/-/g, "/");
}

/**
 * 增量归档一个 session 的新增消息到 L0 分片。
 *
 * 幂等性：游标记录上次处理到的行号；本次只处理游标之后的增量行。
 * 写入成功才推进游标（写失败不推进，下次重试防丢消息）。
 *
 * @param sessionPath  session JSONL 文件绝对路径
 * @param profilePath  当前 profile 目录（L0 数据与游标都存这里，跟随 profile）
 * @param cwd          工作目录（可选；从扩展 ctx.cwd 传入，精确值。缺省时从
 *                     session 目录名启发式解码——pi 的编码不可逆，含 `-` 的路径会失真）
 * @returns L0ArchiveResult
 */
export function archiveSessionIncrement(sessionPath: string, profilePath: string, cwd?: string): L0ArchiveResult {
	if (!existsSync(sessionPath)) {
		return { recorded: 0, filtered: 0, error: `session file not found: ${sessionPath}` };
	}

	const cursor = loadL0Cursor(profilePath, sessionPath);
	const raw = readFileSync(sessionPath, "utf-8");
	// 按行分割后去掉 split 产生的尾部空串（空文件 / 以换行结尾），
	// 保证「行号 = 数组 index + 1」在追加后仍成立——否则尾部空串会占据一个
	// index，追加新行后旧游标跳过的恰是新行（真实 bug，2026-08-17 验证修复）。
	const lines = raw.split(/\r?\n/);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const totalLines = lines.length;

	if (totalLines <= cursor) {
		return { recorded: 0, filtered: 0 }; // 无新增
	}

	// 只解析增量行段（startLine = cursor + 1，与文件真实行号对齐）
	const parsed = parseSessionLines(lines.slice(cursor), cursor + 1);

	// 规则集：内置 + 外部 l0-sanitize-rules.json（每轮构建一次，规则数少开销可忽略）
	const rules = buildRuleSet(profilePath);

	// cwd：优先显式传入（ctx.cwd 精确）；兜底从 session 目录名启发式解码
	const effectiveCwd = cwd || decodeCwdFromSessionPath(sessionPath);

	const records: string[] = [];
	const now = new Date();
	const recordedAt = now.toISOString();
	const sessionKey = basename(sessionPath).replace(/\.jsonl$/, "");
	let filtered = 0;

	for (const msg of parsed) {
		// 角色过滤：只保留 user/assistant（toolResult/custom 等丢弃）
		if (msg.role !== "user" && msg.role !== "assistant") {
			filtered++;
			continue;
		}

		// base64 图片 → [image] 占位符（保留含图信号，防污染索引）
		let content = replaceBase64WithImage(msg.content);

		// 降噪（可扩展规则集）
		content = sanitizeText(content, msg.role, rules);

		// 宽松过滤：空 / 斜杠命令 / 纯 [image]
		if (!shouldCaptureL0(content)) {
			filtered++;
			continue;
		}

		records.push(
			JSON.stringify({
				sessionKey,
				recordedAt,
				id: msg.id ?? null,
				role: msg.role,
				content,
				timestamp: msg.timestamp ?? null,
				cwd: effectiveCwd,
			}),
		);
	}

	// 写入分片（本地日期，跨 session 混排）
	if (records.length > 0) {
		const shardDir = join(profilePath, MEMORY_DB_DIR, CONVERSATIONS_DIR);
		if (!existsSync(shardDir)) mkdirSync(shardDir, { recursive: true });
		const shardPath = join(shardDir, `${localDate(now)}.jsonl`);
		appendFileSync(shardPath, records.join("\n") + "\n", "utf-8");
	}

	// 写成功（或无记录）→ 推进游标到文件末尾，避免下次重复处理
	saveL0Cursor(profilePath, sessionPath, totalLines);

	return { recorded: records.length, filtered };
}
