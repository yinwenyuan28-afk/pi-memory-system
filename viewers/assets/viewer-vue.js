/*
 * viewers/assets/viewer-vue.js —— 查看器共享 Vue 层（Vue 3 + Element Plus）
 *
 * ── 这一层负责什么 ──────────────────────────────────────────────────────────
 *
 * 1. **把 Element Plus 装上**（含中文 locale）并统一全局组件名；
 * 2. **提供领域组件**：胶囊（形状编码种类）/ 度量 token / 统计行 / 提示条 / JSON 折叠块 /
 *    分段切换 / 悬停说明 / 条形图 / 直方图 —— 这些是 Element Plus 表达不了的"领域形状"，
 *    见下面「为什么有些东西不用 el-*」；
 * 3. **统一挂载入口** `V.vue.mount()`：页面脚本只声明一个组件，其余（暗色主题类、EP 安装、
 *    locale、错误兜底、导航）都在这里做掉，避免五个页面各写一遍。
 *
 * ── 为什么有些东西不用 el-*（设计契约优先于"都用组件库"）─────────────────────
 *
 * · **胶囊（.chip）不用 el-tag**：契约 2 规定「形状编码种类」—— 实心彩丸=已定状态、
 *   虚线丸=未落定（work_task open / 场景未归类）、点线丸=已搁置（dropped）、无色方块=分类值。
 *   el-tag 的 type 只有 primary/success/warning/info/danger 五档，且全是实心同形，
 *   用它就得把"虚线/点线"这层语义丢掉 —— 那正是这一页读起来便宜的原因，不能丢。
 * · **度量（.metric）不用 el-text**：等宽 + tabular-nums 是契约 4（跨几百张卡片对齐同一列数字）。
 * · **卡片（.card）不用 el-card**：卡片是领域形状（3px 质量条 + 截断正文 + 属性胶囊），
 *   el-card 的 header/body 结构塞不进去，强行用会在每个卡片外再套一层无信息的盒子。
 *
 * 换句话说：**EP 负责"外壳控件"（按钮 / 输入 / 下拉 / 表格 / 弹层 / 分页 / 提示），
 * 领域形状仍由本仓库自己的 CSS 表达**。这条分工写进 viewer-theme.css 的文件头契约。
 *
 * ── 依赖与顺序（写错即白屏，见 vendor/README.md）─────────────────────────────
 *
 *   vue.global.prod.js → element-plus/index.full.min.js → locale-zh-cn.min.js
 *   → viewer-core.js（window.V）→ 本文件 → <页面>-app.js
 */
(function () {
	"use strict";

	var V = window.V;
	var UI = window.ViewerI18n || { locale: "zh-CN", t: function (s) { return s; } };
	if (!V) {
		// viewer-core 没加载：只有把话说在页面上才查得动（控制台里的红字用户看不到）
		document.body.insertAdjacentHTML(
			"afterbegin",
			'<div class="notice err" style="margin:16px">viewer-core.js 未加载：本页依赖 <code>window.V</code>。请检查 HTML 里脚本顺序（见 assets/vendor/README.md）。</div>',
		);
		return;
	}
	if (!window.Vue || !window.ElementPlus) {
		document.body.insertAdjacentHTML(
			"afterbegin",
			'<div class="notice err" style="margin:16px">Vue 或 Element Plus 未加载：请检查 <code>assets/vendor/</code> 下的脚本是否按顺序引入（Vue 必须在 Element Plus 之前 —— EP 的 UMD 包装在加载时就要取全局 <code>Vue</code>）。</div>',
		);
		return;
	}

	var Vue = window.Vue;
	var EP = window.ElementPlus;

	// The selected theme is persisted by viewer-core and shared across all pages.

	// ── 小工具（各页此前各写一份，现在收在这里一处）──────────────────────────

	/** 当前是否带写盘桥（`?port=`）。写动作的启用条件、只读提示都问它。 */
	function hasPort() {
		return !!V.bridgePort();
	}

	/**
	 * 从桥返回里挖出**人话错误**。
	 *
	 * 桥的失败形态有三种：CLI 拒绝（`data.error`）、命令失败带 stdout（`data.raw`）、
	 * 进程错误（`data.stderr`）；HTTP 非 2xx 时上面可能都为空。按这个顺序取第一个非空的，
	 * 都没有就退回 `HTTP <status>` —— 返回值一定是给用户看的一句话，不会是 undefined。
	 *
	 * @param r `V.bridge()` 的返回（`{ok, status, data}`）
	 * @returns 错误文本
	 */
	function bridgeError(r) {
		var d = (r && r.data) || {};
		return String(d.error || d.raw || d.stderr || (r && r.status ? "HTTP " + r.status : "未知错误"));
	}

	/** 结构化输出 → 等宽折叠块（把端点原样返回摆出来，不替用户"总结"掉证据）。 */
	var JsonDetails = {
		name: "JsonDetails",
		props: {
			summary: { type: String, default: "返回" },
			value: { type: null, default: null },
		},
		computed: {
			text: function () {
				try {
					return JSON.stringify(this.value === undefined ? null : this.value, null, 2);
				} catch (e) {
					return String(this.value);
				}
			},
		},
		template:
			'<details class="log"><summary>{{ summary }}</summary><pre class="log-text">{{ text }}</pre></details>',
	};

	/**
	 * 领域胶囊（契约 2 的形状编码）。
	 *
	 * @prop kind  形状+语义 class（如 "task-open" / "del" / "q-hot" / "st-running"）；空串=无色分类值
	 * @prop label 文本
	 * @prop tip   title 提示（悬停看口径）
	 */
	var Chip = {
		name: "Chip",
		props: {
			kind: { type: String, default: "" },
			label: { type: [String, Number], default: "" },
			tip: { type: String, default: "" },
		},
		template: '<span class="chip" :class="kind" :title="tip || null">{{ label }}</span>',
	};

	/** 度量 token（契约 4：等宽 + tabular-nums，跨行对齐）。 */
	var Metric = {
		name: "Metric",
		props: {
			value: { type: [String, Number], default: "" },
			tip: { type: String, default: "" },
			kind: { type: String, default: "" },
		},
		template: '<span class="metric" :class="kind" :title="tip || null">{{ value }}</span>',
	};

	/**
	 * 统计行列表（侧栏概览）。
	 *
	 * 是一条分隔线列表而不是一叠盒子（旧版每行一个圆角块，14 行就是 14 个盒子）。
	 *
	 * @prop rows  [{label, value}] —— value 允许 HTML（页面已转义），因为常用 <b>/<code> 强调
	 * @prop foot  补充说明（字符串数组，渲染成 .hint）
	 */
	var StatList = {
		name: "StatList",
		props: {
			rows: { type: Array, default: function () { return []; } },
			foot: { type: Array, default: function () { return []; } },
		},
		template:
			'<div class="stats">' +
			'<div class="stat" v-for="(r, i) in rows" :key="i"><span>{{ r.label }}</span><span v-html="r.value"></span></div>' +
			'<div class="hint" v-for="(f, i) in foot" :key="\'f\' + i" v-html="f"></div>' +
			"</div>",
	};

	/**
	 * 提示条（取代旧的 `V.note(id, html, level)`）。
	 *
	 * @prop msg `{html, level}`；html 由调用方负责转义（里面常要放 <code>），level 为 ""/"warn"/"err"
	 */
	var Notice = {
		name: "Notice",
		props: {
			msg: { type: Object, default: function () { return { html: "", level: "" }; } },
		},
		template: '<div class="notice" :class="msg.level" v-html="msg.html"></div>',
	};

	/**
	 * 分段切换（提取模式 / 排序这类"二选一、一眼看全"的开关）。
	 *
	 * 用 el-radio-group + el-radio-button：EP 原生就是分段控件（相邻按钮拼接、选中项浮底色），
	 * 比旧版自己拼 `.seg` 少一套样式。样式覆盖在 viewer-theme.css（选中项不用色相，契约 1）。
	 *
	 * @prop modelValue 选中值
	 * @prop options    [{value, label, title, disabled}]
	 * @emits update:modelValue / change
	 */
	var Seg = {
		name: "Seg",
		props: {
			modelValue: { type: [String, Number, Boolean], default: "" },
			options: { type: Array, default: function () { return []; } },
			disabled: { type: Boolean, default: false },
		},
		emits: ["update:modelValue", "change"],
		template:
			'<el-radio-group class="seg" size="small" :disabled="disabled" :model-value="modelValue" @update:model-value="pick">' +
			'<el-radio-button v-for="o in options" :key="String(o.value)" :value="o.value" :disabled="!!o.disabled" :title="o.title || \'\'">{{ o.label }}</el-radio-button>' +
			"</el-radio-group>",
		methods: {
			pick: function (v) {
				this.$emit("update:modelValue", v);
				this.$emit("change", v);
			},
		},
	};

	/**
	 * 悬停才展开的说明（用户 2026-10-10 要求：说明文本默认隐藏，鼠标悬停再展示）。
	 *
	 * 用 `?` 标记承载 el-tooltip，而不是把整段说明做成 title —— title 的原生提示要等 1 秒以上、
	 * 换行不可控，而这里的说明常有 2~3 行。`raw` 打开时允许 HTML（`<code>` 一类）。
	 *
	 * @prop text 说明文本（raw=true 时是 HTML）
	 * @prop raw  是否按 HTML 渲染
	 */
	var HelpNote = {
		name: "HelpNote",
		props: {
			text: { type: String, default: "" },
			raw: { type: Boolean, default: false },
		},
		template:
			'<el-tooltip :content="text" :raw-content="raw" placement="top-start" :show-after="80" :hide-after="0">' +
			'<span class="help-mark" tabindex="0" aria-label="说明">?</span></el-tooltip>',
	};

	/**
	 * 条形图（质量标签计数）。颜色 class 由数据侧给出（.c-hot/.c-warm/…），
	 * 兜底色写成 :where() 让出特异度（旧版踩过：兜底规则把小节拍掉了）。
	 *
	 * @prop rows [{label, count, cls, pct}] —— pct 为 0~100
	 */
	var BarList = {
		name: "BarList",
		props: { rows: { type: Array, default: function () { return []; } } },
		template:
			'<div class="bars">' +
			'<div class="bar-row" v-for="(r, i) in rows" :key="i"><span>{{ r.label }}</span>' +
			'<span class="bar-track"><i :class="r.cls" :style="{ width: r.pct + \'%\' }"></i></span>' +
			'<span class="num">{{ r.count }}</span></div>' +
			"</div>",
	};

	/**
	 * 直方图（质量分分箱）。用 flex 底对齐的柱子，不引图表库 —— 它只有十几个箱、
	 * 只在侧栏出现一次，引一个图表库等于为一张图多背 200KB。
	 *
	 * @prop cols [{label, count, pct, tip}]
	 */
	var Hist = {
		name: "Hist",
		props: { cols: { type: Array, default: function () { return []; } } },
		template:
			'<div class="hist">' +
			'<div class="col" v-for="(c, i) in cols" :key="i" :title="c.tip || null">' +
			'<span class="val">{{ c.count }}</span>' +
			'<span class="fill" :style="{ height: c.pct + \'%\' }"></span>' +
			'<span class="lbl">{{ c.label }}</span>' +
			"</div></div>",
	};

	/** 全局注册的组件表（名字 → 定义）；页面模板里直接用 kebab-case。 */
	var COMPONENTS = {
		Chip: Chip,
		Metric: Metric,
		StatList: StatList,
		Notice: Notice,
		JsonDetails: JsonDetails,
		Seg: Seg,
		HelpNote: HelpNote,
		BarList: BarList,
		Hist: Hist,
	};

	/**
	 * 页面公共部分：加载提示与"一次只飞一个动作"的忙碌标记。
	 *
	 * 各页此前都有一份 `state.busy` + `V.note("loadNote", …)`，语义完全一致 —— 收进 mixin，
	 * 页面只写自己的业务方法。
	 */
	var pageMixin = {
		data: function () {
			return {
				/** 加载提示条：{html, level} */
				loadNote: { html: "加载中…", level: "" },
				/** 正在飞的动作键（"" = 空闲）；同一时刻只允许一个写动作 */
				busy: "",
			};
		},
		methods: {
			/**
			 * 写加载提示。
			 * @param html  文案（调用方转义）
			 * @param level "" | "warn" | "err"
			 */
			setNote: function (html, level) {
				this.loadNote = { html: html, level: level || "" };
			},
			hasPort: hasPort,
			bridgeError: bridgeError,
			/** 让 `<code>` 这类片段在提示里能正常显示（转义后拼串是既有纪律）。 */
			esc: V.escapeHtml,
			// 时间格式化进模板：模板里写 `{{ fromNow(r.updatedAt) }}` 比每页各写一个 computed 直白
			fmtTime: V.fmtTime,
			fmtDay: V.fmtDay,
			fromNow: V.fromNow,
			t: UI.t,
		},
	};

	/**
	 * 挂载一个查看器页面。
	 *
	 * 顶部导航 / 版本 chip / 只读横幅**仍由 viewer-core 的 `mountChrome` 负责**：
	 * 它是 gate ⑰ 钉住的契约（页内跳转必须带 `location.search`、缺 `?port=` 要给可操作提示、
	 * 桥地址按页面自身 hostname 拼），把它搬进 Vue 只会让那条门禁去断言一段死代码。
	 * 所以页面骨架保持"`#nav` 由 core 写、`#app` 由 Vue 写"这条分界。
	 *
	 * @param root  根组件定义
	 * @param opts  {active, selector}
	 * @returns 应用实例（一般不用）
	 */
	function mount(root, opts) {
		opts = opts || {};
		V.mountChrome({ active: opts.active });

		var app = Vue.createApp(root);
		app.use(EP, UI.locale === "en" ? {} : { locale: window.ElementPlusLocaleZhCn });
		Object.keys(COMPONENTS).forEach(function (name) {
			app.component(name, COMPONENTS[name]);
		});
		app.config.globalProperties.$V = V;
		app.config.globalProperties.$t = UI.t;

		// 渲染期异常兜底：Vue 默认只把错误丢进控制台，页面看起来"半截渲染"却没有任何提示。
		// 这一页的用户是排查记忆库的人，把错误直接摆在页面顶部比什么都强。
		app.config.errorHandler = function (err, instance, info) {
			console.error("[viewer]", err, info);
			var box = document.getElementById("vueError");
			if (!box) {
				box = document.createElement("div");
				box.id = "vueError";
				box.className = "notice err";
				box.style.margin = "12px 20px";
				var host = document.getElementById("app");
				if (host && host.parentNode) host.parentNode.insertBefore(box, host);
				else document.body.insertBefore(box, document.body.firstChild);
			}
			box.innerHTML =
				"页面渲染出错（" + V.escapeHtml(String(info)) + "）：<code>" + V.escapeHtml(err && err.message ? err.message : String(err)) + "</code>" +
				" —— 数据仍可能已加载，刷新可重试；若一直如此请把这条信息连同控制台堆栈一起反馈。";
		};

		return app.mount(opts.selector || "#app");
	}

	/**
	 * 确认框（写动作前的人话确认）。
	 *
	 * 用 EP 的 MessageBox 而不是 `window.confirm`：一是样式统一，二是**浏览器自动化的
	 * confirm 会被外部直接接受**（2026-10-10 实测：自动化点"删除（墓碑）"时 confirm 被静默
	 * 接受，页面 JS 却卡在同步阻塞上）—— 换成基于 Promise 的弹层后不存在这种半死状态。
	 *
	 * @returns Promise<boolean>（取消 = false）
	 */
	function confirmBox(message, title) {
		return EP.ElMessageBox.confirm(UI.t(message), UI.t(title || "确认"), {
			confirmButtonText: UI.t("确定"),
			cancelButtonText: UI.t("取消"),
			type: "warning",
			// 危险动作的正文里有换行（代价说明），保留换行才读得懂
			customClass: "viewer-confirm",
		})
			.then(function () {
				return true;
			})
			.catch(function () {
				return false;
			});
	}

	/** 轻提示（动作成功/失败的一句话）。 */
	function toast(message, type) {
		EP.ElMessage({ message: UI.t(message), type: type || "info", duration: type === "error" ? 6000 : 2600, grouping: true });
	}

	V.vue = {
		mount: mount,
		pageMixin: pageMixin,
		hasPort: hasPort,
		bridgeError: bridgeError,
		confirm: confirmBox,
		toast: toast,
		components: COMPONENTS,
	};
})();
