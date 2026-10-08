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
import fs from 'node:fs';
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
 *
 * 一致性设计（为什么需要"外部改动检测"）：
 * 本地管理命令 `devices revoke` 直接改 %DSH_HOME%/devices.json，而正在运行的网关把设备
 * 缓存在内存里。若不做检测，会出现两个问题：
 * 1) CLI 吊销后，网关内存里仍有该设备 → 旧令牌依旧放行（安全漏洞）；
 * 2) 网关后续一次 flush 会把被吊销的设备写回文件（吊销被"复活"）。
 * 因此：校验失败时按 mtime 同步重载一次再判定；周期性维护也先重载后落盘；
 * 结构变更（新增/吊销）由网关自己发起时则以内存为准。
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
    /** 有待写入磁盘的改动（含仅 lastSeenAt 的更新）。 */
    this.dirty = false;
    /** 存在设备增删（结构变更）：此时不允许被外部文件覆盖。 */
    this.structuralDirty = false;
    /** 上次已知的文件 mtimeMs，用于识别外部（CLI）改动。 */
    this.mtimeMs = 0;
  }

  /** 从磁盘加载（文件不存在视为空库）。 */
  async load() {
    const { value, error, corrupt } = await readJsonFile(this.file, { version: 1, devices: [] });
    if (error && corrupt) this.logger?.warn(`设备令牌库损坏，已隔离为 .corrupt 文件并重建：${this.file}`);
    else if (error) this.logger?.warn(`设备令牌库读取失败（忽略）：${error.message}`);
    const list = Array.isArray(value?.devices) ? value.devices : [];
    this.devices = list.filter((d) => d && typeof d.tokenHash === 'string' && typeof d.tokenId === 'string');
    this.dirty = false;
    this.structuralDirty = false;
    this.#rememberMtime();
    return this.devices.length;
  }

  /**
   * 若文件被外部改动（CLI 吊销/手工编辑）则同步重载。
   * 为什么同步：认证路径需要立即得到结论，且该分支只在"内存里找不到令牌"时才走，
   * 频率由限速器兜底，不会成为性能瓶颈。
   * @returns {boolean} 是否发生了重载
   */
  reloadIfChangedSync() {
    try {
      const stat = fs.statSync(this.file);
      if (stat.mtimeMs === this.mtimeMs) return false;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(parsed?.devices) ? parsed.devices : [];
      this.devices = list.filter((d) => d && typeof d.tokenHash === 'string' && typeof d.tokenId === 'string');
      this.dirty = false;
      this.structuralDirty = false;
      this.mtimeMs = stat.mtimeMs;
      this.logger?.info(`设备库被外部修改，已重新加载：${this.devices.length} 个设备`);
      return true;
    } catch {
      return false;
    }
  }

  /** 立即落盘（原子写）。 */
  async flush() {
    // 只有"非结构变更"（如 lastSeenAt 更新）才允许先接受外部改动，
    // 避免把 CLI 刚吊销的设备又写回去；结构变更以内存为准。
    if (!this.structuralDirty) this.reloadIfChangedSync();
    if (!this.dirty) return;
    this.dirty = false;
    this.structuralDirty = false;
    await atomicWriteJson(this.file, { version: 1, devices: this.devices });
    this.#rememberMtime();
  }

  /** 记录当前文件 mtime（写盘后 mtime 会变化，必须刷新，否则会误判为外部改动）。 */
  #rememberMtime() {
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.mtimeMs = 0;
    }
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
    // 关键：每次鉴权前先接受外部改动。否则「CLI 吊销」会被内存里的旧副本掩盖 ——
    // 被吊销的令牌依然能在内存中命中，等于吊销无效（安全缺陷）。
    // 这里只做一次 stat + mtime 比较，未变化时开销极小。
    this.reloadIfChangedSync();
    const digest = sha256(token);
    const matched = this.#match(digest);
    if (!matched) return null;
    this.touch(matched.tokenId);
    return { tokenId: matched.tokenId, deviceName: matched.deviceName };
  }

  /**
   * 恒定时间比较：故意不做提前返回，保证比较次数与设备数量相关而与命中位置无关。
   * @param {Buffer} digest
   */
  #match(digest) {
    let matched = null;
    for (const device of this.devices) {
      const stored = Buffer.from(device.tokenHash, 'hex');
      if (safeEqual(stored, digest)) matched = device;
    }
    return matched;
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
    this.structuralDirty = true; // 新增设备属于结构变更，落盘时以内存为准
    await this.flush();
    return { token, tokenId, revokedTokenIds };
  }

  /** 吊销令牌。 @param {string} tokenId @returns {Promise<boolean>} */
  async revoke(tokenId) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.tokenId !== tokenId);
    if (this.devices.length === before) return false;
    this.dirty = true;
    this.structuralDirty = true; // 吊销属于结构变更
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
