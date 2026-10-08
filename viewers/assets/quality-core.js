/*
 * viewers/assets/quality-core.js —— L1 质量分 / 淘汰判定的**唯一 JS 副本**（classic script，挂 window.VQ）
 *
 * ⚠ 这是 `memory/l1/quality.ts` 的**移植**，不是它的来源。任何公式改动都必须两边同改，
 *   并由 `scripts/verify-viewer-quality-parity.ts` 用同一批夹具逐例断言数值相等。
 *
 * 为什么要有 parity 门禁（而不是靠页头注释声称"与 quality.ts 1:1"）：
 *   旧版查看器的注释写着「与 memory/l1/quality.ts 1:1」，但 `prune / judgePrune /
 *   protectedPriority / percentile` 在整份文件里出现 **0 次** —— 也就是说"1:1"从来没人验证过，
 *   它只是一句自我声明。声明会漂移，断言不会。门禁跑 TS 与 JS 两份实现比数值，不一致就红。
 *
 * ── 移植时必须保住的三个语义（都是 quality.ts 里踩过的坑）──
 *
 *  1. **两条时钟不要混**：`days` 是"自上次命中以来的**活跃会话日**"（喂 decay 与冷/待观察判定），
 *     `ageDays` 是"记录真实年龄的**日历天**"（只喂新记录保护与「新」标签）。
 *     混用会让停工用户的老记忆被误判为"新"并拿回 priority 保底分。
 *  2. **quality 与淘汰资格是两件事**：quality 是热度、会衰减到 0（符合遗忘曲线）；
 *     `judgePrune` 才回答"能不能删"——高 priority 与 `work_method` 类永不自动淘汰。
 *     只显示 quality 而不显示 prune 候选，等于把"删除资格"这一半隐藏了。
 *  3. **保护带是按分布取的 P75（下限 60）**，不是固定 60：实测提取出的 priority 有通胀
 *     （全库最低 65、中位 85），固定阈值会保护 100% 记录、让淘汰整体失效。
 */
(function () {
	"use strict";

	/** 淘汰规则参数（必须与 quality.ts 的 PRUNE_RULES 逐字一致）。 */
	var PRUNE_RULES = {
		minHitsForFalsified: 3,
		invalidRatio: 0.5,
		idleActiveDays: 30,
		protectedPriority: 60,
		protectedPercentile: 75,
	};

	/** 永不自动淘汰的类型（与 record-types.ts 的 PROTECTED_L1_TYPES 一致）。 */
	var PROTECTED_TYPES = ["work_method"];

	/** 本地日 0 点时间戳（与 active-days.ts 的 startOfLocalDay 一致）。 */
	function startOfLocalDay(ms) {
		var d = new Date(ms);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}

	/** 二分统计 base（**不含当天**）之后的活跃日数量（与 active-days.ts 同实现）。 */
	function countActiveDaysAfter(sortedDays, baseMs) {
		var base = startOfLocalDay(baseMs);
		var lo = 0;
		var hi = sortedDays.length;
		while (lo < hi) {
			var mid = (lo + hi) >> 1;
			if (sortedDays[mid] <= base) lo = mid + 1;
			else hi = mid;
		}
		return sortedDays.length - lo;
	}

	/**
	 * 把命中统计归一成驼峰字段。
	 *
	 * 为什么需要：`hit-stats.json` 侧车里的 `stats` 是**数据库原始行**（snake_case：
	 * `invalid_hits` / `effective_hits` / `last_hit_at`），而 quality.ts 收的是 mapRow 之后的
	 * 驼峰对象。前端两条来源都见得到（侧车 + 桥），在这里收敛一次，别让公式里到处 `??`。
	 *
	 * @returns 驼峰对象；入参为空返回 undefined（= "无统计"，走新记录分支）
	 */
	function normalizeStat(raw) {
		if (!raw || typeof raw !== "object") return undefined;
		function pick(a, b) {
			if (raw[a] !== undefined && raw[a] !== null) return raw[a];
			return raw[b];
		}
		return {
			recordId: pick("record_id", "recordId"),
			hits: Number(pick("hits", "hits") || 0),
			injectHits: Number(pick("inject_hits", "injectHits") || 0),
			toolHits: Number(pick("tool_hits", "toolHits") || 0),
			invalidHits: Number(pick("invalid_hits", "invalidHits") || 0),
			effectiveHits: Number(pick("effective_hits", "effectiveHits") || 0),
			lastHitAt: pick("last_hit_at", "lastHitAt") || null,
			lastInvalidAt: pick("last_invalid_at", "lastInvalidAt") || null,
		};
	}

	/**
	 * 计算单条 L1 的质量分（纯函数，不读盘）。与 quality.ts 的 calcQuality 等价。
	 *
	 * @param rec L1 记录
	 * @param stat 命中统计（驼峰；无则视为 0 命中新记录）
	 * @param nowMs 当前时间戳
	 * @param activeDays 活跃会话日时间戳（升序，本地日 0 点）；不传则 days 退化为日历天数
	 * @returns {quality, decay, days, tag, effective, hits, invalid, activeDayClock}
	 */
	function calcQuality(rec, stat, nowMs, activeDays) {
		nowMs = nowMs || Date.now();
		var hits = stat ? stat.hits || 0 : 0;
		var invalid = stat ? stat.invalidHits || 0 : 0;
		var effective = stat ? stat.effectiveHits || 0 : 0;

		var last = stat && stat.lastHitAt ? new Date(stat.lastHitAt).getTime() : NaN;
		var created = rec.createdAt ? new Date(rec.createdAt).getTime() : nowMs;
		var baseTime = !Number.isNaN(last) ? last : created;

		// 活跃会话日时钟：停工期间不增长。无活跃日数据时退化为墙上时钟。
		var activeDayClock = Array.isArray(activeDays);
		var days = activeDayClock ? countActiveDaysAfter(activeDays, baseTime) : Math.max(0, (nowMs - baseTime) / 86400000);
		var decay = Math.exp(-days / 14);

		// 记录真实年龄（日历天）：新记录保护与「新」标签只认它，不认活跃日
		var ageDays = Math.max(0, (nowMs - created) / 86400000);

		// D4 新记录保护：创建 <7 天且 0 命中，用 priority 保底
		if (!stat && ageDays < 7) {
			var pri = typeof rec.priority === "number" ? rec.priority : 50;
			return { quality: Math.max(pri / 100, 0.3), decay: decay, days: days, tag: "新", effective: effective, hits: hits, invalid: invalid, activeDayClock: activeDayClock };
		}

		// 噪优先：失效率 > 50%（仅 hits>0 时）
		if (hits > 0 && invalid / hits > 0.5) {
			var penaltyNoise = 1 - Math.min(invalid / hits, 0.8);
			return { quality: effective * decay * penaltyNoise, decay: decay, days: days, tag: "噪", effective: effective, hits: hits, invalid: invalid, activeDayClock: activeDayClock };
		}

		var penalty = hits > 0 ? 1 - Math.min(invalid / hits, 0.8) : 1;
		var quality = effective * decay * penalty;

		var tag = "温";
		if (effective >= 5) tag = "热";
		else if (effective >= 1) tag = "温";
		else if (ageDays < 7) tag = "新";
		else if (days > 14) tag = "冷";
		else tag = "待观察";

		return { quality: quality, decay: decay, days: days, tag: tag, effective: effective, hits: hits, invalid: invalid, activeDayClock: activeDayClock };
	}

	/**
	 * 淘汰资格判定（与 quality.ts 的 judgePrune 等价）。
	 *
	 * @param rec L1 记录（取 priority / type）
	 * @param q 质量分（取 hits / invalid / effective / days）
	 * @param protectedPriority 本次生效的保护带阈值（由 保护带阈值() 按分布算出）
	 * @returns {eligible, reason}
	 */
	function judgePrune(rec, q, protectedPriority) {
		if (q.hits >= PRUNE_RULES.minHitsForFalsified && q.invalid / q.hits > PRUNE_RULES.invalidRatio) {
			return { eligible: true, reason: "falsified" };
		}
		var threshold = protectedPriority === undefined || protectedPriority === null ? PRUNE_RULES.protectedPriority : protectedPriority;
		var pri = typeof rec.priority === "number" ? rec.priority : 50;
		if (pri >= threshold) return { eligible: false, reason: "protected-priority" };
		if (PROTECTED_TYPES.indexOf(rec.type || "") >= 0) return { eligible: false, reason: "protected-type" };
		if (q.effective > 0) return { eligible: false, reason: "verified" };
		if (q.days >= PRUNE_RULES.idleActiveDays) return { eligible: true, reason: "idle-low-value" };
		return { eligible: false, reason: "too-early" };
	}

	/** 取升序数组的第 p 百分位（与 quality.ts 的 percentile 等价）。 */
	function percentile(sortedAsc, p) {
		if (sortedAsc.length === 0) return 0;
		var idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
		return sortedAsc[Math.min(Math.max(idx, 0), sortedAsc.length - 1)];
	}

	/**
	 * 本次生效的保护带阈值 = max(60, priority 分布 P75)。
	 *
	 * @param ranked 已算过质量分的记录数组（读 priority）
	 */
	function protectedPriorityOf(ranked) {
		var pris = ranked
			.map(function (r) {
				return typeof r.priority === "number" ? r.priority : 50;
			})
			.sort(function (a, b) {
				return a - b;
			});
		return Math.max(PRUNE_RULES.protectedPriority, percentile(pris, PRUNE_RULES.protectedPercentile));
	}

	/** 淘汰原因的中文文案（页面上直接展示，避免读者去翻源码）。 */
	var PRUNE_REASON_LABELS = {
		falsified: "被真实证伪（曝光足够且失效率 > 50%）",
		"idle-low-value": "长期闲置且内在价值低",
		"protected-priority": "高 priority 保护（不淘汰）",
		"protected-type": "受保护类型（不淘汰）",
		verified: "被有效使用过（不淘汰）",
		"too-early": "还太新（不淘汰）",
	};

	window.VQ = {
		PRUNE_RULES: PRUNE_RULES,
		PROTECTED_TYPES: PROTECTED_TYPES,
		PRUNE_REASON_LABELS: PRUNE_REASON_LABELS,
		startOfLocalDay: startOfLocalDay,
		countActiveDaysAfter: countActiveDaysAfter,
		normalizeStat: normalizeStat,
		calcQuality: calcQuality,
		judgePrune: judgePrune,
		percentile: percentile,
		protectedPriorityOf: protectedPriorityOf,
	};
})();
