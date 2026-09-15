#!/usr/bin/env python3
"""存量 work_method 误分类修正脚本（对齐 dedup update 语义）。

用法：
  python fix-l1-method-types.py --dry-run            # 只打印将执行的修改（默认）
  python fix-l1-method-types.py --mode=inline        # 原地改 type 字段（最小变更）
  python fix-l1-method-types.py --mode=append        # 旧记录标 deleted + 追加新记录（对齐 dedup 语义）

前置：先备份 l1/records/ 目录。改完若启用向量化，需 /my-memory:l1:embedding:rebuild。
"""
import argparse, json, os, re, shutil, sys, time, glob
from collections import Counter

# 与 memory/paths.ts 同步（L1_RECORDS_DIR = memoryDB/l1/records；备份归 backups/）
PROFILE = r"C:/Users/leaf/.pi/agent/profiles/default"
RECORDS = os.path.join(PROFILE, "memoryDB", "l1", "records")
BACKUP = os.path.join(PROFILE, "memoryDB", "backups", "l1-records-20260822")

# 人工复核结果：record_id -> 修正后的 type（仅列出需要修正的）
FIX = {
    # --- 降级 work_fact ---
    "l1_1786940561838_c3d4": "work_fact",
    "l1_1787022400001_arch": "work_fact",
    "l1_1787025800004_strategy": "work_fact",
    "l1_1787025800001_unify": "work_fact",
    "l1_1787037700004_hybrid": "work_fact",
    "l1_1787039896348_g7h8": "work_fact",
    "l1_1787194400004_tui": "work_fact",
    "l1_1787198100003_proxy": "work_fact",
    "l1_1787198510002_c3d4": "work_fact",
    "l1_1787190820001_staging": "work_fact",
    "l1_1787212758004_g7h8": "work_fact",
    "l1_1787210999004_i9j0": "work_fact",
    "l1_1787219387001_b2c3": "work_fact",
    "l1_1787277400002_c3d4": "work_fact",
    "l1_1787296800003_meth3": "work_fact",
    "l1_1787025800007_review": "work_fact",
    "l1_1787030400004_review2": "work_fact",
    "l1_1787017600001_inject": "work_fact",
    "l1_1787017600003_jsonl": "work_fact",
    "l1_1787020852001_serial": "work_fact",
    "l1_1787022400004_update_serial": "work_fact",
    # --- 降级 work_artifact ---
    "l1_1755415192001_tool1": "work_artifact",
    "l1_1755418960003_fix": "work_artifact",
    "l1_1787006600000_r7x2": "work_artifact",
    "l1_1787019200002_fix1": "work_artifact",
    "l1_1787194400001_fix1": "work_artifact",
}

def load_all():
    rows = {}
    for f in glob.glob(os.path.join(RECORDS, "*.jsonl")):
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if isinstance(o, dict) and o.get("id"):
                    rows.setdefault(o["id"], []).append((f, line, o))
    return rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["inline", "append"], default="inline")
    ap.add_argument("--dry-run", action="store_true", default=True)
    ap.add_argument("--no-dry-run", dest="dry_run", action="store_false")
    args = ap.parse_args()

    rows = load_all()
    missing = [rid for rid in FIX if rid not in rows]
    if missing:
        print(f"WARN: 以下 record_id 未找到，跳过: {missing}")

    plan = []
    for rid, new_type in FIX.items():
        if rid not in rows:
            continue
        for f, line, o in rows[rid]:
            if o.get("type") == new_type:
                print(f"SKIP  {rid} 已是 {new_type}")
                continue
            plan.append((f, line, o, new_type))

    print(f"\n待修正 {len(plan)} 条（mode={args.mode}, dry_run={args.dry_run}）")
    for f, line, o, new_type in plan:
        print(f"  [{o['type']} -> {new_type}] {o['id']}  {o.get('content','')[:60]}")

    if args.dry_run:
        print("\n[dry-run] 未写入任何文件。确认后加 --no-dry-run 执行。")
        return

    if not os.path.isdir(BACKUP):
        shutil.copytree(RECORDS, BACKUP)
        print(f"\n已备份: {BACKUP}")

    by_file = {}
    for f, line, o, new_type in plan:
        by_file.setdefault(f, []).append((line, o, new_type))

    for f, items in by_file.items():
        with open(f, encoding="utf-8") as fh:
            lines = fh.readlines()
        out = []
        for ln in lines:
            try:
                o = json.loads(ln)
            except Exception:
                out.append(ln)
                continue
            matched = [(orig_line, rec, nt) for (orig_line, rec, nt) in items if rec["id"] == o.get("id") and not o.get("deleted")]
            if not matched:
                out.append(ln)
                continue
            _, rec, new_type = matched[0]
            if args.mode == "inline":
                o["type"] = new_type
                o["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
                o["version"] = int(o.get("version", 1)) + 1
                out.append(json.dumps(o, ensure_ascii=False) + "\n")
            else:  # append
                o["deleted"] = True
                o["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
                out.append(json.dumps(o, ensure_ascii=False) + "\n")
                new = dict(rec)
                new["id"] = new["id"] + "_fix"
                new["type"] = new_type
                new["deleted"] = False
                new["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
                new["version"] = int(new.get("version", 1)) + 1
                out.append(json.dumps(new, ensure_ascii=False) + "\n")
        with open(f, "w", encoding="utf-8", newline="") as fh:
            fh.writelines(out)
        print(f"已写入 {os.path.basename(f)} ({len(items)} 条)")

    # 统计修正后剩余
    remaining = Counter()
    for f in glob.glob(os.path.join(RECORDS, "*.jsonl")):
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("type") == "work_method" and not o.get("deleted"):
                    remaining[o["id"]] += 1
    print(f"\n修正后剩余未删除 work_method: {len(remaining)} 条")
    print("提示: 若启用向量化，请执行 /my-memory:l1:embedding:rebuild 同步向量库")

if __name__ == "__main__":
    main()
