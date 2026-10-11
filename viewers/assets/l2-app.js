/*
 * viewers/assets/l2-app.js —— L2 场景层（块 / 成员 / 归档账本 / 对账）· Vue 3 版
 *
 * 依赖：viewer-core.js（window.V）、viewer-vue.js（V.vue）。本页只用 V（不涉及质量分，故不加载 quality-core）。
 *
 * ── 这一页最要紧的一件事：分清"权威"与"派生" ──
 *
 * `l2/index/scene_index.json` 是**派生物**：每次 `l2_commit` 都从块文件全量重建，任何只存在于
 * 索引里的字段都会在下次重建时丢失。真正的权威是：
 *   · 块的正文与 META（`scene-blocks/*.md`、`archive/*.md`）
 *   · 成员清单（`index/scene_members.json` 与 `archive/scene_members.json` 两份侧车）
 *   · 归档事件（`archive/ledger.jsonl`，append-only，**不可重建**）
 *
 * 所以本页不"相信"索引自洽，而是逐项对账并把差异**显式列出来**（索引缺块 / 块未入索引 /
 * 侧车与索引成员不一致 / 归档目录与账本不一致 / 账本提到但文件不在 / 成员 id 无对应块）。
 * 一个自洽的假象比一个明显的缺口更难发现 —— 这是本页存在的理由。
 *
 * ── 「L2 管理」区（2026-10-08 补）──
 *
 * 左栏把所有会改盘的动作收在一处：块归档/恢复、场景池报告、场景池播种。
 * （**请求组织与停止子代理已搬走** —— 它们是三层同名动作，2026-10-08 收拢到「流水线」页
 * pipeline-viewer.html，与队列放在一起看才有上下文。）
 * 三条铁律（每一条都有踩过坑的理由，见下文各处的注释）：
 *   · 每个写动作都**两拍**：预演（不带 apply）→ 确认执行（apply:true）；预演与实写都是后端裁决；
 *   · 视图层不做业务判断，端点原样返回的 JSON / 文本一律摆出来（口径只准在 CLI 一份）；
 *   · 无 `?port=` 时整区禁用并说明原因（写回能力全部依赖写盘桥）。
 *
 * ── Vue 版与旧版的差别（只列会影响行为的；其余是同一套语义换实现）──────────────
 *
 * 1. 表格 / 折叠面板 / 按钮 / 弹层换成 Element Plus（el-table / el-collapse / el-button / el-dialog）。
 *    **端点、请求体、判定条件、文案一字未改** —— 这一页的价值在语义，重构不该动语义。
 * 2. 第二步（`apply: true`）在写盘前多一道 `V.vue.confirm`：预演那拍原样保留，但落盘是不可逆的
 *    一步，不该只靠"同一颗按钮点第二次"当确认。异步弹层同时避免了 `window.confirm` 在浏览器
 *    自动化下被外部直接接受、页面 JS 却卡在同步阻塞上的半死状态（见 viewer-vue.js 的说明）。
 * 3. 搜索从「debounce + 遍历 DOM 加 display:none」改成 computed 过滤：口径不变（块行按行内可见
 *    文本匹配，成员反查行按 id / 所属块匹配），但不再需要 debounce（响应式只在输入时重算一次）。
 * 4. 说明文字（侧栏的「契约」与「权威 / 派生的分工」）收进 el-collapse **默认收起** —— 与旧版
 *    原生 details 同样的取舍：那两段是方法论，只在真需要时读。
 * 5. 侧栏的 `.ops*` / 播种表 / 差异清单那几组类随 viewer.css 一起退役（主题只留领域形状），
 *    这里改用主题里现成的 `.hint` / `.cell-actions` / `.budget` / `.timeline` + EP 控件拼出来；
 *    文案一字不差（`.diff-list` 的增/删色标除外，见交付说明的语义差异清单）。
 */
(function () {
	"use strict";

	var V = window.V;
	var isEnglish = window.ViewerI18n && window.ViewerI18n.locale === "en";

	// ── 解析场景块（与 memory/l2/commit-tool.ts 的 parseSceneBlock 同口径）──
	var META_START = "-----META-START-----";
	var META_END = "-----META-END-----";

	/**
	 * 解析块文件：META 段 + 正文。
	 *
	 * 与后端同款容错：找不到标记时**不报错**，整篇当正文、META 全空 —— 因为块文件是人可读的
	 * markdown，历史/手写的块可能没有 META，把它当"坏文件"会让整页空掉，得不偿失。
	 *
	 * @param text 块文件全文
	 * @returns {meta:{created,updated,summary,heat}, body, hasMeta}
	 */
	function parseBlock(text) {
		var s = String(text || "");
		var start = s.indexOf(META_START);
		var end = s.indexOf(META_END);
		if (start < 0 || end < 0 || end < start) {
			return { meta: { created: "", updated: "", summary: "", heat: 0 }, body: s, hasMeta: false };
		}
		var metaText = s.slice(start + META_START.length, end);
		var meta = { created: "", updated: "", summary: "", heat: 0 };
		metaText.split("\n").forEach(function (line) {
			var m = /^([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line.trim());
			if (!m) return;
			var k = m[1];
			var v = m[2];
			if (k === "heat") meta.heat = Number(v) || 0;
			else if (k === "created" || k === "updated" || k === "summary") meta[k] = v;
		});
		return { meta: meta, body: s.slice(end + META_END.length).replace(/^\s*\n/, ""), hasMeta: true };
	}

	/**
	 * 极简 markdown 渲染（标题 / 列表 / 代码块）；其余按 pre-wrap 原样展示，不做花哨处理。
	 *
	 * 代码围栏用主题里的 `.log-text`（等宽块）；正文容器是 `.wrap-any`（pre-wrap），
	 * 否则行与行之间的 \n 会被 HTML 折成一段。
	 *
	 * @param body 块正文
	 * @returns HTML 片段（文本一律 escapeHtml 后拼）
	 */
	function renderMarkdown(body) {
		var lines = String(body || "").split("\n");
		var out = [];
		var inCode = false;
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			if (/^```/.test(line)) {
				inCode = !inCode;
				out.push(inCode ? '<pre class="log-text">' : "</pre>");
				continue;
			}
			if (inCode) {
				out.push(V.escapeHtml(line));
				continue;
			}
			var h = /^(#{2,4})\s+(.*)$/.exec(line);
			if (h) {
				var lvl = Math.min(h[1].length + 1, 6);
				out.push("<h" + lvl + ">" + V.escapeHtml(h[2]) + "</h" + lvl + ">");
				continue;
			}
			out.push(V.escapeHtml(line));
		}
		return out.join("\n");
	}

	/** CLI 文本裁剪上限（报告可达数万字符，整段塞进 DOM 会把页面撑爆）。 */
	var MAX_LOG_CHARS = 20000;

	/**
	 * CLI 文本裁剪。
	 * @param t 原文
	 * @returns 超过上限时截断并注明原长
	 */
	function clipText(t) {
		var s = String(t === null || t === undefined ? "" : t);
		return s.length > MAX_LOG_CHARS ? s.slice(0, MAX_LOG_CHARS) + "\n…（已截断，共 " + s.length + " 字符）" : s;
	}

	/** 端点字面量集中一处：静态校验会按字面量核对桥里是否已声明（门禁 ⑬），拼串会漏检。 */
	var EP = {
		limits: "/api/limits",
		blocks: "/api/l2/blocks",
		archive: "/api/l2/archive",
		restore: "/api/l2/restore",
		seed: "/api/l2/scene-pool/seed",
		report: "/api/l2/scene-pool/report",
		mergeReport: "/api/l2/scene-pool/merge-report",
	};

	/** 每行操作格的空状态：opState 里没有这个文件时的兜底（正常路径下 syncOpState 已经建好）。 */
	var EMPTY_OP = { reason: "", html: "", level: "", json: null, jsonSummary: "原始返回", items: [], canApply: false, busy: false, running: false };

	/**
	 * 确认框正文里的代价说明（写盘动作**没有单条回滚**，只能靠这句话把代价说在前面）。
	 * 这些句子与预演清单说的是同一件事，只是提前到"按下确认之前"。
	 */
	var APPLY_CAVEAT = {
		archive:
			"归档 = 有记账的删除（可 restore 还原）：块从 scene-blocks/ 搬到平级的 archive/，" +
			"不再被 L3/注入看到，但不占 maxScenes 名额。\n\n" +
			"写盘顺序是「取 L2 运行锁 → 自愈 → 搬块 → 重建索引」，中途失败没有单条回滚，" +
			"事后能追的只有 append-only 的 archive/ledger.jsonl。",
		restore:
			"恢复把块搬回 scene-blocks/ 并重建索引，会占一个 maxScenes 名额（空位为 0 时后端拒绝）。\n\n" +
			"写盘顺序是「取 L2 运行锁 → 自愈 → 搬块 → 重建索引」，中途失败没有单条回滚；" +
			"账本会记一条 restore。",
	};

	// ── 页面 ────────────────────────────────────────────────────────────────

	var PAGE = {
		mixins: [V.vue.pageMixin],
		data: function () {
			return {
				isEnglish: isEnglish,
				/** ../l2/index/scene_index.json —— 派生物，只用来对账与兜底 */
				index: [],
				/** ../l2/index/scene_members.json —— 权威成员清单 */
				members: {},
				/** ../l2/archive/scene_members.json */
				archiveMembers: {},
				/** ../l2/archive/ledger.jsonl —— append-only，不可重建 */
				ledger: [],
				/** ../l2/cursor.json；null = 没有这个文件 */
				cursor: null,
				/** /api/limits 的 l2 配置节；null = 无桥（读不到 maxScenes） */
				config: null,
				/** 桥列出的真实文件（权威目录视图）；无桥时为空 */
				dirLive: null,
				dirArchive: null,
				/** filename → {meta, body, hasMeta}（块文件读不到的文件不在表里） */
				blocks: {},
				archiveBlocks: {},
				/** filename → 行内操作格的临时状态（原因输入 / 预演裁决 / 原始返回） */
				opState: {},
				/**
				 * 操作格的**版本号**：`pageRows` 读它，于是它一变整张块表重渲染。
				 *
				 * 为什么需要它：Element Plus 的 `el-table` 只在 `:data` 变化时重渲染单元格
				 * （实测 2.14.7，父组件 `$forceUpdate()` 都无效）。opState 是表格数据之外的状态，
				 * 不显式制造这个依赖，预演结果就不显示、输入框也读不到模型值。
				 */
				opVersion: 0,
				/** 首次加载是否已完成（决定空态写"尚未加载"还是「暂无数据」） */
				loaded: false,
				/** 块详情弹层 */
				detailOpen: false,
				detail: null,
				/** 弹层里两个折叠段（正文 / 成员清单）：旧版两个 details 都是 open，默认全开 */
				detailPanels: ["body", "members"],
				/** 搜索词（computed 过滤，不再遍历 DOM） */
				q: "",
				/** 侧栏两个折叠段：默认收起 */
				contractOpen: [],
				authorityOpen: [],
				/** 归档 / 恢复执行结果（不在会被重绘的表格里，重新加载后也还看得见） */
				opsNote: { html: "", level: "", json: null, jsonSummary: "执行原始返回" },
				/** 场景池报告：busy / 正文 / 折叠块的标题 */
				report: { busy: false, html: "", level: "", text: null, textSummary: "", json: null },
				/**
				 * 报告弹层：几千字的 CLI 文本在 336px 侧栏里读不下来，所以结果进弹层。
				 * 点侧栏那颗按钮**同时**打开弹层并开始生成（与旧版"点一下就开始生成"同一拍，
				 * 只是把结果摆到了一个放得下的容器里）。
				 */
				reportOpen: false,
				/** 当前报告类型："report"（场景池）| "merge"（合并） */
				reportKind: "report",
				/** 播种弹层（四列表格在侧栏里只能压成折行） */
				seedOpen: false,
				/** 播种表（一行 = 一个场景）；初始就留一行，空表会让用户以为"播种"没在做 */
				seedRows: [{ name: "", aliases: "", note: "" }],
				/** 执行（写盘）只在一次成功的预演之后可用（旧版同款：预演成功才启用） */
				seedPreviewed: false,
				seedOut: { html: "", err: false, log: null },
			};
		},
		mounted: function () {
			// 旧版 init() 做三件事：mountChrome（已在 V.vue.mount 里做过）、bind()（Vue 接管，
			// 事件委托不再需要）、autoLoad()。挂载后立刻取一次数。
			var self = this;
			V.registerRefreshHandler(function () { return self.loadAll(); });
			this.loadAll();
		},
		computed: {
			/** 详情弹层里「在 L1 页搜」的链接（旧版按 bridgePort() 拼，语义原样）。 */
			recordsHref: function () {
				return "records-viewer.html?port=" + V.bridgePort();
			},
			/** 桥列出的文件里最大的那批统计口径：config 在不在决定了下限判定。 */
			maxScenes: function () {
				return this.config && typeof this.config.maxScenes === "number" ? this.config.maxScenes : null;
			},
			/** 块文件名清单（index 给 live；archive 侧车给归档；桥的目录列举作权威补充）。 */
			lists: function () {
				var live = {};
				this.index.forEach(function (e) {
					if (e && typeof e.filename === "string") live[e.filename] = true;
				});
				(this.dirLive || []).forEach(function (f) {
					live[f.file] = true;
				});
				Object.keys(this.members).forEach(function (f) {
					live[f] = true;
				});

				var archive = {};
				Object.keys(this.archiveMembers).forEach(function (f) {
					archive[f] = true;
				});
				(this.dirArchive || []).forEach(function (f) {
					archive[f.file] = true;
				});
				this.ledger.forEach(function (e) {
					if (e && e.op === "archive" && typeof e.filename === "string") archive[e.filename] = true;
				});
				return { live: Object.keys(live).sort(), archive: Object.keys(archive).sort() };
			},
			/**
			 * 逐项对账，返回问题清单。
			 *
			 * 每一条都对应一个真实可能的失效，而不是泛泛的"数据可能不一致"：
			 *   · 索引缺块 / 块未入索引 → 索引是派生物，重建时机与块变更不同步时会出现
			 *   · 侧车成员与索引成员不一致 → 索引会被重建、侧车不会，两者漂移意味着"数成员数"会数错
			 *   · 归档文件不在账本 / 账本提到但文件不在 → 归档的可追溯性（这就是 archive 与 delete 的区别）
			 *   · 成员 id 在文件里查不到（正文里的 id token）→ 侧车丢过或块被手工改过
			 *   · 同一 id 同时挂在多个块上 → 成员口径分叉
			 *
			 * @returns {issues: [{level,text}], ownerOf: Map<id, filename>}
			 */
			recon: function () {
				var issues = [];
				var indexByFile = new Map();
				this.index.forEach(function (e) {
					if (e && typeof e.filename === "string") indexByFile.set(e.filename, e);
				});

				// 索引 ↔ 磁盘块
				if (this.dirLive) {
					var diskLive = {};
					this.dirLive.forEach(function (f) {
						diskLive[f.file] = true;
					});
					this.index.forEach(function (e) {
						if (e && e.filename && !diskLive[e.filename]) issues.push({ level: "warn", text: isEnglish ? "Block “" + e.filename + "” is in the index, but its file is missing from scene-blocks/ (has the index not been rebuilt?)" : "索引里有块「" + e.filename + "」，但 scene-blocks/ 下没有这个文件（索引未重建？）" });
					});
					this.dirLive.forEach(function (f) {
						if (!indexByFile.has(f.file)) issues.push({ level: "warn", text: isEnglish ? "“" + f.file + "” in scene-blocks/ is missing from the index (L3 and memory injection cannot see this block)" : "scene-blocks/ 下的「" + f.file + "」不在索引里（该块目前不会被 L3/注入看到）" });
					});
				} else {
					issues.push({ level: "info", text: isEnglish ? "Viewer bridge unavailable: scene-blocks/ cannot be listed, so the index cannot be compared with disk (only the index and sidecars can be checked)." : "无写盘桥：拿不到 scene-blocks/ 的目录列举，无法核对「索引 ↔ 磁盘」是否一致（只能核对索引与侧车）" });
				}

				// 索引成员 ↔ 侧车成员
				var self = this;
				this.index.forEach(function (e) {
					if (!e || !e.filename) return;
					var fromSidecar = self.members[e.filename];
					if (!fromSidecar) {
						if (Array.isArray(e.members) && e.members.length > 0) {
							issues.push({ level: "warn", text: isEnglish ? "“" + e.filename + "” lists " + e.members.length + " members in the index, but has no entry in the scene_members.json sidecar. The sidecar is authoritative; index members may have been parsed from the block content." : "「" + e.filename + "」在索引里有 " + e.members.length + " 个成员，但 scene_members.json 侧车里没有这条 —— 侧车是权威，索引成员可能来自正文兜底解析" });
						}
						return;
					}
					var a = (e.members || []).slice().sort().join(",");
					var b = fromSidecar.slice().sort().join(",");
					if (a !== b) issues.push({ level: "warn", text: isEnglish ? "Members for “" + e.filename + "” differ between the index and sidecar (index: " + (e.members || []).length + "; sidecar: " + fromSidecar.length + "). The index is derived; use the sidecar as the source of truth." : "「" + e.filename + "」的成员在索引与侧车不一致（索引 " + (e.members || []).length + " 个 / 侧车 " + fromSidecar.length + " 个）—— 索引是派生物，以侧车为准" });
				});

				// 归档：目录 ↔ 账本
				var ledgerArchived = {};
				this.ledger.forEach(function (e) {
					if (e && e.op === "archive" && e.filename) ledgerArchived[e.filename] = e;
				});
				if (this.dirArchive) {
					this.dirArchive.forEach(function (f) {
						if (!ledgerArchived[f.file]) issues.push({ level: "warn", text: isEnglish ? "Archived block “" + f.file + "” has no archive event in ledger.jsonl; its archive history is incomplete." : "归档块「" + f.file + "」在 ledger.jsonl 里没有 archive 记录 —— 归档的可追溯性缺失" });
					});
				}
				Object.keys(ledgerArchived).forEach(function (f) {
					if (self.dirArchive && !self.dirArchive.some(function (d) { return d.file === f; })) {
						issues.push({ level: "warn", text: isEnglish ? "The ledger records an archive for “" + f + "”, but the file is missing from archive/ (was it restored without a matching restore event?)" : "账本记了「" + f + "」的 archive，但 archive/ 下没有该文件（已被 restore 后账本未补 restore 记录？）" });
					}
				});
				Object.keys(this.archiveMembers).forEach(function (f) {
			if (!ledgerArchived[f]) issues.push({ level: "warn", text: isEnglish ? "Archived member sidecar contains “" + f + "”, but the ledger has no archive event for it." : "归档侧车成员里有「" + f + "」，但账本没有它的 archive 记录" });
				});

				// 成员 id 是否在块正文里出现（兜底口径） / 是否被多个块声明
				var ownerOf = new Map();
				var allSidecars = [
					{ src: "live", obj: this.members },
					{ src: "archive", obj: this.archiveMembers },
				];
				allSidecars.forEach(function (s) {
					Object.keys(s.obj).forEach(function (f) {
						(s.obj[f] || []).forEach(function (id) {
							var prev = ownerOf.get(id);
							if (prev && prev !== f) issues.push({ level: "warn", text: isEnglish ? "Member “" + id + "” is assigned to both “" + prev + "” and “" + f + "” (conflicting ownership)." : "成员 " + id + " 同时挂在「" + prev + "」与「" + f + "」上（成员口径分叉）" });
							else ownerOf.set(id, f);
						});
					});
				});
				var tokenMissing = 0;
				ownerOf.forEach(function (f, id) {
					var blk = self.blocks[f] || self.archiveBlocks[f];
					if (!blk) return;
					if (blk.body.indexOf(id) < 0) tokenMissing++;
				});
				if (tokenMissing > 0) {
					issues.push({ level: "info", text: isEnglish ? tokenMissing + " member IDs could not be found in their block content (the sidecar may have been backfilled or the content edited manually)." : tokenMissing + " 个成员 id 在所属块的正文里找不到（可能是侧车回填过 / 或正文被手工改过）" });
				}

				return { issues: issues, ownerOf: ownerOf };
			},
			/** 对账结果 → 提示条（warn 用 .notice.warn；info 与"无告警"那份用素色 .notice）。 */
			reconNotices: function () {
				var self = this;
				var warn = this.recon.issues.filter(function (i) { return i.level === "warn"; });
				var info = this.recon.issues.filter(function (i) { return i.level !== "warn"; });
				var out = warn.length === 0 ? [{ html: isEnglish ? "Reconciliation passed: index, sidecars, disk, and ledger all match." : "对账无告警：索引 / 侧车 / 磁盘 / 账本四项一致。", level: "" }] : [];
				return out
					.concat(
						warn.map(function (i) { return { html: self.esc(i.text), level: "warn" }; }),
					)
					.concat(
						info.map(function (i) { return { html: self.esc(i.text), level: "" }; }),
					);
			},
			/** live 块数（索引优先，索引为空时退到磁盘列举 —— 旧版同款口径）。 */
			liveCount: function () {
				return this.index.length || this.lists.live.length;
			},
			/** 上限判定（red/orange/yellow/none/unknown）—— 只影响预算条配色，不参与任何写判定。 */
			grade: function () {
				var m = this.maxScenes;
				var n = this.liveCount;
				if (m === null) return "unknown";
				if (n >= m) return "red";
				if (n === m - 1) return "orange";
				if (n >= Math.ceil(m * 0.8)) return "yellow";
				return "none";
			},
			gradeText: function () {
				if (isEnglish) return { red: "Full", orange: "One slot left", yellow: "Near limit", none: "Below limit", unknown: "Limit unavailable (no viewer bridge)" }[this.grade];
				return { red: "已满", orange: "差一个到上限", yellow: "接近上限", none: "未接近上限", unknown: "上限未知（无桥时读不到 l2.maxScenes）" }[this.grade];
			},
			/** 严重度 → CSS 类（色值只在 viewer-theme.css 里有一份）。unknown 不给宽度，故不配色。 */
			gradeClass: function () {
				return { red: "over", orange: "warn", yellow: "warn", none: "", unknown: "" }[this.grade];
			},
			gradePct: function () {
				var m = this.maxScenes;
				return m ? Math.min(100, Math.round((this.liveCount / m) * 100)) : 0;
			},
			/**
			 * 「块数上限」的口径注解（归档配置 + "归档块不占名额"）—— 挂到标题的问号上。
			 * 它是静态注解，不随数据变；只有"读不到配置"才是要写在页面上的失败态（见 capError）。
			 */
			capHelp: function () {
				var c = this.config;
				if (!c) return "";
				return (
					"归档配置：" + (c.archive && c.archive.enabled ? "启用" : "关闭") +
					"（最低年龄 " + (c.archive && c.archive.minAgeCalendarDays) + " 日历天，每批最多 " +
					(c.archive && c.archive.maxPerBatch) + " 个）。归档块与 scene-blocks/ 平级，<b>不占 maxScenes 名额</b>。"
				);
			},
			/** 配置读不到时的可见提示（失败态不许藏进问号）。 */
			capError: function () {
				if (this.config) return "";
				return isEnglish
					? "No viewer bridge: <code>l2.maxScenes</code> is unavailable. Limits are served by /api/limits so the page does not receive config files that may contain secrets."
					: "无写盘桥：读不到 <code>l2.maxScenes</code>（配置节由 /api/limits 提供，避免把含密钥的 config/ 交给页面）。";
			},
			/** 侧栏概览：七项全库口径（不随搜索变）。 */
			statRows: function () {
				var memberTotal = 0;
				var members = this.members;
				Object.keys(members).forEach(function (f) { memberTotal += (members[f] || []).length; });
				var archiveMemberTotal = 0;
				var am = this.archiveMembers;
				Object.keys(am).forEach(function (f) { archiveMemberTotal += (am[f] || []).length; });
				return [
					{ label: "live 块（索引）", value: this.index.length },
					{ label: "live 块（磁盘）", value: this.dirLive ? this.dirLive.length : "—" },
					{ label: "归档块", value: Object.keys(this.archiveBlocks).length },
					{ label: "live 成员总数", value: memberTotal },
					{ label: "归档成员总数", value: archiveMemberTotal },
					{ label: isEnglish ? "Ledger events" : "账本条目", value: this.ledger.length },
					{ label: "对账问题", value: this.recon.issues.filter(function (i) { return i.level === "warn"; }).length },
				];
			},
			/** L2 游标水位（值留给页面；"水位用来判什么"那句进标题的问号）。 */
			cursorHtml: function () {
				if (!this.cursor) return '<span class="hint">' + (isEnglish ? "No cursor.json" : "无 cursor.json") + "</span>";
				if (isEnglish) return '<div class="cursor-facts">' +
					'<div class="cursor-fact"><span class="cursor-label">Last processed</span><time class="cursor-value">' +
					this.esc(V.fmtTime(new Date(this.cursor.lastProcessedAt).toISOString())) + "</time></div>" +
					'<div class="cursor-fact"><span class="cursor-label">Last record ID</span><span class="cursor-value cursor-id">' +
					this.esc(this.cursor.lastRecordId || "—") + "</span></div></div>";
				return '<div class="cursor-facts">' +
					'<div class="cursor-fact"><span class="cursor-label">最近处理时间</span><time class="cursor-value">' +
					this.esc(V.fmtTime(new Date(this.cursor.lastProcessedAt).toISOString())) + "</time></div>" +
					'<div class="cursor-fact"><span class="cursor-label">最近处理记录</span><span class="cursor-value cursor-id">' +
					this.esc(this.cursor.lastRecordId || "—") + "</span></div></div>";
			},
			/** 管理区契约三段（长解释；默认收起，真被拒时再展开读）。 */
			contractHtml: function () {
				var m = this.maxScenes;
				var live = this.liveCount;
				var free = m === null ? null : Math.max(0, m - live);
				if (isEnglish) return "<p><b>Block limit</b>: <code>maxScenes</code> = " +
					(m === null ? "unknown (unavailable without the viewer bridge: <code>/api/limits</code>)" : m) +
					"; current live blocks: " + live + (free === null ? "" : "; available slots: " + free) + ".</p>" +
					"<p><b>Restore requires an available slot</b>: restoring adds one block to live, so " +
					(free === null ? "the server rejects it when the limit is reached" : "the server rejects it when no slots remain (" + live + " / " + m + ")") +
					". Archive or merge another block first. Archived blocks live in <code>archive/</code> beside <code>scene-blocks/</code> and <b>do not count toward maxScenes</b>.</p>" +
					"<p><b>Archive is a logged, reversible removal</b>: the block is moved, and <code>archive/ledger.jsonl</code> records its filename, time, author, and reason. This append-only ledger is the evidence needed to restore and audit it. <code>delete</code> permanently removes it without a ledger entry.</p>";
				return "<p><b>块数预算</b>：live 块上限 <code>maxScenes</code> = " +
					(m === null ? "未知（无桥时读不到 <code>/api/limits</code>）" : m) +
					"，当前 live 块 " + live + " 个" + (free === null ? "" : "，空位 " + free + " 个") + "。</p>" +
					"<p><b>恢复要先腾位</b>：restore 会往 live 加回一个块，所以" +
					(free === null ? "满库时会被后端拒绝" : "空位为 0（" + live + " / " + m + "）时就被后端拒绝") +
					" —— 得先归档或合并别的块。归档块放在与 <code>scene-blocks/</code> 平级的 <code>archive/</code>，<b>不占 maxScenes 名额</b>。</p>" +
					"<p><b>归档 = 有记账的删除</b>（可恢复）：块只是被搬走，<code>archive/ledger.jsonl</code> 逐条记下归档/恢复的" +
					"<b>文件名、时间、by、reason</b> —— 那份 append-only、不可重建的账本，就是它可恢复、可追责的凭据；" +
					"<code>delete</code> 才是真的消失且不留痕。</p>";
			},
			/** 无桥时的整区说明（写回能力全部依赖写盘桥，这里要说清怎么把桥拉起来）。 */
			readOnlyHint: function () {
				if (isEnglish) return "<b>Read-only mode</b>: archiving, restoring, and changing scene names require the viewer bridge, so the buttons below are disabled. Run <code>node scripts/l1-admin/viewer-bridge.mjs</code>, then open this page using the URL it prints with <b><code>?port=</code></b>.";
				return '<b>只读模式</b>：归档/恢复与统一场景名称都需要写盘桥，下面的按钮已禁用。' +
					"请运行 <code>node scripts/l1-admin/viewer-bridge.mjs</code>，再用它打印的<b>带 <code>?port=</code> 的地址</b>打开本页。";
			},
			/** 归档账本时间线（按 at 升序，与账本追加顺序一致）。 */
			ledgerRows: function () {
				var sorted = this.ledger.slice().sort(function (a, b) { return V.ts(a.at) - V.ts(b.at); });
				return sorted.map(function (e) {
					var op = e.op || "?";
					var label = isEnglish ? ({ archive: "Archive", restore: "Restore", "ledger-missing": "Ledger repair" }[op] || op) : ({ archive: "归档", restore: "恢复", "ledger-missing": "缺账补记" }[op] || op);
					return {
						cls: op,
						label: label,
						filename: e.filename || "",
						when:
							V.fmtTime(e.at) + " · by " + (e.by || "—") +
							(e.heat !== undefined ? " · heat " + e.heat : "") +
							(e.memberCount !== undefined ? (isEnglish ? " · members " : " · 成员 ") + e.memberCount : ""),
						reason: e.reason || "",
					};
				});
			},
			/** 成员归属反查的全量口径（id → 所属块）。 */
			ownerList: function () {
				var out = [];
				this.recon.ownerOf.forEach(function (f, id) {
					out.push({ id: id, file: f });
				});
				return out;
			},
			ownerTotal: function () {
				return this.ownerList.length;
			},
			/** 块表：live 在前、归档在后（旧版同序）。 */
			pageRows: function () {
				var self = this;
				// 显式依赖操作格版本号：只有它变，这一份（以及 el-table 的 `:data`）才会重算，
				// 单元格才会带着最新的预演结果/可用状态重渲染（见 opVersion 与 setOp 的注释）。
				void this.opVersion;
				var indexByFile = new Map();
				this.index.forEach(function (e) {
					if (e && e.filename) indexByFile.set(e.filename, e);
				});
				var mk = function (filename, archived) {
					var blk = (archived ? self.archiveBlocks : self.blocks)[filename];
					var idx = indexByFile.get(filename);
					var sidecar = (archived ? self.archiveMembers : self.members)[filename];
					var meta = blk ? blk.meta : { created: "", updated: "", summary: "", heat: 0 };
					var heat = meta.heat || (idx ? idx.heat : 0) || 0;
					var summary = meta.summary || (idx ? idx.summary : "") || "";
					var members = sidecar || (idx && idx.members) || [];
					var updated = self.fmtDay(meta.updated || (idx && idx.updated));
					var flags = (blk && !blk.hasMeta ? "无 META" : "") + (archived ? " 已归档" : "");
					return {
						filename: filename,
						archived: !!archived,
						/** 只区分"文件读到了但没有 META"与"文件读不到"这两种不同的缺失 */
						noMeta: !!(blk && !blk.hasMeta),
						missing: !blk,
						heat: heat,
						memberCount: members.length,
						updated: updated,
						summary: summary,
						/** 这一行的操作格状态（**同一个对象引用**：输入框直接写进 opState，见 opVersion 注释） */
						op: self.opOf(filename),
						/** 搜索用的行内可见文本（等价于旧版 tr.innerText 里属于本行数据的那部分） */
						hay: (filename + " " + heat + " " + members.length + " " + updated + " " + summary + " " + flags).toLowerCase(),
					};
				};
				return this.lists.live
					.map(function (f) { return mk(f, false); })
					.concat(this.lists.archive.map(function (f) { return mk(f, true); }));
			},
			/** 搜索过滤后的块行（空词 = 全部）。 */
			visibleRows: function () {
				var needle = this.q.trim().toLowerCase();
				if (!needle) return this.pageRows;
				return this.pageRows.filter(function (r) { return r.hay.indexOf(needle) >= 0; });
			},
			/** 成员反查：只列前 300 条（旧版口径），再套搜索。 */
			visibleOwners: function () {
				var head = this.ownerList.slice(0, 300);
				var needle = this.q.trim().toLowerCase();
				if (!needle) return head;
				return head.filter(function (o) {
					return (o.id + " " + o.file).toLowerCase().indexOf(needle) >= 0;
				});
			},
		},
		methods: {
			/** 行内操作格的状态（缺失时给一份只读兜底，避免渲染期创建响应式键）。 */
			opOf: function (filename) {
				return this.opState[filename] || EMPTY_OP;
			},
			/** 操作格状态变了 → 递增版本号，让块表（`:data` = pageRows）重渲染那些单元格。 */
			bumpOp: function () {
				this.opVersion++;
			},
			/**
			 * 打开报告弹层并**立刻开始生成**。
			 *
			 * 与旧版同一拍（旧版点一下按钮就生成、结果留在侧栏）；只是把结果摆进放得下的容器。
			 * `reportKind` 决定弹层标题与「重新生成」重新跑哪一种。
			 */
			openReport: function (which) {
				this.reportKind = which;
				this.reportOpen = true;
				return this.runReport(which);
			},
			/** 块行可点（打开详情）：EP 默认不给 pointer，这里补上"这行能点"的提示。 */
			rowStyle: function () {
				return { cursor: "pointer" };
			},
			/** 点行打开详情弹层（操作格自己有点击语义，那里已经 @click.stop）。 */
			onRowClick: function (row) {
				this.openBlock(row.filename, row.archived);
			},

			/**
			 * 写行内操作格的状态（预演裁决 / 原始返回 / 是否给出"确认执行"）。
			 *
			 * ⚠ 必须 `bumpOp()`：操作格渲染在 `el-table` 的单元格里，而 **Element Plus 的表格只在 `:data`
			 * 变化时重渲染单元格**（2026-10-10 实测 2.14.7：连父组件 `$forceUpdate()` 都不会让单元格重画）。
			 * 若 `:data` 与 opState 无关，预演结果永远不显示、输入框也读不到模型值 —— 用户填了归档原因
			 * 却被告知"必须写原因"（这是本轮真实测出的故障，静态检查与逻辑冒烟都抓不到）。
			 */
			setOp: function (row, html, level, json, items, canApply, jsonSummary) {
				var st = this.opOf(row.filename);
				st.html = html;
				st.level = level || "";
				st.json = json === undefined ? null : json;
				st.jsonSummary = jsonSummary || "原始返回";
				st.items = items || [];
				st.canApply = !!canApply;
				this.bumpOp();
			},
			/** 写归档 / 恢复的执行结果（不在会被重绘的表格里，重新加载也还看得见）。 */
			setOps: function (html, level, json, jsonSummary) {
				this.opsNote = { html: html, level: level || "", json: json === undefined ? null : json, jsonSummary: jsonSummary || "执行原始返回" };
			},

			// ── 加载 ────────────────────────────────────────────────────────────

			/** 取五个静态来源 + 两个桥端点（无桥时桥那两个端点原样返回 ok:false，页面按只读处理）。 */
			loadMeta: function () {
				var self = this;
				return Promise.all([
					V.loadJson("../l2/index/scene_index.json"),
					V.loadJson("../l2/index/scene_members.json"),
					V.loadJson("../l2/archive/scene_members.json"),
					V.loadJsonl("../l2/archive/ledger.jsonl"),
					V.loadJson("../l2/cursor.json"),
					V.bridge(EP.limits),
					V.bridge(EP.blocks),
				]).then(function (r) {
					self.index = Array.isArray(r[0]) ? r[0] : [];
					self.members = r[1] && typeof r[1] === "object" ? r[1] : {};
					self.archiveMembers = r[2] && typeof r[2] === "object" ? r[2] : {};
					self.ledger = Array.isArray(r[3]) ? r[3] : [];
					self.cursor = r[4] || null;
					self.config = r[5] && r[5].ok && r[5].data ? r[5].data.l2 : null;
					self.dirLive = r[6] && r[6].ok ? r[6].data.live : null;
					self.dirArchive = r[6] && r[6].ok ? r[6].data.archive : null;
				});
			},

			/**
			 * 取块文件正文（读不到的文件不进表 —— 与"读到但为空"是两种状态）。
			 * 结果整体一次赋给 this.blocks：逐个赋值会触发几十次重渲染。
			 */
			loadBlocks: function () {
				var self = this;
				var lists = this.lists;
				var blocks = {};
				var archiveBlocks = {};
				var tasks = [];
				lists.live.forEach(function (f) {
					tasks.push(
						V.loadText("../l2/scene-blocks/" + encodeURIComponent(f)).then(function (txt) {
							if (txt !== null) blocks[f] = parseBlock(txt);
						}),
					);
				});
				lists.archive.forEach(function (f) {
					tasks.push(
						V.loadText("../l2/archive/" + encodeURIComponent(f)).then(function (txt) {
							if (txt !== null) archiveBlocks[f] = parseBlock(txt);
						}),
					);
				});
				return Promise.all(tasks).then(function () {
					self.blocks = blocks;
					self.archiveBlocks = archiveBlocks;
				});
			},

			/** 重建每行操作格的空状态：整页重新加载会把旧版的预演结果一起抹掉，这里同样重来。 */
			syncOpState: function () {
				var lists = this.lists;
				var next = {};
				lists.live.concat(lists.archive).forEach(function (f) {
					next[f] = { reason: "", html: "", level: "", json: null, jsonSummary: "原始返回", items: [], canApply: false, busy: false, running: false };
				});
				this.opState = next;
				// 表格行里存的是"当初那个 opState 条目的引用"，换了对象必须重渲染，否则输入框与
				// 预演结果会继续指向被丢弃的那一份（`opOf` 已经看不到它了）。
				this.bumpOp();
			},

			/** 重新加载（并重算对账）；页头按钮与写盘成功后的收尾都走这里。 */
			loadAll: function () {
				var self = this;
				this.setNote("加载中…");
				this.blocks = {};
				this.archiveBlocks = {};
				return this.loadMeta()
					.then(function () {
						return self.loadBlocks();
					})
					.then(function () {
						self.loaded = true;
						self.syncOpState();
						// 场景池报告**不在**加载时取 —— 它可能调 embedding，必须按需（见 runReport）。
						// 待消费信号与在跑的子代理也不在这里了：它们已归「流水线」页。
						self.setNote(isEnglish
							? "Loaded " + self.index.length + " live index entries, " + Object.keys(self.members).length + " live member sidecar entries, and " + self.ledger.length + " ledger events" +
								(self.dirLive ? " (disk listing available: " + self.dirLive.length + " live .md files, " + self.dirArchive.length + " archived .md files)" : " (<b>viewer bridge unavailable</b>: cannot list directories or compare the index with disk)")
							: "已加载 " + self.index.length + " 个 live 索引条目、" + Object.keys(self.members).length + " 条 live 成员侧车、" + self.ledger.length + " 条账本事件" +
								(self.dirLive ? "（磁盘列举可用：live " + self.dirLive.length + " 个 .md、归档 " + self.dirArchive.length + " 个 .md）" : "（<b>无写盘桥</b>：拿不到目录列举，索引 ↔ 磁盘 无法核对）"));
					})
					.catch(function (e) {
						self.setNote("加载失败：" + self.esc(e && e.message ? e.message : String(e)), "err");
					});
			},

			// ── 块详情（点行打开）───────────────────────────────────────────────

			/**
			 * 打开块详情：META / 成员清单 / 正文（含"文件读不到"与"正文里没有这个 id"两种提示）。
			 * @param filename 块文件名
			 * @param archived 来自归档目录（决定读哪份侧车与正文）
			 */
			openBlock: function (filename, archived) {
				var blk = (archived ? this.archiveBlocks : this.blocks)[filename] || null;
				var sidecar = (archived ? this.archiveMembers : this.members)[filename] || null;
				var idx = null;
				this.index.forEach(function (e) {
					if (e && e.filename === filename) idx = e;
				});
				var members = sidecar || (idx && idx.members) || [];
				this.detail = {
					filename: filename,
					archived: !!archived,
					blk: blk,
					sidecar: sidecar,
					// 「正文兜底」是块文件的兜底口径：成员 id 应当在正文里出现（侧车回填或手改会破坏它）
					members: members.map(function (id) {
						return { id: id, inBody: !!(blk && blk.body.indexOf(id) >= 0) };
					}),
					bodyHtml: blk ? renderMarkdown(blk.body) : "",
					bodyLen: blk ? blk.body.length : 0,
					summary: blk && blk.meta.summary ? blk.meta.summary : "",
					missingNote: {
						level: "warn",
						html: "这个块的文件读不到（可能只在索引/侧车里存在）。" + (this.dirLive ? "" : "无写盘桥时无法列目录，建议用桥打开。"),
					},
				};
				this.detailPanels = ["body", "members"];
				this.detailOpen = true;
			},

			// ══ 管理操作区（「L2 管理」） ═══════════════════════════════════════
			//
			// 为什么每个写动作都要「预演 → 确认执行」两拍，而不是点一下就走：
			//   · 归档/恢复会取 **L2 运行级锁**，顺序是「自愈 → 搬块 → 重建索引」，中途失败没有单条回滚，
			//     事后能追的只有 archive/ledger.jsonl（append-only、不可重建）。预演先把能只读判定的前置
			//     条件（文件在不在 / reason 有没有 / maxScenes 够不够）摆出来，多数错误到此就挡住了。
			//   · 播种会**整节重写** l1/scenes.json（L1 场景归属的唯一真源），且写前才自动备份。
			//   · 桥是单线程同步执行的：一次慢动作（报告 / 实写）期间整座桥不响应请求，所以要置灰整行。
			//
			// 视图层不做任何业务判断：上不上锁、满没满、能不能恢复，全部由 l1-admin 的 CLI 裁决，
			// 页面只负责把它的结构化输出如实摆出来（口径只准在后端一份）。

			/** 场景池只读报告：**按需**取（可能调 embedding，绝不在页面加载时打这一炮）。 */
			runReport: function (which) {
				var self = this;
				if (!this.hasPort()) return;
				var merge = which === "merge";
				var title = merge ? "合并报告" : "场景池报告";
				this.report = { busy: true, html: "正在生成" + this.esc(title) + "…（可能几秒到更久）", level: "", text: null, textSummary: "", json: null };
				V.bridge(merge ? EP.mergeReport : EP.report)
					.then(function (r) {
						var text = r && r.ok && r.data ? r.data.text : null;
						if (text === null || text === undefined) {
							self.report = {
								busy: false,
								html: "生成失败：" + self.esc(self.bridgeError(r)),
								level: "err",
								text: null,
								textSummary: "",
								json: (r && r.data) || {},
							};
							return;
						}
						self.report = {
							busy: false,
							html: "",
							level: "",
							text: clipText(text),
							textSummary: title + "（" + String(text).length + " 字符）",
							json: null,
						};
					})
					.catch(function (e) {
						self.report = {
							busy: false,
							html: "生成失败：" + self.esc(e && e.message ? e.message : String(e)),
							level: "err",
							text: null,
							textSummary: "",
							json: null,
						};
					});
			},

			// ── 统一场景名称：维护场景当前名称与历史名称的对应关系 ───────────────

			/** 加一行空场景（name 必填，aliases 逗号分隔，note 可选）。 */
			seedAddRow: function () {
				this.seedRows.push({ name: "", aliases: "", note: "" });
			},
			/** 删一行，并**保证至少一行**：空表会让用户以为"播种"没在做。 */
			seedRemove: function (index) {
				this.seedRows.splice(index, 1);
				this.seedEnsureRow();
			},
			seedEnsureRow: function () {
				if (this.seedRows.length === 0) this.seedAddRow();
			},

			/**
			 * 收集播种表 → scenes。
			 * 空行忽略；缺场景名**报错而不是静默丢**（静默丢会写出一份缺条目的池）。
			 *
			 * @returns {scenes, error}
			 */
			seedCollect: function () {
				var scenes = [];
				var bad = false;
				this.seedRows.forEach(function (r) {
					var name = String(r.name || "").trim();
					var aliases = String(r.aliases || "")
						.split(/[,，、]/)
						.map(function (s) {
							return s.trim();
						})
						.filter(Boolean);
					var note = String(r.note || "").trim();
					if (!name && aliases.length === 0 && !note) return;
					if (!name) {
						bad = true;
						return;
					}
					var s = { name: name, aliases: aliases };
					if (note) s.note = note;
					scenes.push(s);
				});
				if (bad) return { scenes: [], error: "每一行都要有场景名（别名与备注可空）" };
				if (scenes.length === 0) return { scenes: [], error: "至少要填一行" };
				return { scenes: scenes, error: "" };
			},

			/**
			 * 播种：apply=false 打印计划（预演），apply=true 先备份再写。
			 * 执行前必须有一次成功的预演（按钮只在预演成功后启用）。
			 */
			seedRun: function (apply) {
				var self = this;
				if (!this.hasPort()) return;
				var got = this.seedCollect();
				if (got.error) {
					this.seedOut = { html: this.esc(got.error), err: true, log: null };
					this.seedPreviewed = false;
					return;
				}
				this.seedPreviewed = false;
				this.busy = "seed";
				this.seedOut = {
					html: apply ? "正在保存名称设置（会先自动备份）…" : "正在检查变更（尚未保存）…",
					err: false,
					log: null,
				};
				V.bridge(EP.seed, { method: "POST", body: JSON.stringify({ scenes: got.scenes, apply: !!apply }) })
					.then(function (r) {
						var ok = r && r.ok && r.data && r.data.success !== false;
						var text = r && r.data ? r.data.text || r.data.error || r.data.raw || JSON.stringify(r.data) : "无响应";
						self.busy = "";
						if (!ok) {
							self.seedOut = { html: (apply ? "保存失败：" : "检查失败：") + self.esc(self.bridgeError(r)), err: true, log: { summary: "详细信息", text: clipText(text) } };
							return;
						}
						self.seedOut = {
							html: apply
								? "名称设置已保存，原设置已自动备份。"
								: "检查完成，尚未保存。请查看上方变更，确认后点「保存名称设置」。",
							err: false,
							log: { summary: apply ? "执行输出" : "预演输出（CLI 计划）", text: clipText(text) },
						};
						if (!apply) self.seedPreviewed = true;
					})
					.catch(function (e) {
						self.busy = "";
						self.seedOut = { html: (apply ? "保存失败：" : "检查失败：") + self.esc(e && e.message ? e.message : String(e)), err: true, log: null };
					});
			},

			// ── 每个块行上的 归档 / 恢复（预演 → 确认执行）──────────────────────────

			/**
			 * 第一步：预演（不带 apply，后端保证不写盘）。通过后才给出「确认执行」。
			 * @param row 块表的一行（row.archived 决定是归档还是恢复）
			 */
			blockPreview: function (row) {
				var self = this;
				var op = row.archived ? "restore" : "archive";
				var st = this.opOf(row.filename);
				var reason = String(st.reason || "").trim();
				// 归档的 reason 是后端硬拦的（= 归档唯一的审计凭据），这里提前说清，别等一个 500。
				if (op === "archive" && !reason) {
					this.setOp(row, '归档必须写原因 —— 它是这次归档唯一的审计凭据，会写进 <code>ledger.jsonl</code>。', "warn");
					return;
				}
				this.setOp(row, "正在预演" + (op === "archive" ? "归档" : "恢复") + "…（预演不写盘、不跑自愈）", "");
				var body = { filename: row.filename };
				if (reason) body.reason = reason;
				V.bridge(EP[op], { method: "POST", body: JSON.stringify(body) }).then(function (r) {
					var d = (r && r.data) || {};
					if (!(r && r.ok && d.success !== false && d.dryRun)) {
						self.setOp(row, "预演未通过：" + self.esc(self.bridgeError(r)), "err", d);
						return;
					}
					var live = d.live;
					var items =
						op === "archive"
							? [
									"从 scene-blocks/ 移出 " + row.filename + "（live " + live + " → " + (live - 1) + "）",
									"进入 archive/，并写一条 archive 账目（于是可 restore 还原）",
									"归档块不占 maxScenes（上限 " + d.maxScenes + "）名额",
								]
							: [
									"回到 scene-blocks/（live " + live + " → " + (live + 1) + "）",
									"写一条 restore 账目",
									"恢复要占一个 maxScenes 名额：" + live + " + 1，上限 " + d.maxScenes,
								];
					self.setOp(row, "预演通过（前置条件都满足）。确认后才会真正写盘。", "", d, items, true, "预演原始返回");
				});
			},

			/**
			 * 第二步：确认后执行（apply:true）。
			 * 确认框与预演说的是同一件事 —— 只是提前到"按下之前"；成功后就重新加载整页，
			 * 让块表 / 账本 / 对账反映新状态。
			 */
			blockApply: function (row) {
				var self = this;
				var op = row.archived ? "restore" : "archive";
				var st = this.opOf(row.filename);
				var reason = String(st.reason || "").trim();
				if (op === "archive" && !reason) {
					this.setOp(row, "归档必须写原因（审计凭据），请先填上面的输入框再预演。", "warn");
					return;
				}
				return V.vue
					.confirm("确认" + (op === "archive" ? "归档" : "恢复") + "「" + row.filename + "」？\n\n" + APPLY_CAVEAT[op], op === "archive" ? "归档场景块" : "恢复场景块")
					.then(function (yes) {
						if (!yes) return null;
						var body = { filename: row.filename, apply: true };
						if (reason) body.reason = reason;
						st.busy = true;
						st.running = true;
						// 长任务期间整行置灰（`.ops-row.busy`）＝按钮禁用 + "正在执行…"，两者的显隐
						// 都在被重渲染的单元格里，所以这里必须让表格重算一次。
						self.bumpOp();
						return V.bridge(EP[op], { method: "POST", body: JSON.stringify(body) }).then(function (r) {
							var d = (r && r.data) || {};
							var ok = r && r.ok && d.success !== false;
							st.running = false;
							if (!ok) {
								st.busy = false;
								self.setOp(row, "执行失败：" + self.esc(self.bridgeError(r)), "err", d);
								return null;
							}
							self.setOps(
								"已" + (op === "archive" ? "归档" : "恢复") + "「" + self.esc(row.filename) + "」" +
									(d.members === undefined ? "" : "（" + d.members + " 个成员随之保留）") +
									"。页面正在重新加载，以反映新的块分布与账本。",
								"",
								d,
							);
							return self.loadAll();
						});
					});
			},
		},
		template: /* html */ `
		<header class="page">
			<h1>L2 场景层</h1>
			<!-- 只列区块；「权威 vs 派生」那句方法论侧栏里已折叠成一份，页头不重复 -->
			<p class="sub">场景块（live + 归档）· 成员侧车 · 归档账本 · 对账。</p>
			<notice :msg="loadNote"></notice>
			<div class="toolbar">
				<el-input v-model="q" clearable placeholder="搜索块名 / summary / 成员 id …" class="grow" />
			</div>
		</header>

		<main>
			<aside>
				<h2>概览</h2>
				<stat-list :rows="statRows"></stat-list>

				<h2>块数上限（l2.maxScenes）<help-note v-if="config" :text="capHelp" raw></help-note></h2>
				<div class="budget">
					<div class="track"><i :class="gradeClass" :style="{ width: gradePct + '%' }"></i></div>
					<div class="meta"><span>{{ isEnglish ? liveCount + ' / ' + (maxScenes === null ? '?' : maxScenes) + ' live blocks' : liveCount + ' / ' + (maxScenes === null ? '?' : maxScenes) + ' 个 live 块' }}</span><span>{{ gradeText }}</span></div>
				</div>
				<!-- 读不到配置是失败态，留在页面上；能读到时的口径注解进问号 -->
				<div class="hint" v-if="!config" v-html="capError"></div>

				<h2>L2 管理</h2>
				<div v-if="!hasPort()" class="hint" v-html="readOnlyHint"></div>
				<!-- 管理动作按用途分组：读报告、维护统一场景名称。表格进弹层，侧栏只留简短说明和入口。 -->
				<!-- ⚠ 模板里**不许出现反引号**（这句注释本身就踩过一次）：JS 模板字符串用反引号
				     定界，注释里的反引号会提前把它闭合，后面半截模板会当成 JS 执行 —— 症状是
				     整页空白 + ReferenceError: row is not defined，而 new Function 语法检查照样通过
				     （漏出来那截恰好是合法语句时）。门禁 ⑨ 现在断言模板内部没有第二个反引号。 -->
				<div class="l2-admin-tools">
					<section class="l2-tool-card">
						<h3>查看报告</h3>
						<p>查看场景当前状态，或查看系统建议合并的相似场景。报告按需生成。</p>
						<div class="l2-tool-actions">
							<el-button :disabled="!hasPort()" @click="openReport('report')">场景概况</el-button>
							<el-button :disabled="!hasPort()" @click="openReport('merge')">合并建议</el-button>
						</div>
					</section>
					<section class="l2-tool-card">
						<h3>统一场景名称</h3>
						<p>把几个历史名称归到同一个名称下。先预演查看变更，确认后保存；保存前会自动备份原设置。</p>
						<el-button :disabled="!hasPort()" @click="seedOpen = true">编辑名称对应关系</el-button>
					</section>
				</div>

				<!-- 契约三段（块数预算 / 恢复要先腾位 / 归档≠删除）是长解释，默认收起：
				     它们描述"为什么会被拒"，只有真被拒时才需要读。 -->
				<h3 class="sub">契约</h3>
				<el-collapse v-model="contractOpen">
					<el-collapse-item name="contract" :title="isEnglish ? 'Block limit / make room before restoring / archive is not delete' : '块数预算 / 恢复要先腾位 / 归档 ≠ 删除'">
						<div class="hint" v-html="contractHtml"></div>
					</el-collapse-item>
				</el-collapse>

				<div v-if="opsNote.html">
					<notice :msg="opsNote"></notice>
					<json-details v-if="opsNote.json !== null" :summary="opsNote.jsonSummary" :value="opsNote.json"></json-details>
				</div>

				<!-- 水位"用来判什么"是静态口径 → 问号；游标值本身（两行数据）留在页面上 -->
				<h2>L2 游标水位<help-note text="水位用于「有哪些 L1 记录还没进任何场景块」的判定（见下方未归属统计）。"></help-note></h2>
				<div class="hint" v-html="cursorHtml"></div>

				<!-- 这四段是方法论（谁是权威源、归档为什么不是删除），默认收起 ——
				     侧栏原本 1,903px 高、要滚 1,049px 才看得见下面的内容，大半是这段。 -->
				<h2>权威 / 派生的分工</h2>
				<el-collapse v-model="authorityOpen">
					<el-collapse-item name="authority" :title="isEnglish ? 'Authoritative data / why the index is derived / archive is not delete' : '权威源是哪些 / 索引为什么是派生 / 归档 ≠ 删除'">
						<div class="hint" v-if="!isEnglish">
							<p><b>权威</b>：块文件正文与 META、两份 <code>scene_members.json</code> 侧车、
							<code>archive/ledger.jsonl</code>（append-only，不可重建）。</p>
							<p><b>派生</b>：<code>index/scene_index.json</code> —— 每次提交都从块文件<b>全量重建</b>，
							所以只存在于索引里的字段下次重建就没了；它的 <code>members</code> 也是从侧车并进去的。</p>
							<p>因此「数成员」一律以侧车为准；索引与侧车不一致时会显示为告警。</p>
							<p><b>归档 ≠ 删除</b>：归档把块搬到与 <code>scene-blocks/</code> 平级的 <code>archive/</code>
							（不占 maxScenes 名额），有账、可 restore；<code>delete</code> 才是真的消失、且不留痕。</p>
						</div>
						<div class="hint" v-else>
							<p><b>Authoritative data</b>: block content and META, both <code>scene_members.json</code> sidecars, and <code>archive/ledger.jsonl</code> (append-only and cannot be rebuilt).</p>
							<p><b>Derived data</b>: <code>index/scene_index.json</code> is rebuilt from all block files on every commit. Fields that exist only in the index are lost on the next rebuild; member lists are also merged from the sidecars.</p>
							<p>Always use the sidecars as the source of truth for member counts. A mismatch between the index and sidecar is shown as a warning.</p>
							<p><b>Archive is not delete</b>: archiving moves a block to <code>archive/</code> beside <code>scene-blocks/</code> (it does not use a <code>maxScenes</code> slot). The move is recorded and can be restored; <code>delete</code> permanently removes the block without a record.</p>
						</div>
					</el-collapse-item>
				</el-collapse>
			</aside>

			<section class="content">
				<h2>对账结果</h2>
				<notice v-for="(n, i) in reconNotices" :key="i" :msg="n"></notice>

				<h2>场景块</h2>
				<!-- 列宽口径：六列相加 858px（min-width 的「块文件」吸收余量），落在 1280 视口下内容列的
				     894px 里 —— 列宽之和超过容器会让 el-table 自己长出一条横向滚动条，而"一层只有一条
				     滚动轴"是设计契约 3。旧版固定列 heat/成员/updated + 自适应 summary 的比例相同。
				     行内的归档 / 恢复动作**留在行上**：它是行内动作的合理形态（点行仍打开详情，
				     操作格里已 @click.stop）。 -->
				<el-table
					:data="visibleRows"
					size="small"
					row-key="filename"
					class="fixed-rows"
					:row-style="rowStyle"
					:empty-text="loaded ? '暂无数据' : '尚未加载'"
					@row-click="onRowClick"
				>
					<el-table-column label="块文件" min-width="190">
						<template #default="{ row }">
							<!-- 文件名单行省略（全文走 title 悬停）：长中文文件名折行会把行撑高，
							     而行高不一致的表格没法扫读。后面的胶囊保持在行内。 -->
							<div class="cell-line">
								<span class="ellipsis" :title="row.filename">{{ row.filename }}</span>
								<chip v-if="row.noMeta" label="无 META"></chip>
								<chip v-if="row.archived" label="已归档"></chip>
							</div>
						</template>
					</el-table-column>
					<el-table-column label="heat" width="52" align="right" class-name="mono">
						<template #default="{ row }">{{ row.heat }}</template>
					</el-table-column>
					<el-table-column :label="isEnglish ? 'Members' : '成员'" width="72" align="right" class-name="mono">
						<template #default="{ row }">{{ row.memberCount }}</template>
					</el-table-column>
					<el-table-column label="updated" width="90" class-name="nowrap">
						<template #default="{ row }">{{ row.updated }}</template>
					</el-table-column>
					<el-table-column label="summary" width="180">
						<template #default="{ row }">
							<div class="ellipsis" :title="row.summary">{{ row.summary }}</div>
						</template>
					</el-table-column>
					<el-table-column label="操作" width="290">
						<template #default="{ row }">
							<!-- 操作格自己有点击语义（原因输入 / 按钮 / 预演结果），点它不该再弹详情 -->
							<div @click.stop>
								<template v-if="hasPort()">
									<div class="cell-actions">
										<el-input
											v-model="row.op.reason"
											size="small"
											style="flex: 1 1 110px"
											:disabled="row.op.busy"
											:placeholder="row.archived ? '恢复原因（可选，写入账本）' : '归档原因（必填，写入账本）'"
										/>
										<!-- 行上这颗是**预演**（点了只出裁决与账本预览，落盘要再点弹出来的「确认执行」），
										     所以两行都是默认的「文字动作」；danger/primary 留给真正改盘的确认按钮。 -->
										<el-button size="small" :disabled="row.op.busy" @click="blockPreview(row)">{{ row.archived ? "恢复（预演）" : "归档（预演）" }}</el-button>
									</div>
									<div v-if="row.op.html" :class="row.op.level ? 'notice ' + row.op.level : 'hint'" v-html="row.op.html"></div>
									<ul v-if="row.op.items.length" class="hint">
										<li v-for="(it, i) in row.op.items" :key="i">{{ it }}</li>
									</ul>
									<el-button
										v-if="row.op.canApply"
										size="small"
										:type="row.archived ? 'primary' : 'danger'"
										:disabled="row.op.busy"
										@click="blockApply(row)"
									>确认执行{{ row.archived ? "恢复" : "归档" }}</el-button>
									<div v-if="row.op.running" class="hint">正在执行…（实写：取 L2 运行锁 → 自愈 → 搬块 → 重建索引；桥在此期间不响应别的请求）</div>
									<json-details v-if="row.op.json !== null" :summary="row.op.jsonSummary" :value="row.op.json"></json-details>
								</template>
								<span v-else class="hint">写回需 <code>?port=</code></span>
							</div>
						</template>
					</el-table-column>
				</el-table>

				<h2>归档 / 恢复账本（时间线）</h2>
				<div v-if="!ledgerRows.length" class="hint">账本为空（还没有归档/恢复事件）。</div>
				<div v-else class="timeline">
					<div v-for="(e, i) in ledgerRows" :key="i" class="tl-item" :class="e.cls">
						<span class="chip">{{ e.label }}</span>
						<b>{{ e.filename }}</b>
						<div class="when">{{ e.when }}</div>
						<div class="hint">{{ e.reason }}</div>
					</div>
				</div>

				<h2>成员归属反查</h2>
				<div v-if="loaded && ownerTotal === 0" class="hint">{{ isEnglish ? 'No member records.' : '没有成员记录。' }}</div>
				<div v-else-if="!loaded" class="hint">尚未加载</div>
				<template v-else>
					<div class="hint">{{ isEnglish ? ownerTotal + ' member IDs are assigned and searchable on this page. Select a block above to view its member list.' : '共 ' + ownerTotal + ' 个成员 id 有归属（全部在页面内可搜）。点上方块行查看该块的实际成员清单。' }}</div>
					<el-table :data="visibleOwners" size="small" max-height="260" class="fixed-rows">
						<el-table-column :label="isEnglish ? 'L1 record ID' : 'L1 记录 id'" min-width="220" class-name="mono">
							<template #default="{ row }"><div class="ellipsis" :title="row.id">{{ row.id }}</div></template>
						</el-table-column>
						<el-table-column label="所属块" min-width="220">
							<template #default="{ row }"><div class="ellipsis" :title="row.file">{{ row.file }}</div></template>
						</el-table-column>
					</el-table>
					<div v-if="ownerTotal > 300" class="hint">只列前 300 条。</div>
				</template>
			</section>
		</main>

		<el-dialog v-model="detailOpen" class="viewer-dialog" width="940px" :title="detail ? detail.filename : ''">
			<template v-if="detail">
				<div class="chips">
					<chip v-if="detail.blk" :label="'heat ' + detail.blk.meta.heat"></chip>
					<chip v-else kind="err" label="文件读不到"></chip>
					<chip :label="'成员 ' + detail.members.length"></chip>
					<chip v-if="detail.blk && detail.blk.meta.created" :label="'created ' + fmtDay(detail.blk.meta.created)"></chip>
					<chip v-if="detail.blk && detail.blk.meta.updated" :label="'updated ' + fmtDay(detail.blk.meta.updated)"></chip>
					<chip v-if="detail.sidecar" label="成员来源：scene_members.json（权威）"></chip>
					<chip v-else kind="merged" label="成员来源：索引（侧车缺本条）"></chip>
					<chip v-if="detail.archived" label="已归档"></chip>
				</div>
				<p v-if="detail.summary" style="margin: 10px 0 0">{{ detail.summary }}</p>
				<notice v-if="!detail.blk" :msg="detail.missingNote"></notice>
				<el-collapse v-if="detail.blk || detail.members.length" v-model="detailPanels">
					<el-collapse-item v-if="detail.blk" name="body" :title="'正文（' + detail.bodyLen + ' 字符）'">
						<div class="wrap-any" v-html="detail.bodyHtml"></div>
					</el-collapse-item>
					<el-collapse-item v-if="detail.members.length" name="members" :title="'成员清单（' + detail.members.length + '）'">
						<el-table :data="detail.members" size="small">
							<el-table-column :label="isEnglish ? 'L1 record ID' : 'L1 记录 id'" min-width="240" class-name="mono">
								<template #default="{ row }">{{ row.id }}</template>
							</el-table-column>
							<el-table-column label="" width="120">
								<template #default><a :href="recordsHref">在 L1 页搜</a></template>
							</el-table-column>
							<el-table-column label="正文兜底" width="130">
								<template #default="{ row }">
									<span v-if="row.inBody">在正文中</span>
									<chip v-else kind="merged" label="正文里没有"></chip>
								</template>
							</el-table-column>
						</el-table>
					</el-collapse-item>
				</el-collapse>
			</template>
			<template #footer>
				<el-button @click="detailOpen = false">关闭</el-button>
			</template>
		</el-dialog>

		<!-- 场景池报告（只读、按需生成）：几千字的 CLI 文本在 336px 侧栏里读不下来，
		     所以结果进弹层；点侧栏那颗按钮=打开弹层并开始生成（与旧版同一拍）。
		     生成期间桥被整座占满 —— "别重复点"这句话因此放在弹层里最显眼的位置。 -->
		<el-dialog v-model="reportOpen" :title="reportKind === 'merge' ? '合并报告（场景池）' : '场景池报告'" width="1000px" top="6vh" class="viewer-dialog">
			<div class="ops">
				<div class="hint">报告可能调用 embedding，要几秒到更久；桥是单线程同步执行 —— 生成期间整座桥都不响应请求，别重复点。</div>
				<div v-if="report.busy" class="hint">生成中…（桥在此期间不响应其他请求）</div>
				<notice v-if="report.html" :msg="{ html: report.html, level: report.level }"></notice>
				<template v-if="report.text !== null">
					<div class="hint">{{ report.textSummary }}</div>
					<pre class="log-text">{{ report.text }}</pre>
				</template>
				<json-details v-if="report.json !== null" summary="原始返回" :value="report.json"></json-details>
			</div>
			<template #footer>
				<el-button :disabled="report.busy || !hasPort()" @click="runReport(reportKind)">重新生成</el-button>
				<el-button @click="reportOpen = false">关闭</el-button>
			</template>
		</el-dialog>

			<!-- 映射编辑：每行把一个统一名称与历史名称对应起来。 -->
			<el-dialog v-model="seedOpen" title="统一场景名称" width="1000px" top="6vh" class="viewer-dialog">
			<div class="ops">
					<p class="scene-map-intro">每行填写一个现在要使用的名称，再列出它过去用过的名称。先检查变更，确认后保存；保存前会自动备份当前设置。</p>
					<div class="scene-map-toolbar">
						<el-button :disabled="!hasPort() || busy === 'seed'" @click="seedAddRow">添加一行</el-button>
						<div class="scene-map-actions">
							<el-button :disabled="!hasPort() || busy === 'seed'" @click="seedRun(false)">预演变更</el-button>
							<el-button type="primary" :disabled="!hasPort() || busy === 'seed' || !seedPreviewed" @click="seedRun(true)">保存名称设置</el-button>
						</div>
					</div>
					<div v-if="busy === 'seed'" class="hint">正在处理场景名称…</div>
				<el-table :data="seedRows" size="small" empty-text="还没有行">
						<el-table-column label="统一名称" min-width="240">
						<template #default="{ row }">
								<el-input v-model="row.name" size="small" placeholder="填写统一名称" />
						</template>
					</el-table-column>
						<el-table-column label="过去用过的名称（逗号分隔）" min-width="340">
						<template #default="{ row }">
								<el-input v-model="row.aliases" size="small" placeholder="旧名称 1, 旧名称 2" />
						</template>
					</el-table-column>
						<el-table-column label="说明（可选）" min-width="240">
						<template #default="{ row }">
							<el-input v-model="row.note" size="small" placeholder="备注（可选）" />
						</template>
					</el-table-column>
					<el-table-column width="96">
						<template #default="{ $index }">
							<el-button size="small" @click="seedRemove($index)">移除</el-button>
						</template>
					</el-table-column>
				</el-table>
				<notice v-if="seedOut.html" :msg="{ html: seedOut.html, level: seedOut.err ? 'err' : '' }"></notice>
				<details v-if="seedOut.log" class="log" open>
					<summary>{{ seedOut.log.summary }}</summary>
					<pre class="log-text">{{ seedOut.log.text }}</pre>
				</details>
			</div>
			<template #footer>
				<el-button @click="seedOpen = false">关闭</el-button>
			</template>
		</el-dialog>
		`,
	};

	V.vue.mount(PAGE, { active: "l2-viewer.html" });
})();
