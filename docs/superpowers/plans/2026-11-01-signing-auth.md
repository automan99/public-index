# 签收认证（演示级静态加密）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `index.html` 在手机上必须先输入收件人完整手机号，才能解密查看运单详情并签收；签收后在本机记录时间、脱敏手机号与设备指纹。

**Architecture:** 静态页 + 手机号派生密钥的 AES-256-GCM 密文。`data/public.json` 只放浅信息，`data/sealed.json` 放密文，明文源移入不发布的 `data-private/`。`sign-api.js` 封装解密、限流与签收记录，`app.js` 只负责页面状态与渲染。

**Tech Stack:** 原生 HTML/CSS/JS（无框架、无构建、零 npm 依赖）；Node 22 内置 `crypto`；Python 3 本地静态服务；headless Chrome + CDP 验收。

**Spec:** `docs/superpowers/specs/2026-11-01-signing-auth-design.md`

## Global Constraints

- 零 npm 依赖、无构建链；Node 单测只用内置模块；本地服务用 Python 3。
- 加密参数固定：PBKDF2-HMAC-SHA256、600000 次、salt 16B、IV 12B、AES-256-GCM、AAD `<运单号>|2`、密文 = ciphertext + 16B tag、base64。
- 发布产物只允许 `data/public.json`、`data/sealed.json`、查找表、`data/embedded.js`；不得出现完整手机号、明文路由、身份 UID。
- `data-private/**`、`tools/**`、`tests/**`、`deploy/**`、`docs/**` 不进发布；本地服务必须同样拒绝。
- 演示级定位：签收记录只写 localStorage；页面常驻文案“演示环境：详情为加密演示数据；签收记录仅保存在本机，不具备法律效力。”
- 移动端优先；手机号输入框字号 ≥16px；按钮可触达高度 ≥44px。
- 保留 `index.html` 顶部 `<base>` 脚本；同时支持 `/p/<运单号>` 与 `index.html?w=<运单号>`。
- 不修改标签契约 v2、不改 NFC 写入端、不改 `ad.html`。
- 每完成一个任务提交一次；不 push；建议在 `feat/signing-auth` 分支执行（当前 spec 提交在 `main`）。

## Review Focus

1. **篡改或异构的 sealed 条目**：base64 损坏、salt/iv 长度错、`iter` 越界、跨运单密文互换 → 统一失败、不崩溃、不无限等待。测试落在 Task 2。
2. **手机号输入边缘**：空格、连字符、`+86` 前缀、超长、非法号段、粘贴 → 归一化或本地拒绝；格式错误不扣尝试次数。测试落在 Task 2 与 Task 3。
3. **localStorage 不可用/损坏/配额满**：隐私模式、JSON 损坏、`lockUntil` 异常 → 页面仍可验证；记录必要时退化为内存，不崩。测试落在 Task 2。
4. **数据加载失败或运单缺失**：`public/sealed/查找表` 404、坏 JSON、`file://`、未知运单 → 可读错误、不泄露详情、不停在「正在加载…」。测试落在 Task 3。
5. **重复/并发签收与重载**：双击、两个标签页、已有记录、重新密封后 contentHash 变化 → 幂等、不覆盖、不产生第二条记录。测试落在 Task 2 与 Task 4。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `tools/seal_data.js` | 明文 → public/sealed/embedded；含加解密纯函数、泄露检查、原子写入 |
| `sign-api.js` | 浏览器侧签收 API 抽象：解密、尝试限制、签收记录；未来可替换为 HTTP |
| `app.js` | 页面状态机：locked / verifying / unlocked / signed；渲染与事件绑定 |
| `index.html` | 页面骨架；加载 `embedded.js` → `sign-api.js` → `app.js` |
| `styles.css` | 现有卡片 + 门禁/签收/锁定/成功卡样式 |
| `data-private/labels.json` | 明文载荷源，不发布 |
| `data-private/demo_phones.json` | 演示手机号，不发布 |
| `data/public.json` | 浅信息发布产物 |
| `data/sealed.json` | 密文发布产物 |
| `data/embedded.js` | `file://` 回退副本，只含 public/sealed/查找表 |
| `tests/sign_tests.js` | 密封工具 + sign-api 单测（Node，零依赖） |
| `tests/run_tests.js` | 现有纯函数单测；修正数据路径 |
| `tests/acceptance.js` | 真浏览器验收；重写 AC-04/05/09，新增签收与安全断言 |
| `tools/serve_spa.py` | 本地静态服务；新增私有路径拒绝 |
| `.github/workflows/static.yml` | 发布排除 `data-private`、`docs` |

---

## Task 1: 密封工具与加密数据

**Files:**
- Create: `tools/seal_data.js`
- Create: `tests/sign_tests.js`
- Create: `data-private/demo_phones.json`
- Create: `data-private/labels.json`（从 `data/labels.json` 复制；本任务暂保留原文件，Task 3 删除）
- Generate: `data/public.json`、`data/sealed.json`、`data/embedded.js`
- Modify: `tools/serve_spa.py`、`.github/workflows/static.yml`（创建私有数据的同时加护栏）

**Interfaces:**
- Produces（`module.exports`）：
  - `normalizePhone(input: string): string` — 去空白/连字符/括号；`+86` 或 `86` 前缀在剩余 11 位时去掉
  - `isValidPhone(phone: string): boolean` — `^1[3-9]\d{9}$`
  - `maskPhone(phone: string): string` — 前 3 + `****` + 后 4
  - `sealLabel(label: object, phone: string, waybill: string, version?: string): { salt, iv, ciphertext }`
  - `openSealed(entry, phone: string, waybill: string, version?: string): string`
  - `buildPublicDoc(labelsDoc: object, phones: object): object`
  - `buildSealedDoc(entries: object): object`
  - `buildEmbedded(publicDoc, sealedDoc, tables): string`
  - `findLeaks(publicDoc, sealedDoc, tables, phones, labelsDoc): Array<{ kind, value }>`
  - CLI：`node tools/seal_data.js [--final] [--check]`；`--check` 只校验现有产物、不重写。
- Produces 数据形状：严格按 spec §4.2 / §4.3；`sealed.entries[w]` 只允许 `salt`、`iv`、`ciphertext` 三个键。

- [ ] **Step 1: 写失败单测**

在 `tests/sign_tests.js` 写入以下断言（使用 `assert`，不引入测试框架）：

```js
const assert = require('assert');
const seal = require('../tools/seal_data');

assert.strictEqual(seal.normalizePhone(' +86 138-0000-1111 '), '13800001111');
assert.strictEqual(seal.normalizePhone('138 0000 1111'), '13800001111');
assert.strictEqual(seal.isValidPhone('13800001111'), true);
assert.strictEqual(seal.isValidPhone('12800001111'), false);
assert.strictEqual(seal.isValidPhone('138000011111'), false);
assert.strictEqual(seal.maskPhone('13800001111'), '138****1111');

const sample = { v: '2', t: 'pda-iot-label',
  f: { l: { w: 'W1', n: '物品', g: '1kg' }, r: { c: '350503' },
       i: { s: '0123456789abcdef', r: 'fedcba9876543210' } },
  o: { ts: 't', tcn: 1, d: 'DEV' } };
const entry = seal.sealLabel(sample, '13800001111', 'W1');
assert.strictEqual(seal.openSealed(entry, '13800001111', 'W1'), JSON.stringify(sample));
assert.throws(() => seal.openSealed(entry, '13900001111', 'W1'));
assert.throws(() => seal.openSealed(entry, '13800001111', 'W2'), /AAD|unable|auth/i);
assert.throws(() => seal.openSealed({ ...entry, salt: 'x' }, '13800001111', 'W1'));

const sealedDoc = { meta: { iter: 600000 }, entries: { W1: entry } };
const leaks = seal.findLeaks(
  { waybills: { W1: { phoneMask: '138****1111' } } },
  sealedDoc,
  { adSlots: {}, materials: {}, nodes: {} },
  { W1: '13800001111' },
  { labels: { W1: sample } }
);
assert.strictEqual(leaks.length, 0);
const bad = seal.findLeaks(
  { waybills: { W1: { phoneMask: '13800001111', route: '350503', uid: '0123456789abcdef' } } },
  sealedDoc,
  { adSlots: {}, materials: {}, nodes: {} },
  { W1: '13800001111' },
  { labels: { W1: sample } }
);
assert.ok(bad.some((x) => x.kind === 'phone'));
assert.ok(bad.some((x) => x.kind === 'route'));
assert.ok(bad.some((x) => x.kind === 'uid'));
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/sign_tests.js`
Expected: FAIL，`Cannot find module '../tools/seal_data'`

- [ ] **Step 3: 实现 `tools/seal_data.js`**

要求：
- 只 `require('crypto')` / `fs` / `path`；
- `sealLabel` 用 `crypto.pbkdf2Sync(phone, salt, 600000, 32, 'sha256')`、`createCipheriv('aes-256-gcm')`、`setAAD(Buffer.from(waybill + '|2'))`；
- `openSealed` 先校验 `salt` 16B、`iv` 12B、`ciphertext` ≥16B、`iter` 在 100000–1000000；**结构问题**抛 `Error('DATA')`，GCM 认证失败保留底层错误（由 sign-api 映射为 `MISMATCH`）；
- `buildPublicDoc` 只输出 `w/n/g/service/phoneMask`；
- `findLeaks(publicDoc, sealedDoc, tables, phones, labelsDoc)` 在 public 文档中查找完整手机号、6 位路由码、16 位 UID；查找表**只查完整手机号**（`nodes.json` 合法包含节点码，不能把表里的码当泄露）；**不扫描 sealed 密文里的短码**（base64 会误报），只检查密文条目没有明文字段、且不含完整手机号；
- CLI 读取 `data-private/labels.json`、`data-private/demo_phones.json`、`data/adSlots.json`、`data/materials.json`、`data/nodes.json`；
- 每个运单必须存在合法手机号，否则退出码 1；
- `--final` 时若 `data/labels.json` 仍存在则退出码 1；
- `--check` 只读取并校验现有 `public/sealed/embedded`：条目形状、无完整手机号、无明文 labels，不重写文件；
- 先写临时文件、校验后 `rename`，失败不留半成品；
- `if (require.main === module) main();`

- [ ] **Step 4: 准备私有数据并生成**

```bash
cp data/labels.json data-private/labels.json
```

创建 `data-private/demo_phones.json`：为 `data-private/labels.json` 中每个运单选一个不同的、符合 `^1[3-9]\d{9}$` 的**假号码**。不要把真实号码写入仓库。

```bash
node tools/seal_data.js
```

Expected: 输出 public / sealed / embedded 三个产物；提示 `data/labels.json` 仍存在（本任务允许，Task 3 删除）。

- [ ] **Step 4b: 创建私有数据的同时加部署护栏**

- `tools/serve_spa.py`：在 `_prepare()` 最前面，对 `rel = posixpath.normpath(path).lstrip("/")` 的首段命中 `{"data-private","tools","tests","deploy","docs"}` 时返回 `False`（404），再走 `/p/` 回退。
- `.github/workflows/static.yml`：`case` 排除项加入 `data-private|docs`。

这一步必须在 `data-private/` 提交前完成，避免中间提交被部署时把明文源和设计文档发布出去。

- [ ] **Step 5: 运行单测并检查产物形状**

Run: `node tests/sign_tests.js`
Expected: PASS

再运行一次只读校验（本任务 `data/labels.json` 仍在，所以不加 `--final`）：

```bash
node tools/seal_data.js --check
```

Expected: 通过；不重写任何产物。

人工/脚本检查：
- `data/public.json` 的每个 waybill 只有 `w/n/g/service/phoneMask`；
- `data/sealed.json` 的每个 entry 只有 `salt/iv/ciphertext`；
- `data/embedded.js` 含 `public/sealed/adSlots/materials/nodes`，不含 `"labels"` 明文键，不含完整手机号。

- [ ] **Step 6: 提交**

```bash
git add tools/seal_data.js tests/sign_tests.js data-private data/public.json data/sealed.json data/embedded.js \
  tools/serve_spa.py .github/workflows/static.yml
git commit -m "feat(data): 新增密封工具、加密数据与私有路径护栏"
```

> 说明：本任务保留 `data/labels.json`，旧页面在 http 下仍可运行；`file://` 回退会暂时失效，Task 3 切换后恢复。

---

## Task 2: 签收 API（解密、限流、记录）

**Files:**
- Create: `sign-api.js`
- Modify: `tests/sign_tests.js`

**Interfaces:**
- Produces `window.PdaSignApi`：

```js
{
  configure({ publicDoc, sealedDoc }): void,
  getPublic(waybill): ShallowInfo | null,
  unlock({ waybill, phone }): Promise<{ detail, contentHash }>,
  getAttemptState(waybill, now?): { fails, remaining, lockUntil, locked },
  getRecord(waybill): SignRecord | null,
  sign({ waybill, detail, contentHash, phoneMask, now? }): Promise<SignRecord>,
  isCryptoAvailable(): boolean
}
```

- Produces `window.__pdaSign` 测试钩子：
  `normalizePhone`、`isValidPhone`、`maskPhone`、`getAttemptState`、`recordFailure(waybill, now?)`、`resetAttempts(waybill)`、`buildSignRecord({ waybill, phoneMask, contentHash, device, signedAt })`、`attemptKey`、`recordKey`。
- 错误对象带 `code`：`FORMAT`、`MISMATCH`、`LOCKED`、`DATA`、`CRYPTO`。
- 记录形状严格按 spec §7.1；存储键 `pda_sign_<waybill>`；尝试键 `pda_sign_attempts_<waybill>`。

- [ ] **Step 1: 追加失败单测**

在 `tests/sign_tests.js` 追加 VM 加载器与断言：

```js
const vm = require('vm');
const nodeCrypto = require('crypto');
const pub = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/public.json')));
const sealed = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/sealed.json')));
const phones = JSON.parse(fs.readFileSync(path.join(__dirname, '../data-private/demo_phones.json')));
const W = pub.meta.waybills[0];
const W2 = pub.meta.waybills[1];
const phone = phones[W];

function loadSignApi() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const sandbox = {
    window: {}, console, localStorage, navigator: { userAgent: 'test', language: 'zh-CN' },
    screen: { width: 390, height: 844 }, Intl, TextEncoder, TextDecoder, atob, btoa,
    crypto: nodeCrypto.webcrypto,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sign-api.js'), 'utf8'), sandbox);
  return { api: sandbox.window.PdaSignApi, hooks: sandbox.window.__pdaSign, sandbox, store };
}

// 正确手机号
let { api, hooks, store } = loadSignApi();
api.configure({ publicDoc: pub, sealedDoc: sealed });
let unlocked = await api.unlock({ waybill: W, phone: ' ' + phone + ' ' });
assert.strictEqual(unlocked.detail.f.l.w, W);
assert.match(unlocked.contentHash, /^[0-9a-f]{64}$/);
const plus86 = await api.unlock({ waybill: W, phone: '+86 ' + phone });
assert.strictEqual(plus86.detail.f.l.w, W);

// 错误手机号 / 格式错误 / 锁定
const wrong = phone.slice(0, 10) + (phone[10] === '9' ? '8' : '9');
await assert.rejects(() => api.unlock({ waybill: W, phone: wrong }), (e) => e.code === 'MISMATCH');
const failsAfterMismatch = hooks.getAttemptState(W).fails;
await assert.rejects(() => api.unlock({ waybill: W, phone: '123' }), (e) => e.code === 'FORMAT');
assert.strictEqual(hooks.getAttemptState(W).fails, failsAfterMismatch); // 格式错误不扣次数
store.clear();
for (let i = 0; i < 5; i++) hooks.recordFailure(W2, 1000 + i);
assert.strictEqual(hooks.getAttemptState(W2, 1005).locked, true);
assert.strictEqual(hooks.getAttemptState(W2, 1004 + 15 * 60 * 1000 + 1).locked, false);

// 被篡改的 sealed 条目
const bad = JSON.parse(JSON.stringify(sealed));
bad.meta.iter = 99999999;
api.configure({ publicDoc: pub, sealedDoc: bad });
await assert.rejects(() => api.unlock({ waybill: W, phone }), (e) => e.code === 'DATA');

// 跨运单密文（AAD）
const cross = JSON.parse(JSON.stringify(sealed));
cross.entries[W] = cross.entries[W2];
api.configure({ publicDoc: pub, sealedDoc: cross });
await assert.rejects(() => api.unlock({ waybill: W, phone: phones[W2] }), (e) => e.code === 'MISMATCH');

// localStorage 损坏
store.set('pda_sign_attempts_' + W, '{bad');
assert.strictEqual(hooks.getAttemptState(W, 0).fails, 0);
store.set('pda_sign_' + W, '{bad');
assert.strictEqual(api.getRecord(W), null);

// 幂等签收 + 不含完整手机号
api.configure({ publicDoc: pub, sealedDoc: sealed });
const r1 = await api.sign({ waybill: W, detail: unlocked.detail, contentHash: unlocked.contentHash,
  phoneMask: pub.waybills[W].phoneMask, now: 5000 });
const r2 = await api.sign({ waybill: W, detail: unlocked.detail, contentHash: unlocked.contentHash,
  phoneMask: pub.waybills[W].phoneMask, now: 6000 });
assert.strictEqual(r1.eventId, r2.eventId);
assert.strictEqual(r1.contentHash, r2.contentHash);
const r3 = await api.sign({ waybill: W, detail: unlocked.detail, contentHash: 'b'.repeat(64),
  phoneMask: pub.waybills[W].phoneMask, now: 7000 });
assert.strictEqual(r3.eventId, r1.eventId);
assert.strictEqual(r3.contentHash, r1.contentHash);
assert.strictEqual(r1.phoneMask, pub.waybills[W].phoneMask);
assert.match(r1.device.fingerprintId, /^fp_[0-9a-f]{8}$/);
assert.ok(!JSON.stringify(r1).includes(phone));
```

再补一条“localStorage 不可用”用例：让 `getItem/setItem` 抛错，`unlock` 与 `sign` 仍能在内存中完成。测试脚本用 `async function main()` 包裹全部断言，末尾 `catch` 后 `process.exit(1)`。

- [ ] **Step 2: 运行确认失败**

Run: `node tests/sign_tests.js`
Expected: FAIL，`Cannot find module '../sign-api.js'` 或 `window.PdaSignApi` 未定义

- [ ] **Step 3: 实现 `sign-api.js`**

要求：
- IIFE；不依赖 `document`，Node VM 可加载；
- `getCrypto()` 使用 `typeof crypto !== 'undefined' ? crypto : window.crypto`；无 `subtle` 时 `isCryptoAvailable()` 返回 false；
- `decryptEntry`：校验 base64、salt 16B、iv 12B、cypher ≥16B；读取 `sealedDoc.meta.iter` 并校验 100000–1000000，校验 `meta.alg === 'AES-256-GCM'`、`meta.kdf === 'PBKDF2-SHA256'`；派生 key；`subtle.decrypt({ name:'AES-GCM', iv, additionalData: TextEncoder().encode(waybill + '|2'), tagLength:128 }, key, ciphertext)`；失败映射 `MISMATCH`，结构失败映射 `DATA`；
- `unlock`：先校验手机号格式（`FORMAT`），再查锁定（`LOCKED`），再解密；失败扣次数；成功清零；返回 `detail` 与 `contentHash = sha256Hex(plaintext)`；
- `getAttemptState` / `recordFailure` 用可注入 `now`；5 次失败锁 15 分钟；损坏 JSON 视为从未尝试；
- `getStorage` 捕获 localStorage 读写异常（隐私模式、配额满），读写都回退到模块内 Map，页面仍能完成本次会话的验证与签收；
- `sign` 先读已有记录，存在则原样返回；否则构造 `eventId`、`signedAt`、`device`（`deviceId`、`fingerprintId = fp_ + hash 前 8`、`fingerprintHash`、`ua/platform/screen/timezone/language`）、`consentVersion: 'demo-v1'`；UUID 用 `crypto.randomUUID()`，不可用时用 `getRandomValues` 生成 hex；写入后返回；
- 不把完整手机号写入记录、日志或错误信息；
- 暴露 `window.PdaSignApi` 与 `window.__pdaSign`。

- [ ] **Step 4: 运行单测**

Run: `node tests/sign_tests.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add sign-api.js tests/sign_tests.js
git commit -m "feat(sign): 新增签收 API 抽象、解密与尝试限制"
```

---

## Task 3: 页面门禁与安全发布

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `styles.css`
- Modify: `tests/run_tests.js`
- Modify: `tests/acceptance.js`
- Modify: `tools/check_materials.py`
- Delete: `data/labels.json`
- Regenerate: `data/embedded.js`

> `tools/serve_spa.py` 与 `.github/workflows/static.yml` 的私有路径护栏已在 Task 1 完成。

**Interfaces:**
- Consumes: `PdaSignApi`（Task 2）。
- Produces（app.js）：
  - `renderDemoBanner(): string`
  - `renderShallow(info): string`
  - `renderLocked(info, ctx, record): void`
  - `renderFull(label, ctx, record, options): void`
  - `bindVerify(info): void`
  - `handleVerify(info): Promise<void>`
  - `startLockoutCountdown(lockUntil): void`
  - `isLocalhost(): boolean`
- 稳定 DOM 选择器：`#main`、`.demo-banner`、`.gate-card`、`#phone-input`、`#verify-btn`、`#gate-error`、`#lockout`、`.status-pill`、`.verified-badge`。

- [ ] **Step 1: 重写验收断言（先红）**

改 `tests/acceptance.js`：

1. 替换数据加载：
```js
const publicDoc = readJSON(path.join(H5_DIR, 'data', 'public.json'));
const sealedDoc = readJSON(path.join(H5_DIR, 'data', 'sealed.json'));
const privateDoc = readJSON(path.join(H5_DIR, 'data-private', 'labels.json'));
const phones = readJSON(path.join(H5_DIR, 'data-private', 'demo_phones.json'));
const waybills = publicDoc.meta.waybills;
const W = waybills[0];
const W2 = waybills[1];
const label = privateDoc.labels[W];
const phone = phones[W];
const mask = publicDoc.waybills[W].phoneMask;
const wrong = phone.slice(0, 10) + (phone[10] === '9' ? '8' : '9');
const phone2 = phones[W2];
const wrong2 = phone2.slice(0, 10) + (phone2[10] === '9' ? '8' : '9');
const publicRaw = fs.readFileSync(path.join(H5_DIR, 'data', 'public.json'), 'utf8');
const sealedRaw = fs.readFileSync(path.join(H5_DIR, 'data', 'sealed.json'), 'utf8');
const embeddedRaw = fs.readFileSync(path.join(H5_DIR, 'data', 'embedded.js'), 'utf8');
```
2. 新增 `Page` 辅助：
```js
async waitForSelector(selector, timeout = 30000) { /* 轮询 document.querySelector */ }
async waitForText(text, timeout = 30000) { /* 轮询 #main innerText.includes(text) */ }
async verifyWith(phone) {
  await this.evaluate(`(() => {
    const el = document.getElementById('phone-input');
    el.value = ${JSON.stringify(phone)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('verify-btn').click();
    return true;
  })()`);
}
```
3. AC-04 未验证断言：
   - 页面包含演示横幅文案“演示环境”；
   - 页面包含 `W`、`label.f.l.n`、`label.f.l.g`、`publicDoc.waybills[W].service`、`mask`；
   - 不包含第一个路由节点名、`label.f.i.s`、`label.f.i.r`、广告标题、素材 caption、`label.o.ts`；
   - 初始 `mainHTML()` 不匹配 `/1[3-9]\d{9}/`；
   - `GET /data/labels.json`、`GET /data-private/labels.json`、`GET /data-private/demo_phones.json` 均为 404；
   - `public.json` 的 waybill 条目只有 `w/n/g/service/phoneMask`；`sealed.json` 条目只有 `salt/iv/ciphertext`；
   - `publicRaw` 不含完整手机号、`label.f.i.s`、`label.f.i.r`、6 位路由码；`sealedRaw` 不含完整手机号；
   - `embeddedRaw` 不含 `"labels"` 明文键、不含完整手机号。
4. AC-04 错误手机号：
   - `verifyWith(wrong)` → `waitForText('不匹配')`；
   - 错误提示不包含完整手机号。
5. 锁定 UI：另开页面打开 `W2`，连续 `verifyWith(wrong2)` 5 次，每次点击后等 `#verify-btn` 恢复可用再点下一次；最后等待 `#lockout` 出现且文案含倒计时。该页不影响 `W`。
6. AC-04 正确手机号：
   - `verifyWith(phone)` → `waitForSelector('.verified-badge')` 或详情卡片；
   - 断言路由节点名、双 UID、广告标题、素材 caption、留痕时间出现；
   - 页面无未捕获 JS 异常。
7. AC-05：通过另一形态打开同一运单，重复未验证/验证流程；`#main` innerHTML 与 AC-04 解锁后的内容一致（时间类字段不存在，因为本任务还没有签收卡）。AC-05 在 AC-04 之后、AC-04-S 之前执行；AC-04 只验证不签收，W 仍无本机记录。
8. AC-09：验证手机号后检查广告文案 A；修改 `data/adSlots.json`；新开页面、重新验证、检查 B；断言 `sealed.json` 与 `public.json` 字节不变，pointer 不变，marker 不进入两个产物。
9. 未知运单：打开 `index.html?w=999999999999`，断言出现“未找到运单”，且不出现任何路由/UID。

Run: `bash tests/acceptance.sh`
Expected: FAIL（页面仍在读取 `labels.json`，且未渲染门禁）

- [ ] **Step 2: 更新 `index.html`**

- `<title>快件签收 · NFC-PDA</title>`；
- 在 `app.js` 前加载 `<script src="sign-api.js"></script>`；
- 保持 `<base>` 内联脚本、`#main`、debug box、footer 不变。

- [ ] **Step 3: 实现 app.js 门禁与验证**

要求：
- `loadJSON` 改为 `public.json → public`、`sealed.json → sealed`、查找表键不变；`file://` 回退读 `embedded.js` 的 `public/sealed/adSlots/materials/nodes` 键；
- `boot()`：加载 5 份数据；`PdaSignApi.configure({ publicDoc, sealedDoc })`；取 URL 运单号；`getPublic(w)`；无结果 → “未找到运单” notice；`isCryptoAvailable()` 为 false → 可读的 HTTPS/localhost 提示；读取本机 `getRecord(w)`；渲染 locked；`?debug=1` 仅在 `isLocalhost()` 时启用；`window.PdaSignApi` 不存在时显示可读错误；
- `renderLocked`：常驻 `.demo-banner`、浅信息卡、脱敏手机号、`#phone-input`（`type=text`、`inputmode=numeric`、`autocomplete=off`、`spellcheck=false`）、`#verify-btn`、`#gate-error`（`aria-live="polite"`）、`#lockout`、隐私说明“手机号仅用于本机解密，不上传、不保存”、`.status-pill`（有本机记录时）；
- `handleVerify`：进入 verifying 时禁用按钮与输入并显示“验证中…”；调用 `unlock`；成功清空输入、`renderFull(detail, ctx, record)`、更新 `.verified-badge`；失败按 code 渲染：
  - `FORMAT` → “请输入 11 位手机号”
  - `MISMATCH` → “手机号与运单信息不匹配，请核对后重试（剩余 N 次）”
  - `LOCKED` → 倒计时文案，禁用输入
  - `DATA` / `CRYPTO` → 对应可读提示
- `renderFull`：复跑 `validate`；前置 `renderDemoBanner()`；通过后渲染现有 `renderHero/Route/Identity/Ad/Material/Stamp`；本任务**不渲染签收卡**；
- 保留 `window.__pdaIot` 的 `validate/routeNodesOf/resolve*/esc` 导出；Node 无 `document` 时提前 return，不跑 `boot()`；
- `startLockoutCountdown`：每秒更新 `#lockout`，倒计时结束恢复输入；
- debug 粘贴渲染调用 `renderFull(label, ctx, null, { debug: true })`；debug 模式不出现签收入口（本任务本来也没有）；
- footer 与 `source-badge` 更新为“加密演示数据 / 已解锁”；不泄露完整手机号。

- [ ] **Step 4: 补样式**

在 `styles.css` 增加：`.demo-banner`、`.gate-card`、`.phone-mask`、`.phone-form`、`.phone-input`、`.verify-btn`、`.gate-error`、`.lockout`、`.status-pill`、`.verified-badge`。输入框 16px、按钮 ≥44px、移动端不横向溢出；沿用现有颜色变量。

- [ ] **Step 5: 修正数据路径与工具**

- `tools/check_materials.py`：`labels_path` 改为 `data-private/labels.json`。
- `tests/run_tests.js`：labels 读取 `data-private/labels.json`；查找表改读 `H5_DIR/data/...`；删除未使用的 `REPO`。

- [ ] **Step 6: 删除明文并重新生成**

```bash
git rm data/labels.json
node tools/seal_data.js --final
git status --short
```

Expected: `data/labels.json` 消失；`--final` 通过；`data/embedded.js` 重新生成且不含明文 labels。

- [ ] **Step 7: 跑全部现有测试**

```bash
node tests/run_tests.js
node tests/sign_tests.js
bash tests/acceptance.sh
```

Expected: 全部 PASS；AC-04/05 未验证只见浅信息、正确手机号可见详情；AC-09 在验证后仍成立；404 与产物形状断言通过。

- [ ] **Step 8: 提交**

```bash
git add index.html app.js styles.css tools/check_materials.py \
  tests/run_tests.js tests/acceptance.js \
  data/embedded.js data/public.json data/sealed.json
git add -u data/labels.json
git commit -m "feat(sign): index 改为手机号验证后查看详情"
```

---

## Task 4: 签收流程与留痕

**Files:**
- Modify: `app.js`
- Modify: `styles.css`
- Modify: `tests/acceptance.js`

**Interfaces:**
- Consumes: `PdaSignApi.unlock` / `sign` / `getRecord`；`unlocked` 内存对象 `{ waybill, detail, contentHash }`。
- Produces（app.js）：
  - `renderSignCard(): string`
  - `renderSignedCard(record): string`
  - `bindSign(unlocked, info): void`
  - `handleSign(unlocked, info): Promise<void>`
- 稳定 DOM 选择器：`.sign-card`、`#sign-btn`、`#sign-confirm`、`#sign-confirm-btn`、`#sign-cancel-btn`、`#sign-error`、`.sign-success`、`.sign-time`、`.sign-phone`、`.sign-fp`、`.sign-event`、`.sign-hash`、`.signed-record`。

- [ ] **Step 1: 追加失败验收（先红）**

把 AC-04-S 放在 AC-09 之后执行，避免签收记录影响 AC-05/AC-09 的无状态字节对比。在 `tests/acceptance.js` 增加：

```js
check('验证后出现签收按钮', await page.waitForSelector('#sign-btn'));
await page.evaluate(`document.getElementById('sign-btn').click()`);
check('签收前出现不可撤销确认', await page.waitForSelector('#sign-confirm-btn'));
await page.evaluate(`document.getElementById('sign-confirm-btn').click()`);
check('签收成功卡出现', await page.waitForSelector('.sign-success'));

const success = await page.evaluate(`(() => ({
  text: document.querySelector('.sign-success').innerText,
  time: document.querySelector('.sign-time')?.innerText,
  phone: document.querySelector('.sign-phone')?.innerText,
  fp: document.querySelector('.sign-fp')?.innerText,
  event: document.querySelector('.sign-event')?.innerText,
  hash: document.querySelector('.sign-hash')?.innerText,
}))()`);
check('成功卡含“已签收”', success.text.includes('已签收'));
check('成功卡含签收时间', !!success.time);
check('成功卡展示脱敏手机号', success.phone.includes(mask));
check('成功卡展示指纹 ID', /fp_[0-9a-f]{8}/.test(success.fp));
check('成功卡展示记录 ID', /[0-9a-f]{8}/.test(success.event));
check('成功卡展示内容指纹', /h_[0-9a-f]{8}/.test(success.hash));

const rec = await page.evaluate(`JSON.parse(localStorage.getItem('pda_sign_${W}'))`);
check('本机记录已写入', !!rec && rec.status === 'signed');
check('记录含脱敏手机号', rec.phoneMask === mask);
check('记录不含完整手机号', !JSON.stringify(rec).includes(phone));
check('记录含设备指纹', /^fp_[0-9a-f]{8}$/.test(rec.device.fingerprintId));

// 刷新后仍需验证，验证后不产生第二条
await page.goto(prodUrlW);
check('刷新后显示本机已签收', await page.has('已签收（本机'));
await page.verifyWith(phone);
await page.waitForSelector('.sign-success, .signed-record');
const rec2 = await page.evaluate(`JSON.parse(localStorage.getItem('pda_sign_${W}'))`);
check('刷新后记录未被覆盖', rec2.eventId === rec.eventId);
check('已签收后不再出现签收按钮', !(await page.evaluate(`!!document.getElementById('sign-btn')`)));
```

Run: `bash tests/acceptance.sh`
Expected: FAIL（没有签收卡/按钮）

- [ ] **Step 2: 实现签收卡与记录**

要求：
- `renderFull` 在详情后追加签收区：无记录 → `renderSignCard()`；有记录 → `renderSignedCard(record)`；`options.debug` 为 true 时不渲染签收区；
- `handleVerify` 成功后把 `{ waybill, detail, contentHash }` 存入模块变量 `currentUnlock`，`renderFull` 用它调用 `bindSign(currentUnlock, info)`；
- 签收卡文案固定“签收后不可撤销。将记录签收时间、脱敏手机号与设备信息，用于签收凭证。”；
- `#sign-btn` 点击先展开 `#sign-confirm`，禁用自身；
- `#sign-confirm-btn` 调用 `PdaSignApi.sign(...)`，按钮 loading；成功 → `renderSignedCard` + 更新 badge；失败 → `#sign-error`，恢复按钮；
- `#sign-cancel-btn` 收起确认、恢复按钮；
- `renderSignedCard` 展示：状态、`.sign-time`、`.sign-phone`、`.sign-fp`、校验方式、`.sign-event`、`.sign-hash`；
- 记录存在时不渲染 `#sign-btn`；
- 已签收状态下刷新：locked 视图显示 `.status-pill`；验证后直接显示 `.signed-record`；
- 完整手机号不进入 DOM/记录。

- [ ] **Step 3: 补签收样式**

新增 `.sign-card`、`.sign-actions`、`.sign-confirm`、`.sign-btn`、`.sign-confirm-btn`、`.sign-cancel-btn`、`.sign-error`、`.sign-success`、`.sign-success-icon`、`.sign-field`、`.sign-mono`；成功卡用 `--ok` 色系；确认区用 `--warn-soft`。

- [ ] **Step 4: 跑验收**

Run: `bash tests/acceptance.sh`
Expected: PASS，含 AC-04-S 全部断言

- [ ] **Step 5: 提交**

```bash
git add app.js styles.css tests/acceptance.js
git commit -m "feat(sign): 签收确认、本机记录与成功卡"
```

---

## Task 5: 文档与最终验收

**Files:**
- Modify: `README.md`
- Modify: `deploy/README.md`

- [ ] **Step 1: 更新 README**

必须覆盖：
- 文件表加入 `sign-api.js`、`data-private/`、`public.json`、`sealed.json`；删除 `labels.json`；
- 命令改为（本仓库在根目录，不带 `reader-h5/` 前缀）：
  - `node tools/seal_data.js` / `node tools/seal_data.js --final`
  - `node tools/seal_data.js --check --final`（只校验，不重写）
  - `bash serve.sh`
  - `node tests/run_tests.js && node tests/sign_tests.js`
  - `bash tests/acceptance.sh`
- 演示手机号位置：`data-private/demo_phones.json`（不部署，不要在 README 复制完整号码）；
- 数据来源改为“手机号派生密钥加密的 public/sealed”；
- 新增“签收流程”与“安全边界”段落，原文放入 spec §3 的 5 条限制与“演示级，不是安全边界”；
- 调试入口注明仅 localhost 生效；
- 注明 `tools/build_data.py` 是上游构建工具，本仓库使用 `seal_data.js`；
- 注明本仓库是 `pda-iot/reader-h5` 的部署副本，改动需回灌。

- [ ] **Step 2: 更新 `deploy/README.md`**

- 发布清单改为 `public.json`、`sealed.json`、`embedded.js`、查找表、`materials/`；
- 明确不发布 `data-private/`、`labels.json`、`tools/`、`tests/`、`docs/`；
- 加一段：纯静态托管只能提供演示级门禁；真实签收需要服务端校验与 append-only 记录（指向 spec §11.2）。

- [ ] **Step 3: 最终验证**

```bash
node tests/run_tests.js
node tests/sign_tests.js
node tools/seal_data.js --check --final
bash tests/acceptance.sh
git status --short
```

Expected:
- 单测全部通过；
- `--check --final` 通过（无 `data/labels.json`、无泄露、不重写产物）；
- 验收全部通过（本地默认跑 AC-04/04-S/05/09）；
- `git status` 只剩本次文档改动。

人工检查：
- 桌面与手机视口各打开一次 `/p/<运单号>` 与 `?w=`；
- 直接请求 `/data/labels.json`、`/data-private/labels.json` 得到 404；
- 错误手机号 5 次后出现倒计时；
- 正确手机号可看详情并签收，刷新后显示“已签收（本机）”；
- 页面常驻演示横幅。

- [ ] **Step 4: 提交**

```bash
git add README.md deploy/README.md
git commit -m "docs: 更新签收认证的使用说明与部署边界"
```

---

## 执行备注

- Task 1 与 Task 3 之间，`file://` 回退暂时失效；执行时不要在中途部署。http 下的旧页面仍可用。
- 若并行执行 Task 3/4，`app.js` 会冲突；按顺序执行。
- 线上部署后，用 `bash tests/acceptance.sh https://<域名> --form=query` 再跑一次远端验收（AC-09 会自动跳过）。
- 完成后按 spec §11.3 把等价改动同步回 `pda-iot/reader-h5`。
