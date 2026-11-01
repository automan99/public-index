/* 签收 API 抽象 + 演示实现（解密 / 尝试限制 / 本机记录）。
 *
 * 设计要点（见 docs/superpowers/specs/2026-11-01-signing-auth-design.md §5、§7、§8）：
 *   · 详情由「完整手机号派生的密钥」加密，AES-GCM 校验通过即证明手机号正确；
 *   · 本机 5 次失败锁定 15 分钟（演示级，可被清空 localStorage 绕过）；
 *   · 签收记录只存脱敏手机号与轻量软指纹，绝不存完整手机号；
 *   · 不依赖 document，可在 Node VM 中加载与单测。
 *
 * 暴露：window.PdaSignApi（页面接口）、window.__pdaSign（测试钩子）。
 */
(function () {
  'use strict';

  var ALG = 'AES-256-GCM';
  var KDF = 'PBKDF2-SHA256';
  var ITER_MIN = 100000;
  var ITER_MAX = 1000000;
  var SALT_BYTES = 16;
  var IV_BYTES = 12;
  var TAG_BYTES = 16;
  var KEY_BITS = 256;
  var AAD_VERSION = '2';
  var ENTRY_KEYS = ['salt', 'iv', 'ciphertext'];

  var MAX_FAILS = 5;
  var LOCK_MS = 15 * 60 * 1000;
  var ATTEMPT_PREFIX = 'pda_sign_attempts_';
  var RECORD_PREFIX = 'pda_sign_';
  var DEVICE_KEY = 'pda_device_id';
  var CONSENT_VERSION = 'demo-v1';

  var MESSAGES = {
    FORMAT: '请输入 11 位手机号',
    MISMATCH: '手机号与运单信息不匹配，请核对后重试',
    LOCKED: '尝试次数过多，请稍后再试',
    DATA: '数据格式错误',
    CRYPTO: '当前环境不支持安全解密（需要 HTTPS 或 localhost）',
  };

  var publicDoc = null;
  var sealedDoc = null;

  // ============================================================
  // 一、环境与错误
  // ============================================================

  function getGlobal(name) {
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis[name] !== 'undefined') {
        return globalThis[name];
      }
    } catch (_) { /* 某些环境的 getter 会抛错 */ }
    if (typeof window !== 'undefined' && window && typeof window[name] !== 'undefined') {
      return window[name];
    }
    return undefined;
  }

  function getCrypto() {
    var c = getGlobal('crypto');
    if (c && c.subtle) return c;
    var w = getGlobal('window');
    if (w && w.crypto) return w.crypto;
    return c || null;
  }

  function signError(code, message) {
    var err = new Error(message || MESSAGES[code] || code);
    err.code = code;
    return err;
  }

  function dataError() {
    return signError('DATA', MESSAGES.DATA);
  }

  function isCryptoAvailable() {
    var c = getCrypto();
    return !!(c && c.subtle &&
      typeof c.subtle.importKey === 'function' &&
      typeof c.subtle.deriveKey === 'function' &&
      typeof c.subtle.decrypt === 'function' &&
      typeof c.subtle.digest === 'function');
  }

  // ============================================================
  // 二、手机号工具
  // ============================================================

  function normalizePhone(input) {
    var s = String(input == null ? '' : input).trim();
    s = s.replace(/[\s\-()（）]/g, '');
    if (s.indexOf('+86') === 0 && s.length === 14) s = s.slice(3);
    else if (s.indexOf('86') === 0 && s.length === 13) s = s.slice(2);
    return s;
  }

  function isValidPhone(phone) {
    return typeof phone === 'string' && /^1[3-9]\d{9}$/.test(phone);
  }

  function maskPhone(phone) {
    var s = String(phone);
    return s.slice(0, 3) + '****' + s.slice(-4);
  }

  /* 记录只接受掩码；即便调用方误传完整手机号，也先脱敏再落盘。 */
  function toPhoneMask(value) {
    var raw = String(value == null ? '' : value);
    var normalized = normalizePhone(raw);
    return isValidPhone(normalized) ? maskPhone(normalized) : raw;
  }

  // ============================================================
  // 三、存储（localStorage，异常时回退内存 Map）
  // ============================================================

  var memStore = new Map();
  var volatileKeys = new Set();
  var storageBroken = false;

  function getStorage() {
    if (storageBroken) return null;
    try {
      var s = getGlobal('localStorage');
      if (s && typeof s.getItem === 'function' && typeof s.setItem === 'function' &&
          typeof s.removeItem === 'function') {
        return s;
      }
    } catch (_) { /* 隐私模式下访问 localStorage 本身可能抛 SecurityError */ }
    storageBroken = true;
    return null;
  }

  function readStored(key) {
    if (!volatileKeys.has(key)) {
      var s = getStorage();
      if (s) {
        try {
          return s.getItem(key);
        } catch (_) {
          storageBroken = true;
        }
      }
    }
    return memStore.has(key) ? memStore.get(key) : null;
  }

  function writeStored(key, value) {
    var s = getStorage();
    if (s) {
      try {
        s.setItem(key, value);
        volatileKeys.delete(key);
        memStore.delete(key);
        return;
      } catch (_) {
        storageBroken = true;
      }
    }
    volatileKeys.add(key);
    memStore.set(key, value);
  }

  function removeStored(key) {
    var s = getStorage();
    if (s) {
      try {
        s.removeItem(key);
        volatileKeys.delete(key);
        memStore.delete(key);
        return;
      } catch (_) {
        storageBroken = true;
      }
    }
    volatileKeys.add(key);
    memStore.delete(key);
  }

  // ============================================================
  // 四、尝试限制
  // ============================================================

  function attemptKey(waybill) {
    return ATTEMPT_PREFIX + waybill;
  }

  function recordKey(waybill) {
    return RECORD_PREFIX + waybill;
  }

  function emptyAttempts() {
    return { fails: 0, firstFailAt: 0, lockUntil: 0 };
  }

  function sanitizeAttempts(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return emptyAttempts();
    return {
      fails: Number.isInteger(obj.fails) && obj.fails > 0 ? obj.fails : 0,
      firstFailAt: typeof obj.firstFailAt === 'number' && isFinite(obj.firstFailAt)
        ? obj.firstFailAt : 0,
      lockUntil: typeof obj.lockUntil === 'number' && isFinite(obj.lockUntil)
        ? obj.lockUntil : 0,
    };
  }

  function readAttempts(waybill) {
    var raw = readStored(attemptKey(waybill));
    if (typeof raw !== 'string' || !raw) return emptyAttempts();
    try {
      return sanitizeAttempts(JSON.parse(raw));
    } catch (_) {
      return emptyAttempts();
    }
  }

  function writeAttempts(waybill, state) {
    writeStored(attemptKey(waybill), JSON.stringify(state));
  }

  function nowOf(value) {
    return typeof value === 'number' && isFinite(value) ? value : Date.now();
  }

  function getAttemptState(waybill, now) {
    var t = nowOf(now);
    var state = readAttempts(waybill);
    if (state.lockUntil && t >= state.lockUntil) {
      state = emptyAttempts();
      writeAttempts(waybill, state);
    }
    var locked = !!(state.lockUntil && t < state.lockUntil);
    return {
      fails: state.fails,
      remaining: locked ? 0 : Math.max(0, MAX_FAILS - state.fails),
      lockUntil: state.lockUntil || 0,
      locked: locked,
    };
  }

  function recordFailure(waybill, now) {
    var t = nowOf(now);
    var state = readAttempts(waybill);
    if (state.lockUntil && t >= state.lockUntil) state = emptyAttempts();
    var fails = state.fails + 1;
    var lockUntil = fails >= MAX_FAILS ? t + LOCK_MS : 0;
    writeAttempts(waybill, {
      fails: fails,
      firstFailAt: state.firstFailAt || t,
      lockUntil: lockUntil,
    });
    return getAttemptState(waybill, t);
  }

  function resetAttempts(waybill) {
    removeStored(attemptKey(waybill));
  }

  // ============================================================
  // 五、编解码与摘要
  // ============================================================

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function isBase64(s) {
    return typeof s === 'string' && s.length > 0 && s.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  }

  function base64ToBytes(s) {
    if (!isBase64(s)) throw dataError();
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function randomUUID() {
    var c = getCrypto();
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      var bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      var hex = bytesToHex(bytes);
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
        hex.slice(16, 20) + '-' + hex.slice(20);
    }
    throw signError('CRYPTO', MESSAGES.CRYPTO);
  }

  async function sha256Hex(text) {
    var c = getCrypto();
    if (!isCryptoAvailable()) throw signError('CRYPTO', MESSAGES.CRYPTO);
    var buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return bytesToHex(new Uint8Array(buf));
  }

  // ============================================================
  // 六、解密
  // ============================================================

  function validateMeta(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw dataError();
    if (meta.alg !== ALG || meta.kdf !== KDF) throw dataError();
    if (!Number.isInteger(meta.iter) || meta.iter < ITER_MIN || meta.iter > ITER_MAX) {
      throw dataError();
    }
    return meta.iter;
  }

  function decodeEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw dataError();
    var keys = Object.keys(entry);
    if (keys.length !== ENTRY_KEYS.length ||
        !ENTRY_KEYS.every(function (k) { return keys.indexOf(k) >= 0; })) {
      throw dataError();
    }
    var salt = base64ToBytes(entry.salt);
    var iv = base64ToBytes(entry.iv);
    var ciphertext = base64ToBytes(entry.ciphertext);
    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES ||
        ciphertext.length < TAG_BYTES) {
      throw dataError();
    }
    return { salt: salt, iv: iv, ciphertext: ciphertext };
  }

  async function decryptEntry(entry, phone, waybill, meta) {
    var iter = validateMeta(meta);
    if (!isCryptoAvailable()) throw signError('CRYPTO', MESSAGES.CRYPTO);
    var c = getCrypto();
    var enc = new TextEncoder();
    var parts = decodeEntry(entry);

    var key;
    try {
      var baseKey = await c.subtle.importKey('raw', enc.encode(phone), 'PBKDF2', false,
        ['deriveKey']);
      key = await c.subtle.deriveKey(
        { name: 'PBKDF2', salt: parts.salt, iterations: iter, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: KEY_BITS },
        false,
        ['decrypt']
      );
    } catch (_) {
      throw signError('CRYPTO', MESSAGES.CRYPTO);
    }

    var plain;
    try {
      plain = await c.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: parts.iv,
          additionalData: enc.encode(waybill + '|' + AAD_VERSION),
          tagLength: 128,
        },
        key,
        parts.ciphertext
      );
    } catch (_) {
      // GCM 认证失败 = 手机号错误或密文被篡改；与「手机号错误」使用同一错误。
      throw signError('MISMATCH', MESSAGES.MISMATCH);
    }
    return new TextDecoder().decode(plain);
  }

  // ============================================================
  // 七、设备指纹与记录
  // ============================================================

  function getTimezone() {
    try {
      var IntlObj = getGlobal('Intl');
      if (IntlObj && typeof IntlObj.DateTimeFormat === 'function') {
        return IntlObj.DateTimeFormat().resolvedOptions().timeZone || '';
      }
    } catch (_) { /* 忽略环境差异 */ }
    return '';
  }

  function stableStringify(obj) {
    var keys = Object.keys(obj).sort();
    var parts = keys.map(function (k) {
      return JSON.stringify(k) + ':' + JSON.stringify(obj[k]);
    });
    return '{' + parts.join(',') + '}';
  }

  function getDeviceId() {
    var existing = readStored(DEVICE_KEY);
    if (typeof existing === 'string' && existing) return existing;
    var id = randomUUID();
    writeStored(DEVICE_KEY, id);
    return id;
  }

  async function buildDevice() {
    var nav = getGlobal('navigator') || {};
    var scr = getGlobal('screen') || {};
    var deviceId = getDeviceId();
    var components = {
      deviceId: deviceId,
      language: nav.language || (nav.languages && nav.languages[0]) || '',
      platform: nav.platform || (nav.userAgentData && nav.userAgentData.platform) || '',
      screen: scr.width != null && scr.height != null
        ? String(scr.width) + 'x' + String(scr.height) : '',
      timezone: getTimezone(),
      ua: nav.userAgent || '',
    };
    var fingerprintHash = await sha256Hex(stableStringify(components));
    return {
      deviceId: deviceId,
      fingerprintId: 'fp_' + fingerprintHash.slice(0, 8),
      fingerprintHash: fingerprintHash,
      ua: components.ua,
      platform: components.platform,
      screen: components.screen,
      timezone: components.timezone,
      language: components.language,
    };
  }

  function buildSignRecord(input) {
    var p = input || {};
    var d = p.device || {};
    var meta = sealedDoc && sealedDoc.meta ? sealedDoc.meta : null;
    return {
      eventId: randomUUID(),
      waybill: String(p.waybill),
      status: 'signed',
      signedAt: p.signedAt,
      verifyMethod: 'phone',
      phoneMask: toPhoneMask(p.phoneMask),
      contentHash: String(p.contentHash),
      sealVersion: meta && meta.version != null ? String(meta.version) : '1',
      device: {
        deviceId: d.deviceId,
        fingerprintId: d.fingerprintId,
        fingerprintHash: d.fingerprintHash,
        ua: d.ua,
        platform: d.platform,
        screen: d.screen,
        timezone: d.timezone,
        language: d.language,
      },
      consentVersion: CONSENT_VERSION,
    };
  }

  // ============================================================
  // 八、对外接口
  // ============================================================

  function configure(params) {
    var p = params || {};
    publicDoc = p.publicDoc && typeof p.publicDoc === 'object' ? p.publicDoc : null;
    sealedDoc = p.sealedDoc && typeof p.sealedDoc === 'object' ? p.sealedDoc : null;
  }

  function getPublic(waybill) {
    var table = publicDoc && publicDoc.waybills;
    if (!table || typeof table !== 'object') return null;
    var entry = table[waybill];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    return {
      w: entry.w,
      n: entry.n,
      g: entry.g,
      service: entry.service,
      phoneMask: entry.phoneMask,
    };
  }

  function getRecord(waybill) {
    var raw = readStored(recordKey(waybill));
    if (typeof raw !== 'string' || !raw) return null;
    try {
      var rec = JSON.parse(raw);
      return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null;
    } catch (_) {
      return null;
    }
  }

  async function unlock(params) {
    var p = params || {};
    var waybill = p.waybill;
    var phone = normalizePhone(p.phone);

    if (!isValidPhone(phone)) throw signError('FORMAT', MESSAGES.FORMAT);

    if (typeof waybill !== 'string' || !waybill) throw dataError();

    if (getAttemptState(waybill).locked) throw signError('LOCKED', MESSAGES.LOCKED);

    var entries = sealedDoc && sealedDoc.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw dataError();
    var entry = entries[waybill];
    if (!entry) throw dataError();

    var plaintext;
    try {
      plaintext = await decryptEntry(entry, phone, waybill, sealedDoc.meta);
    } catch (err) {
      if (err && err.code === 'MISMATCH') recordFailure(waybill);
      throw err;
    }

    var detail;
    try {
      detail = JSON.parse(plaintext);
    } catch (_) {
      throw dataError();
    }
    var contentHash = await sha256Hex(plaintext);
    resetAttempts(waybill);
    return { detail: detail, contentHash: contentHash };
  }

  async function sign(params) {
    var p = params || {};
    var waybill = p.waybill;
    if (typeof waybill !== 'string' || !waybill) throw dataError();

    var existing = getRecord(waybill);
    if (existing) return existing;

    var device = await buildDevice();
    var record = buildSignRecord({
      waybill: waybill,
      phoneMask: p.phoneMask,
      contentHash: p.contentHash,
      device: device,
      signedAt: new Date(nowOf(p.now)).toISOString(),
    });
    writeStored(recordKey(waybill), JSON.stringify(record));
    return record;
  }

  var api = {
    configure: configure,
    getPublic: getPublic,
    unlock: unlock,
    getAttemptState: getAttemptState,
    getRecord: getRecord,
    sign: sign,
    isCryptoAvailable: isCryptoAvailable,
  };

  var hooks = {
    normalizePhone: normalizePhone,
    isValidPhone: isValidPhone,
    maskPhone: maskPhone,
    getAttemptState: getAttemptState,
    recordFailure: recordFailure,
    resetAttempts: resetAttempts,
    buildSignRecord: buildSignRecord,
    attemptKey: attemptKey,
    recordKey: recordKey,
  };

  var win = getGlobal('window');
  if (!win || typeof win !== 'object') win = getGlobal('globalThis');
  if (win) {
    win.PdaSignApi = api;
    win.__pdaSign = hooks;
  }
})();
