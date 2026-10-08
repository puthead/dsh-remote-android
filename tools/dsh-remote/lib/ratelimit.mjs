/**
 * 按 IP 的滑动窗口限速器（契约 §6.4：pair/claim 每 IP 每分钟 10 次、认证失败每 IP 每分钟 30 次）。
 *
 * 为什么自己实现：零第三方依赖要求；逻辑很小，且需要「只对失败计数」（认证成功不该消耗额度）。
 * 为什么用滑动窗口而非固定窗口：固定窗口在窗口边界会放过 2 倍流量，滑动窗口更严格且实现同样简单。
 * 内存保护：单个 key 的时间戳数组被窗口长度天然限制（≤ limit + 并发突发），并设置 keys 上限做兜底清扫。
 */
export class RateLimiter {
  /**
   * @param {{limit: number, windowMs: number, now?: () => number, maxKeys?: number}} opts
   */
  constructor({ limit, windowMs, now = Date.now, maxKeys = 4096 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  /**
   * 记一次命中并判断是否超限。
   * @param {string} key 通常是归一化后的客户端 IP
   * @returns {{allowed: boolean, remaining: number, retryAfterSec: number}}
   */
  hit(key) {
    const now = this.now();
    const cutoff = now - this.windowMs;
    let list = this.hits.get(key);
    if (!list) {
      if (this.hits.size >= this.maxKeys) this.#sweep(now, cutoff);
      list = [];
      this.hits.set(key, list);
    }
    while (list.length && list[0] <= cutoff) list.shift();
    list.push(now);
    const allowed = list.length <= this.limit;
    const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
    return { allowed, remaining: Math.max(0, this.limit - list.length), retryAfterSec };
  }

  /** 只读检查（不计数），供测试与健康检查使用。 */
  peek(key) {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    return { used: list.length, remaining: Math.max(0, this.limit - list.length) };
  }

  /** 清空某个 key（配对成功后重置计数，避免用户因重试被锁）。 */
  reset(key) {
    this.hits.delete(key);
  }

  /** 删除窗口已过期的空 key，防止被海量伪造 IP 撑爆内存。 */
  #sweep(now, cutoff) {
    for (const [key, list] of this.hits) {
      while (list.length && list[0] <= cutoff) list.shift();
      if (list.length === 0) this.hits.delete(key);
      if (this.hits.size < this.maxKeys / 2) break;
    }
  }
}

/**
 * 归一化客户端地址：把 IPv4-mapped IPv6（::ffff:127.0.0.1）折叠为 IPv4，便于限速与回环判断。
 * @param {string|undefined|null} address
 * @returns {string}
 */
export function normalizeIp(address) {
  if (!address) return 'unknown';
  const addr = String(address);
  if (addr.startsWith('::ffff:') && addr.includes('.')) return addr.slice(7);
  return addr;
}

/**
 * 判断是否回环地址（契约 §2.1：pair/open 只接受本机请求）。
 * @param {string|undefined|null} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  const ip = normalizeIp(address);
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}
