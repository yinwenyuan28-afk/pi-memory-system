// viewer.mts —— 记忆库查看器的一键启动（同步最新页面 → 起写盘桥 → 开浏览器）
//
// 为什么要有它：直接跑 `viewer-bridge.mjs` 还差三件事 ——
//   ① 查看器源码改了但还没部署（要重启 pi 会话才会同步），不检查就会看到旧页面；
//   ② 5174 被占时桥直接退出，得自己找空闲端口；
//   ③ 还得手动复制终端里的地址去浏览器。
// 这三件事都是"每次都要做、忘了就出问题"的机械步骤，所以收进一个入口。
//
// 用法：
//   node --experimental-strip-types scripts/l1-admin/viewer.mts [--profile <dir>] [--port <n>] [--no-open] [--no-sync]
//                                                              [--lan] [--host <addr>]
//   （Windows 也可直接双击 scripts/l1-admin/启动查看器.cmd，参数照传：`启动查看器.cmd --lan`）
//
// `--lan` = 让桥**额外**监听本机局域网网卡（环回保留），好让别的设备打开同一个查看器调试；
// `--host <addr>` 指定确切地址。地址探测规则与桥共用 `lan-addresses.mjs`（一份规则、两个消费者）——
// 各写一份迟早出现"启动器打印 A 地址、桥实际听的是 B 地址"这种最难查的错配。
// 注意这个开关把写端点也放到了局域网上（无鉴权），安全代价写在 viewer-bridge.mjs 头部。
//
// profile 的解析**复用扩展自己的 ProfileManager**（读宿主 settings.json 的 memorySystem.activeProfile，
// 含旧版顶层键兼容）—— 不硬编码路径，也就不会出现"查看器看的是 A profile、扩展写的是 B profile"。
//
// 退出行为：Ctrl+C 会先把桥子进程停掉再退。Windows 上 Ctrl+C 其实会同时打到整个进程组，
// 但显式 kill 一次能确保不留孤儿进程占着端口（实测被占过一次，之后每次都要手动 taskkill）。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
import { ProfileManager } from "../../memory/core/profile.ts";
import { resolveAgentDir } from "../../util/agent-dir.ts";
import { deployViewers } from "../../memory/viewers/deploy.ts";
import { MEMORY_DB_DIR } from "../../memory/paths.ts";
import { lanAddresses } from "./lan-addresses.mjs";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(TOOL_DIR, "viewer-bridge.mjs");

/** 取 `--flag value` 形式的值。 */
function flagValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}

const explicitProfile = flagValue("--profile");
const explicitPort = flagValue("--port");
const noOpen = argv.includes("--no-open");
const noSync = argv.includes("--no-sync");
/** 局域网调试开关（原样透传给桥；地址探测也在这里做一次，只为把"别的设备该访问哪个地址"打印出来）。 */
const lanMode = argv.includes("--lan");
const explicitHost = flagValue("--host") ?? "";

/**
 * 解析目标 profile。
 *
 * 顺序：`--profile` → 环境变量 `PI_PROFILE_PATH` → 宿主 settings.json 里的激活 profile。
 * 最后一档走 `ProfileManager`，与扩展同一份实现（避免"查看器与扩展看不同 profile"这类无声错配）。
 */
function resolveProfile(): { path: string; source: string } {
	if (explicitProfile) return { path: explicitProfile, source: "--profile 参数" };
	const env = process.env.PI_PROFILE_PATH;
	if (env) return { path: env, source: "环境变量 PI_PROFILE_PATH" };
	try {
		const pm = new ProfileManager(resolveAgentDir());
		const active = pm.getActiveProfile();
		if (active?.path) return { path: active.path, source: `宿主 settings.json 的激活 profile「${pm.getActiveProfileName()}」` };
	} catch {
		/* 读不到就退到默认档 */
	}
	return { path: join(resolveAgentDir(), "profiles", "default"), source: "默认档 default（读不到激活 profile）" };
}

/** 探测一个空闲端口：能 listen 成功即视为空闲，随即释放交给桥去听。 */
function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.once("listening", () => probe.close(() => resolve(true)));
		probe.listen(port, "127.0.0.1");
	});
}

/** 从 preferred 起往上找第一个空闲端口。 */
async function pickPort(preferred: number): Promise<number> {
	for (let p = preferred; p <= preferred + 20; p++) {
		if (await isPortFree(p)) return p;
	}
	throw new Error(`端口 ${preferred}~${preferred + 20} 全被占用，请用 --port 指定其它端口`);
}

/** 用系统默认浏览器打开 URL（不等待、不阻塞）。 */
function openBrowser(url: string): void {
	const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
	// Windows 的 start 是 cmd 内建命令；第一个空参数是窗口标题，必须留，否则带引号的 URL 会被当成标题
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		console.log(`（自动打开浏览器失败，请手动访问 ${url}）`);
	}
}

/** 轮询健康检查直到桥就绪。 */
async function waitHealthy(port: number, timeoutMs = 15000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
			if (r.ok) return true;
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const { path: profilePath, source: profileSource } = resolveProfile();

if (!existsSync(join(profilePath, MEMORY_DB_DIR))) {
	console.error(`[NG] profile 下没有 ${MEMORY_DB_DIR}/：${profilePath}`);
	console.error(`     来源：${profileSource}`);
	console.error("     该 profile 还没跑过记忆系统（或路径不对）。可用 --profile <dir> 指定。");
	process.exit(2);
}

console.log("记忆库查看器");
console.log(`  profile : ${profilePath}`);
console.log(`            （来源：${profileSource}）`);
console.log(`  桥脚本  : ${BRIDGE}`);
console.log("");

// ① 同步最新页面：部署是幂等的（内容没变就零写入），所以每次启动都跑一遍最省心
if (noSync) {
	console.log("① 跳过页面同步（--no-sync）");
} else {
	try {
		const r = deployViewers(profilePath);
		if (r.errors.length > 0) {
			console.log(`① 页面同步有 ${r.errors.length} 项失败（不影响查看已部署的版本）：`);
			for (const e of r.errors) console.log(`     · ${e}`);
		} else if (r.written.length > 0) {
			console.log(`① 已同步最新页面 ${r.version}（写入 ${r.written.length} 个文件，其余 ${r.skipped.length} 个未变）`);
		} else {
			console.log(`① 页面已是最新 ${r.version}（${r.skipped.length} 个文件内容一致，零写入）`);
		}
		if (r.retired.length > 0) console.log(`     已退役：${r.retired.join(", ")}（移入 backups/viewers-retired）`);
	} catch (e) {
		console.log(`① 页面同步异常（继续用已部署版本）：${e instanceof Error ? e.message : String(e)}`);
	}
}

// ② 选端口
let port: number;
try {
	port = await pickPort(Number(explicitPort) || 5174);
} catch (e) {
	console.error(`[NG] ${e instanceof Error ? e.message : String(e)}`);
	process.exit(2);
}
if (explicitPort && port !== Number(explicitPort)) {
	console.log(`② 端口 ${explicitPort} 被占用，改用 ${port}`);
} else {
	console.log(`② 端口 ${port}`);
}

// ③ 起桥（stdio 继承，桥自己的日志直接显示在这里）
console.log("③ 启动写盘桥…");
const bridgeArgs = [BRIDGE, "--port", String(port), "--profile", profilePath];
if (lanMode) bridgeArgs.push("--lan");
if (explicitHost) bridgeArgs.push("--host", explicitHost);
const child: ChildProcess = spawn(process.execPath, bridgeArgs, {
	stdio: "inherit",
});

let exiting = false;
function shutdown(): void {
	if (exiting) return;
	exiting = true;
	console.log("\n正在停止写盘桥…");
	try {
		if (child.exitCode === null && !child.killed) child.kill();
	} catch {
		/* 已退出 */
	}
	// 给子进程一点时间退干净：父进程先走会在 Windows 上留下占着端口的孤儿进程
	setTimeout(() => process.exit(0), 400).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// 桥自己退出（端口冲突、profile 有误等）时，父进程跟着退，不留空转窗口
child.on("exit", (code, signal) => {
	if (exiting) return;
	console.log(`\n写盘桥已退出（code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}）。`);
	process.exit(code ?? 0);
});

// ④ 等就绪 → 开浏览器
const url = `http://localhost:${port}/viewers/index.html?port=${port}`;
if (await waitHealthy(port)) {
	console.log("");
	console.log(`  ✔ 已就绪：${url}`);
	console.log("    写盘可用（改任务状态 / 删除都会真正落盘）；Ctrl+C 停止。");
	if (lanMode || explicitHost) {
		// 局域网地址由桥真正监听的那张网卡决定：`--host` 给了就用它，否则用与桥同一份规则选出的首选地址
		const host = explicitHost || (lanAddresses()[0] ?? "");
		if (host) {
			console.log("");
			console.log(`  ✔ 别的设备打开这个地址（同一局域网）：http://${host}:${port}/viewers/index.html?port=${port}`);
			console.log("    同一个查看器、同一份数据，页面的 /api 请求会跟着这个地址走。");
			console.log("    ⚠ 该地址上没有鉴权：同网段任何设备都能读全部记忆、也能调用写端点。用完即关。");
			console.log("      别的设备打不开时，先看 Windows 防火墙是否放行了 node 的入站（专用网络 / 该网段）。");
		} else {
			console.log("  [warn] --lan/--host 已给，但没探测到可用的局域网 IPv4 —— 别的设备访问不了，检查网卡。");
		}
	}
	if (noOpen) console.log("    （--no-open：未自动打开浏览器）");
	else {
		console.log("    正在打开浏览器…");
		openBrowser(url);
	}
} else {
	console.error("[NG] 桥启动后 15 秒内未响应健康检查。请查看上方的桥日志。");
	shutdown();
}
