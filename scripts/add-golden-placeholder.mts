// 一次性脚本：给 golden 加一个空占位条目，供 regen-golden.mts 填内容
// （regen-golden.mts:20 的 `if (!gold[name]) throw` 决定了必须先手加占位）
import { readFileSync, writeFileSync } from "node:fs";

const goldenPath = "C:/Users/leaf/.pi/agent/extensions/memory-system/prompts/.golden/tools.json";
const [name, file] = process.argv.slice(2);
if (!name || !file) throw new Error("用法：tsx add-golden-placeholder.mts <工具名> <源码文件>");

const gold = JSON.parse(readFileSync(goldenPath, "utf-8")) as Record<string, { file: string; value: string }>;
if (gold[name] && gold[name].value) {
	console.log(`${name} 已有内容，跳过`);
} else {
	gold[name] = { file, value: "" };
	// 保持与 tools.md 相同的声明顺序，便于人工比对
	const ordered: Record<string, { file: string; value: string }> = {};
	for (const k of Object.keys(gold)) ordered[k] = gold[k];
	writeFileSync(goldenPath, JSON.stringify(ordered, null, 2) + "\n", "utf-8");
	console.log(`已加占位：${name} → ${file}`);
}
