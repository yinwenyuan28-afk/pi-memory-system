// 激活 profile 写宿主 settings.json 的回归基线（2026-10-01，STANDALONE_RELEASE_PLAN P1-6）
//
// 这个文件**有别的写者**（宿主 settings-manager：改主题/模型/装包都会重写它），所以
// 「怎么写进去」本身就是需求，不是实现细节。原来的写法是 parse→改对象→stringify→writeFileSync，
// 也就是拿一份旧快照盖掉整个文件。三个后果各有断言钉着：
//
//   A/B/D  定点编辑：只碰目标键，其余字节不动；字符串里的同名文本、嵌套同名键都不能误伤
//   E      幂等：值已经对得上就不写（用 utimes 把 mtime 设成 2001 年，写了就必然暴露）
//   F      无撕裂：子进程死循环读+parse，主进程反复切 profile，读侧必须零次失败
//   G      失败可见 + 回滚：写盘失败必须抛错，且内存态退回旧 profile
//   H      端到端：真实 ProfileManager 在临时 agentDir 上跑通
//   I      真机只读体检：对**真实** ~/.pi/agent/settings.json 在内存里跑一遍 splice，
//          断言除新增项外逐字节不变 —— 只做文本变换，**绝不写盘**
//
// 铁律：只用临时目录（mkdtempSync），除了 I 组只读地碰真实 settings.json。
//
// 用法：node --experimental-strip-types scripts/verify-profile-settings.ts
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "../memory/core/profile.ts";
import { spliceJsonKey } from "../util/json-edit.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

const KEY = "memorySystem.activeProfile";
/** 插入到 HOST_SETTINGS 这类「两空格缩进、成员各占一行」文件末尾时应当出现的整段文本。 */
const INSERTED = ',\n  "memorySystem": { "activeProfile": "work" }';
const roots: string[] = [];

/** 与 index.ts 的 getAgentDir() 同口径（不能 import 扩展入口，会把整个插件拉起来）。 */
function realAgentDir(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return process.env.PI_CODING_AGENT_DIR || `${home}/.pi/agent`;
}

/** 一份仿真的宿主 settings.json（形状照抄真机的：嵌套对象 + 一个说明键 + URL 里带 // 的字符串）。 */
const HOST_SETTINGS = `{
  "enableSkillCommands": true,
  "theme": "dark",
  "defaultProvider": "command",
  "subagents": {
    "defaultModel": "deepseek/deepseek-v4.1-flash"
  },
  "_comment": "说明,http://127.0.0.1:7897",
  "tuiMode": "regular"
}
`;

/** 建一个带 settings.json 的临时 agentDir，返回 { agentDir, settingsPath }。 */
function makeAgentDir(withSettings = true): { agentDir: string; settingsPath: string } {
	const agentDir = mkdtempSync(join(tmpdir(), "profileset-"));
	roots.push(agentDir);
	mkdirSync(join(agentDir, "profiles"), { recursive: true });
	const settingsPath = join(agentDir, "settings.json");
	if (withSettings) writeFileSync(settingsPath, HOST_SETTINGS, "utf-8");
	return { agentDir, settingsPath };
}

function parse(text: string): Record<string, unknown> {
	return JSON.parse(text) as Record<string, unknown>;
}

function nsActive(text: string): unknown {
	return (parse(text).memorySystem as Record<string, unknown> | undefined)?.activeProfile;
}

/**
 * 断言「除目标键所在的那一支外，其余顶层键逐键深比较不变」。
 *
 * `skipTop` 必须排除**承载目标的顶层键**本身 —— 比如 memorySystem 已存在时，
 * 我们改的正是它下面的值，拿它参与比较是比错的（这条断言第一版就栽在这儿）。
 */
function originalsIntact(before: string, after: string, skipTop: string[] = [KEY.split(".")[0]]): boolean {
	const b = parse(before);
	const a = parse(after);
	for (const k of Object.keys(b)) {
		if (skipTop.includes(k)) continue;
		if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) return false;
	}
	return true;
}

/**
 * 返回 after 比 before **多出来的那一整段连续文本**（前后两端分别按字节求公共前缀/后缀）。
 * 拿它跟预期的插入物逐字节比，等价于断言「除了这一段，其余字节完全没动」。
 *
 * 不用 lastIndexOf("}") 之类的取巧写法：插入进去的值本身可能带花括号
 * （"memorySystem": { … }），那样找到的是内层花括号，差值会莫名其妙地算成 3。
 */
function soleInsertion(before: string, after: string): string {
	let p = 0;
	while (p < before.length && p < after.length && before[p] === after[p]) p++;
	let s = 0;
	while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
	return after.slice(p, after.length - s);
}

async function main(): Promise<void> {
	// ── A 定点编辑基础 ───────────────────────────────────────────────
	console.log("\n=== A. 定点编辑：插入 ===");
	{
		const r = spliceJsonKey(HOST_SETTINGS, KEY, '"work"');
		check("A1 结果可 JSON.parse", (() => { try { parse(r.text); return true; } catch { return false; } })());
		check("A2 标记为插入而非替换", r.replaced === false);
		check("A3 值写对", nsActive(r.text) === "work");
		check("A4 原有顶层键逐键深比较不变", originalsIntact(HOST_SETTINGS, r.text));
		check("A5 恰好只多一个顶层键",
			Object.keys(parse(r.text)).length === Object.keys(parse(HOST_SETTINGS)).length + 1);
		check("A6 逗号在末项之后而非甩到下一行",
			r.text.includes('"tuiMode": "regular",\n  "memorySystem"'), JSON.stringify(r.text.slice(-60)));
		check("A7 逐字节只多出这一段", soleInsertion(HOST_SETTINGS, r.text) === INSERTED,
			JSON.stringify(soleInsertion(HOST_SETTINGS, r.text)));
	}

	// ── B 字节级不变 ─────────────────────────────────────────────────
	console.log("\n=== B. 替换已有值：除目标值外逐字节相同 ===");
	{
		const first = spliceJsonKey(HOST_SETTINGS, KEY, '"work"').text;
		const second = spliceJsonKey(first, KEY, '"home"');
		check("B1 标记为替换", second.replaced === true);
		check("B2 值变了", nsActive(second.text) === "home");
		check("B3 长度不变（home/work 等长）", second.text.length === first.length,
			`${first.length} -> ${second.text.length}`);
		// 逐字节：把原文里那一处值换掉，应当恰好等于新文本
		check("B4 逐字节只差那一处值", first.replace('"activeProfile": "work"', '"activeProfile": "home"') === second.text);
		check("B5 memorySystem 对象没被重建", (second.text.match(/"memorySystem"/g) || []).length === 1);
	}

	// ── C 嵌套路径的几种形态 ─────────────────────────────────────────
	console.log("\n=== C. 嵌套路径：只加子键 / 紧凑单行 / 空对象 ===");
	{
		const src = '{\n  "memorySystem": {\n    "other": 1\n  },\n  "z": 2\n}';
		const r = spliceJsonKey(src, KEY, '"work"');
		const o = parse(r.text).memorySystem as Record<string, unknown>;
		check("C1 已有命名空间时只加子键", o.activeProfile === "work" && o.other === 1);
		check("C2 兄弟顶层键保留", parse(r.text).z === 2);
		check("C3 子键缩进与兄弟对齐", r.text.includes('    "other": 1,\n    "activeProfile": "work"'));

		const compact = spliceJsonKey('{"a":1}', KEY, '"work"');
		check("C4 紧凑单行保持紧凑（不硬塞换行）", compact.text === '{"a":1,"memorySystem": { "activeProfile": "work" }}', compact.text);

		const empty = spliceJsonKey("{}", KEY, '"work"');
		check("C5 空对象直接插入不添逗号", nsActive(empty.text) === "work" && !empty.text.includes(",,"));

		const missing = spliceJsonKey(HOST_SETTINGS, "brand.new.nested", "42");
		check("C6 多级缺失时整段作为新对象插入",
			JSON.stringify((parse(missing.text).brand as Record<string, unknown>).new) === '{"nested":42}', missing.text.slice(-70));
	}

	// ── D 抗误伤（手写扫描器而非正则的核心价值）──────────────────────
	console.log("\n=== D. 抗误伤：字符串字面量与嵌套同名键 ===");
	{
		const src = [
			"{",
			'  "note": "这里提到 activeProfile 和 {brace} 与 \\" 转义三种字面量",',
			'  "sub": {',
			'    "activeProfile": "nested"',
			"  },",
			'  "memorySystem": { "activeProfile": "real" }',
			"}",
		].join("\n");
		const r = spliceJsonKey(src, KEY, '"changed"');
		check("D1 只改命名空间里的那个", nsActive(r.text) === "changed");
		check("D2 更深层里的同名键没动", (parse(r.text).sub as Record<string, unknown>).activeProfile === "nested");
		check("D3 字符串里的字面量（含花括号与转义）没动", originalsIntact(src, r.text));
		check("D4 逐字节只差那一处值",
			src.replace('"activeProfile": "real"', '"activeProfile": "changed"') === r.text);
	}
	{
		// 病态输入：重复顶层键。行为定为「只改第一个」（findMember 命中即返回）
		const r = spliceJsonKey('{"memorySystem":{"activeProfile":"x"},"memorySystem":{"activeProfile":"y"}}', KEY, '"z"');
		check("D5 重名时只改第一个", r.text === '{"memorySystem":{"activeProfile":"z"},"memorySystem":{"activeProfile":"y"}}', r.text);
	}

	// ── E 非法输入必须抛错，而不是产出半成品 ─────────────────────────
	console.log("\n=== E. 非法输入 ===");
	{
		let t1 = false;
		try { spliceJsonKey("{ 不是 json", KEY, '"w"'); } catch { t1 = true; }
		check("E1 非法 JSON 抛错（不在损坏文件上叠加编辑）", t1);

		let t2 = false;
		try { spliceJsonKey("[]", KEY, '"w"'); } catch { t2 = true; }
		check("E2 顶层非对象抛错", t2);

		let t3 = false;
		try { spliceJsonKey(HOST_SETTINGS, "", '"w"'); } catch { t3 = true; }
		check("E3 空 keyPath 抛错", t3);

		let t4 = false;
		try { spliceJsonKey('{"a": "未闭合', KEY, '"w"'); } catch { t4 = true; }
		check("E4 结构未闭合抛错", t4);
	}

	// ── F 幂等：值已对得上就不写 ─────────────────────────────────────
	console.log("\n=== F. 幂等：值已相同 ⇒ 不落盘 ===");
	{
		const { agentDir, settingsPath } = makeAgentDir();
		const pm = new ProfileManager(agentDir);
		pm.switchProfile("work"); // 先写一次

		// 把 mtime 钉到 2001 年：只要发生任何一次写，它必然变成「现在」
		const old = new Date("2001-01-01T00:00:00Z");
		utimesSync(settingsPath, old, old);
		const pinned = statSync(settingsPath).mtimeMs;

		pm.switchProfile("work"); // 同名重复切换 ⇒ 应判定为无需写
		check("F1 同值重复切换没有产生写入", statSync(settingsPath).mtimeMs === pinned,
			`mtime ${new Date(pinned).toISOString()} -> ${new Date(statSync(settingsPath).mtimeMs).toISOString()}`);
		check("F2 文件内容仍是 work", nsActive(readFileSync(settingsPath, "utf-8")) === "work");

		pm.switchProfile("other");
		check("F3 换成不同的值会真写", nsActive(readFileSync(settingsPath, "utf-8")) === "other");
	}

	// ── G 原子性 ─────────────────────────────────────────────────────
	console.log("\n=== G. 原子性：靶文件是「换」出来的，不是「原地截断」写出来的 ===");
	{
		// 为什么不用「并发读者有没有读到半截 JSON」来验：
		// 实测（2026-10-01，本机）settings.json 这个体量（~700B）下，**非原子**的
		// writeFileSync 直写，跑满 2.5 秒 / 9 万次读也是 0 次撕裂 —— 那条断言两种写法
		// 都过，等于没验。要把 payload 膨胀到 ~80KB 才抓得到（2 次/1.4 万读），
		// 概率太稀、挂在上面只会变成随机红。
		// 改用确定性的判据：**靶文件的 inode 每次都变** = 每次写都换了一个新文件，
		// 读侧因此不可能看到中间态。下面的 G4 是阳性对照，证明这条判据确实有区分度。
		const { agentDir, settingsPath } = makeAgentDir();
		const pm = new ProfileManager(agentDir);

		let inos = new Set<number>();
		for (const n of ["work", "other", "work", "other", "third"]) {
			pm.switchProfile(n);
			inos.add(statSync(settingsPath).ino);
		}
		check("G1 每次写都换了新文件（inode 变化）", inos.size === 5, `不同 inode 数=${inos.size}/5`);
		check("G2 收尾内容正确", nsActive(readFileSync(settingsPath, "utf-8")) === "third");

		// 阳性对照：同样内容用 writeFileSync 原地覆写，inode 不变 ⇒ G1 不是恒真
		const ctrl = mkdtempSync(join(tmpdir(), "profileset-ctrl-"));
		roots.push(ctrl);
		const cp = join(ctrl, "settings.json");
		writeFileSync(cp, HOST_SETTINGS, "utf-8");
		const c0 = statSync(cp).ino;
		writeFileSync(cp, HOST_SETTINGS.replace("regular", "work"), "utf-8");
		const c1 = statSync(cp).ino;
		check("G3 对照组：原地覆写 inode 不变（G1 判据有区分度）", c0 === c1, `${c0} vs ${c1}`);

		// tmp 文件用完即消失，不在宿主目录里留垃圾
		const leftovers = roots.filter((r) => {
			try {
				return readdirSync(r).some((f) => f.includes(".tmp-"));
			} catch {
				return false;
			}
		});
		check("G4 无 .tmp 残留", leftovers.length === 0, `残留于 ${leftovers.length} 个目录`);
	}

	// ── G2 真实并发压力：读侧持续持文件时，写侧仍须成功 ──────────────
	// 这条验的是另一个东西 —— rename 在别的进程正开着靶文件时会抛 EPERM
	// （本机实测复现过），原子写的 0/50/50ms 重试就是为它准备的。
	console.log("\n=== G2. 并发读侧持文件时写入仍成功（EPERM 重试）===");
	{
		const { agentDir, settingsPath } = makeAgentDir();
		const readerCode = [
			"const fs=require('fs');const p=process.argv[1];",
			"let ok=0,bad=0;const end=Date.now()+2500;",
			"while(Date.now()<end){try{JSON.parse(fs.readFileSync(p,'utf-8'));ok++;}catch(e){bad++;}}",
			"console.log(JSON.stringify({ok,bad}));",
		].join("");
		const reader = spawn(process.execPath, ["-e", readerCode, settingsPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		reader.stdout.on("data", (d) => { out += String(d); });

		const pm = new ProfileManager(agentDir);
		let switches = 0;
		let failed = "";
		try {
			for (let i = 0; i < 30; i++) {
				pm.switchProfile(i % 2 === 0 ? "work" : "other");
				switches++;
			}
		} catch (e) {
			failed = e instanceof Error ? e.message : String(e);
		}
		const code: number = await new Promise((resolve) => reader.on("close", resolve));
		const stat = JSON.parse(out || '{"ok":0,"bad":-1}') as { ok: number; bad: number };

		check("G5 读侧进程正常退出", code === 0);
		check("G6 读侧确实读到了东西（否则这条是空转）", stat.ok > 0, `ok=${stat.ok}`);
		check("G7 并发读侧下 30 次切换全部成功（EPERM 重试生效）", failed === "" && switches === 30,
			failed ? failed.slice(0, 100) : `switches=${switches}`);
		check("G8 读侧零次解析失败", stat.bad === 0, `ok=${stat.ok} bad=${stat.bad}`);
		check("G9 收尾后文件仍是合法 JSON 且值正确", nsActive(readFileSync(settingsPath, "utf-8")) !== undefined);
	}

	// ── H 写盘失败必须抛错 + 回滚内存 ───────────────────────────────
	console.log("\n=== H. 失败可见 + 回滚 ===");
	{
		const { agentDir, settingsPath } = makeAgentDir();
		const pm = new ProfileManager(agentDir);
		pm.switchProfile("work");

		// 让写盘必然失败：把 settings.json 换成一个目录（readFileSync 抛 EISDIR）。
		// Windows 上靠 chmod 制造只读不可靠，用这个更确定。
		rmSync(settingsPath, { force: true });
		mkdirSync(settingsPath, { recursive: true });

		let threw = false;
		let msg = "";
		try {
			pm.switchProfile("other");
		} catch (e) {
			threw = true;
			msg = e instanceof Error ? e.message : String(e);
		}
		check("H1 写盘失败会抛错（不再静默 best-effort）", threw, msg.slice(0, 90));
		check("H2 报错文案点明失败与回滚", msg.includes("切换 profile 失败") && msg.includes("work"), msg.slice(0, 90));
		check("H3 内存态已回滚到旧 profile", pm.getActiveProfileName() === "work", `现值=${pm.getActiveProfileName()}`);
	}

	// ── I 端到端：真实 ProfileManager ────────────────────────────────
	console.log("\n=== I. 端到端：真实 ProfileManager ===");
	{
		const { agentDir, settingsPath } = makeAgentDir();
		const pm = new ProfileManager(agentDir);
		check("I1 初始为 default", pm.getActiveProfileName() === "default");
		pm.switchProfile("work");
		const after = readFileSync(settingsPath, "utf-8");
		check("I2 切完落盘正确", nsActive(after) === "work");
		check("I3 宿主其它键逐键深比较不变", originalsIntact(HOST_SETTINGS, after));
		check("I4 只多一个顶层键",
			Object.keys(parse(after)).length === Object.keys(parse(HOST_SETTINGS)).length + 1);

		// 新实例应从磁盘读回，而不是只靠内存
		const reopened = new ProfileManager(agentDir);
		check("I5 重开实例能读回", reopened.getActiveProfileName() === "work");

		// 旧版写的顶层 activeProfile 仍可读（只读兼容）
		const legacyDir = makeAgentDir();
		writeFileSync(legacyDir.settingsPath, '{\n  "theme": "dark",\n  "activeProfile": "legacy"\n}\n', "utf-8");
		check("I6 兼容旧版顶层 activeProfile", new ProfileManager(legacyDir.agentDir).getActiveProfileName() === "legacy");

		// 没有 settings.json 时应回落 default，且第一次切换要能凭空建出文件
		const bare = makeAgentDir(false);
		const barePm = new ProfileManager(bare.agentDir);
		check("I7 无 settings.json 时回落 default", barePm.getActiveProfileName() === "default");
		barePm.switchProfile("fresh");
		check("I8 无 settings.json 时切换会建出文件", existsSync(bare.settingsPath) && nsActive(readFileSync(bare.settingsPath, "utf-8")) === "fresh");

		// 空文件（宿主把空当 {}）
		const emptyFile = makeAgentDir(false);
		writeFileSync(emptyFile.settingsPath, "", "utf-8");
		const emptyPm = new ProfileManager(emptyFile.agentDir);
		emptyPm.switchProfile("fromempty");
		check("I9 空 settings.json 也能写入", nsActive(readFileSync(emptyFile.settingsPath, "utf-8")) === "fromempty",
			JSON.stringify(readFileSync(emptyFile.settingsPath, "utf-8")));
	}

	// ── J 真机只读体检 ──────────────────────────────────────────────
	// 只在内存里做文本变换，**不调用任何写路径**。目的是证明算法对真实文件同样成立。
	console.log("\n=== J. 真机只读体检（不写盘）===");
	{
		const settingsPath = join(realAgentDir(), "settings.json");
		if (!existsSync(settingsPath)) {
			check("J0 真实 settings.json 存在", false, settingsPath);
		} else {
			const real = readFileSync(settingsPath, "utf-8");
			const r = spliceJsonKey(real, KEY, '"work"');
			check("J0 真实 settings.json 存在", true, `${real.length} 字节`);

			let parses = true;
			try { parse(r.text); } catch { parses = false; }
			check("J1 splice 结果可 JSON.parse", parses);
			check("J2 值写对", nsActive(r.text) === "work");
			check("J3 原有顶层键逐键深比较不变", originalsIntact(real, r.text));
			check("J4 恰好只多一个顶层键",
				Object.keys(parse(r.text)).length === Object.keys(parse(real)).length + 1);

			// 逐字节：整段新增物摘掉后，剩下的应当与原文完全一致
			if ((parse(real).memorySystem as Record<string, unknown> | undefined)?.activeProfile === undefined) {
				const ins = soleInsertion(real, r.text);
				check("J5 只插入了这一段、其余字节完全没动", ins === INSERTED, `插入物=${JSON.stringify(ins)}`);
			} else {
				// 文件里已有该键（走过一次切换）：改为验证「只替换值」后能精确还原
				const orig = (parse(real).memorySystem as Record<string, unknown>).activeProfile as string;
				const back = spliceJsonKey(r.text, KEY, JSON.stringify(orig));
				check("J5 已存在该键时往返可还原", back.text === real, `原值=${orig}`);
			}
		}
	}

	// ── 清理（必须留在 main() 内：void main() 只是启动 promise）────────
	for (const r of roots) {
		try {
			rmSync(r, { recursive: true, force: true });
		} catch {
			// 清理失败不影响结论
		}
	}
	console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
	if (fail > 0) process.exit(1);
}

void main();