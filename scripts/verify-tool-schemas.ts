// 工具 schema 合法性回归（只读；不触碰生产数据）
//
// 为什么需要它：2026-09-16 实测 —— L3 子代理第一次调用就被 provider 拒收：
//   Error: 400 Invalid schema for function 'l3_edit': true is not of type "array"
// 根因是把 `required: true` 写在**属性子 schema 里**（合法位置只有顶层 `required` 数组）。
// `index.ts` 的 registerTool 包装器本来就是为了「给严格 OpenAI 兼容 provider 补齐 schema」，
// 但它只处理"扁平 map"形态，对已声明 `type: "object"` 的 schema 原样透传 —— 于是这类非法写法
// 一路发到 provider 才炸，而且**炸在子代理侧**（主代理看不见、只看代码也看不出来）。
//
// 本脚本的做法：用一个假 pi 调扩展入口，拿到**经包装器归一化之后**的最终 schema
//（= 真正发给 provider 的东西），逐条校验。这是唯一能在本地复现该类问题的入口。
//
// 用 tsx 跑（package.json 是 commonjs，顶层 await 不可用）：
//   C:/dev/ide/pi-agent/pi-0.80.10/node_modules/.bin/tsx --conditions=import scripts/verify-tool-schemas.ts
// ⚠ `--conditions=import` 不能少（2026-09-30 实测）：本脚本 import 扩展入口 → config/model-config.ts
//   **静态** import `@earendil-works/pi-ai/compat`，而该包的 exports 只声明了 import 条件
//   （没有 require），少了就报 `ERR_PACKAGE_PATH_NOT_EXPORTED: './compat'`。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import extension from "../index.ts";

const EXT_ROOT = "C:/Users/leaf/.pi/agent/extensions/memory-system";

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

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

async function main(): Promise<void> {
	console.log("\n=== 1. 用假 pi 调入口，捕获全部已注册工具 ===");
	const tools: Array<Record<string, unknown>> = [];
	const commands: string[] = [];
	const warnings: string[] = [];
	const origWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	};

	const fakePi = {
		registerTool: (t: Record<string, unknown>) => {
			tools.push(t);
			return t;
		},
		on: () => undefined,
		registerCommand: (name: string) => {
			commands.push(name);
			return undefined;
		},
	};

	let entryThrew: string | null = null;
	try {
		extension(fakePi as never);
	} catch (e) {
		entryThrew = e instanceof Error ? e.message : String(e);
	}
	console.warn = origWarn;

	check("扩展入口可在假 pi 下执行", entryThrew === null, entryThrew ?? "");
	check("捕获到工具与命令", tools.length > 0 && commands.length > 0, `${tools.length} 工具 / ${commands.length} 命令`);

	console.log("\n=== 2. 逐工具校验「发给 provider 的最终 schema」 ===");
	for (const t of tools) {
		const name = String(t.name);
		const params = t.parameters as Record<string, unknown> | undefined;
		if (!params || typeof params !== "object") {
			check(`${name}: parameters 存在`, false);
			continue;
		}
		check(`${name}: 顶层 type === "object"`, params.type === "object", String(params.type));

		const props = params.properties as Record<string, Record<string, unknown>> | undefined;
		check(`${name}: properties 是对象`, !!props && typeof props === "object" && !Array.isArray(props));

		if ("required" in params) {
			const req = params.required;
			const okArr = isStringArray(req);
			// 顶层 required 必须是字符串数组 —— 这行就是本次 400 的同款检查
			check(`${name}: 顶层 required 是字符串数组`, okArr, JSON.stringify(req));
			if (okArr && props) {
				const unknown = req.filter((k) => !(k in props));
				check(`${name}: required 全部指向已声明属性`, unknown.length === 0, unknown.join(","));
			}
		}

		if (props) {
			// 关键：属性子 schema 里不得出现**非数组**的 required（本次 400 的根因）
			const offenders = Object.entries(props)
				.filter(([, spec]) => spec && typeof spec === "object" && "required" in spec && !Array.isArray((spec as { required: unknown }).required))
				.map(([k, spec]) => `${k}=${JSON.stringify((spec as { required: unknown }).required)}`);
			check(`${name}: 属性子 schema 无非数组 required`, offenders.length === 0, offenders.join(" "));

			const untyped = Object.entries(props)
				.filter(([, spec]) => {
					if (!spec || typeof spec !== "object") return true;
					if (Object.getOwnPropertySymbols(spec).length > 0) return false; // TypeBox
					return !("type" in spec) && !("enum" in spec) && !("$ref" in spec) && !("oneOf" in spec) && !("anyOf" in spec);
				})
				.map(([k]) => k);
			check(`${name}: 每个属性都声明了 type/enum`, untyped.length === 0, untyped.join(","));
		}

		const desc = t.description as string | undefined;
		check(`${name}: description 非空且无残留占位符`, typeof desc === "string" && desc.length > 10 && !desc.includes("{{"));
	}

	console.log("\n=== 3. 点名核查 L3 子代理唯一可见的两个扩展工具 ===");
	for (const name of ["l3_edit", "l3_commit"]) {
		const t = tools.find((x) => x.name === name);
		check(`${name} 已注册`, !!t);
		if (!t) continue;
		const params = t.parameters as { properties: Record<string, Record<string, unknown>>; required?: unknown };
		check(`${name}: required 是数组`, isStringArray(params.required), JSON.stringify(params.required));
		const inline = Object.keys(params.properties).filter((k) => "required" in params.properties[k]);
		check(`${name}: 无内联 required`, inline.length === 0, inline.join(","));
	}

	console.log("\n=== 4. l3_edit 的 action 枚举完整性 ===");
	{
		const t = tools.find((x) => x.name === "l3_edit");
		const props = (t?.parameters as { properties: Record<string, { enum?: unknown; type?: unknown }> }).properties;
		check("action.type === string", props?.action?.type === "string");
		check("action.enum = add/update/delete", JSON.stringify(props?.action?.enum) === JSON.stringify(["add", "update", "delete"]));
		check("content / target 为 string", props?.content?.type === "string" && props?.target?.type === "string");
	}

	console.log("\n=== 5. 源码静态扫描：不该再有 `required: true` 内联写法 ===");
	{
		// 包装器现在会兜住它，但源码本身也不该留这个哑弹（别人抄一下就又埋一颗）
		const hits: string[] = [];
		const scan = (rel: string) => {
			const p = join(EXT_ROOT, rel);
			if (!existsSync(p)) return;
			readFileSync(p, "utf-8")
				.split("\n")
				.forEach((ln, i) => {
					if (/^\s*required:\s*true\s*,?\s*$/.test(ln)) hits.push(`${rel}:${i + 1}`);
				});
		};
		scan("index.ts");
		for (const f of readdirSync(join(EXT_ROOT, "memory"), { recursive: true }) as string[]) {
			const rel = join("memory", String(f));
			if (!rel.endsWith(".ts")) continue;
			scan(rel);
		}
		check("源码无 `required: true` 内联写法", hits.length === 0, hits.join(","));
	}

	console.log("\n=== 6. 归一化告警可观测（有非法写法时包装器会留痕） ===");
	check(
		"本次无 schema 归一化告警（源码已干净）",
		warnings.filter((w) => w.includes("[tool-schema")).length === 0,
		warnings.filter((w) => w.includes("tool-schema")).join(" | "),
	);
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
