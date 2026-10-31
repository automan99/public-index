/* 快件溯源 H5 —— 读取端参考实现（契约 v2）
 *
 * 职责边界（见 shared/README.md §五「读取端」）：
 *   · 按 MIME 过滤 NDEF 记录 —— 由原生 App / 系统负责，H5 拿到的已经是载荷本体；
 *   · 校验载荷，失败或版本未知时给出提示，**不得崩溃**；
 *   · 由 f.r.c 每 6 位切分还原节点列表（routeNodes 不在标签里）；
 *   · 用 adSlots.json / materials.json / nodes.json 解析指针，**查不到时降级为占位文案**。
 *
 * 读取端**不实现** UID 算法（只展示），也**不识别**标签批次（载荷里没有批次，INV-6）。
 */
(function () {
  'use strict';

  var SUPPORTED_V = '2';
  var LABEL_TYPE = 'pda-iot-label';

  // ============================================================
  // 一、数据加载
  //
  // 素材表（adSlots / materials / nodes）**每次打开页面都重新读取**，不与标签绑定：
  // 换广告文案、改节点名，标签一个字节都不用动，页面内容随之变化（AC-09 / D8）。
  // ============================================================

  function loadJSON(file, embeddedKey) {
    return fetch('data/' + file, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function () {
        // file:// 直接打开时 fetch 会被浏览器拦下；回退到 build_data.py 生成的内嵌副本。
        var embedded = (window.__PDA_IOT_DATA__ || {})[embeddedKey];
        if (embedded) return embedded;
        throw new Error('无法加载 data/' + file +
          '（请用 reader-h5/serve.sh 启动本地静态服务，而不是直接双击打开）');
      });
  }

  // ============================================================
  // 二、载荷校验（对应 label.schema.json + INV-1~6）
  // ============================================================

  function validate(label) {
    var errors = [], warnings = [];

    if (!label || typeof label !== 'object' || Array.isArray(label)) {
      return { errors: ['标签内容不是有效的 JSON 对象'], warnings: warnings };
    }
    if (label.t !== LABEL_TYPE) {
      return { errors: ['这不是本系统的快件标签（类型标识为 ' + JSON.stringify(label.t) + '）'], warnings: warnings };
    }
    if (label.v !== SUPPORTED_V) {
      // 版本不识别只提示升级，不当作损坏 —— 契约必须能向前演进（BR-05）
      return { errors: ['标签契约版本为 ' + JSON.stringify(label.v) + '，本页只支持 v' + SUPPORTED_V + '。请更新读取端。'], warnings: warnings };
    }

    var f = label.f || {}, o = label.o || {};

    function need(obj, key, path) {
      var v = obj[key];
      if (typeof v !== 'string' || v === '') { errors.push('缺少必填字段 ' + path); return ''; }
      return v;
    }

    var l = f.l || {}, r = f.r || {}, i = f.i || {}, m = f.m || {};
    need(l, 'w', 'f.l.w（运单号）');
    need(l, 'n', 'f.l.n（物品名）');
    need(l, 'g', 'f.l.g（重量）');

    // INV-1：全路由编码必须是 6 位一段的数字串，且能无损切分还原节点
    var code = r.c;
    if (typeof code !== 'string' || !/^([0-9]{6})+$/.test(code) || code.length < 6 || code.length > 60) {
      errors.push('f.r.c 全路由编码不合法（应为 6~60 位、6 的倍数的数字串）：' + JSON.stringify(code));
    }

    // INV-2：UID 必须是 16 位小写 hex —— 出现明文手机号即是隐私红线（BR-03）
    ['s', 'r'].forEach(function (who) {
      var v = i[who];
      if (typeof v !== 'string' || !/^[0-9a-f]{16}$/.test(v)) {
        errors.push('f.i.' + who + ' 不是 16 位小写 hex：' + JSON.stringify(v));
      }
    });

    need(m, 'a', 'f.m.a（广告位指针）');

    need(o, 'ts', 'o.ts（最后触碰时间）');
    if (typeof o.tcn !== 'number' || !(o.tcn >= 1 && o.tcn <= 99999)) {
      errors.push('o.tcn 累计触碰次数不合法：' + JSON.stringify(o.tcn));
    }
    need(o, 'd', 'o.d（写入设备 UID）');

    // INV-5 / INV-6 / INV-4 是跨字段约束，JSON Schema 拦不住，这里兜底扫一遍。
    // 读取端把这些当**告警**而非错误：标签已经写好了，展示能力不应因数据瑕疵而中断。
    (function scan(node, path) {
      if (node === null || node === '') {
        warnings.push('INV-5 空值不应落标签：' + path);
        return;
      }
      if (Array.isArray(node)) { node.forEach(function (v, n) { scan(v, path + '[' + n + ']'); }); return; }
      if (typeof node !== 'object') return;
      if (Object.keys(node).length === 0) { warnings.push('INV-5 空对象不应落标签：' + path); return; }
      Object.keys(node).forEach(function (k) {
        if (/^(dev|devmode|isdev|testmode|istest|batch|lock|locked|lockbytes)$/i.test(k)) {
          warnings.push('INV-6 载荷出现写入端策略标记：' + path + '.' + k);
        }
        if (/phone/i.test(k) && path.charAt(0) === 'f') {
          warnings.push('INV-4 固化区出现手机号字段：' + path + '.' + k);
        }
        scan(node[k], path + '.' + k);
      });
    })(label, '$');

    return { errors: errors, warnings: warnings };
  }

  // ============================================================
  // 三、指针解析（查不到必须降级为占位文案，不得留空或报错）
  // ============================================================

  function resolveAd(id, table) {
    var slot = ((table || {}).slots || {})[id];
    if (!slot) return { found: false, placeholder: '广告位 ' + id };
    return { found: true, title: slot.title, body: slot.body, landingUrl: slot.landingUrl };
  }

  function resolveMaterial(id, table) {
    var mat = ((table || {}).materials || {})[id];
    if (!mat) return { found: false, placeholder: '验货素材 ' + id };
    return { found: true, type: mat.type, url: mat.url, caption: mat.caption };
  }

  // 由全路由编码还原节点列表（routeNodes 已不在标签里，读取端自己推）
  function routeNodesOf(code) {
    var out = [];
    for (var n = 0; n < code.length; n += 6) out.push(code.substr(n, 6));
    return out;
  }

  function resolveNode(code, table) {
    var node = ((table || {}).nodes || {})[code];
    if (!node) return { found: false, name: '节点 ' + code, short: code };
    return { found: true, name: node.name, short: node.short, role: node.role };
  }

  // ============================================================
  // 四、渲染
  // ============================================================

  // 标签内容属于**不可信输入**（任何 NFC 工具都能写一张标签），一律转义后再进 DOM。
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function card(title, inner) {
    return '<section class="card">' +
      (title ? '<h2 class="card-title">' + esc(title) + '</h2>' : '') + inner + '</section>';
  }

  function kv(k, v) {
    return '<div class="kv"><span class="kv-k">' + esc(k) + '</span><span class="kv-v">' + v + '</span></div>';
  }

  function renderHero(label) {
    var l = label.f.l, cd = label.f.m.cd;
    var svc = cd && cd.service ? '<span class="tagline">' + esc(cd.service) + '</span>' : '';
    var inner = '<p class="hero-no">' + esc(l.w) + '</p>' +
      '<p class="hero-no-label">运单号</p>' +
      kv('物品', esc(l.n) + ' ' + svc) +
      kv('重量', esc(l.g));
    if (cd) {
      inner += Object.keys(cd).filter(function (k) { return k !== 'service'; })
        .map(function (k) { return kv(k === 'remark' ? '备注' : k, esc(cd[k])); }).join('');
    }
    return card(null, '<div class="hero">' + inner + '</div>');
  }

  function renderRoute(label, nodeTable) {
    var nodes = routeNodesOf(label.f.r.c);
    var items = nodes.map(function (code, idx) {
      var nd = resolveNode(code, nodeTable);
      var cls = idx === 0 ? 'is-first' : (idx === nodes.length - 1 ? 'is-last' : '');
      var role = nd.role ? '<span class="role">' + esc(nd.role) + '</span>' : '';
      return '<li class="' + cls + '"><span class="dot"></span><div class="route-body">' +
        '<div class="route-name">' + esc(nd.name) + role + '</div>' +
        '<div class="route-code">' + esc(code) + '</div></div></li>';
    }).join('');

    // 临时路由 tr 在非固化区，与规划的固化路由不同 —— 出现时必须显著区分
    var tr = label.o.tr
      ? '<div class="alert"><b>路由已临时变更</b>　' + esc(label.o.tr) + '</div>'
      : '';

    return card('路由进度', '<ul class="route">' + items + '</ul>' + tr +
      '<p class="route-note">共 ' + nodes.length + ' 个节点，由全路由编码每 6 位切分还原。' +
      '本页展示的是标签内**规划的完整路由**；「当前到达哪一个节点」需二期字段支持。</p>');
  }

  function renderIdentity(label) {
    return card('身份特征码',
      kv('寄件人', '<span class="uid">' + esc(label.f.i.s) + '</span>') +
      kv('收件人', '<span class="uid">' + esc(label.f.i.r) + '</span>') +
      '<p class="privacy-note">以上为**脱敏哈希 UID**，标签内不含任何明文手机号。' +
      '读取端不做反查——身份证特征码的转换与反查只在写入端与二期反查端实现。</p>');
  }

  function renderAd(label, adTable) {
    var ad = resolveAd(label.f.m.a, adTable);
    if (!ad.found) {
      return card('广告位', '<div class="ad ad-missing">' +
        '<div class="ad-title">' + esc(ad.placeholder) + '</div>' +
        '<div class="ad-body">素材表中暂无此广告位文案，已降级为占位显示。</div></div>');
    }
    var link = ad.landingUrl
      ? '<a class="ad-link" href="' + esc(ad.landingUrl) + '" rel="noopener noreferrer">了解详情 →</a>' : '';
    return card('广告位', '<div class="ad"><div class="ad-title">' + esc(ad.title) + '</div>' +
      '<div class="ad-body">' + esc(ad.body) + '</div>' + link + '</div>' +
      '<p class="route-note">广告文案来自素材表，标签里只存指针 <code>' + esc(label.f.m.a) +
      '</code>——换广告不用重写标签。</p>');
  }

  function renderMaterial(label, matTable) {
    if (!label.f.m.p) return '';
    var mat = resolveMaterial(label.f.m.p, matTable);
    if (!mat.found) {
      return card('验货素材', '<div class="ad ad-missing">' +
        '<div class="ad-title">验货素材 ' + esc(label.f.m.p) + '</div>' +
        '<div class="ad-body">素材表中暂无此素材，已降级为占位显示。</div></div>');
    }
    var body = mat.type === 'photo'
      ? '<figure class="material" style="margin:0"><img src="' + esc(mat.url) + '" alt="' + esc(mat.caption || '验货图') + '">' +
        (mat.caption ? '<figcaption>' + esc(mat.caption) + '</figcaption>' : '') + '</figure>'
      : '<div class="ad-body">' + esc(mat.caption || '') + '</div>';
    return card('验货素材', body +
      '<p class="route-note">标签里只存指针 <code>' + esc(label.f.m.p) + '</code>（6 B）；' +
      'v0.4 曾把 71 B 的图片 URL 直接写进标签。</p>');
  }

  function renderStamp(label) {
    var o = label.o;
    return card('留痕',
      '<div class="stamp"><span class="stamp-k">最后触碰</span><span class="stamp-v">' + esc(o.ts) + '</span></div>' +
      '<div class="stamp"><span class="stamp-k">累计触碰</span><span class="stamp-v">' + esc(o.tcn) + ' 次</span></div>' +
      '<div class="stamp"><span class="stamp-k">写入设备</span><span class="stamp-v">' + esc(o.d) + '</span></div>' +
      '<p class="privacy-note">以上位于**非固化区**，每次触碰覆盖写入；固化区写入后不变。</p>');
  }

  function renderWarnings(warnings) {
    if (!warnings.length) return '';
    var shown = warnings.slice(0, 6).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');
    var more = warnings.length > 6 ? '<li>…另有 ' + (warnings.length - 6) + ' 条</li>' : '';
    return '<div class="notice notice-warn"><h2>数据质量告警（不影响展示）</h2>' +
      '<p>标签已写入，以下问题属于写入端应当拦下的情形：</p><ul>' + shown + more + '</ul></div>';
  }

  function renderNotice(kind, title, body) {
    return '<div class="notice notice-' + kind + '"><h2>' + esc(title) + '</h2><p>' + body + '</p></div>';
  }

  // ============================================================
  // 五、入口：URL → 载荷 → 页面
  // ============================================================

  function waybillFromUrl() {
    // 主路径：D7 决策下 URL 形如 https://<域名>/p/<运单号>
    var m = location.pathname.match(/\/p\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
    // 静态托管未做 rewrite 时退化为查询参数：?w=<运单号>
    var q = new URLSearchParams(location.search).get('w');
    return q ? q : null;
  }

  function render(label, ctx) {
    var v = validate(label);
    var html = '';

    if (v.errors.length) {
      // 契约要求：校验失败不得崩溃，给出可读提示（BR-05）
      html += renderNotice('err', '无法展示此标签',
        '<ul>' + v.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>');
      document.getElementById('main').innerHTML = html;
      document.getElementById('source-badge').textContent = ctx.badge;
      return;
    }

    html += renderWarnings(v.warnings);
    html += renderHero(label);
    html += renderRoute(label, ctx.nodes);
    html += renderIdentity(label);
    html += renderAd(label, ctx.adSlots);
    html += renderMaterial(label, ctx.materials);
    html += renderStamp(label);

    document.getElementById('main').innerHTML = html;
    document.getElementById('source-badge').textContent = ctx.badge;
  }

  function renderDebugEntry(hint) {
    // 调试入口：把一张真标签的载荷贴进来渲染。
    // PDA 写入端和第三方 NFC 工具都能导出载荷 JSON，这里用于**真机联调**而不必先部署域名。
    var box = document.getElementById('debug-box');
    if (!box) return;
    box.hidden = false;
    if (hint) document.getElementById('debug-hint').textContent = hint;
    document.getElementById('debug-go').addEventListener('click', function () {
      var raw = document.getElementById('debug-input').value;
      try {
        render(JSON.parse(raw), window.__ctx);
      } catch (e) {
        document.getElementById('main').insertAdjacentHTML('afterbegin',
          renderNotice('err', 'JSON 解析失败', esc(e.message)));
      }
    });
  }

  function fail(msg) {
    document.getElementById('main').innerHTML =
      renderNotice('err', '暂时无法展示', esc(msg));
  }

  function boot() {
    Promise.all([
      loadJSON('labels.json', 'labels'),
      loadJSON('adSlots.json', 'adSlots'),
      loadJSON('materials.json', 'materials'),
      loadJSON('nodes.json', 'nodes'),
    ]).then(function (res) {
      var payload = res[0] || {};
      var ctx = {
        labels: payload.labels || {},
        adSlots: res[1], materials: res[2], nodes: res[3],
        badge: '演示数据集',
      };
      window.__ctx = ctx;

      var meta = payload.meta || {};
      document.getElementById('foot-meta').innerHTML =
        '数据源：' + esc(meta.generatedFrom || '—') + '<br>' +
        '生成时间戳：' + esc(meta.timestamp || '—') + '　契约版本 v' + SUPPORTED_V + '<br>' +
        '演示期页面数据与 PDA 写入端同源；浏览器无 NFC 读取能力，载荷不经 URL 传递。';

      var w = waybillFromUrl();
      if (!w && location.search.indexOf('debug') === -1) {
        w = meta.waybills && meta.waybills[0];
      }

      if (location.search.indexOf('debug') !== -1 || (w && !ctx.labels[w])) {
        // 查不到就说明这张标签不是演示数据集里的 —— 给调试入口而不是死路
        document.getElementById('main').innerHTML = renderNotice('info',
          '未找到运单 ' + esc(w || ''),
          '演示数据集内含：<code>' + (meta.waybills || []).join('</code> <code>') + '</code>' +
          '<br>也可以直接贴入一张真标签的载荷 JSON 来渲染。');
        document.getElementById('source-badge').textContent = '等待输入';
        renderDebugEntry('粘贴标签载荷 JSON（由 PDA 写入端导出，或 NFC 工具读取）');
        return;
      }

      if (!w) { fail('URL 里没有运单号。正确形式：/p/&lt;运单号&gt; 或 ?w=&lt;运单号&gt;'); return; }

      render(ctx.labels[w], ctx);
      renderDebugEntry(null);
    }).catch(function (e) {
      fail(e.message);
    });
  }

  // 测试钩子：把纯函数暴露出来，供 reader-h5/tests/run_tests.js 在 Node 下直接调用。
  // 指针降级、契约校验这些逻辑跑在无 DOM 环境里就能验，不必起浏览器。
  if (typeof window !== 'undefined') {
    window.__pdaIot = {
      validate: validate, routeNodesOf: routeNodesOf,
      resolveAd: resolveAd, resolveMaterial: resolveMaterial, resolveNode: resolveNode,
      esc: esc,
    };
  }
  if (typeof document === 'undefined') return;   // Node 环境（单测）到此为止

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
