/**
 * memory/viewers/deploy.ts —— 查看器**部署**：仓库源码 → {memoryDB}/viewers/
 *
 * 为什么要有这个模块（2026-10-08，见 plan/pi-memory-system/completed/查看器-跟版重写-计划.md）：
 * 旧查看器是 profile 里手维护的单个 HTML —— 不在 git、`package.json` 不发布、扩展也不生成它
 * （`VIEWER_DIR` 全仓库无人引用）。于是后端每次改 schema 都静默把它甩开：场景池（09-15）、
 * L2 归档（09-27）、type 收束与项目归属（10-02）、`taskState`（10-08）全都没跟上，而页头注释
 * 还在声称「与 quality.ts 1:1」。**根因是没有任何东西负责让它跟版**，所以这里不是再改一次内容，
 * 而是补上「源码在仓库、运行位置由代码同步」这条链路。
 *
 * 设计要点（每条都对应一个具体的坑）：
 *
 *  1. **只在内容变化时写**：逐文件比 sha256。日常激活零写入，不会每次重启都 churn 一遍
 *     （旧文件被无谓改写会让「谁在改我的 profile」这类排查失效）。
 *  2. **原子写**：走 `util/atomic-write.ts`（与 settings.json 同一实现）。页面可能正被浏览器
 *     打开着，截断式写入会让用户在刷新前看到半截 HTML。
 *  3. **只碰自己拥有的文件**：`viewer-manifest.json` 记录本模块写过的文件；删除/退役只对
 *     清单内的条目生效。用户往 `viewers/` 里放的东西（自留脚本、临时 JSON）绝不被清理。
 *  4. **退役而非删除**：废弃页面（如 `vue-viewer/`）整体挪到
 *     `{memoryDB}/backups/viewers-retired/`，保留可回退性。删除是不可逆动作，不该由一次
 *     扩展激活顺手做掉。
 *  5. **失败不阻塞激活**：部署问题不该让记忆系统起不来。调用方把异常记为 notice 即可，
 *     本模块内部也逐文件容错（单文件失败不影响其余）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { PLUGIN_ROOT } from "../../util/agent-dir.ts";
import { atomicWriteBytes } from "../../util/atomic-write.ts";
import { MEMORY_DB_DIR, VIEWERS_RETIRED_DIR, VIEWER_DIR, VIEWER_MANIFEST_FILE } from "../paths.ts";

/** 仓库内的查看器源码目录（随包发布，见 package.json 的 files）。 */
export const VIEWER_SOURCE_DIR = join(PLUGIN_ROOT, "viewers");

/**
 * 已废弃、需要在部署时移入备份的路径（相对 `viewers/`）。
 *
 * `vue-viewer/`：2026-08-23 的 Vue 原型，已被 `records-viewer.html` 取代 —— 没有 node_modules、
 * 没有 dist，其 `quality.js` 只有日历天衰减（连 `activeDays` 都没有），hit-stats 只认裸数组。
 * 留着的唯一后果是下次有人打开它、看到一份更旧的数字。**移入备份而不是删除**：它是用户资产，
 * 删不删由用户决定。
 */
const RETIRED_PATHS: readonly string[] = ["vue-viewer"];

/** 清单条目：一个被本模块部署的文件。 */
export interface ViewerManifestEntry {
	/** 相对 `viewers/` 的路径（POSIX 斜杠，跨平台一致） */
	path: string;
	/** 内容 sha256（十六进制） */
	sha256: string;
	/** 字节数 */
	size: number;
}

/** 版本清单（`viewer-manifest.json`）。 */
export interface ViewerManifest {
	/** `{包版本}+{内容哈希前 8 位}`；任一页面改动都会变 */
	version: string;
	/** 本次部署时间（ISO） */
	generatedAt: string;
	/** 源码根（诊断用：判断页面是哪份源码部署的） */
	sourceRoot: string;
	/** 本次部署的文件（也即本模块「拥有」的文件全集） */
	files: ViewerManifestEntry[];
	/** 已退役并移入备份的路径 */
	retired: string[];
}

/** 一次部署的结果。 */
export interface DeployViewersResult {
	/** 版本号（内容哈希派生） */
	version: string;
	/** 实际写入的文件（相对路径，POSIX 斜杠） */
	written: string[];
	/** 内容一致、跳过的文件 */
	skipped: string[];
	/** 本次退役并移入备份的路径 */
	retired: string[];
	/** 逐文件失败信息（部署不因此中断） */
	errors: string[];
	/** 目标目录（调用方用于提示路径） */
	targetDir: string;
}

/** 目录递归列出所有文件，返回相对路径（POSIX 斜杠），已排序。 */
function listFilesRecursive(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listFilesRecursive(full, base));
		} else if (entry.isFile()) {
			out.push(relative(base, full).split(sep).join("/"));
		}
	}
	return out.sort();
}

/** 计算字节的 sha256（十六进制）。 */
function sha256Of(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** 读包版本号（读不到就退化为 "0"；版本只用于显示，不该让部署失败）。 */
function readPackageVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf-8")) as { version?: unknown };
		return typeof pkg.version === "string" && pkg.version ? pkg.version : "0";
	} catch {
		return "0";
	}
}

/** 源码扫描结果：文件清单 + 由清单派生的版本号。 */
export interface ViewerSourceScan {
	/** 源码根 */
	sourceDir: string;
	/** 全部文件（相对路径，POSIX 斜杠，已排序） */
	files: ViewerManifestEntry[];
	/** `{包版本}+{内容哈希前 8 位}` */
	version: string;
	/** 列举/读取失败的文件（不阻断；它们不进 files，也就不参与哈希） */
	errors: string[];
}

/**
 * 扫描源码目录并算出**内容版本号**（唯一实现）。
 *
 * 为什么单独抽出来：这个版本号有两处消费者 —— ① 部署写进 `viewer-manifest.json`；
 * ② 写盘桥的漂移检测（`/api/viewer-status`）要拿"仓库源码的版本"与"已部署的版本"比。
 * 若两处各算一遍，公式一改就会出现"明明已部署却一直报漂移"（或反过来漏报），
 * 而这正是本次要根治的失效模式 —— 所以哈希口径只能有一份。
 *
 * @param sourceDir 源码目录（默认 `PLUGIN_ROOT/viewers`）
 */
export function scanViewerSource(sourceDir: string = VIEWER_SOURCE_DIR): ViewerSourceScan {
	const out: ViewerSourceScan = { sourceDir, files: [], version: "", errors: [] };
	if (!existsSync(sourceDir)) return out;

	let rels: string[];
	try {
		rels = listFilesRecursive(sourceDir);
	} catch (e) {
		out.errors.push(`列举源码目录失败：${e instanceof Error ? e.message : String(e)}`);
		return out;
	}

	const hash = createHash("sha256");
	for (const rel of rels) {
		let data: Uint8Array;
		try {
			data = readFileSync(join(sourceDir, rel.split("/").join(sep)));
		} catch (e) {
			out.errors.push(`${rel}：读取失败（${e instanceof Error ? e.message : String(e)}）`);
			continue;
		}
		const sha = sha256Of(data);
		out.files.push({ path: rel, sha256: sha, size: data.byteLength });
		hash.update(`${rel}\0${sha}\0`);
	}
	out.version = `${readPackageVersion()}+${hash.digest("hex").slice(0, 8)}`;
	return out;
}

/** 读已有的清单；缺失/损坏一律当作「没有」——那意味着全部文件会被重写一遍，是安全的退化。 */
function readManifest(file: string): ViewerManifest | null {
	try {
		if (!existsSync(file)) return null;
		const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<ViewerManifest>;
		if (!Array.isArray(raw?.files)) return null;
		return {
			version: typeof raw.version === "string" ? raw.version : "",
			generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
			sourceRoot: typeof raw.sourceRoot === "string" ? raw.sourceRoot : "",
			files: raw.files.filter((f): f is ViewerManifestEntry => !!f && typeof f.path === "string"),
			retired: Array.isArray(raw.retired) ? raw.retired.filter((r): r is string => typeof r === "string") : [],
		};
	} catch {
		return null;
	}
}

/**
 * 把某个目标路径（文件或目录）移入退役备份目录。
 *
 * 用 `renameSync` 同盘移动（memoryDB 与 backups 同在 profile 下，必然同盘）；
 * 目标已存在时先删旧的备份（同名路径重复退役只可能是上一次没成或源码里删了又加回来）。
 *
 * @returns 是否真的移动了
 */
function retirePath(sourceAbs: string, retiredRel: string, retiredRootAbs: string): boolean {
	const dated = retiredRel.split("/").join(sep);
	const dest = join(retiredRootAbs, dated);
	mkdirSync(dirname(dest), { recursive: true });
	try {
		if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
		renameSync(sourceAbs, dest);
		return true;
	} catch {
		return false;
	}
}

/**
 * 部署查看器：把 `PLUGIN_ROOT/viewers/` 同步到 `{memoryDB}/viewers/`。
 *
 * 幂等：内容一致的文件不写（二次调用 `written` 为空）。逐文件容错：单文件失败记进 `errors`
 * 并继续，返回值本身不抛（调用方只需提示，不必处理异常）。
 *
 * @param profilePath profile 根目录
 * @param opts.sourceDir 源码目录覆盖（测试注入；默认 `PLUGIN_ROOT/viewers`）
 * @returns 部署结果；源码目录不存在时返回所有数组为空的退化结果
 */
export function deployViewers(profilePath: string, opts: { sourceDir?: string } = {}): DeployViewersResult {
	const targetDir = join(profilePath, MEMORY_DB_DIR, VIEWER_DIR);
	const manifestPath = join(profilePath, MEMORY_DB_DIR, VIEWER_MANIFEST_FILE);
	const retiredRoot = join(profilePath, MEMORY_DB_DIR, VIEWERS_RETIRED_DIR);
	const empty: DeployViewersResult = { version: "", written: [], skipped: [], retired: [], errors: [], targetDir };
	if (!existsSync(opts.sourceDir ?? VIEWER_SOURCE_DIR)) return empty;

	// 1) 扫源码（唯一的哈希口径；版本号由它算出，见 scanViewerSource）
	const scan = scanViewerSource(opts.sourceDir);
	if (scan.errors.some((e) => e.startsWith("列举源码目录失败"))) {
		return { ...empty, errors: scan.errors };
	}
	const sourceDir = scan.sourceDir;
	const files = scan.files;
	const errors = scan.errors.slice();

	// 2) 读已有清单：既用于「内容是否已一致」的快速判断，也用于知道我们拥有哪些文件
	const prev = readManifest(manifestPath);
	const prevHash = new Map<string, string>((prev?.files ?? []).map((f) => [f.path, f.sha256]));

	const written: string[] = [];
	const skipped: string[] = [];

	// 3) 逐文件比对与写入
	for (const entry of files) {
		// 内容一致 → 跳过（**必须在写之前判断**：这就是日常零写入的来源）
		const rel = entry.path;
		if (prevHash.get(rel) === entry.sha256 && existsSync(join(targetDir, rel.split("/").join(sep)))) {
			skipped.push(rel);
			continue;
		}
		try {
			const data = readFileSync(join(sourceDir, rel.split("/").join(sep)));
			const destAbs = join(targetDir, rel.split("/").join(sep));
			mkdirSync(dirname(destAbs), { recursive: true });
			atomicWriteBytes(destAbs, data);
			written.push(rel);
		} catch (e) {
			errors.push(`${rel}：写入失败（${e instanceof Error ? e.message : String(e)}）`);
		}
	}

	// 3) 源码里已删除、但清单里还记着的文件（本模块拥有 → 可以清理）
	for (const entry of prev?.files ?? []) {
		if (files.some((f) => f.path === entry.path)) continue;
		try {
			rmSync(join(targetDir, entry.path.split("/").join(sep)), { force: true });
		} catch {
			/* 清不掉不影响用户（页面可能正被打开），下次部署再试 */
		}
	}

	// 4) 退役废弃路径（移入备份，不删除）
	const retired: string[] = [];
	for (const rel of RETIRED_PATHS) {
		const abs = join(targetDir, rel.split("/").join(sep));
		if (!existsSync(abs)) continue;
		if (retirePath(abs, rel, retiredRoot)) {
			retired.push(rel);
		} else {
			errors.push(`${rel}：退役失败（移入 backups/viewers-retired 时出错）`);
		}
	}

	// 5) 写清单（含本次退役结果；已退役但本次不在场的路径继续保留，便于事后追溯）
	const carriedRetired = (prev?.retired ?? []).filter((r) => !retired.includes(r));
	const version = scan.version;
	const manifest: ViewerManifest = {
		version,
		generatedAt: new Date().toISOString(),
		sourceRoot: sourceDir,
		files,
		retired: [...carriedRetired, ...retired],
	};
	try {
		mkdirSync(dirname(manifestPath), { recursive: true });
		atomicWriteBytes(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8"));
	} catch (e) {
		errors.push(`viewer-manifest.json：写入失败（${e instanceof Error ? e.message : String(e)}）`);
	}

	return { version, written, skipped, retired, errors, targetDir };
}

/** 读目标位置当前的清单（供命令/诊断展示「运行中的页面是哪份」）。 */
export function readDeployedManifest(profilePath: string): ViewerManifest | null {
	return readManifest(join(profilePath, MEMORY_DB_DIR, VIEWER_MANIFEST_FILE));
}

/** 目标目录里是否存在本模块部署过的页面（用于判断"还没部署过"）。 */
export function hasDeployedViewers(profilePath: string): boolean {
	return existsSync(join(profilePath, MEMORY_DB_DIR, VIEWER_DIR, "index.html"));
}

/**
 * 目录条目（诊断用）：列出目标目录下的文件与大小。
 *
 * 只读，给「页面为什么没更新」这类排查用 —— 与清单比对能看出是不是有人手工改了部署产物。
 */
export function listDeployedFiles(profilePath: string): Array<{ path: string; size: number; mtime: string }> {
	const dir = join(profilePath, MEMORY_DB_DIR, VIEWER_DIR);
	if (!existsSync(dir)) return [];
	const out: Array<{ path: string; size: number; mtime: string }> = [];
	for (const rel of listFilesRecursive(dir)) {
		try {
			const st = statSync(join(dir, rel.split("/").join(sep)));
			out.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() });
		} catch {
			/* 竞态（文件刚被删）忽略 */
		}
	}
	return out;
}
