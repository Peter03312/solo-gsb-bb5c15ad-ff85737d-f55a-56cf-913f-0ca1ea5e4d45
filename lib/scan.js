'use strict';

/**
 * 现场扫描采样导入：把无表头两列 CSV（频率 MHz、电平 dBm）转换为占用区间。
 *
 * 纯函数、不触碰数据库——原始采样数据不入库，生成的区间仅随协调请求临时使用。
 *
 * 处理规则：
 *   - 整批校验：频率/电平均为有限数值、采样间隔为正数、非空记录不超过 1000 条；
 *     任一记录非法即整体拒绝，错误消息指出行号（行号对应粘贴文本，空行也计数）。
 *   - 同一频点（按 Hz 精度归并）多条记录取最高电平，再按频率升序处理。
 *   - 电平达到阈值（>=）的频点扩展为 [f − step/2, f + step/2] 闭区间。
 *   - 相交或端点相接的区间合并（复用 normalizeOccupiedBands 的闭区间合并语义）。
 */

const { mhzToHz, normalizeOccupiedBands } = require('./intermod');

/** 非空采样记录上限 */
const MAX_SCAN_ROWS = 1000;

/**
 * 解析扫描采样并生成占用区间。
 *
 * @param {string} csv 无表头两列 CSV 文本：每行「频率 MHz, 电平 dBm」
 * @param {number} stepMhz 采样间隔（MHz，必须为正的有限数值）
 * @param {number} thresholdDbm 占用阈值（dBm，电平 >= 阈值视为占用）
 * @returns {{points:number, unique:number, triggered:number,
 *            step:number, threshold:number,
 *            bands:Array<{lo:number, hi:number}>}}
 *          points 非空记录数；unique 去重后频点数；triggered 达到阈值的频点数；
 *          bands 合并后的占用区间（MHz，按下限升序）
 * @throws {Error} 校验失败，消息含行号或具体原因
 */
function scanToBands(csv, stepMhz, thresholdDbm) {
  if (typeof csv !== 'string') {
    throw new Error('扫描数据必须是 CSV 文本（无表头两列：频率 MHz, 电平 dBm）');
  }
  const step = Number(stepMhz);
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error('采样间隔必须为正数（MHz）');
  }
  const threshold = Number(thresholdDbm);
  if (!Number.isFinite(threshold)) {
    throw new Error('占用阈值必须是有限数值（dBm）');
  }

  // 整批解析：任一记录非法即整体拒绝并指出行号；空行不计入记录数
  const samples = [];
  const lines = csv.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === '') continue;
    const lineNo = i + 1;
    const cols = text.split(',').map((c) => c.trim());
    if (cols.length !== 2 || cols[0] === '' || cols[1] === '') {
      throw new Error(`第 ${lineNo} 行格式错误：应为两列「频率 MHz, 电平 dBm」`);
    }
    const freq = Number(cols[0]);
    const level = Number(cols[1]);
    if (!Number.isFinite(freq) || !Number.isFinite(level)) {
      throw new Error(`第 ${lineNo} 行数值无效：频率与电平必须是有限数值`);
    }
    samples.push({ freq, level });
  }
  if (samples.length === 0) {
    throw new Error('扫描数据为空：请粘贴至少一条「频率 MHz, 电平 dBm」记录');
  }
  if (samples.length > MAX_SCAN_ROWS) {
    throw new Error(`采样记录过多：共 ${samples.length} 条非空记录，最多支持 ${MAX_SCAN_ROWS} 条`);
  }

  // 同频点取最高电平（按 Hz 精度归并，避免浮点误差），按频率升序
  const peakByFreqHz = new Map();
  for (const s of samples) {
    const freqHz = mhzToHz(s.freq);
    const prev = peakByFreqHz.get(freqHz);
    if (prev === undefined || s.level > prev) peakByFreqHz.set(freqHz, s.level);
  }
  const sorted = [...peakByFreqHz.entries()].sort((a, b) => a[0] - b[0]);

  // 达到阈值的频点 → 中心 ± 半个采样间隔的闭区间；相交或相接区间合并
  const raw = [];
  for (const [freqHz, level] of sorted) {
    if (level < threshold) continue;
    const center = freqHz / 1e6;
    raw.push({ lo: center - step / 2, hi: center + step / 2 });
  }
  const bands = normalizeOccupiedBands(raw);

  return {
    points: samples.length,
    unique: sorted.length,
    triggered: raw.length,
    step,
    threshold,
    bands,
  };
}

module.exports = { scanToBands, MAX_SCAN_ROWS };
