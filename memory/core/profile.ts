import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spliceJsonKey } from "../../util/json-edit.ts";
import { DEFAULT_PROFILE, PROFILES_DIR_NAME, type Profile } from "./types.ts";

const PROFILES_DIR = PROFILES_DIR_NAME;
const SETTINGS_FILE = "settings.json";

/**
 * 激活 profile 在宿主 settings.json 里的位置（点号路径，见 util/json-edit）。
 *
 * 为什么挂在自己的命名空间下而不是裸的顶层 `activeProfile`：
 * settings.json 是宿主拥有的文件，顶层键是它的命名空间，我们只占其中一个。
 * `memorySystem` 一眼能看出这段不是宿主写的，将来要整个摘掉也只需去掉一个对象，
 * 不会和宿主将来可能新增的同名键静默互相覆盖。
 */
const ACTIVE_PROFILE_KEY = "memorySystem.activeProfile";

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
		const prev = this.activeProfile;
		this.activeProfile = name;
		try {
			this.writeActiveProfile(name);
		} catch (e) {
			// 写盘失败必须回滚内存：否则会话里用的是新 profile、磁盘上却是旧的，
			// 重启后静默变回去，用户全程看不到任何提示 —— 这正是原实现「catch 吞掉 +
			// 先改内存后写盘」组合出来的假成功。
			this.activeProfile = prev;
			throw new Error(
				`切换 profile 失败（仍保持 '${prev}'）: ${e instanceof Error ? e.message : String(e)}`
			);
		}
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
				const settings = JSON.parse(raw) as Record<string, unknown>;
				const ns = settings?.memorySystem as Record<string, unknown> | undefined;
				const cur = ns?.activeProfile;
				if (typeof cur === "string" && cur) return cur;
				// 旧版写的是顶层 activeProfile（2026-10-01 之前）。只读兼容，不再写回 ——
				// 下一次 switch 会把值搬到命名空间下，顶层那个键由用户自行清理。
				const legacy = settings?.activeProfile;
				if (typeof legacy === "string" && legacy) return legacy;
			}
		} catch {
			// ignore — fall back to default
		}
		return DEFAULT_PROFILE;
	}

	/**
	 * 把激活 profile 写进宿主 settings.json。
	 *
	 * 这个文件**有别的写者**（宿主的 settings-manager，改主题/模型/装包时都会重写它），
	 * 所以三条约束缺一不可（STANDALONE_RELEASE_PLAN P1-6）：
	 *
	 * 1. **定点编辑**：只替换 `memorySystem.activeProfile` 那一个值，文件其余字节不动。
	 *    不做 parse→stringify 全量往返 —— 那样等于拿旧快照盖掉整个文件，会把并发写者的
	 *    改动抹掉，也会把不认识的键重新排版一遍。
	 * 2. **原子写**：tmp → rename。`writeFileSync` 是「截断 → 重写」，并发读者可能读到半截
	 *    JSON；宿主读失败会记 `globalSettingsLoadError`，之后 `save()` 直接 early-return
	 *    —— 一次写坏 = 整个会话的配置写入静默失效。
	 * 3. **写后校验 + 重试**：我们和宿主之间没有共享锁（不引 `proper-lockfile` 的理由见计划：
	 *    为一个键加运行时依赖不划算，而锁实现有 bug 或崩溃留陈旧锁会**阻塞宿主写配置**）。
	 *    写完立刻重读确认自己的值还在；不在 = 这期间被别人覆盖了，重来。
	 *
	 * 失败一律抛出，**不再 best-effort 静默吞掉** —— 调用方 switchProfile 靠它回滚内存。
	 */
	private writeActiveProfile(name: string): void {
		const settingsPath = join(this.baseDir, "..", SETTINGS_FILE);
		const rawValue = JSON.stringify(name);
		let lastErr: unknown = null;

		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				// 宿主容忍空 settings.json（它把空当 {}），我们也得能往里写
				const before = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : "";
				const base = before.trim() ? before : "{}";

				// 幂等：值已经对得上就不动文件，省掉一次整文件改名
				if (this.readActiveProfileKey(base) === name) return;

				const spliced = spliceJsonKey(base, ACTIVE_PROFILE_KEY, rawValue);
				this.atomicWrite(settingsPath, spliced.text);

				// 校验：自己的值真的落到位了吗（被并发覆盖时这里不通过）
				const after = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : "";
				if (this.readActiveProfileKey(after) === name) return;
				lastErr = new Error("写入后校验未通过（可能被并发写者覆盖）");
			} catch (e) {
				lastErr = e;
			}
		}
		throw new Error(
			`写入 ${settingsPath} 失败（已重试 3 次）: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
		);
	}

	/** 从一段 settings.json 文本里取激活 profile 名；取不到或文本非法 → undefined。 */
	private readActiveProfileKey(text: string): string | undefined {
		try {
			const ns = (JSON.parse(text) as Record<string, unknown>)?.memorySystem as
				| Record<string, unknown>
				| undefined;
			const v = ns?.activeProfile;
			return typeof v === "string" && v ? v : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 原子写：写同目录 tmp → rename 覆盖。Windows 上 rename 撞 EBUSY/EPERM
	 * （别的进程正开着这个文件）是已知现象，重试 3 次 / 0·50·50ms。
	 *
	 * ⚠ 不要写成「先 `rmSync` 再 `renameSync`」—— 仓库里 `config/app-config.ts` 和
	 * `util/judg-session-project` 都是那么写的，那会在两者之间留一个「文件不存在」的
	 * 空窗，比不原子还糟。Node 的 `fs.renameSync` 在 Windows 上走
	 * `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，本机实测能直接覆盖已存在文件，
	 * `rmSync` 纯属多余（方法落地时实测过，见 scripts/verify-profile-settings.ts）。
	 */
	private atomicWrite(file: string, text: string): void {
		const tmp = `${file}.tmp-${randomUUID()}`;
		const delays = [0, 50, 50];
		let lastErr: unknown = null;
		for (const d of delays) {
			if (d > 0) {
				// 同步接口只能忙等（这里不能 await）
				const until = Date.now() + d;
				while (Date.now() < until) { /* spin */ }
			}
			try {
				writeFileSync(tmp, text, "utf-8");
				renameSync(tmp, file);
				return;
			} catch (e) {
				lastErr = e;
			}
		}
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* 临时文件残留不影响正确性 */
		}
		throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
