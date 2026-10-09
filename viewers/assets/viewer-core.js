/*
 * viewers/assets/viewer-core.js —— 查看器共享核心（classic script，挂在 window.V）
 *
 * 为什么是 classic script 而不是 ES module：
 *   `file://` 下浏览器既禁止 `fetch()` 也禁止 ES module 加载，但**允许** <script src> 与
 *   <link rel=stylesheet>。用 classic script，直接双击打开时页面至少能正常渲染、并给出
 *   「自动加载与写回都不可用」的说明（见 mountChrome 的提示条），而不是白屏或半死不活。
 *   取数本身仍然需要 http + 写盘桥 —— 2026-10-08 起已按用户要求移除「手动选 JSONL」这条
 *   离线载入路径，所以 file:// 下现在只剩「能看说明」这一层价值。
 *
 * 单一来源：格式化 / 时间 / 加载器 / 导航 / 版本 只在这里一份。三个页面都不再各写一份
 * （旧版就是因为每页内联一份，改一处要改三处，很快分叉）。
 *
 * 依赖方向：viewer-core 不依赖 quality-core，也不依赖任何页面脚本。反向可以。
 */
(function () {
	"use strict";

	/** 页面清单（导航与相对链接的单源）。 */
	var PAGES = [
		{ file: "index.html", label: "总览" },
		{ file: "records-viewer.html", label: "L1 原子记忆" },
		{ file: "l2-viewer.html", label: "L2 场景" },
		{ file: "l3-viewer.html", label: "L3 画像" },
		// 流水线页放在四页之后：它是**跨层**的运维视图（队列 + 三层子代理），
		// 不属于某一层的数据，所以既不插在层与层之间，也不挤在最前面抢注意力。
		{ file: "pipeline-viewer.html", label: "流水线" },
	];

	/** L1 记录类型（与 memory/l1/record-types.ts 的 L1_RECORD_TYPES 一致）。 */
	var RECORD_TYPES = ["work_fact", "work_task", "work_method", "work_artifact"];

	/** 任务状态标签（与 record-types.ts 的 L1_TASK_STATE_LABELS 一致）。 */
	var TASK_STATE_LABELS = { open: "待办", done: "已完成", dropped: "已废弃" };

	/** 质量标签配色 class（与 viewer.css 的 .q-* 一致）。 */
	var QUALITY_CLASS = { 热: "q-hot", 温: "q-warm", 冷: "q-cold", 新: "q-new", 噪: "q-noise", 待观察: "q-watch" };

	function escapeHtml(s) {
		return String(s === null || s === undefined ? "" : s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	/** 时间戳解析（非法返回 0，便于直接参与比较）。 */
	function ts(v) {
		var n = Date.parse(v);
		return Number.isNaN(n) ? 0 : n;
	}

	function fmtTime(v) {
		if (!v) return "—";
		var d = new Date(v);
		return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("zh-CN", { hour12: false });
	}

	function fmtDay(v) {
		if (!v) return "—";
		return String(v).slice(0, 10);
	}

	/** 相对时间（"3 天前"）；用于「这条记忆多久没动了」这类快速判断。 */
	function fromNow(v, nowMs) {
		var t = ts(v);
		if (!t) return "—";
		var diff = ((nowMs || Date.now()) - t) / 1000;
		if (diff < 60) return "刚刚";
		if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
		if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
		return Math.floor(diff / 86400) + " 天前";
	}

	/** 解析 JSONL 文本为对象数组（坏行跳过并计数，不抛）。 */
	function parseJsonl(text, sourceFile) {
		var out = [];
		var lines = String(text || "").split("\n");
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].trim();
			if (!line) continue;
			try {
				var o = JSON.parse(line);
				if (o && typeof o === "object") {
					if (sourceFile) o.sourceFile = sourceFile;
					out.push(o);
				}
			} catch (e) {
				/* 坏行跳过：与后端 loader 同款口径（宁可漏判，不让一行挡住整次读取） */
			}
		}
		return out;
	}

	/** 是否跑在 http(s) 下（`file://` 下 fetch 被浏览器禁止）。 */
	function isHttp() {
		return location.protocol === "http:" || location.protocol === "https:";
	}

	/**
	 * 写盘桥端口（只认 URL 的 `?port=`）；空字符串 = 只读模式。
	 *
	 * 为什么端口要靠 query 传、而不是"页面同源就在桥那儿"：本页既要能在桥下跑，也要能
	 * 从 `file://` 直接双击打开（此时没有同源可推断），还要能挂在任意静态服务器上只读浏览
	 * —— `?port=` 是唯一能把"桥在哪"表达清楚的手段，且不依赖页面来源。
	 * 代价是：一旦某种打开方式把 query 丢了（点导航、手敲地址、收藏夹），页面就静默降级成
	 * 只读、到处显示"无写盘桥"。所以**所有页内跳转都必须带上 location.search**（见 mountChrome），
	 * 并且丢了 query 时要给出明确提示而不是只闷着降级（见 modeBanner）。
	 */
	function bridgePort() {
		try {
			return new URLSearchParams(location.search).get("port") || "";
		} catch (e) {
			return "";
		}
	}

	/**
	 * 桥的**主机名** —— 跟着页面自身走，不写死 `127.0.0.1`。
	 *
	 * 为什么（2026-10-09 桥加 `--lan` 时暴露）：桥也能听在局域网上，页面于是会从
	 * `http://172.16.10.4:5174/…` 被打开。此时若仍去 fetch `127.0.0.1:5174`，在**别的设备**上指的是
	 * 它自己的回环 —— 所有 `/api/*` 都不会返回，页面只剩"桥连接失败"，而本机打开同一个地址却完全正常
	 * （最难查的一类：换台机器就坏）。主机名跟着页面走，本机与远端就是同一条代码路径。
	 * `file://` 下 `location.hostname` 是空串，那时退回 `127.0.0.1`（唯一合理的猜测）。
	 */
	function bridgeHost() {
		return location.hostname || "127.0.0.1";
	}

	/** 桥的 origin：协议同样跟页面走（`file://` 下页面没有 http 协议，退回 http）。 */
	function bridgeOrigin() {
		return (isHttp() ? location.protocol : "http:") + "//" + bridgeHost() + ":" + bridgePort();
	}

	/**
	 * 调写盘桥的 JSON 接口。
	 *
	 * @returns Promise<{ok:boolean, status:number, data:any}>；无桥或网络失败时 ok=false 且 data.error 有原因
	 */
	function bridge(path, opts) {
		var port = bridgePort();
		if (!port) {
			return Promise.resolve({ ok: false, status: 0, data: { error: "未带 ?port=，当前为只读模式" } });
		}
		var init = Object.assign({ cache: "no-store" }, opts || {});
		if (init.body && !init.headers) init.headers = { "Content-Type": "application/json" };
		return fetch(bridgeOrigin() + path, init)
			.then(function (r) {
				return r.json().catch(function () {
					return { error: "响应不是 JSON（HTTP " + r.status + "）" };
				}).then(function (data) {
					return { ok: r.ok, status: r.status, data: data };
				});
			})
			.catch(function (e) {
				return { ok: false, status: 0, data: { error: "桥连接失败：" + (e && e.message ? e.message : String(e)) } };
			});
	}

	/** fetch 文本；失败返回 null（调用方据此区分"文件不存在"与"内容为空"）。 */
	function loadText(url) {
		return fetch(url, { cache: "no-store" })
			.then(function (r) {
				return r.ok ? r.text() : null;
			})
			.catch(function () {
				return null;
			});
	}

	/** fetch JSON；失败或非 JSON 返回 null。 */
	function loadJson(url) {
		return loadText(url).then(function (txt) {
			if (txt === null) return null;
			try {
				return JSON.parse(txt);
			} catch (e) {
				return null;
			}
		});
	}

	/** fetch JSONL → 对象数组；文件不存在返回空数组。 */
	function loadJsonl(url) {
		return loadText(url).then(function (txt) {
			return txt === null ? [] : parseJsonl(txt);
		});
	}

	/** 项目路径归一化：统一正斜杠、去尾斜杠（记录里 `metadata.project` 与 `cwd` 的斜杠风格不一致）。 */
	function normalizePath(p) {
		if (!p) return "";
		return String(p).replace(/\\/g, "/").replace(/\/+$/, "");
	}

	/** 项目短名（取最后一段，便于在窄 chip 里显示）。 */
	function projectShort(p) {
		var n = normalizePath(p);
		if (!n) return "";
		var parts = n.split("/");
		return parts[parts.length - 1] || n;
	}

	/** 按 fn 分组计数，返回 [{key, count}]（count 降序，key 升序）。 */
	function groupCount(arr, fn) {
		var m = new Map();
		for (var i = 0; i < arr.length; i++) {
			var k = fn(arr[i]);
			m.set(k, (m.get(k) || 0) + 1);
		}
		return Array.from(m.entries())
			.map(function (e) {
				return { key: e[0], count: e[1] };
			})
			.sort(function (a, b) {
				return b.count - a.count || String(a.key).localeCompare(String(b.key));
			});
	}

	function debounce(fn, ms) {
		var t = null;
		return function () {
			var args = arguments;
			var self = this;
			if (t) clearTimeout(t);
			t = setTimeout(function () {
				fn.apply(self, args);
			}, ms);
		};
	}

	/** 触发浏览器下载（导出当前视图用）。 */
	function download(filename, text, mime) {
		var blob = new Blob([text], { type: mime || "application/json;charset=utf-8" });
		var url = URL.createObjectURL(blob);
		var a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(function () {
			URL.revokeObjectURL(url);
		}, 1000);
	}

	/**
	 * 在指定容器渲染提示条。
	 *
	 * @param el 容器（元素或 id）
	 * @param html 内容（**调用方负责转义**，因为里面常要放 <code>）
	 * @param level "" | "warn" | "err"
	 */
	function note(el, html, level) {
		var node = typeof el === "string" ? document.getElementById(el) : el;
		if (!node) return;
		node.className = "notice" + (level ? " " + level : "");
		node.innerHTML = html;
		node.style.display = "";
	}

	/** manifest 缓存（三页都要，避免各页各读一次）。 */
	var manifestPromise = null;
	function loadManifest() {
		if (!manifestPromise) manifestPromise = loadJson("viewer-manifest.json");
		return manifestPromise;
	}

	/**
	 * 渲染顶部导航 + 版本 chip，并在能连上写盘桥时做一次「漂移」检查。
	 *
	 * 漂移检查：桥（在仓库里）能读到 `viewers/` 源码的内容哈希，与本机部署版本的哈希比对。
	 * 不一致 = 源码改了但扩展还没重新部署 —— 这正是旧查看器最致命的失效方式（页面悄悄落后），
	 * 所以必须有可见信号；纯静态打开（无桥）时无此检查，退化为只显示版本。
	 *
	 * @param opts.active 当前页文件名（用于高亮）
	 */
	function mountChrome(opts) {
		opts = opts || {};
		var host = document.getElementById("nav");
		if (!host) return;
		var html =
			'<span class="brand">记忆库查看器</span>' +
			PAGES.map(function (p) {
				// 页内跳转必须带上 location.search：丢了 ?port= 页面就变只读，而且只在
				// L2/L3/总览的"无写盘桥"文案里间接体现，不报错 —— 实测点一下导航就会中招。
				return (
					'<a class="item' + (p.file === opts.active ? " active" : "") + '" href="' + p.file + escapeHtml(location.search) + '">' + escapeHtml(p.label) + "</a>"
				);
			}).join("") +
			'<span class="spacer"></span>' +
			'<span class="version" id="versionChip">读取版本…</span>';
		host.innerHTML = html;

		var chip = document.getElementById("versionChip");
		loadManifest().then(function (m) {
			if (!m || !m.version) {
				chip.textContent = location.protocol === "file:" ? "file:// 打开（未部署清单）" : "无版本清单";
				chip.classList.add("stale");
				return;
			}
			chip.textContent = m.version + " · " + fmtTime(m.generatedAt);
			chip.title = "部署自 " + (m.sourceRoot || "?") + "（共 " + (m.files ? m.files.length : 0) + " 个文件）";
		});

		// 漂移检查（需要写盘桥：只有桥能读到仓库里的源码）
		if (bridgePort()) {
			bridge("/api/viewer-status").then(function (r) {
				if (!r.ok || !r.data || !r.data.sourceVersion) return;
				if (r.data.drifted) {
					chip.classList.add("stale");
					chip.textContent += " ⚠ 源码已更新未部署";
					chip.title = "源码版本 " + r.data.sourceVersion + "，已部署 " + r.data.deployedVersion + "；重启会话或 /reload 触发部署";
				}
			});
		}

		// 两种"只读降级"的原因与解法不同，必须分开说 —— 合并成一句会让人以为桥挂了。
		var banner = document.getElementById("modeBanner");
		if (banner) {
			if (!isHttp()) {
				note(
					banner,
					"当前以 <code>file://</code> 打开：<b>自动加载与写回都不可用</b>（浏览器禁止 file:// 下的 fetch）。" +
						"完整功能请运行 <code>node scripts/l1-admin/viewer-bridge.mjs</code>（或 <code>npm run viewer</code>），" +
						"再打开它打印的 <code>http://localhost:5174/viewers/…?port=5174</code>。",
					"warn",
				);
			} else if (!bridgePort()) {
				note(
					banner,
					"这个地址<b>没带 <code>?port=</code></b>，所以当前是只读模式（自动加载全部分片、目录列举、画像文件与写回都依赖它）。" +
						"在地址后补 <code>?port=&lt;端口&gt;</code>（端口就是地址栏里那个）即可恢复；" +
						"或者直接用 <code>npm run viewer</code> / 桥启动时打印的那个带 <code>?port=</code> 的地址打开。",
					"warn",
				);
			}
		}
	}

	window.V = {
		PAGES: PAGES,
		RECORD_TYPES: RECORD_TYPES,
		TASK_STATE_LABELS: TASK_STATE_LABELS,
		QUALITY_CLASS: QUALITY_CLASS,
		escapeHtml: escapeHtml,
		ts: ts,
		fmtTime: fmtTime,
		fmtDay: fmtDay,
		fromNow: fromNow,
		parseJsonl: parseJsonl,
		isHttp: isHttp,
		bridgePort: bridgePort,
		bridge: bridge,
		loadText: loadText,
		loadJson: loadJson,
		loadJsonl: loadJsonl,
		loadManifest: loadManifest,
		normalizePath: normalizePath,
		projectShort: projectShort,
		groupCount: groupCount,
		debounce: debounce,
		download: download,
		note: note,
		mountChrome: mountChrome,
	};
})();
