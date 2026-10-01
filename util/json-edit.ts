/**
 * util/json-edit.ts —— JSON 文本的**定点编辑**（只改一个键，其余字节原样保留）
 *
 * 解决的问题（STANDALONE_RELEASE_PLAN P1-6）：
 * 插件要在宿主的 `settings.json` 里记一个键（当前记忆 profile 名）。原来的写法是
 * `JSON.parse` 整个文件 → 改对象 → `JSON.stringify` 整个文件 → `writeFileSync` 覆写。
 * 对**自己独占**的文件这没问题，对**宿主拥有、还有别的写者**的文件就有三个隐患：
 *
 *   1. **撕裂写**：writeFileSync 是「截断 → 重写」，并发读者可能读到半截 JSON。
 *      宿主的 settings-manager 读失败会记 `globalSettingsLoadError`，
 *      之后 `save()` 直接 early-return —— 一次写坏 = 整个会话的配置写入静默失效。
 *   2. **丢更新**：读-改-写之间没有锁。宿主在这中间改过别的键，我们的旧快照会把它的改动抹掉。
 *   3. **不该碰的键被重排**：整份重新序列化会规范化格式（缩进、空白），
 *      也会把当前进程不认识的键原样重写一遍 —— 我们只想改一个值，凭什么动别人的字段。
 *
 * 本模块的思路：**不做 parse→stringify 往返**，而是直接在原始文本上定位到目标值的那一段
 * 字符，只替换那一段，其余部分按原字节拼回。改完之后文件里除了目标值，其它键的字节完全没动，
 * 上面的 1 和 3 从根上消失（2 由调用方的「写后校验 + 重试」兜）。
 *
 * ── 为什么不处理 JSONC 注释 ─────────────────────────────────────────
 * 本模块服务于宿主的 `settings.json`，而宿主用**严格 `JSON.parse`** 读它
 * （`pi-coding-agent/dist/core/settings-manager.js` 的 `loadFromStorage`），
 * 所以这个文件在物理上不可能含注释 —— 含了就宿主自己也读不了。
 * 与 `util/jsonc.ts`（那是给插件自己的 `application-propertis.json` 用的，那边确实有注释）
 * 是两套不同场景，不要把注释处理逻辑合并过来。
 *
 * 用法：
 *   spliceJsonKey(text, "memorySystem.activeProfile", '"work"')
 *     → 键已存在：只替换那个值；键不存在：在所在对象末尾插入
 *     → 中间层对象不存在：把剩余路径整体作为一个新对象插入
 *   rawValue 必须是**已 JSON.stringify 过的字面量**（字符串要自带引号）。
 */

/** spliceJsonKey 的结果：改完的文本，以及这次到底是「改值」还是「插入」。 */
export interface SpliceResult {
	/** 编辑后的完整文本。 */
	text: string;
	/** 命中的成员原本是否存在（false = 本次是插入）。 */
	replaced: boolean;
}

/**
 * 在 JSON 文本里定点替换/插入一个键的值。
 *
 * @param text      原始 JSON 文本（顶层必须是对象；空串/纯空白请先归一成 `"{}"`）
 * @param keyPath   点号路径，如 `"memorySystem.activeProfile"`；单段则改顶层键
 * @param rawValue  已 `JSON.stringify` 过的值字面量（字符串要自带引号，如 `'"work"'`）
 * @returns 编辑结果；`replaced` 区分「改了已有值」与「新插入」
 * @throws 文本不是合法 JSON、顶层不是对象、或结构未闭合 —— 宁可抛错也不产出半成品
 */
export function spliceJsonKey(text: string, keyPath: string, rawValue: string): SpliceResult {
	const segs = keyPath.split(".").filter((s) => s.length > 0);
	if (!segs.length) throw new Error("spliceJsonKey: keyPath 不能为空");

	// 先整体 parse 一次做前置校验：宁可在这里失败，也不要在一个已经损坏的文件上叠加编辑
	try {
		JSON.parse(text);
	} catch (e) {
		throw new Error(`spliceJsonKey: 文本不是合法 JSON（${(e as Error).message}）`);
	}

	const start = skipWs(text, 0);
	if (text[start] !== "{") {
		throw new Error("spliceJsonKey: 顶层不是 JSON 对象，无法定点编辑");
	}

	return spliceIn(text, start, segs, rawValue);
}

// ── 内部实现 ──────────────────────────────────────────────────────

/**
 * 在 `text[objStart]` 处的对象内设置 `segs[0..]` 路径的值为 rawValue。
 *
 * 递归下降：只要还有下一段就往下走；到叶子时要么原地替换值，要么在对象末尾插入。
 * 子文本用 slice 切出来单独处理再拼回 —— 长度会变，但拼的是前后两段原文，不受影响。
 */
function spliceIn(text: string, objStart: number, segs: string[], rawValue: string): SpliceResult {
	const objEnd = skipContainer(text, objStart) - 1; // '}' 的下标

	// 叶子：就在本对象里找这个键
	if (segs.length === 1) {
		const hit = findMember(text, objStart, objEnd, segs[0]);
		if (hit) {
			// 只切掉值那一段；键名、引号、冒号、空白、逗号全部保留
			return { text: text.slice(0, hit.valueStart) + rawValue + text.slice(hit.valueEnd), replaced: true };
		}
		return { text: insertMember(text, objStart, objEnd, segs[0], rawValue), replaced: false };
	}

	// 还有下一层：中间对象在不在？
	const child = findMember(text, objStart, objEnd, segs[0]);
	if (!child) {
		// 整条剩余路径包成一个新对象插进去，例如 memorySystem 整个不存在时
		// 插入  "memorySystem": { "activeProfile": "work" }
		return { text: insertMember(text, objStart, objEnd, segs[0], buildNested(segs, rawValue)), replaced: false };
	}

	const head = text.slice(0, child.valueStart);
	const childText = text.slice(child.valueStart, child.valueEnd);
	const tail = text.slice(child.valueEnd);
	const inner = spliceIn(childText, 0, segs.slice(1), rawValue);
	return { text: head + inner.text + tail, replaced: inner.replaced };
}

/** 一个成员在对象内的位置：`{ "k": <value>, ... }` 里各段的起止下标。 */
interface MemberSpan {
	/** 键名左引号的位置。 */
	keyStart: number;
	/** 值的起始位置（冒号与空白之后）。 */
	valueStart: number;
	/** 值的结束位置（不含，即值最后一个字符 + 1）。 */
	valueEnd: number;
}

/**
 * 在对象 `text[objStart..objEnd]`（objEnd = 右花括号下标）内查找名为 `key` 的**直接成员**。
 *
 * 只认直接成员 —— 嵌套对象里的同名键不会被误命中（这正是手写扫描器而非正则的价值：
 * `"activeProfile"` 三个字符完全可能出现在别的字符串值里，也可能出现在更深一层的键上）。
 *
 * @returns 找到返回位置；不存在返回 undefined
 */
function findMember(text: string, objStart: number, objEnd: number, key: string): MemberSpan | undefined {
	let i = objStart + 1; // 跳过 '{'
	for (;;) {
		i = skipWs(text, i);
		if (i >= objEnd) return undefined; // 到头（空对象或结构异常）
		if (text[i] !== '"') {
			throw new Error(`spliceJsonKey: 期望键名引号，位置 ${i} 却是 ${JSON.stringify(text[i])}`);
		}
		const keyEnd = skipString(text, i);
		let name: string;
		try {
			name = JSON.parse(text.slice(i, keyEnd)) as string;
		} catch {
			throw new Error(`spliceJsonKey: 位置 ${i} 的键名不是合法 JSON 字符串`);
		}

		let j = skipWs(text, keyEnd);
		if (text[j] !== ":") {
			throw new Error(`spliceJsonKey: 键 '${name}' 之后期望冒号，位置 ${j} 却是 ${JSON.stringify(text[j])}`);
		}
		j = skipWs(text, j + 1);
		const valueEnd = readValueEnd(text, j);

		if (name === key) return { keyStart: i, valueStart: j, valueEnd };
		i = skipWs(text, valueEnd);
		if (text[i] === ",") {
			i++;
			continue;
		}
		return undefined; // 没有逗号了 ⇒ 已是最后一个成员
	}
}

/** 在对象末尾插入一个新成员，并处理逗号、换行与缩进。 */
function insertMember(text: string, objStart: number, objEnd: number, key: string, rawValue: string): string {
	const entry = `${JSON.stringify(key)}: ${rawValue}`;
	const first = skipWs(text, objStart + 1);

	// 空对象：不需要前导逗号
	if (first >= objEnd || text[first] === "}") {
		return text.slice(0, objEnd) + entry + text.slice(objEnd);
	}

	// 逗号插在「末项最后一个非空白字符之后」，**不是** objEnd 之前。
	// 两者在多行对象上差别很大：按 objEnd 插会得到
	//     "tuiMode": "regular"
	//     ,
	//     "memorySystem": { ... }}
	// —— 逗号被甩到下一行、结尾花括号还跟新项挤在一行。夹在两者之间的空白
	// （换行 + 右花括号的缩进）原样保留在新增项**之后**，右花括号因此保持原样。
	let last = objEnd - 1;
	while (last > objStart && " \t\r\n".includes(text[last])) last--;
	const at = last + 1;
	const gap = text.slice(at, objEnd);

	const gapEol = gap.includes("\r\n") ? "\r\n" : gap.includes("\n") ? "\n" : "";
	// 紧凑单行对象（gap 里没有换行）就保持紧凑，不硬塞换行和缩进去
	if (!gapEol) return text.slice(0, at) + "," + entry + gap + text.slice(objEnd);

	return text.slice(0, at) + "," + gapEol + lineIndent(text, first) + entry + gap + text.slice(objEnd);
}

/** 把剩余路径（不含已由调用方消费的第一段）包成一个嵌套对象字面量。 */
function buildNested(segs: string[], rawValue: string): string {
	let out = rawValue;
	for (let k = segs.length - 1; k >= 1; k--) {
		out = `{ ${JSON.stringify(segs[k])}: ${out} }`;
	}
	return out;
}

/** 从 i 开始读一个 JSON 值，返回它结束后的下标（不含）。 */
function readValueEnd(text: string, i: number): number {
	const c = text[i];
	if (c === '"') return skipString(text, i);
	if (c === "{" || c === "[") return skipContainer(text, i);
	// 字面量（数字 / true / false / null）：读到下一个分隔符为止
	let j = i;
	while (j < text.length && !",}] \t\r\n".includes(text[j])) j++;
	if (j === i) throw new Error(`spliceJsonKey: 位置 ${i} 处不是一个值`);
	return j;
}

/** 从左引号开始读完整个字符串，返回结束后的下标（不含右引号之后的那个位置）。 */
function skipString(text: string, i: number): number {
	let j = i + 1;
	while (j < text.length) {
		const c = text[j];
		if (c === "\\") {
			j += 2; // 转义：反斜杠与它后面那个字符整体跳过
			continue;
		}
		if (c === '"') return j + 1;
		j++;
	}
	throw new Error(`spliceJsonKey: 位置 ${i} 开始的字符串未闭合`);
}

/** 从 `{` / `[` 开始跳到配对的闭合符之后，返回该位置（不含）。 */
function skipContainer(text: string, i: number): number {
	let depth = 0;
	let inString = false;
	for (let j = i; j < text.length; j++) {
		const c = text[j];
		if (inString) {
			if (c === "\\") {
				j++;
				continue;
			}
			if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			continue;
		}
		if (c === "{" || c === "[") depth++;
		else if (c === "}" || c === "]") {
			depth--;
			if (depth === 0) return j + 1;
		}
	}
	throw new Error(`spliceJsonKey: 位置 ${i} 开始的容器未闭合`);
}

/** 跳过空白。 */
function skipWs(text: string, i: number): number {
	let j = i;
	while (j < text.length && " \t\r\n".includes(text[j])) j++;
	return j;
}

/** 取位置 i 所在行的前导空白。 */
function lineIndent(text: string, i: number): string {
	let ls = i;
	while (ls > 0 && text[ls - 1] !== "\n") ls--;
	let j = ls;
	while (j < i && (text[j] === " " || text[j] === "\t")) j++;
	return text.slice(ls, j);
}