/**
 * 中继通用工具：标识符/令牌生成、sha256、原子写 JSON、日志脱敏。
 *
 * 为什么单独成模块：中继有两条不可协商的安全约束 ——
 * 1. 只存 `sha256(令牌)`，明文令牌只在生成它的那一次响应里出现；
 * 2. 日志里任何令牌/授权头都必须脱敏（前 4 位 + `****`）。
 * 把这两件事收在一个文件里，保证「只在一处审计安全敏感逻辑」，
 * 而不是靠每个调用方自律（历史教训：只要有一处漏了，拖库/日志泄露就成立）。
 *
 * 沿用 `tools/dsh-remote/lib/util.mjs` 的风格：零第三方依赖、中文 JSDoc、可控错误码、原子写。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** @param {string|Buffer} data @returns {Buffer} sha256 摘要（原始字节） */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/** @param {string|Buffer} data @returns {string} sha256 十六进制（落盘/索引用的规范形态） */
export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 生成 `bytes` 字节随机数的 Base64Url（无填充）字符串。
 * @param {number} bytes
 * @returns {string}
 */
export function randomBase64Url(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * 生成 6 位数字配对码（保留前导 0）。
 * 为什么用 crypto 而不是 Math.random：拿到码即可换长期 deviceToken，配对码是安全边界；
 * 用拒绝采样避免取模偏置（与网关 v1 行为一致）。
 * @returns {string}
 */
export function randomPairCode() {
  const limit = 1_000_000;
  const max = Math.floor(0xffffffff / limit) * limit;
  for (;;) {
    const n = crypto.randomBytes(4).readUInt32BE(0);
    if (n < max) return String(n % limit).padStart(6, '0');
  }
}

/**
 * 生成 `home_` + 22 位 Base64Url 的 homeId（契约 §1）。
 * 16 字节随机数的 Base64Url 恰好 22 字符（去掉 `=` 填充），与契约形态一致。
 * @returns {string}
 */
export function newHomeId() {
  return `home_${crypto.randomBytes(16).toString('base64url')}`;
}

/** @returns {string} `homeToken`：32 字节随机 Base64Url（契约 §1） */
export function newHomeToken() {
  return randomBase64Url(32);
}

/** @returns {string} `tok_` + 12 位十六进制的令牌 id（非秘密，可出现在响应/日志） */
export function newTokenId() {
  return `tok_${crypto.randomBytes(6).toString('hex')}`;
}

/** 归一化配对码：接受字符串或数字，必须是 6 位数字；非法返回 null（与网关 v1 同规则）。 */
export function normalizePairCode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value).padStart(6, '0');
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{6}$/.test(trimmed) ? trimmed : null;
}

/** 设备 ID 必须是**小写** UUID v4（契约 §1 沿用 v1 裁定 A4；大小写不同会被当成两台设备）。 */
export const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 令牌脱敏：前 4 位 + `****`（契约 §5.5 第 2 条硬性要求）。
 * 为什么保留 4 位：排障时需要区分「哪把令牌」，但 4 位不足以恢复 256 位熵的密钥。
 * 长度 ≤ 4 时整串不可见，避免"脱敏后反而全泄露"。
 * @param {unknown} value
 * @returns {string}
 */
export function redactToken(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 4) return '****';
  return `${value.slice(0, 4)}****`;
}

/**
 * 自由文本脱敏：把文本中出现的令牌形态（`dshr_…`、`home_…`、`tok_…`、`Bearer …`）替换为前 4 位 + `****`。
 * 为什么需要它：日志内容往往由错误消息、请求路径拼成，令牌可能被夹带进来；
 * 统一在写盘前做一遍，比要求每个调用点手工脱敏可靠。
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  return String(text)
    // 前缀类令牌：保留「前缀 + 前 4 位」，例如 dshr_9f2c****
    .replace(/\b(dshr_[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{4,}/g, '$1****')
    .replace(/\b(home_[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{4,}/g, '$1****')
    .replace(/\b(tok_[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{4,}/g, '$1****')
    // 裸 Bearer 头：保留 scheme + 前 4 位
    .replace(/\b(Bearer\s+)([A-Za-z0-9._~+/-]{4})[A-Za-z0-9._~+/-]{4,}=*/g, '$1$2****');
}

/**
 * 固定时间比较两个十六进制摘要，避免用 `===` 泄露时序信息。
 * 长度不同直接判否（长度本身由 sha256 固定，不构成信息泄露）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function hexEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 原子写文件：先写同目录临时文件并 fsync，再 rename 覆盖目标。
 * 为什么必须这样写：`homes.json` 是中继唯一的持久状态（令牌摘要 + 设备绑定），
 * 直接覆盖写遇到崩溃会留下半截 JSON，重启后所有 home/device 绑定全丢。
 * @param {string} file 目标绝对路径
 * @param {string|Buffer} data
 */
export async function atomicWriteFile(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let fh = null;
  try {
    fh = await fsp.open(tmp, 'w');
    await fh.writeFile(data);
    await fh.sync(); // rename 之前先落盘，保证 rename 后内容完整
    await fh.close();
    fh = null;
    await fsp.rename(tmp, file); // Windows 上 libuv 用 MoveFileEx(REPLACE_EXISTING)，可原子替换
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * 原子写 JSON（带缩进，便于人工排障）。
 * @param {string} file
 * @param {unknown} value
 */
export async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 读 JSON；文件不存在返回 fallback；内容损坏时把原文件改名为 `.corrupt-<ts>` 后返回 fallback，
 * 避免一个坏文件让中继起不来（宁可要求重新注册，也不要服务不可用）。
 * @param {string} file
 * @param {unknown} [fallback]
 * @returns {Promise<{value: unknown, error: Error|null, corrupt: boolean}>}
 */
export async function readJsonFile(file, fallback = null) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { value: fallback, error: null, corrupt: false };
    return { value: fallback, error: err, corrupt: false };
  }
  try {
    return { value: JSON.parse(text.replace(/^\uFEFF/, '')), error: null, corrupt: false };
  } catch (err) {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    await fsp.rename(file, quarantine).catch(() => {});
    return { value: fallback, error: err, corrupt: true };
  }
}

/** @returns {boolean} 路径是否存在（同步，用于 CLI 的快速分支） */
export function existsSync(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** @returns {string} 当前机器 hostname，用作 relayName 默认值 */
export function hostName() {
  try {
    return os.hostname();
  } catch {
    return 'relay.local';
  }
}

/** 等待若干毫秒。 @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把可能为 undefined 的值断言为字符串（避免 `'undefined'` 混进日志）。 */
export function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/** @returns {boolean} 是否是回环地址（IPv4/IPv6 映射形态都算） */
export function isLoopbackAddress(ip) {
  const value = str(ip);
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}
