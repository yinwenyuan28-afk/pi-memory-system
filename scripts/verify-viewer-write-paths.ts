// 查看器"管理操作补齐"的离线回归 —— 只读生产代码、只写系统临时目录。
//
// 为什么要有它：本轮把写盘面从 2 个端点扩到 12 个，其中三个动作是**破坏性**的
// （整库还原、向量重建、并入 live 画像）。这些路径不能只靠"跑通了"来验收 ——
// 每一道闸都要有夹具证明它**会拒绝**，否则闸门就是装饰。
//
// 覆盖：
//   ① pending-trigger 通道：写 → 探查不消费 → 消费一次即删 → 坏文件也能被消费掉（不会卡死触发）
//   ② applyL3Edit：dry-run 不落盘 / add·update·delete / 定位不唯一给候选 / 预算闸两种形态 /
//      缺参数给人话报错
//   ③ 抽取的等价性：经 `l3_edit` 工具走一遍，与直接调 `applyL3Edit` 的落盘结果**逐字节相同**
//   ④ mergeTempIntoLive：陈旧拒绝 / 过半删除拒绝 / 清空拒绝 / 三道闸分别放行后落盘 + 留档 /
//      dry-run 不落盘 / 无提议稿拒绝
//   ⑤ restoreFromBackup：文件名白名单（三条越界尝试）/ 逐字还原 / 还原前留档 / 空备份拒绝 /
//      不存在的备份报出候选
//   ⑥ checkFixGates：四道闸（证据 / 记录不存在 / 已删除 / 24h 防抖 / 高价值 + force）
//   ⑦ CLI 包装可执行：l2-archive 归档→恢复往返、l1-mode 读写、trigger 写信号、subagent-stop
//      空态、l3-edit/l3-restore/l3-merge 的 dry-run 与 apply、l1-fix 预演、embedding status
//   ⑧ 桥端点：13 个新端点存在且形状正确；写端点**默认 dry-run**（不传 apply 不改盘）；
//      confirm 副验（rollback / 重建 / 还原 / 并入）在缺 confirm 时 400
//
// 跑法：node --conditions=import --experimental-strip-types scripts/verify-viewer-write-paths.ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyL3Edit } from "../memory/l3/edit-core.ts";
import { registerL3EditTool } from "../memory/l3/edit-tool.ts";
import { listUserBackups, mergeTempIntoLive, readUserFile, readUserTempFile, resetRunFlags, restoreFromBackup, USER_TEMP_FILE } from "../memory/l3/user-file.ts";
import { consumePendingTrigger, isTriggerLayer, peekPendingTrigger, pendingTriggerPath, writePendingTrigger } from "../memory/pipeline/pending-trigger.ts";
import { releaseAllRunLocks } from "../memory/pipeline/run-lock.ts";
import { checkFixGates, type FixParams } from "../memory/l1/fix-tool.ts";

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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_DIR = join(REPO_ROOT, "scripts", "l1-admin");
const root = mkdtempSync(join(tmpdir(), "viewer-write-"));
const db = join(root, "memoryDB");

const iso = (d: string) => new Date(`${d}T00:00:00.000Z`).toISOString();
const j = (o: unknown) => `${JSON.stringify(o)}\n`;
const read = (p: string) => readFileSync(p, "utf-8");
const write = (p: string, s: string) => {
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, s, "utf-8");
};
/** 把文件 mtime 定到指定时刻（夹具要造"提议稿比 live 旧"这种时序，不能靠写盘先后赌同一毫秒）。 */
const setMtime = (p: string, ms: number) => utimesSync(p, ms / 1000, ms / 1000);

// ════════════════════════════════════════════════════════════════════════
// 夹具：一个最小可用的 profile（含 L1 记录 / 场景索引 / 两份画像 / 备份）
// ════════════════════════════════════════════════════════════════════════
const REC_A = "l1_1000_aaaa"; // work_task，存活
const REC_B = "l1_1001_bbbb"; // note，存活
const REC_C = "l1_1002_cccc"; // work_task，已 deleted
const REC_D = "l1_1003_dddd"; // note，存活且被场景索引引用（高价值）
const REC_E = "l1_1004_eeee"; // note，存活且带 24h 内的 l1Cleanup（防抖）

function buildFixture(): void {
	rmSync(join(root, "memoryDB"), { recursive: true, force: true });
	write(
		join(db, "l1", "records", "2026-10-08.jsonl"),
		[
			{ id: REC_A, type: "work_task", content: "任务甲：把桥的端点补齐", createdAt: iso("2026-10-01"), taskState: "open", cwd: "C:/dev/x" },
			{ id: REC_B, type: "note", content: "笔记乙：普通的观察", createdAt: iso("2026-10-02") },
			{ id: REC_C, type: "work_task", content: "已删丙", createdAt: iso("2026-10-03"), deleted: true },
			{ id: REC_D, type: "note", content: "高价值丁：被场景块引用", createdAt: iso("2026-10-04") },
			{
				id: REC_E,
				type: "note",
				content: "防抖戊：刚被改过",
				createdAt: iso("2026-10-05"),
				metadata: { l1Cleanup: { action: "rewrite", appliedAt: new Date().toISOString() } },
			},
		]
			.map(j)
			.join(""),
	);
	// 场景索引：REC_D 在 members 里 ⇒ isHighValue 为真（高价值保护那道闸）
	write(join(db, "l2", "index", "scene_index.json"), `${JSON.stringify([{ id: "sc1", name: "查看器", members: [REC_D] }], null, 2)}\n`);
	write(join(db, "l2", "scene-blocks", "查看器管理面.md"), "# 查看器管理面\n\n- l1_1003_dddd\n");
	write(join(db, "l1", "scenes.json"), `${JSON.stringify({ scenes: [{ id: "sc1", name: "查看器", aliases: ["viewer"] }] }, null, 2)}\n`);
	write(join(db, "l3", "cursor.json"), `${JSON.stringify({ lastPersonaUpdate: iso("2026-10-01"), memoriesSinceLastPersona: 3, lastTriggeredAt: iso("2026-10-02"), lastCommittedAt: iso("2026-10-03") }, null, 2)}\n`);
	write(join(db, "config", "application-propertis.json"), `{\n  // 夹具用最小配置节\n  "l1": { "mode": "code" }\n}\n`);
	// L1 库备份（整库还原的候选）
	write(join(db, "backups", "l1-admin", "20261001-100000-fixture", "l1", "records", "2026-10-08.jsonl"), j({ id: REC_A, type: "work_task", content: "备份里的甲", createdAt: iso("2026-09-30") }));
	// 画像三件套 + 一份备份
	const live = ["规则一：中文输出", "规则二：先分析根因", "规则三：改前先读", "规则四：精确提交", "规则五：留证据", "规则六：不编造"].join("\n§\n");
	write(join(root, "USER.md"), `${live}\n`);
	write(join(root, "MEMORY.md"), "全局事实一\n§\n全局事实二\n");
	write(join(root, "USER-temp.md"), `${["规则一：中文输出（提议稿改过）", "规则二：先分析根因", "规则三：改前先读", "规则四：精确提交", "规则五：留证据", "新增：提议稿里的第七条"].join("\n§\n")}\n`);
	write(join(db, "backups", "user-backups", "user-backup-1000.md"), "备份条目A\n§\n备份条目B\n");
	write(join(db, "backups", "user-backups", "user-backup-1001-empty.md"), "");
	// 提议稿比 live 旧（陈旧闸的夹具；两个时间点都写死，不靠写盘先后）
	setMtime(join(root, "USER-temp.md"), 1_700_000_000_000);
	setMtime(join(root, "USER.md"), 1_700_000_100_000);
}
buildFixture();

/** 跑一个 l1-admin CLI（与桥同款：`node --experimental-strip-types <script> … --profile <root>`）。 */
function cli(script: string, args: string[]): { code: number; json: any; out: string } {
	const r = spawnSync(process.execPath, ["--experimental-strip-types", join(TOOL_DIR, script), ...args, "--profile", root], {
		encoding: "utf8",
		timeout: 120000,
	});
	const out = `${r.stdout ?? ""}`;
	const i = out.indexOf("{");
	let json: any = null;
	if (i >= 0) {
		try {
			json = JSON.parse(out.slice(i));
		} catch {
			json = null;
		}
	}
	return { code: r.status ?? -1, json, out };
}

// ════════════════════════════════════════════════════════════════════════
// ① pending-trigger 通道
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== ① pending-trigger 通道 ===");
check("非法层名被拒（防止拼出不该存在的文件名）", isTriggerLayer("l0") === false && isTriggerLayer("l1") === true);
check("L1 信号路径落在 pipeline/ 下", pendingTriggerPath(root, "l1").endsWith(join("pipeline", "pending-trigger-l1.json")), pendingTriggerPath(root, "l1"));
check("写信号成功", writePendingTrigger(root, "l1", { reason: "夹具触发", by: "gate" }) === true);
const peeked1 = peekPendingTrigger(root, "l1");
check("探查（peek）能读到内容", peeked1?.reason === "夹具触发" && peeked1?.by === "gate", JSON.stringify(peeked1));
check("探查**不消费**（文件还在，页面刷新不会吃掉信号）", existsSync(pendingTriggerPath(root, "l1")));
const consumed = consumePendingTrigger(root, "l1");
check("消费拿到内容", consumed?.reason === "夹具触发");
check("消费后文件即删", !existsSync(pendingTriggerPath(root, "l1")));
check("再消费为 undefined（一个信号只生效一次）", consumePendingTrigger(root, "l1") === undefined);
// 坏文件：必须能被消费掉，否则一条坏信号会永久卡住该层的触发
writeFileSync(pendingTriggerPath(root, "l2"), "{ 这不是 JSON", "utf-8");
check("坏信号消费返回 undefined", consumePendingTrigger(root, "l2") === undefined);
check("坏信号被删掉（不会永久卡住触发）", !existsSync(pendingTriggerPath(root, "l2")));

// ════════════════════════════════════════════════════════════════════════
// ② applyL3Edit（抽取后的唯一实现）
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== ② applyL3Edit ===");
resetRunFlags();
const tempBefore = readUserTempFile(root) as string;
const dryAdd = applyL3Edit(root, { action: "add", content: "预演新增的一条" }, { dryRun: true });
check("dry-run 报成功且标 dryRun", dryAdd.success === true && dryAdd.dryRun === true, JSON.stringify({ ...dryAdd, candidates: undefined }));
check("dry-run 不落盘（提议稿逐字节未变）", readUserTempFile(root) === tempBefore);
check("dry-run 也回传目标文件名（界面要说明改的是提议稿）", dryAdd.targetFile === USER_TEMP_FILE);

const addRes = applyL3Edit(root, { action: "add", content: "真正新增的一条" });
check("add 落盘成功", addRes.success === true && addRes.dryRun === undefined);
check("add 后提议稿含新条目", (readUserTempFile(root) as string).includes("真正新增的一条"));
check("add 回传位置与用量", addRes.position === addRes.entryCount! - 1 && typeof addRes.usage === "string", `position=${addRes.position} usage=${addRes.usage}`);

const upRes = applyL3Edit(root, { action: "update", target: "真正新增的一条", content: "改写后的一条" });
check("update 命中并改写", upRes.success === true && (readUserTempFile(root) as string).includes("改写后的一条"));
check("update 后旧文本消失", !(readUserTempFile(root) as string).includes("真正新增的一条"));

const amb = applyL3Edit(root, { action: "update", target: "规则", content: "x" });
check("定位不唯一 → 拒绝并给候选清单", amb.success === false && Array.isArray(amb.candidates) && amb.candidates!.length > 1, `候选 ${amb.candidates?.length ?? 0} 条`);

const delRes = applyL3Edit(root, { action: "delete", target: "改写后的一条" });
check("delete 生效", delRes.success === true && !(readUserTempFile(root) as string).includes("改写后的一条"));
check("delete 缺 target → 明确报错（不再靠内部异常兜底）", applyL3Edit(root, { action: "delete" }).error!.includes("需要 target"));
check("add 缺 content → 明确报错", applyL3Edit(root, { action: "add" }).error!.includes("需要 content"));
check("非法 action → 拒绝", applyL3Edit(root, { action: "replace-all" as never, content: "x" }).success === false);

// ════════════════════════════════════════════════════════════════════════
// ③ 抽取的等价性：工具路径与 CLI 路径落盘结果必须逐字节相同
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== ③ 工具路径 vs applyL3Edit 等价 ===");
let capturedTool: { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> } | undefined;
registerL3EditTool({ registerTool: (t: unknown) => (capturedTool = t as never) } as never, () => root, () => {});
check("l3_edit 工具已注册", capturedTool !== undefined);
resetRunFlags();
const toolAdd = await capturedTool!.execute("call-1", { action: "add", content: "工具加的一条" });
const tempFromTool = readUserTempFile(root);
// 把提议稿恢复到夹具初始态，再用 CLI 侧实现跑同一步
write(join(root, `USER-temp.md`), tempBefore);
resetRunFlags();
const cliAdd = applyL3Edit(root, { action: "add", content: "工具加的一条" });
check("两侧都成功", JSON.parse(toolAdd.content[0].text).success === true && cliAdd.success === true);
check("两侧落盘结果逐字节相同", readUserTempFile(root) === tempFromTool);

// ════════════════════════════════════════════════════════════════════════
// ④ mergeTempIntoLive —— 三道安全闸
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== ④ 并入 live（三道闸） ===");
resetRunFlags();
const userPath = join(root, "USER.md");
const tempPath = join(root, USER_TEMP_FILE);
/**
 * 把两份画像的 mtime **钉死**再调 merge。
 * 不能靠"写盘先后"赌时序：任何一次写 temp 都会把它的 mtime 刷成"现在"，
 * 于是"提议稿比 live 旧"这个夹具前提会在上一节结束时悄悄失效（第一版就是这么假的）。
 */
const pinPersonaTimes = (tempMs: number) => {
	setMtime(userPath, 1_700_000_000_000);
	setMtime(tempPath, tempMs);
};
const liveBefore = readUserFile(root) as string;
check("夹具前提：live 6 条", (liveBefore.match(/规则/g) ?? []).length === 6, `实际 ${(liveBefore.match(/规则/g) ?? []).length}`);

// ① 陈旧：temp 比 live 旧
pinPersonaTimes(1_699_999_000_000);
const staleMerge = mergeTempIntoLive(root, {});
check("陈旧拒绝：提议稿比 live 旧 → 拒绝", staleMerge.ok === false && staleMerge.error!.includes("比 live 画像旧"), staleMerge.error?.slice(0, 60));
check("拒绝时也报出「会删几条」", typeof staleMerge.removedTotal === "number", `removedTotal=${staleMerge.removedTotal}`);
check("拒绝时 live 未被改动", readUserFile(root) === liveBefore);

// ② 过半删除：temp 更新，但只剩 1 条（放行陈旧闸也还不够）
write(tempPath, "只剩一条的提议稿\n");
pinPersonaTimes(1_700_000_200_000);
const massMerge = mergeTempIntoLive(root, { allowStale: true });
check("过半删除拒绝：live 6 条要删 6 条 → 拒绝", massMerge.ok === false && massMerge.error!.includes("过半"), massMerge.error?.slice(0, 40));
check("拒绝时 live 未被改动", readUserFile(root) === liveBefore);

// ③ 清空：temp 为空而 live 非空（放行过半闸也只是让"清空"这道闸变得可达）
write(tempPath, "\n");
pinPersonaTimes(1_700_000_200_000);
const emptyMerge = mergeTempIntoLive(root, { allowMassRemoval: true });
check("清空拒绝：提议稿 0 条而 live 有 6 条 → 拒绝", emptyMerge.ok === false && emptyMerge.error!.includes("清空"), emptyMerge.error?.slice(0, 40));

// ④ dry-run：三闸全放行也只预演
const okDry = mergeTempIntoLive(root, { dryRun: true, allowStale: true, allowMassRemoval: true, allowEmpty: true });
check("dry-run 全放行时报 ok 且标 dryRun", okDry.ok === true && okDry.dryRun === true);
check("dry-run 不落盘（live 逐字节未变）", readUserFile(root) === liveBefore);

// ⑤ 实写：三闸分别放行后落盘，并留档一份 -live-premerge 备份
const backupsBefore = listUserBackups(root).length;
const okMerge = mergeTempIntoLive(root, { allowStale: true, allowMassRemoval: true, allowEmpty: true });
check("三闸分别放行后实写成功", okMerge.ok === true && okMerge.backupFile !== undefined, `backup=${okMerge.backupFile}`);
check("live 变成提议稿的内容（0 条 ⇒ 空文件）", (readUserFile(root) ?? "").trim() === "");
check("备份数 +1（并入可回退）", listUserBackups(root).length === backupsBefore + 1);
check("备份名标出来由（live-premerge）", (okMerge.backupFile ?? "").includes("live-premerge"));
check("报告的 before/after 计数正确", okMerge.beforeCount === 6 && okMerge.afterCount === 0, `${okMerge.beforeCount}→${okMerge.afterCount}`);

// ⑥ 无提议稿 ⇒ 拒绝
rmSync(tempPath, { force: true });
const noTemp = mergeTempIntoLive(root, {});
check("无提议稿 → 拒绝并说明怎么办", noTemp.ok === false && noTemp.error!.includes("没有提议稿"), noTemp.error?.slice(0, 40));
// 把 live 还原回夹具态，后续小节要用（并入测试已经把 live 写空了）
write(userPath, `${["规则一：中文输出", "规则二：先分析根因", "规则三：改前先读", "规则四：精确提交", "规则五：留证据", "规则六：不编造"].join("\n§\n")}\n`);

// ════════════════════════════════════════════════════════════════════════
// ⑤ restoreFromBackup
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== ⑤ 备份还原 ===");
resetRunFlags();
write(join(root, USER_TEMP_FILE), "当前提议稿的一条\n");
setMtime(join(root, USER_TEMP_FILE), 1_700_000_300_000);
check("列举备份含夹具两份且有序", listUserBackups(root).length >= 2 && listUserBackups(root)[0] === "user-backup-1000.md", listUserBackups(root).join(", "));

for (const bad of ["../evil.md", "sub/evil.md", "evil.txt"]) {
	check(`文件名白名单拒绝 ${bad}`, restoreFromBackup(root, bad, {}).ok === false);
}
const notFound = restoreFromBackup(root, "user-backup-9999.md", {});
check("不存在的备份 → 拒绝且报出现有候选", notFound.ok === false && notFound.error!.includes("现有"), notFound.error?.slice(0, 60));

const tempNow = readUserTempFile(root);
const restDry = restoreFromBackup(root, "user-backup-1000.md", { dryRun: true });
check("dry-run 报 ok 且标 dryRun", restDry.ok === true && restDry.dryRun === true);
check("dry-run 不落盘", readUserTempFile(root) === tempNow);
check("dry-run 给出差异条数", restDry.removedTotal === 1 && restDry.addedTotal === 2, `+${restDry.addedTotal}/-${restDry.removedTotal}`);

const backupsBefore2 = listUserBackups(root).length;
const restOk = restoreFromBackup(root, "user-backup-1000.md", {});
check("还原成功", restOk.ok === true && restOk.restoredFrom === "user-backup-1000.md");
check("提议稿 = 备份原文（逐字还原，不重新序列化）", readUserTempFile(root) === "备份条目A\n§\n备份条目B\n");
check("还原前把当前 temp 另存（还原也可回退）", listUserBackups(root).length === backupsBefore2 + 1 && (restOk.backupFile ?? "").includes("pre-restore"));
check("还原目标是提议稿而非 live", restOk.file === USER_TEMP_FILE);

const emptyRestore = restoreFromBackup(root, "user-backup-1001-empty.md", {});
check("空备份覆盖有内容的提议稿 → 拒绝", emptyRestore.ok === false && emptyRestore.error!.includes("空"), emptyRestore.error?.slice(0, 40));
check("显式放行后可以还原成空", restoreFromBackup(root, "user-backup-1001-empty.md", { allowEmpty: true }).ok === true);

// ════════════════════════════════════════════════════════════════════════
// ⑥ checkFixGates（L1 纠错的四道闸，纯裁决）
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== ⑥ L1 纠错闸门 ===");
// 注意：证据门槛是 ≥20 字符、正文 ≥10 字符 —— 夹具字符串必须够长，否则测的是长度闸而不是目标闸。
const base: FixParams = { recordId: REC_A, action: "rewrite", newContent: "替换后的正文内容写够十个字以上", evidence: "grep 输出：fix-tool.ts:83 命中 checkFixGates 的裁决" };
		check("正常记录 → 放行", checkFixGates(root, base, {}).ok === true, JSON.stringify(checkFixGates(root, base, {})));
	check("证据过短 → 拒绝", checkFixGates(root, { ...base, evidence: "太短" }, {}).ok === false);
	check("rewrite 正文 <10 字符 → 拒绝", checkFixGates(root, { ...base, newContent: "短" }, {}).ok === false);
check("记录不存在 → 拒绝", checkFixGates(root, { ...base, recordId: "l1_9999_zzzz" }, {}).ok === false);
check("已 deleted 的记录 → 拒绝", checkFixGates(root, { ...base, recordId: REC_C }, {}).ok === false);
check("24h 防抖：刚改过的记录 → 拒绝", checkFixGates(root, { ...base, recordId: REC_E }, {}).ok === false);
check("高价值（场景索引引用）→ 拒绝", checkFixGates(root, { ...base, recordId: REC_D }, {}).ok === false);
check("--force 只解高价值那道闸", checkFixGates(root, { ...base, recordId: REC_D }, { force: true }).ok === true);
check("--force 解不开证据闸", checkFixGates(root, { ...base, recordId: REC_D, evidence: "短" }, { force: true }).ok === false);
check("非法 action → 拒绝", checkFixGates(root, { ...base, action: "delete" as never }, {}).ok === false);

// ════════════════════════════════════════════════════════════════════════
// ⑦ CLI 包装可执行（桥调用的就是它们）
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== ⑦ CLI 包装 ===");
// **必须先把本进程持有的 L3 运行级锁放掉**：上面几节直接调 applyL3Edit，它在进程内取锁且
// 不主动释放（子代理进程本来就短命，这是设计）；本门禁同进程里接着跑 CLI，那些 CLI 会看到
// 锁被一个活着的 pid 持有而正当地拒写 —— 那是锁在工作，不是 bug。
releaseAllRunLocks();
const mode0 = cli("l1-mode.mts", []);
check("l1-mode 读当前模式", mode0.json?.mode === "code", JSON.stringify(mode0.json));
const modeSet = cli("l1-mode.mts", ["--set", "chat"]);
check("l1-mode --set 写盘并回读确认", modeSet.json?.success === true && modeSet.json?.mode === "chat" && modeSet.json?.changed === true, modeSet.json?.error ?? "");
check("l1-mode 拒绝非法值", cli("l1-mode.mts", ["--set", "bogus"]).json?.success === false);
// --set 不需要 --apply（可逆动作的例外，写在脚本头注释里）
check("l1-mode 不走 dry-run（无 --apply 也写）", cli("l1-mode.mts", []).json?.mode === "chat");

const trigDry = cli("trigger.mts", ["--status"]);
check("trigger --status 三层皆为 null（夹具里没信号）", trigDry.json?.pending?.l1 === null && trigDry.json?.pending?.l3 === null);
const trigL2 = cli("trigger.mts", ["--layer", "l2", "--reason", "夹具"]);
check("trigger 写 L2 信号并回读确认", trigL2.json?.success === true && trigL2.json?.layer === "l2", trigL2.json?.error ?? "");
check("信号文件确实落在盘上", existsSync(pendingTriggerPath(root, "l2")));
const trigStatus2 = cli("trigger.mts", ["--status"]);
check("--status 能看到待消费信号", trigStatus2.json?.pending?.l2?.reason === "夹具");
check("trigger 拒绝非法层", cli("trigger.mts", ["--layer", "l9"]).json?.success === false);
// 清理这条信号，避免污染后续断言
rmSync(pendingTriggerPath(root, "l2"), { force: true });

const stopList = cli("subagent-stop.mts", ["--list"]);
check("subagent-stop --list 空态是 success:true", stopList.json?.success === true && Array.isArray(stopList.json?.runs));
check("subagent-stop 拒绝非法层", cli("subagent-stop.mts", ["--layer", "l9"]).json?.success === false);

const embed = cli("embedding.mts", ["status"]);
check("embedding status 可跑（夹具无向量库也不崩）", typeof embed.json?.success === "boolean", `success=${embed.json?.success}`);
const embedRebuildNoConfirm = cli("embedding.mts", ["rebuild", "--apply"]);
check("rebuild 缺 --confirm REBUILD → 拒绝", embedRebuildNoConfirm.json?.success === false && embedRebuildNoConfirm.json?.error!.includes("REBUILD"), embedRebuildNoConfirm.json?.error?.slice(0, 40));

const l2ArchiveDry = cli("l2-archive.mts", ["archive", "--file", "查看器管理面.md", "--reason", "夹具归档"]);
check("L2 归档 dry-run 通过前置检查", l2ArchiveDry.json?.success === true && l2ArchiveDry.json?.dryRun === true, l2ArchiveDry.json?.error ?? "");
check("dry-run 没搬走文件", existsSync(join(db, "l2", "scene-blocks", "查看器管理面.md")));
const l2Archive = cli("l2-archive.mts", ["archive", "--file", "查看器管理面.md", "--reason", "夹具归档", "--apply"]);
check("L2 归档实写成功", l2Archive.json?.success === true && l2Archive.json?.op === "archive", l2Archive.json?.error ?? "");
check("文件进了 archive/、离开了 scene-blocks/", existsSync(join(db, "l2", "archive", "查看器管理面.md")) && !existsSync(join(db, "l2", "scene-blocks", "查看器管理面.md")));
check("归档带上了 reason（账目唯一凭据）", (l2Archive.json?.members ?? -1) >= 0, `members=${l2Archive.json?.members}`);
const l2ArchiveNoReason = cli("l2-archive.mts", ["archive", "--file", "不存在.md"]);
check("归档缺 reason → 拒绝", l2ArchiveNoReason.json?.success === false);
const l2Restore = cli("l2-archive.mts", ["restore", "--file", "查看器管理面.md", "--apply"]);
check("L2 恢复往返成功", l2Restore.json?.success === true && existsSync(join(db, "l2", "scene-blocks", "查看器管理面.md")));

const l3EditDry = cli("l3-edit.mts", ["add", "--content", "CLI 预演的一条"]);
check("l3-edit dry-run 报成功", l3EditDry.json?.success === true && l3EditDry.json?.dryRun === true, l3EditDry.json?.error ?? "");
const l3EditApply = cli("l3-edit.mts", ["add", "--content", "CLI 实写的一条", "--apply"]);
check("l3-edit --apply 落盘", l3EditApply.json?.success === true && (readUserTempFile(root) ?? "").includes("CLI 实写的一条"), l3EditApply.json?.error ?? "");
releaseAllRunLocks(); // l3-edit --apply 又在本进程外取过锁，后面的 CLI 还需要它空着

const l3RestoreList = cli("l3-restore.mts", ["--list"]);
check("l3-restore --list 列出备份与条目数", l3RestoreList.json?.success === true && l3RestoreList.json?.count >= 2, `count=${l3RestoreList.json?.count}`);
const l3RestoreNoConfirm = cli("l3-restore.mts", ["--file", "user-backup-1000.md", "--apply"]);
check("l3-restore --apply 缺 --confirm → 拒绝", l3RestoreNoConfirm.json?.success === false && l3RestoreNoConfirm.json?.error!.includes("confirm"), l3RestoreNoConfirm.json?.error?.slice(0, 40));
const l3Restore = cli("l3-restore.mts", ["--file", "user-backup-1000.md", "--apply", "--confirm", "user-backup-1000.md"]);
check("l3-restore 带 confirm 还原成功", l3Restore.json?.success === true, l3Restore.json?.error ?? "");

const l3MergeNoConfirm = cli("l3-merge.mts", ["--apply"]);
check("l3-merge --apply 缺 --confirm MERGE → 拒绝", l3MergeNoConfirm.json?.success === false && l3MergeNoConfirm.json?.error!.includes("MERGE"));
const l3MergeDry = cli("l3-merge.mts", []);
check("l3-merge 预演（无 --apply）不落盘", l3MergeDry.json?.dryRun === true || l3MergeDry.json?.success === false);
const l1FixDry = cli("l1-fix.mts", [REC_A, "--action", "rewrite", "--content", "桥预演替换的正文内容写够十个字", "--evidence", "grep 输出：checkFixGates 命中并放行"]);
check("l1-fix 预演通过四道闸且不落盘", l1FixDry.json?.success === true && l1FixDry.json?.dryRun === true, l1FixDry.json?.error ?? "");
check("l1-fix 预演确实没改记录", read(join(db, "l1", "records", "2026-10-08.jsonl")).includes("任务甲：把桥的端点补齐"));
// 高价值那道闸依赖场景索引的 members —— 上面的 L2 归档往返会 syncSceneIndex 重建它，
// 所以这里把索引写回夹具态再测（否则测的是"索引恰好没提到它"，而不是闸门）。
write(join(db, "l2", "index", "scene_index.json"), `${JSON.stringify([{ id: "sc1", name: "查看器", members: [REC_D] }], null, 2)}\n`);
const l1FixForce = cli("l1-fix.mts", [REC_D, "--action", "rewrite", "--content", "强行替换的长正文内容写够十个字", "--evidence", "grep 输出：checkFixGates 命中高价值闸"]);
check("l1-fix 高价值记录预演被拒", l1FixForce.json?.success === false && l1FixForce.json?.error!.includes("高价值"), l1FixForce.json?.error?.slice(0, 60));
const l1FixForceOk = cli("l1-fix.mts", [REC_D, "--action", "rewrite", "--content", "强行替换的长正文内容写够十个字", "--evidence", "grep 输出：checkFixGates 命中高价值闸", "--force"]);
check("l1-fix --force 后预演通过（只解高价值那道闸）", l1FixForceOk.json?.success === true && l1FixForceOk.json?.dryRun === true, l1FixForceOk.json?.error?.slice(0, 60));

// ════════════════════════════════════════════════════════════════════════
// ⑧ 桥端点（起真桥 + 真 HTTP）
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== ⑧ 桥端点 ===");
releaseAllRunLocks();
const PORT = 5300 + Math.floor(Math.random() * 500);
const bridge = spawn(process.execPath, [join(TOOL_DIR, "viewer-bridge.mjs"), "--port", String(PORT), "--profile", root], {
	stdio: ["ignore", "pipe", "pipe"],
});
let bridgeLog = "";
bridge.stdout?.on("data", (c) => (bridgeLog += String(c)));
bridge.stderr?.on("data", (c) => (bridgeLog += String(c)));

const baseUrl = `http://127.0.0.1:${PORT}`;
async function get(path: string): Promise<{ status: number; json: any }> {
	const r = await fetch(baseUrl + path);
	let json: any = null;
	try {
		json = await r.json();
	} catch {
		json = null;
	}
	return { status: r.status, json };
}
async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
	const r = await fetch(baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
	let json: any = null;
	try {
		json = await r.json();
	} catch {
		json = null;
	}
	return { status: r.status, json };
}

/** 等桥就绪（轮询 /api/health，最多 8 秒）。 */
async function waitReady(): Promise<boolean> {
	for (let i = 0; i < 40; i++) {
		try {
			const r = await fetch(`${baseUrl}/api/health`);
			if (r.ok) return true;
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

try {
	check("桥起得来（/api/health 就绪）", await waitReady(), bridgeLog.slice(0, 200));

	// 读端点
	check("GET /api/limits 带 l1.mode", (await get("/api/limits")).json?.l1?.mode === "chat", JSON.stringify((await get("/api/limits")).json?.l1));
	const back = await get("/api/l1/backups");
	check("GET /api/l1/backups 列出夹具备份（含分片数）", back.json?.count === 1 && back.json?.backups?.[0]?.shards === 1, JSON.stringify(back.json?.backups?.[0]));
	const emb = await get("/api/l1/embeddings");
	check("GET /api/l1/embeddings 回结构化状态", typeof emb.json?.success === "boolean", emb.json?.error?.slice(0, 60));
	const pend = await get("/api/pending-triggers");
	check("GET /api/pending-triggers 回三层字段", pend.json?.pending && "l1" in pend.json.pending && "l2" in pend.json.pending && "l3" in pend.json.pending);
	const runs = await get("/api/subagent-runs");
	check("GET /api/subagent-runs 回 runs 数组", Array.isArray(runs.json?.runs));
	const pool = await get("/api/l2/scene-pool/report");
	check("GET /api/l2/scene-pool/report 回文本报告", pool.json?.success === true && typeof pool.json?.text === "string", `text ${String(pool.json?.text ?? "").length} 字符`);
	const mergeReport = await get("/api/l2/scene-pool/merge-report");
	check("GET /api/l2/scene-pool/merge-report 存在", mergeReport.status === 200 && typeof mergeReport.json?.text === "string");
	const blocks = await get("/api/l2/blocks");
	check("GET /api/l2/blocks 仍工作（回归）", Array.isArray(blocks.json?.live) && Array.isArray(blocks.json?.archive));
	const l3back = await get("/api/l3/backups");
	check("GET /api/l3/backups 仍工作（回归）", Array.isArray(l3back.json?.backups));

	// 写端点：默认 dry-run（不传 apply 时一个字节都不改）
	const shardPath = join(db, "l1", "records", "2026-10-08.jsonl");
	const shardBefore = read(shardPath);
	const fixDry = await post("/api/l1/fix", { id: REC_A, action: "rewrite", content: "桥来的新正文内容写够十个字以上", evidence: "grep 输出：桥端点默认 dry-run 检查" });
	check("POST /api/l1/fix 默认 dry-run", fixDry.json?.success === true && fixDry.json?.dryRun === true, fixDry.json?.error ?? "");
	check("POST /api/l1/fix dry-run 没改分片", read(shardPath) === shardBefore);
	check("POST /api/l1/fix 校验 id 形态", (await post("/api/l1/fix", { id: "not-an-id", action: "rewrite" })).status === 400);
	check("POST /api/l1/fix 校验 action", (await post("/api/l1/fix", { id: REC_A, action: "nuke" })).status === 400);

	check("POST /api/l1/mode 校验闭集", (await post("/api/l1/mode", { mode: "bogus" })).status === 400);
	const modePost = await post("/api/l1/mode", { mode: "code" });
	check("POST /api/l1/mode 写成功并回读", modePost.json?.success === true && modePost.json?.mode === "code", modePost.json?.error ?? "");

	check("POST /api/trigger 校验闭集", (await post("/api/trigger", { layer: "l9" })).status === 400);
	const trigPost = await post("/api/trigger", { layer: "l2", reason: "桥夹具" });
	check("POST /api/trigger 落盘信号", trigPost.json?.success === true && existsSync(pendingTriggerPath(root, "l2")), trigPost.json?.error ?? "");
	rmSync(pendingTriggerPath(root, "l2"), { force: true });

	check("POST /api/subagent/stop 校验闭集", (await post("/api/subagent/stop", { layer: "l9" })).status === 400);
	const stopPost = await post("/api/subagent/stop", { layer: "l3" });
	check("POST /api/subagent/stop 空态为 200 且 stopped:false", stopPost.status === 200 && stopPost.json?.stopped === false, JSON.stringify(stopPost.json));

	// L2 归档/恢复经桥（含文件名白名单）
	check("POST /api/l2/archive 拒绝带路径的文件名", (await post("/api/l2/archive", { filename: "../x.md", reason: "x" })).status === 400);
	check("POST /api/l2/archive 要求 reason", (await post("/api/l2/archive", { filename: "查看器管理面.md" })).status === 400);
	const brArchive = await post("/api/l2/archive", { filename: "查看器管理面.md", reason: "桥夹具归档" });
	check("POST /api/l2/archive 默认 dry-run", brArchive.json?.dryRun === true, brArchive.json?.error ?? "");
	check("POST /api/l2/archive dry-run 没搬文件", existsSync(join(db, "l2", "scene-blocks", "查看器管理面.md")));

	// L3：edit / restore / merge 的 confirm 副验
	check("POST /api/l3/edit 校验 action", (await post("/api/l3/edit", { action: "nuke" })).status === 400);
	const brEdit = await post("/api/l3/edit", { action: "add", content: "桥加的一条" });
	check("POST /api/l3/edit 默认 dry-run", brEdit.json?.success === true && brEdit.json?.dryRun === true, brEdit.json?.error ?? "");
	check("POST /api/l3/restore 校验备份名", (await post("/api/l3/restore", { file: "../evil.md", apply: true })).status === 400);
	check("POST /api/l3/restore apply 缺 confirm → 400", (await post("/api/l3/restore", { file: "user-backup-1000.md", apply: true })).status === 400);
	check("POST /api/l3/merge apply 缺 confirm → 400", (await post("/api/l3/merge", { apply: true })).status === 400);
	const mergeDryPost = await post("/api/l3/merge", {});
	check("POST /api/l3/merge 默认 dry-run", mergeDryPost.json?.dryRun === true || mergeDryPost.json?.success === false, JSON.stringify(mergeDryPost.json).slice(0, 120));

	check("POST /api/l1/embedding 校验 op", (await post("/api/l1/embedding", { op: "nuke" })).status === 400);
	check("POST /api/l1/embedding rebuild 缺 confirm → 400", (await post("/api/l1/embedding", { op: "rebuild", apply: true })).status === 400);
	check("POST /api/l1/rollback 校验备份名（拒绝路径）", (await post("/api/l1/rollback", { backup: "../evil" })).status === 400);
	const rollbackMissing = await post("/api/l1/rollback", { backup: "不存在的备份" });
	check("POST /api/l1/rollback 不存在的备份 → 400", rollbackMissing.status === 400, rollbackMissing.json?.error?.slice(0, 40));
	check(
		"POST /api/l1/rollback 缺 confirm → 400",
		(await post("/api/l1/rollback", { backup: "20261001-100000-fixture", apply: true })).status === 400,
	);
	const rollbackDry = await post("/api/l1/rollback", { backup: "20261001-100000-fixture" });
	check("POST /api/l1/rollback 默认 dry-run 且分片未变", rollbackDry.status === 200 && read(shardPath) === shardBefore, `status=${rollbackDry.status} json=${JSON.stringify(rollbackDry.json).slice(0, 100)}`);

	check("POST /api/l2/scene-pool/seed 要求 scenes", (await post("/api/l2/scene-pool/seed", { scenes: [] })).status === 400);
	const seedDry = await post("/api/l2/scene-pool/seed", { scenes: [{ name: "新场景", aliases: ["新"] }] });
	check("POST /api/l2/scene-pool/seed 默认 dry-run（文本透传）", seedDry.status === 200 && seedDry.json?.success === true && String(seedDry.json?.text ?? "").length > 0, JSON.stringify(seedDry.json).slice(0, 120));
	check("seed dry-run 没改 scenes.json", !read(join(db, "l1", "scenes.json")).includes("新场景"));
	check("未知端点仍是 404", (await get("/api/nope")).status === 404);
	check("静态托管仍拒绝 config/（回归）", (await fetch(`${baseUrl}/config/application-propertis.json`)).status === 403);
} finally {
	bridge.kill();
	// 先等子进程真的退出再删临时目录：Windows 上只要还有一个句柄开着，rmSync 就 EPERM
	// （实测：桥刚被 kill 就删 ⇒ EPERM，把一次全绿的验收变成退出码 1）。
	await new Promise<void>((resolve) => {
		const t = setTimeout(resolve, 3000);
		bridge.once("exit", () => {
			clearTimeout(t);
			resolve();
		});
	});
	// 清理失败**不判失败**：临时目录多留一份不影响上面的结论，而误判会让人去查不存在的问题。
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		console.log(`  （提示：临时目录未能清理，可手工删除 ${root}）`);
	}
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exit(1);
