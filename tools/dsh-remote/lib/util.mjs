/**
 * 通用工具：ID 生成、原子写文件、JSON 读写、UTF-8 安全截断、日志与敏感信息脱敏。
 *
 * 为什么单独成模块：网关、任务队列、令牌库都要用到「原子持久化」与「日志绝不落明文密钥」
 * 这两条硬性约束，集中实现可以保证行为一致、且只在一处审计安全敏感逻辑。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** Crockford Base32 字母表（ULID 规范），去掉了易混淆的 I/L/O/U。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 生成 26 字符 ULID：前 10 位为毫秒时间戳、后 16 位随机。
 * 为什么不用 uuid：ULID 字典序 == 时间序，任务列表按 id 排序即按创建时间排序，
 * 且不依赖第三方库。
 * 80 位随机数按 5 位一组编码成 16 个 Base32 字符（用 BigInt 做位切分，避免位数对不齐）。
 * @param {number} [ms] 毫秒时间戳
 * @param {Buffer} [rand] 10 字节随机源（测试可注入以获得确定性）
 * @returns {string}
 */
export function ulid(ms = Date.now(), rand = crypto.randomBytes(10)) {
  let t = ms;
  const time = new Array(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = CROCKFORD[t % 32];
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(rand[i] ?? 0);
  const tail = new Array(16);
  for (let i = 15; i >= 0; i--) {
    tail[i] = CROCKFORD[Number(bits & 31n)];
    bits >>= 5n;
  }
  return time.join('') + tail.join('');
}

/** @returns {string} 形如 `task_01J…` 的任务 id */
export function newTaskId(ms) {
  return `task_${ulid(ms)}`;
}

/** @returns {string} 形如 `tok_7a1b…` 的令牌 id（令牌 id 不是秘密，可出现在响应中） */
export function newTokenId() {
  return `tok_${crypto.randomBytes(8).toString('hex')}`;
}

/** @returns {string} 形如 `run_1a2b…` 的内部关联 id，仅用于日志 */
export function newRunId() {
  return `run_${crypto.randomBytes(6).toString('hex')}`;
}

/** @param {string|Buffer} data @returns {Buffer} sha256 摘要 */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * 生成 32 字节随机数的 Base64Url（无填充）字符串，用于设备令牌与配对码随机源。
 * @param {number} bytes
 * @returns {string}
 */
export function randomBase64Url(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * 生成 6 位数字配对码。
 * 为什么用 crypto 而不是 Math.random：配对码是安全边界（拿到码即可换长期令牌），
 * 必须使用密码学安全随机源。使用拒绝采样避免取模偏置。
 * @returns {string} 例如 `482913`（保留前导 0）
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
 * 按 UTF-8 字节数安全截断字符串，不切断代理对（避免产生非法 UTF-16）。
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  // 二分查找能放进 maxBytes 的最大字符数，避免逐字符扫描大字符串
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // 若切在代理对中间则回退一位
  if (lo > 0 && lo < text.length) {
    const code = text.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1;
  }
  return text.slice(0, lo);
}

/** 形如 `sk-xxx` 的 API Key 与 `dshr_xxx` 的网关令牌，绝不允许出现在日志里。 */
const SECRET_PATTERNS = [
  /\b(sk-)[A-Za-z0-9_-]{8,}/g,
  /\b(dshr_)[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g,
];

/**
 * 日志脱敏：把可能的密钥/令牌替换为 `***`。
 * 为什么不依赖调用方自律：日志是最后一道防线，脱敏必须在写盘前统一执行。
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '$1***REDACTED***');
  return out;
}

/**
 * 原子写文本文件：先写同目录临时文件并 fsync，再 rename 覆盖目标。
 * 为什么必须这样写：%DSH_HOME% 下同时是任务历史与令牌库，
 * 直接覆盖写会在断电/崩溃时留下半截 JSON，导致重启后历史或令牌全丢。
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
    await fsp.rename(tmp, file); // Windows 上 libuv 使用 MoveFileEx(REPLACE_EXISTING)，可原子替换
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
 * 读取 JSON；文件不存在返回 fallback；内容损坏时把原文件改名为 `.corrupt-<ts>` 后返回 fallback，
 * 避免一个坏文件让整个网关起不来。
 * @param {string} file
 * @param {unknown} fallback
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
    return { value: JSON.parse(text), error: null, corrupt: false };
  } catch (err) {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    await fsp.rename(file, quarantine).catch(() => {});
    return { value: fallback, error: err, corrupt: true };
  }
}

/** 本地日期戳 YYYYMMDD（日志按天滚动）。 @param {Date} [d] */
export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 创建按天滚动的文件日志器。
 * 安全约定：写入前统一走 redactSecrets，任何调用方都无法把明文令牌/密钥写进日志；
 * 写日志失败绝不影响主流程（本地磁盘问题不应让任务执行中断）。
 * @param {{dir: string|null, filePrefix?: string, toConsole?: boolean, now?: () => number, consoleLike?: Console}} opts
 *   dir 传 null 表示仅输出到控制台（用于配置加载阶段：此时还不知道日志目录）。
 */
export function createLogger({ dir, filePrefix = 'gateway', toConsole = true, now = Date.now, consoleLike = console }) {
  const fileFor = (ts) => (dir ? path.join(dir, `${filePrefix}-${dateStamp(new Date(ts))}.log`) : null);
  let lastFile = null;

  const write = (level, msg) => {
    const ts = now();
    const line = `${new Date(ts).toISOString()} [${level}] ${redactSecrets(msg)}\n`;
    const file = fileFor(ts);
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line, 'utf8'); // 同步写：崩溃时日志不丢，本地小体量可接受
        lastFile = file;
      } catch {
        /* 日志失败不抛出 */
      }
    }
    if (toConsole) {
      // warn/error 走 stderr，便于运维用重定向分离
      const sink = level === 'error' || level === 'warn' ? consoleLike.error : consoleLike.log;
      sink.call(consoleLike, line.trimEnd());
    }
  };

  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    debug: (m) => write('debug', m),
    /** @returns {string} 最近一次成功写入的日志文件路径（测试用） */
    currentFile: () => lastFile,
    dir,
  };
}

/** @returns {string} 当前机器可用的 hostname，用作 serverName 默认值 */
export function hostName() {
  try {
    return os.hostname();
  } catch {
    return 'unknown-host';
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
