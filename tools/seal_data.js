#!/usr/bin/env node
/* 密封工具：明文标签 → data/public.json + data/sealed.json + data/embedded.js
 *
 * 设计要点（见 docs/superpowers/specs/2026-11-01-signing-auth-design.md）：
 *   · 浅信息（运单号/物品/重量/服务/脱敏手机号）明文发布；
 *   · 详情用「完整手机号派生的密钥」加密，GCM 校验通过即证明手机号正确；
 *   · 明文源与演示手机号只放 data-private/，不进入发布产物；
 *   · 写出前做泄露自检，先写临时文件再原子替换，失败不留半成品。
 *
 * 用法：
 *   node tools/seal_data.js            # 生成 public/sealed/embedded
 *   node tools/seal_data.js --final    # 同时要求 data/labels.json 已删除
 *   node tools/seal_data.js --check    # 只校验现有产物，不重写（可配 --final）
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const H5_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(H5_DIR, 'data');
const PRIVATE_DIR = path.join(H5_DIR, 'data-private');

const ITER = 600000;
const ITER_MIN = 100000;
const ITER_MAX = 1000000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const DEFAULT_VERSION = '2';
const PUBLIC_VERSION = '1';
const SEALED_VERSION = '1';

const ENTRY_KEYS = ['salt', 'iv', 'ciphertext'];
const PUBLIC_KEYS = ['w', 'n', 'g', 'service', 'phoneMask'];
const EMBEDDED_KEYS = ['public', 'sealed', 'adSlots', 'materials', 'nodes'];
const EMBEDDED_MARKER = 'window.__PDA_IOT_DATA__ = ';

const PATHS = {
  labels: path.join(PRIVATE_DIR, 'labels.json'),
  phones: path.join(PRIVATE_DIR, 'demo_phones.json'),
  legacyLabels: path.join(DATA_DIR, 'labels.json'),
  public: path.join(DATA_DIR, 'public.json'),
  sealed: path.join(DATA_DIR, 'sealed.json'),
  embedded: path.join(DATA_DIR, 'embedded.js'),
  adSlots: path.join(DATA_DIR, 'adSlots.json'),
  materials: path.join(DATA_DIR, 'materials.json'),
  nodes: path.join(DATA_DIR, 'nodes.json'),
};

// ============================================================
// 一、手机号工具
// ============================================================

function normalizePhone(input) {
  let s = String(input == null ? '' : input).trim();
  s = s.replace(/[\s\-()（）]/g, '');
  if (s.startsWith('+86') && s.length === 14) s = s.slice(3);
  else if (s.startsWith('86') && s.length === 13) s = s.slice(2);
  return s;
}

function isValidPhone(phone) {
  return typeof phone === 'string' && /^1[3-9]\d{9}$/.test(phone);
}

function maskPhone(phone) {
  return String(phone).slice(0, 3) + '****' + String(phone).slice(-4);
}

// ============================================================
// 二、密封 / 解开
// ============================================================

function dataError() {
  return new Error('DATA');
}

function isBase64(s) {
  return typeof s === 'string' && s.length > 0 && s.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

function decodeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw dataError();
  const keys = Object.keys(entry);
  if (keys.length !== ENTRY_KEYS.length || !ENTRY_KEYS.every((k) => keys.includes(k))) {
    throw dataError();
  }
  for (const key of ENTRY_KEYS) {
    if (!isBase64(entry[key])) throw dataError();
  }
  const salt = Buffer.from(entry.salt, 'base64');
  const iv = Buffer.from(entry.iv, 'base64');
  const ciphertext = Buffer.from(entry.ciphertext, 'base64');
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ciphertext.length < TAG_BYTES) {
    throw dataError();
  }
  return { salt, iv, ciphertext };
}

function contractVersion(version) {
  return version == null ? DEFAULT_VERSION : String(version);
}

function sealLabel(label, phone, waybill, version) {
  if (!label || typeof label !== 'object' || Array.isArray(label)) {
    throw new TypeError('label 必须是对象');
  }
  if (typeof phone !== 'string' || !phone || typeof waybill !== 'string' || !waybill) {
    throw new TypeError('phone / waybill 必须是非空字符串');
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = crypto.pbkdf2Sync(phone, salt, ITER, KEY_BYTES, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(waybill + '|' + contractVersion(version), 'utf8'));

  const plain = Buffer.from(JSON.stringify(label), 'utf8');
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: Buffer.concat([body, tag]).toString('base64'),
  };
}

/* 结构/格式问题统一抛 Error('DATA')；GCM 认证失败保留底层错误，
 * 由 sign-api 映射为 MISMATCH。 */
function openSealed(entry, phone, waybill, version) {
  if (typeof phone !== 'string' || typeof waybill !== 'string' || !waybill) {
    throw dataError();
  }
  const { salt, iv, ciphertext } = decodeEntry(entry);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);

  const key = crypto.pbkdf2Sync(phone, salt, ITER, KEY_BYTES, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(waybill + '|' + contractVersion(version), 'utf8'));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

// ============================================================
// 三、产物构建
// ============================================================

function isoWithOffset(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
}

function serviceOf(label) {
  const cd = label && label.f && label.f.m && label.f.m.cd;
  return cd && typeof cd.service === 'string' ? cd.service : '';
}

function buildPublicDoc(labelsDoc, phones) {
  if (!labelsDoc || typeof labelsDoc !== 'object' || !labelsDoc.labels ||
      typeof labelsDoc.labels !== 'object') {
    throw new Error('labels 文档缺少 labels 映射');
  }
  const phoneMap = phones || {};
  const waybills = {};
  const order = [];

  for (const wb of Object.keys(labelsDoc.labels)) {
    const phone = normalizePhone(phoneMap[wb]);
    if (!isValidPhone(phone)) throw new Error(`运单 ${wb} 缺少合法手机号`);

    const label = labelsDoc.labels[wb] || {};
    const l = (label.f && label.f.l) || {};
    waybills[wb] = {
      w: typeof l.w === 'string' && l.w ? l.w : wb,
      n: typeof l.n === 'string' ? l.n : '',
      g: typeof l.g === 'string' ? l.g : '',
      service: serviceOf(label),
      phoneMask: maskPhone(phone),
    };
    order.push(wb);
  }

  return {
    meta: {
      version: PUBLIC_VERSION,
      generatedFrom: 'data-private/labels.json',
      generatedAt: isoWithOffset(new Date()),
      waybills: order,
      securityNote: '浅信息为公开数据；详情为加密数据。',
    },
    waybills,
  };
}

function buildSealedDoc(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new TypeError('entries 必须是对象');
  }
  return {
    meta: {
      version: SEALED_VERSION,
      alg: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iter: ITER,
      note: '密文公开；完整手机号是唯一解密凭据。',
    },
    entries,
  };
}

function buildEmbedded(publicDoc, sealedDoc, tables) {
  const t = tables || {};
  for (const key of ['adSlots', 'materials', 'nodes']) {
    if (!(key in t)) throw new Error(`缺少查找表 ${key}`);
  }
  const payload = {
    public: publicDoc,
    sealed: sealedDoc,
    adSlots: t.adSlots,
    materials: t.materials,
    nodes: t.nodes,
  };
  return '// 本文件由 tools/seal_data.js 自动生成，请勿手工编辑。\n' +
    '// 用途：file:// 直接打开页面时 fetch 不可用，作为同源数据的兜底副本。\n' +
    EMBEDDED_MARKER + JSON.stringify(payload, null, 2) + ';\n';
}

// ============================================================
// 四、泄露检查
// ============================================================

function collectPhones(phones) {
  const out = new Set();
  if (!phones || typeof phones !== 'object') return [];
  for (const value of Object.values(phones)) {
    const phone = normalizePhone(value);
    if (isValidPhone(phone)) out.add(phone);
  }
  return Array.from(out);
}

function routeCodesOf(label) {
  const code = label && label.f && label.f.r && label.f.r.c;
  if (typeof code !== 'string') return [];
  const out = [];
  for (let i = 0; i + 6 <= code.length; i += 6) out.push(code.slice(i, i + 6));
  return out;
}

function uidsOf(label) {
  const i = (label && label.f && label.f.i) || {};
  return [i.s, i.r].filter((v) => typeof v === 'string' && /^[0-9a-f]{16}$/i.test(v));
}

/* 返回 Array<{ kind, value }>，kind 为 phone / route / uid / sealed。
 * 手机号泄露时 value 用掩码，避免把完整号码打进日志。 */
function findLeaks(publicDoc, sealedDoc, tables, phones, labelsDoc) {
  const found = [];
  const seen = new Set();
  const add = (kind, value) => {
    const key = kind + ':' + value;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind: kind, value: value });
  };

  const phoneList = collectPhones(phones);
  const publicText = JSON.stringify(publicDoc || {});
  for (const phone of phoneList) {
    if (publicText.includes(phone)) add('phone', maskPhone(phone));
  }

  const labels = (labelsDoc && labelsDoc.labels) || {};
  const routes = new Set();
  const uids = new Set();
  for (const label of Object.values(labels)) {
    for (const code of routeCodesOf(label)) routes.add(code);
    for (const uid of uidsOf(label)) uids.add(uid);
  }
  for (const code of routes) {
    if (publicText.includes(code)) add('route', code);
  }
  for (const uid of uids) {
    if (publicText.includes(uid)) add('uid', uid);
  }

  // 查找表只查完整手机号：nodes.json 合法包含 6 位节点码，不能当泄露。
  if (tables && typeof tables === 'object') {
    for (const table of Object.values(tables)) {
      const text = JSON.stringify(table || {});
      for (const phone of phoneList) {
        if (text.includes(phone)) add('phone', maskPhone(phone));
      }
    }
  }

  // sealed 只检查条目形状与完整手机号；不扫密文里的短码（base64 会误报）。
  const sealed = sealedDoc || {};
  const entries = sealed.entries && typeof sealed.entries === 'object' ? sealed.entries : {};
  for (const wb of Object.keys(entries)) {
    try {
      decodeEntry(entries[wb]);
    } catch (err) {
      add('sealed', wb);
    }
  }
  const sealedText = JSON.stringify(sealed);
  for (const phone of phoneList) {
    if (sealedText.includes(phone)) add('phone', maskPhone(phone));
  }

  return found;
}

// ============================================================
// 五、产物形状校验（--check / 写盘前自检）
// ============================================================

function sorted(list) {
  return list.slice().sort();
}

function sameKeys(a, b) {
  return a.length === b.length && sorted(a).join('\0') === sorted(b).join('\0');
}

function validatePublicDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('public.json 不是对象');
  }
  const meta = doc.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('public.json 缺少 meta');
  }
  if (meta.version !== PUBLIC_VERSION) {
    throw new Error('public.json meta.version 非法');
  }
  if (meta.generatedFrom !== 'data-private/labels.json' ||
      typeof meta.generatedAt !== 'string' || !meta.generatedAt ||
      typeof meta.securityNote !== 'string') {
    throw new Error('public.json meta 字段非法');
  }
  if (!Array.isArray(meta.waybills) || meta.waybills.some((w) => typeof w !== 'string')) {
    throw new Error('public.json meta.waybills 非法');
  }
  const waybills = doc.waybills;
  if (!waybills || typeof waybills !== 'object' || Array.isArray(waybills)) {
    throw new Error('public.json 缺少 waybills');
  }
  if (!sameKeys(Object.keys(waybills), meta.waybills)) {
    throw new Error('public.json waybills 与 meta.waybills 不一致');
  }
  for (const wb of Object.keys(waybills)) {
    const entry = waybills[wb];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`public.json 运单 ${wb} 不是对象`);
    }
    if (!sameKeys(Object.keys(entry), PUBLIC_KEYS)) {
      throw new Error(`public.json 运单 ${wb} 字段应为 w/n/g/service/phoneMask`);
    }
    for (const key of PUBLIC_KEYS) {
      if (typeof entry[key] !== 'string') {
        throw new Error(`public.json 运单 ${wb} 的 ${key} 不是字符串`);
      }
    }
    if (!/^\d{3}\*{4}\d{4}$/.test(entry.phoneMask)) {
      throw new Error(`public.json 运单 ${wb} 的 phoneMask 格式非法`);
    }
  }
}

function validateSealedDoc(doc, publicDoc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('sealed.json 不是对象');
  }
  const meta = doc.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('sealed.json 缺少 meta');
  }
  if (meta.version !== SEALED_VERSION || meta.alg !== 'AES-256-GCM' ||
      meta.kdf !== 'PBKDF2-SHA256') {
    throw new Error('sealed.json meta 的 version/alg/kdf 非法');
  }
  if (!Number.isInteger(meta.iter) || meta.iter < ITER_MIN || meta.iter > ITER_MAX) {
    throw new Error('sealed.json meta.iter 越界');
  }
  if (typeof meta.note !== 'string') {
    throw new Error('sealed.json meta.note 非法');
  }
  const entries = doc.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('sealed.json 缺少 entries');
  }
  if (publicDoc && !sameKeys(Object.keys(entries), Object.keys(publicDoc.waybills || {}))) {
    throw new Error('sealed.json entries 与 public.json waybills 不一致');
  }
  for (const wb of Object.keys(entries)) {
    try {
      decodeEntry(entries[wb]);
    } catch (err) {
      throw new Error(`sealed.json 条目 ${wb} 形状非法`);
    }
  }
}

function parseEmbedded(text) {
  if (typeof text !== 'string') throw new Error('embedded.js 不可读');
  const start = text.indexOf(EMBEDDED_MARKER);
  if (start < 0) throw new Error('embedded.js 缺少 window.__PDA_IOT_DATA__ 赋值');
  const jsonStart = start + EMBEDDED_MARKER.length;
  const end = text.lastIndexOf(';');
  if (end <= jsonStart) throw new Error('embedded.js 结构非法');
  let parsed;
  try {
    parsed = JSON.parse(text.slice(jsonStart, end));
  } catch (err) {
    throw new Error('embedded.js 载荷不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('embedded.js 载荷不是对象');
  }
  return parsed;
}

function validateEmbedded(text, publicDoc, sealedDoc, tables) {
  const parsed = parseEmbedded(text);
  if (!sameKeys(Object.keys(parsed), EMBEDDED_KEYS)) {
    throw new Error('embedded.js 键必须且只能是 public/sealed/adSlots/materials/nodes');
  }
  const expected = {
    public: publicDoc,
    sealed: sealedDoc,
    adSlots: tables.adSlots,
    materials: tables.materials,
    nodes: tables.nodes,
  };
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error('embedded.js 与 public/sealed/查找表不一致');
  }
}

function assertNoPlaintext(text, phones, where) {
  if (/"labels"\s*:/.test(text)) throw new Error(`${where} 含明文 labels 键`);
  for (const phone of Object.values(phones || {})) {
    if (typeof phone === 'string' && phone && text.includes(phone)) {
      throw new Error(`${where} 含完整手机号`);
    }
  }
}

// ============================================================
// 六、CLI
// ============================================================

function displayPath(file) {
  return path.relative(H5_DIR, file).split(path.sep).join('/');
}

function readJSON(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`无法读取 ${displayPath(file)}（${err.code || err.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${displayPath(file)} 不是合法 JSON`);
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`无法读取 ${displayPath(file)}（${err.code || err.message}）`);
  }
}

function loadTables() {
  return {
    adSlots: readJSON(PATHS.adSlots),
    materials: readJSON(PATHS.materials),
    nodes: readJSON(PATHS.nodes),
  };
}

function readLabelsAndPhones() {
  const labelsDoc = readJSON(PATHS.labels);
  if (!labelsDoc || typeof labelsDoc !== 'object' || !labelsDoc.labels ||
      typeof labelsDoc.labels !== 'object' || Array.isArray(labelsDoc.labels)) {
    throw new Error('data-private/labels.json 缺少 labels 映射');
  }
  const phonesDoc = readJSON(PATHS.phones);

  const phones = {};
  for (const wb of Object.keys(labelsDoc.labels)) {
    const phone = normalizePhone(phonesDoc[wb]);
    if (!isValidPhone(phone)) {
      throw new Error(`运单 ${wb} 缺少合法演示手机号（见 data-private/demo_phones.json）`);
    }
    phones[wb] = phone;
  }
  return { labelsDoc: labelsDoc, phones: phones };
}

function legacyGuard(isFinal) {
  if (!fs.existsSync(PATHS.legacyLabels)) return;
  if (isFinal) {
    throw new Error('data/labels.json 仍存在；--final 要求先删除明文再生成');
  }
  console.warn('[WARN] data/labels.json 仍存在（本阶段允许；最终发布前删除并用 --final 重新生成）');
}

function describeLeaks(leaks) {
  return leaks.map((x) => x.kind + '=' + x.value).join('，');
}

function writeAtomic(outputs) {
  const suffix = '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const staged = outputs.map((o) => ({
    file: o.file,
    content: o.content,
    tmp: o.file + suffix,
  }));
  try {
    for (const o of staged) fs.writeFileSync(o.tmp, o.content, 'utf8');
    for (const o of staged) fs.renameSync(o.tmp, o.file);
  } catch (err) {
    for (const o of staged) {
      try { fs.unlinkSync(o.tmp); } catch (_) { /* 清理尽力而为 */ }
    }
    throw err;
  }
}

function generate(isFinal) {
  legacyGuard(isFinal);

  const { labelsDoc, phones } = readLabelsAndPhones();
  const tables = loadTables();

  const publicDoc = buildPublicDoc(labelsDoc, phones);
  const entries = {};
  for (const wb of Object.keys(labelsDoc.labels)) {
    entries[wb] = sealLabel(labelsDoc.labels[wb], phones[wb], wb);
  }
  const sealedDoc = buildSealedDoc(entries);

  const leaks = findLeaks(publicDoc, sealedDoc, tables, phones, labelsDoc);
  if (leaks.length) throw new Error('泄露检查失败：' + describeLeaks(leaks));

  validatePublicDoc(publicDoc);
  validateSealedDoc(sealedDoc, publicDoc);

  const embedded = buildEmbedded(publicDoc, sealedDoc, tables);
  validateEmbedded(embedded, publicDoc, sealedDoc, tables);
  assertNoPlaintext(embedded, phones, 'data/embedded.js');

  writeAtomic([
    { file: PATHS.public, content: JSON.stringify(publicDoc, null, 2) + '\n' },
    { file: PATHS.sealed, content: JSON.stringify(sealedDoc, null, 2) + '\n' },
    { file: PATHS.embedded, content: embedded },
  ]);

  console.log(`[ OK ] ${displayPath(PATHS.public)}（${Object.keys(publicDoc.waybills).length} 个运单）`);
  console.log(`[ OK ] ${displayPath(PATHS.sealed)}（${Object.keys(sealedDoc.entries).length} 个条目）`);
  console.log(`[ OK ] ${displayPath(PATHS.embedded)}`);
}

function check(isFinal) {
  legacyGuard(isFinal);

  const { labelsDoc, phones } = readLabelsAndPhones();
  const tables = loadTables();
  const publicDoc = readJSON(PATHS.public);
  const sealedDoc = readJSON(PATHS.sealed);
  const embedded = readText(PATHS.embedded);

  validatePublicDoc(publicDoc);
  validateSealedDoc(sealedDoc, publicDoc);

  const leaks = findLeaks(publicDoc, sealedDoc, tables, phones, labelsDoc);
  if (leaks.length) throw new Error('泄露检查失败：' + describeLeaks(leaks));

  validateEmbedded(embedded, publicDoc, sealedDoc, tables);
  assertNoPlaintext(embedded, phones, 'data/embedded.js');

  console.log(`[ OK ] public.json / sealed.json / embedded.js 校验通过` +
    `（${Object.keys(publicDoc.waybills).length} 个运单，无泄露）`);
}

function main(argv) {
  const flags = new Set();
  for (const arg of argv.slice(2)) {
    if (arg === '--final' || arg === '--check') flags.add(arg);
    else throw new Error('未知参数：' + arg + '\n用法：node tools/seal_data.js [--final] [--check]');
  }
  if (flags.has('--check')) check(flags.has('--final'));
  else generate(flags.has('--final'));
}

module.exports = {
  normalizePhone: normalizePhone,
  isValidPhone: isValidPhone,
  maskPhone: maskPhone,
  sealLabel: sealLabel,
  openSealed: openSealed,
  buildPublicDoc: buildPublicDoc,
  buildSealedDoc: buildSealedDoc,
  buildEmbedded: buildEmbedded,
  findLeaks: findLeaks,
};

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    console.error('[FAIL] ' + err.message);
    process.exitCode = 1;
  }
}
