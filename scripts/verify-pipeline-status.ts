import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPipelineStatus } from "../memory/pipeline/status.ts";
import { setupL1Extractor } from "../memory/l1/index.ts";
import { closePipelineJobsDB, getPipelineJobsDB } from "../memory/pipeline/jobs-db.ts";
import { setupSkillReviewer } from "../skill/reviewer.ts";

const idle = { remaining: 7, paused: false };
assert.equal(formatPipelineStatus(idle, undefined, "13t"), "Memory L1 7t | Skill 13t");
assert.equal(formatPipelineStatus({ ...idle, queued: true }, undefined, "13t"), "Memory L1 排队中 | Skill 13t");
assert.equal(formatPipelineStatus({ ...idle, paused: true, queued: true }, undefined, "13t"), "Memory L1 已暂停·有排队任务 | Skill 13t");
assert.equal(formatPipelineStatus({ remaining: 0, paused: true }, undefined, "13t"), "Memory L1 已暂停 | Skill 13t");
assert.equal(formatPipelineStatus(idle, { layer: "l1", detail: "⚙L1 4.2m（子代理存活）" }, "13t"), "Memory ⚙L1 4.2m（子代理存活） | Skill 13t");
assert.equal(formatPipelineStatus(idle, { layer: "l2", detail: "⚙L2 4m" }, "13t"), "Memory L1 7t · ⚙L2 4m | Skill 13t");
assert.equal(formatPipelineStatus(idle, { layer: "l3", detail: "⚙L3 2m" }, "⚙审查"), "Memory L1 7t · ⚙L3 2m | Skill ⚙审查");
assert.equal(formatPipelineStatus(idle, undefined, "等待完整回复"), "Memory L1 7t | Skill 等待完整回复");
const root = mkdtempSync(join(tmpdir(), "pipeline-status-"));
try {
	const handlers = new Map<string, ((event: any) => void)[]>();
	const pi = {
		on: (name: string, fn: (event: any) => void) => handlers.set(name, [...handlers.get(name) ?? [], fn]),
		registerCommand() {},
	};
	const controls = setupL1Extractor(pi as never, () => root, { setCachedCtx() {}, kick() {}, enqueueL1() { return undefined; } } as never);
	const getSkillStatus = setupSkillReviewer(pi as never, () => root);
	assert.deepEqual(controls.getTurnStatus(), { remaining: 10, paused: false, queued: false });
	assert.equal(getSkillStatus(), "20t");
	for (let i = 0; i < 3; i++) for (const fn of handlers.get("input") ?? []) fn({ source: "interactive" });
	assert.equal(controls.getTurnStatus().remaining, 7);
	assert.equal(getSkillStatus(), "17t");
	for (const fn of handlers.get("input") ?? []) fn({ source: "extension" });
	assert.equal(controls.getTurnStatus().remaining, 7);
	const db = getPipelineJobsDB(root);
	db.enqueue("l1", "interval");
	assert.equal(controls.getTurnStatus().queued, true);
	db.claim(db.listQueued()[0].id);
	for (const fn of handlers.get("input") ?? []) fn({ source: "interactive" });
	assert.equal(controls.getTurnStatus().remaining, 7, "L1 active 时计数应暂停");
	controls.reset();
	assert.deepEqual(controls.getTurnStatus(), { remaining: 10, paused: false, queued: false });
	console.log("结果：PASS 16 / FAIL 0");
} finally {
	closePipelineJobsDB(root);
	if (!root.startsWith(join(tmpdir(), "pipeline-status-"))) throw new Error("refuse cleanup outside test temp root");
	rmSync(root, { recursive: true, force: true });
}
