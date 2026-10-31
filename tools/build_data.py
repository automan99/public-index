#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 H5 读取页所需的静态数据（构建步骤，产物进 reader-h5/data/）。

为什么需要这个步骤：

    H5 是**纯静态页**，标签里只有 URL 和运单号，**载荷不会随 URL 传到浏览器**
    （碰标签时系统只把 URI 记录交给浏览器，NDEF 主数据记录不会）。所以页面必须
    自己拿到载荷数据。本期做法：把 PDA 写入端同源的 mock 快件**预生成为标签载荷**，
    按运单号索引成 labels.json，页面按 URL 里的运单号查表。

    ⚠️ 这条边界必须说清楚：**演示期 H5 展示的数据来自与 PDA 同源的预生成数据集，
    不是从标签实时读出来的**（浏览器没有 NFC 读取能力）。标签是写入端的真值来源，
    H5 是展示端。生产环境应改为服务端按运单号取数。

用法：
    python3 reader-h5/tools/build_data.py                      # 用默认时间戳
    python3 reader-h5/tools/build_data.py --timestamp 2026-09-22T18:00:00+08:00
    python3 reader-h5/tools/build_data.py --h5-base https://np.cn/p/
"""
import argparse
import importlib.util
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
H5_DIR = os.path.abspath(os.path.join(HERE, os.pardir))
REPO = os.path.abspath(os.path.join(H5_DIR, os.pardir))
SHARED = os.path.join(REPO, "shared")
DATA_DIR = os.path.join(H5_DIR, "data")

# 素材表 / 节点表：直接从 shared/ 复制，保证两端同源
COPY_FROM_SHARED = ["adSlots.json", "materials.json", "nodes.json"]


def load_build_label():
    """按路径加载 shared/tools/build_label.py（它不是包，用 importlib 显式加载）。"""
    path = os.path.join(SHARED, "tools", "build_label.py")
    spec = importlib.util.spec_from_file_location("build_label", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timestamp", default="2026-09-22T18:00:00+08:00",
                    help="写进 o.ts 的最后触碰时间")
    ap.add_argument("--touch-count", type=int, default=3, help="写进 o.tcn 的累计触碰次数")
    ap.add_argument("--h5-base", default=None,
                    help="H5 地址前缀（只记录进 meta，页面的自查提示用；不影响载荷）")
    args = ap.parse_args()

    bl = load_build_label()
    h5_base = args.h5_base or bl.DEFAULT_H5_BASE

    with open(os.path.join(SHARED, "mock_parcels.json"), encoding="utf-8") as f:
        parcels = json.load(f)

    labels = {}
    for idx, parcel in enumerate(parcels):
        label = bl.build_label(parcel, args.timestamp, args.touch_count + idx)
        # 生成即校验：不会把一条违反 INV 的载荷烤进 H5
        raw = json.dumps(label, ensure_ascii=False, separators=(",", ":"))
        _text, url = bl.build_summary(label, h5_base)
        problems = bl.check_invariants(label, raw, _text, url) + bl.validate_against_schema(label)
        if problems:
            print(f"[FAIL] {parcel['waybillNo']} 未通过契约校验，已中止构建：", file=sys.stderr)
            for p in problems:
                print(f"        └─ {p}", file=sys.stderr)
            return 1
        labels[parcel["waybillNo"]] = label
        print(f"[ OK ] {parcel['waybillNo']}  载荷 {len(raw.encode('utf-8'))} B  "
              f"节点 {len(bl.route_nodes_of(label))} 段  → {url}")

    os.makedirs(DATA_DIR, exist_ok=True)

    meta = {
        "generatedFrom": "shared/mock_parcels.json + shared/tools/build_label.py",
        "timestamp": args.timestamp,
        "h5Base": h5_base,
        "waybills": list(labels),
        "note": "演示期数据集，与 PDA 写入端同源；生产环境应改为服务端按运单号取数。",
    }
    payload = {"meta": meta, "labels": labels}

    json_path = os.path.join(DATA_DIR, "labels.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    # file:// 兜底：直接双击 index.html 时 fetch 会被浏览器拦下（CORS），
    # 这里把同一份数据同时写成一份 JS 赋值，页面在 fetch 失败时回退到它。
    # 注意：**http(s) 场景下不会用到这份副本**——素材表仍然每次重新 fetch，
    # 所以「改素材表不重写标签」（AC-09）在正式部署路径上依然成立。
    embedded = {"labels": payload}
    for name in COPY_FROM_SHARED:
        key = os.path.splitext(name)[0]
        with open(os.path.join(SHARED, name), encoding="utf-8") as f:
            embedded[key] = json.load(f)

    js_path = os.path.join(DATA_DIR, "embedded.js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("// 本文件由 reader-h5/tools/build_data.py 自动生成，请勿手工编辑。\n")
        f.write("// 用途：file:// 直接打开页面时 fetch 不可用，作为同源数据的兜底副本。\n")
        f.write("window.__PDA_IOT_DATA__ = ")
        json.dump(embedded, f, ensure_ascii=False, indent=2)
        f.write(";\n")

    for name in COPY_FROM_SHARED:
        shutil.copyfile(os.path.join(SHARED, name), os.path.join(DATA_DIR, name))
        print(f"[ OK ] 复制 {name}")

    print(f"\n产物：{os.path.relpath(json_path, REPO)}、"
          f"{os.path.relpath(js_path, REPO)}、{', '.join(COPY_FROM_SHARED)}")
    print("提示：素材表改完**不需要重跑本脚本**（页面每次加载都重新读取）——"
          "这正是指针化的价值，改广告不用重写标签。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
