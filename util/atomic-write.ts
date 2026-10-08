/**
 * util/atomic-write.ts —— 「原子写文件」的**单一实现**（tmp → rename）
 *
 * 为什么要有这个模块（2026-10-08，查看器跟版重写计划 T1）：
 * 这段逻辑原先只在 `memory/core/profile.ts` 里以私有方法存在，而查看器部署（`memory/viewers/deploy.ts`）
 * 要做同一件事——把一个已经存在的文件整体换掉，且不能被读者读到半截。照抄一份 = 又一次「同一概念
 * 多份实现」（`util/agent-dir.ts` 头部记过同样的教训）：
 *
 *   1. `memory/core/profile.ts`：原子写 settings.json。**只替换一个键的字符区间**（`spliceJsonKey`），
 *      因为整文件 parse→stringify 往返会抹掉并发写者的改动。
 *   2. `memory/viewers/deploy.ts`：整体覆盖 HTML/CSS/JS（内容由本仓库决定，无并发写者），
 *      直接整文件原子写即可。
 *   —— 两者只共用「怎么把新内容换进去」这一步，正是本模块的边界。
 *
 * ── 为什么必须是 tmp → rename（而不是 rm → rename）──
 *
 * `writeFileSync` 是「截断 → 重写」：并发读者可能读到半截 JSON，宿主读失败会记
 * `globalSettingsLoadError` 并让整个会话的配置写入静默失效（一次写坏代价极大）。
 * 而「先 `rmSync` 再 `renameSync`」比不原子**更糟**：两者之间留了一个「文件不存在」的空窗。
 * 仓库里 `config/app-config.ts` 与 `util/judg-session-project` 都是那种写法，属于**已知反例**
 * （见 `plan/pi-memory-system/notes/known-issues.md`），不要在新增代码里扩散。
 * Node 的 `fs.renameSync` 在 Windows 上走 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，
 * 本机实测可直接覆盖已存在文件，`rmSync` 纯属多余（实测见 `scripts/verify-profile-settings.ts`）。
 *
 * ── Windows 的 EBUSY/EPERM ──
 *
 * 目标文件被别的进程打开时 rename 会失败，属已知现象，故重试 3 次 / 0·50·50ms。
 * 同步接口只能忙等（这里不能 await）——调用点都在同步路径上。
 */
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

/** 重试间隔（毫秒）。第一次立即试，之后两次退避。 */
const RETRY_DELAYS_MS = [0, 50, 50];

/**
 * 原子写文本文件（tmp → rename）。
 *
 * @param file 目标文件绝对路径（父目录必须已存在——本函数只保证"内容整体换入"的原子性，不建目录）
 * @param text 新内容（UTF-8）
 * @throws 三次重试均失败时抛出最后一次错误；失败前会清理残留的 tmp 文件
 */
export function atomicWriteFile(file: string, text: string): void {
	atomicWriteInternal(file, (tmp) => writeFileSync(tmp, text, "utf-8"));
}

/**
 * 原子写二进制内容（tmp → rename）。
 *
 * 单独一个函数而不是让调用方自己拼 Buffer：`writeFileSync` 对 string 默认 utf-8、
 * 对 Buffer 原样写，两者语义不同，混用会静默改变字节。
 *
 * @param file 目标文件绝对路径
 * @param data 新内容
 */
export function atomicWriteBytes(file: string, data: Uint8Array): void {
	atomicWriteInternal(file, (tmp) => writeFileSync(tmp, data));
}

/**
 * 原子替换的公共骨架：写出 tmp → rename 覆盖 → 失败重试 → 清理残留。
 *
 * @param file 目标文件
 * @param writeTmp 把新内容写进给定 tmp 路径（由调用方决定文本还是字节）
 */
function atomicWriteInternal(file: string, writeTmp: (tmp: string) => void): void {
	const tmp = `${file}.tmp-${randomUUID()}`;
	let lastErr: unknown = null;
	for (const delay of RETRY_DELAYS_MS) {
		if (delay > 0) {
			// 同步接口只能忙等（这里不能 await）
			const until = Date.now() + delay;
			while (Date.now() < until) {
				/* spin */
			}
		}
		try {
			writeTmp(tmp);
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
