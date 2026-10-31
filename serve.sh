#!/usr/bin/env bash
# 本地起一个静态服务跑 H5 读取页。
#
# 为什么不能直接双击 index.html：浏览器对 file:// 的 fetch 有同源限制，
# 素材表读不出来（页面会回退到 data/embedded.js 的副本，但那条路径不反映
# 「改素材表即生效」的真实部署行为）。用本脚本起服务，才是正式路径。
#
# 为什么不用 `python3 -m http.server`：它对 /p/<运单号> 返回 404，
# 而 /p/<运单号> 正是 D7 定的**生产形态**。用它起服务，等于本地永远验不到 AC-04
# 要走的那条路径。这里改用 tools/serve_spa.py —— 它本地复刻了生产托管的 rewrite
# 规则（见 reader-h5/deploy/），本地跑通 == 生产跑得通。
#
# 用法：
#   bash reader-h5/serve.sh            # 默认 8080
#   bash reader-h5/serve.sh 9000
set -eu

PORT="${1:-8080}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec python3 "$HERE/tools/serve_spa.py" "$PORT"
