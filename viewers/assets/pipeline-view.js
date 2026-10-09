/*
 * viewers/assets/pipeline-view.js —— 流水线页（作业队列 + 三层子代理管理）
 *
 * 依赖：viewer-core.js（window.V）。本页不涉及质量分，故不加载 quality-core。
 *
 * ── 这一页为什么存在（2026-10-08）────────────────────────────────────────
 *
 * 「请求触发 / 待消费信号 / 停止子代理」这三件事此前**各页各写一遍**：L1 页有 opsTrigger +
 * opsStop、L2 页有 triggerBtn + stopBtn + pendingFlag、L3 页有 opsTrigger。三份实现的语义
 * 完全一样（同一个 /api/trigger、同一个 /api/subagent/stop），差别只在文案 —— 这正是会分叉的
 * 形状。现在三层合成一张表（每层一行），并补上一件此前谁都看不到的东西：**队列本身**。
 *
 * ── 三个只读数据源 + 两个写动作 ──────────────────────────────────────────
 *
 *   GET  /api/pipeline/jobs     queue/run/history 全景（jobs.sqlite 只读转储）—— 便宜，随加载取
 *   GET  /api/pending-triggers  三层待消费信号（**只探查不消费**：展示不该有副作用）
 *   GET  /api/subagent-runs     正在跑的子代理（停止按钮的**唯一**依据：没有运行记录就不显示可用的停止）
 *   POST /api/trigger           {layer}     请求入队 —— 写入信号，**不是立即执行**
 *   POST /api/subagent/stop     {layer,job} 停子代理 —— 不可逆，先 confirm
 *
 * 视图层不做业务判断：队列顺序（谁下一个跑）由 CLI 按 jobs-db.ts:listQueued 的口径给出，
 * 本页只负责渲染；状态与来源只做**标签翻译**，不改写任何含义。
 *
 * 三个小助手（opsStatus / jsonDetails / bridgeError）与 l2-view.js 里是同源的复制 —— 共享核心
 * viewer-core.js 被门禁 ⑰ 锁着两处字面量，本轮不动它；这三段是"页面自己的呈现策略"，
 * 各页一份本来也允许（l2 与 records 就是这么做的）。
 */
(function () {
	"use strict";

	var V = window.V;

	/** 三层的展示口径（id 与 jobs.sqlite 的 type / 运行记录的 layer 一致）。 */
	var LAYERS = [
		{ id: "l1", name: "L1 提取", agent: "l1-extractor", what: "从 L0 会话分片提取原子记忆" },
		{ id: "l2", name: "L2 组织", agent: "l2-scene-organizer", what: "把新记录并进场景块" },
		{ id: "l3", name: "L3 画像", agent: "l3-persona-generator", what: "重算 USER.md / MEMORY.md 画像" },
	];

	/** 五个状态（jobs.sqlite 的 status 闭集）→ 中文标签 + 色相 class（.chip.st-*）。 */
	var STATUS = {
		queued: { label: "排队", cls: "st-queued" },
		running: { label: "在跑", cls: "st-running" },
		done: { label: "完成", cls: "st-done" },
		skipped: { label: "跳过", cls: "st-skipped" },
		failed: { label: "失败", cls: "st-failed" },
	};

	/** 来源（谁把它排进队列的）；口径见 jobs-db.ts 的 PipelineJobSource 注释。 */
	var SOURCE = {
		interval: "周期到点",
		manual: "手动命令",
		l1_commit: "L1 提交",
		drain: "收尾续排",
		trigger: "门控触发",
		signal: "显式信号",
	};

	/** 端点字面量集中一处：静态校验按字面量核对桥里是否声明，拼串会漏检。 */
	var EP = {
		jobs: "/api/pipeline/jobs",
		pending: "/api/pending-triggers",
		runs: "/api/subagent-runs",
		trigger: "/api/trigger",
		stop: "/api/subagent/stop",
	};

	/** 两个写动作共用的那句原话：触发是入队请求，不是执行（后半句由 /api/trigger 的语义决定）。 */
	var TRIGGER_CAVEAT =
		"它<b>只负责入队，不是立即执行</b>：需要 pi 会话活着，并在下一轮结束（<code>agent_settled</code>）时由主进程消费。";

	var state = {
		/** /api/pipeline/jobs 的 data（null = 读不到，读不到与"队列空"必须分开表达） */
		jobs: null,
		jobsError: "",
		/** /api/pending-triggers 的 pending（{l1,l2,l3}，缺项为 null） */
		pending: null,
		/** /api/subagent-runs 的 runs 数组 */
		runs: [],
		/** "" | "trigger:l1" | "stop:l2" —— 同一时刻只允许一个动作在飞 */
		busy: "",
	};

	function $(id) {
		return document.getElementById(id);
	}

	// ── 呈现小助手（与 l2-view.js 同源，见文件头） ─────────────────────────

	/** 操作结果统一落在这里：它不在会被重绘的表格里，刷新后也还看得见。 */
	function opsStatus(html, level) {
		var host = $("opsResult");
		if (!host) return;
		host.className = "notice" + (level ? " " + level : "");
		host.innerHTML = html;
	}

	/** 结构化输出 → 等宽折叠块（把端点原样返回摆出来，不替用户"总结"掉证据）。 */
	function jsonDetails(summary, obj) {
		return (
			'<details class="log"><summary>' + V.escapeHtml(summary) + "</summary>" +
			'<pre class="log-text">' + V.escapeHtml(JSON.stringify(obj === undefined ? null : obj, null, 2)) + "</pre></details>"
		);
	}

	/** 从桥返回里挖人话错误：CLI 的拒绝理由在 data.error，失败时还会带回 stdout（见 bridge 的 runCli）。 */
	function bridgeError(r) {
		var d = (r && r.data) || {};
		return String(d.error || d.raw || d.stderr || (r && r.status ? "HTTP " + r.status : "未知错误"));
	}

	/** 毫秒 → 人话时长（作业耗时都在秒到分钟级，超过一小时才进位）。 */
	function fmtDur(ms) {
		var s = Math.max(0, Math.round(ms / 1000));
		if (s < 60) return s + " 秒";
		var m = Math.floor(s / 60);
		if (m < 60) return m + " 分 " + (s % 60) + " 秒";
		return Math.floor(m / 60) + " 时 " + (m % 60) + " 分";
	}

	/** 作业耗时：已结束 = finished − started；在跑 = now − started；没开始过 = null。 */
	function jobDurationMs(j, nowMs) {
		if (!j || !j.startedAt) return null;
		var from = V.ts(j.startedAt);
		if (!from) return null;
		var to = j.finishedAt ? V.ts(j.finishedAt) : j.status === "running" ? nowMs : 0;
		return to && to >= from ? to - from : null;
	}

	/** status → {label, cls}；未知状态原样显示（宁可露出一个生词，也不假装它是五分之一）。 */
	function statusOf(s) {
		return STATUS[s] || { label: String(s || "?"), cls: "" };
	}

	function layerName(type) {
		for (var i = 0; i < LAYERS.length; i++) if (LAYERS[i].id === type) return LAYERS[i].name;
		return String(type || "?");
	}

	function sourceLabel(src) {
		return SOURCE[src] || String(src || "?");
	}

	/** 某层的运行记录（没有则 null）。 */
	function runOf(layer) {
		for (var i = 0; i < state.runs.length; i++) {
			if (state.runs[i] && state.runs[i].layer === layer) return state.runs[i];
		}
		return null;
	}

	/** 某层的待消费信号（没有则 null）。 */
	function signalOf(layer) {
		return state.pending && state.pending[layer] ? state.pending[layer] : null;
	}

	/**
	 * 某层最近结束的一条作业。
	 * `recent` 由 CLI 按 id 倒序给出（id 自增 ⇒ 最近的在前），所以第一个匹配就是最新的那条。
	 */
	function lastOf(layer) {
		var recent = state.jobs && state.jobs.recent ? state.jobs.recent : [];
		for (var i = 0; i < recent.length; i++) {
			if (recent[i] && recent[i].type === layer) return recent[i];
		}
		return null;
	}

	// ── 渲染：侧栏概览 ──────────────────────────────────────────────────────

	/** 一行统计（.stat 是分隔线列表，不是盒子）。 */
	function statRow(label, value) {
		return '<div class="stat"><span>' + V.escapeHtml(label) + "</span><span>" + V.escapeHtml(String(value)) + "</span></div>";
	}

	/** 侧栏概览：五个状态计数 + 两条"当下为真"的计数 + 数据新鲜度。 */
	function renderStats() {
		var host = $("stats");
		var j = state.jobs;
		if (!j) {
			host.innerHTML =
				'<div class="stat"><span>队列</span><span>读不到</span></div>' +
				'<div class="hint">' + V.escapeHtml(state.jobsError || "无写盘桥") + "</div>";
			return;
		}
		var c = j.counts || {};
		var recent = j.recent || [];
		var sigCount = 0;
		for (var i = 0; i < LAYERS.length; i++) if (signalOf(LAYERS[i].id)) sigCount++;
		var runningRuns = state.runs.length;

		host.innerHTML =
			statRow("排队中", c.queued || 0) +
			statRow("在跑", c.running || 0) +
			statRow("已完成", c.done || 0) +
			statRow("已跳过", c.skipped || 0) +
			statRow("已失败", c.failed || 0) +
			'<div class="hint">' +
			(j.exists === false
				? "jobs.sqlite 还不存在：这个 profile 从未跑过流水线。"
				: "共 " + (c.total || 0) + " 条" +
					(recent.length
						? " · 最近结束 job " + V.escapeHtml(String(recent[0].id)) + "（" + V.escapeHtml(V.fromNow(recent[0].finishedAt || recent[0].createdAt)) + "）"
						: "")) +
			"</div>" +
			'<div class="hint">待消费信号 ' + sigCount + " / 3 层 · 运行记录 " + runningRuns + " 条</div>";
	}

	// ── 渲染：三层子代理表（本页的主交互） ──────────────────────────────────

	/** 每层一行：待消费信号 / 正在跑 / 最近结束 / 动作。 */
	function layerRow(l) {
		var ro = !V.bridgePort();
		var run = runOf(l.id);
		var sig = signalOf(l.id);
		var triggering = state.busy === "trigger:" + l.id;
		var stopping = state.busy === "stop:" + l.id;
		var busy = triggering || stopping;

		// 待消费信号：有信号时把 by/reason 也摆出来 —— "谁请求的、为什么"是它唯一的内容
		var sigCell = sig
			? '<span class="chip st-queued" title="' + V.escapeHtml(V.fmtTime(sig.at)) + '">待消费 · ' + V.escapeHtml(V.fromNow(sig.at)) + "</span>" +
				'<div class="hint">' +
				V.escapeHtml(String(sig.by || "?")) +
				(sig.reason ? " · " + V.escapeHtml(String(sig.reason)) : "") +
				(sig.personaSignal ? " · <b>显式信号</b>（P1 闸）" : "") +
				"</div>"
			: '<span class="hint">无</span>';

		var runCell = run
			? '<span class="chip st-running" title="来自 /api/subagent-runs">job ' + V.escapeHtml(String(run.jobId)) +
				" · pid " + V.escapeHtml(String(run.pid)) + "</span>" +
				'<div class="hint">' + V.escapeHtml(String(run.agent || "?")) + " · 起于 " + V.escapeHtml(V.fmtTime(run.startedAt)) +
				"（" + V.escapeHtml(V.fromNow(run.startedAt)) + "）</div>"
			: '<span class="hint">没有在跑</span>';

		var last = lastOf(l.id);
		var lastCell = last
			? '<span class="chip ' + statusOf(last.status).cls + '">' + V.escapeHtml(statusOf(last.status).label) + "</span>" +
				'<div class="hint">job ' + V.escapeHtml(String(last.id)) + " · " + V.escapeHtml(V.fromNow(last.finishedAt || last.createdAt)) + "</div>"
			: '<span class="hint">' + (state.jobs ? "没有已结束记录" : "—") + "</span>";

		var acts =
			'<div class="cell-actions">' +
			'<button type="button" class="primary" data-op="trigger" data-layer="' + l.id + '"' + (ro || busy ? " disabled" : "") +
			' title="向该层写一份待消费信号（' + V.escapeHtml(l.what) + "）\">请求入队</button>" +
			'<button type="button" class="danger" data-op="stop" data-layer="' + l.id + '"' + (ro || !run || busy ? " disabled" : "") +
			' title="' + (run ? "停掉 job " + V.escapeHtml(String(run.jobId)) + "（pid " + V.escapeHtml(String(run.pid)) + "）" : "没有在跑的子代理") + '">停止子代理</button>' +
			(triggering ? '<span class="busy-flag">请求中…</span>' : stopping ? '<span class="busy-flag">停止中…</span>' : "") +
			"</div>";

		return (
			'<tr data-layer="' + l.id + '">' +
			'<td><div class="pipeline-layer">' + V.escapeHtml(l.name) + '</div><div class="hint">' + V.escapeHtml(l.agent) + "　" + V.escapeHtml(l.what) + "</div></td>" +
			"<td>" + sigCell + "</td>" +
			"<td>" + runCell + "</td>" +
			"<td>" + lastCell + "</td>" +
			'<td class="acts">' + acts + "</td>" +
			"</tr>"
		);
	}

	function renderLayers() {
		var host = $("layerTable");
		host.className = "";
		var head =
			'<table><thead><tr><th style="width:150px">层</th><th>待消费信号</th><th>正在跑</th><th style="width:150px">最近结束</th>' +
			'<th class="acts">动作</th></tr></thead><tbody>';
		host.innerHTML = head + LAYERS.map(layerRow).join("") + "</tbody></table>" + extraRunsNote();
	}

	/**
	 * 落在 l1/l2/l3 之外的运行记录（skill / review 等）：**不静默隐藏**。
	 * 它们确实在跑、也确实占着进程，只是本页没给它们动作（要停只能用 CLI / 命令）。
	 */
	function extraRunsNote() {
		var extra = [];
		for (var i = 0; i < state.runs.length; i++) {
			var r = state.runs[i];
			if (!r) continue;
			var known = false;
			for (var k = 0; k < LAYERS.length; k++) if (LAYERS[k].id === r.layer) known = true;
			if (!known) extra.push(r);
		}
		if (!extra.length) return "";
		return (
			'<div class="hint" style="margin-top:6px">另有 ' + extra.length + " 条运行记录不属于这三层：" +
			extra
				.map(function (r) {
					return "<code>" + V.escapeHtml(String(r.layer)) + "</code>（job " + V.escapeHtml(String(r.jobId)) + " · pid " + V.escapeHtml(String(r.pid)) + "）";
				})
				.join("、") +
			" —— 本页不给它们动作，要停请用 <code>/my-memory:subagent-kill</code>。</div>"
		);
	}

	// ── 渲染：队列与历史（同一套行渲染，两块只差数据源） ─────────────────────

	var JOB_HEAD =
		'<table><thead><tr><th style="width:64px">job</th><th style="width:96px">层</th><th style="width:96px">来源</th>' +
		'<th style="width:76px">状态</th><th style="width:110px">入队</th><th style="width:96px">耗时</th><th>说明</th></tr></thead><tbody>';

	/** 一个作业一行。耗时对"在跑"是活的（now − started），对已结束是终值。 */
	function jobRow(j, nowMs) {
		var st = statusOf(j.status);
		var ms = jobDurationMs(j, nowMs);
		return (
			"<tr>" +
			'<td class="num">' + V.escapeHtml(String(j.id)) + "</td>" +
			"<td>" + V.escapeHtml(layerName(j.type)) + "</td>" +
			"<td>" + V.escapeHtml(sourceLabel(j.source)) + "</td>" +
			'<td><span class="chip ' + st.cls + '">' + V.escapeHtml(st.label) + "</span></td>" +
			'<td class="day" title="' + V.escapeHtml(V.fmtTime(j.createdAt)) + '">' + V.escapeHtml(V.fromNow(j.createdAt)) + "</td>" +
			'<td class="num" title="' + V.escapeHtml(V.fmtTime(j.startedAt) + " → " + V.fmtTime(j.finishedAt)) + '">' +
			(ms === null ? "—" : V.escapeHtml(fmtDur(ms))) + "</td>" +
			// 失败原因可能很长且带堆栈：给一个上限并允许任意断行，不做内滚动（契约 3）
			'<td style="max-width:460px;white-space:pre-wrap;overflow-wrap:anywhere">' +
			(j.error ? V.escapeHtml(String(j.error)) : '<span class="hint">—</span>') + "</td>" +
			"</tr>"
		);
	}

	/** 队列（进行中）：running 在前（它才是占着单飞闸的那条），其后是 queued 的认领顺序。 */
	function renderQueue() {
		var note = $("queueNote");
		var host = $("queueTable");
		var j = state.jobs;
		if (!j) {
			note.innerHTML = "读不到队列：" + V.escapeHtml(state.jobsError || "无写盘桥");
			host.innerHTML = "";
			return;
		}
		var running = j.running || [];
		var queued = j.queued || [];
		note.innerHTML = running.length
			? "认领是<b>单飞</b>的：<b>" + running.length + "</b> 条在跑占着执行位，队列里 <b>" + queued.length + "</b> 条按序等待（L3 永远最后）。"
			: queued.length
				? "没有在跑的作业；队列里 <b>" + queued.length + "</b> 条按认领顺序等着（L3 永远最后）。"
				: "队列空：没有排队的、也没有正在跑的作业。";

		var rows = running.concat(queued);
		var nowMs = Date.now();
		host.innerHTML = rows.length ? JOB_HEAD + rows.map(function (x) { return jobRow(x, nowMs); }).join("") + "</tbody></table>" : "";
	}

	/** 最近结束：CLI 已按 id 倒序给出（id 自增 ⇒ 最近的在最前）。 */
	function renderRecent() {
		var j = state.jobs;
		var recent = j && j.recent ? j.recent : [];
		var c = j && j.counts ? j.counts : {};
		var finished = Math.max(0, (c.total || 0) - (c.queued || 0) - (c.running || 0));
		$("recentCount").textContent =
			recent.length === 0
				? "最近结束：没有记录"
				: "最近结束 " + recent.length + " 条（全部已结束 " + finished + " 条）";
		var host = $("recentTable");
		host.innerHTML = recent.length ? JOB_HEAD + recent.map(function (x) { return jobRow(x, Date.now()); }).join("") + "</tbody></table>" : "";
	}

	function renderAll() {
		renderStats();
		renderLayers();
		renderQueue();
		renderRecent();
	}

	// ── 两个写动作（都不可逆，都要 confirm / 都要说清代价） ──────────────────

	/** 请求入队：只写一份待消费信号（执行在主进程）。 */
	function triggerLayer(layer) {
		if (!V.bridgePort() || state.busy) return;
		state.busy = "trigger:" + layer;
		renderLayers();
		// reason 写成人看得懂的一句话，而不是重复 by：`by` 已经说明"谁来请求的"，
		// 两者都塞 "viewer" 会让日志里出现「外部触发（viewer / viewer）」这种零信息的记录。
		V.bridge(EP.trigger, { method: "POST", body: JSON.stringify({ layer: layer, reason: "查看器「流水线」页的请求入队按钮" }) })
			.then(function (r) {
				state.busy = "";
				var d = r.data || {};
				var ok = r.ok && d.success !== false;
				opsStatus(
					ok
						? "已把 <b>" + V.escapeHtml(layerName(layer)) + "</b> 的请求写入待消费信号。" + TRIGGER_CAVEAT + jsonDetails("返回", d)
						: "入队失败：" + V.escapeHtml(bridgeError(r)) + jsonDetails("返回", d),
					ok ? "" : "err",
				);
				// 成败都重取：信号格与队列都可能已经变了
				return loadAll();
			});
	}

	/** 停止子代理：立即且不可逆（后端 CLI 没有 dry-run，要么停要么报"没在跑"），所以先 confirm。 */
	function stopLayer(layer) {
		var run = runOf(layer);
		if (!V.bridgePort() || !run || state.busy) return;
		if (
			!window.confirm(
				"停止 " + layerName(layer) + " 子代理？\n\njob " + run.jobId + " · pid " + run.pid + " · " + (run.agent || "?") + "\n\n" +
					"立即且不可逆：先拦信号、再杀进程树；本批未提交 ⇒ 游标不推进，下一轮整批重做。",
			)
		)
			return;
		state.busy = "stop:" + layer;
		renderLayers();
		V.bridge(EP.stop, { method: "POST", body: JSON.stringify({ layer: layer, job: run.jobId, reason: "查看器「流水线」页的停止按钮" }) })
			.then(function (r) {
				state.busy = "";
				var d = r.data || {};
				var ok = r.ok && d.success !== false;
				if (!ok) {
					opsStatus("停止失败：" + V.escapeHtml(bridgeError(r)) + jsonDetails("返回", d), "err");
				} else if (d.stopped === false) {
					// 不是错误：没有在跑的子代理是常态。但要说出来，否则"点了没反应"就是新的静默失效
					opsStatus("没有停到东西：" + V.escapeHtml(String(d.note || "该层没有在跑的子代理")) + jsonDetails("返回", d), "warn");
				} else {
					opsStatus(
						V.escapeHtml(String(d.note || "已停掉子代理。")) +
							(d.killConfirmed === false ? "<br>未能确认进程已死：该层已被<b>持有</b>（确认停止前不接受新任务）。" : "") +
							jsonDetails("返回", d),
						d.killConfirmed === false ? "warn" : "",
					);
				}
				return loadAll();
			});
	}

	// ── 取数 ────────────────────────────────────────────────────────────────

	/**
	 * 三个只读端点一次取齐（都便宜：一次 sqlite 只读查询 + 两次目录探查）。
	 * 无桥时**不编造空态**：state.jobs 保持 null，页面上写的是"读不到 + 原因"。
	 */
	function loadAll() {
		V.note("loadNote", "加载中…");
		if (!V.bridgePort()) {
			state.jobs = null;
			state.jobsError = "无写盘桥";
			state.pending = null;
			state.runs = [];
			renderAll();
			V.note("loadNote", "无写盘桥：队列、信号与运行记录全部来自 <code>/api/*</code>，请用带 <code>?port=</code> 的地址打开本页。", "warn");
			return Promise.resolve();
		}
		return Promise.all([V.bridge(EP.jobs), V.bridge(EP.pending), V.bridge(EP.runs)]).then(function (r) {
			var jobsR = r[0], pendR = r[1], runsR = r[2];
			state.jobs = jobsR.ok && jobsR.data && jobsR.data.success !== false ? jobsR.data : null;
			state.jobsError = state.jobs ? "" : bridgeError(jobsR);
			state.pending = pendR.ok && pendR.data ? pendR.data.pending || null : null;
			state.runs = runsR.ok && runsR.data && Array.isArray(runsR.data.runs) ? runsR.data.runs : [];
			renderAll();

			var failed = [jobsR, pendR, runsR].filter(function (x) { return !x.ok; }).length;
			var c = state.jobs ? state.jobs.counts || {} : null;
			var sigCount = 0;
			for (var i = 0; i < LAYERS.length; i++) if (signalOf(LAYERS[i].id)) sigCount++;
			V.note(
				"loadNote",
				(c ? "队列共 " + (c.total || 0) + " 条：排队 " + (c.queued || 0) + " · 在跑 " + (c.running || 0) : "队列：读不到（" + V.escapeHtml(state.jobsError) + "）") +
					" ｜ 待消费信号 " + sigCount + " 层 ｜ 运行记录 " + state.runs.length + " 条" +
					(failed ? " ｜ <b>" + failed + " 个端点没读到</b>，各格已写出原因" : ""),
				failed ? "warn" : "",
			);
		});
	}

	// ── 绑定与启动 ──────────────────────────────────────────────────────────

	function bind() {
		$("reloadBtn").addEventListener("click", function () {
			loadAll();
		});
		// 表格会被整体重画，所以用事件委托（重画不丢监听）
		$("layerTable").addEventListener("click", function (e) {
			var btn = e.target && e.target.closest ? e.target.closest("button[data-op]") : null;
			if (!btn || btn.disabled) return;
			var layer = btn.getAttribute("data-layer");
			var op = btn.getAttribute("data-op");
			if (op === "trigger") triggerLayer(layer);
			else if (op === "stop") stopLayer(layer);
		});
	}

	function init() {
		V.mountChrome({ active: "pipeline-viewer.html" });
		bind();
		loadAll();
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
})();
