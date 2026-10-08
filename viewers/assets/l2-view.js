/*
 * viewers/assets/l2-view.js —— L2 场景层的页面逻辑
 *
 * 依赖：viewer-core.js（window.V）。本页只用 V（不涉及质量分，故不加载 quality-core）。
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
 */
(function () {
	"use strict";

	var V = window.V;

	var state = {
		index: [],
		members: {},
		archiveMembers: {},
		ledger: [],
		cursor: null,
		config: null,
		/** 桥列出的真实文件（权威目录视图）；无桥时为空 */
		dirLive: null,
		dirArchive: null,
		/** filename → {meta, body, raw} */
		blocks: new Map(),
		archiveBlocks: new Map(),
		selected: "",
		errors: [],
	};

	function $(id) {
		return document.getElementById(id);
	}

	// ── 解析场景块（与 memory/l2/commit-tool.ts 的 parseSceneBlock 同口径）──
	var META_START = "-----META-START-----";
	var META_END = "-----META-END-----";

	/**
	 * 解析块文件：META 段 + 正文。
	 *
	 * 与后端同款容错：找不到标记时**不报错**，整篇当正文、META 全空 —— 因为块文件是人可读的
	 * markdown，历史/手写的块可能没有 META，把它当"坏文件"会让整页空掉，得不偿失。
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

	/** 极简 markdown 渲染（标题 / 列表 / 代码块）；其余按 pre-wrap 原样展示，不做花哨处理。 */
	function renderMarkdown(body) {
		var lines = String(body || "").split("\n");
		var out = [];
		var inCode = false;
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			if (/^```/.test(line)) {
				inCode = !inCode;
				out.push(inCode ? '<pre class="json">' : "</pre>");
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

	// ── 加载 ────────────────────────────────────────────────────────────────
	function loadMeta() {
		return Promise.all([
			V.loadJson("../l2/index/scene_index.json"),
			V.loadJson("../l2/index/scene_members.json"),
			V.loadJson("../l2/archive/scene_members.json"),
			V.loadJsonl("../l2/archive/ledger.jsonl"),
			V.loadJson("../l2/cursor.json"),
			V.bridge("/api/limits"),
			V.bridge("/api/l2/blocks"),
		]).then(function (r) {
			state.index = Array.isArray(r[0]) ? r[0] : [];
			state.members = r[1] && typeof r[1] === "object" ? r[1] : {};
			state.archiveMembers = r[2] && typeof r[2] === "object" ? r[2] : {};
			state.ledger = Array.isArray(r[3]) ? r[3] : [];
			state.cursor = r[4] || null;
			state.config = r[5] && r[5].ok && r[5].data ? r[5].data.l2 : null;
			state.dirLive = r[6] && r[6].ok ? r[6].data.live : null;
			state.dirArchive = r[6] && r[6].ok ? r[6].data.archive : null;
		});
	}

	/** 取块文件名清单（index 给 live；archive 侧车给归档；桥的目录列举作权威补充）。 */
	function collectFilenames() {
		var live = {};
		state.index.forEach(function (e) {
			if (e && typeof e.filename === "string") live[e.filename] = true;
		});
		(state.dirLive || []).forEach(function (f) {
			live[f.file] = true;
		});
		Object.keys(state.members).forEach(function (f) {
			live[f] = true;
		});

		var archive = {};
		Object.keys(state.archiveMembers).forEach(function (f) {
			archive[f] = true;
		});
		(state.dirArchive || []).forEach(function (f) {
			archive[f.file] = true;
		});
		state.ledger.forEach(function (e) {
			if (e && e.op === "archive" && typeof e.filename === "string") archive[e.filename] = true;
		});
		return { live: Object.keys(live).sort(), archive: Object.keys(archive).sort() };
	}

	function loadBlocks() {
		var lists = collectFilenames();
		var tasks = [];
		lists.live.forEach(function (f) {
			tasks.push(
				V.loadText("../l2/scene-blocks/" + encodeURIComponent(f)).then(function (txt) {
					if (txt !== null) state.blocks.set(f, parseBlock(txt));
				}),
			);
		});
		lists.archive.forEach(function (f) {
			tasks.push(
				V.loadText("../l2/archive/" + encodeURIComponent(f)).then(function (txt) {
					if (txt !== null) state.archiveBlocks.set(f, parseBlock(txt));
				}),
			);
		});
		return Promise.all(tasks);
	}

	// ── 对账 ────────────────────────────────────────────────────────────────
	/**
	 * 逐项对账，返回问题清单。
	 *
	 * 每一条都对应一个真实可能的失效，而不是泛泛的"数据可能不一致"：
	 *   · 索引缺块 / 块未入索引 → 索引是派生物，重建时机与块变更不同步时会出现
	 *   · 侧车成员与索引成员不一致 → 索引会被重建、侧车不会，两者漂移意味着"数成员数"会数错
	 *   · 归档文件不在账本 / 账本提到但文件不在 → 归档的可追溯性（这就是 archive 与 delete 的区别）
	 *   · 成员 id 在文件里查不到（正文里的 id token）→ 侧车丢过或块被手工改过
	 *   · 同一 id 同时挂在多个块上 → 成员口径分叉
	 */
	function reconcile() {
		var issues = [];
		var indexByFile = new Map();
		state.index.forEach(function (e) {
			if (e && typeof e.filename === "string") indexByFile.set(e.filename, e);
		});

		// 索引 ↔ 磁盘块
		if (state.dirLive) {
			var diskLive = {};
			state.dirLive.forEach(function (f) {
				diskLive[f.file] = true;
			});
			state.index.forEach(function (e) {
				if (e && e.filename && !diskLive[e.filename]) issues.push({ level: "warn", text: "索引里有块「" + e.filename + "」，但 scene-blocks/ 下没有这个文件（索引未重建？）" });
			});
			state.dirLive.forEach(function (f) {
				if (!indexByFile.has(f.file)) issues.push({ level: "warn", text: "scene-blocks/ 下的「" + f.file + "」不在索引里（该块目前不会被 L3/注入看到）" });
			});
		} else {
			issues.push({ level: "info", text: "无写盘桥：拿不到 scene-blocks/ 的目录列举，无法核对「索引 ↔ 磁盘」是否一致（只能核对索引与侧车）" });
		}

		// 索引成员 ↔ 侧车成员
		state.index.forEach(function (e) {
			if (!e || !e.filename) return;
			var fromSidecar = state.members[e.filename];
			if (!fromSidecar) {
				if (Array.isArray(e.members) && e.members.length > 0) {
					issues.push({ level: "warn", text: "「" + e.filename + "」在索引里有 " + e.members.length + " 个成员，但 scene_members.json 侧车里没有这条 —— 侧车是权威，索引成员可能来自正文兜底解析" });
				}
				return;
			}
			var a = (e.members || []).slice().sort().join(",");
			var b = fromSidecar.slice().sort().join(",");
			if (a !== b) issues.push({ level: "warn", text: "「" + e.filename + "」的成员在索引与侧车不一致（索引 " + (e.members || []).length + " 个 / 侧车 " + fromSidecar.length + " 个）—— 索引是派生物，以侧车为准" });
		});

		// 归档：目录 ↔ 账本
		var ledgerArchived = {};
		state.ledger.forEach(function (e) {
			if (e && e.op === "archive" && e.filename) ledgerArchived[e.filename] = e;
		});
		if (state.dirArchive) {
			state.dirArchive.forEach(function (f) {
				if (!ledgerArchived[f.file]) issues.push({ level: "warn", text: "归档块「" + f.file + "」在 ledger.jsonl 里没有 archive 记录 —— 归档的可追溯性缺失" });
			});
		}
		Object.keys(ledgerArchived).forEach(function (f) {
			if (state.dirArchive && !state.dirArchive.some(function (d) { return d.file === f; })) {
				issues.push({ level: "warn", text: "账本记了「" + f + "」的 archive，但 archive/ 下没有该文件（已被 restore 后账本未补 restore 记录？）" });
			}
		});
		Object.keys(state.archiveMembers).forEach(function (f) {
			if (!ledgerArchived[f]) issues.push({ level: "warn", text: "归档侧车成员里有「" + f + "」，但账本没有它的 archive 记录" });
		});

		// 成员 id 是否在块正文里出现（兜底口径） / 是否被多个块声明
		var ownerOf = new Map();
		var allSidecars = [
			{ src: "live", obj: state.members },
			{ src: "archive", obj: state.archiveMembers },
		];
		allSidecars.forEach(function (s) {
			Object.keys(s.obj).forEach(function (f) {
				(s.obj[f] || []).forEach(function (id) {
					var prev = ownerOf.get(id);
					if (prev && prev !== f) issues.push({ level: "warn", text: "成员 " + id + " 同时挂在「" + prev + "」与「" + f + "」上（成员口径分叉）" });
					else ownerOf.set(id, f);
				});
			});
		});
		var tokenMissing = 0;
		ownerOf.forEach(function (f, id) {
			var blk = state.blocks.get(f) || state.archiveBlocks.get(f);
			if (!blk) return;
			if (blk.body.indexOf(id) < 0) tokenMissing++;
		});
		if (tokenMissing > 0) {
			issues.push({ level: "info", text: tokenMissing + " 个成员 id 在所属块的正文里找不到（可能是侧车回填过 / 或正文被手工改过）" });
		}

		return { issues: issues, ownerOf: ownerOf };
	}

	// ── 渲染 ────────────────────────────────────────────────────────────────
	function renderStats(recon) {
		var lists = collectFilenames();
		var maxScenes = state.config && typeof state.config.maxScenes === "number" ? state.config.maxScenes : null;
		var liveCount = state.index.length || lists.live.length;
		var grade = maxScenes === null ? "unknown" : liveCount >= maxScenes ? "red" : liveCount === maxScenes - 1 ? "orange" : liveCount >= Math.ceil(maxScenes * 0.8) ? "yellow" : "none";
		var gradeText = { red: "已满", orange: "差一个到上限", yellow: "接近上限", none: "未接近上限", unknown: "上限未知（无桥时读不到 l2.maxScenes）" }[grade];
		// 严重度 → CSS 类（色值只在 viewer.css 里有一份）。unknown 不给宽度，故不配色。
		var gradeClass = { red: "over", orange: "warn", yellow: "warn", none: "", unknown: "" }[grade];

		var memberTotal = 0;
		Object.keys(state.members).forEach(function (f) { memberTotal += (state.members[f] || []).length; });
		var archiveMemberTotal = 0;
		Object.keys(state.archiveMembers).forEach(function (f) { archiveMemberTotal += (state.archiveMembers[f] || []).length; });

		$("stats").innerHTML = [
			["live 块（索引）", state.index.length],
			["live 块（磁盘）", state.dirLive ? state.dirLive.length : "—"],
			["归档块", state.archiveBlocks.size],
			["live 成员总数", memberTotal],
			["归档成员总数", archiveMemberTotal],
			["账本条目", state.ledger.length],
			["对账问题", recon.issues.filter(function (i) { return i.level === "warn"; }).length],
		]
			.map(function (kv) {
				return '<div class="stat"><span>' + kv[0] + "</span><span>" + kv[1] + "</span></div>";
			})
			.join("");

		$("capNote").innerHTML =
			'<div class="budget"><div class="track"><i class="' + gradeClass + '" style="width:' +
			(maxScenes ? Math.min(100, Math.round((liveCount / maxScenes) * 100)) : 0) + '%"></i></div>' +
			'<div class="meta"><span>' + liveCount + " / " + (maxScenes === null ? "?" : maxScenes) + " 个 live 块</span><span>" + V.escapeHtml(gradeText) + "</span></div></div>" +
			(state.config
				? '<div class="hint">归档配置：' + (state.config.archive && state.config.archive.enabled ? "启用" : "关闭") +
					"（最低年龄 " + (state.config.archive && state.config.archive.minAgeCalendarDays) + " 日历天，每批最多 " +
					(state.config.archive && state.config.archive.maxPerBatch) + " 个）。归档块与 scene-blocks/ 平级，**不占 maxScenes 名额**。</div>"
				: '<div class="hint">无写盘桥：读不到 <code>l2.maxScenes</code>（配置节由 /api/l2/config 提供，避免把含密钥的 config/ 交给页面）。</div>');

		$("cursorNote").innerHTML = state.cursor
			? "<code>lastProcessedAt</code> = " + V.escapeHtml(V.fmtTime(new Date(state.cursor.lastProcessedAt).toISOString())) +
				"<br><code>lastRecordId</code> = " + V.escapeHtml(state.cursor.lastRecordId || "—") +
				'<br><span class="hint">水位用于「有哪些 L1 记录还没进任何场景块」的判定（见下方未归属统计）。</span>'
			: '<span class="hint">无 cursor.json</span>';

		var warn = recon.issues.filter(function (i) { return i.level === "warn"; });
		var info = recon.issues.filter(function (i) { return i.level !== "warn"; });
		$("reconcile").innerHTML =
			(warn.length === 0
				? '<div class="notice">对账无告警：索引 / 侧车 / 磁盘 / 账本四项一致。</div>'
				: warn
						.map(function (i) {
							return '<div class="notice warn">' + V.escapeHtml(i.text) + "</div>";
						})
						.join("")) +
			info
				.map(function (i) {
					return '<div class="notice">' + V.escapeHtml(i.text) + "</div>";
				})
				.join("");
	}

	function renderList(recon) {
		var lists = collectFilenames();
		var indexByFile = new Map();
		state.index.forEach(function (e) {
			if (e && e.filename) indexByFile.set(e.filename, e);
		});

		var rowOf = function (filename, archived) {
			var blk = (archived ? state.archiveBlocks : state.blocks).get(filename);
			var idx = indexByFile.get(filename);
			var sidecar = (archived ? state.archiveMembers : state.members)[filename];
			var meta = blk ? blk.meta : { created: "", updated: "", summary: "", heat: 0 };
			var heat = meta.heat || (idx ? idx.heat : 0) || 0;
			var summary = meta.summary || (idx ? idx.summary : "") || "";
			var members = sidecar || (idx && idx.members) || [];
			return (
				'<tr class="clickable" data-file="' + V.escapeHtml(filename) + '" data-archived="' + (archived ? "1" : "0") + '">' +
				"<td>" + V.escapeHtml(filename) + (blk && !blk.hasMeta ? ' <span class="chip">无 META</span>' : "") + (archived ? ' <span class="chip">已归档</span>' : "") + "</td>" +
				'<td class="num">' + heat + "</td>" +
				'<td class="num">' + members.length + "</td>" +
				"<td>" + V.escapeHtml(V.fmtDay(meta.updated || (idx && idx.updated))) + "</td>" +
				'<td style="max-width:520px">' + V.escapeHtml(summary) + "</td>" +
				"</tr>"
			);
		};

		$("blockTable").innerHTML =
			'<div class="wrap-scroll"><table><thead><tr><th>块文件</th><th>heat</th><th>成员</th><th>updated</th><th>summary</th></tr></thead><tbody>' +
			lists.live.map(function (f) { return rowOf(f, false); }).join("") +
			lists.archive.map(function (f) { return rowOf(f, true); }).join("") +
			"</tbody></table></div>";

		// 账本时间线
		var sorted = state.ledger.slice().sort(function (a, b) { return V.ts(a.at) - V.ts(b.at); });
		$("ledger").innerHTML =
			sorted.length === 0
				? '<div class="hint">账本为空（还没有归档/恢复事件）。</div>'
				: '<div class="timeline">' +
					sorted
						.map(function (e) {
							var op = e.op || "?";
							var label = { archive: "归档", restore: "恢复", "ledger-missing": "缺账补记" }[op] || op;
							return (
								'<div class="tl-item ' + V.escapeHtml(op) + '">' +
								'<span class="chip">' + V.escapeHtml(label) + "</span> " +
								"<b>" + V.escapeHtml(e.filename || "") + "</b>" +
								'<div class="when">' + V.escapeHtml(V.fmtTime(e.at)) + " · by " + V.escapeHtml(e.by || "—") +
								(e.heat !== undefined ? " · heat " + V.escapeHtml(e.heat) : "") +
								(e.memberCount !== undefined ? " · 成员 " + V.escapeHtml(e.memberCount) : "") + "</div>" +
								'<div class="hint">' + V.escapeHtml(e.reason || "") + "</div></div>"
							);
						})
						.join("") +
					"</div>";

		// 成员归属反查（点块内查看；也用于回答"这条 L1 记录属于哪个块"）
		var owners = [];
		recon.ownerOf.forEach(function (f, id) {
			owners.push({ id: id, file: f });
		});
		$("memberIndex").innerHTML =
			owners.length === 0
				? '<div class="hint">没有成员记录。</div>'
				: '<div class="hint">共 ' + owners.length + " 个成员 id 有归属（全部在页面内可搜）。点上方块行查看该块的实际成员清单。</div>" +
					'<div class="wrap-scroll" style="max-height:260px"><table><thead><tr><th>L1 记录 id</th><th>所属块</th></tr></thead><tbody>' +
					owners
						.slice(0, 300)
						.map(function (o) {
							return "<tr><td>" + V.escapeHtml(o.id) + "</td><td>" + V.escapeHtml(o.file) + "</td></tr>";
						})
						.join("") +
					"</tbody></table></div>" +
					(owners.length > 300 ? '<div class="hint">只列前 300 条。</div>' : "");
	}

	function openBlock(filename, archived) {
		var blk = (archived ? state.archiveBlocks : state.blocks).get(filename);
		var sidecar = (archived ? state.archiveMembers : state.members)[filename];
		var idx = null;
		state.index.forEach(function (e) {
			if (e && e.filename === filename) idx = e;
		});
		var members = sidecar || (idx && idx.members) || [];

		var memberRows = members.map(function (id) {
			var inBody = blk && blk.body.indexOf(id) >= 0;
			return (
				"<tr><td>" + V.escapeHtml(id) + '</td><td><a href="records-viewer.html?port=' + V.escapeHtml(V.bridgePort()) + '">在 L1 页搜</a></td>' +
				"<td>" + (inBody ? "在正文中" : '<span class="chip merged">正文里没有</span>') + "</td></tr>"
			);
		});

		$("detail").innerHTML =
			"<h3>" + V.escapeHtml(filename) + (archived ? ' <span class="chip">已归档</span>' : "") + "</h3>" +
			'<div class="chips">' +
			(blk ? '<span class="chip">heat ' + blk.meta.heat + "</span>" : '<span class="chip err">文件读不到</span>') +
			'<span class="chip">成员 ' + members.length + "</span>" +
			(blk && blk.meta.created ? '<span class="chip">created ' + V.escapeHtml(V.fmtDay(blk.meta.created)) + "</span>" : "") +
			(blk && blk.meta.updated ? '<span class="chip">updated ' + V.escapeHtml(V.fmtDay(blk.meta.updated)) + "</span>" : "") +
			(sidecar ? '<span class="chip">成员来源：scene_members.json（权威）</span>' : '<span class="chip merged">成员来源：索引（侧车缺本条）</span>') +
			"</div>" +
			(blk && blk.meta.summary ? '<p style="margin:10px 0 0">' + V.escapeHtml(blk.meta.summary) + "</p>" : "") +
			(blk
				? '<details class="more" open><summary>正文（' + blk.body.length + " 字符）</summary><div>" + renderMarkdown(blk.body) + "</div></details>"
				: '<div class="notice warn">这个块的文件读不到（可能只在索引/侧车里存在）。' + (state.dirLive ? "" : "无写盘桥时无法列目录，建议用桥打开。") + "</div>") +
			(memberRows.length
				? '<details class="more" open><summary>成员清单（' + memberRows.length + "）</summary><div class=\"wrap-scroll\"><table><thead><tr><th>L1 记录 id</th><th></th><th>正文兜底</th></tr></thead><tbody>" + memberRows.join("") + "</tbody></table></div></details>"
				: "") +
			'<div class="foot"><button type="button" data-close>关闭</button></div>';
		$("modal").classList.add("open");
	}

	function renderAll() {
		var recon = reconcile();
		renderStats(recon);
		renderList(recon);
	}

	function bind() {
		$("reloadBtn").addEventListener("click", function () {
			autoLoad();
		});
		$("blockTable").addEventListener("click", function (e) {
			var tr = e.target.closest("tr[data-file]");
			if (!tr) return;
			openBlock(tr.getAttribute("data-file"), tr.getAttribute("data-archived") === "1");
		});
		$("q").addEventListener(
			"input",
			V.debounce(function (e) {
				var needle = e.target.value.trim().toLowerCase();
				Array.from(document.querySelectorAll("#blockTable tr[data-file]")).forEach(function (tr) {
					tr.style.display = !needle || tr.innerText.toLowerCase().indexOf(needle) >= 0 ? "" : "none";
				});
				Array.from(document.querySelectorAll("#memberIndex tr")).forEach(function (tr) {
					tr.style.display = !needle || tr.innerText.toLowerCase().indexOf(needle) >= 0 ? "" : "none";
				});
			}, 150),
		);
		$("modal").addEventListener("click", function (e) {
			if (e.target === $("modal") || (e.target.dataset && e.target.dataset.close !== undefined)) {
				$("modal").classList.remove("open");
			}
		});
		document.addEventListener("keydown", function (e) {
			if (e.key === "Escape" && $("modal").classList.contains("open")) $("modal").classList.remove("open");
		});
	}

	function autoLoad() {
		V.note("loadNote", "加载中…");
		state.blocks = new Map();
		state.archiveBlocks = new Map();
		return loadMeta()
			.then(loadBlocks)
			.then(function () {
				renderAll();
				V.note(
					"loadNote",
					"已加载 " + state.index.length + " 个 live 索引条目、" + Object.keys(state.members).length +
						" 条 live 成员侧车、" + state.ledger.length + " 条账本事件" +
						(state.dirLive ? "（磁盘列举可用：live " + state.dirLive.length + " 个 .md、归档 " + state.dirArchive.length + " 个 .md）" : "（<b>无写盘桥</b>：拿不到目录列举，索引 ↔ 磁盘 无法核对）"),
				);
			})
			.catch(function (e) {
				V.note("loadNote", "加载失败：" + V.escapeHtml(e && e.message ? e.message : String(e)), "err");
			});
	}

	function init() {
		V.mountChrome({ active: "l2-viewer.html" });
		bind();
		autoLoad();
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
})();
