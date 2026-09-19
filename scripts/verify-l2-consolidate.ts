// l2_commit consolidate 原子动作的端到端回归基线（临时 profile；不触碰生产数据）
//
// 为什么单独成文件：本用例需要真实调用工具的 execute（含落盘、删源、重建索引），
// 放在 verify-l2-config.ts 里会与前面的只读用例共享进程状态——实测该组合下 await
// 无法 settle（原因未定位，独立进程运行则稳定）。独立文件也让"破坏性动作"与
// "纯函数校验"这两类测试的失败面彼此隔离。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSceneBlock, registerL2CommitTool } from "../memory/l2/commit-tool.ts";
import { closePipelineJobsDB } from "../memory/pipeline/jobs-db.ts";

/** 关掉缓存里的 jobs.sqlite 再删目录：Windows 下句柄未释放时 rmSync 会 EPERM（2026-09-19 实测）。 */
function drop(dir: string): void {
	try {
		closePipelineJobsDB(dir);
	} catch {
		// 未打开过则忽略
	}
	rmSync(dir, { recursive: true, force: true });
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

type ToolResult = { content: Array<{ text: string }> };

const p = mkdtempSync(join(tmpdir(), "l2-consolidate-e2e-"));
const sceneDir = join(p, "memoryDB", "l2", "scene-blocks");
const metaDir = join(p, "memoryDB", "l2", "index");
mkdirSync(sceneDir, { recursive: true });
mkdirSync(metaDir, { recursive: true });
mkdirSync(join(p, "memoryDB", "config"), { recursive: true });
writeFileSync(join(p, "memoryDB", "config", "application-propertis.json"), JSON.stringify({ l2: { maxScenes: 5 } }), "utf-8");

const block = (summary: string, heat: number, created: string, lines: string[]) =>
	`-----META-START-----\ncreated: ${created}\nupdated: 2026-09-01T00:00:00.000Z\nsummary: ${summary}\nheat: ${heat}\n-----META-END-----\n\n${lines.join("\n")}\n`;
const linesA = Array.from({ length: 8 }, (_, i) => `- 条目 A-${i}`);
const linesB = Array.from({ length: 8 }, (_, i) => `- 条目 B-${i}`);

writeFileSync(join(sceneDir, "a.md"), block("摘要A", 3, "2026-08-17T10:10:00.000Z", linesA), "utf-8");
writeFileSync(join(sceneDir, "b.md"), block("摘要B", 13, "2026-08-20T08:00:00.000Z", linesB), "utf-8");
writeFileSync(join(sceneDir, "keep.md"), block("摘要K", 1, "2026-08-01T00:00:00.000Z", ["- 保留"]), "utf-8");
writeFileSync(join(metaDir, "scene_members.json"), JSON.stringify({ "a.md": ["m1", "m2"], "b.md": ["m2", "m3"] }), "utf-8");

const captured: Array<{ execute: (...args: unknown[]) => Promise<ToolResult> }> = [];
registerL2CommitTool({ registerTool: (t: unknown) => captured.push(t as never) } as never, () => p);
const tool = captured[0];

console.log("=== consolidate 端到端（临时 profile / maxScenes=5 / 3 个块）===");
check("l2_commit 工具已注册", !!tool);

const mergedContent = [...linesA, ...linesB].join("\n");

async function main(): Promise<void> {
	// ── 拒绝路径：显式 members 漏了 m3 → 完整性校验失败，整批不落盘 ──
	console.log("\n-- 拒绝路径（members 漏源成员）--");
	const rej = JSON.parse(
		(
			await tool.execute(
				"t1",
				{
					sceneWrites: [{ action: "consolidate", filename: "merged.md", sources: ["a.md", "b.md"], content: mergedContent, members: ["m1", "m2"] }],
					cursor: "l1_1787277400002_c3d4",
				},
				null,
				null,
				{},
			)
		).content[0].text,
	);
	check("success=false", rej.success === false);
	check("拒绝时源块仍在（不写半批）", existsSync(join(sceneDir, "a.md")) && existsSync(join(sceneDir, "b.md")));
	check("拒绝时目标块未创建", !existsSync(join(sceneDir, "merged.md")));
	check("回报缺口 id", (rej.consolidation?.memberGaps ?? []).includes("m3"), JSON.stringify(rej.consolidation?.memberGaps ?? []));

	// ── 结构校验：源块不存在 ──
	console.log("\n-- 结构校验 --");
	const bad = JSON.parse(
		(
			await tool.execute(
				"t2",
				{ sceneWrites: [{ action: "consolidate", filename: "x.md", sources: ["nope.md", "nope2.md"], content: "x" }], cursor: "l1_1787277400002_c3d4" },
				null,
				null,
				{},
			)
		).content[0].text,
	);
	check("源块不存在 → 拒绝", bad.success === false && String(bad.error).includes("源块不存在"), bad.error ?? "");

	const selfInc = JSON.parse(
		(
			await tool.execute(
				"t3",
				{ sceneWrites: [{ action: "consolidate", filename: "a.md", sources: ["a.md", "b.md"], content: mergedContent }], cursor: "l1_1787277400002_c3d4" },
				null,
				null,
				{},
			)
		).content[0].text,
	);
	check("sources 含目标自身 → 拒绝", selfInc.success === false && String(selfInc.error).includes("不得包含目标块自身"), selfInc.error ?? "");

	// ── 成功路径：members 缺省 → 代码取并集；created/heat 自动计算 ──
	console.log("\n-- 成功路径 --");
	const ok = JSON.parse(
		(
			await tool.execute(
				"t4",
				{
					sceneWrites: [{ action: "consolidate", filename: "merged.md", sources: ["a.md", "b.md"], content: mergedContent, meta: { summary: "合并摘要" } }],
					cursor: "l1_1787277400002_c3d4",
				},
				null,
				null,
				{},
			)
		).content[0].text,
	);
	check("合并成功（5 上限下 3 块 → 2 块）", ok.success === true, ok.error ?? "");
	check("块数变为 2", ok.sceneCount === 2, `sceneCount=${ok.sceneCount}`);
	check("源块已删除", !existsSync(join(sceneDir, "a.md")) && !existsSync(join(sceneDir, "b.md")));
	check("无关块保留", existsSync(join(sceneDir, "keep.md")));

	const parsed = parseSceneBlock(readFileSync(join(sceneDir, "merged.md"), "utf-8"));
	check("created 自动取源块最早（不依赖 LLM 遵守）", parsed.meta.created === "2026-08-17T10:10:00.000Z", parsed.meta.created);
	check("heat 自动取源块最大（不依赖 LLM 遵守）", parsed.meta.heat === 13, `heat=${parsed.meta.heat}`);
	check("summary 采用子代理提供的值", parsed.meta.summary === "合并摘要", parsed.meta.summary);
	check("正文完整保留（B 段条目在场）", parsed.content.includes("- 条目 B-7"));

	const membersAfter = JSON.parse(readFileSync(join(metaDir, "scene_members.json"), "utf-8")) as Record<string, string[]>;
	check("members 自动取源并集", (membersAfter["merged.md"] ?? []).length === 3, JSON.stringify(membersAfter["merged.md"] ?? []));
	check("源条目已从 sidecar 移除", !("a.md" in membersAfter) && !("b.md" in membersAfter));
	check("无关块成员不受影响", !("keep.md" in membersAfter));

	const idx = JSON.parse(readFileSync(join(metaDir, "scene_index.json"), "utf-8")) as Array<{ filename: string; members: string[] }>;
	check("索引条目数 == 块数", idx.length === readdirSync(sceneDir).filter((f) => f.endsWith(".md")).length, `idx=${idx.length}`);
	check("索引里目标块带 members", (idx.find((e) => e.filename === "merged.md")?.members ?? []).length === 3);

	const report = ok.consolidations?.[0];
	check("回报备份目录", typeof report?.backupDir === "string" && report.backupDir.includes("l2-consolidate-"), report?.backupDir ?? "");
	check("备份目录实际存在且含源块原文", !!report && existsSync(join(p, "memoryDB", report.backupDir, "a.md")));
	check("回报 membersSource=auto-union", report?.membersSource === "auto-union", report?.membersSource ?? "");
	check(
		"回报行数比（16 → 16）",
		(report?.lines?.sourceTotal ?? 0) === 16 && (report?.lines?.target ?? 0) === 16,
		JSON.stringify(report?.lines ?? {}),
	);

	// ── 上限边界（2026-09-16）：已达 maxScenes 时，"update / merge + 新文件名"必须同样被拒 ──
	// 旧口径只认 action==="create"，实测这里会静默多出一个块（目录 3 → 4、返回 success=true）。
	// 放在同一脚本里是因为它同样需要真实落盘——纯函数断言（verify-l2-config.ts §4）覆盖不到落盘层。
	console.log("\n-- 上限边界（新名 update / merge 不得绕过 maxScenes）--");
	const p2 = mkdtempSync(join(tmpdir(), "l2-cap-e2e-"));
	const capSceneDir = join(p2, "memoryDB", "l2", "scene-blocks");
	mkdirSync(capSceneDir, { recursive: true });
	mkdirSync(join(p2, "memoryDB", "l2", "index"), { recursive: true });
	mkdirSync(join(p2, "memoryDB", "config"), { recursive: true });
	writeFileSync(join(p2, "memoryDB", "config", "application-propertis.json"), JSON.stringify({ l2: { maxScenes: 3 } }), "utf-8");
	for (const n of ["a.md", "b.md", "c.md"]) {
		writeFileSync(join(capSceneDir, n), block(`摘要${n}`, 1, "2026-08-01T00:00:00.000Z", ["- 条目"]), "utf-8");
	}
	const capTools: Array<{ execute: (...args: unknown[]) => Promise<ToolResult> }> = [];
	registerL2CommitTool({ registerTool: (t: unknown) => capTools.push(t as never) } as never, () => p2);
	const capTool = capTools[0];
	const dirCount = () => readdirSync(capSceneDir).filter((f) => f.endsWith(".md")).length;
	const capCall = async (id: string, write: Record<string, unknown>) =>
		JSON.parse((await capTool.execute(id, { sceneWrites: [write], cursor: "l1_1787277400002_c3d4" }, null, null, {})).content[0].text);

	check("夹具：cap=3 且目录已满（3/3）", dirCount() === 3, `实际 ${dirCount()}`);
	for (const action of ["create", "update", "merge"] as const) {
		const r = await capCall(`cap-${action}`, { action, filename: `New-${action}.md`, content: "- 新内容", meta: { summary: "s" } });
		check(`${action} + 新名 → 拒绝（success=false）`, r.success === false, String(r.error ?? "").slice(0, 36));
		check(`${action} 拒绝后目录块数仍为 3`, dirCount() === 3, `实际 ${dirCount()}`);
		check(`${action} 拒绝时目标块未落盘`, !existsSync(join(capSceneDir, `New-${action}.md`)));
	}
	const msg = await capCall("cap-msg", { action: "create", filename: "New-x.md", content: "x" });
	check("拒绝指引指向 consolidate（不提两步式 merge）", String(msg.error).includes("consolidate") && !String(msg.error).includes("merge 目标块"));

	// 收缩出口不被堵（防死锁）：已达上限时 consolidate 必须放行，腾出空位后 create 恢复可过
	const shrink = await capCall("cap-consolidate", { action: "consolidate", filename: "merged.md", sources: ["a.md", "b.md"], content: [...linesA, ...linesB].join("\n") });
	check("已达上限时 consolidate 放行", shrink.success === true, shrink.error ?? "");
	check("合并后 3 → 2", dirCount() === 2 && shrink.sceneCount === 2, `dir=${dirCount()} sceneCount=${shrink.sceneCount}`);
	const afterCreate = await capCall("cap-create-ok", { action: "create", filename: "New.md", content: "- 新内容" });
	check("腾出空位后 create 恢复可过", afterCreate.success === true, afterCreate.error ?? "");
	check("最终 3 块，且未出现 overLimit warning", dirCount() === 3 && afterCreate.warning === undefined, `dir=${dirCount()} warning=${afterCreate.warning ?? "无"}`);
	drop(p2);

	drop(p);
}

main()
	.then(() => {
		console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
		process.exit(fail === 0 ? 0 : 1);
	})
	.catch((e: unknown) => {
		console.error("端到端测试异常：", e);
		process.exit(1);
	});
