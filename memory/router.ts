import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Route, RouteResult } from "./types.js";

const ROUTES_FILE = "routes.md";

/**
 * Memory routing engine — resolves user input against routes.md rules
 * at the CODE level, not via LLM prompt injection.
 */
export class MemoryRouter {
	private routes: Route[] = [];
	private profilePath = "";
	private lastMtime = 0;

	loadRoutes(profilePath: string): void {
		this.profilePath = profilePath;
		const filePath = join(profilePath, ROUTES_FILE);
		if (!existsSync(filePath)) {
			this.routes = [];
			return;
		}
		const raw = readFileSync(filePath, "utf-8");
		this.routes = this.parseRoutes(raw);
	}

	/**
	 * Resolve matching routes for the given user input and cwd.
	 *
	 * 1. Reads routes.md (cached, with mtime check).
	 * 2. Filters disabled routes.
	 * 3. Matches keywords (regex) against userInput.
	 * 4. Optionally matches path_contains against cwd.
	 * 5. Sorts by priority descending.
	 * 6. Deduplicates by mutex_group (keeps highest priority).
	 * 7. Loads sub-memory files for matching routes.
	 */
	resolve(userInput: string, cwd: string): RouteResult[] {
		this.reloadIfChanged();

		const results: RouteResult[] = [];

		for (const route of this.routes) {
			if (route.disabled) continue;

			// Match keywords
			const keywords = route.match.keywords;
			const keywordMatch = keywords.some((kw: string) => {
				try {
					return new RegExp(kw, "iu").test(userInput);
				} catch {
					return userInput.toLowerCase().includes(kw.toLowerCase());
				}
			});
			if (!keywordMatch) continue;

			// Match path_contains (optional)
			if (route.match.pathContains) {
				if (!cwd.toLowerCase().includes(route.match.pathContains.toLowerCase())) {
					continue;
				}
			}

			results.push({ route, content: "" });
		}

		// Sort by priority descending
		results.sort((a, b) => b.route.priority - a.route.priority);

		// Deduplicate by mutex_group — keep only the highest priority in each group
		const seenGroups = new Set<string>();
		const deduped: RouteResult[] = [];
		for (const r of results) {
			const group = r.route.mutexGroup || r.route.id;
			if (seenGroups.has(group)) continue;
			seenGroups.add(group);
			deduped.push(r);
		}

		// Load content for matched routes
		for (const r of deduped) {
			if (r.route.load === "sub-memory") {
				r.content = this.loadSubMemory(r.route.target);
			}
			// For "skill" type, content stays empty — caller resolves the skill name
		}

		return deduped;
	}

	/** Load a sub-memory file by its relative path (from profile root). */
	loadSubMemory(targetPath: string): string {
		// targetPath can be:
		//   "sub-memories/global/Node.js 环境配置.md"
		//   or absolute path
		const fullPath =
			targetPath.startsWith("/") || targetPath.includes(":\\") ? targetPath : join(this.profilePath, targetPath);

		if (!existsSync(fullPath)) {
			return `[Sub-memory file not found: ${targetPath}]`;
		}
		return readFileSync(fullPath, "utf-8").trim();
	}

	/** Get all active routes (for inspection/tool use). */
	getRoutes(): Route[] {
		return this.routes.filter((r) => !r.disabled);
	}

	/** Render matching results as a context block for system prompt injection. */
	renderContext(results: RouteResult[]): string {
		if (!results.length) return "";

		const parts: string[] = [];
		for (const r of results) {
			const header = `[ROUTE MATCHED: ${r.route.id}]`;
			const sep = "═".repeat(46);
			const content = r.content || `[skill: ${r.route.target}]`;
			parts.push(`${header}\n${sep}\n${content}`);
		}
		return parts.join("\n\n");
	}

	// ── Internal ────────────────────────────────────────────────────

	private reloadIfChanged(): void {
		if (!this.profilePath) return;
		const filePath = join(this.profilePath, ROUTES_FILE);
		if (!existsSync(filePath)) return;

		const stat = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
		if (!stat) return;

		// Simple mtime check: just compare content hash
		// A more robust approach would use fs.stat, but this is sufficient
		const mtime = stat.length;
		if (mtime === this.lastMtime) return;
		this.lastMtime = mtime;
		this.loadRoutes(this.profilePath);
	}

	/**
	 * Parse routes.md which contains YAML-like route definitions.
	 *
	 * Format:
	 * ```yaml
	 * routes:
	 *   - id: "git-commit"
	 *     group: "workflow"
	 *     desc: "Git commit"
	 *     match:
	 *       keywords: ["提交", "commit"]
	 *       path_contains: ""
	 *     load: "sub-memory"
	 *     target: "sub-memories/global/git.md"
	 *     priority: 5
	 *     mutex_group: "workflow"
	 *     disabled: false
	 * ```
	 */
	private parseRoutes(raw: string): Route[] {
		// Try JSON code block first
		const jsonRoutes = this.tryParseJsonRoutes(raw);
		if (jsonRoutes) return jsonRoutes;

		return [];
	}

	/**
	 * Extract JSON route definition from ```json ... ``` code blocks.
	 *
	 * Format:
	 * ```json
	 * { "routes": [...] }
	 * ```
	 */
	private tryParseJsonRoutes(raw: string): Route[] | null {
		const blockRegex = /```json\s*\n?([\s\S]*?)```/i;
		const match = raw.match(blockRegex);
		if (!match) return null;

		try {
			const parsed = JSON.parse(match[1].trim()) as { routes: Route[] };
			if (!parsed.routes || !Array.isArray(parsed.routes)) return null;

			return parsed.routes.map((r) => ({
				id: r.id || "",
				group: r.group || "",
				desc: r.desc || "",
				match: {
					keywords: r.match?.keywords || [],
					pathContains: r.match?.pathContains || undefined,
				},
				load: r.load || "sub-memory",
				target: r.target || "",
				priority: r.priority ?? 0,
				mutexGroup: r.mutexGroup || undefined,
				disabled: r.disabled ?? false,
			}));
		} catch {
			return null;
		}
	}
}
