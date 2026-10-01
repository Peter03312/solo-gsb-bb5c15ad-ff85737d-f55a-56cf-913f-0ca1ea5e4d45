'use strict';

// 现场扫描采样导入测试：lib/scan.js 纯函数 + POST /api/scan/intervals 接口。
// 使用独立临时 DATA_DIR，通过 HTTP 调用导出的 app（监听随机端口）。
process.env.DATA_DIR = require('node:path').join(
  require('node:os').tmpdir(),
  `mic-scan-test-${process.pid}-${Date.now()}`,
);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../db');
const app = require('../server');
const { scanToBands, MAX_SCAN_ROWS } = require('../lib/scan');

/* ---------- 纯函数：解析与区间生成 ---------- */

test('扫描导入：达到阈值（>=）的频点扩展为中心 ± 半个采样间隔的闭区间', () => {
  const r = scanToBands('500.000, -80\n500.100, -90\n500.200, -80', 0.1, -80);
  assert.equal(r.points, 3);
  assert.equal(r.unique, 3);
  assert.equal(r.triggered, 2); // -80 达到阈值（含等于），-90 未达到
  assert.deepEqual(r.bands, [
    { lo: 499.95, hi: 500.05 },
    { lo: 500.15, hi: 500.25 },
  ]);
  assert.equal(r.step, 0.1);
  assert.equal(r.threshold, -80);
});

test('扫描导入：同频点取最高电平，决定是否达到阈值', () => {
  // 同一频点两条记录，最高电平 -70 达到阈值
  const hit = scanToBands('500, -90\n500, -70', 0.1, -80);
  assert.equal(hit.points, 2);
  assert.equal(hit.unique, 1);
  assert.equal(hit.triggered, 1);
  assert.deepEqual(hit.bands, [{ lo: 499.95, hi: 500.05 }]);

  // 最高电平 -85 未达到阈值 → 无区间
  const miss = scanToBands('500, -90\n500, -85', 0.1, -80);
  assert.equal(miss.triggered, 0);
  assert.deepEqual(miss.bands, []);
});

test('扫描导入：乱序输入按频率排序，相交区间合并', () => {
  const r = scanToBands('500.10, -70\n500.00, -70\n500.05, -70\n500.30, -70', 0.1, -80);
  assert.deepEqual(r.bands, [
    { lo: 499.95, hi: 500.15 }, // 500.00 / 500.05 / 500.10 三点区间相交合并
    { lo: 500.25, hi: 500.35 },
  ]);
});

test('扫描导入：端点相接（间隔恰好一个采样间隔）的区间也合并', () => {
  // [499.95, 500.05] 与 [500.05, 500.15] 在 500.05 相接 → 合并
  const r = scanToBands('500.0, -70\n500.1, -70', 0.1, -80);
  assert.deepEqual(r.bands, [{ lo: 499.95, hi: 500.15 }]);
});

test('扫描导入：空行与 CRLF 兼容，空行不计入记录数', () => {
  const r = scanToBands('\r\n500, -70\r\n\r\n501, -90\r\n', 0.1, -80);
  assert.equal(r.points, 2);
  assert.equal(r.unique, 2);
  assert.equal(r.triggered, 1);
  assert.deepEqual(r.bands, [{ lo: 499.95, hi: 500.05 }]);
});

test('扫描导入校验：非法行指出行号（行号含空行）', () => {
  assert.throws(() => scanToBands('500, -80\nabc, -70', 0.1, -80), /第 2 行/);
  assert.throws(() => scanToBands('500, -80\n\n\n500.1', 0.1, -80), /第 4 行/);
  assert.throws(() => scanToBands('500, -80, 1', 0.1, -80), /第 1 行/);
  assert.throws(() => scanToBands('500,', 0.1, -80), /第 1 行/);
  assert.throws(() => scanToBands('500, NaN', 0.1, -80), /第 1 行/);
  assert.throws(() => scanToBands('Infinity, -80', 0.1, -80), /第 1 行/);
});

test('扫描导入校验：间隔必须为正、阈值必须有限、空数据与非文本拒绝', () => {
  assert.throws(() => scanToBands('500, -80', 0, -80), /采样间隔/);
  assert.throws(() => scanToBands('500, -80', -0.1, -80), /采样间隔/);
  assert.throws(() => scanToBands('500, -80', NaN, -80), /采样间隔/);
  assert.throws(() => scanToBands('500, -80', 0.1, 'x'), /占用阈值/);
  assert.throws(() => scanToBands('500, -80', 0.1, Infinity), /占用阈值/);
  assert.throws(() => scanToBands('   \n \n', 0.1, -80), /为空/);
  assert.throws(() => scanToBands(123, 0.1, -80), /CSV/);
});

test('扫描导入校验：非空记录最多 1000 条（空行不计）', () => {
  const okCsv = Array.from({ length: MAX_SCAN_ROWS }, (_, i) => `${400 + i * 0.1}, -70`).join('\n');
  const ok = scanToBands(okCsv, 0.1, -80);
  assert.equal(ok.points, MAX_SCAN_ROWS);
  assert.equal(ok.unique, MAX_SCAN_ROWS);

  const tooMany = `${okCsv}\n${400 + MAX_SCAN_ROWS * 0.1}, -70\n\n\n`; // 尾部空行不计
  assert.throws(() => scanToBands(tooMany, 0.1, -80), /1000/);
});

/* ---------- HTTP 接口 ---------- */

let server;
let port;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  db.exec('DELETE FROM devices; DELETE FROM plans;');
});

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('接口：合法采样返回合并区间与统计，且不写入任何数据', async () => {
  const res = await request('POST', '/api/scan/intervals', {
    csv: '512.000, -85\n512.000, -70\n512.100, -75\n520.000, -95',
    step: 0.1,
    threshold: -80,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.points, 4);
  assert.equal(res.data.unique, 3);
  assert.equal(res.data.triggered, 2);
  // 512.000（最高 -70）与 512.100（-75）达阈值，两区间在 512.05 相接合并；520.000 未达阈值
  assert.deepEqual(res.data.bands, [{ lo: 511.95, hi: 512.15 }]);

  // 原始采样不入库：设备与方案表均无变化
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM devices').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plans').get().c, 0);
});

test('接口：非法输入返回 400 并指出行号或原因', async () => {
  const badRow = await request('POST', '/api/scan/intervals', {
    csv: '512, -80\n512.1, abc', step: 0.1, threshold: -80,
  });
  assert.equal(badRow.status, 400);
  assert.match(badRow.data.error, /第 2 行/);

  const badStep = await request('POST', '/api/scan/intervals', {
    csv: '512, -80', step: 0, threshold: -80,
  });
  assert.equal(badStep.status, 400);
  assert.match(badStep.data.error, /采样间隔/);

  const badThreshold = await request('POST', '/api/scan/intervals', {
    csv: '512, -80', step: 0.1,
  });
  assert.equal(badThreshold.status, 400);
  assert.match(badThreshold.data.error, /占用阈值/);

  const notString = await request('POST', '/api/scan/intervals', {
    csv: 42, step: 0.1, threshold: -80,
  });
  assert.equal(notString.status, 400);
});

test('接口：扫描区间与手填占用区间合并送入协调流程，合并结果随方案保存', async () => {
  const dev = await request('POST', '/api/devices', { name: 'A', frequency: 500, guard: 0.25, locked: false });
  assert.equal(dev.status, 201);

  // 扫描导入生成 [499.8, 500.2]；手填一条与之相接的 [500.2, 500.4] → 服务端合并为 [499.8, 500.4]
  const scan = await request('POST', '/api/scan/intervals', { csv: '500, -70', step: 0.4, threshold: -80 });
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.data.bands, [{ lo: 499.8, hi: 500.2 }]);

  const res = await request('POST', '/api/coordinate', {
    bandMin: 490, bandMax: 510, step: 0.025, maxOffset: 2,
    occupiedBands: [...scan.data.bands, { lo: 500.2, hi: 500.4 }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.solved, true);
  assert.deepEqual(res.data.params.occupiedBands, [{ lo: 499.8, hi: 500.4 }]);
  // 新载频保护区（±0.25）避开合并后的占用区间
  const f = res.data.assignments[0].frequency;
  assert.ok(f + 0.25 < 499.8 || f - 0.25 > 500.4);

  // 保存方案时记录的是合并后的区间
  const saved = await request('POST', '/api/plans', {
    name: '扫描避让方案',
    params: res.data.params,
    assignments: res.data.assignments,
    totalOffset: res.data.totalOffset,
    solved: res.data.solved,
  });
  assert.equal(saved.status, 201);
  const plans = await request('GET', '/api/plans');
  assert.deepEqual(plans.data[0].params.occupiedBands, [{ lo: 499.8, hi: 500.4 }]);
});
