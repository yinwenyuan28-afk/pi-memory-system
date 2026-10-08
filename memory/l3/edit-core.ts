/**
 * L3 条目编辑的**唯一实现**（`l3_edit` 工具与查看器写盘桥的 CLI 共用）。
 *
 * 为什么单独一个模块：这段编排原本内联在 `edit-tool.ts` 的 `execute()` 里，只有模型能触发。
 * 2026-10-08 查看器要补 L3 的"条目增删改"按钮，若在 CLI 里照抄一份，就是第三处口径分叉
 * （预算闸、定位裁决、备份时机、`markRunSeeded` 切口径的时点各漂一次）。所以把编排原样搬到这里，
 * 工具改为薄壳调用 —— 与 `task-state.ts` 之于 `l1_task_state` 是同一个做法。
 *
 * 语义**一字未改**（用户 2026-09-16 / 2026-09-28 两次裁定都落在这段代码里）：
 *   · 一次调用只动一条（`content` 必须单行、不含 `§` —— 由 `normalizeEntryText` 强制）；
 *   · 落盘目标是 `USER-temp.md`（提议稿），live `USER.md` 永不被本模块改写；
 *   · 预算按"并入 live 之后的整篇"计价，且对"工作副本本来就超限"的情形只放行能降用量的改动。
 */

import { USER_CHAR_LIMIT } from "./config.ts";
import {
	entryBudget,
	locateEntry,
	normalizeEntryText,
	serializeUserFile,
	usageText,
	type EntryOpResult,
} from "./entries.ts";
import {
	ensureRunBackup,
	l3RunEntries,
	markRunSeeded,
	readL3Proposal,
	readL3TargetFile,
	USER_TEMP_FILE,
	writeUserTempFile,
} from "./user-file.ts";
import { isStopRequested, stopRequestedMessage } from "../pipeline/stop-request.ts";
import { acquireRunLock, runLockBusyMessage } from "../pipeline/run-lock.ts";

/** 一次编辑请求。`content`/`target` 按 action 取值，与 `l3_edit` 工具的参数一一对应。 */
export interface L3EditParams {
	action: "add" | "update" | "delete";
	/** add/update 必填：一条规则正文（单行）。 */
	content?: unknown;
	/** update/delete 必填：能唯一定位现有条目的文字片段。 */
	target?: unknown;
}

export interface L3EditOptions {
	/** 只校验与预演，**不落盘**（CLI 的 `--dry-run`）。预演不写备份、不切本轮口径。 */
	dryRun?: boolean;
	/** 调用方已持有 L3 run-lock（避免自己再取一次；仅内部/测试用）。 */
	lockHeld?: boolean;
	/** 落盘成功后的回调（扩展内用于刷新注入快照；CLI 不传）。 */
	onChanged?: () => void;
}

/** 编辑结果：成功时带用量与位置，失败时带原因（定位失败还带候选清单）。 */
export interface L3EditResult extends EntryOpResult {
	/** 本次动作（回显，便于调用方展示）。 */
	action?: string;
	/** 是否是干跑（未落盘）。 */
	dryRun?: boolean;
	/** 落盘目标文件名 —— 恒为 `USER-temp.md`，界面据此说明"改的是提议稿，不是 live"。 */
	targetFile?: string;
}

/** 把任意输入归一成字符串或 undefined（工具参数来自模型，CLI 参数来自 argv，两者都不可信）。 */
function asText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return undefined;
	return String(value);
}

/**
 * 执行一次 L3 条目编辑。
 *
 * 边界与副作用：
 *   · 取 **L3 run-lock**（拿不到直接拒，一条都不写）—— 与 `l3_commit` 同一把；
 *   · 写盘前若本进程还没备份过，把**将被覆盖的那份**留档到 `backups/user-backups/`；
 *   · 成功写盘后 `markRunSeeded()`：本轮工作副本从"live+temp 并集"切口径到"temp 原文"，
 *     否则同一轮里删掉的条目会因仍在 live 中而复活（死循环，见 user-file.ts 头注释）。
 */
export function applyL3Edit(profilePath: string, params: L3EditParams, opts: L3EditOptions = {}): L3EditResult {
	const reply = (r: L3EditResult): L3EditResult => r;

	try {
		if (!profilePath) return reply({ success: false, error: "No active profile" });
		// 停止请求（2026-09-26）：硬上限停掉 L3 子代理时入口拒写（提议稿会被并入受保护的 live 画像）
		if (isStopRequested(profilePath, "l3")) return reply({ success: false, error: stopRequestedMessage("l3") });

		// 干跑也要过锁：否则"预演说没问题"可能在真写时因锁被别人持着而失败，误导使用者。
		const runLock = opts.lockHeld ? undefined : acquireRunLock(profilePath, "l3");
		if (runLock && !runLock.acquired) return reply({ success: false, error: runLockBusyMessage("l3", runLock.owner) });

		const action = params?.action;
		if (action !== "add" && action !== "update" && action !== "delete") {
			return reply({ success: false, error: `action 必须是 add / update / delete，收到 ${JSON.stringify(action)}。` });
		}

		const content = asText(params.content);
		const target = asText(params.target);
		// 显式的前置校验：以前直接把 undefined 交给 normalizeEntryText/locateEntry，会在里面抛异常，
		// 报出来的是"某个内部调用炸了"而不是"你少给了参数"。
		if (action !== "delete" && content === undefined) {
			return reply({ success: false, error: `action=${action} 需要 content（一条单行规则，不含 §）。` });
		}
		if (action !== "add" && target === undefined) {
			return reply({ success: false, error: `action=${action} 需要 target（能唯一定位现有条目的文字片段）。` });
		}

		const rawTarget = readL3TargetFile(profilePath);
		const proposal = readL3Proposal(profilePath);
		// 本轮工作副本：第一次写盘时以 live + temp 独有条目播种（见 user-file.ts 头注释第 2 条）
		const entries = [...l3RunEntries(profilePath)];
		const before = entryBudget(entries);

		let next: string[];
		let position: number;

		if (action === "add") {
			const norm = normalizeEntryText(content as string);
			if (!norm.ok) return reply({ success: false, error: norm.error, usage: usageText(before, USER_CHAR_LIMIT), entryCount: entries.length });
			next = [...entries, norm.text];
			position = next.length - 1;
		} else {
			const located = locateEntry(entries, target);
			if (!located.ok) {
				return reply({
					success: false,
					error: located.error,
					usage: usageText(before, USER_CHAR_LIMIT),
					entryCount: entries.length,
					candidates: located.candidates,
				});
			}
			position = located.index;
			if (action === "delete") {
				next = entries.filter((_, i) => i !== position);
			} else {
				const norm = normalizeEntryText(content as string);
				if (!norm.ok) return reply({ success: false, error: norm.error, usage: usageText(before, USER_CHAR_LIMIT), entryCount: entries.length });
				next = [...entries];
				next[position] = norm.text;
			}
		}

		// 限额按**整篇**复核：单次 op 合法但总量超预算时，拒绝并要求先腾空间。
		// 口径按"并入 live 之后的整篇"算（工作副本 = live + 本轮改动），所以它直接等于
		// 用户把 temp 并进 USER.md 后的用量：不会出现"提议通过、合并超限"。
		//
		// 两种被拒形态（第二种是要命的死锁，别把它合回"一律 budget > LIMIT 就拒"）：
		//   ① 常规：改动把用量推过上限 → 拒，让调用方先腾空间；
		//   ② 工作副本本来就超限（live 已近满 + temp 里还有用户未并入的条目）→ **只放行真能
		//      降低用量的改动**。若这里也一律拒，删除 op 的"改动后用量"仍在上限之上 ⇒ 恒拒
		//      ⇒ 连腾空间的第一步都做不了。
		const budget = entryBudget(next);
		if (budget > USER_CHAR_LIMIT && budget >= before) {
			const over = before > USER_CHAR_LIMIT;
			return reply({
				success: false,
				error:
					`本次改动会让画像达到 ${budget} 字符，超过上限 ${USER_CHAR_LIMIT}（改动前 ${before}）。` +
					`未做任何改动。` +
					(over
						? `当前工作副本本身就超限（live 画像 + ${USER_TEMP_FILE} 里尚未并入的条目），只有能**降低**用量的改动才放行。`
						: `写入稿是 ${USER_TEMP_FILE}，但它按"并入 USER.md 后的整篇"计价。`) +
					`请先删除或压缩其他条目腾出空间，再重试本次 ${action}。`,
				usage: usageText(before, USER_CHAR_LIMIT),
				entryCount: entries.length,
			});
		}

		if (opts.dryRun) {
			return reply({
				success: true,
				action,
				dryRun: true,
				targetFile: USER_TEMP_FILE,
				position,
				usage: usageText(budget, USER_CHAR_LIMIT),
				entryCount: next.length,
			});
		}

		ensureRunBackup(profilePath, rawTarget);
		writeUserTempFile(profilePath, serializeUserFile(next, proposal.eol, proposal.trailingNewline));
		// 写盘成功 ⇒ 本轮工作副本切口径到"temp 原文"（之后的删改立刻生效，见 user-file.ts）
		markRunSeeded();
		try {
			opts.onChanged?.();
		} catch {
			// non-fatal
		}

		return reply({
			success: true,
			action,
			targetFile: USER_TEMP_FILE,
			position,
			usage: usageText(budget, USER_CHAR_LIMIT),
			entryCount: next.length,
		});
	} catch (err) {
		return reply({ success: false, error: err instanceof Error ? err.message : String(err) });
	}
}
