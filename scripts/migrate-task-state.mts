// L1 存量任务状态迁移（一次性）：把历史 `metadata.status === "done"` 升格成顶层 `taskState = "done"`。
//
// 背景（plan/pi-memory-system/L1-任务生命周期标记-计划.md 任务 9）：
// 2026-10-08 之前，提取器把任务进度写成 `metadata.status` 自由文本（存量实测 7 种取值：
// todo 25 / done 4 / deferred 3 / confirmed 2 / doing 1 / blocked 1 / decided 1），
// 而**没有任何读取者**。新方案改用顶层闭集 `taskState`（open/done/dropped）。
//
// 本脚本只做**可机械映射**的一步：`metadata.status === "done"` → `taskState = "done"`。
// 其余取值（deferred / doing / blocked / confirmed / decided）语义不明，**一律不猜**，
// 保持缺省（= open），并在报告里列出"正文自称已完成/待决策但状态仍 open"的可疑行供人工过一遍。
// `metadata.status` 原样保留不删（模型自由字段，不属于本脚本的处置范围）。
//
// 语义与安全性：
//   - 走 `applyTaskStateChanges`（与工具/命令同一实现）：写锁内**就地改写**，不动正文/编号/向量；
//     审计写 `metadata.taskStateChange`（by=migration），**不碰** `metadata.l1Cleanup`（那是 l1_fix 的 24h 防抖源）。
//   - 默认 **dry-run**，只打印将改哪些行；`--apply` 才写盘，写前自动备份 l1/records 到
//     `memoryDB/backups/<ts>-task-state/`（复用 l1-admin 的 autoBackup）。
//   - 与 CLI 的既有缺口一致：`--apply` 前会检查 L1 运行级锁，**请在无后台 L1 运行时执行**
//     （l1-admin 的 .mjs 写者不取提交级写锁，这个缺口不在本脚本解决范围内）。
//
// 用法：
//   node scripts/migrate-task-state.mts --profile <profileDir>            # dry-run
//   node scripts/migrate-task-state.mts --profile <profileDir> --apply    # 实写（自动备份）
import { argv, exit } from "node:process";
import { recordsDirOf, scanRecordShards } from "../memory/l1/in-place-mark.ts";
import { applyTaskStateChanges } from "../memory/l1/task-state.ts";
import { taskStateOf } from "../memory/l1/record-types.ts";
import { autoBackup } from "./l1-admin/lib.mjs";

function argOf(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}
const profilePath = argOf("--profile") ?? process.env.PI_PROFILE_PATH ?? "";
const apply = argv.includes("--apply");
if (!profilePath) {
	console.error("用法：node scripts/migrate-task-state.mts --profile <profileDir> [--apply]");
	exit(2);
}

/** 正文自称"已完成"的信号（仅用于 dry-run 报告的人工复核清单，不驱动任何写入）。 */
const LOOKS_DONE = /已执行|已完成|已闭环|已完成并核验/;
/** 正文自称"待决策/待确认"的信号（同上，仅报告）。 */
const LOOKS_PENDING_DECISION = /待用户决策|待用户拍板|待拍板|待确认|待管理员确认/;

const scan = scanRecordShards(recordsDirOf(profilePath));
const migratable: { id: string; content: string; legacy: string }[] = [];
const suspectDone: { id: string; content: string }[] = [];
const suspectPending: { id: string; content: string }[] = [];
let aliveTasks = 0;
let alreadyDone = 0;

for (const [id, row] of scan.lastById) {
	if (row.obj.deleted === true) continue;
	if (row.obj.type !== "work_task") continue;
	aliveTasks++;
	const state = taskStateOf(row.obj);
	const md = (typeof row.obj.metadata === "object" && row.obj.metadata !== null ? row.obj.metadata : {}) as Record<string, unknown>;
	const legacy = typeof md.status === "string" ? md.status.trim().toLowerCase() : "";
	const content = typeof row.obj.content === "string" ? row.obj.content : "";
	if (state === "done") {
		alreadyDone++;
		continue;
	}
	if (legacy === "done") {
		migratable.push({ id, content, legacy: String(md.status) });
		continue;
	}
	if (state === "open" && LOOKS_DONE.test(content)) suspectDone.push({ id, content });
	else if (state === "open" && LOOKS_PENDING_DECISION.test(content)) suspectPending.push({ id, content });
}

const clip = (s: string, n = 70) => s.replace(/\s+/g, " ").slice(0, n);
console.log(`profile: ${profilePath}`);
console.log(`存活 work_task: ${aliveTasks} 条（其中已是 done: ${alreadyDone} 条）`);
console.log(`\n=== 可机械迁移（metadata.status="done" → taskState="done"）: ${migratable.length} 条 ===`);
for (const m of migratable) console.log(`  ${m.id}  (legacy status="${m.legacy}") | ${clip(m.content)}`);
console.log(`\n=== 需人工过一遍：正文自称已完成但状态仍 open（${suspectDone.length} 条） ===`);
for (const s of suspectDone) console.log(`  ${s.id} | ${clip(s.content)}`);
console.log(`\n=== 需人工过一遍：正文自称待决策/待确认（${suspectPending.length} 条） ===`);
for (const s of suspectPending) console.log(`  ${s.id} | ${clip(s.content)}`);

if (migratable.length === 0) {
	console.log("\n无可机械迁移的行，退出。");
	exit(0);
}
if (!apply) {
	console.log("\n[dry-run] 未写盘。加 --apply 实写（会自动备份）。");
	exit(0);
}

autoBackup(profilePath, "task-state");
const out = applyTaskStateChanges(
	profilePath,
	migratable.map((m) => ({ id: m.id, state: "done" as const })),
	{ by: "migration", reason: "迁移：metadata.status=done → taskState" },
);
console.log(`\n迁移结果：成功 ${out.changed} / 幂等 ${out.noop} / 失败 ${out.failed}（分片 ${out.changedFiles} 个 / 行 ${out.changedRows}）`);
for (const r of out.results) {
	console.log(r.ok ? (r.changed ? `  ✓ ${r.id}  ${r.from} → ${r.to}` : `  = ${r.id}  已是 ${r.to}`) : `  ✗ ${r.id}  ${r.error}`);
}
exit(out.failed > 0 ? 1 : 0);
