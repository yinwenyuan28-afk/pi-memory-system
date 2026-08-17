import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROFILE, PROFILES_DIR_NAME, type Profile } from "./types.js";

const PROFILES_DIR = PROFILES_DIR_NAME;
const SETTINGS_FILE = "settings.json";

/**
 * ProfileManager — manages multiple isolated memory profiles.
 *
 * Each profile has its own complete set of memory files:
 *   profiles/<name>/
 *   ├── MEMORY.md
 *   ├── USER.md
 *   ├── routes.md
 *   ├── .staging/
 *   └── sub-memories/
 */
export class ProfileManager {
	private baseDir: string;
	private activeProfile: string;

	constructor(agentDir: string) {
		this.baseDir = join(agentDir, PROFILES_DIR);
		this.activeProfile = this.readActiveProfile();
	}

	// ── Public API ──────────────────────────────────────────────────

	/** List all available profiles. */
	listProfiles(): Profile[] {
		if (!existsSync(this.baseDir)) {
			return [{ name: DEFAULT_PROFILE, path: this.profilePath(DEFAULT_PROFILE) }];
		}

		const entries = readdirSync(this.baseDir, { withFileTypes: true });
		const profiles: Profile[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			const profilePath = join(this.baseDir, entry.name);
			let createdAt: number | undefined;
			try {
				createdAt = statSync(profilePath).birthtimeMs;
			} catch {
				// ignore
			}
			profiles.push({ name: entry.name, path: profilePath, createdAt });
		}

		if (!profiles.length) {
			return [{ name: DEFAULT_PROFILE, path: this.profilePath(DEFAULT_PROFILE) }];
		}
		return profiles;
	}

	/** Get the currently active profile. */
	getActiveProfile(): Profile {
		const path = this.profilePath(this.activeProfile);
		if (!existsSync(path)) {
			this.ensureProfileStructure(path);
		}
		return { name: this.activeProfile, path };
	}

	/** Switch to a different profile (persists to settings.json). */
	switchProfile(name: string): Profile {
		if (!name || name.startsWith(".")) {
			throw new Error(`Invalid profile name: '${name}'`);
		}
		const path = this.profilePath(name);
		if (!existsSync(path)) {
			this.ensureProfileStructure(path);
		}
		this.activeProfile = name;
		this.writeActiveProfile(name);
		return { name, path };
	}

	/** Create a new profile, optionally cloning from an existing one. */
	createProfile(name: string, cloneFrom?: string): Profile {
		if (!name || name.startsWith(".")) {
			throw new Error(`Invalid profile name: '${name}'`);
		}

		const newPath = this.profilePath(name);
		if (existsSync(newPath)) {
			throw new Error(`Profile '${name}' already exists.`);
		}

		if (cloneFrom) {
			const sourcePath = this.profilePath(cloneFrom);
			if (!existsSync(sourcePath)) {
				throw new Error(`Source profile '${cloneFrom}' does not exist.`);
			}
			this.copyDirectory(sourcePath, newPath);
		} else {
			this.ensureProfileStructure(newPath);
		}

		const stat = statSync(newPath);
		return { name, path: newPath, createdAt: stat.birthtimeMs };
	}

	/** Delete a profile completely. */
	deleteProfile(name: string): void {
		if (name === DEFAULT_PROFILE) {
			throw new Error("Cannot delete the default profile.");
		}
		if (name === this.activeProfile) {
			throw new Error("Cannot delete the active profile. Switch to another profile first.");
		}

		const path = this.profilePath(name);
		if (!existsSync(path)) {
			throw new Error(`Profile '${name}' does not exist.`);
		}
		rmSync(path, { recursive: true, force: true });
	}

	/** Get current active profile name. */
	getActiveProfileName(): string {
		return this.activeProfile;
	}

	// ── Internal ────────────────────────────────────────────────────

	private readActiveProfile(): string {
		try {
			const settingsPath = join(this.baseDir, "..", SETTINGS_FILE);
			if (existsSync(settingsPath)) {
				const raw = readFileSync(settingsPath, "utf-8");
				const settings = JSON.parse(raw);
				if (settings.activeProfile && typeof settings.activeProfile === "string") {
					return settings.activeProfile;
				}
			}
		} catch {
			// ignore — fall back to default
		}
		return DEFAULT_PROFILE;
	}

	private writeActiveProfile(name: string): void {
		try {
			const settingsPath = join(this.baseDir, "..", SETTINGS_FILE);
			let settings: Record<string, unknown> = {};
			if (existsSync(settingsPath)) {
				const raw = readFileSync(settingsPath, "utf-8");
				settings = JSON.parse(raw);
			}
			settings.activeProfile = name;
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
		} catch {
			// best effort
		}
	}

	private profilePath(name: string): string {
		return join(this.baseDir, name);
	}

	private ensureProfileStructure(path: string): void {
		mkdirSync(join(path, "sub-memories", "global"), { recursive: true });
		mkdirSync(join(path, ".staging"), { recursive: true });

		// Create empty files if they don't exist
		const files = ["MEMORY.md", "USER.md", "routes.md"];
		for (const file of files) {
			const filePath = join(path, file);
			if (!existsSync(filePath)) {
				writeFileSync(filePath, "", "utf-8");
			}
		}
	}

	private copyDirectory(src: string, dest: string): void {
		mkdirSync(dest, { recursive: true });
		const entries = readdirSync(src, { withFileTypes: true });
		for (const entry of entries) {
			const srcPath = join(src, entry.name);
			const destPath = join(dest, entry.name);
			if (entry.isDirectory()) {
				this.copyDirectory(srcPath, destPath);
			} else if (entry.isFile()) {
				writeFileSync(destPath, readFileSync(srcPath));
			}
		}
	}
}
