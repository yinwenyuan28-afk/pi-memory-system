import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { L0_CONVERSATIONS_DIR, MEMORY_DB_DIR } from "../paths.ts";
import { normalizeProjectTag } from "./project-scope.ts";

/** 仅从 profile 的 L0 读取出处；模型提供的路径不参与文件读取。一次提交最多扫描一次。 */
export function createProjectEvidenceVerifier(profilePath: string, records: Record<string, unknown>[]) {
	let messages: Map<string, string | null> | undefined;
	let readError = "";
	const key = (session: string, id: string) => JSON.stringify([session, id]);
	const wanted = new Set<string>();
	for (const record of records) {
		if (typeof record.sessionKey !== "string" || !Array.isArray(record.source_message_ids)) continue;
		for (const id of record.source_message_ids) if (typeof id === "string") wanted.add(key(record.sessionKey, id));
	}
	function load(): Map<string, string | null> {
		if (messages) return messages;
		messages = new Map();
		const dir = join(profilePath, MEMORY_DB_DIR, L0_CONVERSATIONS_DIR);
		if (!existsSync(dir)) return messages;
		try {
			for (const filename of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
				for (const line of readFileSync(join(dir, filename), "utf-8").split(/\r?\n/)) {
					if (!line.trim()) continue;
					let row: Record<string, unknown>;
					try { row = JSON.parse(line); } catch { continue; }
					if (!row || (row.role !== "user" && row.role !== "assistant") || typeof row.sessionKey !== "string" || typeof row.content !== "string") continue;
					const ids = typeof row.id === "string"
						? [row.id]
						: [
							typeof row.sourceLine === "number" ? `${row.sessionKey}#${row.sourceLine}` : "",
							typeof row.timestamp === "string" || (typeof row.timestamp === "number" && Number.isFinite(row.timestamp)) ? `${row.sessionKey}#${row.timestamp}` : "",
						].filter(Boolean);
					for (const id of ids) {
						const k = key(row.sessionKey, id);
						if (!wanted.has(k)) continue; // 仅保留本批出处，避免把全部会话正文载入常驻 Map。
						// 相同 ID 对应不同正文时不能确认出处，不能让后一行静默覆盖前一行。
						if (messages.has(k) && messages.get(k) !== row.content) messages.set(k, null);
						else if (!messages.has(k)) messages.set(k, row.content);
					}
				}
			}
		} catch {
			readError = "L0 证据读取失败";
		}
		return messages;
	}
	return (record: Record<string, unknown>, metadata: Record<string, unknown>): { project: string; error?: string } => {
		const project = normalizeProjectTag(metadata.project);
		const evidence = metadata.projectEvidence;
		if (!project || /(^|\/)\.{1,2}(\/|$)/.test(project) || /^[A-Za-z]:\/$/.test(project) || !Array.isArray(evidence) || evidence.length === 0) return { project: "", error: "逐条项目归属需要合法的 project 和非空 projectEvidence" };
		const session = typeof record.sessionKey === "string" ? record.sessionKey : "";
		const sourceIds = Array.isArray(record.source_message_ids) ? record.source_message_ids : [];
		const source = load();
		if (readError) return { project: "", error: readError };
		for (const item of evidence) {
			if (!item || typeof item !== "object") return { project: "", error: "projectEvidence 条目格式错误" };
			const { message_id: id, path: rawPath } = item as Record<string, unknown>;
			const path = typeof rawPath === "string" ? normalizeProjectTag(rawPath.replace(/^\/([a-zA-Z])\//, (_, drive: string) => `${drive.toUpperCase()}:/`)) : "";
			if (typeof id !== "string" || !sourceIds.includes(id) || !path || /(^|\/)\.{1,2}(\/|$)/.test(path)) return { project: "", error: "项目证据必须引用 source_message_ids 中的消息及绝对路径，路径不得含 . 或 .. 段" };
			const content = source.get(key(session, id));
			if (typeof content !== "string") return { project: "", error: "项目证据的源消息不存在、会话不匹配或 ID 有歧义" };
			const root = project.toLowerCase();
			const p = path.toLowerCase();
			if (p !== root && !p.startsWith(root.endsWith("/") ? root : `${root}/`)) return { project: "", error: "项目证据包含目标项目之外的路径" };
			// 兼容盘符、反斜杠、Git Bash；必须命中完整路径边界，不能把 proj-b 认成 proj。
			const text = content.replace(/\\/g, "/").replace(/(^|[\s"'`(<（：:])\/([a-zA-Z])\//g, (_, prefix: string, drive: string) => `${prefix}${drive.toUpperCase()}:/`).toLowerCase();
			let found = false;
			for (let pos = text.indexOf(p); pos >= 0; pos = text.indexOf(p, pos + 1)) {
				const before = pos === 0 ? "" : text[pos - 1];
				const after = text[pos + p.length] ?? "";
				if ((!before || /[\s"'`(<（：:]/.test(before)) && (!after || /[\s/"'`)>）。，,;；：:]/.test(after))) { found = true; break; }
			}
			if (!found) return { project: "", error: "项目证据路径未出现在所引用的 L0 正文中" };
		}
		return { project };
	};
}
