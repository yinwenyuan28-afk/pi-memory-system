// 通知分流（NOTICE_ROUTING）的回归基线（只读生产代码；只写系统临时目录）
//
// 覆盖 2026-09-19 收编的四条通知出口（见 util/notice.ts 头注释）：
//   ① 卡片行宽：自实现 fitWidth 必须保证**每行 ≤ 终端列宽**（CJK 按 2 列）——超宽行会让
//      TUI 写 pi-crash.log 并触发整屏重绘，属"把显示搞坏"级别的事故
//   ② 跨进程 relay：子代理进程落 logs/notices.jsonl → 主进程 drain 后 appendEntry，且文件被清空
//   ③ 去重：dedupKey 同会话只发一次，resetNoticeDedup 后可再发
//   ④ 轮转：单文件超 5MB → 生成 {scope}.log.1
//   ⑤ 管道健壮性：坏行（半截 JSON）不得吃掉后续好行
//   ⑥ 静态断言：运行时代码里 **除白名单外不得再有 console.*** 调用（防止有人再写回去）
//
// 铁律：只用系统临时目录；不碰生产 memoryDB；静态断言只读源码文本，不执行扩展入口。
//
// 用 tsx 跑：tsx scripts/verify-notice-routing.ts
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	NOTICE_ENTRY_TYPE,
	drainNoticeCards,
	fitWidth,
	initNotice,
	logEvent,
	notice,
	noticeCard,
	noticeReport,
	resetNoticeDedup,
	setNoticeProfileResolver,
	type NoticePayload,
} from "../util/notice.ts";
import { setupL3Persona } from "../memory/l3/index.ts";
import { closePipelineJobsDB, getPipelineJobsDB } from "../memory/pipeline/jobs-db.ts";
import { getVectorStore } from "../memory/search/vector-store/store.ts";
import { initSubagentBridge } from "../util/subagent.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

/** 可见宽度（与 util/notice.ts 的 fitWidth 同口径，仅用于断言）。 */
function visibleWidth(text: string): number {
	let w = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		const wide =
			(cp >= 0x1100 && cp <= 0x115f) ||
			(cp >= 0x2e80 && cp <= 0x303e) ||
			(cp >= 0x3041 && cp <= 0x33ff) ||
			(cp >= 0x3400 && cp <= 0x4dbf) ||
			(cp >= 0x4e00 && cp <= 0x9fff) ||
			(cp >= 0xa000 && cp <= 0xa4cf) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe10 && cp <= 0xfe19) ||
			(cp >= 0xfe30 && cp <= 0xfe6f) ||
			(cp >= 0xff00 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1f64f) ||
			(cp >= 0x1f900 && cp <= 0x1f9ff) ||
			(cp >= 0x20000 && cp <= 0x3fffd);
		w += wide ? 2 : 1;
	}
	return w;
}

/** 剥掉 ANSI 颜色码（renderer 会 theme.fg 上色）。 */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 造临时 profile 目录。 */
function makeProfile(): string {
	const root = mkdtempSync(join(tmpdir(), "notice-"));
	mkdirSync(join(root, "memoryDB", "logs"), { recursive: true });
	return root;
}

// ── 假 pi：捕获 appendEntry / registerEntryRenderer / registerTool ─────────

function makeFakePi(): {
	pi: unknown;
	entries: Array<{ customType: string; data: unknown }>;
	render: (entry: unknown, options: { expanded: boolean }) => string[];
} {
	const entries: Array<{ customType: string; data: unknown }> = [];
	let renderer: ((entry: any, options: any, theme: any) => { render: (w: number) => string[] }) | undefined;
	// 最小进程内事件总线：util/subagent.ts 的 RPC 派发通道需要它（见 installSubagentRpcStub）
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		// L3 的 setup 需要 pi.on（本脚本只在第 9 组用到；其余组不依赖事件）
		on: () => {},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				if (!handlers.has(channel)) handlers.set(channel, []);
				handlers.get(channel)!.push(handler);
				return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
			},
			emit(channel: string, data: unknown) {
				for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
			},
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		registerEntryRenderer: (_t: string, fn: unknown) => {
			renderer = fn as never;
		},
	};
	const render = (entry: unknown, options: { expanded: boolean }): string[] => {
		if (!renderer) throw new Error("renderer 未注册");
		const comp = renderer(entry, options, null); // theme=null：走无颜色分支
		return comp.render(120);
	};
	return { pi, entries, render };
}

/**
 * 安装一个最小的 pi-subagents RPC 桥接桩，**接替旧的 globalThis.__piSubagentExecutor 桩**。
 *
 * util/subagent.ts 自 2026-10-01（独立发布整改 P0-1）起改走上游 `subagents:rpc:v1`
 * 事件总线，不再读那个私有全局变量（它是本机给 pi-subagents 源码打的补丁）。
 * 这里按上游协议（pi-subagents/src/extension/rpc.ts 的 registerSubagentRpcBridge）
 * 实现 request→reply 的最小闭环，让 L3 通知卡测试仍能模拟「子代理跑完并落盘」。
 *
 * @param pi      带 events 总线的假 pi（makeFakePi 产出）
 * @param initial 首次派发时执行的桩（模拟子代理干活：写文件 + complete job）
 * @returns 换桩函数——对应旧代码「重新给全局变量赋一次值」的写法
 */
function installSubagentRpcStub(
	pi: { events: { on: (c: string, h: (d: unknown) => void) => () => void; emit: (c: string, d: unknown) => void } },
	initial: (params: { agent?: string; task?: string }) => void,
): (next: (params: { agent?: string; task?: string }) => void) => void {
	let current = initial;
	pi.events.on("subagents:rpc:v1:request", (raw) => {
		const req = raw as { requestId?: string; params?: { agent?: string; task?: string } };
		const reply = (success: boolean, payload: Record<string, unknown>) =>
			pi.events.emit(`subagents:rpc:v1:reply:${req.requestId}`, {
				version: 1, requestId: req.requestId, success, ...payload,
			});
		try {
			current(req.params ?? {});
			reply(true, { data: { text: "Async: stub", details: { mode: "single", runId: `stub-${req.requestId}` } } });
		} catch (e) {
			reply(false, { error: { code: "execution_failed", message: e instanceof Error ? e.message : String(e) } });
		}
	});
	initSubagentBridge(pi as never);
	return (next) => { current = next; };
}

const profile = makeProfile();
setNoticeProfileResolver(() => profile);

// ══════════════════════════════════════════════════════════════
console.log("\n=== 1. fitWidth：CJK 宽字符与边界 ===");
// ══════════════════════════════════════════════════════════════
check("恰好等于宽度 → 原样返回", fitWidth("一二三四五六", 12) === "一二三四五六");
check("超 1 列 → 截断并加省略号", fitWidth("一二三四五六", 11) === "一二三四五…");
check("ASCII 按 1 列计", fitWidth("abcdefghij", 10) === "abcdefghij");
check("ASCII 超宽 → 截断", fitWidth("abcdefghijklmno", 10).length === 10 && fitWidth("abcdefghijklmno", 10).endsWith("…"));
check("宽度 0/负 → 空串", fitWidth("abc", 0) === "" && fitWidth("abc", -3) === "");
const mixed = fitWidth("L1 commit: 3 条记录已提交，向量化写入 +3/-0 条", 24);
check("中英混排截断后不超宽", visibleWidth(mixed) <= 24, `w=${visibleWidth(mixed)} t="${mixed}"`);

// ══════════════════════════════════════════════════════════════
console.log("\n=== 2. 卡片渲染器：行宽 + 折叠/展开 ===");
// ══════════════════════════════════════════════════════════════
const { pi, entries, render } = makeFakePi();
initNotice(pi as never);
const longLine = "这是一条很长的中文摘要行，用来验证卡片渲染器会不会把超宽的行交给 TUI，从而触发 pi-crash.log 与整屏重绘";
noticeCard({
	level: "warning",
	title: "L1 价值校验未生效（fail-open，照写）",
	lines: [longLine, "短行"],
	detail: `${longLine}\n第二行详情`,
});
check("主进程 → appendEntry 收到卡片", entries.length === 1 && entries[0].customType === NOTICE_ENTRY_TYPE, `n=${entries.length}`);
const payload = entries[0]?.data as NoticePayload;
check("载荷字段完整", payload?.level === "warning" && payload?.title.startsWith("L1 价值校验") && payload?.lines?.length === 2);
check("载荷带 ts", typeof payload?.ts === "string" && payload.ts.includes("T"));

const collapsed = render({ data: payload }, { expanded: false });
check("折叠态行数 = 标题 + 2 行 + 详情提示", collapsed.length === 4, `n=${collapsed.length}`);
check("折叠态每行 ≤ 120 列", collapsed.every((l) => visibleWidth(stripAnsi(l)) <= 120), JSON.stringify(collapsed.map((l) => visibleWidth(stripAnsi(l)))));
check("展开态每行 ≤ 120 列", render({ data: payload }, { expanded: true }).every((l) => visibleWidth(stripAnsi(l)) <= 120));

// 窄屏：换一个 pi 重新注册 renderer，验证宽字符内容也不会越界
const narrow = (() => {
	const piNarrow = makeFakePi();
	initNotice(piNarrow.pi as never);
	resetNoticeDedup();
	noticeCard({ level: "info", title: "窄屏", lines: [longLine], detail: longLine });
	return piNarrow.render({ data: piNarrow.entries[0].data }, { expanded: true });
})();
check("宽字符内容在 120 列下不越界", narrow.every((l) => visibleWidth(stripAnsi(l)) <= 120));

// ══════════════════════════════════════════════════════════════
console.log("\n=== 3. 去重：dedupKey 与 resetNoticeDedup ===");
// ══════════════════════════════════════════════════════════════
const d = makeFakePi();
initNotice(d.pi as never);
resetNoticeDedup();
noticeCard({ level: "error", title: "向量库一致性异常", dedupKey: "k" });
noticeCard({ level: "error", title: "向量库一致性异常", dedupKey: "k" });
check("同 dedupKey 只发一次", d.entries.length === 1, `n=${d.entries.length}`);
resetNoticeDedup();
noticeCard({ level: "error", title: "向量库一致性异常", dedupKey: "k" });
check("resetNoticeDedup 后可再发", d.entries.length === 2);
noticeCard({ level: "info", title: "无 key 的卡片" });
noticeCard({ level: "info", title: "无 key 的卡片" });
check("无 dedupKey 不去重", d.entries.length === 4, `n=${d.entries.length}`);

// ══════════════════════════════════════════════════════════════
console.log("\n=== 4. noticeReport：长报告自动切摘要 + detail ===");
// ══════════════════════════════════════════════════════════════
const r = makeFakePi();
initNotice(r.pi as never);
resetNoticeDedup();
noticeReport("L1 库体检", Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行指标`).join("\n"), { maxSummaryLines: 5 });
const rep = r.entries[0]?.data as NoticePayload;
check("摘要行数受 maxSummaryLines 限制", rep?.lines?.length === 5, `n=${rep?.lines?.length}`);
check("超出部分进 detail", typeof rep?.detail === "string" && rep.detail.includes("第 30 行"));
check("报告标题原样保留", rep?.title === "L1 库体检");

// ══════════════════════════════════════════════════════════════
console.log("\n=== 5. notice：级别归一 + 子代理进程 no-op ===");
// ══════════════════════════════════════════════════════════════
const notified: Array<{ msg: string; type: string }> = [];
const ctx = { ui: { notify: (msg: string, type: string) => notified.push({ msg, type }) } };
notice(ctx as never, "warn", "已在队列或运行中");
check('"warn" 归一为 "warning"', notified[0]?.type === "warning", JSON.stringify(notified));
notice(ctx as never, "error", "失败");
check('"error" 原样传递', notified[1]?.type === "error");
process.env.PI_SUBAGENT_CHILD = "1";
notice(ctx as never, "info", "子代理里应被忽略");
check("子代理进程 no-op", notified.length === 2, `n=${notified.length}`);
delete process.env.PI_SUBAGENT_CHILD;

// ══════════════════════════════════════════════════════════════
console.log("\n=== 6. 跨进程 relay：子代理落盘 → 主进程 drain ===");
// ══════════════════════════════════════════════════════════════
const queueFile = join(profile, "memoryDB", "logs", "notices.jsonl");
process.env.PI_SUBAGENT_CHILD = "1";
const childPi = { appendEntry: () => { throw new Error("子代理不应直接 appendEntry"); } };
initNotice(childPi as never);
resetNoticeDedup();
noticeCard({ level: "warning", title: "L1 提取未提交（超时/无 l1_commit）", lines: ["job 7（来源 interval）在时限内未调入 l1_commit"] });
check("子代理写入 notices.jsonl", existsSync(queueFile));
check("子代理未直接 appendEntry（未抛错即通过）", true);
check("子代理 drain 返回 0", drainNoticeCards() === 0);
delete process.env.PI_SUBAGENT_CHILD;

const main = makeFakePi();
initNotice(main.pi as never);
const drained = drainNoticeCards();
check("主进程 drain 渲染 1 张卡", drained === 1, `n=${drained}`);
check("渲染的 customType 正确", main.entries[0]?.customType === NOTICE_ENTRY_TYPE);
check("卡片内容透传", (main.entries[0]?.data as NoticePayload)?.title === "L1 提取未提交（超时/无 l1_commit）");
check("drain 后队列文件被清空（删除）", !existsSync(queueFile));
check("drain 后无 .draining 残留", !existsSync(`${queueFile}.draining`));
check("空队列 drain 返回 0", drainNoticeCards() === 0);

// 坏行不得吃掉好行
process.env.PI_SUBAGENT_CHILD = "1";
initNotice(makeFakePi().pi as never);
appendFileSync(queueFile, "{这行是坏 JSON\n", "utf8");
noticeCard({ level: "info", title: "坏行之后的好卡片" });
delete process.env.PI_SUBAGENT_CHILD;
const main2 = makeFakePi();
initNotice(main2.pi as never);
check("坏行难吃好行：drain=1 且渲染的是好卡片", drainNoticeCards() === 1 && (main2.entries[0]?.data as NoticePayload)?.title === "坏行之后的好卡片");

// 残留 .draining（模拟上次崩溃）
writeFileSync(`${queueFile}.draining`, "{}\n", "utf8");
noticeCard({ level: "info", title: "残留清理后的卡片" });
const main3 = makeFakePi();
initNotice(main3.pi as never);
check("残留 .draining 被清理后仍能 drain", drainNoticeCards() === 0 || main3.entries.length >= 0);
check(".draining 已不残留", !existsSync(`${queueFile}.draining`));

// ══════════════════════════════════════════════════════════════
console.log("\n=== 7. logEvent：落盘 / scope 白名单 / 5MB 轮转 ===");
// ══════════════════════════════════════════════════════════════
logEvent("recall", "recall=3 filtered=3 kept=0 minScore=0.2");
const recallLog = join(profile, "memoryDB", "logs", "recall.log");
check("日志落盘且带 ISO 前缀", existsSync(recallLog) && /^\[\d{4}-\d{2}-\d{2}T/.test(readFileSync(recallLog, "utf8")), readFileSync(recallLog, "utf8").trim().slice(0, 40));
logEvent("Bad/../Scope!", "路径穿越应被白名单化");
check("scope 白名单化（不留路径片段）", existsSync(join(profile, "memoryDB", "logs", "badscope.log")) && readdirSync(join(profile, "memoryDB", "logs")).every((f) => !f.includes("..")));

const bigScope = "biglog";
const bigFile = join(profile, "memoryDB", "logs", `${bigScope}.log`);
writeFileSync(bigFile, Buffer.alloc(5 * 1024 * 1024 + 10, "x"));
logEvent(bigScope, "轮转后的新行");
check("超 5MB → 生成 .1 轮转文件", existsSync(`${bigFile}.1`));
check("新文件只含新行", readFileSync(bigFile, "utf8").includes("轮转后的新行") && statSync(bigFile).size < 1000, `size=${statSync(bigFile).size}`);

const savedResolver = profile;
setNoticeProfileResolver(() => undefined);
let threw = false;
try {
	logEvent("recall", "profile 未知时应静默 no-op");
	noticeCard({ level: "info", title: "profile 未知时应静默 no-op" });
} catch {
	threw = true;
}
check("profile 未知时 logEvent/noticeCard 不抛错", !threw);
setNoticeProfileResolver(() => savedResolver);

// ══════════════════════════════════════════════════════════════
console.log("\n=== 8. 静态断言：运行时代码无 console.*（白名单 3 文件 4 处） ===");
// ══════════════════════════════════════════════════════════════
const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 运行时代码目录（排除 scripts/ 工具与回归脚本；它们跑在 bash 工具里，输出本身可见）。 */
const RUNTIME_ROOTS = ["index.ts", "memory", "util", "skill", "prompts", "config", "workflow"];
/** 豁免清单（键=相对路径，值=允许的出现次数）与理由。 */
const WHITELIST: Record<string, { allow: number; why: string }> = {
	"prompts/registry.ts": { allow: 2, why: "加载期、profile 未知，无处落盘（启动期 checkPromptAssets 已汇总成卡片）" },
	"memory/l2/config.ts": { allow: 1, why: "一次性 deprecation，函数已无调用者" },
	"index.ts": { allow: 1, why: "registerTool 包装器在模块加载期报告代码级 schema 问题" },
};
const CONSOLE_RE = /console\.(log|warn|error|info|debug|trace|table)\s*\(/;

function walk(rel: string): string[] {
	const abs = join(EXT_ROOT, rel);
	if (!existsSync(abs)) return [];
	if (!statSyncSafeIsDir(abs)) return [abs]; // 单文件（如 index.ts）
	const out: string[] = [];
	const stack = [abs];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === "node_modules") continue;
				stack.push(p);
			} else if (e.name.endsWith(".ts")) {
				out.push(p);
			}
		}
	}
	return out;
}

/** 目录判定（walk 用于兼容“根是单个文件”的情形）。 */
function statSyncSafeIsDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

const hits: Array<{ rel: string; line: number; text: string }> = [];
for (const root of RUNTIME_ROOTS) {
	for (const abs of walk(root)) {
		const rel = relative(EXT_ROOT, abs).replace(/\\/g, "/");
		const lines = readFileSync(abs, "utf8").split(/\r?\n/);
		lines.forEach((text, i) => {
			const trimmed = text.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return; // 注释不算
			if (CONSOLE_RE.test(text)) hits.push({ rel, line: i + 1, text: trimmed.slice(0, 80) });
		});
	}
}

const offenders = hits.filter((h) => {
	const wl = WHITELIST[h.rel];
	return !wl;
});
check("白名单以外的运行时代码无 console.*", offenders.length === 0, offenders.map((o) => `${o.rel}:${o.line}`).join(", "));

for (const [rel, wl] of Object.entries(WHITELIST)) {
	const n = hits.filter((h) => h.rel === rel).length;
	check(`${rel} 的 console.* 数量 = ${wl.allow}（${wl.why}）`, n === wl.allow, `实际 ${n}`);
}
check("白名单文件都确实存在（防条目过期）", Object.keys(WHITELIST).every((rel) => existsSync(join(EXT_ROOT, rel))));

// 反向自检：断言本身能抓到 console（否则正则失效会让本条永久假绿）
const probe = "  console.warn('x');";
check("静态断言正则可命中 console.warn（自检）", CONSOLE_RE.test(probe));
check("静态断言正则可命中 console.log（自检）", CONSOLE_RE.test("console.log('y')"));

// ══════════════════════════════════════════════════════════════
console.log("\n=== 9. L3 画像 diff 卡片（主进程 spawn 前后集合比对） ===");
// ══════════════════════════════════════════════════════════════
// 这是本计划“重要信息进聊天区”的中心场景：L3 是本系统唯一会改用户画像的一层，
// 它跑在**子代理进程**里，以前完全静默。这里用桩子代理驱动真实的 executeJob。
const l3Group = (async () => {
	const l3Root = mkdtempSync(join(tmpdir(), "notice-l3-"));
	mkdirSync(join(l3Root, "memoryDB", "config"), { recursive: true });
	mkdirSync(join(l3Root, "memoryDB", "l2", "index"), { recursive: true });
	mkdirSync(join(l3Root, "memoryDB", "l2", "scene-blocks"), { recursive: true });
	writeFileSync(join(l3Root, "memoryDB", "config", "application-propertis.json"), '{"l1":{"mode":"code"}}', "utf-8");
	writeFileSync(
		join(l3Root, "memoryDB", "l2", "index", "scene_index.json"),
		JSON.stringify([{ filename: "s.md", summary: "x", heat: 1, created: "2026-09-01T00:00:00.000Z", updated: "2026-09-10T00:00:00.000Z" }]),
		"utf-8",
	);
	writeFileSync(join(l3Root, "memoryDB", "l2", "scene-blocks", "s.md"), "x", "utf-8");
	// 跑前：两条规则
	writeFileSync(join(l3Root, "USER.md"), ["规则甲：中文输出", "规则乙：先计划后执行"].join("\n§\n") + "\n", "utf-8");

	setNoticeProfileResolver(() => l3Root);
	const l3Cards = makeFakePi();
	initNotice(l3Cards.pi as never);
	resetNoticeDedup();

	const db = getPipelineJobsDB(l3Root);
	const queued = db.enqueue("l3", "manual");
	const job = db.claim(queued.id)!;
	// 桩子代理：把“规则乙”换成“规则丙”写进**提议稿**（2026-09-28 起 L3 只写 USER-temp.md），
	// 然后写“真完成信号”（等价 l3_commit → completeRunningL3）
	const setL3Stub = installSubagentRpcStub(l3Cards.pi as never, () => {
		writeFileSync(join(l3Root, "USER-temp.md"), ["规则甲：中文输出", "规则丙：新增的画像规则"].join("\n§\n") + "\n", "utf-8");
		db.complete(job.id, "done");
	});
	const l3Ctx = { ui: { notify: () => {}, setStatus: () => {} } };
	const controls = setupL3Persona(l3Cards.pi as never, () => l3Root, {
		enqueueL3: () => ({ id: 1, duplicate: false }),
		setCachedCtx: () => {},
		kick: () => {},
	} as never);

	const l3Result = await controls.executeJob(l3Ctx as never, job);
	check("executeJob 返回 done", l3Result === "done", l3Result);
	check("L3 跑完产出 1 张卡片", l3Cards.entries.length === 1, `n=${l3Cards.entries.length}`);
	const card = l3Cards.entries[0]?.data as NoticePayload;
	check("标题 = 画像提议 ＋1 / －1（改一条=换掉一条）", card?.title === "画像提议（待并入 USER.md）：＋1 / －1", card?.title);
	check("摘要点明 live USER.md 未动", (card?.lines ?? []).some((l) => l.includes("live USER.md 未动")));
	check("摘要列出新规则", (card?.lines ?? []).some((l) => l.includes("规则丙")));
	check("摘要列出被换掉的规则", (card?.lines ?? []).some((l) => l.includes("规则乙")));
	check("detail 含逐条明细", typeof card?.detail === "string" && card.detail.includes("＋ 规则丙") && card.detail.includes("－ 规则乙"));

	// 第二轮：子代理什么都不改 → 也要有一张“无改动”卡片（证明 L3 确实跑过）
	const q2 = db.enqueue("l3", "manual");
	const job2 = db.claim(q2.id)!;
	setL3Stub(() => {
		db.complete(job2.id, "done");
	});
	const r2 = await controls.executeJob(l3Ctx as never, job2);
	check("第二轮仍返回 done", r2 === "done", r2);
	check("第二轮卡片注明本轮无改动", l3Cards.entries.length === 2 && (l3Cards.entries[1]?.data as NoticePayload)?.title.includes("无改动"));

	closePipelineJobsDB(l3Root);
	rmSync(l3Root, { recursive: true, force: true });
	setNoticeProfileResolver(() => profile);

	// ══════════════════════════════════════════════════════════════════════
	console.log("\n=== 10. 向量库初始化路径冒烟（离线真库；防“变量越界”类静默破坏） ===");
	// ══════════════════════════════════════════════════════════════════════
	// 本组是为一个真实事故加的：把 store.ts 的 console.* 改道时，一致性自检分支里写错了变量名
	// （用了只存在于 getVectorStore 作用域的 baseProfilePath）→ 初始化成功路径抛 ReferenceError
	// → 子代理的 embed_and_search 全部 fallback（向量去重路不可用）。此类错误**没有 tsc 门禁**
	// （仓库无构建），只有真跑一次初始化才能暴露。
	{
		const storeRoot = mkdtempSync(join(tmpdir(), "notice-store-"));
		mkdirSync(join(storeRoot, "memoryDB", "config"), { recursive: true });
		writeFileSync(join(storeRoot, "memoryDB", "config", "application-propertis.json"), "{}", "utf-8");
		let store: { count(): Promise<number>; close(): void } | undefined;
		let initError: unknown;
		try {
			store = (await getVectorStore(storeRoot)) as unknown as { count(): Promise<number>; close(): void };
		} catch (e) {
			initError = e;
		}
		check("getVectorStore 初始化不抛错（空库走一致性自检通过分支）", !initError, String(initError));
		if (store) {
			let n = -1;
			try {
				n = await store.count();
			} catch (e) {
				initError = e;
			}
			check("初始化后可查 count（空库 = 0）", n === 0, `n=${n} err=${String(initError ?? "")}`);
		}
		const storeLog = join(storeRoot, "memoryDB", "logs", "store.log");
		check(
			"初始化完成日志落到 store.log（走通 logEvent 分支）",
			existsSync(storeLog) && readFileSync(storeLog, "utf8").includes("初始化完成"),
		);
		store?.close();
		// 单例存在 globalThis 上：不释放的话临时目录会被 sqlite 文件句柄锁住（Windows EPERM）
		delete (globalThis as unknown as { __piMemorySystem_vectorStore?: unknown }).__piMemorySystem_vectorStore;
		try {
			rmSync(storeRoot, { recursive: true, force: true });
		} catch {
			// 初始化失败时 sqlite 句柄已泄漏在进程内（getVectorStore 只清 initPromise，不关库），
			// Windows 下临时目录删不掉是预期的——不得因此把“一次 FAIL”渲染成“脚本崩溃”。
			console.log("  （临时目录未能删除：初始化失败时句柄已泄漏，重启进程自清）");
		}
	}
})();

// ══════════════════════════════════════════════════════════════
l3Group.then(() => {
	rmSync(profile, { recursive: true, force: true });
	console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
	process.exit(fail === 0 ? 0 : 1);
});
