// 查看器部署与静态完整性回归 —— plan/pi-memory-system/completed/查看器-跟版重写-计划.md
//
// 这个脚本要守住的是**机制**，不是页面长什么样。旧查看器之所以落后 4 次 schema 变更，根因就是
// 「没有任何东西负责让它跟版」；所以这里逐条钉住那条新机制：
//
//   ① 首次部署：源码 → {memoryDB}/viewers/，逐文件落地 + 写清单（版本 = 包版本 + 内容哈希前 8 位）
//   ② 幂等：二次调用零写入（日常激活不该 churn 一遍文件）
//   ③ 增量：只改一个源文件 → 只重写那一个
//   ④ 清理由本模块拥有的文件：源里删掉的文件，目标侧也删除
//   ⑤ **不碰**清单之外的文件（用户自留的东西绝不能被清理）
//   ⑥ 退役：已废弃路径（vue-viewer）整体移入 backups/viewers-retired，不删除
//   ⑦ 无源码目录 → 退化返回，不抛
//   ⑧ 版本号：内容变则变、内容不变则不变（桥的漂移检测靠它）
//
// 外加两条**无浏览器也能跑**的静态完整性检查（实测它们能抓到真实错误）：
//   ⑨ 所有查看器 JS 能被解析（语法错误无需开浏览器就能发现 —— 开发期真的写出过一处）
//   ⑩ HTML 里引用的 assets/*.js|css 在源码树里都存在（改名字/漏文件时立刻红）
//   ⑪ 页面用到的 element id 在 HTML 里存在；⑬ 页面调用的 /api/* 端点在桥里已声明
//   ⑭ 页面不含 ../../ 相对路径；⑮ l1-admin 下各 CLI 语法可解析
//   ⑯ 界面设计契约（配色单源 / 滚动条 / overscroll 归属 / 字号令牌 / 卡片截断）
//   ⑰ 打开方式契约（`?port=` 不得被页内跳转或桥的根路径静默丢掉）
//
// 铁律：只用系统临时目录；不读真实 profile、不写任何真实数据。
// 运行：node --conditions=import --experimental-strip-types scripts/verify-viewer-deploy.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	deployViewers,
	hasDeployedViewers,
	listDeployedFiles,
	readDeployedManifest,
	scanViewerSource,
	VIEWER_SOURCE_DIR,
} from "../memory/viewers/deploy.ts";
import { MEMORY_DB_DIR, VIEWERS_RETIRED_DIR, VIEWER_DIR } from "../memory/paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_VIEWERS = join(HERE, "..", "viewers");

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ""): void {
	if (cond) pass++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, actual: T, expected: T): void {
	ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

/** 造一个源码树（内容可控，便于测增量与删除）。 */
function makeSource(root: string, files: Record<string, string>): void {
	for (const [rel, body] of Object.entries(files)) {
		const abs = join(root, rel.split("/").join("/"));
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, body, "utf-8");
	}
}

/** 去掉 CSS 注释再扫描规则，免得把说明文字里的 `overscroll-behavior:` 之类当成真声明。 */
function stripCssComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 取 `marker`（如 @supports …）后面第一个 `{...}` 块的字符区间 [start, end)；找不到返回 null。 */
function supportsBlockSpan(src: string, marker: string): [number, number] | null {
	const start = src.indexOf(marker);
	if (start < 0) return null;
	const open = src.indexOf("{", start);
	if (open < 0) return null;
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) return [start, i + 1];
		}
	}
	return null;
}

const tmp = mkdtempSync(join(tmpdir(), "viewer-deploy-"));
try {
	const source = join(tmp, "source");
	const profile = join(tmp, "profile");
	const target = join(profile, MEMORY_DB_DIR, VIEWER_DIR);

	// ── ① 首次部署 ────────────────────────────────────────────────
	makeSource(source, {
		"index.html": "<!doctype html><title>index</title>",
		"records-viewer.html": "<!doctype html><title>records</title>",
		"assets/viewer.css": "body{}",
		"assets/viewer-core.js": "window.V={};",
	});

	const r1 = deployViewers(profile, { sourceDir: source });
	eq("① written 全部文件（按路径排序）", r1.written, ["assets/viewer-core.js", "assets/viewer.css", "index.html", "records-viewer.html"]);
	eq("① skipped 为空", r1.skipped, []);
	eq("① retired 为空", r1.retired, []);
	eq("① errors 为空", r1.errors, []);
	ok("① 目标文件齐备", existsSync(join(target, "index.html")) && existsSync(join(target, "assets", "viewer.css")));
	ok("① index.html 存在（hasDeployedViewers）", hasDeployedViewers(profile));
	// 目录列举 = 4 个部署文件 + viewer-manifest.json（清单本身也在 viewers/ 下）
	eq("① 目录列举含 4 文件 + 清单", listDeployedFiles(profile).length, 5);
	ok("① 清单文件确实在目录里", listDeployedFiles(profile).some((f) => f.path === "viewer-manifest.json"));

	const m1 = readDeployedManifest(profile);
	ok("① 清单存在且版本形如 x.y.z+8hex", !!m1 && /^.+?\+[0-9a-f]{8}$/.test(m1.version), `version=${m1?.version}`);
	eq("① 清单 files 数", m1?.files.length, 4);
	ok("① 清单 sourceRoot 记录源码目录", m1?.sourceRoot === source, `sourceRoot=${m1?.sourceRoot}`);
	ok("① 清单每条都有 sha256(64) 与 size", !!m1 && m1.files.every((f) => f.sha256.length === 64 && f.size > 0));
	eq("① 清单 retired 为空", m1?.retired, []);

	// ── ② 幂等 ────────────────────────────────────────────────────
	const r2 = deployViewers(profile, { sourceDir: source });
	eq("② 二次部署零写入", r2.written, []);
	eq("② 二次部署全部跳过", r2.skipped.length, 4);
	eq("② 版本号不变", r2.version, r1.version);

	// 记录 mtime，确认真的没动文件
	const beforeMtime = statSync(join(target, "index.html")).mtimeMs;
	const r2b = deployViewers(profile, { sourceDir: source });
	ok("② 未改动文件的 mtime 不变", statSync(join(target, "index.html")).mtimeMs === beforeMtime, `written=${JSON.stringify(r2b.written)}`);

	// ── ③ 增量：只改一个源文件 ─────────────────────────────────────
	writeFileSync(join(source, "assets", "viewer.css"), "body{color:red}", "utf-8");
	const r3 = deployViewers(profile, { sourceDir: source });
	eq("③ 只重写被改的那一个", r3.written, ["assets/viewer.css"]);
	eq("③ 其余跳过", r3.skipped.length, 3);
	ok("③ 版本号随内容变化", r3.version !== r1.version, `${r1.version} → ${r3.version}`);
	ok("③ 目标内容已更新", readFileSync(join(target, "assets", "viewer.css"), "utf-8") === "body{color:red}");

	// ── ④ 源里删除 → 目标侧清理（本模块拥有的文件） ─────────────────
	rmSync(join(source, "assets", "viewer-core.js"));
	const r4 = deployViewers(profile, { sourceDir: source });
	ok("④ 源中删除的文件在目标侧被清理", !existsSync(join(target, "assets", "viewer-core.js")));
	eq("④ 清单不再包含它", readDeployedManifest(profile)?.files.some((f) => f.path === "assets/viewer-core.js"), false);
	ok("④ 其余文件仍在", existsSync(join(target, "index.html")));

	// ── ⑤ 不碰清单之外的文件 ──────────────────────────────────────
	mkdirSync(join(target, "my-notes"), { recursive: true });
	writeFileSync(join(target, "my-notes", "keep.txt"), "用户自留", "utf-8");
	writeFileSync(join(target, "scratch.json"), '{"mine":true}', "utf-8");
	deployViewers(profile, { sourceDir: source });
	ok("⑤ 用户自留目录未被删除", existsSync(join(target, "my-notes", "keep.txt")));
	ok("⑤ 用户自留文件未被删除", readFileSync(join(target, "scratch.json"), "utf-8") === '{"mine":true}');
	ok("⑤ 用户自留文件不进清单", !(readDeployedManifest(profile)?.files ?? []).some((f) => f.path === "scratch.json"));

	// ── ⑥ 退役（vue-viewer → backups/viewers-retired） ─────────────
	mkdirSync(join(target, "vue-viewer", "src"), { recursive: true });
	writeFileSync(join(target, "vue-viewer", "index.html"), "<html>old prototype</html>", "utf-8");
	writeFileSync(join(target, "vue-viewer", "src", "App.vue"), "<template/>", "utf-8");
	const r6 = deployViewers(profile, { sourceDir: source });
	eq("⑥ 报告退役 vue-viewer", r6.retired, ["vue-viewer"]);
	ok("⑥ 原位置已移走", !existsSync(join(target, "vue-viewer")));
	const retiredRoot = join(profile, MEMORY_DB_DIR, VIEWERS_RETIRED_DIR);
	ok("⑥ 备份里保留了整棵子树（不是删除）", existsSync(join(retiredRoot, "vue-viewer", "index.html")) && existsSync(join(retiredRoot, "vue-viewer", "src", "App.vue")));
	ok("⑥ 退役内容完好", readFileSync(join(retiredRoot, "vue-viewer", "index.html"), "utf-8") === "<html>old prototype</html>");
	eq("⑥ 清单记录了退役路径", readDeployedManifest(profile)?.retired, ["vue-viewer"]);
	// 再部署一次：已经不在场，不应重复报告
	const r6b = deployViewers(profile, { sourceDir: source });
	eq("⑥ 重复部署不再报退役", r6b.retired, []);
	eq("⑥ 退役记录仍保留在清单里", readDeployedManifest(profile)?.retired, ["vue-viewer"]);

	// ── ⑦ 无源码目录：退化返回，不抛 ───────────────────────────────
	const r7 = deployViewers(join(tmp, "nonexistent-profile"), { sourceDir: join(tmp, "nope") });
	eq("⑦ 无源码目录 → 各数组为空", [r7.written, r7.skipped, r7.retired, r7.errors], [[], [], [], []]);
	eq("⑦ 无源码目录 → 版本为空", r7.version, "");
	ok("⑦ 未创建目标目录", !existsSync(join(tmp, "nonexistent-profile", MEMORY_DB_DIR, VIEWER_DIR)));

	// ── ⑧ 版本号语义 ──────────────────────────────────────────────
	const s1 = scanViewerSource(source);
	const s2 = scanViewerSource(source);
	eq("⑧ 同一内容两次扫描版本一致", s1.version, s2.version);
	eq("⑧ 文件清单稳定（同序）", s1.files.map((f) => f.path), s2.files.map((f) => f.path));
	writeFileSync(join(source, "index.html"), "<!doctype html><title>index v2</title>", "utf-8");
	const s3 = scanViewerSource(source);
	ok("⑧ 内容变则版本变", s3.version !== s1.version);
	ok("⑧ 版本格式 = 包版本 + '+' + 8 位十六进制", /^[^\s+]+\+[0-9a-f]{8}$/.test(s3.version), s3.version);
	ok("⑧ 空目录的版本与有内容时不同", scanViewerSource(join(tmp, "empty-src")).version === "", "不存在的目录应返回空版本");

	// ── ⑨ 仓库内所有查看器 JS 可解析（无需浏览器） ──────────────────
	{
		const assets = join(REPO_VIEWERS, "assets");
		const jsFiles = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith(".js")) : [];
		ok("⑨ 仓库里存在查看器 JS 资源", jsFiles.length > 0, `找到 ${jsFiles.length} 个`);
		for (const f of jsFiles) {
			let err = "";
			try {
				new Function(readFileSync(join(assets, f), "utf-8"));
			} catch (e) {
				err = e instanceof Error ? e.message : String(e);
			}
			ok(`⑨ ${f} 语法可解析`, err === "", err);
		}
	}

	// ── ⑩ HTML 引用的资源都存在 ────────────────────────────────────
	{
		const htmlFiles = existsSync(REPO_VIEWERS) ? readdirSync(REPO_VIEWERS).filter((f) => f.endsWith(".html")) : [];
		ok("⑩ 仓库里存在查看器页面", htmlFiles.length >= 4, `找到 ${htmlFiles.length} 个`);
		const referenced = new Set<string>();
		for (const f of htmlFiles) {
			const html = readFileSync(join(REPO_VIEWERS, f), "utf-8");
			const refs: string[] = [];
			// 只取本页的相对资源（assets/*），外链与非相对路径跳过
			for (const m of html.matchAll(/(?:src|href)="((?!https?:|\/\/|#|data:)[^"]+)"/g)) {
				const rel = m[1];
				if (!/^[\w./-]+$/.test(rel)) continue;
				refs.push(rel);
				referenced.add(rel);
			}
			for (const rel of refs) {
				ok(`⑩ ${f} 引用的 ${rel} 存在`, existsSync(join(REPO_VIEWERS, rel.split("/").join("/"))));
			}
		}
		ok("⑩ 至少引用了共享资源", referenced.size > 0, `引用 ${[...referenced].join(", ")}`);
	}

	// ── ⑪ 页面引用的元素 id 在页面里存在 ──────────────────────────
	// 这一条能抓到「JS 里 $("x") 拼错/HTML 漏了元素」这类只有开浏览器才发现的错误。
	// 由于三份页面共用共享资源，这里只检查每页自己的 *-view.js 与首方 <script src>。
	{
		const pairs: Array<[string, string]> = [
			["index.html", "assets/index-view.js"],
			["records-viewer.html", "assets/records-view.js"],
			["l2-viewer.html", "assets/l2-view.js"],
			["l3-viewer.html", "assets/l3-view.js"],
			["pipeline-viewer.html", "assets/pipeline-view.js"],
		];
		for (const [htmlFile, jsFile] of pairs) {
			const htmlPath = join(REPO_VIEWERS, htmlFile);
			const jsPath = join(REPO_VIEWERS, jsFile.split("/").join("/"));
			if (!existsSync(htmlPath) || !existsSync(jsPath)) {
				ok(`⑪ ${htmlFile}/${jsFile} 存在`, false);
				continue;
			}
			const html = readFileSync(htmlPath, "utf-8");
			const pageJs = readFileSync(jsPath, "utf-8");
			// 静态 HTML 里的 id **加上**页面 JS 自己注入的 id（如详情弹层用 innerHTML 拼出的
			// `#taskReason`）。不合并这两处就会把"由 JS 生成的元素"误报成缺失。
			const htmlIds = new Set<string>([
				...[...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
				...[...pageJs.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
			]);
			// 只看「页面专属 JS」里的静态字面量 id。共享 JS（viewer-core）里的 id 多为可选增强
			// （nav / versionChip / modeBanner 由 mountChrome 注入），对它做强制检查会误报。
			const pageUsed = new Set<string>();
			for (const m of pageJs.matchAll(/\$\("([^"]+)"\)|getElementById\("([^"]+)"\)/g)) {
				pageUsed.add(m[1] ?? m[2]);
			}
			const missing = [...pageUsed].filter((id) => !htmlIds.has(id));
			ok(
				`⑪ ${htmlFile} 的元素 id 全部存在（页面 JS 用到 ${pageUsed.size} 个）`,
				missing.length === 0,
				missing.length ? `HTML 与页面 JS 里都缺：${missing.join(", ")}` : "",
			);
		}
	}

	// ── ⑫ 仓库源码可被真实部署（用真实目录跑一次，只读校验，不写 profile） ──
	{
		const scan = scanViewerSource(VIEWER_SOURCE_DIR);
		ok("⑫ 仓库 viewers/ 可扫描", scan.files.length >= 5, `files=${scan.files.length}`);
		eq("⑫ 扫描无错误", scan.errors, []);
		ok("⑫ 版本非空", !!scan.version);
	}

	// ── ⑬ 页面调用的 /api/* 端点在桥里真的存在 ──────────────────────
	// 开发期真的踩到过：总览页写成 /api/active-days（桥的路由是 /api/l1/active-days），
	// 结果是**静默退化**——页面不报错，只是永远显示"拿不到活跃会话日"。这种错不该靠肉眼。
	{
		const assetsDir = join(REPO_VIEWERS, "assets");
		const bridgePath = join(HERE, "l1-admin", "viewer-bridge.mjs");
		if (existsSync(assetsDir) && existsSync(bridgePath)) {
			const bridgeSrc = readFileSync(bridgePath, "utf-8");
			const declared = new Set<string>([...bridgeSrc.matchAll(/["'`](\/api\/[\w/-]+)["'`]/g)].map((m) => m[1]));
			const used = new Map<string, string>(); // 端点 → 首次出现的文件
			for (const f of readdirSync(assetsDir).filter((x) => x.endsWith(".js"))) {
				const src = readFileSync(join(assetsDir, f), "utf-8");
				for (const m of src.matchAll(/["'`](\/api\/[\w/-]+)["'`]/g)) {
					if (!used.has(m[1])) used.set(m[1], f);
				}
			}
			ok("⑬ 页面确实调用了 /api/*", used.size > 0, `used=${[...used.keys()].join(", ")}`);
			for (const [endpoint, file] of used) {
				ok(`⑬ ${file} 调用的 ${endpoint} 在桥里已声明`, declared.has(endpoint), `桥里已声明：${[...declared].join(", ")}`);
			}
		} else {
			ok("⑬ 找到查看器 assets 与 viewer-bridge.mjs", false, `assets=${existsSync(assetsDir)} bridge=${existsSync(bridgePath)}`);
		}
	}

	// ── ⑭ 页面不依赖 memoryDB 之外的相对路径 ──────────────────────
	// 桥只挂载 {memoryDB}，所以 HTML/JS 里出现 `../../` 这种"到 profile 根"的相对路径必然 404
	// （开发期真的踩到过：L3 页用 ../../USER.md 读画像，整段读不到）。profile 根的文件必须走
	// /api/profile-files 白名单端点。
	{
		const offenders: string[] = [];
		for (const rel of ["index.html", "records-viewer.html", "l2-viewer.html", "l3-viewer.html", "pipeline-viewer.html", "assets/viewer-core.js", "assets/records-view.js", "assets/l2-view.js", "assets/l3-view.js", "assets/index-view.js", "assets/pipeline-view.js"]) {
			const p = join(REPO_VIEWERS, rel.split("/").join("/"));
			if (!existsSync(p)) continue;
			const src = readFileSync(p, "utf-8");
			// 只看 fetch/loadText/loadJson/loadJsonl/HTML src|href 里的 ../../
			for (const m of src.matchAll(/(?:loadText|loadJson|loadJsonl|fetch)\(\s*["'`](\.\.\/\.\.[^"'`]*)["'`]/g)) offenders.push(`${rel}: ${m[1]}`);
			for (const m of src.matchAll(/(?:src|href)="(\.\.\/\.\.[^"]*)"/g)) offenders.push(`${rel}: ${m[1]}`);
		}
		ok("⑭ 没有指向 memoryDB 之外的相对路径", offenders.length === 0, offenders.join(" | "));
	}

	// ── ⑮ l1-admin 下的 CLI 脚本语法可解析 ────────────────────────
	// 这一目录集中了查看器的全部写盘与诊断入口（`.mjs` + `.mts` 共 12 个），此前没有任何语法门禁 ——
	// 拼错一个括号只有真去跑那个工具时才会发现。
	//
	// ⚠ 不能用 `node --check <file.mts>`：**含 import 的 .mts 会被假绿**（Node 24 实测：走
	// `cjs/loader.wrapSafe` 那条路径后静默返回 0；同样内容写成 .mjs 才会真的报错）。也就是说
	// `--check` + `.mts` 组合恰好对**所有真实 CLI 文件**（它们都以 import 开头）失效 ——
	// 一条从不报警的门禁比没有门禁更糟，所以这里改成：先用 `module.stripTypeScriptTypes`
	// 去掉类型，再把 ESM 源码从 stdin 交给 `node --input-type=module --check -`（该组合实测有效）。
	{
		const adminDir = join(HERE, "l1-admin");
		const clis = existsSync(adminDir)
			? readdirSync(adminDir).filter((f) => f.endsWith(".mjs") || f.endsWith(".mts")).sort()
			: [];
		ok("⑮ 找到 l1-admin 的 CLI 脚本", clis.length >= 6, `找到 ${clis.length} 个：${clis.join(", ")}`);

		const stripFn = typeof stripTypeScriptTypes === "function" ? stripTypeScriptTypes : null;
		/** 调 stripTypeScriptTypes 会抛一次 ExperimentalWarning，压在门禁输出末尾很难看。
		 *  只吞掉这一条（其它 warning 照常），属"让结论可读"的处理，不改变判定结果。 */
		const stripQuietly = (code: string): string => {
			const orig = process.emitWarning;
			process.emitWarning = ((...args: unknown[]) => {
				const text = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
				if (text.includes("stripTypeScriptTypes") || text.includes("ExperimentalWarning")) return;
				return (orig as (...a: unknown[]) => void)(...args);
			}) as typeof process.emitWarning;
			try {
				return (stripFn as (c: string, o?: { mode?: string }) => string)(code, { mode: "strip" });
			} finally {
				process.emitWarning = orig;
			}
		};
		for (const f of clis) {
			const src = readFileSync(join(adminDir, f), "utf-8");
			let jsSrc = src;
			if (f.endsWith(".mts")) {
				if (stripFn) {
					try {
						jsSrc = stripQuietly(src);
					} catch (e) {
						ok(`⑮ ${f} 类型剥离可完成`, false, e instanceof Error ? e.message : String(e));
						continue;
					}
				} else {
					ok(`⑮ ${f} 语法可解析`, false, "当前 Node 无 module.stripTypeScriptTypes，无法可靠校验 .mts");
					continue;
				}
			}
			let err = "";
			try {
				execFileSync(process.execPath, ["--input-type=module", "--check", "-"], {
					input: jsSrc,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (e) {
				const out = [e && (e as { stdout?: string }).stdout, e && (e as { stderr?: string }).stderr]
					.filter(Boolean)
					.join("");
				err = String(out || (e instanceof Error ? e.message : e)).split("\n").slice(0, 4).join(" / ");
			}
			ok(`⑮ ${f} 语法可解析`, err === "", err);
		}
		// 一键启动器必须在场：它是唯一对用户的入口
		ok("⑮ 一键启动器 viewer.mts 在场", clis.includes("viewer.mts"));
		ok("⑮ Windows 双击入口 启动查看器.cmd 在场", existsSync(join(adminDir, "启动查看器.cmd")));
	}
} finally {
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* 清不掉不影响结论 */
	}
}

// ── ⑯ 设计契约（2026-10-08 视觉打磨） ────────────────────────────────────────
// 这一节钉住的是**静默失真**型错误：它们不会报错、不会让页面空白，只是"看起来不对"，
// 所以只有断言能防住。四条对应四个当天真实踩到的坑：
//   · 配色出现第二份副本（JS 里内联十六进制）→ 与 CSS 漂移，改一处不生效
//   · 声明 scrollbar-color → Chromium 退回 16px 经典滚动条（比不声明更宽）
//   · 兜底色特异度过高压过 .c-* 工具类 → 所有条形图变灰
//   · 卡片正文自带内部滚动 → 几百张卡片各画一条原生滚动条
{
	const jsNames = ["index-view.js", "l2-view.js", "l3-view.js", "pipeline-view.js", "quality-core.js", "records-view.js", "viewer-core.js"];
	const viewerJs = jsNames.map((f) => ({ f, src: readFileSync(join(REPO_VIEWERS, "assets", f), "utf-8") }));
	const css = readFileSync(join(REPO_VIEWERS, "assets", "viewer.css"), "utf-8");

	// ① 配色单源：色值只允许出现在 viewer.css 的 :root
	for (const { f, src } of viewerJs) {
		const hits = src.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
		ok(`⑯ ${f} 无硬编码色值（配色单源）`, hits.length === 0, `命中 ${hits.slice(0, 3).join(", ")}`);
	}

	// ② 滚动条：标准属性只允许出现在兼容兜底块内。
	//    必须做「区间判定」而不是「只看兜底块之前」—— 声明写在兜底块**之后**同样会生效，
	//    早先只查前缀的写法被位测试证明会漏掉这种情形。
	const span = supportsBlockSpan(css, "@supports not selector(::-webkit-scrollbar)");
	ok("⑯ 存在 ::-webkit-scrollbar 的兼容兜底块", span !== null);
	const stdDecls = [...css.matchAll(/scrollbar-(?:color|width)\s*:/g)].map((m) => m.index ?? -1);
	const outsideDecls = stdDecls.filter((i) => span === null || i < span[0] || i >= span[1]);
	ok(
		"⑯ scrollbar-color / scrollbar-width 只出现在兜底块内（否则滚动条 11px→16px）",
		outsideDecls.length === 0,
		`兜底块外 ${outsideDecls.length} 处：${outsideDecls.slice(0, 3).join(", ")}`,
	);
	ok("⑯ 保留 ::-webkit-scrollbar 覆盖", /::-webkit-scrollbar\s*\{/.test(css));

	// ②b overscroll-behavior 只允许落在弹层上。
	//     实测（L2 场景页，2026-10-08）：把它加在 aside / .wrap-scroll 这类 overflow:auto 的包装层上，
	//     滚轮会被它吞掉 —— **即使该容器根本没有可滚内容**。L2 的块表格正是"overflow:auto 但不溢出"
	//     且占了内容列大半，于是表现为"鼠标滚动失效"（对照实验：改回 auto 后同样的滚轮立刻能滚页面）。
	const obRules = [...stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.filter((m) => /overscroll-behavior\s*:/.test(m[2]))
		.map((m) => m[1].trim());
	const obHarmful = obRules.filter((s) => /(^|[\s,])(aside|\.wrap-scroll)([\s,]|$)/.test(s));
	ok("⑯ overscroll-behavior 未落在 aside / .wrap-scroll 上（实测会吞掉滚轮）", obHarmful.length === 0, obHarmful.join(" | "));
	ok("⑯ overscroll-behavior 仍留在弹层上（打开弹层时不该滚动背景）", obRules.some((s) => /\.modal/.test(s)));

	// ③ 温度工具类不得被兜底色压过
	for (const token of ["hot", "warm", "cold", "new", "noise", "watch"]) {
		ok(`⑯ 温度工具类 .c-${token} 仍是 background: var(--${token})`, new RegExp(`\\.c-${token}\\s*\\{\\s*background:\\s*var\\(--${token}\\)`).test(css));
	}
	ok("⑯ 条形图兜底色写成 :where()（让出特异度给 .c-*）", /:where\(\.bar-track\)\s*>\s*i\s*\{/.test(css) && /:where\(\.qbar\)\s*>\s*i\s*\{/.test(css));
	ok("⑯ .bar-track > i 自身不声明 background", !/\.bar-track\s*>\s*i\s*\{[^}]*background/.test(css));
	ok("⑯ .qbar > i 自身不声明 background", !/\.qbar\s*>\s*i\s*\{[^}]*background/.test(css));

	// ④ 字号令牌与主题基线
	for (const t of ["xs", "sm", "md", "lg", "xl"]) ok(`⑯ 字号令牌 --t-${t} 在场`, new RegExp(`--t-${t}\\s*:`).test(css));
	ok("⑯ color-scheme: dark 在场（原生控件变暗的前提）", /color-scheme\s*:\s*dark/.test(css));

	// ⑤ 卡片正文只截断、不再自带滚动条
	ok("⑯ 页面脚本不再使用 card-scroll（正文改截断预览）", !viewerJs.some(({ src }) => src.includes("card-scroll")));
	ok("⑯ .card-body 正文声明了 -webkit-line-clamp", /\.card-body \.full-content\s*\{[^}]*-webkit-line-clamp/.test(css));
}

// ── ⑰ 打开方式契约：`?port=` 不能被静默丢掉 ─────────────────────────────────
// 「无写盘桥」不是异常、也不写日志，只是页面安静地少了一半能力（自动加载全部分片、目录列举、
// 画像文件、全部写回）。2026-10-08 用户就是拿着这句话来问"为什么一定要用桥打开"。
// 实测两条会丢 query 的路径都在我们自己可控的代码里，各钉一条：
//   · 顶部导航链接不带 location.search → 在总览页点一下导航就变只读（复现时 L2 出现 3 处"无写盘桥"）
//   · 桥的根路径 `/` 就地返回 index.html → 相对引用的 `assets/*` 解析成 `/assets/*` 全部 404，
//     页面连 window.V 都没有；而桥启动打印的第一行正是这个根路径，终端里可点
{
	const core = readFileSync(join(REPO_VIEWERS, "assets", "viewer-core.js"), "utf-8");
	const bridge = readFileSync(join(HERE, "l1-admin", "viewer-bridge.mjs"), "utf-8");

	ok("⑰ 顶部导航链接携带 location.search（否则点导航即静默变只读）", /p\.file\s*\+\s*escapeHtml\(location\.search\)/.test(core));
	ok(
		"⑰ 桥的根路径改为 302 且带上 ?port=（不能再就地返回 index.html）",
		/url\s*===\s*"\/"[\s\S]{0,500}?writeHead\(302[\s\S]{0,300}?port=\$\{PORT\}/.test(bridge),
	);
	ok("⑰ 缺 ?port= 时给出可操作提示（不是只闷着降级）", /没带 <code>\?port=<\/code>/.test(core));
	ok("⑰ 缺 ?port= 的提示与 file:// 提示分开（两种降级原因不同）", /else if \(!bridgePort\(\)\)/.test(core));

	// ⑰b 局域网调试（2026-10-09 用户要求"别的设备也能打开"）：两个方向各钉一条。
	//   · 页面侧：桥地址必须**跟着页面主机名**走 —— 写死 127.0.0.1 的话，从别的设备打开时
	//     所有 /api/* 都打到那台设备自己的回环上，表现为"本机好好的、换台机器全空"。
	//   · 桥侧：默认必须只有环回；把写端点放到局域网上（无鉴权 + CORS 全开）只能是显式的 `--lan`/`--host`，
	//     而且启动时必须把代价打印出来 —— 这条断言就是防"哪天被顺手改成默认监听 0.0.0.0"。
	ok("⑰ 页面按自身 hostname 拼桥地址（否则别的设备打开 = 全部 /api 失败）", /location\.hostname\s*\|\|\s*"127\.0\.0\.1"/.test(core));
	ok("⑰ 桥默认只监听环回（--lan / --host 才额外听）", /const DEFAULT_HOST = "127\.0\.0\.1"/.test(bridge) && /if \(!LAN\) return \[DEFAULT_HOST\]/.test(bridge));
	ok("⑰ 局域网监听时打印「无鉴权」警告（风险必须留在终端里）", /没有鉴权/.test(bridge) && /--lan/.test(bridge));
}

// ── ⑱ 写盘端点契约（管理操作补齐后新增 12 个写端点，每条闸都要有人盯） ──────────
//
// 这一节守的不是"端点存在"，而是**每个端点的安全默认**：
//   · 写端点默认 dry-run —— 必须显式 `apply:true` 才落盘。少一个 `body.apply === true` 判断，
//     页面上一次"预演"就会变成实写。
//   · 破坏性动作（整库还原 / 向量重建 / 还原备份 / 并入 live 画像）在桥这一层**也要** confirm
//     副验 —— 界面那层是便利，不是安全边界。
//   · 桥把 url 取成 `req.url.split("?")[0]`，所以 GET 端点带查询串必然静默 404（文件头约定 A）。
//   · rollback / scene-pool 这类"说人话"的 CLI 不能走 JSON 解析（否则一次成功被报成
//     "未返回可解析的 JSON"）。
{
	const bridge = readFileSync(join(HERE, "l1-admin", "viewer-bridge.mjs"), "utf-8");
	const assetsDir = join(REPO_VIEWERS, "assets");
	const pageSrc = readdirSync(assetsDir)
		.filter((x) => x.endsWith(".js"))
		.map((f) => readFileSync(join(assetsDir, f), "utf-8"))
		.join("\n");

	// ① 写端点清单必须逐个在场（改名 = 页面静默失效，这一节就是防这个）
	const writeEndpoints = [
		"/api/tombstone",
		"/api/task-state",
		"/api/l1/fix",
		"/api/l1/rollback",
		"/api/l1/embedding",
		"/api/l1/mode",
		"/api/trigger",
		"/api/subagent/stop",
		"/api/l2/archive",
		"/api/l2/restore",
		"/api/l2/scene-pool/seed",
		"/api/l3/edit",
		"/api/l3/restore",
		"/api/l3/merge",
	];
	for (const ep of writeEndpoints) ok(`⑱ 写端点 ${ep} 在场`, bridge.includes(`"${ep}"`));

	// ② **预演/实写**型端点必须有显式放行判断（默认 dry-run）。
	//    另有四个端点是"点了就是执行"（删除 / 任务状态 / 请求入队 / 停子代理）—— 它们没有预演，
	//    这是设计（与 task-state 同类），清单在这里写死以免有人误以为漏了。
	const previewApplyEndpoints = [
		"/api/l1/fix",
		"/api/l1/rollback",
		"/api/l1/embedding",
		"/api/l2/archive",
		"/api/l2/restore",
		"/api/l2/scene-pool/seed",
		"/api/l3/edit",
		"/api/l3/restore",
		"/api/l3/merge",
	];
	/** 取"端点字符串出现处起 N 字符"当处理块 —— 比按 `req.method` 切稳，因为它锚在端点上。 */
	const blockOf = (ep: string, len = 1000): string => {
		const i = bridge.indexOf(`"${ep}"`);
		return i < 0 ? "" : bridge.slice(i, i + len);
	};
	// l2 的两个端点共用 `l2Move`（同样的 body 形状），放行判断在那个函数里，所以单独锚它
	ok("⑱ /api/l2/archive 路由进 l2Move", /"\/api\/l2\/archive"\)\s*\{\s*return l2Move\(req, res, "archive"\)/.test(bridge));
	ok("⑱ /api/l2/restore 路由进 l2Move", /"\/api\/l2\/restore"\)\s*\{\s*return l2Move\(req, res, "restore"\)/.test(bridge));
	ok("⑱ l2Move 内需要显式 apply:true 才落盘", /function l2Move[\s\S]{0,900}?body\.apply === true/.test(bridge));
	for (const ep of previewApplyEndpoints.filter((e) => !e.startsWith("/api/l2/"))) {
		ok(`⑱ ${ep} 需要显式 apply:true 才落盘`, /body\.apply === true/.test(blockOf(ep)), blockOf(ep).slice(0, 80));
	}
	// l1/mode 是唯一"无 apply"的配置写入（可逆、幂等，脚本头注释里写了理由），单独钉住它的闭集校验
	ok("⑱ /api/l1/mode 走闭集校验（code|chat）", /L1_MODES\.has\(body\.mode\)/.test(blockOf("/api/l1/mode", 400)));

	// ③ 破坏性动作的 confirm 副验（四处，缺一不可）
	ok("⑱ 整库还原要 confirm = 备份目录名", /body\.confirm !== backup/.test(bridge));
	ok("⑱ 向量重建要 confirm = REBUILD", /body\.confirm !== "REBUILD"/.test(bridge));
	ok("⑱ 备份还原要 confirm = 备份文件名", /body\.confirm !== file/.test(bridge));
	ok("⑱ 并入 live 画像要 confirm = MERGE", /body\.confirm !== "MERGE"/.test(bridge));

	// ④ 查询串约定：url 必须仍是 split("?")[0]，且页面不得给 /api/* 挂查询串
	ok('⑱ 桥仍以 req.url.split("?")[0] 取路径（约定 A 的前提）', /\(req\.url \|\| ""\)\.split\("\?"\)\[0\]/.test(bridge));
	const queryOnApi = pageSrc.match(/["'`]\/api\/[\w/-]+\?/g) ?? [];
	ok("⑱ 页面没有给 /api/* 挂查询串（否则静默 404）", queryOnApi.length === 0, queryOnApi.join(", "));

	// ⑤ 文本型 CLI 不能走 JSON 解析（rollback / scene-pool 都是 console.log 式输出）
	ok("⑱ 定义了 passthroughText（文本型 CLI 的出口）", /function passthroughText\(/.test(bridge));
	ok("⑱ 整库还原走 passthroughText", /passthroughText\(res, cliArgs, LONG_TIMEOUT_MS\)/.test(blockOf("/api/l1/rollback")));
	ok("⑱ 场景池报告与播种走 passthroughText", (bridge.match(/passthroughText\(/g) ?? []).length >= 4);

	// ⑥ 失败路径必须带回 stdout（CLI 的拒绝理由都在结构化输出里）
	ok("⑱ runCli 失败时也返回 stdout（否则拿不到 CLI 的人话拒绝）", /ok: false,\s*stdout,/.test(bridge));

	// ⑦ 桥的写端点一律经 l1-admin CLI 转发，桥里不出现业务逻辑（不该有 JSONL 解析/sql 之类）
	ok("⑱ 桥不直接读写 L1 分片（写盘一律走 CLI）", !/l1\/records[\s\S]{0,200}?(writeFileSync|appendFileSync)/.test(bridge));
}

// 汇总

console.log("\n=== 查看器部署与静态完整性回归 ===");
if (failures.length > 0) {
	console.log(`\n失败项（${failures.length}）：`);
	for (const f of failures) console.log(`  ✗ ${f}`);
	console.log(`\n结果：PASS ${pass} / FAIL ${failures.length}`);
	process.exit(1);
}
console.log(`\n结果：PASS ${pass} / FAIL 0`);
