// viewer-cli.mts —— 查看器写盘桥那批 CLI 包装的**共用骨架**
//
// 为什么共用：这一批（l1-fix / embedding / trigger / l1-mode / subagent-stop / l2-archive /
// l3-edit / l3-restore / l3-merge）的骨架完全一样 —— 取 `--flag value`、把结果写成 JSON、
// 用 `process.exitCode` 收尾、默认 dry-run 且 `--apply` 才落盘。九个文件各抄一份的话，
// "有的用 exit() 有的用 exitCode"这种分叉必然重演（tombstone 时代已经漂过一次，
// 见 `task-state.mts` 文件头对 stdout 截断的实测记录）。
//
// 约定（所有包装都遵守）：
//   · **stdout 只出 JSON**，且 `{` 只出现在最后那一个对象里 —— 桥那边是
//     `parseCliJson`（从第一个 `{` 起解析）来兜 `autoBackup` 之类的日志噪声，中途多打一个
//     带花括号的行就会让桥解析到错的对象。进度一律用无花括号的 `# ` 前缀行，或走 stderr。
//   · **默认 dry-run**：不带 `--apply` 只做校验与预演，一个字节都不写。
//   · 破坏性动作在 CLI 这一层**也**要 `--confirm <字面量>`（桥里那道是副验，不是唯一一道）。
import { argv, stderr, stdout } from "node:process";

/**
 * 真正的命令行参数 —— **必须切掉前两位**（`process.argv` 是 `[execPath, scriptPath, ...args]`）。
 *
 * 这一刀不能省：`task-state.mts` 那种手写循环靠"只认 `l1_` 前缀的 token"顺带躲过了它，
 * 而本模块的 `positionals()` 语义是"除 flag 之外都算位置参数" —— 不切就会把 `node.exe` 的路径
 * 和脚本自身路径当成第一个位置参数（实测踩到：`embedding.mts status` 的 op 变成了 `C:\…\node.exe`，
 * `l2-archive.mts list` 直接报用法错误）。
 */
export const ARGS = argv.slice(2);

/** 是否实写。 */
export const APPLY = ARGS.includes("--apply");

/** 取 `--flag value` 形式的值。 */
export function flagValue(flag: string): string | undefined {
	const i = ARGS.indexOf(flag);
	return i >= 0 ? ARGS[i + 1] : undefined;
}

/** 布尔 flag 是否存在（`--force` / `--allow-empty` 这类）。 */
export function hasFlag(flag: string): boolean {
	return ARGS.includes(flag);
}

/** 位置参数（已排除所有 flag 及其取值）。`flagsWithValue` 必须列全本脚本用到的取值 flag。 */
export function positionals(flagsWithValue: readonly string[]): string[] {
	const skip = new Set(flagsWithValue);
	const out: string[] = [];
	for (let i = 0; i < ARGS.length; i++) {
		const a = ARGS[i];
		if (skip.has(a)) {
			i++;
			continue;
		}
		if (a.startsWith("--")) continue;
		out.push(a);
	}
	return out;
}

/** profile 路径：`--profile` → 环境变量 → 空串（空串由各脚本判成用法错误）。 */
export function profileArg(): string {
	return flagValue("--profile") ?? process.env.PI_PROFILE_PATH ?? "";
}

/** 输出 JSON（唯一出口；见文件头 stdout 约定）。 */
export function writeJson(obj: unknown): void {
	stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

/** 无花括号的进度行（桥能安全忽略；只给人看）。 */
export function progress(line: string): void {
	stderr.write(`# ${line}\n`);
}

/**
 * 收尾用的哨兵异常。
 *
 * **为什么非得抛异常**（2026-10-08 实测踩到）：收尾函数若只"写 JSON + 设 exitCode"就返回，
 * 调用点的守卫写完错误后会**继续往下执行**，于是脚本再写第二个 JSON —— 两个对象首尾相连，
 * 桥那边 `JSON.parse` 整段失败 → 一次说得清清楚楚的拒绝被报成"CLI 未返回可解析的 JSON"。
 * 实测中招的两处：`trigger.mts --layer l9`（写完用法错误还去写了一个 `pending-trigger-l9.json`）
 * 与 `l2-archive.mts archive` 缺 reason。
 */
class ExitSignal extends Error {
	constructor() {
		super("viewer-cli: exit");
	}
}

/** 收尾异常的统一处理：已写好 JSON 的直接吞掉，其它异常兜成结构化错误。 */
function onExit(e: unknown): void {
	if (e instanceof ExitSignal) return;
	writeJson({ success: false, error: `脚本异常：${e instanceof Error ? e.message : String(e)}` });
	process.exitCode = 1;
}

/**
 * 脚本主体入口：**每个包装的顶层代码都要放进它**，否则上面的哨兵异常会变成
 * "Uncaught ExitSignal" 堆栈（JSON 已写出去了，但退出码与噪声都不对）。
 */
export function run(main: () => void | Promise<void>): void {
	try {
		const r = main();
		if (r && typeof (r as Promise<void>).then === "function") {
			(r as Promise<void>).catch(onExit);
		}
	} catch (e) {
		onExit(e);
	}
}

/**
 * 成功收尾：写 JSON + 退出码，然后**中止执行**（抛哨兵）。
 * `success:false` 时默认退出码 1（桥据此判 500），用法错误传 2。
 */
export function finish(obj: Record<string, unknown> & { success?: boolean }, failCode = 1): never {
	writeJson(obj);
	process.exitCode = obj.success === false ? failCode : 0;
	throw new ExitSignal();
}

/** 失败收尾（统一形状：{success:false, error}），写完即中止执行。 */
export function fail(error: string, code = 1): never {
	writeJson({ success: false, error });
	process.exitCode = code;
	throw new ExitSignal();
}

/** 用法错误收尾（退出码 2，与 task-state.mts 一致），写完即中止执行。 */
export function usageError(usage: string): never {
	writeJson({ success: false, error: `用法：${usage}` });
	process.exitCode = 2;
	throw new ExitSignal();
}
