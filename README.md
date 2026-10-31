# reader-h5/ —— 手机端读取页（M2 交付物）

需求 §5.4 的**主路径**：碰标签 → 系统解析 NDEF → 打开本页 → 展示快件信息、路由进度、
脱敏 UID、广告位、留痕。**双端通用、零签名、零账号、零安装。**

技术栈：无框架、无构建、原生 JS。整页三份静态资源，任何静态托管都能放。

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面骨架 |
| `ad.html` | **广告落地页**（`ad.html?slot=A01`），素材表 `landingUrl` 指向它 |
| `app.js` | 全部逻辑：校验 → 指针解析 → 渲染 |
| `styles.css` | 移动端优先的样式 |
| `data/` | **构建产物**，由 `tools/build_data.py` 生成，不手工编辑 |
| `tools/build_data.py` | 从 `shared/` 生成 `data/` |
| `tools/check_materials.py` | **素材表定稿检查**：悬空指针 / 演示数据残留 |
| `tools/serve_spa.py` | 本地静态服务，复刻生产托管的 SPA 回退规则 |
| `deploy/` | **交给托管方**的 rewrite 配置（Netlify / Vercel / nginx） |
| `tests/run_tests.js` | 纯函数单测（无浏览器、无硬件） |
| `tests/acceptance.js` | 验收断言 AC-04 / AC-05 / AC-09（真浏览器） |
| `tests/acceptance.sh` | 上面那条的入口 |
| `serve.sh` | 本地起服务（= `serve_spa.py`） |

---

## 一、跑起来

```bash
python3 reader-h5/tools/build_data.py     # 生成 data/（改了 shared/ 后要重跑）
bash reader-h5/serve.sh                   # 默认 8080
```

然后打开：

| 场景 | 地址 |
| --- | --- |
| 演示数据 | `http://localhost:8080/index.html?w=202608080003` |
| 线上正式形态 | `https://automan99.github.io/public-index/index.html?w=202608080003` |
| 广告落地页 | `http://localhost:8080/ad.html?slot=A01`（线上同路径 `/public-index/ad.html?slot=A01`） |
| 路径式（`/p/`，由 `404.html` 兼容） | `http://localhost:8080/p/202608080003` |
| 调试入口 | `http://localhost:8080/index.html?debug=1` |

单测（纯函数，无浏览器）：

```bash
node reader-h5/tests/run_tests.js
```

**验收（真浏览器 + 真 HTTP，AC-04 / AC-05 / AC-09）：**

```bash
bash reader-h5/tests/acceptance.sh                    # 本地，自己起服务，全跑
bash reader-h5/tests/acceptance.sh https://<域名>      # 打线上（/p/ 形态），只跑 AC-04 / AC-05
bash reader-h5/tests/acceptance.sh https://automan99.github.io/public-index --form=query
                                                      # 打线上（正式形态 ?w=）
```

它自己起 `serve_spa.py`、开 headless Chrome、按手机视口打开正式形态 URL
（默认 `/p/<运单号>`，`--form=query` 时为 `index.html?w=<运单号>`），
逐项对内容，并对 AC-09 做**字节级**断言（改文案后页面必须变、`labels.json`
必须一个字节都不变）。零 npm 依赖。

**素材表定稿检查（换甲方真实文案 / 节点表时用）：**

```bash
python3 reader-h5/tools/check_materials.py                 # 换表期间自查
python3 reader-h5/tools/check_materials.py --require-final # 定稿验收：演示数据残留即失败
```

指针化设计的代价是**表里错一个键，标签当场变成一句占位文案**——页面不报错、
不崩，只是安静地显示「节点 999999」。换表时肉眼看着"没问题"正是因为降级路径
本来就长这样。这条检查专堵它：悬空指针报 ERROR，`example.com` / `XX 物流` /
演示映射节点表这类残留报 WARN，定稿时必须清零。

> 这两条**都必须跑**。`run_tests.js` 全绿只说明纯函数对，不代表页面能打开 ——
> 2026-09-22 就是在这个缝里漏掉了一个 bug：`/p/<运单号>` 下页面的相对资源路径
> 全部解析到 `/p/` 下拿回 HTML，**页面在生产形态的 URL 下什么都渲染不出来**，
> 而当时的渲染验证只跑过 `?w=` 形态。详见 §四.1。

> ⚠️ **别直接双击 `index.html`**。`file://` 下浏览器禁止 `fetch`，页面会回退到
> `data/embedded.js` 的内嵌副本——能看，但**不反映「改素材表即生效」的真实行为**。
> 要验 AC-09 请用 `serve.sh`。

---

## 二、一条必须说清的边界：H5 的数据从哪来

**碰标签时，浏览器只拿到 NDEF 的 URI 记录（URL），拿不到主数据记录（JSON 载荷）。**
这是系统行为，不是实现取舍——iOS/Android 都只把 URI 交给浏览器。

所以页面必须自己拿到载荷。本期做法：

```
shared/mock_parcels.json ──build_data.py──▶ data/labels.json ──按运单号查表──▶ 页面
        ▲ 与 PDA 写入端同源
```

| | 本期（演示） | 生产 |
| --- | --- | --- |
| 载荷来源 | 构建期预生成，按运单号查表 | **服务端按运单号取数** |
| 标签的角色 | 写入端的真值来源 | 同左 |
| H5 的角色 | 展示端 | 展示端 |

> **演示话术要注意**：现场说「数据在标签里」时，指的是**PDA↔标签的业务链路**（AC-08）。
> H5 展示的内容来自与写入端同源的演示数据集——浏览器没有 NFC 读取能力，这一点无法绕过。
> 若要说清「标签即真值」，走 **Android 读取 App（M4）**，它是真读标签的。

---

## 三、契约消费点（对着 `shared/README.md` §五 逐条实现）

| 契约要求 | 实现位置 |
| --- | --- |
| 校验失败 / 版本未知 → 提示，**不得崩溃**（BR-05） | `validate()` + `renderNotice('err', …)` |
| 由 `f.r.c` 每 6 位切分还原节点（`routeNodes` 不在标签里） | `routeNodesOf()` |
| 指针查不到 → **降级为占位文案**，不得留空或报错 | `resolveAd()` / `resolveMaterial()` / `resolveNode()` |
| 展示脱敏 UID，标注不含明文手机号 | `renderIdentity()` |
| 读取端**不实现** UID 算法、**不识别**标签批次 | 全篇无相关代码（INV-6） |
| 标签内容是不可信输入 | 所有插值走 `esc()` |

**素材表每次打开都重新读取**（`fetch(..., {cache:'no-store'})`），不与标签绑定：
改 `data/adSlots.json` 的文案，刷新页面即变，**标签一个字节都不用动**（AC-09 / D8）。

广告落地页同理：`landingUrl` 用站内相对路径 `ad.html?slot=A01`（由 `<base>` 解析到站点根），
随 H5 一起部署。验收会真的请求这个链接并打开落地页——只断言「有 href」不够，
链接指向死域名时页面渲染照样正常，点开才会发现打不开。

**降级表现**（单测覆盖）：广告位指针落空 → 显示「广告位 A99 + 素材表中暂无此广告位文案」；
节点码落空 → 显示「节点 999999」；两者都不留空、不报错。

---

## 四、三个已知边界（**需要甲方/部署方知道**）

### 1. 正式 URL 形态取决于托管能力

D7 定的形态是 `https://<域名>/p/<运单号>`。这**不对应磁盘上的任何文件**，
静态托管默认返回 404，需要配一条 rewrite 把 `/p/*` 回退到 `index.html`。

**当前演示部署是 GitHub Pages 项目页**（子路径 `/public-index/`）：GitHub Pages
不支持 rewrite，因此**正式形态改为 `index.html?w=<运单号>`**，纯静态托管直接返回 200；
`/p/<运单号>` 由部署仓库根目录的 `404.html` 在浏览器里跳到 `?w=` 形态——HTTP 状态先 404、
再前端跳转，能看但不是首选。写标签时用 `--h5-base` 指向 `?w=` 形态即可。

换到支持 rewrite 的托管（Netlify / Vercel / nginx）时，**`deploy/` 里的配置仍然可用**，
`/p/` 可直接 200 返回。本地 `reader-h5/tools/serve_spa.py` 实现的就是该规则，
`serve.sh` 默认用它，因此本地验收默认仍是 `--form=path`。

> 此前本地用的是 `python3 -m http.server`，它对 `/p/xxx` 直接 404，
> 于是**生产形态的 URL 在本地从来没有被打开过**。

### 2. 相对资源路径：`index.html` 顶部那段 `<base>` 脚本不能删

`/p/<运单号>` 下浏览器不知道「这其实是站点根的那张页面」，会把 `styles.css` /
`app.js` / `data/labels.json` 这些裸相对路径解析到 **`/p/`** 下，而它们全都命中
同一条 SPA 回退规则、各拿回一份 HTML（`Content-Type: text/html`）。结果：

```
CSS 不生效（拿回的是 HTML） → app.js 报语法错 → labels.json 的 r.json() 解析失败
→ 页面停在「正在加载…」，生产形态的 URL 下什么都渲染不出来
```

`index.html` 顶部那段内联 `<base>` 脚本把站点根显式算出来，一次覆盖根部署、
子路径部署、`file://` 三种形态（推导规则见文件内注释）。**它是这个页面能在
`/p/<运单号>` 下打开的前提，不是可选优化。**

> `tests/acceptance.js` 专门盯着这条：删掉那段脚本，验收立刻红，
> 并打印出「资源全部解析到 `/p/` 下」的诊断。

### 3. H5 拿不到「当前到达哪个节点」

标签的 `o` 区只有 `ts` / `tcn` / `d`（时间、次数、设备），**没有当前位置字段**。
所以页面展示的是**标签内规划的完整路由链**（首节点=揽收，末节点=派送），
外加 `tr`（临时路由）变更提示；不能高亮「当前节点」。

需求 §7 讲的「触碰复核、标出当前节点位置」是 **FR-10，属于 PDA 端**——PDA 碰标签时
本地知道自己在哪个节点。H5 没有这个上下文。若要在 H5 上也标出当前位置，
需要**二期**在非固化区加一个位置字段（会占字节，需重新核算容量）。

> 这条不在 v0.6 验收范围内，此处如实标出，避免演示时被问住。

---

## 五、调试入口

`?debug=1`，或访问一个不在演示数据集里的运单号，页面会给出一个输入框：
把 **PDA 写入端导出的载荷 JSON**（或第三方 NFC 工具读出的）贴进去即可渲染。

用途：**真机联调**——M3 还没做完、域名还没定的时候，就能验证「写入端产出的载荷
能不能被读取端正确渲染」，不必等端到端打通。

```bash
# 拿一条载荷来试
python3 shared/tools/build_label.py --dump 3
```
