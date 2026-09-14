// 临时验收脚本（跑完即删）：验证 readRecentSceneContext 与 buildL1Task 注入
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildL1Task, RECENT_SCENE_LIMIT, readRecentSceneContext } from "../memory/l1/config.ts";
import { stampRecordTimes } from "../memory/l1/commit-tool.ts";

const REAL = "C:/Users/leaf/.pi/agent/profiles/default";
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

const day = (offset: number) => {
	const d = new Date(Date.now() + offset * 86_400_000);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function makeProfile(files: Record<string, string[]>): string {
	const root = mkdtempSync(join(tmpdir(), "l1anchor-"));
	const dir = join(root, "memoryDB", "l1", "records");
	mkdirSync(dir, { recursive: true });
	for (const [name, lines] of Object.entries(files)) {
		writeFileSync(join(dir, name), lines.join("\n") + "\n", "utf-8");
	}
	return root;
}
const rec = (o: Record<string, unknown>) => JSON.stringify(o);

console.log("\n=== 1. 真实 profile ===");
const t0 = Date.now();
const real = readRecentSceneContext(REAL);
console.log(`  耗时 ${Date.now() - t0} ms`);
console.log(`  PreviousScene: ${real.previous ? `${real.previous.name} | cwd=${real.previous.cwd}` : "(无)"}`);
console.log(`  recent ${real.recent.length} 条（上限 ${RECENT_SCENE_LIMIT}）:`);
real.recent.forEach((r, i) => console.log(`    ${i + 1}. ${r.name} | cwd=${r.cwd}`));
check("previous 非空", real.previous !== null);
check("recent 不超上限", real.recent.length <= RECENT_SCENE_LIMIT);
check("recent 名字去重", new Set(real.recent.map((r) => r.name)).size === real.recent.length);

console.log("\n=== 2. 反例：同 id 存活行在前、作废标记在后（跨分片）===");
{
	const p = makeProfile({
		[`${day(-3)}.jsonl`]: [rec({ id: "r1", scene_name: "甲", cwd: "C:/A", deleted: false })],
		[`${day(-1)}.jsonl`]: [rec({ id: "r1", scene_name: "甲", cwd: "C:/A", deleted: true })],
	});
	const a = readRecentSceneContext(p, 15, "C:/A");
	check("已被取代的 id 不参与锚点", a.previous === null, `previous=${a.previous?.name ?? "(无)"}`);
	rmSync(p, { recursive: true, force: true });
}

console.log("\n=== 3. 反例：单看 deleted 字段会误判的场景（存活行留在旧分片）===");
{
	const p = makeProfile({
		[`${day(-5)}.jsonl`]: [
			rec({ id: "old", scene_name: "旧场景", cwd: "C:/A", deleted: false }),
			rec({ id: "old2", scene_name: "旧场景2", cwd: "C:/A", deleted: false }),
		],
		[`${day(-2)}.jsonl`]: [rec({ id: "old", scene_name: "旧场景", cwd: "C:/A", deleted: true })],
		[`${day(-1)}.jsonl`]: [rec({ id: "new", scene_name: "新场景", cwd: "C:/A", deleted: false })],
	});
	const a = readRecentSceneContext(p, 15, "C:/A");
	check("previous 取最后写入", a.previous?.name === "新场景", `实际 ${a.previous?.name}`);
	check("被取代的旧场景已剔除", !a.recent.some((r) => r.name === "旧场景"), a.recent.map((r) => r.name).join("/"));
	check("未取代的旧场景仍在候选", a.recent.some((r) => r.name === "旧场景2"));
	rmSync(p, { recursive: true, force: true });
}

console.log("\n=== 4. 边界：非 jsonl 文件 / 空 scene_name / 换行 / 坏行 ===");
{
	const p = makeProfile({
		"backup-l1-records.zip": ["not jsonl at all"],
		[`${day(-2)}.jsonl`]: [
			rec({ id: "e1", scene_name: "   ", cwd: "C:/A", deleted: false }),
			rec({ id: "e2", cwd: "C:/A", deleted: false }),
			"{ 坏行",
			rec({ id: "e3", scene_name: "带\n换行 的名字", cwd: "C:/A", deleted: false }),
		],
	});
	const a = readRecentSceneContext(p, 15, "C:/A");
	check("非 jsonl 文件被忽略且不崩", a.previous?.name === "带 换行 的名字", `实际 ${JSON.stringify(a.previous?.name)}`);
	check("换行被折叠为单空格", a.previous?.name === "带 换行 的名字");
	check("空 scene_name 被跳过", a.recent.length === 1);
	rmSync(p, { recursive: true, force: true });
}

console.log("\n=== 5. 同 cwd 优先 + 上限截断 ===");
{
	const lines: string[] = [];
	for (let i = 0; i < 20; i++) {
		// 场景10 落在「最新 15 条」区间内但不在首位，用于验证同 cwd 上浮
		lines.push(rec({ id: `s${i}`, scene_name: `场景${i}`, cwd: i === 10 ? "C:/ME" : "C:/OTHER", deleted: false }));
	}
	const p = makeProfile({ [`${day(-1)}.jsonl`]: lines });
	const a = readRecentSceneContext(p, 15, "C:/ME");
	check("截断到上限", a.recent.length === 15, `实际 ${a.recent.length}`);
	check("同 cwd 上浮到首位", a.recent[0].name === "场景10" && a.recent[0].cwd === "C:/ME", `首位 ${a.recent[0].name}/${a.recent[0].cwd}`);
	check("其余保持倒序（近者优先）", a.recent[1].name === "场景19", `实际 ${a.recent[1].name}`);
	check("窗口外的旧名未入选", !a.recent.some((r) => r.name === "场景4"), a.recent.map((r) => r.name).join("/"));
	check("previous 仍是最新一条", a.previous?.name === "场景19");
	rmSync(p, { recursive: true, force: true });
}

console.log("\n=== 6. 边界：超窗口的旧分片被排除 ===");
{
	const p = makeProfile({
		[`${day(-90)}.jsonl`]: [rec({ id: "old", scene_name: "三个月前", cwd: "C:/A", deleted: false })],
	});
	const a = readRecentSceneContext(p, 15, "C:/A");
	check("窗口外记录不入锚点", a.previous === null);
	rmSync(p, { recursive: true, force: true });
}

console.log("\n=== 7. 边界：目录不存在 / 全作废 ===");
{
	const a1 = readRecentSceneContext("C:/definitely/not/exist", 15, "C:/A");
	check("目录不存在时降级为空", a1.previous === null && a1.recent.length === 0);
	const p = makeProfile({
		[`${day(-1)}.jsonl`]: [rec({ id: "x", scene_name: "全部作废", cwd: "C:/A", deleted: true })],
	});
	const a2 = readRecentSceneContext(p, 15, "C:/A");
	check("全作废时降级为空", a2.previous === null && a2.recent.length === 0);
	rmSync(p, { recursive: true, force: true });
}

console.log("\n=== 8. buildL1Task 注入结果（临时 profile，避免污染真实锚点日志）===");
{
	// 注意：buildL1Task 会向 profile 的 l1/anchor-log.jsonl 追加一条日志，
	// 所以这里必须用临时 profile——早期版本直接对真实 profile 调用，污染了生产日志。
	const root = mkdtempSync(join(tmpdir(), "l1task-"));
	const l0dir = join(root, "memoryDB", "l0", "conversations");
	const recdir = join(root, "memoryDB", "l1", "records");
	mkdirSync(l0dir, { recursive: true });
	mkdirSync(recdir, { recursive: true });
	writeFileSync(join(l0dir, `${day(0)}.jsonl`), "{}\n", "utf-8");
	writeFileSync(
		join(recdir, `${day(-1)}.jsonl`),
		`${rec({ id: "t1", scene_name: "临时场景甲", cwd: "C:/TMP", deleted: false })}\n`,
		"utf-8",
	);

	const task = buildL1Task(root);
	if (task === null) {
		check("临时 profile 有 L0 分片时应返回任务消息", false, "返回 null");
	} else {
		const lines = task.split("\n");
		console.log(`  行数 ${lines.length}`);
		lines.forEach((l) => console.log(`    ${l.slice(0, 120)}`));
		check("含 PreviousScene 行", lines.some((l) => l.startsWith("PreviousScene:")));
		check("含 RecentScenes 行", lines.some((l) => l.startsWith("RecentScenes")));
		check(
			"PreviousScene 取到临时记录",
			lines.some((l) => l.startsWith("PreviousScene: 临时场景甲 | cwd=C:/TMP")),
			lines.find((l) => l.startsWith("PreviousScene:")) ?? "",
		);
	}
	const logPath = join(root, "memoryDB", "l1", "anchor-log.jsonl");
	check("锚点日志写入临时 profile", existsSync(logPath));
	if (existsSync(logPath)) {
		const logged = JSON.parse(readFileSync(logPath, "utf-8").split("\n").filter(Boolean)[0]);
		check("日志含 previous 与 recent", !!logged.previous && Array.isArray(logged.recent), JSON.stringify(logged.previous));
	}
	rmSync(root, { recursive: true, force: true });
}

console.log("\n=== 9. 批 D：时间字段覆写（stampRecordTimes）===");
{
	const NOW = "2026-09-10T06:00:00.000Z";
	const live = {
		id: "x1",
		createdAt: "2026-08-17T09:12:00.000Z",
		updatedAt: "2026-08-17T09:12:00.000Z",
		timestamps: ["2026-08-17T09:03:54.004Z"],
	};
	stampRecordTimes(live, false, NOW);
	check("active 行 createdAt 被覆写", live.createdAt === NOW, live.createdAt);
	check("active 行 updatedAt 被覆写", live.updatedAt === NOW, live.updatedAt);
	check("timestamps 逐字不变", JSON.stringify(live.timestamps) === JSON.stringify(["2026-08-17T09:03:54.004Z"]));

	const marker = {
		id: "x1",
		deleted: true,
		createdAt: "2026-08-17T09:12:00.000Z",
		updatedAt: "2026-08-17T09:12:00.000Z",
		timestamps: ["2026-08-17T09:03:54.004Z"],
	};
	stampRecordTimes(marker, true, NOW);
	check("标记行 createdAt 保留原值", marker.createdAt === "2026-08-17T09:12:00.000Z", marker.createdAt);
	check("标记行 updatedAt 改为当日", marker.updatedAt === NOW, marker.updatedAt);
	check("标记行 timestamps 逐字不变", JSON.stringify(marker.timestamps) === JSON.stringify(["2026-08-17T09:03:54.004Z"]));

	const noCreated = { id: "x2", deleted: true };
	stampRecordTimes(noCreated, true, NOW);
	check("标记行缺 createdAt 时补 now", (noCreated as Record<string, unknown>).createdAt === NOW);

	const badCreated = { id: "x3", deleted: true, createdAt: "not-a-date" };
	stampRecordTimes(badCreated, true, NOW);
	check("标记行 createdAt 不可解析时补 now", badCreated.createdAt === NOW);
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
