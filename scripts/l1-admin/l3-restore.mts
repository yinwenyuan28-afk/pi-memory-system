// l3-restore.mts —— L3 画像备份的列举与还原（查看器写盘桥 + 人工运维）
//
// 这是本轮**唯一新写的还原实现**（此前 `backups/user-backups/` 有生成者也有陈列者，
// 但没有还原入口 —— 全系统搜不到任何 user-backup 的还原代码）。还原逻辑在
// `memory/l3/user-file.ts` 的 `restoreFromBackup`，本脚本只解析参数。
//
// 语义要点（写在这里也写在界面上，因为它反直觉）：
//   · **还原到 `USER-temp.md`（提议稿），不是 live `USER.md`**。原因：备份文件名只记时间戳，
//     不记"当时捕获的是 temp 还是 live"（`ensureRunBackup` 捕的是 `readL3TargetFile` = temp ?? live），
//     既然分不清就统一落到 L3 唯一的写目标 temp；要上 live 再走一次并入。
//   · 还原前会把**当前 temp** 另存一份（`-pre-restore` 后缀），所以还原本身也可回退。
//   · 空备份（0 条）而当前有内容 ⇒ 默认拒绝，要 `--allow-empty` 显式放行。
//
// 为什么要在这里取 L3 run-lock：还原和正在跑的 L3 子代理都在写同一份提议稿，交错会互相覆盖。
// 锁取在 CLI 层而不是函数里，是因为 `restoreFromBackup` 是个"文件级"操作（要能脱锁离线测）；
// 而 `applyL3Edit` 要照顾模型调用的工具路径，只能在实现内部取 —— 两种取法的差别仅是调用方是谁。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/l3-restore.mts --list [--profile <dir>]
//   node --experimental-strip-types scripts/l1-admin/l3-restore.mts --file <user-backup-….md> [--allow-empty] [--confirm <同名>] [--profile <dir>] [--apply]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listUserBackups, restoreFromBackup, userBackupsDirPath } from "../../memory/l3/user-file.ts";
import { acquireRunLock, runLockBusyMessage } from "../../memory/pipeline/run-lock.ts";
import { fail, finish, flagValue, hasFlag, profileArg, run, usageError } from "./viewer-cli.mts";

const USAGE =
	"node --experimental-strip-types scripts/l1-admin/l3-restore.mts --list | " +
	"--file <user-backup-….md> [--allow-empty] [--confirm <同名>] [--profile <dir>] [--apply]";

run(() => {
	const profilePath = profileArg();
	if (!profilePath) usageError(USAGE);

	if (hasFlag("--list")) {
		const dir = userBackupsDirPath(profilePath);
		const files = listUserBackups(profilePath);
		finish({
			success: true,
			dir,
			count: files.length,
			backups: files.map((file) => {
				// size 用文件系统的大小；条目数按 `§` 分节粗算即可（展示用，不与解析口径争权威）。
				let size = 0;
				let entries: number | null = null;
				try {
					const raw = readFileSync(join(dir, file), "utf-8");
					size = Buffer.byteLength(raw, "utf-8");
					const parts = raw.split(/\r?\n§\r?\n/).map((s) => s.trim()).filter(Boolean);
					entries = parts.length;
				} catch {
					// 读不了就留 null：宁可少一个数字，不让整次列举失败
				}
				return { file, size, entries };
			}),
		});
	}

	const file = flagValue("--file");
	if (!file) usageError(USAGE);
	if (!existsSync(join(userBackupsDirPath(profilePath), file))) fail(`备份不存在：${file}`);

	// 实写前要求把文件名原样打一遍（防止误点/误粘贴）。
	if (hasFlag("--apply") && flagValue("--confirm") !== file) {
		fail(`还原会覆盖当前提议稿，需要显式确认：--confirm ${file}`);
	}

	const lock = hasFlag("--apply") ? acquireRunLock(profilePath, "l3") : undefined;
	if (lock && !lock.acquired) fail(runLockBusyMessage("l3", lock.owner));
	try {
		const out = restoreFromBackup(profilePath, file, { dryRun: !hasFlag("--apply"), allowEmpty: hasFlag("--allow-empty") });
		if (!out.ok) fail(out.error ?? "还原失败");
		finish({
			...out,
			success: true,
			note: out.dryRun ? "预演；加 --apply --confirm <同名> 才写盘" : `已还原到 ${out.file}（写前已把当前提议稿另存备份）`,
		});
	} finally {
		lock?.release();
	}
});
