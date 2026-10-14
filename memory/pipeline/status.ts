import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PipelineJobScope, PipelineJobType } from "./worker.ts";
import { t } from "../../i18n/index.ts";

/** Central status-line adapter so background work and turn counters share one Pi status item. */
export interface PipelineStatusReporter {
	set: (ctx: ExtensionContext, layer: PipelineJobType, detail: string, scope?: PipelineJobScope) => void;
	clear: (ctx: ExtensionContext, layer: PipelineJobType, scope?: PipelineJobScope) => void;
	refresh: (ctx?: ExtensionContext) => void;
}

export function formatPipelineStatus(
	l1: { remaining: number; paused: boolean; queued?: boolean },
	active: { layer: PipelineJobType; detail: string } | undefined,
	skill: string,
): string {
	const l1Text = l1.paused ? (l1.queued ? t("ext.status.l1PausedQueued") : t("ext.status.l1Paused"))
		: l1.queued ? t("ext.status.l1Queued") : t("ext.status.l1Remaining", { n: l1.remaining });
	const memoryText = active?.layer === "l1"
		? t("ext.status.memoryActive", { detail: active.detail })
		: active
			? t("ext.status.memoryBoth", { l1: l1Text, detail: active.detail })
			: t("ext.status.memoryL1", { l1: l1Text });
	return t("ext.status.full", { memory: memoryText, skill });
}

export function setPipelineStatus(
	reporter: PipelineStatusReporter | undefined,
	ctx: ExtensionContext,
	layer: PipelineJobType,
	detail: string,
	scope?: PipelineJobScope,
): void {
	if (scope && !scope.isCurrent()) return;
	if (reporter) reporter.set(ctx, layer, detail, scope);
	else ctx.ui.setStatus("memory", t("ext.status.memoryActive", { detail }));
}

export function clearPipelineStatus(
	reporter: PipelineStatusReporter | undefined,
	ctx: ExtensionContext,
	layer: PipelineJobType,
	scope?: PipelineJobScope,
): void {
	if (scope && !scope.isCurrent()) return;
	if (reporter) reporter.clear(ctx, layer, scope);
	else ctx.ui.setStatus("memory", t("ext.status.memoryBare"));
}
