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
 */
(function () {
	"use strict";

	var V = window.V;

	var state = {
		cursor: null,
		pending: null,
		limits: null,
		backups: [],
		files: {},
	};

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

	/** 加载与游标、画像三件套、阈值、备份。 */
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
		]).then(function (r) {
			state.cursor = r[0] || null;
			state.pending = r[1] || null;
			state.limits = r[2] && r[2].ok ? r[2].data.l3 : null;
			state.backups = r[3] && r[3].ok && r[3].data.backups ? r[3].data.backups : [];
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
		$("backups").innerHTML = state.backups.length
			? '<div class="wrap-scroll" style="max-height:300px"><table><thead><tr><th>备份文件</th><th>大小</th><th>时间</th></tr></thead><tbody>' +
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

	function renderAll() {
		renderCursor();
		renderFiles();
		renderBackups();
	}

	function bind() {
		$("reloadBtn").addEventListener("click", function () {
			autoLoad();
		});
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
