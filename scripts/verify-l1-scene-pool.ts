#!/usr/bin/env node
// ============================================================================
// verify-l1-scene-pool.ts — L1 工作场景池回归基线
//
// 用法（本仓 `.ts` 不能用 `node` 直接跑：`agent/extensions/package.json` 是
// `"type": "commonjs"`，Node 22 会报 `Cannot use import statement outside a module`）：
//
//   C:/dev/ide/pi-agent/pi-0.80.10/node_modules/.bin/tsx scripts/verify-l1-scene-pool.ts
//
// 覆盖（2026-09-15 L1_SCENE_POOL 计划，取代旧 verify-scene-anchor.ts）：
//   A. 池内核：四分支解析 / 同批去重 / deleted 跳过 / mergedInto 链 / 注入排序截断 / 坏池降级
//   B. detectBatchCwd：尾部众数 / 缺 cwd 字段退化 / 坏分片跳过
//   C. buildL1Task：ScenePool 块形态、空池 `(无)`、变量契约（无残留占位符）
//   D. l1_commit 端到端（subagent）：canonical 覆写 / 新条目登记 / 中间字段剥离 /
//      未知 id 降级不阻断 / deleted 行不碰池 / sceneStats 自洽
//   E. l1_commit 端到端（main-agent）：cwd 匹配 / 显式名字不入池 / 零命中占位 + fallback 标记
//   F. stampRecordTimes：active 覆写双字段、标记行保留 createdAt、timestamps 不动
//
// 铁律：**只用临时目录**，绝不对真实 profile 调用会写盘的函数
//      （旧 verify-scene-anchor.ts 曾在真实 profile 上调 buildL1Task，污染了生产
//        `memoryDB/l1/anchor-log.jsonl` —— 该日志已退役，但教训保留）。
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildScenePoolLines,
	createSceneResolver,
	emptyPool,
	findMostRecentScene,
	findSceneByNameOrAlias,
	nextSceneId,
	readScenePool,
	resolveMergedTarget,
	scenePoolPath,
	SCENE_POOL_INJECT_LIMIT,
	writeScenePool,
	type ScenePool,
} from "../memory/l1/scene-pool.ts";
import { buildL1Task, detectBatchCwd } from "../memory/l1/config.ts";
import { registerL1CommitTool, stampRecordTimes } from "../memory/l1/commit-tool.ts";

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

const NOW = "2026-09-15T10:00:00.000Z";
const A = "C:/dev/alpha";
const B = "C:/dev/beta";
const root = mkdtempSync(join(tmpdir(), "scenepool-verify-"));
const dirs: string[] = [root];

/** 造一个临时 profile，可选写入 L0 分片与场景池。 */
function makeProfile(opts: { l0?: Record<string, unknown[]>; pool?: ScenePool } = {}): string {
	const p = mkdtempSync(join(tmpdir(), "scenepool-p-"));
	dirs.push(p);
	// memoryDB/ 必须先存在：跨进程写锁用 `mkdirSync(lockDir, {recursive:false})` 占位，
	// 上层目录缺失会直接拿不到锁（生产 profile 必然有，夹具需对齐）
	mkdirSync(join(p, "memoryDB", "l1"), { recursive: true });
	mkdirSync(join(p, "memoryDB", "pipeline"), { recursive: true });
	if (opts.l0) {
		const dir = join(p, "memoryDB", "l0", "conversations");
		mkdirSync(dir, { recursive: true });
		for (const [name, rows] of Object.entries(opts.l0)) {
			writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
		}
	}
	if (opts.pool) {
		writeFileSync(scenePoolPath(p), JSON.stringify(opts.pool, null, 2), "utf-8");
	}
	return p;
}

function l0Row(o: { cwd?: string; recordedAt?: string; content?: string }): Record<string, unknown> {
	return {
		sessionKey: "sess-1",
		recordedAt: o.recordedAt ?? "2026-09-15T09:00:00.000Z",
		id: null,
		role: "user",
		content: o.content ?? "继续推进",
		timestamp: 1789000000000,
		...(o.cwd ? { cwd: o.cwd } : {}),
	};
}

/** 读出某个 profile 的 L1 记录（所有分片展平）。 */
function readRecords(profilePath: string): Record<string, unknown>[] {
	const dir = join(profilePath, "memoryDB", "l1", "records");
	if (!existsSync(dir)) return [];
	const out: Record<string, unknown>[] = [];
	for (const f of readdirSync(dir)) {
		if (!/\.jsonl$/.test(f)) continue;
		for (const line of readFileSync(join(dir, f), "utf-8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line));
			} catch {
				// 坏行跳过
			}
		}
	}
	return out;
}

/** 捕获 l1_commit 的工具定义，返回可直接调用的 execute。 */
function captureCommitTool(profilePath: string) {
	let def: { execute: (...args: unknown[]) => Promise<unknown> } | null = null;
	registerL1CommitTool({ registerTool: (d: unknown) => (def = d as never) } as never, () => profilePath);
	if (!def) throw new Error("l1_commit 未注册");
	const ctx = {
		cwd: A,
		ui: { notify: () => {} },
		sessionManager: { getSessionFile: () => "C:/x/sess.jsonl", getSessionId: () => "sid-1" },
	};
	return async (params: Record<string, unknown>) => {
		const res = (await def!.execute("t1", params, undefined, undefined, ctx)) as { content: { text: string }[] };
		return JSON.parse(res.content[0].text) as Record<string, unknown>;
	};
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== A. 池内核：四分支解析 ===");
{
	const pool: ScenePool = { ...emptyPool(), updatedAt: NOW, scenes: [] };
	const r = createSceneResolver(pool, NOW);
	const created = r.resolve({ new_scene_name: "alpha｜合同流程", new_scene_reason: "新议题", cwd: A });
	check("新建：kind", created.kind === "created", created.kind);
	check("新建：id 格式 sc0001", created.scene_id === "sc0001", String(created.scene_id));
	check("新建：理由已记录", pool.scenes[0].newSceneReason === "新议题");
	check("新建：cwds 收入 A", pool.scenes[0].cwds.includes(A));

	const r2 = createSceneResolver(pool, NOW);
	const reused = r2.resolve({ scene_id: "sc0001", new_scene_name: "子代理乱填的名字", cwd: B });
	check("复用：kind", reused.kind === "reused", reused.kind);
	check("复用：canonical 覆写子代理所填", reused.scene_name === "alpha｜合同流程", reused.scene_name);
	check("复用：cwds 追加 B", pool.scenes[0].cwds.includes(B));

	const r3 = createSceneResolver(pool, NOW);
	const matched = r3.resolve({ new_scene_name: "  alpha｜合同流程  ", cwd: A });
	check("名字命中：不新建", matched.kind === "name-match" && pool.scenes.length === 1, matched.kind);

	const r4 = createSceneResolver(pool, NOW);
	const fb = r4.resolve({ scene_id: "sc9999", cwd: A });
	check("未知 id：降级 fallback", fb.kind === "fallback", fb.kind);
	check("未知 id：归入同 cwd 最近场景", fb.scene_name === "alpha｜合同流程", fb.scene_name);
	check("未知 id：给出 warn", typeof fb.warn === "string" && fb.warn.includes("sc9999"));
	check("未知 id：不抛错、stats.fallback=1", r4.stats().fallback === 1);

	// 同批同 id 只累加一次
	const before = pool.scenes[0].useCount;
	const r5 = createSceneResolver(pool, "2026-09-15T11:00:00.000Z");
	r5.resolve({ scene_id: "sc0001" });
	r5.resolve({ scene_id: "sc0001" });
	r5.resolve({ scene_id: "sc0001" });
	check("同批同 id 只 +1", pool.scenes[0].useCount === before + 1, `${before} → ${pool.scenes[0].useCount}`);
	check("同批 stats.reused=3", r5.stats().reused === 3);

	// 空池降级
	const e = emptyPool();
	check("空池 + 自填名 → 沿用", createSceneResolver(e, NOW).resolve({ scene_name: "自填" } as never).scene_name === "自填");
	const e2 = emptyPool();
	const emptyRes = createSceneResolver(e2, NOW).resolve({});
	check("空池 + 无自填名 → 占位", emptyRes.scene_name === "未分类场景", emptyRes.scene_name);
	check("空池 → scene_id 为 null", emptyRes.scene_id === null);
}

console.log("\n=== A2. mergedInto 链 + 注入排序/截断/窗口 ===");
{
	const p: ScenePool = { ...emptyPool(), updatedAt: NOW, scenes: [] };
	p.scenes.push(
		{ id: "sc0001", name: "甲", cwds: [A], aliases: [], mergedInto: "sc0002", origin: "seed", createdAt: NOW, lastUsedAt: NOW, useCount: 1 },
		{ id: "sc0002", name: "乙", cwds: [A], aliases: ["旧甲名"], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: NOW, useCount: 1 },
		{ id: "sc0003", name: "丙", cwds: [B], aliases: [], mergedInto: "sc0003", origin: "seed", createdAt: NOW, lastUsedAt: NOW, useCount: 1 },
	);
	check("合并链一跳跳转", resolveMergedTarget(p, "sc0001")?.name === "乙");
	check("自成环 → null", resolveMergedTarget(p, "sc0003") === null);
	check("被合并 id 解析到目标名", createSceneResolver(p, NOW).resolve({ scene_id: "sc0001" }).scene_name === "乙");
	check("别名命中（含合并跳转）", findSceneByNameOrAlias(p, "旧甲名")?.name === "乙");
	const lines = buildScenePoolLines(p, A);
	check("被合并条目不参与注入", lines.lines.every((l) => !l.includes("sc0001") && !l.includes("sc0003")), JSON.stringify(lines.lines));
	check("注入行格式 id | name", lines.lines[0] === "- sc0002 | 乙", lines.lines[0]);

	const p2: ScenePool = { ...emptyPool(), updatedAt: NOW, scenes: [] };
	p2.scenes.push(
		{ id: "sc0001", name: "旧", cwds: [A], aliases: [], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: "2026-01-01T00:00:00.000Z", useCount: 1 },
		{ id: "sc0002", name: "近B", cwds: [B], aliases: [], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: "2026-09-15T09:00:00.000Z", useCount: 1 },
		{ id: "sc0003", name: "近A", cwds: [A], aliases: [], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: "2026-09-14T09:00:00.000Z", useCount: 1 },
	);
	check("窗口外条目被剔除", buildScenePoolLines(p2, B).lines.length === 2);
	check("同 cwd 优先", buildScenePoolLines(p2, A).lines[0].includes("近A"));
	check("cwd 未知 → 纯 lastUsedAt 倒序", buildScenePoolLines(p2, "").lines[0].includes("近B"));
	check("findMostRecentScene 同 cwd 优先", findMostRecentScene(p2, A)?.name === "近A");

	const many: ScenePool = { ...emptyPool(), updatedAt: NOW, scenes: [] };
	for (let i = 1; i <= 50; i++) {
		many.scenes.push({
			id: nextSceneId(many),
			name: `场景${i}`,
			cwds: [A],
			aliases: [],
			mergedInto: null,
			origin: "seed",
			createdAt: NOW,
			lastUsedAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
			useCount: 1,
		});
	}
	const lm = buildScenePoolLines(many, A);
	check(`截断到上限 ${SCENE_POOL_INJECT_LIMIT}`, lm.shown === SCENE_POOL_INJECT_LIMIT && lm.eligible === 50, `${lm.shown}/${lm.eligible}`);
	check("id 4 位递增", many.scenes[49].id === "sc0050", many.scenes[49].id);
}

console.log("\n=== A3. 坏池降级 ===");
{
	const bad = mkdtempSync(join(tmpdir(), "scenepool-bad-"));
	dirs.push(bad);
	mkdirSync(join(bad, "memoryDB", "l1"), { recursive: true });
	check("池不存在 → 空池", readScenePool(bad).scenes.length === 0);
	writeFileSync(scenePoolPath(bad), "{ not json", "utf-8");
	check("坏 JSON → 空池", readScenePool(bad).scenes.length === 0);
	writeFileSync(scenePoolPath(bad), JSON.stringify({ version: 999, scenes: [{ id: "x", name: "y" }] }), "utf-8");
	check("未知 version → 空池", readScenePool(bad).scenes.length === 0);
	writeFileSync(scenePoolPath(bad), JSON.stringify({ version: 1, scenes: [{ id: "sc0001", name: "好" }, { bogus: 1 }, null] }), "utf-8");
	const mixed = readScenePool(bad);
	check("坏条目跳过、好条目保留", mixed.scenes.length === 1 && mixed.scenes[0].name === "好");
	check("缺字段补齐", Array.isArray(mixed.scenes[0].cwds) && mixed.scenes[0].mergedInto === null);
}

console.log("\n=== A4. 读写往返 ===");
{
	const p = mkdtempSync(join(tmpdir(), "scenepool-rw-"));
	dirs.push(p);
	const pool: ScenePool = { ...emptyPool(), updatedAt: NOW, scenes: [] };
	createSceneResolver(pool, NOW).resolve({ new_scene_name: "alpha｜X", cwd: A });
	check("写池成功", writeScenePool(p, pool));
	check("回读条目数", readScenePool(p).scenes.length === 1);
	check("tmp 不残留", !existsSync(join(p, "memoryDB", "l1", `.tmp_scenes_${Date.now()}`)));
	const raw = readFileSync(scenePoolPath(p), "utf-8");
	check("落盘为合法 JSON", (() => { try { JSON.parse(raw); return true; } catch { return false; } })());
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== B. detectBatchCwd ===");
{
	const p = makeProfile({
		l0: {
			"2026-09-15.jsonl": [l0Row({ cwd: A }), l0Row({ cwd: B }), l0Row({ cwd: B }), l0Row({ cwd: A }), l0Row({ cwd: B })],
		},
	});
	const files = [join(p, "memoryDB", "l0", "conversations", "2026-09-15.jsonl")];
	check("尾部众数 = B", detectBatchCwd(files) === B, detectBatchCwd(files));

	const noCwd = makeProfile({ l0: { "2026-09-15.jsonl": [l0Row({}), l0Row({})] } });
	check(
		"无 cwd 字段 → 空串（退化纯 lastUsedAt）",
		detectBatchCwd([join(noCwd, "memoryDB", "l0", "conversations", "2026-09-15.jsonl")]) === "",
	);
	check("文件不存在 → 空串", detectBatchCwd(["C:/nope/2026-09-15.jsonl"]) === "");

	// 最新分片整片缺 cwd → 回溯到前一个分片
	const multi = makeProfile({
		l0: {
			"2026-09-14.jsonl": [l0Row({ cwd: A }), l0Row({ cwd: A })],
			"2026-09-15.jsonl": [l0Row({}), l0Row({})],
		},
	});
	const md = join(multi, "memoryDB", "l0", "conversations");
	check("最新分片缺 cwd → 回溯前一档", detectBatchCwd([join(md, "2026-09-14.jsonl"), join(md, "2026-09-15.jsonl")]) === A);
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== C. buildL1Task 注入 ===");
{
	// 空池
	const p = makeProfile({ l0: { "2026-09-15.jsonl": [l0Row({ cwd: A })] } });
	const task = buildL1Task(p);
	check("有增量时返回任务消息", typeof task === "string" && task!.length > 0);
	check("空池输出 (无)", !!task && task.includes("ScenePool: (无)"));
	check("空池不输出块头（只有单行）", !!task && !task.includes("ScenePool (id | name"));
	check("无未展开占位符", !!task && !task.includes("{{"));
	check("不再出现锚点两行", !!task && !task.includes("PreviousScene") && !task.includes("RecentScenes"));

	// 有池：同项目优先
	const p2 = makePoolProfile();
	const task2 = buildL1Task(p2);
	check("有池时输出块头说明", !!task2 && task2.includes("ScenePool (id | name"), task2?.split("\n")[task2.split("\n").length - 3]);
	check("有池时列出条目", !!task2 && task2.includes("- sc0001 | alpha｜X"), task2?.split("\n").pop());
	check("条目行带 id", !!task2 && /^- sc\d{4} \| /m.test(task2));

	// 无增量 → null
	const p3 = makeProfile({});
	check("无 L0 增量 → null", buildL1Task(p3) === null);
}

function makePoolProfile(): string {
	const pool: ScenePool = { ...emptyPool(), updatedAt: NOW, scenes: [] };
	pool.scenes.push({
		id: "sc0001",
		name: "alpha｜X",
		cwds: [A],
		aliases: [],
		mergedInto: null,
		origin: "seed",
		createdAt: NOW,
		lastUsedAt: new Date().toISOString(),
		useCount: 1,
	});
	return makeProfile({ l0: { "2026-09-15.jsonl": [l0Row({ cwd: A })] }, pool });
}

// ══════════════════════════════════════════════════════════════
//  D–F 需要 await（l1_commit 的 execute 是异步的），而本仓 `.ts` 经 tsx 走 CJS 转换、
//  不支持顶层 await —— 故这几节收在一个 async main 里。
// ══════════════════════════════════════════════════════════════
async function main(): Promise<void> {
console.log("\n=== D. l1_commit 端到端（subagent 路径）===");
{
	const p = makeProfile({ l0: { "2026-09-15.jsonl": [l0Row({ cwd: A })] } });
	const commit = captureCommitTool(p);

	// D1 新建：登记条目 + 剥离中间字段
	const r1 = await commit({
		cursor: "2026-09-15T09:30:00.000Z",
		records: [{ content: "决策甲", type: "work_fact", priority: 80, new_scene_name: "alpha｜合同流程", new_scene_reason: "新议题", cwd: A }],
	});
	check("D1 提交成功", r1.success === true, JSON.stringify(r1).slice(0, 120));
	check("D1 sceneStats.created=1", (r1.sceneStats as { created: number })?.created === 1, JSON.stringify(r1.sceneStats));
	const pool1 = readScenePool(p);
	check("D1 池新增 1 条", pool1.scenes.length === 1, String(pool1.scenes.length));
	check("D1 条目名 = 稳定标签", pool1.scenes[0].name === "alpha｜合同流程", pool1.scenes[0].name);
	const rec1 = readRecords(p);
	check("D1 记录 scene_name 来自池", rec1[0].scene_name === "alpha｜合同流程", String(rec1[0].scene_name));
	check("D1 记录带 scene_id", rec1[0].scene_id === "sc0001", String(rec1[0].scene_id));
	check("D1 new_scene_name 未落盘", !("new_scene_name" in rec1[0]));
	check("D1 new_scene_reason 未落盘", !("new_scene_reason" in rec1[0]));

	// D2 复用：canonical 覆写子代理自填的名字
	const r2 = await commit({
		cursor: "2026-09-15T09:40:00.000Z",
		records: [{ content: "决策乙", type: "work_fact", priority: 70, scene_id: "sc0001", scene_name: "子代理手抄的错误名字", cwd: A }],
	});
	check("D2 reused=1", (r2.sceneStats as { reused: number })?.reused === 1);
	const rec2 = readRecords(p).filter((r) => r.content === "决策乙");
	check("D2 scene_name 被池覆写（非子代理所填）", rec2[0].scene_name === "alpha｜合同流程", String(rec2[0].scene_name));

	// D3 未知 id + 无名 → 降级不阻断
	const r3 = await commit({
		cursor: "2026-09-15T09:50:00.000Z",
		records: [{ content: "决策丙", type: "work_fact", priority: 60, scene_id: "sc9999", cwd: A }],
	});
	check("D3 仍 success（降级不阻断）", r3.success === true);
	check("D3 有 warn", Array.isArray(r3.sceneWarns) && (r3.sceneWarns as string[]).length === 1, JSON.stringify(r3.sceneWarns));
	check("D3 fallback=1", (r3.sceneStats as { fallback: number })?.fallback === 1);
	const rec3 = readRecords(p).filter((r) => r.content === "决策丙");
	check("D3 归入同 cwd 最近场景", rec3[0].scene_name === "alpha｜合同流程", String(rec3[0].scene_name));

	// D4 deleted 标记行不碰池
	const poolBefore = JSON.stringify(readScenePool(p));
	const r4 = await commit({
		cursor: "2026-09-15T10:00:00.000Z",
		records: [{ id: "l1_123_bogus", content: "作废标记", type: "work_fact", deleted: true, scene_id: "sc9999", cwd: A }],
	});
	check("D4 标记行不产生池变更", JSON.stringify(readScenePool(p)) === poolBefore);
	check("D4 标记行不计数", (r4.sceneStats as { fallback: number })?.fallback === 0, JSON.stringify(r4.sceneStats));

	// D5 新条目 id 递增、cwds 累积
	const r5 = await commit({
		cursor: "2026-09-15T10:10:00.000Z",
		records: [{ content: "决策丁", type: "work_fact", new_scene_name: "beta｜超时排查", new_scene_reason: "换议题了", cwd: B }],
	});
	check("D5 created=1", (r5.sceneStats as { created: number })?.created === 1);
	const pool5 = readScenePool(p);
	check("D5 新 id = sc0002", pool5.scenes.some((s) => s.id === "sc0002"), pool5.scenes.map((s) => s.id).join(","));
	check("D5 新条目 cwds = [B]", JSON.stringify(pool5.scenes.find((s) => s.id === "sc0002")?.cwds) === JSON.stringify([B]));
}

console.log("\n=== E. l1_commit 端到端（main-agent 路径）===");
{
	const p = makePoolProfile();
	const commit = captureCommitTool(p);

	// E1 未给名字 → 按 cwd 取池内最近条目
	const r1 = await commit({ source: "main-agent", records: [{ content: "主代理记录甲", type: "work_fact", cwd: A }] });
	check("E1 success", r1.success === true, JSON.stringify(r1).slice(0, 120));
	const rec1 = readRecords(p).filter((r) => r.content === "主代理记录甲");
	check("E1 场景取自池（同 cwd）", rec1[0].scene_name === "alpha｜X", String(rec1[0].scene_name));
	check("E1 带 scene_id", rec1[0].scene_id === "sc0001");
	check("E1 未标 fallback", r1.sceneNameFallback === false);

	// E2 显式名字命中池 → 用 canonical
	const r2 = await commit({ source: "main-agent", records: [{ content: "主代理记录乙", type: "work_fact", scene_name: "alpha｜X", cwd: A }] });
	check("E2 显式名字命中 → canonical + id", readRecords(p).filter((r) => r.content === "主代理记录乙")[0].scene_id === "sc0001");

	// E3 显式名字未命中 → 原样保留、不入池
	const poolBefore = readScenePool(p).scenes.length;
	await commit({ source: "main-agent", records: [{ content: "主代理记录丙", type: "work_fact", scene_name: "主代理自创的场景", cwd: A }] });
	const rec3 = readRecords(p).filter((r) => r.content === "主代理记录丙")[0];
	check("E3 未命中名字原样保留", rec3.scene_name === "主代理自创的场景", String(rec3.scene_name));
	check("E3 未命中不登记进池", readScenePool(p).scenes.length === poolBefore, `${poolBefore} → ${readScenePool(p).scenes.length}`);
	check("E3 未命中不带 scene_id", !("scene_id" in rec3) || !rec3.scene_id);

	// E4 池空 + 未给名字 → 占位 + fallback 标记
	const pEmpty = makeProfile({ pool: emptyPool() });
	const commitEmpty = captureCommitTool(pEmpty);
	const r4 = await commitEmpty({ source: "main-agent", records: [{ content: "孤立记录", type: "work_fact", cwd: "C:/nowhere" }] });
	check("E4 提交成功", r4.success === true, JSON.stringify(r4).slice(0, 120));
	check("E4 占位 main-agent-live", readRecords(pEmpty)[0]?.scene_name === "main-agent-live", String(readRecords(pEmpty)[0]?.scene_name));
	check("E4 标记 sceneNameFallback", r4.sceneNameFallback === true);
	check("E4 不推进游标（无 cursor 文件）", !existsSync(join(pEmpty, "memoryDB", "l1", "cursor.json")));
}

// ══════════════════════════════════════════════════════════════
console.log("\n=== F. stampRecordTimes ===");
{
	const now = "2026-09-15T12:00:00.000Z";
	const active: Record<string, unknown> = { timestamps: ["2026-01-01T00:00:00.000Z"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
	stampRecordTimes(active, false, now);
	check("active：createdAt 覆写", active.createdAt === now);
	check("active：updatedAt 覆写", active.updatedAt === now);
	check("active：timestamps 不动", JSON.stringify(active.timestamps) === JSON.stringify(["2026-01-01T00:00:00.000Z"]));

	const marker: Record<string, unknown> = { timestamps: ["2026-01-01T00:00:00.000Z"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
	stampRecordTimes(marker, true, now);
	check("标记行：createdAt 保留原值", marker.createdAt === "2026-01-01T00:00:00.000Z", String(marker.createdAt));
	check("标记行：updatedAt 更新", marker.updatedAt === now);

	const missing: Record<string, unknown> = {};
	stampRecordTimes(missing, true, now);
	check("标记行缺 createdAt → 补 now", missing.createdAt === now);
	const bad: Record<string, unknown> = { createdAt: "not-a-date" };
	stampRecordTimes(bad, true, now);
	check("标记行不可解析 → 补 now", bad.createdAt === now);
}

// ══════════════════════════════════════════════════════════════
for (const d of dirs) {
	try {
		rmSync(d, { recursive: true, force: true });
	} catch {
		// 清理失败不影响结论
	}
}
console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
}

void main();
