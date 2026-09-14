import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillManager } from "./skill-manager.ts";

const SUPPORT_FILE_PREFIXES = ["references/", "templates/", "scripts/", "assets/"];

/**
 * OpenAI Function-Calling schema for the `skill_view` tool.
 */
export const SKILL_VIEW_SCHEMA = {
	name: "skill_view",
	description:
		"View the content of a skill's SKILL.md or one of its support files. " +
		"Use this to inspect a skill before deciding whether to update it. " +
		"Required before skill_manage(edit) in background review mode.",
	parameters: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "Skill name (e.g. 'git-commit'). Can also be 'category/skill-name'.",
			},
			file_path: {
				type: "string",
				description:
					"Optional: path within the skill directory. " +
					"Omit to view SKILL.md. Use 'references/api.md' for support files.",
			},
		},
		required: ["name"],
	},
};

export function handleSkillViewTool(args: Record<string, unknown>, skillManager: SkillManager): string {
	const name = String(args.name || "").trim();
	const filePath = args.file_path !== undefined ? String(args.file_path) : undefined;

	if (!name) {
		return JSON.stringify({ success: false, error: "name is required." });
	}

	const found = skillManager.findSkill(name);
	if (!found) {
		return JSON.stringify({
			success: false,
			error: `Skill '${name}' not found. Use skill_manage(list) to see available skills.`,
		});
	}

	// View SKILL.md
	if (!filePath) {
		const skillMdPath = join(found.path, "SKILL.md");
		if (!existsSync(skillMdPath)) {
			return JSON.stringify({ success: false, error: `SKILL.md not found for '${name}'.` });
		}
		const content = readFileSync(skillMdPath, "utf-8");
		return JSON.stringify({
			success: true,
			name: found.name,
			category: found.category,
			description: found.description,
			content,
			supportFiles: listSupportFiles(found.path),
		});
	}

	// View a specific support file
	const hasValidPrefix = SUPPORT_FILE_PREFIXES.some((p) => filePath.startsWith(p));
	if (!hasValidPrefix) {
		return JSON.stringify({
			success: false,
			error: `file_path must start with one of: ${SUPPORT_FILE_PREFIXES.join(", ")}`,
		});
	}

	const targetPath = join(found.path, filePath);
	if (!existsSync(targetPath)) {
		return JSON.stringify({
			success: false,
			error: `File '${filePath}' not found in skill '${name}'.`,
		});
	}

	const content = readFileSync(targetPath, "utf-8");
	return JSON.stringify({
		success: true,
		name: found.name,
		file_path: filePath,
		content,
	});
}

function listSupportFiles(skillPath: string): string[] {
	const files: string[] = [];
	for (const prefix of SUPPORT_FILE_PREFIXES) {
		const dir = join(skillPath, prefix);
		if (!existsSync(dir)) continue;
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile()) {
				files.push(prefix + entry.name);
			}
		}
	}
	return files;
}
