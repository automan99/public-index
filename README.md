# public-index —— 手机端读取 / 签收页（M2 交付物）

需求 §5.4 的**主路径**：碰标签 → 系统解析 NDEF → 打开本页 → 先验证收件人手机号 →
展示快件信息、路由进度、脱敏 UID、广告位、留痕，并可签收。**双端通用、零签名、零账号、零安装。**

技术栈：无框架、无构建、原生 JS。整页静态资源，任何静态托管都能放。
本轮起详情数据改为**手机号派生密钥加密的密文**，页面本身即是签收入口。

> **演示级，不是安全边界。** 纯静态托管没有服务端，无法真正限流、无法防止离线爆破、
> 无法生成可信签收记录。详见下方「安全边界」。真实上线的最小方案见
> `docs/superpowers/specs/2026-11-01-signing-auth-design.md` §11.2。

> **仓库关系**：本仓库是 `pda-iot/reader-h5` 的**部署副本**。本轮改动先在 `public-index`
> 落地并验收，之后必须把等价改动同步回 `pda-iot/reader-h5`（spec §11.3），否则两处会分叉。

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面骨架（签收入口） |
| `ad.html` | **广告落地页**（`ad.html?slot=A01`），素材表 `landingUrl` 指向它 |
| `404.html` | 静态托管的 `/p/<运单号>` 兼容页：前端跳到 `?w=` 形态（GitHub Pages 用） |
| `app.js` | 页面逻辑：门禁状态机、签收流程、完整内容渲染 |
| `sign-api.js` | 签收 API 抽象 + 演示实现（解密、尝试限制、本机记录） |
| `styles.css` | 移动端优先的样式 |
| `data/public.json` | **生成产物**：浅信息（运单号 / 物品 / 重量 / 服务 / 脱敏手机号） |
| `data/sealed.json` | **生成产物**：AES-256-GCM 密文详情 |
| `data/embedded.js` | **生成产物**：public + sealed + 查找表的内嵌副本（`file://` 兜底） |
| `data/adSlots.json` / `materials.json` / `nodes.json` | 公共查找表，不含具体运单映射 |
| `data/materials/` | 通用演示素材图 |
| `data-private/labels.json` | **明文载荷源**（不发布） |
| `data-private/demo_phones.json` | **演示手机号**（不发布，README 不复制完整号码） |
| `tools/seal_data.js` | 本仓库的生成器：明文源 → `public.json` / `sealed.json` / `embedded.js` |
| `tools/build_data.py` | **上游**（`pda-iot/reader-h5`）构建工具，本仓库不再用它生成发布产物 |
| `tools/check_materials.py` | **素材表定稿检查**：悬空指针 / 演示数据残留 |
| `tools/serve_spa.py` | 本地静态服务，复刻生产托管的 SPA 回退规则，并拒绝私有目录 |
| `deploy/` | **交给托管方**的 rewrite 配置（Netlify / Vercel / nginx） |
| `tests/run_tests.js` | 纯函数单测（无浏览器、无硬件） |
| `tests/sign_tests.js` | 密封工具与 `sign-api.js` 单测 |
| `tests/serve_guard_test.py` | 私有路径护栏回归测试（大小写 / 反斜杠 / 尾随点） |
| `tests/acceptance.js` | 验收断言 AC-04 / AC-04-S / AC-05 / AC-09（真浏览器） |
| `tests/acceptance.sh` | 上面那条的入口 |
| `serve.sh` | 本地起服务（= `serve_spa.py`） |

`README.md`、`docs/`、`tools/`、`tests/`、`deploy/`、`data-private/` 都不进入部署产物。

---

## 一、跑起来

本仓库就是站点根，命令都在仓库根目录执行，**不带 `reader-h5/` 前缀**。

```bash
node tools/seal_data.js                  # 生成 public / sealed / embedded（改明文源后重跑）
node tools/seal_data.js --final          # 最终发布：要求 data/labels.json 已删除
node tools/seal_data.js --check --final  # 只校验现有产物，不重写
bash serve.sh                            # 默认 8080
```

> 生成器只依赖 Node 内置 `crypto`，零 npm 依赖。产物提交入库，部署流程不跑它。
> `tools/build_data.py` 是上游 `pda-iot/reader-h5` 的构建工具；本仓库的发布产物由
> `tools/seal_data.js` 生成，不要再对 `data/` 跑 `build_data.py`。

然后打开：

| 场景 | 地址 |
| --- | --- |
| 演示数据 | `http://localhost:8080/index.html?w=202608080003` |
| 线上正式形态 | `https://automan99.github.io/public-index/index.html?w=202608080003` |
| 广告落地页 | `http://localhost:8080/ad.html?slot=A01`（线上同路径 `/public-index/ad.html?slot=A01`） |
| 路径式（`/p/`，由 `404.html` 兼容） | `http://localhost:8080/p/202608080003` |
| 调试入口（仅 localhost） | `http://localhost:8080/index.html?debug=1` |

演示手机号在 `data-private/demo_phones.json`（waybill → 11 位假号码），**不部署**。
本地验收脚本直接读该文件；README 不复制完整号码，需要时在本地打开文件查看。

单测（纯函数，无浏览器）：

```bash
node tests/run_tests.js && node tests/sign_tests.js
python3 tests/serve_guard_test.py
```

**验收（真浏览器 + 真 HTTP，AC-04 / AC-04-S / AC-05 / AC-09）：**

```bash
CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" bash tests/acceptance.sh
bash tests/acceptance.sh https://<域名>                # 打线上（/p/ 形态），跳过 AC-09
bash tests/acceptance.sh https://automan99.github.io/public-index --form=query
                                                       # 打线上（正式形态 ?w=）
```

验收需要 Chromium 内核浏览器；默认找 `google-chrome`，Windows 用上面的 `CHROME`
环境变量指定 Chrome。没有 Chrome 时可用 Edge（同为 Chromium 内核），例如：

```bash
CHROME="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" bash tests/acceptance.sh
```

它自己起 `serve_spa.py`、开 headless 浏览器、按手机视口打开正式形态 URL
（默认 `/p/<运单号>`，`--form=query` 时为 `index.html?w=<运单号>`），逐项对内容，
并对 AC-09 做**字节级**断言（改文案后页面必须变、`sealed.json` 与 `public.json`
必须一个字节都不变）。零 npm 依赖。

> AC-04 / AC-05 / AC-09 已按签收认证重写：不再断言「打开即完整展示」，
> 而是断言未验证只看到浅信息；另新增 **AC-04-S**（手机号校验、锁定、签收、本机留痕）。
> AC-09 仍只对本地目标执行。

**素材表定稿检查（换甲方真实文案 / 节点表时用）：**

```bash
python3 tools/check_materials.py                 # 换表期间自查
python3 tools/check_materials.py --require-final # 定稿验收：演示数据残留即失败
```

指针化设计的代价是**表里错一个键，标签当场变成一句占位文案**——页面不报错、
不崩，只是安静地显示「节点 999999」。换表时肉眼看着"没问题"正是因为降级路径
本来就长这样。这条检查专堵它：悬空指针报 ERROR，`example.com` / `XX 物流` /
演示映射节点表这类残留报 WARN，定稿时必须清零。

> 纯函数单测全绿只说明逻辑对，不代表页面能打开 —— 2026-09-22 就是在这个缝里
> 漏掉了一个 bug：`/p/<运单号>` 下页面的相对资源路径全部解析到 `/p/` 下拿回 HTML，
> **页面在生产形态的 URL 下什么都渲染不出来**，而当时的渲染验证只跑过 `?w=` 形态。
> 详见「已知边界」§2。

> ⚠️ **别直接双击 `index.html`**。`file://` 下浏览器禁止 `fetch`，页面会回退到
> `data/embedded.js` 的内嵌副本——能看，但**不反映「改素材表即生效」的真实行为**，
> 且 `crypto.subtle` 在部分浏览器下受安全上下文限制。要验 AC-09 / 签收流程请用 `serve.sh`。

---

## 二、数据从哪来

**碰标签时，浏览器只拿到 NDEF 的 URI 记录（URL），拿不到主数据记录（JSON 载荷）。**
这是系统行为，不是实现取舍——iOS/Android 都只把 URI 交给浏览器。

所以页面必须自己拿到数据。本期做法：

```
data-private/labels.json       明文载荷（真相源，不发布）
data-private/demo_phones.json  演示手机号（假号码，不发布）
        │
        ▼  tools/seal_data.js（Node，零 npm 依赖）
        │
        ├─▶ data/public.json   浅信息，明文发布（不含路由、UID、广告/素材指针）
        ├─▶ data/sealed.json   每运单一段 AES-GCM 密文
        └─▶ data/embedded.js   public + sealed + 查找表的内嵌副本
```

- 浅信息在验证前可见；详情是密文，**完整手机号派生出的密钥**才能解开；
  GCM 校验通过即证明手机号正确（不做「先比对哈希再解密」，避免多存一份可爆破凭据）。
- 明文源只放 `data-private/`，不进入发布产物；旧的 `data/labels.json` 已删除。
- `tools/build_data.py` 是上游 `reader-h5` 的构建工具；本仓库由 `seal_data.js` 生成产物。

| | 本期（演示） | 生产 |
| --- | --- | --- |
| 浅信息 | `data/public.json` 静态发布 | 服务端按运单号下发 |
| 详情 | `data/sealed.json`，手机号派生密钥解密 | **服务端校验手机号后下发** |
| 签收状态 | 本机 localStorage | 服务端 append-only 记录 |
| 标签的角色 | 写入端的真值来源 | 只写不透明 ID |

> **演示话术要注意**：现场说「数据在标签里」时，指的是**PDA↔标签的业务链路**（AC-08）。
> H5 展示的内容来自与写入端同源的演示数据集——浏览器没有 NFC 读取能力，这一点无法绕过。
> 若要说清「标签即真值」，走 **Android 读取 App（M4）**，它是真读标签的。

---

## 三、签收流程

1. **未验证（locked）**：只展示浅信息卡（运单号、物品、重量、服务）和脱敏手机号
   （如 `138****0001`），提示输入完整手机号验证。路由、身份 UID、广告、素材、
   留痕与签收按钮都不渲染，也不存在于 DOM。
2. **输入手机号**：去掉空格 / 连字符后必须是 11 位（`^1[3-9]\d{9}$`）。
   格式不合法只提示，不扣次数；格式合法但解不开密文，扣一次尝试。
3. **验证即解密**：用手机号经 PBKDF2-SHA256（600000 次）派生 256 位密钥，
   解密 `sealed.json` 中该运单的 AES-256-GCM 密文。失败与手机号错误使用同一条提示。
4. **锁定（演示）**：连续 5 次失败锁定 15 分钟，显示倒计时并禁用输入；
   清空 localStorage 可绕过，仅用于演示与生产行为对齐。
5. **已验证（unlocked）**：展示完整详情、路由、脱敏 UID、广告位、素材与签收卡。
6. **确认签收**：先弹出**行内确认**（「确认签收？此操作不可撤销」），确认后才写入；
   页面同时做按钮禁用与二次读取，保证幂等。
7. **本机记录**：写入 localStorage `pda_sign_<运单号>`，包含签收时间、掩码手机号、
   `fp_xxxxxxxx` 设备指纹 ID、记录 ID 与内容指纹。**不保存完整手机号**，
   成功页也只显示掩码。
8. **再次打开 / 刷新**：仍要先验证手机号才能看详情；未验证时显示
   「已签收（本机）」+ 时间。清除浏览器数据后记录消失（演示预期）。

设备指纹是**轻量软指纹**（UA、platform、screen、timezone、language + 本地随机
`deviceId`），可清除、可伪造，**不是硬件 ID**。页面常驻演示横幅：
「演示环境：详情为加密演示数据；签收记录仅保存在本机，不具备法律效力。」

---

## 四、安全边界（**演示级，不是安全边界**）

**能挡住：**

- 普通访问者打开页面、查 DevTools、直接请求已删除的 `data/labels.json`；
- 直接 `curl` 已发布的 `data/public.json` / `data/sealed.json` 读取详情（只有浅信息与密文）；
- 通过 `?debug=1` 在线上渲染任意载荷（生产域名下忽略该参数）。

**挡不住（五条，必须与甲方说清）：**

1. **离线爆破**：掩码 `138****5678` 只隐藏中间 4 位，候选仅 1 万种；PBKDF2 能拖慢，
   但挡不住 GPU。
2. **本机记录伪造**：localStorage 由客户端控制，签收时间也是本机时间。
3. **标签内容泄露**：若 NFC 标签 MIME 记录里写了完整载荷，第三方 NFC 工具可直接读取，
   完全绕过网页。生产应只往标签写不透明 ID，详情留服务端。
4. **仓库与历史**：本仓库是公开的 GitHub 仓库，`data-private/` 和 git 历史仍可被看到；
   当前为假数据，可接受；真实数据必须私有仓库、不入库、清历史。
5. **共享素材**：`data/materials/` 下的验货图仍是公开文件；若将来是运单专属敏感图，
   必须移到服务端。

**生产最小改造（spec §11.2）：**

1. 详情改为服务端按运单号下发，`index.html` 只保留浅信息；
2. `POST /api/verify` 服务端比对手机号（或 OTP），按运单 + IP + 设备限流；
3. 验证成功签发短时 token，详情与签收接口均需 token；
4. 签收记录服务端 append-only 写入，使用服务端时间与 IP，幂等键防重；
5. 标签只写不透明 ID，详情不再固化在标签 MIME 记录里；
6. 仓库私有化，明文手机号与详情源不入库；敏感验货图走鉴权接口。

`sign-api.js` 的 `window.PdaSignApi` 接口是替换点：`getPublic` / `unlock` / `sign`
已经是异步接口，可原地替换为 HTTP 调用。但 `getRecord` / `getAttemptState` 目前是
**同步 localStorage 读取**（演示实现），接服务端时需改为异步，并小幅调整页面状态
（读取本机记录、检查锁定与剩余次数都要等待 Promise）。渲染与 UI 结构基本可以保留，
但这处适配不能省。

---

## 五、契约消费点（对照上游 `pda-iot` 仓库的 `shared/README.md` §五 逐条实现）

> 本仓库不包含 `shared/`；`shared/README.md` 位于上游 `pda-iot` 仓库，路径相对该仓库根目录。

| 契约要求 | 实现位置 |
| --- | --- |
| 校验失败 / 版本未知 → 提示，**不得崩溃**（BR-05） | `validate()` + `renderNotice('err', …)` |
| 由 `f.r.c` 每 6 位切分还原节点（`routeNodes` 不在标签里） | `routeNodesOf()` |
| 指针查不到 → **降级为占位文案**，不得留空或报错 | `resolveAd()` / `resolveMaterial()` / `resolveNode()` |
| 展示脱敏 UID，标注不含明文手机号 | `renderIdentity()` |
| 读取端**不实现** UID 算法、**不识别**标签批次 | 全篇无相关代码（INV-6） |
| 标签内容是不可信输入 | 所有插值走 `esc()` |
| 验证前只给浅信息 | `renderLocked()` / `renderFull(..., {debug:false})` |
| 详情解密失败与手机号错误同一提示 | `sign-api.js` 的 `unlock()` |

**素材表每次打开都重新读取**（`fetch(..., {cache:'no-store'})`），不与标签绑定：
改 `data/adSlots.json` 的文案，刷新并重新验证后即变，**标签一个字节都不用动**
（AC-09）。public / sealed 同样 `no-store` 加载。

广告落地页同理：`landingUrl` 用站内相对路径 `ad.html?slot=A01`（由 `<base>` 解析到站点根），
随 H5 一起部署。验收会真的请求这个链接并打开落地页——只断言「有 href」不够，
链接指向死域名时页面渲染照样正常，点开才会发现打不开。

**降级表现**（单测覆盖）：广告位指针落空 → 显示「广告位 A99 + 素材表中暂无此广告位文案」；
节点码落空 → 显示「节点 999999」；两者都不留空、不报错。

---

## 六、已知边界（**需要甲方/部署方知道**）

### 1. 正式 URL 形态取决于托管能力

D7 定的形态是 `https://<域名>/p/<运单号>`。这**不对应磁盘上的任何文件**，
静态托管默认返回 404，需要配一条 rewrite 把 `/p/*` 回退到 `index.html`。

**当前演示部署是 GitHub Pages 项目页**（子路径 `/public-index/`）：GitHub Pages
不支持 rewrite，因此**正式形态改为 `index.html?w=<运单号>`**，纯静态托管直接返回 200；
`/p/<运单号>` 由部署仓库根目录的 `404.html` 在浏览器里跳到 `?w=` 形态——HTTP 状态先 404、
再前端跳转，能看但不是首选。写标签时用 `--h5-base` 指向 `?w=` 形态即可。

换到支持 rewrite 的托管（Netlify / Vercel / nginx）时，**`deploy/` 里的配置仍然可用**，
`/p/` 可直接 200 返回。本地 `tools/serve_spa.py` 实现的就是该规则，
`serve.sh` 默认用它，因此本地验收默认仍是 `--form=path`。

> 此前本地用的是 `python3 -m http.server`，它对 `/p/xxx` 直接 404，
> 于是**生产形态的 URL 在本地从来没有被打开过**。

### 2. 相对资源路径：`index.html` 顶部那段 `<base>` 脚本不能删

`/p/<运单号>` 下浏览器不知道「这其实是站点根的那张页面」，会把 `styles.css` /
`app.js` / `data/public.json` 这些裸相对路径解析到 **`/p/`** 下，而它们全都命中
同一条 SPA 回退规则、各拿回一份 HTML（`Content-Type: text/html`）。结果：

```
CSS 不生效（拿回的是 HTML） → app.js 报语法错 → public.json 的 r.json() 解析失败
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

## 七、调试入口（仅 localhost）

`?debug=1`，或访问一个不在演示数据集里的运单号，页面会给出一个输入框：
把 **PDA 写入端导出的载荷 JSON**（或第三方 NFC 工具读出的）贴进去即可渲染。

**仅当 `location.hostname` 为 `localhost` / `127.0.0.1` / `::1` 时启用**；
生产域名下忽略 `?debug=1`，避免绕过加密。

用途：**真机联调**——M3 还没做完、域名还没定的时候，就能验证「写入端产出的载荷
能不能被读取端正确渲染」，不必等端到端打通。

```bash
# 从本地明文源取一条载荷（仅本地，不部署；也可粘贴 PDA 写入端导出的载荷 JSON）
node -e "const l=require('./data-private/labels.json').labels; console.log(JSON.stringify(l['202608080003']))"
```

---

## 八、验收标准变化

- **AC-04（修订）**：碰标签打开后，未验证只给浅信息；路由、身份 UID、广告、素材、
  签收按钮均不在 DOM；初始 HTML / 网络响应不含完整手机号；
  `/data/labels.json` 与 `/data-private/*` 返回 404；发布产物不含明文路由与 UID。
- **AC-04-S（新增）**：错误手机号统一提示并递减次数；5 次后锁定并显示倒计时；
  正确手机号显示详情并可签收；成功卡含时间、掩码手机号、`fp_` 指纹、记录 ID、内容指纹；
  刷新后显示「已签收（本机）」，重新验证不产生第二条记录。
- **AC-05（修订）**：`index.html?w=<运单号>` 形态下执行与 AC-04 相同的
  未验证 / 已验证 / 签收断言。
- **AC-09（修订）**：验证后读取广告文案 A，修改 `data/adSlots.json` 为 B，
  刷新并重新验证显示 B；`sealed.json` 与 `public.json` 字节不变。
- 浏览器验收需要 Chrome（或同内核的 Edge），用 `CHROME` 环境变量指定路径。

---

## 九、部署

发布清单与 rewrite 配置见 **`deploy/README.md`**。要点：发布
`index.html`、`app.js`、`sign-api.js`、`styles.css`、`ad.html`、`404.html` 与
`data/`（`public.json`、`sealed.json`、`embedded.js`、`adSlots.json`、`materials.json`、
`nodes.json`、`materials/`）；**不发布** `data-private/`、`data/labels.json`（已删除）、
`tools/`、`tests/`、`docs/`、`deploy/`、`README.md`、`serve.sh`。

`.github/workflows/static.yml` 已排除 `data-private`、`docs`、`tools`、`tests`、`deploy`、
`serve.sh`、`README.md`。

---

## 十、仓库同步

本仓库是 `automan99/pda-iot` 中 `reader-h5/` 的部署副本。本轮实现完成后，必须按
spec §11.3 把等价改动同步回 `pda-iot/reader-h5`，再由部署流程生成 `public-index`；
否则两处会分叉。
