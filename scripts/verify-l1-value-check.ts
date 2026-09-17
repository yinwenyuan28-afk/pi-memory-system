// L1 价值校验 + 确定性闸门的回归基线（只读生产代码；只写系统临时目录）
//
// 覆盖 2026-09-17 新增的两层：
//   ① 确定性闸门（代码，写盘路径内）：content 非空 / type 枚举 / priority 带 / 软闸观测
//   ② 价值校验（一次 agent loop，maxTurns 默认 1）：判据摘取、裁决解析、裁决应用、**fail-open**
//
// 铁律：只用临时目录；价值校验的 LLM 调用一律用**注入的桩 loop**，本脚本不发真实请求。
//
// 用 tsx 跑：tsx scripts/verify-l1-value-check.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyVerdicts,
	buildCheckUserContent,
	buildChecklist,
	loadChecklistFromFile,
	parseVerdicts,
	runValueCheck,
	type ValueVerdict,
} from "../memory/l1/value-check.ts";
import { DEFAULT_VALUE_CHECK, loadL1Config, saveL1Mode, PROMPT_DIR } from "../memory/l1/config.ts";
import { registerL1CommitTool } from "../memory/l1/commit-tool.ts";

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

const PROMPT_FILE = join(PROMPT_DIR, "extract-code-personal.md");

/** 造临时 profile；`valueCheck` 为 undefined 表示只写 mode。 */
function makeProfile(valueCheck?: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "l1vc-"));
	mkdirSync(join(root, "memoryDB", "config"), { recursive: true });
	mkdirSync(join(root, "memoryDB", "l1", "records"), { recursive: true });
	const l1: Record<string, unknown> = { mode: "code" };
	if (valueCheck) l1.valueCheck = valueCheck;
	writeFileSync(join(root, "memoryDB", "config", "application-propertis.json"), JSON.stringify({ l1 }), "utf-8");
	return root;
}

/** 捕获 l1_commit 的 execute（与 verify-l1-scene-pool.ts 同款）。 */
function captureCommitTool(profilePath: string) {
	let def: { execute: (...args: unknown[]) => Promise<unknown> } | null = null;
	registerL1CommitTool({ registerTool: (d: unknown) => (def = d as never) } as never, () => profilePath);
	if (!def) throw new Error("l1_commit 未注册");
	const ctx = {
		cwd: "C:/dev/alpha",
		ui: { notify: () => {} },
		sessionManager: { getSessionFile: () => "C:/x/sess.jsonl", getSessionId: () => "sid-1" },
		// 刻意不给 model：价值校验应 fail-open（返回体带 skipped），而不是抛错
	};
	return async (params: Record<string, unknown>) => {
		const res = (await def!.execute("t1", params, undefined, undefined, ctx)) as { content: { text: string }[] };
		return JSON.parse(res.content[0].text) as Record<string, unknown>;
	};
}

const REC = (over: Record<string, unknown> = {}) => ({
	content: "遇到数值与命名不一致时，先按公式或量化依据算出取值再落常量，不要凭手感试错",
	type: "work_method",
	priority: 80,
	source_message_ids: ["m1"],
	...over,
});

async function main(): Promise<void> {
	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 1. 判据摘取（与提取规则同源，且能抗标题漂移） ===");
	{
		check("规则文件存在", existsSync(PROMPT_FILE), PROMPT_FILE);
		const text = readFileSync(PROMPT_FILE, "utf-8");
		const checklist = buildChecklist(text);
		check("能摘出判据", !!checklist);
		const c = checklist ?? "";
		check("判据长度足够（>=200）", c.length >= 200, `${c.length} 字符`);
		// 五个标记段都必须命中：任一缺失 → 判据不完整 → 校验器会按残缺标准误杀
		for (const marker of ["【首要原则 · 宁缺毋滥】", "【三项判别测试】", "【明确排除项】", "### 不应该提取的内容", "### 输出前自检"]) {
			check(`判据含标记段「${marker}」`, c.includes(marker));
		}
		check("判据含价值判据核心句（重新发现成本）", c.includes("重新发现成本"));
		check("判据含三个闸门（剥离/一次性/有出处）", c.includes("剥离测试") && c.includes("一次性测试") && c.includes("有出处测试"));
		check("判据不含其他任务的正文（任务一/任务三）", !c.includes("### 任务一") && !c.includes("### 任务三"));

		check("loadChecklistFromFile 走通", loadChecklistFromFile(PROMPT_FILE) !== null);
		check("文件不存在 → null（fail-open 信号）", loadChecklistFromFile(join(PROMPT_DIR, "no-such.md")) === null);
		check("内容过短 → null（宁可 fail-open 也不拿残缺判据审）", buildChecklist("【首要原则 · 宁缺毋滥】\n太短") === null);
		check("一个标记都没有 → null", buildChecklist("无关正文".repeat(200)) === null);
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 2. 裁决解析（宽容但安全） ===");
	{
		const n = 3;
		const ok = parseVerdicts('{"verdicts":[{"i":0,"v":"keep"},{"i":1,"v":"drop","r":"流水账"},{"i":2,"v":"retype","t":"work_fact","r":"无规范词"}]}', n);
		check("三条都能解析", ok?.length === n && ok[1].v === "drop" && ok[2].t === "work_fact");

		const fenced = parseVerdicts('说明如下：\n```json\n{"verdicts":[{"i":0,"v":"keep"}]}\n```\n以上。', 2);
		check("容忍代码块与前后缀", fenced?.[0].v === "keep");

		check("无法解析 → null", parseVerdicts("模型今天不想输出 JSON", n) === null);
		check("空串 → null", parseVerdicts("", n) === null);
		check("verdicts 非数组 → null", parseVerdicts('{"verdicts":"x"}', n) === null);

		// 安全性：无理由的删除不可审计 → 降级 keep
		const noReason = parseVerdicts('{"verdicts":[{"i":0,"v":"drop"}]}', 1);
		check("drop 缺理由 → 降级 keep", noReason?.[0].v === "keep");
		const badType = parseVerdicts('{"verdicts":[{"i":0,"v":"retype","t":"architecture","r":"x"}]}', 1);
		check("retype 给越枚举类型 → 降级 keep", badType?.[0].v === "keep");

		const outOfRange = parseVerdicts('{"verdicts":[{"i":9,"v":"drop","r":"x"},{"i":0,"v":"drop","r":"流水账"}]}', 1);
		check("越界下标被忽略", outOfRange?.length === 1 && outOfRange[0].v === "drop");
		const dup = parseVerdicts('{"verdicts":[{"i":0,"v":"drop","r":"a"},{"i":0,"v":"keep"}]}', 1);
		check("重复下标取首次", dup?.[0].v === "drop");

		const partial = parseVerdicts('{"verdicts":[{"i":0,"v":"drop","r":"流水账"}]}', 3);
		check("未覆盖的记录一律补 keep（不删没被判过的）", partial?.length === 3 && partial[1].v === "keep" && partial[2].v === "keep");
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 3. 裁决应用（drop 剔除 / retype 改型并留痕 / keep 不动） ===");
	{
		const recs = [{ type: "work_method", content: "a" }, { type: "work_fact", content: "b" }, { type: "work_fact", content: "c" }];
		const verdicts: ValueVerdict[] = [
			{ i: 0, v: "drop", r: "流水账" },
			{ i: 1, v: "retype", t: "work_method", r: "含规范词" },
			{ i: 2, v: "keep" },
		];
		const applied = applyVerdicts(recs, verdicts);
		check("drop 被剔除", applied.dropped.length === 1 && applied.dropped[0].reason === "流水账");
		check("retype 改型 + 入 kept", applied.retyped.length === 1 && applied.retyped[0].from === "work_fact" && applied.retyped[0].to === "work_method");
		check("retype 留下审计痕", JSON.stringify(applied.kept.find((k) => (k as { content: string }).content === "b")).includes('"verdict":"retype"'));
		check("held 总数 = 2", applied.kept.length === 2);
		check("不修改入参数组", recs.length === 3 && recs[1].type === "work_fact");

		const untouched = applyVerdicts(recs, null);
		check("verdicts=null → 全部原样保留（fail-open 语义）", untouched.kept.length === 3 && untouched.dropped.length === 0 && untouched.retyped.length === 0);
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 4. runValueCheck（桩 loop，不发真实请求） ===");
	{
		const cands = [{ content: "a".repeat(50), type: "work_method", priority: 80 }];
		const base = { model: {}, checklist: "判据".repeat(200), candidates: cands };

		const ok = await runValueCheck({
			...base,
			loop: async () => '{"verdicts":[{"i":0,"v":"drop","r":"流水账"}]}',
		});
		check("正常路径取到裁决", ok.verdicts?.[0].v === "drop");

		const nullText = await runValueCheck({ ...base, loop: async () => null });
		check("循环返回 null → fail-open（verdicts=null + skipped）", nullText.verdicts === null && !!nullText.skipped);

		const threw = await runValueCheck({
			...base,
			loop: async () => {
				throw new Error("模拟 provider 抛错");
			},
		});
		check("循环抛错 → fail-open 不冒泡", threw.verdicts === null && String(threw.skipped).includes("模拟"));

		const noModel = await runValueCheck({ ...base, model: null, loop: async () => "x" });
		check("无模型 → fail-open", noModel.verdicts === null && noModel.skipped === "无可用模型");

		const noChecklist = await runValueCheck({ ...base, checklist: "", loop: async () => "x" });
		check("判据为空 → fail-open", noChecklist.verdicts === null && noChecklist.skipped === "判据为空");

		const empty = await runValueCheck({ ...base, candidates: [] });
		check("无候选 → 空裁决且不报 skipped", Array.isArray(empty.verdicts) && empty.verdicts.length === 0 && !empty.skipped);

		// 超长候选必须被截断，否则单条记录会把校验上下文吃掉
		const longRaw = "甲".repeat(1200);
		const long = buildCheckUserContent("判据".repeat(200), [{ content: longRaw, type: "work_fact" }], 200);
		check("候选超长被截断", long.includes("（已截断）") && !long.includes("甲".repeat(300)), `${long.length} 字符`);
		check("截断保留在 maxRecordChars 内", long.includes("甲".repeat(200)) && !long.includes("甲".repeat(201)));
		check("提示词无残留占位符", !long.includes("{{"));
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 5. valueCheck 配置（默认值与上限钳制） ===");
	{
		const p1 = makeProfile();
		const c1 = loadL1Config(p1);
		check("缺省 → 默认值", JSON.stringify(c1.valueCheck) === JSON.stringify(DEFAULT_VALUE_CHECK), JSON.stringify(c1.valueCheck));
		check("默认 turn 上限 = 1（纯判定）", c1.valueCheck.maxTurns === 1);
		rmSync(p1, { recursive: true, force: true });

		const p2 = makeProfile({ enabled: true, maxTurns: 99, timeoutMs: 1, maxRecordChars: 999999 });
		const c2 = loadL1Config(p2);
		check("maxTurns 钳到 3（不许放开成不受控循环）", c2.valueCheck.maxTurns === 3);
		check("timeoutMs 钳到下限 5000", c2.valueCheck.timeoutMs === 5000);
		check("maxRecordChars 钳到上限 4000", c2.valueCheck.maxRecordChars === 4000);
		rmSync(p2, { recursive: true, force: true });

		const p3 = makeProfile({ enabled: false });
		check("可显式关闭", loadL1Config(p3).valueCheck.enabled === false);
		// 切 mode 不能把 valueCheck 冲掉（saveAppSection 是整节替换）
		saveL1Mode(p3, "chat");
		const c3 = loadL1Config(p3);
		check("saveL1Mode 保留同节其他字段", c3.mode === "chat" && c3.valueCheck.enabled === false, JSON.stringify(c3));
		rmSync(p3, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 6. l1_commit 端到端：确定性闸门 ===");
	{
		const root = makeProfile({ enabled: false }); // 关掉价值校验，单独验闸门
		const commit = captureCommitTool(root);
		const base = { source: "subagent", cursor: "2026-09-17T00:00:00.000Z", records: [REC()] };

		const okRes = await commit(base);
		check("正常记录可提交", okRes.success === true, `written=${okRes.written}`);

		const badType = await commit({ ...base, records: [REC({ type: "architecture" })] });
		check("type 越枚举 → 整批拒绝", badType.success === false && String(badType.error).includes("越出枚举"), String(badType.error).slice(0, 50));

		const badPriority = await commit({ ...base, records: [REC({ priority: 120 })] });
		check("priority 越界 → 整批拒绝", badPriority.success === false && String(badPriority.error).includes("越界"));

		const emptyContent = await commit({ ...base, records: [REC({ content: "   " })] });
		check("content 空 → 整批拒绝", emptyContent.success === false && String(emptyContent.error).includes("非空"));

		const noPriority = await commit({ ...base, records: [REC({ priority: undefined })] });
		check("priority 省略 → 通过并补默认", noPriority.success === true && noPriority.priorityDefaulted === 1);

		const noProv = await commit({ ...base, records: [REC({ source_message_ids: [] })] });
		check("缺 source_message_ids → 软闸（通过 + 计数）", noProv.success === true && noProv.provenanceMissing === 1);

		const longContent = await commit({ ...base, records: [REC({ content: "甲".repeat(500) })] });
		check("超召回预算 → 软闸（通过 + 计数）", longContent.success === true && longContent.overRecallBudget === 1 && longContent.overBudgetMax === 500);

		// 被拒的批次不得改动库（分片名按**本地日期**，不用 UTC 推）
		const shardDir = join(root, "memoryDB", "l1", "records");
		const shardFiles = existsSync(shardDir) ? readdirSync(shardDir).filter((f) => f.endsWith(".jsonl")) : [];
		const lines = shardFiles.flatMap((f) => readFileSync(join(shardDir, f), "utf-8").split("\n").filter(Boolean));
		const types = lines.map((l) => JSON.parse(l).type);
		check("被拒批次未写库（只有合法 type）", types.length > 0 && types.every((t) => ["work_fact", "work_task", "work_method", "work_artifact"].includes(t)), types.join(","));
		rmSync(root, { recursive: true, force: true });
	}

	// ════════════════════════════════════════════════════════════════════════
	console.log("\n=== 7. l1_commit 端到端：价值校验接线（无模型必须 fail-open） ===");
	{
		const root = makeProfile({ enabled: true, maxTurns: 1 }); // 默认开；ctx 无 model → 应 skipped
		const commit = captureCommitTool(root);
		const res = await commit({ source: "subagent", cursor: "2026-09-17T00:00:00.000Z", records: [REC()] });
		check("价值校验开着也不阻断写盘", res.success === true);
		check("无可用模型 → 返回体带 skipped（fail-open 可观测）", !!res.valueCheck && !!res.valueCheck.skipped, JSON.stringify(res.valueCheck));

		const root2 = makeProfile({ enabled: false });
		const commit2 = captureCommitTool(root2);
		const res2 = await commit2({ source: "subagent", cursor: "2026-09-17T00:00:00.000Z", records: [REC()] });
		check("关掉时不出现 valueCheck 字段", res2.success === true && res2.valueCheck === undefined);

		// 主代理路径不跑价值校验（同步工具调用不能被 LLM 卡住）
		const res3 = await commit2({ source: "main-agent", records: [{ content: "主代理直写的事实", type: "work_fact" }] });
		check("main-agent 路径不出现 valueCheck", res3.success === true && res3.valueCheck === undefined);
		rmSync(root, { recursive: true, force: true });
		rmSync(root2, { recursive: true, force: true });
	}
}

main()
	.then(() => {
		console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
		if (fail > 0) process.exit(1);
	})
	.catch((err: unknown) => {
		console.error("\n用例执行异常：", err);
		process.exit(1);
	});
