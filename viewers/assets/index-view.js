/*
 * viewers/assets/index-view.js —— 总览页的页面逻辑
 *
 * 只做一件事：把"这一层现在健不健康"用少量数字摊开，并给出到各页的入口。
 * 刻意不复用各页的完整渲染 —— 总览页要能在各页出问题时仍然可用（它是排查的起点）。
 *
 * 健康摘要的取数原则：**能读多少读多少，读不到就说读不到**。
 * 不把"取数失败"渲染成 0（0 与"未知"是两回事，混起来会让人以为库是空的）。
 */
(function () {
	"use strict";

	var V = window.V;

	function $(id) {
		return document.getElementById(id);
	}

	/** 最近一次 L1 分片日期（从 bridge 的分片清单取）；无桥则用最近 90 天探测。 */
	function l1Summary() {
		return V.bridge("/api/l1/shards").then(function (r) {
			if (r.ok && r.data && Array.isArray(r.data.shards)) {
				var rows = r.data.total || 0;
				var last = r.data.shards.length ? r.data.shards[r.data.shards.length - 1].file : null;
				return { source: "bridge", shards: r.data.shards.length, rows: rows, lastShard: last };
			}
			return { source: "none", note: "无写盘桥：列不了分片目录" };
		});
	}

	/** L1 记录条数与任务状态分布（需要真读分片；这里只读最近一天的分片做抽样，避免总览页拖慢）。 */
	function l1Sample() {
		return V.bridge("/api/l1/shards").then(function (r) {
			if (!r.ok || !r.data || !r.data.shards || r.data.shards.length === 0) return null;
			var last = r.data.shards[r.data.shards.length - 1].file;
			return V.loadText("../l1/records/" + last).then(function (txt) {
				if (txt === null) return null;
				var rows = V.parseJsonl(txt, last);
				var byId = new Map();
				rows.forEach(function (x) { if (x && x.id) byId.set(x.id, x); });
				var latest = Array.from(byId.values());
				var tasks = { open: 0, done: 0, dropped: 0 };
				latest.forEach(function (x) {
					if (x.type !== "work_task" || x.deleted === true) return;
					var s = x.taskState === "done" || x.taskState === "dropped" ? x.taskState : "open";
					tasks[s]++;
				});
				return { shard: last, rows: rows.length, distinct: latest.length, tasks: tasks };
			});
		});
	}

	function l2Summary() {
		return Promise.all([V.loadJson("../l2/index/scene_index.json"), V.loadJson("../l2/index/scene_members.json"), V.loadJson("../l2/archive/scene_members.json"), V.loadJsonl("../l2/archive/ledger.jsonl"), V.bridge("/api/l2/blocks")]).then(function (r) {
			var index = Array.isArray(r[0]) ? r[0] : [];
			var members = r[1] || {};
			var archiveMembers = r[2] || {};
			var ledger = Array.isArray(r[3]) ? r[3] : [];
			var live = r[4] && r[4].ok ? r[4].data.live : null;
			var arch = r[4] && r[4].ok ? r[4].data.archive : null;
			var memberTotal = 0;
			Object.keys(members).forEach(function (f) { memberTotal += (members[f] || []).length; });
			// 索引 ↔ 磁盘 差异（只在有桥时算）
			var idxFiles = {};
			index.forEach(function (e) { if (e && e.filename) idxFiles[e.filename] = true; });
			var missingOnDisk = live ? Object.keys(idxFiles).filter(function (f) { return !live.some(function (d) { return d.file === f; }); }).length : null;
			var notIndexed = live ? live.filter(function (d) { return !idxFiles[d.file]; }).length : null;
			return { index: index.length, diskLive: live ? live.length : null, archive: arch ? arch.length : null, memberTotal: memberTotal, archiveMembers: Object.keys(archiveMembers).length, ledger: ledger.length, missingOnDisk: missingOnDisk, notIndexed: notIndexed };
		});
	}

	function l3Summary() {
		// 画像三件套在 profile 根（见 l3-view.js 的同一说明），只能走白名单端点
		return Promise.all([V.loadJson("../l3/cursor.json"), V.bridge("/api/limits"), V.bridge("/api/profile-files"), V.bridge("/api/l3/backups")]).then(function (r) {
			var cursor = r[0] || null;
			var limits = r[1] && r[1].ok ? r[1].data.l3 : null;
			var pf = r[2] && r[2].ok && r[2].data && r[2].data.files ? r[2].data.files : null;
			var backups = r[3] && r[3].ok && r[3].data.backups ? r[3].data.backups : null;
			var parse = function (raw) {
				if (raw === null || raw === undefined || String(raw).trim() === "") return [];
				return String(raw).split(/\r?\n§\r?\n/).map(function (p) { return p.trim(); }).filter(Boolean);
			};
			var budget = function (entries) {
				if (entries.length === 0) return 0;
				return entries.reduce(function (s, e) { return s + e.length; }, 0) + 3 * (entries.length - 1);
			};
			var userEntries = parse(pf ? pf["USER.md"] : null);
			var tempEntries = parse(pf ? pf["USER-temp.md"] : null);
			return {
				profileFilesAvailable: !!pf,
				cursor: cursor,
				userEntries: userEntries.length,
				userBudget: budget(userEntries),
				userLimit: limits ? limits.userCharLimit : null,
				tempEntries: tempEntries.length,
				tempBudget: budget(tempEntries),
				pendingProposal: tempEntries.filter(function (e) { return userEntries.indexOf(e) < 0; }).length,
				interval: limits ? limits.interval : null,
				backups: backups ? backups.length : null,
			};
		});
	}

	function row(label, value, note, cls) {
		return '<div class="stat"><span>' + V.escapeHtml(label) + "</span><span>" + (value === null || value === undefined ? '<span class="chip del">读不到</span>' : V.escapeHtml(String(value))) + "</span></div>" + (note ? '<div class="hint">' + note + "</div>" : "");
	}

	function render() {
		var out = { errors: [] };

		var tasks = [
			l1Summary().then(function (s) {
				$("l1").innerHTML =
					row("分片数", s.shards, s.source === "none" ? V.escapeHtml(s.note) : "最近分片 " + V.escapeHtml(s.lastShard || "—")) +
					row("总行数（含墓碑）", s.rows);
			}),
			l1Sample().then(function (s) {
				$("l1sample").innerHTML = s
					? row("最新分片 " + s.shard, s.rows + " 行 / " + s.distinct + " 个 id") +
						'<div class="chips"><span class="chip task-open">待办 ' + s.tasks.open + '</span><span class="chip task-done">已完成 ' + s.tasks.done + '</span><span class="chip task-dropped">已废弃 ' + s.tasks.dropped + "</span></div>" +
						'<div class="hint">任务状态按 <code>taskState</code> 统计（缺字段 = 待办）。这只是<b>最新一天分片</b>的抽样，全库分布见 L1 页。</div>'
					: '<div class="hint">读不到最新分片。</div>';
			}),
			// 端点路径必须带 l1/ 前缀（桥的路由是 /api/l1/active-days）；写错会静默退化成
			// "拿不到活跃会话日"，把权威时钟误报成不可用。
			V.bridge("/api/l1/active-days").then(function (r) {
				$("clock").innerHTML =
					r.ok && r.data && r.data.available
						? row("活跃会话日", r.data.count, "首 " + V.escapeHtml(r.data.firstDay || "—") + " · 末 " + V.escapeHtml(r.data.lastDay || "—") + "<br>来源：<code>l0/conversations</code>（权威；<code>hit-stats.json</code> 侧车会滞后）")
						: '<div class="notice warn">拿不到活跃会话日：质量分的衰减时钟会退化为日历天（停工期间照常衰减）。</div>';
			}),
			l2Summary().then(function (s) {
				$("l2").innerHTML =
					row("live 块（索引 / 磁盘）", s.index + " / " + (s.diskLive === null ? "?" : s.diskLive)) +
					row("归档块", s.archive) +
					row("live 成员总数", s.memberTotal) +
					row("账本条目", s.ledger) +
					(s.missingOnDisk === null
						? '<div class="hint">无写盘桥：无法核对「索引 ↔ 磁盘」。</div>'
						: s.missingOnDisk === 0 && s.notIndexed === 0
							? '<div class="notice">索引与磁盘一致（无缺失块、无未入索引块）。</div>'
							: '<div class="notice warn">索引缺块 ' + s.missingOnDisk + " 个 · 未入索引块 " + s.notIndexed + " 个 —— 详见 L2 页的对账结果。</div>");
			}),
			l3Summary().then(function (s) {
				var pending = s.cursor ? s.cursor.memoriesSinceLastPersona : null;
				$("l3").innerHTML =
					(s.profileFilesAvailable
						? ""
						: '<div class="notice warn">读不到 profile 根的画像文件（<code>MEMORY.md</code>/<code>USER.md</code>/<code>USER-temp.md</code>）—— 需要写盘桥的 <code>/api/profile-files</code>。下面条目数为 0 不代表文件为空。</div>') +
					row("USER.md 条目 / 预算", s.profileFilesAvailable ? s.userEntries + " 条 / " + s.userBudget + (s.userLimit ? " / " + s.userLimit : "") + " 字符" : null, '预算按 <code>entryBudget</code>（正文 + 分隔符），<b>不是字节数</b>') +
					row("USER-temp 待合入条目", s.profileFilesAvailable ? s.pendingProposal : null, "L3 提议稿；合并进 live 是人工动作") +
					row("P4 进度", pending === null ? null : pending + (s.interval ? " / " + s.interval : "")) +
					row("画像备份数", s.backups);
			}),
		];

		return Promise.all(
			tasks.map(function (p) {
				return p.catch(function (e) {
					out.errors.push(e && e.message ? e.message : String(e));
				});
			}),
		).then(function () {
			$("health").innerHTML = out.errors.length
				? '<div class="notice err">有 ' + out.errors.length + " 项摘要取数失败：" + V.escapeHtml(out.errors.join("；")) + "</div>"
				: "";
		});
	}

	function bind() {
		$("reloadBtn").addEventListener("click", function () {
			load();
		});
		$("openBridge").addEventListener("click", function () {
			var port = V.bridgePort();
			V.note("hint", port ? "当前已带 ?port=" + port + "，写盘可用。" : "当前未带 ?port=，只能只读浏览。运行 <code>node scripts/l1-admin/viewer-bridge.mjs</code> 后打开它打印的地址即可写盘。", port ? "" : "warn");
		});
	}

	function load() {
		V.note("loadNote", "汇总中…");
		return V.bridge("/api/viewer-status").then(function (r) {
			var v = r.ok && r.data ? r.data : null;
			V.note(
				"loadNote",
				v
					? "源码版本 <b>" + V.escapeHtml(v.sourceVersion) + "</b>，已部署 <b>" + V.escapeHtml(v.deployedVersion || "（从未部署）") + "</b>" +
						(v.drifted ? ' —— <b class="text-warn">源码已更新但未部署</b>（重启会话或 /reload 会触发部署）' : "，两者一致") +
						(v.retired && v.retired.length ? "。已退役：" + V.escapeHtml(v.retired.join("、")) : "")
					: "无写盘桥：无法做版本/漂移检查（只能只读浏览本地文件）。",
				v && v.drifted ? "warn" : "",
			);
		}).then(render);
	}

	function init() {
		V.mountChrome({ active: "index.html" });
		bind();
		load();
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
})();
