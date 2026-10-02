// 类型检查门禁（运行时 .ts 的「找不到名字 / 找不到模块 / 模块没有该导出」类错误）
//
// 为什么有这个脚本（2026-09-20 事故后的补丁）：
//   仓库没有构建产物（pi 用 jiti 直接跑 .ts），因此**没有任何东西会拦住"变量名写错""导入路径写错"**
//   这类错误。当天把 store.ts 的 console.* 改道时把 `baseProfilePath`（只存在于 getVectorStore）
//   写进了 createSqliteVecStore（形参叫 profilePath）→ 向量库初始化成功路径抛 ReferenceError，
//   子代理的 embed_and_search 连续 11 次 fallback、两批共 17 条 L1 记录没进向量库，
//   而 9 套回归全绿（没有一条用例真的初始化过向量库）。这个脚本就是把 tsc 当"拼写检查"用。
//
// 只报这几类（其余错误一律无视，避免既有噪音淹没门禁）：
//   TS2304 找不到名字 / TS2552 找不到名字（是不是想写 X）/ TS2307 找不到模块 /
//   TS2305 模块没有该导出 / TS2459 模块内部有但没导出 / TS2454 变量使用前未赋值
// 已存在的历史条目列在 type-check-baseline.json（只允许减少，新增即 FAIL）。
//
// 用法：node agent/extensions/memory-system/scripts/check-types.mjs
// 退出码：0 = 无新增；1 = 有新增或环境不可用。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = join(EXT_ROOT, "scripts", "type-check-baseline.json");

/** 被检查的运行时目录（排除 scripts/ 工具与 node_modules；scripts 里是回归脚本，不参与运行）。 */
// "workflow" 已于 2026-10-02 随目录一并删除（停用近一年、2354 行死代码，用户拍板删）。
// 若将来重建工作流系统，记得把 "workflow" 加回这里，否则新代码不受门禁覆盖。
const RUNTIME_ROOTS = ["index.ts", "memory", "util", "skill", "prompts", "config"];

/** 门禁覆盖的错误码（"名字/模块/导出"类；其余类型噪音不在此列）。 */
const GATED = new Set(["TS2304", "TS2552", "TS2307", "TS2305", "TS2459", "TS2454"]);

/** tsc 的编译选项：与 jiti 的实际加载方式对齐（无 tsconfig，全部走命令行）。 */
const TSC_FLAGS = [
	"--noEmit",
	"--target", "es2022",
	"--module", "esnext",
	"--moduleResolution", "bundler",
	"--allowImportingTsExtensions",
	"--skipLibCheck",
];

/** 找 tsc：环境变量 > 全局安装 > pi fork 自带。返回可执行的 (nodeArgs) 或 null。 */
function resolveTsc() {
	if (process.env.TSC_PATH && existsSync(process.env.TSC_PATH)) {
		return { label: `TSC_PATH=${process.env.TSC_PATH}`, entry: process.env.TSC_PATH };
	}
	const candidates = [];
	// 候选 1：与当前 node 同 prefix 的全局 node_modules（npm i -g typescript 的标准落点）
	candidates.push({
		label: "当前 node 的全局 node_modules",
		entry: join(dirname(process.execPath), "node_modules", "typescript", "lib", "tsc.js"),
	});
	// 候选 2：问 npm（字符串形式 + shell：Windows 下 npm 是 .cmd，且带 args 的 shell 调用会触发 DEP0190）
	if (!existsSync(candidates[0].entry)) {
		try {
			const r = spawnSync("npm root -g", { encoding: "utf8", shell: true });
			const globalRoot = (r.stdout ?? "").trim();
			if (r.status === 0 && globalRoot) {
				candidates.push({ label: `全局 npm（${globalRoot}）`, entry: join(globalRoot, "typescript", "lib", "tsc.js") });
			}
		} catch {
			// npm 不可用 → 看最后一个候选
		}
	}
	candidates.push({
		label: "pi fork 自带（C:/dev/ide/pi-agent/pi-0.80.10）",
		entry: "C:/dev/ide/pi-agent/pi-0.80.10/node_modules/typescript/lib/tsc.js",
	});
	for (const c of candidates) {
		if (existsSync(c.entry)) return c;
	}
	return null;
}

/** 收集待检文件（.ts，跳过 node_modules）。 */
function collectFiles(rel) {
	const abs = join(EXT_ROOT, rel);
	if (!existsSync(abs)) return [];
	if (!statSync(abs).isDirectory()) return [abs];
	const out = [];
	const stack = [abs];
	while (stack.length > 0) {
		const dir = stack.pop();
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name !== "node_modules") stack.push(p);
			} else if (e.name.endsWith(".ts")) {
				out.push(p);
			}
		}
	}
	return out;
}

/** 从 tsc 输出里提取 (相对路径, 行, 列, 错误码, 标识符)。 */
function parseErrors(stdout) {
	const out = [];
	for (const line of stdout.split(/\r?\n/)) {
		const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
		if (!m) continue;
		const [, file, row, col, code, message] = m;
		if (!GATED.has(code)) continue;
		// 名字/模块名用于基线匹配（行号会漂，名字不会）
		const ident =
			message.match(/'([^']+)'/)?.[1] ??
			message.match(/"([^"]+)"/)?.[1] ??
			message.slice(0, 60);
		out.push({ file: relative(EXT_ROOT, file).replace(/\\/g, "/"), row: Number(row), col: Number(col), code, ident, message });
	}
	return out;
}

const tsc = resolveTsc();
if (!tsc) {
	console.error("✗ 找不到 tsc。装法（二选一）：");
	console.error("  ① npm i -g typescript      （推荐，本脚本自动找全局安装）");
	console.error("  ② set TSC_PATH=<path-to>/typescript/lib/tsc.js");
	process.exit(1);
}

const files = RUNTIME_ROOTS.flatMap(collectFiles);
console.log(`类型检查（${GATED.size} 类错误）· ${files.length} 个运行时 .ts · tsc=${tsc.label}`);

const res = spawnSync(process.execPath, [tsc.entry, ...TSC_FLAGS, ...files], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (res.error) {
	console.error(`✗ tsc 启动失败：${res.error.message}`);
	process.exit(1);
}
const errors = parseErrors(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);

const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : [];
const key = (e) => `${e.file}|${e.code}|${e.ident}`;
const baselineKeys = new Set(baseline.map((b) => `${b.file}|${b.code}|${b.ident}`));
const currentKeys = new Set(errors.map(key));

const fresh = errors.filter((e) => !baselineKeys.has(key(e)));
const stale = baseline.filter((b) => !currentKeys.has(`${b.file}|${b.code}|${b.ident}`));

console.log(`  已知条目（基线）: ${baseline.length}   本次命中: ${errors.length}   新增: ${fresh.length}`);
for (const b of baseline) console.log(`  · 基线 ${b.file} [${b.code}] ${b.ident}${b.why ? ` — ${b.why}` : ""}`);
for (const e of errors) console.log(`  ${fresh.includes(e) ? "NEW!" : "    "} ${e.file}:${e.row}:${e.col} [${e.code}] ${e.message}`);
if (stale.length > 0) {
	console.log(`  （提示：基线里 ${stale.length} 条已不再出现，可删：${stale.map((s) => `${s.file}[${s.code}]${s.ident}`).join(", ")}）`);
}

if (fresh.length > 0) {
	console.error(`\n✗ 类型检查失败：新增 ${fresh.length} 处「名字/模块/导出」类错误（上表标 NEW! 的行）。`);
	console.error("  这类错误在无构建仓库里只能靠运行时撞见——先修，别加进基线。");
	process.exit(1);
}
console.log("\n✓ 类型检查通过（无新增）");
