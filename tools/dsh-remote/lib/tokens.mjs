/**
 * 设备令牌库与配对码管理（契约 §2 / §5）。
 *
 * 安全设计（对应工单硬性要求 4）：
 * 1. 令牌明文只在 pair/claim 响应中出现一次，落库的只有 sha256(明文) 的十六进制串；
 *    网关被读取 devices.json 也无法反推出可用令牌。
 * 2. 校验用 crypto.timingSafeEqual，且**不提前 break**：遍历全部设备做恒定时间比较，
 *    避免通过响应时间泄露「令牌是否存在/前几位是否命中」。
 * 3. 配对码用 crypto 随机数生成（util.randomPairCode），一次性、5 分钟过期、
 *    新码会使旧码立即失效（避免多码并存被在线暴力试探）。
 */
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { atomicWriteJson, newTokenId, randomBase64Url, randomPairCode, readJsonFile, sha256 } from './util.mjs';

/** 令牌前缀，便于在日志/代码中识别（配合 util.redactSecrets 脱敏）。 */
export const TOKEN_PREFIX = 'dshr_';

/**
 * 恒定时间比较两个 Buffer；长度不同直接返回 false（长度本身不是秘密：摘要恒为 32 字节）。
 * @param {Buffer} a
 * @param {Buffer} b
 */
function safeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 设备令牌库。
 */
export class DeviceStore {
  /**
   * @param {{file: string, now?: () => number, logger?: {info: Function, warn: Function}}} opts
   */
  constructor({ file, now = Date.now, logger = null }) {
    this.file = file;
    this.now = now;
    this.logger = logger;
    /** @type {Array<{tokenId:string, tokenHash:string, deviceName:string, deviceIdHash:string|null, pairedAt:number, lastSeenAt:number}>} */
    this.devices = [];
    this.dirty = false;
  }

  /** 从磁盘加载（文件不存在视为空库）。 */
  async load() {
    const { value, error, corrupt } = await readJsonFile(this.file, { version: 1, devices: [] });
    if (error && corrupt) this.logger?.warn(`设备令牌库损坏，已隔离为 .corrupt 文件并重建：${this.file}`);
    else if (error) this.logger?.warn(`设备令牌库读取失败（忽略）：${error.message}`);
    const list = Array.isArray(value?.devices) ? value.devices : [];
    this.devices = list.filter((d) => d && typeof d.tokenHash === 'string' && typeof d.tokenId === 'string');
    return this.devices.length;
  }

  /** 立即落盘（原子写）。 */
  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    await atomicWriteJson(this.file, { version: 1, devices: this.devices });
  }

  /** 对外可见的设备列表（绝不返回 tokenHash）。 */
  list() {
    return this.devices.map((d) => ({
      tokenId: d.tokenId,
      deviceName: d.deviceName,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt,
    }));
  }

  /**
   * 校验明文令牌。
   * @param {string} token
   * @returns {{tokenId: string, deviceName: string}|null}
   */
  verify(token) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
    const digest = sha256(token);
    let matched = null;
    // 注意：故意不做提前返回，保证比较次数与设备数量相关而与命中位置无关
    for (const device of this.devices) {
      const stored = Buffer.from(device.tokenHash, 'hex');
      if (safeEqual(stored, digest)) matched = device;
    }
    if (!matched) return null;
    this.touch(matched.tokenId);
    return { tokenId: matched.tokenId, deviceName: matched.deviceName };
  }

  /**
   * 签发新令牌。同一 deviceId 重复配对时旧令牌立即吊销（契约 §2.2，便于用户重装 App）。
   * @param {{deviceName?: string, deviceId?: string|null}} input
   * @returns {Promise<{token: string, tokenId: string, revokedTokenIds: string[]}>}
   */
  async issue({ deviceName = '未命名设备', deviceId = null } = {}) {
    const deviceIdHash = typeof deviceId === 'string' && deviceId.trim() ? sha256(deviceId.trim()).toString('hex') : null;
    const revokedTokenIds = [];
    if (deviceIdHash) {
      for (const d of this.devices) {
        if (d.deviceIdHash === deviceIdHash) revokedTokenIds.push(d.tokenId);
      }
      if (revokedTokenIds.length) {
        this.devices = this.devices.filter((d) => d.deviceIdHash !== deviceIdHash);
      }
    }
    const token = TOKEN_PREFIX + randomBase64Url(32); // 32 字节随机，Base64Url 无填充（契约 §2.2）
    const tokenId = newTokenId();
    const at = this.now();
    this.devices.push({
      tokenId,
      tokenHash: sha256(token).toString('hex'),
      deviceName: String(deviceName || '未命名设备').slice(0, 64),
      deviceIdHash,
      pairedAt: at,
      lastSeenAt: at,
    });
    this.dirty = true;
    await this.flush();
    return { token, tokenId, revokedTokenIds };
  }

  /** 内部：记录被剔除的令牌 id（保持 issue() 主流程可读）。 */
  #revokedBuffer = [];

  /** 吊销令牌。 @param {string} tokenId @returns {Promise<boolean>} */
  async revoke(tokenId) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.tokenId !== tokenId);
    if (this.devices.length === before) return false;
    this.dirty = true;
    await this.flush();
    return true;
  }

  /** 记录一次成功认证的时间（内存更新，落盘由 flush 周期控制，避免每请求一次磁盘写）。 */
  touch(tokenId) {
    const device = this.devices.find((d) => d.tokenId === tokenId);
    if (!device) return;
    device.lastSeenAt = this.now();
    this.dirty = true;
  }
}

/**
 * 配对码管理器：同一时刻最多一个有效码。
 */
export class PairingManager {
  /**
   * @param {{ttlMs?: number, now?: () => number}} [opts]
   */
  constructor({ ttlMs = 300_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {{code: string, expiresAt: number}|null} */
    this.current = null;
  }

  /** 当前是否存在有效配对窗口（health.pairingOpen）。 */
  get isOpen() {
    return this.current !== null && this.current.expiresAt >= this.now();
  }

  /**
   * 生成新配对码（PC 本地回环调用）。
   * @returns {{code: string, expiresAt: number}}
   */
  open() {
    const code = randomPairCode();
    const expiresAt = this.now() + this.ttlMs;
    this.current = { code, expiresAt };
    return { code, expiresAt };
  }

  /** 主动关闭配对窗口（配对成功或管理员取消）。 */
  close() {
    this.current = null;
  }

  /**
   * 校验并消费配对码。
   * @param {string} code
   * @returns {{ok: true} | {ok: false, reason: 'pairing_closed'|'pairing_bad_code'}}
   */
  claim(code) {
    if (!this.current) return { ok: false, reason: 'pairing_closed' };
    if (this.current.expiresAt < this.now()) {
      this.current = null; // 过期即关闭，后续请求得到 pairing_closed
      return { ok: false, reason: 'pairing_bad_code' };
    }
    const expected = Buffer.from(this.current.code, 'utf8');
    const provided = Buffer.from(typeof code === 'string' ? code : '', 'utf8');
    if (!safeEqual(expected, provided)) return { ok: false, reason: 'pairing_bad_code' };
    this.current = null; // 一次性：成功即消费
    return { ok: true };
  }
}

/** 便于测试：把令牌哈希成文件里出现的形式。 */
export function tokenHashOf(token) {
  return sha256(token).toString('hex');
}

/** 便于测试/排障：确认 devices.json 中不含任何以 dshr_ 开头的明文。 */
export async function assertNoPlaintextTokens(file) {
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  return !text.includes(TOKEN_PREFIX);
}
