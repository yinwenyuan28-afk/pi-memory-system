#!/usr/bin/env python3
"""L1 情境名复用率度量（只读，不改任何数据）。

背景：情境名碎片化的根因是「上一批用的名字」从未注入子代理，导致每批各自造句。
修复后主进程在每次提取前注入 PreviousScene / RecentScenes，本脚本量化收敛效果。

指标定义（分母口径来自 memoryDB/l1-anchor-log.jsonl 的真实注入记录）：

  复用率 = 可归属的新 active 记录中，scene_name 命中「该次提取提供的候选集」的比例
  其中 候选集 = {previous} ∪ {recent 各条名字}

归属方法：记录落盘时刻 createdAt（2026-09-10 起由代码覆写，可信）落在哪个锚点日志条目
之后，就归属该条目。**历史记录的 createdAt 由子代理自填、不可信，不参与归属**，只用它们
算「全局收敛度」作为对照基线。

用法：
  python scripts/l1-scene-reuse-rate.py [profilePath]
默认 profilePath = C:/Users/leaf/.pi/agent/profiles/default
"""

import glob
import io
import json
import os
import sys
from datetime import datetime, timezone

PROFILE = sys.argv[1] if len(sys.argv) > 1 else "C:/Users/leaf/.pi/agent/profiles/default"
RECORDS_DIR = os.path.join(PROFILE, "memoryDB", "l1-records")
ANCHOR_LOG = os.path.join(PROFILE, "memoryDB", "l1-anchor-log.jsonl")


def parse_iso(s):
    if not isinstance(s, str) or not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_records():
    """返回按「全局追加序」排列的 active 记录（同 id 后写覆盖前写，不读 deleted 字段做过滤）。"""
    by_id = {}
    order = 0
    for path in sorted(glob.glob(os.path.join(RECORDS_DIR, "*.jsonl"))):
        if not os.path.basename(path)[:10].replace("-", "").isdigit():
            continue  # 只认 YYYY-MM-DD.jsonl
        for line in io.open(path, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            rid = obj.get("id")
            if not isinstance(rid, str):
                continue
            by_id[rid] = {
                "seq": order,
                "deleted": obj.get("deleted") is True,
                "name": (obj.get("scene_name") or "").strip(),
                "cwd": obj.get("cwd") or "",
                "created_at": parse_iso(obj.get("createdAt")),
                "type": obj.get("type") or "",
            }
            order += 1
    alive = [v for v in by_id.values() if not v["deleted"] and v["name"]]
    alive.sort(key=lambda r: r["seq"])
    return alive


def load_anchor_log():
    if not os.path.exists(ANCHOR_LOG):
        return []
    entries = []
    for line in io.open(ANCHOR_LOG, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        at = parse_iso(obj.get("at"))
        if at is None:
            continue
        prev = obj.get("previous") or None
        recent = obj.get("recent") or []
        names = set()
        if isinstance(prev, dict) and prev.get("name"):
            names.add(prev["name"])
        for r in recent:
            if isinstance(r, dict) and r.get("name"):
                names.add(r["name"])
        entries.append({"at": at, "previous": (prev or {}).get("name") if isinstance(prev, dict) else None, "names": names})
    entries.sort(key=lambda e: e["at"])
    return entries


def pct(n, d):
    return f"{(100.0 * n / d):.1f}%" if d else "n/a"


def main():
    alive = load_records()
    logs = load_anchor_log()
    distinct = len({r["name"] for r in alive})

    print("=" * 68)
    print("L1 情境名复用率")
    print("=" * 68)
    print(f"profile            : {PROFILE}")
    print(f"active 记录        : {len(alive)}")
    print(f"distinct scene_name: {distinct}")
    if alive:
        # 全局收敛度 = 1 - distinct/total。历史基线 ≈ 0.57（232 条 / 99 个名字量级）
        conv = 1.0 - distinct / len(alive)
        print(f"全局收敛度         : {conv:.1%}   （= 1 - distinct/active，越高名字越集中）")

    print()
    if not logs:
        print("锚点日志：不存在或为空 → 无法计算批级复用率。")
        print(f"期望路径：{ANCHOR_LOG}")
        print("修复上线后需：重启 pi → 触发一次 L1 提取（/my-memory:l1-trigger），日志即产生。")
        print("提示：全局收敛度只反映历史状态；真正的复用率必须有分母（注入候选集）。")
        return

    first = logs[0]["at"]
    print(f"锚点日志           : {len(logs)} 条，{first.isoformat()} → {logs[-1]['at'].isoformat()}")

    attributable = [r for r in alive if r["created_at"] and r["created_at"] >= first]
    print(f"可归属记录         : {len(attributable)}（createdAt ≥ 首条日志时间；更早的记录时间戳不可信，不计入）")
    if not attributable:
        print("尚无可归属记录 → 修复后还没有新记录落盘。")
        return

    hit_prev = 0
    hit_any = 0
    by_day = {}
    for r in attributable:
        entry = None
        for e in logs:  # 取 createdAt 之前最近的一条
            if e["at"] <= r["created_at"]:
                entry = e
            else:
                break
        if entry is None:
            continue
        ok = r["name"] in entry["names"]
        hit_any += 1 if ok else 0
        hit_prev += 1 if r["name"] == entry["previous"] else 0
        day = r["created_at"].date().isoformat()
        d = by_day.setdefault(day, [0, 0])
        d[0] += 1
        d[1] += 1 if ok else 0

    print()
    print(f"复用率（命中候选集）: {pct(hit_any, len(attributable))}  （{hit_any}/{len(attributable)}）")
    print(f"其中命中 PreviousScene: {pct(hit_prev, len(attributable))}  （{hit_prev}/{len(attributable)}）")
    print()
    print("分天：")
    for day in sorted(by_day):
        total, hit = by_day[day]
        print(f"  {day}  {hit}/{total}  复用率 {pct(hit, total)}")


if __name__ == "__main__":
    main()
