// l1-fix.mts —— L1 纠错（重写正文 / 墓碑）的命令行入口（查看器写盘桥与人工运维共用）
//
// 包装 `memory/l1/fix-tool.ts`：四道闸（证据门槛、LWW 存活、24h 防抖、高价值保护）与
// 审计标注的实现**一行不复制** —— 与 `task-state.mts` 同款做法，避免桥成为第三处口径。
//
// 为什么这里能真干跑：`runFix` 内部恒定向 rewrite/tombstone 传 `--apply`（那两个脚本默认 dry-run），
// 本身没有预演路径。所以闸门被抽成了 `checkFixGates`（纯裁决、不写盘），dry-run 走它。
// 注意 dry-run **不做全部校验**：正文长度、证据、存活、防抖、高价值都在里面，
// 但"分片是否写得进"这类 IO 级问题只有实写时才知道 —— 别把 dry-run 当保证。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/l1-fix.mts <l1_id> --action rewrite|tombstone \
//     [--content "新正文"] --evidence "grep/file:line/命令输出" [--reason "…"] [--priority 0-100] \
//     [--force] [--profile <dir>] [--apply]
// 默认 **dry-run**（只报四道闸的裁决）；`--apply` 才写盘（脚本内部自动备份 + 逐行校验）。
import { checkFixGates, runFix, type FixParams } from "../../memory/l1/fix-tool.ts";
import { APPLY, fail, finish, flagValue, hasFlag, positionals, profileArg, run, usageError } from "./viewer-cli.mts";

const USAGE =
	"node --experimental-strip-types scripts/l1-admin/l1-fix.mts <l1_id> --action rewrite|tombstone " +
	'[--content "新正文"] --evidence "证据" [--reason "…"] [--priority 0-100] [--force] [--profile <dir>] [--apply]';

// 主体包在 run() 里：收尾函数靠抛哨兵中止执行（见 viewer-cli.mts 的 ExitSignal 说明）。
run(async () => {
	const profilePath = profileArg();
	const action = flagValue("--action");
	const id = positionals(["--profile", "--action", "--content", "--evidence", "--reason", "--priority"])[0];
	if (!profilePath || !id || !action) usageError(USAGE);

	const priorityRaw = flagValue("--priority");
	const params: FixParams = {
		recordId: id,
		action: action as FixParams["action"],
		newContent: flagValue("--content") ?? null,
		evidence: flagValue("--evidence") ?? null,
		reason: flagValue("--reason") ?? null,
		priority: priorityRaw !== undefined && priorityRaw !== "" ? Number(priorityRaw) : null,
	};
	const force = hasFlag("--force");

	const gate = checkFixGates(profilePath, params, { force });
	if (!gate.ok) fail(gate.error);
	if (!APPLY) {
		finish({
			success: true,
			dryRun: true,
			id,
			action,
			force,
			note: "四道闸通过（dry-run 不含 IO 级校验）；加 --apply 才写盘，实写前会自动备份并逐行校验",
		});
	}
	// runFix 返回 JSON 文本；解析不出（异常路径）就把它当错误信息透传，别把成功错报成失败。
	const text = await runFix(params, profilePath, { force });
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = { success: false, error: String(text).slice(0, 500) };
	}
	finish({ dryRun: false, id, action, ...(parsed as Record<string, unknown>) });
});
