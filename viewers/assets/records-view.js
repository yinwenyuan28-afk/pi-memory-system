/*
 * viewers/assets/records-view.js —— L1 原子记忆页的页面逻辑
 *
 * 依赖：viewer-core.js（window.V）与 quality-core.js（window.VQ），两者都先于本文件加载。
 *
 * 这一版补齐的字段（旧版全部缺失，逐条对应一次后端改动）：
 *   · `taskState`（2026-10-08）：work_task 的任务生命周期，与 `deleted` 是**独立的两根轴**。
 *     页面上必须都能看见：一条记录可以既是「已完成」又已被 deleted，两者不能合并成一个状态。
 *   · 场景归属：`scene_name` 只是落盘时的历史快照，真源是 `l1/scenes.json`。这里按
 *     `scene_id` 解析出 canonical 名，并对已合并（mergedInto）的条目给出提示 —— 否则两个
 *     看起来不同的场景名其实可能是同一个 id，读者会按错的分组去理解。
 *   · 项目维度：`metadata.project`（419 条记录有值）。旧版连筛都没有。
 *   · 价值校验丢弃留痕：`l1/value-check-log.jsonl` —— 被 value-check 判 drop 的记录**从不写进库**，
 *     只看 records 会看到纯粹的幸存者偏差。
 *   · 淘汰候选：`judgePrune`。旧版只算"热度"（quality），把"删除资格"这一半整个隐藏了，
 *     而页头注释还声称与 quality.ts 1:1。
 */
(function () {
	"use strict";

	var V = window.V;
	var VQ = window.VQ;

	// ── 状态 ────────────────────────────────────────────────────────────────
	var state = {
		/** 已加质量分与场景/项目解析的记录（加载时算一次，避免每次筛选重算） */
		rows: [],
		/** 原始文件清单（侧栏"来源文件"） */
		files: [],
		/** 命中统计：recordId → 归一后的驼峰对象 */
		hitMap: new Map(),
		/** 活跃会话日时间戳（侧车提供；无则 quality 退化为日历天） */
		activeDays: null,
		/** 本次生效的保护带阈值（priority 分布 P75，下限 60） */
		protectedPriority: 60,
		/** value-check 丢弃留痕 */
		drops: [],
		/** 场景池索引 */
		scenes: { byId: new Map(), byName: new Map() },
		/** 加载方式："bridge"（列全部分片）| "static"（逐日探测 90 天窗口，无桥时的兜底） */
		source: "",
		/** 加载过程中的错误/提示 */
		errors: [],
		filters: {
			type: "",
			task: "",
			scene: "",
			project: "",
			quality: "",
			date: "",
			q: "",
			sort: "quality-desc",
			hideDeleted: true,
			onlyDeleted: false,
		},
		tab: "records",
		lastRows: [],
		modalRow: null,
		/**
		 * 批量选择的**记录 id** 集合。
		 *
		 * 按 id 而不是卡片下标记账：下标只在"当前这一份渲染结果"里有效，任何一次筛选/重新加载都会
		 * 让同一个下标指向另一条记录 —— 那样"选中 → 改筛选 → 批量删除"会删到错的记录上。
		 * 选择跨筛选保持（由用户显式「清空选择」），这是刻意行为：先在不同筛选里挑，再一起操作。
		 */
		selected: new Set(),
		/** 待二次确认的墓碑 id 列表（非空时渲染确认条；确认或取消后清空） */
		pendingTombstone: null,
		/** L1 管理操作区状态：全部来自 /api/*；失败时字段留空而不是沿用旧值（宁缺勿假） */
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
			/** 整库还原：已预演的备份目录名 + 预演 CLI 文本（预渲染成 details.log）+ 用户已键入的确认串 */
			rollbackBackup: "",
			rollbackPreviewHtml: "",
			rollbackConfirm: "",
		},
	};

	// ── 工具 ────────────────────────────────────────────────────────────────
	function $(id) {
		return document.getElementById(id);
	}

	function fmtQ(n) {
		return Number(n).toFixed(2);
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

	/**
	 * 解析记录的场景归属（以 scenes.json 为真源）。
	 *
	 * 三种情形必须能区分开，不能都退化成一个名字：
	 *   ① scene_id 命中池 → canonical 名（可能还带"已合并"提示）
	 *   ② scene_id 不在池中（池被重建/记录是 main-agent 产物）→ 明确标注，不假装知道
	 *   ③ 无 scene_id（早于场景池的存量）→ 按名字/别名反查，查不到就标"未归类"
	 */
	function resolveScene(rec) {
		var scenes = state.scenes;
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
	 * 名混在一个下拉里，读者会以为它们是同一层级的可信分组 —— 而记里的名字只是落盘快照。
	 */
	function sceneBucket(r) {
		if (r.scene.known && r.scene.canonical) return r.scene.canonical;
		if (r.scene.canonical) return "未归类：" + r.scene.canonical;
		return "(无场景)";
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

	// ── 加载 ────────────────────────────────────────────────────────────────
	/**
	 * 活跃会话日：**优先问写盘桥**（读 `l0/conversations/` 真源），侧车只作离线回退。
	 *
	 * 为什么不能只用侧车（2026-10-08 实测）：`hit-stats.json` 的 `activeDays` 只在命中统计库
	 * 被打开/写入时才刷新，无召回发生就不重写。实测侧车 29 天、实际 30 天，`days` 差 1 →
	 * 3 条记录从「冷」错标成「待观察」、整个质量分直方图偏一格。公式没错（parity 门禁全绿），
	 * 错的是喂进去的输入 —— 所以输入要取权威来源。
	 *
	 * @returns Promise<"bridge"|"sidecar"|"none"> 实际采用哪个来源（页面据此如实标注时钟出处）
	 */
	function loadActiveDays() {
		var fromKeys = function (keys) {
			return keys
				.map(function (k) {
					var d = new Date(k + "T00:00:00");
					return d.getTime();
				})
				.filter(function (t) {
					return !Number.isNaN(t);
				})
				.sort(function (a, b) {
					return a - b;
				});
		};

		return V.bridge("/api/l1/active-days").then(function (r) {
			if (r.ok && r.data && r.data.available && Array.isArray(r.data.activeDays) && r.data.activeDays.length > 0) {
				state.activeDays = fromKeys(r.data.activeDays);
				return "bridge";
			}
			// 桥不可用（或 l0 不存在）→ 回退侧车
			return V.loadJson("../l1/hit-stats.json").then(function (payload) {
				var days = payload && !Array.isArray(payload) && Array.isArray(payload.activeDays) ? payload.activeDays : null;
				if (days && days.length > 0) {
					state.activeDays = fromKeys(days);
					return "sidecar";
				}
				state.activeDays = null;
				return "none";
			});
		});
	}

	/**
	 * 读命中统计侧车（兼容 `{generatedAt, activeDays, stats}` 与旧的裸数组两种形态）。
	 *
	 * 注意：这里**只取 stats**，activeDays 由 loadActiveDays 单独负责（它优先走桥）。
	 */
	function loadHitStats() {
		return V.loadJson("../l1/hit-stats.json").then(function (payload) {
			var arr = [];
			if (Array.isArray(payload)) arr = payload;
			else if (payload && Array.isArray(payload.stats)) arr = payload.stats;
			else return;
			state.hitMap = new Map();
			for (var i = 0; i < arr.length; i++) {
				var st = VQ.normalizeStat(arr[i]);
				if (st && st.recordId) state.hitMap.set(st.recordId, st);
			}
			state.sidecarGeneratedAt = payload && typeof payload.generatedAt === "string" ? payload.generatedAt : "";
		});
	}

	/** 读场景池，建 id 与 名称/别名 两套索引。 */
	function loadScenes() {
		return V.loadJson("../l1/scenes.json").then(function (payload) {
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
						// 别名不覆盖 canonical 名（canonical 优先）
						if (al && !byName.has(al)) byName.set(al, e);
					}
				}
			}
			state.scenes = { byId: byId, byName: byName };
		});
	}

	/** 读 value-check 丢弃留痕。 */
	function loadDropLog() {
		return V.loadJsonl("../l1/value-check-log.jsonl").then(function (rows) {
			state.drops = rows;
		});
	}

	/**
	 * 取记录分片清单。
	 *
	 * 有写盘桥时走 `/api/l1/shards`（服务端能列目录 → **全部分片**）；否则退化为最近 N 天的
	 * 逐日探测（`file://` 与纯静态 http 下浏览器列不了目录）。旧版固定 60 天，会悄悄漏掉更早的
	 * 存量（实测 24 个分片里最早的在窗口之外）。
	 */
	function listShardDates() {
		return V.bridge("/api/l1/shards").then(function (r) {
			if (r.ok && r.data && Array.isArray(r.data.shards) && r.data.shards.length > 0) {
				state.source = "bridge";
				return r.data.shards.map(function (s) {
					return { file: s.file, rows: s.rows };
				});
			}
			state.source = "static";
			var out = [];
			var windowDays = 90;
			for (var i = 0; i < windowDays; i++) {
				var d = new Date(Date.now() - i * 86400000);
				out.push({ file: d.toISOString().slice(0, 10) + ".jsonl", rows: null });
			}
			return out;
		});
	}

	/** 加载全部记录分片（逐个 fetch，失败的静默跳过并计数）。 */
	function loadRecords() {
		return listShardDates().then(function (shards) {
			var tasks = shards.map(function (s) {
				return V.loadText("../l1/records/" + s.file).then(function (txt) {
					if (txt === null) return null;
					var rows = V.parseJsonl(txt, s.file);
					return { file: s.file, rows: rows };
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
				state.files = files;
				return records;
			});
		});
	}

	/** 给一批原始记录加质量分、场景解析、项目与 LWW 去重。 */
	function enrichAll(records) {
		// LWW：同一 id 取追加序最后一行（分片升序 + 行序）—— 与 record-loader.ts 同口径。
		// 分片是按日期倒序取的，所以要反着遍历才是"追加序"。
		var lastById = new Map();
		for (var i = records.length - 1; i >= 0; i--) {
			var rec = records[i];
			if (rec && typeof rec.id === "string") lastById.set(rec.id, rec);
		}
		var list = Array.from(lastById.values());

		var rows = list.map(function (rec) {
			var st = state.hitMap.get(rec.id);
			var q = VQ.calcQuality(rec, st, Date.now(), state.activeDays || undefined);
			return Object.assign({}, rec, {
				q: q,
				scene: resolveScene(rec),
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
		state.protectedPriority = VQ.protectedPriorityOf(alive);
		for (var j = 0; j < rows.length; j++) {
			rows[j].prune = VQ.judgePrune(rows[j], rows[j].q, state.protectedPriority);
		}
		return rows;
	}

	function autoLoad() {
		V.note("loadNote", "加载中…");
		state.errors = [];
		// 先定时钟（loadActiveDays 优先桥），再算分 —— 顺序不能反：quality 依赖 activeDays
		return loadActiveDays()
			.then(function (clockSource) {
				state.clockSource = clockSource;
				return Promise.all([loadHitStats(), loadScenes(), loadDropLog()]);
			})
			.then(loadRecords)
				.then(function (records) {
					state.rows = enrichAll(records);
					var clockLabel =
						state.clockSource === "bridge"
							? "活跃会话日 " + state.activeDays.length + " 个（源：l0/conversations，权威）"
							: state.clockSource === "sidecar"
								? "活跃会话日 " + (state.activeDays ? state.activeDays.length : 0) + " 个（源：hit-stats.json 侧车，可能滞后于 l0）"
								: "日历天（拿不到活跃日数据，已退化）";
					var srcLabel = state.source === "bridge" ? "写盘桥（全部分片）" : "静态探测（最近 90 天；更早的分片需要写盘桥）";
					// 页头只报**别处没有的**：总/存活/已删除、场景池、丢弃留痕都在侧栏【统计】组里，
					// 「显示 X / Y」由页签下的 #resultMeta 负责（它还会跟着筛选变）。同组数字在首屏
					// 抄两三遍，读者得自己判断这几个 840 是不是同一个 840。
					V.note(
						"loadNote",
						"来自 <b>" + state.files.length + "</b> 个分片 · 来源：" + srcLabel,
					);
					// 口径类信息（用哪种时钟、保护带取到多少）放默认收起的统计组 —— 它是健康信息，
					// 不是每次打开都要读一遍的东西。
					$("sourceNote").innerHTML =
						"时钟：" + clockLabel +
						"<br>保护带阈值 P" + VQ.PRUNE_RULES.protectedPercentile + " = " + state.protectedPriority;
					renderAll();
					return true;
			})
			.catch(function (e) {
				state.source = state.source || "static";
				V.note(
					"loadNote",
						"自动加载失败：" + V.escapeHtml(e && e.message ? e.message : String(e)) +
							"。请确认地址带了 <code>?port=</code> 且写盘桥在运行（<code>npm run viewer</code> 可一键起桥）。",
					"warn",
				);
				return false;
			});
	}

	// ── 筛选 ────────────────────────────────────────────────────────────────
	function filtered() {
		var f = state.filters;
		var rows = state.rows;

		if (f.onlyDeleted) rows = rows.filter(function (r) { return !!r.deleted; });
		else if (f.hideDeleted) rows = rows.filter(function (r) { return !r.deleted; });

		if (f.type) rows = rows.filter(function (r) { return (r.type || "(无 type)") === f.type; });

		if (f.task === "none") rows = rows.filter(function (r) { return !r.isTask; });
		else if (f.task) rows = rows.filter(function (r) { return r.isTask && r.taskState === f.task; });

		if (f.scene) rows = rows.filter(function (r) { return sceneBucket(r) === f.scene; });
		if (f.project) {
			rows = rows.filter(function (r) {
				return (r.project ? V.projectShort(r.project) : "(无项目)") === f.project;
			});
		}
		if (f.quality) rows = rows.filter(function (r) { return r.q.tag === f.quality; });
		if (f.date) {
			rows = rows.filter(function (r) {
				return String(r.createdAt || r.updatedAt || "").slice(0, 10) === f.date;
			});
		}
		if (f.q) {
			var needle = f.q.toLowerCase();
			rows = rows.filter(function (r) {
				var hay = [r.id, r.content, r.type, r.scene.canonical, r.scene.rawName, r.project, r.scope, r.cwd, r.sessionKey, JSON.stringify(r.metadata || {})]
					.join("\n")
					.toLowerCase();
				return hay.indexOf(needle) >= 0;
			});
		}

		var s = f.sort;
		rows = rows.slice().sort(function (a, b) {
			if (s === "quality-desc") return b.q.quality - a.q.quality;
			if (s === "quality-asc") return a.q.quality - b.q.quality;
			if (s === "updated-desc") return V.ts(b.updatedAt || b.createdAt) - V.ts(a.updatedAt || a.createdAt);
			if (s === "updated-asc") return V.ts(a.updatedAt || a.createdAt) - V.ts(b.updatedAt || b.createdAt);
			if (s === "prio-desc") return (b.priority || 0) - (a.priority || 0);
			if (s === "prio-asc") return (a.priority || 0) - (b.priority || 0);
			if (s === "type") return String(a.type).localeCompare(String(b.type)) || b.q.quality - a.q.quality;
			return 0;
		});
		return rows;
	}

	// ── 渲染：侧栏 ──────────────────────────────────────────────────────────
	function barRow(label, count, max, cls) {
		var w = max > 0 ? Math.round((count / max) * 100) : 0;
		return (
			'<div class="bar-row"><span>' + V.escapeHtml(label) + "</span>" +
			'<span class="bar-track"><i class="' + (cls || "") + '" style="width:' + w + '%"></i></span>' +
			'<span class="num">' + count + "</span></div>"
		);
	}

	function renderStats() {
		var all = state.rows;
		if (all.length === 0) {
			$("stats").innerHTML = '<div class="stat"><span>已加载</span><span>0</span></div>';
			$("qualityStats").innerHTML = "";
			$("typeList").innerHTML = "";
			$("sceneList").innerHTML = '<option value="">全部场景</option>';
			$("sceneNote").textContent = "";
			$("projectList").innerHTML = '<option value="">全部项目</option>';
			$("fileList").textContent = "尚未加载";
			$("taskCounts").innerHTML = "";
			return;
		}
		var alive = all.filter(function (r) { return !r.deleted; });
		var deleted = all.length - alive.length;
		var pruneCount = alive.filter(function (r) { return r.prune.eligible; }).length;
		var types = new Set(all.map(function (r) { return r.type || "(无 type)"; }));

		$("stats").innerHTML = [
			["总条数（LWW 后）", all.length],
			["存活", alive.length],
			["已删除", deleted],
			["类型数", types.size],
			["淘汰候选", pruneCount],
			["命中统计条目", state.hitMap.size],
			["场景池", state.scenes.byId.size],
			["丢弃留痕", state.drops.length],
		]
			.map(function (kv) {
				return '<div class="stat"><span>' + kv[0] + "</span><span>" + kv[1] + "</span></div>";
			})
			.join("");

		// 质量分布：标签 + 分数直方图（只在存活记录上算，与 quality.ts 口径一致）
		var dist = { 热: 0, 温: 0, 冷: 0, 新: 0, 噪: 0, 待观察: 0 };
		alive.forEach(function (r) { dist[r.q.tag] = (dist[r.q.tag] || 0) + 1; });
		var maxTag = Math.max.apply(null, Object.keys(dist).map(function (k) { return dist[k]; }).concat([1]));
		var hist = {
			"0-2": alive.filter(function (r) { return r.q.quality >= 0 && r.q.quality < 2; }).length,
			"2-4": alive.filter(function (r) { return r.q.quality >= 2 && r.q.quality < 4; }).length,
			"4-6": alive.filter(function (r) { return r.q.quality >= 4 && r.q.quality < 6; }).length,
			"6+": alive.filter(function (r) { return r.q.quality >= 6; }).length,
		};
		var maxHist = Math.max.apply(null, Object.keys(hist).map(function (k) { return hist[k]; }).concat([1]));
		// 温度色一律用 .c-* 工具类（viewer.css），JS 不再自带色值副本。
		// 曾把「待观察」错映射到 warm（琥珀），于是侧栏图例说是灰、条形图却是琥珀 —— 图例与图必须同色。
		var tagClass = { 热: "c-hot", 温: "c-warm", 冷: "c-cold", 新: "c-new", 噪: "c-noise", 待观察: "c-watch" };

			// 这三个标题现在挂在「统计」组的 <details> 内，组标题是外层 h2 —— 组内一律降级为
			// h3.sub，否则展开后会出现 4 个同级 h2，分组反而看不出来了。
			$("qualityStats").innerHTML =
				'<h3 class="sub">质量标签</h3><div class="bars">' +
				Object.keys(dist)
					.map(function (k) { return barRow(k, dist[k], maxTag, tagClass[k]); })
					.join("") +
				'</div><h3 class="sub">质量分直方图</h3><div class="hist">' +
			Object.keys(hist)
				.map(function (k) {
					return (
						'<div class="col"><span class="val">' + hist[k] + "</span>" +
						'<span class="fill" style="height:' + Math.round((hist[k] / maxHist) * 100) + '%"></span>' +
						'<span class="lbl">' + k + "</span></div>"
					);
				})
				.join("") +
			"</div>" +
			'<h3 class="sub">淘汰候选（judgePrune 可判删）</h3><div class="hint">' +
			(alive.length > 0
				? "候选 <b>" + pruneCount + "</b> / 存活 " + alive.length +
					"（保护带 priority ≥ " + state.protectedPriority + "，按分布 P" + VQ.PRUNE_RULES.protectedPercentile + " 取）<br>" +
					"被真实证伪 <b>" + alive.filter(function (r) { return r.prune.reason === "falsified"; }).length + "</b>；" +
					"长期闲置且低价值 <b>" + alive.filter(function (r) { return r.prune.reason === "idle-low-value"; }).length + "</b>"
				: "无存活记录") +
			'</div><div class="hint" style="margin-top:6px"><a href="#" id="filterPrune">只看淘汰候选</a></div>';

		// 类型筛选（含非任务记录）
		var counts = V.groupCount(all, function (r) { return r.type || "(无 type)"; });
		var aliveCounts = new Map();
		alive.forEach(function (r) {
			var t = r.type || "(无 type)";
			aliveCounts.set(t, (aliveCounts.get(t) || 0) + 1);
		});
		$("typeList").innerHTML =
			'<button type="button" class="' + (state.filters.type === "" ? "active" : "") + '" data-type=""><span>全部</span><span class="n"><span class="alive">' +
			alive.length + "</span>/" + all.length + "</span></button>" +
			counts
				.map(function (c) {
					return (
						'<button type="button" class="' + (state.filters.type === c.key ? "active" : "") + '" data-type="' + V.escapeHtml(c.key) + '">' +
						"<span>" + V.escapeHtml(c.key) + '</span><span class="n"><span class="alive">' + (aliveCounts.get(c.key) || 0) + "</span>/" + c.count + "</span></button>"
					);
				})
				.join("");

		// 任务状态统计（独立于 deleted 轴）
		var tasks = all.filter(function (r) { return r.isTask && !r.deleted; });
		$("taskCounts").innerHTML =
			'<div class="hint">work_task 存活 ' + tasks.length + " 条：" +
			["open", "done", "dropped"]
				.map(function (s) {
					return V.TASK_STATE_LABELS[s] + " <b>" + tasks.filter(function (r) { return r.taskState === s; }).length + "</b>";
				})
				.join("，") +
			"</div>";

		// 场景 / 项目下拉（取前 40 项，避免长列表把侧栏撑爆）
		// 场景桶用 sceneBucket：池中 canonical 与"未归类的历史名字"分开列，不混成一层
		var sceneCounts = V.groupCount(alive, sceneBucket);
		var unclassified = sceneCounts.filter(function (c) { return c.key.indexOf("未归类") === 0; }).reduce(function (n, c) { return n + c.count; }, 0);
		$("sceneList").innerHTML =
			'<option value="">全部场景（' + sceneCounts.length + ' 个分组）</option>' +
			sceneCounts
				.slice(0, 40)
				.map(function (c) {
					return '<option value="' + V.escapeHtml(c.key) + '"' + (state.filters.scene === c.key ? " selected" : "") + ">" + V.escapeHtml(c.key) + "（" + c.count + "）</option>";
				})
				.join("");
		$("sceneNote").innerHTML =
			"池中 <b>" + sceneCounts.filter(function (c) { return c.key.indexOf("未归类") !== 0 && c.key !== "(无场景)"; }).length +
			"</b> 个分组已对上 <code>scenes.json</code>；<b>" + unclassified +
			"</b> 条记录的场景名不在池中（历史快照，标着「未归类」）—— 这类只在记录里存在，别当成有效分组看。";
		var projectCounts = V.groupCount(alive, function (r) { return r.project ? V.projectShort(r.project) : "(无项目)"; });
		$("projectList").innerHTML =
			'<option value="">全部项目（' + projectCounts.length + '）</option>' +
			projectCounts
				.slice(0, 40)
				.map(function (c) {
					return '<option value="' + V.escapeHtml(c.key) + '"' + (state.filters.project === c.key ? " selected" : "") + ">" + V.escapeHtml(c.key) + "（" + c.count + "）</option>";
				})
				.join("");

		// 日期下拉
		var dates = V.groupCount(all, function (r) { return String(r.createdAt || r.updatedAt || "(无日期)").slice(0, 10); });
		$("dateFilter").innerHTML =
			'<option value="">全部日期</option>' +
			dates
				.map(function (c) {
					return '<option value="' + V.escapeHtml(c.key) + '"' + (state.filters.date === c.key ? " selected" : "") + ">" + V.escapeHtml(c.key) + "（" + c.count + "）</option>";
				})
				.join("");

		$("fileList").textContent = state.files.length ? state.files.slice(-12).join("、") + (state.files.length > 12 ? " …（共 " + state.files.length + " 个）" : "") : "尚未加载";
	}

	// ── 渲染：记录卡片 ──────────────────────────────────────────────────────
	/** 状态药丸：只用于「已确定的状态」（deleted / 任务状态 / 温度 / 淘汰候选 / 场景归属）。 */
	function chip(text, cls, title) {
		return '<span class="chip ' + (cls || "") + '"' + (title ? ' title="' + V.escapeHtml(title) + '"' : "") + ">" + V.escapeHtml(text) + "</span>";
	}

	/**
	 * 度量 token：等宽、无边框、扁平方块，用于「量出来的数」。
	 *
	 * 与 chip 分开是刻意的：旧版把 eff / hits / decay / days / 日期 / id 也做成彩色药丸，
	 * 一张卡片 12 个药丸，读者分不出哪个是状态、哪个是读数。形状编码种类见 viewer.css 契约 2。
	 *
	 * @param text 显示文本（调用方不必转义，这里统一转义）
	 * @param title 可选 title
	 * @param cls 额外类（如 "id"，让记录 id 更显眼）
	 */
	function metric(text, title, cls) {
		return (
			'<span class="metric' + (cls ? " " + cls : "") + '"' + (title ? ' title="' + V.escapeHtml(title) + '"' : "") + ">" + V.escapeHtml(text) + "</span>"
		);
	}

	function renderRecords(rows) {
		state.lastRows = rows;
		$("resultMeta").textContent = "显示 " + rows.length + " / " + state.rows.length + " 条（类型 + 任务状态 + 场景 + 项目 + 质量 + 日期 联合筛选）";
		if (rows.length === 0) {
			$("list").className = "empty";
			$("list").innerHTML = state.rows.length
				? "<strong>无匹配结果</strong>试试放宽筛选或清空搜索。"
				: "<strong>还没有数据</strong>点上方「重新加载」从写盘桥取数。";
			return;
		}
		$("list").className = "cards";
		var maxQ = Math.max.apply(null, rows.map(function (r) { return r.q.quality; }).concat([1]));
		// 温度 → 工具类；色值只在 viewer.css 里有一份（旧版这里内联了第二份十六进制副本）
		var barClass = { 热: "c-hot", 温: "c-warm", 冷: "c-cold", 新: "c-new", 噪: "c-noise", 待观察: "c-watch" };
		$("list").innerHTML = rows
			.map(function (r, idx) {
				var q = r.q;
				var qClass = V.QUALITY_CLASS[q.tag] || "";
				var barH = Math.min(100, Math.round((q.quality / maxQ) * 100));

				// ── 状态药丸：少而显眼（形状=药丸，见 viewer.css 契约 2）
				var chips = [chip(r.type || "unknown", "type")];
				if (r.priority !== undefined && r.priority !== null) chips.push(chip("P" + r.priority, "prio"));
				// 两根独立的轴：deleted 与 taskState 都要出现，不能合并
				if (r.deleted) chips.push(chip("deleted", "del", "记录不成立（查重覆盖 / 纠错作废）—— 与任务状态是两根独立的轴"));
				if (r.isTask) {
					chips.push(
						chip(V.TASK_STATE_LABELS[r.taskState], "task-" + r.taskState,
							r.audit.taskStateChange ? "审计：" + r.audit.taskStateChange.at + " by " + r.audit.taskStateChange.by : "缺省即待办"),
					);
				}
				// 淘汰候选是「建议」不是「事实」，故用琥珀 prune 而不是 deleted 的红
				if (r.prune.eligible) chips.push(chip("淘汰候选", "prune", VQ.PRUNE_REASON_LABELS[r.prune.reason] || r.prune.reason));
				// 温度：词在前、分数在后，不用「A · B」中点拼接
				chips.push(chip(q.tag + " " + fmtQ(q.quality), qClass, "质量分 " + fmtQ(q.quality) + " —— 热度，按天数衰减"));

				// 场景 chip：已知（池中）与未知必须**看起来不同** —— 记录里的 scene_name 只是落盘快照，
				// 把不在池中的旧名字当 canonical 平铺展示，正是这次要消除的那种混淆。
				var sceneChip;
				if (r.scene.known && r.scene.canonical) {
					sceneChip = chip(r.scene.canonical + (r.scene.merged ? " 已合并" : ""), "scene" + (r.scene.merged ? " merged" : ""), r.scene.note || "scene_id " + r.scene.id);
				} else if (r.scene.canonical) {
					sceneChip = chip(r.scene.canonical + "（未归类）", "scene unclassified", "这是历史快照里的原始 scene_name，不在 l1/scenes.json 池中 —— " + (r.scene.note || ""));
				} else {
					sceneChip = chip("未归类", "scene unclassified", r.scene.note || "无场景信息");
				}
				if (r.project) chips.push(chip(V.projectShort(r.project), "", r.project));
				else chips.push(chip("无项目", "", "metadata.project 为空"));

				// ── 度量 token：列表层只留一个「多久没动」。
				// eff / hits / 注入 / decay / 活跃天 / 日期 / id 这些是**诊断值**，要排查衰减或
				// 命中时才用得上；详情弹层里它们一个不少（其中 eff/hits/decay/天数/日期/id 本来
				// 就各出现了两处）。列表层留 8 个胶囊而不是 15 个，是为了让 567 张卡里真正
				// 该被扫到的东西（类型 / 状态 / 温度 / 场景）不被一排等宽数字淹没。
				var metrics = [metric(V.fromNow(r.updatedAt || r.createdAt), "最后更新于 " + V.fmtTime(r.updatedAt || r.createdAt))];

				return (
					'<article class="card' + (r.deleted ? " deleted" : "") + '" data-idx="' + idx + '">' +
					// 勾选框放在 chips 行首（而不是浮在卡片角上）：不新增定位层，也不遮挡正文。
					// data-sel 用**记录 id**（见 state.selected 注释），data-sel-label 供点击委托识别。
					'<div class="card-head" data-toggle><div class="chips">' +
					'<label class="check" data-sel-label title="加入批量选择"><input type="checkbox" data-sel="' +
					V.escapeHtml(r.id || "") + '"' + (state.selected.has(r.id) ? " checked" : "") + " /></label>" +
					chips.join("") + sceneChip + "</div></div>" +
					'<div class="qbar"><i class="' + (barClass[q.tag] || "c-watch") + '" style="width:' + barH + '%"></i></div>' +
					'<div class="card-body" data-toggle><div class="full-content">' + V.escapeHtml(r.content || "") + "</div></div>" +
					'<div class="card-foot"><div class="chips">' + metrics.join("") + "</div>" +
					'<button type="button" class="expand-btn" data-open="' + idx + '">查看完整记录</button></div>' +
					"</article>"
				);
			})
			.join("");
	}

	// ── 渲染：丢弃留痕 ──────────────────────────────────────────────────────
	function renderDrops() {
		var q = (state.filters.q || "").toLowerCase();
		var rows = state.drops.filter(function (d) {
			if (!q) return true;
			var rec = d.record || {};
			return [d.reason, d.action, rec.content, rec.type, rec.id, d.id].join("\n").toLowerCase().indexOf(q) >= 0;
		});
		$("dropMeta").textContent = "显示 " + rows.length + " / " + state.drops.length + " 条（value-check 判 drop 的记录从不写进库，这里是它们唯一的留痕）";
		if (rows.length === 0) {
			$("dropList").innerHTML = state.drops.length
				? "<strong>无匹配结果</strong>"
				: "<strong>没有丢弃留痕</strong><code>l1/value-check-log.jsonl</code> 不存在或为空。";
			return;
		}
		$("dropList").innerHTML =
			'<div class="wrap-scroll"><table><thead><tr><th>时间</th><th>动作</th><th>记录 id</th><th>类型</th><th>P</th><th>场景</th><th>丢弃理由</th><th>正文</th></tr></thead><tbody>' +
			rows
				.map(function (d) {
					var rec = d.record || {};
					var scene = rec.scene_id ? ((state.scenes.byId.get(rec.scene_id) || {}).name || rec.scene_id || rec.scene_name) : rec.scene_name || "—";
					var reason = d.reason || "";
					var body = rec.content || (d.action === "revoke-tombstone" ? "（撤销墓碑：" + (d.id || "") + " → " + (d.replacedBy || "") + "）" : "");
					var rid = rec.id || d.id || "—";
					return (
						"<tr><td>" + V.escapeHtml(V.fmtTime(d.at)) + '</td><td><span class="chip">' + V.escapeHtml(d.action || "") + "</span></td>" +
						'<td><span class="chip mono">' + V.escapeHtml(rid) + "</span></td>" +
						"<td>" + V.escapeHtml(rec.type || "—") + '</td><td class="num">' + (rec.priority === undefined ? "—" : V.escapeHtml(rec.priority)) + "</td>" +
						"<td>" + V.escapeHtml(scene) + "</td>" +
						'<td style="max-width:300px">' + V.escapeHtml(reason) + "</td>" +
							// overflow-wrap:anywhere —— pre-wrap 只在允许的断点换行，一个长 token
							// （如 `/my-memory:l2-trigger`）会整段顶出格子 31px 压到右侧空白
							'<td style="max-width:460px;white-space:pre-wrap;overflow-wrap:anywhere">' + V.escapeHtml(body) + "</td></tr>"
					);
				})
				.join("") +
			"</tbody></table></div>";
	}

	function renderAll() {
		renderStats();
		var rows = filtered();
		renderRecords(rows);
		renderDrops();
		// 选择条与卡片是两份渲染：卡片重画后必须同步一次，否则"全选/清空"后的计数会停在旧值
		renderSelectionBar();
	}

	// ── 批量选择 ────────────────────────────────────────────────────────────
	/** 勾选/取消一条（on = 目标状态，不读 DOM，避免与重画竞争）。 */
	function toggleSelected(id, on) {
		if (!id) return;
		if (on) state.selected.add(id);
		else state.selected.delete(id);
		renderSelectionBar();
	}

	/** 选中集合里仍在场的记录（记录可能因重新加载而不在 state.rows 里）。 */
	function selectedRows() {
		return state.rows.filter(function (r) {
			return state.selected.has(r.id);
		});
	}

	/** 选择条：只在有勾选时出现；计数器用<b>而不是自己拼粗体，避免把数字当 HTML 打进去。 */
	function renderSelectionBar() {
		var n = state.selected.size;
		$("selBar").style.display = n > 0 ? "" : "none";
		$("selCount").innerHTML = "已选 <b>" + n + "</b> 条";
		if (n === 0) {
			// 没有选中就没有可删的东西：把待确认的墓碑一并作废，免得留下一条"幽灵确认"
			state.pendingTombstone = null;
		}
		renderSelConfirm();
	}

	/** 墓碑二次确认条：逐条列出将被删除的 id（这是"点了不可逆"的唯一凭据）。 */
	function renderSelConfirm() {
		var ids = state.pendingTombstone;
		var box = $("selConfirm");
		if (!ids || ids.length === 0) {
			box.hidden = true;
			box.innerHTML = "";
			return;
		}
		box.hidden = false;
		box.className = "notice warn";
		box.innerHTML =
			"<b>墓碑删除</b>：就地写 <code>deleted:true</code>（记录连同向量退出召回），自动备份、可用危险区的整库还原回退，<b>不可逐条撤销</b>。确认删除以下 <b>" +
			ids.length + "</b> 条？" +
			'<ul class="diff-list">' +
			ids
				.slice(0, 20)
				.map(function (id) {
					return '<li class="del">' + V.escapeHtml(id) + "</li>";
				})
				.join("") +
			(ids.length > 20 ? '<li class="more">…还有 ' + (ids.length - 20) + " 条</li>" : "") +
			"</ul>" +
			'<div class="toolbar"><button type="button" class="danger" id="selConfirmYes">确认删除 ' + ids.length + " 条</button>" +
			'<button type="button" id="selConfirmNo">取消</button></div>';
	}

	/**
	 * 批量标记任务状态：**一次请求**带上全部选中 id（task-state 端点本就接受 ids 数组）。
	 *
	 * 只有 work_task 承载任务状态，选中的非任务记录会被 CLI 逐条判错 —— 所以这里如实报"成功/失败"
	 * 两个数，而不是把整批当成功。
	 */
	function applyTaskStateBatch(target) {
		var ids = Array.from(state.selected);
		if (ids.length === 0 || !V.bridgePort()) return;
		V.note("selNote", "正在标记 " + ids.length + " 条为「" + V.escapeHtml(V.TASK_STATE_LABELS[target]) + "」…");
		V.bridge("/api/task-state", {
			method: "POST",
			body: JSON.stringify({ ids: ids, state: target }),
		}).then(function (r) {
			var d = r.data || {};
			if (d.error) {
				V.note("selNote", "批量标记失败：" + V.escapeHtml(String(d.error)), "err");
				return;
			}
			if (!r.ok && d.results === undefined) {
				V.note("selNote", "批量标记失败：HTTP " + r.status, "err");
				return;
			}
			var changed = d.changed === undefined ? ids.length - (d.failed || 0) : d.changed;
			var failed = d.failed || 0;
			// 就地同步本地状态（服务端只改状态字段），不为一次标记重载全部分片
			state.rows.forEach(function (row) {
				if (!state.selected.has(row.id) || !row.isTask) return;
				row.taskState = target;
				row.audit.taskStateChange = { from: "", to: target, at: new Date().toISOString(), by: "user" };
			});
			V.note(
				"selNote",
				"已标记 <b>" + changed + "</b> 条为「" + V.escapeHtml(V.TASK_STATE_LABELS[target]) + "」" +
					(failed > 0 ? "，<b>" + failed + "</b> 条失败（只有 work_task 承载任务状态）" : "") + "。",
				failed > 0 ? "warn" : "",
			);
			renderAll();
		});
	}

	/** 批量墓碑（删除）：真正写盘的入口，只在确认条上点「确认删除」后到达。 */
	function applyTombstoneBatch(ids) {
		if (ids.length === 0 || !V.bridgePort()) return;
		V.note("selNote", "正在删除 " + ids.length + " 条…");
		V.bridge("/api/tombstone", { method: "POST", body: JSON.stringify({ ids: ids }) }).then(function (r) {
			if (!r.ok || !r.data || r.data.success === false) {
				V.note("selNote", "批量删除失败：" + V.escapeHtml(String((r.data && r.data.error) || "未知错误")), "err");
				return;
			}
			ids.forEach(function (id) {
				state.rows.forEach(function (row) {
					if (row.id === id) row.deleted = true;
				});
			});
			state.selected = new Set();
			state.pendingTombstone = null;
			V.note("selNote", "已就地标记 deleted:true（自动备份已生成，可用危险区的整库还原回退）。");
			renderAll();
		});
	}

	/** 导出选中：导出的是选中记录本身（不是当前筛选），与"导出当前视图"是两件事。 */
	function exportSelected() {
		var rows = selectedRows();
		if (rows.length === 0) {
			V.note("selNote", "没有可导出的选中记录（选中的 id 可能已不在当前加载的数据里）。", "warn");
			return;
		}
		V.download("l1-selected-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(rows, null, 2));
	}

	// ── L1 管理操作区（侧栏） ────────────────────────────────────────────────
	/** 字节 → 人类可读（只用于备份大小比较，不参与任何判定）。 */
	function fmtBytes(n) {
		if (typeof n !== "number" || Number.isNaN(n)) return "—";
		if (n < 1024) return n + " B";
		if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
		return (n / 1024 / 1024).toFixed(1) + " MB";
	}

	/**
	 * 读管理操作区要用的全部只读状态。
	 *
	 * 无桥时**不发请求**（桥根本不存在），直接把面板渲染成禁用态 —— 与页面顶部提示条同一口径。
	 */
	function loadOps() {
		if (!V.bridgePort()) {
			state.ops.loaded = true;
			// "管理操作区加载中…" 必须被换掉：面板其实已经渲染成禁用态了，而这句话会永远停在那儿
			// —— 一行说谎的状态提示比没有提示更糟（本项目反复踩过"静默误导"这一类）。
			V.note("opsNote", "无写盘桥：管理动作全部禁用，只能看。带 <code>?port=</code> 打开即可用。", "warn");
			renderOps();
			return Promise.resolve();
		}
		// 触发 / 待消费信号 / 停止子代理已搬到「流水线」页（pipeline-viewer.html），
		// 所以这里不再取 /api/pending-triggers 与 /api/subagent-runs —— 两个端点各少一次往返，
		// 也少一份会在两处显示同一事实的读数。
		return Promise.all([
			V.bridge("/api/limits"),
			V.bridge("/api/l1/embeddings"),
			V.bridge("/api/l1/backups"),
		]).then(function (r) {
			state.ops.mode = r[0].ok && r[0].data && r[0].data.l1 && r[0].data.l1.mode ? r[0].data.l1.mode : null;
			state.ops.modeError = state.ops.mode ? "" : (r[0].data && r[0].data.error) || "读取失败";
			var emb = r[1];
			state.ops.embedding = emb.ok && emb.data && emb.data.status ? emb.data.status : null;
			state.ops.embeddingError = state.ops.embedding ? "" : (emb.data && emb.data.error) || "读取失败";
			state.ops.backups = r[2].ok && r[2].data && Array.isArray(r[2].data.backups) ? r[2].data.backups : [];
			state.ops.loaded = true;
			// 同上：加载完成必须把"加载中…"换掉。顺带报出有几项没读到 —— 单项失败在面板里已有说明，
			// 这里给的是"整体是否可信"的一句话。
			var failed = [r[0], r[1], r[2]].filter(function (x) { return !x.ok; }).length;
			V.note(
				"opsNote",
				failed === 0
					? "写盘桥已连接：下面每个动作都注明是否落盘（标「预演」的不写，要按「确认执行」才写）。"
					: "写盘桥已连接，但有 " + failed + " 项状态没读到 —— 面板里对应格子会写出原因，别把空白当默认值。",
				failed === 0 ? "" : "warn",
			);
			renderOps();
		});
	}

	/** 只重取向量库状态（回填/重建后条数会变）。 */
	function refreshOpsEmbedding() {
		return V.bridge("/api/l1/embeddings").then(function (r) {
			state.ops.embedding = r.ok && r.data && r.data.status ? r.data.status : null;
			if (!state.ops.embedding) state.ops.embeddingError = (r.data && r.data.error) || "读取失败";
			renderOps();
		});
	}

	/** 只重取备份清单（整库还原会新生成一份 pre-rollback 备份）。 */
	function refreshOpsBackups() {
		return V.bridge("/api/l1/backups").then(function (r) {
			state.ops.backups = r.ok && r.data && Array.isArray(r.data.backups) ? r.data.backups : [];
			renderOps();
		});
	}

	/** 无桥时的统一提示（措辞与页面既有"无写盘桥"文案同源）。 */
	function opsReadOnlyHint() {
		return '<div class="hint">写回需要写盘桥：请用带 <code>?port=</code> 的地址打开本页（<code>npm run viewer</code> 一键起桥）。只读模式下这里的按钮全部禁用。</div>';
	}

	/** 还原按钮的可用性 = 输入的目录名与所选备份**逐字相等**（与桥的 confirm 副验同口径）。 */
	function syncRollbackApply() {
		var sel = $("rbBackup");
		var input = $("rbConfirm");
		var btn = $("rbApply");
		if (!sel || !input || !btn) return;
		var chosen = sel.value;
		var typed = input.value.trim();
		var ok = !!chosen && typed === chosen && !!V.bridgePort();
		btn.disabled = !ok;
		btn.title = ok ? "与桥的 confirm 副验一致，将执行整库还原" : "必须逐字输入所选备份目录名（" + chosen + "）";
	}

	/** 重建的「确认执行」要等用户键入 REBUILD；回填无需打字。 */
	function syncEmbedApply() {
		var btn = $("opsEmbedApply");
		if (!btn) return;
		if (state.ops.embedOp !== "rebuild") {
			btn.disabled = !V.bridgePort();
			return;
		}
		var input = $("opsRebuildConfirm");
		btn.disabled = !V.bridgePort() || !input || input.value.trim() !== "REBUILD";
	}

	/** 渲染整块管理操作区（含危险区）。值全部来自 state.ops，纯函数式重画。 */
	function renderOps() {
		var o = state.ops;
		var ro = !V.bridgePort();
		var dis = ro ? " disabled" : "";

		// ── 提取模式 ──
		var modeRow =
			'<div class="ops-row" id="opsModeRow">' +
			'<div class="ops-label">提取模式</div>' +
			'<div class="ops-ctl">' +
			'<button type="button" id="opsModeCode" class="' + (o.mode === "code" ? "primary" : "") + '"' + dis + ">code</button>" +
			'<button type="button" id="opsModeChat" class="' + (o.mode === "chat" ? "primary" : "") + '"' + dis + ">chat</button>" +
			"</div>" +
			'<div class="ops-note">当前 <b>' + V.escapeHtml(o.mode || (o.loaded ? "未知" : "读取中…")) + "</b>（真源 <code>/api/limits.l1.mode</code>" +
			(o.modeError ? "，读取失败：" + V.escapeHtml(o.modeError) : "") +
			"）。立即写盘、可逆、幂等（改 <code>application-propertis.json</code> 的 l1.mode），影响下一轮提取取向。</div>" +
			"</div>";

		// 触发提取与停止子代理**不在这里**：它们已搬到「流水线」页（pipeline-viewer.html），
		// 与 L2/L3 的同名动作合成一张三层表 —— 同一件事在三页各写一份是分叉的温床。

		// ── 向量库（长任务：桥单线程同步执行，期间整座桥不响应） ──
		var st = o.embedding;
		var embedStat = st
			? metric("向量 " + st.vectorizedCount + "/" + st.totalRecords, "已向量化 / 总记录") + metric("缺 " + st.unVectorizedCount, "未向量化条数")
			: '<span class="hint">' + V.escapeHtml(o.embeddingError || (o.loaded ? "读不到向量库状态" : "读取中…")) + "</span>";
		var busyEmbed = o.busy === "embedding";
		var steps = "";
		if (o.embedOp) {
			var v = o.embedVerdict || { ok: true, text: "" };
			steps =
				'<div id="opsEmbedVerdict" class="notice' + (v.ok ? "" : " warn") + '">' + v.text + "</div>" +
				(o.embedLog ? '<details class="log" open><summary>CLI 输出</summary><pre class="log-text">' + V.escapeHtml(o.embedLog) + "</pre></details>" : "") +
				'<div class="ops-ctl" style="margin-top:6px">' +
				(o.embedOp === "rebuild"
					? '<span class="confirm-token">REBUILD</span><input type="text" class="confirm-input" id="opsRebuildConfirm" placeholder="输入 REBUILD 以解锁执行"' + (ro ? " disabled" : "") + " />"
					: "") +
				'<button type="button" class="danger" id="opsEmbedApply"' + (ro || o.embedOp === "rebuild" ? " disabled" : "") + ">确认执行" + (o.embedOp === "rebuild" ? "重建" : "回填") + "</button>" +
				'<button type="button" id="opsEmbedCancel">取消</button>' +
				"</div>";
		}
		var embedRow =
			'<div class="ops-row' + (busyEmbed ? " busy" : "") + '" id="opsEmbedRow">' +
			'<div class="ops-label">向量库</div>' +
			'<div class="ops-ctl">' + embedStat +
			'<button type="button" id="opsBackfill"' + dis + ">回填：预演</button>" +
			'<button type="button" id="opsRebuild"' + dis + ">重建：预演</button>" +
			(busyEmbed ? '<span class="busy-flag">运行中（桥被占满，勿重复点）</span>' : "") +
			"</div>" +
			'<div class="ops-note">回填只补缺失向量；<b>重建会先清空向量库再全量重算</b>（中途失败 = 库空，需打字确认）。两者都是长任务：桥单线程同步执行，跑起来后整座桥都不响应。</div>' +
			'<div id="opsEmbedSteps" style="grid-column: 1 / -1">' + steps + "</div>" +
			"</div>";

		// ── 危险区：整库还原（不是单条撤销） ──
		var bk = o.backups || [];
		var chosen = o.rollbackBackup && bk.some(function (b) { return b.dir === o.rollbackBackup; })
			? o.rollbackBackup
			: (bk.length ? bk[bk.length - 1].dir : "");
		var options = bk.length
			? bk
					.slice()
					.reverse()
					.map(function (b) {
						// 时间与分片数放最前：闭合状态下拉框很窄，而 5 个 backfill-* 目录只有末尾
						// 时间戳不同 —— 目录名打头的话它们在框里显示成一模一样的「backfill-project-」，
						// 根本分不开。完整目录名仍在后面的「打字确认」token 里逐字显示。
						return (
							'<option value="' + V.escapeHtml(b.dir) + '"' + (b.dir === chosen ? " selected" : "") + ">" +
							V.escapeHtml(V.fmtTime(b.mtime)) + " · " + b.shards + " 分片 / " + fmtBytes(b.bytes) +
							" · " + V.escapeHtml(b.dir) + "</option>"
						);
					})
					.join("")
			: '<option value="">（没有备份）</option>';
		var rbBusy = o.busy === "rollback";
		var danger =
			'<div class="danger-zone" id="opsDanger">' +
			"<h3>危险区 · 整库还原（L1）</h3>" +
			'<div class="ops">' +
			'<div class="ops-row' + (rbBusy ? " busy" : "") + '">' +
			'<div class="ops-label">选择备份</div>' +
			'<div class="ops-ctl"><select id="rbBackup"' + (ro || bk.length === 0 ? " disabled" : "") + ">" + options + "</select>" +
			'<button type="button" id="rbPreview"' + (ro || !chosen ? " disabled" : "") + ">预演</button></div>" +
			'<div class="ops-note">整库还原 = 删掉当前 L1 全部 <code>.jsonl</code> 再复制备份内容，<b>不是单条撤销</b>；当前库会先自动备份一份（pre-rollback）。预演只比对，不写盘。</div>' +
			"</div>" +
			'<div class="ops-row' + (rbBusy ? " busy" : "") + '">' +
			'<div class="ops-label">打字确认</div>' +
			'<div class="ops-ctl">' +
			'<span class="confirm-token" id="rbToken">' + V.escapeHtml(chosen || "(无备份)") + "</span>" +
			'<input type="text" class="confirm-input" id="rbConfirm" placeholder="逐字输入所选备份目录名" value="' + V.escapeHtml(o.rollbackConfirm || "") + '"' + (ro || !chosen ? " disabled" : "") + " />" +
			'<button type="button" class="danger" id="rbApply" disabled>执行还原</button>' +
			(rbBusy ? '<span class="busy-flag">还原中（桥被占满，勿重复点）</span>' : "") +
			"</div>" +
			'<div class="ops-note">必须逐字输入上面显示的备份目录名 —— 与桥的 confirm 副验一致；输入正确前「执行还原」保持禁用。</div>' +
			"</div>" +
			'<div id="rbLog">' + (o.rollbackPreviewHtml || "") + "</div>" +
			"</div></div>";

		$("l1ops").innerHTML =
			(ro ? opsReadOnlyHint() : "") +
			'<h3 class="sub">提取模式</h3>' + modeRow +
			'<h3 class="sub">向量库</h3>' + embedRow +
			danger;
		syncRollbackApply();
		syncEmbedApply();
	}

	// ── 管理操作：写动作 ────────────────────────────────────────────────────
	/** 切换 L1 提取模式（唯一无预演的写动作：可逆、幂等，CLI 自己读写确认）。 */
	function setL1Mode(mode) {
		if (!V.bridgePort()) return;
		state.ops.busy = "mode";
		renderOps();
		V.bridge("/api/l1/mode", { method: "POST", body: JSON.stringify({ mode: mode }) }).then(function (r) {
			state.ops.busy = "";
			var d = r.data || {};
			if (!r.ok || d.success === false) {
				V.note("opsNote", "模式切换失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
				renderOps();
				return;
			}
			state.ops.mode = d.mode || mode;
			V.note("opsNote", "提取模式已切到 <b>" + V.escapeHtml(state.ops.mode) + "</b>（" + (d.changed === false ? "值未变" : "已写入并回读确认") + "）。");
			renderOps();
		});
	}

	// 请求触发 L1 / 停止 L1 子代理这两个动作已搬到「流水线」页（pipeline-viewer.html）。
	// 之所以搬：它们是**跨三层的同一件事**，而且都需要"队列里现在有什么、哪条在跑"的上下文 ——
	// 那种上下文只在流水线页上才有（这里只能看到 L1 自己的一格）。

	/** 向量回填/重建的**预演**：只报"现在缺多少条"与后续代价，不写盘。 */
	function previewEmbedding(op) {
		if (!V.bridgePort()) return;
		state.ops.embedOp = op;
		state.ops.embedVerdict = { ok: true, text: "预演中…" };
		state.ops.embedLog = "";
		renderOps();
		V.bridge("/api/l1/embedding", { method: "POST", body: JSON.stringify({ op: op }) }).then(function (r) {
			var d = r.data || {};
			if (!r.ok || d.success === false) {
				state.ops.embedOp = "";
				state.ops.embedVerdict = null;
				V.note("opsNote", "预演失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
				renderOps();
				return;
			}
			var s = d.status || state.ops.embedding;
			var text =
				"预演通过（dry-run，未写盘）。" +
				(s ? "总 " + s.totalRecords + " 条，已向量化 " + s.vectorizedCount + "，缺 " + s.unVectorizedCount + "。" : "") +
				" " + V.escapeHtml(d.note || "");
			state.ops.embedVerdict = { ok: true, text: text };
			renderOps();
		});
	}

	/** 向量回填/重建的**执行**：长任务 —— 期间桥整座阻塞，所以先置 busy 再发请求。 */
	function applyEmbedding() {
		if (!V.bridgePort()) return;
		var op = state.ops.embedOp;
		if (!op) return;
		var body = { op: op, apply: true };
		if (op === "rebuild") {
			var input = $("opsRebuildConfirm");
			if (!input || input.value.trim() !== "REBUILD") return;
			body.confirm = "REBUILD";
		}
		state.ops.busy = "embedding";
		state.ops.embedVerdict = { ok: true, text: (op === "rebuild" ? "重建" : "回填") + "执行中…桥在此期间不响应任何请求。" };
		renderOps();
		V.bridge("/api/l1/embedding", { method: "POST", body: JSON.stringify(body) }).then(function (r) {
			state.ops.busy = "";
			var d = r.data || {};
			if (!r.ok || d.success === false) {
				state.ops.embedVerdict = { ok: false, text: "执行失败：" + V.escapeHtml(String(d.error || "未知错误")) };
				state.ops.embedLog = String(d.raw || d.stderr || d.error || "");
				V.note("opsNote", "向量" + (op === "rebuild" ? "重建" : "回填") + "失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
				renderOps();
				return;
			}
			state.ops.embedOp = "";
			state.ops.embedVerdict = null;
			state.ops.embedLog = "";
			V.note(
				"opsNote",
				"向量" + (op === "rebuild" ? "重建" : "回填") + "完成（耗时 " + (d.elapsedMs ? Math.round(d.elapsedMs / 1000) + " 秒" : "未知") + "）。",
			);
			refreshOpsEmbedding();
		});
	}

	/** 整库还原的**预演**：只比对（CLI dry-run），把它的文本原样放进 details.log。 */
	function previewRollback() {
		if (!V.bridgePort()) return;
		var sel = $("rbBackup");
		var dir = sel ? sel.value : "";
		if (!dir) return;
		state.ops.rollbackBackup = dir;
		state.ops.busy = "rollback";
		renderOps();
		V.bridge("/api/l1/rollback", { method: "POST", body: JSON.stringify({ backup: dir }) }).then(function (r) {
			state.ops.busy = "";
			var d = r.data || {};
			var text = String(d.text || d.error || "");
			state.ops.rollbackPreviewHtml =
				'<details class="log"' + (d.success === false ? " open" : "") + '><summary>还原预演（CLI 输出）</summary><pre class="log-text">' +
				V.escapeHtml(text.slice(0, 4000)) + "</pre></details>";
			if (d.success === false) V.note("opsNote", "预演失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
			else V.note("opsNote", "预演完成（dry-run，未写盘）。详情见下方日志；确认无误后逐字输入备份目录名再执行。");
			renderOps();
		});
	}

	/** 整库还原的**执行**：替换当前全部 L1 记录。confirm 必须等于目录名（桥会复验）。 */
	function applyRollback() {
		if (!V.bridgePort()) return;
		var sel = $("rbBackup");
		var dir = sel ? sel.value : "";
		var input = $("rbConfirm");
		if (!dir || !input || input.value.trim() !== dir) return;
		if (!confirm("整库还原会用备份「" + dir + "」替换当前 L1 全部记录（不是单条撤销）。\n\n继续？")) return;
		state.ops.busy = "rollback";
		renderOps();
		V.bridge("/api/l1/rollback", { method: "POST", body: JSON.stringify({ backup: dir, apply: true, confirm: dir }) }).then(function (r) {
			state.ops.busy = "";
			var d = r.data || {};
			var text = String(d.text || d.error || "");
			state.ops.rollbackPreviewHtml =
				'<details class="log" open><summary>还原结果（CLI 输出）</summary><pre class="log-text">' + V.escapeHtml(text.slice(0, 4000)) + "</pre></details>";
			if (!r.ok || d.success === false) {
				V.note("opsNote", "整库还原失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
				renderOps();
				return;
			}
			state.ops.rollbackConfirm = "";
			V.note("opsNote", "整库还原完成，已重新加载记录。");
			// 记录被整库替换 → 卡片必须重读；备份清单也多了一份 pre-rollback
			renderOps();
			autoLoad();
			refreshOpsBackups();
		});
	}

	// ── 详情弹层 ────────────────────────────────────────────────────────────
	function openModal(r) {
		state.modalRow = r;
		var q = r.q;
		var a = r.audit;
		var hasPort = !!V.bridgePort();

		var auditBlock = function (title, obj, formatter) {
			if (!obj) return "";
			return "<dt>" + V.escapeHtml(title) + "</dt><dd>" + formatter(obj) + "</dd>";
		};

			var hitSt = state.hitMap.get(r.id);
			$("modalBody").innerHTML =
				"<h3>" + V.escapeHtml(r.type || "unknown") + "</h3>" +
				// id 与状态一起放在标题下：id 是 l1_fix / l1_task_state 的操作句柄，放这里方便直接抄
				// （卡片列表层已经不再显示 id —— 它是操作句柄不是浏览信息，见 renderRecords 的度量注释）
				'<div class="chips">' +
				metric(r.id || "?", "记录 id：l1_fix / l1_task_state 的入参", "id") +
				chip(q.tag + " " + fmtQ(q.quality), V.QUALITY_CLASS[q.tag] || "", "质量分 " + fmtQ(q.quality) + " —— 热度，按天数衰减") +
				chip(r.prune.eligible ? "淘汰候选：" + (VQ.PRUNE_REASON_LABELS[r.prune.reason] || r.prune.reason) : "不淘汰：" + (VQ.PRUNE_REASON_LABELS[r.prune.reason] || r.prune.reason), r.prune.eligible ? "prune" : "") +
				(r.isTask ? chip(V.TASK_STATE_LABELS[r.taskState], "task-" + r.taskState) : "") +
				(r.deleted ? chip("deleted", "del") : "") +
				"</div>" +
				// 诊断值全在这里：卡片只留了「多久没动」，其余从列表层搬进来 ——
				// 注入/工具此前**只**在卡片上出现过，搬走等于丢，所以必须同时补进弹层。
				'<div class="chips" style="margin-top:4px">' +
				metric("eff " + q.effective) +
				metric("hits " + q.hits + " / 无效 " + q.invalid) +
				(hitSt && (hitSt.injectHits || hitSt.toolHits)
					? metric("注入 " + hitSt.injectHits + " / 工具 " + hitSt.toolHits, "自动注入 / 工具召回")
					: "") +
				"</div>" +
			(r.isTask
				? '<div style="margin:12px 0"><div class="hint" style="margin-bottom:5px">任务状态（就地改写，保留 id/正文/向量；写 <code>metadata.taskStateChange</code> 审计）' +
					(hasPort ? "" : " —— <b>需带 ?port= 打开才能写盘</b>") + "：</div>" +
					'<div class="toolbar">' +
					["open", "done", "dropped"]
						.map(function (s) {
							return '<button type="button" class="task-' + s + '" data-task="' + s + '"' + (r.taskState === s ? " disabled" : "") + ">" + V.TASK_STATE_LABELS[s] + "</button>";
						})
						.join("") +
					'<input type="text" class="reason" id="taskReason" placeholder="可选：关闭原因（写入审计）" />' +
					"</div></div>"
				: "") +
			'<div class="full-content" data-view="content">' + V.escapeHtml(r.content || "") + "</div>" +
			'<textarea class="edit-area" data-edit-area="content" hidden>' + V.escapeHtml(r.content || "") + "</textarea>" +
				'<details class="more"><summary>字段与审计（点开）</summary><dl class="kv">' +
				// 这里不再重复 id：它已经在标题下那一行（弹层里此前 id 出现两处）
				"<dt>priority</dt><dd>" + V.escapeHtml(r.priority === undefined ? "—" : r.priority) + "</dd>" +
			"<dt>场景（解析后）</dt><dd>" + V.escapeHtml(r.scene.canonical || "—") + '<br><span class="hint">' + V.escapeHtml(r.scene.note || "") + "</span></dd>" +
			"<dt>scene_id / scene_name</dt><dd>" + V.escapeHtml(r.scene.id || "—") + " / " + V.escapeHtml(r.scene.rawName || "—") + "</dd>" +
			"<dt>项目 / scope</dt><dd>" + V.escapeHtml(r.project || "—") + " / " + V.escapeHtml(r.scope || "—") + "</dd>" +
			"<dt>cwd</dt><dd>" + V.escapeHtml(r.cwd || "—") + "</dd>" +
			"<dt>sessionKey</dt><dd>" + V.escapeHtml(r.sessionKey || "—") + "</dd>" +
			"<dt>version / deleted</dt><dd>" + V.escapeHtml(r.version === undefined ? "—" : r.version) + " / " + (r.deleted ? "true" : "false") + "</dd>" +
				"<dt>createdAt / updatedAt</dt><dd>" + V.escapeHtml(V.fmtTime(r.createdAt)) + " / " + V.escapeHtml(V.fmtTime(r.updatedAt)) +
				'<br><span class="hint">最后更新 ' + V.escapeHtml(V.fromNow(r.updatedAt || r.createdAt)) + "</span></dd>" +
			"<dt>质量明细</dt><dd>q=" + fmtQ(q.quality) + " decay=" + fmtQ(q.decay) + " days=" + Number(q.days).toFixed(2) + "（" + (q.activeDayClock ? "活跃会话日" : "日历天") + "） tag=" + V.escapeHtml(q.tag) + "</dd>" +
			"<dt>淘汰判定</dt><dd>" + V.escapeHtml(VQ.PRUNE_REASON_LABELS[r.prune.reason] || r.prune.reason) + "（保护带 priority ≥ " + state.protectedPriority + "）</dd>" +
			auditBlock("taskStateChange", a.taskStateChange, function (o) {
				return V.escapeHtml("from " + o.from + " → " + o.to + " · " + o.at + " · by " + o.by + (o.reason ? " · " + o.reason : ""));
			}) +
			auditBlock("valueCheck", a.valueCheck, function (o) {
				return V.escapeHtml(o.verdict + (o.from ? "（" + o.from + " → " + o.to + "）" : "") + (o.reason ? " · " + o.reason : ""));
			}) +
			auditBlock("l1Cleanup", a.l1Cleanup, function (o) {
				return V.escapeHtml((o.action || "") + (o.appliedAt || o.at || o.date ? " · " + (o.appliedAt || o.at || o.date) : "") + (o.replacedBy ? " · replacedBy " + o.replacedBy : ""));
			}) +
			"<dt>sourceFile</dt><dd>" + V.escapeHtml(r.sourceFile || "—") + "</dd>" +
			"</dl><pre class=\"json\">" + V.escapeHtml(JSON.stringify(r, null, 2)) + "</pre></details>" +
			// 纠错面板（l1_fix）：预演（checkFixGates 裁决）→ 执行。审计标注会**追加进正文本身**，
			// 与页面上那条「编辑正文（仅本页预览）」是两件事 —— 后者不写盘，这里写盘。
			'<div class="ops" style="margin-top:12px">' +
			'<h3 class="sub">纠错（l1_fix）</h3>' +
			(hasPort ? "" : '<div class="hint">写盘需要写盘桥：请以带 <code>?port=</code> 的地址打开本页。以下控件在只读模式下不可用。</div>') +
			'<div class="ops-row"><div class="ops-label">动作</div><div class="ops-ctl">' +
			'<select id="fixAction"' + (hasPort ? "" : " disabled") + ">" +
			'<option value="rewrite">rewrite（改写正文）</option>' +
			'<option value="tombstone">tombstone（作废该条）</option>' +
			"</select></div>" +
			'<div class="ops-note">rewrite 会把审计标注【YYYY-MM-DD L1 修正：…】<b>追加进正文本身</b>（不是独立审计键），同时记 <code>metadata.l1Cleanup</code> —— 正文会真的变长。四道闸：证据 ≥20 字符、rewrite 正文 ≥10 字符、24h 防抖、高价值保护。</div></div>' +
			'<div class="ops-row"><div class="ops-label">新正文</div><div class="ops-ctl">' +
			'<textarea id="fixContent" class="edit-area" style="min-height:110px"' + (hasPort ? "" : " disabled") + ">" + V.escapeHtml(r.content || "") + "</textarea>" +
			'</div><div class="ops-note">仅 rewrite 使用（≥10 字符）；tombstone 忽略此框。</div></div>' +
			'<div class="ops-row"><div class="ops-label">证据 *</div><div class="ops-ctl">' +
			'<input type="text" id="fixEvidence" class="reason" placeholder="grep 输出 / file:line / 命令输出（≥20 字符，必填）"' + (hasPort ? "" : " disabled") + " />" +
			'</div><div class="ops-note">必填且 ≥20 字符：修正必须附可复核证据，否则预演就会被拒。</div></div>' +
			'<div class="ops-row"><div class="ops-label">原因 / 优先级</div><div class="ops-ctl">' +
			'<input type="text" id="fixReason" class="reason" placeholder="可选：原因（写进正文审计标注）"' + (hasPort ? "" : " disabled") + " />" +
			'<input type="number" id="fixPriority" class="reason" min="0" max="100" placeholder="priority 0-100" style="min-width:130px"' + (hasPort ? "" : " disabled") + " />" +
			'<label class="check"><input type="checkbox" id="fixForce"' + (hasPort ? "" : " disabled") + " /> force（只解高价值保护那道闸）</label>" +
			"</div></div>" +
			'<div class="ops-ctl" style="margin-top:6px">' +
			'<button type="button" class="primary" id="fixPreview"' + (hasPort ? "" : " disabled") + ">预演（只报闸门裁决）</button>" +
			'<button type="button" class="danger" id="fixApply" hidden>执行（写盘）</button>' +
			"</div>" +
			'<div id="fixVerdict"></div>' +
			"</div>" +
			'<div class="foot">' +
			'<button type="button" class="primary" data-edit="content">编辑正文</button>' +
			'<button type="button" data-cancel="content" hidden>取消</button>' +
			'<button type="button" class="primary" data-save="content" hidden>保存（仅本页预览）</button>' +
			'<button type="button" class="danger" id="delBtn">删除（墓碑）</button>' +
			'<button type="button" data-close>关闭</button>' +
			"</div>";
		$("modal").classList.add("open");
	}

	function closeModal() {
		$("modal").classList.remove("open");
		state.modalRow = null;
	}

	/** 真实写盘：任务状态切换（走 l1_task_state 同一实现）。 */
	function applyTaskState(row, target, reason) {
		V.note("loadNote", "正在标记…");
		return V.bridge("/api/task-state", {
			method: "POST",
			body: JSON.stringify({ ids: [row.id], state: target, reason: reason || undefined }),
		}).then(function (r) {
			if (!r.ok || !r.data || r.data.success === false) {
				var err = (r.data && (r.data.error || (r.data.results && r.data.results[0] && r.data.results[0].error))) || "未知错误";
				V.note("loadNote", "标记失败：" + V.escapeHtml(String(err)), "err");
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
			V.note("loadNote", "已标记为「" + V.TASK_STATE_LABELS[target] + "」（就地改写 + 写锁，审计写入 metadata.taskStateChange）");
			renderAll();
			closeModal();
		});
	}

	/** 真实删除（墓碑）：走既有 tombstone CLI。 */
	function applyTombstone(row) {
		V.note("loadNote", "正在删除…");
		return V.bridge("/api/tombstone", { method: "POST", body: JSON.stringify({ ids: [row.id] }) }).then(function (r) {
			if (!r.ok || !r.data || !r.data.success) {
				V.note("loadNote", "删除失败：" + V.escapeHtml(String((r.data && r.data.error) || "未知错误")), "err");
				return;
			}
			row.deleted = true;
			V.note("loadNote", "已就地标记 deleted:true（自动备份已生成，可用 rollback 还原）");
			renderAll();
			closeModal();
		});
	}

	/** 一键取纠错表单的值（预演与执行各取一次，保证读到的是用户当下看到的输入）。 */
	function readFixForm() {
		var val = function (id) {
			var el = $(id);
			return el ? el.value.trim() : "";
		};
		var forceEl = $("fixForce");
		var prioRaw = val("fixPriority");
		var prio = prioRaw === "" ? undefined : Number(prioRaw);
		if (prio !== undefined && !Number.isFinite(prio)) prio = undefined;
		var contentEl = $("fixContent");
		return {
			id: state.modalRow ? state.modalRow.id : "",
			action: val("fixAction") || "rewrite",
			content: contentEl ? contentEl.value : "",
			evidence: val("fixEvidence"),
			reason: val("fixReason"),
			priority: prio,
			force: !!(forceEl && forceEl.checked),
		};
	}

	/** 组装 l1_fix 的请求体（预演与执行的差别只有 apply:true，其余必须逐字段一致）。 */
	function fixBody(f, apply) {
		var body = { id: f.id, action: f.action, evidence: f.evidence };
		if (apply) body.apply = true;
		if (f.action === "rewrite") body.content = f.content;
		if (f.reason) body.reason = f.reason;
		if (f.priority !== undefined) body.priority = f.priority;
		if (f.force) body.force = true;
		return body;
	}

	/**
	 * l1_fix 的**预演**：不写盘，只报四道闸的裁决。
	 *
	 * 为什么预演真的有意义：`runFix` 内部恒定向 rewrite/tombstone 传 `--apply`，本身没有干跑路径；
	 * 桥的 dry-run 走 `checkFixGates`（与实写同一份裁决）。预演覆盖正文长度/证据/存活/防抖/高价值，
	 * 但**不含 IO 级校验**（分片写得进写不进只有实写时才知道），界面上不把它说成保证。
	 */
	function previewFix() {
		if (!V.bridgePort()) return;
		var f = readFixForm();
		V.note("fixVerdict", "预演中…");
		V.bridge("/api/l1/fix", { method: "POST", body: JSON.stringify(fixBody(f, false)) }).then(function (r) {
			var d = r.data || {};
			if (!r.ok || d.success === false) {
				V.note("fixVerdict", "预演被拒：" + V.escapeHtml(String(d.error || "未知错误")), "err");
				$("fixApply").hidden = true;
				return;
			}
			V.note(
				"fixVerdict",
				"预演通过（dry-run，未写盘）：四道闸放行。" + (d.note ? "<br>" + V.escapeHtml(String(d.note)) : "") +
					(f.action === "rewrite" ? "<br>注意：执行时审计标注会<b>追加进正文本身</b>。" : "") +
					"<br><span class=\"hint\">dry-run 不含 IO 级校验（分片能否写入只有实写时才知道）。</span>",
			);
			$("fixApply").hidden = false;
			$("fixApply").disabled = false;
		});
	}

	/** l1_fix 的**执行**：与预演同一份表单值，额外带 apply:true。 */
	function applyFix() {
		if (!V.bridgePort()) return;
		var f = readFixForm();
		$("fixApply").disabled = true;
		V.note("fixVerdict", "执行中…");
		V.bridge("/api/l1/fix", { method: "POST", body: JSON.stringify(fixBody(f, true)) }).then(function (r) {
			var d = r.data || {};
			if (!r.ok || d.success === false) {
				V.note("fixVerdict", "执行失败：" + V.escapeHtml(String(d.error || "未知错误")), "err");
				$("fixApply").disabled = false;
				return;
			}
			// 正文被服务端就地改写（含追加的审计标注），本地那份内容已不可信 —— 重读取回真身
			closeModal();
			V.note("loadNote", "纠错已写入（" + V.escapeHtml(f.action) + "）：" + V.escapeHtml(String(d.detail || "").slice(0, 200)) + "<br>正文由服务端改写，页面重新加载以取回真实内容。");
			autoLoad();
		});
	}

	// ── 事件绑定 ────────────────────────────────────────────────────────────
	/** 管理操作区的点击分发（按 id 路由到各写动作；按钮 disabled 时浏览器不会派发 click）。 */
	function onOpsClick(e) {
		var btn = e.target && e.target.closest ? e.target.closest("button") : null;
		if (!btn || btn.disabled) return;
		switch (btn.id) {
			case "opsModeCode": return setL1Mode("code");
			case "opsModeChat": return setL1Mode("chat");
			case "opsBackfill": return previewEmbedding("backfill");
			case "opsRebuild": return previewEmbedding("rebuild");
			case "opsEmbedApply": return applyEmbedding();
			case "opsEmbedCancel":
				state.ops.embedOp = "";
				state.ops.embedVerdict = null;
				state.ops.embedLog = "";
				renderOps();
				return;
			case "rbPreview": return previewRollback();
			case "rbApply": return applyRollback();
			default: return;
		}
	}

	/** 管理操作区的输入变化：只切换"打字确认"按钮的可用性，**不重画**（重画会把光标顶走）。 */
	function onOpsInput(e) {
		var t = e.target;
		if (!t || !t.id) return;
		if (t.id === "rbConfirm") {
			state.ops.rollbackConfirm = t.value.trim();
			syncRollbackApply();
			return;
		}
		if (t.id === "opsRebuildConfirm") {
			syncEmbedApply();
			return;
		}
		if (t.id === "rbBackup") {
			state.ops.rollbackBackup = t.value;
			// 换了备份就要重画一次：确认串的提示字符号（#rbToken）要跟着换
			renderOps();
			return;
		}
	}

	function bind() {
		$("typeList").addEventListener("click", function (e) {
			var btn = e.target.closest("[data-type]");
			if (!btn) return;
			state.filters.type = btn.getAttribute("data-type") || "";
			renderAll();
		});
		$("taskList").addEventListener("click", function (e) {
			var btn = e.target.closest("[data-taskfilter]");
			if (!btn) return;
			state.filters.task = btn.getAttribute("data-taskfilter") || "";
			$("taskList").querySelectorAll("button").forEach(function (b) {
				b.classList.toggle("active", b === btn);
			});
			renderAll();
		});
		$("qualityFilter").addEventListener("change", function (e) {
			state.filters.quality = e.target.value;
			renderAll();
		});
		$("sceneList").addEventListener("change", function (e) {
			state.filters.scene = e.target.value;
			renderAll();
		});
		$("projectList").addEventListener("change", function (e) {
			state.filters.project = e.target.value;
			renderAll();
		});
		$("dateFilter").addEventListener("change", function (e) {
			state.filters.date = e.target.value;
			renderAll();
		});
		$("sort").addEventListener("change", function (e) {
			state.filters.sort = e.target.value;
			renderAll();
		});
		$("hideDeleted").addEventListener("change", function (e) {
			state.filters.hideDeleted = e.target.checked;
			if (e.target.checked) {
				state.filters.onlyDeleted = false;
				$("onlyDeleted").checked = false;
			}
			renderAll();
		});
		$("onlyDeleted").addEventListener("change", function (e) {
			state.filters.onlyDeleted = e.target.checked;
			if (e.target.checked) {
				state.filters.hideDeleted = false;
				$("hideDeleted").checked = false;
			}
			renderAll();
		});
		$("q").addEventListener(
			"input",
			V.debounce(function (e) {
				state.filters.q = e.target.value.trim();
				renderAll();
			}, 180),
		);

		// 只看淘汰候选（侧栏里的快捷入口，渲染后才有，用事件委托）
		$("qualityStats").addEventListener("click", function (e) {
			if (e.target && e.target.id === "filterPrune") {
				e.preventDefault();
				state.filters.hideDeleted = true;
				$("hideDeleted").checked = true;
				state.filters.q = "";
				$("q").value = "";
				var rows = state.rows.filter(function (r) {
					return !r.deleted && r.prune.eligible;
				});
				renderStats();
				renderRecords(rows);
				$("resultMeta").textContent = "淘汰候选 " + rows.length + " 条（judgePrune 判定可删）—— 改筛选条件可退出此视图";
			}
		});

		// 手动载入（选择 JSONL / 选择目录 / 选择 hit-stats.json）已于 2026-10-08 按用户要求移除：
		// 那三个按钮只为「file:// 手动选文件」这条路径存在，而实际始终经写盘桥打开，属死重量。
		// 连带删掉了它们背后的三个隐藏 <input type="file"> 与 loadFromFiles()。
		// 若要恢复「无桥也能看」：需同时改回 file:// 提示条、本页空态文案与 README，
		// 且注意 loadActiveDays() 自带 hit-stats 侧车兜底 —— 手动入口删了不等于时钟来源少了。
		$("reloadBtn").addEventListener("click", function () {
			autoLoad();
			// 记录与管理状态是两份来源：重新加载时一起刷新，免得面板显示的是上一轮的盘面
			loadOps();
		});
		$("clearBtn").addEventListener("click", function () {
			state.rows = [];
			state.files = [];
			state.drops = [];
			state.source = "";
			V.note("loadNote", "已清空。点「重新加载」取回数据。");
			renderAll();
		});
		$("exportBtn").addEventListener("click", function () {
			var rows = filtered();
			V.download("l1-records-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(rows, null, 2));
		});

		// 标签页
		$("tabRecords").addEventListener("click", function () { switchTab("records"); });
		$("tabDrops").addEventListener("click", function () { switchTab("drops"); });

		// 卡片：整张卡（含正文预览）都可点，一律打开详情弹层。
		// 正文是截断预览（.card-body，见 viewer.css 契约 3），完整正文只在弹层里给 ——
		// 旧版在卡片内做了 190px 的内部滚动，567 张卡各画一条原生滚动条。
		$("list").addEventListener("click", function (e) {
			// 勾选框（含它的 label）归选择条管，不弹详情；否则"想勾选却打开了弹层"
			if (e.target.closest && e.target.closest("[data-sel-label]")) return;
			var btn = e.target.closest("[data-open]");
			var head = e.target.closest(".card");
			if (!head) return;
			var idx = btn ? Number(btn.getAttribute("data-open")) : Number(head.getAttribute("data-idx"));
			var row = state.lastRows[idx];
			if (row) openModal(row);
		});
		// 勾选变化：用 change（不是 click）—— checkbox 的勾选状态在 change 时才可靠
		$("list").addEventListener("change", function (e) {
			var input = e.target;
			if (!input || !input.matches || !input.matches('input[type="checkbox"][data-sel]')) return;
			toggleSelected(input.getAttribute("data-sel") || "", input.checked);
		});

		// 批量选择条
		$("selOpen").addEventListener("click", function () { applyTaskStateBatch("open"); });
		$("selDone").addEventListener("click", function () { applyTaskStateBatch("done"); });
		$("selDropped").addEventListener("click", function () { applyTaskStateBatch("dropped"); });
		$("selExport").addEventListener("click", exportSelected);
		$("selClear").addEventListener("click", function () {
			state.selected = new Set();
			state.pendingTombstone = null;
			renderRecords(state.lastRows);
			renderSelectionBar();
		});
		// 全选 = 勾上"当前篩选结果"（state.lastRows 就是这一份渲染的行）
		$("selAll").addEventListener("click", function () {
			state.lastRows.forEach(function (r) { if (r.id) state.selected.add(r.id); });
			renderRecords(state.lastRows);
			renderSelectionBar();
		});
		$("selDelete").addEventListener("click", function () {
			var ids = Array.from(state.selected);
			if (ids.length === 0) return;
			state.pendingTombstone = ids;
			renderSelConfirm();
		});
		// 确认条是动态注入的，事件委托到固定容器
		$("selConfirm").addEventListener("click", function (e) {
			if (!e.target || !e.target.id) return;
			if (e.target.id === "selConfirmYes") applyTombstoneBatch(state.pendingTombstone || []);
			else if (e.target.id === "selConfirmNo") {
				state.pendingTombstone = null;
				renderSelConfirm();
			}
		});

		// 侧栏「L1 管理」：内容由 renderOps 动态注入 → 事件一律委托到 #l1ops 上
		$("l1ops").addEventListener("click", onOpsClick);
		$("l1ops").addEventListener("input", onOpsInput);
		$("l1ops").addEventListener("change", onOpsInput);

		// 弹层
		$("modal").addEventListener("click", function (e) {
			if (e.target === $("modal") || (e.target.dataset && e.target.dataset.close !== undefined)) {
				closeModal();
			}
		});
		$("modalBody").addEventListener("click", function (e) {
			var t = e.target;
			var row = state.modalRow;
			if (!row) return;

			var taskBtn = t.closest("[data-task]");
			if (taskBtn) {
				var target = taskBtn.getAttribute("data-task");
				var reasonEl = $("taskReason");
				var reason = reasonEl ? reasonEl.value.trim() : "";
				if (!V.bridgePort()) {
					V.note("loadNote", "写盘需要写盘桥：请运行 <code>node scripts/l1-admin/viewer-bridge.mjs --port 5174</code> 并以 <code>?port=5174</code> 重新打开本页。", "warn");
					return;
				}
				taskBtn.disabled = true;
				applyTaskState(row, target, reason).then(function () {
					taskBtn.disabled = false;
				});
				return;
			}
			if (t.id === "delBtn") {
				if (!V.bridgePort()) {
					if (!confirm("未带 ?port=，无法真实删除。\n\n请先运行：node scripts/l1-admin/viewer-bridge.mjs\n再以 ?port= 打开本页。\n\n现在仅在本页预览标记（刷新即恢复）？")) return;
					row.deleted = true;
					renderAll();
					closeModal();
					return;
				}
				if (!confirm("确定真实删除（就地标记 deleted:true）？\nID: " + row.id + "\n\n会自动备份，可用 rollback 还原。")) return;
				t.disabled = true;
				applyTombstone(row).then(function () {
					t.disabled = false;
				});
				return;
			}
			if (t.dataset && t.dataset.edit === "content") {
				var area = $("modalBody").querySelector('[data-edit-area="content"]');
				var view = $("modalBody").querySelector('[data-view="content"]');
				area.hidden = false;
				view.hidden = true;
				t.hidden = true;
				$("modalBody").querySelector('[data-save="content"]').hidden = false;
				$("modalBody").querySelector('[data-cancel="content"]').hidden = false;
				return;
			}
			if (t.dataset && t.dataset.cancel === "content") {
				var area2 = $("modalBody").querySelector('[data-edit-area="content"]');
				var view2 = $("modalBody").querySelector('[data-view="content"]');
				area2.value = view2.textContent;
				area2.hidden = true;
				view2.hidden = false;
				t.hidden = true;
				$("modalBody").querySelector('[data-save="content"]').hidden = true;
				$("modalBody").querySelector('[data-edit="content"]').hidden = false;
				return;
			}
			if (t.dataset && t.dataset.save === "content") {
				var area3 = $("modalBody").querySelector('[data-edit-area="content"]');
				var view3 = $("modalBody").querySelector('[data-view="content"]');
				var rec = state.rows.find(function (x) { return x.id === row.id; });
				if (rec) {
					rec.content = area3.value;
					rec.updatedAt = new Date().toISOString();
					row.content = area3.value;
				}
				view3.textContent = area3.value;
				area3.hidden = true;
				view3.hidden = false;
				t.hidden = true;
				$("modalBody").querySelector('[data-cancel="content"]').hidden = true;
				$("modalBody").querySelector('[data-edit="content"]').hidden = false;
				renderAll();
				return;
			}
			// 纠错面板：预演 → 执行（两步；执行才写盘）
			if (t.id === "fixPreview") { previewFix(); return; }
			if (t.id === "fixApply") { applyFix(); return; }
		});
		document.addEventListener("keydown", function (e) {
			if (e.key === "Escape" && $("modal").classList.contains("open")) closeModal();
		});
	}

	function switchTab(tab) {
		state.tab = tab;
		var isRecords = tab === "records";
		$("tabRecords").classList.toggle("active", isRecords);
		$("tabDrops").classList.toggle("active", !isRecords);
		$("paneRecords").hidden = !isRecords;
		$("paneDrops").hidden = isRecords;
		renderAll();
	}

	function init() {
		V.mountChrome({ active: "records-viewer.html" });
		bind();
		autoLoad();
		// 管理操作区独立于记录加载：即便分片读失败，提取模式 / 向量库 / 还原这些信息仍应可见
		loadOps();
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
})();
