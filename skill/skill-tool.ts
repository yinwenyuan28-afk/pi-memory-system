import type { SkillManager } from "./skill-manager.ts";

/**
 * OpenAI Function-Calling schema for the `skill_manage` tool.
 */
export const SKILL_MANAGE_SCHEMA = {
	name: "skill_manage",
	description:
		"Create, edit, delete, or list skills. Skills capture **bounded-task-class executable capabilities** " +
		"(workflows with recurring trigger, steps, decisions, validation)—NOT user preferences or style corrections " +
		"(those belong in memory via the memory tool).\n\n" +
		"Actions:\n" +
		"  create: Create a new skill with name, category, and full SKILL.md content.\n" +
		"  edit: Replace SKILL.md content of an existing skill.\n" +
		"  delete: Archive a skill (movement to archived/, not permanent delete).\n" +
		"  list: List all skills, optionally filtered by category.\n" +
		"  write_file: Add a support file (references/*, templates/*, scripts/*).\n\n" +
		"Directory layout:\n" +
		"  skills/<category>/<skill-name>/SKILL.md\n" +
		"  skills/<category>/<skill-name>/references/\n" +
		"  skills/<category>/<skill-name>/templates/\n" +
		"  skills/<category>/<skill-name>/scripts/\n\n" +
		"SKILL.md frontmatter:\n" +
		"  name: lowercase-hyphenated, <=64 chars.\n" +
		"  description: ONE sentence, **<=60 characters**. This is critical — " +
		"longer descriptions are silently truncated in the system prompt.\n" +
		"  version: 0.1.0\n" +
		"  author: Always 'Pi' for user-created skills.\n\n" +
		"Body sections (in order):\n" +
		"  ## When to Use → ## Prerequisites → ## How to Run → " +
		"## Procedure → ## Pitfalls → ## Verification",
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: ["create", "edit", "delete", "list", "write_file", "pin", "unpin"],
				description: "The operation to perform.",
			},
			name: {
				type: "string",
				description: "Skill name (lowercase-hyphenated, <=64 chars). Required for create/edit/delete/write_file.",
			},
			category: {
				type: "string",
				description: "Category folder (e.g. 'workflow', 'tool'). Required for create.",
			},
			content: {
				type: "string",
				description: "Full SKILL.md content for create/edit. Must include frontmatter and body sections.",
			},
			file_path: {
				type: "string",
				description:
					"Support file path for write_file. Must start with 'references/', 'templates/', or 'scripts/'.",
			},
		},
		required: ["action"],
	},
};

export function handleSkillManageTool(args: Record<string, unknown>, manager: SkillManager): string {
	const action = String(args.action || "");

	switch (action) {
		case "create": {
			const name = String(args.name || "");
			const category = String(args.category || "");
			const content = String(args.content || "");
			const result = manager.create(name, category, content);
			return JSON.stringify(result);
		}

		case "edit": {
			const name = String(args.name || "");
			const content = String(args.content || "");
			const result = manager.edit(name, content);
			return JSON.stringify(result);
		}

		case "delete": {
			const name = String(args.name || "");
			const result = manager.delete(name);
			return JSON.stringify(result);
		}

		case "list": {
			const category = args.category !== undefined ? String(args.category) : undefined;
			const skills = manager.list(category);
			return JSON.stringify({
				success: true,
				skills: skills.map((s) => ({
					name: s.name,
					category: s.category,
					description: s.description,
					status: s.status,
					protectedLevel: s.protectedLevel,
					uses: s.uses,
					lastUsed: s.lastUsed,
				})),
			});
		}

		case "pin": {
			const name = String(args.name || "");
			const result = manager.pin(name);
			return JSON.stringify(result);
		}

		case "unpin": {
			const name = String(args.name || "");
			const result = manager.unpin(name);
			return JSON.stringify(result);
		}

		case "write_file": {
			const name = String(args.name || "");
			const filePath = String(args.file_path || "");
			const content = String(args.content || "");
			const result = manager.writeFile(name, filePath, content);
			return JSON.stringify(result);
		}

		default:
			return JSON.stringify({
				success: false,
				error: `Unknown action '${action}'. Use: create, edit, delete, list, write_file`,
			});
	}
}
