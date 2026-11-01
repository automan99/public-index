#!/usr/bin/env node
/* 密封工具单测（Node 内置 assert，零 npm 依赖）。
 *
 * 覆盖：
 *   · 手机号归一化 / 校验 / 掩码；
 *   · AES-256-GCM 密封与解开（正确/错误手机号、跨运单 AAD、结构损坏）；
 *   · public / sealed / embedded 产物形状；
 *   · 泄露检查（public 完整手机号 / 路由码 / UID、查找表手机号、sealed 形状）。
 *
 * 用法：node tests/sign_tests.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');
const seal = require('../tools/seal_data');

function section(name) {
  console.log('--- ' + name + ' ---');
}

/* 在 Node VM 中加载 sign-api.js（无 DOM 依赖）。
 * opts.throwStorage：localStorage 读写一律抛错，验证内存回退；
 * opts.noCrypto：crypto 不提供 subtle，验证 CRYPTO 错误。 */
function loadSignApi(opts) {
  const o = opts || {};
  const store = new Map();
  const throwing = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
    clear() { throw new Error('SecurityError'); },
  };
  const localStorage = o.throwStorage ? throwing : {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const sandbox = {
    window: {}, console, localStorage,
    navigator: { userAgent: 'test', language: 'zh-CN' },
    screen: { width: 390, height: 844 }, Intl, TextEncoder, TextDecoder, atob, btoa,
    crypto: o.noCrypto ? {} : nodeCrypto.webcrypto,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sign-api.js'), 'utf8'), sandbox);
  return { api: sandbox.window.PdaSignApi, hooks: sandbox.window.__pdaSign, sandbox, store };
}

async function testSignApi() {
  section('sign-api：解密 / 限流 / 记录');

  const pub = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/public.json'), 'utf8'));
  const sealed = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/sealed.json'), 'utf8'));
  const demoPhones = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../data-private/demo_phones.json'), 'utf8'));
  const W = pub.meta.waybills[0];
  const W2 = pub.meta.waybills[1];
  const phone = demoPhones[W];

  // 接口与测试钩子齐全
  let { api, hooks, store } = loadSignApi();
  for (const key of ['configure', 'getPublic', 'unlock', 'getAttemptState', 'getRecord', 'sign',
    'isCryptoAvailable']) {
    assert.strictEqual(typeof api[key], 'function', 'PdaSignApi.' + key + ' 缺失');
  }
  for (const key of ['normalizePhone', 'isValidPhone', 'maskPhone', 'getAttemptState',
    'recordFailure', 'resetAttempts', 'buildSignRecord', 'attemptKey', 'recordKey']) {
    assert.strictEqual(typeof hooks[key], 'function', '__pdaSign.' + key + ' 缺失');
  }
  assert.strictEqual(hooks.attemptKey(W), 'pda_sign_attempts_' + W);
  assert.strictEqual(hooks.recordKey(W), 'pda_sign_' + W);
  assert.strictEqual(hooks.normalizePhone(' +86 138-0000-1111 '), '13800001111');
  assert.strictEqual(hooks.isValidPhone('12800001111'), false);
  assert.strictEqual(hooks.maskPhone('13800001111'), '138****1111');
  assert.strictEqual(api.isCryptoAvailable(), true);

  api.configure({ publicDoc: pub, sealedDoc: sealed });
  assert.strictEqual((await api.getPublic(W)).n, pub.waybills[W].n);
  assert.strictEqual((await api.getPublic(W)).phoneMask, pub.waybills[W].phoneMask);
  assert.strictEqual(await api.getPublic('不存在'), null);

  // 正确手机号（前后空格 / +86）
  let unlocked = await api.unlock({ waybill: W, phone: ' ' + phone + ' ' });
  assert.strictEqual(unlocked.detail.f.l.w, W);
  assert.match(unlocked.contentHash, /^[0-9a-f]{64}$/);
  const plus86 = await api.unlock({ waybill: W, phone: '+86 ' + phone });
  assert.strictEqual(plus86.detail.f.l.w, W);
  assert.strictEqual(plus86.contentHash, unlocked.contentHash);

  // 错误手机号扣次数；格式错误不扣；错误信息不含完整手机号
  const wrong = phone.slice(0, 10) + (phone[10] === '9' ? '8' : '9');
  await assert.rejects(() => api.unlock({ waybill: W, phone: wrong }), (e) => {
    assert.strictEqual(e.code, 'MISMATCH');
    assert.ok(!String(e.message).includes(phone));
    return true;
  });
  const failsAfterMismatch = hooks.getAttemptState(W).fails;
  assert.strictEqual(failsAfterMismatch, 1);
  await assert.rejects(() => api.unlock({ waybill: W, phone: '123' }),
    (e) => e.code === 'FORMAT');
  assert.strictEqual(hooks.getAttemptState(W).fails, failsAfterMismatch);

  // 成功清零
  await api.unlock({ waybill: W, phone });
  assert.strictEqual(hooks.getAttemptState(W).fails, 0);

  // 5 次失败锁定 15 分钟；到期解锁
  for (let i = 0; i < 5; i++) hooks.recordFailure(W2, 1000 + i);
  assert.strictEqual(hooks.getAttemptState(W2, 1005).locked, true);
  assert.strictEqual(hooks.getAttemptState(W2, 1005).remaining, 0);
  assert.strictEqual(hooks.getAttemptState(W2, 1004 + 15 * 60 * 1000 + 1).locked, false);
  assert.strictEqual(hooks.getAttemptState(W2, 1004 + 15 * 60 * 1000 + 1).fails, 0);

  // 锁定期间正确手机号也拒绝（用真实时间，unlock 不接受注入 now）
  const W3 = pub.meta.waybills[2];
  for (let i = 0; i < 5; i++) hooks.recordFailure(W3);
  await assert.rejects(() => api.unlock({ waybill: W3, phone: demoPhones[W3] }),
    (e) => e.code === 'LOCKED');
  hooks.resetAttempts(W3);

  // sealed meta 迭代次数非法 → DATA，且不扣尝试次数
  const beforeBadMeta = hooks.getAttemptState(W).fails;
  const tampered = JSON.parse(JSON.stringify(sealed));
  tampered.meta.iter = 99999999;
  api.configure({ publicDoc: pub, sealedDoc: tampered });
  await assert.rejects(() => api.unlock({ waybill: W, phone }), (e) => e.code === 'DATA');
  assert.strictEqual(hooks.getAttemptState(W).fails, beforeBadMeta);
  const badAlg = JSON.parse(JSON.stringify(sealed));
  badAlg.meta.alg = 'AES-CBC';
  api.configure({ publicDoc: pub, sealedDoc: badAlg });
  await assert.rejects(() => api.unlock({ waybill: W, phone }), (e) => e.code === 'DATA');

  // 跨运单密文（AAD）
  const cross = JSON.parse(JSON.stringify(sealed));
  cross.entries[W] = cross.entries[W2];
  api.configure({ publicDoc: pub, sealedDoc: cross });
  await assert.rejects(() => api.unlock({ waybill: W, phone: demoPhones[W2] }),
    (e) => e.code === 'MISMATCH');

  // localStorage 损坏：尝试状态视为从未尝试，记录视为不存在
  store.set('pda_sign_attempts_' + W, '{bad');
  assert.strictEqual(hooks.getAttemptState(W, 0).fails, 0);
  store.set('pda_sign_' + W, '{bad');
  assert.strictEqual(api.getRecord(W), null);

  // 幂等签收 + 记录形状 + 不落完整手机号
  api.configure({ publicDoc: pub, sealedDoc: sealed });
  const r1 = await api.sign({ waybill: W, detail: unlocked.detail,
    contentHash: unlocked.contentHash, phoneMask: pub.waybills[W].phoneMask, now: 5000 });
  const r2 = await api.sign({ waybill: W, detail: unlocked.detail,
    contentHash: unlocked.contentHash, phoneMask: pub.waybills[W].phoneMask, now: 6000 });
  assert.strictEqual(r1.eventId, r2.eventId);
  assert.strictEqual(r1.contentHash, r2.contentHash);
  const r3 = await api.sign({ waybill: W, detail: unlocked.detail, contentHash: 'b'.repeat(64),
    phoneMask: pub.waybills[W].phoneMask, now: 7000 });
  assert.strictEqual(r3.eventId, r1.eventId);
  assert.strictEqual(r3.contentHash, r1.contentHash);
  assert.strictEqual(r1.phoneMask, pub.waybills[W].phoneMask);
  assert.match(r1.device.fingerprintId, /^fp_[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(r1).includes(phone));

  // 即便误传完整手机号，记录也只落掩码
  const W4 = pub.meta.waybills[3];
  const r4 = await api.sign({ waybill: W4, detail: unlocked.detail,
    contentHash: unlocked.contentHash, phoneMask: demoPhones[W4], now: 9000 });
  assert.strictEqual(r4.phoneMask, pub.waybills[W4].phoneMask);
  assert.ok(!JSON.stringify(r4).includes(demoPhones[W4]));

  assert.strictEqual(r1.status, 'signed');
  assert.strictEqual(r1.waybill, W);
  assert.strictEqual(r1.verifyMethod, 'phone');
  assert.strictEqual(r1.sealVersion, '1');
  assert.strictEqual(r1.consentVersion, 'demo-v1');
  assert.strictEqual(r1.signedAt, new Date(5000).toISOString());
  assert.match(r1.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepStrictEqual(Object.keys(r1.device).sort(),
    ['deviceId', 'fingerprintHash', 'fingerprintId', 'language', 'platform', 'screen',
      'timezone', 'ua']);
  assert.strictEqual(r1.device.ua, 'test');
  assert.strictEqual(r1.device.language, 'zh-CN');
  assert.strictEqual(r1.device.screen, '390x844');
  assert.strictEqual(r1.device.platform, '');
  assert.strictEqual(typeof r1.device.timezone, 'string');
  assert.match(r1.device.fingerprintHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(r1.device.fingerprintId, 'fp_' + r1.device.fingerprintHash.slice(0, 8));
  assert.match(r1.device.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.strictEqual(api.getRecord(W).eventId, r1.eventId);
  assert.strictEqual(store.get('pda_sign_' + W), JSON.stringify(r1));
  assert.strictEqual(store.get('pda_device_id'), r1.device.deviceId);
  assert.strictEqual(hooks.getAttemptState(W).fails, 0);

  // buildSignRecord 钩子
  const built = hooks.buildSignRecord({ waybill: W, phoneMask: '138****0001',
    contentHash: 'a'.repeat(64), device: r1.device, signedAt: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(built.status, 'signed');
  assert.strictEqual(built.consentVersion, 'demo-v1');
  assert.strictEqual(built.sealVersion, '1');
  assert.match(built.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // localStorage 不可用：内存回退后仍可验证与签收
  const fallback = loadSignApi({ throwStorage: true });
  fallback.api.configure({ publicDoc: pub, sealedDoc: sealed });
  const u2 = await fallback.api.unlock({ waybill: W, phone });
  assert.strictEqual(u2.detail.f.l.w, W);
  assert.strictEqual(fallback.hooks.getAttemptState(W).fails, 0);
  const s2 = await fallback.api.sign({ waybill: W, detail: u2.detail,
    contentHash: u2.contentHash, phoneMask: pub.waybills[W].phoneMask, now: 8000 });
  assert.strictEqual(fallback.api.getRecord(W).eventId, s2.eventId);
  await assert.rejects(() => fallback.api.unlock({ waybill: W, phone: wrong }),
    (e) => e.code === 'MISMATCH');
  assert.strictEqual(fallback.hooks.getAttemptState(W).fails, 1);
  fallback.hooks.resetAttempts(W);
  assert.strictEqual(fallback.hooks.getAttemptState(W).fails, 0);

  // 并发签收（spec §7.2 二次读取）：两次并发只落一个 eventId，且都返回它
  const concurrent = loadSignApi();
  concurrent.api.configure({ publicDoc: pub, sealedDoc: sealed });
  const [c1, c2] = await Promise.all([
    concurrent.api.sign({ waybill: W, detail: unlocked.detail, contentHash: unlocked.contentHash,
      phoneMask: pub.waybills[W].phoneMask, now: 10000 }),
    concurrent.api.sign({ waybill: W, detail: unlocked.detail, contentHash: unlocked.contentHash,
      phoneMask: pub.waybills[W].phoneMask, now: 11000 }),
  ]);
  assert.strictEqual(c1.eventId, c2.eventId);
  assert.strictEqual(concurrent.api.getRecord(W).eventId, c1.eventId);
  const stored = JSON.parse(concurrent.store.get('pda_sign_' + W));
  assert.strictEqual(stored.eventId, c1.eventId);
  assert.ok([new Date(10000).toISOString(), new Date(11000).toISOString()].includes(
    stored.signedAt));

  // 无 subtle：明确报 CRYPTO，而不是静默失败
  const noCrypto = loadSignApi({ noCrypto: true });
  noCrypto.api.configure({ publicDoc: pub, sealedDoc: sealed });
  assert.strictEqual(noCrypto.api.isCryptoAvailable(), false);
  await assert.rejects(() => noCrypto.api.unlock({ waybill: W, phone }),
    (e) => e.code === 'CRYPTO');
}

async function main() {
  section('手机号归一化、校验与掩码');
  assert.strictEqual(seal.normalizePhone(' +86 138-0000-1111 '), '13800001111');
  assert.strictEqual(seal.normalizePhone('138 0000 1111'), '13800001111');
  assert.strictEqual(seal.normalizePhone('(138) 0000-1111'), '13800001111');
  assert.strictEqual(seal.normalizePhone('8613800001111'), '13800001111');
  assert.strictEqual(seal.normalizePhone('+8613800001111'), '13800001111');
  assert.strictEqual(seal.normalizePhone('861380000111'), '861380000111');
  assert.strictEqual(seal.isValidPhone('13800001111'), true);
  assert.strictEqual(seal.isValidPhone('12800001111'), false);
  assert.strictEqual(seal.isValidPhone('138000011111'), false);
  assert.strictEqual(seal.maskPhone('13800001111'), '138****1111');

  section('密封与解开');
  const sample = { v: '2', t: 'pda-iot-label',
    f: { l: { w: 'W1', n: '物品', g: '1kg' }, r: { c: '350503' },
         i: { s: '0123456789abcdef', r: 'fedcba9876543210' } },
    o: { ts: 't', tcn: 1, d: 'DEV' } };
  const entry = seal.sealLabel(sample, '13800001111', 'W1');
  assert.deepStrictEqual(Object.keys(entry).sort(), ['ciphertext', 'iv', 'salt']);
  assert.strictEqual(Buffer.from(entry.salt, 'base64').length, 16);
  assert.strictEqual(Buffer.from(entry.iv, 'base64').length, 12);
  assert.ok(Buffer.from(entry.ciphertext, 'base64').length >= 16);
  assert.strictEqual(seal.openSealed(entry, '13800001111', 'W1'), JSON.stringify(sample));
  assert.throws(() => seal.openSealed(entry, '13900001111', 'W1'));
  assert.throws(() => seal.openSealed(entry, '13800001111', 'W2'), /AAD|unable|auth/i);
  assert.throws(() => seal.openSealed({ ...entry, salt: 'x' }, '13800001111', 'W1'));

  // 结构问题统一抛 Error('DATA')；GCM 认证失败保留底层错误。
  assert.throws(() => seal.openSealed({ ...entry, iv: 'AAAA' }, '13800001111', 'W1'),
    (e) => e.message === 'DATA');
  assert.throws(() => seal.openSealed({ ...entry, extra: 1 }, '13800001111', 'W1'),
    (e) => e.message === 'DATA');
  assert.throws(() => seal.openSealed(null, '13800001111', 'W1'),
    (e) => e.message === 'DATA');

  // 契约版本进入 AAD。
  const v3 = seal.sealLabel(sample, '13800001111', 'W1', '3');
  assert.throws(() => seal.openSealed(v3, '13800001111', 'W1'));
  assert.strictEqual(seal.openSealed(v3, '13800001111', 'W1', '3'), JSON.stringify(sample));

  section('产物形状');
  const labelDoc = {
    labels: {
      W1: {
        v: '2',
        t: 'pda-iot-label',
        f: {
          l: { w: 'W1', n: '物品', g: '1kg' },
          r: { c: '350503' },
          i: { s: '0123456789abcdef', r: 'fedcba9876543210' },
          m: { cd: { service: '次日达' } },
        },
        o: { ts: 't', tcn: 1, d: 'DEV' },
      },
    },
  };
  const phones = { W1: '13800001111' };
  const publicDoc = seal.buildPublicDoc(labelDoc, phones);
  assert.deepStrictEqual(
    Object.keys(publicDoc.waybills.W1).sort(),
    ['g', 'n', 'phoneMask', 'service', 'w']);
  assert.strictEqual(publicDoc.waybills.W1.phoneMask, '138****1111');
  assert.strictEqual(publicDoc.waybills.W1.service, '次日达');
  assert.deepStrictEqual(publicDoc.meta.waybills, ['W1']);
  assert.throws(() => seal.buildPublicDoc(labelDoc, {}), /手机号/);

  const sealedDoc = seal.buildSealedDoc({ W1: entry });
  assert.strictEqual(sealedDoc.meta.iter, 600000);
  assert.strictEqual(sealedDoc.meta.alg, 'AES-256-GCM');
  assert.strictEqual(sealedDoc.meta.kdf, 'PBKDF2-SHA256');
  assert.strictEqual(entry, sealedDoc.entries.W1);

  const tables = { adSlots: {}, materials: {}, nodes: {} };
  const embedded = seal.buildEmbedded(publicDoc, sealedDoc, tables);
  assert.ok(embedded.includes('window.__PDA_IOT_DATA__'));
  assert.ok(embedded.includes('"public"'));
  assert.ok(embedded.includes('"sealed"'));
  assert.ok(embedded.includes('"adSlots"'));
  assert.ok(embedded.includes('"materials"'));
  assert.ok(embedded.includes('"nodes"'));
  assert.ok(!/"labels"\s*:/.test(embedded));
  assert.ok(!embedded.includes('13800001111'));

  section('泄露检查');
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

  // 查找表只查完整手机号：节点码出现在表里是合法的。
  const tableLeaks = seal.findLeaks(
    { waybills: {} },
    { meta: { iter: 600000 }, entries: {} },
    { adSlots: {}, materials: {}, nodes: { nodes: { '350503': { name: '节点' } } } },
    {},
    { labels: {} }
  );
  assert.strictEqual(tableLeaks.length, 0);
  const tablePhone = seal.findLeaks(
    { waybills: {} },
    { meta: { iter: 600000 }, entries: {} },
    { adSlots: { slots: { A01: { body: '13800001111' } } }, materials: {}, nodes: {} },
    { W1: '13800001111' },
    { labels: {} }
  );
  assert.ok(tablePhone.some((x) => x.kind === 'phone'));

  // sealed 条目只允许 salt / iv / ciphertext。
  const badEntry = JSON.parse(JSON.stringify(sealedDoc));
  badEntry.entries.W1.plain = 'x';
  const shapeLeaks = seal.findLeaks(
    { waybills: {} }, badEntry, { adSlots: {}, materials: {}, nodes: {} },
    { W1: '13800001111' }, { labels: { W1: sample } }
  );
  assert.ok(shapeLeaks.some((x) => x.kind === 'sealed'));

  await testSignApi();

  console.log('');
  console.log('sign_tests: 全部通过。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
