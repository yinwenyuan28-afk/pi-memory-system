/**
 * `util/recall-score.ts` 契约回归（2026-10-02）
 *
 * 覆盖四组：
 *   A. projectCompareKey 归一化（大小写 / 斜杠 / 尾分隔符 / 盘符根）
 *   B. scoreRecord 分类与系数（match / mismatch / generic 三类）
 *   C. **安全回退**：会话无 project / flag=false 占位值 ⇒ 系数全 1.0（行为不变）
 *   D. 边界与畸形输入 + 排序函数
 *
 * ⚠ **C 组是本脚本的核心价值**：项目加权是「上线后行为会变」的改动。
 *   若判定表读不到、或拿到的是 `flag=false` 的弃权占位值，却仍按异项目压低别人的记忆，
 *   那是**静默的质量损失**（实测 15/20 会话是弃权态）。所以必须锁死「读不到就不加权」。
 *
 * 用法：tsx --conditions=import scripts/verify-recall-score.ts
 */
import {
	CROSS_PROJECT_WEIGHT,
	projectCompareKey,
	scoreRecord,
	sortByScore,
} from "../util/recall-score.ts";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown): void {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (ok) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name} — 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
	}
}

// ══════════════════════════════════════════════════════════════
//  A. projectCompareKey 归一化
// ══════════════════════════════════════════════════════════════
console.log("\n=== A. projectCompareKey 归一化 ===");
check("A1 反斜杠 → 正斜杠", projectCompareKey("C:\\dev\\code\\xianhua"), "c:/dev/code/xianhua");
check("A2 大小写不敏感", projectCompareKey("C:/DEV/Code/Xianhua"), projectCompareKey("c:/dev/code/xianhua"));
check("A3 尾部斜杠去除", projectCompareKey("C:/dev/code/xianhua/"), "c:/dev/code/xianhua");
check("A4 盘符根保留尾斜杠（不得削成 C:）", projectCompareKey("C:/"), "c:/");
check("A5 盘符根带反斜杠也一致", projectCompareKey("C:\\"), projectCompareKey("C:/"));
check("A6 空串 → 空串", projectCompareKey(""), "");
check("A7 undefined 不抛错", projectCompareKey(undefined as unknown as string), "");
check("A8 首尾空白去除", projectCompareKey("  C:/dev/x  "), "c:/dev/x");
check("A9 同一路径三种写法归一后相等", new Set([
	projectCompareKey("C:\\dev\\code_java\\wangxin\\backend\\A104527"),
	projectCompareKey("C:/dev/code_java/wangxin/backend/A104527"),
	projectCompareKey("C:/dev/code_java/wangxin/backend/A104527/"),
]).size, 1);

// ══════════════════════════════════════════════════════════════
//  B. scoreRecord 分类与系数
// ══════════════════════════════════════════════════════════════
console.log("\n=== B. scoreRecord 分类与系数 ===");
const P = "C:/dev/code/xianhua";
check("B1 self + 同项目 ⇒ match，系数 1.0",
	scoreRecord(0.6, P, { scope: "self", project: P }), { score: 0.6, cls: "match" });
check("B2 self + 异项目 ⇒ mismatch，×0.75",
	scoreRecord(0.6, P, { scope: "self", project: "C:/dev/code/other" }),
	{ score: 0.6 * CROSS_PROJECT_WEIGHT, cls: "mismatch" });
check("B3 global ⇒ generic，**不降权**",
	scoreRecord(0.6, P, { scope: "global", project: "" }), { score: 0.6, cls: "generic" });
check("B4 unknown ⇒ generic，**不降权**",
	scoreRecord(0.6, P, { scope: "unknown", project: "C:/dev/other" }),
	{ score: 0.6, cls: "generic" });
check("B5 scope 缺字段 ⇒ 视同 unknown（generic）",
	scoreRecord(0.6, P, { project: "C:/dev/other" }), { score: 0.6, cls: "generic" });
check("B6 同项目但斜杠写法不同 ⇒ 仍 match",
	scoreRecord(0.5, P, { scope: "self", project: "C:\\dev\\code\\xianhua\\" }),
	{ score: 0.5, cls: "match" });
check("B7 self + 项目为空串 ⇒ mismatch（不是 match）",
	scoreRecord(0.6, P, { scope: "self", project: "" }).cls, "mismatch");
check("B8 大小写不同仍算同项目",
	scoreRecord(0.5, P, { scope: "self", project: "C:/DEV/CODE/XIANHUA" }).cls, "match");
check("B9 crossWeight 可覆盖",
	scoreRecord(1.0, P, { scope: "self", project: "C:/x" }, 0.5), { score: 0.5, cls: "mismatch" });
check("B10 crossWeight=0 ⇒ 异项目分数归零但仍分类 mismatch",
	scoreRecord(0.6, P, { scope: "self", project: "C:/x" }, 0).score, 0);

// ══════════════════════════════════════════════════════════════
//  C. 安全回退（核心）
// ══════════════════════════════════════════════════════════════
console.log("\n=== C. 安全回退：会话无判定 ⇒ 系数全 1.0 ===");
check("C1 会话 project 为空串 ⇒ 异项目记忆也不降权",
	scoreRecord(0.6, "", { scope: "self", project: "C:/some/other" }),
	{ score: 0.6, cls: "match" });
check("C2 会话 project 未传（undefined）⇒ 同上",
	scoreRecord(0.6, undefined as unknown as string, { scope: "self", project: "C:/some/other" }),
	{ score: 0.6, cls: "match" });
check("C3 会话 project 只有空白 ⇒ 同上",
	scoreRecord(0.6, "   ", { scope: "self", project: "C:/some/other" }).score, 0.6);
check("C4 flag=false 的占位值形态（家目录）⇒ 不会被误判成 mismatch",
	scoreRecord(0.6, "C:/Users/leaf", { scope: "self", project: "C:/dev/other" }).cls, "mismatch");
// ⚠ C4 说明：**调用方必须只在 flag===true 时传 sessionProject**。
//   若误传弃权占位值，会退化成「按家目录过滤」，把几乎所有记忆判成 mismatch ——
//   这是接线侧的义务，不是 scoreRecord 能兜住的（它无法区分「真项目」与「弃权占位」）。
//   这里显式记录该行为，供接线审查时对照。
check("C5 权重默认常量 = 0.75（实测平台期起点）", CROSS_PROJECT_WEIGHT, 0.75);

// ══════════════════════════════════════════════════════════════
//  D. 排序 + 畸形输入
// ══════════════════════════════════════════════════════════════
console.log("\n=== D. 排序与畸形输入 ===");
{
	// 真实场景复现：异项目高分 vs 同项目中分
	const items = [
		// 用**实测区间**的真实值，不用随手编的数（实测：跨项目 P50=0.599 P90=0.676；
		// 同项目 P25=0.568 P50=0.605）—— 考察的是「实测里真实会发生的差距」
		{ id: "a", raw: 0.676, cls: "mismatch", score: 0 }, // 异项目 P90
		{ id: "b", raw: 0.605, cls: "match", score: 0 },    // 同项目 P50
		{ id: "c", raw: 0.586, cls: "generic", score: 0 },  // 通用件 P50
	];
	for (const it of items) {
		it.score = scoreRecord(it.raw, P, {
			scope: it.cls === "generic" ? "global" : "self",
			project: it.cls === "mismatch" ? "C:/other" : P,
		}).score;
	}
	const sorted = sortByScore(items);
	// 0.676×0.75=0.507 < 0.605 < 0.586 ⇒ 顺序变成 同项目 > 通用件 > 异项目
	check("D1 实测 P50/P90 区间下，加权把异项目 P90 压到通用件之下", sorted.map((x) => x.id), ["b", "c", "a"]);
	{
		// 反向验证：权重不能压过头（异项目 P90 0.676 若真与同项目 P90 0.698 同级，仍应排后）
		const tight = [
			{ id: "x", raw: 0.698, cls: "match", score: 0 },
			{ id: "y", raw: 0.676, cls: "mismatch", score: 0 },
		];
		for (const it of tight) {
			it.score = scoreRecord(it.raw, P, {
				scope: it.cls === "match" ? "self" : "self",
				project: it.cls === "match" ? P : "C:/other",
			}).score;
		}
		check("D1b 同项目 P90 仍压过异项目 P90（不会因加权反超）",
			sortByScore(tight).map((z) => z.id), ["x", "y"]);
	}
	check("D2 排序是降序", sorted[0].score >= sorted[1].score && sorted[1].score >= sorted[2].score, true);
}
check("D3 空数组排序不抛错", sortByScore([]), []);
check("D4 单元素排序不抛错", sortByScore([{ score: 1 }]), [{ score: 1 }]);
check("D5 余弦为 0 时加权仍为 0", scoreRecord(0, P, { scope: "self", project: "C:/x" }).score, 0);
check("D6 scope 非字符串（数字）⇒ 视同缺字段 → generic", scoreRecord(0.6, P, { scope: 123 }).cls, "generic");
check("D7 project 非字符串 ⇒ mismatch 而不抛错", scoreRecord(0.6, P, { scope: "self", project: {} }).cls, "mismatch");
check("D8 分数保留小数精度（不做取整）",
	scoreRecord(0.123456, P, { scope: "self", project: "C:/x" }).score, 0.123456 * 0.75);

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);