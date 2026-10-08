/** Interactive setup and read-only inspection for memory models. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAppProps, saveAppSection } from "./app-config.ts";
import { readModelEntry } from "./memory-system-config.ts";
import { loadVectorizationConfig } from "../memory/search/embedding/vectorization-config.ts";
import { loadAllL1Records } from "../memory/search/embedding/record-loader.ts";
import { MEMORY_DB_DIR, VECTORS_DIR } from "../memory/paths.ts";

type ProfilePathGetter = () => string | undefined;
type ModelEntry = Record<string, unknown>;

const DEFAULT_EMBEDDING_MODEL = "qwen3.7-text-embedding";
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_VECTOR_THRESHOLD = 500;

/** Register the interactive model setup command and its strictly read-only companion. */
export function registerModelSetupCommands(pi: ExtensionAPI, getProfilePath: ProfilePathGetter): void {
	pi.registerCommand("my-memory:model", {
		description: "交互式配置记忆系统的后台 LLM、Embedding 和向量化",
		handler: async (_args, ctx) => {
			const profilePath = getProfilePath();
			if (!profilePath) {
				ctx.ui.notify("当前没有激活的记忆 profile", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("此命令需要 Pi 交互界面，请在 TUI 中运行", "warning");
				return;
			}

			while (true) {
				const overview = await buildPeekReport(profilePath, ctx);
				const selected = await ctx.ui.select(`${overview}\n\n请选择要修改的部分：`, [
					"设置后台 LLM",
					"设置 Embedding 服务",
					"设置向量化",
					"完成",
				]);
				if (!selected || selected === "完成") return;

				try {
					if (selected === "设置后台 LLM") {
						await configureLlm(profilePath, ctx);
					} else if (selected === "设置 Embedding 服务") {
						await configureEmbedding(profilePath, ctx);
					} else if (selected === "设置向量化") {
						await configureVectorization(profilePath, ctx);
					}
				} catch (error) {
					ctx.ui.notify(`配置失败：${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
		},
	});

	pi.registerCommand("my-memory:model:peek", {
		description: "只读查看当前记忆模型与向量化状态",
		handler: async (_args, ctx) => {
			const profilePath = getProfilePath();
			if (!profilePath) {
				ctx.ui.notify("当前没有激活的记忆 profile", "error");
				return;
			}
			try {
				const report = await buildPeekReport(profilePath, ctx);
				ctx.ui.notify(report, "info");
			} catch (error) {
				ctx.ui.notify(`只读检查失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

async function configureLlm(profilePath: string, ctx: ExtensionContext): Promise<void> {
	const models = ctx.modelRegistry.getAvailable()
		.slice()
		.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
	if (models.length === 0) {
		ctx.ui.notify("Pi 当前没有可选模型。请先通过 /login 或 Pi 模型配置添加模型。", "warning");
		return;
	}

	const labels = models.map((model) => {
		const name = model.name && model.name !== model.id ? ` — ${model.name}` : "";
		return `${model.provider}/${model.id}${name}`;
	});
	const choice = await ctx.ui.select("选择记忆系统后台 LLM", labels);
	if (!choice) return;
	const model = models[labels.indexOf(choice)];
	if (!model) return;

	const existing = loadModelSection(profilePath);
	const accepted = await ctx.ui.confirm(
		"保存后台模型",
		`记忆系统后台 LLM 将使用 ${model.provider}/${model.id}。这不会改变当前对话模型。`,
	);
	if (!accepted) return;

	saveAppSection(profilePath, "model", {
		...existing,
		llm: { provider: model.provider, modelId: model.id },
	});
	ctx.ui.notify(`后台 LLM 已保存：${model.provider}/${model.id}`, "info");
}

async function configureEmbedding(profilePath: string, ctx: ExtensionContext): Promise<void> {
	const existing = readModelEntry(profilePath, "embedding") ?? {};
	const previousKey = typeof existing.apiKey === "string" ? existing.apiKey : "";
	const previousUrl = typeof existing.url === "string" ? existing.url : "";
	const previousModel = typeof existing.model === "string" ? existing.model : DEFAULT_EMBEDDING_MODEL;
	const previousDimensions = typeof existing.dimensions === "number" ? existing.dimensions : DEFAULT_EMBEDDING_DIMENSIONS;

	const urlInput = await ctx.ui.input("Embedding OpenAI-compatible API 基础地址", previousUrl || "https://…/compatible-mode/v1");
	if (urlInput === undefined) return;
	const url = (urlInput || previousUrl).trim();
	if (!isHttpUrl(url)) {
		ctx.ui.notify("地址必须是有效的 http:// 或 https:// URL；原配置未更改。", "error");
		return;
	}

	let apiKey = previousKey;
	const keyChoice = await ctx.ui.select("Embedding API Key", previousKey
		? ["保留当前 API Key", "输入新的 API Key", "取消"]
		: ["输入 API Key", "取消"]);
	if (!keyChoice || keyChoice === "取消") return;
	if (keyChoice !== "保留当前 API Key") {
		ctx.ui.notify("Pi 输入框不提供密码掩码；输入时密钥可能可见。密钥会写入当前 profile 的配置文件。", "warning");
		const keyInput = await ctx.ui.input("Embedding API Key", "输入密钥；留空取消本次配置");
		if (keyInput === undefined || !keyInput.trim()) return;
		apiKey = keyInput.trim();
	}
	if (!apiKey) {
		ctx.ui.notify("API Key 不能为空；原配置未更改。", "error");
		return;
	}

	const modelInput = await ctx.ui.input("Embedding 模型名", previousModel);
	if (modelInput === undefined) return;
	const model = (modelInput || previousModel).trim();
	if (!model) {
		ctx.ui.notify("模型名不能为空；原配置未更改。", "error");
		return;
	}

	const dimensionsInput = await ctx.ui.input("Embedding 输出维度", String(previousDimensions));
	if (dimensionsInput === undefined) return;
	const dimensions = dimensionsInput.trim() ? Number(dimensionsInput.trim()) : previousDimensions;
	if (!Number.isInteger(dimensions) || dimensions < 1) {
		ctx.ui.notify("维度必须是正整数；原配置未更改。", "error");
		return;
	}
	const vectorStoreStats = await readVectorStoreStatsReadOnly(profilePath);
	if (vectorStoreStats.exists && vectorStoreStats.dimensions === null) {
		ctx.ui.notify("现有向量库维度无法只读识别；为避免保存不兼容配置，本次未更改。", "error");
		return;
	}
	if (vectorStoreStats.dimensions !== null && dimensions !== vectorStoreStats.dimensions) {
		ctx.ui.notify(
			`现有向量库使用 ${vectorStoreStats.dimensions} 维，不能直接切换到 ${dimensions} 维。为避免后续召回失败，原配置未更改。`,
			"error",
		);
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"保存 Embedding 配置",
		`模型：${model}\n维度：${dimensions}\n地址：${url}\nAPI Key：${previousKey && apiKey === previousKey ? "保留现有值" : "已填写（不会回显）"}`,
	);
	if (!confirmed) return;

	const current = loadModelSection(profilePath);
	saveAppSection(profilePath, "model", {
		...current,
		embedding: {
			...existing,
			apiKey,
			url,
			model,
			dimensions,
		},
	});
	ctx.ui.notify("Embedding 配置已保存。重启 Pi 后会确保新配置对所有后台进程生效。", "info");
}

async function configureVectorization(profilePath: string, ctx: ExtensionContext): Promise<void> {
	const current = loadVectorizationConfig(profilePath);
	const hasEmbedding = isEmbeddingEntryUsable(readModelEntry(profilePath, "embedding"));
	const records = await loadAllL1Records(profilePath, 365);
	const action = await ctx.ui.select(
		`向量化当前${current.enabled ? "开启" : "关闭"}；L1 记录 ${records.length} 条；触发阈值 ${current.triggerThreshold} 条。开启后用于 L1 语义召回和去重。`,
		current.enabled ? ["保持开启", "修改触发阈值", "关闭向量化", "取消"] : ["保持关闭", "开启向量化", "取消"],
	);
	if (!action || action === "取消" || action === "保持开启" || action === "保持关闭") return;

	if (action === "开启向量化" && !hasEmbedding) {
		ctx.ui.notify("需要先配置有效的 Embedding URL 和 API Key；向量化保持关闭。", "warning");
		return;
	}

	const enabled = action === "开启向量化" || action === "修改触发阈值";
	let triggerThreshold = current.triggerThreshold || DEFAULT_VECTOR_THRESHOLD;
	if (enabled) {
		const thresholdInput = await ctx.ui.input("达到多少条 L1 记录后开始向量化", String(triggerThreshold));
		if (thresholdInput === undefined) return;
		const parsed = thresholdInput.trim() ? Number(thresholdInput.trim()) : triggerThreshold;
		if (!Number.isInteger(parsed) || parsed < 1) {
			ctx.ui.notify("阈值必须是正整数；向量化配置未更改。", "error");
			return;
		}
		triggerThreshold = parsed;
	}

	const summary = enabled
		? `达到 ${triggerThreshold} 条后开始为 L1 记忆生成向量，支持语义召回和去重。已有记录需要时可手动运行回填命令。`
		: "关闭后停止新 L1 向量写入；已有向量仍可召回，但新增记忆不会进入语义召回和向量去重候选。";
	if (!await ctx.ui.confirm(enabled ? "开启向量化" : "关闭向量化", summary)) return;

	const latest = loadVectorizationConfig(profilePath);
	saveAppSection(profilePath, "vectorization", {
		...latest,
		enabled,
		triggerThreshold,
	});
	ctx.ui.notify(enabled ? "向量化已开启；阈值未达到前不会写入向量。" : "向量化已关闭。", "info");
}

async function buildPeekReport(profilePath: string, ctx: ExtensionContext): Promise<string> {
	const llm = readModelEntry(profilePath, "llm");
	const llmLabel = llm && typeof llm.provider === "string" && typeof llm.modelId === "string"
		? ctx.modelRegistry.find(llm.provider, llm.modelId)
			? `${llm.provider}/${llm.modelId}（后台已配置）`
			: `${llm.provider}/${llm.modelId}（未解析，运行时回退当前 Pi 模型）`
		: ctx.model ? `${ctx.model.provider}/${ctx.model.id}（跟随当前 Pi 模型）` : "未配置，且当前会话无模型";

	const embedding = readModelEntry(profilePath, "embedding");
	const embeddingUsable = isEmbeddingEntryUsable(embedding);
	const embeddingLabel = !embedding
		? "未配置"
		: embeddingUsable
			? `${typeof embedding.model === "string" ? embedding.model : DEFAULT_EMBEDDING_MODEL} · ${typeof embedding.dimensions === "number" ? embedding.dimensions : DEFAULT_EMBEDDING_DIMENSIONS} 维 · API Key 已设置`
			: "配置不完整（密钥或地址缺失）";

	const vectorization = loadVectorizationConfig(profilePath);
	const records = await loadAllL1Records(profilePath, 365);
	const vectorStoreStats = await readVectorStoreStatsReadOnly(profilePath);
	const generationReady = vectorization.enabled && embeddingUsable && records.length >= vectorization.triggerThreshold;
	// 关闭向量化只阻止新向量写入，不会清空旧向量；有可用配置和现存向量时召回仍可工作。
	const recallReady = embeddingUsable && (vectorStoreStats.count ?? 0) > 0;
	const vectorLine = vectorStoreStats.count === null
		? "向量库       不可读取（只读检查）"
		: `向量记录     ${vectorStoreStats.count} 条${vectorStoreStats.dimensions ? ` · ${vectorStoreStats.dimensions} 维` : ""}`;
	return [
		`记忆模型状态 · profile: ${profilePath.split(/[\\/]/).pop() || "unknown"}`,
		"",
		`后台 LLM     ${llmLabel}`,
		`Embedding    ${embeddingLabel}`,
		`向量化       ${formatVectorizationState(vectorization.enabled, embeddingUsable, records.length, vectorization.triggerThreshold)}`,
		`L1 记忆      ${records.length} 条（最近 365 天）`,
		vectorLine,
		`语义召回     ${recallReady ? "有可用向量" : "当前不可用或尚无向量"}`,
		"",
		"只读检查：未修改配置或数据库，未调用远端服务。",
	].join("\n");
}

/** Count vector rows using a read-only SQLite handle; never initialize/create the vector store. */
async function readVectorStoreStatsReadOnly(profilePath: string): Promise<{ exists: boolean; count: number | null; dimensions: number | null }> {
	const dbPath = join(profilePath, MEMORY_DB_DIR, VECTORS_DIR, "l1-vectors.sqlite");
	if (!existsSync(dbPath)) return { exists: false, count: 0, dimensions: null };
	let db: { prepare(sql: string): { get(): unknown }; close(): void } | undefined;
	try {
		const Database = (await import("better-sqlite3")).default;
		const sqliteVec = await import("sqlite-vec");
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
		sqliteVec.load(db as never);
		const row = db.prepare("SELECT count(*) AS n FROM l1_vectors").get() as { n: number };
		const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'l1_vectors'").get() as { sql?: string } | undefined;
		const dimensions = schema?.sql?.match(/float\s*\[\s*(\d+)\s*\]/i)?.[1];
		return { exists: true, count: row.n, dimensions: dimensions ? Number(dimensions) : null };
	} catch {
		return { exists: true, count: null, dimensions: null };
	} finally {
		try { db?.close(); } catch { /* close best effort */ }
	}
}

function loadModelSection(profilePath: string): ModelEntry {
	const section = loadAppProps(profilePath)?.model;
	return section && typeof section === "object" ? { ...(section as ModelEntry) } : {};
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isEmbeddingEntryUsable(entry: ModelEntry | null): boolean {
	return !!entry && typeof entry.apiKey === "string" && entry.apiKey.trim().length > 0 &&
		typeof entry.url === "string" && isHttpUrl(entry.url.trim());
}

function formatVectorizationState(enabled: boolean, embeddingUsable: boolean, recordCount: number, threshold: number): string {
	if (!enabled) return `关闭 · 阈值 ${threshold} 条 · 新向量写入已关闭`;
	if (!embeddingUsable) return `开启 · 阈值 ${threshold} 条 · 缺少有效 Embedding 配置`;
	if (recordCount < threshold) return `开启 · 阈值 ${threshold} 条 · 还差 ${threshold - recordCount} 条`;
	return `开启 · 阈值 ${threshold} 条 · 新向量写入条件已满足`;
}
