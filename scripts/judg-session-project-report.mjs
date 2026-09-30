#!/usr/bin/env node
// ============================================================================
// judg-session-project-report.mjs — 会话级项目归属判定的只读报告
//
// 用法：node scripts/judg-session-project-report.mjs [profilePath]
//   （不带参数 = 默认 profile；只读，不写任何文件）
//
// 报什么、为什么报这几项：
//   · 条目数 / flag 分布 / decidedBy 分布        —— 判定到底跑没跑
//   · confidence 直方图                          —— **不是模型置信度**，且 LLM 可能选的并非 top1
//   · 判定失败次数                               —— 一等指标（对应计划的 B12：周配额 429 / 网络）
//   · 最近一次判定时间                           —— 「没有消费者的数据文件会停更」要变成可见的
//   · 陈旧度                                     —— 多久没更新
//   · project 目录已不存在的条目数               —— B21：保留条目不删，但消费侧要能发现
//   · L1 落盘的 projectSource 分布 + 与判定值的一致性核对
//   · fallback 占比，且**区分"尚未判定"与"判定为无"**（B20）
//
// ⚠ **cwd 语义断层**：2026-09-30 之前落盘的 L1 记录，cwd = 会话工作台；之后的 = 项目目录。
//   报告里凡按 cwd 统计的地方都标了口径，别把两段混在一起看。
// ============================================================================
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_HOME = process.env.PI_AGENT_HOME ?? join(homedir(), ".pi", "agent");
const PROFILE = process.argv[2] ?? process.env.PI_PROFILE_PATH ?? join(AGENT_HOME, "profiles", "default");
const DB = join(PROFILE, "memoryDB");
const JUDG_FILE = join(DB, "state", "judg-session-project.json");
const RECORDS_DIR = join(DB, "l1", "records");
const LOG_FILE = join(DB, "logs", "judg.log");

/** 本功能上线日期：早于它的 L1 记录 cwd 是「会话工作台」而不是「项目」。 */
const SEMANTIC_CUTOVER = "2026-09-30";

const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");
const dist = (map) => {
	const total = [...map.values()].reduce((a, b) => a + b, 0);
	return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v} (${pct(v, total)})`).join("  ") || "(空)";
};

function main() {
	console.log(`profile : ${PROFILE}`);
	console.log(`判定文件 : ${JUDG_FILE}`);

	// ── 1. 判定文件本身 ──
	if (!existsSync(JUDG_FILE)) {
		console.log("\n⚠ 判定文件还不存在 —— 判定从未落过盘。");
		console.log("  可能原因：① 还没跑过一次 agent_settled ② profile 路径不对 ③ 扩展没 /reload");
		return;
	}
	let judg;
	try {
		judg = JSON.parse(readFileSync(JUDG_FILE, "utf-8"));
	} catch (e) {
		console.log(`\n✗ 判定文件解析失败：${e.message}`);
		console.log("  读写层遇到解析失败会**拒绝覆盖**，所以原文件仍在，但本报告读不了。");
		return;
	}
	const sessions = Object.entries(judg.sessions ?? {});
	console.log(`\n=== 1. 条目概览 ===`);
	console.log(`version    : ${judg.version}（期望 3）`);
	console.log(`updatedAt  : ${judg.updatedAt || "(无)"}`);
	console.log(`条目数     : ${sessions.length}`);
	if (sessions.length === 0) {
		console.log("\n⚠ 一个条目都没有。判定只对**正在使用的会话**生效，历史会话不补。");
		return;
	}

	const flagMap = new Map();
	const decidedMap = new Map();
	for (const [, e] of sessions) {
		flagMap.set(String(e.flag), (flagMap.get(String(e.flag)) ?? 0) + 1);
		decidedMap.set(String(e.decidedBy), (decidedMap.get(String(e.decidedBy)) ?? 0) + 1);
	}
	const usable = sessions.filter(([, e]) => e.flag === true).length;
	console.log(`flag 分布  : ${dist(flagMap)}`);
	console.log(`decidedBy : ${dist(decidedMap)}`);
	console.log(`可用条目  : ${usable}/${sessions.length} = ${pct(usable, sessions.length)}（flag:false ⇒ l1_commit 退回会话工作台）`);

	// ── 2. confidence 直方图（附两条免责）──
	console.log(`\n=== 2. 证据集中度直方图 ===`);
	console.log("⚠ 它是 **top 候选的文件占比**（证据集中度），不是模型自报的置信度。");
	console.log("⚠ LLM 选的**可能不是 top1**（尺子 #20 就是），此时该值描述的是它**没选**的那条。");
	const buckets = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]];
	for (const [lo, hi] of buckets) {
		const n = sessions.filter(([, e]) => typeof e.confidence === "number" && e.confidence >= lo && e.confidence < hi).length;
		const bar = "█".repeat(Math.round((n / sessions.length) * 40));
		console.log(`  ${(lo * 100).toFixed(0).padStart(3)}–${(hi * 100).toFixed(0).padStart(3)}%  ${String(n).padStart(4)}  ${bar}`);
	}

	// ── 3. 判定失败次数（一等指标）──
	console.log(`\n=== 3. 判定失败次数（对应计划 B12：网络 / 429 周配额 / 模型 id 改名）===`);
	let failures = 0;
	let lastFail = "";
	if (existsSync(LOG_FILE)) {
		const lines = readFileSync(LOG_FILE, "utf-8").split("\n").filter((l) => l.includes("判定失败") || l.includes("判定异常"));
		failures = lines.length;
		lastFail = lines[lines.length - 1] ?? "";
	}
	console.log(`失败条数   : ${failures}${failures > 0 ? "  ⚠ 有失败，判定可能长期停在初值" : ""}`);
	if (lastFail) console.log(`最近一条   : ${lastFail.slice(0, 160)}`);
	if (!existsSync(LOG_FILE)) console.log(`（日志文件还没有：${LOG_FILE}）—— 没有它就看不到失败，只能看到"值不变"`);

	// ── 4. 陈旧度 + project 目录是否还在 ──
	console.log(`\n=== 4. 新鲜度与目录存续 ===`);
	const times = sessions.map(([, e]) => Date.parse(e.at ?? "")).filter((t) => !Number.isNaN(t));
	if (times.length > 0) {
		const last = Math.max(...times);
		const hours = (Date.now() - last) / 3_600_000;
		console.log(`最近一次判定 : ${new Date(last).toISOString()}（${hours.toFixed(1)} 小时前）`);
		if (hours > 72) console.log("  ⚠ 超过 3 天没更新。**没有消费者的数据文件就是这样腐烂的** —— 不是变错，是没人知道它停了。");
	}
	const gone = sessions.filter(([, e]) => e.flag === true && !existsSync(String(e.project ?? "")));
	console.log(`project 目录已不存在 : ${gone.length} 条（B21：条目保留不删，消费侧遇到不存在的目录按 flag:false 处理）`);
	for (const [k, e] of gone.slice(0, 5)) console.log(`    ${k.slice(0, 26)}… → ${e.project}`);

	// ── 5. L1 落盘侧核对 ──
	console.log(`\n=== 5. L1 落盘侧（metadata.projectSource）===`);
	if (!existsSync(RECORDS_DIR)) {
		console.log("（还没有 L1 记录分片）");
		return;
	}
	const srcMap = new Map();
	let total = 0;
	let fallback = 0;
	let mismatched = 0;
	const judgByKey = new Map(sessions);
	for (const f of readdirSync(RECORDS_DIR).filter((x) => x.endsWith(".jsonl")).sort()) {
		for (const line of readFileSync(join(RECORDS_DIR, f), "utf-8").split("\n")) {
			if (!line.trim()) continue;
			let o;
			try { o = JSON.parse(line); } catch { continue; }
			if (o.deleted === true) continue;
			total++;
			const src = String(o?.metadata?.projectSource ?? "(无)");
			srcMap.set(src, (srcMap.get(src) ?? 0) + 1);
			if (src === "fallback") fallback++;
			// 一致性核对：projectSource != fallback 时，落盘 cwd 应当等于判定出的 project
			if (src !== "fallback" && src !== "(无)") {
				const e = judgByKey.get(String(o.sessionKey ?? ""));
				if (e && e.flag === true && String(o.cwd ?? "") !== e.project) mismatched++;
			}
		}
	}
	console.log(`存活记录数 : ${total}`);
	console.log(`分布       : ${dist(srcMap)}`);
	console.log(`fallback 占比 : ${pct(fallback, total)}  ← 这是"新机制没覆盖到"的直接度量`);
	console.log(`  ⚠ fallback 里混着两种情况，报告刻意不合并：` +
		`「尚未判定过」与「判定了但结果是 flag:false（无项目）」。要看区分得看 ${LOG_FILE}。`);
	console.log(`与判定值不一致 : ${mismatched} 条（projectSource 非 fallback 却与 judg 文件对不上）`);

	// ── 6. cwd 语义断层提醒 ──
	console.log(`\n=== 6. cwd 语义断层（${SEMANTIC_CUTOVER}）===`);
	console.log(`本功能上线**之前**落盘的记录，cwd = 会话工作台（pi 从哪启动）；**之后** = 项目目录。`);
	console.log(`两者混在一起按 cwd 做统计/聚类会得到错误结论。做聚合前先按分片日期分段看。`);
	try {
		const files = readdirSync(RECORDS_DIR).filter((x) => x.endsWith(".jsonl")).sort();
		const pre = files.filter((f) => f.slice(0, 10) < SEMANTIC_CUTOVER);
		const post = files.filter((f) => f.slice(0, 10) >= SEMANTIC_CUTOVER);
		const bytes = (list) => list.reduce((s, f) => s + statSync(join(RECORDS_DIR, f)).size, 0);
		console.log(`上线前分片 ${pre.length} 个（${(bytes(pre) / 1024).toFixed(0)} KB） / 上线后 ${post.length} 个（${(bytes(post) / 1024).toFixed(0)} KB）`);
	} catch {
		// 分片读取失败不影响主结论
	}
	console.log(`\n口径提醒：${SEMANTIC_CUTOVER} 之前的分片与场景池里的 cwds 一律是旧语义。`);
}

main();
