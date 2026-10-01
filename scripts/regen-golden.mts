// 一次性脚本：用 registry.render() 的输出逐字节重写 prompts/.golden/tools.json 里指定的工具条目。
// （仓库约定：golden 没有生成器，改工具 description 后要拿 render 的输出逐字节写回。）
// 用法：tsx regen-golden.mts <工具名> [工具名...]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EX = "C:/Users/leaf/.pi/agent/extensions/memory-system";
const goldenPath = `${EX}/prompts/.golden/tools.json`;
const names = process.argv.slice(2);
if (names.length === 0) throw new Error("用法：tsx regen-golden.mts <工具名> [工具名...]");

const reg = (await import(pathToFileURL(`${EX}/prompts/registry.ts`).href)) as {
	render: (key: string, vars: Record<string, string>) => string;
};

const raw = readFileSync(goldenPath, "utf-8");
const gold = JSON.parse(raw) as Record<string, { file: string; value: string }>;

for (const name of names) {
	if (!gold[name]) throw new Error(`golden 里没有 ${name}`);
	const out = reg.render(`tools#${name}`, {});
	const same = out === gold[name].value;
	console.log(`${name}: ${gold[name].value.length} -> ${out.length} chars, ${same ? "未变" : "已更新"}`);
	gold[name].value = out;
}

writeFileSync(goldenPath, JSON.stringify(gold, null, 2) + "\n", "utf-8");
console.log("写回", goldenPath);
