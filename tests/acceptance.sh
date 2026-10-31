#!/usr/bin/env bash
# H5 读取页验收 —— AC-04 / AC-05 / AC-09。包装 tests/acceptance.js。
#
# 为什么用真浏览器：`tests/run_tests.js` 只跑纯函数，够不到「页面到底渲染出来没有」。
# AC-04 恰恰卡在生产形态的 URL 上 —— 本地一度用 `python3 -m http.server`，那条路径
# 直接 404，等于这条验收从来没在本地被跑过。详见 tests/acceptance.js 的文件头。
#
# 依赖：headless Chrome（可用环境变量 CHROME 指定路径）、python3、node。
# 不装任何 npm 包 —— Chrome 走 CDP，Node 自带 WebSocket 与 fetch。
#
# 用法：
#   bash reader-h5/tests/acceptance.sh                  # 本地：自己起服务，全跑（含 AC-09）
#   bash reader-h5/tests/acceptance.sh https://<域名>     # 线上：只跑 AC-04 / AC-05
#   bash reader-h5/tests/acceptance.sh https://<域名> --form=query
#                                                      # 线上正式形态是 index.html?w= 时用
#
# ⚠️ AC-09 会临时改动 data/adSlots.json 再还原，只对本地目标执行；
#    打线上时脚本会自动跳过它，不会去动别人的服务器。
set -eu

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" != "" ]; then
  exec node "$HERE/acceptance.js" --base "${1%/}" "${@:2}"
fi

exec node "$HERE/acceptance.js"
