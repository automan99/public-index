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
  var DEMO_BANNER = '演示环境：详情为加密演示数据；签收记录仅保存在本机，不具备法律效力。';
  var LOCK_FALLBACK_MS = 60 * 1000;
  var lockTimer = null;
  // 本次验证成功后的内存解锁结果，仅供签收使用；刷新即失效。
  var currentUnlock = null;

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
          '（请用 bash serve.sh 启动本地静态服务，而不是直接双击打开）');
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
  // 五、入口：URL → 浅信息 → 手机号门禁 → 详情
  //
  // 隐私边界（spec §6）：详情以「完整手机号派生的密钥」加密，未验证时页面里
  // **不得出现**路由、UID、广告、素材、留痕 —— 连隐藏节点都不行。手机号只用于
  // 本机解密，不写入任何存储。
  // ============================================================

  function waybillFromUrl() {
    // 主路径：D7 决策下 URL 形如 https://<域名>/p/<运单号>
    var m = location.pathname.match(/\/p\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
    // 静态托管未做 rewrite 时退化为查询参数：?w=<运单号>
    var q = new URLSearchParams(location.search).get('w');
    return q ? q : null;
  }

  function isLocalhost() {
    if (typeof location === 'undefined') return false;
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }

  function setBadge(text) {
    var el = document.getElementById('source-badge');
    if (el) el.textContent = text;
  }

  function setFootMeta(publicDoc) {
    var el = document.getElementById('foot-meta');
    if (!el) return;
    var meta = (publicDoc && publicDoc.meta) || {};
    el.innerHTML = '加密演示数据（详情需手机号验证）' +
      '<br>数据源：' + esc(meta.generatedFrom || '—') +
      '　生成时间：' + esc(meta.generatedAt || '—') +
      '　契约版本 v' + SUPPORTED_V + '<br>' +
      esc(meta.securityNote || '浅信息为公开数据；详情为加密数据。') +
      '浏览器无 NFC 读取能力，载荷不经 URL 传递。';
  }

  function renderDemoBanner() {
    return '<div class="demo-banner" role="note">' + esc(DEMO_BANNER) + '</div>';
  }

  function formatRecordTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 签收区：仅在已验证视图渲染。记录只展示脱敏手机号与软指纹，不含完整手机号。 */
  var SIGN_NOTE = '签收后不可撤销。将记录签收时间、脱敏手机号与设备信息，用于签收凭证。';

  function signField(k, cls, v) {
    return '<div class="sign-field"><span class="sign-k">' + esc(k) + '</span>' +
      '<span class="sign-v ' + cls + '">' + esc(v) + '</span></div>';
  }

  function renderSignCard() {
    return '<section class="card sign-card">' +
      '<h2 class="card-title">签收</h2>' +
      '<p class="sign-note">' + esc(SIGN_NOTE) + '</p>' +
      '<div class="sign-actions">' +
        '<button id="sign-btn" class="sign-btn" type="button">确认签收</button>' +
      '</div>' +
      '<p id="sign-error" class="sign-error" aria-live="polite"></p>' +
      '</section>';
  }

  function renderSignedCard(record) {
    var rec = record || {};
    var device = rec.device || {};
    var fp = device.fingerprintId || '—';
    var eventId = String(rec.eventId || '');
    var contentHash = String(rec.contentHash || '');
    return '<section class="card sign-success signed-record">' +
      '<div class="sign-success-icon" aria-hidden="true">✓</div>' +
      '<h2 class="card-title">签收凭证</h2>' +
      '<p class="sign-state">已签收（本机记录）</p>' +
      signField('状态', '', '已签收') +
      signField('签收时间', 'sign-time', formatRecordTime(rec.signedAt)) +
      signField('手机号', 'sign-phone sign-mono', rec.phoneMask || '—') +
      signField('设备指纹', 'sign-fp sign-mono', fp) +
      signField('校验方式', '', rec.verifyMethod === 'phone' ? '手机号' : (rec.verifyMethod || '—')) +
      signField('记录 ID', 'sign-event sign-mono', eventId.slice(0, 8)) +
      signField('内容指纹', 'sign-hash sign-mono', 'h_' + contentHash.slice(0, 8)) +
      '<p class="privacy-note">签收记录仅保存在本机，不具备法律效力。' +
      '设备指纹为软指纹，清除浏览器数据即失效，也可被伪造。</p>' +
      '</section>';
  }

  /* 行内确认：先展开不可撤销提示，确认后才写入；取消则收起并恢复按钮。 */
  function bindSign(unlocked, info) {
    var btn = document.getElementById('sign-btn');
    if (!btn || !unlocked) return;
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      btn.disabled = true;

      var card = btn.closest ? btn.closest('.sign-card') : null;
      var wrap = document.getElementById('sign-confirm');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'sign-confirm';
        wrap.className = 'sign-confirm';
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', '确认签收');
        wrap.innerHTML = '<p class="sign-confirm-text">确认签收？此操作不可撤销</p>' +
          '<div class="sign-confirm-actions">' +
            '<button id="sign-confirm-btn" class="sign-confirm-btn" type="button">确认签收</button>' +
            '<button id="sign-cancel-btn" class="sign-cancel-btn" type="button">取消</button>' +
          '</div>';
        var errEl = document.getElementById('sign-error');
        if (card && errEl && errEl.parentNode === card) card.insertBefore(wrap, errEl);
        else if (card) card.appendChild(wrap);

        var cancelBtn = document.getElementById('sign-cancel-btn');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', function () {
            if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
            btn.disabled = false;
          });
        }
        var confirmBtn = document.getElementById('sign-confirm-btn');
        if (confirmBtn) {
          confirmBtn.addEventListener('click', function () {
            handleSign(unlocked, info);
          });
        }
      }
    });
  }

  function handleSign(unlocked, info) {
    var api = window.PdaSignApi;
    var btn = document.getElementById('sign-confirm-btn');
    var cancelBtn = document.getElementById('sign-cancel-btn');
    var errEl = document.getElementById('sign-error');
    if (!api || !unlocked || !btn || btn.disabled) return Promise.resolve();

    btn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    btn.textContent = '签收中…';
    if (errEl) errEl.textContent = '';

    return api.sign({
      waybill: unlocked.waybill,
      detail: unlocked.detail,
      contentHash: unlocked.contentHash,
      phoneMask: (info && info.phoneMask) || '',
    }).then(function (record) {
      showSigned(record);
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = '确认签收';
      if (cancelBtn) cancelBtn.disabled = false;
      if (errEl) errEl.textContent = '签收失败，请稍后重试。';
    });
  }

  function showSigned(record) {
    var old = document.querySelector('.sign-card, .signed-record');
    if (old) {
      var box = document.createElement('div');
      box.innerHTML = renderSignedCard(record);
      old.parentNode.replaceChild(box.firstChild, old);
    }
    setBadge('已签收');
  }

  /* 浅信息卡：运单号 / 物品 / 重量 / 服务。详情字段一律不在这里出现。 */
  function renderShallow(info) {
    var i = info || {};
    return '<section class="card gate-card">' +
      '<h2 class="card-title">运单信息</h2>' +
      '<p class="hero-no">' + esc(i.w || '') + '</p>' +
      '<p class="hero-no-label">运单号</p>' +
      kv('物品', esc(i.n || '')) +
      kv('重量', esc(i.g || '')) +
      kv('服务', esc(i.service || '—')) +
      '</section>';
  }

  /* 未验证视图：浅信息 + 脱敏手机号 + 手机号表单 + 错误/锁定区 + 隐私说明。 */
  function renderLocked(info, ctx, record) {
    var pill = record
      ? '<div class="status-pill">已签收（本机记录）· ' + esc(formatRecordTime(record.signedAt)) + '</div>'
      : '';
    var html = renderDemoBanner() +
      renderShallow(info) +
      '<section class="card gate-card">' +
        pill +
        '<p class="phone-mask">' + esc((info && info.phoneMask) || '') + '</p>' +
        '<p class="phone-hint">为保护收件人隐私，请输入完整手机号验证</p>' +
        '<form class="phone-form" id="phone-form" novalidate>' +
          '<input id="phone-input" class="phone-input" type="text" inputmode="numeric" ' +
            'autocomplete="off" spellcheck="false" aria-label="收件人手机号" ' +
            'placeholder="请输入 11 位手机号">' +
          '<button id="verify-btn" class="verify-btn" type="submit">验证并查看</button>' +
        '</form>' +
        '<p id="gate-error" class="gate-error" aria-live="polite"></p>' +
        '<div id="lockout" class="lockout" role="status" aria-live="polite" hidden></div>' +
        '<p class="privacy-note">手机号仅用于本机解密，不上传、不保存。</p>' +
      '</section>';

    document.getElementById('main').innerHTML = html;
    setBadge('加密演示数据');
    ctx.info = info;
    bindVerify(info);

    var state = window.PdaSignApi.getAttemptState(ctx.waybill);
    if (state.locked) startLockoutCountdown(state.lockUntil);
  }

  function bindVerify(info) {
    var form = document.getElementById('phone-form');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      handleVerify(info);
    });
  }

  /* 验证中禁用控件；成功渲染详情；失败按错误码给出统一、可读的提示。 */
  function handleVerify(info) {
    var api = window.PdaSignApi;
    var input = document.getElementById('phone-input');
    var btn = document.getElementById('verify-btn');
    var errEl = document.getElementById('gate-error');
    var lockEl = document.getElementById('lockout');
    if (!api || !input || !btn || btn.disabled) return Promise.resolve();

    var labelText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '验证中…';
    input.disabled = true;
    if (errEl) errEl.textContent = '';
    if (lockEl) { lockEl.hidden = true; lockEl.textContent = ''; }

    var ctx = window.__ctx || {};
    return api.unlock({ waybill: ctx.waybill, phone: input.value }).then(function (res) {
      input.value = '';
      btn.disabled = false;
      btn.textContent = labelText;
      input.disabled = false;
      currentUnlock = {
        waybill: ctx.waybill,
        detail: res.detail,
        contentHash: res.contentHash,
      };
      renderFull(res.detail, ctx, api.getRecord(ctx.waybill));
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = labelText;
      input.disabled = false;
      var code = err && err.code;

      if (code === 'FORMAT') {
        if (errEl) errEl.textContent = '请输入 11 位手机号';
        return;
      }
      if (code === 'MISMATCH') {
        var st = api.getAttemptState(ctx.waybill);
        if (errEl) {
          errEl.textContent = '手机号与运单信息不匹配，请核对后重试（剩余 ' + st.remaining + ' 次）';
        }
        if (st.locked) startLockoutCountdown(st.lockUntil);
        return;
      }
      if (code === 'LOCKED') {
        var locked = api.getAttemptState(ctx.waybill);
        if (errEl) errEl.textContent = '';
        startLockoutCountdown(locked.lockUntil || Date.now() + LOCK_FALLBACK_MS);
        return;
      }
      if (code === 'DATA') {
        if (errEl) errEl.textContent = '数据格式错误，暂时无法展示详情。';
        return;
      }
      if (code === 'CRYPTO') {
        if (errEl) errEl.textContent = '当前环境不支持安全解密（需要 HTTPS 或 localhost）。';
        return;
      }
      if (errEl) errEl.textContent = '验证失败，请稍后重试。';
    });
  }

  /* 每秒刷新 #lockout；倒计时结束恢复输入。锁定期间正确手机号也不放行。 */
  function startLockoutCountdown(lockUntil) {
    if (lockTimer) clearInterval(lockTimer);
    var until = typeof lockUntil === 'number' && isFinite(lockUntil) && lockUntil > Date.now()
      ? lockUntil : Date.now() + LOCK_FALLBACK_MS;
    var input = document.getElementById('phone-input');
    var btn = document.getElementById('verify-btn');
    var lockEl = document.getElementById('lockout');

    function finish() {
      clearInterval(lockTimer);
      lockTimer = null;
      if (input) input.disabled = false;
      if (btn) { btn.disabled = false; btn.textContent = '验证并查看'; }
      if (lockEl) {
        lockEl.hidden = true;
        lockEl.textContent = '';
      }
      var errEl = document.getElementById('gate-error');
      if (errEl) errEl.textContent = '锁定已解除，请重新验证。';
    }

    function tick() {
      var left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) { finish(); return; }
      var mm = String(Math.floor(left / 60)).padStart(2, '0');
      var ss = String(left % 60).padStart(2, '0');
      if (lockEl) {
        lockEl.hidden = false;
        lockEl.textContent = '尝试次数过多，请在 ' + mm + ':' + ss + ' 后重试。';
      }
      if (input) input.disabled = true;
      if (btn) btn.disabled = true;
    }

    tick();
    if (!lockTimer) lockTimer = setInterval(tick, 1000);
  }

  /* 已验证视图：复跑契约校验，通过后复用现有卡片渲染，并在末尾追加签收区。 */
  function renderFull(label, ctx, record, options) {
    var opts = options || {};
    var v = validate(label);
    var html = renderDemoBanner();

    if (v.errors.length) {
      html += renderNotice('err', '数据格式错误',
        '<ul>' + v.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>');
      document.getElementById('main').innerHTML = html;
      setBadge(opts.debug ? '调试渲染' : '已解锁');
      return;
    }

    html += '<div class="verified-badge" role="status">' +
      (opts.debug ? '调试渲染（未验证）' : '已验证') + '</div>';
    if (record) {
      html += '<div class="status-pill">已签收（本机记录）· ' +
        esc(formatRecordTime(record.signedAt)) + '</div>';
    }
    html += renderWarnings(v.warnings);
    html += renderHero(label);
    html += renderRoute(label, ctx.nodes);
    html += renderIdentity(label);
    html += renderAd(label, ctx.adSlots);
    html += renderMaterial(label, ctx.materials);
    html += renderStamp(label);

    if (!opts.debug) {
      html += record ? renderSignedCard(record) : renderSignCard();
    }

    document.getElementById('main').innerHTML = html;
    setBadge(opts.debug ? '调试渲染' : '已解锁');
    ctx.unlocked = true;

    if (!opts.debug && !record && currentUnlock && currentUnlock.waybill === ctx.waybill) {
      bindSign(currentUnlock, ctx.info);
    }
  }

  function renderDebugEntry(ctx) {
    // 调试入口：把一张真标签的载荷贴进来渲染。仅在 localhost 且 ?debug=1 时启用，
    // 生产域名下忽略该参数，避免绕过加密。
    var box = document.getElementById('debug-box');
    if (!box) return;
    box.hidden = false;
    var btn = document.getElementById('debug-go');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        var raw = document.getElementById('debug-input').value;
        try {
          renderFull(JSON.parse(raw), ctx || window.__ctx, null, { debug: true });
        } catch (e) {
          document.getElementById('main').insertAdjacentHTML('afterbegin',
            renderNotice('err', 'JSON 解析失败', esc(e.message)));
        }
      });
    }
  }

  function fail(msg) {
    document.getElementById('main').innerHTML =
      renderDemoBanner() + renderNotice('err', '暂时无法展示', esc(msg));
    setBadge('加载失败');
  }

  function renderNotFound(w, publicDoc) {
    var list = (publicDoc && publicDoc.meta && publicDoc.meta.waybills) || [];
    var body = '演示数据集内含：<code>' + list.map(esc).join('</code> <code>') + '</code>' +
      '<br>正确形式：/p/&lt;运单号&gt; 或 ?w=&lt;运单号&gt;。';
    document.getElementById('main').innerHTML = renderDemoBanner() +
      renderNotice('info', w ? '未找到运单 ' + esc(w) : '未找到运单', body);
    setBadge('未找到运单');
  }

  function renderCryptoError() {
    document.getElementById('main').innerHTML = renderDemoBanner() +
      renderNotice('err', '当前环境无法安全验证',
        '浏览器加密能力（Web Crypto）仅在 HTTPS 或 localhost 下可用。' +
        '请通过 HTTPS 或 localhost 打开本页后再验证手机号。');
    setBadge('环境不支持');
  }

  async function asyncBoot(publicDoc, sealedDoc, adSlots, materials, nodes) {
    publicDoc = publicDoc || {};
    sealedDoc = sealedDoc || {};
    var ctx = {
      publicDoc: publicDoc,
      sealedDoc: sealedDoc,
      adSlots: adSlots,
      materials: materials,
      nodes: nodes,
      unlocked: false,
      waybill: null,
    };
    window.__ctx = ctx;
    setFootMeta(publicDoc);

    var api = window.PdaSignApi;
    if (!api || typeof api.configure !== 'function') {
      fail('签收组件未加载（缺少 sign-api.js），无法验证手机号。');
      return;
    }
    api.configure({ publicDoc: publicDoc, sealedDoc: sealedDoc });

    var w = waybillFromUrl();
    var debugMode = isLocalhost() && new URLSearchParams(location.search).get('debug') === '1';

    if (!w) {
      if (debugMode) {
        document.getElementById('main').innerHTML = renderDemoBanner() +
          renderNotice('info', '调试模式',
            '未指定运单号；可以粘贴一张真标签的载荷 JSON 来渲染。');
        setBadge('调试模式');
        renderDebugEntry(ctx);
      } else {
        renderNotFound(null, publicDoc);
      }
      return;
    }

    var info = await api.getPublic(w);
    if (!info) {
      renderNotFound(w, publicDoc);
      return;
    }
    ctx.waybill = w;
    ctx.info = info;

    if (!api.isCryptoAvailable()) {
      renderCryptoError();
      return;
    }

    var record = api.getRecord(w);
    renderLocked(info, ctx, record);

    if (debugMode) renderDebugEntry(ctx);
  }

  async function boot() {
    try {
      var res = await Promise.all([
        loadJSON('public.json', 'public'),
        loadJSON('sealed.json', 'sealed'),
        loadJSON('adSlots.json', 'adSlots'),
        loadJSON('materials.json', 'materials'),
        loadJSON('nodes.json', 'nodes'),
      ]);
      await asyncBoot(res[0], res[1], res[2], res[3], res[4]);
    } catch (e) {
      fail(e.message);
    }
  }

  // 测试钩子：把纯函数暴露出来，供 tests/run_tests.js 在 Node 下直接调用。
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
