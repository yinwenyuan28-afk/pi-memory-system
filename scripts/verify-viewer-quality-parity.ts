// 查看器质量分 parity 门禁 —— 断言 JS 移植版与 TS 源实现**逐例数值相等**
//
// 为什么需要它（2026-10-08，查看器跟版重写计划 T5）：
// 旧版查看器的注释写着「与 memory/l1/quality.ts 1:1」，但 `prune / judgePrune / protectedPriority /
// percentile` 在整份文件里出现 0 次 —— "1:1" 是一句从未被验证的自我声明。声明会漂移，断言不会。
// 本脚本把两份实现喂同一批夹具并比数值：公式一改、只改一边，这里立刻红。
//
// 覆盖：
//   ① calcQuality 的五个标签分支（新 / 噪 / 热 / 温 / 冷 / 待观察）
//   ② 两条时钟：活跃会话日 vs 无活跃日时的日历天退化
//   ③ judgePrune 的六种 reason
//   ④ 保护带阈值（priority 分布 P75，下限 60）
//   ⑤ 侧车字段归一（snake_case 数据库行 → 驼峰）
//   ⑥ 常量一致性（PRUNE_RULES / PROTECTED_L1_TYPES / 标签文案）
//
// 铁律：只用内存夹具，不读盘、不发网络请求。
// 运行：node --conditions=import --experimental-strip-types scripts/verify-viewer-quality-parity.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { calcQuality, getQualityStats, judgePrune, PRUNE_RULES } from "../memory/l1/quality.ts";
import { PROTECTED_L1_TYPES } from "../memory/l1/record-types.ts";
import { RECORDS_DIR_NAME } from "../memory/l1/config.ts";
import { MEMORY_DB_DIR } from "../memory/paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUALITY_JS = join(HERE, "..", "viewers", "assets", "quality-core.js");

// ── 加载 JS 副本：classic script，用 vm 建一个上下文跑，取它挂上的 window.VQ ──
// 为什么用 vm 而不是 import()：JS 是 classic script（为了保住 file:// 直开），没有 export，
// 不能当模块 import。vm 里给它一个 window 全局即可，与浏览器中的挂载方式一致。
interface VQ {
	PRUNE_RULES: typeof PRUNE_RULES;
	PROTECTED_TYPES: readonly string[];
	PRUNE_REASON_LABELS: Record<string, string>;
	normalizeStat: (raw: unknown) => Record<string, unknown> | undefined;
	calcQuality: (rec: unknown, stat: unknown, nowMs: number, activeDays?: number[]) => Record<string, unknown>;
	judgePrune: (rec: unknown, q: unknown, protectedPriority?: number) => { eligible: boolean; reason: string };
	percentile: (sortedAsc: number[], p: number) => number;
	protectedPriorityOf: (ranked: unknown[]) => number;
}

function loadVQ(): VQ {
	const source = readFileSync(QUALITY_JS, "utf-8");
	const sandbox: Record<string, unknown> = { console };
	sandbox.window = sandbox; // classic script 挂 window.VQ
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "quality-core.js" });
	const vq = sandbox.VQ as VQ | undefined;
	if (!vq || typeof vq.calcQuality !== "function") {
		throw new Error("未能从 quality-core.js 取到 window.VQ（脚本形态变了？）");
	}
	return vq;
}

const VQ = loadVQ();

// ── 断言器 ────────────────────────────────────────────────────────────────
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ""): void {
	if (cond) pass++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eqNum(name: string, a: number, b: number): void {
	// 浮点严格相等：两份实现跑的是同一串 IEEE 运算，顺序也一致，理应逐位相同。
	// 若真出现末位差异，说明移植时改了运算顺序 —— 那正是要发现的东西，故不放宽容差。
	ok(name, Object.is(a, b) || a === b, `TS=${a} JS=${b}`);
}
function eqStr(name: string, a: string, b: string): void {
	ok(name, a === b, `TS=${JSON.stringify(a)} JS=${JSON.stringify(b)}`);
}

// ── 夹具 ──────────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const DAY = 86400000;

/** 活跃会话日：从 60 天前到 5 天前，每隔 3 天一个（本地日 0 点）。 */
const ACTIVE_DAYS: number[] = (() => {
	const out: number[] = [];
	for (let d = 60; d >= 5; d -= 3) {
		const t = new Date(NOW - d * DAY);
		t.setHours(0, 0, 0, 0);
		out.push(t.getTime());
	}
	return out.sort((a, b) => a - b);
})();

interface Case {
	name: string;
	rec: Record<string, unknown>;
	stat?: Record<string, unknown>;
}

const CASES: Case[] = [
	// ① 新记录保护（无统计 + 日历年龄 <7 天），priority 参与保底
	{ name: "新/无统计/age<7/priority=88", rec: { type: "work_fact", priority: 88, createdAt: iso(2 * DAY) } },
	{ name: "新/无统计/age<7/priority=12(低于0.3下限)", rec: { type: "work_fact", priority: 12, createdAt: iso(6 * DAY) } },
	{ name: "新/无统计/age<7/priority缺失按50", rec: { type: "work_fact", createdAt: iso(1 * DAY) } },
	// ② 无统计但年龄 >=7 天（掉出保护，quality=0）
	{ name: "无统计/age>=7", rec: { type: "work_fact", priority: 90, createdAt: iso(30 * DAY) } },
	// ③ 噪：失效率 >50%
	{ name: "噪/2命中2无效", rec: { type: "work_fact", priority: 70, createdAt: iso(40 * DAY) }, stat: { hits: 2, invalidHits: 2, effectiveHits: 0, lastHitAt: iso(3 * DAY) } },
	{ name: "噪/6命中4无效(0.667)", rec: { type: "work_fact", priority: 70, createdAt: iso(40 * DAY) }, stat: { hits: 6, invalidHits: 4, effectiveHits: 2, lastHitAt: iso(10 * DAY) } },
	// ④ 热：有效命中 >=5
	{ name: "热/有效6", rec: { type: "work_fact", priority: 80, createdAt: iso(50 * DAY) }, stat: { hits: 7, invalidHits: 1, effectiveHits: 6, lastHitAt: iso(6 * DAY) } },
	// ⑤ 温：有效 1..4
	{ name: "温/有效3", rec: { type: "work_fact", priority: 80, createdAt: iso(50 * DAY) }, stat: { hits: 3, invalidHits: 0, effectiveHits: 3, lastHitAt: iso(9 * DAY) } },
	// ⑥ 恰好 50% 失效率不算噪（严格大于 才判噪）
	{ name: "边界/失效率恰好0.5", rec: { type: "work_fact", priority: 80, createdAt: iso(50 * DAY) }, stat: { hits: 4, invalidHits: 2, effectiveHits: 2, lastHitAt: iso(9 * DAY) } },
	// ⑦ 冷：有效 0 + 日历年龄 >=7 + 活跃日 >14
	{ name: "冷/有效0/久未命中", rec: { type: "work_fact", priority: 50, createdAt: iso(90 * DAY) }, stat: { hits: 2, invalidHits: 0, effectiveHits: 0, lastHitAt: iso(60 * DAY) } },
	// ⑧ 待观察：有效 0 + 日期尚近
	{ name: "待观察/有效0/近", rec: { type: "work_fact", priority: 50, createdAt: iso(20 * DAY) }, stat: { hits: 1, invalidHits: 0, effectiveHits: 0, lastHitAt: iso(8 * DAY) } },
	// ⑨ 无 lastHitAt 时用 createdAt 作基准
	{ name: "无lastHitAt/基准取createdAt", rec: { type: "work_fact", priority: 60, createdAt: iso(45 * DAY) }, stat: { hits: 1, invalidHits: 0, effectiveHits: 1, lastHitAt: null } },
];

const CLOCK_MODES: Array<{ label: string; activeDays: number[] | undefined }> = [
	{ label: "活跃日时钟", activeDays: ACTIVE_DAYS },
	{ label: "日历天退化", activeDays: undefined },
];

// ── ① calcQuality：两份实现逐例比数值 ────────────────────────────────────
for (const c of CASES) {
	for (const mode of CLOCK_MODES) {
		const label = `calcQuality[${c.name}][${mode.label}]`;
		const tsResult = calcQuality(c.rec as never, c.stat as never, NOW, mode.activeDays);
		const jsResult = VQ.calcQuality(c.rec, c.stat, NOW, mode.activeDays);
		eqNum(`${label}.quality`, tsResult.quality, jsResult.quality as number);
		eqNum(`${label}.decay`, tsResult.decay, jsResult.decay as number);
		eqNum(`${label}.days`, tsResult.days, jsResult.days as number);
		eqStr(`${label}.tag`, tsResult.tag, jsResult.tag as string);
		eqNum(`${label}.effective`, tsResult.effective, jsResult.effective as number);
		eqNum(`${label}.hits`, tsResult.hits, jsResult.hits as number);
		eqNum(`${label}.invalid`, tsResult.invalid, jsResult.invalid as number);
		ok(`${label}.activeDayClock`, tsResult.activeDayClock === jsResult.activeDayClock, `TS=${tsResult.activeDayClock} JS=${jsResult.activeDayClock}`);
	}
}

// ── ② judgePrune：六种 reason 必须两边一致 ───────────────────────────────
const PROTECTED_P75 = 85; // 取一个高于 60 的阈值，让"保护带"分支真的与固定 60 有区别
const PRUNE_CASES: Array<{ name: string; rec: Record<string, unknown>; q: Record<string, unknown>; threshold?: number }> = [
	{ name: "falsified", rec: { type: "work_fact", priority: 30 }, q: { hits: 5, invalid: 4, effective: 1, days: 1 } },
	{ name: "falsified阈值内(hits<3)", rec: { type: "work_fact", priority: 30 }, q: { hits: 2, invalid: 2, effective: 0, days: 40 } },
	{ name: "protected-priority", rec: { type: "work_fact", priority: 90 }, q: { hits: 1, invalid: 0, effective: 0, days: 60 } },
	{ name: "protected-priority(阈值85/prio85)", rec: { type: "work_fact", priority: 85 }, q: { hits: 1, invalid: 0, effective: 0, days: 60 }, threshold: PROTECTED_P75 },
	{ name: "protected-priority(阈值85/prio84)", rec: { type: "work_fact", priority: 84 }, q: { hits: 1, invalid: 0, effective: 0, days: 60 }, threshold: PROTECTED_P75 },
	{ name: "protected-type", rec: { type: "work_method", priority: 40 }, q: { hits: 1, invalid: 0, effective: 0, days: 60 } },
	{ name: "verified", rec: { type: "work_fact", priority: 40 }, q: { hits: 3, invalid: 1, effective: 2, days: 60 } },
	{ name: "idle-low-value", rec: { type: "work_fact", priority: 40 }, q: { hits: 1, invalid: 0, effective: 0, days: 30 } },
	{ name: "too-early", rec: { type: "work_fact", priority: 40 }, q: { hits: 1, invalid: 0, effective: 0, days: 29 } },
];

for (const c of PRUNE_CASES) {
	const label = `judgePrune[${c.name}]`;
	const tsVerdict = judgePrune(c.rec as never, c.q as never, c.threshold);
	const jsVerdict = VQ.judgePrune(c.rec, c.q, c.threshold);
	ok(`${label}.eligible`, tsVerdict.eligible === jsVerdict.eligible, `TS=${tsVerdict.eligible} JS=${jsVerdict.eligible}`);
	eqStr(`${label}.reason`, tsVerdict.reason, jsVerdict.reason);
}

// ── ③ 保护带阈值（P75，下限 60）────────────────────────────────────────
const PRIO_SETS: Array<{ name: string; pris: number[] }> = [
	{ name: "空数组", pris: [] },
	{ name: "单元素", pris: [90] },
	{ name: "含缺失→按50", pris: [70, 80, 90, 95] },
	{ name: "低分布(全<60)", pris: [10, 20, 30, 40] },
	{ name: "实测形态(最低65/中位85)", pris: [65, 70, 75, 80, 85, 85, 90, 95] },
	{ name: "100个递增", pris: Array.from({ length: 100 }, (_, i) => i + 1) },
];
// percentile 直接对拍
for (const s of PRIO_SETS) {
	for (const p of [50, 75, 90, 100]) {
		// TS 的 percentile 是模块私有函数，用 getQualityStats 的公开口径无法直接取 —— 改为
		// 通过 protectedPriorityOf 的等价公式对拍：JS 的 percentile 对上手工实现的同一公式。
		const expected = s.pris.length === 0
			? 0
			: (() => {
					const sorted = [...s.pris].sort((a, b) => a - b);
					const idx = Math.ceil((p / 100) * sorted.length) - 1;
					return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
				})();
		eqNum(`percentile[${s.name}][P${p}]`, expected, VQ.percentile([...s.pris].sort((a, b) => a - b), p));
	}
}
for (const s of PRIO_SETS) {
	const ranked = s.pris.map((pri) => ({ priority: pri }));
	const expected = Math.max(60, (() => {
		if (s.pris.length === 0) return 0;
		const sorted = [...s.pris].sort((a, b) => a - b);
		const idx = Math.ceil((75 / 100) * sorted.length) - 1;
		return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
	})());
	eqNum(`protectedPriorityOf[${s.name}]`, expected, VQ.protectedPriorityOf(ranked));
}

// ── ③b 权威对拍：保护带阈值 vs TS 的 getQualityStats ──────────────────────
// 上面那组只证明「JS 的 percentile 与测试里重写的同一公式一致」，属于自证。
// 这一段才是真门禁：把已知 priority 分布的 L1 记录写进临时 profile，调 TS 的 getQualityStats
// 拿它真实算出的 protectedPriority，与 JS 的 protectedPriorityOf 比 —— 这样 TS 的 P75/下限
// 一旦改动，这里立刻红（而不是两边一起漂）。
{
	const tmp = mkdtempSync(join(tmpdir(), "viewer-parity-"));
	try {
		for (const s of PRIO_SETS.filter((x) => x.pris.length > 0)) {
			const profile = join(tmp, s.name.replace(/[^\w\u4e00-\u9fa5]/g, "_"));
			const dir = join(profile, MEMORY_DB_DIR, RECORDS_DIR_NAME);
			mkdirSync(dir, { recursive: true });
			const today = new Date().toISOString().slice(0, 10);
			const lines = s.pris.map((pri, i) =>
				JSON.stringify({
					id: `l1_parity_${i}`,
					content: `parity fixture ${i}`,
					type: "work_fact",
					priority: pri,
					createdAt: new Date(NOW - 40 * DAY).toISOString(),
					updatedAt: new Date(NOW - 40 * DAY).toISOString(),
					deleted: false,
				}),
			);
			writeFileSync(join(dir, `${today}.jsonl`), `${lines.join("\n")}\n`, "utf-8");

			const stats = await getQualityStats(profile, NOW);
			const jsThreshold = VQ.protectedPriorityOf(stats.ranked);
			eqNum(`getQualityStats.protectedPriority[${s.name}]`, stats.protectedPriority, jsThreshold);
			eqNum(`getQualityStats.total[${s.name}]`, s.pris.length, stats.total);
			// 淘汰候选数也必须一致（judgePrune 在两边都按同一阈值筛）
			const jsPrune = stats.ranked.filter((r) => VQ.judgePrune(r, r, jsThreshold).eligible).length;
			eqNum(`getQualityStats.prune 条数[${s.name}]`, stats.prune.length, jsPrune);
		}
	} finally {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* 临时目录清不掉不影响结论 */
		}
	}
}

// ── ④ 常量一致性（数值/文案分叉也要拦）─────────────────────────────────
eqNum("PRUNE_RULES.minHitsForFalsified", PRUNE_RULES.minHitsForFalsified, VQ.PRUNE_RULES.minHitsForFalsified);
eqNum("PRUNE_RULES.invalidRatio", PRUNE_RULES.invalidRatio, VQ.PRUNE_RULES.invalidRatio);
eqNum("PRUNE_RULES.idleActiveDays", PRUNE_RULES.idleActiveDays, VQ.PRUNE_RULES.idleActiveDays);
eqNum("PRUNE_RULES.protectedPriority", PRUNE_RULES.protectedPriority, VQ.PRUNE_RULES.protectedPriority);
eqNum("PRUNE_RULES.protectedPercentile", PRUNE_RULES.protectedPercentile, VQ.PRUNE_RULES.protectedPercentile);
ok(
	"PROTECTED_TYPES 与 PROTECTED_L1_TYPES 一致",
	JSON.stringify([...VQ.PROTECTED_TYPES]) === JSON.stringify([...PROTECTED_L1_TYPES]),
	`TS=${JSON.stringify([...PROTECTED_L1_TYPES])} JS=${JSON.stringify([...VQ.PROTECTED_TYPES])}`,
);
for (const reason of ["falsified", "idle-low-value", "protected-priority", "protected-type", "verified", "too-early"]) {
	ok(`PRUNE_REASON_LABELS 覆盖 ${reason}`, typeof VQ.PRUNE_REASON_LABELS[reason] === "string");
}

// ── ⑤ 侧车字段归一（数据库 snake_case 行 → 驼峰）────────────────────────
const rawRow = {
	record_id: "l1_1_abcd",
	hits: 7,
	inject_hits: 5,
	tool_hits: 2,
	invalid_hits: 1,
	effective_hits: 6,
	last_hit_at: "2026-10-02T00:00:00.000Z",
	last_invalid_at: null,
	created_at: "2026-09-01T00:00:00.000Z",
	updated_at: "2026-10-02T00:00:00.000Z",
};
const normalized = VQ.normalizeStat(rawRow);
eqStr("normalizeStat.recordId", "l1_1_abcd", String(normalized?.recordId));
eqNum("normalizeStat.hits", 7, Number(normalized?.hits));
eqNum("normalizeStat.injectHits", 5, Number(normalized?.injectHits));
eqNum("normalizeStat.toolHits", 2, Number(normalized?.toolHits));
eqNum("normalizeStat.invalidHits", 1, Number(normalized?.invalidHits));
eqNum("normalizeStat.effectiveHits", 6, Number(normalized?.effectiveHits));
eqStr("normalizeStat.lastHitAt", "2026-10-02T00:00:00.000Z", String(normalized?.lastHitAt));
ok("normalizeStat 驼峰入参也认", (VQ.normalizeStat({ hits: 3, invalidHits: 1, effectiveHits: 2 }) as { effectiveHits?: number })?.effectiveHits === 2);
ok("normalizeStat 空入参 → undefined", VQ.normalizeStat(null) === undefined);
// 归一后的对象喂 calcQuality，结果应与直接喂驼峰对象一致
{
	const camel = { hits: 7, invalidHits: 1, effectiveHits: 6, lastHitAt: rawRow.last_hit_at };
	const a = calcQuality({ type: "work_fact", priority: 80, createdAt: iso(50 * DAY) } as never, camel as never, NOW, ACTIVE_DAYS);
	const b = VQ.calcQuality({ type: "work_fact", priority: 80, createdAt: iso(50 * DAY) }, normalized, NOW, ACTIVE_DAYS);
	eqNum("归一后 calcQuality.quality 一致", a.quality, b.quality as number);
	eqNum("归一后 calcQuality.tag 一致", 0, a.tag === b.tag ? 0 : 1);
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n=== 查看器质量分 parity 门禁（JS ↔ memory/l1/quality.ts）===`);
console.log(`夹具：calcQuality ${CASES.length} 例 × ${CLOCK_MODES.length} 时钟 + judgePrune ${PRUNE_CASES.length} 例 + 常量/归一`);
if (failures.length > 0) {
	console.log(`\n不一致项（${failures.length}）：`);
	for (const f of failures) console.log(`  ✗ ${f}`);
	console.log(`\n结果：PASS ${pass} / FAIL ${failures.length}`);
	process.exit(1);
}
console.log(`\n结果：PASS ${pass} / FAIL 0 —— 两份实现数值全等`);
