#!/usr/bin/env node
/* H5 读取页验收断言 —— AC-04 / AC-05 / AC-09。
 *
 * 为什么需要这个脚本：
 *
 *   1. `tests/run_tests.js` 跑的是**纯函数**，够不到「页面到底渲染出来没有」。
 *      指针降级逻辑全绿，不等于 `/p/<运单号>` 打得开。
 *   2. AC-04 判的是「手机不装 App，碰标签打开 H5 并完整展示」，它依赖**生产形态的
 *      URL**。形态由托管的回退能力决定：`--form=path`（默认）用 `/p/<运单号>`，需要
 *      SPA 回退；`--form=query` 用 `/index.html?w=<运单号>`，纯静态托管（GitHub Pages
 *      等）也能直接打开。纯函数单测完全碰不到这两条路径 —— 本地一度用
 *      `python3 -m http.server`，`/p/` 那条 URL 直接 404，等于 AC-04 从来没被验过。
 *   3. AC-09（改素材表文案不重写标签）此前**没有任何自动化断言**，只靠人点。
 *
 * 所以这里用**真浏览器**（headless Chrome）+ **真 HTTP**跑一遍，并把 AC-09 做成
 * 字节级断言：改文案后页面内容必须变，而 labels.json 与标签内的指针必须**一个字节
 * 都不变**。
 *
 * 零依赖：Chrome 走 CDP（--remote-debugging-port），Node 22 自带 WebSocket 与 fetch，
 * 不需要 npm install。需求 §5.2 刻意不加构建链，验收侧同样不加。
 *
 * 用法：
 *   node reader-h5/tests/acceptance.js                    # 自己起服务，全跑（含 AC-09）
 *   node reader-h5/tests/acceptance.js --base https://<域名>   # 打线上，只跑 AC-04/05
 *   node reader-h5/tests/acceptance.js --base https://<域名> --form=query
 *                                                          # 线上正式形态是 ?w= 时用
 */
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const H5_DIR = path.resolve(__dirname, '..');
const REPO = path.resolve(H5_DIR, '..');
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
          mainText: m ? (m.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 100) : '(无 #main)',
          resources: res.slice(0, 6),
        };
      })()`);
    } catch (e) {
      return `（取不到页面状态：${e.message}）`;
    }
    const lines = [
      `诊断：window.__pdaIot=${s.bootLoaded}（undefined = app.js 根本没跑起来）`,
      `      #main 内容：${JSON.stringify(s.mainText)}`,
      `      已加载资源：${s.resources.length ? s.resources.join('、') : '（一个都没有）'}`,
    ];
    if (s.bootLoaded === 'undefined' && s.resources.length === 0) {
      lines.push('       → 页面没能加载自己的静态资源。生产形态 URL 下最常见的原因是：');
      lines.push('         托管方没配 rewrite（deploy/），或 index.html 的 <base> 修正被破坏。');
    }
    return lines.join('\n       ');
  }

  mainHTML() { return this.evaluate(`document.getElementById('main').innerHTML`); }
  mainText() {
    return this.evaluate(`document.getElementById('main').innerText.replace(/\\s+/g,' ').trim()`);
  }
  has(needle) { return this.evaluate(`document.getElementById('main').innerText.includes(${JSON.stringify(needle)})`); }
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

  const labelsDoc = readJSON(path.join(H5_DIR, 'data', 'labels.json'));
  const adSlots = readJSON(path.join(H5_DIR, 'data', 'adSlots.json'));
  const materials = readJSON(path.join(H5_DIR, 'data', 'materials.json'));
  const nodes = readJSON(path.join(H5_DIR, 'data', 'nodes.json'));
  const embeddedRaw = fs.readFileSync(path.join(H5_DIR, 'data', 'embedded.js'), 'utf8');
  const waybills = labelsDoc.meta.waybills;
  const W = waybills[0];
  const label = labelsDoc.labels[W];

  console.log('H5 读取页验收断言（AC-04 / AC-05 / AC-09）');
  console.log(`目标：${base}${isLocal ? '（本地，含 AC-09）' : '（远端，跳过 AC-09）'}`);
  console.log(`正式形态：${form === 'query' ? 'index.html?w=<运单号>' : '/p/<运单号>'}`);
  console.log(`样品运单：${W}\n`);

  const browser = await Browser.launch();

  try {
    // ============================================================ AC-04
    console.log('--- AC-04：手机不装 App，碰标签打开 H5 并完整展示（生产形态 URL）---');

    const prodPath = form === 'query' ? `/index.html?w=${W}` : `/p/${W}`;
    const prodUrlW = prodUrl + W;
    const r = await fetch(prodUrlW, { redirect: 'manual' });
    check(`GET ${prodPath} 返回 200`, r.status === 200,
      form === 'query'
        ? `实际 HTTP ${r.status} —— 静态托管应能直接返回 index.html`
        : `实际 HTTP ${r.status} —— 托管方没配 SPA 回退，见 reader-h5/deploy/`);

    const page = await browser.newPage();
    await page.emulateMobile();
    try {
      await page.goto(prodUrlW);
    } catch (e) {
      // 渲染不出来时后面每条断言都无从谈起 —— 报一条 FAIL 就收，别刷一屏噪音
      check(`页面在 ${prodPath} 下渲染完成`, false, e.message);
      throw new Error('__RENDER_FAILED__');
    }

    check('页面未停在「正在加载…」', !(await page.has('正在加载')));
    check('页面未给出错误提示', !(await page.has('暂时无法展示')) && !(await page.has('无法展示此标签')));

    // 「完整展示」逐项对：运单号 / 物品 / 每个路由节点 / 双 UID / 广告 / 留痕
    check(`展示运单号 ${W}`, await page.has(W));
    check(`展示物品名「${label.f.l.n}」`, await page.has(label.f.l.n));

    const routeCodes = label.f.r.c.match(/\d{6}/g);
    const routeNames = routeCodes.map((c) => (nodes.nodes[c] || {}).name);
    const missingNodes = [];
    for (let i = 0; i < routeNames.length; i++) {
      if (routeNames[i] && !(await page.has(routeNames[i]))) missingNodes.push(`${routeCodes[i]} ${routeNames[i]}`);
    }
    check(`展示全部 ${routeCodes.length} 个路由节点名`, missingNodes.length === 0,
      missingNodes.length ? `未出现：${missingNodes.join('、')}` : undefined);

    const html = await page.mainHTML();
    check('展示寄件人脱敏 UID', html.includes(label.f.i.s));
    check('展示收件人脱敏 UID', html.includes(label.f.i.r));

    const ad = (adSlots.slots || {})[label.f.m.a];
    check(`展示广告位 ${label.f.m.a} 的文案（来自素材表）`, ad ? await page.has(ad.title) : false,
      ad ? undefined : `素材表里没有 ${label.f.m.a}`);

    if (label.f.m.p) {
      const mat = (materials.materials || {})[label.f.m.p];
      check(`展示验货素材 ${label.f.m.p} 的说明`, mat ? await page.has(mat.caption) : false);
    }

    check('展示留痕：最后触碰时间', await page.has(label.o.ts));
    check('展示留痕：累计触碰次数', await page.has(String(label.o.tcn)));
    check('展示留痕：写入设备 UID', await page.has(label.o.d));

    // 隐私红线：脱敏 UID 之外不得出现明文手机号
    const plainPhone = html.match(/1[3-9]\d{9}/);
    check('页面不含明文手机号（BR-03）', !plainPhone,
      plainPhone ? `命中：${plainPhone[0]}` : undefined);

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
      // GitHub Pages 无法对 /p/* 返回 200：命中 404.html 后在浏览器里跳转到 ?w=。
      // HTTP 状态是 404 属于预期，真正要验的是「浏览器能落到同一个页面」。
      const alt = await fetch(`${altUrl}${W}`, { redirect: 'manual' });
      if (alt.status === 200) {
        check(`GET /p/${W} 返回 200`, true);
      } else {
        skip(`GET /p/${W} 返回 200`, `实际 HTTP ${alt.status} —— 静态托管无 rewrite；` +
          '下方用真浏览器验证 404.html 的前端跳转');
      }
    }

    await page2.goto(`${altUrl}${W}`);

    const href = routeNames.filter(Boolean);
    check('兜底页也完整渲染', href.length === 0 || (await page2.has(href[0])));

    const htmlP = await page.mainHTML();
    const htmlQ = await page2.mainHTML();
    check('两条 URL 的 #main 内容逐字节一致', htmlP === htmlQ,
      htmlP === htmlQ ? undefined
        : `长度 ${htmlP.length} vs ${htmlQ.length}；首个差异位置 ${firstDiff(htmlP, htmlQ)}`);

    // ============================================================ AC-09
    console.log('\n--- AC-09：改素材表文案，刷新即变，标签不需重写 ---');

    if (!isLocal) {
      skip('AC-09', '会改动素材表文件，只对本地目标执行（见 reader-h5/deploy/README.md）');
    } else {
      const adSlotsPath = path.join(H5_DIR, 'data', 'adSlots.json');
      const labelsPath = path.join(H5_DIR, 'data', 'labels.json');
      const labelsBefore = fs.readFileSync(labelsPath);
      const pointerBefore = label.f.m.a;
      const marker = `【AC-09 临时文案 ${crypto.randomBytes(3).toString('hex')}】`;
      const oldTitle = (adSlots.slots[pointerBefore] || {}).title;

      check('改前：页面展示素材表里的原文案', await page.has(oldTitle));
      check('马甲不存在于内嵌兜底副本中（确保验的是 data/ 实时读取）', !embeddedRaw.includes(marker));

      const original = fs.readFileSync(adSlotsPath);
      try {
        const patched = JSON.parse(original.toString('utf8'));
        patched.slots[pointerBefore].title = marker;
        fs.writeFileSync(adSlotsPath, JSON.stringify(patched, null, 2) + '\n');

        // 新开一个标签页 = 全新加载，不复用任何缓存
        const page3 = await browser.newPage();
        await page3.emulateMobile();
        await page3.goto(prodUrlW);

        check('改后：刷新页面即出现新文案', await page3.has(marker));
        check('改后：旧文案不再出现', !(await page3.has(oldTitle)));

        const labelsAfter = fs.readFileSync(labelsPath);
        check('labels.json 未被改动（标签不需重写）',
          sha256(labelsBefore) === sha256(labelsAfter),
          `改前 ${sha256(labelsBefore).slice(0, 12)}… 改后 ${sha256(labelsAfter).slice(0, 12)}…`);
        check('标签内的广告指针未变', readJSON(labelsPath).labels[W].f.m.a === pointerBefore);
        check('新文案没有渗进 labels.json（文案只活在素材表里）',
          !labelsAfter.toString('utf8').includes(marker));
      } finally {
        fs.writeFileSync(adSlotsPath, original);
        check('素材表已还原', sha256(fs.readFileSync(adSlotsPath)) === sha256(original));
      }
    }
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
