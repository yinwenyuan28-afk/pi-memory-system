import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Jieba } from "@node-rs/jieba";
import type { InvertedIndexData } from "./types.js";

const INDEX_FILE = "memory-index.json";
const INDEX_VERSION = 1;

/**
 * 通过 store 冻结快照常驻注入的根文件，不进入倒排索引。
 * 这些文件每次 before_agent_start 都由 store.getFullContext() 全量注入，
 * 若再被索引命中会重复注入浪费 token。
 */
export const ROOT_MEMORY_FILES: ReadonlySet<string> = new Set(["MEMORY.md", "USER.md"]);

// 停用词（高频无意义词）
const STOP_WORDS = new Set([
	"的",
	"了",
	"是",
	"在",
	"有",
	"不",
	"和",
	"与",
	"就",
	"都",
	"还",
	"也",
	"很",
	"到",
	"去",
	"做",
	"用",
	"把",
	"被",
	"让",
	"给",
	"对",
	"从",
	"向",
	"按",
	"将",
	"以",
	"为",
	"因",
	"由",
	"于",
	"及",
	"并",
	"或",
	"既",
	"又",
	"更",
	"最",
	"太",
	"极",
	"越",
	"稍",
	"略",
	"这",
	"那",
	"它",
	"我",
	"你",
	"他",
	"她",
	"们",
	"上",
	"下",
	"中",
	"外",
	"前",
	"后",
	"内",
	"之",
	"而",
	"且",
	"但",
	"也",
	"其",
	"中",
	"如",
	"何",
	"么",
	"能",
	"会",
	"可",
	"以",
	"已",
	"正",
	"在",
	"时",
	"个",
	"等",
	"入",
	"与",
	"来",
	"出",
	"过",
	"对",
	"于",
	"同",
	"各",
	"几",
	"两",
	"多",
	"少",
	"大",
	"小",
	"没",
	"别",
	"每",
	"某",
	"哪",
	"儿",
	"什",
	"么",
	"怎",
	"样",
	"给",
	"向",
	"从",
	"比",
	"被",
	"让",
	"叫",
]);

/** 默认停用词。外界可 set 自定义列表。 */
export { STOP_WORDS };

// ══════════════════════════════════════════════════════════════

/** LLM 过滤 prompt：从候选列表中删除不需要的词，只删不增。 */
export function buildFilterPrompt(content: string, candidates: string[]): string {
	return `你是一个关键词过滤器。

从以下列表中选择应该作为搜索关键词保留的词。
规则：
- 只删不增：只能从列表中删除，不能添加不在列表中的词
- 保留的必须是能帮助用户搜索到这篇文章的重要词汇
- 删除无意义的通用词（的/了/是/有/在/我/你/他/这/那/它/和/与/就/都/还/也/很/到/去/做/用/把/被/让/给/对/从/向/按/将/以/为/因/由/于/及/并/或/既/又/还/更/最/略）
- 删除无关的词
- 如果保留的词太少（<3个），放宽限制多保留一些

原文：
${content}

候选词列表：
${candidates.join("\n")}

只输出 JSON 格式：{ "keep": ["词1", "词2"] }`;
}

/**
 * 解析 LLM 返回的 JSON，提取保留的词列表。
 * 兜底：解析失败则返回完整候选列表（不丢失）。
 */
export function parseFilterResponse(response: string, candidates: string[]): string[] {
	try {
		// 提取 JSON 块（处理 LLM 可能在代码块中返回的情况）
		const jsonMatch = response.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return candidates;
		const parsed = JSON.parse(jsonMatch[0]);
		if (Array.isArray(parsed.keep) && parsed.keep.length > 0) {
			return parsed.keep.filter((k: string) => candidates.includes(k));
		}
	} catch {
		// 解析失败，返回完整列表
	}
	return candidates;
}

/** LLM 过滤回调类型。接收 prompt，返回 LLM 响应文本。 */
export type LLMFilterCallback = (prompt: string) => Promise<string>;

/**
 * 倒排索引 —— 代码分词 + LLM 过滤，自动构建搜索索引。
 *
 * 写入时自动分词建索引，搜索时按命中数排序返回文件路径。
 * routes.md 优先匹配，倒排兜底。
 */
export class InvertedIndex {
	private index: Map<string, Set<string>> = new Map();
	private profilePath = "";
	private jieba = new Jieba();
	private llmFilter: LLMFilterCallback | null = null;

	/** 设置 LLM 过滤回调（可选）。设置后 addEntry 会自动过滤噪声词。 */
	setLLMFilter(cb: LLMFilterCallback): void {
		this.llmFilter = cb;
	}

	// ── 初始化 ──────────────────────────────────────────────

	load(profilePath: string): void {
		this.profilePath = profilePath;
		const filePath = join(profilePath, INDEX_FILE);
		if (!existsSync(filePath)) {
			this.index = new Map();
			return;
		}
		try {
			const raw = readFileSync(filePath, "utf-8");
			const data = JSON.parse(raw) as InvertedIndexData;
			if (data.version === INDEX_VERSION && data.index) {
				this.index = new Map();
				for (const [term, files] of Object.entries(data.index)) {
					this.index.set(term, new Set(files));
				}
			}
		} catch {
			this.index = new Map();
		}
	}

	private save(): void {
		if (!this.profilePath) return;
		const filePath = join(this.profilePath, INDEX_FILE);
		const dir = this.profilePath;
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const obj: InvertedIndexData = {
			version: INDEX_VERSION,
			index: {},
		};
		for (const [term, files] of this.index) {
			obj.index[term] = Array.from(files);
		}
		writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");
	}

	/** 全量重建索引（启动时或手动调用）。 */
	rebuild(entries: Array<{ filePath: string; content: string }>): void {
		this.index = new Map();
		for (const { filePath, content } of entries) {
			const terms = this.tokenizeSync(content);
			for (const term of terms) {
				if (!this.index.has(term)) this.index.set(term, new Set());
				this.index.get(term)!.add(filePath);
			}
		}
		this.save();
	}

	// ── 分词 ────────────────────────────────────────────────

	/** 代码级分词（不使用 LLM）。 */
	tokenizeSync(text: string): string[] {
		text = text.toLowerCase();
		const words = this.jieba.cut(text, true); // HMM 模式，中文按词切
		const tokens = new Set<string>();

		for (const w of words) {
			const trimmed = w.trim();
			if (!trimmed || trimmed.length < 2) continue; // 过滤单字符和空白
			if (STOP_WORDS.has(trimmed)) continue; // 过滤停用词
			// 纯标点符号过滤
			if (/^[^\w\u4e00-\u9fff]+$/.test(trimmed)) continue;
			tokens.add(trimmed);
		}

		return Array.from(tokens);
	}

	// ── 索引操作 ────────────────────────────────────────────

	/** 为一条记忆文件添加倒排索引。如果设置了 LLM 过滤，会自动去噪。 */
	addEntry(filePath: string, content: string): void {
		const terms = this.tokenizeSync(content);
		this._addTerms(filePath, terms);
		this.save();

		// 异步 LLM 过滤（不阻塞写入）：按 filePath 串行队列
		if (this.llmFilter && terms.length > 0) {
			this._queueRefine(filePath);
		}
	}

	/**
	 * 从磁盘读取文件的完整内容并重建索引（统一写入入口）。
	 * 解决 S1：只索引写入片段会导致同文件旧条目被逐步抹掉。
	 */
	reindexFromDisk(filePath: string): void {
		// MEMORY.md/USER.md 由 store 快照每次全量注入，不建索引（避免重复注入）
		if (ROOT_MEMORY_FILES.has(filePath)) {
			this.removeEntry(filePath);
			return;
		}
		const fullPath = join(this.profilePath, filePath);
		this.removeEntry(filePath);
		if (!existsSync(fullPath)) return;
		const content = readFileSync(fullPath, "utf-8");
		const terms = this.tokenizeSync(content);
		if (terms.length === 0) return;
		this._addTerms(filePath, terms);
		this.save();
		if (this.llmFilter) this._queueRefine(filePath);
	}

	/** 索引的核心操作（同步，无 LLM）。 */
	private _addTerms(filePath: string, terms: string[]): void {
		for (const term of terms) {
			if (!this.index.has(term)) this.index.set(term, new Set());
			this.index.get(term)!.add(filePath);
		}
	}

	/** 异步 LLM 过滤：从磁盘读取完整内容，LLM 过滤后重建该文件索引。 */
	private async _refineAsync(filePath: string): Promise<void> {
		try {
			const fullPath = join(this.profilePath, filePath);
			if (!existsSync(fullPath)) {
				this.removeEntry(filePath);
				return;
			}
			const fullContent = readFileSync(fullPath, "utf-8");
			const candidates = this.tokenizeSync(fullContent);
			if (candidates.length === 0) return;

			const prompt = buildFilterPrompt(fullContent, candidates);
			const response = await this.llmFilter!(prompt);
			const kept = parseFilterResponse(response, candidates);

			// 从索引中删除该文件的所有旧条目
			for (const [, files] of this.index) {
				files.delete(filePath);
			}

			// 用 LLM 过滤后的词重建（完整内容）
			this._addTerms(filePath, kept);

			// 清理空 term
			for (const [term, files] of this.index) {
				if (files.size === 0) this.index.delete(term);
			}

			this.save();
		} catch {
			// LLM 过滤失败不影响已有索引
		}
	}

	/** per-filePath 串行刷新队列，防止并发 refine 竞态（M1）。 */
	private refineQueues: Map<string, Promise<void>> = new Map();

	private _queueRefine(filePath: string): void {
		const prev = this.refineQueues.get(filePath) || Promise.resolve();
		const next = prev.then(() => this._refineAsync(filePath)).catch(() => {});
		this.refineQueues.set(filePath, next);
	}

	/** 从索引中删除一条记忆文件的所有条目。 */
	removeEntry(filePath: string): void {
		for (const [, files] of this.index) {
			files.delete(filePath);
		}
		// 清理空 term
		for (const [term, files] of this.index) {
			if (files.size === 0) this.index.delete(term);
		}
		this.save();
	}

	/** 更新一条记忆文件的索引：从磁盘读取完整内容重建。 */
	updateEntry(filePath: string, _oldContent: string, _newContent: string): void {
		this.reindexFromDisk(filePath);
	}

	// ── 搜索 ────────────────────────────────────────────────

	/**
	 * 搜索倒排索引。
	 * @param query 用户输入
	 * @param limit 最多返回结果数
	 * @returns 按命中词数降序的文件路径列表
	 */
	search(query: string, limit = 5): string[] {
		const terms = this.tokenizeSync(query);
		if (!terms.length) return [];

		const hitCount = new Map<string, number>();

		for (const term of terms) {
			const files = this.index.get(term);
			if (!files) continue;
			for (const f of files) {
				hitCount.set(f, (hitCount.get(f) || 0) + 1);
			}
		}

		return Array.from(hitCount.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([file]) => file);
	}

	/**
	 * Search with normalized hit scores (0-1).
	 * Same logic as search(), but returns scores for combined ranking.
	 */
	searchWithScores(query: string, limit = 5): Array<{ file: string; score: number }> {
		const terms = this.tokenizeSync(query);
		if (!terms.length) return [];

		const hitCount = new Map<string, number>();

		for (const term of terms) {
			const files = this.index.get(term);
			if (!files) continue;
			for (const f of files) {
				hitCount.set(f, (hitCount.get(f) || 0) + 1);
			}
		}

		const entries = Array.from(hitCount.entries());
		if (!entries.length) return [];

		const maxHits = Math.max(...entries.map(([, c]) => c));
		return entries
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([file, hits]) => ({ file, score: maxHits > 0 ? hits / maxHits : 0 }));
	}

	/** 获取索引大小（term 数量）。 */


	get size(): number {
		return this.index.size;
	}
}
