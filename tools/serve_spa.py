#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""带 SPA 回退的静态服务 —— 本地复刻生产托管上的 rewrite 规则。

为什么需要这个脚本：

    D7 定的 URL 形态是 https://<域名>/p/<运单号>。但静态托管默认对未知路径返回 404，
    `python3 -m http.server` 同样如此。于是**生产形态的 URL 在本地根本打不开**：
    AC-04 在本地无从验起，演示现场第一次点 /p/xxx 也会直接踩空。

    本脚本实现的就是要交给托管方的那条规则（`reader-h5/deploy/` 下有三份现成配置）：

        命中已存在的文件      → 原样返回
        路径形如 /p/xxx       → 返回 index.html（200）
        其余未知路径          → 404

    本地与生产跑同一条规则，AC-04 才算真的验过；否则验的只是 ?w= 那条降级路径。

为什么**不做**全站兜底（catch-all rewrite 到 index.html）：

    全站兜底会把 `data/adSlots.json` 缺失这种真实故障静默吞掉 —— 服务器返回一份
    HTML，页面的 r.json() 解析失败后回退到 embedded.js 的内嵌副本，页面**照样能看**，
    但看的是构建期的旧副本。把回退收在 /p/ 前缀下，缺文件就是一个响亮的 404。

用法：
    python3 reader-h5/tools/serve_spa.py            # 默认 8080
    python3 reader-h5/tools/serve_spa.py 9000
    python3 reader-h5/tools/serve_spa.py --quiet    # 不打印访问日志
"""
import argparse
import os
import posixpath
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
H5_DIR = os.path.abspath(os.path.join(HERE, os.pardir))

# 不发布的目录：即使本机存在文件也一律 404，与生产发布清单保持一致。
PRIVATE_SEGMENTS = frozenset(("data-private", "tools", "tests", "deploy", "docs"))


class SPAHandler(SimpleHTTPRequestHandler):
    """静态文件 + 限定在 /p/ 下的 SPA 回退。"""

    quiet = False

    def _resolve(self):
        """返回 (本机文件路径, 是否已存在)。"""
        path = unquote(urlparse(self.path).path)
        rel = posixpath.normpath(path).lstrip("/")
        if rel in ("", "."):
            return os.path.join(self.directory, "index.html"), os.path.isfile(
                os.path.join(self.directory, "index.html"))
        fs = os.path.join(self.directory, rel)
        return fs, os.path.isfile(fs)

    def _real_path_is_private(self, path):
        """兜底：按真实文件系统路径判断是否落入私有目录。

        仅比较字面首段挡不住平台差异 —— Windows/NTFS 文件名大小写不敏感、
        打开时忽略尾随点和空格，反斜杠也是分隔符。translate_path() 给出实际
        要读取的本机路径，realpath() 再解析成真实大小写，然后与私有目录比较。
        """
        target = os.path.normcase(os.path.realpath(self.translate_path(path)))
        root = os.path.realpath(self.directory)
        for name in PRIVATE_SEGMENTS:
            base = os.path.normcase(os.path.join(root, name))
            if target == base or target.startswith(base + os.sep):
                return True
        return False

    def _prepare(self):
        """按生产规则改写 self.path；返回 False 表示应当直接 404。"""
        path = unquote(urlparse(self.path).path)

        # 私有 / 开发目录不进发布产物；本机即使有文件也拒绝，避免演示时被直接下载。
        # 先归一化再比较：反斜杠按分隔符处理，忽略大小写与尾随点/空格。
        rel = posixpath.normpath(path.replace("\\", "/")).lstrip("/")
        first = rel.split("/", 1)[0].lower().rstrip(". ")
        if first in PRIVATE_SEGMENTS:
            return False

        try:
            if self._real_path_is_private(self.path):
                return False
        except (OSError, ValueError):
            # 真实路径无法判定时宁可拒绝
            return False

        fs, exists = self._resolve()

        if exists:
            return True

        # /p/<运单号> 是 D7 定的生产形态 —— 交给 index.html，由前端按 pathname 取运单号
        if path == "/p" or path.startswith("/p/"):
            self.path = "/index.html"
            return True

        return False

    def _send_404(self):
        body = (
            "<!DOCTYPE html><html><head><meta charset='utf-8'>"
            "<title>404</title></head><body>"
            "<h1>404 Not Found</h1>"
            "<p>本机静态服务只对 <code>/p/&lt;运单号&gt;</code> 做 SPA 回退；"
            "其余未知路径一律 404，与生产托管一致。</p>"
            "</body></html>"
        ).encode("utf-8")
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if self._prepare():
            return super().do_GET()
        self._send_404()

    def do_HEAD(self):
        if self._prepare():
            return super().do_HEAD()
        self._send_404()

    def list_directory(self, path):
        # 生产托管不列目录，本地也不列 —— 免得 `data/` 能被人肉翻出来当成"能访问"
        self._send_404()
        return None

    def log_message(self, fmt, *args):
        if not self.quiet:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=8080)
    ap.add_argument("--quiet", action="store_true", help="不打印访问日志")
    ap.add_argument("--dir", default=H5_DIR, help="站点根目录（默认 reader-h5/）")
    args = ap.parse_args()

    SPAHandler.quiet = args.quiet
    handler = lambda *a, **kw: SPAHandler(*a, directory=args.dir, **kw)  # noqa: E731

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"H5 读取页（SPA 回退已启用，与生产同规则）：http://localhost:{args.port}/")
    print(f"  站点根目录：{args.dir}")
    print()
    print(f"  路径式（生产形态）  http://localhost:{args.port}/p/202608080003")
    print(f"  查询参数（降级）    http://localhost:{args.port}/index.html?w=202608080003")
    print(f"  调试入口            http://localhost:{args.port}/index.html?debug=1")
    print()
    print("按 Ctrl-C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
