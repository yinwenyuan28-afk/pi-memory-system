// viewer-limits.mts —— 查看器要展示的**阈值与配置**节（桥的 /api/limits）
//
// 为什么要有这个入口，而不是让页面自己写数字：
//   · 页面要显示"上限 2200 / 阈值 30 / 单条 500 / maxScenes 15"这类数字，若在前端硬编码，
//     改一处源码就得记得改前端 —— 又是一次"同一概念多份实现"（仓库里记过同样的教训）。
//   · 也不能让页面直接 fetch `config/application-propertis.json`：那是 JSONC（浏览器 parse 不了）
//     且含 `model.embedding.apiKey`（桥 CORS 全开地托管 memoryDB，等于把密钥交给任何本地页面）。
//   所以：**取值一律 import 源码常量/加载器**，响应按构造只含这几个数字，密钥没有机会出现。
//
// 输出：
//   { l2: { maxScenes, archive: {enabled, minAgeCalendarDays, maxPerBatch} },
//     l3: { interval, userCharLimit, memoryCharLimit, entryCharLimit } }
//
// 用法：node --experimental-strip-types scripts/l1-admin/viewer-limits.mts [--profile <dir>]
import { argv, stdout } from "node:process";
import { loadL2ArchiveConfig, loadL2Config } from "../../memory/l2/config.ts";
import { L3_ENTRY_CHAR_LIMIT, L3_INTERVAL, USER_CHAR_LIMIT } from "../../memory/l3/config.ts";
import { DEFAULT_MEMORY_CHAR_LIMIT } from "../../memory/core/types.ts";

/** 取 `--flag value` 形式的值。 */
function flagValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}

const PROFILE = flagValue("--profile") ?? "C:/Users/leaf/.pi/agent/profiles/default";

// 一律用 process.exitCode 而非 exit()：stdout 是管道时写入异步，立刻 exit 会截断 JSON。
stdout.write(
	`${JSON.stringify(
		{
			l2: { maxScenes: loadL2Config(PROFILE).maxScenes, archive: loadL2ArchiveConfig(PROFILE) },
			l3: {
				interval: L3_INTERVAL,
				userCharLimit: USER_CHAR_LIMIT,
				memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
				entryCharLimit: L3_ENTRY_CHAR_LIMIT,
			},
		},
		null,
		2,
	)}\n`,
);
process.exitCode = 0;
