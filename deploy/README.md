# deploy/ —— 交给托管方的部署配置

**要托管方做的一件事**：让 `https://<域名>/p/<运单号>` 能打开。

> **GitHub Pages 例外（当前演示部署）**：GitHub Pages 不支持 rewrite，正式形态用
> `index.html?w=<运单号>`，由写单时的 `--h5-base` 直接生成；`/p/<运单号>` 由部署仓库
> 根目录的 `404.html` 前端跳转到 `?w=` 兼容。下面的 rewrite 配置适用于 Netlify /
> Vercel / nginx 等支持回退规则的托管。

`/p/<运单号>` 不对应磁盘上的任何文件，静态托管默认返回 404。需要配一条 rewrite，
把 `/p/*` 回退到 `index.html`，由前端按 pathname 取运单号（`app.js` 的 `waybillFromUrl()`）。

按托管方选一份用：

| 文件 | 适用 |
| --- | --- |
| `_redirects` | Netlify、Cloudflare Pages |
| `vercel.json` | Vercel |
| `nginx.conf.snippet` | 自建 nginx / 阿里云 OSS+CDN 回源 |

---

## 一条规则，本地与线上同源

`tools/serve_spa.py` 实现的就是这条规则，`serve.sh` 默认用它。
**本地怎么跑，线上就怎么跑** —— 否则 AC-04 验的只是 `?w=` 那条降级路径，
生产形态的 URL 到演示当天才第一次被打开。

规则精确表述：

```
命中已存在的文件      → 原样返回
路径形如 /p/xxx       → 返回 index.html（200）
其余未知路径          → 404
```

---

## 为什么**不**做全站兜底

常见的 SPA 配法是 `/* → /index.html 200`。这里**刻意不这么写**，只回退 `/p/*`。

原因：全站兜底会把「素材表没部署上去」这种真实故障静默吞掉。

```
data/adSlots.json 缺失
  ├─ 全站兜底：服务器返回一份 HTML
  │    └─ 页面 r.json() 解析失败 → 回退 data/embedded.js 内嵌副本
  │         └─ 页面照样能看，但看的是**构建期的旧文案**，无人察觉 ⚠️
  └─ 只回退 /p/*：这个请求得到 404，当场暴露 ✅
```

`data/` 下的文件是载荷与素材表，缺失必须响亮地失败。

---

## 部署清单

1. 把站点根目录下这些**整个**传上去：
   `index.html`、`app.js`、`sign-api.js`、`styles.css`、`ad.html`、`404.html`；
   以及 `data/` 整个目录：
   `public.json`、`sealed.json`、`embedded.js`、`adSlots.json`、`materials.json`、
   `nodes.json`，和 `materials/` 子目录（验货配图，`materials.json` 指向
   `data/materials/…`）。
2. **不要发布**：
   - `data-private/`（`labels.json` 明文载荷源、`demo_phones.json` 完整演示手机号）；
   - `data/labels.json`（已删除，不要从旧版本带回来）；
   - `tools/`、`tests/`、`docs/`、`deploy/`、`README.md`、`serve.sh`。
3. 加上本目录对应的 rewrite 配置。
4. 配好后跑一遍验收（见下），**不要靠肉眼点**。

`.github/workflows/static.yml` 已按上述清单排除私有与开发目录。

## 验收

```bash
CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" \
  bash tests/acceptance.sh https://<域名>
```

本地与线上共用同一个脚本 —— 换域名即可。线上按正式形态传 `--form=query`
（GitHub Pages）。本地会跑 AC-04 / AC-04-S / AC-05 / AC-09；对线上只跑
AC-04 / AC-04-S / AC-05，**AC-09 会自动跳过**（它会改动素材表文件，只应作用于本地）。

需要 Chromium 内核浏览器；没有 Chrome 时可用 Edge（同内核），通过 `CHROME` 指定路径。

---

## 演示级说明与生产底线

纯静态托管只能提供**演示级门禁**：手机号派生密钥解密、localStorage 本机记录，
没有服务端限流、可信时间、跨设备状态或防篡改审计。离线爆破、本机记录伪造、
标签载荷被第三方 NFC 工具读取等问题都无法在纯静态方案里解决（详见
`docs/superpowers/specs/2026-11-01-signing-auth-design.md` §3）。

**真实签收的最低要求（spec §11.2）：**

1. 详情由服务端按运单号下发，页面只保留浅信息；
2. 服务端校验手机号（或 OTP）并按运单 + IP + 设备限流，签发短时 token；
3. 签收记录服务端 **append-only** 写入，使用服务端时间与 IP，幂等键防重；
4. 标签只写不透明 ID，仓库私有化，敏感图片走鉴权接口。

`sign-api.js` 的 `window.PdaSignApi` 即为替换点；页面 UI 不需要重写。
