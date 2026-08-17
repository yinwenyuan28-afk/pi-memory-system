import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InvertedIndex } from "../search/inverted-index.js";
import type { DuplicateResult } from "./types.js";

/**
 * 语义重复检查 —— 利用倒排索引 + Jaccard 相似度。
 *
 * 写入前判断新内容与已有记忆是否语义重复。
 * ≥0.8 阻断并提示 replace，0.5~0.8 warning。
 */

/** Jaccard 相似度计算（基于词集合）。 */
function jaccardSimilarity(a: string[], b: string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	let intersection = 0;
	for (const item of setA) {
		if (setB.has(item)) intersection++;
	}
	const union = new Set([...setA, ...setB]).size;
	return union === 0 ? 0 : intersection / union;
}

/** 将文本分词为集合（复用倒排索引的分词逻辑）。 */
function tokenizeSet(text: string, index: InvertedIndex): string[] {
	return index.tokenizeSync(text);
}

/**
 * 检查新内容是否与已有记忆语义重复。
 *
 * @param content       要写入的内容
 * @param invertedIndex 倒排索引实例
 * @param profilePath   profile 目录路径
 * @returns DuplicateResult
 */
export function checkDuplicate(content: string, invertedIndex: InvertedIndex, profilePath: string): DuplicateResult {
	if (!content) return { isDuplicate: false, similarity: 0 };

	// 1. 分词新内容
	const newTerms = tokenizeSet(content, invertedIndex);
	if (newTerms.length === 0) return { isDuplicate: false, similarity: 0 };

	// 2. 用倒排索引搜索相关文件
	const matchedFiles = invertedIndex.search(content, 3);
	if (matchedFiles.length === 0) return { isDuplicate: false, similarity: 0 };

	// 3. 对每个匹配文件，读取内容并计算相似度
	let bestSimilarity = 0;
	let bestContent = "";
	let bestFile = "";

	for (const filePath of matchedFiles) {
		const fullPath = join(profilePath, filePath);
		if (!existsSync(fullPath)) continue;

		const fileContent = readFileSync(fullPath, "utf-8");
		// 文件可能包含多条（§ 分隔），逐条对比
		const entries = fileContent
			.split(/§\n?/)
			.map((e) => e.trim())
			.filter(Boolean);

		for (const entry of entries) {
			const existingTerms = tokenizeSet(entry, invertedIndex);
			if (existingTerms.length === 0) continue;

			const sim = jaccardSimilarity(newTerms, existingTerms);
			if (sim > bestSimilarity) {
				bestSimilarity = sim;
				bestContent = entry;
				bestFile = filePath;
			}
		}
	}

	if (bestSimilarity >= 0.8) {
		return {
			isDuplicate: true,
			similarity: bestSimilarity,
			existingContent: bestContent.length > 100 ? bestContent.slice(0, 100) + "..." : bestContent,
			existingFile: bestFile,
			suggestion: `已有高度相似的条目（相似度 ${(bestSimilarity * 100).toFixed(0)}%）。建议用 memory(action="replace", old_text="...", content="...") 更新已有条目，不要新增重复。`,
		};
	}

	if (bestSimilarity >= 0.5) {
		return {
			isDuplicate: false,
			similarity: bestSimilarity,
			existingContent: bestContent.length > 80 ? bestContent.slice(0, 80) + "..." : bestContent,
			existingFile: bestFile,
			suggestion: `可能与已有条目相似（相似度 ${(bestSimilarity * 100).toFixed(0)}%）。确认后可使用 replace 而非 add。`,
		};
	}

	return { isDuplicate: false, similarity: bestSimilarity };
}
