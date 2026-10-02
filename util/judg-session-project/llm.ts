/**
 * 会话项目归属的 LLM 判定（一次调用）
 *
 * ── 为什么是"代码提候选 + LLM 判断"，而不是纯代码 ──
 *
 * 分层标注集（20 条，`scripts/fixtures/judg-session-project/ruler.json`）实测：
 *
 * | 方案 | 精确率 | 覆盖率 |
 * |---|---|---|
 * | A 纯代码 top1（不弃权） | 54%（7/13） | 50% |
 * | B 纯代码三规则（弃权） | 70%（7/10） | 50% |
 * | C 代码 + 决策模型 Jev | 54% | 50% | ← 与 A **逐行完全相同**，零增量，已移出
 * | **D 代码 + 普通 LLM** | **92%（11/12）** | **79%（11/14）** |
 *
 * D 唯一的能力差异：**能读用户消息里的自由文本**，因此答得出"零工具调用、只有用户首问
 * 点名了项目"那一类会话（尺子里的 #20）。纯代码和决策模型在原理上都答不了它 ——
 * 选项都来自文件证据。
 *
 * 代价：比纯代码慢、token 多（实测约 650 input/次）。换来 8~40 个百分点的正确率，值的。
 *
 * ── 边界 ──
 *
 * 本模块**只管这一次 HTTP**：不做重试策略、不做单飞、不写盘、不碰 pi API。
 * 单飞与重试在 `index.ts` 的挂点里；落盘在 `index.ts`（读写层）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "../agent-dir.ts";
import { callLLM } from "../llm.ts";
import { readConfig } from "../../config/model-config.ts";
import { parseJsonc } from "../jsonc.ts";
import { isNotAProjectPath } from "./index.ts";
import type { ExtractResult } from "./candidates.ts";

// ══════════════════════════════════════════════════════════════
//  常量
// ══════════════════════════════════════════════════════════════

/**
 * 判定的输出 token 上限。**不得调小。**
 *
 * 配置模型是**推理模型**，token 先花在 `reasoning_content` 上。
 * 2026-09-30 实测（本机 `deepseek/deepseek-v4.1-flash`，同一份载荷）：
 *
 * | maxTokens | stopReason | output tokens | 文本 |
 * |---|---|---|---|
 * | 120 | `length` | 120 | 截断在 `"reason":"工具调用集中在xianhua` |
 * | 2000 | `stop` | 85 | 完整 JSON |
 * | 不传 | `stop` | 114 | 完整 JSON |
 *
 * 实际需求只有约 200，2000 是留余量。**这条失败态不报错、只是静默截断**，
 * 所以 `parseJudgeJson` 带了截断兜底，而「拿不到 project」必须当**失败**而不是当 `unknown`（B1）。
 */
export const JUDGE_MAX_TOKENS = 2000;

/** 判定超时（毫秒）。 */
export const JUDGE_TIMEOUT_MS = 60_000;

/** 判「无项目」的哨兵值。与路径字面量区分开。 */
export const UNKNOWN = "unknown";

// ══════════════════════════════════════════════════════════════
//  判据（内联，不单独建 md 文件）
// ══════════════════════════════════════════════════════════════

/**
 * 判定提示词。**判据优先级是实测调出来的，照抄顺序，别自己重排。**
 *
 * 四条来自实测的硬结论：
 *  ① 「被顺带提到的路径」不是证据 —— 喂整段对话会让准确率从 87% 掉到 73%，
 *     4 次变化**全部是「本来对 → 变错」**，没有一次反向。机制：模型把正文里出现的
 *     任何路径都当证据，而用户只是在提问时顺带提了别的仓库。
 *  ② **给前 3 条用户消息，不是最后 3 条** —— last3 精确率 83% vs first3 92%：
 *     会话后期容易聊到别的项目，末尾提到的路径是干扰而非证据。
 *  ③ 完全不给对话文本只剩 36% 覆盖率 —— 对话是主力信号，不是补充。
 *  ④ **粒度**：同一个项目会以多个粒度同时出现在候选里（尺子 #12：`C:\Users\leaf\.pi` 与
 *     `C:\Users\leaf\.pi\agent\agents` 同时在池里，选后者就错）。但**不能**简单说"选最外层"：
 *     实测那样会把 #5 / #7 一起推到 `C:\dev\code_java\wangxin`（真值是两个不同的子项目），
 *     而那里同时有 `backend/A104527`、`frontend/A104525`… ⇒ 判据要落在中间。
 */
export const JUDGE_SYSTEM_PROMPT = [
	"你判断一段编码会话**实际在哪个项目目录上干活**。只回答 JSON，不要任何解释性前后缀。",
	"",
	"## 输入",
	"- candidates：工具调用真正动过的路径，按证据强度（命中的不同文件数）降序。",
	"  同一个项目会以多个粒度同时出现（项目根、它的某个子目录），**都要考虑**。",
	"- pathsNamedByUser：用户消息里点名过的路径及提及次数。",
	"- userMessages：**最前面**几条用户消息原文（不是最后几条）。",
	"",
	"## 判据（按顺序，先命中先答）",
	"1. 这一轮根本没有工作对象（探针 / 打招呼 / 一次性问答，如「你好」「只回复：OK」）→ unknown",
	"2. 用户消息里明确点名的项目是最强证据",
	"3. 其次看工具真正动过的文件（candidates）",
	"4. 只是被顺带提到的路径**不算**证据 —— 用户提问时提一句别的仓库，不等于在那个仓库上干活",
	"5. **粒度**：同一个项目的多个候选（互为祖先/后代）都在池里时，选**最具体又覆盖得住主要证据**",
	"   那一层 —— 既不是只含一两个文件的深层子目录，也不是把好几个项目合在一起的仓库根。",
	"   判据：若某一层的候选里同时出现了它的**兄弟目录**（别的子项目/子包），说明这层太大，往下选一层。",
	"6. 用户点名的是**另一个项目的计划/文档**、而工具证据集中在别处 → 以工具证据为准",
	"   （用户常用「参考 X 的方案来做 Y」这种句式，点名的那个不是干活的那个）。",
	"7. 多个项目都有证据、且看不出主线 → unknown（宁可弃权，不要猜）",
	"",
	"## 输出",
	'严格 JSON：{"project":"<路径字面量 或 unknown>","reason":"<15 字内>"}',
	"",
	"## 硬性要求",
	"- project 必须是**路径字面量**（照抄 candidates / pathsNamedByUser 里的形态，含盘符），",
	"  这样才能直接归一化后落盘。不要给项目名、不要给简写、不要给相对路径。",
	"- 只在 candidates / pathsNamedByUser 里没有合适答案、但 userMessages 明确点名了项目时，",
	"  才允许给一个不在这些列表里的路径。",
	"- 不确定就给 unknown。判错会让记忆挂到错误项目上，代价远大于漏判。",
].join("\n");

/** 组装送进模型的证据载荷（就是提示词里承诺的那三项）。 */
export function buildJudgePayload(x: ExtractResult): string {
	return JSON.stringify(
		{
			candidates: x.candidates.map((c) => ({ path: c.path, distinctFiles: c.files })),
			pathsNamedByUser: x.pathsNamedByUser.slice(0, 5),
			userMessages: x.userMessages,
		},
		null,
		1,
	);
}

// ══════════════════════════════════════════════════════════════
//  判定
// ══════════════════════════════════════════════════════════════

export interface JudgeResult {
	/** 判定是否成功。失败时调用方必须保留原值、不写盘。 */
	ok: boolean;
	/** 选中的项目路径（`ok && project !== "unknown"` 时有值）。已去引号与首尾空白。 */
	project: string | null;
	/** 模型给的理由（≤15 字，审计用）。 */
	reason: string | null;
	/** 失败原因（`ok === false`）。 */
	error: string | null;
}

/**
 * 从可能带 markdown 围栏 / 前后缀 / **被截断**的模型输出里抠出 JSON 对象。
 *
 * 截断兜底是必需的（2026-09-30 实测）：`maxTokens` 给小时网关返回
 * `stopReason:"length"`，输出停在 `{"project":"C:/dev/code/xianhua","reason":"工具改动集中` ——
 * 花括号不配平，严格 `JSON.parse` 直接失败。但 `project` 字段总是**先写完**
 * （模型按提示词的字段顺序输出），所以正则捞它比丢弃整条结果划算得多。
 *
 * ⚠ 计划原文把这条失败态记成「`content` 为空串」。实测不是：空串是另一个 bug
 *   （模型对象缺 `cost` 字段导致 pi-ai 结算时抛 `cost.tiers`，见 `resolveJudgeModel`）。
 *   小 `maxTokens` 的真实表现是**截断**。
 */
export function parseJudgeJson(text: string): { project?: unknown; reason?: unknown } | null {
	let s = text.trim();
	// ```json … ``` 围栏
	const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
	if (fence) s = fence[1].trim();
	// 直接是对象就用，否则截取第一对花括号
	if (!s.startsWith("{")) {
		const a = s.indexOf("{");
		const b = s.lastIndexOf("}");
		if (a >= 0 && b > a) s = s.slice(a, b + 1);
	}
	try {
		const o = JSON.parse(s);
		if (o && typeof o === "object" && !Array.isArray(o)) return o as { project?: unknown; reason?: unknown };
	} catch {
		// 落到下面的截断兜底
	}
	// 截断兜底：只要 project（外层引号闭合即可，路径里不会出现未转义引号）
	const salvaged = /"project"\s*:\s*"([^"]*)"/.exec(s);
	if (salvaged) {
		const reason = /"reason"\s*:\s*"([^"]*)"/.exec(s);
		return { project: salvaged[1], reason: reason ? reason[1] : undefined };
	}
	return null;
}

/**
 * 发起一次判定。
 *
 * @param model  已解析的模型对象（见 {@link resolveJudgeModel} / 生产路径的 `resolveConfiguredModel`）
 * @param x       候选提取结果
 * @param opts    覆盖超时的测试钩子
 * @returns 判定结果。**任何失败都返回 `ok:false` 而不是抛异常** —— 调用方据此保留原值。
 */
export async function judgeProject(
	model: unknown,
	x: ExtractResult,
	opts?: { timeoutMs?: number; maxTokens?: number; apiKey?: string },
): Promise<JudgeResult> {
	// 候选为空**且用户也没点名任何路径** → 直接判「无」，**不发请求**（尺子里 5 条「无」全靠这条判对）
	//
	// ⚠ 条件里必须有 `pathsNamedByUser` 这一半。计划原文的 B3 写成「候选为空就不发请求」，
	// 而 B5 又说「实测 #20 就是『候选为空但用户点名了项目』，LLM 从消息里读出来，正确」——
	// 两条自相矛盾。合起来的意思是：**只有代码手里什么都没有时**才不发请求。
	// 尺子 #20（零工具调用、首问点名 A104489）就是靠后半句才答对的。
	if (x.candidates.length === 0 && x.pathsNamedByUser.length === 0) {
		return { ok: true, project: null, reason: "无文件证据", error: null };
	}
	if (!model) {
		return { ok: false, project: null, reason: null, error: "无可用模型" };
	}
	const raw = await callLLM(model, JUDGE_SYSTEM_PROMPT, buildJudgePayload(x), {
		timeoutMs: opts?.timeoutMs ?? JUDGE_TIMEOUT_MS,
		maxTokens: opts?.maxTokens ?? JUDGE_MAX_TOKENS,
		...(opts?.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
	});
	// ⚠ content 空串是配置模型的常见失败态（推理模型把 token 花在 reasoning_content 上、
	// 撞上 max_tokens 上限）。**当失败处理，不当 unknown**（见 B1）。
	if (raw === null) return { ok: false, project: null, reason: null, error: "调用失败/超时" };
	if (!raw.trim()) return { ok: false, project: null, reason: null, error: "content 为空串（maxTokens 太小？）" };

	const parsed = parseJudgeJson(raw);
	if (!parsed) return { ok: false, project: null, reason: null, error: "输出不是 JSON" };
	if (typeof parsed.project !== "string" || !parsed.project.trim()) {
		return { ok: false, project: null, reason: null, error: "JSON 里没有 project" };
	}
	const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 40) : null;
	const p = parsed.project.trim().replace(/^["']|["']$/g, "").trim();
	if (!p || p.toLowerCase() === UNKNOWN) return { ok: true, project: null, reason: reason ?? "无主线", error: null };
	// 家目录 / 桌面 / 文档 / AppData 之类**不可能是项目**（用户裁定 2026-09-30）。
	// 判成 unknown 而不是拒收：拒收会把这次判定打成"失败"、触发重试，而模型选它
	// 恰恰说明证据不足 —— 按"弃权"处理更贴合语义，也让报告里的"有项目却被判成无"能反映出来。
	if (isNotAProjectPath(p)) {
		return { ok: true, project: null, reason: `选中的是家目录/内容目录（不可作项目）：${p.slice(0, 60)}`, error: null };
	}
	return { ok: true, project: p, reason, error: null };
}

// ══════════════════════════════════════════════════════════════
//  独立脚本用的模型解析
// ══════════════════════════════════════════════════════════════

/** 脚本可用的模型对象（比 pi 的 `Model` 多了 `apiKey`，因为脚本没有环境变量兜底）。 */
export interface JudgeModel {
	provider: string;
	modelId: string;
	apiKey: string;
	model: Record<string, unknown>;
}

/**
 * **独立脚本**用的模型解析：从统一配置读 provider/modelId，再从
 * `{agentHome}/models.json` + `auth.json` 组装出 `completeSimple` 能用的模型对象。
 *
 * 为什么需要它：生产路径（`index.ts` 挂点）有 `ctx.modelRegistry`，一条
 * `resolveConfiguredModel(profilePath, ctx.model, ctx.modelRegistry)` 就够；
 * 而评测脚本是裸 node 进程，没有 registry 也读不到环境变量里的 key。
 *
 * ⚠ **不硬编码端点与 key**：provider/modelId 来自
 * `{profile}/memoryDB/config/application-propertis.json` 的 `model.llm`，
 * baseUrl/compat 来自 `models.json` 的同名 provider，key 来自 `auth.json` 的同名条目。
 * 把 `model.llm.provider` 改成别的（`opencode-go` / `wangxin`），三样会一并跟着变。
 *
 * @param profilePath profile 根目录
 * @param agentHome   agent 根目录（默认取 `PI_AGENT_HOME` 或 `~/.pi/agent`）
 * @returns 解析结果；配置或文件缺失时返回 null
 */
export function resolveJudgeModel(profilePath: string, agentHome?: string): JudgeModel | null {
	// 2026-10-01（P1-8）：原先是 `join(process.env.USERPROFILE ?? "", ".pi", "agent")`。
	// `USERPROFILE` 在服务化启动 / 部分 CI 里根本没设，那时得到的是**相对路径** `.pi/agent`，
	// 跟着进程 cwd 跑偏 —— 评测脚本会读到另一个 agent 根的 models.json，静默拿错模型或返回 null。
	// 现统一走 `resolveAgentDir()`，与 index.ts / l1/config.ts 同一份实现。
	// 本函数额外认 `PI_AGENT_HOME`（脚本专用覆盖），优先级在环境变量之上、显式入参之下。
	const home = agentHome ?? process.env.PI_AGENT_HOME ?? resolveAgentDir();
	const cfg = readConfig(profilePath);
	if (!cfg) return null;
	const modelsFile = join(home, "models.json");
	const authFile = join(home, "auth.json");
	if (!existsSync(modelsFile) || !existsSync(authFile)) return null;

	const models = parseJsonc(readFileSync(modelsFile, "utf-8")) as { providers?: Record<string, Record<string, unknown>> };
	const provider = models?.providers?.[cfg.provider];
	if (!provider) return null;
	const entry = (provider.models as { id: string; [k: string]: unknown }[] | undefined)?.find((m) => m.id === cfg.modelId);
	if (!entry) return null;

	// key 只从文件读，**绝不回显**（进了会话记录就会被 L0 归档持久化）
	const auth = JSON.parse(readFileSync(authFile, "utf-8")) as Record<string, { key?: string } | undefined>;
	const apiKey = auth[cfg.provider]?.key;
	if (!apiKey) return null;

	return {
		provider: cfg.provider,
		modelId: cfg.modelId,
		apiKey,
		model: {
			...entry,
			provider: cfg.provider,
			baseUrl: provider.baseUrl,
			api: provider.api,
			compat: provider.compat,
			apiKey,
			// ⚠ `cost` 在 models.json 的 model 条目里**不存在**，而 pi-ai 结算成本时直接读
			//   `model.cost.tiers` —— 缺它会在流**已经收完**之后抛
			//   `Cannot read properties of undefined (reading 'tiers')`，
			//   表现为 stopReason:"error" + 文本在最后一个字符处被砍掉（reason 字段写一半）。
			//   这个坑极难认：usage 全 0、HTTP 200、看起来像模型自己停的。
			//   这里补一份零费率（脚本自测不计费；真实计费走前台会话的 registry，那条路有 cost）。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] },
			contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : 128_000,
			maxTokens: typeof entry.maxTokens === "number" ? entry.maxTokens : 8192,
			input: Array.isArray(entry.input) ? entry.input : ["text"],
			reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : true,
			name: typeof entry.name === "string" ? entry.name : String(entry.id),
		},
	};
}
