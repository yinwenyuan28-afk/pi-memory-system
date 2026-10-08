// active-days.mts —— 活跃会话日清单（供写盘桥的 /api/l1/active-days 调用）
//
// 为什么需要这个入口（2026-10-08 实测发现）：
// 查看器的质量分用"活跃会话日"时钟算衰减，而它原先只从 `l1/hit-stats.json` 侧车拿 `activeDays`。
// 侧车**只在命中统计库被打开/写入时才刷新**（无召回发生就不会重写），所以它可以比真实情况旧好几天。
// 实测差异：侧车 29 个活跃日，实际 30 个 —— 公式两边一致（parity 门禁全绿），但 `days` 差 1，
// 于是 3 条记录从「冷」错标成「待观察」，且整个质量分直方图整体偏了一格。**静默偏移正是本次要根治的失效模式。**
//
// 所以权威来源是 `l0/conversations/` 目录本身（`loadActiveDayKeys` 的读取口径），由本入口透出，
// 页面优先用它、侧车只作离线回退。规则不在这里重写 —— 只 import。
//
// 输出：{ activeDays: ["YYYY-MM-DD", …], count, firstDay, lastDay, source }
// 用法：node --experimental-strip-types scripts/l1-admin/active-days.mts [--profile <dir>]
import { argv, stdout } from "node:process";
import { loadActiveDayKeys } from "../../memory/l1/active-days.ts";

/** 取 `--flag value` 形式的值。 */
function flagValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}

const PROFILE = flagValue("--profile") ?? "C:/Users/leaf/.pi/agent/profiles/default";
const keys = loadActiveDayKeys(PROFILE);

// 一律用 process.exitCode 而非 exit()：stdout 是管道时写入异步，立刻 exit 会截断 JSON。
stdout.write(
	`${JSON.stringify(
		{
			// undefined（l0/conversations 不存在或读不了）→ 空数组 + source="none"，
			// 页面据此显式退化为日历天（而不是悄悄按"0 个活跃日"算出偏高的质量分）
			activeDays: keys ?? [],
			count: keys?.length ?? 0,
			firstDay: keys && keys.length > 0 ? keys[0] : null,
			lastDay: keys && keys.length > 0 ? keys[keys.length - 1] : null,
			source: "l0/conversations",
			available: Array.isArray(keys),
		},
		null,
		2,
	)}\n`,
);
process.exitCode = 0;
