#!/usr/bin/env node
/* H5 读取页验收断言 —— AC-04 / AC-04-S / AC-05 / AC-09（签收认证版）。
 *
 * 为什么需要这个脚本：
 *
 *   1. `tests/run_tests.js` 跑的是**纯函数**，够不到「页面到底渲染出来没有」。
 *      指针降级逻辑全绿，不等于 `/p/<运单号>` 打得开。
 *   2. AC-04 判的是「手机不装 App，碰标签打开 H5」，并且**未验证只能看到浅信息**。
 *      这条依赖生产形态 URL 与真实浏览器；纯函数单测完全碰不到。
 *   3. AC-09（改素材表文案不重写标签）此前只靠人点；这里做成字节级断言：
 *      改文案后页面内容必须变，而 sealed.json / public.json 与标签内指针一个字节都不变。
 *
 * 零依赖：Chrome 走 CDP（--remote-debugging-port），Node 22 自带 WebSocket 与 fetch，
 * 不需要 npm install。需求 §5.2 刻意不加构建链，验收侧同样不加。
 *
 * 用法：
 *   node tests/acceptance.js                          # 自己起服务，全跑（含 AC-09）
 *   node tests/acceptance.js --base https://<域名>     # 打线上，跑 AC-04 / AC-04-S / AC-05（跳过 AC-09）
 *   node tests/acceptance.js --base https://<域名> --form=query
 *
 * CHROME 环境变量可指定浏览器路径；Windows 示例：
 *   CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" bash tests/acceptance.sh
 */
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const H5_DIR = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME || 'google-chrome';

// ---------------------------------------------------------------- 断言框架

let fail = 0;
let skipped = 0;
function check(desc, cond, detail) {
  if (cond) { console.log(`  OK   ${desc}`); return true; }
  fail++;
  console.log(`  FAIL ${desc}`);
  if (detail !== undefined) console.log(`       ${detail}`);
  return false;
}
function skip(desc, why) {
  skipped++;
  console.log(`  SKIP ${desc}`);
  console.log(`       ${why}`);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sameBytes = (a, b) => Buffer.compare(a, b) === 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// ---------------------------------------------------------------- CDP 客户端

class Browser {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = []; }

  static async launch() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'h5acc-'));
    const proc = spawn(CHROME, [
      '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--disable-dev-shm-usage', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('Chrome 启动超时（未输出 DevTools 地址）')), 30000);
      proc.stderr.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('exit', (c) => { clearTimeout(timer); reject(new Error(`Chrome 退出，code=${c}`)); });
    });

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });

    const b = new Browser(ws);
    b.proc = proc;
    b.profile = profile;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && b.pending.has(msg.id)) {
        const { resolve, reject } = b.pending.get(msg.id);
        b.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || '')})`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of b.listeners) fn(msg);
      }
    };
    return b;
  }

  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  on(fn) { this.listeners.push(fn); }

  /** 开一个新标签页并附加（flatten 模式，事件按 sessionId 区分）。 */
  async newPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Log.enable', {}, sessionId);

    const page = new Page(this, sessionId);
    this.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        page.jsErrors.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const e = msg.params.entry;
        page.logErrors.push(`${e.source}: ${e.text}`);
      }
    });
    return page;
  }

  async close() {
    try { this.ws.close(); } catch (_) {}
    try { this.proc.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch (_) {}
  }
}

class Page {
  constructor(browser, sessionId) {
    this.b = browser;
    this.sessionId = sessionId;
    this.jsErrors = [];
    this.logErrors = [];
  }

  send(method, params) { return this.b.send(method, params, this.sessionId); }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面内求值抛错：' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }

  /** 手机视口 + 移动端 UA —— AC-04 判的是「手机端」，桌面视口不算验过。 */
  async emulateMobile() {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await this.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
  }

  /** 导航并等到页面渲染完成（#main 里不再是「正在加载…」）。 */
  async goto(url) {
    this.jsErrors = [];
    this.logErrors = [];
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      let state;
      try {
        state = await this.evaluate(`(() => {
          const m = document.getElementById('main');
          if (!m) return 'no-main';
          if (m.querySelector('.loading')) return 'loading';
          return 'ready';
        })()`);
      } catch (_) { continue; }   // 导航途中执行上下文会短暂失效
      if (state === 'ready') return;
    }
    throw new Error(`页面未在 20s 内渲染完成：${url}\n       ${await this.diagnose()}`);
  }

  /** 渲染失败时尽力取回现场，好让失败信息能指向原因，而不是只说「超时」。 */
  async diagnose() {
    let s;
    try {
      s = await this.evaluate(`(() => {
        const m = document.getElementById('main');
        const res = performance.getEntriesByType('resource').map(
          (r) => r.name.replace(location.origin, '') + '(' + (r.initiatorType || '?') + ')');
        return {
          bootLoaded: typeof window.__pdaIot,
          hasSignApi: typeof window.PdaSignApi,
          mainText: m ? (m.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : '(无 #main)',
          resources: res.slice(0, 6),
        };
      })()`);
    } catch (e) {
      return `（取不到页面状态：${e.message}）`;
    }
    const lines = [
      `诊断：window.__pdaIot=${s.bootLoaded}（undefined = app.js 根本没跑起来）；` +
        `PdaSignApi=${s.hasSignApi}`,
      `      #main 内容：${JSON.stringify(s.mainText)}`,
      `      已加载资源：${s.resources.length ? s.resources.join('、') : '（一个都没有）'}`,
    ];
    if (s.bootLoaded === 'undefined' && s.resources.length === 0) {
      lines.push('       → 页面没能加载自己的静态资源。生产形态 URL 下最常见的原因是：');
      lines.push('         托管方没配 rewrite（deploy/），或 index.html 的 <base> 修正被破坏。');
    }
    return lines.join('\n       ');
  }

  /** 轮询直到选择器出现；超时抛出带诊断的异常。 */
  async waitForSelector(selector, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const ok = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
        if (ok) return true;
      } catch (_) { /* 导航/上下文切换期间忽略 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`等待选择器超时：${selector}\n       ${await this.diagnose()}`);
  }

  /** 轮询直到 #main 的可见文本包含指定子串。 */
  async waitForText(text, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const ok = await this.evaluate(`(() => {
          const m = document.getElementById('main');
          return !!m && (m.innerText || '').includes(${JSON.stringify(text)});
        })()`);
        if (ok) return true;
      } catch (_) { /* 同上 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`等待文本 ${JSON.stringify(text)} 超时\n       ${await this.diagnose()}`);
  }

  /** 轮询直到 #main 的可见文本匹配正则（正则源码字符串）。 */
  async waitForTextMatch(source, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const ok = await this.evaluate(`(() => {
          const m = document.getElementById('main');
          return !!m && new RegExp(${JSON.stringify(source)}).test(m.innerText || '');
        })()`);
        if (ok) return true;
      } catch (_) { /* 同上 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`等待文本匹配 /${source}/ 超时\n       ${await this.diagnose()}`);
  }

  /** 轮询直到控件恢复可用（验证中会禁用按钮）。 */
  async waitForEnabled(selector, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const ok = await this.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          return !!el && !el.disabled;
        })()`);
        if (ok) return true;
      } catch (_) { /* 同上 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`等待控件可用超时：${selector}\n       ${await this.diagnose()}`);
  }

  /** 填入手机号并点击「验证并查看」（输入事件也发，保持与真人操作一致）。 */
  async verifyWith(phone) {
    await this.evaluate(`(() => {
      const el = document.getElementById('phone-input');
      if (!el) throw new Error('#phone-input 不存在');
      el.value = ${JSON.stringify(phone)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('verify-btn').click();
      return true;
    })()`);
  }

  mainHTML() { return this.evaluate(`document.getElementById('main').innerHTML`); }
  mainText() {
    return this.evaluate(`document.getElementById('main').innerText.replace(/\\s+/g,' ').trim()`);
  }
  has(needle) { return this.evaluate(`document.getElementById('main').innerText.includes(${JSON.stringify(needle)})`); }
  gateErrorText() {
    return this.evaluate(`(() => {
      const el = document.getElementById('gate-error');
      return el ? el.textContent : '';
    })()`);
  }
}

// ---------------------------------------------------------------- 本地服务

function startServer(port) {
  const proc = spawn('python3', [path.join(H5_DIR, 'tools', 'serve_spa.py'), String(port), '--quiet'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本地静态服务启动超时')), 15000);
    const probe = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/index.html`, { method: 'HEAD' });
        if (r.status === 200) { clearTimeout(timer); resolve(proc); return true; }
      } catch (_) {}
      return false;
    };
    (async () => {
      for (let i = 0; i < 60; i++) {
        if (await probe()) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
  });
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const argv = process.argv.slice(2);
  const baseArg = argv.indexOf('--base');
  let base = baseArg >= 0 ? argv[baseArg + 1] : null;
  const formArg = argv.indexOf('--form');
  const formEq = argv.find((a) => a.startsWith('--form='));
  const form = formEq ? formEq.slice('--form='.length)
    : (formArg >= 0 ? argv[formArg + 1] : 'path');
  if (form !== 'path' && form !== 'query') {
    console.error(`--form 只能是 path 或 query，收到 ${JSON.stringify(form)}`);
    process.exit(2);
  }
  const isLocal = !base;
  let server = null;

  if (!base) {
    const port = await freePort();
    server = await startServer(port);
    base = `http://127.0.0.1:${port}`;
  }

  // 正式形态由 --form 指定；另一种形态用作 AC-05 的对照。
  const prodUrl = form === 'query' ? `${base}/index.html?w=` : `${base}/p/`;
  const altUrl = form === 'query' ? `${base}/p/` : `${base}/index.html?w=`;

  // ---- 数据源（明文只从 data-private/ 读，发布产物只读 data/） ----
  const publicDoc = readJSON(path.join(H5_DIR, 'data', 'public.json'));
  const sealedDoc = readJSON(path.join(H5_DIR, 'data', 'sealed.json'));
  const privateDoc = readJSON(path.join(H5_DIR, 'data-private', 'labels.json'));
  const phones = readJSON(path.join(H5_DIR, 'data-private', 'demo_phones.json'));
  const adSlots = readJSON(path.join(H5_DIR, 'data', 'adSlots.json'));
  const materials = readJSON(path.join(H5_DIR, 'data', 'materials.json'));
  const nodes = readJSON(path.join(H5_DIR, 'data', 'nodes.json'));

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

  const routeCodes = (label.f.r.c.match(/\d{6}/g) || []);
  const routeNames = routeCodes.map((c) => (nodes.nodes[c] || {}).name);
  const ad = (adSlots.slots || {})[label.f.m.a];
  const material = label.f.m.p ? (materials.materials || {})[label.f.m.p] : null;

  console.log('H5 读取页验收断言（签收认证版：AC-04 / AC-05 / AC-09）');
  console.log(`目标：${base}${isLocal ? '（本地，含 AC-09）' : '（远端，跳过 AC-09）'}`);
  console.log(`正式形态：${form === 'query' ? 'index.html?w=<运单号>' : '/p/<运单号>'}`);
  console.log(`样品运单：${W}（门禁用 W2=${W2}）\n`);

  // ============================================================ 发布产物安全断言
  console.log('--- 发布产物：无明文、无私有路径 ---');
  for (const p of ['/data/labels.json', '/data-private/labels.json', '/data-private/demo_phones.json']) {
    let status = 0;
    try { status = (await fetch(base + p, { redirect: 'manual' })).status; } catch (_) {}
    check(`GET ${p} 返回 404`, status === 404, `实际 HTTP ${status || '请求失败'}`);
  }

  const pubKeys = 'g,n,phoneMask,service,w';
  const pubShapeOk = waybills.every((w) =>
    Object.keys(publicDoc.waybills[w] || {}).sort().join(',') === pubKeys);
  check('public.json 每个运单只含 w/n/g/service/phoneMask', pubShapeOk,
    pubShapeOk ? undefined : JSON.stringify(Object.keys(publicDoc.waybills[W] || {})));

  const sealedShapeOk = Object.keys(sealedDoc.entries || {}).every((w) =>
    Object.keys(sealedDoc.entries[w] || {}).sort().join(',') === 'ciphertext,iv,salt');
  check('sealed.json 每个条目只含 salt/iv/ciphertext', sealedShapeOk);

  const allPhones = Object.values(phones);
  const publicPhoneLeaks = allPhones.filter((p) => publicRaw.includes(p));
  check('public.json 不含完整手机号', publicPhoneLeaks.length === 0);
  check('public.json 不含身份 UID',
    ![label.f.i.s, label.f.i.r].some((u) => publicRaw.includes(u)));
  check('public.json 不含 6 位路由码',
    !routeCodes.some((c) => publicRaw.includes(c)));
  check('sealed.json 不含完整手机号',
    !allPhones.some((p) => sealedRaw.includes(p)));
  check('embedded.js 不含明文 labels 键', !/"labels"\s*:/.test(embeddedRaw));
  check('embedded.js 不含完整手机号', !allPhones.some((p) => embeddedRaw.includes(p)));

  const browser = await Browser.launch();

  try {
    // ============================================================ AC-04
    console.log('\n--- AC-04：碰标签打开，未验证只看浅信息（生产形态 URL）---');

    const prodPath = form === 'query' ? `/index.html?w=${W}` : `/p/${W}`;
    const prodUrlW = prodUrl + W;
    const r = await fetch(prodUrlW, { redirect: 'manual' });
    check(`GET ${prodPath} 返回 200`, r.status === 200,
      form === 'query'
        ? `实际 HTTP ${r.status} —— 静态托管应能直接返回 index.html`
        : `实际 HTTP ${r.status} —— 托管方没配 SPA 回退，见 deploy/`);

    const page = await browser.newPage();
    await page.emulateMobile();
    try {
      await page.goto(prodUrlW);
    } catch (e) {
      check(`页面在 ${prodPath} 下渲染完成`, false, e.message);
      throw new Error('__RENDER_FAILED__');
    }

    const gateReady = await page.waitForSelector('#phone-input', 15000).then(() => true).catch(() => false);
    check('未验证页面渲染手机号门禁（#phone-input）', gateReady,
      gateReady ? undefined : '15s 内未出现门禁输入框');
    if (!gateReady) throw new Error('__RENDER_FAILED__');

    check('页面未停在「正在加载…」', !(await page.has('正在加载')));
    check('页面未给出错误提示', !(await page.has('暂时无法展示')) && !(await page.has('无法展示此标签')));
    check('常驻演示横幅文案',
      await page.has('演示环境：详情为加密演示数据；签收记录仅保存在本机，不具备法律效力。'));

    // 浅信息
    check(`展示运单号 ${W}`, await page.has(W));
    check(`展示物品名「${label.f.l.n}」`, await page.has(label.f.l.n));
    check(`展示重量「${label.f.l.g}」`, await page.has(label.f.l.g));
    check(`展示服务「${publicDoc.waybills[W].service}」`,
      await page.has(publicDoc.waybills[W].service));
    check(`展示脱敏手机号 ${mask}`, await page.has(mask));

    // 详情不得出现在 locked DOM 里（包括隐藏节点）
    const lockedHTML = await page.mainHTML();
    check(`不展示第一个路由节点名「${routeNames[0] || '(无)'}」`,
      !(await page.has(routeNames[0] || '__none__')));
    check('不展示任何路由节点名', !(await Promise.all(routeNames.filter(Boolean).map((n) => page.has(n)))).some(Boolean));
    check('不展示寄件人 UID', !lockedHTML.includes(label.f.i.s));
    check('不展示收件人 UID', !lockedHTML.includes(label.f.i.r));
    check(`不展示广告标题「${ad ? ad.title : '(无)'}」`, !(await page.has(ad ? ad.title : '__none__')));
    if (material) check(`不展示素材 caption「${material.caption}」`, !(await page.has(material.caption)));
    check('不展示留痕时间', !(await page.has(label.o.ts)));
    check('锁定视图 HTML 不含完整手机号', !/1[3-9]\d{9}/.test(lockedHTML),
      (lockedHTML.match(/1[3-9]\d{9}/) || [])[0]);

    // 门禁控件属性
    const inputAttrs = await page.evaluate(`(() => {
      const el = document.getElementById('phone-input');
      const err = document.getElementById('gate-error');
      return {
        type: el && el.getAttribute('type'),
        inputmode: el && el.getAttribute('inputmode'),
        autocomplete: el && el.getAttribute('autocomplete'),
        spellcheck: el && el.getAttribute('spellcheck'),
        ariaLive: err && err.getAttribute('aria-live'),
      };
    })()`);
    check('#phone-input 使用 text 且移动键盘/不自动补全',
      inputAttrs.type === 'text' && inputAttrs.inputmode === 'numeric' &&
      inputAttrs.autocomplete === 'off' && inputAttrs.spellcheck === 'false',
      JSON.stringify(inputAttrs));
    check('#gate-error 使用 aria-live="polite"', inputAttrs.ariaLive === 'polite');
    check('展示隐私说明', await page.has('手机号仅用于本机解密，不上传、不保存'));

    // 错误手机号：统一提示、不泄露号码、剩余次数递减
    await page.verifyWith(wrong);
    await page.waitForText('不匹配');
    const errText = await page.gateErrorText();
    check('错误手机号给出统一提示', errText.includes('手机号与运单信息不匹配'),
      JSON.stringify(errText));
    check('错误提示包含剩余次数', /剩余\s*4\s*次/.test(errText), JSON.stringify(errText));
    check('错误提示不含完整手机号', !errText.includes(phone) && !errText.includes(wrong),
      JSON.stringify(errText));

    // 锁定 UI：换 W2，连续 5 次错误，不影响 W
    const pageLock = await browser.newPage();
    await pageLock.emulateMobile();
    await pageLock.goto(prodUrl + W2);
    await pageLock.waitForSelector('#phone-input');
    for (let i = 0; i < 5; i++) {
      await pageLock.verifyWith(wrong2);
      if (i < 4) await pageLock.waitForEnabled('#verify-btn');
    }
    await pageLock.waitForTextMatch('\\d{1,2}:\\d{2}');
    const lockText = await pageLock.evaluate(`(() => {
      const el = document.getElementById('lockout');
      return el ? el.textContent : '';
    })()`);
    check('连续 5 次失败后出现锁定倒计时', /\d{1,2}:\d{2}/.test(lockText), JSON.stringify(lockText));
    const lockedInput = await pageLock.evaluate(
      `document.getElementById('phone-input').disabled`);
    check('锁定后输入框禁用', lockedInput === true);

    // 正确手机号：清空输入、展示完整详情
    await page.verifyWith(phone);
    await page.waitForSelector('.verified-badge');
    check('验证成功后展示「已验证」标识', await page.has('已验证'));

    const htmlUnlocked = await page.mainHTML();
    const missingNodes = [];
    for (let i = 0; i < routeCodes.length; i++) {
      if (routeNames[i] && !(await page.has(routeNames[i]))) missingNodes.push(`${routeCodes[i]} ${routeNames[i]}`);
    }
    check(`展示全部 ${routeCodes.length} 个路由节点名`, missingNodes.length === 0,
      missingNodes.length ? `未出现：${missingNodes.join('、')}` : undefined);
    check('展示寄件人脱敏 UID', htmlUnlocked.includes(label.f.i.s));
    check('展示收件人脱敏 UID', htmlUnlocked.includes(label.f.i.r));
    check(`展示广告位 ${label.f.m.a} 的文案（来自素材表）`, ad ? await page.has(ad.title) : false,
      ad ? undefined : `素材表里没有 ${label.f.m.a}`);

    // 广告落地页：页面上有「了解详情 →」不等于链接点得开。landingUrl 若仍指向
    // example.com 占位，页面渲染完全正常，只有真正点进去才会 404 —— 所以这里把
    // 链接取出来发一次真实请求，并打开它确认落地页真的渲染出了这条广告。
    const adHref = await page.evaluate(`(() => {
      const el = document.querySelector('.ad-link');
      return el ? el.href : null;
    })()`);
    check(`广告位 ${label.f.m.a} 有落地页链接`, !!adHref,
      adHref ? undefined : '页面里没有 .ad-link');
    if (adHref) {
      let adStatus = 0;
      try {
        adStatus = (await fetch(adHref, { signal: AbortSignal.timeout(5000) })).status;
      } catch (_) { /* 请求失败按 0 记，下面报 FAIL */ }
      check(`广告落地页返回 200（${adHref}）`, adStatus === 200,
        `实际 HTTP ${adStatus || '请求失败'}`);
      if (adStatus === 200 && ad) {
        const adPage = await browser.newPage();
        await adPage.emulateMobile();
        await adPage.goto(adHref);
        check(`广告落地页展示「${ad.title}」`, await adPage.has(ad.title));
      }
    }

    if (material) {
      check(`展示验货素材 ${label.f.m.p} 的说明`, await page.has(material.caption));
      if (material.type === 'photo') {
        let img = null;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          img = await page.evaluate(`(() => {
            const el = document.querySelector('.material img');
            return el ? { src: el.currentSrc || el.src, complete: el.complete, w: el.naturalWidth } : null;
          })()`);
          if (img && img.complete) break;
          await new Promise((res) => setTimeout(res, 100));
        }
        check(`验货图 ${label.f.m.p} 实际加载成功`, !!img && img.complete && img.w > 0,
          img ? `src=${img.src} naturalWidth=${img.w}` : '页面里没有 .material img');
      }
    }
    check('展示留痕：最后触碰时间', await page.has(label.o.ts));
    check('展示留痕：累计触碰次数', await page.has(String(label.o.tcn)));
    check('展示留痕：写入设备 UID', await page.has(label.o.d));
    check('解锁后页面不含明文手机号（输入框已清空）', !/1[3-9]\d{9}/.test(
      await page.mainHTML() + await page.evaluate(`(document.getElementById('phone-input') || {}).value || ''`)));
    check('验证成功后输入框已清空', await page.evaluate(
      `(() => { const el = document.getElementById('phone-input'); return el ? el.value === '' : true; })()`));

    check('无未捕获的 JS 异常', page.jsErrors.length === 0,
      page.jsErrors.length ? page.jsErrors.join('\n       ') : undefined);
    const nonNetwork = page.logErrors.filter((e) => !/^network:/.test(e));
    check('无页面级错误日志（网络类除外）', nonNetwork.length === 0,
      nonNetwork.length ? nonNetwork.join('\n       ') : undefined);

    // ============================================================ AC-05
    console.log(`\n--- AC-05：另一种形态（${form === 'query' ? '/p/' : '?w='}）打开同一页，内容一致 ---`);
    const page2 = await browser.newPage();
    await page2.emulateMobile();

    if (form === 'query') {
      const alt = await fetch(`${altUrl}${W}`, { redirect: 'manual' });
      if (alt.status === 200) {
        check(`GET /p/${W} 返回 200`, true);
      } else {
        skip(`GET /p/${W} 返回 200`, `实际 HTTP ${alt.status} —— 静态托管无 rewrite；` +
          '下方用真浏览器验证 404.html 的前端跳转');
      }
    }

    await page2.goto(`${altUrl}${W}`);
    await page2.waitForSelector('#phone-input');
    check('对照形态同样先显示浅信息', await page2.has(W) &&
      !(await page2.has(routeNames[0] || '__none__')));
    await page2.verifyWith(phone);
    await page2.waitForSelector('.verified-badge');

    const htmlP = htmlUnlocked;
    const htmlQ = await page2.mainHTML();
    check('两条 URL 解锁后的 #main 内容逐字节一致', htmlP === htmlQ,
      htmlP === htmlQ ? undefined
        : `长度 ${htmlP.length} vs ${htmlQ.length}；首个差异位置 ${firstDiff(htmlP, htmlQ)}`);

    // ============================================================ 未知运单
    console.log('\n--- 未知运单：可读提示且不泄露详情 ---');
    const pageMiss = await browser.newPage();
    await pageMiss.emulateMobile();
    await pageMiss.goto(`${prodUrl}999999999999`);
    await pageMiss.waitForText('未找到运单');
    const missHTML = await pageMiss.mainHTML();
    check('未知运单出现「未找到运单」', await pageMiss.has('未找到运单'));
    check('未知运单页不含路由节点名', !(await Promise.all(routeNames.filter(Boolean).map(
      (n) => pageMiss.has(n)))).some(Boolean));
    check('未知运单页不含身份 UID',
      !missHTML.includes(label.f.i.s) && !missHTML.includes(label.f.i.r));

    // ============================================================ AC-09
    console.log('\n--- AC-09：改素材表文案，刷新即变，标签/产物不需重写 ---');

    if (!isLocal) {
      skip('AC-09', '会改动素材表文件，只对本地目标执行');
    } else {
      const adSlotsPath = path.join(H5_DIR, 'data', 'adSlots.json');
      const sealedPath = path.join(H5_DIR, 'data', 'sealed.json');
      const publicPath = path.join(H5_DIR, 'data', 'public.json');
      const privatePath = path.join(H5_DIR, 'data-private', 'labels.json');

      const sealedBefore = fs.readFileSync(sealedPath);
      const publicBefore = fs.readFileSync(publicPath);
      const pointerBefore = label.f.m.a;
      const marker = `【AC-09 临时文案 ${crypto.randomBytes(3).toString('hex')}】`;
      const oldTitle = (adSlots.slots[pointerBefore] || {}).title;

      check('改前：页面展示素材表里的原文案 A', await page.has(oldTitle));
      check('临时文案不存在于内嵌兜底副本中（确保验的是 data/ 实时读取）',
        !embeddedRaw.includes(marker));

      const original = fs.readFileSync(adSlotsPath);
      try {
        const patched = JSON.parse(original.toString('utf8'));
        patched.slots[pointerBefore].title = marker;
        fs.writeFileSync(adSlotsPath, JSON.stringify(patched, null, 2) + '\n');

        // 新开一个标签页 = 全新加载，不复用任何缓存
        const page3 = await browser.newPage();
        await page3.emulateMobile();
        await page3.goto(prodUrlW);
        await page3.waitForSelector('#phone-input');
        await page3.verifyWith(phone);
        await page3.waitForSelector('.verified-badge');

        check('改后：重新验证即出现新文案 B', await page3.has(marker));
        check('改后：旧文案不再出现', !(await page3.has(oldTitle)));

        const sealedAfter = fs.readFileSync(sealedPath);
        const publicAfter = fs.readFileSync(publicPath);
        check('AC-09 未改动 sealed.json（字节一致）',
          sameBytes(sealedBefore, sealedAfter),
          `改前 ${sha256(sealedBefore).slice(0, 12)}… 改后 ${sha256(sealedAfter).slice(0, 12)}…`);
        check('AC-09 未改动 public.json（字节一致）',
          sameBytes(publicBefore, publicAfter),
          `改前 ${sha256(publicBefore).slice(0, 12)}… 改后 ${sha256(publicAfter).slice(0, 12)}…`);
        check('标签内的广告指针未变', readJSON(privatePath).labels[W].f.m.a === pointerBefore);
        check('新文案没有渗进 sealed.json', !sealedAfter.toString('utf8').includes(marker));
        check('新文案没有渗进 public.json', !publicAfter.toString('utf8').includes(marker));
      } finally {
        fs.writeFileSync(adSlotsPath, original);
        check('素材表已还原', sha256(fs.readFileSync(adSlotsPath)) === sha256(original));
      }
    }

    // ============================================================ AC-04-S
    // 放在 AC-09 之后：AC-05 的字节对比与 AC-09 都发生在 W 仍未签收时。
    console.log('\n--- AC-04-S：手机号验证后签收与本机留痕 ---');
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
  } finally {
    await browser.close();
    if (server) server.kill('SIGTERM');
  }

  console.log('');
  if (fail) { console.log(`结论：${fail} 项失败。`); process.exit(1); }
  console.log(`结论：全部通过${skipped ? `（${skipped} 项跳过）` : ''}。`);
  process.exit(0);
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

main().catch((e) => {
  if (e.message === '__RENDER_FAILED__') {
    console.log('\n结论：页面渲染失败，后续断言已中止。');
    process.exit(1);
  }
  console.error('\n验收脚本自身出错：', e.message);
  process.exit(2);
});
