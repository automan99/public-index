#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""素材表定稿检查 —— 换甲方真实文案 / 节点表之前、之后都跑这一条。

为什么需要这个脚本：

    素材表（`adSlots.json` / `materials.json` / `nodes.json`）是**指针化设计**的落点：
    标签里只存 `A01` / `M001` / `350503` 这样的短指针，文案与节点名全在表里，改表不用
    重写标签（AC-09 / D8）。代价是**表里错一个键，标签当场变成一句占位文案** ——
    页面不会报错、不会崩，只会安静地显示「广告位 A99 暂无文案」「节点 999999」。

    这正是换表时最容易翻车的地方：改完肉眼看着"没问题"，因为降级路径本来就长这样。

本脚本把这件事变成一条可运行的检查：

    1. **悬空指针**（ERROR）—— 标签引用了表里不存在的键。
       这类必须修，否则演示现场显示占位文案。
    2. **未替换的演示数据**（WARN）—— 仍是 example.com、XX 物流、演示映射节点表。
       换表前是正常的；**定稿验收时必须清零**，用 --require-final 把它变成 ERROR。
    3. **字段缺失**（ERROR）—— 表项少了必填字段，渲染出来是空块。

用法：
    python3 reader-h5/tools/check_materials.py                 # 换表期间自查
    python3 reader-h5/tools/check_materials.py --require-final # 定稿验收（演示数据即失败）
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
H5_DIR = os.path.abspath(os.path.join(HERE, os.pardir))
REPO = os.path.abspath(os.path.join(H5_DIR, os.pardir))
SHARED = os.path.join(REPO, "shared")

DEMO_MARKERS = [
    (re.compile(r"example\.com"), "URL 仍指向 example.com"),
    (re.compile(r"\bXX\b|XX\s*物流"), "文案里仍有「XX」占位"),
]

REQUIRED = {
    "adSlots.json": ("slots", ["title", "body"]),
    "materials.json": ("materials", ["type", "url", "caption"]),
    "nodes.json": ("nodes", ["name", "short"]),
}


def load(name):
    with open(os.path.join(SHARED, name), encoding="utf-8") as f:
        return json.load(f)


def walk_strings(obj, path="$"):
    """产出 (路径, 字符串) —— 用来扫演示数据残留。"""
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if k.startswith("_"):      # _comment / _scope 是说明文字，不算数据
                continue
            yield from walk_strings(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk_strings(v, f"{path}[{i}]")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--require-final", action="store_true",
                    help="定稿验收模式：演示数据残留视为 ERROR 而非 WARN")
    args = ap.parse_args()

    errors, warns = [], []

    tables = {n: load(n) for n in REQUIRED}

    # ---- 1. 表项自身的必填字段 ----
    for fname, (root, fields) in REQUIRED.items():
        for key, entry in (tables[fname].get(root) or {}).items():
            for f in fields:
                if not entry.get(f):
                    errors.append(f"{fname}::{key} 缺必填字段 `{f}`（页面会渲染成空块）")

    # ---- 2. 悬空指针：标签引用的键必须存在于表里 ----
    labels_path = os.path.join(H5_DIR, "data", "labels.json")
    if os.path.exists(labels_path):
        with open(labels_path, encoding="utf-8") as f:
            labels = json.load(f).get("labels", {})
        slots = (tables["adSlots.json"].get("slots") or {})
        mats = (tables["materials.json"].get("materials") or {})
        nodes = (tables["nodes.json"].get("nodes") or {})
        for wb, lb in labels.items():
            m = (lb.get("f") or {}).get("m") or {}
            if m.get("a") and m["a"] not in slots:
                errors.append(f"广告指针悬空：{wb} 的 f.m.a={m['a']} 不在 adSlots.json 里")
            if m.get("p") and m["p"] not in mats:
                errors.append(f"素材指针悬空：{wb} 的 f.m.p={m['p']} 不在 materials.json 里")
            code = ((lb.get("f") or {}).get("r") or {}).get("c") or ""
            for node in re.findall(r"\d{6}", code):
                if node not in nodes:
                    errors.append(f"节点码悬空：{wb} 路由里的 {node} 不在 nodes.json 里"
                                  f"（页面会显示「节点 {node}」占位）")

    # ---- 3. 演示数据残留 ----
    for fname in tables:
        for path, s in walk_strings(tables[fname], fname):
            for pat, why in DEMO_MARKERS:
                if pat.search(s):
                    warns.append(f"{path}：{why} —— {s[:60]}")
    scope = tables["nodes.json"].get("_scope", "")
    if "演示" in scope:
        warns.append("nodes.json 仍是演示映射（_scope 自述），与真实邮政编码不保证对应")

    # ---- 报告 ----
    print("素材表定稿检查")
    print(f"模式：{'定稿验收（演示数据即失败）' if args.require_final else '换表期间自查'}")
    print()
    for fname, (root, _) in REQUIRED.items():
        print(f"  {fname:<16} {len(tables[fname].get(root) or {})} 项")

    if errors:
        print(f"\n--- ERROR（{len(errors)}）必须修 ---")
        for e in errors:
            print(f"  ✗ {e}")
    if warns:
        print(f"\n--- WARN（{len(warns)}）演示数据残留，定稿前需清零 ---")
        for w in warns:
            print(f"  ! {w}")
    if not errors and not warns:
        print("\n  素材表已是定稿状态：无悬空指针，无演示数据残留。")

    if args.require_final:
        errors += warns          # 定稿模式下，演示残留同样是拦路项
        warns = []

    print()
    if errors:
        print(f"结论：{len(errors)} 项未通过。")
        return 1
    print(f"结论：全部通过{'（仍有 ' + str(len(warns)) + ' 项演示数据残留，尚未定稿）' if warns else ''}。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
