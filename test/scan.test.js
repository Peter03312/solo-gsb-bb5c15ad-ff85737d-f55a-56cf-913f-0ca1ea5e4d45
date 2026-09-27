'use strict';

// 现场扫描采样导入测试：lib/scan 纯函数 + POST /api/scan/import 接口。
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
const { importScanSamples, parseScanCsv, ScanValidationError, MAX_SCAN_SAMPLES } = require('../lib/scan');

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

/* ---------- lib/scan 纯函数 ---------- */

test('达到阈值的频点扩展为中心 ± 半个采样间隔的闭区间，未达到的不生成', () => {
  const text = '500.000,-85.3\n500.025,-72.1\n500.050,-90';
  const r = importScanSamples(text, 0.025, -80);
  assert.equal(r.sampleCount, 3);
  assert.equal(r.pointCount, 3);
  // 仅 500.025（-72.1 ≥ -80）占用 → [500.0125, 500.0375]
  assert.deepEqual(r.bands, [{ lo: 500.0125, hi: 500.0375 }]);
});

test('电平恰好等于阈值（闭区间语义，≥）也算占用', () => {
  const r = importScanSamples('500,-80', 0.025, -80);
  assert.deepEqual(r.bands, [{ lo: 499.9875, hi: 500.0125 }]);
});

test('同频点取最高电平（高电平达阈值时占用，低电平不影响）', () => {
  // 同一频点两条：-90 不达标、-70 达标 → 取 -70 → 占用
  const r = importScanSamples('500,-90\n500,-70', 0.025, -80);
  assert.equal(r.sampleCount, 2);
  assert.equal(r.pointCount, 1);
  assert.equal(r.bands.length, 1);

  // 反过来也是 -70 生效
  const r2 = importScanSamples('500,-70\n500,-90', 0.025, -80);
  assert.equal(r2.bands.length, 1);

  // 最高电平仍低于阈值 → 不占用
  const r3 = importScanSamples('500,-90\n500,-81', 0.025, -80);
  assert.deepEqual(r3.bands, []);
});

test('相邻采样点的区间端点相接时合并为一个闭区间', () => {
  // 500 与 500.025 均占用，间隔 0.025：
  // [499.9875, 500.0125] 与 [500.0125, 500.0375] 端点相接 → 合并
  const r = importScanSamples('500,-70\n500.025,-70', 0.025, -80);
  assert.deepEqual(r.bands, [{ lo: 499.9875, hi: 500.0375 }]);
});

test('相交区间合并，不相交区间保留；结果按频率排序', () => {
  // 大间隔 1 MHz：500→[499.5,500.5]、501→[500.5,501.5] 相接合并；
  // 520→[519.5,520.5] 独立。输入故意乱序
  const r = importScanSamples('520,-70\n500,-70\n501,-70', 1, -80);
  assert.deepEqual(r.bands, [
    { lo: 499.5, hi: 501.5 },
    { lo: 519.5, hi: 520.5 },
  ]);
});

test('空行（含 CRLF、纯空白行）忽略；制表符分隔也可解析', () => {
  const text = '\r\n  \n500.000\t-70.5\r\n\n500.025,-90\n';
  const r = importScanSamples(text, 0.025, -80);
  assert.equal(r.sampleCount, 2);
  assert.deepEqual(r.bands, [{ lo: 499.9875, hi: 500.0125 }]);
});

test('没有电平达标的频点：合法但返回空区间', () => {
  const r = importScanSamples('500,-90\n500.025,-91', 0.025, -80);
  assert.deepEqual(r.bands, []);
});

test('逐行错误：列数不对、空列、非数值均指出行号并一次性收集', () => {
  const text = [
    '500,-70', // 1 OK
    '500.025', // 2 只有一列
    '500.050,', // 3 第二列空
    'abc,-70', // 4 频率非数值
    '500.1,-70,1', // 5 三列
  ].join('\n');
  const { records, errors } = parseScanCsv(text);
  assert.equal(records.length, 1);
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4, 5]);
});

test('importScanSamples 整批校验失败抛出含行号的 ScanValidationError', () => {
  assert.throws(
    () => importScanSamples('500,-70\n500.025,abc', 0.025, -80),
    (e) => {
      assert.ok(e instanceof ScanValidationError);
      assert.ok(e.errors.some((x) => x.line === 2));
      assert.match(e.message, /第 2 行/);
      return true;
    },
  );

  // 采样间隔非正数
  assert.throws(() => importScanSamples('500,-70', 0, -80), /采样间隔必须是正数/);
  assert.throws(() => importScanSamples('500,-70', -1, -80), /采样间隔必须是正数/);
  assert.throws(() => importScanSamples('500,-70', NaN, -80), /采样间隔必须是正数/);

  // 阈值非有限数值
  assert.throws(() => importScanSamples('500,-70', 0.025, NaN), /占用阈值必须是有限数值/);

  // 完全没有非空记录
  assert.throws(() => importScanSamples('  \n\n', 0.025, -80), /没有任何非空采样记录/);
});

test(`非空记录超过 ${MAX_SCAN_SAMPLES} 条：整批拒绝`, () => {
  const text = Array.from({ length: MAX_SCAN_SAMPLES + 1 }, (_, i) => `500.${String(i).padStart(6, '0')},-70`).join('\n');
  assert.throws(
    () => importScanSamples(text, 0.025, -80),
    new RegExp(`最多 ${MAX_SCAN_SAMPLES} 条`),
  );

  // 恰好上限可以通过
  const ok = Array.from({ length: MAX_SCAN_SAMPLES }, () => '500,-90').join('\n');
  const r = importScanSamples(ok, 0.025, -80);
  assert.equal(r.sampleCount, MAX_SCAN_SAMPLES);
});

/* ---------- POST /api/scan/import ---------- */

test('接口：合法采样返回区间与统计，且不写入任何数据', () => {
  const devicesBefore = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  const plansBefore = db.prepare('SELECT COUNT(*) AS c FROM plans').get().c;
  return request('POST', '/api/scan/import', {
    text: '500,-70\n500.025,-70',
    interval: 0.025,
    threshold: -80,
  }).then((res) => {
    assert.equal(res.status, 200, res.data.error);
    assert.deepEqual(res.data.bands, [{ lo: 499.9875, hi: 500.0375 }]);
    assert.equal(res.data.sampleCount, 2);
    assert.equal(res.data.pointCount, 2);
    assert.equal(res.data.interval, 0.025);
    assert.equal(res.data.threshold, -80);
    // 原始采样不入库
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM devices').get().c, devicesBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plans').get().c, plansBefore);
  });
});

test('接口：逐行/整批错误返回 400 并附行号明细', async () => {
  const res = await request('POST', '/api/scan/import', {
    text: '500,-70\nx,-80\n\n500.05,-900',
    interval: 0,
    threshold: 'nope',
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.data.errors));
  assert.ok(res.data.errors.some((e) => e.line === 2));
  assert.ok(res.data.errors.some((e) => e.message.includes('采样间隔')));
  assert.ok(res.data.errors.some((e) => e.message.includes('占用阈值')));
  assert.match(res.data.error, /第 2 行/);
});

test('接口：text 不是字符串 → 400', async () => {
  const res = await request('POST', '/api/scan/import', { text: 123, interval: 0.025, threshold: -80 });
  assert.equal(res.status, 400);
});

test('端到端：扫描生成的区间与手填区间合并后送入协调流程', async () => {
  // 两个设备：500 与 510；扫描占用 500 附近（[499.9875, 500.0125]），
  // 手填占用 [500.0125, 500.1] 与其相接 → 服务端合并为 [499.9875, 500.1]
  await request('POST', '/api/devices', { name: 'A', frequency: 500, guard: 0.25 });
  await request('POST', '/api/devices', { name: 'B', frequency: 510, guard: 0.25 });

  const scan = await request('POST', '/api/scan/import', {
    text: '500,-70',
    interval: 0.025,
    threshold: -80,
  });
  assert.equal(scan.status, 200);
  const occupiedBands = scan.data.bands.concat([{ lo: 500.0125, hi: 500.1 }]);

  const coord = await request('POST', '/api/coordinate', {
    bandMin: 470, bandMax: 608, step: 0.025, maxOffset: 5, occupiedBands,
  });
  assert.equal(coord.status, 200, coord.data.error);
  // params.occupiedBands 为合并后的区间（保存方案时记录的就是它）
  assert.deepEqual(coord.data.params.occupiedBands, [{ lo: 499.9875, hi: 500.1 }]);
  // A 的保护区 [499.75, 500.25] 与合并区间相交 → A 必须被挪开 500
  const a = coord.data.assignments.find((x) => x.name === 'A');
  assert.notEqual(a.frequency, 500);
});
