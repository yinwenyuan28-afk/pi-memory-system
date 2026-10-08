/**
 * memory/l1/in-place-mark.ts —— L1 records 分片的**扫描**与**就地改写**原语（单一实现）
 *
 * 为什么单独成模块（2026-10-08，任务生命周期计划 T1）：
 * `l1/records/*.jsonl` 上有两类写者都要做同一件事——「定位某个 id 在哪个分片的哪一行，然后
 * 原地改写那一行」：① `l1_commit` 的 `deleted` 就地标记（B2 2026-09-11 引入）；
 * ② `task-state.ts` 的任务状态标记（就地改 `taskState`，方案见
 * plan/pi-memory-system/L1-任务生命周期标记-计划.md）。此前这段逻辑内联在 `commit-tool.ts` 的
 * execute 里，第二处若照抄一份，**"最后一行"的判定口径就会分叉**——而它正是 LWW 存活语义的
 * 唯一判据（口径一分叉，同一条记录会出现"提交说死了、标记说活着"这种无声不一致）。
 *
 * 本模块只管两件事，不含任何业务字段：
 *   1. `scanRecordShards()`：一次扫全部分片，给出「每个 id 的最后一行」与「最后一条活跃行」；
 *   2. `rewriteShardRows()`：按分片重写指定行（原子 tmp+rename），改哪些行、怎么改由回调决定。
 *
 * 调用方**必须**已在 `write-lock.ts` 的跨进程写锁内（整分片 read-modify-write 的互斥前提）。
 * 已知缺口（写在 `write-lock.ts` 头部的同一件事）：`scripts/l1-admin` 的 .mjs 脚本不取这把锁，
 * 故 CLI 与运行时写者之间仍无互斥，批量标记/迁移应在无后台 L1 运行时执行。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { L1_RECORDS_DIR, MEMORY_DB_DIR } from "../paths.ts";

/** 记录在分片里的位置（`file` 是分片文件名，不是全路径）。 */
export interface ShardRow {
	/** 分片文件名，如 `2026-09-11.jsonl` */
	file: string;
	/** 该行在分片中的 0 基行号 */
	lineIdx: number;
	/** 解析后的记录对象（原样引用，调用方自行拷贝后再改） */
	obj: Record<string, unknown>;
}

/** 一次扫描的结果。 */
export interface ShardScan {
	/** 出现过的全部 id（含已作废行）——重投去重用。 */
	allIds: Set<string>;
	/** 非 `deleted` 行的 content 归一化哈希——内容去重用。 */
	aliveContentHashes: Set<string>;
	/** 每个 id 的**最后一行**（LWW 存活判据：最后一行 `deleted===true` 即该 id 不存活）。 */
	lastById: Map<string, ShardRow>;
	/** 每个 id 的**最后一条活跃行**（就地标记的落点；仅当最后一行非 deleted 时才等于 lastById）。 */
	lastAliveById: Map<string, ShardRow>;
}

/** 内容归一化哈希（去重用）：去空白、转小写、sha1。 */
export function contentHash(content: string): string {
	const norm = content.replace(/\s+/g, " ").trim().toLowerCase();
	return createHash("sha1").update(norm, "utf-8").digest("hex");
}

/** records 目录全路径。 */
export function recordsDirOf(profilePath: string): string {
	return join(profilePath, MEMORY_DB_DIR, L1_RECORDS_DIR);
}

/**
 * 扫描 records 目录下的全部分片。
 *
 * **分片按文件名升序读**（`YYYY-MM-DD.jsonl` ⇒ 字典序即时间序），这是 LWW「最后一行」的排序依据：
 * 旧实现用 `readdirSync` 的原始顺序，跨分片同 id 的"最后一行"取决于文件系统枚举顺序，
 * 与提取器契约里写的「按分片日期升序、文件行序取最后一次写入」并不一致。抽原语时一并改正。
 *
 * 坏行 / 坏分片一律跳过（与 `commit-tool` 旧实现同款：宁可漏判也不让一次扫描失败挡住写入）。
 *
 * @param recordsDir records 目录（`recordsDirOf(profilePath)`）
 */
export function scanRecordShards(recordsDir: string): ShardScan {
	const scan: ShardScan = {
		allIds: new Set(),
		aliveContentHashes: new Set(),
		lastById: new Map(),
		lastAliveById: new Map(),
	};
	if (!existsSync(recordsDir)) return scan;
	for (const f of readdirSync(recordsDir).filter((f) => /\.jsonl$/.test(f)).sort()) {
		let text: string;
		try {
			text = readFileSync(join(recordsDir, f), "utf-8");
		} catch {
			continue; // 跳过坏分片
		}
		const fileLines = text.split(/\r?\n/);
		for (let li = 0; li < fileLines.length; li++) {
			const t = fileLines[li].trim();
			if (!t) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(t) as Record<string, unknown>;
			} catch {
				continue; // 跳过坏行
			}
			const id = obj?.id;
			if (typeof id !== "string") continue;
			scan.allIds.add(id);
			if (obj.deleted !== true && typeof obj.content === "string") {
				scan.aliveContentHashes.add(contentHash(obj.content));
			}
			const row: ShardRow = { file: f, lineIdx: li, obj };
			scan.lastById.set(id, row);
			if (obj.deleted !== true) scan.lastAliveById.set(id, row);
		}
	}
	return scan;
}

/**
 * 就地改写指定行：对受影响分片整文件重写（原子 `tmp + rename`）。
 *
 * 调用方**必须**已持跨进程写锁（见模块头）。
 *
 * @param recordsDir records 目录
 * @param markByFile 分片文件名 → 待改写的行号集合
 * @param mutate 逐行回调：返回 `true` 表示该行已改（计入 `changedRows`），`false` 表示保持原样
 *               （幂等分支、解析失败等一律返回 `false`）
 * @returns 实际被改写的行数与写盘的分片数（分片数用于回报口径，与行数不是一回事）
 */
export function rewriteShardRows(
	recordsDir: string,
	markByFile: Map<string, Set<number>>,
	mutate: (obj: Record<string, unknown>, row: { file: string; lineIdx: number }) => boolean,
): { changedRows: number; changedFiles: number } {
	let changedRows = 0;
	let changedFiles = 0;
	for (const [file, lineSet] of markByFile) {
		const fp = join(recordsDir, file);
		if (!existsSync(fp)) continue;
		const fileLines = readFileSync(fp, "utf-8").split(/\r?\n/);
		let changed = 0;
		const out = fileLines.map((l, i) => {
			const t = l.trim();
			if (!t || !lineSet.has(i)) return l;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(t) as Record<string, unknown>;
			} catch {
				return l; // 坏行不动
			}
			if (!mutate(obj, { file, lineIdx: i })) return l;
			changed++;
			return JSON.stringify(obj);
		});
		if (changed > 0) {
			writeFileSync(fp + ".tmp", out.join("\n"), "utf-8");
			renameSync(fp + ".tmp", fp);
			changedRows += changed;
			changedFiles++;
		}
	}
	return { changedRows, changedFiles };
}
