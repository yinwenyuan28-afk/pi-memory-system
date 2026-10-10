/*
 * viewers/assets/index-app.js —— 总览页（数据健康摘要 + 版本/漂移 + 各页入口）· Vue 3 版
 *
 * 依赖：viewer-core.js（window.V）、viewer-vue.js（V.vue）。本页不涉及质量分，不加载 quality-core；
 * 也**没有任何写盘动作**（唯一的"写盘"相关交互是「写盘状态」按钮，它只把桥的有无说清楚）。
 *
 * ── 这一页为什么存在 ────────────────────────────────────────────────────────
 *
 * 只做一件事：把"这一层现在健不健康"用少量数字摊开，并给出到各页的入口。
 * 刻意不复用各页的完整渲染 —— 总览页要能在各页出问题时仍然可用（它是排查的起点）。
 *
 * 健康摘要的取数原则：**能读多少读多少，读不到就说读不到**。
 * 不把"取数失败"渲染成 0（0 与"未知"是两回事，混起来会让人以为库是空的）。
 * 落到实现上是三种状态，必须分开表达：
 *   · undefined —— 还没取到（旧版是写死的「加载中 / …」，或一个空 div）
 *   · null      —— 取到了但没有（旧版渲染成「读不到」胶囊 / warn 提示条）
 *   · 对象/数字 —— 有值（0 也是一个值）
 *
 * ── 七个只读端点 + 五条相对路径直读（与旧版逐个对齐）────────────────────────
 *
 *   GET /api/viewer-status   源码版本 vs 已部署版本（漂移检测）—— **先跑**，它的结果写 loadNote
 *   GET /api/l1/shards       L1 分片清单（分片数 / 总行数 / 最新分片）—— 抽样块也用它挑分片
 *   GET /api/l2/blocks       L2 块清单（live / archive）—— 索引↔磁盘对账的一半
 *   GET /api/l1/active-days  活跃会话日（**权威**衰减时钟；hit-stats.json 侧车会滞后）
 *   GET /api/limits          阈值（USER.md 预算 / P4 间隔）
 *   GET /api/profile-files   画像三件套（在 profile 根，只能走这个白名单端点）
 *   GET /api/l3/backups      画像备份清单
 *
 *   相对路径直读（桥只挂载 {memoryDB}，所以这些都要走 memoryDB 内的相对路径）：
 *   ../l1/records/<最新分片> · ../l2/index/scene_index.json · ../l2/index/scene_members.json
 *   · ../l2/archive/scene_members.json · ../l2/archive/ledger.jsonl · ../l3/cursor.json
 *
 * ── Vue 版与旧版的差别（只列会影响行为的）──────────────────────────────────
 *
 * 1. 外壳换成 Element Plus（el-button / el-collapse）与共享组件（stat-list / notice / chip）：
 *    **端点、判定条件、文案一字未改** —— 这一页的价值在口径，重构不该动口径。
 * 2. 旧版的六处 innerHTML 拼串（#health / #l1 / #l1sample / #clock / #l2 / #l3）改成响应式数据 +
 *    computed；"读不到"与"空"的三态表达原样保留。
 * 3. 「页面」导航：旧版是 `<button onclick="location.href='x.html' + location.search">`，
 *    现在是 el-button + `go()`，**跳转仍然拼接 location.search**（丢了 ?port= 页面就静默变只读，
 *    这是门禁 ⑰ 钉住的契约）。四条的标题与副标题文案逐字保留。
 * 4. 侧栏「怎么用」由 `<details class="more">` 换成 el-collapse（同样默认收起）。
 * 5. 统计行的口径注释按 `<stat-list>` 的 rows/foot 分组摆放：L1（最近分片）、衰减时钟（首/末 +
 *    来源）、L2（无写盘桥那句走 foot，对账结论仍是独立 notice）文案与归属都不变；L3 的两条
 *    行内注释拆成"画像文件"一组（两行 + 两条注释）与"进度/备份"一组，避免注释漂到无关的行下面。
 *    详见各 computed 上方的注释。
 */
(function () {
	"use strict";

	var V = window.V;

	/** 端点字面量集中一处：门禁 ⑬ 按字面量核对桥里是否声明（拼串会漏检）。 */
	var EP = {
		viewerStatus: "/api/viewer-status",
		l1Shards: "/api/l1/shards",
		l2Blocks: "/api/l2/blocks",
		activeDays: "/api/l1/active-days",
		limits: "/api/limits",
		profileFiles: "/api/profile-files",
		l3Backups: "/api/l3/backups",
	};

	/**
	 * 侧栏导航入口（四个页面的主标题 / 副标题与旧版逐字一致）。
	 *
	 * 不复用 `V.PAGES`：那是顶部导航的清单（含本页、且 L2/L3 的短标签与这里的"L2 场景层 /
	 * L3 画像层"不同），这一页的按钮要带各自的一句话说明。
	 */
	var PAGES = [
		{ file: "records-viewer.html", label: "L1 原子记忆", desc: "记录 / 质量分 / 任务状态" },
		{ file: "l2-viewer.html", label: "L2 场景层", desc: "块 / 成员 / 归档账本" },
		{ file: "l3-viewer.html", label: "L3 画像层", desc: "游标 / 三份画像文件" },
		{ file: "pipeline-viewer.html", label: "流水线", desc: "队列 / 子代理 / 触发与停止" },
	];

	/** 尚未取到数时的占位行（旧版 HTML 里写死的「加载中 / …」）。 */
	var LOADING_ROWS = [{ label: "加载中", value: "…" }];

	/**
	 * 统计行。
	 *
	 * value 为 null/undefined 时显示「读不到」胶囊：0 与"未知"必须分开表达（旧版同款判定）。
	 * value 允许 HTML（stat-list 用 v-html 渲染），所以这里自己先转义。
	 *
	 * @param label 左侧文案（靠 Vue 插值转义）
	 * @param value 右侧值；null/undefined = 读不到
	 */
	function statRow(label, value) {
		return {
			label: label,
			value: value === null || value === undefined ? '<span class="chip del">读不到</span>' : V.escapeHtml(String(value)),
		};
	}

	// ── 页面 ────────────────────────────────────────────────────────────────

	var PAGE = {
		mixins: [V.vue.pageMixin], // loadNote / busy / setNote / hasPort / bridgeError / esc / fmtTime / fromNow
		data: function () {
			return {
				/** 侧栏导航（模板只能解析组件实例上的名字，模块级常量必须挂上来） */
				pages: PAGES,
				/** /api/l1/shards 的两条统计；null = 还没取到（取不到时对象里是 {source:"none"}） */
				l1: null,
				/** 最新分片抽样：undefined = 加载中（旧版这里是空 div）、null = 读不到最新分片 */
				sample: undefined,
				/** 衰减时钟来源：undefined = 加载中（旧版这里是空 div）、null = 拿不到活跃会话日 */
				clock: undefined,
				/** L2 摘要；null = 还没取到 */
				l2: null,
				/** L3 摘要；null = 还没取到 */
				l3: null,
				/** 摘要取数失败的原因（**全部落定后**一次性摆出来 —— 旧版同样不中途闪红） */
				errors: [],
				/** 「写盘状态」按钮的提示（旧版 `#hint`：点之前不占位） */
				hintNote: { html: "", level: "" },
				/** 侧栏「怎么用」的展开状态（默认收起，与旧版 `<details>` 一致） */
				helpOpen: [],
			};
		},
		// 旧版的 init() 做三件事：mountChrome（已在 V.vue.mount 里做过）、bind()（Vue 接管，
		// 不再需要手动挂事件）、load()。挂载后立刻取一次数。
		mounted: function () {
			var self = this;
			V.registerRefreshHandler(function () { return self.loadAll(); });
			this.loadAll();
		},
		computed: {
			/** 健康区（旧版 `#health`）：只在有取数失败时出现，文案与旧版一致。 */
			healthNote: function () {
				return { html: "有 " + this.errors.length + " 项摘要取数失败：" + this.esc(this.errors.join("；")), level: "err" };
			},

			/** L1 记录库（旧版 `#l1`）：分片数 / 总行数，无桥时两条都是「读不到」。 */
			l1Rows: function () {
				if (!this.l1) return LOADING_ROWS;
				return [statRow("分片数", this.l1.shards), statRow("总行数（含墓碑）", this.l1.rows)];
			},
			/** 分片口径：无桥时给原因（不是 0），有桥时给最新分片名。 */
			l1Foot: function () {
				if (!this.l1) return [];
				return [this.l1.source === "none" ? this.esc(this.l1.note) : "最近分片 " + this.esc(this.l1.lastShard || "—")];
			},

			/** 最新分片的抽样结果（刚读到时为空数组 = 加载中，不占位）。 */
			sampleRows: function () {
				if (!this.sample) return [];
				return [statRow("最新分片 " + this.sample.shard, this.sample.rows + " 行 / " + this.sample.distinct + " 个 id")];
			},

			/** 衰减时钟：活跃会话日条数。 */
			clockRows: function () {
				if (!this.clock) return [];
				return [statRow("活跃会话日", this.clock.count)];
			},
			/** 时钟口径：首/末会话日 + 为什么它比侧车权威（<br> 保留旧版换行）。 */
			clockFoot: function () {
				if (!this.clock) return [];
				return [
					"首 " +
						this.esc(this.clock.firstDay || "—") +
						" · 末 " +
						this.esc(this.clock.lastDay || "—") +
						"<br>来源：<code>l0/conversations</code>（权威；<code>hit-stats.json</code> 侧车会滞后）",
				];
			},
			/** 拿不到活跃会话日时说的那句（旧版 .notice.warn）。 */
			clockWarn: function () {
				return { html: "拿不到活跃会话日：质量分的衰减时钟会退化为日历天（停工期间照常衰减）。", level: "warn" };
			},

			/** L2 场景层（旧版 `#l2`）：live 块（索引 / 磁盘）、归档块、live 成员总数、账本条目。 */
			l2Rows: function () {
				if (!this.l2) return LOADING_ROWS;
				var s = this.l2;
				return [
					statRow("live 块（索引 / 磁盘）", s.index + " / " + (s.diskLive === null ? "?" : s.diskLive)),
					statRow("归档块", s.archive),
					statRow("live 成员总数", s.memberTotal),
					statRow("账本条目", s.ledger),
				];
			},
			/** 无写盘桥时唯一能说的那句（旧版是 row() 的 note → .hint）。 */
			l2Foot: function () {
				if (!this.l2 || this.l2.missingOnDisk !== null) return [];
				return ["无写盘桥：无法核对「索引 ↔ 磁盘」。"];
			},
			/** 索引↔磁盘的对账结论（旧版是四行之后的 .notice / .notice.warn）。 */
			l2Notice: function () {
				if (!this.l2 || this.l2.missingOnDisk === null) return null;
				if (this.l2.missingOnDisk === 0 && this.l2.notIndexed === 0) {
					return { html: "索引与磁盘一致（无缺失块、无未入索引块）。", level: "" };
				}
				return {
					html: "索引缺块 " + this.l2.missingOnDisk + " 个 · 未入索引块 " + this.l2.notIndexed + " 个 —— 详见 L2 页的对账结果。",
					level: "warn",
				};
			},

			/**
			 * L3 画像层（旧版 `#l3` 的前两行）——"画像文件读到了没有"这一组。
			 * profile 三件套读不到时两行都是「读不到」（0 会被误读成"文件是空的"）。
			 */
			l3ProfileRows: function () {
				if (!this.l3) return LOADING_ROWS;
				var s = this.l3;
				return [
					statRow(
						"USER.md 条目 / 预算",
						s.profileFilesAvailable ? s.userEntries + " 条 / " + s.userBudget + (s.userLimit ? " / " + s.userLimit : "") + " 字符" : null,
					),
					statRow("USER-temp 待合入条目", s.profileFilesAvailable ? s.pendingProposal : null),
				];
			},
			/** 这两行的口径注释（旧版逐行跟在数字下面，这里归到该组之后，顺序与旧版一致）。 */
			l3ProfileFoot: function () {
				if (!this.l3) return [];
				return ["预算按 <code>entryBudget</code>（正文 + 分隔符），<b>不是字节数</b>", "L3 提议稿；合并进 live 是人工动作"];
			},
			/** L3 的后两行：P4 进度（游标）与画像备份数。 */
			l3ProgressRows: function () {
				if (!this.l3) return LOADING_ROWS;
				var pending = this.l3.cursor ? this.l3.cursor.memoriesSinceLastPersona : null;
				return [
					statRow("P4 进度", pending === null ? null : pending + (this.l3.interval ? " / " + this.l3.interval : "")),
					statRow("画像备份数", this.l3.backups),
				];
			},
			/** 画像三件套读不到时先给一条 warn（旧版把它放在数字**之前**，不让人误读 0）。 */
			l3Notice: function () {
				if (!this.l3 || this.l3.profileFilesAvailable) return null;
				return {
					html:
						"读不到 profile 根的画像文件（<code>MEMORY.md</code>/<code>USER.md</code>/<code>USER-temp.md</code>）" +
						"—— 需要写盘桥的 <code>/api/profile-files</code>。下面条目数为 0 不代表文件为空。",
					level: "warn",
				};
			},
		},
		methods: {
			/**
			 * 最近一次 L1 分片日期（从 bridge 的分片清单取）；无桥则用"读不到"表达。
			 *
			 * @returns Promise<{source:"bridge",shards,rows,lastShard} | {source:"none",note}>
			 */
			l1Summary: function () {
				return V.bridge(EP.l1Shards).then(function (r) {
					if (r.ok && r.data && Array.isArray(r.data.shards)) {
						var rows = r.data.total || 0;
						var last = r.data.shards.length ? r.data.shards[r.data.shards.length - 1].file : null;
						return { source: "bridge", shards: r.data.shards.length, rows: rows, lastShard: last };
					}
					return { source: "none", note: "无写盘桥：列不了分片目录" };
				});
			},

			/**
			 * L1 记录条数与任务状态分布（需要真读分片；这里只读最近一天的分片做抽样，避免总览页拖慢）。
			 *
			 * @returns Promise<null | {shard, rows, distinct, tasks:{open,done,dropped}}>
			 *          null = 读不到最新分片（没有分片清单、或那一份读不出来）
			 */
			l1Sample: function () {
				return V.bridge(EP.l1Shards).then(function (r) {
					if (!r.ok || !r.data || !r.data.shards || r.data.shards.length === 0) return null;
					var last = r.data.shards[r.data.shards.length - 1].file;
					return V.loadText("../l1/records/" + last).then(function (txt) {
						if (txt === null) return null;
						var rows = V.parseJsonl(txt, last);
						var byId = new Map();
						rows.forEach(function (x) {
							if (x && x.id) byId.set(x.id, x);
						});
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
			},

			/**
			 * 衰减时钟来源：活跃会话日。
			 *
			 * 端点路径必须带 l1/ 前缀（桥的路由是 /api/l1/active-days）；写错会静默退化成
			 * "拿不到活跃会话日"，把权威时钟误报成不可用。
			 *
			 * @returns Promise<null | {count, firstDay, lastDay}>（null = 端点没读到或 available 为假）
			 */
			clockSource: function () {
				return V.bridge(EP.activeDays).then(function (r) {
					return r.ok && r.data && r.data.available ? r.data : null;
				});
			},

			/**
			 * L2 摘要：块清单（live/archive）+ 两份成员侧车 + 归档账本 + 索引↔磁盘对账。
			 *
			 * @returns Promise<{index,diskLive,archive,memberTotal,archiveMembers,ledger,missingOnDisk,notIndexed}>
			 */
			l2Summary: function () {
				return Promise.all([
					V.loadJson("../l2/index/scene_index.json"),
					V.loadJson("../l2/index/scene_members.json"),
					V.loadJson("../l2/archive/scene_members.json"),
					V.loadJsonl("../l2/archive/ledger.jsonl"),
					V.bridge(EP.l2Blocks),
				]).then(function (r) {
					var index = Array.isArray(r[0]) ? r[0] : [];
					var members = r[1] || {};
					var archiveMembers = r[2] || {};
					var ledger = Array.isArray(r[3]) ? r[3] : [];
					var live = r[4] && r[4].ok ? r[4].data.live : null;
					var arch = r[4] && r[4].ok ? r[4].data.archive : null;
					var memberTotal = 0;
					Object.keys(members).forEach(function (f) {
						memberTotal += (members[f] || []).length;
					});
					// 索引 ↔ 磁盘 差异（只在有桥时算）
					var idxFiles = {};
					index.forEach(function (e) {
						if (e && e.filename) idxFiles[e.filename] = true;
					});
					var missingOnDisk = live
						? Object.keys(idxFiles).filter(function (f) {
								return !live.some(function (d) {
									return d.file === f;
								});
							}).length
						: null;
					var notIndexed = live
						? live.filter(function (d) {
								return !idxFiles[d.file];
							}).length
						: null;
					return {
						index: index.length,
						diskLive: live ? live.length : null,
						archive: arch ? arch.length : null,
						memberTotal: memberTotal,
						archiveMembers: Object.keys(archiveMembers).length,
						ledger: ledger.length,
						missingOnDisk: missingOnDisk,
						notIndexed: notIndexed,
					};
				});
			},

			/**
			 * L3 摘要：游标 + 画像三件套条目/预算 + P4 间隔 + 备份数。
			 *
			 * @returns Promise<{profileFilesAvailable,cursor,userEntries,userBudget,userLimit,tempEntries,tempBudget,pendingProposal,interval,backups}>
			 */
			l3Summary: function () {
				// 画像三件套在 profile 根（见 l3-view.js 的同一说明），只能走白名单端点
				return Promise.all([V.loadJson("../l3/cursor.json"), V.bridge(EP.limits), V.bridge(EP.profileFiles), V.bridge(EP.l3Backups)]).then(function (r) {
					var cursor = r[0] || null;
					var limits = r[1] && r[1].ok ? r[1].data.l3 : null;
					var pf = r[2] && r[2].ok && r[2].data && r[2].data.files ? r[2].data.files : null;
					var backups = r[3] && r[3].ok && r[3].data.backups ? r[3].data.backups : null;
					var parse = function (raw) {
						if (raw === null || raw === undefined || String(raw).trim() === "") return [];
						return String(raw)
							.split(/\r?\n§\r?\n/)
							.map(function (p) {
								return p.trim();
							})
							.filter(Boolean);
					};
					var budget = function (entries) {
						if (entries.length === 0) return 0;
						return (
							entries.reduce(function (s, e) {
								return s + e.length;
							}, 0) +
							3 * (entries.length - 1)
						);
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
						pendingProposal: tempEntries.filter(function (e) {
							return userEntries.indexOf(e) < 0;
						}).length,
						interval: limits ? limits.interval : null,
						backups: backups ? backups.length : null,
					};
				});
			},

			/** 「刷新摘要」/ 首次挂载：版本检查 → 五路摘要（旧版 load() 的顺序）。 */
			loadAll: function () {
				var self = this;
				this.setNote("汇总中…");
				return V.bridge(EP.viewerStatus)
					.then(function (r) {
						var v = r.ok && r.data ? r.data : null;
						// 版本号由右上角的版本 chip 负责（viewer-core 注入），这里不再抄一遍 ——
						// 同一个 0.1.0+hash 在首屏出现两次，读者要自己确认它们说的是同一件事。
						// 这里只留 chip 没有的：是否漂移、是否从未部署、退役清单。
						self.setNote(
							v
								? (v.drifted
										? '<b class="text-warn">源码已更新但未部署</b>（重启会话或 /reload 会触发部署）'
										: v.deployedVersion
											? "源码与已部署版本一致"
											: '<b class="text-warn">从未部署</b>') +
										(v.retired && v.retired.length ? " · 已退役：" + self.esc(v.retired.join("、")) : "")
								: "无写盘桥：无法做版本/漂移检查（只能只读浏览本地文件）。",
							v && v.drifted ? "warn" : "",
						);
						return self.loadSummaries();
					});
			},

			/**
			 * 五路摘要并行取（每一路的失败都不拖累其余：能读多少读多少）。
			 *
			 * 每一路自己 `.then` 写自己的那一格 —— 与旧版逐段渲染同款：先到的先显示，
			 * 而不是等最慢的那一路把整页卡成空白。
			 */
			loadSummaries: function () {
				var self = this;
				var errors = [];
				var tasks = [
					this.l1Summary().then(function (s) {
						self.l1 = s;
					}),
					this.l1Sample().then(function (s) {
						self.sample = s;
					}),
					this.clockSource().then(function (s) {
						self.clock = s;
					}),
					this.l2Summary().then(function (s) {
						self.l2 = s;
					}),
					this.l3Summary().then(function (s) {
						self.l3 = s;
					}),
				];
				return Promise.all(
					tasks.map(function (p) {
						return p.catch(function (e) {
							errors.push(e && e.message ? e.message : String(e));
						});
					}),
				).then(function () {
					self.errors = errors;
				});
			},

			/** 「写盘状态」：把"现在能不能写"说清楚（旧版 #hint，只读时给可操作的下一步）。 */
			showBridgeState: function () {
				var port = V.bridgePort();
				this.hintNote = port
					? { html: "当前已带 ?port=" + this.esc(port) + "，写盘可用。", level: "" }
					: {
							html:
								"当前未带 ?port=，只能只读浏览。运行 <code>node scripts/l1-admin/viewer-bridge.mjs</code> " +
								"后打开它打印的地址即可写盘。",
							level: "warn",
						};
			},

			/**
			 * 侧栏「页面」的跳转。
			 *
			 * **必须拼上 location.search**：丢掉 `?port=` 的页面不会报错，只会安静地少掉一半能力
			 * （全部分片自动加载、目录列举、画像文件、全部写回）—— 这正是门禁 ⑰ 钉住的那条契约。
			 *
			 * @param file 目标页文件名（与 viewer-core 的 PAGES 同源）
			 */
			go: function (file) {
				location.href = file + location.search;
			},
		},
		template: /* html */ `
		<header class="page">
			<h1>记忆库查看器</h1>
			<p class="sub">L0–L3 记忆库的本地查看器。源码在插件仓库 <code>viewers/</code>，激活时按内容哈希同步到 <code>{profile}/memoryDB/viewers/</code>。</p>
			<notice :msg="loadNote"></notice>
			<div class="toolbar">
				<el-button @click="showBridgeState">写盘状态</el-button>
			</div>
			<!-- 「写盘状态」的答案：点之前不占位（旧版 #hint 是 display:none 的空 div） -->
			<notice v-if="hintNote.html" :msg="hintNote"></notice>
		</header>

		<main>
			<aside>
				<!-- 导航放最前：这一页的左栏是入口，不是说明书。
				     「怎么用」三段是 366 字的教程，此前占着左栏第一屏（整页 53% 的字都是它）。 -->
				<h2>页面</h2>
				<div class="btn-list">
					<el-button v-for="p in pages" :key="p.file" @click="go(p.file)"><span>{{ p.label }}</span><span class="n">{{ p.desc }}</span></el-button>
				</div>

				<h2>怎么用</h2>
				<el-collapse v-model="helpOpen">
					<el-collapse-item name="help" title="经写盘桥打开 / file:// 会降级 / 版本 chip 怎么看">
						<div class="hint">
							<p><b>推荐经写盘桥打开</b>：<code>node scripts/l1-admin/viewer-bridge.mjs</code>，然后打开终端打印的 <code>http://localhost:5174/viewers/index.html?port=5174</code>。带 <code>?port=</code> 才有：全部分片的自动加载、目录列举（解开日期窗口）、以及写盘（改任务状态 / 删除）。</p>
							<p><b>直接双击 HTML（file://）</b>：页面能打开，但自动加载与写回都不可用（浏览器禁止 <code>file://</code> 下的 fetch），所以看不到数据。必须经写盘桥。</p>
							<p><b>要在别的设备上打开</b>（同一局域网）：给桥加 <code>--lan</code>（或 <code>--host &lt;本机IP&gt;</code>），它会额外监听局域网那张网卡，然后从别的设备访问它打印的那个地址。注意这个地址上<b>没有鉴权</b> —— 同网段任何设备都能读写，只在可信网络里用。</p>
							<p><b>版本 chip</b>：右上角显示已部署版本；若源码改过但还没部署，会标黄提示「源码已更新未部署」。</p>
						</div>
					</el-collapse-item>
				</el-collapse>
			</aside>

			<section class="content">
				<!-- 健康区：取数失败不静默 —— 五路里坏了几路就说几路 -->
				<notice v-if="errors.length" :msg="healthNote"></notice>

				<h2>L1 记录库</h2>
				<stat-list :rows="l1Rows" :foot="l1Foot"></stat-list>
				<!-- 抽样块是独立的一组（旧版 #l1sample 与 #l1 分开、上面留 6px）：
				     加载中为空、读不到给一句话，绝不拿 0 冒充 -->
				<div style="margin-top: 6px">
					<template v-if="sample">
						<stat-list :rows="sampleRows"></stat-list>
						<div class="chips">
							<chip kind="task-open" :label="'待办 ' + sample.tasks.open"></chip>
							<chip kind="task-done" :label="'已完成 ' + sample.tasks.done"></chip>
							<chip kind="task-dropped" :label="'已废弃 ' + sample.tasks.dropped"></chip>
						</div>
						<div class="hint">任务状态按 <code>taskState</code> 统计（缺字段 = 待办）。这只是<b>最新一天分片</b>的抽样，全库分布见 L1 页。</div>
					</template>
					<div class="hint" v-else-if="sample === null">读不到最新分片。</div>
				</div>

				<h2>衰减时钟来源</h2>
				<stat-list v-if="clock" :rows="clockRows" :foot="clockFoot"></stat-list>
				<notice v-else-if="clock === null" :msg="clockWarn"></notice>

				<h2>L2 场景层</h2>
				<stat-list :rows="l2Rows" :foot="l2Foot"></stat-list>
				<notice v-if="l2Notice" :msg="l2Notice"></notice>

				<h2>L3 画像层</h2>
				<notice v-if="l3Notice" :msg="l3Notice"></notice>
				<stat-list :rows="l3ProfileRows" :foot="l3ProfileFoot"></stat-list>
				<stat-list :rows="l3ProgressRows"></stat-list>
			</section>
		</main>
		`,
	};

	V.vue.mount(PAGE, { active: "index.html" });
})();
