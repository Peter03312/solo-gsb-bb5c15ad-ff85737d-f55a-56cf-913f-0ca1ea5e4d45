'use strict';

/**
 * 现场扫描采样导入（纯函数，无外部依赖）。
 *
 * 输入为无表头的两列文本（CSV，逗号分隔；制表符也兼容）：
 *   第 1 列频率 MHz、第 2 列电平 dBm，每行一条采样，空行忽略。
 *
 * 整批校验：采样间隔须为正数；两列均须为有限数值；非空记录最多 1000 条；
 * 任一错误都以行号指出，全部收集后一次性抛出（ScanValidationError.errors）。
 *
 * 转换规则：同频点取最高电平；按频率升序排序；电平达到（≥）占用阈值的频点
 * 扩展为中心 ± 半个采样间隔的闭区间；相交或端点相接的区间自动合并
 * （合并口径与 normalizeOccupiedBands 一致，闭区间、Hz 精度）。
 */

const { mhzToHz, hzToMhz, normalizeOccupiedBands } = require('./intermod');

const MAX_SCAN_SAMPLES = 1000;

class ScanValidationError extends Error {
  /** @param {Array<{line:number|null, message:string}>} errors */
  constructor(errors) {
    super(errors.map((e) => (e.line ? `第 ${e.line} 行：${e.message}` : e.message)).join('；'));
    this.name = 'ScanValidationError';
    this.errors = errors;
  }
}

/**
 * 解析两列采样文本。
 *
 * @param {string} text
 * @returns {{records: Array<{line:number, frequency:number, level:number}>, errors: Array<{line:number, message:string}>}}
 */
function parseScanCsv(text) {
  const records = [];
  const errors = [];
  const lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '') return; // 空行（含纯空白行）忽略，不计数
    const cols = trimmed.split(/[,\t]/).map((c) => c.trim());
    if (cols.length !== 2 || cols.some((c) => c === '')) {
      errors.push({ line, message: '应为「频率, 电平」两列数值（无表头，逗号分隔）' });
      return;
    }
    const frequency = Number(cols[0]);
    const level = Number(cols[1]);
    if (!Number.isFinite(frequency) || !Number.isFinite(level)) {
      errors.push({ line, message: '频率与电平都必须是有限数值' });
      return;
    }
    records.push({ line, frequency, level });
  });
  return { records, errors };
}

/**
 * 校验采样文本与参数，并生成已合并的占用区间。
 *
 * @param {string} text         两列采样文本（频率 MHz、电平 dBm，无表头）
 * @param {number} intervalMhz  采样间隔 MHz（必须为正数）
 * @param {number} thresholdDbm 占用阈值 dBm（有限数值；电平 ≥ 阈值视为占用）
 * @returns {{bands: Array<{lo:number, hi:number}>,
 *            sampleCount:number, pointCount:number,
 *            interval:number, threshold:number}}
 * @throws {ScanValidationError} 存在任何整批/逐行校验错误
 */
function importScanSamples(text, intervalMhz, thresholdDbm) {
  const errors = [];

  const interval = Number(intervalMhz);
  if (!Number.isFinite(interval) || interval <= 0) {
    errors.push({ line: null, message: '采样间隔必须是正数（MHz）' });
  }
  const threshold = Number(thresholdDbm);
  if (!Number.isFinite(threshold)) {
    errors.push({ line: null, message: '占用阈值必须是有限数值（dBm）' });
  }

  const { records, errors: lineErrors } = parseScanCsv(text);
  errors.push(...lineErrors);

  if (records.length === 0 && lineErrors.length === 0) {
    errors.push({ line: null, message: '没有任何非空采样记录，请粘贴两列 CSV（频率 MHz、电平 dBm）' });
  }
  if (records.length > MAX_SCAN_SAMPLES) {
    errors.push({ line: null, message: `非空采样记录最多 ${MAX_SCAN_SAMPLES} 条，当前 ${records.length} 条` });
  }

  if (errors.length > 0) throw new ScanValidationError(errors);

  // 同频点取最高电平：以整数 Hz 为键，避免浮点重复
  const best = new Map();
  for (const r of records) {
    const key = mhzToHz(r.frequency);
    const cur = best.get(key);
    if (!cur || r.level > cur.level) best.set(key, { frequency: r.frequency, level: r.level });
  }

  // 按频率升序；占用点（电平达到阈值）扩展为中心 ± 半个采样间隔的闭区间
  const half = interval / 2;
  const rawBands = [...best.values()]
    .sort((a, b) => a.frequency - b.frequency)
    .filter((p) => p.level >= threshold)
    .map((p) => ({ lo: p.frequency - half, hi: p.frequency + half }));

  return {
    bands: normalizeOccupiedBands(rawBands), // 相交或端点相接的区间合并
    sampleCount: records.length,
    pointCount: best.size,
    interval,
    threshold,
  };
}

module.exports = {
  MAX_SCAN_SAMPLES,
  ScanValidationError,
  parseScanCsv,
  importScanSamples,
};
