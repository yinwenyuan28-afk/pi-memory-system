#!/usr/bin/env node
// ============================================================================
// test-recall-scheduler.mjs — 召回调度闸门行为单测（无 pi 依赖）
//
// 用法（任选）：
//   node --experimental-strip-types scripts/test-recall-scheduler.mjs          # 原生 ESM 优先
//   node scripts/test-recall-scheduler.mjs                                     # 走 jiti 兜底
//
// 为什么可能要 jiti：`agent/extensions/package.json` 声明 `"type": "commonjs"`，
// 故 Node 原生会把 `memory/search/*.ts` 当 CJS 解析（ESM `export` 不可见）。给该目录加
// `type:module` 标记会改变 pi（jiti）对该目录的加载语义，风险大于收益，因此本脚本
// 「原生 import 优先 + jiti 兜底」（jiti 也是 pi 的实际加载器，更贴近运行时）。
//
// 覆盖 plan/memory-system/L1_RECALL_ASYNC/ 的验证项 1（R1 阻断修正后的语义）：
//   ① 任一时刻未作废活动 ≤1 —— 含「预算超时后底层仍在跑时不放行下一项」（R1 B1）
//   ② inject 单槽 latest-wins，被覆盖者以 superseded settle
//   ③ demand 必 settle（含被 inject 占闸时跨轮排队后仍返回）（R1 B2）
//   ④ maxHoldMs 到点强制释放（底层永不 settle 时不死锁）（R1 B3）
//   ⑤ reset 清空并 settle 所有排队/在飞请求
// ============================================================================

import { existsSync, readFileSync } from "node:fs";

/** 最近的 package.json 是否声明 type:module（决定能否用原生 ESM import）。 */
function nativeEsmAvailable() {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
		return pkg?.type === "module";
	} catch {
		return false;
	}
}

/** 加载调度器：原生 import 优先（仅当包类型允许，避免 Node 的 CJS 警告），否则用 jiti（pi 的实际加载器）。 */
async function loadScheduler() {
	if (nativeEsmAvailable()) {
		const m = await import("../memory/search/recall-scheduler.ts");
		if (typeof m.createRecallScheduler === "function") return m;
	}
	const jitiPaths = [
		"C:/Users/leaf/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs",
		"../node_modules/jiti/lib/jiti.mjs",
	];
	for (const p of jitiPaths) {
		try {
			const spec = p.startsWith("C:") ? `file:///${p}` : p;
			const { createJiti } = await import(spec);
			const jiti = createJiti(import.meta.url);
			return await jiti.import("../memory/search/recall-scheduler.ts");
		} catch {
			/* 试下一个 */
		}
	}
	throw new Error("无法加载 recall-scheduler.ts（原生 ESM 与 jiti 均失败）");
}

const { createRecallScheduler } = await loadScheduler();

let pass = 0;
let fail = 0;
const ok = (name) => { console.log(`  ok  ${name}`); pass++; };
const bad = (name, detail) => { console.error(`  FAIL ${name}: ${detail}`); fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 构造一个可观测「并发度」的 run：记录同时在跑的数量峰值。 */
function makeRun(behavior) {
	let active = 0;
	let peak = 0;
	const started = [];
	const run = async (payload, signal) => {
		active++;
		peak = Math.max(peak, active);
		started.push(payload.id);
		try {
			return await behavior(payload, signal);
		} finally {
			active--;
		}
	};
	return { run, peak: () => peak, started };
}

async function t1_noConcurrentEvenAfterBudgetTimeout() {
	// run 慢于预算（底层 200ms、预算 20ms）→ 结果 timeout，但闸门必须等底层结束才放下一项
	const { run, peak } = makeRun(async (p) => {
		await sleep(200);
		return `r${p.id}`;
	});
	const sch = createRecallScheduler({ run, maxHoldMs: 5000, log: () => {} });
	const t0 = Date.now();
	const r1 = await sch.request({ kind: "inject", turnToken: 1, timeoutMs: 20, payload: { id: 1 } });
	if (r1.outcome !== "timeout") return bad("①预算超时 settle 为 timeout", r1.outcome);
	// 第二个请求（demand）应在底层结束后才开始 → 峰值并发仍为 1
	const p2 = sch.request({ kind: "demand", turnToken: -1, timeoutMs: 3000, payload: { id: 2 } });
	const r2 = await p2;
	if (peak() !== 1) return bad("①并发度", `peak=${peak()}（应为 1）`);
	if (r2.outcome !== "ok" || r2.value !== "r2") return bad("②demand 结果", JSON.stringify(r2));
	if (Date.now() - t0 < 190) return bad("①闸门绑定底层 settle", "闸门被过早释放（总耗时 < 底层耗时）");
	ok("①预算超时不提前放闸：底层仍在跑时并发度保持 1（R1 B1）");
}

async function t2_injectLatestWins() {
	const { run } = makeRun(async (p) => {
		await sleep(60);
		return `r${p.id}`;
	});
	const sch = createRecallScheduler({ run, maxHoldMs: 5000, log: () => {} });
	const a = sch.request({ kind: "inject", turnToken: 1, timeoutMs: 3000, payload: { id: "A" } }); // 在飞
	await sleep(5);
	const b = sch.request({ kind: "inject", turnToken: 2, timeoutMs: 3000, payload: { id: "B" } }); // 入单槽
	const c = sch.request({ kind: "inject", turnToken: 3, timeoutMs: 3000, payload: { id: "C" } }); // 覆盖 B
	const [ra, rb, rc] = await Promise.all([a, b, c]);
	if (ra.outcome !== "ok") return bad("②在飞者仍返回 ok", ra.outcome);
	if (rb.outcome !== "superseded") return bad("②被覆盖的 inject 应为 superseded", rb.outcome);
	if (rc.outcome !== "ok" || rc.value !== "rC") return bad("②最新 inject 应执行", JSON.stringify(rc));
	ok("②inject 单槽 latest-wins：被覆盖者以 superseded settle，最新者执行");
}

async function t3_demandNeverDropped() {
	let active = 0;
	let demandReturned = 0;
	const run = async (p) => {
		active++;
		await sleep(p.id === "inject" ? 80 : 20);
		active--;
		return `r${p.id}`;
	};
	const sch = createRecallScheduler({ run, maxHoldMs: 5000, log: () => {} });
	// 先占闸（inject 在飞），随后 3 个 demand + 2 个 inject，全部 demand 必须有结果
	const inj = sch.request({ kind: "inject", turnToken: 1, timeoutMs: 3000, payload: { id: "inject" } });
	await sleep(5);
	const demands = [1, 2, 3].map((i) =>
		sch.request({ kind: "demand", turnToken: -1, timeoutMs: 3000, payload: { id: `d${i}` } }).then((r) => {
			demandReturned++;
			return r;
		}),
	);
	sch.request({ kind: "inject", turnToken: 2, timeoutMs: 3000, payload: { id: "i2" } });
	sch.request({ kind: "inject", turnToken: 3, timeoutMs: 3000, payload: { id: "i3" } });
	const rs = await Promise.all([inj, ...demands]);
	if (demandReturned !== 3) return bad("③demand 全部 settle", `仅 ${demandReturned}/3 返回`);
	const okAll = rs.slice(1).every((r) => r.outcome === "ok" && String(r.value).startsWith("rd"));
	if (!okAll) return bad("③demand 结果完整", JSON.stringify(rs.slice(1)));
	ok("③demand 必 settle：被 inject 占闸时排队后仍逐个返回（R1 B2）");
}

async function t4_maxHoldForcedRelease() {
	// 底层永不 settle → maxHoldMs 到点必须释放，drain 继续（否则死锁）
	let startedNever = false;
	const run = async (p) => {
		if (p.id === "hang") {
			startedNever = true;
			return new Promise(() => {}); // 永不 settle
		}
		return `r${p.id}`;
	};
	const logs = [];
	const sch = createRecallScheduler({ run, maxHoldMs: 60, log: (m) => logs.push(m) });
	const hang = sch.request({ kind: "inject", turnToken: 1, timeoutMs: 20, payload: { id: "hang" } });
	const rh = await hang; // 预算 20ms → timeout
	if (rh.outcome !== "timeout") return bad("④超时 settle", rh.outcome);
	const after = await sch.request({ kind: "demand", turnToken: -1, timeoutMs: 3000, payload: { id: "after" } });
	if (after.outcome !== "ok" || after.value !== "rafter") return bad("④强制释放后应能继续", JSON.stringify(after));
	if (!logs.some((l) => l.includes("闸门强制释放"))) return bad("④应记录强制释放警告", JSON.stringify(logs));
	if (!startedNever) return bad("④前置", "hang 未启动");
	ok("④maxHoldMs 到点强制释放：底层永不 settle 也不死锁（R1 B3）");
}

async function t5_resetSettlesEverything() {
	const run = async (p) => {
		await sleep(300);
		return `r${p.id}`;
	};
	const sch = createRecallScheduler({ run, maxHoldMs: 5000, log: () => {} });
	const a = sch.request({ kind: "inject", turnToken: 1, timeoutMs: 2000, payload: { id: "A" } });
	await sleep(5);
	const b = sch.request({ kind: "demand", turnToken: -1, timeoutMs: 2000, payload: { id: "B" } });
	const c = sch.request({ kind: "inject", turnToken: 2, timeoutMs: 2000, payload: { id: "C" } });
	await sleep(5);
	sch.reset();
	const [ra, rb, rc] = await Promise.all([a, b, c]);
	const allReset = [ra, rb, rc].every((r) => r.outcome === "reset" || r.outcome === "ok");
	if (!allReset) return bad("⑤reset 后全部 settle", JSON.stringify([ra, rb, rc]));
	if (sch.isBusy()) return bad("⑤reset 后不应 busy", "isBusy=true");
	ok("⑤reset 清空并 settle 所有在飞/排队请求（不悬挂）");
}

console.log("── recall-scheduler 单测");
await t1_noConcurrentEvenAfterBudgetTimeout();
await t2_injectLatestWins();
await t3_demandNeverDropped();
await t4_maxHoldForcedRelease();
await t5_resetSettlesEverything();
console.log("");
if (fail > 0) {
	console.error(`✗ ${fail} 项失败，${pass} 项通过`);
	process.exit(1);
}
console.log(`✓ 全部通过（${pass} 项）`);
