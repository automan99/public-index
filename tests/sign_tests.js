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
const seal = require('../tools/seal_data');

function section(name) {
  console.log('--- ' + name + ' ---');
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

  console.log('');
  console.log('sign_tests: 全部通过。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
