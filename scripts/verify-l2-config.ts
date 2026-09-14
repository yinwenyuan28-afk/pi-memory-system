// L2 配置与任务消息注入的回归基线（只读；用临时 profile，不碰生产数据）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildL2Task, loadL2Config, MAX_SCENES_DEFAULT } from "../memory/l2/config.ts";
import {
	backupSceneBlocks,
	checkConsolidation,
	checkSceneLimit,
	CONSOLIDATE_BACKUP_KEEP,
	consolidationMeta,
	loadSceneMembers,
	mergeSceneMembers,
	resolveConsolidationMembers,
	syncSceneIndex,
} from "../memory/l2/commit-tool.ts";

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

/** 造一个临时 profile；appConfig 为 null 表示不写配置文件。 */
function makeProfile(appConfig: string | null): string {
	const root = mkdtempSync(join(tmpdir(), "l2cfg-"));
	if (appConfig !== null) {
		const dir = join(root, "memoryDB", "config");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "application-propertis.json"), appConfig, "utf-8");
	}
	return root;
}

console.log("\n=== 1. loadL2Config 取值与兜底 ===");
{
	const roots: string[] = [];
	const cases: Array<[string, string | null, number]> = [
		["无配置文件 → 默认", null, MAX_SCENES_DEFAULT],
		["l2.maxScenes=20 → 20", '{"l2":{"maxScenes":20}}', 20],
		["l2.maxScenes=1 → 1", '{"l2":{"maxScenes":1}}', 1],
		["maxScenes=0 → 默认（非正数非法）", '{"l2":{"maxScenes":0}}', MAX_SCENES_DEFAULT],
		["maxScenes=-3 → 默认", '{"l2":{"maxScenes":-3}}', MAX_SCENES_DEFAULT],
		["maxScenes 为字符串 → 默认", '{"l2":{"maxScenes":"20"}}', MAX_SCENES_DEFAULT],
		["无 l2 节 → 默认", '{"l1":{"mode":"code"}}', MAX_SCENES_DEFAULT],
		["JSONC 注释可解析 → 20", '{\n  // 注释\n  "l2": { "maxScenes": 20 }\n}', 20],
		["小数 15.9 → 取整 15", '{"l2":{"maxScenes":15.9}}', 15],
	];
	for (const [label, content, expected] of cases) {
		const r = makeProfile(content);
		roots.push(r);
		const got = loadL2Config(r).maxScenes;
		check(label, got === expected, `期望 ${expected}，实际 ${got}`);
	}
	for (const r of roots) rmSync(r, { recursive: true, force: true });
}

console.log("\n=== 2. buildL2Task 注入 MaxScenes 与 Mode ===");
{
	const root = makeProfile('{"l2":{"maxScenes":22},"l1":{"mode":"chat"}}');
	const task = buildL2Task(root);
	const lines = task.split("\n");
	console.log("  任务消息：");
	lines.forEach((l) => console.log(`    ${l.slice(0, 110)}`));
	check("含 MaxScenes 行", lines.some((l) => l.startsWith("MaxScenes:")));
	check("MaxScenes 取配置值 22", lines.some((l) => l.startsWith("MaxScenes: 22")), lines.find((l) => l.startsWith("MaxScenes:")) ?? "");
	check("含 Mode 行（此前是死模板）", lines.some((l) => l.startsWith("Mode:")));
	check("Mode 跟随 L1 配置 = chat", lines.some((l) => l === "Mode: chat"), lines.find((l) => l.startsWith("Mode:")) ?? "");
	check("原 5 个定位字段未丢", ["RecordsDir:", "SceneDir:", "IndexPath:", "CursorPath:", "PromptDir:"].every((p) => lines.some((l) => l.startsWith(p))));
	rmSync(root, { recursive: true, force: true });
}

console.log("\n=== 3. 生产 profile 实际取值（只读）===");
{
	const REAL = "C:/Users/leaf/.pi/agent/profiles/default";
	const cfg = loadL2Config(REAL);
	check("生产 maxScenes 为正整数", Number.isInteger(cfg.maxScenes) && cfg.maxScenes > 0, `实际 ${cfg.maxScenes}`);
	const task = buildL2Task(REAL);
	check("生产任务消息含 MaxScenes", task.split("\n").some((l) => l.startsWith("MaxScenes:")), task.split("\n").find((l) => l.startsWith("MaxScenes:")) ?? "");
}

console.log("\n=== 4. 硬上限预检 checkSceneLimit（语义：场景数【不得超过】maxScenes）===");
{
	const W = (action: "create" | "update" | "merge" | "delete", filename: string) => ({ action, filename });
	const base = ["a.md", "b.md", "c.md"]; // 3 个已有块

	check("3 块 + cap5 + create → 通过（4 ≤ 5）", checkSceneLimit(base, [W("create", "d.md")], 5).ok);
	check("3 块 + cap4 + create → 通过（4 ≤ 4，恰好等于上限合法）", checkSceneLimit(base, [W("create", "d.md")], 4).ok);
	const over = checkSceneLimit(base, [W("create", "d.md")], 3);
	check("3 块 + cap3 + create → 拒绝（4 > 3）", !over.ok, over.error?.slice(0, 30) ?? "");
	check("拒绝时报告预演后的数量", over.count === 4, `count=${over.count}`);
	check("拒绝信息含「合并评估」指引", (over.error ?? "").includes("合并评估"));
	check("拒绝信息写明硬上限数值", (over.error ?? "").includes("硬上限 3"));

	// 死锁回归（2026-09-10 真实踩坑）：已达上限时**收缩批必须放行**。
	// 若在入口就把"已达上限"的批次整体拒掉，delete/merge 会被一并挡下——
	// 而收缩正是脱离上限的唯一途径 → L2 永远无法合并自愈。
	check("已达上限 + 只 delete → 通过（收缩必须放行，防死锁）", checkSceneLimit(base, [W("delete", "a.md")], 3).ok);
	check("已达上限 + merge 目标已存在 → 通过", checkSceneLimit(base, [W("merge", "a.md")], 3).ok);
	check("已达上限 + 无写入 → 通过（空批不改变状态，不应被拒）", checkSceneLimit(base, [], 3).ok);
	check("已超上限（3 块 > cap2）+ 只 delete → 通过（超限态仍可收缩）", checkSceneLimit(base, [W("delete", "a.md")], 2).ok);

	// 先合后建：cap=3 时 3 个块已满，必须先 delete 再 create
	const createFirst = checkSceneLimit(base, [W("create", "merged.md"), W("delete", "a.md"), W("delete", "b.md")], 3);
	check("顺序敏感：先 create 后 delete → 在 create 那刻即拒", !createFirst.ok, `count=${createFirst.count}`);
	const deleteFirst = checkSceneLimit(base, [W("delete", "a.md"), W("delete", "b.md"), W("create", "merged.md")], 3);
	check("先 delete 后 create → 通过（3→2→1→2）", deleteFirst.ok, `count=${deleteFirst.count}`);

	check("update 不增加数量", checkSceneLimit(base, [W("update", "a.md")], 3).ok);
	check("merge 目标已存在不增加数量", checkSceneLimit(base, [W("merge", "a.md")], 3).ok);
	check("delete 不存在的文件不产生负数", checkSceneLimit(base, [W("delete", "zzz.md")], 3).count === 3);
	const two = checkSceneLimit(base, [W("create", "d.md"), W("create", "e.md")], 4);
	check("一次 create 多个 → 逐个判定，第二个越线即拒", !two.ok, `count=${two.count}`);
	check("空 base + cap1 + create → 通过（1 ≤ 1）", checkSceneLimit([], [W("create", "a.md")], 1).ok);
	check("空 base + cap0 + create → 拒绝（1 > 0）", !checkSceneLimit([], [W("create", "a.md")], 0).ok);
}

console.log("\n=== 5. 成员清单 mergeSceneMembers（纯函数）===");
{
	const W = (action: "create" | "update" | "merge" | "delete", filename: string, members?: string[]) => ({
		action,
		filename,
		...(members ? { members } : {}),
	});

	const r1 = mergeSceneMembers({}, [W("create", "a.md", ["l1_1", "l1_2"])]);
	check("新块带 members → 写入", JSON.stringify(r1.members["a.md"]) === JSON.stringify(["l1_1", "l1_2"]), JSON.stringify(r1.members));
	check("无缺失告警", r1.missing.length === 0);

	const r2 = mergeSceneMembers({}, [W("create", "b.md")]);
	check("新块不带 members → 记入 missing", r2.missing.includes("b.md"), JSON.stringify(r2.missing));
	check("新块不带 members → 成员为空数组", (r2.members["b.md"] ?? null)?.length === 0);

	const r3 = mergeSceneMembers({ "a.md": ["l1_1"] }, [W("update", "a.md")]);
	check("已有块不带 members → 保留原集合（不清空、不告警）", JSON.stringify(r3.members["a.md"]) === JSON.stringify(["l1_1"]) && r3.missing.length === 0);

	const r4 = mergeSceneMembers({ "a.md": ["l1_1"] }, [W("update", "a.md", ["l1_1", "l1_9"])]);
	check("update 带 members → 替换为完整集合（非增量）", JSON.stringify(r4.members["a.md"]) === JSON.stringify(["l1_1", "l1_9"]));

	const r5 = mergeSceneMembers({ "a.md": ["l1_1"], "b.md": ["l1_2"] }, [W("delete", "a.md")]);
	check("delete → 移除该条目的成员", !("a.md" in r5.members) && "b.md" in r5.members, JSON.stringify(r5.members));

	const r6 = mergeSceneMembers({}, [W("merge", "merged.md", ["l1_1", "l1_1", "", "l1_2"])]);
	check("merge 传并集 → 去重去空保序", JSON.stringify(r6.members["merged.md"]) === JSON.stringify(["l1_1", "l1_2"]), JSON.stringify(r6.members));

	const r7 = mergeSceneMembers({}, [W("create", "x.md", ["old"]), W("create", "x.md", ["new"])]);
	check("同批同名多次 → 最后一次为准", JSON.stringify(r7.members["x.md"]) === JSON.stringify(["new"]));
}

console.log("\n=== 6. syncSceneIndex 集成：成员清单必须能在索引重建后存活 ===");
{
	const root = mkdtempSync(join(tmpdir(), "l2idx-"));
	const dbDir = join(root, "memoryDB");
	mkdirSync(join(dbDir, "l2", "scene-blocks"), { recursive: true });
	mkdirSync(join(dbDir, "l2", "index"), { recursive: true });
	const sceneFile = join(dbDir, "l2", "scene-blocks", "proj-主线.md");
	writeFileSync(
		sceneFile,
		["-----META-START-----", "created: 2026-09-01T00:00:00.000Z", "updated: 2026-09-10T00:00:00.000Z", "summary: 摘要", "heat: 7", "-----META-END-----", "", "## 实施区", "内容"].join("\n"),
		"utf-8",
	);
	writeFileSync(join(dbDir, "l2", "index", "scene_members.json"), JSON.stringify({ "proj-主线.md": ["l1_1", "l1_2"] }), "utf-8");

	const first = syncSceneIndex(root);
	check("索引条目带 members", JSON.stringify(first[0]?.members) === JSON.stringify(["l1_1", "l1_2"]), JSON.stringify(first[0]));
	check("其余 META 字段照旧", first[0]?.heat === 7 && first[0]?.summary === "摘要", `heat=${first[0]?.heat}`);

	// 关键性质：索引是派生物，重建后成员不能丢
	const second = syncSceneIndex(root);
	check("二次重建后 members 仍在（sidecar 是权威载体）", JSON.stringify(second[0]?.members) === JSON.stringify(["l1_1", "l1_2"]));

	// sidecar 缺失时降级为空数组而不是崩
	rmSync(join(dbDir, "l2", "index", "scene_members.json"), { force: true });
	const third = syncSceneIndex(root);
	check("sidecar 缺失 → members 降级为 []", Array.isArray(third[0]?.members) && third[0].members.length === 0);

	// 块被删后，sidecar 里的孤儿条目不应出现在索引里
	rmSync(sceneFile, { force: true });
	check("块已删除 → 索引为空（孤儿成员不出现）", syncSceneIndex(root).length === 0);

	const members = loadSceneMembers(root);
	check("loadSceneMembers 对不存在的 sidecar 返回空表", typeof members === "object" && Object.keys(members).length === 0);
	rmSync(root, { recursive: true, force: true });
}

console.log("\n=== 7. consolidate 完整性校验 checkConsolidation（纯函数）===");
{
	const src = (name: string, lines: string[], members: string[]) => ({
		filename: name,
		content: lines.join("\n"),
		members,
	});
	const body = (n: number) => Array.from({ length: n }, (_, i) => `- 条目 ${i}`);

	const s1 = src("a.md", body(10), ["l1_1787277400001_a1b2"]);
	const s2 = src("b.md", body(10), ["l1_1787277400002_c3d4"]);

	const good = checkConsolidation([s1, s2], {
		filename: "c.md",
		content: body(18).join("\n"),
		members: ["l1_1787277400001_a1b2", "l1_1787277400002_c3d4"],
	});
	check("正常合并通过", good.ok, good.error ?? "");
	check("无成员缺口", good.memberGaps.length === 0);
	check("行数比 ≈0.9", Math.abs(good.lines.ratio - 0.9) < 0.01, `ratio=${good.lines.ratio}`);
	check("正常合并不产生警告", good.warnings.length === 0, good.warnings.join(" | ").slice(0, 90));

	const gap = checkConsolidation([s1, s2], {
		filename: "c.md",
		content: body(18).join("\n"),
		members: ["l1_1787277400001_a1b2"],
	});
	check("显式 members 漏源成员 → 硬拒绝", !gap.ok);
	check("缺口可定位到具体 id", gap.memberGaps.length === 1 && gap.memberGaps[0] === "l1_1787277400002_c3d4", gap.memberGaps.join(","));

	const omit = checkConsolidation([s1, s2], { filename: "c.md", content: body(18).join("\n") });
	check("members 缺省 → 兜底放行（不判缺口）", omit.ok, omit.error ?? "");

	const short = checkConsolidation([s1, s2, src("d.md", body(10), [])], {
		filename: "c.md",
		content: body(6).join("\n"),
	});
	check("3 源且行数比 0.2 → 硬拒绝", !short.ok, `ratio=${short.lines.ratio.toFixed(2)}`);
	check("拒绝信息说明疑似丢条目", (short.error ?? "").includes("疑似大段条目丢失"));

	const twoLow = checkConsolidation([s1, s2], { filename: "c.md", content: body(8).join("\n") });
	check("2 源低比率 → 仍放行（避免误拒正常去重）", twoLow.ok, twoLow.error ?? "");
	check("2 源低比率 → 有警告（补上信号缺口）", twoLow.warnings.some((w) => w.includes("警戒线")), twoLow.warnings.join(" | ").slice(0, 80));

	const dropped = checkConsolidation([src("a.md", ["- 依据 l1_1787212089236_c3d4 确认"], ["l1_1787212089236_c3d4"])], {
		filename: "c.md",
		content: "- 目标块没有引用任何 id",
	});
	check("源正文 id 未出现在目标正文 → 警告", dropped.warnings.some((w) => w.includes("找不到")), dropped.warnings.join(" | ").slice(0, 90));
	// 提取口径是"数字部分"（块内常写去后缀形式），故对比也归一化到数字部分
	check("droppedIdRefs 定位到该 id", dropped.droppedIdRefs.includes("l1_1787212089236"), dropped.droppedIdRefs.join(","));

	const loose = checkConsolidation([src("a.md", ["- 依据 l1_1787212089236 确认"], ["l1_1787212089236_c3d4"])], {
		filename: "c.md",
		content: "- 依据 l1_1787212089236_c3d4 确认",
	});
	check("源写数字部分 / 目标写全量 → 不算丢失（宽松口径）", loose.droppedIdRefs.length === 0, loose.droppedIdRefs.join(","));

	const noMembers = checkConsolidation([src("a.md", body(6), []), src("b.md", body(6), [])], {
		filename: "c.md",
		content: body(11).join("\n"),
	});
	check("源块无 members → 提示已跳过成员校验", noMembers.warnings.some((w) => w.includes("跳过")), noMembers.warnings.join(" | ").slice(0, 80));
}

console.log("\n=== 8. consolidate 成员并集与 META 不变量（纯函数）===");
{
	const memberMap = { "a.md": ["m1", "m2"], "b.md": ["m2", "m3"] };
	const auto = resolveConsolidationMembers(["a.md", "b.md"], memberMap);
	check("缺省取源并集（去重）", auto.length === 3 && auto.includes("m1") && auto.includes("m3"), auto.join(","));
	const withExplicit = resolveConsolidationMembers(["a.md"], memberMap, ["m9"]);
	check("显式 members 并入并集", withExplicit.includes("m9") && withExplicit.includes("m1"), withExplicit.join(","));

	const sourcesMeta = [
		{ created: "2026-08-17T10:10:00.000Z", heat: 3 },
		{ created: "2026-08-17T08:42:40.008Z", heat: 13 },
	];
	const fresh = consolidationMeta(sourcesMeta, null, "2026-09-10T17:00:00.000Z", "新摘要");
	check("created 取最早", fresh.created === "2026-08-17T08:42:40.008Z", fresh.created);
	check("heat 取最大（禁止重置为 0）", fresh.heat === 13, `heat=${fresh.heat}`);
	check("updated 用调用方传入的当前时间", fresh.updated === "2026-09-10T17:00:00.000Z");
	check("summary 采用子代理提供的值", fresh.summary === "新摘要");

	const existing = { created: "2026-08-01T00:00:00.000Z", updated: "2026-08-01T00:00:00.000Z", summary: "旧摘要", heat: 32 };
	const onto = consolidationMeta(sourcesMeta, existing, "2026-09-10T17:00:00.000Z", "");
	check("目标已存在 → 保留其 created（禁止改写）", onto.created === "2026-08-01T00:00:00.000Z", onto.created);
	check("目标 heat 参与取最大（32 胜过 13）", onto.heat === 32, `heat=${onto.heat}`);
	check("summary 缺省时沿用目标原值", onto.summary === "旧摘要");
}

console.log("\n=== 9. consolidate 接入：上限预检 / 成员表 / 自动备份 ===");
{
	const base = ["a.md", "b.md", "d.md"];
	const shrink = checkSceneLimit(base, [{ action: "consolidate", filename: "merged.md", sources: ["a.md", "b.md"] }], 3);
	check("已达上限时 consolidate 必须放行（否则永远无法靠合并自愈）", shrink.ok, `count=${shrink.count}`);
	check("consolidate 后数量 3-2+1=2", shrink.count === 2, `count=${shrink.count}`);

	const ontoExisting = checkSceneLimit(base, [{ action: "consolidate", filename: "d.md", sources: ["a.md", "b.md"] }], 3);
	check("目标已存在时不新增条目（3-2=1）", ontoExisting.ok && ontoExisting.count === 1, `count=${ontoExisting.count}`);

	const updated = mergeSceneMembers({ "a.md": ["m1", "m2"], "b.md": ["m2", "m3"], "z.md": ["mz"] }, [
		{ action: "consolidate", filename: "merged.md", sources: ["a.md", "b.md"] },
	]);
	check("源条目已移除", !("a.md" in updated.members) && !("b.md" in updated.members));
	check("目标条目为源并集（说明并集在删除之前算）", (updated.members["merged.md"] ?? []).length === 3, (updated.members["merged.md"] ?? []).join(","));
	check("无关条目不受影响", (updated.members["z.md"] ?? []).join(",") === "mz");
	check("成员充足时不报 membersMissing", !updated.missing.includes("merged.md"));

	const p = mkdtempSync(join(tmpdir(), "l2-consolidate-"));
	const first = backupSceneBlocks(
		p,
		[
			{ filename: "a.md", raw: "AAA" },
			{ filename: "b.md", raw: "BBB" },
		],
		"t1",
		{ at: "now" },
	);
	const backupDirAbs = join(p, "memoryDB", first.dir);
	check("备份目录已创建", existsSync(backupDirAbs), first.dir);
	check("源块内容已备份", existsSync(join(backupDirAbs, "a.md")) && readFileSync(join(backupDirAbs, "a.md"), "utf-8") === "AAA");
	check("manifest 已写入", existsSync(join(backupDirAbs, "_manifest.json")));
	check("返回备份文件清单", first.files.length === 2, first.files.join(","));

	for (let i = 0; i < CONSOLIDATE_BACKUP_KEEP + 2; i++) {
		backupSceneBlocks(p, [{ filename: "a.md", raw: `v${i}` }], `t${100 + i}`, { at: "now" });
	}
	const dirs = readdirSync(join(p, "memoryDB", "backups")).filter((d) => d.startsWith("l2-consolidate-"));
	check(`备份份数封顶在 ${CONSOLIDATE_BACKUP_KEEP}`, dirs.length === CONSOLIDATE_BACKUP_KEEP, `实际 ${dirs.length}`);
	rmSync(p, { recursive: true, force: true });
}

// consolidate 的端到端（含真实落盘/删源/重建索引）在独立文件 scripts/verify-l2-consolidate.ts 中——
// 它与本文件的只读用例同进程运行时 await 无法 settle，拆开后各自稳定。
console.log(`
结果：PASS ${pass} / FAIL ${fail}`);
