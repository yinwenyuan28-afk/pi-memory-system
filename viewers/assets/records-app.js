/*
 * viewers/assets/records-app.js —— L1 原子记忆页 · Vue 3 + Element Plus 版
 *
 * 依赖：viewer-core.js（window.V）、quality-core.js（window.VQ）、viewer-vue.js（V.vue）。
 *
 * ── 这一页表达什么（与旧 records-view.js 完全一致，重构没动语义）──────────────
 *
 *   · `taskState`（2026-10-08）：work_task 的任务生命周期，与 `deleted` 是**独立的两根轴**，
 *     一条记录可以既是「已完成」又已被 deleted，两者不合并成一个状态。
 *   · 场景归属：`scene_name` 只是落盘时的历史快照，真源是 `l1/scenes.json`；按 `scene_id`
 *     解析 canonical 名，已合并（mergedInto）的给出提示。
 *   · 项目维度：`metadata.project`。
 *   · 价值校验丢弃留痕：被 value-check 判 drop 的记录**从不写进库**，`value-check-log.jsonl`
 *     是它们唯一的留痕（否则只有幸存者偏差）。
 *   · 淘汰候选：`judgePrune` —— 质量分是"热度"，能不能删是另一半信息。
 *
 * ── Vue 版与旧版的差别（逐条，含理由）──────────────────────────────────────
 *
 * 1. **状态收敛到 Vue 的响应式数据**。旧版是 `state` 单例 + `renderXxx()` 手工重画，
 *    每加一个筛选条件都要记得"改完调 renderAll()"（漏一处就是静默不刷新）。现在筛选条件、
 *    选中集合、管理面板状态都是 `data`，派生量是 `computed` —— 不存在"忘记重画"这种 bug。
 * 2. **弹层里的记录不再靠下标定位**。旧版卡片写 `data-idx`，点击时用 `state.lastRows[idx]`
 *    取回记录；下标只在"当前这一份渲染结果"里有效，任何一次重画都会让它指向别处。
 *    新版直接把记录对象交给 `openModal(row)`。
 * 3. **列表分页**（每页 60 / 120 / 240 / 全部，默认 60）。旧版一次渲染全部（实测 566 张卡片），
 *    每次改搜索词都要重建整张列表。**语义未变**：「全选当前筛选」与「导出当前视图」作用的仍是
 *    **筛选结果全集**（不是当前页），分页只影响画面。
 * 4. **确认框换成 EP 的弹层**（`V.vue.confirm`）：`window.confirm` 是同步阻塞的，浏览器自动化
 *    会直接把它接受掉而页面 JS 卡住（2026-10-10 实测踩过）。
 * 5. 表格 / 折叠面板 / 下拉 / 输入框 / 分段切换 / 提示换成 Element Plus —— 端点、请求体、
 *    判定条件、文案、四道闸（证据 ≥20 字符、新正文 ≥10 字符、24h 防抖、高价值保护）一字未改。
 */
(function () {
	"use strict";

	var V = window.V;
	var VQ = window.VQ;

	/** 类型轴上的**虚拟值**：work_task 之外的全部记录（真 type 里没有 `!` 前缀，不会撞车）。 */
	var NON_TASK = "!non-task";

	/** 任务状态的**固定顺序**（= record-types.ts 的 L1_TASK_STATES）：菜单里不按计数排。 */
	var TASK_STATES = ["open", "done", "dropped"];

	/** 质量标签的固定顺序 + 温度色工具类（色值只在 viewer-theme.css 里有一份）。 */
	var QUALITY_TAGS = ["热", "温", "冷", "新", "噪", "待观察"];
	var TAG_BAR = { 热: "c-hot", 温: "c-warm", 冷: "c-cold", 新: "c-new", 噪: "c-noise", 待观察: "c-watch" };

	/** 排序选项（与旧版 <select id="sort"> 的取值一字不差）。 */
	var SORTS = [
		{ value: "quality-desc", label: "质量分 ↓" },
		{ value: "quality-asc", label: "质量分 ↑" },
		{ value: "updated-desc", label: "更新时间 ↓" },
		{ value: "updated-asc", label: "更新时间 ↑" },
		{ value: "prio-desc", label: "优先级 ↓" },
		{ value: "prio-asc", label: "优先级 ↑" },
		{ value: "type", label: "按类型" },
	];

	/** 端点字面量集中一处：门禁 ⑬ 按字面量核对桥里是否声明，拼串会漏检。 */
	var EP = {
		shards: "/api/l1/shards",
		activeDays: "/api/l1/active-days",
		taskState: "/api/task-state",
		tombstone: "/api/tombstone",
		fix: "/api/l1/fix",
		limits: "/api/limits",
		embeddings: "/api/l1/embeddings",
		embedding: "/api/l1/embedding",
		backups: "/api/l1/backups",
		rollback: "/api/l1/rollback",
		l1mode: "/api/l1/mode",
	};

	// ── 纯函数（与旧版逐行对应，只是把 `state.*` 改成入参）─────────────────────

	function fmtQ(n) {
		return Number(n).toFixed(2);
	}

	/** 字节 → 人类可读（只用于备份大小比较，不参与任何判定）。 */
	function fmtBytes(n) {
		if (typeof n !== "number" || Number.isNaN(n)) return "—";
		if (n < 1024) return n + " B";
		if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
		return (n / 1024 / 1024).toFixed(1) + " MB";
	}

	/** 场景名归一（与 scene-pool.ts 的 normalizeSceneName 同口径：折叠空白 + trim）。 */
	function normalizeSceneName(s) {
		return String(s || "").replace(/\s+/g, " ").trim();
	}

	function taskStateOf(rec) {
		var s = rec && rec.taskState;
		if (s === "open" || s === "done" || s === "dropped") return s;
		return "open"; // 缺字段/非法值一律按 open —— 与 record-types.ts 的 taskStateOf 同口径
	}

	/** 项目路径（记录里的 metadata.project）。 */
	function projectOf(rec) {
		var md = rec && rec.metadata;
		return md && typeof md.project === "string" ? V.normalizePath(md.project) : "";
	}

	function scopeOf(rec) {
		var md = rec && rec.metadata;
		return md && typeof md.scope === "string" ? md.scope : "";
	}

	/** 审计字段取值（任务状态变更 / 价值校验 / 就地清理）。 */
	function auditOf(rec) {
		var md = (rec && rec.metadata) || {};
		return {
			taskStateChange: md.taskStateChange && typeof md.taskStateChange === "object" ? md.taskStateChange : null,
			valueCheck: md.valueCheck && typeof md.valueCheck === "object" ? md.valueCheck : null,
			l1Cleanup: md.l1Cleanup && typeof md.l1Cleanup === "object" ? md.l1Cleanup : null,
		};
	}

	/** 场景池 → 两套索引（id / 名称+别名，canonical 名优先于别名）。 */
	function buildSceneIndex(payload) {
		var list = payload && Array.isArray(payload.scenes) ? payload.scenes : [];
		var byId = new Map();
		var byName = new Map();
		for (var i = 0; i < list.length; i++) {
			var e = list[i];
			if (!e || typeof e.id !== "string") continue;
			byId.set(e.id, e);
			if (e.name) byName.set(normalizeSceneName(e.name), e);
			if (Array.isArray(e.aliases)) {
				for (var a = 0; a < e.aliases.length; a++) {
					var al = normalizeSceneName(e.aliases[a]);
					if (al && !byName.has(al)) byName.set(al, e);
				}
			}
		}
		return { byId: byId, byName: byName };
	}

	/**
	 * 解析记录的场景归属（以 scenes.json 为真源）。
	 *
	 * 三种情形必须能区分开，不能都退化成一个名字：
	 *   ① scene_id 命中池 → canonical 名（可能还带"已合并"提示）
	 *   ② scene_id 不在池中（池被重建/记录是 main-agent 产物）→ 明确标注，不假装知道
	 *   ③ 无 scene_id（早于场景池的存量）→ 按名字/别名反查，查不到就标"未归类"
	 */
	function resolveScene(scenes, rec) {
		var id = typeof rec.scene_id === "string" ? rec.scene_id : "";
		var rawName = normalizeSceneName(rec.scene_name);
		var out = { id: id, rawName: rawName, canonical: rawName, merged: false, known: false, note: "" };

		var follow = function (startId) {
			// 跟随 mergedInto（最多 8 跳，与 scene-pool.ts 的防环上限一致）
			var cur = startId;
			var hops = 0;
			var lastEntry = null;
			while (cur && hops < 8) {
				var e = scenes.byId.get(cur);
				if (!e) break;
				lastEntry = e;
				if (!e.mergedInto) return { entry: e, hops: hops };
				cur = e.mergedInto;
				hops++;
			}
			return { entry: lastEntry, hops: hops };
		};

		if (id) {
			if (scenes.byId.has(id)) {
				var r = follow(id);
				out.known = true;
				if (r.entry) {
					out.canonical = r.entry.name;
					if (r.hops > 0) {
						out.merged = true;
						out.note = "已合并 → " + r.entry.name + "（原始 id " + id + "）";
					}
				}
			} else {
				out.note = "scene_id 不在场景池中（" + id + "）—— 池可能被重建过";
			}
			return out;
		}

		// 无 scene_id：按名字或别名反查
		var byName = rawName ? scenes.byName.get(rawName) : null;
		if (byName) {
			var r2 = follow(byName.id);
			out.known = true;
			out.id = byName.id;
			if (r2.entry) out.canonical = r2.entry.name;
			out.note = "按名称匹配到 " + byName.id + "（记录本身无 scene_id）";
		} else {
			out.note = rawName ? "未归类（无 scene_id，名称也不在池中）" : "未归类（无场景信息）";
		}
		return out;
	}

	/**
	 * 场景筛选/分组用的桶名。
	 *
	 * 已知（池中）与未知必须落在**不同的桶**里：把不在池中的历史 scene_name 与池里的 canonical
	 * 名混在一个下拉里，读者会以为它们是同一层级的可信分组 —— 而记录里的名字只是落盘快照。
	 */
	function sceneBucket(r) {
		if (r.scene.known && r.scene.canonical) return r.scene.canonical;
		if (r.scene.canonical) return "未归类：" + r.scene.canonical;
		return "(无场景)";
	}

	// ── 页面 ────────────────────────────────────────────────────────────────

	var PAGE = {
		mixins: [V.vue.pageMixin],
		data: function () {
			return {
				// —— 数据 ——
				/** 已加质量分与场景/项目解析的记录（加载时算一次，避免每次筛选重算） */
				rows: [],
				/** 原始分片清单（侧栏"来源分片"） */
				files: [],
				/** 命中统计：recordId → 归一后的驼峰对象 */
				hitMap: new Map(),
				/** 活跃会话日时间戳（侧车提供；无则 quality 退化为日历天） */
				activeDays: null,
				/** 时钟来源："bridge"（权威）| "sidecar"（侧车，可能滞后）| "none" */
				clockSource: "",
				sidecarGeneratedAt: "",
				/** 本次生效的保护带阈值（priority 分布 P75，下限 60） */
				protectedPriority: 60,
				/** value-check 丢弃留痕 */
				drops: [],
				/** 场景池索引 */
				scenes: { byId: new Map(), byName: new Map() },
				/** 加载方式："bridge"（列全部分片）| "static"（逐日探测 90 天窗口，无桥时的兜底） */
				source: "",

				// —— 筛选 ——
				filters: {
					type: "",
					task: "",
					branchOpen: false,
					scene: "",
					project: "",
					quality: "",
					date: "",
					q: "",
					sort: "quality-desc",
					hideDeleted: true,
					onlyDeleted: false,
				},
				/** 「只看淘汰候选」快捷视图（任何筛选变化都会退出它，见 clearPruneView） */
				pruneOnly: false,
				/** 搜索框的**即时值**（防抖后才进 filters.q，避免每敲一个字重建列表） */
				qInput: "",

				// —— 视图 ——
				tab: "records",
				/** 分页（只影响画面；全选/导出作用的仍是筛选结果全集） */
				page: 1,
				pageSize: 60,
				pageSizes: [
					{ value: 60, label: "每页 60" },
					{ value: 120, label: "每页 120" },
					{ value: 240, label: "每页 240" },
					{ value: 0, label: "全部" },
				],
				/** 当前打开的详情记录（null = 未打开）；直接持有对象，不用下标 */
				modalRow: null,
				modalOpen: false,

				// —— 批量选择 ——
				/**
				 * 选中的**记录 id** 集合（不是下标）：下标只在"当前这一份渲染结果"里有效，
				 * 任何一次筛选/重新加载都会让同一个下标指向另一条记录。选择跨筛选保持（刻意行为）。
				 */
				selected: new Set(),
				/** 待二次确认的墓碑 id 列表（非空时渲染确认块） */
				pendingTombstone: null,
				/** 选择条的提示（写动作的结果） */
				selNote: { html: "", level: "" },

				// —— 详情弹层内的写动作 ——
				taskReason: "",
				taskBusy: false,
				fix: { content: "", evidence: "", reason: "", priority: null, force: false },
				fixVerdict: { html: "", level: "" },
				/** 预演通过后才显示「执行（写盘）」 */
				fixApplyReady: false,

				// —— 侧栏管理操作区（值全部来自 /api/*；失败时留空而不是沿用旧值：宁缺勿假）——
				ops: {
					loaded: false,
					mode: null,
					modeError: "",
					embedding: null,
					embeddingError: "",
					backups: [],
					/** 正在跑的写动作名："" | "mode" | "embedding" | "rollback" */
					busy: "",
					/** 已预演、等待执行的向量操作（"" = 无待执行） */
					embedOp: "",
					embedVerdict: null,
					embedLog: "",
					/** 重建要打字的确认串 */
					embedConfirm: "",
					/** 整库还原：所选备份目录名 + 预演输出 + 用户已键入的确认串 */
					rollbackBackup: "",
					rollbackPreview: null,
					rollbackConfirm: "",
				},

				/** 侧栏折叠组的展开状态 */
				statsOpen: [],
				helpOpen: [],

				/** 管理操作区的提示条（与页面加载提示是两处容器，与旧版一致） */
				opsNote: { html: "", level: "" },

				/** 模板里直接引用的常量（模板不该去翻 $options） */
				sorts: SORTS,
				tagBar: TAG_BAR,
			};
		},
		computed: {
			/** 存活记录（侧栏统计与质量分布都用它，与 quality.ts 口径一致） */
			alive: function () {
				return this.rows.filter(function (r) {
					return !r.deleted;
				});
			},
			/** 全部分片里的类型（按 schema 声明序，其余按字典序） */
			typeOrder: function () {
				var present = new Set(
					this.rows.map(function (r) {
						return r.type || "(无 type)";
					}),
				);
				var ordered = V.RECORD_TYPES.filter(function (t) {
					return present.has(t);
				});
				Array.from(present)
					.filter(function (t) {
						return ordered.indexOf(t) < 0;
					})
					.sort()
					.forEach(function (t) {
						ordered.push(t);
					});
				return ordered;
			},
			/** 「类型 · 任务状态」二级菜单的模型（一级 = 类型，二级 = work_task 下的状态） */
			typeMenu: function () {
				var self = this;
				var all = this.rows;
				var alive = this.alive;
				var f = this.filters;
				var aliveOf = function (pred) {
					return alive.filter(pred).length;
				};
				var totalOf = function (pred) {
					return all.filter(pred).length;
				};
				var out = [
					{ value: "", label: "全部", alive: alive.length, total: all.length, active: f.type === "", branch: false },
				];
				this.typeOrder.forEach(function (t) {
					var isTask = t === "work_task";
					var item = {
						value: t,
						label: t,
						alive: aliveOf(function (r) {
							return (r.type || "(无 type)") === t;
						}),
						total: totalOf(function (r) {
							return (r.type || "(无 type)") === t;
						}),
						active: f.type === t,
						branch: isTask,
						// work_task 行在有状态筛选时**必须显示那个状态**：二级可收起，收起后若不显示，
						// 就会出现"列表被筛过、侧栏却看不出在筛什么"
						marker: isTask && f.task ? V.TASK_STATE_LABELS[f.task] || f.task : "",
						subs: isTask
							? TASK_STATES.map(function (s) {
									return {
										value: s,
										label: V.TASK_STATE_LABELS[s],
										alive: aliveOf(function (r) {
											return r.isTask && r.taskState === s;
										}),
										total: totalOf(function (r) {
											return r.isTask && r.taskState === s;
										}),
										active: f.task === s,
									};
								})
							: [],
					};
					out.push(item);
				});
				// 非任务记录：类型轴上的补集（work_task 之外的全部）
				out.push({
					value: NON_TASK,
					label: "非任务记录",
					alive: aliveOf(function (r) {
						return !r.isTask;
					}),
					total: totalOf(function (r) {
						return !r.isTask;
					}),
					active: f.type === NON_TASK,
					branch: false,
				});
				return out;
			},
			/** 筛选 + 排序后的记录（旧版 filtered() 的等价物） */
			filteredRows: function () {
				var f = this.filters;
				var rows = this.rows;

				if (this.pruneOnly) {
					return this.sorted(
						rows.filter(function (r) {
							return !r.deleted && r.prune.eligible;
						}),
					);
				}

				if (f.onlyDeleted) {
					rows = rows.filter(function (r) {
						return !!r.deleted;
					});
				} else if (f.hideDeleted) {
					rows = rows.filter(function (r) {
						return !r.deleted;
					});
				}

				// 类型 / 任务状态是同一棵菜单的两级：状态只在 work_task 下可选（由菜单点击保证）
				if (f.type === NON_TASK) {
					rows = rows.filter(function (r) {
						return !r.isTask;
					});
				} else if (f.type) {
					rows = rows.filter(function (r) {
						return (r.type || "(无 type)") === f.type;
					});
				}
				if (f.task) {
					rows = rows.filter(function (r) {
						return r.isTask && r.taskState === f.task;
					});
				}
				if (f.scene) {
					rows = rows.filter(function (r) {
						return sceneBucket(r) === f.scene;
					});
				}
				if (f.project) {
					rows = rows.filter(function (r) {
						return (r.project ? V.projectShort(r.project) : "(无项目)") === f.project;
					});
				}
				if (f.quality) {
					rows = rows.filter(function (r) {
						return r.q.tag === f.quality;
					});
				}
				if (f.date) {
					rows = rows.filter(function (r) {
						return String(r.createdAt || r.updatedAt || "").slice(0, 10) === f.date;
					});
				}
				if (f.q) {
					var needle = f.q.toLowerCase();
					rows = rows.filter(function (r) {
						var hay = [
							r.id,
							r.content,
							r.type,
							r.scene.canonical,
							r.scene.rawName,
							r.project,
							r.scope,
							r.cwd,
							r.sessionKey,
							JSON.stringify(r.metadata || {}),
						]
							.join("\n")
							.toLowerCase();
						return hay.indexOf(needle) >= 0;
					});
				}
				return this.sorted(rows);
			},
			/** 当前页要渲染的记录（pageSize = 0 表示全部） */
			pageRows: function () {
				if (!this.pageSize) return this.filteredRows;
				var start = (this.page - 1) * this.pageSize;
				return this.filteredRows.slice(start, start + this.pageSize);
			},
			/** 结果计数（旧版 #resultMeta 的等价物） */
			resultMeta: function () {
				if (this.pruneOnly) {
					return "淘汰候选 " + this.filteredRows.length + " 条（judgePrune 判定可删）—— 改筛选条件可退出此视图";
				}
				var n = this.filteredRows.length;
				var tail = this.pageSize && n > this.pageSize ? "，当前第 " + this.page + " 页（每页 " + this.pageSize + "）" : "";
				return "显示 " + n + " / " + this.rows.length + " 条（类型 + 任务状态 + 场景 + 项目 + 质量 + 日期 联合筛选）" + tail;
			},
			/** 侧栏概览的 8 行 */
			statRows: function () {
				var all = this.rows;
				var alive = this.alive;
				var types = new Set(
					all.map(function (r) {
						return r.type || "(无 type)";
					}),
				);
				return [
					{ label: "总条数（LWW 后）", value: all.length },
					{ label: "存活", value: alive.length },
					{ label: "已删除", value: all.length - alive.length },
					{ label: "类型数", value: types.size },
					{
						label: "淘汰候选",
						value: alive.filter(function (r) {
							return r.prune.eligible;
						}).length,
					},
					{ label: "命中统计条目", value: this.hitMap.size },
					{ label: "场景池", value: this.scenes.byId.size },
					{ label: "丢弃留痕", value: this.drops.length },
				];
			},
			/** 质量标签分布（条形图行） */
			qualityBars: function () {
				var alive = this.alive;
				var dist = {};
				QUALITY_TAGS.forEach(function (t) {
					dist[t] = 0;
				});
				alive.forEach(function (r) {
					dist[r.q.tag] = (dist[r.q.tag] || 0) + 1;
				});
				var max = Math.max.apply(
					null,
					QUALITY_TAGS.map(function (k) {
						return dist[k];
					}).concat([1]),
				);
				return QUALITY_TAGS.map(function (k) {
					return { label: k, count: dist[k], cls: TAG_BAR[k], pct: Math.round((dist[k] / max) * 100) };
				});
			},
			/** 质量分直方图（0-2 / 2-4 / 4-6 / 6+） */
			histCols: function () {
				var alive = this.alive;
				var bins = { "0-2": 0, "2-4": 0, "4-6": 0, "6+": 0 };
				alive.forEach(function (r) {
					var q = r.q.quality;
					if (q >= 0 && q < 2) bins["0-2"]++;
					else if (q < 4) bins["2-4"]++;
					else if (q < 6) bins["4-6"]++;
					else bins["6+"]++;
				});
				var max = Math.max.apply(
					null,
					Object.keys(bins).map(function (k) {
						return bins[k];
					}).concat([1]),
				);
				return Object.keys(bins).map(function (k) {
					return { label: k, count: bins[k], pct: Math.round((bins[k] / max) * 100) };
				});
			},
			/** 淘汰候选说明（judgePrune 的两个理由各自多少条） */
			pruneNote: function () {
				var alive = this.alive;
				if (!alive.length) return "无存活记录";
				var eligible = alive.filter(function (r) {
					return r.prune.eligible;
				});
				var falsified = eligible.filter(function (r) {
					return r.prune.reason === "falsified";
				}).length;
				var idle = eligible.filter(function (r) {
					return r.prune.reason === "idle-low-value";
				}).length;
				return (
					"候选 <b>" + eligible.length + "</b> / 存活 " + alive.length +
					"（保护带 priority ≥ " + this.protectedPriority + "，按分布 P" + VQ.PRUNE_RULES.protectedPercentile + " 取）<br>" +
					"被真实证伪 <b>" + falsified + "</b>；长期闲置且低价值 <b>" + idle + "</b>"
				);
			},
			/** 时钟与保护带的出处（放默认收起的统计组：它是健康信息，不是每次都要读） */
			sourceNote: function () {
				var clock =
					this.clockSource === "bridge"
						? "活跃会话日 " + (this.activeDays ? this.activeDays.length : 0) + " 个（源：l0/conversations，权威）"
						: this.clockSource === "sidecar"
							? "活跃会话日 " + (this.activeDays ? this.activeDays.length : 0) + " 个（源：hit-stats.json 侧车，可能滞后于 l0）"
							: "日历天（拿不到活跃日数据，已退化）";
				return "时钟：" + clock + "<br>保护带阈值 P" + VQ.PRUNE_RULES.protectedPercentile + " = " + this.protectedPriority;
			},
			/** 场景下拉（取前 40 项避免侧栏被撑爆；池中 canonical 与"未归类"分开列） */
			sceneOptions: function () {
				var counts = V.groupCount(this.alive, sceneBucket);
				var unclassified = counts
					.filter(function (c) {
						return c.key.indexOf("未归类") === 0;
					})
					.reduce(function (n, c) {
						return n + c.count;
					}, 0);
				return {
					items: counts.slice(0, 40),
					label: "全部场景（" + counts.length + " 个分组）",
					known: counts.filter(function (c) {
						return c.key.indexOf("未归类") !== 0 && c.key !== "(无场景)";
					}).length,
					unclassified: unclassified,
				};
			},
			projectOptions: function () {
				var counts = V.groupCount(this.alive, function (r) {
					return r.project ? V.projectShort(r.project) : "(无项目)";
				});
				return { items: counts.slice(0, 40), label: "全部项目（" + counts.length + "）" };
			},
			/** 日期下拉（全部记录，含已删除 —— 与旧版口径一致） */
			dateOptions: function () {
				return V.groupCount(this.rows, function (r) {
					return String(r.createdAt || r.updatedAt || "(无日期)").slice(0, 10);
				});
			},
			/** 来源分片摘要（只显示最后 12 个 + 总数） */
			fileSummary: function () {
				if (!this.files.length) return "";
				return this.files.slice(-12).join("、") + (this.files.length > 12 ? " …（共 " + this.files.length + " 个）" : "");
			},
			/** 勾选中的记录（选中 id 可能已不在当前加载的数据里，所以按 rows 过滤） */
			selectedRows: function () {
				var sel = this.selected;
				return this.rows.filter(function (r) {
					return sel.has(r.id);
				});
			},
			/** 丢弃留痕的筛选结果 */
			dropRows: function () {
				var q = (this.filters.q || "").toLowerCase();
				var scenes = this.scenes;
				return this.drops
					.filter(function (d) {
						if (!q) return true;
						var rec = d.record || {};
						return [d.reason, d.action, rec.content, rec.type, rec.id, d.id].join("\n").toLowerCase().indexOf(q) >= 0;
					})
					.map(function (d) {
						var rec = d.record || {};
						var scene = rec.scene_id
							? (scenes.byId.get(rec.scene_id) || {}).name || rec.scene_id || rec.scene_name
							: rec.scene_name || "—";
						return {
							at: V.fmtTime(d.at),
							action: d.action || "",
							id: rec.id || d.id || "—",
							type: rec.type || "—",
							priority: rec.priority === undefined ? "—" : rec.priority,
							scene: scene || "—",
							reason: d.reason || "",
							body:
								rec.content ||
								(d.action === "revoke-tombstone" ? "（撤销墓碑：" + (d.id || "") + " → " + (d.replacedBy || "") + "）" : ""),
						};
					});
			},
			dropMeta: function () {
				return (
					"显示 " + this.dropRows.length + " / " + this.drops.length +
					" 条（value-check 判 drop 的记录从不写进库，这里是它们唯一的留痕）"
				);
			},
			modeOptions: function () {
				return [
					{ value: "code", label: "code", disabled: !this.hasPort() },
					{ value: "chat", label: "chat", disabled: !this.hasPort() },
				];
			},
			modeTitle: function () {
				var o = this.ops;
				return (
					"切换 l1.mode（code / chat）。当前：" + (o.mode || (o.loaded ? "未知" : "读取中…")) +
					"。真源 /api/limits.l1.mode；改的是 application-propertis.json 的 l1.mode，立即写盘、可逆、幂等，影响下一轮提取取向。" +
					(o.modeError ? "（读取失败：" + o.modeError + "）" : "")
				);
			},
			embedTitle: function () {
				return (
					"回填只补缺失向量；重建会先清空向量库再全量重算（中途失败 = 库空，需打字确认）。" +
					"两者都是长任务：桥单线程同步执行，跑起来后整座桥都不响应。"
				);
			},
			/** 备份下拉项：时间与分片数放最前（闭合时下拉框很窄，5 个 backfill-* 只看目录名分不开） */
			backupOptions: function () {
				var o = this.ops;
				return o.backups
					.slice()
					.reverse()
					.map(function (b) {
						return {
							value: b.dir,
							label: V.fmtTime(b.mtime) + " · " + b.shards + " 分片 / " + fmtBytes(b.bytes) + " · " + b.dir,
						};
					});
			},
			/** 当前选中的备份目录（选择被清空时退回最新的一份） */
			chosenBackup: function () {
				var o = this.ops;
				var bk = o.backups || [];
				var exists =
					o.rollbackBackup &&
					bk.some(function (b) {
						return b.dir === o.rollbackBackup;
					});
				if (exists) return o.rollbackBackup;
				return bk.length ? bk[bk.length - 1].dir : "";
			},
			/** 还原按钮的可用性 = 输入的目录名与所选备份**逐字相等**（与桥的 confirm 副验同口径） */
			rollbackReady: function () {
				return !!this.hasPort() && !!this.chosenBackup && this.ops.rollbackConfirm.trim() === this.chosenBackup;
			},
			/** 重建的「确认执行」要等用户键入 REBUILD；回填无需打字 */
			embedReady: function () {
				if (!this.hasPort()) return false;
				if (this.ops.embedOp !== "rebuild") return true;
				return this.ops.embedConfirm.trim() === "REBUILD";
			},
			/** 当前结果集里的最高质量分（温度条按它归一，O(1) 供每张卡片取用） */
			maxQuality: function () {
				return Math.max.apply(
					null,
					this.filteredRows.map(function (r) {
						return r.q.quality;
					}).concat([1]),
				);
			},
			modalTitle: function () {
				return this.modalRow ? this.modalRow.type || "unknown" : "";
			},
			/** 弹层里的命中统计（"注入/工具"只在有值时出现） */
			modalHitStat: function () {
				return this.modalRow ? this.hitMap.get(this.modalRow.id) || null : null;
			},
		},
		mounted: function () {
			this.autoLoad();
			// 管理操作区独立于记录加载：即便分片读失败，提取模式 / 向量库 / 还原这些信息仍应可见
			this.loadOps();
		},
		methods: {
			// ── 工具 ────────────────────────────────────────────────────────
			fmtQ: fmtQ,
			fmtBytes: fmtBytes,
			projectShort: function (p) {
				return V.projectShort(p);
			},
			qualClass: function (tag) {
				return V.QUALITY_CLASS[tag] || "";
			},
			taskLabel: function (s) {
				return V.TASK_STATE_LABELS[s] || s;
			},
			pruneLabel: function (reason) {
				return VQ.PRUNE_REASON_LABELS[reason] || reason;
			},
			sceneBucket: sceneBucket,
			/** 记录里的场景胶囊：已知（池中）与未知必须**看起来不同** */
			sceneChip: function (r) {
				if (r.scene.known && r.scene.canonical) {
					return {
						text: r.scene.canonical + (r.scene.merged ? " 已合并" : ""),
						kind: "scene" + (r.scene.merged ? " merged" : ""),
						tip: r.scene.note || "scene_id " + r.scene.id,
					};
				}
				if (r.scene.canonical) {
					return {
						text: r.scene.canonical + "（未归类）",
						kind: "scene unclassified",
						tip: "这是历史快照里的原始 scene_name，不在 l1/scenes.json 池中 —— " + (r.scene.note || ""),
					};
				}
				return { text: "未归类", kind: "scene unclassified", tip: r.scene.note || "无场景信息" };
			},
			/** 卡片温度条宽度（按当前结果集里的最高分归一；maxQuality 是 computed，不会退化成 O(n²)） */
			barPct: function (r) {
				return Math.min(100, Math.round((r.q.quality / this.maxQuality) * 100));
			},

			/**
			 * 排序（旧版 filtered() 末尾的那段 sort，取值与顺序判定一字不差）。
			 * @param rows 待排序数组（不修改入参）
			 */
			sorted: function (rows) {
				var s = this.filters.sort;
				return rows.slice().sort(function (a, b) {
					if (s === "quality-desc") return b.q.quality - a.q.quality;
					if (s === "quality-asc") return a.q.quality - b.q.quality;
					if (s === "updated-desc") return V.ts(b.updatedAt || b.createdAt) - V.ts(a.updatedAt || a.createdAt);
					if (s === "updated-asc") return V.ts(a.updatedAt || a.createdAt) - V.ts(b.updatedAt || b.createdAt);
					if (s === "prio-desc") return (b.priority || 0) - (a.priority || 0);
					if (s === "prio-asc") return (a.priority || 0) - (b.priority || 0);
					if (s === "type") return String(a.type).localeCompare(String(b.type)) || b.q.quality - a.q.quality;
					return 0;
				});
			},

			/** 任何筛选变化都要退出「只看淘汰候选」视图（旧版靠"再次 renderAll 就从 filtered() 取数"实现） */
			clearPruneView: function () {
				this.pruneOnly = false;
			},
			onFilterChange: function () {
				this.clearPruneView();
				this.page = 1;
			},
			/** 搜索：敲键只更新 qInput，防抖后才进 filters.q（旧版同款 180ms） */
			onSearchInput: V.debounce(function () {
				this.filters.q = this.qInput.trim();
				this.onFilterChange();
			}, 180),
			/** 只看淘汰候选（侧栏快捷入口）：一次性视图，改筛选即退出 */
			showPruneOnly: function () {
				this.filters.hideDeleted = true;
				this.filters.onlyDeleted = false;
				this.filters.q = "";
				this.qInput = "";
				this.pruneOnly = true;
				this.page = 1;
			},
			pickType: function (value) {
				this.filters.type = value;
				// 离开 work_task 就清掉状态：留着会让行上显示"work_task · 待办"而列表按别的类型筛
				this.filters.task = value === "work_task" ? this.filters.task : "";
				// 点 work_task 把二级摊开：让人当场看见它下面还有什么可选
				if (value === "work_task") this.filters.branchOpen = true;
				this.onFilterChange();
			},
			pickTask: function (value) {
				// 选状态 = 选 work_task 的那个状态：两级同属一个维度，不该要求先点一次类型
				this.filters.type = "work_task";
				this.filters.task = value;
				this.filters.branchOpen = true;
				this.onFilterChange();
			},
			toggleBranch: function () {
				// 展开把手：只切换二级的显隐，**不动筛选**（"只想看一眼有哪些状态"不该换掉当前视图）
				this.filters.branchOpen = !this.filters.branchOpen;
			},
			/** 两个"隐藏/仅看已删除"互斥（旧版在各自的 change 里对拆） */
			onHideDeleted: function (v) {
				this.filters.hideDeleted = v;
				if (v) this.filters.onlyDeleted = false;
				this.onFilterChange();
			},
			onOnlyDeleted: function (v) {
				this.filters.onlyDeleted = v;
				if (v) this.filters.hideDeleted = false;
				this.onFilterChange();
			},

			// ── 加载 ────────────────────────────────────────────────────────
			/**
			 * 活跃会话日：**优先问写盘桥**（读 `l0/conversations/` 真源），侧车只作离线回退。
			 *
			 * 为什么不能只用侧车（2026-10-08 实测）：`hit-stats.json` 的 `activeDays` 只在命中统计库
			 * 被打开/写入时才刷新，无召回发生就不重写。实测侧车 29 天、实际 30 天，`days` 差 1 →
			 * 3 条记录从「冷」错标成「待观察」、整个质量分直方图偏一格。公式没错（parity 门禁全绿），
			 * 错的是喂进去的输入 —— 所以输入要取权威来源。
			 */
			loadActiveDays: function () {
				var self = this;
				var fromKeys = function (keys) {
					return keys
						.map(function (k) {
							return new Date(k + "T00:00:00").getTime();
						})
						.filter(function (t) {
							return !Number.isNaN(t);
						})
						.sort(function (a, b) {
							return a - b;
						});
				};
				return V.bridge(EP.activeDays).then(function (r) {
					if (r.ok && r.data && r.data.available && Array.isArray(r.data.activeDays) && r.data.activeDays.length > 0) {
						self.activeDays = fromKeys(r.data.activeDays);
						return "bridge";
					}
					// 桥不可用（或 l0 不存在）→ 回退侧车
					return V.loadJson("../l1/hit-stats.json").then(function (payload) {
						var days = payload && !Array.isArray(payload) && Array.isArray(payload.activeDays) ? payload.activeDays : null;
						if (days && days.length > 0) {
							self.activeDays = fromKeys(days);
							return "sidecar";
						}
						self.activeDays = null;
						return "none";
					});
				});
			},

			/**
			 * 读命中统计侧车（兼容 `{generatedAt, activeDays, stats}` 与旧的裸数组两种形态）。
			 * 这里**只取 stats**，activeDays 由 loadActiveDays 单独负责（它优先走桥）。
			 */
			loadHitStats: function () {
				var self = this;
				return V.loadJson("../l1/hit-stats.json").then(function (payload) {
					var arr = [];
					if (Array.isArray(payload)) arr = payload;
					else if (payload && Array.isArray(payload.stats)) arr = payload.stats;
					else return;
					var map = new Map();
					for (var i = 0; i < arr.length; i++) {
						var st = VQ.normalizeStat(arr[i]);
						if (st && st.recordId) map.set(st.recordId, st);
					}
					self.hitMap = map;
					self.sidecarGeneratedAt = payload && typeof payload.generatedAt === "string" ? payload.generatedAt : "";
				});
			},

			/** 读场景池，建 id 与 名称/别名 两套索引 */
			loadScenes: function () {
				var self = this;
				return V.loadJson("../l1/scenes.json").then(function (payload) {
					self.scenes = buildSceneIndex(payload);
				});
			},

			/** 读 value-check 丢弃留痕 */
			loadDropLog: function () {
				var self = this;
				return V.loadJsonl("../l1/value-check-log.jsonl").then(function (rows) {
					self.drops = rows;
				});
			},

			/**
			 * 取记录分片清单。
			 *
			 * 有写盘桥时走 `/api/l1/shards`（服务端能列目录 → **全部分片**）；否则退化为最近 N 天的
			 * 逐日探测（`file://` 与纯静态 http 下浏览器列不了目录）。旧版固定 60 天，会悄悄漏掉更早的
			 * 存量（实测 24 个分片里最早的在窗口之外）。
			 */
			listShardDates: function () {
				var self = this;
				return V.bridge(EP.shards).then(function (r) {
					if (r.ok && r.data && Array.isArray(r.data.shards) && r.data.shards.length > 0) {
						self.source = "bridge";
						return r.data.shards.map(function (s) {
							return { file: s.file, rows: s.rows };
						});
					}
					self.source = "static";
					var out = [];
					var windowDays = 90;
					for (var i = 0; i < windowDays; i++) {
						var d = new Date(Date.now() - i * 86400000);
						out.push({ file: d.toISOString().slice(0, 10) + ".jsonl", rows: null });
					}
					return out;
				});
			},

			/** 加载全部记录分片（逐个 fetch，失败的静默跳过并计数） */
			loadRecords: function () {
				var self = this;
				return this.listShardDates().then(function (shards) {
					var tasks = shards.map(function (s) {
						return V.loadText("../l1/records/" + s.file).then(function (txt) {
							if (txt === null) return null;
							return { file: s.file, rows: V.parseJsonl(txt, s.file) };
						});
					});
					return Promise.all(tasks).then(function (results) {
						var records = [];
						var files = [];
						for (var i = 0; i < results.length; i++) {
							var r = results[i];
							if (!r) continue;
							records = records.concat(r.rows);
							files.push(r.file + " (" + r.rows.length + ")");
						}
						self.files = files;
						return records;
					});
				});
			},

			/** 给一批原始记录加质量分、场景解析、项目与 LWW 去重 */
			enrichAll: function (records) {
				var self = this;
				// LWW：同一 id 取追加序最后一行（分片升序 + 行序）—— 与 record-loader.ts 同口径。
				// 分片是按日期倒序取的，所以要反着遍历才是"追加序"。
				var lastById = new Map();
				for (var i = records.length - 1; i >= 0; i--) {
					var rec = records[i];
					if (rec && typeof rec.id === "string") lastById.set(rec.id, rec);
				}
				var list = Array.from(lastById.values());

				var rows = list.map(function (rec) {
					var st = self.hitMap.get(rec.id);
					var q = VQ.calcQuality(rec, st, Date.now(), self.activeDays || undefined);
					return Object.assign({}, rec, {
						q: q,
						scene: resolveScene(self.scenes, rec),
						project: projectOf(rec),
						scope: scopeOf(rec),
						audit: auditOf(rec),
						taskState: taskStateOf(rec),
						isTask: rec.type === "work_task",
					});
				});

				// 保护带阈值按**存活记录**的 priority 分布算（与 getQualityStats 同口径）
				var alive = rows.filter(function (r) {
					return !r.deleted;
				});
				this.protectedPriority = VQ.protectedPriorityOf(alive);
				for (var j = 0; j < rows.length; j++) {
					rows[j].prune = VQ.judgePrune(rows[j], rows[j].q, this.protectedPriority);
				}
				return rows;
			},

			/** 一次加载：时钟 → 侧车/场景池/丢弃留痕 → 分片 → 富化。顺序不能反（quality 依赖 activeDays） */
			autoLoad: function () {
				var self = this;
				this.setNote("加载中…");
				return this.loadActiveDays()
					.then(function (clockSource) {
						self.clockSource = clockSource;
						return Promise.all([self.loadHitStats(), self.loadScenes(), self.loadDropLog()]);
					})
					.then(function () {
						return self.loadRecords();
					})
					.then(function (records) {
						self.rows = self.enrichAll(records);
						self.page = 1;
						var srcLabel =
							self.source === "bridge" ? "写盘桥（全部分片）" : "静态探测（最近 90 天；更早的分片需要写盘桥）";
						// 页头只报**别处没有的**：总/存活/已删除、场景池、丢弃留痕都在侧栏【统计】组里，
						// 「显示 X / Y」由结果计数行负责（它还会跟着筛选变）。
						self.setNote("来自 <b>" + self.files.length + "</b> 个分片 · 来源：" + srcLabel);
						return true;
					})
					.catch(function (e) {
						self.source = self.source || "static";
						self.setNote(
							"自动加载失败：" + V.escapeHtml(e && e.message ? e.message : String(e)) +
								"。请确认地址带了 <code>?port=</code> 且写盘桥在运行（<code>npm run viewer</code> 可一键起桥）。",
							"warn",
						);
						return false;
					});
			},

			/** 清空（只清内存，不动盘） */
			clearAll: function () {
				this.rows = [];
				this.files = [];
				this.drops = [];
				this.source = "";
				this.selected = new Set();
				this.pendingTombstone = null;
				this.setNote("已清空。点「重新加载」取回数据。");
			},

			/** 导出当前视图（筛选结果**全集**，不是当前页） */
			exportView: function () {
				V.download(
					"l1-records-" + new Date().toISOString().slice(0, 10) + ".json",
					JSON.stringify(this.filteredRows, null, 2),
				);
			},

			/** 跳到流水线页（说明里那句指引的链接）：**必须带 location.search**，丢了 ?port= 就变只读 */
			gotoPipeline: function () {
				location.href = "pipeline-viewer.html" + location.search;
			},

			// ── 批量选择 ────────────────────────────────────────────────────
			/** 勾选/取消一条（on = 目标状态，不读 DOM，避免与重画竞争） */
			toggleSelected: function (id, on) {
				if (!id) return;
				if (on) this.selected.add(id);
				else this.selected.delete(id);
				// Set 的增删在 Vue 3 里是响应式的，但为了触发依赖 Set.size 的 computed，这里重建一次
				this.selected = new Set(this.selected);
				if (this.selected.size === 0) {
					// 没有选中就没有可删的东西：把待确认的墓碑一并作废，免得留下一条"幽灵确认"
					this.pendingTombstone = null;
				}
			},
			selectAllFiltered: function () {
				var sel = new Set(this.selected);
				this.filteredRows.forEach(function (r) {
					if (r.id) sel.add(r.id);
				});
				this.selected = sel;
			},
			clearSelection: function () {
				this.selected = new Set();
				this.pendingTombstone = null;
				this.selNote = { html: "", level: "" };
			},
			/** 导出选中：导出的是选中记录本身（不是当前筛选），与"导出当前视图"是两件事 */
			exportSelected: function () {
				var rows = this.selectedRows;
				if (rows.length === 0) {
					this.selNote = {
						html: "没有可导出的选中记录（选中的 id 可能已不在当前加载的数据里）。",
						level: "warn",
					};
					return;
				}
				V.download("l1-selected-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(rows, null, 2));
			},

			/**
			 * 批量标记任务状态：**一次请求**带上全部选中 id（task-state 端点本就接受 ids 数组）。
			 *
			 * 只有 work_task 承载任务状态，选中的非任务记录会被 CLI 逐条判错 —— 所以这里如实报
			 * "成功/失败"两个数，而不是把整批当成功。
			 */
			applyTaskStateBatch: function (target) {
				var self = this;
				var ids = Array.from(this.selected);
				if (ids.length === 0 || !this.hasPort()) return;
				this.selNote = { html: "正在标记 " + ids.length + " 条为「" + V.escapeHtml(V.TASK_STATE_LABELS[target]) + "」…", level: "" };
				V.bridge(EP.taskState, { method: "POST", body: JSON.stringify({ ids: ids, state: target }) }).then(function (r) {
					var d = r.data || {};
					if (d.error) {
						self.selNote = { html: "批量标记失败：" + V.escapeHtml(String(d.error)), level: "err" };
						return;
					}
					if (!r.ok && d.results === undefined) {
						self.selNote = { html: "批量标记失败：HTTP " + r.status, level: "err" };
						return;
					}
					var changed = d.changed === undefined ? ids.length - (d.failed || 0) : d.changed;
					var failed = d.failed || 0;
					// 就地同步本地状态（服务端只改状态字段），不为一次标记重载全部分片
					self.rows.forEach(function (row) {
						if (!self.selected.has(row.id) || !row.isTask) return;
						row.taskState = target;
						row.audit.taskStateChange = { from: "", to: target, at: new Date().toISOString(), by: "user" };
					});
					self.selNote = {
						html:
							"已标记 <b>" + changed + "</b> 条为「" + V.escapeHtml(V.TASK_STATE_LABELS[target]) + "」" +
							(failed > 0 ? "，<b>" + failed + "</b> 条失败（只有 work_task 承载任务状态）" : "") + "。",
						level: failed > 0 ? "warn" : "",
					};
				});
			},

			/** 批量墓碑（删除）：真正写盘的入口，只在确认块上点「确认删除」后到达 */
			applyTombstoneBatch: function (ids) {
				var self = this;
				if (!ids || ids.length === 0 || !this.hasPort()) return;
				this.selNote = { html: "正在删除 " + ids.length + " 条…", level: "" };
				V.bridge(EP.tombstone, { method: "POST", body: JSON.stringify({ ids: ids }) }).then(function (r) {
					if (!r.ok || !r.data || r.data.success === false) {
						self.selNote = {
							html: "批量删除失败：" + V.escapeHtml(String((r.data && r.data.error) || "未知错误")),
							level: "err",
						};
						return;
					}
					ids.forEach(function (id) {
						self.rows.forEach(function (row) {
							if (row.id === id) row.deleted = true;
						});
					});
					self.selected = new Set();
					self.pendingTombstone = null;
					self.selNote = { html: "已就地标记 deleted:true（自动备份已生成，可用危险区的整库还原回退）。", level: "" };
				});
			},

			// ── 详情弹层 ────────────────────────────────────────────────────
			openModal: function (r) {
				this.modalRow = r;
				this.taskReason = "";
				this.taskBusy = false;
				this.fix = {
					content: r.content || "",
					evidence: "",
					reason: "",
					priority: null,
					force: false,
				};
				this.fixVerdict = { html: "", level: "" };
				this.fixApplyReady = false;
				this.modalOpen = true;
			},
			closeModal: function () {
				this.modalOpen = false;
				this.modalRow = null;
				this.fixApplyReady = false;
			},

			/**
			 * 任务状态：**换值即写**（`l1_task_state` 同一实现：就地改写 + 写锁 +
			 * `metadata.taskStateChange` 审计）。值没变就不写（下拉在某些浏览器上会派发 change）。
			 */
			onTaskStateChange: function (target) {
				var self = this;
				var row = this.modalRow;
				if (!row || !this.hasPort()) return;
				if (target === row.taskState) return;
				this.taskBusy = true;
				this.applyTaskState(row, target, this.taskReason.trim()).then(function () {
					// 成功时 applyTaskState 已把 row.taskState 改掉并关了弹层；这里只处理失败：
					// 把下拉拨回真实值，免得控件显示的状态和盘上的不一致。
					self.taskBusy = false;
				});
			},

			/** 真实写盘：任务状态切换（单条） */
			applyTaskState: function (row, target, reason) {
				var self = this;
				this.setNote("正在标记…");
				return V.bridge(EP.taskState, {
					method: "POST",
					body: JSON.stringify({ ids: [row.id], state: target, reason: reason || undefined }),
				}).then(function (r) {
					if (!r.ok || !r.data || r.data.success === false) {
						var err =
							(r.data && (r.data.error || (r.data.results && r.data.results[0] && r.data.results[0].error))) || "未知错误";
						self.setNote("标记失败：" + V.escapeHtml(String(err)), "err");
						return;
					}
					// 就地改写 → 本地同步（真实落盘已由 CLI 完成，这里只是让页面立刻反映）
					row.taskState = target;
					row.audit.taskStateChange = {
						from: (r.data.results && r.data.results[0] && r.data.results[0].from) || "",
						to: target,
						at: new Date().toISOString(),
						by: "user",
						reason: reason || undefined,
					};
					self.setNote("已标记为「" + V.TASK_STATE_LABELS[target] + "」（就地改写 + 写锁，审计写入 metadata.taskStateChange）");
					self.closeModal();
				});
			},

			/** 详情页脚「删除（墓碑）」：真实删除走既有 tombstone CLI */
			onTombstoneClick: function () {
				var self = this;
				var row = this.modalRow;
				if (!row) return;
				if (!this.hasPort()) {
					// 只读模式：说清为什么删不掉，并给出"只在本页预览标记"的选项（刷新即恢复）
					return V.vue
						.confirm(
							"未带 ?port=，无法真实删除。\n\n请先运行：node scripts/l1-admin/viewer-bridge.mjs\n再以 ?port= 打开本页。\n\n现在仅在本页预览标记（刷新即恢复）？",
							"无法真实删除",
						)
						.then(function (ok) {
							if (!ok) return null;
							row.deleted = true;
							self.closeModal();
							return null;
						});
				}
				return V.vue
					.confirm("确定真实删除（就地标记 deleted:true）？\nID: " + row.id + "\n\n会自动备份，可用 rollback 还原。", "删除（墓碑）")
					.then(function (ok) {
						if (!ok) return null;
						self.setNote("正在删除…");
						return V.bridge(EP.tombstone, { method: "POST", body: JSON.stringify({ ids: [row.id] }) }).then(function (r) {
							if (!r.ok || !r.data || !r.data.success) {
								self.setNote("删除失败：" + V.escapeHtml(String((r.data && r.data.error) || "未知错误")), "err");
								return;
							}
							row.deleted = true;
							self.setNote("已就地标记 deleted:true（自动备份已生成，可用 rollback 还原）");
							self.closeModal();
						});
					});
			},

			// ── l1_fix（改写正文）────────────────────────────────────────────
			/**
			 * 组装 l1_fix 的请求体（预演与执行的差别只有 apply:true，其余字段必须逐字段一致）。
			 * 动作恒为 rewrite：面板只做改写（tombstone 收归页脚「删除（墓碑）」那条无闸路径）。
			 */
			fixBody: function (apply) {
				var f = this.fix;
				var body = {
					id: this.modalRow ? this.modalRow.id : "",
					action: "rewrite",
					content: f.content,
					evidence: (f.evidence || "").trim(),
				};
				var reason = (f.reason || "").trim();
				if (apply) body.apply = true;
				if (reason) body.reason = reason;
				if (f.priority !== null && f.priority !== undefined && f.priority !== "" && Number.isFinite(Number(f.priority))) {
					body.priority = Number(f.priority);
				}
				if (f.force) body.force = true;
				return body;
			},

			/**
			 * l1_fix 的**预演**：不写盘，只报四道闸的裁决。
			 *
			 * 为什么预演真的有意义：`runFix` 内部恒定向 rewrite 传 `--apply`，本身没有干跑路径；
			 * 桥的 dry-run 走 `checkFixGates`（与实写同一份裁决）。预演覆盖正文长度/证据/存活/防抖/
			 * 高价值，但**不含 IO 级校验**（分片写得进写不进只有实写时才知道），界面上不当成保证。
			 */
			previewFix: function () {
				var self = this;
				if (!this.hasPort()) return;
				this.fixApplyReady = false;
				this.fixVerdict = { html: "预演中…", level: "" };
				V.bridge(EP.fix, { method: "POST", body: JSON.stringify(this.fixBody(false)) }).then(function (r) {
					var d = r.data || {};
					if (!r.ok || d.success === false) {
						self.fixVerdict = { html: "预演被拒：" + V.escapeHtml(String(d.error || "未知错误")), level: "err" };
						return;
					}
					self.fixVerdict = {
						html:
							"预演通过（dry-run，未写盘）：四道闸放行。" + (d.note ? "<br>" + V.escapeHtml(String(d.note)) : "") +
							"<br>注意：执行时审计标注会<b>追加进正文本身</b>。" +
							'<br><span class="hint">dry-run 不含 IO 级校验（分片能否写入只有实写时才知道）。</span>',
						level: "",
					};
					self.fixApplyReady = true;
				});
			},

			/** l1_fix 的**执行**：与预演同一份表单值，额外带 apply:true */
			applyFix: function () {
				var self = this;
				if (!this.hasPort()) return;
				var body = this.fixBody(true);
				this.fixApplyReady = false;
				this.fixVerdict = { html: "执行中…", level: "" };
				V.bridge(EP.fix, { method: "POST", body: JSON.stringify(body) }).then(function (r) {
					var d = r.data || {};
					if (!r.ok || d.success === false) {
						self.fixVerdict = { html: "执行失败：" + V.escapeHtml(String(d.error || "未知错误")), level: "err" };
						self.fixApplyReady = true;
						return;
					}
					// 正文被服务端就地改写（含追加的审计标注），本地那份内容已不可信 —— 重读取回真身
					self.closeModal();
					self.setNote(
						"纠错已写入（" + V.escapeHtml(body.action) + "）：" + V.escapeHtml(String(d.detail || "").slice(0, 200)) +
							"<br>正文由服务端改写，页面重新加载以取回真实内容。",
					);
					self.autoLoad();
				});
			},

			// ── 侧栏管理操作区 ──────────────────────────────────────────────
			/**
			 * 读管理操作区要用的全部只读状态。
			 * 无桥时**不发请求**（桥根本不存在），直接把面板渲染成禁用态 —— 与页面顶部提示条同一口径。
			 */
			loadOps: function () {
				var self = this;
				var o = this.ops;
				if (!this.hasPort()) {
					o.loaded = true;
					// "管理操作区加载中…" 必须被换掉：面板其实已经渲染成禁用态了，而这句话会永远停在那儿
					// —— 一行说谎的状态提示比没有提示更糟（本项目反复踩过"静默误导"这一类）。
					this.setNote2("无写盘桥：管理动作全部禁用，只能看。带 <code>?port=</code> 打开即可用。", "warn");
					return Promise.resolve();
				}
				// 触发 / 待消费信号 / 停止子代理已搬到「流水线」页（pipeline-viewer.html），
				// 所以这里不再取 /api/pending-triggers 与 /api/subagent-runs。
				return Promise.all([V.bridge(EP.limits), V.bridge(EP.embeddings), V.bridge(EP.backups)]).then(function (r) {
					o.mode = r[0].ok && r[0].data && r[0].data.l1 && r[0].data.l1.mode ? r[0].data.l1.mode : null;
					o.modeError = o.mode ? "" : (r[0].data && r[0].data.error) || "读取失败";
					o.embedding = r[1].ok && r[1].data && r[1].data.status ? r[1].data.status : null;
					o.embeddingError = o.embedding ? "" : (r[1].data && r[1].data.error) || "读取失败";
					o.backups = r[2].ok && r[2].data && Array.isArray(r[2].data.backups) ? r[2].data.backups : [];
					o.loaded = true;
					// 顺带报出有几项没读到 —— 单项失败在面板里已有说明，这里给的是"整体是否可信"的一句话
					var failed = r.filter(function (x) {
						return !x.ok;
					}).length;
					self.setNote2(
						failed === 0
							? "写盘桥已连接：下面每个动作都注明是否落盘（标「预演」的不写，要按「确认执行」才写）。"
							: "写盘桥已连接，但有 " + failed + " 项状态没读到 —— 面板里对应格子会写出原因，别把空白当默认值。",
						failed === 0 ? "" : "warn",
					);
				});
			},
			/** 管理操作区的提示条（与页面加载提示分开两处，与旧版的两个容器一致） */
			setNote2: function (html, level) {
				this.opsNote = { html: html, level: level || "" };
			},

			/** 只重取向量库状态（回填/重建后条数会变） */
			refreshOpsEmbedding: function () {
				var self = this;
				return V.bridge(EP.embeddings).then(function (r) {
					self.ops.embedding = r.ok && r.data && r.data.status ? r.data.status : null;
					if (!self.ops.embedding) self.ops.embeddingError = (r.data && r.data.error) || "读取失败";
				});
			},

			/** 只重取备份清单（整库还原会新生成一份 pre-rollback 备份） */
			refreshOpsBackups: function () {
				var self = this;
				return V.bridge(EP.backups).then(function (r) {
					self.ops.backups = r.ok && r.data && Array.isArray(r.data.backups) ? r.data.backups : [];
				});
			},

			/** 切换 L1 提取模式（唯一无预演的写动作：可逆、幂等，CLI 自己读写确认） */
			setL1Mode: function (mode) {
				var self = this;
				if (!this.hasPort() || this.ops.busy) return;
				this.ops.busy = "mode";
				V.bridge(EP.l1mode, { method: "POST", body: JSON.stringify({ mode: mode }) }).then(function (r) {
					self.ops.busy = "";
					var d = r.data || {};
					if (!r.ok || d.success === false) {
						self.setNote2("模式切换失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
						return;
					}
					self.ops.mode = d.mode || mode;
					self.setNote2(
						"提取模式已切到 <b>" + V.escapeHtml(self.ops.mode) + "</b>（" +
							(d.changed === false ? "值未变" : "已写入并回读确认") + "）。",
					);
				});
			},

			/** 向量回填/重建的**预演**：只报"现在缺多少条"与后续代价，不写盘 */
			previewEmbedding: function (op) {
				var self = this;
				if (!this.hasPort() || this.ops.busy) return;
				this.ops.embedOp = op;
				this.ops.embedVerdict = { ok: true, text: "预演中…" };
				this.ops.embedLog = "";
				this.ops.embedConfirm = "";
				V.bridge(EP.embedding, { method: "POST", body: JSON.stringify({ op: op }) }).then(function (r) {
					var d = r.data || {};
					if (!r.ok || d.success === false) {
						self.ops.embedOp = "";
						self.ops.embedVerdict = null;
						self.setNote2("预演失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
						return;
					}
					var s = d.status || self.ops.embedding;
					self.ops.embedVerdict = {
						ok: true,
						text:
							"预演通过（dry-run，未写盘）。" +
							(s ? "总 " + s.totalRecords + " 条，已向量化 " + s.vectorizedCount + "，缺 " + s.unVectorizedCount + "。" : "") +
							" " + V.escapeHtml(d.note || ""),
					};
				});
			},

			/** 向量回填/重建的**执行**：长任务 —— 期间桥整座阻塞，所以先置 busy 再发请求 */
			applyEmbedding: function () {
				var self = this;
				if (!this.hasPort() || !this.embedReady) return;
				var op = this.ops.embedOp;
				var body = { op: op, apply: true };
				if (op === "rebuild") body.confirm = "REBUILD";
				this.ops.busy = "embedding";
				this.ops.embedVerdict = {
					ok: true,
					text: (op === "rebuild" ? "重建" : "回填") + "执行中…桥在此期间不响应任何请求。",
				};
				V.bridge(EP.embedding, { method: "POST", body: JSON.stringify(body) }).then(function (r) {
					self.ops.busy = "";
					var d = r.data || {};
					if (!r.ok || d.success === false) {
						self.ops.embedVerdict = { ok: false, text: "执行失败：" + V.escapeHtml(String(d.error || "未知错误")) };
						self.ops.embedLog = String(d.raw || d.stderr || d.error || "");
						self.setNote2("向量" + (op === "rebuild" ? "重建" : "回填") + "失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
						return;
					}
					self.ops.embedOp = "";
					self.ops.embedVerdict = null;
					self.ops.embedLog = "";
					self.ops.embedConfirm = "";
					self.setNote2(
						"向量" + (op === "rebuild" ? "重建" : "回填") + "完成（耗时 " +
							(d.elapsedMs ? Math.round(d.elapsedMs / 1000) + " 秒" : "未知") + "）。",
					);
					self.refreshOpsEmbedding();
				});
			},

			/** 取消待执行的向量操作 */
			cancelEmbedding: function () {
				this.ops.embedOp = "";
				this.ops.embedVerdict = null;
				this.ops.embedLog = "";
				this.ops.embedConfirm = "";
			},

			/** 整库还原的**预演**：只比对（CLI dry-run），把它的文本原样放进日志折叠块 */
			previewRollback: function () {
				var self = this;
				if (!this.hasPort() || this.ops.busy) return;
				var dir = this.chosenBackup;
				if (!dir) return;
				this.ops.rollbackBackup = dir;
				this.ops.busy = "rollback";
				V.bridge(EP.rollback, { method: "POST", body: JSON.stringify({ backup: dir }) }).then(function (r) {
					self.ops.busy = "";
					var d = r.data || {};
					var text = String(d.text || d.error || "");
					self.ops.rollbackPreview = {
						open: d.success === false,
						title: "还原预演（CLI 输出）",
						text: text.slice(0, 4000),
					};
					if (d.success === false) self.setNote2("预演失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
					else self.setNote2("预演完成（dry-run，未写盘）。详情见下方日志；确认无误后逐字输入备份目录名再执行。");
				});
			},

			/** 整库还原的**执行**：替换当前全部 L1 记录。confirm 必须等于目录名（桥会复验） */
			applyRollback: function () {
				var self = this;
				if (!this.hasPort() || !this.rollbackReady || this.ops.busy) return;
				var dir = this.chosenBackup;
				return V.vue
					.confirm("整库还原会用备份「" + dir + "」替换当前 L1 全部记录（不是单条撤销）。\n\n继续？", "整库还原")
					.then(function (ok) {
						if (!ok) return null;
						self.ops.busy = "rollback";
						return V.bridge(EP.rollback, {
							method: "POST",
							body: JSON.stringify({ backup: dir, apply: true, confirm: dir }),
						}).then(function (r) {
							self.ops.busy = "";
							var d = r.data || {};
							self.ops.rollbackPreview = { open: true, title: "还原结果（CLI 输出）", text: String(d.text || d.error || "").slice(0, 4000) };
							if (!r.ok || d.success === false) {
								self.setNote2("整库还原失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
								return;
							}
							self.ops.rollbackConfirm = "";
							self.setNote2("整库还原完成，已重新加载记录。");
							// 记录被整库替换 → 卡片必须重读；备份清单也多了一份 pre-rollback
							self.autoLoad();
							self.refreshOpsBackups();
						});
					});
			},
		},
		template: /* html */ `
		<header class="page">
			<h1>L1 原子记忆</h1>
			<!-- 页头只留一句定位：这一页是**筛选 + 浏览**的地方，方法论（drop 留痕在哪、两根轴怎么区分…）
			     一律下放到侧栏【说明】组，别在首屏替读者读一遍。 -->
			<p class="sub">记录库 · 质量分 · 淘汰候选 · 任务状态 · 场景 / 项目归属。</p>
			<notice :msg="loadNote"></notice>

			<div class="toolbar">
				<el-button @click="autoLoad(); loadOps()">重新加载</el-button>
				<el-button @click="clearAll">清空</el-button>
				<el-button @click="exportView">导出当前视图</el-button>
			</div>
			<div class="toolbar">
				<el-input class="grow" v-model="qInput" clearable placeholder="搜索 content / 场景 / 项目 / id / cwd …" @input="onSearchInput" @clear="onSearchInput"></el-input>
				<el-select v-model="filters.quality" style="width:118px" @change="onFilterChange">
					<el-option value="" label="全部质量"></el-option>
					<el-option v-for="t in ['热','温','冷','新','待观察','噪']" :key="t" :value="t" :label="t"></el-option>
				</el-select>
				<el-select v-model="filters.date" style="width:140px" @change="onFilterChange">
					<el-option value="" label="全部日期"></el-option>
					<el-option v-for="d in dateOptions" :key="d.key" :value="d.key" :label="d.key + '（' + d.count + '）'"></el-option>
				</el-select>
				<el-select v-model="filters.sort" style="width:132px" @change="onFilterChange">
					<el-option v-for="s in sorts" :key="s.value" :value="s.value" :label="s.label"></el-option>
				</el-select>
				<el-checkbox :model-value="filters.hideDeleted" @update:model-value="onHideDeleted">隐藏已删除</el-checkbox>
				<el-checkbox :model-value="filters.onlyDeleted" @update:model-value="onOnlyDeleted">仅看已删除</el-checkbox>
			</div>
		</header>

		<main>
			<!--
				侧栏按「性质」分四组，而不是把 14 个区块平铺：
				  筛选（常开）—— 这一页最常用的动作，放最前
				  操作（常开）—— 危险动作必须一眼可达，不该滚两屏统计才看见
				  统计（默认收起）—— 概览/质量/淘汰候选/来源分片都是「查」不是「用」
				  说明（默认收起）—— 5 段教程
			-->
			<aside>
				<h2>筛选</h2>

				<!-- 类型与任务状态是**同一棵菜单**的两级：任务状态是 work_task 这个类型下的一个维度，
				     平铺成两块按钮会让人以为它们是两个平行的轴。二级挂在 work_task 行下，点把手展开；
				     「非任务记录」是类型轴上的补集。行序固定为 schema 声明序，不按计数排。 -->
				<h3 class="sub">类型 · 任务状态</h3>
				<div class="btn-list" id="typeMenu">
					<template v-for="item in typeMenu" :key="item.value || 'all'">
						<div v-if="item.branch" class="type-branch">
							<el-button :class="{ active: item.active }" @click="pickType(item.value)">
								<span>{{ item.label }}</span>
								<chip v-if="item.marker" :kind="'task-' + filters.task" :label="item.marker" tip="当前筛选：仅该状态"></chip>
								<span class="n"><span class="alive">{{ item.alive }}</span>/{{ item.total }}</span>
								<span class="caret" :title="(filters.branchOpen ? '收起' : '展开') + '任务状态'" @click.stop="toggleBranch">{{ filters.branchOpen ? "▾" : "▸" }}</span>
							</el-button>
							<div v-if="filters.branchOpen" class="btn-list type-sub">
								<el-button v-for="s in item.subs" :key="s.value" :class="{ active: s.active }" @click="pickTask(s.value)">
									<span>{{ s.label }}</span>
									<span class="n"><span class="alive">{{ s.alive }}</span>/{{ s.total }}</span>
								</el-button>
							</div>
						</div>
						<el-button v-else :class="{ active: item.active }" @click="pickType(item.value)">
							<span>{{ item.label }}</span>
							<span class="n"><span class="alive">{{ item.alive }}</span>/{{ item.total }}</span>
						</el-button>
					</template>
				</div>

				<h3 class="sub">场景（按 scene_id 解析到池中 canonical 名）</h3>
				<el-select v-model="filters.scene" style="width:100%" @change="onFilterChange">
					<el-option value="" :label="sceneOptions.label"></el-option>
					<el-option v-for="c in sceneOptions.items" :key="c.key" :value="c.key" :label="c.key + '（' + c.count + '）'"></el-option>
				</el-select>
				<div class="hint" v-if="rows.length" style="margin-top:6px">
					池中 <b>{{ sceneOptions.known }}</b> 个分组已对上 <code>scenes.json</code>；<b>{{ sceneOptions.unclassified }}</b> 条记录的场景名不在池中（历史快照，标着「未归类」）—— 这类只在记录里存在，别当成有效分组看。
				</div>

				<h3 class="sub">项目（metadata.project）</h3>
				<el-select v-model="filters.project" style="width:100%" @change="onFilterChange">
					<el-option value="" :label="projectOptions.label"></el-option>
					<el-option v-for="c in projectOptions.items" :key="c.key" :value="c.key" :label="c.key + '（' + c.count + '）'"></el-option>
				</el-select>

				<h2>操作</h2>
				<!-- 管理操作区：值全部来自 /api/*，失败时字段留空而不是沿用旧值（宁缺勿假）。
				     这里只有「L1 自己的」写动作：提取模式 / 向量库 / 整库还原 ——
				     请求触发与停止子代理是三层同名动作，2026-10-08 已归「流水线」页。 -->
				<notice :msg="opsNote"></notice>
				<div class="ops" id="l1ops">
					<div v-if="!hasPort()" class="hint">写回需要写盘桥：请用带 <code>?port=</code> 的地址打开本页（<code>npm run viewer</code> 一键起桥）。只读模式下这里的按钮全部禁用。</div>

					<!-- 提取模式：分段切换 + 扁平段；说明文本默认隐藏、悬停整行才显示（title）。
					     这类"什么时候会写盘、真源在哪"的注解平时占一大块侧栏，只有真要去点时才需要。 -->
					<div class="ops-row" :title="modeTitle">
						<div class="ops-label">提取模式</div>
						<div class="ops-ctl">
							<seg :model-value="ops.mode || ''" :options="modeOptions" :disabled="!hasPort() || !!ops.busy" @change="setL1Mode"></seg>
							<span v-if="ops.busy === 'mode'" class="hint">切换中…</span>
							<span v-else-if="!ops.mode && ops.loaded" class="hint">{{ ops.modeError }}</span>
						</div>
					</div>

					<!-- 向量库（长任务：桥单线程同步执行，期间整座桥不响应） -->
					<div class="ops-row" :class="{ busy: ops.busy === 'embedding' }" :title="embedTitle">
						<div class="ops-label">向量库</div>
						<div class="ops-ctl">
							<template v-if="ops.embedding">
								<metric :value="'向量 ' + ops.embedding.vectorizedCount + '/' + ops.embedding.totalRecords" tip="已向量化 / 总记录"></metric>
								<metric :value="'缺 ' + ops.embedding.unVectorizedCount" tip="未向量化条数"></metric>
							</template>
							<span v-else class="hint">{{ ops.embeddingError || (ops.loaded ? "读不到向量库状态" : "读取中…") }}</span>
							<el-button :disabled="!hasPort() || !!ops.busy" @click="previewEmbedding('backfill')">回填：预演</el-button>
							<el-button :disabled="!hasPort() || !!ops.busy" @click="previewEmbedding('rebuild')">重建：预演</el-button>
							<span v-if="ops.busy === 'embedding'" class="hint">运行中（桥被占满，勿重复点）</span>
						</div>
						<div style="grid-column:1 / -1" v-if="ops.embedOp">
							<notice v-if="ops.embedVerdict" :msg="{ html: ops.embedVerdict.text, level: ops.embedVerdict.ok ? '' : 'warn' }"></notice>
							<details class="log" v-if="ops.embedLog" open><summary>CLI 输出</summary><pre class="log-text">{{ ops.embedLog }}</pre></details>
							<div class="ops-ctl" style="margin-top:6px">
								<template v-if="ops.embedOp === 'rebuild'">
									<span class="confirm-token">REBUILD</span>
									<el-input v-model="ops.embedConfirm" style="width:230px" placeholder="输入 REBUILD 以解锁执行" :disabled="!hasPort()"></el-input>
								</template>
								<!-- 执行是**写盘 + 不可逆**（重建先清空向量库）：danger 描边 -->
								<el-button type="danger" :disabled="!embedReady || !!ops.busy" @click="applyEmbedding">确认执行{{ ops.embedOp === 'rebuild' ? '重建' : '回填' }}</el-button>
								<el-button @click="cancelEmbedding">取消</el-button>
							</div>
						</div>
					</div>

					<!-- 危险区：整库还原（不是单条撤销） -->
					<div class="danger-zone" id="opsDanger">
						<h3>危险区 · 整库还原（L1）</h3>
						<div class="ops">
							<div class="ops-row" :class="{ busy: ops.busy === 'rollback' }">
								<div class="ops-label">选择备份</div>
								<div class="ops-ctl">
									<el-select :model-value="chosenBackup" style="width:340px" :disabled="!hasPort() || !backupOptions.length" @change="(v) => (ops.rollbackBackup = v)">
										<el-option v-if="!backupOptions.length" value="" label="（没有备份）"></el-option>
										<el-option v-for="b in backupOptions" :key="b.value" :value="b.value" :label="b.label"></el-option>
									</el-select>
									<el-button :disabled="!hasPort() || !chosenBackup || !!ops.busy" @click="previewRollback">预演</el-button>
								</div>
								<div class="ops-note">整库还原 = 删掉当前 L1 全部 <code>.jsonl</code> 再复制备份内容，<b>不是单条撤销</b>；当前库会先自动备份一份（pre-rollback）。预演只比对，不写盘。</div>
							</div>
							<div class="ops-row" :class="{ busy: ops.busy === 'rollback' }">
								<div class="ops-label">打字确认</div>
								<div class="ops-ctl">
									<span class="confirm-token">{{ chosenBackup || "(无备份)" }}</span>
									<el-input v-model="ops.rollbackConfirm" style="width:260px" placeholder="逐字输入所选备份目录名" :disabled="!hasPort() || !chosenBackup"></el-input>
									<el-button type="danger" :disabled="!rollbackReady || !!ops.busy" @click="applyRollback">执行还原</el-button>
									<span v-if="ops.busy === 'rollback'" class="hint">还原中（桥被占满，勿重复点）</span>
								</div>
								<div class="ops-note">必须逐字输入上面显示的备份目录名 —— 与桥的 confirm 副验一致；输入正确前「执行还原」保持禁用。</div>
							</div>
							<div v-if="ops.rollbackPreview">
								<details class="log" :open="ops.rollbackPreview.open"><summary>{{ ops.rollbackPreview.title }}</summary><pre class="log-text">{{ ops.rollbackPreview.text }}</pre></details>
							</div>
						</div>
					</div>
				</div>
				<!-- 搬走的两个动作留一句指引：按钮凭空消失而不说去哪了，是这一版最不想要的失效方式 -->
				<p class="hint">「请求触发 L1」与「停止子代理」在顶部
					<a href="pipeline-viewer.html" @click.prevent="gotoPipeline">流水线页</a>
					（队列与三层子代理合成一张表）。</p>

				<h2>统计</h2>
				<el-collapse v-model="statsOpen">
					<el-collapse-item name="stats" title="概览 · 质量标签 · 质量分直方图 · 淘汰候选 · 来源分片">
						<!-- 数据从哪来 / 用哪种时钟 —— 是健康信息不是操作信息，展开才看 -->
						<div class="hint" v-html="sourceNote"></div>
						<h3 class="sub">概览</h3>
						<stat-list :rows="statRows"></stat-list>

						<h3 class="sub">质量标签</h3>
						<bar-list :rows="qualityBars"></bar-list>
						<h3 class="sub">质量分直方图</h3>
						<hist :cols="histCols"></hist>
						<h3 class="sub">淘汰候选（judgePrune 可判删）</h3>
						<div class="hint" v-html="pruneNote"></div>
						<div class="hint" style="margin-top:6px"><a href="#" @click.prevent="showPruneOnly">只看淘汰候选</a></div>

						<h3 class="sub">来源分片</h3>
						<div class="hint">{{ fileSummary || "尚未加载" }}</div>
					</el-collapse-item>
				</el-collapse>

				<h2>说明</h2>
				<el-collapse v-model="helpOpen">
					<el-collapse-item name="help" title="价值校验留痕 / 两根独立的轴 / 场景名以池为准 / 质量分 ≠ 能不能删 / 衰减时钟">
						<div class="hint">
							<p><b>drop 的记录从不写进库</b>：被价值校验判 drop 的记录压根不会落进 <code>l1/records/</code>，
							它们的唯一留痕是 <code>value-check-log.jsonl</code> —— 页面上的「价值校验丢弃」页签就是那份日志，
							否则只有幸存者偏差。</p>
							<p><b>两根独立的轴</b>：<span class="chip del">deleted</span> 表示"这条记录不成立"（查重覆盖 / 纠错作废），
							记录连同向量一起退出召回；<span class="chip task-done">已完成</span> 只表示任务关了，记录照旧存活、照旧被召回。
							同一条记录可以两者兼有，所以页面上它们分别渲染、不合并成一个状态。</p>
							<p><b>场景名以池为准</b>：记录里的 <code>scene_name</code> 只是落盘当时的历史快照，真源是
							<code>l1/scenes.json</code>。带「⇢合并」的表示该 id 已被合并到另一个场景，按 canonical 名归组。</p>
							<p><b>质量分 ≠ 能不能删</b>：质量分是"热度"，长期不被命中就会衰减到 0（符合遗忘曲线）；
							能不能删由 <code>judgePrune</code> 单独判定 —— 高 priority 与 <code>work_method</code> 类永不自动淘汰。
							「淘汰候选」就是这一半信息。</p>
							<p><b>衰减时钟</b>：<code>days</code> 按<b>活跃会话日</b>算（停工期间不增长），
							只有侧车缺 <code>activeDays</code> 时才退化为日历天 —— 卡片上会标明用的是哪种。</p>
							<p class="hint">质量分公式与 <code>memory/l1/quality.ts</code> 的一致性由
							<code>scripts/verify-viewer-quality-parity.ts</code> 断言数值全等（不是靠注释声明）。</p>
						</div>
					</el-collapse-item>
				</el-collapse>
			</aside>

			<section class="content">
				<div class="toolbar">
					<el-button :class="{ active: tab === 'records' }" @click="tab = 'records'">记录</el-button>
					<el-button :class="{ active: tab === 'drops' }" @click="tab = 'drops'">价值校验丢弃</el-button>
				</div>

				<div v-show="tab === 'records'">
					<!-- 批量选择条：只在有勾选时出现。放在列表上方而不是浮动：设计契约是一层一条滚动轴，
					     浮动条会再造一层。 -->
					<div class="toolbar" v-if="selected.size > 0">
						<span class="hint" v-html="'已选 <b>' + selected.size + '</b> 条'"></span>
						<el-button @click="applyTaskStateBatch('open')">标为待办</el-button>
						<el-button @click="applyTaskStateBatch('done')">标为完成</el-button>
						<el-button @click="applyTaskStateBatch('dropped')">标为废弃</el-button>
						<el-button type="danger" @click="pendingTombstone = Array.from(selected)">删除（墓碑）</el-button>
						<el-button @click="exportSelected">导出选中</el-button>
						<el-button @click="selectAllFiltered">全选当前筛选</el-button>
						<el-button @click="clearSelection">清空选择</el-button>
					</div>
					<notice v-if="selNote.html" :msg="selNote"></notice>
					<!-- 墓碑二次确认：逐条列出将被删除的 id（这是"点了不可逆"的唯一凭据） -->
					<div v-if="pendingTombstone && pendingTombstone.length" class="notice warn">
						<b>墓碑删除</b>：就地写 <code>deleted:true</code>（记录连同向量退出召回），自动备份、可用危险区的整库还原回退，<b>不可逐条撤销</b>。确认删除以下 <b>{{ pendingTombstone.length }}</b> 条？
						<ul class="diff-list">
							<li class="del" v-for="id in pendingTombstone.slice(0, 20)" :key="id">{{ id }}</li>
							<li class="more" v-if="pendingTombstone.length > 20">…还有 {{ pendingTombstone.length - 20 }} 条</li>
						</ul>
						<div class="toolbar">
							<el-button type="danger" @click="applyTombstoneBatch(pendingTombstone)">确认删除 {{ pendingTombstone.length }} 条</el-button>
							<el-button @click="pendingTombstone = null">取消</el-button>
						</div>
					</div>
					<p class="hint">{{ resultMeta }}</p>

					<div v-if="pageRows.length === 0" class="empty">
						<template v-if="rows.length"><strong>无匹配结果</strong>试试放宽筛选或清空搜索。</template>
						<template v-else><strong>还没有数据</strong>点上方「重新加载」从写盘桥取数。</template>
					</div>
					<div v-else class="cards" id="list">
						<!-- 卡片：整张卡（含正文预览）都可点 → 打开详情弹层。正文是截断预览（契约 3），
						     完整正文只在弹层里给。勾选框放在 chips 行首（不新增定位层，不遮挡正文），
						     用**记录 id** 记账而不是下标。 -->
						<article class="card" :class="{ deleted: r.deleted }" v-for="r in pageRows" :key="r.id" @click="openModal(r)">
							<div class="card-head">
								<div class="chips">
									<label class="check" title="加入批量选择" @click.stop>
										<el-checkbox :model-value="selected.has(r.id)" @update:model-value="(v) => toggleSelected(r.id, v)"></el-checkbox>
									</label>
									<chip :kind="'type'" :label="r.type || 'unknown'"></chip>
									<chip v-if="r.priority !== undefined && r.priority !== null" kind="prio" :label="'P' + r.priority"></chip>
									<!-- 两根独立的轴：deleted 与 taskState 都要出现，不能合并 -->
									<chip v-if="r.deleted" kind="del" label="deleted" tip="记录不成立（查重覆盖 / 纠错作废）—— 与任务状态是两根独立的轴"></chip>
									<chip v-if="r.isTask" :kind="'task-' + r.taskState" :label="taskLabel(r.taskState)" :tip="r.audit.taskStateChange ? '审计：' + r.audit.taskStateChange.at + ' by ' + r.audit.taskStateChange.by : '缺省即待办'"></chip>
									<!-- 淘汰候选是「建议」不是「事实」，故用琥珀 prune 而不是 deleted 的红 -->
									<chip v-if="r.prune.eligible" kind="prune" label="淘汰候选" :tip="pruneLabel(r.prune.reason)"></chip>
									<!-- 温度：词在前、分数在后 -->
									<chip :kind="qualClass(r.q.tag)" :label="r.q.tag + ' ' + fmtQ(r.q.quality)" :tip="'质量分 ' + fmtQ(r.q.quality) + ' —— 热度，按天数衰减'"></chip>
									<!-- 场景胶囊：已知（池中）与未知必须看起来不同 -->
									<chip :kind="sceneChip(r).kind" :label="sceneChip(r).text" :tip="sceneChip(r).tip"></chip>
									<chip v-if="r.project" :label="projectShort(r.project)" :tip="r.project"></chip>
									<chip v-else label="无项目" tip="metadata.project 为空"></chip>
								</div>
							</div>
							<div class="qbar"><i :class="tagBar[r.q.tag] || 'c-watch'" :style="{ width: barPct(r) + '%' }"></i></div>
							<div class="card-body"><div class="full-content">{{ r.content || "" }}</div></div>
							<div class="card-foot">
								<div class="chips">
									<metric :value="fromNow(r.updatedAt || r.createdAt)" :tip="'最后更新于 ' + fmtTime(r.updatedAt || r.createdAt)"></metric>
								</div>
								<el-button class="expand-btn" @click.stop="openModal(r)">查看完整记录</el-button>
							</div>
						</article>
					</div>

					<!-- 分页：只影响画面。全选 / 导出作用的仍是筛选结果全集。
					     ⚠ current-page 必须用 v-model 绑定：实测（EP 2.14.7）写成单向的
					     :current-page="page" 会让整个分页组件渲染成一个空注释节点（组件在、DOM 全无），
					     而且不报任何错 —— 只有真去数 .el-pager li 才会发现它是空的。 -->
					<div class="toolbar" style="justify-content:space-between" v-if="pageSize && filteredRows.length > pageSize">
						<el-pagination
							background
							layout="prev, pager, next"
							v-model:current-page="page"
							:page-size="pageSize"
							:total="filteredRows.length"
						></el-pagination>
						<el-select v-model="pageSize" style="width:118px" @change="page = 1">
							<el-option v-for="s in pageSizes" :key="s.value" :value="s.value" :label="s.label"></el-option>
						</el-select>
					</div>
					<div class="toolbar" v-else-if="filteredRows.length > 60">
						<el-select v-model="pageSize" style="width:118px" @change="page = 1">
							<el-option v-for="s in pageSizes" :key="s.value" :value="s.value" :label="s.label"></el-option>
						</el-select>
					</div>
				</div>

				<div v-show="tab === 'drops'">
					<p class="hint">{{ dropMeta }}</p>
					<div v-if="dropRows.length === 0" class="hint">
						<template v-if="drops.length"><strong>无匹配结果</strong></template>
						<template v-else><strong>没有丢弃留痕</strong><code>l1/value-check-log.jsonl</code> 不存在或为空。</template>
					</div>
					<el-table v-else :data="dropRows" size="small" max-height="560" empty-text="没有留痕">
						<el-table-column label="时间" width="150" class-name="nowrap">
							<template #default="{ row }">{{ row.at }}</template>
						</el-table-column>
						<el-table-column label="动作" width="130">
							<template #default="{ row }"><chip :label="row.action"></chip></template>
						</el-table-column>
						<el-table-column label="记录 id" width="150" class-name="mono">
							<template #default="{ row }"><chip class="mono" :label="row.id"></chip></template>
						</el-table-column>
						<el-table-column label="类型" width="96">
							<template #default="{ row }">{{ row.type }}</template>
						</el-table-column>
						<el-table-column label="P" width="48" align="right" class-name="mono">
							<template #default="{ row }">{{ row.priority }}</template>
						</el-table-column>
						<el-table-column label="场景" width="120">
							<template #default="{ row }">{{ row.scene }}</template>
						</el-table-column>
						<el-table-column label="丢弃理由" min-width="220">
							<template #default="{ row }"><span class="wrap-any">{{ row.reason }}</span></template>
						</el-table-column>
						<el-table-column label="正文" min-width="240">
							<template #default="{ row }"><span class="wrap-any">{{ row.body }}</span></template>
						</el-table-column>
					</el-table>
				</div>
			</section>
		</main>

		<!-- 详情弹层：卡片正文是 6 行截断的预览，这里才是看全文的地方 -->
		<el-dialog v-model="modalOpen" :title="modalTitle" width="820px" top="4vh" class="viewer-dialog" @closed="modalRow = null">
			<template v-if="modalRow">
				<div class="chips">
					<metric kind="id" :value="modalRow.id || '?'" tip="记录 id：l1_fix / l1_task_state 的入参"></metric>
					<chip :kind="qualClass(modalRow.q.tag)" :label="modalRow.q.tag + ' ' + fmtQ(modalRow.q.quality)" :tip="'质量分 ' + fmtQ(modalRow.q.quality) + ' —— 热度，按天数衰减'"></chip>
					<chip :kind="modalRow.prune.eligible ? 'prune' : ''" :label="(modalRow.prune.eligible ? '淘汰候选：' : '不淘汰：') + pruneLabel(modalRow.prune.reason)"></chip>
					<!-- 这里**刻意不再放任务状态胶囊**（2026-10-10，用户问"明明状态是已完成，为什么三种都显示"）：
					     状态由下面那个下拉自己说明。卡片列表上那枚照旧保留（卡片没有切换器）。 -->
					<chip v-if="modalRow.deleted" kind="del" label="deleted"></chip>
				</div>
				<!-- 诊断值全在这里：卡片只留了「多久没动」，其余从列表层搬进来 -->
				<div class="chips" style="margin-top:4px">
					<metric :value="'eff ' + modalRow.q.effective"></metric>
					<metric :value="'hits ' + modalRow.q.hits + ' / 无效 ' + modalRow.q.invalid"></metric>
					<metric v-if="modalHitStat && (modalHitStat.injectHits || modalHitStat.toolHits)" :value="'注入 ' + modalHitStat.injectHits + ' / 工具 ' + modalHitStat.toolHits" tip="自动注入 / 工具召回"></metric>
				</div>

				<!-- 任务状态：**一个下拉，不是三颗按钮**（用户 2026-10-10 报"看起来就像是展示状态"）。
				     三颗带形状编码的描边按钮并排，谁看都像"这条记录有这几种状态"而不像"这里可以改"。
				     行为不变：选中即写（l1_task_state，就地改写 + 写锁 + metadata.taskStateChange 审计）。 -->
				<div class="ops-row" style="margin:12px 0" v-if="modalRow.isTask">
					<div class="ops-label">任务状态</div>
					<div class="ops-ctl">
						<el-select :model-value="modalRow.taskState" style="width:130px" :disabled="!hasPort() || taskBusy" @change="onTaskStateChange">
							<el-option v-for="s in ['open','done','dropped']" :key="s" :value="s" :label="taskLabel(s)"></el-option>
						</el-select>
						<el-input v-model="taskReason" style="width:250px" placeholder="可选：原因（写入审计）" :disabled="!hasPort() || taskBusy" maxlength="200"></el-input>
						<span v-if="taskBusy" class="hint">写入中…</span>
					</div>
					<div class="ops-note">
						改这里就<b>就地改写</b>该条（保留 id / 正文 / 向量），并写 <code>metadata.taskStateChange</code> 审计<template v-if="!hasPort()">。只读：需带 <code>?port=</code> 打开才能写盘。</template>。
					</div>
				</div>

				<!-- 弹层里的正文**只读**：全页唯一的正文编辑入口是下面纠错面板的「新正文」框（写盘要过四道闸） -->
				<div class="full-content">{{ modalRow.content || "" }}</div>

				<el-collapse>
					<el-collapse-item name="fields" title="字段与审计（点开）">
						<dl class="kv">
							<!-- 这里不再重复 id：它已经在标题那一行 -->
							<dt>priority</dt><dd>{{ modalRow.priority === undefined ? "—" : modalRow.priority }}</dd>
							<dt>场景（解析后）</dt><dd>{{ modalRow.scene.canonical || "—" }}<br /><span class="hint">{{ modalRow.scene.note || "" }}</span></dd>
							<dt>scene_id / scene_name</dt><dd>{{ (modalRow.scene.id || "—") + " / " + (modalRow.scene.rawName || "—") }}</dd>
							<dt>项目 / scope</dt><dd>{{ (modalRow.project || "—") + " / " + (modalRow.scope || "—") }}</dd>
							<dt>cwd</dt><dd>{{ modalRow.cwd || "—" }}</dd>
							<dt>sessionKey</dt><dd>{{ modalRow.sessionKey || "—" }}</dd>
							<dt>version / deleted</dt><dd>{{ (modalRow.version === undefined ? "—" : modalRow.version) + " / " + (modalRow.deleted ? "true" : "false") }}</dd>
							<dt>createdAt / updatedAt</dt><dd>{{ fmtTime(modalRow.createdAt) + " / " + fmtTime(modalRow.updatedAt) }}<br /><span class="hint">最后更新 {{ fromNow(modalRow.updatedAt || modalRow.createdAt) }}</span></dd>
							<dt>质量明细</dt><dd>{{ "q=" + fmtQ(modalRow.q.quality) + " decay=" + fmtQ(modalRow.q.decay) + " days=" + Number(modalRow.q.days).toFixed(2) + "（" + (modalRow.q.activeDayClock ? "活跃会话日" : "日历天") + "） tag=" + modalRow.q.tag }}</dd>
							<dt>淘汰判定</dt><dd>{{ pruneLabel(modalRow.prune.reason) + "（保护带 priority ≥ " + protectedPriority + "）" }}</dd>
							<template v-if="modalRow.audit.taskStateChange">
								<dt>taskStateChange</dt><dd>{{ "from " + modalRow.audit.taskStateChange.from + " → " + modalRow.audit.taskStateChange.to + " · " + modalRow.audit.taskStateChange.at + " · by " + modalRow.audit.taskStateChange.by + (modalRow.audit.taskStateChange.reason ? " · " + modalRow.audit.taskStateChange.reason : "") }}</dd>
							</template>
							<template v-if="modalRow.audit.valueCheck">
								<dt>valueCheck</dt><dd>{{ modalRow.audit.valueCheck.verdict + (modalRow.audit.valueCheck.from ? "（" + modalRow.audit.valueCheck.from + " → " + modalRow.audit.valueCheck.to + "）" : "") + (modalRow.audit.valueCheck.reason ? " · " + modalRow.audit.valueCheck.reason : "") }}</dd>
							</template>
							<template v-if="modalRow.audit.l1Cleanup">
								<dt>l1Cleanup</dt><dd>{{ (modalRow.audit.l1Cleanup.action || "") + (modalRow.audit.l1Cleanup.appliedAt || modalRow.audit.l1Cleanup.at || modalRow.audit.l1Cleanup.date ? " · " + (modalRow.audit.l1Cleanup.appliedAt || modalRow.audit.l1Cleanup.at || modalRow.audit.l1Cleanup.date) : "") + (modalRow.audit.l1Cleanup.replacedBy ? " · replacedBy " + modalRow.audit.l1Cleanup.replacedBy : "") }}</dd>
							</template>
							<dt>sourceFile</dt><dd>{{ modalRow.sourceFile || "—" }}</dd>
						</dl>
						<pre class="log-text">{{ JSON.stringify(modalRow, null, 2) }}</pre>
					</el-collapse-item>

					<!-- 纠错面板（l1_fix）：预演（checkFixGates 裁决）→ 执行。审计标注会**追加进正文本身**。
					     默认收起：这一块实测 382px、占弹层一半高，而它是 agent 自纠的走法；人的日常动作是
					     看正文、标任务状态、作废。summary 就是它唯一的入口。 -->
					<el-collapse-item name="fix" :title="'改写正文（l1_fix）· 需填证据、会写盘' + (hasPort() ? '' : ' · 只读：需带 ?port= 打开')">
						<div class="ops">
							<div class="hint" v-if="!hasPort()">写盘需要写盘桥：请以带 <code>?port=</code> 的地址打开本页。以下控件在只读模式下不可用。</div>
							<div class="hint">
								作废某条请用右下<b>删除（墓碑）</b> —— 与 l1_fix 的 tombstone 是同一个写盘动作，这里不再重复入口。改写会把审计标注【YYYY-MM-DD L1 修正：…】<b>追加进正文本身</b>（不是独立审计键），同时记 <code>metadata.l1Cleanup</code> —— 正文会真的变长。四道闸：证据 ≥20 字符、新正文 ≥10 字符、24h 防抖、高价值保护。
							</div>
							<div class="ops-row">
								<div class="ops-label">新正文</div>
								<div class="ops-ctl">
									<el-input type="textarea" v-model="fix.content" :autosize="{ minRows: 5, maxRows: 14 }" :disabled="!hasPort()"></el-input>
								</div>
								<div class="ops-note">≥10 字符；短于此预演就会被拒。</div>
							</div>
							<div class="ops-row">
								<div class="ops-label">证据 *</div>
								<div class="ops-ctl">
									<el-input v-model="fix.evidence" placeholder="grep 输出 / file:line / 命令输出（≥20 字符，必填）" :disabled="!hasPort()"></el-input>
								</div>
								<div class="ops-note">必填且 ≥20 字符：修正必须附可复核证据，否则预演就会被拒。</div>
							</div>
							<div class="ops-row">
								<div class="ops-label">原因 / 优先级</div>
								<div class="ops-ctl">
									<el-input v-model="fix.reason" style="width:240px" placeholder="可选：原因（写进正文审计标注）" :disabled="!hasPort()"></el-input>
									<el-input-number v-model="fix.priority" style="width:140px" :min="0" :max="100" :controls="false" placeholder="priority 0-100" :disabled="!hasPort()"></el-input-number>
									<el-checkbox v-model="fix.force" :disabled="!hasPort()">force（只解高价值保护那道闸）</el-checkbox>
								</div>
							</div>
							<div class="ops-ctl" style="margin-top:6px">
								<!-- 预演是只读动作（描边默认档）；只有真正写盘的「执行」才用 primary（写入新内容） -->
								<el-button :disabled="!hasPort()" @click="previewFix">预演（只报闸门裁决）</el-button>
								<el-button v-if="fixApplyReady" type="primary" :disabled="!hasPort()" @click="applyFix">执行（写盘）</el-button>
							</div>
							<notice v-if="fixVerdict.html" :msg="fixVerdict"></notice>
						</div>
					</el-collapse-item>
				</el-collapse>
			</template>
			<template #footer>
				<div class="foot">
					<!-- 页脚只放**不可逆**的那一个动作（删除墓碑）与关闭 -->
					<el-button type="danger" @click="onTombstoneClick">删除（墓碑）</el-button>
					<el-button @click="closeModal">关闭</el-button>
				</div>
			</template>
		</el-dialog>
		`,
	};

	// 排序选项与温度色工具类挂到组件构造器上（模板经 `sorts` / `tagBar` 数据字段引用）
	PAGE.SORTS = SORTS;
	PAGE.TAG_BAR = TAG_BAR;

	V.vue.mount(PAGE, { active: "records-viewer.html" });
})();
