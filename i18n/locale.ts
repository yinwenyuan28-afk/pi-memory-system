/**
 * i18n/locale.ts —— 语言解析（纯函数，无 IO，便于单测）
 *
 * 职责：把「配置里写的语言 / 环境变量 / 系统区域」这一堆来源，收敛成一个
 * **本仓库如实存在的语言目录名**（= `i18n/locales/<name>.json` 的 `<name>`）。
 *
 * 取值优先级（高 → 低）：
 *   1. 配置 `application-propertis.json` 的 `language.locale`（`auto` 视同未配置）
 *   2. 环境变量：LC_ALL → LC_MESSAGES → LANG
 *   3. 系统区域：`Intl.DateTimeFormat().resolvedOptions().locale`
 *   4. 兜底：源语言 zh-CN
 *
 * 为什么第 2 档在 Windows 上形同虚设：本扩展仅支持 Windows（见 README「环境要求」），
 * 而 Windows 默认**不设置** LANG/LC_* 这一族变量。所以实际生效的探测档是第 3 档
 * （系统区域）—— 英文 Windows 判为 en、中文 Windows 判为 zh-CN。这里仍保留 env 档，
 * 是因为 Git Bash / CI 里常被显式设上，且成本为零。
 *
 * 「可扩展」在这里的落点：本模块**不硬编码语言清单**，语言清单由调用方从
 * `i18n/locales/` 目录实时列举后传入。因此新增一门语言 = 丢一个 `<lang>.json`，
 * 不改这里任何一行。
 */

/** 源语言（所有键的权威出处；也是探测全落空时的兜底）。 */
export const SOURCE_LOCALE = "zh-CN";

/** 配置里代表「交给自动探测」的哨兵值。 */
export const AUTO = "auto";

/**
 * 把一个原始语言串匹配到 `available` 里的某一项。
 *
 * 匹配规则（宽松，宁可用近似也不落空）：
 *   - 先精确匹配（忽略大小写，`_` 归一为 `-`）：`zh-cn` → `zh-CN`
 *   - 再按主语言匹配：`zh-TW` / `zh-Hans` → `zh-CN`；`en-GB` → `en`
 *   - `C` / `POSIX` / 空串 / 非字符串 → undefined（视为「没有意见」，交给下一档）
 *
 * @param raw       原始值（配置值、环境变量值或系统区域）
 * @param available 可选语言（= locales 目录里实际存在的文件名，不带 .json）
 * @returns 命中的语言名；无命中返回 undefined
 */
export function matchLocale(raw: unknown, available: readonly string[]): string | undefined {
	if (typeof raw !== "string") return undefined;
	const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
	if (!normalized || normalized === "c" || normalized === "posix") return undefined;

	const exact = available.find((a) => a.toLowerCase() === normalized);
	if (exact) return exact;

	const primary = normalized.split("-")[0];
	return available.find((a) => a.toLowerCase().split("-")[0] === primary);
}

/**
 * 自动探测语言：env → 系统区域。两者都没意见 → undefined（由调用方兜底）。
 *
 * @param available 可选语言（locales 目录列举结果）
 */
export function detectLocale(available: readonly string[]): string | undefined {
	const candidates = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG];
	for (const raw of candidates) {
		const hit = matchLocale(raw, available);
		if (hit) return hit;
	}
	try {
		return matchLocale(Intl.DateTimeFormat().resolvedOptions().locale, available);
	} catch {
		// 极简运行时可能没有 Intl；这不是错误，只是少了一档探测
		return undefined;
	}
}

/**
 * 解析最终语言：配置 → 探测 → 兜底。
 *
 * @param configured 配置值（`auto`/缺省/无法识别一律落到探测档）
 * @param available  可选语言（locales 目录列举结果）
 * @param fallback   兜底语言（通常是 SOURCE_LOCALE；若源语言不在 available 里则取第一项）
 */
export function resolveLocale(
	configured: unknown,
	available: readonly string[],
	fallback: string,
): string {
	return matchLocale(configured, available) ?? detectLocale(available) ?? fallback;
}
