/*
 * viewers/assets/l3-view.js —— L3 画像层的页面逻辑
 *
 * 依赖：viewer-core.js（window.V）。
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
 * 写动作全部经桥转发到 `scripts/l1-admin/*.mts`，且都遵循"预演 → 打字确认 → 执行"两步：
 *   · 条目增删改 → `USER-temp.md`（**提议稿**，不是 live）；要生效须再走"并入"；
 *   · 备份还原 → 目标也是 `USER-temp.md`（备份名不记当时捕的是哪份，统一落到 L3 唯一写目标）；
 *   · 并入 live → 全仓库唯一写 `USER.md` 的路径，服务端三道安全闸（陈旧 / 过半删除 / 清空）
 *     默认拒绝，页面只把拒绝原文回显，并把**对应的放行勾选框**在拒绝之后才显示（绝不预勾）。
 * 注：运行中的 pi 会话注入的是**冻结快照**，并入后要 `/reload` 或新开会话才读到新画像。
 */
(function () {
	"use strict";

	var V = window.V;

	var state = {
		cursor: null,
		pending: null,
		pendingTriggers: null,
		limits: null,
		backups: [],
		files: {},
	};

	// ── 管理操作区的分步状态（都在内存里，刷新即重置）────────────────────────
	//
	// 三个写动作（条目编辑 / 备份还原 / 并入 live）都是"预演 → 打字确认 → 执行"两步：
	// `previewed` 记录"本动作是否已成功预演过"，未预演前「执行」恒禁用（仅靠 token 不够）。
	var entryLists = { USER: [], temp: [] };
	/** 条目编辑中的动作：action ∈ add/update/delete；target 是 update/delete 的定位片段。 */
	var editOp = { action: "add", target: null, previewed: false };
	/** 还原中的备份文件与放行状态（gateEmpty = 服务端报"空备份会清空"这道闸）。 */
	var restoreOp = { file: null, previewed: false, gateEmpty: false, allowEmpty: false };
	/** 并入状态：revealed = 服务端拒绝暴露出的安全闸（放行勾选框按它出现）；gates = 已勾选放行项。 */
	var mergeOp = { previewed: false, revealed: {}, gates: {} };

	function $(id) {
		return document.getElementById(id);
	}

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

	/** 加载与游标、画像三件套、阈值、备份，以及三层的待消费触发信号。 */
	function loadAll() {
		return Promise.all([
			V.loadJson("../l3/cursor.json"),
			V.loadJson("../l3/pending-trigger.json"),
			V.bridge("/api/limits"),
			V.bridge("/api/l3/backups"),
			// 画像三件套在 profile **根**（memoryDB 的上一级），桥只挂载 memoryDB：
			// 相对路径 `../../USER.md` 在浏览器里会解析回 `/USER.md` = {memoryDB}/USER.md → 404。
			// 所以必须走白名单端点，不能靠相对路径。
			V.bridge("/api/profile-files"),
			// 三层的待消费触发信号（只读探查，不消费）—— 触发区据此显示"是否已有信号在等 pi 消费"。
			V.bridge("/api/pending-triggers"),
		]).then(function (r) {
			state.cursor = r[0] || null;
			state.pending = r[1] || null;
			state.limits = r[2] && r[2].ok ? r[2].data.l3 : null;
			state.backups = r[3] && r[3].ok && r[3].data.backups ? r[3].data.backups : [];
			state.pendingTriggers = r[5] && r[5].ok && r[5].data ? r[5].data : null;
			var pf = r[4] && r[4].ok && r[4].data && r[4].data.files ? r[4].data.files : null;
			state.profileFilesAvailable = !!pf;
			state.files = {
				MEMORY: { raw: pf ? pf["MEMORY.md"] : null, label: "MEMORY.md", note: "由 core/store 维护（不是 L3 产物）" },
				USER: { raw: pf ? pf["USER.md"] : null, label: "USER.md", note: "live 画像；L3 只读它" },
				temp: { raw: pf ? pf["USER-temp.md"] : null, label: "USER-temp.md", note: "L3 提议稿；合并进 live 是人工动作" },
			};
		});
	}

	/**
	 * 逐条自检。每一条都是"能被这页看到、且真的会出问题"的形态，不是凑数的校验：
	 *   · 首条以 § 开头 → 文件开头多了一个分隔符，那个 § 会粘进正文（实测 USER-temp.md 就是）
	 *   · 条目内含换行 → 违反"单条必须单行"的契约（整篇重写就是从这里溜进来的）
	 *   · 条目超长 → 超过 entryCharLimit 会被 l3_edit 拒绝
	 *   · 重复条目 → 同一句写了两遍，白占预算
	 */
	function inspectEntries(entries, key) {
		var limits = state.limits || { entryCharLimit: 500 };
		var issues = [];
		if (entries.length > 0 && entries[0].indexOf("§") === 0) {
			issues.push({ level: "warn", text: "首个条目以 § 开头 —— 文件开头多了一个分隔符，那段 §（连同换行）已被并进第一条正文。" });
		}
		entries.forEach(function (e, i) {
			if (/\r?\n/.test(e)) issues.push({ level: "warn", text: "第 " + (i + 1) + " 条含换行 —— 条目必须是单行（单条契约）。" });
			if (e.length > limits.entryCharLimit) issues.push({ level: "warn", text: "第 " + (i + 1) + " 条 " + e.length + " 字符，超过单条上限 " + limits.entryCharLimit + "，l3_edit 会拒绝写入。" });
		});
		var seen = new Map();
		entries.forEach(function (e, i) {
			var prev = seen.get(e);
			if (prev !== undefined) issues.push({ level: "warn", text: "第 " + (prev + 1) + " 条与第 " + (i + 1) + " 条完全重复。" });
			else seen.set(e, i);
		});
		return issues;
	}

	function budgetBar(label, entries, limit, extraNote) {
		var used = entryBudget(entries);
		var pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
		var over = used > limit;
		return (
			'<div class="budget"><div class="meta"><span>' + V.escapeHtml(label) + "</span><span>" + used.toLocaleString() + " / " + limit.toLocaleString() + " 字符（" + pct + "%）</span></div>" +
			'<div class="track"><i class="' + (over ? "over" : "") + '" style="width:' + pct + '%"></i></div>' +
			(extraNote ? '<div class="hint">' + extraNote + "</div>" : "") +
			"</div>"
		);
	}

	function renderCursor() {
		var c = state.cursor;
		var limits = state.limits || {};
		var interval = typeof limits.interval === "number" ? limits.interval : null;
		if (!c) {
			$("cursor").innerHTML = '<div class="notice warn">没有 <code>l3/cursor.json</code>（L3 从未运行过？）。</div>';
			return;
		}
		var since = typeof c.memoriesSinceLastPersona === "number" ? c.memoriesSinceLastPersona : null;
		var pct = interval ? Math.min(100, Math.round(((since || 0) / interval) * 100)) : 0;
		$("cursor").innerHTML =
			'<div class="stats">' +
			[
				["最近画像更新", V.fmtTime(c.lastPersonaUpdate)],
				["最近触发", V.fmtTime(c.lastTriggeredAt)],
				["最近提交", V.fmtTime(c.lastCommittedAt)],
			]
				.map(function (kv) {
					return '<div class="stat"><span>' + kv[0] + "</span><span>" + V.escapeHtml(kv[1]) + "</span></div>";
				})
				.join("") +
			"</div>" +
			(interval === null
				? '<div class="hint">无写盘桥：读不到 <code>L3_INTERVAL</code>，无法显示 P4 触发进度。</div>'
				: '<div class="budget"><div class="meta"><span>P4 记忆阈值进度</span><span>' + (since === null ? "—" : since) + " / " + interval + "</span></div>" +
					'<div class="track"><i style="width:' + pct + '%"></i></div>' +
					'<div class="hint">新增记忆累计到 ' + interval + ' 条时触发 P4。触发分级：P1 显式请求 / P2 冷启动 / P2.5 恢复 / P3 首次场景 / P4 记忆阈值。</div></div>') +
			(state.pending
				? '<div class="notice warn">存在 <code>pending-trigger.json</code>：<code>' + V.escapeHtml(JSON.stringify(state.pending)) + "</code></div>"
				: "") +
			(c.lastTriggeredAt && c.lastCommittedAt && V.ts(c.lastTriggeredAt) > V.ts(c.lastCommittedAt)
				? '<div class="notice">最近一次触发晚于最近一次提交 —— 也就是「跑了但没提交」。这两个字段分开记就是为了让这种情况可见。</div>'
				: "");
	}

	function renderFiles() {
		var limits = state.limits || {};
		var userLimit = typeof limits.userCharLimit === "number" ? limits.userCharLimit : 2200;
		var memLimit = typeof limits.memoryCharLimit === "number" ? limits.memoryCharLimit : 2200;
		var entriesOf = {};
		Object.keys(state.files).forEach(function (k) {
			entriesOf[k] = parseEntries(state.files[k].raw);
		});

		var allIssues = [];
		["MEMORY", "USER", "temp"].forEach(function (k) {
			inspectEntries(entriesOf[k], k).forEach(function (i) {
				allIssues.push({ level: i.level, text: state.files[k].label + "：" + i.text });
			});
		});

		$("budgets").innerHTML =
			(state.profileFilesAvailable
				? ""
				: '<div class="notice warn"><b>读不到画像文件</b>：<code>MEMORY.md</code> / <code>USER.md</code> / <code>USER-temp.md</code> ' +
					"位于 profile <b>根</b>目录（<code>memoryDB</code> 的上一级），而写盘桥只挂载 <code>memoryDB</code>。" +
					"请用桥打开 —— 端点 <code>/api/profile-files</code> 会按白名单读取它们；下面的数字因此不可信。</div>") +
			budgetBar("MEMORY.md（" + entriesOf.MEMORY.length + " 条）", entriesOf.MEMORY, memLimit, state.files.MEMORY.note) +
			budgetBar("USER.md（" + entriesOf.USER.length + " 条）", entriesOf.USER, userLimit, state.files.USER.note) +
			budgetBar("USER-temp.md（" + entriesOf.temp.length + " 条，提议稿）", entriesOf.temp, userLimit, state.files.temp.note) +
			'<div class="hint">预算按 <code>entryBudget</code> 计（条目正文 + 分隔符），<b>不是文件字节数</b>：中文 1 字符 = 3 字节，' +
			"用 <code>ls</code> 的字节数看会误判成严重超限。</div>" +
			(allIssues.length === 0
				? '<div class="notice">三份文件逐条自检无异常。</div>'
				: allIssues
						.map(function (i) {
							return '<div class="notice warn">' + V.escapeHtml(i.text) + "</div>";
						})
						.join(""));

		// 差异：temp 里独有 = 待合入的提议；live 里独有 = temp 未覆盖到的现存规则
		var inTempOnly = entriesOf.temp.filter(function (e) { return entriesOf.USER.indexOf(e) < 0; });
		var inUserOnly = entriesOf.USER.filter(function (e) { return entriesOf.temp.indexOf(e) < 0; });
		$("diff").innerHTML =
			'<div class="chips"><span class="chip">temp 独有 ' + inTempOnly.length + "</span><span class=\"chip\">live 独有 " + inUserOnly.length + "</span></div>" +
			'<h2>temp 独有（待人工合入 live）</h2>' +
			(inTempOnly.length === 0
				? '<div class="hint">无</div>'
				: inTempOnly
						.map(function (e) {
							return '<div class="entry added"><span class="tag added">待合入</span> ' + V.escapeHtml(e) + "</div>";
						})
						.join("")) +
			'<h2>live 独有（temp 未覆盖）</h2>' +
			(inUserOnly.length === 0
				? '<div class="hint">无</div>'
				: '<details class="more"><summary>展开 ' + inUserOnly.length + " 条</summary>" +
					inUserOnly
						.map(function (e) {
							return '<div class="entry">' + V.escapeHtml(e) + "</div>";
						})
						.join("") +
					"</details>");

		// 逐条清单（三份文件）
		$("entries").innerHTML = ["MEMORY", "USER", "temp"]
			.map(function (k) {
				var f = state.files[k];
				var list = entriesOf[k];
				var issuesForFile = inspectEntries(list, k);
				return (
					'<h2><code>' + V.escapeHtml(f.label) + "</code> —— " + list.length + " 条" +
					(issuesForFile.length ? ' <span class="chip err">' + issuesForFile.length + " 项异常</span>" : "") +
					(list.length === 0 ? ' <span class="chip">空</span>' : "") + "</h2>" +
					(list.length === 0
						? '<div class="hint">（空文件或不存在）' + V.escapeHtml(f.note) + "</div>"
						: list
								.map(function (e, i) {
									var bad = /\r?\n/.test(e) || e.length > (state.limits ? state.limits.entryCharLimit : 500);
									return (
										'<div class="entry' + (bad ? "" : "") + '"><span class="idx">' + (i + 1) + ".</span>" + V.escapeHtml(e) +
										'<span class="chip">' + e.length + " 字符</span></div>"
									);
								})
								.join(""))
				);
			})
			.join("");
	}

	function renderBackups() {
		// 这里**不设** max-height：设了就是一层内滚动（本页纪律：长内容进 <details>，页面统一滚）。
		// 备份清单通常很短，直接让它随页面滚即可。
		$("backups").innerHTML = state.backups.length
			? '<div class="wrap-scroll"><table><thead><tr><th>备份文件</th><th>大小</th><th>时间</th></tr></thead><tbody>' +
				state.backups
					.slice()
					.reverse()
					.map(function (b) {
						return "<tr><td>" + V.escapeHtml(b.file) + '</td><td class="num">' + b.size + "</td><td>" + V.escapeHtml(V.fmtTime(b.mtime)) + "</td></tr>";
					})
					.join("") +
				"</tbody></table></div>"
			: '<div class="hint">没有备份（或未用写盘桥：<code>backups/user-backups/</code> 需要桥来列目录）。</div>';
	}

	// ══ 管理操作区 ══════════════════════════════════════════════════════════════
	//
	// 这一区是全查看器唯一能改画像的地方（并入区更是全仓库唯一写 live USER.md 的路径），
	// 所以纪律比别处重：
	//   · 每个写动作都两步 —— 预演（apply 缺席 / false）看后果 → 执行（apply:true）；
	//   · 三个写端点（edit / restore / merge）在执行前都要求**打字确认**（token）：
	//     桥是 CORS 全开的本地进程，一次误点就是真写盘，token 把"手滑"挡在外面；
	//   · 服务端的拒绝理由**原文回显**，放行勾选框只在拒绝提到对应那一道闸时出现，且不预勾。
	//
	// 说明：条目编辑那个 token 是服务端 action 字面量的大写形式（ADD/UPDATE/DELETE）。
	// `/api/l3/edit` 在桥里没有 confirm 字段（不像 restore=文件名、merge=MERGE），所以这道
	// 确认纯粹是客户端摩擦，选"动作词"是为了让人在点之前再确认一次**动作本身**选对了没。

	/** 条目写动作的确认词（先预演、再原样输入、才启用「执行」）。 */
	function editToken(action) {
		if (action === "delete") return "DELETE";
		if (action === "update") return "UPDATE";
		return "ADD";
	}

	/** 变更差异清单（还原 / 并入共用）：加了几条、删了几条 + 逐条增删。 */
	function diffHtml(added, removed, addedTotal, removedTotal) {
		var a = Array.isArray(added) ? added : [];
		var rm = Array.isArray(removed) ? removed : [];
		var aT = typeof addedTotal === "number" ? addedTotal : a.length;
		var rT = typeof removedTotal === "number" ? removedTotal : rm.length;
		var html =
			'<div class="chips"><span class="chip">会加 ' + aT + " 条</span>" +
			'<span class="chip">会删 ' + rT + " 条</span></div>";
		if (a.length || rm.length) {
			html += '<ul class="diff-list">';
			html += a.map(function (t) { return '<li class="add">' + V.escapeHtml(t) + "</li>"; }).join("");
			if (aT > a.length) html += '<li class="more">另有 ' + (aT - a.length) + " 条未列出</li>";
			html += rm.map(function (t) { return '<li class="del">' + V.escapeHtml(t) + "</li>"; }).join("");
			if (rT > rm.length) html += '<li class="more">另有 ' + (rT - rm.length) + " 条未列出</li>";
			html += "</ul>";
		} else {
			html += '<div class="hint">条目没有差异（可能只改了行尾 / 结尾换行）。</div>';
		}
		return html;
	}

	/** 从容器事件里找到触发它的 <button>（事件目标的子元素也要能命中）。 */
	function closestButton(ev, selector) {
		var t = ev.target;
		if (!t || !t.closest) return null;
		return t.closest(selector || "button");
	}

	/** 一条条目一行：正文 + 长度 + 改写 / 删除。动作经 data-* 交给容器委托（不生成 id）。 */
	function entryRows(sid, entries) {
		return entries
			.map(function (e, i) {
				var head =
					'<div class="entry"><span class="idx">' + (i + 1) + ".</span>" + V.escapeHtml(e) +
					'<span class="chip">' + e.length + " 字符</span>";
				return (
					head +
					'<button type="button" data-op="edit" data-sid="' + sid + '" data-idx="' + i + '">改写</button>' +
					'<button type="button" class="danger" data-op="del" data-sid="' + sid + '" data-idx="' + i + '">删除</button>' +
					"</div>"
				);
			})
			.join("");
	}

	/** 无写盘桥时：给出提示并禁用整块操作区（否则按钮只会去调一个不存在的端口）。 */
	function disableOpsControls() {
		Array.prototype.forEach.call($("ops").querySelectorAll("button, input"), function (el) {
			el.disabled = true;
		});
	}

	function renderTriggerState() {
		var p = state.pendingTriggers && state.pendingTriggers.pending ? state.pendingTriggers.pending.l3 : null;
		$("opsTriggerState").textContent = p ? "已有信号待消费" + (p.at ? "（" + p.at + "）" : "") : "当前无待消费信号";
	}

	function renderOpsBackups() {
		if (!state.backups.length) {
			$("opsBackups").innerHTML = '<div class="hint">没有备份（或未用写盘桥）。</div>';
			return;
		}
		// 每行：文件名 / 大小 / 时间 + 预览（读静态路径）+ 还原（预演 → 打字确认 → 执行）。
		$("opsBackups").innerHTML = state.backups
			.slice()
			.reverse()
			.map(function (b) {
				var f = V.escapeHtml(b.file);
				return (
					'<div class="entry"><span class="idx">·</span>' + f +
					'<span class="chip">' + b.size + " B</span>" +
					'<span class="chip">' + V.escapeHtml(V.fmtTime(b.mtime)) + "</span>" +
					'<button type="button" data-op="preview" data-file="' + f + '">预览</button>' +
					'<button type="button" class="danger" data-op="restore" data-file="' + f + '">还原</button>' +
					'<div data-role="preview"></div></div>'
				);
			})
			.join("");
	}

	function renderMergeGates() {
		var labels = {
			stale: "仍要并入：允许用比 live 旧的提议稿覆盖（live 之后被改过，会丢掉那些改动）",
			mass: "仍要删除：同意一次删掉 live 过半条目",
			empty: "仍要清空：同意把 live 画像清空",
		};
		var keys = ["stale", "mass", "empty"].filter(function (k) { return mergeOp.revealed[k]; });
		$("opsMergeGates").innerHTML = keys.length
			? '<div class="notice warn">服务端拒绝了这次并入。要放行请<b>逐条显式勾选</b>（默认不勾）：</div>' +
				keys
					.map(function (k) {
						return (
							'<label class="check"><input type="checkbox" data-gate="' + k + '"' +
							(mergeOp.gates[k] ? " checked" : "") + ">" + V.escapeHtml(labels[k]) + "</label>"
						);
					})
					.join("")
			: "";
	}

	/** 把拒绝原文映射到它触发的安全闸（服务端按 ①陈旧 → ③清空 → ②过半 的顺序裁决）。 */
	function mergeGateFromError(msg) {
		if (/比 live 画像旧/.test(msg)) return "stale";
		if (/清空/.test(msg)) return "empty";
		if (/过半/.test(msg)) return "mass";
		return null;
	}

	/**
	 * 本地估算的并入差异（并入源恒为提议稿、目标恒为 live —— 与 `#diff` 那段同一口径）。
	 * 只在服务端拒绝、拿不到它自己的差异清单时用；成功预演时一律用服务端返回的权威差异。
	 */
	function localMergeDiff() {
		var live = parseEntries(state.files.USER ? state.files.USER.raw : null);
		var temp = parseEntries(state.files.temp ? state.files.temp.raw : null);
		return {
			added: temp.filter(function (e) { return live.indexOf(e) < 0; }),
			removed: live.filter(function (e) { return temp.indexOf(e) < 0; }),
		};
	}

	/** 渲染整块操作区（只读摘要 + 各区的当前状态）。只在加载 / 重新加载时调用。 */
	function renderOps() {
		var noBridge = !V.bridgePort();
		$("opsReadonly").style.display = noBridge ? "" : "none";
		if (noBridge) {
			$("opsReadonly").innerHTML =
				"<b>无写盘桥，管理操作全部禁用</b>：请用带 <code>?port=</code> 的地址打开（见页首提示）。" +
				"这些按钮都要经桥转发到 <code>scripts/l1-admin/*.mts</code>，没有桥就只是调一个不存在的端口。";
		}

		var entriesOf = {};
		Object.keys(state.files).forEach(function (k) {
			entriesOf[k] = parseEntries(state.files[k].raw);
		});
		entryLists = { USER: entriesOf.USER, temp: entriesOf.temp };

		var eLimit = state.limits && state.limits.entryCharLimit ? state.limits.entryCharLimit : 500;
		$("opsContentNote").textContent = "必须单行、不含 §、" + eLimit + " 字符以内。";
		// 醒目的一句：改的是提议稿，不是注入画像。
		$("opsEntryWarn").style.display = "";
		$("opsEntryWarn").innerHTML =
			"改写 / 删除 / 新增都落在 <code>USER-temp.md</code>（<b>提议稿</b>），<b>不会</b>立刻改变注入画像 —— " +
			"只有到「并入区」把它写进 live <code>USER.md</code> 之后才生效。" +
			"下面 live 列表本身只读；对它点改写 / 删除，改的同样是提议稿。";

		$("opsEntries").innerHTML =
			'<h3 class="sub">USER.md（live 画像，' + entriesOf.USER.length + " 条）</h3>" +
			(entriesOf.USER.length ? entryRows("USER", entriesOf.USER) : '<div class="hint">（无条目）</div>') +
			'<h3 class="sub">USER-temp.md（提议稿，' + entriesOf.temp.length + " 条）</h3>" +
			(entriesOf.temp.length ? entryRows("temp", entriesOf.temp) : '<div class="hint">（无条目）</div>');

		$("opsBackupNote").innerHTML =
			"还原目标是<b>提议稿 <code>USER-temp.md</code>，不是 live <code>USER.md</code></b>：" +
			"备份文件名只记时间戳、不记当时捕的是哪一份，所以统一还原到 L3 唯一的写目标，要上 live 再走一次「并入」。";
		renderOpsBackups();

		$("opsMergeNote").innerHTML =
			"这是<b>全仓库唯一会写 live <code>USER.md</code></b> 的动作。写前会先把 live 现况留档一份备份，" +
			"因此可回退。三道安全闸（提议稿比 live 旧 / 会删掉 live 过半条目 / 提议稿为空）默认拒绝，" +
			"拒绝理由原文会显示在下面，要放行必须逐条显式勾选。";
		renderMergeGates();

		renderTriggerState();

		if (noBridge) disableOpsControls();
	}

	// ── 条目区：改写 / 删除 / 加一条 ─────────────────────────────────────────

	function stageEdit(action, target) {
		editOp = { action: action, target: target || null, previewed: false };
		$("opsEditTitle").textContent = action === "delete" ? "删除条目（写 USER-temp.md）" : "改写条目（写 USER-temp.md）";
		$("opsTargetBox").textContent = target || "—（加一条不需要定位）";
		$("opsContent").value = action === "update" ? target : "";
		$("opsTokenHint").textContent = editToken(action);
		$("opsConfirm").value = "";
		$("opsApply").disabled = true;
		V.note("opsEditOut", "已选：<b>" + (action === "delete" ? "删除" : "改写") + "</b> 该条目。先点「预演」看后果。", "");
	}

	function resetEdit() {
		editOp = { action: "add", target: null, previewed: false };
		$("opsEditTitle").textContent = "加一条（写 USER-temp.md）";
		$("opsTargetBox").textContent = "—（加一条不需要定位）";
		$("opsContent").value = "";
		$("opsTokenHint").textContent = editToken("add");
		$("opsConfirm").value = "";
		$("opsApply").disabled = true;
		V.note("opsEditOut", "已切回「加一条」：填正文后点「预演」。", "");
	}

	function entryEditBody(apply) {
		var body = { action: editOp.action, apply: apply };
		if (editOp.action !== "delete") body.content = $("opsContent").value;
		if (editOp.action !== "add") body.target = editOp.target;
		return body;
	}

	function onEntryClick(ev) {
		var btn = closestButton(ev, "button[data-op]");
		if (!btn) return;
		var list = entryLists[btn.getAttribute("data-sid")] || [];
		var text = list[Number(btn.getAttribute("data-idx"))];
		if (typeof text !== "string") return;
		stageEdit(btn.getAttribute("data-op") === "edit" ? "update" : "delete", text);
	}

	function previewEdit() {
		// 客户端只挡"明显缺参数"（真正裁决在服务端：单条契约、定位唯一性、整篇预算）。
		if (editOp.action !== "delete" && $("opsContent").value.trim() === "") {
			V.note("opsEditOut", "正文为空，没有可写入的内容。", "warn");
			return;
		}
		V.note("opsEditOut", "预演中…", "");
		V.bridge("/api/l3/edit", { method: "POST", body: JSON.stringify(entryEditBody(false)) }).then(function (r) {
			var d = r.data || {};
			if (r.ok && d.success) {
				editOp.previewed = true;
				V.note(
					"opsEditOut",
					"预演通过（未落盘）：写入目标是 <code>" + V.escapeHtml(d.targetFile || "USER-temp.md") + "</code>，" +
						"操作后用量 <b>" + V.escapeHtml(String(d.usage || "")) + "</b>" +
						(typeof d.entryCount === "number" ? "、" + d.entryCount + " 条。" : "。") +
						(d.note ? " " + V.escapeHtml(d.note) : ""),
					"",
				);
				$("opsApply").disabled = $("opsConfirm").value !== editToken(editOp.action);
			} else {
				editOp.previewed = false;
				$("opsApply").disabled = true;
				var cand = Array.isArray(d.candidates) && d.candidates.length ? " 候选：" + d.candidates.map(V.escapeHtml).join(" ／ ") : "";
				V.note("opsEditOut", "预演被拒：" + V.escapeHtml(d.error || "HTTP " + r.status) + cand, "err");
			}
		});
	}

	function applyEdit() {
		if (!editOp.previewed || $("opsConfirm").value !== editToken(editOp.action)) return;
		$("opsApply").disabled = true;
		V.note("opsEditOut", "写入中…", "");
		V.bridge("/api/l3/edit", { method: "POST", body: JSON.stringify(entryEditBody(true)) }).then(function (r) {
			var d = r.data || {};
			if (r.ok && d.success) {
				V.note(
					"opsEditOut",
					"已写入 <code>" + V.escapeHtml(d.targetFile || "USER-temp.md") + "</code>（提议稿）：用量 <b>" +
						V.escapeHtml(String(d.usage || "")) + "</b>。" + V.escapeHtml(d.note || "") +
						" 要进入注入画像，还需到下面「并入区」并入。",
					"",
				);
				editOp.previewed = false;
				$("opsConfirm").value = "";
				reloadAfterWrite();
			} else {
				editOp.previewed = false;
				V.note("opsEditOut", "执行失败：" + V.escapeHtml(d.error || "HTTP " + r.status), "err");
			}
		});
	}

	// ── 备份区：预览 / 还原 ─────────────────────────────────────────────────

	function previewBackup(btn, file) {
		var slot = btn.parentNode ? btn.parentNode.querySelector('[data-role="preview"]') : null;
		if (!slot) return;
		slot.innerHTML = '<div class="hint">读取中…</div>';
		// 备份内容走静态托管（桥把 memoryDB 整个挂上）——`../backups/…` 落在 memoryDB/backups 下。
		V.loadText("../backups/user-backups/" + encodeURIComponent(file)).then(function (txt) {
			if (txt === null) {
				slot.innerHTML = '<div class="notice warn">读不到这份备份（静态路径 404）。</div>';
				return;
			}
			var n = parseEntries(txt).length;
			// 长文本进 <details>，不开内滚动。
			slot.innerHTML =
				'<details class="log"><summary>预览 ' + V.escapeHtml(file) + "（" + n + " 条）</summary>" +
				'<div class="log-text">' + V.escapeHtml(txt) + "</div></details>";
		});
	}

	/** 打开某份备份的还原面板（预演 → 打字确认文件名 → 执行）。 */
	function stageRestore(file) {
		restoreOp = { file: file, previewed: false, gateEmpty: false, allowEmpty: false };
		var f = V.escapeHtml(file);
		$("opsRestoreOut").innerHTML =
			'<div class="ops-row"><div class="ops-label">还原</div><div class="ops-ctl">' +
			'<span class="confirm-token">' + f + "</span>" +
			'<button type="button" id="opsRestorePreview" data-file="' + f + '">预演还原</button>' +
			"</div>" +
			'<div class="ops-note">备份内容会覆盖<b>提议稿</b>（写前先把当前提议稿另存一份，故还原本身也可回退）。</div></div>' +
			'<div id="opsRestoreGates"></div>' +
			'<div id="opsRestoreDiff"></div>' +
			'<div class="ops-row"><div class="ops-label">确认</div><div class="ops-ctl">' +
			"<span>原样输入备份文件名 <span class=\"confirm-token\">" + f + "</span></span>" +
			'<input type="text" class="confirm-input" id="opsRestoreConfirm" autocomplete="off" />' +
			'<button type="button" class="danger" id="opsRestoreApply" disabled>执行还原</button>' +
			"</div></div>" +
			'<div id="opsRestoreMsg"></div>';
		if (V.bridgePort()) $("opsRestoreConfirm").focus();
		else disableOpsControls();
	}

	function toggleRestoreApply() {
		var btn = $("opsRestoreApply");
		if (!btn) return;
		var input = $("opsRestoreConfirm");
		var tokenOk = !!input && input.value === restoreOp.file;
		// 空备份清空提议稿被拒后，必须先勾选放行（gateOk）才允许执行。
		var gateOk = !restoreOp.gateEmpty || restoreOp.allowEmpty;
		btn.disabled = !(restoreOp.previewed && tokenOk && gateOk) || !V.bridgePort();
	}

	function previewRestore() {
		if (!restoreOp.file) return;
		V.note("opsRestoreMsg", "预演中…", "");
		V.bridge("/api/l3/restore", {
			method: "POST",
			body: JSON.stringify({ file: restoreOp.file, apply: false, allowEmpty: restoreOp.allowEmpty }),
		}).then(function (r) {
			var d = r.data || {};
			if (r.ok && d.ok) {
				restoreOp.previewed = true;
				restoreOp.gateEmpty = false;
				$("opsRestoreGates").innerHTML = "";
				$("opsRestoreDiff").innerHTML = diffHtml(d.added, d.removed, d.addedTotal, d.removedTotal);
				V.note(
					"opsRestoreMsg",
					"预演通过（未落盘）：提议稿 " + d.beforeCount + " → " + d.afterCount + " 条（" +
						V.escapeHtml(String(d.beforeChars)) + " → " + V.escapeHtml(String(d.afterChars)) + " 字符）。",
					"",
				);
			} else {
				restoreOp.previewed = false;
				var msg = d.error || "HTTP " + r.status;
				V.note("opsRestoreMsg", "预演被拒：" + V.escapeHtml(msg), "err");
				// 空备份（0 条）覆盖有内容的提议稿：服务端专门拒这一种，要显式放行。
				if (/空/.test(msg) && !restoreOp.gateEmpty) {
					restoreOp.gateEmpty = true;
					$("opsRestoreGates").innerHTML =
						'<label class="check"><input type="checkbox" id="opsRestoreGateEmpty"' +
						(restoreOp.allowEmpty ? " checked" : "") + ">这是空备份，仍要清空提议稿</label>";
				}
			}
			toggleRestoreApply();
		});
	}

	function applyRestore() {
		if (!restoreOp.previewed) return;
		if (!$("opsRestoreConfirm") || $("opsRestoreConfirm").value !== restoreOp.file) return;
		if (restoreOp.gateEmpty && !restoreOp.allowEmpty) return;
		V.note("opsRestoreMsg", "还原中…", "");
		V.bridge("/api/l3/restore", {
			method: "POST",
			body: JSON.stringify({ file: restoreOp.file, apply: true, confirm: restoreOp.file, allowEmpty: restoreOp.allowEmpty }),
		}).then(function (r) {
			var d = r.data || {};
			if (r.ok && d.ok) {
				V.note("opsRestoreMsg", "已还原到 <code>" + V.escapeHtml(d.file || "USER-temp.md") + "</code>（提议稿）。" + V.escapeHtml(d.note || "") + " 要上 live 还要走「并入区」。", "");
				restoreOp = { file: null, previewed: false, gateEmpty: false, allowEmpty: false };
				$("opsRestoreDiff").innerHTML = "";
				$("opsRestoreGates").innerHTML = "";
				$("opsRestoreConfirm").value = "";
				reloadAfterWrite();
			} else {
				restoreOp.previewed = false;
				V.note("opsRestoreMsg", "还原失败：" + V.escapeHtml(d.error || "HTTP " + r.status), "err");
				toggleRestoreApply();
			}
		});
	}

	function onBackupClick(ev) {
		var btn = closestButton(ev, "button[data-op]");
		if (!btn) return;
		var file = btn.getAttribute("data-file");
		if (btn.getAttribute("data-op") === "preview") previewBackup(btn, file);
		else stageRestore(file);
	}

	function onRestoreClick(ev) {
		var btn = closestButton(ev, "button");
		if (!btn) return;
		if (btn.id === "opsRestorePreview") previewRestore();
		else if (btn.id === "opsRestoreApply") applyRestore();
	}

	// ── 并入区：预演 → 三道闸放行 → MERGE → 执行 ─────────────────────────────

	function toggleMergeApply() {
		var btn = $("opsMergeApply");
		if (!btn) return;
		// 已暴露的每一道闸都必须勾选（否则服务端会再拒一次）。
		var gatesOk = ["stale", "mass", "empty"].every(function (k) {
			return !mergeOp.revealed[k] || mergeOp.gates[k];
		});
		btn.disabled = !(mergeOp.previewed && $("opsMergeConfirm").value === "MERGE" && gatesOk) || !V.bridgePort();
	}

	function mergeBody(apply) {
		return {
			apply: apply,
			confirm: apply ? "MERGE" : undefined,
			allowStale: !!mergeOp.gates.stale,
			allowMassRemoval: !!mergeOp.gates.mass,
			allowEmpty: !!mergeOp.gates.empty,
		};
	}

	function previewMerge() {
		V.note("opsMergeOut", "预演中…", "");
		V.bridge("/api/l3/merge", { method: "POST", body: JSON.stringify(mergeBody(false)) }).then(function (r) {
			var d = r.data || {};
			if (r.ok && d.ok) {
				mergeOp.previewed = true;
				// **成功分支必须把上一次的拒绝现场清掉**（与 previewRestore 对齐）：否则在一次被拒之后再来一次
				// 成功的预演，屏幕上会同时出现「预演通过」与「服务端拒绝了这次并入」+ 一排放行勾选框 ——
				// 自相矛盾的界面比没有界面更坏（本项目反复记过"误导态"这一条）。
				// 放行勾选也一并归零：它只在"服务端刚拒绝过"这个语境里有意义；留着会让用户在勾选框已被清掉、
				// 看不见的情况下，仍把 allow* 带进请求体（等于偷偷放行）。
				mergeOp.revealed = {};
				mergeOp.gates = {};
				$("opsMergeGates").innerHTML = "";
				$("opsMergeOut").innerHTML =
					'<div class="notice">预演通过（未落盘）：<code>' + V.escapeHtml(d.file || "USER.md") + "</code> " +
					d.beforeCount + " → " + d.afterCount + " 条，" + V.escapeHtml(String(d.beforeChars)) + " → " +
					V.escapeHtml(String(d.afterChars)) + " 字符。</div>" +
					diffHtml(d.added, d.removed, d.addedTotal, d.removedTotal) +
					'<div class="hint">live mtime ' + V.escapeHtml(V.fmtTime(d.liveMtime)) + " · 提议稿 mtime " +
					V.escapeHtml(V.fmtTime(d.tempMtime)) + "</div>";
			} else {
				mergeOp.previewed = false;
				var msg = d.error || "HTTP " + r.status;
				var gate = mergeGateFromError(msg);
				if (gate) mergeOp.revealed[gate] = true;
				// CLI 包装在拒绝时只透出 {success:false,error}（viewer-cli 的 fail 不带差异字段），
				// 所以这里用本页已载入的内容补一份**同口径**估算（并入源恒为 temp、目标恒为 live，
				// 与上面「提议稿与 live 的差异」那段一致），让"会删几条"始终看得见。
				var local = localMergeDiff();
				$("opsMergeOut").innerHTML =
					'<div class="notice err">预演被拒：' + V.escapeHtml(msg) + "</div>" +
					diffHtml(local.added.slice(0, 20), local.removed.slice(0, 20), local.added.length, local.removed.length) +
					'<div class="hint">上面的差异是按本页当前已载入的 live / 提议稿估算的（服务端在给出自己的差异之前就拒绝了）。</div>';
				renderMergeGates();
			}
			toggleMergeApply();
		});
	}

	function applyMerge() {
		if (!mergeOp.previewed || $("opsMergeConfirm").value !== "MERGE") return;
		$("opsMergeApply").disabled = true;
		V.note("opsMergeOut", "并入中…", "");
		V.bridge("/api/l3/merge", { method: "POST", body: JSON.stringify(mergeBody(true)) }).then(function (r) {
			var d = r.data || {};
			if (r.ok && d.ok) {
				$("opsMergeOut").innerHTML =
					'<div class="notice">已写入 live <code>' + V.escapeHtml(d.file || "USER.md") + "</code>：" +
					d.beforeCount + " → " + d.afterCount + " 条。" +
					(d.backupFile ? "写前备份 <code>" + V.escapeHtml(d.backupFile) + "</code>。" : "（live 原本不存在，未产生备份。）") +
					"</div>" +
					'<div class="notice warn">注意：<b>运行中的 pi 会话仍注入旧画像</b>（注入用的是启动时构建的冻结快照）。' +
					"要等 <code>/reload</code> 或新开一个会话才会读到新画像 —— 刷新本页不算。</div>";
				mergeOp = { previewed: false, revealed: {}, gates: {} };
				$("opsMergeConfirm").value = "";
				renderMergeGates();
				toggleMergeApply();
				reloadAfterWrite();
			} else {
				mergeOp.previewed = false;
				var msg = d.error || "HTTP " + r.status;
				var gate = mergeGateFromError(msg);
				if (gate) mergeOp.revealed[gate] = true;
				V.note("opsMergeOut", "并入失败：" + V.escapeHtml(msg), "err");
				renderMergeGates();
				toggleMergeApply();
			}
		});
	}

	// ── 触发区：请求入队（不是立即执行）─────────────────────────────────────

	function refreshPendingTriggers() {
		return V.bridge("/api/pending-triggers").then(function (r) {
			if (r.ok && r.data) state.pendingTriggers = r.data;
			renderTriggerState();
		});
	}

	function triggerL3() {
		V.note("opsTriggerOut", "请求入队中…", "");
		V.bridge("/api/trigger", { method: "POST", body: JSON.stringify({ layer: "l3", reason: "viewer 手动触发" }) }).then(function (r) {
			var d = r.data || {};
			if (r.ok && d.success) {
				V.note(
					"opsTriggerOut",
					V.escapeHtml(d.note || "已写入请求。") +
						" 它<b>只负责入队，不是立即执行</b>：需要 pi 会话活着，并在下一轮结束（<code>agent_settled</code>）时由主进程消费。",
					"",
				);
			} else {
				V.note("opsTriggerOut", "触发失败：" + V.escapeHtml(d.error || "HTTP " + r.status), "err");
			}
			return refreshPendingTriggers();
		});
	}

	/** 写盘成功后重取数据并重绘（不改动各区自己刚写好的结果提示）。 */
	function reloadAfterWrite() {
		return loadAll().then(function () {
			renderAll();
			V.note("loadNote", "已重载（" + state.backups.length + " 个备份 / 提议稿 " + entryLists.temp.length + " 条）。", "");
		});
	}

	function renderAll() {
		renderCursor();
		renderFiles();
		renderBackups();
		renderOps();
	}

	function bind() {
		$("reloadBtn").addEventListener("click", function () {
			autoLoad();
		});

		// 条目区：容器上委托（条目行是渲染出来的，逐个挂监听会随每次重绘泄漏）。
		$("opsEntries").addEventListener("click", onEntryClick);
		$("opsPreview").addEventListener("click", previewEdit);
		$("opsApply").addEventListener("click", applyEdit);
		$("opsResetEdit").addEventListener("click", resetEdit);
		// token 匹配前「执行」恒禁用（即便已预演通过）。
		$("opsConfirm").addEventListener("input", function () {
			$("opsApply").disabled = !editOp.previewed || $("opsConfirm").value !== editToken(editOp.action);
		});

		// 备份区：预览 / 还原的按钮是渲染出来的，同样用容器委托；
		// 还原面板内部（预演 / 执行 / token 输入 / 空备份放行）也委托到它自己那层。
		$("opsBackups").addEventListener("click", onBackupClick);
		$("opsRestoreOut").addEventListener("click", onRestoreClick);
		$("opsRestoreOut").addEventListener("input", function (ev) {
			if (ev.target && ev.target.id === "opsRestoreConfirm") toggleRestoreApply();
		});
		$("opsRestoreOut").addEventListener("change", function (ev) {
			// 空备份放行：勾选后重跑预演，拿到真正的差异（服务端才不会再拒）。
			if (ev.target && ev.target.id === "opsRestoreGateEmpty") {
				restoreOp.allowEmpty = !!ev.target.checked;
				previewRestore();
			}
		});

		// 并入区：预演 / 执行 / MERGE 输入 / 三道闸的放行勾选（勾选变化即重跑预演）。
		$("opsMergePreview").addEventListener("click", previewMerge);
		$("opsMergeApply").addEventListener("click", applyMerge);
		$("opsMergeConfirm").addEventListener("input", toggleMergeApply);
		$("opsMergeGates").addEventListener("change", function (ev) {
			var gate = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-gate") : null;
			if (!gate) return;
			mergeOp.gates[gate] = !!ev.target.checked;
			previewMerge();
		});

		$("opsTrigger").addEventListener("click", triggerL3);
	}

	function autoLoad() {
		V.note("loadNote", "加载中…");
		return loadAll()
			.then(function () {
				renderAll();
				var missing = Object.keys(state.files).filter(function (k) {
					return state.files[k].raw === null;
				});
				V.note(
					"loadNote",
					"已加载游标、三份画像文件与 " + state.backups.length + " 个备份。" +
						(missing.length ? " <b>没读到：" + missing.map(function(k){return state.files[k].label;}).join("/") + "</b>" : "") +
						(state.limits ? " 阈值来自 /api/limits（源码常量）。" : " <b>无写盘桥：阈值与备份清单不可用</b>。"),
				);
			})
			.catch(function (e) {
				V.note("loadNote", "加载失败：" + V.escapeHtml(e && e.message ? e.message : String(e)), "err");
			});
	}

	function init() {
		V.mountChrome({ active: "l3-viewer.html" });
		bind();
		autoLoad();
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
})();
