/**
 * i18n/index.ts —— 国际化唯一入口（扩展侧）
 *
 * 用法（业务代码只碰这三件事）：
 *   - `t("ext.notify.noProfile")`            取词（点号路径）
 *   - `t("ext.l2.archive.done", { name, n })` 带命名参数取词（模板里写 `{{name}}`）
 *   - `t` 之外最多再调 `refreshLocaleFromConfig(profilePath)`（会话启动时应用配置）
 *
 * ── 三条硬规矩（违反即被 scripts/verify-i18n.mjs 或评审拦下）──────────────
 *   1. **整句做键 + `{{name}}` 命名参数**。禁止把一句话拆成「前缀 + 数字 + 后缀」的
 *      碎片键（中英语序不同、复数不同，碎片键拼不出正确句子）；禁止 `%s` / `{0}` 位置参数。
 *   2. **缺失键可见**：查不到返回 `⟦key⟧` 并记账，**不静默回退中文** —— 半句回退会让
 *      「漏翻」在英文环境里悄悄变成中文，没人发现。
 *   3. **只翻给人看的**。写进模型上下文（注入块、工具 description、prompts/**）或落盘
 *      成数据的内容一律不进词表（见 i18n/README.md 的边界表）。
 *
 * ── 目录与装载 ─────────────────────────────────────────────────────────
 * 词表 = `i18n/locales/<lang>.json`（嵌套 JSON，装载时拍平成点号路径）。
 * 语言清单**从目录实时列举**，不硬编码 ⇒ 新增语言 = 加一个 json 文件，零代码改动。
 * 用 `fs.readFileSync` 而不是 `import ... with { type: "json" }`：扩展由 pi 的 jiti 加载、
 * 回归脚本由 `node --experimental-strip-types` 加载，两套变换链对 JSON import attributes
 * 的支持不一致；fs 读文件在两者下都必然可用。
 *
 * ── 语言何时生效（诚实声明，不假装可热切换）──────────────────────────────
 * 命令/工具的 description 在扩展工厂期就注册（早于 session_start），那一刻还没有活跃
 * profile，所以进程内先用「env/系统区域」初始化一次；session_start 读到 profile 配置后
 * 再用 `refreshLocaleFromConfig()` 覆盖。**命令 description 与已渲染的卡片要到下次
 * `/reload` 才刷新；状态栏可以即时刷（调用方 refreshStatus）。**
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAppProps, saveAppSection } from "../config/app-config.ts";
import { PLUGIN_ROOT } from "../util/agent-dir.ts";
import { AUTO, SOURCE_LOCALE, resolveLocale } from "./locale.ts";

/** 词表目录（随包发布，见 package.json 的 files）。 */
export const LOCALES_DIR = join(PLUGIN_ROOT, "i18n", "locales");

/** `application-propertis.json` 里语言配置所在的节名。 */
export const LANGUAGE_SECTION = "language";

/** 当前语言（= locales 目录里的文件名，不带 .json）。 */
let currentLocale: string | undefined;
/** 当前语言的拍平词表（点号路径 → 文案）。 */
let currentFlat: Map<string, string> = new Map();
/** 运行时缺失的键（`t()` 查不到时记账；交付/诊断时可见，不静默）。 */
const missingKeys = new Set<string>();

/** 列举可选语言（locales 目录里的 `*.json`，按名排序）。目录缺失时只有源语言。 */
export function listLocales(): string[] {
	try {
		const names = readdirSync(LOCALES_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -".json".length));
		if (names.length > 0) return names.sort();
	} catch {
		// 目录不存在（未随包发布 / 被删）→ 落到源语言兜底
	}
	return [SOURCE_LOCALE];
}

/** 驼峰/普通键都保留原样，只把嵌套结构拍成 `a.b.c` 形式的点号路径。 */
function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
	if (typeof value === "string") {
		out.set(prefix, value);
		return;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			flatten(child, prefix ? `${prefix}.${key}` : key, out);
		}
	}
}

/** 读一个词表文件并拍平。读不到/非法 → 空表（缺失键会在 `t()` 处显形，不静默）。 */
function loadCatalog(locale: string): Map<string, string> {
	const out = new Map<string, string>();
	try {
		const parsed = JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), "utf-8"));
		flatten(parsed, "", out);
	} catch {
		// 保持空表：调用方 t() 会返回 ⟦key⟧ 标记，问题可见
	}
	return out;
}

/** 兜底语言：源语言在可选清单里就用它，否则取清单第一项。 */
function fallbackLocale(available: readonly string[]): string {
	return available.includes(SOURCE_LOCALE) ? SOURCE_LOCALE : (available[0] ?? SOURCE_LOCALE);
}

/** 读配置里写的语言值（`auto`/缺省都返回原值，交给 resolveLocale 判定）。 */
export function readLanguageSetting(profilePath: string | undefined): unknown {
	if (!profilePath) return undefined;
	try {
		const section = loadAppProps(profilePath)?.[LANGUAGE_SECTION];
		if (section && typeof section === "object" && !Array.isArray(section)) {
			return (section as Record<string, unknown>).locale;
		}
	} catch {
		// 配置读失败不该影响主流程；当作「未配置」→ 走自动探测
	}
	return undefined;
}

/**
 * 写语言配置（`{ "language": { "locale": "<value>" } }`，读-改-写只动这一节）。
 *
 * @param profilePath 活跃 profile 根目录
 * @param value       `auto` | 语言名（如 `zh-CN` / `en`）
 */
export function writeLanguageSetting(profilePath: string, value: string): void {
	saveAppSection(profilePath, LANGUAGE_SECTION, { locale: value });
}

/** 应用语言：装载词表。 */
function applyLocale(locale: string): void {
	currentLocale = locale;
	currentFlat = loadCatalog(locale);
}

/**
 * 初始化（幂等）：进程内第一次取词前调一次即可。
 *
 * 此刻通常还没有活跃 profile，故只能读 env/系统区域；会话启动后应再调
 * `refreshLocaleFromConfig()` 让配置生效。
 */
export function initI18n(): void {
	if (currentLocale) return;
	const available = listLocales();
	applyLocale(resolveLocale(readLanguageSetting(process.env.PI_PROFILE_PATH), available, fallbackLocale(available)));
}

/**
 * 按 profile 配置重新解析语言（会话启动 / 切换 profile 后调用）。
 * 语言未变时是空操作，不会白白重读文件。
 *
 * @param profilePath 活跃 profile 根目录（缺省则沿用 PI_PROFILE_PATH）
 */
export function refreshLocaleFromConfig(profilePath?: string): void {
	const available = listLocales();
	const configured = readLanguageSetting(profilePath ?? process.env.PI_PROFILE_PATH);
	const next = resolveLocale(configured, available, fallbackLocale(available));
	if (next !== currentLocale) applyLocale(next);
}

/** 强制设定语言（测试 / 调试用；正常路径请走配置 + refreshLocaleFromConfig）。 */
export function setLocale(locale: string): void {
	const available = listLocales();
	const hit = available.find((a) => a.toLowerCase() === locale.toLowerCase());
	applyLocale(hit ?? locale);
}

/** 当前语言（未初始化时先做一次默认初始化）。 */
export function getLocale(): string {
	if (!currentLocale) initI18n();
	return currentLocale!;
}

/** 是否有该语言的词表（供命令做合法性校验）。 */
export function hasLocale(locale: string): boolean {
	return listLocales().some((a) => a.toLowerCase() === locale.toLowerCase());
}

/** 把 `{{name}}` 占位替换为参数值；未提供的占位原样保留（便于发现漏传参）。 */
function interpolate(template: string, params: Record<string, string | number>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
		Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
	);
}

/**
 * 取词。
 *
 * @param key    点号路径（如 `ext.notify.noProfile`）
 * @param params 命名参数（模板里用 `{{name}}`）
 * @returns 文案；**键不存在时返回 `⟦key⟧`**（可见的缺失，而不是静默回退中文）
 */
export function t(key: string, params?: Record<string, string | number>): string {
	if (!currentLocale) initI18n();
	const raw = currentFlat.get(key);
	if (raw === undefined) {
		missingKeys.add(key);
		return `⟦${key}⟧`;
	}
	return params ? interpolate(raw, params) : raw;
}

/** 运行时缺失键的快照（诊断/测试用；正常应为空，由 verify-i18n 的键对等保证）。 */
export function getMissingKeys(): string[] {
	return [...missingKeys].sort();
}

/** 配置里代表「自动探测」的哨兵（命令层复用，避免各处硬编码 "auto"）。 */
export { AUTO, SOURCE_LOCALE };
