# reader-h5/deploy/ —— 交给托管方的部署配置

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

`reader-h5/tools/serve_spa.py` 实现的就是这条规则，`serve.sh` 默认用它。
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

1. 把 `reader-h5/` 下这些**整个**传上去：
   `index.html`、`app.js`、`styles.css`、`data/`（构建产物，必须一起传）。
2. `data/` 里的文件一个都不能少：
   `labels.json`、`embedded.js`、`adSlots.json`、`materials.json`、`nodes.json`，
   以及 `materials/` 子目录（验货配图，`materials.json` 指向 `data/materials/…`）。
   整个 `data/` 目录一起传最稳妥。
3. 加上本目录对应的 rewrite 配置。
4. 配好后跑一遍验收（见下），**不要靠肉眼点**。

## 验收

```bash
bash reader-h5/tests/acceptance.sh https://<域名>
```

同一个脚本既能打本地，也能打线上 —— 换域名即可。它会验 AC-04（生产形态 URL
能打开且完整展示）、AC-05（`?w=` 兜底内容与之一致）、AC-09（改素材表文案
刷新即变、标签不需重写）。

> AC-09 会改动素材表文件，因此**只在本地跑**；对线上只跑 AC-04 / AC-05。
> 脚本会自动判断：目标是 localhost 才跑 AC-09。
