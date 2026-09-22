// read_scene_blocks 的离线回归（临时 profile；只读夹具目录 + 只写系统临时目录）
//
// 覆盖 T2（SUBAGENT_THROUGHPUT）：
//   ① 一次读多块 → 每块 ok + meta + content
//   ② 单块超限 → 截断 + truncated 标记 + 提示单独 read
//   ③ 单次总量超限 → 后续块 omitted（不截半块），提示分次调用
//   ④ 文件名白名单：路径穿越 / 绝对路径 / 非 .md / 不存在 → 明确报错，绝不越界读
//   ⑤ 空输入 / 超条数上限 → 明确报错
// 用 tsx 跑：tsx scripts/verify-l2-scene-read.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_FILENAMES,
	SINGLE_BLOCK_CHAR_LIMIT,
	TOTAL_CHAR_LIMIT,
	isPlainSceneFilename,
	readSceneBlocks,
} from "../memory/l2/scene-read-tool.ts";

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

const root = mkdtempSync(join(tmpdir(), "l2-scene-read-"));
const sceneDir = join(root, "memoryDB", "l2", "scene-blocks");
mkdirSync(sceneDir, { recursive: true });

const block = (summary: string, lines: string[]) =>
	`-----META-START-----\ncreated: 2026-08-17T00:00:00.000Z\nupdated: 2026-09-01T00:00:00.000Z\nsummary: ${summary}\nheat: 3\n-----META-END-----\n\n${lines.join("\n")}\n`;

writeFileSync(join(sceneDir, "a.md"), block("摘要A", ["- A-1", "- A-2"]), "utf-8");
writeFileSync(join(sceneDir, "b.md"), block("摘要B", ["- B-1"]), "utf-8");
// 超大块：正文超过单块上限
const huge = Array.from({ length: Math.ceil(SINGLE_BLOCK_CHAR_LIMIT / 20) + 50 }, (_, i) => `- 巨块行 ${i} ${"x".repeat(12)}`);
writeFileSync(join(sceneDir, "huge.md"), block("摘要巨", huge), "utf-8");
// 触发"总量上限"的块：每块**低于单块上限**（否则先被截断、总量就超不了），但 5 块之和 > 总量上限
const fat = (tag: string) => Array.from({ length: Math.ceil((TOTAL_CHAR_LIMIT / 5 - 200) / 20) }, (_, i) => `- ${tag} ${i} ${"y".repeat(12)}`);
const fatNames = ["fat1.md", "fat2.md", "fat3.md", "fat4.md", "fat5.md"];
for (const [i, n] of fatNames.entries()) writeFileSync(join(sceneDir, n), block(`胖${i + 1}`, fat(`F${i + 1}`)), "utf-8");

console.log("\n=== 1. 一次读多块（主路径）===");
{
	const r = readSceneBlocks(root, ["a.md", "b.md"]);
	check("两块都 ok", r.returned === 2 && r.blocks.every((b) => b.ok), `returned=${r.returned}`);
	check("返回 meta（含 summary）", r.blocks[0].meta?.summary === "摘要A");
	check("返回正文", (r.blocks[0].content ?? "").includes("A-1"));
	check("totalChars > 0 且等于各块之和", r.totalChars === r.blocks.reduce((n, b) => n + (b.content?.length ?? 0), 0));
	check("无截断/无 omitted", r.truncated === 0 && r.omitted === 0);
}

console.log("\n=== 2. 单块超限 → 截断但可用 ===");
{
	const r = readSceneBlocks(root, ["huge.md", "a.md"]);
	const h = r.blocks.find((b) => b.filename === "huge.md");
	check("超大块被标记 truncated", h?.ok === true && h?.truncated === true);
	check("截断后仍在单块上限附近（不超上限+提示文案）", (h?.content ?? "").length < SINGLE_BLOCK_CHAR_LIMIT + 200, String((h?.content ?? "").length));
	check("截断处给出单独 read 的路径提示", (h?.content ?? "").includes("已截断"));
	check("同批的普通块不受影响", r.blocks.find((b) => b.filename === "a.md")?.ok === true);
	check("truncated 计数 = 1", r.truncated === 1);
}

console.log("\n=== 3. 单次总量超限 → 后续块 omitted（不截半块）===");
{
	const r = readSceneBlocks(root, fatNames);
	check("前几块 ok", r.blocks[0]?.ok === true && r.blocks[1]?.ok === true);
	const last = r.blocks[r.blocks.length - 1];
	check("最后一块 omitted 而不是截断", last?.omitted === true && last?.ok === false, JSON.stringify({ ok: last?.ok, omitted: last?.omitted }));
	check("omitted 提示怎么补读", String(last?.error ?? "").includes("read_scene_blocks"));
	check("omitted 计数 ≥1、returned 与 ok 数一致", r.omitted >= 1 && r.returned === r.blocks.filter((b) => b.ok).length);
	check("总量不超过上限", r.totalChars <= TOTAL_CHAR_LIMIT, String(r.totalChars));
	check("没有块因总量被截半（truncated 只来自单块上限）", r.truncated === 0);
}

console.log("\n=== 4. 文件名白名单（绝不越界读）===");
{
	check("裸 .md 名通过", isPlainSceneFilename("a.md"));
	check("路径穿越被拒", !isPlainSceneFilename("../../auth.json") && !isPlainSceneFilename("..\\..\\auth.json"));
	check("绝对路径被拒", !isPlainSceneFilename("C:\\Users\\leaf\\.pi\\agent\\auth.json") && !isPlainSceneFilename("/etc/passwd.md"));
	check("子目录被拒", !isPlainSceneFilename("sub/a.md"));
	check("非 .md 被拒", !isPlainSceneFilename("auth.json"));
	const r = readSceneBlocks(root, ["../../auth.json", "nope.md"]);
	check("非法名 → ok:false + 原因", r.blocks[0]?.ok === false && String(r.blocks[0]?.error).includes("非法"));
	check("不存在 → ok:false + 原因", r.blocks[1]?.ok === false && String(r.blocks[1]?.error).includes("不存在"));
	check("越界请求不计入 returned", r.returned === 0);
}

console.log("\n=== 5. 参数边界 ===");
{
	check("空数组 → 明确报错", readSceneBlocks(root, []).error !== undefined);
	check("超条数上限 → 明确报错", readSceneBlocks(root, Array.from({ length: MAX_FILENAMES + 1 }, () => "a.md")).error !== undefined);
	const r = readSceneBlocks(root, ["  a.md  "]);
	check("首尾空白被容忍（trim 后仍可读）", r.blocks[0]?.ok === true);
}

rmSync(root, { recursive: true, force: true });
console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exit(1);
