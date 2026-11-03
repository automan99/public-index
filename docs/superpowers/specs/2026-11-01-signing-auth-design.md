# 签收认证设计（演示级静态加密）

- 日期：2026-11-01
- 状态：待评审
- 范围：`public-index`（`pda-iot/reader-h5` 的部署副本）
- 取代：此前“独立 `sign.html` 签收页”的提案（未实现）

---

## 1. 背景与目标

现有 `index.html` 是碰标签即打开的只读溯源页，未认证即可看到运单全部详情。需求方明确要求：

1. 打开页面先展示收件人脱敏手机号（如 `138****5678`）；
2. 必须输入正确的完整手机号，才能查看完整详情并签收；
3. 签收后标记“已签收”，展示签收时间、手机号、设备指纹 ID；
4. `index.html` 默认不可看，避免“绕过页面直接拿数据”的漏洞。

本设计把 `index.html` 本身改造成“先验证、后查看/签收”的页面，并把运单详情从静态明文改为**手机号派生的密钥加密后的密文**。

> **演示级，不是安全边界。** 纯静态托管没有服务端，无法真正限流、无法防止离线爆破、无法生成可信签收记录。详见 §3 与 §11。

## 2. 已确认的决策

| 议题 | 决策 |
| --- | --- |
| 入口 | `index.html` 即签收页；不新增 `sign.html` |
| 校验方式 | 输入完整手机号；服务端版本预留 OTP 升级位 |
| 验证前可见范围 | 浅信息：运单号、物品、重量、服务、脱敏手机号、本机签收状态 |
| 详情数据 | AES-256-GCM 加密后静态发布；解密成功即手机号正确 |
| 签收记录 | localStorage 本机记录（演示） |
| 设备指纹 | 轻量软指纹 + 本地随机 `deviceId`；明确非硬件 ID |
| 现有验收 | AC-04 / AC-05 / AC-09 重写，明确改变原“免认证完整展示”契约 |
| 部署 | 明文源文件放 `data-private/`，不进入发布产物；workflow 排除 |
| 调试入口 | 仅 localhost 可用；生产域名下禁用 |

## 3. 安全边界（先读这一节）

**能挡住：**

- 普通访问者打开页面、查 DevTools、直接请求 `data/labels.json`（该文件将被删除）；
- 直接 `curl` 已发布的 `data/public.json` / `data/sealed.json` 读取详情（只有密文）；
- 通过 `?debug=1` 在线上渲染任意载荷。

**挡不住：**

1. **离线爆破**：掩码 `138****5678` 只隐藏中间 4 位，候选仅 1 万种；PBKDF2 能拖慢，但挡不住 GPU。
2. **本机记录伪造**：localStorage 由客户端控制，签收时间也是本机时间。
3. **标签内容泄露**：若 NFC 标签 MIME 记录里写了完整载荷，第三方 NFC 工具可直接读取，完全绕过网页。生产应只往标签写不透明 ID，详情留服务端。
4. **仓库与历史**：本仓库是公开的 GitHub 仓库，`data-private/` 和 git 历史仍可被看到；当前为假数据，可接受；真实数据必须私有仓库、不入库、清历史。
5. **共享素材**：`data/materials/` 下的验货图仍是公开文件；若将来是运单专属敏感图，必须移到服务端。

页面顶部必须常驻演示提示；README 与规格必须同步声明上述边界。真实上线的最小方案见 §11。

## 4. 数据架构

```text
data-private/labels.json        现有明文载荷（从 data/labels.json 移入）
data-private/demo_phones.json   演示用完整手机号（假数据，waybill → 11 位号码）
        │
        ▼  tools/seal_data.js（Node，零 npm 依赖）
        │
        ├─▶ data/public.json    浅信息，明文发布
        ├─▶ data/sealed.json    AES-GCM 密文，发布
        └─▶ data/embedded.js    重新生成：public + sealed + 素材表（无明文详情）
```

### 4.1 发布清单

| 文件 | 发布 | 说明 |
| --- | --- | --- |
| `data/public.json` | 是 | 浅信息；无路由、无 UID、无广告/素材指针 |
| `data/sealed.json` | 是 | 每运单一段密文 |
| `data/adSlots.json` / `materials.json` / `nodes.json` | 是 | 公共查找表，不含具体运单映射 |
| `data/materials/` | 是 | 通用演示素材图 |
| `data/embedded.js` | 是 | 仅 public + sealed + 查找表 |
| `data/labels.json` | **删除** | 不再发布 |
| `data-private/**` | **否** | workflow 与本地服务均拒绝 |
| `docs/**` | **否** | workflow 排除，避免设计文档进站点 |
| `tools/**`、`tests/**`、`deploy/**` | 否 | 现有规则，保持 |

### 4.2 `data/public.json`

```json
{
  "meta": {
    "version": "1",
    "generatedFrom": "data-private/labels.json",
    "generatedAt": "2026-11-01T12:00:00+08:00",
    "waybills": ["202608080001"],
    "securityNote": "浅信息为公开数据；详情为加密数据。"
  },
  "waybills": {
    "202608080001": {
      "w": "202608080001",
      "n": "茶叶礼盒",
      "g": "1.5kg",
      "service": "次日达",
      "phoneMask": "138****5678"
    }
  }
}
```

不含签收状态。签收状态在演示期由本机 localStorage 合并；生产由 `/public` 接口返回。

### 4.3 `data/sealed.json`

```json
{
  "meta": {
    "version": "1",
    "alg": "AES-256-GCM",
    "kdf": "PBKDF2-SHA256",
    "iter": 600000,
    "note": "密文公开；完整手机号是唯一解密凭据。"
  },
  "entries": {
    "202608080001": {
      "salt": "<base64 16B>",
      "iv": "<base64 12B>",
      "ciphertext": "<base64：密文 + 16B GCM tag>"
    }
  }
}
```

- 明文是现有标签载荷 JSON 的原始 UTF-8 字符串；
- AAD = `"<运单号>|2"`（`2` 为契约版本），由浏览器按 URL 与支持版本重算；
- 不存手机号、不存掩码哈希、不存明文详情。

### 4.4 `data-private/demo_phones.json`

```json
{
  "202608080001": "<11 位演示手机号>"
}
```

- 演示用假号码；值只用于生成密文与本地验收；
- 不进入发布产物；README 只写“见该文件”，不复制完整号码；
- 真实部署中该文件必须不入库。

### 4.5 密封工具 `tools/seal_data.js`

零 npm 依赖，Node 内置 `crypto`：

1. 读取 `data-private/labels.json` 与 `data-private/demo_phones.json`；
2. 每个运单必须有合法手机号（`^1[3-9]\d{9}$`），否则退出码 1；
3. 计算掩码 `前3位 + "****" + 后4位`；
4. 每运单生成随机 salt（16B）与 IV（12B），`PBKDF2-SHA256(phone, salt, 600000)` → 256 位密钥，`AES-256-GCM` 加密标签 JSON；
5. 读取现有 `data/adSlots.json`、`data/materials.json`、`data/nodes.json`，与 public/sealed 一起写出 `data/embedded.js`（供 `file://` 回退）；
6. **自检**：在 `public` 文档中搜索每个完整手机号、路由码、身份 UID；在查找表中只搜索完整手机号（`nodes.json` 合法包含节点码，不能把表里的码当泄露）；`sealed` 只检查条目形状与完整手机号；命中即失败；
7. 若 `data/labels.json` 仍存在：默认警告；`--final` 时视为错误并退出；`--check` 只校验现有产物、不重写；
8. 失败时不得留下半成品（先写临时文件，校验通过再原子替换）。

工具不参与 CI/部署；产物提交入库，README 说明重跑命令。

## 5. 加密与验证

### 5.1 参数

| 项 | 值 |
| --- | --- |
| KDF | PBKDF2-HMAC-SHA256 |
| 迭代次数 | 600000（读取时校验范围 100000–1000000） |
| 密钥 | 256 位 |
| 加密 | AES-256-GCM |
| Salt / IV | 16B / 12B，每运单独立随机 |
| AAD | `<运单号>|2`，UTF-8 |
| 密文 | ciphertext + 16B tag，base64 |

### 5.2 验证即解密

- 浏览器用输入手机号派生密钥；GCM 校验通过 = 手机号正确；
- 不做“先比对手机号哈希再解密”，避免多存一份可离线爆破的凭据；
- 解密后解析 JSON，复跑现有 `validate()`；不合法则统一报“数据格式错误”，不进入详情；
- 解密失败与手机号错误使用**同一条提示**，不泄露差异。

### 5.3 输入处理

- 去掉空格、连字符、括号；必须匹配 `^1[3-9]\d{9}$`；
- 格式不合法：本地提示“请输入 11 位手机号”，**不消耗尝试次数**；
- 格式合法但解密失败：消耗一次尝试；
- 验证成功后立即清空输入框，手机号不写入任何存储；
- 输入框：`type="text"`、`inputmode="numeric"`、`autocomplete="off"`、`spellcheck="false"`。

### 5.4 尝试限制（演示）

- localStorage 键 `pda_sign_attempts_<waybill>`：`{ fails, firstFailAt, lockUntil }`；
- 5 次失败锁定 15 分钟；显示倒计时并禁用输入；
- 成功或锁定到期后清零；
- **客户端限流可被清除 localStorage 绕过**，仅用于演示与生产行为对齐。

### 5.5 安全上下文

`crypto.subtle` 只在 HTTPS 或 localhost 可用。局域网 HTTP（如手机访问 `http://192.168.x.x:8080`）不可用，页面必须给出明确提示，而不是静默失败。验收与演示默认走 localhost 或 HTTPS。

## 6. 页面流程与 UI

### 6.1 状态机

```text
boot → locked ──提交合法手机号──▶ verifying ──解密成功──▶ unlocked ──确认签收──▶ signed
          │                           └──解密失败──▶ locked（错误提示 + 扣次数）
          ├──本机已有签收记录──▶ locked（展示「已签收（本机）+ 时间」）
          └──5 次失败──▶ locked-out（倒计时）
```

### 6.2 未验证（locked）

页面顶部在**所有状态**下常驻演示横幅：“演示环境：详情为加密演示数据；签收记录仅保存在本机，不具备法律效力。”

locked 视图按顺序展示：

1. **浅信息卡**：运单号、物品、重量、服务；
2. **脱敏手机号**：`138****5678`，文案“为保护收件人隐私，请输入完整手机号验证”；
3. **输入区**：11 位手机号输入框 + “验证并查看”按钮 + 隐私说明（演示文案“手机号仅用于本机解密，不上传、不保存”；接入服务端后改为“仅用于签收校验，不保存明文”）；
4. **本机签收状态**（若有）：`已签收（本机记录）· 2026-11-01 14:20`；
5. **错误区**：`aria-live="polite"`，统一文案“手机号与运单信息不匹配，请核对后重试（剩余 N 次）”。

未验证时**不得渲染**：路由进度、身份特征码、广告位、验货素材、留痕卡、签收按钮。这些内容也不得存在于 DOM 的隐藏节点中。

### 6.3 验证中（verifying）

- 按钮禁用并显示“验证中…”；
- 输入框只读；
- 解密完成后恢复；失败则按 §6.2 处理。

### 6.4 已验证（unlocked）

- 复用现有渲染：`renderHero`、`renderRoute`、`renderIdentity`、`renderAd`、`renderMaterial`、`renderStamp`；
- 顶部加“已验证”标识；
- 底部加**签收卡**：
  - 说明：“签收后不可撤销。将记录签收时间、脱敏手机号与设备信息，用于签收凭证。”
  - 按钮“确认签收”；
  - 点击后先展示行内确认（“确认签收？此操作不可撤销” + 确认/取消），确认后才写入；
- 若本机已有记录：不显示签收按钮，直接显示签收记录卡。

### 6.5 已签收（signed）

成功卡字段：

| 字段 | 值 |
| --- | --- |
| 状态 | 已签收（本机记录） |
| 签收时间 | `signedAt` 本地化显示 |
| 手机号 | `phoneMask`（只展示掩码） |
| 设备指纹 ID | `fp_xxxxxxxx` |
| 校验方式 | 手机号 |
| 记录 ID | `eventId` 前 8 位 |
| 内容指纹 | `h_xxxxxxxx`（`contentHash` 前 8 位） |

完整手机号不在成功页展示，也不写入记录。

### 6.6 再次打开 / 刷新

- 读取 localStorage 记录，locked 视图显示“已签收（本机）+ 时间”；
- 仍需验证手机号才能查看详情与完整记录；
- 刷新后解密内容从内存清除，必须重新验证。

### 6.7 调试入口

- 现有 `?debug=1` 粘贴载荷渲染功能保留，但仅当 `location.hostname` 为 `localhost` / `127.0.0.1` / `::1` 时启用；
- 生产域名下忽略该参数，避免绕过加密；
- README 注明该入口不适用于线上演示。

### 6.8 样式与可用性

- 复用现有 `styles.css`，新增 `.demo-banner`、`.gate`、`.phone-input`、`.sign-card`、`.sign-success`、`.lockout` 等类；
- 移动端优先；输入框 16px 以上避免 iOS 缩放；按钮最小触达 44px；
- 错误与状态使用 `aria-live`；签收按钮有 `disabled` 与 loading 状态；
- 页面标题改为“快件签收 · NFC-PDA”。

## 7. 签收记录与设备指纹

### 7.1 记录结构

存储键：`pda_sign_<waybill>`

```json
{
  "eventId": "<uuid>",
  "waybill": "202608080001",
  "status": "signed",
  "signedAt": "2026-11-01T14:20:31.000Z",
  "verifyMethod": "phone",
  "phoneMask": "138****5678",
  "contentHash": "<sha256 hex>",
  "sealVersion": "1",
  "device": {
    "deviceId": "<uuid>",
    "fingerprintId": "fp_3f7a9c2e",
    "fingerprintHash": "<sha256 hex>",
    "ua": "<navigator.userAgent>",
    "platform": "<platform>",
    "screen": "390x844",
    "timezone": "Asia/Shanghai",
    "language": "zh-CN"
  },
  "consentVersion": "demo-v1"
}
```

- `contentHash`：解密后明文 JSON 原始字节的 SHA-256，用于标识“签的是哪一版内容”；
- 不存完整手机号、不存 IP、不存地理位置；
- `signedAt` 为本机时间，明确非可信服务端时间。

### 7.2 幂等

- 写入前先读；已存在则直接返回原记录，不覆盖、不改时间；
- 双击/重复提交由按钮禁用 + 二次读取兜底。

### 7.3 设备指纹

- `deviceId`：localStorage `pda_device_id`，`crypto.randomUUID()`，清除浏览器数据即失效；
- 指纹组成：`userAgent`、`platform`、`screen`、`timezone`、`language`、`deviceId`；
- `fingerprintHash = SHA-256(JSON.stringify(组件, 键排序))`；
- 展示 `fingerprintId = "fp_" + hash.slice(0, 8)`；
- 明确告知：软指纹，可清除、可伪造，不是硬件 ID。

## 8. API 抽象

`sign-api.js` 暴露稳定接口，页面不直接操作加密与 localStorage：

```js
window.PdaSignApi = {
  getPublic(waybill),                         // Promise<ShallowInfo|null>
  unlock({ waybill, phone }),                 // Promise<{ detail, contentHash }>
  getAttemptState(waybill),                   // { fails, lockUntil }
  getRecord(waybill),                         // SignRecord|null
  sign({ waybill, detail, contentHash, phoneMask }) // SignRecord
};
```

- **演示实现**：读取已加载的 public/sealed 数据；PBKDF2 + AES-GCM 解密；localStorage 记录；public / sealed / 素材表均按 `cache:'no-store'` 加载，`fetch` 不可用时回退到 `data/embedded.js`；`unlock` 内部负责失败计数与锁定写入，页面只通过 `getAttemptState` 读取；
- **生产替换**：同一接口映射到 HTTP：
  - `GET /api/waybill/:w/public` → 浅信息 + 全局签收状态；
  - `POST /api/verify` → 短时 token；
  - `GET /api/waybill/:w/detail`（Bearer token）→ 详情 + 签收记录；
  - `POST /api/sign`（Bearer token + 幂等键）→ 服务端时间、IP、append-only 记录；
- 生产实现必须服务端校验手机号、服务端限流、服务端签发 token；前端只负责展示；
- 本期不实现 HTTP 适配器，只保留接口边界与文档。

## 9. 文件清单

### 新增

| 文件 | 作用 |
| --- | --- |
| `sign-api.js` | 签收 API 抽象 + 演示实现（解密、限流、记录） |
| `tools/seal_data.js` | 生成 public / sealed / embedded |
| `data-private/labels.json` | 明文载荷源（由 `data/labels.json` 移入） |
| `data-private/demo_phones.json` | 演示手机号 |
| `data/public.json` | 生成产物 |
| `data/sealed.json` | 生成产物 |
| `tests/sign_tests.js` | 密封工具与 sign-api 单测 |
| `docs/superpowers/specs/2026-11-01-signing-auth-design.md` | 本规格 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `index.html` | 页面标题改为“快件签收”；保持 `<base>` 脚本不变 |
| `app.js` | boot 改为 public + sealed；新增 locked/unlocked/sign 流程；复用现有渲染 |
| `styles.css` | 新增验证、签收、倒计时、成功卡样式 |
| `data/embedded.js` | 由密封工具重新生成，移除明文详情 |
| `tests/run_tests.js` | 改用本仓库 `data/` 与 `data-private/` 路径 |
| `tests/acceptance.js` | 重写 AC-04/05/09；新增安全断言与签收流程 |
| `tools/serve_spa.py` | 拒绝 `/data-private/`、`/tools/`、`/tests/`、`/docs/`、`/deploy/` 请求 |
| `.github/workflows/static.yml` | 发布排除 `data-private`、`docs` |
| `README.md` | 新流程、演示号码位置、安全边界、验收命令 |
| `deploy/README.md` | 发布清单改为 public/sealed，明确不含 data-private |

### 删除

- `data/labels.json`

## 10. 测试与验收

### 10.1 单元测试（`tests/run_tests.js` + `tests/sign_tests.js`）

- 手机号归一化与校验：空格/连字符、位数、非法号段；
- 掩码函数：`13800001111` → `138****1111`；
- 尝试状态机：5 次失败锁定、到期解锁、成功清零（注入时间）；
- 记录构造：字段齐全、无完整手机号、幂等不覆盖；
- 产物泄露检查：`public.json` 与 `embedded.js` 的浅信息部分不含演示手机号、路由码、身份 UID；查找表只检查手机号；`sealed.json` 条目只含 `salt/iv/ciphertext`；
- 现有 `validate` / `routeNodesOf` / 指针降级 / 转义测试全部保留；
- 路径修正：不再依赖仓库外的 `shared/`，改用本仓库 `data/` 与 `data-private/`。

### 10.2 真浏览器验收（`tests/acceptance.js`）

重写后的断言：

**AC-04（修订）：碰标签打开，未验证只给浅信息**

- 未验证页面包含运单号、物品、重量、服务、脱敏手机号；
- 不包含路由节点名、身份 UID、广告文案、素材标题、签收按钮；
- 初始 HTML 与网络响应中不包含完整手机号；
- `/data/labels.json` 返回 404；
- `/data-private/labels.json`、`/data-private/demo_phones.json` 返回 404；
- `public.json` / `sealed.json` 不含明文路由与 UID。

**AC-04-S（新增）：手机号校验与签收**

- 错误手机号 → 统一错误文案，剩余次数递减；
- 连续 5 次 → 锁定并显示倒计时；
- 正确手机号 → 详情出现、签收按钮可用；
- 签收 → 成功卡包含签收时间、`138****xxxx`、`fp_` 指纹 ID、记录 ID、内容指纹；
- 刷新/再次打开 → 显示“已签收（本机）”，重新验证后不产生第二条记录；
- 页面初始 HTML、网络响应与 localStorage 中不出现完整手机号（输入框当前值除外）。

**AC-05（修订）：`?w=` 形态**

- 与 AC-04 相同的未验证/已验证/签收断言，通过 `index.html?w=<运单号>` 验证。

**AC-09（修订）：改素材表刷新即变**

- 验证手机号 → 读取广告文案 A；
- 修改 `data/adSlots.json` 文案 B；
- 刷新并重新验证 → 页面显示 B；
- `data/sealed.json` 与 `data/public.json` 字节不变。

### 10.3 测试数据

验收脚本从 `data-private/demo_phones.json` 读取对应运单的完整手机号（仅本地运行，不部署）。线上验收时脚本仍在仓库内运行，因此可读取该文件。

### 10.4 手工验收

- 桌面 localhost 与手机视口各走一遍；
- HTTPS 部署后再走一遍；
- 局域网 HTTP 访问时确认出现“需要 HTTPS/localhost”提示；
- 清空 localStorage 后确认签收状态消失（演示预期）。

## 11. 已知限制与生产路径

### 11.1 本期明确不做

- 短信 OTP、短信通道；
- 真实服务端、全局运单状态、跨设备签收；
- 服务端时间、IP、地理位置、签名图片；
- append-only 审计库、后台撤销/更正；
- 硬件设备 ID、原生 App；
- NFC 标签载荷改造（只写不透明 ID）。

### 11.2 生产最小改造

1. 详情数据改为服务端按运单号下发；`index.html` 只保留浅信息；
2. `POST /api/verify` 服务端比对手机号（或 OTP），按运单 + IP + 设备限流；
3. 验证成功签发短时 token，详情与签收接口均需 token；
4. 签收记录服务端 append-only 写入，使用服务端时间与 IP，幂等键防重；
5. 标签只写不透明 ID，详情不再固化在标签 MIME 记录里；
6. 仓库私有化，明文手机号与详情源不入库；敏感验货图走鉴权接口。

§8 的 `PdaSignApi` 接口是替换点：`getPublic` / `unlock` / `sign` 已经是异步接口，
可原地替换为 HTTP 调用。但 `getRecord` / `getAttemptState` 当前是**同步 localStorage
读取**（演示实现），接服务端时需改为异步，并小幅调整页面状态（读取本机记录、
检查锁定与剩余次数要等待 Promise）。渲染与 UI 结构基本可以保留，但这处适配不能省。

### 11.3 仓库同步

本仓库是 `automan99/pda-iot` 中 `reader-h5/` 的部署副本。实现完成后需把等价改动同步回 `pda-iot/reader-h5`，否则两处会分叉；同步后再由部署流程生成 `public-index`。本规格范围内先在 `public-index` 落地并验收。

## 12. 验收标准

1. 未验证只看到浅信息；路由、身份码、广告、素材、留痕、签收按钮均不在 DOM。
2. `/data/labels.json`、`/data-private/*` 在本地服务与线上部署均为 404。
3. 所有发布产物不含完整手机号、明文路由、身份 UID。
4. 错误手机号统一提示并扣次数；5 次后锁定 15 分钟。
5. 正确手机号解密成功，完整详情与签收按钮出现。
6. 签收记录包含时间、掩码手机号、设备指纹 ID、记录 ID、内容指纹；不覆盖已有记录。
7. 刷新/再次打开显示“已签收（本机）”，验证后可查看完整记录。
8. 现有纯函数测试与重写后的 AC-04 / AC-04-S / AC-05 / AC-09 全部通过。
9. 局域网 HTTP 下给出安全上下文提示；localhost / HTTPS 下流程正常。
10. 页面常驻演示提示，README 与规格同步声明“演示级、非安全边界”。

## 13. 未决问题

无。掩码格式采用 `前3 + **** + 后4`；若后续要提高离线爆破成本，只能改为隐藏更多位或接入服务端/OTP，单纯调高 PBKDF2 迭代次数不是解决方案。
