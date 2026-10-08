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
		/** 加载方式："bridge"（列全部分片）| "static"（60 天窗口）| "manual" */
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
				var alive = state.rows.filter(function (r) {
					return !r.deleted;
				}).length;
				var clockLabel =
					state.clockSource === "bridge"
						? "活跃会话日 " + state.activeDays.length + " 个（源：l0/conversations，权威）"
						: state.clockSource === "sidecar"
							? "活跃会话日 " + (state.activeDays ? state.activeDays.length : 0) + " 个（源：hit-stats.json 侧车，可能滞后于 l0）"
							: "日历天（拿不到活跃日数据，已退化）";
				var srcLabel = state.source === "bridge" ? "写盘桥（全部分片）" : "静态探测（最近 90 天；更早需用桥或手动选文件）";
				var msg =
					"已加载 <b>" + state.rows.length + "</b> 条（存活 " + alive + "，已删除 " +
					(state.rows.length - alive) + "），来自 " + state.files.length + " 个分片。<br>" +
					"场景池 " + state.scenes.byId.size + " 条，丢弃留痕 " + state.drops.length + " 条。<br>" +
					"来源：" + srcLabel + "；时钟：" + clockLabel + "；保护带阈值 P" + VQ.PRUNE_RULES.protectedPercentile + " = " + state.protectedPriority;
				V.note("loadNote", msg);
				renderAll();
				return true;
			})
			.catch(function (e) {
				state.source = state.source || "static";
				V.note(
					"loadNote",
					"自动加载失败：" + V.escapeHtml(e && e.message ? e.message : String(e)) +
						"。可手动选择 JSONL，或用 <code>node scripts/l1-admin/viewer-bridge.mjs</code> 打开。",
					"warn",
				);
				return false;
			});
	}

	/** 手动载入（文件选择 / 目录选择）：替换当前记录集，命中统计与场景池照旧自动取。 */
	function loadFromFiles(files, replace) {
		var list = Array.prototype.slice.call(files).filter(function (f) {
			return /\.jsonl$/i.test(f.name || "");
		});
		if (list.length === 0) return Promise.resolve();
		var tasks = list.map(function (f) {
			return f.text().then(function (txt) {
				return { file: f.name, rows: V.parseJsonl(txt, f.name) };
			});
		});
		return Promise.all(tasks).then(function (results) {
			var records = replace ? [] : state.rows.slice();
			var fileNames = replace ? [] : state.files.slice();
			for (var i = 0; i < results.length; i++) {
				records = records.concat(results[i].rows);
				fileNames.push(results[i].file + " (" + results[i].rows.length + ")");
			}
			state.files = fileNames;
			state.source = "manual";
			return Promise.all([loadHitStats(), loadScenes(), loadDropLog()]).then(function () {
				state.rows = enrichAll(records);
				V.note("loadNote", "已手动载入 " + records.length + " 行（LWW 去重后 " + state.rows.length + " 条）");
				renderAll();
			});
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

		$("qualityStats").innerHTML =
			'<h2>质量标签</h2><div class="bars">' +
			Object.keys(dist)
				.map(function (k) { return barRow(k, dist[k], maxTag, tagClass[k]); })
				.join("") +
			'</div><h2>质量分直方图</h2><div class="hist">' +
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
			'<h2>淘汰候选（judgePrune 可判删）</h2><div class="hint">' +
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
				: "<strong>还没有数据</strong>用上方「自动加载」或手动选择 JSONL。";
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

				// ── 度量 token：安静、等宽、跨卡片可对齐
				var metrics = [metric("eff " + q.effective), metric("hits " + q.hits + "/" + q.invalid, "命中/无效（无效即回收后判无价值被清除）")];
				var st = state.hitMap.get(r.id);
				if (st && (st.injectHits || st.toolHits)) metrics.push(metric("注入 " + st.injectHits + " / 工具 " + st.toolHits, "自动注入 / 工具召回"));
				metrics.push(metric("decay " + fmtQ(q.decay)));
				metrics.push(
					metric((q.activeDayClock ? "活跃 " : "日历 ") + Number(q.days).toFixed(1) + " 天",
						q.activeDayClock ? "衰减时钟按活跃会话日（停工不增长）" : "侧车无 activeDays，退化为日历天"),
				);
				metrics.push(metric(V.fmtDay(r.updatedAt || r.createdAt)));
				metrics.push(metric(V.fromNow(r.updatedAt || r.createdAt)));
				// 记录 id 必须显示：它是 l1_fix / l1_task_state 的操作句柄，也是注入行里的「编号」。
				// 旧版有、重写时漏掉过一次 —— 没有它就没法从界面把一条记录对到命令上。
				metrics.push(metric(r.id || "?", "记录 id：注入行里的「编号」，也是 l1_fix / l1_task_state 的入参", "id"));

				return (
					'<article class="card' + (r.deleted ? " deleted" : "") + '" data-idx="' + idx + '">' +
					'<div class="card-head" data-toggle><div class="chips">' + chips.join("") + sceneChip + "</div></div>" +
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
						'<td style="max-width:460px;white-space:pre-wrap">' + V.escapeHtml(body) + "</td></tr>"
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

		$("modalBody").innerHTML =
			"<h3>" + V.escapeHtml(r.type || "unknown") + "</h3>" +
			// id 与状态一起放在标题下：id 是 l1_fix / l1_task_state 的操作句柄，放这里方便直接抄
			'<div class="chips">' +
			metric(r.id || "?", "记录 id：l1_fix / l1_task_state 的入参", "id") +
			chip(q.tag + " " + fmtQ(q.quality), V.QUALITY_CLASS[q.tag] || "", "质量分 " + fmtQ(q.quality) + " —— 热度，按天数衰减") +
			chip(r.prune.eligible ? "淘汰候选：" + (VQ.PRUNE_REASON_LABELS[r.prune.reason] || r.prune.reason) : "不淘汰：" + (VQ.PRUNE_REASON_LABELS[r.prune.reason] || r.prune.reason), r.prune.eligible ? "prune" : "") +
			(r.isTask ? chip(V.TASK_STATE_LABELS[r.taskState], "task-" + r.taskState) : "") +
			(r.deleted ? chip("deleted", "del") : "") +
			"</div>" +
			'<div class="chips" style="margin-top:4px">' +
			metric("eff " + q.effective) +
			metric("hits " + q.hits + " / 无效 " + q.invalid) +
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
			"<dt>id</dt><dd>" + V.escapeHtml(r.id) + "</dd>" +
			"<dt>priority</dt><dd>" + V.escapeHtml(r.priority === undefined ? "—" : r.priority) + "</dd>" +
			"<dt>场景（解析后）</dt><dd>" + V.escapeHtml(r.scene.canonical || "—") + '<br><span class="hint">' + V.escapeHtml(r.scene.note || "") + "</span></dd>" +
			"<dt>scene_id / scene_name</dt><dd>" + V.escapeHtml(r.scene.id || "—") + " / " + V.escapeHtml(r.scene.rawName || "—") + "</dd>" +
			"<dt>项目 / scope</dt><dd>" + V.escapeHtml(r.project || "—") + " / " + V.escapeHtml(r.scope || "—") + "</dd>" +
			"<dt>cwd</dt><dd>" + V.escapeHtml(r.cwd || "—") + "</dd>" +
			"<dt>sessionKey</dt><dd>" + V.escapeHtml(r.sessionKey || "—") + "</dd>" +
			"<dt>version / deleted</dt><dd>" + V.escapeHtml(r.version === undefined ? "—" : r.version) + " / " + (r.deleted ? "true" : "false") + "</dd>" +
			"<dt>createdAt / updatedAt</dt><dd>" + V.escapeHtml(V.fmtTime(r.createdAt)) + " / " + V.escapeHtml(V.fmtTime(r.updatedAt)) + "</dd>" +
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

	// ── 事件绑定 ────────────────────────────────────────────────────────────
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

		// 分片/文件输入
		$("pickFiles").addEventListener("click", function () { $("fileInput").click(); });
		$("pickDir").addEventListener("click", function () { $("dirInput").click(); });
		$("pickHit").addEventListener("click", function () { $("hitInput").click(); });
		$("fileInput").addEventListener("change", function (e) {
			loadFromFiles(e.target.files, state.source === "manual").then(function () {
				e.target.value = "";
			});
		});
		$("dirInput").addEventListener("change", function (e) {
			loadFromFiles(e.target.files, true).then(function () {
				e.target.value = "";
			});
		});
		$("hitInput").addEventListener("change", function (e) {
			var f = e.target.files && e.target.files[0];
			if (f) {
				f.text().then(function (txt) {
					try {
						var payload = JSON.parse(txt);
						var arr = Array.isArray(payload) ? payload : payload.stats || [];
						state.hitMap = new Map();
						arr.forEach(function (raw) {
							var st = VQ.normalizeStat(raw);
							if (st && st.recordId) state.hitMap.set(st.recordId, st);
						});
						if (!Array.isArray(payload) && Array.isArray(payload.activeDays)) {
							state.activeDays = payload.activeDays
								.map(function (k) { return new Date(k + "T00:00:00").getTime(); })
								.filter(function (t) { return !Number.isNaN(t); });
							state.clockSource = "sidecar";
						}
						state.rows = enrichAll(state.rows);
						V.note("loadNote", "已载入命中统计 " + state.hitMap.size + " 条");
						renderAll();
					} catch (err) {
						V.note("loadNote", "命中统计解析失败：" + V.escapeHtml(err.message), "err");
					}
				});
			}
			e.target.value = "";
		});
		$("reloadBtn").addEventListener("click", function () {
			autoLoad();
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
			var btn = e.target.closest("[data-open]");
			var head = e.target.closest(".card");
			if (!head) return;
			var idx = btn ? Number(btn.getAttribute("data-open")) : Number(head.getAttribute("data-idx"));
			var row = state.lastRows[idx];
			if (row) openModal(row);
		});

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
			}
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
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
})();
