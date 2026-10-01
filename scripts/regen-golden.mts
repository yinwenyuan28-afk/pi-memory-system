// 一次性脚本：用 registry.render() 的输出逐字节重写 prompts/.golden/tools.json 里指定的工具条目。
// （仓库约定：golden 没有生成器，改工具 description 后要拿 render 的输出逐字节写回。）
// 用法：node --experimental-strip-types regen-golden.mts <工具名> [工具名...]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 定位从脚本自身位置推导，不写死插件绝对路径（2026-10-01：原为硬编码 C:/Users/leaf/…）
const EX = join(dirname(fileURLToPath(import.meta.url)), "..");
const goldenPath = join(EX, "prompts", ".golden", "tools.json");
const names = process.argv.slice(2);
if (names.length === 0) throw new Error("用法：regen-golden.mts <工具名> [工具名...]");

const reg = (await import(pathToFileURL(join(EX, "prompts", "registry.ts")).href)) as {
	render: (key: string, vars: Record<string, string>) => string;
};
// 与生产调用点共用同一张变量表：部分 description 里的数字由 config/thresholds.ts 注入，
// 不用同一份 vars 渲染出来的文本与生产不一致，golden 就失去意义。
const { promptVarsFor } = (await import(pathToFileURL(join(EX, "prompts", "tool-vars.ts")).href)) as {
	promptVarsFor: (key: string) => Record<string, string>;
};

const raw = readFileSync(goldenPath, "utf-8");
const gold = JSON.parse(raw) as Record<string, { file: string; value: string }>;

for (const name of names) {
	if (!gold[name]) throw new Error(`golden 里没有 ${name}`);
	const key = `tools#${name}`;
	const out = reg.render(key, promptVarsFor(key));
	const same = out === gold[name].value;
	console.log(`${name}: ${gold[name].value.length} -> ${out.length} chars, ${same ? "未变" : "已更新"}`);
	gold[name].value = out;
}

writeFileSync(goldenPath, JSON.stringify(gold, null, 2) + "\n", "utf-8");
console.log("写回", goldenPath);
