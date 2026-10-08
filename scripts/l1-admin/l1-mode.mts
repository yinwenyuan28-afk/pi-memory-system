// l1-mode.mts —— L1 提取模式（code / chat）的读写入口（查看器写盘桥 + 人工运维）
//
// 包装 `memory/l1/config.ts` 的 `loadL1Config` / `saveL1Mode`。为什么不让桥自己改配置：
// 配置是 **JSONC**（浏览器 parse 不了）且 `saveAppSection` 是**整节替换**（`appProps.l1 = value`，
// 不做深合并）—— 外部编辑器很容易把同节的 `valueCheck` 一起冲掉。`saveL1Mode` 内部已经做了
// "先读旧节再合并 mode"的处理（见其注释），所以这条路必须走它。
//
// 本脚本是这批 CLI 里**唯一不要求 `--apply`** 的写操作，理由与 `task-state` 不默认备份同款：
// 动作可逆（改回去即可）、幂等、不改正文，而且是界面上的开关 —— 要求再多一道 flag 只是让
// 按钮的实现变复杂，不增加任何安全。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/l1-mode.mts [--profile <dir>]              # 读当前模式
//   node --experimental-strip-types scripts/l1-admin/l1-mode.mts --set chat|code [--profile <dir>]  # 写
import { loadL1Config, saveL1Mode, type L1Mode } from "../../memory/l1/config.ts";
import { fail, finish, flagValue, profileArg, run, usageError } from "./viewer-cli.mts";

const USAGE = "node --experimental-strip-types scripts/l1-admin/l1-mode.mts [--set chat|code] [--profile <dir>]";

run(() => {
	const profilePath = profileArg();
	if (!profilePath) usageError(USAGE);

	const setRaw = flagValue("--set");
	if (setRaw === undefined) {
		finish({ success: true, mode: loadL1Config(profilePath).mode });
	}
	if (setRaw !== "chat" && setRaw !== "code") {
		fail(`mode 只能是 chat / code，收到 ${JSON.stringify(setRaw)}`);
	}

	const before = loadL1Config(profilePath).mode;
	saveL1Mode(profilePath, setRaw as L1Mode);
	// 写完回读：`saveAppSection` 的整节替换语义下，"以为写了其实被别的字段覆盖"是真实风险，
	// 所以判成功以回读为准，而不是以"函数没抛异常"为准。
	const after = loadL1Config(profilePath).mode;
	if (after !== setRaw) {
		fail(`已调用 saveL1Mode 但回读仍是 ${after}（期望 ${setRaw}）—— 配置节可能被并发写入覆盖`);
	}
	finish({ success: true, mode: after, before, changed: before !== after, note: "已写入 application-propertis.json 的 l1.mode" });
});
