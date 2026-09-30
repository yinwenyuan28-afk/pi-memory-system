/**
 * `l1_project_get` 工具 —— L1 提取子代理读「本会话属于哪个项目」
 *
 * ── 为什么需要它 ──
 *
 * 记忆的 `metadata.scope`（`self` / `subtree`）由 **L1 提取子代理逐条判断**，不猜。
 * 而"这条记忆换个项目还成立吗"这个问题，只有在**知道自己属于哪个项目**时才有答案 ——
 * 所以那个只读工具从"可选"变成"必需"。
 *
 * ── 为什么入参必填、而不是从 ctx 派生 ──
 *
 * 子代理进程里 `ctx.sessionManager.getSessionFile()` 恒为 `"session"`（不是真实 key），
 * 从 ctx 派生会永远查不到条目。所以 `sessionKey` 由子代理从**记录/消息自带的字段**传入。
 *
 * ── 为什么是顶层注册（主代理也看得见）却仍标注"仅供子代理" ──
 *
 * pi 的工具注册没有 per-agent 白名单（`agents/l1-extractor.md` 的 `tools:` 行是**软约束**，
 * 漏写只是调不到、不报错）。所以描述里写明用途，并让入参必填 —— 主代理拿不到子会话的
 * sessionKey，自然也调不出东西。⚠ **`agents/l1-extractor.md:4` 的 `tools:` 行必须同步加上本工具**，
 * 漏了整条 scope 设计静默落空。
 *
 * **只读**：不写盘、不记日志、不影响任何统计。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderPrompt } from "../../prompts/registry.ts";
import { readSessionJudg } from "./index.ts";

/** 返回体（在 prompt 契约里对用户可见的字段名要与此处一致）。 */
interface ProjectGetResult {
	/** 判定出的项目目录（正斜杠）。`flag:false` 时**保留原值但不可用**。 */
	project: string;
	/** 能不能用。`false` ⇒ 服务端会把 `cwd` 退回会话工作台。 */
	flag: boolean;
	/** 证据集中度（0–1），**不是**模型置信度。 */
	confidence: number;
	decidedBy: string;
	/** 补充说明（无可用 profile / 条目不存在 / sessionKey 为空）。 */
	note?: string;
}

export function registerL1ProjectGetTool(
	pi: ExtensionAPI,
	getProfilePath: () => string | undefined,
): void {
	pi.registerTool({
		name: "l1_project_get",
		label: "Get Session Project",
		description: renderPrompt("tools#l1_project_get"),
		// ⚠ 每个属性都必须显式声明 type（golden 契约会逐字段比对）
		parameters: {
			type: "object",
			properties: {
				sessionKey: {
					type: "string",
					description: "The sessionKey carried on the L0 messages / L1 task message. Do NOT derive it from the session context — in a subagent process that always reads back as \"session\".",
				},
			},
			required: ["sessionKey"],
		},
		async execute(_toolCallId, params) {
			const sessionKey = typeof (params as { sessionKey?: unknown } | undefined)?.sessionKey === "string"
				? String((params as { sessionKey: string }).sessionKey).trim()
				: "";
			const out = (r: ProjectGetResult) => ({
				content: [{ type: "text" as const, text: JSON.stringify(r) }],
				details: {},
			});
			if (!sessionKey) {
				return out({ project: "", flag: false, confidence: 0, decidedBy: "none", note: "sessionKey 为空：无法查询。" });
			}
			const profilePath = getProfilePath();
			if (!profilePath) {
				return out({ project: "", flag: false, confidence: 0, decidedBy: "none", note: "No active profile" });
			}
			const e = readSessionJudg(profilePath, sessionKey);
			if (!e) {
				return out({
					project: "",
					flag: false,
					confidence: 0,
					decidedBy: "none",
					note: "这个会话还没有项目归属记录（或判定尚未完成）。照常提取即可：服务端会把 cwd 退回会话工作台，不影响你填写 metadata.scope —— 那时按\"这个项目\"泛指。",
				});
			}
			return out({
				project: e.project,
				flag: e.flag,
				confidence: e.confidence,
				decidedBy: e.decidedBy,
				...(e.flag ? {} : { note: "flag=false：这条 project 是占位值（尚未判定 / 判定为无项目），**不要**拿它当 scope 判据。" }),
			});
		},
	});
}
