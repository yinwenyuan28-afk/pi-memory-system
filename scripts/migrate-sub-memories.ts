/**
 * 一次性迁移脚本：旧 sub-memories → 新 L1 原子记忆（2026-08-19）
 *
 * 背景：新记忆系统（L0 对话分片 → L1 原子记忆）与旧系统（sub-memories 长文 md）
 * 完全解耦、并行存在。本脚本把有价值的旧 sub-memory 文档经 LLM 拆解为 L1 原子记忆，
 * 写入 {profilePath}/memoryDB/l1-records/ 分片，供新系统检索注入利用。
 *
 * 关键决策：
 *  - 不推进 l1-cursor.json（迁移记录不是对话增量，推进会跳过后续真实对话提取）
 *  - source_message_ids 标注 `migration#sub-memories/<相对路径>#<mtimeMs>`，
 *    sessionKey="migration"——与对话提取天然区分，可溯源/可批量回溯
 *  - 内容哈希去重（对齐 l1_commit 的 contentHash 语义），可安全重跑
 *  - 提取 prompt 复用 extract-code.md 的 type 定义与 priority 打分表，
 *    输入从"消息序列"换成"历史文档"，每个文档是一个情境
 *  - 超长文档按 `## ` 章节分段提取，每段 ≤8KB
 *
 * 用法（独立运行，需 tsx + paths alias 解析 @earendil-works/pi-ai/compat）：
 *   tsx --tsconfig /tmp/tsconfig.migrate.json scripts/migrate-sub-memories.ts [--dry-run] [--scope wangxin] [--file xxx.md]
 *   或在 pi 进程内以扩展工具方式调用（model 自动解析）
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative } from "node:path";
import { callLLM } from "../util/llm.js";
import { resolveConfiguredModel } from "../config/model-config.js";

// ══════════════════════════════════════════════════════════════
//  CLI 解析
// ══════════════════════════════════════════════════════════════

interface CliOptions {
	profilePath: string;
	dryRun: boolean;
	scope: string | null;
	fileFilter: string | null;
}

function parseCli(argv: string[]): CliOptions {
	const opts: CliOptions = {
		profilePath: process.env.PI_PROFILE_PATH || "C:/Users/leaf/.pi/agent/profiles/default",
		dryRun: false,
		scope: null,
		fileFilter: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") opts.dryRun = true;
		else if (a === "--scope") opts.scope = argv[++i] ?? null;
		else if (a === "--file") opts.fileFilter = argv[++i] ?? null;
		else if (a === "--profile") opts.profilePath = argv[++i] ?? opts.profilePath;
		else if (a === "--help") {
			console.log(`用法: migrate-sub-memories.ts [--dry-run] [--scope 子目录] [--file 文件名] [--profile profilePath]
  --dry-run  只提取不落盘（统计将写入条数）
  --scope    只迁移指定子目录（如 wangxin）；默认全部分目录
  --file     只迁移指定文件（basename 匹配，如 salary-limit-manager.md）
  --profile  profile 根目录（默认 env PI_PROFILE_PATH 或 default profile）`);
			process.exit(0);
		}
	}
	return opts;
}

// ══════════════════════════════════════════════════════════════
//  常量与工具
// ══════════════════════════════════════════════════════════════

/** 内容归一化哈希（对齐 l1_commit contentHash：去空白、小写、sha1）。 */
function contentHash(content: string): string {
	const norm = content.replace(/\s+/g, " ").trim().toLowerCase();
	return createHash("sha1").update(norm, "utf-8").digest("hex");
}

/** 本地时区 YYYY-MM-DD（分片名，与 l0/l1 一致）。 */
function localDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** 随机 4 位小写字母数字（id 后缀）。 */
function rand4(): string {
	return createHash("md5").update(String(Math.random())).digest("hex").slice(0, 4);
}

/** 按章节切分 md（`## ` 标题分界），返回 [{title, body}]；单段超长再二分。 */
function splitSections(text: string, maxLen = 8000): Array<{ title: string; body: string }> {
	const sections: Array<{ title: string; body: string }> = [];
	const parts = text.split(/^##\s+/m);
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i].trim();
		if (!p) continue;
		const firstLine = p.split(/\r?\n/)[0] ?? "";
		const title = i === 0 ? (text.match(/^#\s+(.+)$/m)?.[1] ?? "文档前言") : firstLine;
		const body = i === 0 ? p : p.slice(firstLine.length).trim();
		if (body.length <= maxLen) {
			sections.push({ title, body });
		} else {
			// 二分直到 ≤maxLen
			let chunk = body;
			while (chunk.length > maxLen) {
				const cut = chunk.lastIndexOf("\n", maxLen);
				const mid = cut > maxLen / 2 ? cut : maxLen;
				sections.push({ title, body: chunk.slice(0, mid).trim() });
				chunk = chunk.slice(mid).trim();
			}
			if (chunk) sections.push({ title, body: chunk });
		}
	}
	return sections;
}

// ══════════════════════════════════════════════════════════════
//  提取 prompt（对齐 extract-code.md 的 type/priority 规则，输入=文档）
// ══════════════════════════════════════════════════════════════

const EXTRACT_SYSTEM_PROMPT =
	"你是专业的工作记忆提取专家。输入是一份已完成的历史技术文档，请提取可在后续项目协作中复用的结构化工作记忆。" +
	"严格按 type/priority 规则输出，只输出 JSON 数组，不要 Markdown 代码块包裹。";

function buildExtractPrompt(filePath: string, docTitle: string, body: string): string {
	return [
		`文档来源：${filePath}`,
		`文档标题（情境名）：${docTitle}`,
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		"【文档内容】",
		body,
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		"【任务】把文档内容拆解为可复用的原子记忆，输出 JSON 数组，每项：",
		'{"content":"完整独立的记忆陈述（中文）","type":"work_fact|work_task|work_method|work_artifact","priority":80,"metadata":{}}',
		"",
		"type 定义（对齐 L1 提取规则）：",
		"- work_fact：项目事实/需求/架构约束/决策结论/系统事实/踩坑结论（90-100 关键决策与长期约束；70-89 持续价值事实；<70 丢弃）",
		"- work_task：有明确后续动作/owner/deadline 的任务（<70 或已无后续动作的丢弃）",
		"- work_method：可复用方法/SOP/设计思路/禁忌/判断标准/经验教训（90-100 长期可跨任务复用；70-89 当前项目明显复用价值；<70 丢弃）",
		"- work_artifact：文档/接口契约/方案/数据表等资产（90-100 核心资产；70-89 可复用资产；<70 丢弃）",
		"",
		"metadata 建议：work_task 可填 owner/deadline/status；work_method 可填 scope/method_type（sop|principle|constraint|anti_pattern）；",
		"work_artifact 可填 artifact_type（doc|api|table|plan|report）；work_fact 可填 work_object。",
		"",
		"规则：",
		"- 每条记忆必须独立完整（跳出文档仍可理解），不要用'本文'、'上述'等指代",
		"- 合并强关联内容，不要把同一结论拆碎；不同主题分开提取",
		"- 用户拍板的决策、接口契约、踩坑教训、环境事实优先提取（这类知识无法从代码快速发现）",
		"- 教程/操作步骤类内容（如 git 命令清单）不提取，保留为文档参考",
		"- priority < 70 的直接丢弃，不要输出",
		"- 最多输出 20 条；整段无有效记忆输出 []",
	].join("\n");
}

// ══════════════════════════════════════════════════════════════
//  cwd 探测：文件名含 A10xxx → backend/frontend 目录探测
// ══════════════════════════════════════════════════════════════

function resolveCwd(profilePath: string, fileName: string, subDir: string): string {
	const wangxinRoot = "C:/dev/code_java/wangxin";
	if (subDir === "wangxin") {
		const m = fileName.match(/^(A10\d{4})/);
		if (m) {
			const id = m[1];
			for (const kind of ["backend", "frontend"]) {
				const p = join(wangxinRoot, kind, id);
				if (existsSync(p)) return p;
			}
		}
		if (existsSync(wangxinRoot)) return wangxinRoot;
	}
	// 其它子目录：不猜测 cwd，留空（检索按关键词，不依赖 cwd）
	return "";
}

// ══════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════

interface MigrateResult {
	scanned: number;
	extracted: number;
	written: number;
	duplicated: number;
	failed: string[];
	byType: Record<string, number>;
}

async function main(): Promise<void> {
	const opts = parseCli(process.argv.slice(2));
	const subRoot = join(opts.profilePath, "sub-memories");
	if (!existsSync(subRoot)) {
		console.error(`sub-memories 目录不存在: ${subRoot}`);
		process.exit(1);
	}

	// 模型：从 memory-system-model.json 解析（与扩展后台调用一致）
	const model = resolveConfiguredModel(opts.profilePath, null);
	if (!model) {
		console.error(
			"无法解析 LLM 模型：请确认 {profile}/memoryDB/config/memory-system-model.json 存在且含 type=llm 条目，或提供环境变量 PI_PROFILE_PATH",
		);
		process.exit(1);
	}
	console.log(`模型: ${JSON.stringify(model).slice(0, 120)}…`);

	// 1. 扫描 md 文件
	const files: Array<{ path: string; subDir: string }> = [];
	for (const subDir of readdirSync(subRoot)) {
		const dir = join(subRoot, subDir);
		if (!statSync(dir).isDirectory()) continue;
		if (opts.scope && subDir !== opts.scope) continue;
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".md")) continue;
			if (opts.fileFilter && !f.includes(opts.fileFilter)) continue;
			files.push({ path: join(dir, f), subDir });
		}
	}
	if (files.length === 0) {
		console.log("没有匹配的 md 文件");
		process.exit(0);
	}
	console.log(`扫描到 ${files.length} 个 md（scope=${opts.scope ?? "all"}）`);

	// 2. 已有记录哈希集合（去重）
	const recordsDir = join(opts.profilePath, "memoryDB", "l1-records");
	const existingHashes = new Set<string>();
	if (existsSync(recordsDir)) {
		for (const f of readdirSync(recordsDir).filter((f) => f.endsWith(".jsonl"))) {
			for (const line of readFileSync(join(recordsDir, f), "utf-8").split(/\r?\n/)) {
				const t = line.trim();
				if (!t) continue;
				try {
					const o = JSON.parse(t);
					if (!o?.deleted && typeof o?.content === "string") existingHashes.add(contentHash(o.content));
				} catch {
					// 跳过坏行
				}
			}
		}
	}
	console.log(`现有记忆哈希: ${existingHashes.size} 条`);

	const result: MigrateResult = { scanned: 0, extracted: 0, written: 0, duplicated: 0, failed: [], byType: {} };
	const now = new Date();
	const nowIso = now.toISOString();
	const shardPath = join(recordsDir, `${localDate(now)}.jsonl`);
	const toAppend: string[] = [];

	for (const { path, subDir } of files) {
		result.scanned++;
		const rel = relative(subRoot, path).replace(/\\/g, "/");
		const fileName = basename(path);
		const st = statSync(path);
		const mtimeIso = new Date(st.mtimeMs).toISOString();
		const raw = readFileSync(path, "utf-8");
		const docTitle = raw.match(/^#\s+(.+)$/m)?.[1] ?? fileName;
		const sections = splitSections(raw);
		console.log(`\n[${rel}] ${raw.length} 字符，${sections.length} 段`);

		let allMemories: Array<{ content: string; type: string; priority: number; metadata: Record<string, unknown> }> = [];
		let fileFailed = false;

		for (const sec of sections) {
			const prompt = buildExtractPrompt(rel, `${docTitle}（${sec.title}）`, sec.body);
			const rawOut = await callLLM(model, EXTRACT_SYSTEM_PROMPT, prompt, { timeoutMs: 120_000 });
			if (rawOut === null) {
				console.error(`  ✗ 段「${sec.title}」提取失败（LLM 返回 null）`);
				fileFailed = true;
				continue;
			}
			const jsonMatch = rawOut.match(/\[[\s\S]*\]/);
			if (!jsonMatch) {
				console.error(`  ✗ 段「${sec.title}」输出非 JSON，跳过`);
				fileFailed = true;
				continue;
			}
			try {
				const arr = JSON.parse(jsonMatch[0]) as Array<{ content?: unknown; type?: unknown; priority?: unknown; metadata?: unknown }>;
				for (const m of arr) {
					if (typeof m?.content === "string" && typeof m?.type === "string" && typeof m?.priority === "number") {
						allMemories.push({
							content: m.content.trim(),
							type: m.type,
							priority: m.priority,
							metadata: m.metadata && typeof m.metadata === "object" ? (m.metadata as Record<string, unknown>) : {},
						});
					}
				}
			} catch {
				console.error(`  ✗ 段「${sec.title}」JSON 解析失败`);
				fileFailed = true;
			}
		}

		if (fileFailed) result.failed.push(rel);
		console.log(`  提取 ${allMemories.length} 条`);

		// 3. 组装 entry + 去重
		const cwd = resolveCwd(opts.profilePath, fileName, subDir);
		const sourceId = `migration#sub-memories/${rel}#${st.mtimeMs}`;
		let fileWritten = 0;
		for (const m of allMemories) {
			const h = contentHash(m.content);
			if (existingHashes.has(h)) {
				result.duplicated++;
				continue;
			}
			existingHashes.add(h);
			const entry = {
				id: `l1_${Date.now()}_${rand4()}`,
				content: m.content,
				type: m.type,
				priority: m.priority,
				scene_name: docTitle,
				source_message_ids: [sourceId],
				metadata: m.metadata,
				timestamps: [mtimeIso],
				createdAt: nowIso,
				updatedAt: nowIso,
				version: 1,
				sessionKey: "migration",
				sessionId: null,
				cwd,
				deleted: false,
			};
			toAppend.push(JSON.stringify(entry));
			result.byType[m.type] = (result.byType[m.type] || 0) + 1;
			fileWritten++;
			result.written++;
		}
		result.extracted += allMemories.length;
		console.log(`  写入 ${fileWritten} 条（去重跳过 ${allMemories.length - fileWritten}）`);
	}

	// 4. 落盘（非 dry-run）
	if (!opts.dryRun && toAppend.length > 0) {
		if (!existsSync(recordsDir)) mkdirSync(recordsDir, { recursive: true });
		appendFileSync(shardPath, toAppend.join("\n") + "\n", "utf-8");
		console.log(`\n已写入 ${shardPath}（${toAppend.length} 条）`);
	} else if (opts.dryRun) {
		console.log(`\n[dry-run] 将写入 ${toAppend.length} 条（未落盘）`);
	}

	// 5. 汇总
	console.log("\n══════ 迁移汇总 ══════");
	console.log(`扫描 ${result.scanned} | 提取 ${result.extracted} | 写入 ${result.written} | 去重跳过 ${result.duplicated} | 失败 ${result.failed.length}`);
	console.log(`type 分布: ${JSON.stringify(result.byType)}`);
	if (result.failed.length > 0) {
		console.log(`失败文件: ${result.failed.join(", ")}`);
	}
	console.log("注意：未推进 l1-cursor.json（迁移记录非对话增量）");
}

main().catch((e) => {
	console.error("迁移失败:", e instanceof Error ? e.message : String(e));
	process.exit(1);
});
