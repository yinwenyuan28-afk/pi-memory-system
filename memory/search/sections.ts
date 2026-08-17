/**
 * 章节级记忆切分模块（sections.ts）
 *
 * 用途：把子记忆 .md 文件按 `## ` 二级标题切分为章节，供章节级注入使用。
 * 背景：整文件注入导致文件膨胀 = 注入膨胀、无效章节浪费 token；章节级注入
 *       只取相关章节，文件可继续膨胀但注入量只跟相关章节走。
 *
 * 设计意图：
 *   - 切分粒度 = `## `（二级标题）：文件主题用 `# `，主题下章节用 `## `，
 *     章节内细节用 `### ` 及以上，不切更细粒度避免碎片化上下文。
 *   - frontmatter（文件头 `--- scope/created/updated/source/status ---`
 *     元信息块）剥离不注入——元信息对 LLM 无知识价值，纯浪费 token。
 *   - 无 `## ` 的小文件（<1KB 或整文件无标题）整文件作为单章节。
 */

/**
 * 记忆章节结构。
 * title 为空表示"前言"章节（文件主题 `# ` 标题 + 引言，在第一个 `## ` 之前）。
 */
export interface MemorySection {
	/** 章节标题（不含 `## ` 前缀）；空 = 前言 */
	title: string;
	/** 章节正文（不含标题行，含 `### ` 及以下子标题） */
	body: string;
	/** 章节序号（文件内从 0 起，用于 `file#序号` 唯一标识） */
	order: number;
}

/**
 * 剥离文件头 frontmatter 元信息块。
 *
 * @param content 文件完整内容
 * @returns 去掉开头 `---\n...\n---` 块后的内容；无 frontmatter 时原样返回。
 * 只匹配文件开头的 `---` 块，正文中的 `---` 分隔线不受影响。
 */
export function stripFrontmatter(content: string): string {
	const cleaned = content.replace(/^\uFEFF/, ""); // BOM
	const match = cleaned.match(/^---\n[\s\S]*?\n---\n?/);
	if (!match) return cleaned;
	return cleaned.slice(match[0].length);
}

/**
 * 按 `## ` 二级标题切分记忆文件为章节。
 *
 * @param content 文件完整内容（含或不含 frontmatter 均可，内部会先剥离）
 * @returns 章节数组（含前言章节）。无 `## ` 时返回单章节（title 空 = 整文件）。
 */
export function splitSections(content: string): MemorySection[] {
	const cleaned = stripFrontmatter(content);
	const lines = cleaned.split("\n");

	// 找所有 `## ` 标题行（含前导空白容错：缩进的 ## 也算）
	const sectionStarts: number[] = [];
	lines.forEach((line, i) => {
		if (/^\s*##\s+\S/.test(line)) sectionStarts.push(i);
	});

	// 无 `## `：整文件单章节
	if (sectionStarts.length === 0) {
		return [{ title: "", body: cleaned.trim(), order: 0 }];
	}

	const sections: MemorySection[] = [];

	// 前言：第一个 `## ` 之前的内容（含 `# ` 一级标题 + 引言块）
	const prelude = lines.slice(0, sectionStarts[0]).join("\n").trim();
	if (prelude) {
		sections.push({ title: "", body: prelude, order: 0 });
	}

	// 每个 `## ` 章节：标题行 → 下一个 `## ` 之前
	for (let i = 0; i < sectionStarts.length; i++) {
		const start = sectionStarts[i];
		const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1] : lines.length;
		const title = lines[start].replace(/^\s*##\s+/, "").trim();
		const body = lines.slice(start + 1, end).join("\n").trim();
		if (title || body) {
			sections.push({ title, body, order: sections.length });
		}
	}

	return sections;
}
