import { completeSimple } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InvertedIndex } from "./inverted-index.js";
import { loadMemoryPrompts, renderPrompt } from "./prompts.js";

/**
 * 关键词缓存兜底刷新间隔（轮次）。事件驱动刷新为主，达到此轮次仍强制刷新。
 */
const REFRESH_INTERVAL = 8;

/**
 * 短消息豁免阈值（字符数）：用户消息 trim 后短于此长度视为延续话题
 * （如"继续"、"1"、"好"），不触发关键词缓存重建。
 */
const SHORT_PROMPT_THRESHOLD = 6;

/**
 * LLM 调用超时（毫秒）。
 */
const LLM_TIMEOUT_MS = 5000;

/**
 * 返回结果的 top-k 上限。
 */
const MAX_RESULTS = 5;

/**
 * 综合评分权重：倒排索引命中数 vs Jaccard 语义相似度。
 */
const INDEX_WEIGHT = 0.4;
const JACCARD_WEIGHT = 0.6;

/**
 * LLMKeywordSearcher —— 用 LLM 设计搜索关键词 + 综合评分排序。
 *
 * 工作流：
 *   1. 调用 completeSimple 让当前模型分析对话意图，输出 JSON 关键词列表
 *   2. 用关键词搜索倒排索引 -> searchWithScores 获得归一化命中分
 *   3. 对每个结果文件计算 LLM 关键词 vs 文件内容的 Jaccard 相似度
 *   4. 综合评分 = 0.4 * indexScore + 0.6 * jaccardScore
 *   5. 取 top-5 返回
 *   6. 如果 LLM 超时/失败，fallback 到 jieba 分词搜索（不排序）
 *
 * 缓存策略：
 *   - 关键词缓存在 searcher 内部，session_start 时立即刷新
 *   - agent_settled 每 5 轮刷新一次
 *   - get_memory 工具强制不走缓存
 */
export class LLMKeywordSearcher {
	private cachedKeywords: string[] = [];
	private cachedAt = 0;
	private turnCount = 0;
	private refreshSeq = 0;
	private model: any = null;
	private invertedIndex: InvertedIndex | null = null;
	private profilePath = "";

	setModel(model: any): void {
		this.model = model;
	}

	setInvertedIndex(index: InvertedIndex | null): void {
		this.invertedIndex = index;
	}

	setProfilePath(path: string): void {
		this.profilePath = path;
	}

	getTurnCount(): number {
		return this.turnCount;
	}

	/** 计数 +1，返回 true 表示达到刷新间隔需要刷新。 */
	incrementTurn(): boolean {
		this.turnCount++;
		if (this.turnCount >= REFRESH_INTERVAL) {
			this.turnCount = 0;
			return true;
		}
		return false;
	}

	resetTurn(): void {
		this.turnCount = 0;
	}

	/** 清理 LLM 关键词缓存（切 profile 或会话结束时调用，防止串档）。 */
	clearKeywords(): void {
		this.cachedKeywords = [];
		this.cachedAt = 0;
		this.refreshSeq = 0;
	}

	/**
	 * 判断是否应触发关键词重建（事件驱动）：
	 * - 短消息（无信息量，如"继续"/"1"）→ false（延续话题，不重建）
	 * - 无缓存（首次/已清空）→ true（必刷）
	 * - jieba(当前prompt) 与缓存关键词无部分匹配 → true（话题切换）
	 * - 否则 → false（话题延续）
	 */
	shouldRefreshKeywords(prompt: string): boolean {
		const trimmed = (prompt || "").trim();
		// 短消息豁免：低于阈值视为延续话题，跳过检测与重建
		if (trimmed.length < SHORT_PROMPT_THRESHOLD) return false;
		// 无缓存：首次会话或 /profile 切换后，必须重建
		if (this.cachedKeywords.length === 0) return true;
		// 话题切换检测：当前 prompt 的 jieba 词与缓存关键词部分匹配（包含关系）
		if (this.invertedIndex) {
			const terms = this.invertedIndex.tokenizeSync(trimmed);
			const overlap = terms.some((t) => {
				const tl = t.toLowerCase();
				return this.cachedKeywords.some((k) => {
					const kl = k.toLowerCase();
					return kl.includes(tl) || tl.includes(kl);
				});
			});
			if (!overlap) return true;
		}
		return false;
	}

	/**
	 * 事件驱动刷新：检测到切换信号时触发 LLM 关键词重建（fire-and-forget，不 await）。
	 * 本轮搜索仍用旧缓存 + jieba(prompt) 保底（S3 合并），下轮起用新关键词。
	 */
	maybeRefreshKeywords(prompt: string, contextText: string): void {
		if (this.shouldRefreshKeywords(prompt)) {
			this.refreshKeywords(contextText).catch(() => {});
		}
	}

	/**
	 * 调用 LLM 设计关键词并缓存。
	 * 若超时/失败，保留旧缓存。
	 */
	async refreshKeywords(contextText: string): Promise<void> {
		if (!this.model) return;
		// 序号令牌：后发起的刷新若先完成则被忽略（防旧上下文覆盖新缓存）
		const seq = ++this.refreshSeq;
		const prompt = renderPrompt(loadMemoryPrompts().keywordExtraction, { contextText });
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
		try {
			const result = await completeSimple(this.model, {
				systemPrompt: "You are a keyword extraction assistant. Respond only with valid JSON arrays.",
				messages: [{ role: "user", content: prompt }],
			}, { signal: controller.signal } as any);

			const raw = typeof result.content === "string"
				? result.content
				: JSON.stringify(result.content);
			const parsed = parseKeywordResponse(raw);
			if (parsed.length > 0 && seq === this.refreshSeq) {
				this.cachedKeywords = parsed;
				this.cachedAt = Date.now();
			}
		} catch {
			// 超时/失败：保留旧缓存（合并策略下 query 仍由 jieba 保底参与）
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * 用缓存的关键词搜索 + 综合评分。
	 * 无缓存时 fallback 到 jieba 分词搜索。
	 */
	search(query: string): string {
		if (!this.invertedIndex || !this.profilePath) return "";
		// S3 修复：缓存关键词 ∪ 当前 query 的 jieba 分词 合并搜索。
		// 缓存保底 + 当前输入始终参与，话题切换不再依赖旧缓存。
		const queryTerms = this.invertedIndex.tokenizeSync(query);
		const merged = Array.from(new Set([...this.cachedKeywords, ...queryTerms]));
		if (merged.length > 0) {
			return this.searchWithCombinedScore(merged);
		}
		return "";
	}

	/**
	 * 强制用 LLM 设计关键词后搜索（用于 get_memory 工具，不走缓存）。
	 */
	async searchWithIntent(query: string): Promise<string> {
		if (this.model) {
			await this.refreshKeywords(query);
		}
		// M6：refresh 失败时旧缓存仍在，但 search() 会合并 jieba(query)，
		// 保证当前 query 一定参与，不会返回与 query 无关的旧结果。
		return this.search(query);
	}

	/**
	 * 综合评分排序：
	 * score = INDEX_WEIGHT * indexScore + JACCARD_WEIGHT * jaccardScore
	 */
	private searchWithCombinedScore(keywords: string[]): string {
		if (!this.invertedIndex || !this.profilePath) return "";

		const query = keywords.join(" ");
		const matched = this.invertedIndex.searchWithScores(query, MAX_RESULTS * 3);
		if (matched.length === 0) return "";

		const keywordSet = new Set(keywords.map((k) => k.toLowerCase()));

		const scored: Array<{ file: string; score: number; content: string }> = [];
		for (const { file, score: indexScore } of matched) {
			const fullPath = join(this.profilePath, file);
			if (!existsSync(fullPath)) continue;

			const content = readFileSync(fullPath, "utf-8").trim();
			if (!content) continue;

			// M2：复用倒排索引的 jieba 分词，中文不再整句一个 token
			const fileTokens = new Set(this.invertedIndex.tokenizeSync(content));
			const jaccard = fileTokens.size > 0
				? computeJaccard(keywordSet, fileTokens)
				: 0;

			const combined = INDEX_WEIGHT * indexScore + JACCARD_WEIGHT * jaccard;
			scored.push({ file, score: combined, content });
		}

		scored.sort((a, b) => b.score - a.score);
		const top = scored.slice(0, MAX_RESULTS);

		return top
			.map((r) => {
				const pct = Math.round(r.score * 100);
				return `[INDEX MATCH: ${r.file}] (${pct}%)\n${r.content}`;
			})
			.join("\n\n");
	}

	/**
	 * Fallback：jieba 分词搜索，不排序。
	 */
	private fallbackSearch(query: string): string {
		if (!this.invertedIndex || !this.profilePath) return "";
		const matched = this.invertedIndex.search(query, MAX_RESULTS);
		if (matched.length === 0) return "";

		const parts: string[] = [];
		for (const file of matched) {
			const fullPath = join(this.profilePath, file);
			if (existsSync(fullPath)) {
				const content = readFileSync(fullPath, "utf-8").trim();
				if (content) parts.push(`[INDEX MATCH: ${file}]\n${content}`);
			}
		}
		return parts.join("\n\n");
	}
}

// ── Helper Functions ──────────────────────────────────────────

function parseKeywordResponse(raw: string): string[] {
	try {
		const match = raw.match(/\[[\s\S]*\]/);
		if (match) {
			const parsed = JSON.parse(match[0]);
			if (Array.isArray(parsed) && parsed.length > 0) {
				return parsed.map(String).filter((s) => s.trim().length > 0);
			}
		}
	} catch {
		// 忽略解析失败
	}
	return [];
}

function computeJaccard(a: Set<string>, b: Set<string>): number {
	let intersection = 0;
	for (const t of a) {
		if (b.has(t)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union > 0 ? intersection / union : 0;
}
