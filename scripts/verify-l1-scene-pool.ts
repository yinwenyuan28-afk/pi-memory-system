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
//      未知 id 降级不阻断 / deleted 行不碰池 / sceneStats 自洽 /
//      **cwds 登记的是记录自填的工作台（不是判定出的项目）** —— 2026-09-30 撤回 cwd 覆写后的口径
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
	cwdCompareKey,
	cwdsInclude,
	emptyPool,
	findMostRecentScene,
	findSceneByNameOrAlias,
	nextSceneId,
	projectOf,
	readScenePool,
	resolveMergedTarget,
	scenePoolPath,
	selectScenePoolEntries,
	SCENE_POOL_INJECT_LIMIT,
	writeScenePool,
	type ScenePool,
} from "../memory/l1/scene-pool.ts";
import { buildL1Task, detectBatchCwd, detectBatchProject } from "../memory/l1/config.ts";
import { registerL1CommitTool, stampRecordTimes } from "../memory/l1/commit-tool.ts";
import { registerListL1ScenesTool } from "../memory/l1/scene-tool.ts";
import { readL0Increment } from "../memory/l1/read-tool.ts";
import { upsertSessionJudg } from "../util/judg-session-project/index.ts";
import { saveAppSection } from "../config/app-config.ts";

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
	// 本套只验证场景/游标提交，不调用价值校验模型。
	saveAppSection(p, "l1", { mode: "code", valueCheck: { enabled: false } });
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
	// 2026-09-15 L1_PROJECT_SIGNAL：降级**不再猜**"同 cwd 最近场景"，直接落未归类
	check("未知 id：落未归类（不猜同 cwd 场景）", fb.scene_name === "未分类场景" && fb.scene_id === null, fb.scene_name);
	check("未知 id：给出 warn 且提示挑 id/给新名", typeof fb.warn === "string" && fb.warn.includes("sc9999") && fb.warn.includes("未归类"), fb.warn);
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

console.log("\n=== A1. cwd 比较归一化（2026-09-30）===");
{
	// 纯函数层
	check("反斜杠 → 正斜杠", cwdCompareKey("C:\\a\\b") === "c:/a/b", cwdCompareKey("C:\\a\\b"));
	check("大小写不敏感", cwdCompareKey("C:/Users/Leaf/.pi") === cwdCompareKey("c:\\users\\leaf\\.pi"), cwdCompareKey("C:/Users/Leaf/.pi"));
	check("尾部斜杠被去", cwdCompareKey("C:/a/b/") === "c:/a/b", cwdCompareKey("C:/a/b/"));
	check("盘符根不被去成 c:", cwdCompareKey("C:\\") === "c:/", cwdCompareKey("C:\\"));
	check("成对引号被剥", cwdCompareKey('  "C:/a/b" ') === "c:/a/b", cwdCompareKey('  "C:/a/b" '));
	check("空串安全", cwdCompareKey("") === "" && cwdCompareKey("   ") === "");

	// 池层：addCwd 不得因写法不同而重复登记（盘上 sc0024 已双写同一个目录）
	const pool: ScenePool = { ...emptyPool(), updatedAt: NOW, scenes: [] };
	const r = createSceneResolver(pool, NOW);
	r.resolve({ new_scene_name: "α｜X", new_scene_reason: "理由", cwd: "C:\\Users\\leaf\\.pi" });
	const r2 = createSceneResolver(pool, NOW);
	r2.resolve({ scene_id: "sc0001", cwd: "C:/Users/leaf/.pi/" });
	r2.resolve({ scene_id: "sc0001", cwd: '  "c:\\USERS\\leaf\\.PI"  ' });
	check("addCwd：三种写法只登记一次", pool.scenes[0].cwds.length === 1, JSON.stringify(pool.scenes[0].cwds));
	check("addCwd：存的是原字符串（不改字段语义）", pool.scenes[0].cwds[0] === "C:\\Users\\leaf\\.pi", pool.scenes[0].cwds[0]);

	// findMostRecentScene：同 cwd 必须能匹配到（否则退化成"全局最近"）
	const p2: ScenePool = {
		...emptyPool(),
		updatedAt: NOW,
		scenes: [
			{ id: "sc0001", name: "旧｜X", cwds: ["C:/dev/alpha"], aliases: [], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: "2026-01-01T00:00:00.000Z", useCount: 1 },
			{ id: "sc0002", name: "新｜Y", cwds: ["C:\\dev\\beta"], aliases: [], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: NOW, useCount: 1 },
		],
	};
	const hit = findMostRecentScene(p2, "C:/dev/beta");
	check("findMostRecentScene：反斜杠写法也能命中同 cwd", hit?.id === "sc0002", hit?.id ?? "null");

	// buildScenePoolLines：同 cwd 优先不能因为斜杠风格而失效
	// （两个 lastUsedAt 都必须落在 60 天注入窗口内 —— 窗口用的是 Date.now()，不是 NOW）
	p2.scenes[0].lastUsedAt = "2026-09-14T09:00:00.000Z";
	const lines = buildScenePoolLines(p2, { batchCwd: "C:\\dev\\alpha" });
	check("buildScenePoolLines：同 cwd 优先命中 sc0001", lines.lines[0]?.startsWith("- sc0001 "), lines.lines[0] ?? "(空)");
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
	const lines = buildScenePoolLines(p, { batchCwd: A });
	check("被合并条目不参与注入", lines.lines.every((l) => !l.includes("sc0001") && !l.includes("sc0003")), JSON.stringify(lines.lines));
	check("注入行格式 id | name", lines.lines[0] === "- sc0002 | 乙", lines.lines[0]);

	const p2: ScenePool = { ...emptyPool(), updatedAt: NOW, scenes: [] };
	p2.scenes.push(
		{ id: "sc0001", name: "旧", cwds: [A], aliases: [], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: "2026-01-01T00:00:00.000Z", useCount: 1 },
		{ id: "sc0002", name: "近B", cwds: [B], aliases: [], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: "2026-09-15T09:00:00.000Z", useCount: 1 },
		{ id: "sc0003", name: "近A", cwds: [A], aliases: [], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: "2026-09-14T09:00:00.000Z", useCount: 1 },
	);
	check("窗口外条目被剔除", buildScenePoolLines(p2, { batchCwd: B }).lines.length === 2);
	check("同 cwd 优先", buildScenePoolLines(p2, { batchCwd: A }).lines[0].includes("近A"));
	check("cwd 未知 → 纯 lastUsedAt 倒序", buildScenePoolLines(p2, {}).lines[0].includes("近B"));
	check("selectScenePoolEntries 与 lines 同源", selectScenePoolEntries(p2, { batchCwd: A })[0].name === "近A");

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
	const lm = buildScenePoolLines(many, { batchCwd: A });
	check(`截断到上限 ${SCENE_POOL_INJECT_LIMIT}`, lm.shown === SCENE_POOL_INJECT_LIMIT && lm.eligible === 50, `${lm.shown}/${lm.eligible}`);
	check("id 4 位递增", many.scenes[49].id === "sc0050", many.scenes[49].id);
}

console.log("\n=== A5. projectOf（项目前缀，取代 cwd 当项目）===");
{
	const mk = (name: string) => ({ id: "sc0001", name, cwds: [], aliases: [], mergedInto: null, origin: "seed" as const, createdAt: NOW, lastUsedAt: NOW, useCount: 1 });
	check("标准标签取前缀", projectOf(mk("memory-system｜L1 场景池")) === "memory-system", projectOf(mk("memory-system｜L1 场景池")));
	check("前缀去空白", projectOf(mk("memory - system ｜X")) === "memory-system", projectOf(mk("memory - system ｜X")));
	check("前缀去尾部「扩展」", projectOf(mk("memory-system 扩展｜X")) === "memory-system", projectOf(mk("memory-system 扩展｜X")));
	check("无 ｜ → 空串", projectOf(mk("团队在围绕某议题推进")) === "");
	check("｜ 在首位 → 空串", projectOf(mk("｜没有项目")) === "");

	// 排序：项目命中优先于同 cwd
	const pp: ScenePool = { ...emptyPool(), updatedAt: NOW, scenes: [] };
	pp.scenes.push(
		{ id: "sc0001", name: "alpha｜X", cwds: [A], aliases: [], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: "2026-09-15T09:00:00.000Z", useCount: 1 },
		{ id: "sc0002", name: "beta｜Y", cwds: [A], aliases: [], mergedInto: null, origin: "seed", createdAt: NOW, lastUsedAt: "2026-09-14T09:00:00.000Z", useCount: 1 },
	);
	const onlyRecent = buildScenePoolLines(pp, { batchCwd: A });
	check("无 batchProject 时最近的在前", onlyRecent.lines[0].includes("sc0001"), onlyRecent.lines[0]);
	const byProject = buildScenePoolLines(pp, { batchCwd: A, batchProject: "beta" });
	check("batchProject 命中项排最前（压过同 cwd）", byProject.lines[0].includes("sc0002"), byProject.lines[0]);
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
		cursor: JSON.stringify({ version: 2, files: {} }),
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
		cursor: JSON.stringify({ version: 2, files: {} }),
		records: [{ content: "决策乙", type: "work_fact", priority: 70, scene_id: "sc0001", scene_name: "子代理手抄的错误名字", cwd: A }],
	});
	check("D2 reused=1", (r2.sceneStats as { reused: number })?.reused === 1);
	const rec2 = readRecords(p).filter((r) => r.content === "决策乙");
	check("D2 scene_name 被池覆写（非子代理所填）", rec2[0].scene_name === "alpha｜合同流程", String(rec2[0].scene_name));

	// D3 未知 id + 无名 → 未归类（**不再猜"同 cwd 最近场景"**，2026-09-15 L1_PROJECT_SIGNAL）
	const r3 = await commit({
		cursor: JSON.stringify({ version: 2, files: {} }),
		records: [{ content: "决策丙", type: "work_fact", priority: 60, scene_id: "sc9999", cwd: A }],
	});
	check("D3 仍 success（降级不阻断）", r3.success === true);
	check("D3 有 warn", Array.isArray(r3.sceneWarns) && (r3.sceneWarns as string[]).length === 1, JSON.stringify(r3.sceneWarns));
	check("D3 fallback=1", (r3.sceneStats as { fallback: number })?.fallback === 1);
	const rec3 = readRecords(p).filter((r) => r.content === "决策丙");
	check("D3 落未归类（不采用池内同 cwd 条目）", rec3[0].scene_name === "未分类场景", String(rec3[0].scene_name));
	check("D3 不带 scene_id", !rec3[0].scene_id);
	check("D3 metadata.sceneFallback 已落盘", (rec3[0].metadata as Record<string, unknown> | undefined)?.sceneFallback === true, JSON.stringify(rec3[0].metadata));

	// D4 deleted 标记行不碰池
	const poolBefore = JSON.stringify(readScenePool(p));
	const r4 = await commit({
		cursor: JSON.stringify({ version: 2, files: {} }),
		records: [{ id: "l1_123_bogus", content: "作废标记", type: "work_fact", deleted: true, scene_id: "sc9999", cwd: A }],
	});
	check("D4 标记行不产生池变更", JSON.stringify(readScenePool(p)) === poolBefore);
	check("D4 标记行不计数", (r4.sceneStats as { fallback: number })?.fallback === 0, JSON.stringify(r4.sceneStats));

	// D5 新条目 id 递增、cwds 累积
	// ⚠ 2026-09-30 第二次夹具改造（撤回 cwd 覆写之后）：
	//   `l1_commit` 现在**不改写 `r.cwd`** —— cwd 是「会话工作台」，判定出的项目另走 `metadata.project`。
	//   所以 `addCwd(entry, r.cwd)` 拿到的就是**记录自填的工作台**，场景池与读侧
	//   `rankCwd`（比的是 `batchCwd` = L0 消息 cwd 众数 = 同样是工作台）口径重新对齐。
	//   这里刻意让「记录自填的工作台」(`WB`)、「判定出的项目」(`B`)、「ctx.cwd / batchCwd」(`A`)
	//   三者互不相同，这样"登记的是哪一个"一旦写错立刻变红，不会出现三值同源的假绿。
	const WB = "C:/workbench/d5";
	upsertSessionJudg(p, "sess-d5", { project: B, flag: true, decidedBy: "llm", confidence: 0.8, evidence: [{ path: B, filesTouched: 3 }] });
	const r5 = await commit({
		cursor: JSON.stringify({ version: 2, files: {} }),
		records: [{ content: "决策丁", type: "work_fact", sessionKey: "sess-d5", new_scene_name: "beta｜超时排查", new_scene_reason: "换议题了", cwd: WB, metadata: { scope: "self" } }],
	});
	check("D5 created=1", (r5.sceneStats as { created: number })?.created === 1);
	const pool5 = readScenePool(p);
	check("D5 新 id = sc0002（承接 D1 的 sc0001）", pool5.scenes.some((s) => s.id === "sc0002"), pool5.scenes.map((s) => s.id).join(","));
	check("D5 新条目 cwds = [记录自填的工作台]，不是判定出的项目", JSON.stringify(pool5.scenes.find((s) => s.id === "sc0002")?.cwds) === JSON.stringify([WB]), JSON.stringify(pool5.scenes.find((s) => s.id === "sc0002")?.cwds));
	const rec5 = readRecords(p).filter((r) => r.content === "决策丁")[0];
	check("D5 记录 cwd 原样保留工作台（不被项目覆写）", rec5.cwd === WB, String(rec5.cwd));
	check("D5 判定出的项目只落进 metadata.project", (rec5.metadata as Record<string, unknown> | undefined)?.project === B, JSON.stringify(rec5.metadata));
	check("D5 metadata.projectSource = llm", (rec5.metadata as Record<string, unknown> | undefined)?.projectSource === "llm", JSON.stringify(rec5.metadata));

	// D5b 场景池读写口径自洽（撤回覆写的**收益**所在，同项目不同工作台不会散）
	//   ① 同一场景、不同工作台 → cwds **追加**而非替换（不会互相顶掉）
	//   ② 读侧 `rankCwd` 比的是 batchCwd（= L0 消息 cwd 众数 = 工作台），命中 → 排到最前
	//   ③ 项目路径（B）**从不**登记进 cwds ⇒ 用项目路径当 batchCwd 不再能"命中同 cwd"
	await commit({
		cursor: JSON.stringify({ version: 2, files: {} }),
		records: [{ content: "决策丁2", type: "work_fact", sessionKey: "sess-d5", scene_id: "sc0002", cwd: A }],
	});
	const pool5b = readScenePool(p);
	const cwds5b = pool5b.scenes.find((s) => s.id === "sc0002")?.cwds ?? [];
	check("D5b 同场景不同工作台 → cwds 累积两条（不替换、不散开）", JSON.stringify(cwds5b) === JSON.stringify([WB, A]), JSON.stringify(cwds5b));
	check("D5b 工作台批次 → 同 cwd 优先命中该条目", buildScenePoolLines(pool5b, { batchCwd: A }).lines[0] === "- sc0002 | beta｜超时排查", buildScenePoolLines(pool5b, { batchCwd: A }).lines.join(" | "));
	check("D5b 项目路径当 batchCwd → 不再被 cwds 命中（写侧不再塞项目，读侧才敢按工作台比）", !cwdsInclude(cwds5b, B), JSON.stringify(cwds5b));
	check("D5b findMostRecentScene 按工作台命中", findMostRecentScene(pool5b, A)?.id === "sc0002", findMostRecentScene(pool5b, A)?.id ?? "null");

	// D6 无判定条目 ⇒ metadata.project 空串 + projectSource=fallback；cwd 仍原样保留自填值
	const WB6 = "C:/workbench/d6";
	const r6 = await commit({
		cursor: JSON.stringify({ version: 2, files: {} }),
		records: [{ content: "决策戊", type: "work_fact", sessionKey: "sess-d6-无条目", new_scene_name: "beta｜兜底", new_scene_reason: "无判定", cwd: WB6 }],
	});
	const rec6 = readRecords(p).filter((r) => r.content === "决策戊")[0];
	check("D6 无条目 → cwd 原样保留自填工作台（不退回 ctx.cwd）", rec6.cwd === WB6, String(rec6.cwd));
	check("D6 无条目 → metadata.project 为空串（判定不可用不猜）", (rec6.metadata as Record<string, unknown> | undefined)?.project === "", JSON.stringify(rec6.metadata?.project));
	check("D6 metadata.projectSource = fallback", (rec6.metadata as Record<string, unknown> | undefined)?.projectSource === "fallback", JSON.stringify(rec6.metadata));
	// D6b cwd 缺字段 ⇒ **唯一**的兜底：填会话工作台 ctx.cwd（A），并登记进池
	const r6b = await commit({
		cursor: JSON.stringify({ version: 2, files: {} }),
		records: [{ content: "决策己", type: "work_fact", sessionKey: "sess-d6-无条目", new_scene_name: "beta｜无 cwd", new_scene_reason: "缺 cwd" }],
	});
	const rec6b = readRecords(p).filter((r) => r.content === "决策己")[0];
	check("D6b cwd 缺字段 → 兜底填 ctx.cwd（A）", rec6b.cwd === A, String(rec6b.cwd));
	check("D6b 兜底出的工作台同样登记进池", JSON.stringify(readScenePool(p).scenes.find((s) => s.name === "beta｜无 cwd")?.cwds) === JSON.stringify([A]), JSON.stringify(readScenePool(p).scenes.find((s) => s.name === "beta｜无 cwd")?.cwds));
	const poolBeforeEmpty = JSON.stringify(readScenePool(p));
	const checkpoint = { version: 2, files: { "2026-09-15.jsonl": 123 } };
	const emptyCommit = await commit({ cursor: JSON.stringify(checkpoint), records: [] });
	check("D7 空记忆批次成功提交", emptyCommit.success === true && emptyCommit.written === 0);
	check("D7 空批保存完整分片游标", JSON.stringify(JSON.parse(readFileSync(join(p, "memoryDB", "l1", "cursor.json"), "utf-8"))) === JSON.stringify(checkpoint));
	check("D7 空批不创建或修改场景", JSON.stringify(readScenePool(p)) === poolBeforeEmpty);
}

console.log("\n=== E. l1_commit 端到端（main-agent 路径）===");
{
	const p = makePoolProfile();
	const commit = captureCommitTool(p);

	// E1 **反例：不再猜场景**——池里有同 cwd 条目，但本记录没给任何场景标识 → 必须未归类
	const r1 = await commit({ source: "main-agent", records: [{ content: "主代理记录甲", type: "work_fact", cwd: A }] });
	check("E1 success", r1.success === true, JSON.stringify(r1).slice(0, 120));
	const rec1 = readRecords(p).filter((r) => r.content === "主代理记录甲")[0];
	check("E1 落占位而非池内同 cwd 条目", rec1.scene_name === "main-agent-live", String(rec1.scene_name));
	check("E1 不带 scene_id", !rec1.scene_id);
	check("E1 metadata.sceneFallback 已落盘", (rec1.metadata as Record<string, unknown> | undefined)?.sceneFallback === true);
	check("E1 返回体标 sceneNameFallback", r1.sceneNameFallback === true);
	check("E1 返回体含 sceneHint 引导先查清单", typeof r1.sceneHint === "string" && (r1.sceneHint as string).includes("list_l1_scenes"), String(r1.sceneHint));

	// E2 给 scene_id（先查清单得到）→ 用池 canonical，且不落 fallback 标记
	const r2 = await commit({ source: "main-agent", records: [{ content: "主代理记录乙", type: "work_fact", scene_id: "sc0001", cwd: A }] });
	const rec2 = readRecords(p).filter((r) => r.content === "主代理记录乙")[0];
	check("E2 scene_id → 池 canonical 名", rec2.scene_name === "alpha｜X", String(rec2.scene_name));
	check("E2 带 scene_id", rec2.scene_id === "sc0001");
	check("E2 不标 fallback", r2.sceneNameFallback === false && !(rec2.metadata as Record<string, unknown>)?.sceneFallback);

	// E3 显式名字命中池 → 用 canonical + id
	await commit({ source: "main-agent", records: [{ content: "主代理记录丙", type: "work_fact", scene_name: "alpha｜X", cwd: A }] });
	const rec3 = readRecords(p).filter((r) => r.content === "主代理记录丙")[0];
	check("E3 显式名字命中 → canonical + id", rec3.scene_name === "alpha｜X" && rec3.scene_id === "sc0001");

	// E4 显式名字未命中 → 原样保留、不入池
	const poolBefore = readScenePool(p).scenes.length;
	const r4 = await commit({ source: "main-agent", records: [{ content: "主代理记录丁", type: "work_fact", scene_name: "主代理自创的场景", cwd: A }] });
	const rec4 = readRecords(p).filter((r) => r.content === "主代理记录丁")[0];
	check("E4 未命中名字原样保留", rec4.scene_name === "主代理自创的场景", String(rec4.scene_name));
	check("E4 未命中不登记进池", readScenePool(p).scenes.length === poolBefore, `${poolBefore} → ${readScenePool(p).scenes.length}`);
	check("E4 未命中不带 scene_id", !rec4.scene_id);
	check("E4 未命中不算未归类（有名字）", r4.sceneFallback === undefined || r4.sceneHint === undefined);

	// E5 池空 + 未给 → 占位 + 标记；且 main-agent 不推进游标
	const pEmpty = makeProfile({ pool: emptyPool() });
	const commitEmpty = captureCommitTool(pEmpty);
	const r5 = await commitEmpty({ source: "main-agent", records: [{ content: "孤立记录", type: "work_fact", cwd: "C:/nowhere" }] });
	check("E5 提交成功", r5.success === true, JSON.stringify(r5).slice(0, 120));
	check("E5 占位 main-agent-live", readRecords(pEmpty)[0]?.scene_name === "main-agent-live", String(readRecords(pEmpty)[0]?.scene_name));
	check("E5 标记 sceneNameFallback", r5.sceneNameFallback === true);
	check("E5 不推进游标（无 cursor 文件）", !existsSync(join(pEmpty, "memoryDB", "l1", "cursor.json")));
}

console.log("\n=== F. list_l1_scenes 工具 ===");
{
	const p = makePoolProfile();
	let def: { execute: (...args: unknown[]) => Promise<unknown> } | null = null;
	registerListL1ScenesTool({ registerTool: (d: unknown) => (def = d as never) } as never, () => p);
	check("工具已注册", !!def);
	const before = readFileSync(scenePoolPath(p), "utf-8");
	const res = (await def!.execute()) as { content: { text: string }[] };
	const body = JSON.parse(res.content[0].text) as { scenes: Record<string, unknown>[]; returned: number; note: string };
	check("返回 1 条", body.returned === 1 && body.scenes.length === 1, String(body.returned));
	check("字段为 {id,name,cwd,lastUsedAt,useCount}", JSON.stringify(Object.keys(body.scenes[0]).sort()) === JSON.stringify(["cwd", "id", "lastUsedAt", "name", "useCount"]), Object.keys(body.scenes[0]).join(","));
	check("id/name 正确", body.scenes[0].id === "sc0001" && body.scenes[0].name === "alpha｜X");
	check("只读（池文件逐字节不变）", readFileSync(scenePoolPath(p), "utf-8") === before);

	// 空池：空数组 + 提示
	const pEmpty = makeProfile({ pool: emptyPool() });
	let defEmpty: { execute: (...args: unknown[]) => Promise<unknown> } | null = null;
	registerListL1ScenesTool({ registerTool: (d: unknown) => (defEmpty = d as never) } as never, () => pEmpty);
	const emptyRes = (await defEmpty!.execute()) as { content: { text: string }[] };
	const emptyBody = JSON.parse(emptyRes.content[0].text) as { scenes: unknown[]; hint?: string };
	check("空池 → 空数组 + hint", emptyBody.scenes.length === 0 && typeof emptyBody.hint === "string", String(emptyBody.hint));
}

console.log("\n=== G. detectBatchProject ===");
{
	const mk = (content: string, cwd = A) => l0Row({ content, cwd });
	const P = ["C:\\", "C:\\temp", "C:\\Users\\leaf", "C:\\Users\\leaf\\.pi", "C:\\dev\\code\\xianhua"];

	// 众数
	const p1 = makeProfile({ l0: { "2026-09-15.jsonl": [
		mk("改 ~/.pi 的扩展"), mk("看 C:\\Users\\leaf\\.pi\\agent\\extensions"), mk("C:/Users/leaf/.pi/x.md"),
		mk("顺便看 C:\\dev\\code\\xianhua\\a.vue"),
	] } });
	const f1 = join(p1, "memoryDB", "l0", "conversations", "2026-09-15.jsonl");
	check("斜杠方向不敏感 + 取众数", detectBatchProject([f1], P) === "C:\\Users\\leaf\\.pi", detectBatchProject([f1], P));

	// 过宽项不参与（C:\ 是任何路径的前缀；C:\Users\leaf 是父目录）
	check("C:\\ 被滤（否则恒等于它）", detectBatchProject([f1], ["C:\\"]) === "");
	check("家目录 C:\\Users\\leaf 被滤", detectBatchProject([f1], ["C:\\Users\\leaf"]) === "");
	check("C:\\temp 被滤", detectBatchProject([f1], ["C:\\temp"]) === "");

	// 命中数为 0 → 空串（不猜）
	const p2 = makeProfile({ l0: { "2026-09-15.jsonl": [mk("聊了点别的"), mk("没有路径")] } });
	check("无命中 → 空串", detectBatchProject([join(p2, "memoryDB", "l0", "conversations", "2026-09-15.jsonl")], P) === "");

	// 并列 → 取路径最长（按字符串长度：`C:\dev\code\xianhua` 19 字 > `C:\Users\leaf\.pi` 17 字）
	const p3 = makeProfile({ l0: { "2026-09-15.jsonl": [
		mk("C:\\dev\\code\\xianhua\\a"), mk("C:\\Users\\leaf\\.pi\\b"), mk("C:\\dev\\code\\xianhua\\c"), mk("C:\\Users\\leaf\\.pi\\d"),
	] } });
	const f3 = join(p3, "memoryDB", "l0", "conversations", "2026-09-15.jsonl");
	check("并列取最长路径", detectBatchProject([f3], P) === "C:\\dev\\code\\xianhua", detectBatchProject([f3], P));

	// 相对路径 / ~ 不参与
	const p4 = makeProfile({ l0: { "2026-09-15.jsonl": [mk("看 agent/extensions/memory-system 和 ~/.pi/agent")] } });
	check("相对路径与 ~ 不参与匹配", detectBatchProject([join(p4, "memoryDB", "l0", "conversations", "2026-09-15.jsonl")], P) === "");
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
console.log("\n=== G. readL0Increment：批次取「最旧」+ 无丢失（2026-09-19 修） ===");
{
	// 造 300 条消息（跨 3 个分片），id 与 recordedAt 同步递增
	const N = 300;
	const names = ["2026-09-15.jsonl", "2026-09-16.jsonl", "2026-09-17.jsonl"];
	const shards: Record<string, string[]> = { [names[0]]: [], [names[1]]: [], [names[2]]: [] };
	for (let i = 0; i < N; i++) {
		const rec = {
			sessionKey: "s1",
			id: `m${i}`,
			role: i % 2 ? "assistant" : "user",
			content: `第 ${i} 条`,
			timestamp: 1789000000000 + i,
			recordedAt: `2026-09-${String(15 + Math.floor(i / 100)).padStart(2, "0")}T00:00:${String(i % 100).padStart(2, "0")}.000Z`,
		};
		shards[names[Math.floor(i / 100)]].push(JSON.stringify(rec));
	}
	const p = makeProfile({ l0: Object.fromEntries(Object.entries(shards).map(([f, ls]) => [f, ls.map((l) => JSON.parse(l))])) });
	const files = names.map((f) => join(p, "memoryDB", "l0", "conversations", f));

	const r1 = readL0Increment(files.join(","), "");
	check("超上限时 truncated=true", r1.truncated === true, `${r1.messages.length} 条`);
	check("返回条数 = 上限 25", r1.messages.length === 25);
	check("按物理行顺序返回最旧的 25 条（首条 = m0）", String(r1.messages[0].id) === "m0", String(r1.messages[0].id));
	check("末条 = m24", String(r1.messages[24].id) === "m24", String(r1.messages[24].id));
	check("background 为空（游标为空串）", r1.background.length === 0);

	// 新批策略：游标按各分片已消费字节数记录，不受 recordedAt 相同影响。
	const cursor1 = JSON.stringify(r1.nextCursor);

	// 第二轮必须从 m25 无缝衔接 —— 没有任何一条被跳过
	const r2 = readL0Increment(files.join(","), cursor1);
	check("第二轮首条 = m25（无跳号）", String(r2.messages[0].id) === "m25", String(r2.messages[0].id));
	check("第二轮不含已处理的 m24", !r2.messages.some((m) => String(m.id) === "m24"));
	check(
		"background = 游标前 5 条（m20..m24）",
		r2.background.length === 5 && String(r2.background[4].id) === "m24",
		r2.background.map((m) => m.id).join(","),
	);

	// 逐轮啃完：25 条/轮 ⇒ 300 条 = 12 轮，且每条恰好覆盖一次
	let cursor = "";
	const seen = new Set<string>();
	let rounds = 0;
	for (; rounds < 40; rounds++) {
		const rr = readL0Increment(files.join(","), cursor);
		if (rr.messages.length === 0) break;
		const batch = rr.messages;
		for (const m of batch) seen.add(String(m.id));
		cursor = JSON.stringify(rr.nextCursor);
		if (batch.length < 25) break;
	}
	check("逐轮啃完覆盖全部 300 条（零丢失）", seen.size === N, `覆盖 ${seen.size}/${N}，共 ${rounds} 轮`);
	check("轮数符合预期（300/25 = 12 轮）", rounds === 12, `${rounds} 轮`);
	rmSync(p, { recursive: true, force: true });
}

{
	const boundary = "2026-09-15T10:00:00.000Z";
	const p = makeProfile({ l0: { "2026-09-15.jsonl": Array.from({ length: 31 }, (_, i) => ({ ...l0Row({ content: `中文边界 ${i}`, recordedAt: i === 0 ? "2026-09-15T09:59:00.000Z" : boundary }), id: `equal${i}` })) } });
	const file = join(p, "memoryDB", "l0", "conversations", "2026-09-15.jsonl");
	const first = readL0Increment(file, boundary);
	const second = readL0Increment(file, JSON.stringify(first.nextCursor));
	check("G 旧时间游标迁移重放整个相等组", first.messages[0]?.id === "equal1" && first.messages.length === 25);
	check("G 同时间戳组可安全拆成 25+5", second.messages.length === 5 && second.messages[0]?.id === "equal26" && second.messages[4]?.id === "equal30");
	check("G UTF-8 中文字节游标消费到完整文件末尾", second.nextCursor.files["2026-09-15.jsonl"] === Buffer.byteLength(readFileSync(file, "utf-8")));
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
