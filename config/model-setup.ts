/** Interactive setup and read-only inspection for memory models. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAppProps, saveAppSection } from "./app-config.ts";
import { readModelEntry } from "./memory-system-config.ts";
import { loadVectorizationConfig } from "../memory/search/embedding/vectorization-config.ts";
import { loadAllL1Records } from "../memory/search/embedding/record-loader.ts";
import { MEMORY_DB_DIR, VECTORS_DIR } from "../memory/paths.ts";
import { t } from "../i18n/index.ts";

type ProfilePathGetter = () => string | undefined;
type ModelEntry = Record<string, unknown>;

const DEFAULT_EMBEDDING_MODEL = "qwen3.7-text-embedding";
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_VECTOR_THRESHOLD = 500;

/** Register the interactive model setup command and its strictly read-only companion. */
export function registerModelSetupCommands(pi: ExtensionAPI, getProfilePath: ProfilePathGetter): void {
	pi.registerCommand("my-memory:model", {
		description: t("ext.model.command.description"),
		handler: async (_args, ctx) => {
			const profilePath = getProfilePath();
			if (!profilePath) {
				ctx.ui.notify(t("ext.model.noProfile"), "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(t("ext.model.needUI"), "warning");
				return;
			}

			while (true) {
				const overview = await buildPeekReport(profilePath, ctx);
				const optionLlm = t("ext.model.option.setLlm");
				const optionEmbedding = t("ext.model.option.setEmbedding");
				const optionVectorization = t("ext.model.option.setVectorization");
				const optionDone = t("ext.model.option.done");
				const selected = await ctx.ui.select(`${overview}\n\n${t("ext.model.selectSection")}`, [
					optionLlm,
					optionEmbedding,
					optionVectorization,
					optionDone,
				]);
				if (!selected || selected === optionDone) return;

				try {
					if (selected === optionLlm) {
						await configureLlm(profilePath, ctx);
					} else if (selected === optionEmbedding) {
						await configureEmbedding(profilePath, ctx);
					} else if (selected === optionVectorization) {
						await configureVectorization(profilePath, ctx);
					}
				} catch (error) {
					ctx.ui.notify(t("ext.model.configFailed", { message: error instanceof Error ? error.message : String(error) }), "error");
				}
			}
		},
	});

	pi.registerCommand("my-memory:model:peek", {
		description: t("ext.model.peek.description"),
		handler: async (_args, ctx) => {
			const profilePath = getProfilePath();
			if (!profilePath) {
				ctx.ui.notify(t("ext.model.noProfile"), "error");
				return;
			}
			try {
				const report = await buildPeekReport(profilePath, ctx);
				ctx.ui.notify(report, "info");
			} catch (error) {
				ctx.ui.notify(t("ext.model.peek.failed", { message: error instanceof Error ? error.message : String(error) }), "error");
			}
		},
	});
}

async function configureLlm(profilePath: string, ctx: ExtensionContext): Promise<void> {
	const models = ctx.modelRegistry.getAvailable()
		.slice()
		.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
	if (models.length === 0) {
		ctx.ui.notify(t("ext.model.noModels"), "warning");
		return;
	}

	const labels = models.map((model) => {
		const name = model.name && model.name !== model.id ? ` — ${model.name}` : "";
		return `${model.provider}/${model.id}${name}`;
	});
	const choice = await ctx.ui.select(t("ext.model.selectLlm"), labels);
	if (!choice) return;
	const model = models[labels.indexOf(choice)];
	if (!model) return;

	const existing = loadModelSection(profilePath);
	const accepted = await ctx.ui.confirm(
		t("ext.model.save.llm.title"),
		t("ext.model.save.llm.body", { model: `${model.provider}/${model.id}` }),
	);
	if (!accepted) return;

	saveAppSection(profilePath, "model", {
		...existing,
		llm: { provider: model.provider, modelId: model.id },
	});
	ctx.ui.notify(t("ext.model.llmSaved", { model: `${model.provider}/${model.id}` }), "info");
}

async function configureEmbedding(profilePath: string, ctx: ExtensionContext): Promise<void> {
	const existing = readModelEntry(profilePath, "embedding") ?? {};
	const previousKey = typeof existing.apiKey === "string" ? existing.apiKey : "";
	const previousUrl = typeof existing.url === "string" ? existing.url : "";
	const previousModel = typeof existing.model === "string" ? existing.model : DEFAULT_EMBEDDING_MODEL;
	const previousDimensions = typeof existing.dimensions === "number" ? existing.dimensions : DEFAULT_EMBEDDING_DIMENSIONS;

	const urlInput = await ctx.ui.input(t("ext.model.ask.url"), previousUrl || "https://…/compatible-mode/v1");
	if (urlInput === undefined) return;
	const url = (urlInput || previousUrl).trim();
	if (!isHttpUrl(url)) {
		ctx.ui.notify(t("ext.model.urlInvalid"), "error");
		return;
	}

	const optionKeepKey = t("ext.model.option.keepKey");
	const optionInputKey = t("ext.model.option.inputKey");
	const optionCancel = t("ext.model.option.cancel");
	let apiKey = previousKey;
	const keyChoice = await ctx.ui.select("Embedding API Key", previousKey
		? [optionKeepKey, t("ext.model.option.newKey"), optionCancel]
		: [optionInputKey, optionCancel]);
	if (!keyChoice || keyChoice === optionCancel) return;
	if (keyChoice !== optionKeepKey) {
		ctx.ui.notify(t("ext.model.keyWarning"), "warning");
		const keyInput = await ctx.ui.input("Embedding API Key", t("ext.model.ask.keyPlaceholder"));
		if (keyInput === undefined || !keyInput.trim()) return;
		apiKey = keyInput.trim();
	}
	if (!apiKey) {
		ctx.ui.notify(t("ext.model.keyEmpty"), "error");
		return;
	}

	const modelInput = await ctx.ui.input(t("ext.model.ask.modelName"), previousModel);
	if (modelInput === undefined) return;
	const model = (modelInput || previousModel).trim();
	if (!model) {
		ctx.ui.notify(t("ext.model.modelNameEmpty"), "error");
		return;
	}

	const dimensionsInput = await ctx.ui.input(t("ext.model.ask.dimensions"), String(previousDimensions));
	if (dimensionsInput === undefined) return;
	const dimensions = dimensionsInput.trim() ? Number(dimensionsInput.trim()) : previousDimensions;
	if (!Number.isInteger(dimensions) || dimensions < 1) {
		ctx.ui.notify(t("ext.model.dimensionsInvalid"), "error");
		return;
	}
	const vectorStoreStats = await readVectorStoreStatsReadOnly(profilePath);
	if (vectorStoreStats.exists && vectorStoreStats.dimensions === null) {
		ctx.ui.notify(t("ext.model.dimUnreadable"), "error");
		return;
	}
	if (vectorStoreStats.dimensions !== null && dimensions !== vectorStoreStats.dimensions) {
		ctx.ui.notify(
			t("ext.model.dimensionMismatch", { existing: vectorStoreStats.dimensions, requested: dimensions }),
			"error",
		);
		return;
	}

	const confirmed = await ctx.ui.confirm(
		t("ext.model.save.embedding.title"),
		t("ext.model.save.embedding.body", {
			model,
			dimensions,
			url,
			key: previousKey && apiKey === previousKey ? t("ext.model.keyKept") : t("ext.model.keyFilled"),
		}),
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
	ctx.ui.notify(t("ext.model.embeddingSaved"), "info");
}

async function configureVectorization(profilePath: string, ctx: ExtensionContext): Promise<void> {
	const current = loadVectorizationConfig(profilePath);
	const hasEmbedding = isEmbeddingEntryUsable(readModelEntry(profilePath, "embedding"));
	const records = await loadAllL1Records(profilePath, 365);
	const optionCancel = t("ext.model.option.cancel");
	const optionKeepOn = t("ext.model.option.keepOn");
	const optionKeepOff = t("ext.model.option.keepOff");
	const optionEditThreshold = t("ext.model.option.editThreshold");
	const optionEnableVec = t("ext.model.option.enableVec");
	const optionDisableVec = t("ext.model.option.disableVec");
	const action = await ctx.ui.select(
		t("ext.model.vec.prompt", {
			state: t(current.enabled ? "ext.model.state.on" : "ext.model.state.off"),
			count: records.length,
			threshold: current.triggerThreshold,
		}),
		current.enabled ? [optionKeepOn, optionEditThreshold, optionDisableVec, optionCancel] : [optionKeepOff, optionEnableVec, optionCancel],
	);
	if (!action || action === optionCancel || action === optionKeepOn || action === optionKeepOff) return;

	if (action === optionEnableVec && !hasEmbedding) {
		ctx.ui.notify(t("ext.model.vec.needEmbedding"), "warning");
		return;
	}

	const enabled = action === optionEnableVec || action === optionEditThreshold;
	let triggerThreshold = current.triggerThreshold || DEFAULT_VECTOR_THRESHOLD;
	if (enabled) {
		const thresholdInput = await ctx.ui.input(t("ext.model.ask.threshold"), String(triggerThreshold));
		if (thresholdInput === undefined) return;
		const parsed = thresholdInput.trim() ? Number(thresholdInput.trim()) : triggerThreshold;
		if (!Number.isInteger(parsed) || parsed < 1) {
			ctx.ui.notify(t("ext.model.thresholdInvalid"), "error");
			return;
		}
		triggerThreshold = parsed;
	}

	const summary = enabled
		? t("ext.model.vec.confirmOn", { threshold: triggerThreshold })
		: t("ext.model.vec.confirmOff");
	if (!await ctx.ui.confirm(enabled ? optionEnableVec : optionDisableVec, summary)) return;

	const latest = loadVectorizationConfig(profilePath);
	saveAppSection(profilePath, "vectorization", {
		...latest,
		enabled,
		triggerThreshold,
	});
	ctx.ui.notify(enabled ? t("ext.model.vec.enabledNotice") : t("ext.model.vec.disabledNotice"), "info");
}

async function buildPeekReport(profilePath: string, ctx: ExtensionContext): Promise<string> {
	const llm = readModelEntry(profilePath, "llm");
	const llmModel = `${llm?.provider}/${llm?.modelId}`;
	const llmLabel = llm && typeof llm.provider === "string" && typeof llm.modelId === "string"
		? ctx.modelRegistry.find(llm.provider, llm.modelId)
			? t("ext.model.peek.llmConfigured", { model: llmModel })
			: t("ext.model.peek.llmUnresolved", { model: llmModel })
		: ctx.model ? t("ext.model.peek.llmFollowing", { model: `${ctx.model.provider}/${ctx.model.id}` }) : t("ext.model.peek.noModel");

	const embedding = readModelEntry(profilePath, "embedding");
	const embeddingUsable = isEmbeddingEntryUsable(embedding);
	const embeddingLabel = !embedding
		? t("ext.model.peek.notConfigured")
		: embeddingUsable
			? t("ext.model.peek.embeddingOk", {
				model: typeof embedding.model === "string" ? embedding.model : DEFAULT_EMBEDDING_MODEL,
				dimensions: typeof embedding.dimensions === "number" ? embedding.dimensions : DEFAULT_EMBEDDING_DIMENSIONS,
			})
			: t("ext.model.peek.embeddingIncomplete");

	const vectorization = loadVectorizationConfig(profilePath);
	const records = await loadAllL1Records(profilePath, 365);
	const vectorStoreStats = await readVectorStoreStatsReadOnly(profilePath);
	const generationReady = vectorization.enabled && embeddingUsable && records.length >= vectorization.triggerThreshold;
	// 关闭向量化只阻止新向量写入，不会清空旧向量；有可用配置和现存向量时召回仍可工作。
	const recallReady = embeddingUsable && (vectorStoreStats.count ?? 0) > 0;
	const vectorLine = vectorStoreStats.count === null
		? t("ext.model.peek.vectorUnreadable")
		: vectorStoreStats.dimensions
			? t("ext.model.peek.vectorLineDim", { count: vectorStoreStats.count, dimensions: vectorStoreStats.dimensions })
			: t("ext.model.peek.vectorLine", { count: vectorStoreStats.count });
	return [
		t("ext.model.peek.title", { profile: profilePath.split(/[\\/]/).pop() || "unknown" }),
		"",
		t("ext.model.peek.llmLine", { label: llmLabel }),
		t("ext.model.peek.embeddingLine", { label: embeddingLabel }),
		t("ext.model.peek.vectorizationLine", { state: formatVectorizationState(vectorization.enabled, embeddingUsable, records.length, vectorization.triggerThreshold) }),
		t("ext.model.peek.l1Line", { count: records.length }),
		vectorLine,
		t("ext.model.peek.recallLine", { state: t(recallReady ? "ext.model.peek.recallReady" : "ext.model.peek.recallUnavailable") }),
		"",
		t("ext.model.peek.readonlyNote"),
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
	if (!enabled) return t("ext.model.vec.state.disabled", { threshold });
	if (!embeddingUsable) return t("ext.model.vec.state.noEmbedding", { threshold });
	if (recordCount < threshold) return t("ext.model.vec.state.below", { threshold, remaining: threshold - recordCount });
	return t("ext.model.vec.state.ready", { threshold });
}
