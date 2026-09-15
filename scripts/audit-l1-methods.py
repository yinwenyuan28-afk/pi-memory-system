#!/usr/bin/env python3
"""只读审计：按新 prompt 三项判别标准，对存量 work_method 记录给出处理建议。

判定规则（对齐 extract-code.md 新定义）：
- KEEP        : 含强规范词（应/必须/不应/禁止/不要/严禁/务必/切忌/优先/避免/宁）且无明显事实标记
- FACT        : 纯描述性（系统行为/架构/决策理由/一次性实施），无规范词或规范词仅泛用
- ARTIFACT    : 带 commit/文件名/路径等可引用标识的交付记录
- REVIEW      : 规范词与事实标记混杂，需人工复核
"""
import json, glob, os, re

# 与 memory/paths.ts 同步（L1_RECORDS_DIR = memoryDB/l1/records）
PROFILE = r"C:/Users/leaf/.pi/agent/profiles/default"
RECORDS = os.path.join(PROFILE, "memoryDB", "l1", "records")
NORM = re.compile(r"(应|必须|不应|禁止|不要|严禁|务必|切忌|优先|避免|宁可|宁)")
NORM_STRONG = re.compile(r"(不应|禁止|不要|严禁|务必|切忌|应优先|必须|避免)")
FACT_MARK = re.compile(r"(commit|已(完成|落地|实施|确认|修复|推送)|改为|改造|新增|修复|实现|触发|采用|回退|迁移|落地|完成)")
ARTIFACT_MARK = re.compile(r"(commit\s*[0-9a-f]{6,}|C:/|~\.|\.ts\b|\.vue\b|\.json\b|\.md\b|PR\s*#|issue\s*#|file://|仓库)")

def suggest(content: str) -> str:
    has_norm_strong = bool(NORM_STRONG.search(content))
    has_norm = bool(NORM.search(content))
    has_fact = bool(FACT_MARK.search(content))
    has_artifact = bool(ARTIFACT_MARK.search(content))
    if has_artifact and not has_norm_strong:
        return "ARTIFACT"
    if has_norm_strong and not has_fact:
        return "KEEP"
    if has_norm_strong and has_fact:
        return "REVIEW"
    return "FACT"

rows = []
for f in sorted(glob.glob(os.path.join(RECORDS, "*.jsonl"))):
    with open(f, encoding="utf-8") as fh:
        for line in fh:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("type") == "work_method" and not o.get("deleted"):
                rows.append((os.path.basename(f), o["id"], suggest(o.get("content", "")), o.get("content", "")))

from collections import Counter
print(f"共 {len(rows)} 条未删除 work_method")
print(Counter(r[2] for r in rows).most_common())
print("=" * 90)
for fn, rid, action, content in rows:
    short = content.replace("\n", " ")[:120]
    print(f"[{action:8s}] {fn} {rid}")
    print(f"    {short}")
