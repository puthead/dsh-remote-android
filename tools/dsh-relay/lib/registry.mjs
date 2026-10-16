/**
 * home/device 注册表 + 配对窗口索引（中继的**唯一**持久状态）。
 *
 * 安全模型（契约 §0 第 4 条 / §5.5 第 2 条）：
 * - 明文 `homeToken`/`deviceToken` 只在生成它的那一次 HTTP 响应里出现；
 *   落盘的只有 `sha256` 摘要，中继被拖库也无法冒充 home 或 device。
 * - 内存里用「摘要 → homeId / deviceId」索引做 O(1) 查找，比较用固定时间实现。
 *
 * 配对窗口（契约 §3.4）**只存内存**：配对码是 5 分钟生命周期的秘密，
 * 落盘只会扩大暴露面；中继重启后网关会重新声明（并在下一轮 pair/open 时自愈）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, hexEquals, newHomeId, newHomeToken, newTokenId, normalizePairCode, randomPairCode, readJsonFile, sha256Hex, str } from './util.mjs';

/** 注册表文件格式版本。 */
export const HOMES_FILE_VERSION = 2;

/** 注册表错误（带契约错误码，HTTP 层直接映射）。 */
export class RegistryError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

export class RelayRegistry {
  /**
   * @param {{file: string, logger?: object, now?: () => number, pairWindowTtlMs?: number}} opts
   */
  constructor({ file, logger = null, now = Date.now, pairWindowTtlMs = 300_000 }) {
    this.file = path.resolve(file);
    this.logger = logger;
    this.now = now;
    this.pairWindowTtlMs = pairWindowTtlMs;
    /** @type {Map<string, object>} homeId → home 记录 */
    this.homes = new Map();
    /** @type {Map<string, string>} sha256(homeToken) → homeId */
    this.homeTokenIndex = new Map();
    /** @type {Map<string, {homeId: string, deviceId: string}>} sha256(deviceToken) → 绑定 */
    this.deviceTokenIndex = new Map();
    /** @type {Map<string, {code: string, expiresAt: number}>} homeId → 配对窗口 */
    this.pairWindows = new Map();
    /** @type {Map<string, string>} code → homeId（§3.4：中继建立 code → homeId 索引） */
    this.pairCodeIndex = new Map();
    this.dirty = false;
    this._writeChain = Promise.resolve();
    this.loadedCount = 0;
    /**
     * 上次读/写文件后内容的 sha256。
     * 用途：`relay.mjs home-token` 是**另一个进程**，运行中的 relay 必须能发现它写了新状态
     * （否则"刚注册的令牌握手 401、重启才行"—— 这是运维实测踩到的缺陷）。
     * 用内容哈希而不是 mtime：Windows 上 mtime 精度与"同毫秒覆盖"会让比较失效。
     */
    this.contentHash = null;
  }

  /** 从磁盘加载；文件不存在/损坏都退化为空表（宁可要求重新注册，也不要服务起不来）。 */
  async load() {
    const { value, corrupt, error } = await readJsonFile(this.file, null);
    if (error && !corrupt) this.logger?.warn?.(`读取 homes.json 失败：${error.message}`);
    if (corrupt) this.logger?.warn?.('homes.json 内容损坏，已隔离为 .corrupt-*，将以空注册表启动（home 需重新注册）');
    const homes = Array.isArray(value?.homes) ? value.homes : [];
    this.#applySnapshot(homes);
    this.contentHash = await this.#readHash();
    return this.loadedCount;
  }

  async #readHash() {
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      return sha256Hex(text);
    } catch {
      return null;
    }
  }

  /**
   * 应用一份 home 列表（重建索引）。
   * 配对窗口是**运行期**状态，不来自文件：只保留仍然存在的 home 的窗口。
   * @param {object[]} homes
   */
  #applySnapshot(homes) {
    this.homes = new Map();
    this.homeTokenIndex = new Map();
    this.deviceTokenIndex = new Map();
    for (const raw of homes) {
      const home = this.#normalizeHome(raw);
      if (!home) continue;
      this.homes.set(home.homeId, home);
      this.homeTokenIndex.set(home.homeTokenHash, home.homeId);
      for (const device of home.devices.values()) this.deviceTokenIndex.set(device.deviceTokenHash, { homeId: home.homeId, deviceId: device.deviceId });
    }
    for (const [homeId, window] of [...this.pairWindows]) {
      if (!this.homes.has(homeId)) {
        this.pairWindows.delete(homeId);
        this.pairCodeIndex.delete(window.code);
      }
    }
    this.loadedCount = this.homes.size;
  }

  /**
   * 文件被其他进程（CLI/运维脚本）改写时热加载。
   * @returns {Promise<boolean>} 是否发生了重载
   */
  async reloadIfChanged() {
    let text;
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch {
      return false; // 文件被删/不可读：保持内存态，绝不因为读失败就把注册表清空
    }
    const hash = sha256Hex(text);
    if (hash === this.contentHash) return false;
    let value;
    try {
      value = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      this.logger?.warn?.('homes.json 被外部改写但内容不是合法 JSON，已忽略本次热加载');
      return false;
    }
    if (!Array.isArray(value?.homes)) return false;
    this.#applySnapshot(value.homes);
    this.contentHash = hash;
    return true;
  }

  #normalizeHome(raw) {
    const homeId = str(raw?.homeId);
    const homeTokenHash = str(raw?.homeTokenHash);
    if (!homeId || !homeTokenHash) return null;
    const devices = new Map();
    for (const rawDevice of Array.isArray(raw?.devices) ? raw.devices : []) {
      const deviceId = str(rawDevice?.deviceId);
      const deviceTokenHash = str(rawDevice?.deviceTokenHash);
      if (!deviceId || !deviceTokenHash) continue;
      devices.set(deviceId, {
        deviceId,
        deviceName: str(rawDevice?.deviceName, '未命名设备'),
        deviceTokenHash,
        tokenId: str(rawDevice?.tokenId),
        createdAt: Number.isFinite(rawDevice?.createdAt) ? rawDevice.createdAt : this.now(),
        updatedAt: Number.isFinite(rawDevice?.updatedAt) ? rawDevice.updatedAt : this.now(),
      });
    }
    return {
      homeId,
      homeName: str(raw?.homeName, '未命名 PC'),
      homeTokenHash,
      gatewayVersion: str(raw?.gatewayVersion),
      createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : this.now(),
      updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : this.now(),
      devices,
    };
  }

  /** 落盘（原子写）；无改动时空转。多次并发调用串行化，避免互相覆盖。 */
  async flush({ force = false } = {}) {
    if (!this.dirty && !force) return false;
    this.dirty = false;
    const payload = this.serialize();
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    this._writeChain = this._writeChain
      .then(async () => {
        await atomicWriteJson(this.file, payload);
        // 记下自己写出的内容哈希：否则下一次 reloadIfChanged 会把自己的写入当成"外部变更"
        this.contentHash = sha256Hex(text);
      })
      .catch((err) => {
        this.logger?.error?.(`写 homes.json 失败：${err.message}`);
        this.dirty = true; // 下次再试，别把待落盘的变更丢掉
      });
    await this._writeChain;
    return true;
  }

  /** @returns {object} 可落盘形态（不含任何明文令牌） */
  serialize() {
    return {
      version: HOMES_FILE_VERSION,
      updatedAt: this.now(),
      homes: [...this.homes.values()].map((home) => ({
        homeId: home.homeId,
        homeName: home.homeName,
        homeTokenHash: home.homeTokenHash,
        gatewayVersion: home.gatewayVersion,
        createdAt: home.createdAt,
        updatedAt: home.updatedAt,
        devices: [...home.devices.values()].map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          deviceTokenHash: device.deviceTokenHash,
          tokenId: device.tokenId,
          createdAt: device.createdAt,
          updatedAt: device.updatedAt,
        })),
      })),
    };
  }

  /**
   * 注册（或复用）一个 home：同一 `homeName` 重复注册 → **轮换** homeToken（契约 §2.2）。
   * @param {{homeName: string, gatewayVersion?: string}} opts
   * @returns {{homeId: string, homeToken: string, homeName: string, rotated: boolean}}
   */
  registerHome({ homeName, gatewayVersion = '' }) {
    const name = str(homeName).trim();
    if (!name) throw new RegistryError('bad_request', 'homeName 必须是非空字符串');
    const existing = [...this.homes.values()].find((home) => home.homeName === name);
    const homeToken = newHomeToken();
    const now = this.now();
    if (existing) {
      this.homeTokenIndex.delete(existing.homeTokenHash);
      existing.homeTokenHash = sha256Hex(homeToken);
      existing.gatewayVersion = gatewayVersion || existing.gatewayVersion;
      existing.updatedAt = now;
      this.homeTokenIndex.set(existing.homeTokenHash, existing.homeId);
      this.dirty = true;
      return { homeId: existing.homeId, homeToken, homeName: existing.homeName, rotated: true };
    }
    const home = {
      homeId: newHomeId(),
      homeName: name,
      homeTokenHash: sha256Hex(homeToken),
      gatewayVersion,
      createdAt: now,
      updatedAt: now,
      devices: new Map(),
    };
    this.homes.set(home.homeId, home);
    this.homeTokenIndex.set(home.homeTokenHash, home.homeId);
    this.dirty = true;
    return { homeId: home.homeId, homeToken, homeName: home.homeName, rotated: false };
  }

  /** @param {string} token @returns {object|null} */
  findHomeByToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const hash = sha256Hex(token);
    const homeId = this.homeTokenIndex.get(hash);
    if (!homeId) return null;
    const home = this.homes.get(homeId);
    if (!home) return null;
    return hexEquals(home.homeTokenHash, hash) ? home : null;
  }

  /** @param {string} homeId @returns {object|null} */
  findHome(homeId) {
    return this.homes.get(str(homeId)) ?? null;
  }

  /** @param {string} name @returns {object|null} */
  findHomeByName(name) {
    const target = str(name).trim();
    if (!target) return null;
    return [...this.homes.values()].find((home) => home.homeName === target) ?? null;
  }

  /**
   * 绑定（或轮换）设备令牌：同一 `deviceId` 再次 claim → 轮换旧 deviceToken（契约 §2.3）。
   * @param {{homeId: string, deviceId: string, deviceName?: string, deviceToken: string, tokenId?: string}} opts
   * @returns {{device: object, rotated: boolean}}
   */
  bindDevice({ homeId, deviceId, deviceName = '未命名设备', deviceToken, tokenId = '' }) {
    const home = this.homes.get(str(homeId));
    if (!home) throw new RegistryError('home_not_found', `home 不存在：${homeId}`);
    if (typeof deviceToken !== 'string' || deviceToken.length < 8) throw new RegistryError('bad_request', 'deviceToken 非法');
    const now = this.now();
    const previous = home.devices.get(deviceId) ?? null;
    if (previous) this.deviceTokenIndex.delete(previous.deviceTokenHash);
    const hash = sha256Hex(deviceToken);
    const device = {
      deviceId,
      deviceName: str(deviceName, '未命名设备'),
      deviceTokenHash: hash,
      tokenId: tokenId || newTokenId(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    home.devices.set(deviceId, device);
    home.updatedAt = now;
    this.deviceTokenIndex.set(hash, { homeId: home.homeId, deviceId });
    this.dirty = true;
    return { device, rotated: Boolean(previous) };
  }

  /**
   * 按设备令牌查绑定（隧道准入的第二道闸，契约 §0 第 4 条）。
   * @param {string} token
   * @returns {{home: object, device: object}|null}
   */
  findDeviceByToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const hash = sha256Hex(token);
    const binding = this.deviceTokenIndex.get(hash);
    if (!binding) return null;
    const home = this.homes.get(binding.homeId);
    const device = home?.devices.get(binding.deviceId);
    if (!home || !device) return null;
    return hexEquals(device.deviceTokenHash, hash) ? { home, device } : null;
  }

  /**
   * 吊销设备（轮换令牌时由 HTTP 层调用；不落盘删除记录，只移除索引 → 旧令牌立即失效）。
   * @param {string} homeId
   * @param {string} deviceId
   * @returns {boolean}
   */
  revokeDevice(homeId, deviceId) {
    const home = this.homes.get(str(homeId));
    const device = home?.devices.get(str(deviceId));
    if (!home || !device) return false;
    this.deviceTokenIndex.delete(device.deviceTokenHash);
    home.devices.delete(device.deviceId);
    home.updatedAt = this.now();
    this.dirty = true;
    return true;
  }

  /** @returns {Array<object>} 人类可读摘要（CLI `homes` 子命令用，绝不包含摘要以外的秘密） */
  listHomes() {
    return [...this.homes.values()].map((home) => ({
      homeId: home.homeId,
      homeName: home.homeName,
      gatewayVersion: home.gatewayVersion,
      createdAt: home.createdAt,
      updatedAt: home.updatedAt,
      devices: [...home.devices.values()].map((device) => ({ deviceId: device.deviceId, deviceName: device.deviceName, tokenId: device.tokenId })),
      pairWindowOpen: this.getPairWindow(home.homeId).open,
    }));
  }

  /** 清理过期配对窗口（惰性判定 + 由服务端定时器主动调用，保证 `GET window` 读数及时）。 */
  sweepPairWindows() {
    const now = this.now();
    let removed = 0;
    for (const [homeId, window] of this.pairWindows) {
      if (!window || window.expiresAt <= now) {
        this.pairWindows.delete(homeId);
        if (window?.code) this.pairCodeIndex.delete(window.code);
        removed++;
      }
    }
    return removed;
  }

  /**
   * 打开/覆盖配对窗口（契约 §3.4）。
   * 码冲突语义：新码与**仍有效的其他 home 的码**撞号 → 返回 `code_conflict`，由网关换码重试（最多 5 次）。
   * @param {string} homeId
   * @param {{code?: string, expiresAt?: number, ttlMs?: number}} [opts]
   * @returns {{ok: true, code: string, expiresAt: number} | {ok: false, code: 'code_conflict'|'bad_request', message: string}}
   */
  openPairWindow(homeId, { code = null, expiresAt = null, ttlMs = null } = {}) {
    const home = this.homes.get(str(homeId));
    if (!home) return { ok: false, code: 'bad_request', message: `home 不存在：${homeId}` };
    this.sweepPairWindows();
    const now = this.now();
    const normalized = code === null || code === undefined ? randomPairCode() : normalizePairCode(code);
    if (!normalized) return { ok: false, code: 'bad_request', message: 'code 必须是 6 位数字' };

    const holder = this.pairCodeIndex.get(normalized);
    if (holder && holder !== home.homeId) {
      return { ok: false, code: 'code_conflict', message: `配对码与在线 home 冲突（${home.homeId}）` };
    }

    const ttl = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : this.pairWindowTtlMs;
    const requested = Number.isFinite(expiresAt) ? Number(expiresAt) : now + ttl;
    // 过期时间只允许落在 (now, now+ttl]：网关声明的更长 TTL 一律夹紧，防止配对码被无限期留存
    const bounded = Math.min(Math.max(requested, now + 1000), now + ttl);

    const previous = this.pairWindows.get(home.homeId);
    if (previous && previous.code !== normalized) this.pairCodeIndex.delete(previous.code);
    this.pairWindows.set(home.homeId, { code: normalized, expiresAt: bounded });
    this.pairCodeIndex.set(normalized, home.homeId);
    return { ok: true, code: normalized, expiresAt: bounded };
  }

  /**
   * 查询当前窗口（契约 §3.4 只返回 `{open, expiresAt}`，不回显码本身）。
   * @param {string} homeId
   * @returns {{open: boolean, expiresAt: number|null}}
   */
  getPairWindow(homeId) {
    const window = this.pairWindows.get(str(homeId));
    if (!window) return { open: false, expiresAt: null };
    if (window.expiresAt <= this.now()) {
      this.pairWindows.delete(str(homeId));
      this.pairCodeIndex.delete(window.code);
      return { open: false, expiresAt: null };
    }
    return { open: true, expiresAt: window.expiresAt };
  }

  /** @param {string} homeId @returns {boolean} 是否真的关掉了窗口 */
  closePairWindow(homeId) {
    const window = this.pairWindows.get(str(homeId));
    if (!window) return false;
    this.pairWindows.delete(str(homeId));
    this.pairCodeIndex.delete(window.code);
    return true;
  }

  /**
   * 按配对码找 home（§2.3 中继侧索引）。
   * @param {string} code
   * @returns {object|null}
   */
  findHomeByPairCode(code) {
    const normalized = normalizePairCode(code);
    if (!normalized) return null;
    this.sweepPairWindows();
    const homeId = this.pairCodeIndex.get(normalized);
    if (!homeId) return null;
    return this.homes.get(homeId) ?? null;
  }

  /** @returns {{homes: number, devices: number, pairWindows: number}} */
  stats() {
    let devices = 0;
    for (const home of this.homes.values()) devices += home.devices.size;
    return { homes: this.homes.size, devices, pairWindows: this.pairWindows.size };
  }
}
