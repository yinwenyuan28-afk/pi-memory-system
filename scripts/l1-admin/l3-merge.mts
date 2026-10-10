// l3-merge.mts —— 把 L3 提议稿（USER-temp.md）并入 live 画像（USER.md）
//
// 用户 2026-09-28 裁定"live 画像不被自动改写、并入由用户手工完成"。本脚本与查看器上的那个按钮
// 就是那条裁定里的"手工" —— 决定权仍在用户手里（他要按确认），只是把"手抄一遍"换成一次调用。
//
// 这是全仓库**唯一会写 live `USER.md` 的代码路径**（`memory/l3/user-file.ts` 的 `writeUserFile`），
// 所以纪律最严：
//   · 写前把 live 现况留档（`user-backup-<ts>-live-premerge.md`），并入因此可回退；
//   · 默认只追加新条目，保留 live 现有内容；完整替换必须显式使用 --replace。
//   · 完整替换的三条安全闸默认全开，每条都要**单独**放行（见 `mergeTempIntoLive` 的注释）：
//       ① 提议稿比 live 旧 ⇒ `--allow-stale`（实测有真实档案就是这么被差点删掉 21 条的）
//       ② 会删掉 live 过半条目 ⇒ `--allow-mass-removal`
//       ③ live 有条目而提议稿为空 ⇒ `--allow-empty`
//   · 实写追加要 `--confirm MERGE`；完整替换要 `--confirm REPLACE`（界面之外再验一次）。
// 预演（不带 --apply）永远全跑一遍：它把三闸的裁决与差异一起报出来，供人决定要不要放行。
//
// ⚠️ 并入后**运行中的 pi 会话仍注入旧画像**：注入用的是 `core/store` 里 `loadFromDisk` 时构建的
// 冻结快照，只有 `refreshSnapshot`（进程内）才会重建。从 CLI/查看器写盘属于进程外改动，
// 因此要等**下一次会话或 `/reload`**。别把"页面刷新过了"当成"注入已经变了"。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/l3-merge.mts [--profile <dir>]                    # 预演追加差异
//   node --experimental-strip-types scripts/l1-admin/l3-merge.mts --replace [--profile <dir>]            # 预演完整替换差异
//   node --experimental-strip-types scripts/l1-admin/l3-merge.mts --apply --confirm MERGE [--profile <dir>]
//   node --experimental-strip-types scripts/l1-admin/l3-merge.mts --replace --apply --confirm REPLACE [--profile <dir>] [--allow-stale] [--allow-mass-removal] [--allow-empty]
import { mergeTempIntoLive } from "../../memory/l3/user-file.ts";
import { acquireRunLock, runLockBusyMessage } from "../../memory/pipeline/run-lock.ts";
import { fail, finish, flagValue, hasFlag, profileArg, run, usageError } from "./viewer-cli.mts";

const USAGE =
	"node --experimental-strip-types scripts/l1-admin/l3-merge.mts [--replace] " +
	"[--apply --confirm MERGE|REPLACE] [--allow-stale] [--allow-mass-removal] [--allow-empty] [--profile <dir>]";

run(() => {
	const profilePath = profileArg();
	if (!profilePath) usageError(USAGE);

	const apply = hasFlag("--apply");
	const strategy = hasFlag("--replace") ? "replace" : "add";
	const confirmToken = strategy === "replace" ? "REPLACE" : "MERGE";
	if (apply && flagValue("--confirm") !== confirmToken) {
		fail(`需要显式确认：--apply --confirm ${confirmToken}`);
	}

	// 实写才取锁：预演不写盘，取锁只会让"看一眼差异"这个动作被在跑的子代理卡住。
	const lock = apply ? acquireRunLock(profilePath, "l3") : undefined;
	if (lock && !lock.acquired) fail(runLockBusyMessage("l3", lock.owner));
	try {
		const out = mergeTempIntoLive(profilePath, {
			dryRun: !apply,
			strategy,
			allowEmpty: hasFlag("--allow-empty"),
			allowStale: hasFlag("--allow-stale"),
			allowMassRemoval: hasFlag("--allow-mass-removal"),
		});
		if (!out.ok) fail(out.error ?? "并入失败");
		finish({
			...out,
			success: true,
			note: out.dryRun
				? `预演：上面是${strategy === "replace" ? "完整替换" : "追加新条目"}后的差异；加 --apply --confirm ${confirmToken} 才真正写入 live USER.md`
				: `已写入 live USER.md（写前备份 ${out.backupFile ?? "无（live 原本不存在）"}）。` +
					"运行中的会话要 /reload 或新开会话才会注入新画像。",
		});
	} finally {
		lock?.release();
	}
});
