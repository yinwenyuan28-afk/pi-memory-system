import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PipelineJobScope, PipelineJobType } from "./worker.ts";

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
	const l1Text = l1.paused ? (l1.queued ? "L1 已暂停·有排队任务" : "L1 已暂停")
		: l1.queued ? "L1 排队中" : `L1 ${l1.remaining}t`;
	const memoryText = active?.layer === "l1"
		? `Memory ${active.detail}`
		: active
			? `Memory ${l1Text} · ${active.detail}`
			: `Memory ${l1Text}`;
	return `${memoryText} | Skill ${skill}`;
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
	else ctx.ui.setStatus("memory", `Memory ${detail}`);
}

export function clearPipelineStatus(
	reporter: PipelineStatusReporter | undefined,
	ctx: ExtensionContext,
	layer: PipelineJobType,
	scope?: PipelineJobScope,
): void {
	if (scope && !scope.isCurrent()) return;
	if (reporter) reporter.clear(ctx, layer, scope);
	else ctx.ui.setStatus("memory", "Memory");
}
