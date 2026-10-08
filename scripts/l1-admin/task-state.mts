// task-state.mts —— 任务生命周期标记的命令行入口（查看器写盘桥与人工运维共用）
//
// 为什么单独一个 CLI 而不是在桥里另写一份：
// 桥是 .mjs（纯 Node，不能 import .ts），而 `taskState` 的就地改写实现是
// `memory/l1/task-state.ts` 的 `applyTaskStateChanges` —— 它同时被 agent 工具 `l1_task_state`
// 与用户命令 `/my-memory:l1:task` 使用。**再写第三份就是三处口径分叉**（写锁、幂等、LWW 存活
// 判定、审计键各漂一次），所以这里只做参数解析 + 转发，逻辑一行不复制。
// 先例：`scripts/migrate-task-state.mts` 同样直接 import 那个实现（Node ≥22.13 的类型剥离）。
//
// 与桥既有写路径（tombstone.mjs）的差别：本脚本**取跨进程写锁**（`applyTaskStateChanges` 内部
// `acquireWriteLock`），拿不到就一条都不写并返回 lockError。l1-admin 的 .mjs 写者至今没有这把锁，
// 这是已知缺口（见 memory/l1/write-lock.ts 头部）；本入口不给这个缺口添新成员。
//
// 用法（供桥调用，也可人工用）：
//   node --experimental-strip-types scripts/l1-admin/task-state.mts <id...> --state done|dropped|open [--reason "…"] [--profile <dir>] [--apply] [--backup]
// 默认 **dry-run**（只报将改什么），`--apply` 才写盘。
//
// ── 关于备份（`--backup`）：为什么**默认不备份**、且桥不传它 ──
// 本目录其它写者（tombstone / rewrite / migrate-task-state）都是"实写前自动备份"，那是它们的安全默认。
// 这里刻意不同，理由是这个动作的风险档次不一样：
//   · `tombstone` 让记录**死掉**（退出召回与向量）；`rewrite` 换掉正文 —— 都是难以从结果反推的破坏。
//   · `taskState` 只是就地改一个状态字段：可逆（改回去即可）、幂等、留审计、不动正文/编号/向量，
//     而且**界面上的切换按钮**会随时调用它 —— 每次点击都整目录备份一遍既拖慢交互又把 backups/ 淹没。
// 所以备份改为显式 `--backup`（人工批量操作时用；界面路径不传）。批量迁移另有
// `scripts/migrate-task-state.mts`，它自带 `--apply` 前备份。
//
// 注意：一律用 `process.exitCode` 而不是 `process.exit()` —— stdout 是管道时写入是异步的，
// 立刻 exit 会把 JSON 截断，桥那边 JSON.parse 直接失败。
import { argv, stdout } from "node:process";
import { applyTaskStateChanges } from "../../memory/l1/task-state.ts";
import { L1_TASK_STATES_TEXT, normalizeTaskState, taskStateOf, type L1TaskState } from "../../memory/l1/record-types.ts";
import { recordsDirOf, scanRecordShards } from "../../memory/l1/in-place-mark.ts";
import { autoBackup } from "./lib.mjs";

/** 取 `--flag value` 形式的值。 */
function flagValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}

const apply = argv.includes("--apply");
const wantBackup = argv.includes("--backup");
const profilePath = flagValue("--profile") ?? process.env.PI_PROFILE_PATH ?? "";
const stateRaw = flagValue("--state");
const reason = flagValue("--reason");
const state = stateRaw ? normalizeTaskState(stateRaw) : null;

/** 非 flag 参数里排除 flag 的值，剩下的当 id。 */
const FLAGS_WITH_VALUE = new Set(["--profile", "--state", "--reason"]);
const ids: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (FLAGS_WITH_VALUE.has(a)) {
		i++;
		continue;
	}
	if (a.startsWith("--")) continue;
	if (/^l1_[0-9a-z_]+$/.test(a)) ids.push(a);
}

function writeJson(obj: unknown): void {
	stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

/** `--apply` 路径：可选备份 → 就地改写 → 输出结果。 */
function runApply(): void {
	// 显式要求备份时才备份（理由见文件头；界面路径不传这个 flag）。
	// 注意：autoBackup 自带 console.log，会在 JSON 之前多打一行 —— 因此本脚本的调用方
	// （写盘桥）必须从第一个 `{` 起解析 stdout，不能整段 JSON.parse。
	let backupDir: string | undefined;
	if (wantBackup) {
		try {
			backupDir = autoBackup(profilePath, "task-state");
		} catch (e) {
			writeJson({ success: false, error: `备份失败，已中止写盘：${e instanceof Error ? e.message : String(e)}` });
			process.exitCode = 1;
			return;
		}
	}

	const out = applyTaskStateChanges(
		profilePath,
		ids.map((id) => ({ id, state })),
		{ by: "user", reason },
	);
	writeJson({
		success: out.failed === 0,
		changed: out.changed,
		noop: out.noop,
		failed: out.failed,
		changedFiles: out.changedFiles,
		changedRows: out.changedRows,
		...(backupDir ? { backupDir } : {}),
		...(out.lockError ? { error: out.lockError } : {}),
		results: out.results,
	});
	process.exitCode = out.failed === 0 ? 0 : 1;
}

if (!profilePath || !state || ids.length === 0) {
	writeJson({
		success: false,
		error:
			`用法：node --experimental-strip-types scripts/l1-admin/task-state.mts <l1_id...> ` +
			`--state ${L1_TASK_STATES_TEXT} [--reason "…"] [--profile <dir>] [--apply] [--backup]`,
	});
	process.exitCode = 2;
} else if (!apply) {
	// dry-run：只读扫描报出「将改什么」，不取写锁、不写盘
	const scan = scanRecordShards(recordsDirOf(profilePath));
	const preview = ids.map((id) => {
		const row = scan.lastById.get(id);
		if (!row) return { id, ok: false, from: null, to: state, error: "记录不存在" };
		if (row.obj.deleted === true) return { id, ok: false, from: null, to: state, error: "记录已 deleted（任务状态不再有意义）" };
		if (row.obj.type !== "work_task") {
			return { id, ok: false, from: null, to: state, error: `只有 work_task 承载任务状态（该记录 type=${row.obj.type || "?"}）` };
		}
		const from: L1TaskState = taskStateOf(row.obj);
		return { id, ok: true, from, to: state, changed: from !== state };
	});
	writeJson({ success: true, dryRun: true, results: preview, hint: "加 --apply 才写盘" });
	process.exitCode = 0;
} else {
	runApply();
}
