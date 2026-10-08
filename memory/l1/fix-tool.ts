// L1 修正工具（agent 自发纠错入口）——pi 工具 `l1_fix` + 命令 `/my-memory:l1:fix`
//
// 背景（2026-09-11 A 档）：agent 命中 L1 记忆发现错误时，可调本工具就地修正/作废。
// 执行层复用 scripts/l1-admin 的 rewrite.mjs / tombstone.mjs（单一实现），
// 本模块只负责「护栏」：evidence 门槛 / 审计标注自动追加 / 24h 防抖 / 高价值保护（--force 可绕）。
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { L1_RECORDS_DIR, L2_ARCHIVE_MEMBERS_PATH, L2_SCENE_INDEX_PATH, MEMORY_DB_DIR } from "../paths.ts";
import { getL1HitStatsDB } from "../stats/l1-hit-stats-db.ts";
import { render as renderPrompt } from "../../prompts/registry.ts";
import { FIX_DEBOUNCE_HOURS, FIX_DEBOUNCE_MS, FIX_HIGH_VALUE_HITS, FIX_MIN_EVIDENCE_CHARS } from "../../config/thresholds.ts";
import { promptVarsFor } from "../../prompts/tool-vars.ts";

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "l1-admin");
const AUDIT_RE = /【\d{4}-\d{2}-\d{2} L1 修正/;
// 三道闸阈值来自 config/thresholds.ts（零依赖叶子模块）——那里的值同时被提示词
// 通过 registry 变量回显，改一处两侧同步，杜绝「代码改了、提示词没改」的漂移。
const DEBOUNCE_MS = FIX_DEBOUNCE_MS;

/** 读 LWW 最后一行（追加序覆盖）；返回 null = id 不存在 */
function lastRow(profilePath: string, recordId: string): Record<string, unknown> | null {
	const dir = join(profilePath, MEMORY_DB_DIR, L1_RECORDS_DIR);
	if (!existsSync(dir)) return null;
	let last: Record<string, unknown> | null = null;
	for (const f of readdirSync(dir).filter((x: string) => x.endsWith(".jsonl")).sort()) {
		for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const o = JSON.parse(t);
				if (typeof o?.id === "string" && o.id === recordId) last = o;
			} catch { /* 坏行跳过 */ }
		}
	}
	return last;
}

/** 高价值判定：hit-stats 有效命中 ≥ FIX_HIGH_VALUE_HITS 或 被 L2 场景块 members 引用 */
function isHighValue(profilePath: string, recordId: string): boolean {
	try {
		const st = getL1HitStatsDB(profilePath).getStats(recordId);
		if (st && (st.hits || 0) >= FIX_HIGH_VALUE_HITS) return true;
	} catch { /* 统计不可用不阻塞 */ }
	try {
		const indexPath = join(profilePath, MEMORY_DB_DIR, L2_SCENE_INDEX_PATH);
		if (existsSync(indexPath)) {
			const idx = JSON.parse(readFileSync(indexPath, "utf8"));
			if (Array.isArray(idx) && idx.some((e: any) => Array.isArray(e?.members) && e.members.includes(recordId))) {
				return true;
			}
		}
		// **归档侧车也要查**（2026-09-27）：块被归档后从 scene_index.json 消失；若这里只看活跃索引，
		// 归档块名下的记录会**静默失去保护** —— 用户看不到任何提示，而 l1-fix 会直接放行改写/墓碑。
		const archiveMembersPath = join(profilePath, MEMORY_DB_DIR, L2_ARCHIVE_MEMBERS_PATH);
		if (existsSync(archiveMembersPath)) {
			const map = JSON.parse(readFileSync(archiveMembersPath, "utf8")) as unknown;
			if (map && typeof map === "object" && !Array.isArray(map)) {
				for (const v of Object.values(map as Record<string, unknown>)) {
					if (Array.isArray(v) && v.includes(recordId)) return true;
				}
			}
		}
	} catch { /* 索引不可用不阻塞 */ }
	return false;
}

export interface FixParams {
	recordId: string;
	action: "rewrite" | "tombstone";
	newContent?: string | null;
	evidence?: string | null;
	reason?: string | null;
	priority?: number | null;
}

/**
 * 修正的**四道闸**（参数完整性 → 证据门槛 → LWW/幂等/24h 防抖 → 高价值保护）。纯裁决，不写盘。
 *
 * 为什么抽出来（2026-10-08）：`runFix` 内部恒定向 `rewrite.mjs` / `tombstone.mjs` 传 `--apply`
 * （见下），所以它**没有干跑路径**；而查看器的写盘桥要提供"先看将发生什么"的预演。
 * 与其在 CLI 里照抄一遍闸门（两处口径必然分叉），不如把裁决抽成这个函数，
 * `runFix` 与 CLI 的 dry-run 都调它。`--force` 只影响最后那道高价值闸。
 */
export function checkFixGates(
	profilePath: string,
	params: FixParams,
	opts: { force?: boolean } = {},
): { ok: true } | { ok: false; error: string } {
	const recordId = String(params?.recordId || "");
	const action = String(params?.action || "");
	const evidence = String(params?.evidence || "");
	const newContent = params?.newContent != null ? String(params.newContent) : "";

	if (!/^(rewrite|tombstone)$/.test(action) || !recordId) {
		return { ok: false, error: "recordId 与 action(rewrite|tombstone) 必填" };
	}
	// 护栏 1：evidence 门槛
	if (evidence.trim().length < FIX_MIN_EVIDENCE_CHARS) {
		return { ok: false, error: `evidence 过短（<${FIX_MIN_EVIDENCE_CHARS} 字符）：修正必须附可复核证据（grep/file:line/命令输出）` };
	}
	if (action === "rewrite" && newContent.trim().length < 10) {
		return { ok: false, error: "rewrite 需要 newContent（>=10 字符）" };
	}

	// LWW 存活判定 + 幂等 + 防抖数据源
	const last = lastRow(profilePath, recordId);
	if (!last) return { ok: false, error: `记录不存在：${recordId}` };
	if (last.deleted === true) return { ok: false, error: "无操作（该记录已 deleted）" };
	// 护栏 3：防抖（24h；无 appliedAt 字段 → 放行一次）
	const cleanup: any = (last.metadata as any)?.l1Cleanup;
	if (cleanup && typeof cleanup.appliedAt === "string") {
		const dt = Date.now() - Date.parse(cleanup.appliedAt);
		if (Number.isFinite(dt) && dt >= 0 && dt < DEBOUNCE_MS) {
			return { ok: false, error: `24h 防抖：该记录 ${cleanup.appliedAt} 刚被操作过（${cleanup.action || "?"}），稍后再试` };
		}
	}
	// 护栏 4：高价值保护（拒改，提示 --force）
	if (!opts.force && isHighValue(profilePath, recordId)) {
		return {
			ok: false,
			error: `高价值记录（hits>=${FIX_HIGH_VALUE_HITS} 或 L2 场景块引用）：自动修正被拒绝。如确认需要，请执行 /my-memory:l1:fix ${recordId} --action ${action} --force`,
		};
	}
	return { ok: true };
}

/**
 * 执行一次 L1 修正（工具与命令共用；force=true 绕过高价值保护）。
 * 返回 JSON 文本（{success, error?|detail?}）。
 *
 * **恒写盘**：内部给 `rewrite.mjs` / `tombstone.mjs` 传 `--apply`（那两个脚本默认 dry-run）。
 * 需要预演请用 `checkFixGates`。
 */
export async function runFix(params: FixParams, profilePath: string, opts: { force?: boolean } = {}): Promise<string> {
	const recordId = String(params?.recordId || "");
	const action = String(params?.action || "");
	const evidence = String(params?.evidence || "");
	const newContent = params?.newContent != null ? String(params.newContent) : "";
	const reason = params?.reason != null ? String(params.reason) : "";
	const priority = params?.priority;

	const fail = (error: string) => JSON.stringify({ success: false, error });

	const gate = checkFixGates(profilePath, params, opts);
	if (!gate.ok) return fail(gate.error);

	// 护栏 2：审计标注自动追加
	let content = newContent;
	if (action === "rewrite" && !AUDIT_RE.test(content)) {
		const today = new Date().toISOString().slice(0, 10);
		const ev = evidence.trim().slice(0, 120);
		content += `\n【${today} L1 修正：由 agent 依据「${ev}」就地更正${reason ? `（${reason}）` : ""}】`;
	}

	// 执行（l1-admin 同实现；脚本内部自动备份 + 校验）
	const script = action === "rewrite" ? "rewrite.mjs" : "tombstone.mjs";
	const args = [script, recordId];
	if (action === "rewrite") {
		args.push("--content", content);
		if (priority !== undefined && priority !== null) args.push("--priority", String(Math.round(Number(priority))));
	}
	args.push("--apply", "--profile", profilePath);
	try {
		const stdout = execFileSync(process.execPath, args, { cwd: TOOL_DIR, encoding: "utf8", timeout: 60000 });
		return JSON.stringify({ success: true, detail: String(stdout).trim() });
	} catch (e: any) {
		const msg = e?.stdout ? String(e.stdout) : (e instanceof Error ? e.message : String(e));
		return fail(`执行失败：${msg.slice(0, 500)}`);
	}
}

export function registerFixTool(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): void {
	pi.registerTool({
		name: "l1_fix",
		label: "Fix L1 Record",
		description: renderPrompt("tools#l1_fix", promptVarsFor("tools#l1_fix")),
		parameters: {
			type: "object",
			properties: {
				recordId: { type: "string", description: "L1 record id to fix" },
				action: { type: "string", enum: ["rewrite", "tombstone"], description: "rewrite = replace content; tombstone = remove" },
				newContent: { type: "string", description: "New content (required for rewrite)" },
				evidence: { type: "string", description: "Grep/file:line/command output proving the error (required, >=20 chars)" },
				reason: { type: "string", description: "Optional short reason, stored in audit annotation" },
				priority: { type: "number", description: "Optional 0-100 priority reassessment (rewrite only)" },
			},
			required: ["recordId", "action", "evidence"],
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const profilePath = getProfilePath();
			if (!profilePath) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active profile" }) }], details: {} };
			const text = await runFix(params as FixParams, profilePath);
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}