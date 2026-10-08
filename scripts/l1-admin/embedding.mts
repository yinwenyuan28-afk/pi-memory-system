// embedding.mts —— L1 向量库的状态 / 回填 / 重建（查看器写盘桥与人工运维共用）
//
// 包装 `memory/search/embedding/backfill.ts` 的三个导出（逻辑一行不复制，与 `task-state.mts` 同款）。
//
// 三条要知道的事：
//   · **status 是只读且便宜**（读记录 + 向量库 id 集合，无网络）；页面可以随便刷。
//   · **backfill / rebuild 是长任务且吃网络**：每批 10 条一次 embedding 请求，耗时随未向量化条数线性增长。
//     桥是单线程 + `execFileSync` 同步，所以这两个动作期间**整座桥都不可用** —— 界面必须显示
//     "运行中、别重复点"，而不是若无其事地转圈。
//   · **rebuild 会先清空向量库**（`clearAll` 后再全量重算）：中途失败 = 库空。
//     所以它要求 `--apply` **和** `--confirm REBUILD` 两道，CLI 与桥各验一次。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/embedding.mts status   [--profile <dir>]
//   node --experimental-strip-types scripts/l1-admin/embedding.mts backfill [--profile <dir>] [--apply]
//   node --experimental-strip-types scripts/l1-admin/embedding.mts rebuild  [--profile <dir>] [--apply] [--confirm REBUILD]
//
// 进度写 stderr（`# ` 前缀，无花括号）：stdout 只留最后那一个 JSON —— 桥按"从第一个 `{` 起解析"
// 兜日志噪声，中途多打一个对象会让它解析到错的东西。
import { getVectorizationStatus, backfillMissingVectors, rebuildAllVectors } from "../../memory/search/embedding/backfill.ts";
import { APPLY, fail, finish, flagValue, positionals, profileArg, progress, run, usageError } from "./viewer-cli.mts";

const USAGE =
	"node --experimental-strip-types scripts/l1-admin/embedding.mts status|backfill|rebuild " +
	"[--profile <dir>] [--apply] [--confirm REBUILD]";

/** 统一的收尾：把耗时一起报出去（长任务的时间也是使用者需要的信息）。 */
function report(op: string, extra: Record<string, unknown>, startedAt: number): void {
	finish({ success: true, op, elapsedMs: Date.now() - startedAt, ...extra });
}

run(async () => {
	const profilePath = profileArg();
	const op = positionals(["--profile", "--confirm"])[0] ?? "status";
	if (!profilePath) usageError(USAGE);
	const startedAt = Date.now();

	if (op === "status") {
		const st = await getVectorizationStatus(profilePath);
		report(op, { status: st }, startedAt);
	}

	if (op !== "backfill" && op !== "rebuild") usageError(USAGE);

	if (op === "rebuild" && flagValue("--confirm") !== "REBUILD") {
		fail('rebuild 会先清空向量库再全量重算，需要显式确认：--confirm REBUILD（并与 --apply 同时给出）');
	}
	if (!APPLY) {
		// 干跑也要有信息量：先报出"现在缺多少条"，否则"加 --apply 才写盘"等于什么都没说。
		const st = await getVectorizationStatus(profilePath);
		finish({
			success: true,
			op,
			dryRun: true,
			status: st,
			note:
				op === "rebuild"
					? "加 --apply --confirm REBUILD 才执行（会清空向量库后全量重算，耗时与条数成正比）"
					: "加 --apply 才执行（只补缺失向量，不动已有向量）",
		});
	}

	// 进度回调：只打无花括号的行，桥的 JSON 解析不会被它带偏。
	const onProgress = (p: unknown): void => {
		try {
			progress(`${op} … ${JSON.stringify(p).replace(/[{}"]/g, "").slice(0, 160)}`);
		} catch {
			progress(`${op} …`);
		}
	};

	if (op === "backfill") {
		const res = await backfillMissingVectors(profilePath, onProgress);
		report(op, { result: res }, startedAt);
	} else {
		const res = await rebuildAllVectors(profilePath, onProgress);
		report(op, { result: res }, startedAt);
	}
});
