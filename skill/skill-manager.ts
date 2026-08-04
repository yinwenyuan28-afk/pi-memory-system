import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SKILLS_DIR = "skills";
const ARCHIVED_DIR = "archived";
const USAGE_FILE = ".usage.json";

export type SkillStatus = "active" | "stale" | "archived";
export type ProtectedLevel = "user" | "pinned" | "bundled";

export interface UsageRecord {
	uses: number;
	lastUsed: number;
	lastCategory?: string;
	pinned?: boolean;
}

export interface SkillInfo {
	name: string;
	category: string;
	path: string;
	description: string;
	status: SkillStatus;
	protectedLevel: ProtectedLevel;
	uses?: number;
	lastUsed?: number;
	createdAt?: number;
}

export interface SkillManageResult {
	success: boolean;
	error?: string;
	skill?: SkillInfo;
	skills?: SkillInfo[];
	path?: string;
}

const STALE_DAYS = 30;

// Bundled skills root — skills shipped with the system that must never be
// modified by the agent or background review.
const BUNDLED_SKILLS_PATHS: string[] = [];

// Injected by extension initialization to include pi's built-in skill paths
export function setBundledSkillsPaths(paths: string[]): void {
	BUNDLED_SKILLS_PATHS.length = 0;
	BUNDLED_SKILLS_PATHS.push(...paths);
}

export class SkillManager {
	private profilePath: string;
	private additionalUserPaths: string[];

	constructor(profilePath: string, additionalUserPaths: string[] = []) {
		this.profilePath = profilePath;
		this.additionalUserPaths = additionalUserPaths;
	}

	private get skillsRoot(): string {
		return join(this.profilePath, SKILLS_DIR);
	}

	// ── Core CRUD ──────────────────────────────────────────────────

	create(name: string, category: string, content: string): SkillManageResult {
		if (!name || !category || !content) {
			return { success: false, error: "name, category, and content are required." };
		}

		const normalizedName = this.normalizeName(name);
		const skillDir = join(this.skillsRoot, category, normalizedName);
		const skillPath = join(skillDir, "SKILL.md");

		if (existsSync(skillPath)) {
			return { success: false, error: `Skill '${normalizedName}' already exists in category '${category}'.` };
		}

		mkdirSync(join(skillDir, "references"), { recursive: true });
		mkdirSync(join(skillDir, "templates"), { recursive: true });
		mkdirSync(join(skillDir, "scripts"), { recursive: true });

		writeFileSync(skillPath, content, "utf-8");

		// Record usage for new skill
		this.recordUse(normalizedName, category);

		const description = this.extractDescription(content);
		return {
			success: true,
			skill: {
				name: normalizedName,
				category,
				path: skillDir,
				description,
				status: "active",
				protectedLevel: "user",
				uses: 1,
				lastUsed: Date.now(),
				createdAt: Date.now(),
			},
		};
	}

	edit(name: string, content: string): SkillManageResult {
		const found = this.findSkill(name);
		if (!found) {
			return { success: false, error: `Skill '${name}' not found.` };
		}

		if (found.protectedLevel === "bundled") {
			return { success: false, error: `Cannot edit bundled skill '${name}'.` };
		}

		const skillPath = join(found.path, "SKILL.md");
		writeFileSync(skillPath, content, "utf-8");
		this.recordUse(name, found.category);

		return {
			success: true,
			skill: { ...found, description: this.extractDescription(content) },
		};
	}

	delete(name: string): SkillManageResult {
		const found = this.findSkill(name);
		if (!found) {
			return { success: false, error: `Skill '${name}' not found.` };
		}

		if (found.protectedLevel === "bundled") {
			return { success: false, error: `Cannot delete bundled skill '${name}'.` };
		}
		if (found.protectedLevel === "pinned") {
			return { success: false, error: `Skill '${name}' is pinned. Unpin it first.` };
		}

		const archivedRoot = join(this.skillsRoot, ARCHIVED_DIR);
		mkdirSync(archivedRoot, { recursive: true });

		const dest = join(archivedRoot, `${found.category}--${found.name}`);
		if (existsSync(dest)) {
			rmSync(dest, { recursive: true, force: true });
		}

		// Move to archive instead of permanent delete
		try {
			renameSync(found.path, dest);
		} catch {
			this.copyDirectory(found.path, dest);
			rmSync(found.path, { recursive: true, force: true });
		}

		return { success: true };
	}

	list(category?: string, includeArchived = false): SkillInfo[] {
		const skills: SkillInfo[] = [];

		// List bundled skills
		for (const bundledPath of BUNDLED_SKILLS_PATHS) {
			this.scanSkillDir(bundledPath, skills, "bundled", category, includeArchived);
		}

		// List user skills from profile
		if (existsSync(this.skillsRoot)) {
			const categories = category ? [category] : this.listCategories();
			for (const cat of categories) {
				const catDir = join(this.skillsRoot, cat);
				if (!existsSync(catDir)) continue;
				this.scanSkillDir(catDir, skills, "user", category, includeArchived);
			}
		}

		// List user skills from additional paths (e.g. agentDir/skills/)
		for (const additionalPath of this.additionalUserPaths) {
			if (!existsSync(additionalPath)) continue;
			this.scanSkillDir(additionalPath, skills, "user", category, includeArchived);
		}

		// List archived if requested
		if (includeArchived) {
			const archivedDir = join(this.skillsRoot, ARCHIVED_DIR);
			if (existsSync(archivedDir)) {
				this.scanSkillDir(archivedDir, skills, "user", undefined, true);
			}
		}

		return skills;
	}

	writeFile(skillName: string, filePath: string, content: string): SkillManageResult {
		const found = this.findSkill(skillName);
		if (!found) {
			return { success: false, error: `Skill '${skillName}' not found.` };
		}

		if (found.protectedLevel === "bundled") {
			return { success: false, error: `Cannot modify bundled skill '${skillName}'.` };
		}

		const validPrefixes = ["references/", "templates/", "scripts/", "assets/"];
		const hasValidPrefix = validPrefixes.some((p) => filePath.startsWith(p));
		if (!hasValidPrefix) {
			return {
				success: false,
				error: `file_path must start with one of: ${validPrefixes.join(", ")}`,
			};
		}

		const fullPath = join(found.path, filePath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content, "utf-8");
		this.recordUse(skillName, found.category);

		return { success: true, path: filePath };
	}

	// ── P1: Usage Tracking ─────────────────────────────────────────

	recordUse(name: string, category: string): void {
		const usage = this.loadUsage();
		const normalized = this.normalizeName(name);
		const existing = usage[normalized];
		usage[normalized] = {
			uses: (existing?.uses || 0) + 1,
			lastUsed: Date.now(),
			lastCategory: category,
			pinned: existing?.pinned ?? false,
		};
		this.saveUsage(usage);
	}

	getUsage(name: string): UsageRecord | undefined {
		const usage = this.loadUsage();
		return usage[this.normalizeName(name)];
	}

	getAllUsage(): Record<string, UsageRecord> {
		return this.loadUsage();
	}

	// ── P3: Pin / Unpin ────────────────────────────────────────────

	pin(name: string): SkillManageResult {
		const found = this.findSkill(name);
		if (!found) {
			return { success: false, error: `Skill '${name}' not found.` };
		}
		if (found.protectedLevel === "bundled") {
			return { success: false, error: `Cannot pin bundled skill '${name}'.` };
		}

		const usage = this.loadUsage();
		const normalized = this.normalizeName(name);
		usage[normalized] = usage[normalized] || { uses: 0, lastUsed: Date.now(), lastCategory: found.category };
		usage[normalized].pinned = true;
		this.saveUsage(usage);

		return { success: true };
	}

	unpin(name: string): SkillManageResult {
		const usage = this.loadUsage();
		const normalized = this.normalizeName(name);
		if (usage[normalized]) {
			usage[normalized].pinned = false;
			this.saveUsage(usage);
		}
		return { success: true };
	}

	// ── Status ──────────────────────────────────────────────────────

	private getStatus(name: string, skillPath: string): SkillStatus {
		if (skillPath.includes(ARCHIVED_DIR)) return "archived";

		const usage = this.loadUsage();
		const record = usage[this.normalizeName(name)];
		if (!record) return "active";

		const daysSinceUse = (Date.now() - record.lastUsed) / (1000 * 60 * 60 * 24);
		return daysSinceUse > STALE_DAYS ? "stale" : "active";
	}

	private extractDescription(skillMd: string): string {
		const match = skillMd.match(/description:\s*"([^"]+)"/);
		return match ? match[1] : "";
	}

	private normalizeName(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/-{2,}/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 64);
	}

	private listCategories(): string[] {
		if (!existsSync(this.skillsRoot)) return [];
		return readdirSync(this.skillsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== ARCHIVED_DIR)
			.map((e) => e.name);
	}

	findSkill(name: string): SkillInfo | null {
		const normalized = this.normalizeName(name);

		// Check user skills (including archived)
		if (existsSync(this.skillsRoot)) {
			const result = this.findInDir(this.skillsRoot, normalized, "user");
			if (result) return result;
		}

		// Check bundled
		for (const bundledPath of BUNDLED_SKILLS_PATHS) {
			const result = this.findInDir(bundledPath, normalized, "bundled");
			if (result) return result;
		}

		// Check additional user paths
		for (const additionalPath of this.additionalUserPaths) {
			const result = this.findInDir(additionalPath, normalized, "user");
			if (result) return result;
		}

		return null;
	}

	private findInDir(root: string, normalizedName: string, protectedLevel: ProtectedLevel): SkillInfo | null {
		if (!existsSync(root)) return null;

		const entries = readdirSync(root, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const fullPath = join(root, entry.name);

			// Check if this directory IS the skill (has SKILL.md)
			const skillMdPath = join(fullPath, "SKILL.md");
			if (existsSync(skillMdPath) && this.normalizeName(entry.name) === normalizedName) {
				const content = readFileSync(skillMdPath, "utf-8");
				const usage = this.loadUsage();
				const record = usage[normalizedName];
				return {
					name: entry.name,
					category: join(root).split(/[\\/]/).pop() || "",
					path: fullPath,
					description: this.extractDescription(content),
					status: this.getStatus(entry.name, fullPath),
					protectedLevel,
					uses: record?.uses,
					lastUsed: record?.lastUsed,
				};
			}

			// If no SKILL.md, recurse into subdirectory (category nesting)
			if (!existsSync(skillMdPath)) {
				const subResult = this.findInDir(fullPath, normalizedName, protectedLevel);
				if (subResult) {
					return subResult;
				}
			}
		}
		return null;
	}

	private scanSkillDir(
		root: string,
		results: SkillInfo[],
		protectedLevel: ProtectedLevel,
		categoryFilter?: string,
		includeArchived = false,
	): void {
		this.scanSkillDirRecursive(root, results, protectedLevel, categoryFilter, includeArchived);
	}

	/**
	 * 递归扫描技能目录（M4 修复）。
	 * 之前的单层扫描导致 <category>/<name>/SKILL.md 的嵌套技能在 list 中不可见。
	 */
	private scanSkillDirRecursive(
		dir: string,
		results: SkillInfo[],
		protectedLevel: ProtectedLevel,
		categoryFilter?: string,
		includeArchived = false,
	): void {
		if (!existsSync(dir)) return;

		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			if (entry.name === ARCHIVED_DIR && !includeArchived) continue;

			const skillPath = join(dir, entry.name);
			const skillMdPath = join(skillPath, "SKILL.md");

			if (!existsSync(skillMdPath)) {
				// 无 SKILL.md → 是分类目录，递归深入
				this.scanSkillDirRecursive(skillPath, results, protectedLevel, categoryFilter, includeArchived);
				continue;
			}

			const content = readFileSync(skillMdPath, "utf-8");
			const usage = this.loadUsage();
			const normalized = this.normalizeName(entry.name);
			const record = usage[normalized];

			const category = entry.name.startsWith("--") ? "archived" : dirname(skillPath).split(/[\/]/).pop() || "";

			if (categoryFilter && category !== categoryFilter) continue;

			results.push({
				name: entry.name,
				category,
				path: skillPath,
				description: this.extractDescription(content),
				status: this.getStatus(entry.name, skillPath),
				protectedLevel,
				uses: record?.uses,
				lastUsed: record?.lastUsed,
			});
		}
	}

	// ── Usage File I/O ─────────────────────────────────────────────

	private usageFilePath(): string {
		return join(this.skillsRoot, USAGE_FILE);
	}

	private loadUsage(): Record<string, UsageRecord> {
		const path = this.usageFilePath();
		if (!existsSync(path)) return {};
		try {
			return JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return {};
		}
	}

	private saveUsage(usage: Record<string, UsageRecord>): void {
		const dir = this.skillsRoot;
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.usageFilePath(), JSON.stringify(usage, null, 2), "utf-8");
	}

	private copyDirectory(src: string, dest: string): void {
		mkdirSync(dest, { recursive: true });
		const entries = readdirSync(src, { withFileTypes: true });
		for (const entry of entries) {
			const srcPath = join(src, entry.name);
			const destPath = join(dest, entry.name);
			if (entry.isDirectory()) {
				this.copyDirectory(srcPath, destPath);
			} else {
				writeFileSync(destPath, readFileSync(srcPath));
			}
		}
	}
}
