#!/usr/bin/env python3
"""L2 场景块 → 成员 L1 记录 抽取与反查校验（只读脚本）。

背景：L2 侧历史上**从未持久化**"哪些 L1 记录进了哪一块"，所以 `scene_members.json`（2026-09-10 起
新增）对历史块是空的。本脚本从块内自由文本里抽取 L1 id 引用并反查校验，产出候选成员表，
供后续写入 sidecar 时使用（本脚本自己不写任何 memoryDB 数据）。

已探明的引用形态（来自 14 个块的真实文本）：
  1. 纯数字部分：`l1_1787277400002`          —— 记录里实际是 `l1_1787277400002_a1b2`，按数字部分匹配
  2. 带后缀全量：`l1_1787304650003_l3wr`
  3. 区间简写：  `l1_1787277400003-6`        —— `-` 后的数字替换同长度的尾部（→ 003..006）
  4. 变体前缀：  `l1_delete_1786948366003_r5` / `l1_merged_...` / `l1_tombstone_...`
  5. 噪音：      `l1_increment` / `l1_count` / `l1_17561`（截断）—— 需过滤

存活判定用 **last-write-wins**（同 id 最后一次写入为准），不用逐行 `deleted !== true` 过滤
（那会恒多算 7 条已作废记录）。另注意 `deleted` 字段有 6 行是字符串 `"false"`，按 `is True` 判定。

用法：
  python scripts/l2-extract-members.py [profilePath]
输出：
  <planDir>/L2_SCENE_CONSOLIDATION-成员抽取-分析.md        报告
  <planDir>/L2_SCENE_CONSOLIDATION-成员候选-数据.json      候选成员（block 文件名 → 存活 L1 id 列表）
"""

import glob
import io
import json
import os
import re
import sys
from collections import OrderedDict

PROFILE = sys.argv[1] if len(sys.argv) > 1 else "C:/Users/leaf/.pi/agent/profiles/default"
PLAN_DIR = sys.argv[2] if len(sys.argv) > 2 else "C:/Users/leaf/.pi/plan/memory-system/observation/L2_SCENE_CONSOLIDATION"
# 路径与扩展的 memory/paths.ts 同步（脚本无法 import TS，改动需手动对齐，见 plan MEMORYDB_LAYOUT_PLAN 3.2-B）
MEMORY_DB = os.path.join(PROFILE, "memoryDB")
RECORDS_DIR = os.path.join(MEMORY_DB, "l1", "records")
BLOCKS_DIR = os.path.join(MEMORY_DB, "l2", "scene-blocks")

# 引用：l1_<字母前缀可选><13 位左右数字>[可选 -<尾部数字>]
REF_RE = re.compile(r"l1_[A-Za-z_]{0,12}?(\d{10,13})(?:-(\d{1,10}))?")
NUM_DIGITS = 13
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T")


def load_records():
    """返回 (by_numeric, stats)。
    by_numeric: 数字部分 → {"alive": [full id], "dead": [full id], "rows": [rec]}
    LWW：同 id 后写覆盖前写。
    """
    latest = OrderedDict()  # full id -> row（后写覆盖）
    order = 0
    for path in sorted(glob.glob(os.path.join(RECORDS_DIR, "*.jsonl"))):
        if not re.match(r"\d{4}-\d{2}-\d{2}\.jsonl$", os.path.basename(path)):
            continue
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
            obj["_seq"] = order
            order += 1
            latest[rid] = obj

    by_numeric = {}
    for rid, obj in latest.items():
        m = re.search(r"(\d{10,13})", rid)
        if not m:
            continue
        num = m.group(1)
        slot = by_numeric.setdefault(num, {"alive": [], "dead": [], "rows": []})
        slot["rows"].append(obj)
        if obj.get("deleted") is True:
            slot["dead"].append(rid)
        else:
            slot["alive"].append(rid)
    return by_numeric, {"lines": order, "ids": len(latest)}


def expand_refs(text):
    """抽取引用并展开区间。返回 (values, refs_raw)。
    values: 数字字符串列表（已展开、去重、保序）
    refs_raw: 原文引用片段（用于报告可核对）
    """
    values = []
    seen = set()
    refs_raw = []
    for m in REF_RE.finditer(text):
        raw = m.group(0)
        base, tail = m.group(1), m.group(2)
        if len(base) != NUM_DIGITS:
            continue  # 过滤 l1_17561 这类截断噪音
        refs_raw.append(raw)
        nums = []
        if tail and len(tail) <= len(base):
            # 区间简写：用 tail 替换同长度的尾部
            start = base[: len(base) - len(tail)] + base[len(base) - len(tail):]
            lo = int(base[len(base) - len(tail):])
            hi = int(tail)
            if hi >= lo and hi - lo <= 50:  # 防御：区间过大说明是误匹配
                prefix = base[: len(base) - len(tail)]
                nums = [prefix + str(n).zfill(len(tail)) for n in range(lo, hi + 1)]
            else:
                nums = [base]
        else:
            nums = [base]
        for n in nums:
            if n not in seen:
                seen.add(n)
                values.append(n)
    return values, refs_raw


def main():
    by_numeric, stats = load_records()
    blocks = sorted(f for f in os.listdir(BLOCKS_DIR) if f.endswith(".md"))

    rows = []
    candidate = {}
    ambiguous = {}
    junk_timestamps = 0
    for b in blocks:
        text = io.open(os.path.join(BLOCKS_DIR, b), encoding="utf-8").read()
        values, refs_raw = expand_refs(text)
        hit, miss = [], []
        unique_ids, amb = [], {}
        cwds, times, types = set(), [], {}
        for v in values:
            slot = by_numeric.get(v)
            if not slot:
                miss.append(v)
                continue
            hit.append(v)
            alive = sorted(slot["alive"])
            if not alive:
                miss.append(v)  # 数字存在但对应记录全部作废（且有后继也判为可追溯，见下）
                continue
            if len(alive) == 1:
                unique_ids.append(alive[0])
            else:
                # 一个数字部分对应多个存活 id（实测最多 5 个）→ 无法确定哪条属于本块，需人工判断
                amb[v] = alive
            for rec in slot["rows"]:
                if rec.get("cwd"):
                    cwds.add(rec["cwd"])
                for t in rec.get("timestamps") or []:
                    if isinstance(t, str) and ISO_RE.match(t):
                        times.append(t)
                    elif isinstance(t, str):
                        junk_timestamps += 1
                if rec.get("deleted") is not True:
                    types[rec.get("type", "?")] = types.get(rec.get("type", "?"), 0) + 1
        if unique_ids:
            # 只把「数字部分唯一存活」的写进候选 —— 歧义的绝不自动采纳（最保守档）
            candidate[b] = sorted(set(unique_ids))
        if amb:
            ambiguous[b] = amb
        rows.append(
            {
                "block": b,
                "refs": len(refs_raw),
                "expanded": len(values),
                "hit": len(hit),
                "miss": miss,
                "unique_ids": sorted(set(unique_ids)),
                "ambiguous": amb,
                "cwds": sorted(cwds),
                "t_min": min(times) if times else "",
                "t_max": max(times) if times else "",
                "types": types,
            }
        )

    # ── 报告
    out = []
    out.append("# L2 场景块 → 成员 L1 记录（抽取与反查校验）\n")
    out.append(f"- profile：`{PROFILE}`")
    out.append(f"- L1 记录：{stats['lines']} 行 / {stats['ids']} 个唯一 id（LWW 后）")
    out.append(f"- 场景块：{len(blocks)} 个\n")
    total_refs = sum(r["refs"] for r in rows)
    total_exp = sum(r["expanded"] for r in rows)
    total_hit = sum(r["hit"] for r in rows)
    with_ref = [r for r in rows if r["refs"] > 0]
    no_ref = [r for r in rows if r["refs"] == 0]
    out.append("## 总览\n")
    out.append(f"- 原始引用片段：**{total_refs}** 处（分布在 {len(with_ref)} 个块；{len(no_ref)} 个块无任何引用）")
    out.append(f"- 展开后 id：**{total_exp}** 个；反查命中 **{total_hit}**，未命中 **{total_exp - total_hit}**")
    n_uniq = sum(len(r["unique_ids"]) for r in rows)
    n_amb = sum(len(r["ambiguous"]) for r in rows)
    out.append(f"- 成员归因：**唯一可归因 {n_uniq} 条**（写进候选）；**歧义 {n_amb} 个数**（不自动采纳，见专节）")
    out.append(f"- 可回填成员的块：**{len(candidate)} / {len(blocks)}**\n")
    if junk_timestamps:
        out.append(f"> ⚠️ 数据质量：`timestamps` 里有 **{junk_timestamps} 处非 ISO 字符串**（值 `\"item\"`），已从时间范围统计中剔除。\n")
    out.append("## 逐块事实表\n")
    out.append("| 块 | 引用处数 | 展开 id | 命中 | 未命中 | 唯一成员 | 歧义数 | cwd | 源消息时间范围 |")
    out.append("|----|---------|--------|------|-------|---------|-------|-----|--------------|")
    for r in rows:
        cwd = "；".join(r["cwds"]) if r["cwds"] else "（无）"
        tr = f"{r['t_min'][:10]} → {r['t_max'][:10]}" if r["t_min"] else "（无）"
        miss = str(len(r["miss"])) + (f"（{','.join(r['miss'][:3])}…）" if r["miss"] else "")
        out.append(
            f"| `{r['block']}` | {r['refs']} | {r['expanded']} | {r['hit']} | {miss} | {len(r['unique_ids'])} | {len(r['ambiguous'])} | {cwd} | {tr} |"
        )
    out.append("")
    if ambiguous:
        out.append("## 歧义引用（一个数字部分对应多个存活 id，**需人工判断**）\n")
        out.append("块里只写了数字部分（如 `l1_1787278230000`），但 L1 记录里有多个 id 共享该数字、且都存活。")
        out.append("**不自动采纳**——否则会把不相干的记录错算成该块成员（虚报）。正确做法是人工读出块内上下文判断，或接受留空。\n")
        for b, amb in ambiguous.items():
            out.append(f"**`{b}`**")
            for num, ids in amb.items():
                out.append(f"- `{num}` → {len(ids)} 个存活 id：{', '.join('`' + i + '`' for i in ids)}")
            out.append("")
    if no_ref:
        out.append("## 无任何 id 引用的块（成员只能留空）\n")
        for r in no_ref:
            out.append(f"- `{r['block']}` —— 块内没有 `l1_*` 形态的引用，**无法从文本回填**；从本批起由子代理通过 `l2_commit.members` 如实上报")
        out.append("")
    miss_all = [(r["block"], m) for r in rows for m in r["miss"]]
    if miss_all:
        out.append("## 未命中的引用（需人工判断）\n")
        for b, m in miss_all:
            out.append(f"- `{b}` → `{m}`（L1 记录里不存在该数字部分的 id）")
        out.append("")
    out.append("## 说明与限制\n")
    out.append("- 匹配按 **id 的数字部分**（块里写 `l1_<13位>`，记录里是 `l1_<13位>_<后缀>`），这是历史文本的唯一可用口径。")
    out.append("- **歧义是口径的固有代价**：一个数字部分可能对应多个存活 id（实测最多 5 个），此类引用不计入候选。")
    out.append("- 存活判定用 **LWW**；`deleted` 为字符串 `\"false\"` 的 6 行按存活计；作废记录若有后继（如 `_meth3_fix`）取后继。")
    out.append("- 本脚本**只读** memoryDB，只写本报告与候选 JSON；不写 `scene_members.json`（那一步需人工确认后单独执行）。")
    out.append("- 历史块的成员**必然不完整**（未被文本引用的记录无从追溯）——这是回填的固有上限，不是脚本缺陷。")

    report_path = os.path.join(PLAN_DIR, "L2_SCENE_CONSOLIDATION-成员抽取-分析.md")
    io.open(report_path, "w", encoding="utf-8").write("\n".join(out) + "\n")
    cand_path = os.path.join(PLAN_DIR, "L2_SCENE_CONSOLIDATION-成员候选-数据.json")
    io.open(cand_path, "w", encoding="utf-8").write(json.dumps(candidate, ensure_ascii=False, indent=2) + "\n")
    amb_path = os.path.join(PLAN_DIR, "L2_SCENE_CONSOLIDATION-成员歧义-数据.json")
    io.open(amb_path, "w", encoding="utf-8").write(json.dumps(ambiguous, ensure_ascii=False, indent=2) + "\n")

    print(f"块数 {len(blocks)}｜引用 {total_refs} 处｜展开 {total_exp} 个 id｜命中 {total_hit}｜未命中 {total_exp - total_hit}")
    print(f"唯一可归因 {n_uniq} 条 → 候选 {len(candidate)} 块；歧义 {n_amb} 个数；无引用 {len(no_ref)} 块")
    if junk_timestamps:
        print(f"注意：timestamps 有 {junk_timestamps} 处非 ISO 值（已剔除）")
    print(f"报告：{report_path}")
    print(f"候选：{cand_path}")
    print(f"歧义：{amb_path}")


if __name__ == "__main__":
    main()
