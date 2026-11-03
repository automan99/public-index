#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tools/serve_spa.py 私有路径护栏回归测试（仅标准库，零依赖）。

Windows/NTFS 上文件名大小写不敏感、打开时忽略尾随点/空格，反斜杠也是分隔符。
这些写法都能落到真实的 data-private 文件上，护栏必须在比较前归一化。
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import serve_spa  # noqa: E402


def make_handler(path, directory=ROOT):
    """不启动 socket，直接构造 handler 以调用 _prepare()。"""
    handler = object.__new__(serve_spa.SPAHandler)
    handler.path = path
    handler.directory = directory
    return handler


class PrivatePathGuardTest(unittest.TestCase):
    def assert_blocked(self, path):
        handler = make_handler(path)
        self.assertFalse(handler._prepare(), "should block %r" % path)

    def assert_allowed(self, path):
        handler = make_handler(path)
        self.assertTrue(handler._prepare(), "should allow %r" % path)

    def test_plain_private_dirs_blocked(self):
        for name in ("data-private", "tools", "tests", "deploy", "docs"):
            self.assert_blocked("/%s/labels.json" % name)

    def test_case_variants_blocked(self):
        # NTFS 大小写不敏感：旧护栏按原样比较首段会被绕过
        self.assert_blocked("/DATA-PRIVATE/labels.json")
        self.assert_blocked("/Data-Private/labels.json")
        self.assert_blocked("/TOOLS/serve_spa.py")

    def test_trailing_dot_or_space_blocked(self):
        # Windows 打开文件时会忽略尾随点/空格
        self.assert_blocked("/data-private./labels.json")
        self.assert_blocked("/DATA-PRIVATE./labels.json")
        self.assert_blocked("/data-private%2e/labels.json")
        self.assert_blocked("/data-private /labels.json")
        self.assert_blocked("/data-private%20/labels.json")

    def test_backslash_separators_blocked(self):
        self.assert_blocked("/data-private\\labels.json")
        self.assert_blocked("/DATA-PRIVATE\\labels.json")
        self.assert_blocked("/%5cdata-private%5clabels.json")

    def test_dot_segment_escape_blocked(self):
        # ".." 段不会逃出站点根，但归一化后仍可能指向根下的私有目录
        self.assert_blocked("/p/../../data-private/labels.json")
        self.assert_blocked("/foo/../data-private/labels.json")

    def test_normal_files_allowed(self):
        self.assert_allowed("/index.html")
        self.assert_allowed("/data/adSlots.json")

    def test_p_fallback_unchanged(self):
        handler = make_handler("/p/202608080003")
        self.assertTrue(handler._prepare())
        self.assertEqual(handler.path, "/index.html")
        self.assert_blocked("/p/unknown/../../data-private/labels.json")


if __name__ == "__main__":
    unittest.main(verbosity=2)
