// 本文件由 reader-h5/tools/build_data.py 自动生成，请勿手工编辑。
// 用途：file:// 直接打开页面时 fetch 不可用，作为同源数据的兜底副本。
window.__PDA_IOT_DATA__ = {
  "labels": {
    "meta": {
      "generatedFrom": "shared/mock_parcels.json + shared/tools/build_label.py",
      "timestamp": "2026-09-22T18:00:00+08:00",
      "h5Base": "https://automan99.github.io/public-index/index.html?w=",
      "waybills": [
        "202608080001",
        "202608080002",
        "202608080003",
        "202608080004",
        "202608080005"
      ],
      "note": "演示期数据集，与 PDA 写入端同源；生产环境应改为服务端按运单号取数。"
    },
    "labels": {
      "202608080001": {
        "v": "2",
        "t": "pda-iot-label",
        "f": {
          "l": {
            "w": "202608080001",
            "n": "茶叶礼盒",
            "g": "1.5kg"
          },
          "r": {
            "c": "350503100009100096"
          },
          "i": {
            "s": "4123f08adadbc985",
            "r": "334c1f0e83f44add"
          },
          "m": {
            "a": "A01",
            "p": "M001",
            "cd": {
              "service": "次日达",
              "remark": "易碎品"
            }
          }
        },
        "o": {
          "ts": "2026-09-22T18:00:00+08:00",
          "tcn": 3,
          "d": "PDA-DEV-001"
        }
      },
      "202608080002": {
        "v": "2",
        "t": "pda-iot-label",
        "f": {
          "l": {
            "w": "202608080002",
            "n": "文件袋",
            "g": "0.2kg"
          },
          "r": {
            "c": "100096350503"
          },
          "i": {
            "s": "5987db203e021029",
            "r": "b308e1879aa66fdf"
          },
          "m": {
            "a": "A02",
            "cd": {
              "service": "标准",
              "remark": "合同文件"
            }
          }
        },
        "o": {
          "ts": "2026-09-22T18:00:00+08:00",
          "tcn": 4,
          "d": "PDA-DEV-001"
        }
      },
      "202608080003": {
        "v": "2",
        "t": "pda-iot-label",
        "f": {
          "l": {
            "w": "202608080003",
            "n": "生鲜礼包",
            "g": "3.0kg"
          },
          "r": {
            "c": "350503361000100009100096"
          },
          "i": {
            "s": "2d3a555f862d1dab",
            "r": "242f2f64dd61fe68"
          },
          "m": {
            "a": "A03",
            "p": "M002",
            "cd": {
              "service": "冷链",
              "remark": "全程 0-4℃"
            }
          }
        },
        "o": {
          "ts": "2026-09-22T18:00:00+08:00",
          "tcn": 5,
          "d": "PDA-DEV-002"
        }
      },
      "202608080004": {
        "v": "2",
        "t": "pda-iot-label",
        "f": {
          "l": {
            "w": "202608080004",
            "n": "电子配件",
            "g": "0.8kg"
          },
          "r": {
            "c": "100009350503100096"
          },
          "i": {
            "s": "94ee0b91bfee872e",
            "r": "ff08a5a507a24410"
          },
          "m": {
            "a": "A01",
            "cd": {
              "service": "次日达",
              "remark": "轻拿轻放"
            }
          }
        },
        "o": {
          "ts": "2026-09-22T18:00:00+08:00",
          "tcn": 6,
          "d": "PDA-DEV-002"
        }
      },
      "202608080005": {
        "v": "2",
        "t": "pda-iot-label",
        "f": {
          "l": {
            "w": "202608080005",
            "n": "书籍",
            "g": "2.2kg"
          },
          "r": {
            "c": "350503100096"
          },
          "i": {
            "s": "caec8f6662ae3bc1",
            "r": "cc2ef05bbbbd9e20"
          },
          "m": {
            "a": "A04",
            "cd": {
              "service": "标准"
            }
          }
        },
        "o": {
          "ts": "2026-09-22T18:00:00+08:00",
          "tcn": 7,
          "d": "PDA-DEV-001"
        }
      }
    }
  },
  "adSlots": {
    "_comment": "广告位素材表：把标签里的 adSlotId 指针解析成实际广告内容。读取端（H5 / Android App）加载本表。改广告文案只改本表，标签无需重写——这是指针化设计的核心价值。",
    "_version": "1",
    "slots": {
      "A01": {
        "title": "XX 物流 · 快件到家",
        "body": "扫码寄件首单立减 10 元",
        "landingUrl": "https://ad.example.com/a01",
        "weight": 100
      },
      "A02": {
        "title": "XX 物流 · 同城当日达",
        "body": "同城 3 小时送达，超时赔付",
        "landingUrl": "https://ad.example.com/a02",
        "weight": 100
      },
      "A03": {
        "title": "冷链直达 · 新鲜到家",
        "body": "全程 0-4℃ 温控，生鲜专线",
        "landingUrl": "https://ad.example.com/a03",
        "weight": 100
      },
      "A04": {
        "title": "书香节 · 满百减三十",
        "body": "图书专场，满 100 减 30",
        "landingUrl": "https://ad.example.com/a04",
        "weight": 100
      }
    }
  },
  "materials": {
    "_comment": "验货素材表：把标签里的 materialId 指针解析成验货图 / 图文说明。v0.4 曾把 71 B 的图片 URL 直接写进标签——那个 URL 既吃掉 11% 的标签容量，又指向一张离线现场打不开的图。改为指针后标签只存 6 B。",
    "_version": "1",
    "materials": {
      "M001": {
        "type": "photo",
        "url": "https://cdn.example.com/inspect/202608080001.jpg",
        "caption": "开箱验货：茶叶礼盒外观完好"
      },
      "M002": {
        "type": "photo",
        "url": "https://cdn.example.com/inspect/202608080003.jpg",
        "caption": "开箱验货：生鲜礼包冷链封条完整"
      }
    }
  },
  "nodes": {
    "_comment": "节点码 → 节点名称。标签里 f.r.c 只存 6 位数字串（本期用 6 位邮政编码，见需求 §2 术语表），读取端按每 6 位切分得到节点码后，用本表解析出可读名称。与 adSlots.json / materials.json 同类：**只影响展示，不占标签字节**，改表不用重写标签。",
    "_version": "1",
    "_scope": "演示映射。码值取自 mock_parcels.json 的 routeNodes，与真实邮政编码的行政区划**不保证一一对应**；生产环境应换成甲方真实分拨中心编码表。",
    "nodes": {
      "350503": {
        "name": "福州仓山分拨中心",
        "short": "福州仓山",
        "role": "揽收"
      },
      "361000": {
        "name": "厦门集美中转场",
        "short": "厦门集美",
        "role": "转运"
      },
      "100009": {
        "name": "北京东城分拨中心",
        "short": "北京东城",
        "role": "转运"
      },
      "100096": {
        "name": "北京海淀末端网点",
        "short": "北京海淀",
        "role": "派送"
      }
    }
  }
};
