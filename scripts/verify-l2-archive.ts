// L2 归档层（archive / restore）的离线回归 —— 只读生产代码、只写系统临时目录。
//
// 覆盖：
//   ① 两条硬拦（纯函数）：年龄不足 / 同名冲突 / 年龄未知放行
//   ② 事实清单：无命中记录的成员 → membersWithHits=0（不崩）；活跃日列按活跃日时钟算
//   ③ e2e 归档：文件进 l2/archive/、live 少一个、成员进归档侧车、live 侧车去掉、账有一行
//   ④ e2e 恢复往返：文件与成员回 live、账两行
//   ⑤ 覆盖保护：两向同名冲突都拒绝
//   ⑥ 上限口径：archive 算净收缩、restore 算净增长（checkSceneLimit 纯函数）
//   ⑦ 自愈：账缺失 → 补账；归档侧车被清掉 → 从正文 id token 兜回；**搁浅成员**（live 有成员、
//      文件已搬走）→ 收回归档侧车而不是丢掉
//   ⑧ reconcile 幂等：连跑两次第二次无改动
//
// 用 tsx 跑：tsx scripts/verify-l2-archive.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	archiveSceneBlock,
	archivedBlockExists,
	loadArchiveMembers,
	loadLiveMembers,
	readArchiveLedger,
	reconcileArchive,
	restoreSceneBlock,
	listArchivedBlocks,
} from "../memory/l2/archive.ts";
import { buildArchiveFacts, checkArchiveHardBlocks } from "../memory/l2/archive-facts.ts";
import { buildArchiveGuide } from "../memory/l2/archive-tool.ts";
import { checkSceneLimit, type SceneWrite } from "../memory/l2/commit-tool.ts";
import { resolveArchiveSection, L2_ARCHIVE_DEFAULTS, sceneCountWarningLine } from "../memory/l2/config.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

const root = mkdtempSync(join(tmpdir(), "l2-archive-"));
const dbDir = join(root, "memoryDB");
const sceneDir = join(dbDir, "l2", "scene-blocks");
const archiveDir = join(dbDir, "l2", "archive");
const membersPath = join(dbDir, "l2", "index", "scene_members.json");
for (const d of [sceneDir, archiveDir, join(dbDir, "l2", "index"), join(dbDir, "l0", "conversations")]) {
	mkdirSync(d, { recursive: true });
}

const NOW = "2026-09-27T10:00:00.000Z";

/** 块夹具：created 默认 40 天前（过年龄硬拦），带若干 id token。 */
function block(opts: { created?: string; updated?: string; summary?: string; ids?: string[] } = {}): string {
	const created = opts.created ?? "2026-08-18T00:00:00.000Z";
	const updated = opts.updated ?? "2026-09-12T00:00:00.000Z";
	const body = (opts.ids ?? []).map((id) => `- 事实（${id}）`).join("\n");
	return `-----META-START-----\ncreated: ${created}\nupdated: ${updated}\nsummary: ${opts.summary ?? "摘要"}\nheat: 3\n-----META-END-----\n\n## 核心叙事\n${body || "- 无"}\n`;
}

const ID_A = "l1_1789000000001_aaaa";
const ID_B = "l1_1789000000002_bbbb";

// ── ① 两条硬拦（纯函数）────────────────────────────────────
console.log("── ① 两条硬拦");
check("年龄不足（6 < 7）→ too-early", (() => {
	const v = checkArchiveHardBlocks({ ageCalendarDays: 6, minAgeCalendarDays: 7, nameConflict: false });
	return !v.ok && v.code === "too-early";
})());
check("年龄刚好 7 → 放行", checkArchiveHardBlocks({ ageCalendarDays: 7, minAgeCalendarDays: 7, nameConflict: false }).ok);
check("年龄未知（null）→ 放行（判不了就不假装判得了）", checkArchiveHardBlocks({ ageCalendarDays: null, minAgeCalendarDays: 7, nameConflict: false }).ok);
check("同名冲突 → name-conflict（且优先级高于年龄）", (() => {
	const v = checkArchiveHardBlocks({ ageCalendarDays: 1, minAgeCalendarDays: 7, nameConflict: true });
	return !v.ok && v.code === "name-conflict";
})());

// ── ② 事实清单 ───────────────────────────────────────────────
console.log("── ② 事实清单");
writeFileSync(join(sceneDir, "old-cold.md"), block({ summary: "早期项目", ids: [ID_A] }), "utf-8");
writeFileSync(join(sceneDir, "fresh.md"), block({ created: "2026-09-25T00:00:00.000Z", summary: "刚建的", ids: [ID_B] }), "utf-8");
writeFileSync(membersPath, JSON.stringify({ "old-cold.md": [ID_A], "fresh.md": [ID_B] }, null, 2), "utf-8");
// 造两个活跃日分片（事实清单的"自 updated 起活跃日"用活跃日时钟）
writeFileSync(join(dbDir, "l0", "conversations", "2026-09-12.jsonl"), "", "utf-8");
writeFileSync(join(dbDir, "l0", "conversations", "2026-09-20.jsonl"), "", "utf-8");

const facts = buildArchiveFacts(root, Date.parse(NOW));
check("事实清单列出 2 块", facts.blocks.length === 2, `实际 ${facts.blocks.length}`);
check("无命中侧车时 statsSource=none", facts.statsSource === "none", facts.statsSource);
const cold = facts.blocks.find((b) => b.filename === "old-cold.md")!;
check("没有命中记录的成员 → membersWithHits=0（不崩）", cold.membersWithHits === 0, String(cold.membersWithHits));
check("成员数与 sidecar 一致", cold.memberCount === 1, String(cold.memberCount));
check("自 updated（09-12）起过了 1 个活跃日（09-20）", cold.activeDaysSinceUpdate === 1, String(cold.activeDaysSinceUpdate));
check("年龄按日历天算（08-18 → 09-27 约 40 天）", cold.ageCalendarDays === 40, String(cold.ageCalendarDays));
check("归档配置走配置中心（缺配置 → 默认值）", facts.archive.enabled === L2_ARCHIVE_DEFAULTS.enabled && facts.archive.minAgeCalendarDays === 7);

check("resolveArchiveSection：非法值逐项回默认", (() => {
	const c = resolveArchiveSection({ enabled: "yes", minAgeCalendarDays: -3, maxPerBatch: 0 });
	return c.enabled === true && c.minAgeCalendarDays === 7 && c.maxPerBatch === 1;
})());
check("resolveArchiveSection：合法值生效", (() => {
	const c = resolveArchiveSection({ enabled: false, minAgeCalendarDays: 30, maxPerBatch: 2 });
	return c.enabled === false && c.minAgeCalendarDays === 30 && c.maxPerBatch === 2;
})());

// ── ③ e2e 归档 ───────────────────────────────────────────────
console.log("── ③ e2e 归档");
const res = archiveSceneBlock(root, { filename: "old-cold.md", reason: "项目已收尾", by: "subagent", nowIso: NOW });
check("归档成功", res.ok, res.error ?? "");
check("成员被带回（1 条）", res.members.length === 1, String(res.members.length));
check("文件进入 l2/archive/", existsSync(join(archiveDir, "old-cold.md")));
check("live 目录里已没有它", !existsSync(join(sceneDir, "old-cold.md")));
check("归档 sidecar 有它的成员", (loadArchiveMembers(root)["old-cold.md"] ?? []).includes(ID_A));
check("live sidecar 已去掉该条目", loadLiveMembers(root)["old-cold.md"] === undefined);
const ledger1 = readArchiveLedger(root);
check("账上有一行 archive 且带 reason", ledger1.length === 1 && ledger1[0].op === "archive" && ledger1[0].reason === "项目已收尾", JSON.stringify(ledger1[0] ?? {}));
check("账上有 memberCount", ledger1[0]?.memberCount === 1, String(ledger1[0]?.memberCount));
check("列表能看到它（含事件）", listArchivedBlocks(root).some((b) => b.filename === "old-cold.md" && b.events.length === 1));

// ── ④ e2e 恢复往返 ───────────────────────────────────────────
console.log("── ④ e2e 恢复往返");
const back = restoreSceneBlock(root, { filename: "old-cold.md", by: "command", reason: "搬错了", nowIso: NOW });
check("恢复成功", back.ok, back.error ?? "");
check("文件回到 live 目录", existsSync(join(sceneDir, "old-cold.md")));
check("归档目录里已没有它", !existsSync(join(archiveDir, "old-cold.md")));
check("成员回到 live sidecar", (loadLiveMembers(root)["old-cold.md"] ?? []).includes(ID_A));
check("归档 sidecar 已去掉该条目", loadArchiveMembers(root)["old-cold.md"] === undefined);
check("账变成两行（archive + restore）", readArchiveLedger(root).length === 2, String(readArchiveLedger(root).length));

// ── ⑤ 覆盖保护 ───────────────────────────────────────────────
console.log("── ⑤ 覆盖保护");
archiveSceneBlock(root, { filename: "old-cold.md", reason: "再搬一次", by: "subagent", nowIso: NOW });
// 此时 live 无、归档有 → 再归档应因"文件不存在"被拒
check("live 已无该块 → 再归档被拒", !archiveSceneBlock(root, { filename: "old-cold.md", reason: "重复", by: "subagent", nowIso: NOW }).ok);
// 造 live 同名 + 归档同名
writeFileSync(join(sceneDir, "old-cold.md"), block({ ids: [ID_A] }), "utf-8");
check("两向同名冲突：归档被拒", (() => {
	const r = archiveSceneBlock(root, { filename: "old-cold.md", reason: "冲突", by: "subagent", nowIso: NOW });
	return !r.ok && r.error!.includes("同名");
})());
check("两向同名冲突：恢复被拒", (() => {
	const r = restoreSceneBlock(root, { filename: "old-cold.md", by: "command", nowIso: NOW });
	return !r.ok && r.error!.includes("同名");
})());
check("非法文件名被拒（路径穿越）", !archiveSceneBlock(root, { filename: "../evil.md", reason: "x", by: "subagent", nowIso: NOW }).ok);
check("空 reason 被拒", !archiveSceneBlock(root, { filename: "fresh.md", reason: "  ", by: "subagent", nowIso: NOW }).ok);
check("archivedBlockExists 只看归档目录", archivedBlockExists(root, "old-cold.md") && !archivedBlockExists(root, "fresh.md"));

// ── ⑥ 上限口径（纯函数）─────────────────────────────────────
console.log("── ⑥ 上限口径");
const W = (action: SceneWrite["action"], filename: string, extra: Partial<SceneWrite> = {}): SceneWrite => ({ action, filename, ...extra });
const base3 = ["a.md", "b.md", "c.md"];
check("满库 + archive → 通过（净收缩）", checkSceneLimit(base3, [W("archive", "a.md", { reason: "r" })], 3).ok);
check("满库 + restore → 拒绝（净增长）", !checkSceneLimit(base3, [W("restore", "z.md")], 3).ok);
check("满库 + 同批 archive 后 restore → 通过（净 0）", checkSceneLimit(base3, [W("archive", "a.md", { reason: "r" }), W("restore", "z.md")], 3).ok);
check("满库 + 同批 restore 后 archive → 拒绝（推演中先越限）", !checkSceneLimit(base3, [W("restore", "z.md"), W("archive", "a.md", { reason: "r" })], 3).ok);
check("archive + create 腾位 → 通过", checkSceneLimit(base3, [W("archive", "a.md", { reason: "r" }), W("create", "d.md")], 3).ok);

// ── ⑦ 自愈 ───────────────────────────────────────────────────
console.log("── ⑦ 自愈");
// 场景：把 fresh.md 手动"搬"进归档目录，但不写账、不写 sidecar（模拟崩在移文件之后）
writeFileSync(join(archiveDir, "fresh.md"), readFileSync(join(sceneDir, "fresh.md"), "utf-8"), "utf-8");
rmSync(join(sceneDir, "fresh.md"), { force: true });
// live sidecar 里还留着 fresh.md 的成员（搁浅成员）
const liveBefore = loadLiveMembers(root);
check("前置：live sidecar 里还有搁浅成员", Array.isArray(liveBefore["fresh.md"]), JSON.stringify(Object.keys(liveBefore)));
const rep = reconcileArchive(root, NOW);
check("补账：fresh.md 得到 ledger-missing", rep.ledgerBackfilled.includes("fresh.md"), JSON.stringify(rep.ledgerBackfilled));
check("搁浅成员被收回（不是丢掉）", rep.strandedMembersCollected.includes("fresh.md"), JSON.stringify(rep.strandedMembersCollected));
check("收回后归档 sidecar 里确有 ID_B", (loadArchiveMembers(root)["fresh.md"] ?? []).includes(ID_B), JSON.stringify(loadArchiveMembers(root)["fresh.md"] ?? []));
check("live sidecar 已清掉搁浅条目", loadLiveMembers(root)["fresh.md"] === undefined);
// 归档 sidecar 被清空 → 从正文 id token 兜回
writeFileSync(join(dbDir, "l2", "archive", "scene_members.json"), JSON.stringify({}, null, 2), "utf-8");
const rep2 = reconcileArchive(root, NOW);
check("成员缺失 → 从正文 id token 兜回", rep2.membersRecovered.includes("fresh.md") && (loadArchiveMembers(root)["fresh.md"] ?? []).includes(ID_B));
// sidecar 有条目、目录无文件 → 剪掉
const am = loadArchiveMembers(root);
am["ghost.md"] = ["l1_1789000000009_zzzz"];
writeFileSync(join(dbDir, "l2", "archive", "scene_members.json"), JSON.stringify(am, null, 2), "utf-8");
const rep3 = reconcileArchive(root, NOW);
check("孤儿 sidecar 条目被剪掉", rep3.sidecarPruned.includes("ghost.md") && loadArchiveMembers(root)["ghost.md"] === undefined);
// 幂等
const rep4 = reconcileArchive(root, NOW);
check("reconcile 幂等（第二次无改动）", rep4.ledgerBackfilled.length === 0 && rep4.strandedMembersCollected.length === 0 && rep4.sidecarPruned.length === 0 && rep4.membersRecovered.length === 0, JSON.stringify(rep4));

// ── ⑧ 渐进式的形状断言（2026-09-27 的核心取舍）───────────────
console.log("── ⑧ 渐进式：工具返回 + 指针只在橙/红级出现");
// 准备一个"年轻"的块，用来验证 verdict 分支
writeFileSync(join(sceneDir, "brand-new.md"), block({ created: "2026-09-26T00:00:00.000Z", summary: "刚建的" }), "utf-8");
const guide = buildArchiveGuide(root, undefined, Date.parse(NOW));
check("返回含规则正文（registry 渲染，非内联）", guide.guide.includes("归档") && guide.guide.includes("reason"));
check("返回含事实清单表头（7 列）", guide.facts.includes("成员数") && guide.facts.includes("自 updated 起活跃日"));
check("事实清单列出每个块（含刚建的）", guide.facts.includes("brand-new.md"));
check("不带 filename 时没有 verdict", guide.verdict === undefined);
check("note 说明每批上限与可 restore", guide.note.includes("restore"));
const ver = buildArchiveGuide(root, "brand-new.md", Date.parse(NOW)).verdict!;
check("带 filename：年龄不足 → ok=false 且 code=too-early", ver.ok === false && ver.code === "too-early", JSON.stringify(ver));
const ver2 = buildArchiveGuide(root, "not-there.md", Date.parse(NOW)).verdict!;
check("带 filename：不存在 → code=not-found（提示可能已归档）", ver2.ok === false && ver2.code === "not-found", JSON.stringify(ver2));
const ver3 = buildArchiveGuide(root, "old-cold.md", Date.parse(NOW)).verdict!;
check("带 filename：live 与归档同名 → code=name-conflict", ver3.ok === false && ver3.code === "name-conflict", JSON.stringify(ver3));
// 一个既在 live、又年龄够、且归档目录无同名的块 → 应当 ok=true
writeFileSync(join(sceneDir, "ok-candidate.md"), block({ created: "2026-08-18T00:00:00.000Z", summary: "合格的候选" }), "utf-8");
const ver4 = buildArchiveGuide(root, "ok-candidate.md", Date.parse(NOW)).verdict!;
check("带 filename：合格块 → ok=true（两条硬拦都过）", ver4.ok === true, JSON.stringify(ver4));
// 渐进式的关键：非橙/红级时任务消息里**不出现**工具名
const warnNone = sceneCountWarningLine(3, 15);
const warnYellow = sceneCountWarningLine(12, 15);
const warnOrange = sceneCountWarningLine(14, 15);
const warnRed = sceneCountWarningLine(15, 15);
check("无色级不含工具名", !warnNone.includes("l2_archive_guide"));
check("黄色级不含工具名", !warnYellow.includes("l2_archive_guide"));
check("橙色级含工具名", warnOrange.includes("l2_archive_guide"));
check("红色级含工具名", warnRed.includes("l2_archive_guide"));
check("归档层关闭时连指针也不出现", !sceneCountWarningLine(15, 15, false).includes("l2_archive_guide"));
check("归档层关闭后仍保留原有合并指引", ["禁止 CREATE", "合并评估", "update"].every((k) => sceneCountWarningLine(15, 15, false).includes(k)));

rmSync(root, { recursive: true, force: true });
console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exit(1);
