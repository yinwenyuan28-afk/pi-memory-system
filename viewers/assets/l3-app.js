/*
 * viewers/assets/l3-app.js —— L3 画像层页面 · Vue 3 + Element Plus 版
 *
 * 依赖：viewer-core.js（window.V）、viewer-vue.js（V.vue）。本页不涉及质量分，不加载 quality-core。
 *
 * 这一页展示三份"§ 分隔的条目文件"与 L3 游标：
 *   · `MEMORY.md`（{profile} 根；由 core/store 维护，不是 L3 产物）
 *   · `USER.md`（live 画像 —— **L3 自 2026-09-28 起只读它**，不再直接改）
 *   · `USER-temp.md`（L3 的**提议稿**；合并进 live 是人工动作）
 *
 * ── 口径必须与源码一致，否则这一页会给出错的结论 ──
 *
 * 1. **字符预算**用的是 `memory/l3/entries.ts` 的 `entryBudget`：`sum(条目长度) + 3 × (条目数-1)`
 *    （分隔符按 LF 的 `\n§\n` 计 3 字符）。它**不是文件字节数** —— 中文 1 字符 3 字节，
 *    实测 USER.md 磁盘 4745 字节但预算只有 1921/2200。用字节数会得出"严重超限"的错误结论。
 * 2. **解析**按 `/\r?\n§\r?\n/` 切分（磁盘是 CRLF），trim 后丢空。
 *    注意：**文件若以 `§` 开头，那个 `§` 不会被切掉**，会粘进第一条正文 —— 这是真实存在的
 *    历史写入形态，本页把它作为异常标出来（否则读者会把"§\r\nxxx"当成正常条目）。
 * 3. **上限**（2200 / 500 / 30）从 `/api/limits` 取（由源码常量透出），页面不硬编码。
 *
 * ── 管理操作区（本页是全查看器唯一能改画像的地方，纪律写在代码附近）─────────
 *
	 * 写动作全部经桥转发到 `scripts/l1-admin/*.mts`。条目增删改遵循"预览 → 弹窗确认 → 执行"：
 *   · 条目增删改 → `USER-temp.md`（**提议稿**，不是 live）；要生效须再走"并入"；
 *   · 备份还原 → 目标也是 `USER-temp.md`（备份名不记当时捕的是哪份，统一落到 L3 唯一写目标）；
	 *   · 并入 live → 默认只追加新条目；显式完整替换时，服务端三道安全闸（陈旧 / 过半删除 / 清空）
	 *     默认拒绝，页面只把拒绝原文回显，并把**对应的放行勾选框**在拒绝之后才显示（绝不预勾）。
 * 注：运行中的 pi 会话注入的是**冻结快照**，并入后要 `/reload` 或新开会话才读到新画像。
 *
 * ── Vue 版与旧版的差别（只列会影响行为的）──────────────────────────────────
 *
 * 1. 手写 DOM（`$()` / `innerHTML` / 事件委托）换成响应式数据 + computed；外壳控件换成 Element Plus
 *    （el-button / el-input / el-checkbox / el-collapse）。**端点、请求体、判定条件、文案一字未改**。
 * 2. 条目清单与画像备份清单**各只有一份**：旧版曾把同源数据渲染两遍（`#entries`/`#opsEntries`、
 *    `#backups`/`#opsBackups`），改写 / 删除 / 预览 / 还原这些动作并进那唯一一份的行上。
 *    定位片段改为由行直接传入（旧版靠 `data-idx` 回查 `entryLists`；下标与列表错位就会改错条目，
 *    那条风险随之下线）。
 * 3. **MEMORY 组不给改写 / 删除按钮**（原样保留）：写动作恒定落到 `USER-temp.md`，
 *    给 MEMORY 加按钮就是给一个必然写错地方的按钮。
 * 4. 还原多一道 `V.vue.confirm`（不可逆写盘动作的统一纪律，理由见 viewer-vue.js 的说明）；
 *    打字确认文件名与 `/api/l3/restore` 的 `confirm` 字段一字未动。
 * 5. 「加载中」与「读不到」仍是两种状态：首次取数完成（loaded）之前不写任何结论，也不编造空态。
 *
 * 页面沿用的**共享样式类**（`.ops` / `.ops-row` / `.ops-label` / `.ops-ctl` / `.ops-note` /
 * `.danger-zone` / `.diff-list` / `.confirm-token`）与旧版 viewer.css 同名 —— 本页只写类名，
 * 样式待收进 viewer-theme.css（见交付报告第 5 节）。
 */
(function () {
	"use strict";

	var V = window.V;
	var isEnglish = window.ViewerI18n && window.ViewerI18n.locale === "en";

	/** 端点字面量集中一处：静态校验按字面量核对桥里是否声明（gate ⑬），拼串会漏检。 */
	var EP = {
		limits: "/api/limits",
		backups: "/api/l3/backups",
		profileFiles: "/api/profile-files",
		edit: "/api/l3/edit",
		restore: "/api/l3/restore",
		merge: "/api/l3/merge",
	};

	/** 三份画像文件的固定口径（条目清单 / 预算条 / 差异都按这个顺序读）。 */
	var FILE_KEYS = ["MEMORY", "USER", "temp"];
	var FILE_META = {
		MEMORY: { field: "MEMORY.md", label: "MEMORY.md", note: "全局记忆", limitKey: "memoryCharLimit", budgetSuffix: "" },
		USER: { field: "USER.md", label: "USER.md", note: "用户画像稳定层，注入的是该文件", limitKey: "userCharLimit", budgetSuffix: "" },
		temp: { field: "USER-temp.md", label: "USER-temp.md", note: "用户画像临时层，需人工合并到稳定层", limitKey: "userCharLimit", budgetSuffix: "，提议稿" },
	};

	/** 并入区三道安全闸的文案（服务端按 ①陈旧 → ③清空 → ②过半 的顺序裁决；页面按下面的顺序陈列）。 */
	var GATE_LABELS = {
		stale: "仍要并入：允许用比 live 旧的提议稿覆盖（live 之后被改过，会丢掉那些改动）",
		mass: "仍要删除：同意一次删掉 live 过半条目",
		empty: "仍要清空：同意把 live 画像清空",
	};

	/** 与 entries.ts 的 parseUserFile 同口径：按 /\r?\n§\r?\n/ 切、trim、丢空。 */
	function parseEntries(raw) {
		if (raw === null || raw === undefined || String(raw).trim() === "") return [];
		return String(raw)
			.split(/\r?\n§\r?\n/)
			.map(function (p) {
				return p.trim();
			})
			.filter(Boolean);
	}

	/** 与 entries.ts 的 entryBudget 同口径（LF 分隔符按 3 字符计）。 */
	function entryBudget(entries) {
		if (entries.length === 0) return 0;
		return entries.reduce(function (sum, e) { return sum + e.length; }, 0) + 3 * (entries.length - 1);
	}

	/**
	 * 逐条自检。每一条都是"能被这页看到、且真的会出问题"的形态，不是凑数的校验：
	 *   · 首条以 § 开头 → 文件开头多了一个分隔符，那个 § 会粘进正文（实测 USER-temp.md 就是）
	 *   · 条目内含换行 → 违反"单条必须单行"的契约（整篇重写就是从这里溜进来的）
	 *   · 条目超长 → 超过 entryCharLimit 会被 l3_edit 拒绝
	 *   · 重复条目 → 同一句写了两遍，白占预算
	 *
	 * 注：旧版判定用 `state.limits.entryCharLimit`（limits 存在但缺该字段时是 undefined → 永不报超长），
	 * 文案却用 `|| 500`；两处口径不一致是旧版的疏漏，这里统一用同一个数。
	 */
	function inspectEntries(entries, entryCharLimit) {
		var issues = [];
		if (entries.length > 0 && entries[0].indexOf("§") === 0) {
			issues.push({ level: "warn", text: isEnglish ? "The first entry starts with §. An extra separator is at the start of the file, and the § plus its line break became part of the first entry." : "首个条目以 § 开头 —— 文件开头多了一个分隔符，那段 §（连同换行）已被并进第一条正文。" });
		}
		entries.forEach(function (e, i) {
			if (/\r?\n/.test(e)) issues.push({ level: "warn", text: isEnglish ? "Entry " + (i + 1) + " contains a line break. Each entry must be a single line." : "第 " + (i + 1) + " 条含换行 —— 条目必须是单行（单条契约）。" });
			if (e.length > entryCharLimit) issues.push({ level: "warn", text: isEnglish ? "Entry " + (i + 1) + " has " + e.length + " characters, above the per-entry limit of " + entryCharLimit + "; l3_edit will reject it." : "第 " + (i + 1) + " 条 " + e.length + " 字符，超过单条上限 " + entryCharLimit + "，l3_edit 会拒绝写入。" });
		});
		var seen = new Map();
		entries.forEach(function (e, i) {
			var prev = seen.get(e);
			if (prev !== undefined) issues.push({ level: "warn", text: isEnglish ? "Entries " + (prev + 1) + " and " + (i + 1) + " are exact duplicates." : "第 " + (prev + 1) + " 条与第 " + (i + 1) + " 条完全重复。" });
			else seen.set(e, i);
		});
		return issues;
	}

	/** 变更差异清单（还原 / 并入共用）：加了几条、删了几条 + 逐条增删。 */
	function diffHtml(added, removed, addedTotal, removedTotal) {
		var a = Array.isArray(added) ? added : [];
		var rm = Array.isArray(removed) ? removed : [];
		var aT = typeof addedTotal === "number" ? addedTotal : a.length;
		var rT = typeof removedTotal === "number" ? removedTotal : rm.length;
		var en = window.ViewerI18n && window.ViewerI18n.locale === "en";
		var html =
			'<div class="chips"><span class="chip">' + (en ? "Adds " + aT + " entries" : "会加 " + aT + " 条") + "</span>" +
			'<span class="chip">' + (en ? "Removes " + rT + " entries" : "会删 " + rT + " 条") + "</span></div>";
		if (a.length || rm.length) {
			html += '<ul class="diff-list">';
			html += a.map(function (t) { return '<li class="add">' + V.escapeHtml(t) + "</li>"; }).join("");
			if (aT > a.length) html += '<li class="more">' + (en ? (aT - a.length) + " more not shown" : "另有 " + (aT - a.length) + " 条未列出") + "</li>";
			html += rm.map(function (t) { return '<li class="del">' + V.escapeHtml(t) + "</li>"; }).join("");
			if (rT > rm.length) html += '<li class="more">' + (en ? (rT - rm.length) + " more not shown" : "另有 " + (rT - rm.length) + " 条未列出") + "</li>";
			html += "</ul>";
		} else {
			html += '<div class="hint">' + (en ? "No entry changes (only line endings or the final newline may differ)." : "条目没有差异（可能只改了行尾 / 结尾换行）。") + "</div>";
		}
		return html;
	}

	/** V.note 的等价物：包一层提示条（并入区的输出块里会连着出现两条，所以拼在同一个字符串里）。 */
	function noticeHtml(html, level) {
		return '<div class="notice' + (level ? " " + level : "") + '">' + html + "</div>";
	}

	/** 把拒绝原文映射到它触发的安全闸（服务端按 ①陈旧 → ③清空 → ②过半 的顺序裁决）。 */
	function mergeGateFromError(msg) {
		if (/比 live 画像旧/.test(msg)) return "stale";
		if (/清空/.test(msg)) return "empty";
		if (/过半/.test(msg)) return "mass";
		return null;
	}

	/**
	 * 预算条（字符用量 / 上限）。领域形状，Element Plus 的进度条表达不了
	 * "超限换 danger 色 + 右侧写清 used / limit / 百分比"这套口径。
	 *
	 * @prop label   左侧文案（含条目数）
	 * @prop entries 条目数组（used 由 entryBudget 现算，不接受页面传进来的数字）
	 * @prop limit   上限（来自 /api/limits）
	 * @prop note    文件用途说明，收在标签旁的 tooltip 中
	 */
	var BudgetBar = {
		name: "BudgetBar",
		props: {
			label: { type: String, default: "" },
			entries: { type: Array, default: function () { return []; } },
			limit: { type: Number, default: 0 },
			note: { type: String, default: "" },
		},
		computed: {
			used: function () { return entryBudget(this.entries); },
			/** 条形宽度封顶 100%（超限由颜色表达，不把条撑出容器） */
			pct: function () { return this.limit > 0 ? Math.min(100, Math.round((this.used / this.limit) * 100)) : 0; },
			over: function () { return this.used > this.limit; },
		},
		template: /* html */ `
			<div class="budget">
				<div class="meta"><span>{{ label }}<help-note v-if="note" :text="note"></help-note></span><span>{{ used.toLocaleString() }} / {{ limit.toLocaleString() }} 字符（{{ pct }}%）</span></div>
				<div class="track"><i :class="{ over: over }" :style="{ width: pct + '%' }"></i></div>
			</div>
		`,
	};

	// ── 页面 ────────────────────────────────────────────────────────────────

	var PAGE = {
		components: { BudgetBar: BudgetBar },
		mixins: [V.vue.pageMixin],
		data: function () {
			return {
				isEnglish: isEnglish,
				/** l3/cursor.json（null = 没读到；与"读到了但某个字段为空"分开表达） */
				cursor: null,
				/** l3/pending-trigger.json 的**文件内容**（不是待消费信号列表；见 fetchAll 里的注释） */
				pending: null,
				/** /api/limits 的 data.l3（阈值与触发间隔；无桥时为 null） */
				limits: null,
				/** /api/l3/backups 的 data.backups */
				backups: [],
				/** /api/profile-files 的三件套：key → {raw, label, note}（raw=null 表示这一份没读到） */
				files: {},
				profileFilesAvailable: false,
				/** 首次取数是否完成：「加载中」与「读不到」必须是两种状态，不能合并 */
				loaded: false,

				/** 侧栏说明 / 两个折叠区（默认收起） */
				helpOpen: [],
				entriesOpen: [],
				backupsOpen: [],
				userOnlyOpen: [],

				/** 条目写动作的分步状态：action ∈ add/update/delete；target 是 update/delete 的定位片段 */
				editOp: { action: "add", target: null, previewed: false },
				editContent: "",
				editOut: { html: "", level: "" },

				/** 还原中的备份文件与放行状态（gateEmpty = 服务端报"空备份会清空"这道闸） */
				restoreOp: { file: null, previewed: false, gateEmpty: false, allowEmpty: false },
				restoreConfirm: "",
				restoreDiff: "",
				restoreMsg: { html: "", level: "" },

				/** 并入状态：revealed = 服务端拒绝暴露出的安全闸（放行勾选框按它出现）；gates = 已勾选放行项 */
				mergeOp: { previewed: false, revealed: {}, gates: {} },
				mergeStrategy: "add",
				mergeConfirm: "",
				mergeOut: "",

				/** 备份预览的展开状态：file → {loading, missing, text, count}（每行一份，与旧版同款） */
				previews: {},

				/** 安全闸文案（模板里直接按 key 取） */
				gateLabels: GATE_LABELS,
			};
		},
		computed: {
			userEntries: function () { return parseEntries(this.files.USER ? this.files.USER.raw : null); },
			tempEntries: function () { return parseEntries(this.files.temp ? this.files.temp.raw : null); },

			/** 单条上限（页面上那句"必须单行、不含 §、N 字符以内"与自检共用同一个数） */
			entryCharLimit: function () {
				return (this.limits && this.limits.entryCharLimit) || 500;
			},

			/** 三份文件的展示口径（标签 / 条目 / 上限 / 自检结果）—— 条目清单与预算条的唯一数据源 */
			fileGroups: function () {
				var self = this;
				var limits = this.limits || {};
				return FILE_KEYS.map(function (k) {
					var meta = FILE_META[k];
					var list = parseEntries(self.files[k] ? self.files[k].raw : null);
					return {
						key: k,
						label: meta.label,
						note: meta.note,
						list: list,
						readonly: k === "MEMORY",
						limit: typeof limits[meta.limitKey] === "number" ? limits[meta.limitKey] : 2200,
						budgetLabel: isEnglish ? meta.label + " (" + list.length + (meta.budgetSuffix ? " draft entries" : " entries") + ")" : meta.label + "（" + list.length + " 条" + meta.budgetSuffix + "）",
						issues: inspectEntries(list, self.entryCharLimit),
					};
				});
			},

			/** 三份文件的全部自检异常（前缀文件标签，逐条渲染成 warn 提示条） */
			allIssues: function () {
				var out = [];
				this.fileGroups.forEach(function (g) {
					g.issues.forEach(function (i) {
						out.push({ level: i.level, text: g.label + "：" + i.text });
					});
				});
				return out;
			},
			issueNotices: function () {
				var self = this;
				return this.allIssues.map(function (i) { return { level: i.level, html: self.esc(i.text) }; });
			},
			noIssuesMsg: function () {
				return { html: isEnglish ? "All entries in the three files passed validation." : "三份文件逐条自检无异常。", level: "" };
			},
			profileFilesMsg: function () {
				return {
					html: isEnglish
						? "<b>Profile files unavailable</b>: <code>MEMORY.md</code>, <code>USER.md</code>, and <code>USER-temp.md</code> are in the profile root (one level above <code>memoryDB</code>), while the viewer bridge only mounts <code>memoryDB</code>. Open the page through the bridge; its allowlisted <code>/api/profile-files</code> endpoint reads these files. Counts below are unavailable."
						:
						"<b>读不到画像文件</b>：<code>MEMORY.md</code> / <code>USER.md</code> / <code>USER-temp.md</code> " +
						"位于 profile <b>根</b>目录（<code>memoryDB</code> 的上一级），而写盘桥只挂载 <code>memoryDB</code>。" +
						"请用桥打开 —— 端点 <code>/api/profile-files</code> 会按白名单读取它们；下面的数字因此不可信。",
					level: "warn",
				};
			},

			/** 差异：temp 里独有 = 待合入的提议；live 里独有 = temp 未覆盖到的现存规则 */
			tempOnly: function () {
				var live = this.userEntries;
				return this.tempEntries.filter(function (e) { return live.indexOf(e) < 0; });
			},
			userOnly: function () {
				var temp = this.tempEntries;
				return this.userEntries.filter(function (e) { return temp.indexOf(e) < 0; });
			},

			/** 逐条清单的折叠标题（全页唯一一份，动作在行上） */
			entriesTitle: function () {
				var g = this.fileGroups;
				if (isEnglish) return "Show " + (g[0].list.length + g[1].list.length + g[2].list.length) + " entries (MEMORY " + g[0].list.length + " · USER " + g[1].list.length + " · temp " + g[2].list.length + "; edit or delete entries inline)";
				return "展开 " + (g[0].list.length + g[1].list.length + g[2].list.length) +
					" 条（MEMORY " + g[0].list.length + " · USER " + g[1].list.length +
					" · temp " + g[2].list.length + "，改写 / 删除在行上）";
			},
			backupsTitle: function () {
				if (isEnglish) return this.backups.length ? "Show " + this.backups.length + " backups (preview or restore inline)" : "No backups found (or the viewer bridge is unavailable)";
				return this.backups.length ? "展开 " + this.backups.length + " 份（预览 / 还原在行上）" : "没有备份（或未用写盘桥）";
			},
			/** 备份按时间倒序展示（最新的在最上面） */
			backupRows: function () {
				return this.backups.slice().reverse();
			},

			editTitle: function () {
				if (this.editOp.action === "delete") return "删除临时画像条目";
				if (this.editOp.action === "update") return "改写临时画像条目";
				return "新增临时画像条目";
			},
			applyEditLabel: function () {
				if (this.editOp.action === "delete") return "从临时层删除";
				if (this.editOp.action === "update") return "保存修改到临时层";
				return "添加到临时层";
			},
			contentNote: function () {
				if (isEnglish) return this.loaded ? "One line, no §, up to " + this.entryCharLimit + " characters." : "One line, no §, within the per-entry limit.";
				// 首次取数完成前后文案不同（旧版静态 HTML 是"≤ 单条上限。"，取到阈值后才写具体数）
				return this.loaded ? "必须单行、不含 §、" + this.entryCharLimit + " 字符以内。" : "必须单行、不含 §、≤ 单条上限。";
			},
			/** 未成功预览前，执行按钮保持禁用。 */
			canApplyEdit: function () {
				return this.hasPort() && !this.busy && this.editOp.previewed;
			},
			canApplyRestore: function () {
				// 空备份清空提议稿被拒后，必须先勾选放行（gateOk）才允许执行。
				var gateOk = !this.restoreOp.gateEmpty || this.restoreOp.allowEmpty;
				return this.hasPort() && !this.busy && this.restoreOp.previewed && this.restoreConfirm === this.restoreOp.file && gateOk;
			},
			/** 已暴露的每一道闸都必须勾选（否则服务端会再拒一次） */
			revealedGates: function () {
				var self = this;
				return ["stale", "mass", "empty"].filter(function (k) { return self.mergeOp.revealed[k]; });
			},
			canApplyMerge: function () {
				var self = this;
				var gatesOk = this.revealedGates.every(function (k) { return !!self.mergeOp.gates[k]; });
				return this.hasPort() && !this.busy && this.mergeOp.previewed && this.mergeConfirm === this.mergeConfirmToken && gatesOk;
			},
			mergeConfirmToken: function () {
				return this.mergeStrategy === "replace" ? "REPLACE" : "MERGE";
			},
			mergeStrategyOptions: function () {
				return [
					{ value: "add", label: "只添加新条目" },
					{ value: "replace", label: "完整替换（会删除旧条目）" },
				];
			},

			/** 游标侧栏 */
			interval: function () {
				return this.limits && typeof this.limits.interval === "number" ? this.limits.interval : null;
			},
			since: function () {
				var c = this.cursor;
				return c && typeof c.memoriesSinceLastPersona === "number" ? c.memoriesSinceLastPersona : null;
			},
			sinceText: function () {
				return this.since === null ? "—" : this.since;
			},
			p4Pct: function () {
				if (!this.interval) return 0;
				return Math.min(100, Math.round(((this.since || 0) / this.interval) * 100));
			},
			cursorRows: function () {
				var c = this.cursor || {};
				var self = this;
				return [
					{ label: isEnglish ? "Last profile update" : "最近画像更新", value: self.esc(V.fmtTime(c.lastPersonaUpdate)) },
					{ label: isEnglish ? "Last triggered" : "最近触发", value: self.esc(V.fmtTime(c.lastTriggeredAt)) },
					{ label: isEnglish ? "Last committed" : "最近提交", value: self.esc(V.fmtTime(c.lastCommittedAt)) },
				];
			},
			noCursorMsg: function () {
				return { html: isEnglish ? "<code>l3/cursor.json</code> is missing. Has L3 ever run?" : "没有 <code>l3/cursor.json</code>（L3 从未运行过？）。", level: "warn" };
			},
			pendingMsg: function () {
				return { html: isEnglish ? "<code>pending-trigger.json</code> exists: <code>" + this.esc(JSON.stringify(this.pending)) + "</code>" : "存在 <code>pending-trigger.json</code>：<code>" + this.esc(JSON.stringify(this.pending)) + "</code>", level: "warn" };
			},
			/** 最近一次触发晚于最近一次提交 —— 两个字段分开记就是为了让这种情况可见 */
			ranWithoutCommit: function () {
				var c = this.cursor;
				return !!(c && c.lastTriggeredAt && c.lastCommittedAt && V.ts(c.lastTriggeredAt) > V.ts(c.lastCommittedAt));
			},
			staleTriggerMsg: function () {
				return { html: isEnglish ? "The latest trigger is newer than the latest commit: L3 ran but did not commit. These timestamps are tracked separately to make this visible." : "最近一次触发晚于最近一次提交 —— 也就是「跑了但没提交」。这两个字段分开记就是为了让这种情况可见。", level: "" };
			},
			missingBackupMsg: function () {
				return { html: isEnglish ? "This backup could not be read (static path returned 404)." : "读不到这份备份（静态路径 404）。", level: "warn" };
			},

			/** 条目清单上方那句醒目提示（改的是提议稿，不是注入画像） */
			entryWarnMsg: function () {
				return {
					html: isEnglish
						? "Edits and additions are written to <code>USER-temp.md</code> (<b>the draft</b>) and do <b>not</b> immediately change the profile used for injection. They take effect only after you merge them into live <code>USER.md</code>. The live lists below are read-only; editing or deleting a USER entry changes the draft."
						:
						"改写 / 删除 / 新增都落在 <code>USER-temp.md</code>（<b>提议稿</b>），<b>不会</b>立刻改变注入画像 —— " +
						"只有到「并入区」把它写进 live <code>USER.md</code> 之后才生效。" +
						"下面 live 列表本身只读（MEMORY 与 USER 都不给按钮）；对 USER 条目点改写 / 删除，改的同样是提议稿。",
					level: "",
				};
			},

			/** 页内跳转必须带上 location.search（丢了 ?port= 就静默变只读） */
			pipelineHref: function () {
				return "pipeline-viewer.html" + location.search;
			},
		},
		mounted: function () {
			// 旧版的 init() 做三件事：mountChrome（已在 V.vue.mount 里做过）、bind()（Vue 接管，
			// 不再需要事件委托）、autoLoad()。挂载后立刻取一次数 —— 漏了这步页面就永远是空态。
			var self = this;
			V.registerRefreshHandler(function () { return self.loadAll(); });
			this.loadAll();
		},
		methods: {
			/**
			 * 取数与加载提示（旧版 autoLoad 的职责）。首次取数完成后 loaded 置位：
			 * 「加载中」与「读不到」是两种状态，不能合并。
			 */
			loadAll: function () {
				var self = this;
				this.setNote("加载中…");
				return this.fetchAll()
					.then(function () {
						self.loaded = true;
						var missing = Object.keys(self.files).filter(function (k) {
							return self.files[k].raw === null;
						});
						self.setNote(isEnglish
							? "Loaded the cursor, three profile files, and " + self.backups.length + " backups." +
								(missing.length ? " <b>Could not read: " + missing.map(function (k) { return self.files[k].label; }).join("/") + "</b>" : "") +
								(self.limits ? " Limits come from source constants exposed by /api/limits." : " <b>Viewer bridge unavailable: limits and backup list are unavailable.</b>")
							: "已加载游标、三份画像文件与 " + self.backups.length + " 个备份。" +
								(missing.length ? " <b>没读到：" + missing.map(function (k) { return self.files[k].label; }).join("/") + "</b>" : "") +
								(self.limits ? " 阈值来自 /api/limits（源码常量）。" : " <b>无写盘桥：阈值与备份清单不可用</b>。"));
					})
					.catch(function (e) {
						self.setNote("加载失败：" + self.esc(e && e.message ? e.message : String(e)), "err");
					});
			},

			/** 写盘成功后重取数据（不改动各区自己刚写好的结果提示）。 */
			reloadAfterWrite: function () {
				var self = this;
				return this.fetchAll().then(function () {
					self.setNote(isEnglish ? "Reloaded (" + self.backups.length + " backups / " + self.tempEntries.length + " draft entries)." : "已重载（" + self.backups.length + " 个备份 / 提议稿 " + self.tempEntries.length + " 条）。", "");
				});
			},

			/** 加载与游标、画像三件套、阈值、备份（旧版 loadAll 的职责）。 */
			fetchAll: function () {
				var self = this;
				return Promise.all([
					V.loadJson("../l3/cursor.json"),
					V.loadJson("../l3/pending-trigger.json"),
					V.bridge(EP.limits),
					V.bridge(EP.backups),
					// 画像三件套在 profile **根**（memoryDB 的上一级），桥只挂载 memoryDB：
					// 相对路径 `../../USER.md` 在浏览器里会解析回 `/USER.md` = {memoryDB}/USER.md → 404。
					// 所以必须走白名单端点，不能靠相对路径。
					V.bridge(EP.profileFiles),
				]).then(function (r) {
					self.cursor = r[0] || null;
					// 下面这个 pending **不是**"待消费信号"（那是流水线页的事，走 /api/pending-triggers）：
					// 它是 l3/pending-trigger.json 这个文件本身 —— 只用来在这一页提示"盘上有一份没被消费的 L3 请求"。
					self.pending = r[1] || null;
					self.limits = r[2] && r[2].ok ? r[2].data.l3 : null;
					self.backups = r[3] && r[3].ok && r[3].data.backups ? r[3].data.backups : [];
					var pf = r[4] && r[4].ok && r[4].data && r[4].data.files ? r[4].data.files : null;
					self.profileFilesAvailable = !!pf;
					var files = {};
					FILE_KEYS.forEach(function (k) {
						var meta = FILE_META[k];
						files[k] = { raw: pf ? pf[meta.field] : null, label: meta.label, note: meta.note };
					});
					self.files = files;
				});
			},

			// ── 条目区：改写 / 删除 / 加一条 ─────────────────────────────────

			/**
			 * 进入改写 / 删除。定位片段由行上那一条的原文直接传入（旧版是 data-idx 回查
			 * entryLists，下标错位就会改错条目 —— Vue 版没有再算下标的机会）。
			 */
			stageEdit: function (action, text) {
				this.editOp = { action: action, target: text || null, previewed: false };
				this.editContent = action === "update" ? text : "";
				this.editOut = {
					html: "已选：<b>" + (action === "delete" ? "删除" : "改写") + "</b> 该条目。先点「预演」看后果。",
					level: "",
				};
			},

			/** 清除已选条目并回到新增模式。 */
			resetEdit: function () {
				this.editOp = { action: "add", target: null, previewed: false };
				this.editContent = "";
				this.editOut = { html: "已切换到新增模式。填写内容后可预览变更。", level: "" };
			},

			/** 预览通过后若正文改变，要求重新预览当前内容。 */
			invalidateEditPreview: function () {
				if (!this.editOp.previewed) return;
				this.editOp.previewed = false;
				this.editOut = { html: "内容已更改，请重新预览。", level: "warn" };
			},

			/** 条目写请求体：add/update 带 content，update/delete 带 target（与 /api/l3/edit 入参逐字对齐）。 */
			entryEditBody: function (apply) {
				var body = { action: this.editOp.action, apply: apply };
				if (this.editOp.action !== "delete") body.content = this.editContent;
				if (this.editOp.action !== "add") body.target = this.editOp.target;
				return body;
			},

			/** 预演：服务端裁决单条契约、定位唯一性与整篇预算（客户端只挡"正文为空"） */
			previewEdit: function () {
				var self = this;
				// 客户端只挡"明显缺参数"（真正裁决在服务端：单条契约、定位唯一性、整篇预算）。
				if (this.editOp.action !== "delete" && this.editContent.trim() === "") {
					this.editOut = { html: "正文为空，没有可写入的内容。", level: "warn" };
					return;
				}
				this.busy = "edit";
				this.editOut = { html: "预演中…", level: "" };
				V.bridge(EP.edit, { method: "POST", body: JSON.stringify(this.entryEditBody(false)) }).then(function (r) {
					self.busy = "";
					var d = r.data || {};
					if (r.ok && d.success) {
						self.editOp.previewed = true;
						self.editOut = {
							html:
								"预演通过（未落盘）：写入目标是 <code>" + self.esc(d.targetFile || "USER-temp.md") + "</code>，" +
								"操作后用量 <b>" + self.esc(String(d.usage || "")) + "</b>" +
								(typeof d.entryCount === "number" ? "、" + d.entryCount + " 条。" : "。") +
								(d.note ? " " + self.esc(d.note) : ""),
							level: "",
						};
					} else {
						self.editOp.previewed = false;
						var cand = Array.isArray(d.candidates) && d.candidates.length ? " 候选：" + d.candidates.map(V.escapeHtml).join(" ／ ") : "";
						self.editOut = { html: "预演被拒：" + self.esc(d.error || "HTTP " + r.status) + cand, level: "err" };
					}
				});
			},

			/** 二次确认后写入临时画像（写前服务端自己会留档一份）。 */
			applyEdit: function () {
				var self = this;
				if (!this.canApplyEdit) return;
				var action = this.editOp.action;
				var confirmMessages = {
					add: "将把这条内容添加到 USER-temp.md。稳定画像不会因此改变。要继续吗？",
					update: "将用新内容替换 USER-temp.md 中选中的条目。稳定画像不会因此改变。要继续吗？",
					delete: "将从 USER-temp.md 删除选中的条目。稳定画像不会因此改变。要继续吗？",
				};
				this.busy = "confirm-edit";
				V.vue.confirm(confirmMessages[action], "确认此操作").then(function (yes) {
					self.busy = "";
					if (!yes || !self.canApplyEdit) return;
					self.busy = "edit";
					self.editOut = { html: "写入中…", level: "" };
					return V.bridge(EP.edit, { method: "POST", body: JSON.stringify(self.entryEditBody(true)) }).then(function (r) {
						self.busy = "";
						var d = r.data || {};
						if (r.ok && d.success) {
							var resultMessage = action === "delete" ? "已从临时画像删除所选条目。" : action === "update" ? "已更新临时画像。" : "已添加到临时画像。";
							self.editOut = {
								html:
									resultMessage + " 当前用量 <b>" + self.esc(String(d.usage || "")) + "</b>。" +
									"稳定画像不会自动改变；要应用这些修改，请在下方合并到稳定画像。",
								level: "",
							};
							self.editOp.previewed = false;
							self.reloadAfterWrite();
						} else {
							self.editOp.previewed = false;
							self.editOut = { html: "执行失败：" + self.esc(d.error || "HTTP " + r.status), level: "err" };
						}
					});
				});
			},

			// ── 备份区：预览 / 还原 ─────────────────────────────────────────

			/** 预览一份备份：走静态托管（不经桥），读不到与"空备份"是两种状态。 */
			previewBackup: function (file) {
				var self = this;
				this.previews[file] = { loading: true, missing: false, text: "", count: 0 };
				// 备份内容走静态托管（桥把 memoryDB 整个挂上）——`../backups/…` 落在 memoryDB/backups 下。
				V.loadText("../backups/user-backups/" + encodeURIComponent(file)).then(function (txt) {
					if (txt === null) {
						self.previews[file] = { loading: false, missing: true, text: "", count: 0 };
						return;
					}
					self.previews[file] = { loading: false, missing: false, text: txt, count: parseEntries(txt).length };
				});
			},

			/** 打开某份备份的还原面板（预演 → 打字确认文件名 → 执行）。 */
			stageRestore: function (file) {
				var self = this;
				this.restoreOp = { file: file, previewed: false, gateEmpty: false, allowEmpty: false };
				this.restoreConfirm = "";
				this.restoreDiff = "";
				this.restoreMsg = { html: "", level: "" };
				// 要打字，就直接把光标送进确认框（只在有写盘桥时；无桥时输入框本来就是禁用的）。
				this.$nextTick(function () {
					if (self.hasPort() && self.$refs.restoreConfirm) self.$refs.restoreConfirm.focus();
				});
			},

			/** 空备份放行勾选：勾选后重跑预演，拿到真正的差异（服务端才不会再拒）。 */
			onRestoreGateChange: function () {
				this.previewRestore();
			},

			previewRestore: function () {
				var self = this;
				if (!this.restoreOp.file) return;
				this.busy = "restore";
				this.restoreMsg = { html: "预演中…", level: "" };
				V.bridge(EP.restore, {
					method: "POST",
					body: JSON.stringify({ file: this.restoreOp.file, apply: false, allowEmpty: this.restoreOp.allowEmpty }),
				}).then(function (r) {
					self.busy = "";
					var d = r.data || {};
					if (r.ok && d.ok) {
						self.restoreOp.previewed = true;
						self.restoreOp.gateEmpty = false;
						self.restoreDiff = diffHtml(d.added, d.removed, d.addedTotal, d.removedTotal);
						self.restoreMsg = {
							html:
								"预演通过（未落盘）：提议稿 " + d.beforeCount + " → " + d.afterCount + " 条（" +
								self.esc(String(d.beforeChars)) + " → " + self.esc(String(d.afterChars)) + " 字符）。",
							level: "",
						};
					} else {
						self.restoreOp.previewed = false;
						var msg = d.error || "HTTP " + r.status;
						self.restoreMsg = { html: "预演被拒：" + self.esc(msg), level: "err" };
						// 空备份（0 条）覆盖有内容的提议稿：服务端专门拒这一种，要显式放行。
						if (/空/.test(msg) && !self.restoreOp.gateEmpty) self.restoreOp.gateEmpty = true;
					}
				});
			},

			/** 执行还原：不可逆写盘，动手前再确认一次（异步弹层，不用同步 window.confirm） */
			applyRestore: function () {
				var self = this;
				if (!this.canApplyRestore) return;
				var file = this.restoreOp.file;
				return V.vue
					.confirm(
						"还原备份 " + file + " 到提议稿 USER-temp.md？\n\n备份内容会覆盖提议稿（写前先把当前提议稿另存一份，故还原本身也可回退）；live USER.md 不受影响。",
						"还原备份",
					)
					.then(function (yes) {
						if (!yes) return null;
						self.busy = "restore";
						self.restoreMsg = { html: "还原中…", level: "" };
						return V.bridge(EP.restore, {
							method: "POST",
							body: JSON.stringify({ file: file, apply: true, confirm: file, allowEmpty: self.restoreOp.allowEmpty }),
						}).then(function (r) {
							self.busy = "";
							var d = r.data || {};
							if (r.ok && d.ok) {
								self.restoreMsg = {
									html:
										"已还原到 <code>" + self.esc(d.file || "USER-temp.md") + "</code>（提议稿）。" +
										self.esc(d.note || "") + " 要上 live 还要走「并入区」。",
									level: "",
								};
								// 状态真正重置（保留 file，面板与这条结果提示留在屏上；旧版把 file 置空却把面板
								// 留在屏上，那两个按钮于是变成"点了没反应"的死键）。
								self.restoreOp = { file: file, previewed: false, gateEmpty: false, allowEmpty: false };
								self.restoreDiff = "";
								self.restoreConfirm = "";
								self.reloadAfterWrite();
							} else {
								self.restoreOp.previewed = false;
								self.restoreMsg = { html: "还原失败：" + self.esc(d.error || "HTTP " + r.status), level: "err" };
							}
						});
					});
			},

			// ── 并入区：预演追加 / 显式替换 → 必要的安全闸放行 → 输入确认词 → 执行 ──

			/** 勾选 / 取消某道闸：变化即重跑预演（服务端只认它自己那次的裁决） */
			onGateChange: function () {
				this.previewMerge();
			},

			mergeBody: function (apply) {
				return {
					apply: apply,
					strategy: this.mergeStrategy,
					confirm: apply ? this.mergeConfirmToken : undefined,
					allowStale: !!this.mergeOp.gates.stale,
					allowMassRemoval: !!this.mergeOp.gates.mass,
					allowEmpty: !!this.mergeOp.gates.empty,
				};
			},

			/** 本地估算的并入差异；追加模式的移除数固定为 0，替换模式才计算 live 独有条目。 */
			localMergeDiff: function () {
				var live = this.userEntries;
				var temp = this.tempEntries;
				return {
					added: temp.filter(function (e) { return live.indexOf(e) < 0; }),
					removed: this.mergeStrategy === "replace" ? live.filter(function (e) { return temp.indexOf(e) < 0; }) : [],
				};
			},

			onMergeStrategyChange: function () {
				this.mergeOp = { previewed: false, revealed: {}, gates: {} };
				this.mergeConfirm = "";
				this.mergeOut = "";
			},

			previewMerge: function () {
				var self = this;
				this.mergeConfirm = "";
				this.busy = "merge";
				this.mergeOut = noticeHtml("预演中…", "");
				V.bridge(EP.merge, { method: "POST", body: JSON.stringify(this.mergeBody(false)) }).then(function (r) {
					self.busy = "";
					var d = r.data || {};
					if (r.ok && d.ok) {
						// **成功分支必须把上一次的拒绝现场清掉**（与 previewRestore 对齐）：否则在一次被拒之后
						// 再来一次成功的预演，屏幕上会同时出现「预演通过」与「服务端拒绝了这次并入」+ 一排放行
						// 勾选框 —— 自相矛盾的界面比没有界面更坏（本项目反复记过"误导态"这一条）。
						// 放行勾选也一并归零：它只在"服务端刚拒绝过"这个语境里有意义；留着会让用户在勾选框已被
						// 清掉、看不见的情况下，仍把 allow* 带进请求体（等于偷偷放行）。
						self.mergeOp = { previewed: true, revealed: {}, gates: {} };
						self.mergeOut =
							noticeHtml(
								self.t(this.mergeStrategy === "replace" ? "替换预演通过（未落盘）：" : "追加预演通过（未落盘）：") +
								"<code>" + self.esc(d.file || "USER.md") + "</code> " +
									(window.ViewerI18n && window.ViewerI18n.locale === "en"
										? d.beforeCount + " → " + d.afterCount + " entries, " + self.esc(String(d.beforeChars)) + " → " + self.esc(String(d.afterChars)) + " characters."
										: d.beforeCount + " → " + d.afterCount + " 条，" + self.esc(String(d.beforeChars)) + " → " + self.esc(String(d.afterChars)) + " 字符。"),
								"",
							) +
							diffHtml(d.added, d.removed, d.addedTotal, d.removedTotal) +
							'<div class="hint">live mtime ' + self.esc(V.fmtTime(d.liveMtime)) + " · 提议稿 mtime " +
							self.esc(V.fmtTime(d.tempMtime)) + "</div>";
					} else {
						var msg = d.error || "HTTP " + r.status;
						var gate = mergeGateFromError(msg);
						self.mergeOp.previewed = false;
						if (gate) self.mergeOp.revealed[gate] = true;
						// CLI 包装在拒绝时只透出 {success:false,error}（viewer-cli 的 fail 不带差异字段），
						// 所以这里用本页已载入的内容补一份**同口径**估算（并入源恒为 temp、目标恒为 live，
						// 与所选策略的差异口径一致，让用户始终能看到影响范围。
						var local = self.localMergeDiff();
						self.mergeOut =
							noticeHtml("预演被拒：" + self.esc(msg), "err") +
							diffHtml(local.added.slice(0, 20), local.removed.slice(0, 20), local.added.length, local.removed.length) +
							'<div class="hint">上面的差异是按本页当前已载入的 live / 提议稿估算的（服务端在给出自己的差异之前就拒绝了）。</div>';
					}
				});
			},

			/** 执行并入：全仓库唯一写 live USER.md 的路径（服务端写前留档一份备份） */
			applyMerge: function () {
				var self = this;
				if (!this.canApplyMerge) return;
				this.busy = "merge";
				this.mergeOut = noticeHtml("并入中…", "");
				V.bridge(EP.merge, { method: "POST", body: JSON.stringify(this.mergeBody(true)) }).then(function (r) {
					self.busy = "";
					var d = r.data || {};
					if (r.ok && d.ok) {
						self.mergeOut =
							noticeHtml(
								self.t(this.mergeStrategy === "replace" ? "已完整替换 live " : "已追加到 live ") + "<code>" + self.esc(d.file || "USER.md") + "</code>: " +
									(window.ViewerI18n && window.ViewerI18n.locale === "en"
										? d.beforeCount + " → " + d.afterCount + " entries. " + (d.backupFile ? "Backup: <code>" + self.esc(d.backupFile) + "</code>." : "No backup was created because USER.md did not exist.")
										: d.beforeCount + " → " + d.afterCount + " 条。" + (d.backupFile ? "写前备份 <code>" + self.esc(d.backupFile) + "</code>。" : "（live 原本不存在，未产生备份。）")),
								"",
							) +
							noticeHtml(
								"注意：<b>运行中的 pi 会话仍注入旧画像</b>（注入用的是启动时构建的冻结快照）。" +
									"要等 <code>/reload</code> 或新开一个会话才会读到新画像 —— 刷新本页不算。",
								"warn",
							);
						self.mergeOp = { previewed: false, revealed: {}, gates: {} };
						self.mergeConfirm = "";
						self.reloadAfterWrite();
					} else {
						var msg = d.error || "HTTP " + r.status;
						var gate = mergeGateFromError(msg);
						self.mergeOp.previewed = false;
						if (gate) self.mergeOp.revealed[gate] = true;
						self.mergeOut = noticeHtml("并入失败：" + self.esc(msg), "err");
					}
				});
			},
		},
		template: /* html */ `
		<header class="page">
			<h1>L3 画像层</h1>
			<!-- 只列这一页有哪些区块；「预算口径与 entryBudget 一致、不是文件字节数」那句
			     侧栏【怎么读这页】里已经写过一遍，页头不再重复。 -->
			<p class="sub">游标与触发进度 · 三份「§ 分隔条目」文件的字符预算与自检 · 提议稿与 live 的差异 · 画像备份。</p>
			<notice :msg="loadNote"></notice>
		</header>

		<main>
			<aside>
				<h2>怎么读这页</h2>
				<!-- 说明默认收起：它长 4 段，常开会把下面的游标与预算挤出首屏 -->
				<el-collapse v-model="helpOpen">
					<el-collapse-item name="help" :title="isEnglish ? 'File roles · character budget · trigger levels · entry rules' : '三份文件的分工 · 预算口径 · 触发分级 · 单条契约'">
						<div class="hint" v-if="!isEnglish">
							<p>文件名旁的问号说明每份文件的用途。「临时层独有」表示只在临时画像中出现、尚未写入稳定层的内容。</p>
							<p><b>预算是字符不是字节</b>：<code>entryBudget = 条目正文 + 分隔符（\\n§\\n 记 3 字符）</code>。
							中文一个字 3 字节，用 <code>ls</code> 的字节数看会误判成严重超限（实测 USER.md 磁盘 4745 字节 vs 预算 1921/2200）。</p>
							<p><b>触发分级</b>：P1 显式请求 / P2 冷启动 / P2.5 恢复 / P3 首次场景 / P4 记忆阈值（累计新增记忆到阈值）。
							<code>lastTriggeredAt</code> 与 <code>lastCommittedAt</code> 分开记，是为了让「跑了但没提交」可见。</p>
							<p><b>单条契约</b>：每条必须单行、不含 <code>§</code>。首条若以 <code>§</code> 开头，说明文件开头多了一个分隔符，
							那个 <code>§</code> 会被并进正文 —— 本页会把它标成异常。</p>
						</div>
						<div class="hint" v-else>
							<p>The question mark beside each file name explains its purpose. “Only in temp” means those entries have not yet been added to the stable profile.</p>
							<p><b>The budget counts characters, not bytes</b>: <code>entryBudget = entry text + separators</code> (each <code>\n§\n</code> separator counts as 3 characters). Chinese characters may use 3 bytes each, so file size can make a profile look over budget when it is not. For example, USER.md can be 4,745 bytes on disk while using only 1,921 of 2,200 budget characters.</p>
							<p><b>Trigger levels</b>: P1 explicit request / P2 cold start / P2.5 recovery / P3 first scene / P4 memory threshold. <code>lastTriggeredAt</code> and <code>lastCommittedAt</code> are tracked separately so a run without a commit remains visible.</p>
							<p><b>Entry rules</b>: each entry must be one line and cannot contain <code>§</code>. If the first entry starts with <code>§</code>, an extra separator was added at the start of the file and became part of that entry; this page flags it.</p>
						</div>
					</el-collapse-item>
				</el-collapse>

				<!-- 触发分级是**静态口径**（谁触发 L3），不是每次都要读的信息；挂到问号上，
				     需要时悬停即可（同一段完整解释也在左栏「怎么读这页」里）。 -->
				<h2>L3 游标与触发<help-note text="P1 显式请求 / P2 冷启动 / P2.5 恢复 / P3 首次场景 / P4 记忆阈值（累计新增记忆到阈值）。lastTriggeredAt 与 lastCommittedAt 分开记，是为了让「跑了但没提交」可见。"></help-note></h2>
				<div v-if="!loaded" class="hint">加载中…</div>
				<template v-else-if="cursor">
					<stat-list :rows="cursorRows"></stat-list>
					<div v-if="interval === null" class="hint">{{ isEnglish ? "No viewer bridge: L3_INTERVAL is unavailable, so P4 trigger progress cannot be shown." : "无写盘桥：读不到 L3_INTERVAL，无法显示 P4 触发进度。" }}</div>
					<div v-else class="budget">
						<div class="meta"><span>P4 记忆阈值进度</span><span>{{ sinceText }} / {{ interval }}</span></div>
						<div class="track"><i :style="{ width: p4Pct + '%' }"></i></div>
					</div>
					<notice v-if="pending" :msg="pendingMsg"></notice>
					<notice v-if="ranWithoutCommit" :msg="staleTriggerMsg"></notice>
				</template>
				<notice v-else :msg="noCursorMsg"></notice>
			</aside>

			<section class="content">
				<h2>字符预算与自检<help-note text="预算按 entryBudget 计（条目正文 + 分隔符），不是文件字节数：中文 1 字符 = 3 字节，用 ls 的字节数看会误判成严重超限。" raw></help-note></h2>
				<div v-if="!loaded" class="hint">加载中…</div>
				<template v-else>
					<notice v-if="!profileFilesAvailable" :msg="profileFilesMsg"></notice>
					<!-- 三份文件每个只出一根条；used 由 BudgetBar 现算（与 entries.ts 的 entryBudget 同口径） -->
					<budget-bar v-for="g in fileGroups" :key="g.key" :label="g.budgetLabel" :entries="g.list" :limit="g.limit" :note="g.note"></budget-bar>
					<notice v-if="!allIssues.length" :msg="noIssuesMsg"></notice>
					<notice v-for="(m, i) in issueNotices" :key="i" :msg="m"></notice>
				</template>

				<h2>提议稿与 live 的差异</h2>
				<div v-if="!loaded" class="hint">加载中…</div>
				<template v-else>
					<div class="chips">
						<chip :label="'temp 独有 ' + tempOnly.length"></chip>
						<chip :label="'live 独有 ' + userOnly.length"></chip>
					</div>
					<h2>temp 独有（待人工合入 live）</h2>
					<div v-if="!tempOnly.length" class="hint">无</div>
					<template v-else>
						<div class="entry added" v-for="(e, i) in tempOnly" :key="i"><span class="tag added">待合入</span> {{ e }}</div>
					</template>
					<h2>live 独有（temp 未覆盖）</h2>
					<div v-if="!userOnly.length" class="hint">无</div>
					<el-collapse v-else v-model="userOnlyOpen">
						<el-collapse-item name="userOnly" :title="'展开 ' + userOnly.length + ' 条'">
							<div class="entry" v-for="(e, i) in userOnly" :key="i">{{ e }}</div>
						</el-collapse-item>
					</el-collapse>
				</template>

				<h2>逐条清单</h2>
				<!-- 条目清单：全页唯一一份（改写 / 删除按钮就在行上），默认收起 ——
				     31 条 × 每条带按钮，常开会占掉近 4 屏，把下面的操作区压到第 3 屏之外。 -->
				<el-collapse v-model="entriesOpen">
					<el-collapse-item name="entries" :title="loaded ? entriesTitle : '加载中…'">
						<!-- 醒目的一句：改的是提议稿，不是注入画像。跟着条目清单走（按钮在哪，这句话就在哪）。 -->
						<notice :msg="entryWarnMsg"></notice>
						<div v-for="g in fileGroups" :key="g.key">
							<h2><code>{{ g.label }}</code> —— {{ g.list.length }} 条<chip v-if="g.issues.length" kind="err" :label="g.issues.length + ' 项异常'"></chip><chip v-if="!g.list.length" label="空"></chip></h2>
							<div v-if="!g.list.length" class="hint">（空文件或不存在）<help-note :text="g.note"></help-note></div>
							<template v-else>
								<!-- MEMORY 组只读：写动作恒定落到 USER-temp.md，给它按钮就是给一个必然写错地方的按钮 -->
								<div class="entry" v-for="(e, i) in g.list" :key="i">
									<span class="idx">{{ i + 1 }}.</span>{{ e }}<chip :label="e.length + ' 字符'"></chip>
									<div v-if="!g.readonly" class="cell-actions">
										<el-button :disabled="!hasPort() || !!busy" @click="stageEdit('update', e)">改写</el-button>
										<el-button type="danger" :disabled="!hasPort() || !!busy" @click="stageEdit('delete', e)">删除</el-button>
									</div>
								</div>
							</template>
						</div>
					</el-collapse-item>
				</el-collapse>

				<h2>画像备份（backups/user-backups）</h2>
				<!-- 备份清单：同样只留一份（预览 / 还原按钮在行上），默认收起 -->
				<el-collapse v-model="backupsOpen">
					<el-collapse-item name="backups" :title="loaded ? backupsTitle : '加载中…'">
						<!-- 还原目标的说明跟着清单走（它解释的正是这一列按钮会把文件写到哪） -->
						<div class="hint">还原目标是<b>提议稿 <code>USER-temp.md</code>，不是 live <code>USER.md</code></b>：备份文件名只记时间戳、不记当时捕的是哪一份，所以统一还原到 L3 唯一的写目标，要上 live 再走一次「并入」。</div>
						<div v-if="!backups.length" class="hint">没有备份（或未用写盘桥：<code>backups/user-backups/</code> 需要桥来列目录）。</div>
						<!-- 每行：文件名 / 大小 / 时间 + 预览（读静态路径）+ 还原（预演 → 打字确认 → 执行） -->
						<template v-else>
							<div class="entry" v-for="b in backupRows" :key="b.file">
								<span class="idx">·</span>{{ b.file }}<chip :label="b.size + ' B'"></chip><chip :label="fmtTime(b.mtime)"></chip>
								<div class="cell-actions">
									<el-button :disabled="!hasPort()" @click="previewBackup(b.file)">预览</el-button>
									<el-button type="danger" :disabled="!hasPort()" @click="stageRestore(b.file)">还原</el-button>
								</div>
								<div v-if="previews[b.file]">
									<div v-if="previews[b.file].loading" class="hint">读取中…</div>
									<notice v-else-if="previews[b.file].missing" :msg="missingBackupMsg"></notice>
									<!-- 长文本进 <details>，不开内滚动 -->
									<details v-else class="log">
										<summary>预览 {{ b.file }}（{{ previews[b.file].count }} 条）</summary>
										<div class="log-text">{{ previews[b.file].text }}</div>
									</details>
								</div>
							</div>
						</template>

						<!-- 还原面板（目标恒为提议稿；预演 → 打字确认文件名 → 执行） -->
						<div v-if="restoreOp.file">
							<div class="ops-row">
								<div class="ops-label">还原</div>
								<div class="ops-ctl">
									<span class="confirm-token">{{ restoreOp.file }}</span>
									<el-button :disabled="!hasPort() || !!busy" @click="previewRestore">预演还原</el-button>
								</div>
								<div class="ops-note">备份内容会覆盖<b>提议稿</b>（写前先把当前提议稿另存一份，故还原本身也可回退）。</div>
							</div>
							<div v-if="restoreOp.gateEmpty">
								<el-checkbox v-model="restoreOp.allowEmpty" :disabled="!hasPort()" @change="onRestoreGateChange">这是空备份，仍要清空提议稿</el-checkbox>
							</div>
							<div v-if="restoreDiff" v-html="restoreDiff"></div>
							<div class="ops-row">
								<div class="ops-label">确认</div>
								<div class="ops-ctl">
									<span>原样输入备份文件名 <span class="confirm-token">{{ restoreOp.file }}</span></span>
									<el-input ref="restoreConfirm" v-model="restoreConfirm" style="width:240px" autocomplete="off" :disabled="!hasPort()"></el-input>
									<el-button type="danger" :disabled="!canApplyRestore" @click="applyRestore">执行还原</el-button>
								</div>
							</div>
							<notice v-if="restoreMsg.html" :msg="restoreMsg"></notice>
						</div>
					</el-collapse-item>
				</el-collapse>

				<h2>管理操作区</h2>
				<div v-if="!hasPort()" class="hint"><b>无写盘桥，管理操作全部禁用</b>：请用带 <code>?port=</code> 的地址打开（见页首提示）。这些按钮都要经桥转发到 <code>scripts/l1-admin/*.mts</code>，没有桥就只是调一个不存在的端口。</div>
				<div class="ops">
					<div class="l3-edit-zone">
						<h3>{{ editTitle }}</h3>
						<div v-if="editOp.action !== 'add'" class="ops-row">
							<div class="ops-label">选中的条目</div>
							<div class="ops-ctl">
								<span class="confirm-token">{{ editOp.target }}</span>
								<el-button :disabled="!hasPort() || !!busy" @click="resetEdit">取消选择，改为新增</el-button>
							</div>
						</div>
						<div v-if="editOp.action !== 'delete'" class="ops-row">
							<div class="ops-label">内容<help-note :text="contentNote"></help-note></div>
							<div class="ops-ctl">
								<el-input class="edit-content-input" v-model="editContent" @input="invalidateEditPreview" style="width:100%" placeholder="一条单行规则，不含 §，≤500 字符" :disabled="!hasPort() || !!busy"></el-input>
							</div>
						</div>
						<div class="ops-row wide">
							<div class="ops-ctl edit-actions">
								<el-button :disabled="!hasPort() || !!busy" @click="previewEdit">预览操作结果</el-button>
								<el-button :type="editOp.action === 'delete' ? 'danger' : 'primary'" :disabled="!canApplyEdit" @click="applyEdit">{{ applyEditLabel }}</el-button>
							</div>
							<div v-if="!editOp.previewed" class="ops-note">先预览结果；确认后再执行。执行前会再次询问你。</div>
						</div>
						<notice v-if="editOut.html" :msg="editOut"></notice>
					</div>

					<div class="danger-zone merge-zone">
						<h3>合并临时画像到稳定画像</h3>
				<p v-if="!isEnglish" class="merge-summary">默认只把 <code>USER-temp.md</code> 中尚不存在的条目追加到 <code>USER.md</code>，保留现有条目。完整替换会删除临时稿里没有的旧条目；只有确实要整体改写时才选择。执行前会自动备份。</p>
				<p v-else class="merge-summary">By default, only entries from <code>USER-temp.md</code> that are not already in <code>USER.md</code> are added; existing entries are preserved. Full replacement deletes live entries that are missing from the draft, so use it only when you intend to replace the whole profile. A backup is created before writing.</p>
						<div class="merge-strategy">
							<span class="merge-strategy-label">合并方式</span>
							<seg v-model="mergeStrategy" :options="mergeStrategyOptions" :disabled="!hasPort() || !!busy" @change="onMergeStrategyChange"></seg>
						</div>
						<div class="merge-actions">
							<div v-if="mergeOp.previewed" class="merge-confirm">
								<label for="merge-confirm-input">检查差异后，输入 <span class="confirm-token">{{ mergeConfirmToken }}</span> {{ mergeStrategy === 'replace' ? '确认完整替换' : '确认追加' }}</label>
								<div class="merge-confirm-controls">
									<el-input id="merge-confirm-input" v-model="mergeConfirm" autocomplete="off" :placeholder="'输入 ' + mergeConfirmToken" :disabled="!hasPort() || !!busy"></el-input>
									<el-button type="primary" :disabled="!canApplyMerge" @click="applyMerge">{{ mergeStrategy === 'replace' ? '确认完整替换' : '确认追加到稳定画像' }}</el-button>
								</div>
							</div>
							<el-button class="merge-preview-button" :disabled="!hasPort() || !!busy" @click="previewMerge">{{ mergeStrategy === 'replace' ? '预览替换结果' : '预览追加结果' }}</el-button>
						</div>
						<div v-if="revealedGates.length" class="merge-gates">
							<div class="notice warn">完整替换触发安全检查。请查看原因，确认确实要删除旧条目后再勾选：</div>
							<el-checkbox v-for="k in revealedGates" :key="k" v-model="mergeOp.gates[k]" :disabled="!hasPort() || !!busy" @change="onGateChange">{{ gateLabels[k] }}</el-checkbox>
						</div>
						<div v-if="mergeOut" class="merge-output" v-html="mergeOut"></div>
					</div>
				</div>

				<!-- 触发区（请求 L3 重算）已搬到「流水线」页（pipeline-viewer.html）：
				     三层的同名动作 + 队列上下文合成了一张表，这一页只剩会改画像文件的写动作。
				     按钮搬走了要留一句指引 —— 凭空消失而不说去哪了是最糟的失效方式。 -->
				<p v-if="!isEnglish" class="hint">「请求 L3 重算」在顶部
					<a :href="pipelineHref">流水线页</a>
					（那里还有队列与三层子代理的在跑 / 停止）。</p>
				<p v-else class="hint">To request an L3 run, open the <a :href="pipelineHref">Pipeline page</a>. The queue and running subagents for all three layers are managed there.</p>
			</section>
		</main>
		`,
	};

	V.vue.mount(PAGE, { active: "l3-viewer.html" });
})();
