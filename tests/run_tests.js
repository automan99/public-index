#!/usr/bin/env node
/* 读取端纯函数单测（无需浏览器、无需硬件）。
 *
 * 覆盖的是验收标准里最容易翻车的几条「不变量式」要求：
 *   · AC-03 / BR-05  无效标签必须给可读提示，**不得崩溃**
 *   · §5.4           指针查不到必须**降级为占位文案**，不得留空或报错
 *   · INV-1          全路由编码必须能每 6 位无损切分还原节点
 *   · AC-10 / INV-5  空值不落标签
 *
 * 用法：node reader-h5/tests/run_tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const H5_DIR = path.resolve(__dirname, '..');
const REPO = path.resolve(H5_DIR, '..');

// app.js 是浏览器脚本，这里在沙箱里加载：只给 window，不给 document，
// 于是它注册完测试钩子就返回，不跑 boot()。
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(H5_DIR, 'app.js'), 'utf8'), sandbox,
  { filename: 'app.js' });
const api = sandbox.window.__pdaIot;

if (!api) {
  console.error('未拿到测试钩子 window.__pdaIot —— app.js 的结构变了？');
  process.exit(2);
}

const labels = JSON.parse(fs.readFileSync(path.join(H5_DIR, 'data', 'labels.json'), 'utf8')).labels;
const nodes = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'nodes.json'), 'utf8'));
const adSlots = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'adSlots.json'), 'utf8'));
const materials = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'materials.json'), 'utf8'));

let fail = 0;
function check(desc, cond, detail) {
  if (cond) { console.log(`  OK   ${desc}`); return; }
  fail++;
  console.log(`  FAIL ${desc}`);
  if (detail !== undefined) console.log(`       ${detail}`);
}

const clone = (o) => JSON.parse(JSON.stringify(o));

console.log('读取端纯函数单测');

console.log('--- AC-03 / BR-05：无效标签不得崩溃 ---');
check('空对象被拒', api.validate({}).errors.length > 0);
check('非对象被拒', api.validate(null).errors.length > 0);
check('别的标签（类型不符）被拒',
  api.validate({ v: '2', t: 'text/plain' }).errors.length > 0);
check('版本未知提示升级',
  api.validate({ v: '99', t: 'pda-iot-label' }).errors[0].includes('更新读取端'),
  JSON.stringify(api.validate({ v: '99', t: 'pda-iot-label' })));
check('明文手机号当 UID 会被拒（INV-2 / BR-03）',
  api.validate(Object.assign(clone(labels['202608080001']), {})).errors.length === 0 &&
  (() => { const b = clone(labels['202608080001']); b.f.i.s = '13800001234';
           return api.validate(b).errors.some((e) => e.includes('f.i.s')); })());

console.log('--- 合法载荷全部通过 ---');
for (const [wb, label] of Object.entries(labels)) {
  const v = api.validate(label);
  check(`${wb} 无错误`, v.errors.length === 0, JSON.stringify(v.errors));
  check(`${wb} 无告警`, v.warnings.length === 0, JSON.stringify(v.warnings));
}

console.log('--- §5.4：指针查不到必须降级，不得留空 ---');
check('广告指针命中素材表',
  api.resolveAd('A03', adSlots).found && api.resolveAd('A03', adSlots).title.includes('冷链'));
const missAd = api.resolveAd('A99', adSlots);
check('广告指针落空 → 占位文案', !missAd.found && missAd.placeholder === '广告位 A99',
  JSON.stringify(missAd));
check('素材指针落空 → 占位文案', api.resolveMaterial('M999', materials).placeholder === '验货素材 M999');
check('素材指针命中', api.resolveMaterial('M002', materials).found);
const missNode = api.resolveNode('999999', nodes);
check('节点码落空 → 回退为码值本身', !missNode.found && missNode.name === '节点 999999');

console.log('--- INV-1：全路由编码 6 位切分无损 ---');
for (const code of ['350503100009100096', '100096350503', '350503361000100009100096']) {
  const back = api.routeNodesOf(code).join('');
  check(`${code} 切分回拼一致（${api.routeNodesOf(code).length} 段）`, back === code);
}

console.log('--- INV-5 / INV-6 / INV-1 告警（不阻断展示） ---');
const dirty = clone(labels['202608080001']);
dirty.o.tr = '';
check('INV-5 空串被标记为告警', api.validate(dirty).warnings.some((w) => w.includes('INV-5')));
const marked = clone(labels['202608080001']);
marked.f.dev = '1';
check('INV-6 写入端策略标记被标记为告警',
  api.validate(marked).warnings.some((w) => w.includes('INV-6')),
  JSON.stringify(api.validate(marked).warnings));
const badRoute = clone(labels['202608080001']);
badRoute.f.r.c = '35050';
check('INV-1 非法路由编码是错误（不是告警）',
  api.validate(badRoute).errors.some((e) => e.includes('f.r.c')));

console.log('--- 转义：标签内容是不可信输入 ---');
check('HTML 被转义', api.esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;');

console.log('');
if (fail) { console.log(`结论：${fail} 项失败。`); process.exit(1); }
console.log('结论：全部通过。');
