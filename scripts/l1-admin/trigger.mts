// trigger.mts —— 各层「手动触发」的进程外入口（查看器写盘桥 + 人工运维）
//
// 为什么不能直接干跑（本文件存在的全部理由）：`triggerManual` 依赖主进程的 `cachedCtx` +
// executors + `kick()`（`memory/pipeline/worker.ts` 的 `drain` 在 `!cachedCtx` 时直接 return），
// 那是**另一个进程**里的闭包，跨进程够不着。全仓库原本只有 L3 有一条落盘通道
// （`memory/l3/signal.ts` 的 `l3/pending-trigger.json`）；本脚本把 L1/L2 也接到同一手法上，
// 写一份信号文件，主进程在 `agent_settled` 读后即删并据此入队。
//
// 因此**触发 = 请求入队，不是立即执行**：
//   · 需要一个活着的 pi 会话（子代理要靠 ctx 才能 spawn）；pi 关着时信号就躺在盘上等；
//   · 真正跑起来还要过队列的单飞闸与去重（同一层已在跑/已排队时不会重复入队）。
// 界面必须把这句原话写上，不能让"点了按钮没反应"变成新的静默失效。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/trigger.mts --layer l1|l2|l3 [--reason "…"] [--by viewer] [--profile <dir>]
//   node --experimental-strip-types scripts/l1-admin/trigger.mts --status            # 只读探查三个层待消费的信号
import { writePendingTrigger as writeL3Signal, peekPendingTrigger as peekL3Signal } from "../../memory/l3/signal.ts";
import {
	isTriggerLayer,
	peekPendingTrigger,
	pendingTriggerPath,
	writePendingTrigger,
} from "../../memory/pipeline/pending-trigger.ts";
import { fail, finish, flagValue, hasFlag, profileArg, run, usageError } from "./viewer-cli.mts";

const USAGE =
	'node --experimental-strip-types scripts/l1-admin/trigger.mts --layer l1|l2|l3 [--reason "…"] [--by viewer] ' +
	"[--profile <dir>] ｜ --status";

/** 三个层的信号状态（统一形状；L3 的载荷不同，这里翻译成同一套字段）。 */
function statusAll(profile: string): Record<string, unknown> {
	const l1 = peekPendingTrigger(profile, "l1");
	const l2 = peekPendingTrigger(profile, "l2");
	const l3 = peekL3Signal(profile);
	return {
		l1: l1 ? { at: l1.at, reason: l1.reason ?? null, by: l1.by ?? null } : null,
		l2: l2 ? { at: l2.at, reason: l2.reason ?? null, by: l2.by ?? null } : null,
		// L3 的信号是给 `evaluateTrigger` 的 P1 闸看的，personaSignal 单独透出（缺它就是个空信号）
		l3: l3 ? { at: l3.at, reason: l3.personaReason ?? null, personaSignal: l3.personaSignal } : null,
	};
}

run(() => {
	const profilePath = profileArg();
	if (!profilePath) usageError(USAGE);

	if (hasFlag("--status")) {
		finish({ success: true, pending: statusAll(profilePath) });
	}

	const layerRaw = flagValue("--layer");
	if (!isTriggerLayer(layerRaw)) usageError(USAGE);
	const layer = layerRaw;
	const reason = flagValue("--reason");
	const by = flagValue("--by") ?? "cli";

	if (layer === "l3") {
		// L3 的写入函数是静默的（返回 void，失败不留痕）—— 所以**写完自己回读一次**来确认，
		// 而不是假定成功。这次回读同时给界面提供"信号确实在盘上了"的证据。
		writeL3Signal(profilePath, { personaSignal: true, personaReason: reason });
	} else if (!writePendingTrigger(profilePath, layer, { reason, by })) {
		fail(`写触发信号失败（目录不可写？）：${pendingTriggerPath(profilePath, layer)}`);
	}

	const pending = statusAll(profilePath);
	const mine = pending[layer] as { at?: string } | null;
	if (!mine) {
		fail(`${layer} 的信号写完却回读不到 —— 写入未生效，请检查 ${profilePath} 下 memoryDB 目录权限`);
	}
	finish({
		success: true,
		layer,
		pending: mine,
		note:
			"已写入请求。它只负责入队：需要 pi 会话活着，并在下一轮结束（agent_settled）时由主进程消费；" +
			"若该层已在跑或已排队，队列去重会让这次请求不新增任务。",
	});
});
