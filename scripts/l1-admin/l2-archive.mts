// l2-archive.mts —— L2 场景块归档 / 恢复的命令行入口（查看器写盘桥与人工运维共用）
//
// 包装 `memory/l2/archive.ts`（`archiveSceneBlock` / `restoreSceneBlock` / `reconcileArchive` /
// `listArchivedBlocks`）+ `syncSceneIndex`。之所以必须有这个包装：归档要按固定**顺序**走
// "自愈 → 搬块 → 重建索引"，而且全程持 **L2 run-lock** —— 顺序或锁在桥里重写一遍就是口径分叉。
// 顺序与 `/my-memory:l2:archive` / `:restore` 命令逐行对齐（index.ts:1413 / :1454）。
//
// 两道硬拦不绕过（与命令同款，人工路径只是能搬子代理搬不动的块）：
//   · 归档必须有 `--reason`（它是归档唯一的审计凭据）；
//   · 恢复要过 maxScenes 上限（满库时须先腾位）。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/l2-archive.mts list [--profile <dir>]
//   node --experimental-strip-types scripts/l1-admin/l2-archive.mts archive --file <名.md> --reason "为什么搬" [--apply]
//   node --experimental-strip-types scripts/l1-admin/l2-archive.mts restore --file <名.md> [--reason "…"] [--apply]
//
// dry-run 的边界：archive/restore 的预演**不做自愈**（`reconcileArchive` 会写盘），
// 只校验文件存在性、reason、上限这些能只读判定的前置条件。实写时自愈照常执行。
import { archiveSceneBlock, listArchivedBlocks, reconcileArchive, restoreSceneBlock } from "../../memory/l2/archive.ts";
import { countSceneBlocks, loadL2Config } from "../../memory/l2/config.ts";
import { syncSceneIndex } from "../../memory/l2/commit-tool.ts";import { acquireRunLock, runLockBusyMessage } from "../../memory/pipeline/run-lock.ts";
import { logEvent } from "../../util/notice.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DB_DIR, L2_ARCHIVE_DIR, L2_SCENE_DIR } from "../../memory/paths.ts";
import { APPLY, fail, finish, flagValue, positionals, profileArg, run, usageError } from "./viewer-cli.mts";

const USAGE =
	"node --experimental-strip-types scripts/l1-admin/l2-archive.mts list | archive --file <名.md> --reason \"…\" | " +
	"restore --file <名.md> [--reason \"…\"] [--profile <dir>] [--apply]";

/** 人工路径一律以 `viewer`/`cli` 的身份记账（与子代理的 by 区分开，事后能看出是谁搬的）。 */
const BY = "viewer";

run(() => {
	const profilePath = profileArg();
	const op = positionals(["--profile", "--file", "--reason"])[0];
	if (!profilePath || !op) usageError(USAGE);

	const dbRel = (rel: string) => join(profilePath, MEMORY_DB_DIR, rel);

	if (op === "list") {
		const blocks = listArchivedBlocks(profilePath).map((b) => {
			const last = [...b.events].reverse().find((e) => e.op === "archive" || e.op === "ledger-missing");
			return {
				file: b.filename,
				members: b.members.length,
				at: last?.at ?? null,
				reason: last?.reason ?? null,
				op: last?.op ?? null,
			};
		});
		finish({
			success: true,
			count: blocks.length,
			live: countSceneBlocks(profilePath),
			maxScenes: loadL2Config(profilePath).maxScenes,
			blocks,
		});
	}
	if (op !== "archive" && op !== "restore") usageError(USAGE);

	const filename = flagValue("--file");
	const reason = flagValue("--reason");
	if (!filename) usageError(USAGE);
	if (op === "archive" && !reason) fail("归档必须给 --reason（这是归档唯一的审计凭据）");

	// 预演：只做能只读判定的前置检查（不跑自愈、不取锁、不写盘）。
	if (!APPLY) {
		const liveHas = existsSync(join(dbRel(L2_SCENE_DIR), filename));
		const archHas = existsSync(join(dbRel(L2_ARCHIVE_DIR), filename));
		const count = countSceneBlocks(profilePath);
		const limit = loadL2Config(profilePath).maxScenes;
		if (op === "archive" && !liveHas) fail(`场景目录里没有这个块：${filename}（现有 live ${count} 个）`);
		if (op === "archive" && archHas) fail(`归档层里已经有同名块：${filename}（先恢复或改名，别覆盖账目）`);
		if (op === "restore" && !archHas) fail(`归档层里没有这个块：${filename}`);
		if (op === "restore" && count + 1 > limit) fail(`场景目录已满（${count}/${limit}）：先归档或合并腾位，再恢复`);
		finish({
			success: true,
			op,
			dryRun: true,
			filename,
			live: count,
			maxScenes: limit,
			note: "前置条件通过（预演不跑自愈）；加 --apply 才写盘，实写会先 reconcileArchive 再搬块并重建索引",
		});
	}

	runMove(profilePath, op, filename, reason);
});

/** 实写路径：取 L2 运行级锁 → 自愈 → 搬块 → 重建索引（顺序与 `/my-memory:l2:archive` 命令一致）。 */
function runMove(profilePath: string, op: "archive" | "restore", filename: string, reason?: string): void {
	const lock = acquireRunLock(profilePath, "l2");
	if (!lock.acquired) fail(runLockBusyMessage("l2", lock.owner));
	try {
		reconcileArchive(profilePath, new Date().toISOString());
		if (op === "archive") {
			const out = archiveSceneBlock(profilePath, { filename, reason: reason as string, by: BY });
			if (!out.ok) fail(out.error ?? "归档失败");
			syncSceneIndex(profilePath);
			logEvent("l2", `查看器归档 ${filename}（${out.members.length} 个成员）：${reason}`, profilePath);
			finish({
				success: true,
				op: "archive",
				filename,
				members: out.members.length,
				live: countSceneBlocks(profilePath),
				note: `已搬进归档层（${out.members.length} 个成员随之保留）。搬回来：restore --file ${filename} --apply`,
			});
		}
		// 恢复会往 live 目录加回一个块 ⇒ 受同一个上限约束（满库时须先腾位，否则拒绝）。
		const count = countSceneBlocks(profilePath);
		const limit = loadL2Config(profilePath).maxScenes;
		if (count + 1 > limit) fail(`场景目录已满（${count}/${limit}）：先把别的块归档或合并，腾出位置再恢复`);
		const out = restoreSceneBlock(profilePath, { filename, by: BY, reason: reason ?? "人工恢复（查看器）" });
		if (!out.ok) fail(out.error ?? "恢复失败");
		syncSceneIndex(profilePath);
		logEvent("l2", `查看器恢复 ${filename}（${out.members.length} 个成员）`, profilePath);
		finish({ success: true, op: "restore", filename, members: out.members.length, live: countSceneBlocks(profilePath) });
	} finally {
		lock.release();
	}
}
