/*
 * viewers/assets/pipeline-app.js —— 流水线页（作业队列 + 三层子代理管理）· Vue 3 版
 *
 * 依赖：viewer-core.js（window.V）、viewer-vue.js（V.vue）。本页不涉及质量分，不加载 quality-core。
 *
 * ── 这一页为什么存在（2026-10-08）────────────────────────────────────────
 *
 * 「请求触发 / 待消费信号 / 停止子代理」此前各页各写一遍（L1 / L2 / L3 三份），语义完全一样、
 * 差别只在文案 —— 这正是会分叉的形状。现在三层合成一张表（每层一行），并补上一件此前谁都看不到的
 * 东西：**队列本身**。
 *
 * ── 三个只读数据源 + 两个写动作 ──────────────────────────────────────────
 *
 *   GET  /api/pipeline/jobs     queue/run/history 全景（jobs.sqlite 只读转储）—— 便宜，随加载取
 *   GET  /api/pending-triggers  三层待消费信号（**只探查不消费**：展示不该有副作用）
 *   GET  /api/subagent-runs     正在跑的子代理（停止按钮的**唯一**依据）
 *   POST /api/trigger           {layer}     请求入队 —— 写入信号，**不是立即执行**
 *   POST /api/subagent/stop     {layer,job} 停子代理 —— 不可逆，先确认
 *
 * ── Vue 版与旧版的差别（只列会影响行为的）────────────────────────────────
 *
 * 1. 表格 / 折叠面板 / 按钮 / 确认框换成 Element Plus（el-table / el-collapse / el-button /
 *    ElMessageBox）。**端点、文案、判定条件一字未改** —— 这一页的价值在语义，重构不该动语义。
 * 2. 停止的确认框由 `window.confirm` 换成 `V.vue.confirm`（基于 Promise 的弹层）：同步的
 *    confirm 在浏览器自动化下会被外部直接接受而页面 JS 卡住（2026-10-10 实测过），
 *    异步弹层不存在这种半死状态。
 * 3. 说明文本（侧栏「说明」）收进 el-collapse 默认收起 —— 与旧版原生 details 同样的取舍。
 */
(function () {
	"use strict";

	var V = window.V;
	var isEnglish = window.ViewerI18n && window.ViewerI18n.locale === "en";

	/** 三层的展示口径（id 与 jobs.sqlite 的 type / 运行记录的 layer 一致）。 */
	var LAYERS = [
		{ id: "l1", name: isEnglish ? "L1 extraction" : "L1 提取", agent: "l1-extractor", what: isEnglish ? "Extract atomic memories from L0 conversation shards" : "从 L0 会话分片提取原子记忆" },
		{ id: "l2", name: isEnglish ? "L2 organization" : "L2 组织", agent: "l2-scene-organizer", what: isEnglish ? "Organize new records into scene blocks" : "把新记录并进场景块" },
		{ id: "l3", name: isEnglish ? "L3 profile" : "L3 画像", agent: "l3-persona-generator", what: isEnglish ? "Rebuild the USER.md / MEMORY.md profiles" : "重算 USER.md / MEMORY.md 画像" },
	];

	/** 五个状态（jobs.sqlite 的 status 闭集）→ 中文标签 + 形状编码 class（.chip.st-*）。 */
	var STATUS = {
		queued: { label: isEnglish ? "Queued" : "排队", cls: "st-queued" },
		running: { label: isEnglish ? "Running" : "在跑", cls: "st-running" },
		done: { label: isEnglish ? "Completed" : "完成", cls: "st-done" },
		skipped: { label: isEnglish ? "Skipped" : "跳过", cls: "st-skipped" },
		failed: { label: isEnglish ? "Failed" : "失败", cls: "st-failed" },
	};

	/** 来源（谁把它排进队列的）；口径见 jobs-db.ts 的 PipelineJobSource 注释。 */
	var SOURCE = {
		interval: isEnglish ? "Scheduled" : "周期到点",
		manual: isEnglish ? "Manual command" : "手动命令",
		l1_commit: isEnglish ? "L1 submission" : "L1 提交",
		drain: isEnglish ? "L1 follow-up" : "收尾续排",
		trigger: isEnglish ? "Gated trigger" : "门控触发",
		signal: isEnglish ? "Explicit signal" : "显式信号",
	};

	/** 端点字面量集中一处：静态校验按字面量核对桥里是否声明（gate ⑬），拼串会漏检。 */
	var EP = {
		jobs: "/api/pipeline/jobs",
		pending: "/api/pending-triggers",
		runs: "/api/subagent-runs",
		trigger: "/api/trigger",
		stop: "/api/subagent/stop",
	};

	/** 写动作共用的那句原话：触发是入队请求，不是执行（后半句由 /api/trigger 的语义决定）。 */
	var TRIGGER_CAVEAT = isEnglish
		? " It <b>only queues the request; it does not run immediately</b>. The pi session must be active so the main process can consume it after the next turn (<code>agent_settled</code>)."
		: "它<b>只负责入队，不是立即执行</b>：需要 pi 会话活着，并在下一轮结束（<code>agent_settled</code>）时由主进程消费。";

	// ── 作业行的共用口径（队列表与最近结束表是同一套渲染，只差数据源）─────────────

	var JOB_METHODS = {
		/** status → {label, cls}；未知状态原样显示（宁可露出一个生词，也不假装它是五分之一） */
		statusOf: function (s) {
			return STATUS[s] || { label: String(s || "?"), cls: "" };
		},
		layerName: function (type) {
			var hit = LAYERS.filter(function (l) {
				return l.id === type;
			})[0];
			return hit ? hit.name : String(type || "?");
		},
		sourceLabel: function (src) {
			return SOURCE[src] || String(src || "?");
		},
		/** 作业耗时：已结束 = finished − started；在跑 = now − started；没开始过 = null */
		jobDurationMs: function (j, nowMs) {
			if (!j || !j.startedAt) return null;
			var from = V.ts(j.startedAt);
			if (!from) return null;
			var to = j.finishedAt ? V.ts(j.finishedAt) : j.status === "running" ? nowMs : 0;
			return to && to >= from ? to - from : null;
		},
		/** 毫秒 → 人话时长（作业都在秒到分钟级，超过一小时才进位） */
		fmtDur: function (ms) {
			if (ms === null) return "—";
			var s = Math.max(0, Math.round(ms / 1000));
			if (s < 60) return s + " 秒";
			var m = Math.floor(s / 60);
			if (m < 60) return m + " 分 " + (s % 60) + " 秒";
			return Math.floor(m / 60) + " 时 " + (m % 60) + " 分";
		},
		durText: function (j) {
			return this.fmtDur(this.jobDurationMs(j, Date.now()));
		},
		/** 耗时列的悬停提示：起止时刻（"在跑"的耗时是活的，hover 可核对从何时算起） */
		durTitle: function (j) {
			return V.fmtTime(j.startedAt) + " → " + V.fmtTime(j.finishedAt);
		},
	};

	/**
	 * 作业表（队列与历史共用一列定义）。
	 *
	 * @prop rows 作业数组；行内只读，动作一律在别处（本页的写动作只针对"层"）
	 */
	var JobTable = {
		name: "JobTable",
		mixins: [{ methods: JOB_METHODS }],
		props: { rows: { type: Array, default: function () { return []; } } },
		template:
			'<el-table class="job-table" :data="rows" size="small" empty-text="没有记录">' +
			'<el-table-column label="job" width="70" class-name="mono">' +
			'<template #default="{ row }">{{ row.id }}</template></el-table-column>' +
			'<el-table-column label="层" width="100">' +
			'<template #default="{ row }">{{ layerName(row.type) }}</template></el-table-column>' +
			'<el-table-column label="来源" width="100">' +
			'<template #default="{ row }">{{ sourceLabel(row.source) }}</template></el-table-column>' +
			'<el-table-column label="状态" width="86">' +
			'<template #default="{ row }"><chip :kind="statusOf(row.status).cls" :label="statusOf(row.status).label"></chip></template>' +
			"</el-table-column>" +
			'<el-table-column label="入队" width="112">' +
			'<template #default="{ row }"><span :title="fmtTime(row.createdAt)">{{ fromNow(row.createdAt) }}</span></template>' +
			"</el-table-column>" +
			'<el-table-column label="' + (isEnglish ? "Duration" : "耗时") + '" width="100" class-name="mono">' +
			'<template #default="{ row }"><span :title="durTitle(row)">{{ durText(row) }}</span></template>' +
			"</el-table-column>" +
			'<el-table-column label="说明" min-width="220">' +
			'<template #default="{ row }">' +
			'<span v-if="row.error" class="wrap-any">{{ row.error }}</span>' +
			'<span v-else class="hint">—</span>' +
			"</template></el-table-column>" +
			"</el-table>",
	};

	// 作业表复用页面 mixin 的时间格式化（fmtTime / fromNow 来自 V.vue.pageMixin）
	JobTable.mixins.push({ methods: { fmtTime: V.fmtTime, fromNow: V.fromNow } });

	// ── 页面 ────────────────────────────────────────────────────────────────

	var PAGE = {
		components: { JobTable: JobTable },
		mixins: [V.vue.pageMixin, { methods: JOB_METHODS }],
		data: function () {
			return {
				isEnglish: isEnglish,
				/** /api/pipeline/jobs 的 data（null = 读不到；读不到与"队列空"必须分开表达） */
				jobs: null,
				jobsError: "",
				/** /api/pending-triggers 的 pending（{l1,l2,l3}，缺项为 null） */
				pending: null,
				/** /api/subagent-runs 的 runs 数组 */
				runs: [],
				/** 操作结果提示（不在会被重绘的表格里，刷新后也还看得见） */
				ops: { html: "", level: "" },
				/** 附在提示下的原始返回（等宽折叠块，不替用户"总结"掉证据） */
				opsJson: null,
				/** 侧栏说明的展开状态（默认收起） */
				helpOpen: [],
				/** 最近结束的展开状态（历史是"查"不是"用"） */
				recentOpen: [],
			};
		},
		mounted: function () {
			// 旧版的 init() 做三件事：mountChrome（已在 V.vue.mount 里做过）、bind()（Vue 接管，
			// 不再需要事件委托）、loadAll()。挂载后立刻取一次数。
			var self = this;
			V.registerRefreshHandler(function () { return self.loadAll(); });
			this.loadAll();
		},
		computed: {
			counts: function () {
				return (this.jobs && this.jobs.counts) || {};
			},
			running: function () {
				return (this.jobs && this.jobs.running) || [];
			},
			queued: function () {
				return (this.jobs && this.jobs.queued) || [];
			},
			recent: function () {
				return (this.jobs && this.jobs.recent) || [];
			},
			/** 待消费信号条数（0~3） */
			signalCount: function () {
				var self = this;
				return LAYERS.filter(function (l) {
					return !!self.signalOf(l.id);
				}).length;
			},
			/** 侧栏概览：五个状态计数 */
			statRows: function () {
				var c = this.counts;
				return [
					{ label: isEnglish ? "Queued" : "排队中", value: c.queued || 0 },
					{ label: isEnglish ? "Running" : "在跑", value: c.running || 0 },
					{ label: isEnglish ? "Completed" : "已完成", value: c.done || 0 },
					{ label: isEnglish ? "Skipped" : "已跳过", value: c.skipped || 0 },
					{ label: isEnglish ? "Failed" : "已失败", value: c.failed || 0 },
				];
			},
			/** 侧栏概览脚注：数据新鲜度 + 两条"当下为真"的计数 */
			statFoot: function () {
				// jobsError 为空且还没取到时是"加载中"，不能写成"无写盘桥" —— 那是另一回事（没有 ?port=）
				if (!this.jobs) return [this.esc(this.jobsError || "加载中…")];
				var c = this.counts;
				var last = this.recent[0];
				return [
					this.jobs.exists === false
						? (isEnglish ? "jobs.sqlite does not exist yet; this profile has never run the pipeline." : "jobs.sqlite 还不存在：这个 profile 从未跑过流水线。")
						: isEnglish ? "" + (c.total || 0) + " jobs" + (last ? " · latest finished job " + this.esc(String(last.id)) + " (" + this.esc(V.fromNow(last.finishedAt || last.createdAt)) + ")" : "")
							: "共 " + (c.total || 0) + " 条" + (last ? " · 最近结束 job " + this.esc(String(last.id)) + "（" + this.esc(V.fromNow(last.finishedAt || last.createdAt)) + "）" : ""),
					isEnglish ? "Pending signals " + this.signalCount + " / 3 layers · " + this.runs.length + " run records" : "待消费信号 " + this.signalCount + " / 3 层 · 运行记录 " + this.runs.length + " 条",
				];
			},
			/** 三层子代理表：每层一行（信号 / 运行 / 最近结束 / 动作） */
			layerRows: function () {
				var self = this;
				return LAYERS.map(function (l) {
					var run = self.runOf(l.id);
					var sig = self.signalOf(l.id);
					var last = self.lastOf(l.id);
					return {
						id: l.id,
						name: l.name,
						agent: l.agent,
						what: l.what,
						sig: sig,
						run: run,
						last: last,
						lastStatus: last ? self.statusOf(last.status) : null,
						triggering: self.busy === "trigger:" + l.id,
						stopping: self.busy === "stop:" + l.id,
						/** 没有写盘桥 → 两个动作都不可用；没有运行记录 → 停止不可用（旧版同款判定） */
						canTrigger: self.hasPort() && !self.busy,
						canStop: self.hasPort() && !!run && !self.busy,
					};
				});
			},
			/** 队列（进行中）：running 在前（它才占着单飞闸），其后按认领顺序 */
			queueRows: function () {
				return this.running.concat(this.queued);
			},
			queueNoteHtml: function () {
				if (isEnglish) {
					if (!this.jobs) return "Queue unavailable: " + this.esc(this.jobsError || "Loading…");
					if (this.running.length) return "Only one job can run at a time. <b>" + this.running.length + "</b> running job(s) occupy the worker; <b>" + this.queued.length + "</b> queued. Jobs run in claim order, with L3 always last.";
					if (this.queued.length) return "No job is running. <b>" + this.queued.length + "</b> job(s) are waiting in claim order, with L3 always last.";
					return "Queue is empty: no jobs are queued or running.";
				}
				if (!this.jobs) return "读不到队列：" + this.esc(this.jobsError || "加载中…");
				if (this.running.length) {
					return "认领是<b>单飞</b>的：<b>" + this.running.length + "</b> 条在跑占着执行位，队列里 <b>" +
						this.queued.length + "</b> 条按序等待（L3 永远最后）。";
				}
				if (this.queued.length) {
					return "没有在跑的作业；队列里 <b>" + this.queued.length + "</b> 条按认领顺序等着（L3 永远最后）。";
				}
				return "队列空：没有排队的、也没有正在跑的作业。";
			},
			/** 落在 l1/l2/l3 之外的运行记录（skill / review 等）：不静默隐藏 */
			extraRuns: function () {
				return this.runs.filter(function (r) {
					return r && !LAYERS.some(function (l) { return l.id === r.layer; });
				});
			},
			recentTitle: function () {
				if (!this.recent.length) return isEnglish ? "Recently finished: no records" : "最近结束：没有记录";
				var c = this.counts;
				var finished = Math.max(0, (c.total || 0) - (c.queued || 0) - (c.running || 0));
				return isEnglish ? "Recently finished " + this.recent.length + " (" + finished + " finished in total)" : "最近结束 " + this.recent.length + " 条（全部已结束 " + finished + " 条）";
			},
		},
		methods: {
			/** 某层的运行记录（没有则 null） */
			runOf: function (layer) {
				return this.runs.filter(function (r) { return r && r.layer === layer; })[0] || null;
			},
			/** 某层的待消费信号（没有则 null） */
			signalOf: function (layer) {
				return this.pending && this.pending[layer] ? this.pending[layer] : null;
			},
			/** 某层最近结束的一条作业（recent 已按 id 倒序，第一个匹配即最新） */
			lastOf: function (layer) {
				return this.recent.filter(function (j) { return j && j.type === layer; })[0] || null;
			},
			/** 写操作结果（html 由本页拼、值经 esc 转义） */
			setOps: function (html, level, json) {
				this.ops = { html: html, level: level || "" };
				this.opsJson = json === undefined ? null : json;
			},

			/**
			 * 取三个只读端点（都便宜：一次 sqlite 只读查询 + 两次目录探查）。
			 * 无桥时**不编造空态**：jobs 保持 null，页面上写的是"读不到 + 原因"。
			 */
			loadAll: function () {
				var self = this;
				this.setNote(isEnglish ? "Loading…" : "加载中…");
				if (!this.hasPort()) {
					this.jobs = null;
					this.jobsError = "无写盘桥";
					this.pending = null;
					this.runs = [];
					this.setNote(isEnglish ? "Viewer bridge unavailable: queue, signals, and run history come from <code>/api/*</code>. Open this page with a <code>?port=</code> URL." : "无写盘桥：队列、信号与运行记录全部来自 <code>/api/*</code>，请用带 <code>?port=</code> 的地址打开本页。", "warn");
					return Promise.resolve();
				}
				return Promise.all([V.bridge(EP.jobs), V.bridge(EP.pending), V.bridge(EP.runs)]).then(function (r) {
					var jobsR = r[0], pendR = r[1], runsR = r[2];
					self.jobs = jobsR.ok && jobsR.data && jobsR.data.success !== false ? jobsR.data : null;
					self.jobsError = self.jobs ? "" : self.bridgeError(jobsR);
					self.pending = pendR.ok && pendR.data ? pendR.data.pending || null : null;
					self.runs = runsR.ok && runsR.data && Array.isArray(runsR.data.runs) ? runsR.data.runs : [];

					var failed = r.filter(function (x) { return !x.ok; }).length;
					var c = self.jobs ? self.jobs.counts || {} : null;
					self.setNote(isEnglish
						? (c ? "Queue: " + (c.total || 0) + " · waiting: " + (c.queued || 0) + " · running: " + (c.running || 0) : "Queue unavailable (" + self.esc(self.jobsError) + ")") +
							" · Pending signals: " + self.signalCount + " / 3 · Run records: " + self.runs.length + (failed ? " · <b>" + failed + " endpoint(s) unavailable</b>; see each section for details." : "")
						: (c ? "队列共 " + (c.total || 0) + " 条：排队 " + (c.queued || 0) + " · 在跑 " + (c.running || 0) : "队列：读不到（" + self.esc(self.jobsError) + "）") +
							" ｜ 待消费信号 " + self.signalCount + " 层 ｜ 运行记录 " + self.runs.length + " 条" + (failed ? " ｜ <b>" + failed + " 个端点没读到</b>，各格已写出原因" : ""),
						failed ? "warn" : "");
				});
			},

			/** 请求入队：只写一份待消费信号（执行在主进程） */
			triggerLayer: function (layer) {
				var self = this;
				if (!this.hasPort() || this.busy) return;
				this.busy = "trigger:" + layer;
				// reason 写成人看得懂的一句话，而不是重复 by：`by` 已经说明"谁来请求的"，
				// 两者都塞 "viewer" 会让日志里出现「外部触发（viewer / viewer）」这种零信息的记录。
				V.bridge(EP.trigger, {
					method: "POST",
					body: JSON.stringify({ layer: layer, reason: "查看器「流水线」页的请求入队按钮" }),
				}).then(function (r) {
					self.busy = "";
					var d = r.data || {};
					var ok = r.ok && d.success !== false;
					self.setOps(
						ok
						? (isEnglish ? "Queued a request for <b>" + self.esc(self.layerName(layer)) + "</b>." : "已把 <b>" + self.esc(self.layerName(layer)) + "</b> 的请求写入待消费信号。") + TRIGGER_CAVEAT
							: (isEnglish ? "Could not queue request: " : "入队失败：") + self.esc(self.bridgeError(r)),
						ok ? "" : "err",
						d,
					);
					// 成败都重取：信号格与队列都可能已经变了
					return self.loadAll();
				});
			},

			/** 停止子代理：立即且不可逆（CLI 没有 dry-run），所以先确认 */
			stopLayer: function (layer) {
				var self = this;
				var run = this.runOf(layer);
				if (!this.hasPort() || !run || this.busy) return;
				return V.vue
					.confirm(
						isEnglish ? "Stop the " + this.layerName(layer) + " subagent?\n\nJob " + run.jobId + " · PID " + run.pid + " · " + (run.agent || "?") +
							"\n\nThis is immediate and irreversible: the signal is blocked, then the process tree is terminated. If this batch was not committed, the cursor will not advance and the full batch will run again next time."
							: "停止 " + this.layerName(layer) + " 子代理？\n\njob " + run.jobId + " · pid " + run.pid + " · " + (run.agent || "?") + "\n\n立即且不可逆：先拦信号、再杀进程树；本批未提交 ⇒ 游标不推进，下一轮整批重做。",
						isEnglish ? "Stop subagent" : "停止子代理",
					)
					.then(function (yes) {
						if (!yes) return null;
						self.busy = "stop:" + layer;
						return V.bridge(EP.stop, {
							method: "POST",
							body: JSON.stringify({ layer: layer, job: run.jobId, reason: "查看器「流水线」页的停止按钮" }),
						}).then(function (r) {
							self.busy = "";
							var d = r.data || {};
							var ok = r.ok && d.success !== false;
							if (!ok) {
								self.setOps((isEnglish ? "Could not stop subagent: " : "停止失败：") + self.esc(self.bridgeError(r)), "err", d);
							} else if (d.stopped === false) {
								// 不是错误：没有在跑的子代理是常态。但要说出来，否则"点了没反应"就是新的静默失效
								self.setOps((isEnglish ? "Nothing was stopped: " : "没有停到东西：") + self.esc(String(d.note || (isEnglish ? "no subagent is running for this layer" : "该层没有在跑的子代理"))), "warn", d);
							} else {
								self.setOps(
									self.esc(String(d.note || (isEnglish ? "Subagent stopped." : "已停掉子代理。"))) +
										(d.killConfirmed === false
											? (isEnglish ? "<br>Could not verify process exit. This layer is <b>locked</b>; new jobs are blocked until termination is confirmed." : "<br>未能确认进程已死：该层已被<b>持有</b>（确认停止前不接受新任务）。")
											: ""),
									d.killConfirmed === false ? "warn" : "",
									d,
								);
							}
							return self.loadAll();
						});
					});
			},
		},
		template: /* html */ `
		<header class="page">
			<h1>流水线 · 队列与子代理</h1>
			<!-- 这一页只回答两件事：**现在在跑什么**、**接下来要跑什么**。三层的触发 / 待消费信号 /
			     停止此前散在 L1/L2/L3 三页各自的管理区里，2026-10-08 收拢到这里：三层动作的语义
			     完全一致，写三遍就是三份会分叉的说明。 -->
			<p class="sub">三层共用的作业队列（pipeline/jobs.sqlite）· 待消费触发信号 · 正在跑的子代理与停止。</p>
			<notice :msg="loadNote"></notice>
		</header>

		<main>
			<aside>
				<h2>概览</h2>
				<stat-list :rows="statRows" :foot="statFoot"></stat-list>

				<h2>说明</h2>
				<el-collapse v-model="helpOpen">
					<el-collapse-item name="help" :title="isEnglish ? 'How the queue works · five statuses · sources · effects of queueing or stopping' : '队列是什么 · 五个状态 · 来源 · 请求入队 / 停止的代价'">
						<div class="hint" v-if="!isEnglish">
							<p><b>队列</b>：<code>memoryDB/pipeline/jobs.sqlite</code> 是三层<b>共用的一条队列</b>
							（主进程 worker 认领、子代理提交时自己标 done）。认领是<b>单飞</b>的 —— 任何时刻最多一条在跑，
							所以 <code>queued</code> 里排第一个的就是下一个。</p>
							<p><b>状态</b>：<span class="chip st-queued">排队</span> 已入队未认领 ·
							<span class="chip st-running">在跑</span> 已认领（子进程在工作）·
							<span class="chip st-done">完成</span> 子代理提交成功 ·
							<span class="chip st-skipped">跳过</span> 认领后门控不成立，没干活就收工（不是失败）·
							<span class="chip st-failed">失败</span> 超时或异常，原因写在「说明」列。</p>
							<p><b>来源</b>（谁把它排进来的）：周期到点 · 手动命令 · L1 提交（提交后自动排 L2）·
							收尾续排（L1 收工时 L0 仍有积压）· 门控触发 / 显式信号（L3 的两条触发通道）。</p>
							<p><b>请求入队</b>只写一份待消费信号，<b>不是立即执行</b>：需要 pi 会话活着，
							在下一轮结束（<code>agent_settled</code>）时由主进程消费；pi 没开，信号就躺在盘上等。
							已有同层排队 / 在跑时，队列去重会让这次请求不新增任务。</p>
							<p><b>停止子代理</b>立即且不可逆：先拦信号再杀进程树；本批未提交 ⇒ 游标不推进，下一轮整批重做。
							按钮只在确实有运行记录时可用（没有在跑的子代理时它是装饰，所以禁用）。</p>
						</div>
						<div class="hint" v-else>
							<p><b>Queue</b>: <code>memoryDB/pipeline/jobs.sqlite</code> is shared by all three layers. The main-process worker claims jobs; subagents mark their own jobs complete. Only one job runs at a time, so the first item in <code>queued</code> runs next.</p>
							<p><b>Status</b>: <span class="chip st-queued">Queued</span> waiting to be claimed · <span class="chip st-running">Running</span> claimed and active · <span class="chip st-done">Completed</span> submitted successfully · <span class="chip st-skipped">Skipped</span> a gate failed after claim, so no work was done · <span class="chip st-failed">Failed</span> timed out or errored; see Details.</p>
							<p><b>Sources</b>: scheduled · manual command · L1 submission (queues L2) · L1 follow-up (L0 still has work) · gated trigger or explicit signal (the two L3 trigger paths).</p>
							<p><b>Queue request</b> writes a pending signal; it does <b>not</b> run immediately. The pi session must be active; the main process consumes the signal after the next turn (<code>agent_settled</code>). If pi is closed, the signal waits on disk. Duplicate requests are ignored while the same layer is queued or running.</p>
							<p><b>Stop subagent</b> is immediate and irreversible: the signal is blocked, then the process tree is terminated. If the current batch was not committed, the cursor does not advance and the full batch runs again next time. The button is enabled only when a process is actually running.</p>
						</div>
					</el-collapse-item>
				</el-collapse>
			</aside>

			<section class="content">
				<h2>三层子代理</h2>
				<el-table :data="layerRows" size="small" row-key="id" empty-text="尚未加载">
					<!-- 列宽口径：五列相加 ≈ 890px，正好落在 1280 视口下内容列的 894px 里 ——
					     列宽之和超过容器会让 el-table 自己长出一条横向滚动条，而"一层只有一条滚动轴"
					     是设计契约 3。旧版固定列 150+150+200、两个自适应列，比例相同。 -->
					<el-table-column label="层" width="150">
						<template #default="{ row }">
							<b>{{ row.name }}</b>
							<div class="hint">{{ row.agent }}　{{ row.what }}</div>
						</template>
					</el-table-column>
					<el-table-column label="待消费信号" min-width="180">
						<template #default="{ row }">
							<template v-if="row.sig">
								<chip kind="st-queued" :label="'待消费 · ' + fromNow(row.sig.at)" :tip="fmtTime(row.sig.at)"></chip>
								<div class="hint">
									{{ row.sig.by || "?" }}<span v-if="row.sig.reason"> · {{ row.sig.reason }}</span><b v-if="row.sig.personaSignal"> · 显式信号（P1 闸）</b>
								</div>
							</template>
							<span v-else class="hint">无</span>
						</template>
					</el-table-column>
					<el-table-column label="正在跑" min-width="180">
						<template #default="{ row }">
							<template v-if="row.run">
								<chip kind="st-running" :label="'job ' + row.run.jobId + ' · pid ' + row.run.pid" tip="来自 /api/subagent-runs"></chip>
								<div class="hint">{{ row.run.agent || "?" }} · 起于 {{ fmtTime(row.run.startedAt) }}（{{ fromNow(row.run.startedAt) }}）</div>
							</template>
							<span v-else class="hint">没有在跑</span>
						</template>
					</el-table-column>
					<el-table-column label="最近结束" width="150">
						<template #default="{ row }">
							<template v-if="row.last">
								<chip :kind="row.lastStatus.cls" :label="row.lastStatus.label"></chip>
								<div class="hint">job {{ row.last.id }} · {{ fromNow(row.last.finishedAt || row.last.createdAt) }}</div>
							</template>
							<span v-else class="hint">{{ jobs ? "没有已结束记录" : "—" }}</span>
						</template>
					</el-table-column>
					<el-table-column label="动作" width="230">
						<template #default="{ row }">
							<div class="cell-actions">
								<!-- 请求入队：写信号（不是执行）；没有写盘桥时禁用 -->
								<el-button :disabled="!row.canTrigger" title="向该层写一份待消费信号（只入队，不立即执行）" @click="triggerLayer(row.id)">请求入队</el-button>
								<!-- 停止：只在确有运行记录时可用（旧版同款判定：没有在跑的子代理时它只是装饰） -->
								<el-button type="danger" :disabled="!row.canStop" :title="row.run ? ('停掉 job ' + row.run.jobId + '（pid ' + row.run.pid + '）') : '没有在跑的子代理'" @click="stopLayer(row.id)">停止子代理</el-button>
								<span v-if="row.triggering" class="hint">请求中…</span>
								<span v-if="row.stopping" class="hint">停止中…</span>
							</div>
						</template>
					</el-table-column>
				</el-table>
				<!-- 不属于这三层的运行记录（skill / review 等）不静默隐藏：它们确实在跑、也确实占着进程，
				     只是本页不给它们动作 -->
				<div class="hint" v-if="extraRuns.length">
					另有 {{ extraRuns.length }} 条运行记录不属于这三层：<span v-for="(r, i) in extraRuns" :key="i"><code>{{ r.layer }}</code>（job {{ r.jobId }} · pid {{ r.pid }}）<span v-if="i < extraRuns.length - 1">、</span></span>
					 —— 本页不给它们动作，要停请用 <code>/my-memory:subagent-kill</code>。
				</div>

				<div v-if="ops.html">
					<notice :msg="ops"></notice>
					<json-details v-if="opsJson !== null" summary="返回" :value="opsJson"></json-details>
				</div>

				<h2>队列（进行中）</h2>
				<p class="hint" v-html="queueNoteHtml"></p>
				<job-table :rows="queueRows"></job-table>

				<h2>最近结束</h2>
				<!-- 历史是"查"不是"用"：默认收起，展开才渲染（它可能几十行） -->
				<el-collapse v-model="recentOpen">
					<el-collapse-item name="recent" :title="recentTitle">
						<job-table :rows="recent"></job-table>
					</el-collapse-item>
				</el-collapse>
			</section>
		</main>
		`,
	};

	V.vue.mount(PAGE, { active: "pipeline-viewer.html" });
})();
