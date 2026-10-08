// l3-edit.mts —— L3 画像条目增删改的命令行入口（查看器写盘桥与人工运维共用）
//
// 包装 `memory/l3/edit-core.ts` 的 `applyL3Edit` —— 那正是 `l3_edit` 工具调用的同一段编排
// （预算闸、定位裁决、备份时机、"一次只动一条"的强制）。逻辑一行不复制。
//
// 落盘目标是 **`USER-temp.md`（提议稿）**，不是 live `USER.md`（用户 2026-09-28 裁定）。
// 要让改动生效于注入，得再走一次并入：`l3-merge.mts`。这条链路在界面上必须讲清楚。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/l3-edit.mts add    --content "一条规则" [--profile <dir>] [--apply]
//   node --experimental-strip-types scripts/l1-admin/l3-edit.mts update --target "定位片段" --content "新的一条" [--apply]
//   node --experimental-strip-types scripts/l1-admin/l3-edit.mts delete --target "定位片段" [--apply]
//
// 默认 **dry-run**：走同一段编排（含取锁与预算裁决）但 `dryRun:true` —— 不写备份、不切本轮口径。
import { applyL3Edit, type L3EditParams } from "../../memory/l3/edit-core.ts";
import { APPLY, fail, finish, flagValue, positionals, profileArg, run, usageError } from "./viewer-cli.mts";

const USAGE =
	'node --experimental-strip-types scripts/l1-admin/l3-edit.mts add|update|delete ' +
	'[--content "一条规则"] [--target "定位片段"] [--profile <dir>] [--apply]';

run(() => {
	const profilePath = profileArg();
	const action = positionals(["--profile", "--content", "--target"])[0];
	if (!profilePath || !action) usageError(USAGE);
	if (action !== "add" && action !== "update" && action !== "delete") usageError(USAGE);

	const params: L3EditParams = {
		action,
		content: flagValue("--content"),
		target: flagValue("--target"),
	};

	const out = applyL3Edit(profilePath, params, { dryRun: !APPLY });
	if (out.success === false) fail(out.error ?? "改写作被拒");
	finish({
		...out,
		success: true,
		note: APPLY
			? `已写入 ${out.targetFile}（提议稿）。要让它进入注入画像，还需并入 live USER.md。`
			: `预演通过；加 --apply 才写入 ${out.targetFile}（写前会留档一份备份）。`,
	});
});
