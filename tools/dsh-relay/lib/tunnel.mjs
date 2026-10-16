/**
 * 隧道层：多路复用、id 重映射、控制面、心跳、背压、掉线通知（契约 §3）。
 *
 * 三条方向性规则（实现里必须一眼可辨，否则最容易写错）：
 * 1. **device → home**：device 发 `req`，中继为它在该 home 连接上**重新分配 id**（§3.2），
 *    并把 home 回的 `res/chunk/end/abort` 用 device 的原始 id 回填。这就是"两个手机撞号"的解法。
 * 2. **home → relay**：home 也用 `req` 帧反向调用中继**自身**的控制面路由（§3.4），
 *    中继即服务端，直接应答；未命中控制面路由表一律拒绝（home 不得借隧道访问中继对外管理端点）。
 * 3. **device 不得访问管理端点**：`/health`、`/api/v2/homes`、`/api/v2/pair/*`、`/api/v2/v1/relay/*`
 *    这些是"人/PC 的操作面"，device 只能访问**自己绑定的那台 home** 的业务端点。
 *
 * 帧方向由帧类型唯一决定（`req` 恒为发起方 → 服务端；`res/chunk/end/abort` 恒为服务端 → 发起方），
 * 因此不存在"id 属于谁"的歧义，不需要额外的方向位。
 *
 * 其余硬性约束：单连接流数 ≤ 64、单 chunk ≤ 256 KiB、单流缓冲 ≤ 1 MiB（超出 abort `overflow`）、
 * bufferedAmount > 4 MiB 暂停读对端、30s 无 pong 判死链、home 掉线立刻向 device 推 `notice`。
 */
import { CLOSE } from './ws.mjs';
import { deriveTunnelUrl } from './config.mjs';
import { str } from './util.mjs';

/** 契约 §3.3 错误码（error 帧与错误响应体共用）。 */
export const ERROR_CODES = Object.freeze([
  'unauthorized',
  'forbidden',
  'home_offline',
  'not_found',
  'bad_request',
  'rate_limited',
  'too_many_streams',
  'overflow',
  'timeout',
  'internal',
]);

/** `abort.reason` 取值（契约 §3.5 六值裁定；lead 明确：**这是枚举，不得扩展**）。 */
export const ABORT_REASONS = Object.freeze(['overflow', 'peer_closed', 'home_offline', 'timeout', 'canceled', 'internal']);

/**
 * 归一 home 发来的 `abort.reason`（**防御**，不是正常路径）。
 *
 * 语义边界（lead 裁定）：`abort.reason` 只回答"**传输层为什么断**"；
 * 业务失败原因一律通过 HTTP 状态码 + 响应体表达（这正是 §3.5「让 TunnelHttp 与真实 HTTP 语义一致」的延伸）。
 * 因此网关**不应**发明 reason（例如 `gateway_error:ECONNREFUSED`、`bad_path`、`too_many_streams`），
 * 越界值这里统一归一为 `internal`，保证手机侧只需要认识 6 个值、协议不会因对端越界而崩。
 * @param {unknown} reason
 * @returns {string}
 */
export function normalizeHomeAbortReason(reason) {
  const text = str(reason);
  return ABORT_REASONS.includes(text) ? text : 'internal';
}

/** contract §3.4：home 反向调用允许的三条控制面路由。 */
export const CONTROL_ROUTES = Object.freeze([
  { method: 'POST', path: '/api/v2/pair/window' },
  { method: 'GET', path: '/api/v2/pair/window' },
  { method: 'POST', path: '/api/v2/pair/close' },
]);

/**
 * device 不得借隧道访问的路径（防御纵深；网关自身仍必须做授权，这里只是不让请求到达）。
 *
 * ⚠️ 这份名单经过两次真互操作（R2）纠正，教训值得留着：
 * 1. 第一版把整个 `/api/v1/` 前缀都拦了，破坏了 v1 契约「task 端点全部保留」
 *    （App 的 `/api/v1/health`、`/api/v1/tasks`、`/api/v1/devices/{id}` 全 403）；
 * 2. 第二版把整个 `/api/v2/pair/` 也拦了，又与 lead 的裁定冲突 —— 经隧道的
 *    `/api/v2/pair/claim` 是**必须放行**的（老 App 靠它换令牌，见下方 pairClaim 注入）。
 * 结论：只精确列"管理面"，不要用前缀一把抓。
 *
 * 现在拦的是：中继自身端点（`/health`、`/api/v2/homes`、`/api/v2/tunnel/*`）
 * 与契约 §4.1 明确「仅回环」的网关管理端点（`/api/v2/relay/*`、`pair/open`、`pair/window`、`pair/close`）。
 * 为什么后者必须由中继挡：经隧道转发时网关看到的来源就是 `127.0.0.1`，**它自己无法区分**。
 */
const DEVICE_FORBIDDEN_EXACT = Object.freeze([
  '/health',
  '/api/v2/homes',
  '/api/v2/pair/open', // 契约 §4.1：仅回环（生成配对码）
  '/api/v2/pair/window', // 中继控制面（home 专用）
  '/api/v2/pair/close', // 中继控制面（home 专用）
  '/api/v1/pair/open', // v1 的 pair/open 同样仅回环
]);

const DEVICE_FORBIDDEN_PREFIXES = Object.freeze([
  '/api/v2/tunnel/', // 中继自身
  '/api/v2/relay/', // 契约 §4.1：仅回环
]);

/** @param {string} pathname @returns {boolean} */
export function isDeviceForbiddenPath(pathname) {
  if (DEVICE_FORBIDDEN_EXACT.includes(pathname)) return true;
  return DEVICE_FORBIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

/** 严格 base64 校验：`Buffer.from(x,'base64')` 会静默忽略非法字符，不能直接信。 */
export function isStrictBase64(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/** 取 URL 的路径部分（解析失败时按原样），用于路由判定。 */
function pathOf(raw) {
  const text = str(raw);
  const index = text.search(/[?#]/);
  return index === -1 ? text : text.slice(0, index);
}

/**
 * 把路径规范化成"网关真正会去请求的那个 pathname"。
 *
 * ⚠️ 这是安全关键函数（R2 审计发现的真实绕过）：
 * 中继第一版按**字面路径**做管理面黑名单，而网关会用 `new URL()` 把 `..`（含 `%2e%2e`）规范化后再打本机 HTTP，
 * 于是 `GET /x/../api/v2/relay/status` 绕过了黑名单，拿到了 PC 的"仅回环"管理端点 ——
 * 实测 `GET /x/../api/v2/relay/status → 200 {...relay 状态...}`、`GET /%2e%2e/api/v2/relay/status → 200`。
 * 结论：**用前缀/包含关系做安全判定前，必须先规范化**（IPv4-mapped、大小写、点段、百分号编码同理）。
 * @param {string} pathname
 * @returns {string}
 */
export function normalizePathname(pathname) {
  const text = str(pathname);
  if (!text) return '/';
  try {
    // WHATWG URL 会按规范折叠 `.`/`..`（`%2e` 同样被当作点）、把 `\` 当 `/`、忽略重复斜杠
    return new URL(text, 'http://relay.invalid').pathname;
  } catch {
    return text;
  }
}

/** 归一化 header：只保留字符串值，限制条数与总长，避免被塞垃圾。 */
function sanitizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  let count = 0;
  let bytes = 0;
  for (const [key, value] of Object.entries(headers)) {
    if (count >= 64) break;
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) continue;
    bytes += key.length + value.length;
    if (bytes > 16_384) break;
    out[key] = value;
    count++;
  }
  return out;
}

/** 一条在途请求（device 视角），中继为它在 home 连接上持有独立 id。 */
class Stream {
  constructor({ deviceConn, homeConn, deviceStreamId, homeStreamId, method, path, startedAt }) {
    this.deviceConn = deviceConn;
    this.homeConn = homeConn;
    this.deviceStreamId = deviceStreamId;
    this.homeStreamId = homeStreamId;
    this.method = method;
    this.path = path;
    this.startedAt = startedAt;
    this.resStarted = false;
    this.chunks = 0;
    this.bytes = 0;
    /** 已交给 device socket 但尚未 flush 的字节数（单流缓冲上限的依据）。 */
    this.pendingBytes = 0;
    this.done = false;
    /** 是否是"经隧道的配对请求"：响应需聚合后注入 `relay` 块（契约 §2.3）。 */
    this.pairClaim = false;
    /** 聚合中的响应（仅 pairClaim 流使用）。 */
    this.hold = null;
  }
}

/** home 自己发起的 `req` → 中继控制面的应答聚合（waitForResponse 用）。 */
class PendingResponse {
  constructor({ resolve, timer }) {
    this.resolve = resolve;
    this.timer = timer;
    this.status = null;
    this.headers = {};
    this.chunks = [];
    this.bytes = 0;
  }

  finish(result) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(result);
  }
}

/** home 连接（PC 网关出站长连接的隧道端点）。 */
class HomeConnection {
  constructor({ hub, home, ws, name = '' }) {
    this.hub = hub;
    this.homeId = home.homeId;
    this.homeName = home.homeName;
    /** 建立连接时所用的 homeToken 摘要：用于在外部轮换令牌后判定"这条连接已失效"。 */
    this.homeTokenHash = home.homeTokenHash;
    this.name = name || home.homeName;
    this.ws = ws;
    this.key = `home:${home.homeId}`;
    this.helloDone = false;
    this.nextStreamId = 1;
    /** @type {Map<number, Stream>} 中继→home 的在途请求（id 由中继分配） */
    this.streams = new Map();
    /** @type {Map<number, PendingResponse>} 中继自身向 home 发出的 HTTP 转发（pair/claim） */
    this.pending = new Map();
    this.lastSeenAt = hub.now();
    this.connectedAt = hub.now();
    this.pingSeq = 0;
    this.heartbeatTimer = null;
    this.helloTimer = null;
    /** 导致本连接被暂停读的对端 key 集合（背压）。 */
    this.pressureHolders = new Set();
  }

  get pendingBytes() {
    return this.ws.pendingBytes;
  }

  /** 协议级错误帧；fatal 时随后关闭连接（契约 §3.1：`fatal:true` → 中继随后关闭）。 */
  sendFrameError(code, message, fatal = false) {
    this.ws.sendJson({ t: 'error', code: ERROR_CODES.includes(code) ? code : 'bad_request', message, fatal });
    if (fatal) this.ws.close(CLOSE.POLICY_VIOLATION, code);
  }

  respond(id, status, bodyObj) {
    const body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    this.ws.sendJson({ t: 'res', id, status, headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) } });
    this.ws.sendJson({ t: 'chunk', id, dataB64: body.toString('base64') });
    this.ws.sendJson({ t: 'end', id });
  }

  /** 中继发起的请求（转发 device 的 req）。 */
  sendRequest({ id, method, path, headers, bodyB64 }) {
    const frame = { t: 'req', id, method, path, headers };
    if (bodyB64 !== undefined) frame.bodyB64 = bodyB64;
    return this.ws.sendJson(frame);
  }

  dispose() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    for (const pending of this.pending.values()) pending.finish({ ok: false, code: 'home_offline' });
    this.pending.clear();
  }
}

/** device 连接（手机经中继的隧道端点）。 */
class DeviceConnection {
  constructor({ hub, home, device, ws }) {
    this.hub = hub;
    this.homeId = home.homeId;
    this.homeName = home.homeName;
    this.deviceId = device.deviceId;
    this.deviceName = device.deviceName;
    this.tokenId = device.tokenId;
    /** 建立连接时所用的 deviceToken 摘要：轮换后用于判定"这条连接已失效"（§2.3）。 */
    this.deviceTokenHash = device.deviceTokenHash;
    this.ws = ws;
    this.key = `device:${home.homeId}:${device.deviceId}`;
    this.helloDone = false;
    /** @type {Map<number, Stream>} device 视角的在途请求 */
    this.streams = new Map();
    this.lastSeenAt = hub.now();
    this.connectedAt = hub.now();
    this.pingSeq = 0;
    this.heartbeatTimer = null;
    this.helloTimer = null;
    this.pressureHolders = new Set();
  }

  get pendingBytes() {
    return this.ws.pendingBytes;
  }

  /** 回一个"真实 HTTP 形状"的错误响应：res + chunk(body) + end（契约 §3.5）。 */
  sendErrorResponse(id, status, code, message) {
    const body = Buffer.from(JSON.stringify({ error: { code, message } }), 'utf8');
    this.ws.sendJson({ t: 'res', id, status, headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) } });
    this.ws.sendJson({ t: 'chunk', id, dataB64: body.toString('base64') });
    this.ws.sendJson({ t: 'end', id });
  }

  /** 协议级错误（非致命时连接保留）。 */
  sendFrameError(code, message, fatal = false) {
    this.ws.sendJson({ t: 'error', code: ERROR_CODES.includes(code) ? code : 'bad_request', message, fatal });
    if (fatal) this.ws.close(CLOSE.POLICY_VIOLATION, code);
  }

  dispose() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }
}

/**
 * 隧道中枢：所有在线连接、流表、心跳与背压的唯一持有者。
 */
export class TunnelHub {
  /**
   * @param {{config: object, registry: object, logger?: object|null, now?: () => number}} opts
   */
  constructor({ config, registry, logger = null, now = Date.now }) {
    this.config = config;
    this.registry = registry;
    this.logger = logger;
    this.now = now;
    /** @type {Map<string, HomeConnection>} homeId → 在线 home 连接 */
    this.homes = new Map();
    /** @type {Map<string, DeviceConnection>} connKey → device 连接 */
    this.devices = new Map();
    /** @type {Map<string, Set<DeviceConnection>>} homeId → 该 home 的在线 device 集合 */
    this.devicesByHome = new Map();
    this.connSeq = 0;
    this.startedAt = now();
    this.counters = {
      requests: 0,
      forwarded: 0,
      aborts: 0,
      overflows: 0,
      rejected: 0,
      backpressurePauses: 0,
      deviceForbidden: 0,
      streamRejected: 0,
      helloTimeouts: 0,
      pairClaimInjected: 0,
      heartbeatTimeouts: 0,
    };
  }

  get limits() {
    return this.config.limits;
  }

  // ---------------------------------------------------------------- 准入

  /**
   * 接入 home 隧道（鉴权已在 HTTP 升级前完成）。
   *
   * ⚠️ **在收到 `hello` 之前，中继一个帧都不发**（契约 §3.1「hello 首帧，必须最先发」）。
   * 这条不是"洁癖"：P0 真联调死锁的根因就是中继在升级后**主动先发 `ready`**，
   * 而网关的 `ready` 监听器是在 `await client.connect()` 之后才挂上的 ——
   * 与握手响应同批到达的 `ready` 因此被丢掉，双方互相等待（中继等 hello、网关等 ready）。
   * 中继只在收到 hello 后应答 ready，这类"帧比监听器先到"的竞态就不可能发生。
   * @param {import('./ws.mjs').WebSocketConnection} ws
   * @param {object} home 注册表记录
   * @param {{name?: string}} [opts]
   * @returns {HomeConnection}
   */
  attachHome(ws, home, { name = '' } = {}) {
    const existing = this.homes.get(home.homeId);
    if (existing) {
      // 同一 home 的旧连接被新连接取代：旧连接上的流全部作废（网关重连后会重发请求）
      this.logger?.warn?.(`home 重复连接，替换旧连接 homeId=${home.homeId}`);
      this.#dropHome(existing, 'peer_closed', { notify: false });
      existing.ws.close(CLOSE.GOING_AWAY, 'replaced');
    }
    const conn = new HomeConnection({ hub: this, home, ws, name });
    this.homes.set(home.homeId, conn);
    this.#trackLiveness(conn);
    this.#startHelloDeadline(conn);
    this.logger?.info?.(`home 隧道已升级，等待 hello homeId=${home.homeId}（超时 ${this.limits.helloTimeoutMs}ms）`);
    return conn;
  }

  /**
   * 接入 device 隧道（鉴权已在 HTTP 升级前完成）；同样等 `hello` 才回 `ready`。
   * @param {import('./ws.mjs').WebSocketConnection} ws
   * @param {{home: object, device: object}} binding
   * @returns {DeviceConnection}
   */
  attachDevice(ws, { home, device }) {
    // 同一 deviceId 的旧连接：令牌已轮换，一律踢掉（契约 §2.3）
    for (const other of [...(this.devicesByHome.get(home.homeId) ?? [])]) {
      if (other.deviceId === device.deviceId && other.ws !== ws) {
        other.ws.sendJson({ t: 'notice', kind: 'revoked', homeId: home.homeId });
        other.ws.close(CLOSE.POLICY_VIOLATION, 'revoked');
        this.#dropDevice(other, 'peer_closed');
      }
    }
    const conn = new DeviceConnection({ hub: this, home, device, ws });
    this.devices.set(conn.key, conn);
    if (!this.devicesByHome.has(home.homeId)) this.devicesByHome.set(home.homeId, new Set());
    this.devicesByHome.get(home.homeId).add(conn);
    this.#trackLiveness(conn);
    this.#startHelloDeadline(conn);
    this.logger?.info?.(`device 隧道已升级，等待 hello homeId=${home.homeId} deviceId=${device.deviceId}（超时 ${this.limits.helloTimeoutMs}ms）`);
    return conn;
  }

  // ---------------------------------------------------------------- 帧分发

  /** device 连接收到一帧（JSON 文本）。 */
  onDeviceFrame(conn, raw) {
    const frame = this.#parseFrame(conn, raw);
    if (!frame) return;
    conn.lastSeenAt = this.now();
    if (!conn.helloDone) {
      if (frame.t !== 'hello') {
        conn.sendFrameError('bad_request', '首帧必须是 hello（契约 §3.1）', true);
        return this.#dropDevice(conn, 'peer_closed');
      }
      if (frame.proto !== this.config.apiVersion) {
        conn.sendFrameError('bad_request', `不支持的 proto：${JSON.stringify(frame.proto)}（本中继为 ${this.config.apiVersion}）`, true);
        return this.#dropDevice(conn, 'peer_closed');
      }
      if (frame.role !== undefined && frame.role !== 'device') {
        conn.sendFrameError('forbidden', `role 必须是 device（当前：${JSON.stringify(frame.role)}）`, true);
        return this.#dropDevice(conn, 'peer_closed');
      }
      conn.helloDone = true;
      this.#clearHelloDeadline(conn);
      conn.deviceName = str(frame.name, conn.deviceName);
      this.#completeDeviceHello(conn);
      return;
    }
    switch (frame.t) {
      case 'req':
        return this.#onDeviceRequest(conn, frame);
      case 'cancel':
        return this.#onDeviceCancel(conn, frame);
      case 'ping':
        conn.ws.sendJson(frame.id === undefined ? { t: 'pong' } : { t: 'pong', id: frame.id });
        return;
      case 'pong':
        return;
      case 'hello':
        return; // 重复 hello 忽略（幂等）
      case 'notice':
      case 'ready':
      case 'res':
      case 'chunk':
      case 'end':
      case 'abort':
        conn.sendFrameError('bad_request', `device 连接不应发送 ${frame.t} 帧`, false);
        return;
      default:
        conn.sendFrameError('bad_request', `未知帧类型：${JSON.stringify(frame.t)}`, false);
    }
  }

  /** home 连接收到一帧（JSON 文本）。 */
  onHomeFrame(conn, raw) {
    const frame = this.#parseFrame(conn, raw);
    if (!frame) return;
    conn.lastSeenAt = this.now();
    if (!conn.helloDone) {
      if (frame.t !== 'hello') {
        conn.sendFrameError('bad_request', '首帧必须是 hello（契约 §3.1）', true);
        return this.#dropHome(conn, 'peer_closed');
      }
      if (frame.proto !== this.config.apiVersion) {
        conn.sendFrameError('bad_request', `不支持的 proto：${JSON.stringify(frame.proto)}（本中继为 ${this.config.apiVersion}）`, true);
        return this.#dropHome(conn, 'peer_closed');
      }
      if (frame.role !== undefined && frame.role !== 'home') {
        conn.sendFrameError('forbidden', `role 必须是 home（当前：${JSON.stringify(frame.role)}）`, true);
        return this.#dropHome(conn, 'peer_closed');
      }
      conn.helloDone = true;
      this.#clearHelloDeadline(conn);
      if (str(frame.name)) conn.name = str(frame.name);
      this.#completeHomeHello(conn);
      return;
    }

    switch (frame.t) {
      case 'req':
        return this.#onHomeControlRequest(conn, frame);
      case 'res':
        return this.#onHomeResponseHead(conn, frame);
      case 'chunk':
        return this.#onHomeChunk(conn, frame);
      case 'end':
        return this.#onHomeEnd(conn, frame);
      case 'abort':
        return this.#onHomeAbort(conn, frame);
      case 'cancel':
        return this.#onHomeCancel(conn, frame);
      case 'ping':
        conn.ws.sendJson(frame.id === undefined ? { t: 'pong' } : { t: 'pong', id: frame.id });
        return;
      case 'pong':
        return;
      case 'hello':
        return;
      default:
        this.logger?.warn?.(`home 连接发来未知帧类型 ${JSON.stringify(frame.t)}，已忽略`);
    }
  }

  #parseFrame(conn, raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      conn.ws.sendJson({ t: 'error', code: 'bad_request', message: '帧不是合法 JSON（NDJSON over WS，契约 §帧格式）', fatal: false });
      return null;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      conn.ws.sendJson({ t: 'error', code: 'bad_request', message: '帧必须是 JSON 对象', fatal: false });
      return null;
    }
    return frame;
  }

  // ---------------------------------------------------------------- device req

  #onDeviceRequest(conn, frame) {
    const id = frame.id;
    if (!Number.isInteger(id) || id < 1) {
      conn.sendFrameError('bad_request', 'req.id 必须是 ≥1 的整数（契约 §1）', false);
      return;
    }
    if (conn.streams.has(id)) {
      conn.sendFrameError('bad_request', `req.id 已在途：${id}（同一连接内 id 必须唯一）`, false);
      return;
    }
    const method = str(frame.method).toUpperCase();
    const path = str(frame.path);
    if (!/^[A-Z]{3,10}$/.test(method) || !path.startsWith('/')) {
      conn.sendErrorResponse(id, 400, 'bad_request', 'method/path 非法');
      return;
    }

    const literalPathname = pathOf(path);
    // 协议相对路径（`//host/x`）不是任何合法 API 形式：直接拒，别让它进 URL 解析的灰色地带
    if (literalPathname.startsWith('//')) {
      conn.sendErrorResponse(id, 400, 'bad_request', 'path 不得以 // 开头');
      return;
    }
    // 安全判定必须基于**规范化后**的路径（网关会用 new URL 折叠 `..`，见 normalizePathname 的说明）
    const pathname = normalizePathname(literalPathname);
    if (isDeviceForbiddenPath(pathname) || isDeviceForbiddenPath(literalPathname)) {
      this.counters.deviceForbidden++;
      this.logger?.warn?.(`拒绝 device 访问管理端点 deviceId=${conn.deviceId} ${method} ${literalPathname}${literalPathname !== pathname ? `（规范化后 ${pathname}）` : ''}`);
      conn.sendErrorResponse(id, 403, 'forbidden', 'device 只能访问自己绑定的 home 的业务端点，不得访问中继/网关管理端点');
      return;
    }

    /**
     * 经隧道配对的响应必须**恒注入 `relay` 块**（契约 §2.3，lead 裁定）：
     * v1/v2 的 `pair/claim` 经隧道转发时，中继要把网关响应里的 deviceToken 叠加
     * homeId / tunnelUrl / apiVersion:2 再回给手机 —— 否则老 App 拿不到 tunnelUrl，
     * 就无法建立设备隧道（这是 gateway-dev 在真互操作里发现的缺陷）。
     * 注意：这里只处理**经隧道**的路径；直连 `POST /api/v2/pair/claim`（§2.3 HTTP 路径）
     * 由 http.mjs 处理；直连 `/api/v1/pair/claim` 响应体逐字不变（v1 向后兼容铁律）。
     */
    const isPairClaim = method === 'POST' && (pathname === '/api/v1/pair/claim' || pathname === '/api/v2/pair/claim');

    let bodyB64 = frame.bodyB64;
    if (bodyB64 !== undefined && bodyB64 !== null) {
      if (!isStrictBase64(bodyB64)) {
        conn.sendErrorResponse(id, 400, 'bad_request', 'bodyB64 不是合法 base64');
        return;
      }
      const decoded = Buffer.from(bodyB64, 'base64');
      if (decoded.length > this.limits.maxBodyBytes) {
        conn.sendErrorResponse(id, 413, 'payload_too_large', `请求体超过上限 ${this.limits.maxBodyBytes} 字节`);
        return;
      }
    } else {
      bodyB64 = undefined;
    }

    // 上限 1：单连接并发流（契约 §3.2 / §3.5：回 429 而不是 abort，保证 TunnelHttp 语义与真实 HTTP 一致）
    if (conn.streams.size >= this.limits.maxStreamsPerConnection) {
      this.counters.streamRejected++;
      conn.sendErrorResponse(id, 429, 'too_many_streams', `单连接并发流上限 ${this.limits.maxStreamsPerConnection} 已满`);
      return;
    }

    const homeConn = this.homes.get(conn.homeId);
    if (!homeConn) {
      // 上限 2：home 离线 → 503 home_offline（同时 device 早已收到 notice{home_offline}）
      this.counters.rejected++;
      conn.sendErrorResponse(id, 503, 'home_offline', '电脑离线：隧道未连接');
      return;
    }

    const homeStreamId = homeConn.nextStreamId++;
    const stream = new Stream({
      deviceConn: conn,
      homeConn,
      deviceStreamId: id,
      homeStreamId,
      method,
      path,
      startedAt: this.now(),
    });
    conn.streams.set(id, stream);
    homeConn.streams.set(homeStreamId, stream);
    this.counters.requests++;
    if (isPairClaim) {
      // 这条流的响应要先在内存里聚合，才能注入 `relay` 块（响应体很小，且有缓冲上限兜底）
      stream.pairClaim = true;
      stream.hold = { status: null, headers: {}, chunks: [], bytes: 0 };
    }

    const headers = sanitizeHeaders(frame.headers);
    const ok = homeConn.sendRequest({ id: homeStreamId, method, path, headers, bodyB64 });
    this.#updateHomePressure(homeConn);
    if (!ok && !homeConn.ws.writable) {
      this.#removeStream(stream);
      conn.sendErrorResponse(id, 503, 'home_offline', '电脑离线：隧道写入失败');
      return;
    }
    this.#updateDevicePressure(conn);
  }

  #onDeviceCancel(conn, frame) {
    const id = frame.id;
    const stream = conn.streams.get(id);
    if (!stream) return; // 已结束的流：静默（cancel 是幂等的）
    this.#sendHome(stream.homeConn, { t: 'cancel', id: stream.homeStreamId });
    conn.ws.sendJson({ t: 'abort', id, reason: 'canceled' });
    this.#removeStream(stream);
  }

  // ---------------------------------------------------------------- home 应答

  #onHomeResponseHead(conn, frame) {
    const pending = conn.pending.get(frame.id);
    if (pending) {
      pending.status = Number.isInteger(frame.status) ? frame.status : 502;
      pending.headers = sanitizeHeaders(frame.headers);
      return;
    }
    const stream = conn.streams.get(frame.id);
    if (!stream) return this.#unknownHomeId(conn, frame);
    if (stream.done) return;
    const status = Number.isInteger(frame.status) ? frame.status : 502;
    const headers = sanitizeHeaders(frame.headers);
    if (stream.hold) {
      // 配对响应：先攒着，等 `end` 时注入 relay 块再一次性回给手机
      stream.hold.status = status;
      stream.hold.headers = headers;
      return;
    }
    stream.resStarted = true;
    stream.deviceConn.ws.sendJson({ t: 'res', id: stream.deviceStreamId, status, headers });
  }

  #onHomeChunk(conn, frame) {
    const pending = conn.pending.get(frame.id);
    if (pending) {
      const buf = Buffer.from(str(frame.dataB64), 'base64');
      pending.chunks.push(buf);
      pending.bytes += buf.length;
      if (pending.bytes > this.limits.maxStreamBufferBytes) {
        // pair/claim 的转发同样是"响应缓冲"：不能让网关把中继内存撑爆
        conn.pending.delete(frame.id);
        conn.ws.sendJson({ t: 'cancel', id: frame.id });
        pending.finish({ ok: false, code: 'overflow', message: '网关响应超过缓冲上限' });
      }
      return;
    }
    const stream = conn.streams.get(frame.id);
    if (!stream || stream.done) return this.#unknownHomeId(conn, frame);
    const dataB64 = str(frame.dataB64);
    if (!isStrictBase64(dataB64)) {
      this.#abortStream(stream, 'internal', 'chunk.dataB64 不是合法 base64');
      return;
    }
    const buf = Buffer.from(dataB64, 'base64');
    if (buf.length > this.limits.maxChunkBytes) {
      // 契约 §3.2：单条 chunk 解码后 ≤ 256 KiB；超出即 abort overflow（res 可能已发出，只能用 abort）
      this.counters.overflows++;
      this.#abortStream(stream, 'overflow', `chunk ${buf.length} 字节超过上限 ${this.limits.maxChunkBytes}`);
      return;
    }
    stream.chunks++;
    stream.bytes += buf.length;
    if (stream.hold) {
      // 配对响应聚合中：只记账，不转发（chunk 上限已在上面校验）
      stream.hold.chunks.push(buf);
      stream.hold.bytes += buf.length;
      if (stream.hold.bytes > this.limits.maxStreamBufferBytes) {
        this.counters.overflows++;
        this.#abortStream(stream, 'overflow', `配对响应超过缓冲上限 ${this.limits.maxStreamBufferBytes}`);
      }
      return;
    }
    stream.pendingBytes += buf.length;
    stream.deviceConn.ws.sendJson({ t: 'chunk', id: stream.deviceStreamId, dataB64 }, () => {
      stream.pendingBytes = Math.max(0, stream.pendingBytes - buf.length);
      this.#updateDevicePressure(stream.deviceConn);
    });
    if (stream.pendingBytes > this.limits.maxStreamBufferBytes) {
      // 契约 §3.2：单个 id 缓冲不超过 1 MiB
      this.counters.overflows++;
      this.#abortStream(stream, 'overflow', `单流缓冲 ${stream.pendingBytes} 字节超过上限 ${this.limits.maxStreamBufferBytes}`);
      return;
    }
    this.#updateDevicePressure(stream.deviceConn);
  }

  #onHomeEnd(conn, frame) {
    const pending = conn.pending.get(frame.id);
    if (pending) {
      conn.pending.delete(frame.id);
      pending.finish({ ok: true, status: pending.status ?? 200, headers: pending.headers, body: Buffer.concat(pending.chunks, pending.bytes) });
      return;
    }
    const stream = conn.streams.get(frame.id);
    if (!stream || stream.done) return this.#unknownHomeId(conn, frame);
    if (stream.hold) return this.#finishPairClaim(stream);
    stream.deviceConn.ws.sendJson({ t: 'end', id: stream.deviceStreamId });
    this.#removeStream(stream);
  }

  /**
   * 经隧道配对响应的收尾（契约 §2.3 / lead 裁定）：注入 `relay` 块 + 绑定 deviceToken。
   *
   * 为什么必须由中继做：
   * - 网关的 v1 响应体里没有 `relay` 块（v1 直连响应必须逐字不变），而经隧道的老 App 需要它
   *   才能拿到 `tunnelUrl` → 没有它就无法建立设备隧道（真互操作发现的缺陷）；
   * - 新签发的 deviceToken 必须被中继记住 `sha256` 才能用于后续 device 隧道握手。
   *
   * 非 200 或非 JSON 响应一律**原样透出**（不注入、不绑定）：错误语义归网关。
   */
  #finishPairClaim(stream) {
    const hold = stream.hold;
    const deviceConn = stream.deviceConn;
    const homeId = stream.homeConn.homeId;
    const raw = Buffer.concat(hold.chunks, hold.bytes);
    let payload = null;
    if (hold.status === 200 && raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
      } catch {
        payload = null;
      }
    }

    const sendPlain = (status, headers, body) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
      deviceConn.ws.sendJson({ t: 'res', id: stream.deviceStreamId, status, headers: { ...headers, 'content-length': String(buf.length) } });
      if (buf.length > 0) deviceConn.ws.sendJson({ t: 'chunk', id: stream.deviceStreamId, dataB64: buf.toString('base64') });
      deviceConn.ws.sendJson({ t: 'end', id: stream.deviceStreamId });
    };

    if (!payload) {
      sendPlain(hold.status ?? 502, hold.headers, raw);
      this.#removeStream(stream);
      return;
    }

    const deviceToken = str(payload?.relay?.deviceToken) || (typeof payload?.token === 'string' && payload.token ? payload.token : '');
    if (!deviceToken) {
      // 网关没给令牌（异常响应）：原样透出，别伪造 relay 块骗手机
      this.logger?.warn?.(`经隧道配对响应缺少 deviceToken，原样透出（homeId=${homeId} status=${hold.status}）`);
      sendPlain(hold.status, hold.headers, raw);
      this.#removeStream(stream);
      return;
    }

    // 绑定必须用**隧道身份**的 deviceId：否则设备可以借别人的 deviceId 覆盖绑定
    const bodyDeviceId = str(payload?.deviceId);
    if (bodyDeviceId && bodyDeviceId !== deviceConn.deviceId) {
      this.logger?.warn?.(`配对响应里的 deviceId 与隧道身份不一致（忽略响应体值）tunnel=${deviceConn.deviceId}`);
    }
    let rotated = false;
    try {
      const bound = this.registry.bindDevice({
        homeId,
        deviceId: deviceConn.deviceId,
        deviceName: deviceConn.deviceName,
        deviceToken,
        tokenId: str(payload?.tokenId),
      });
      rotated = bound.rotated;
      // 当前连接的身份同步到新摘要：否则下一次注册表对账会把它当成"旧令牌连接"误杀
      deviceConn.deviceTokenHash = bound.device.deviceTokenHash;
      void this.registry.flush();
      if (rotated) {
        // 轮换：吊销该 deviceId 的**其它**连接（正在配对的这一条保留，否则手机刚配对就被踢）
        this.dropDeviceByIdentity(homeId, deviceConn.deviceId, { exceptKey: deviceConn.key });
      }
    } catch (err) {
      this.logger?.error?.(`绑定 deviceToken 失败：${err.message}`);
    }

    const injected = {
      ...payload,
      relay: {
        ...(payload.relay ?? {}),
        homeId,
        deviceToken,
        tunnelUrl: deriveTunnelUrl(this.config),
        apiVersion: this.config.apiVersion,
      },
    };
    const body = Buffer.from(JSON.stringify(injected), 'utf8');
    this.counters.pairClaimInjected++;
    this.logger?.info?.(`经隧道配对成功（已注入 relay 块）homeId=${homeId} deviceId=${deviceConn.deviceId} tokenId=${str(payload?.tokenId) || '-'} 轮换=${rotated}`);
    sendPlain(hold.status, { ...hold.headers, 'content-type': 'application/json; charset=utf-8' }, body);
    this.#removeStream(stream);
  }

  #onHomeAbort(conn, frame) {
    const reason = normalizeHomeAbortReason(frame.reason);
    const pending = conn.pending.get(frame.id);
    if (pending) {
      conn.pending.delete(frame.id);
      pending.finish({ ok: false, code: reason === 'overflow' ? 'overflow' : 'internal' });
      return;
    }
    const stream = conn.streams.get(frame.id);
    if (!stream || stream.done) return this.#unknownHomeId(conn, frame);
    stream.deviceConn.ws.sendJson({ t: 'abort', id: stream.deviceStreamId, reason });
    this.#removeStream(stream);
  }

  #onHomeCancel(conn, frame) {
    // home 取消一条由 device 发起的请求：等价于该 home 主动 abort（reason=canceled）
    const stream = conn.streams.get(frame.id);
    if (!stream || stream.done) return;
    stream.deviceConn.ws.sendJson({ t: 'abort', id: stream.deviceStreamId, reason: 'canceled' });
    this.#removeStream(stream);
  }
  #unknownHomeId(conn, frame) {
    // 迟到的 res/chunk/end（流已被 abort/取消）是正常竞态：不报错、不升级为协议错误，只记一条 warn
    this.logger?.warn?.(`home 连接返回未知/已结束的流 id=${JSON.stringify(frame.id)}（t=${frame.t}），已忽略`);
  }

  // ---------------------------------------------------------------- 控制面（§3.4）

  #onHomeControlRequest(conn, frame) {
    const id = frame.id;
    if (!Number.isInteger(id) || id < 1) {
      conn.ws.sendJson({ t: 'error', code: 'bad_request', message: 'req.id 必须是 ≥1 的整数', fatal: false });
      return;
    }
    const method = str(frame.method).toUpperCase();
    // 控制面路由同样按**规范化后**的路径匹配：既不让 `/api/v2/pair/./window` 之类的写法绕过白名单，
    // 也让合法但写法奇怪的路径能正确命中。
    const pathname = normalizePathname(pathOf(str(frame.path)));

    if (method === 'POST' && pathname === '/api/v2/pair/window') {
      const body = this.#decodeBody(frame);
      if (body.error) return conn.respond(id, 400, { error: { code: 'bad_request', message: body.error } });
      const result = this.registry.openPairWindow(conn.homeId, { code: body.value?.code ?? null, expiresAt: body.value?.expiresAt ?? null });
      if (!result.ok) {
        const status = result.code === 'code_conflict' ? 409 : 400;
        // §3.4：码冲突 → 409 code_conflict，网关换码重试（最多 5 次）
        this.logger?.warn?.(`配对窗口声明被拒 homeId=${conn.homeId} code=${result.code}`);
        return conn.respond(id, status, { error: { code: result.code, message: result.message } });
      }
      this.logger?.info?.(`配对窗口已打开 homeId=${conn.homeId} expiresAt=${new Date(result.expiresAt).toISOString()}`);
      return conn.respond(id, 200, { code: result.code, expiresAt: result.expiresAt });
    }

    if (method === 'GET' && pathname === '/api/v2/pair/window') {
      return conn.respond(id, 200, this.registry.getPairWindow(conn.homeId));
    }

    if (method === 'POST' && pathname === '/api/v2/pair/close') {
      const closed = this.registry.closePairWindow(conn.homeId);
      this.logger?.info?.(`配对窗口已关闭 homeId=${conn.homeId} closed=${closed}`);
      return conn.respond(id, 200, { open: false });
    }

    // 契约 §3.4：未命中控制面路由表一律拒绝 —— home 不得借隧道访问中继的对外管理端点
    this.counters.rejected++;
    this.logger?.warn?.(`拒绝 home 借隧道访问非控制面路由：${method} ${pathname}`);
    conn.respond(id, 404, { error: { code: 'not_found', message: `中继控制面只允许 ${CONTROL_ROUTES.map((r) => `${r.method} ${r.path}`).join(' | ')}` } });
  }

  #decodeBody(frame) {
    const raw = frame.bodyB64;
    if (raw === undefined || raw === null) return { value: {} };
    if (!isStrictBase64(str(raw))) return { error: 'bodyB64 不是合法 base64' };
    const text = Buffer.from(String(raw), 'base64').toString('utf8');
    if (!text.trim()) return { value: {} };
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: '请求体必须是 JSON 对象' };
      return { value };
    } catch {
      return { error: '请求体不是合法 JSON' };
    }
  }

  // ---------------------------------------------------------------- HTTP 侧转发

  /**
   * 把一次 HTTP 请求经指定 home 的隧道转发到网关（契约 §2.3 pair/claim 用）。
   * @param {string} homeId
   * @param {{method: string, path: string, headers?: Record<string,string>, body?: Buffer|string|null, timeoutMs?: number}} opts
   * @returns {Promise<{ok: true, status: number, headers: object, body: Buffer} | {ok: false, code: 'home_offline'|'timeout'|'internal', message?: string}>}
   */
  async forwardHttp(homeId, { method, path, headers = {}, body = null, timeoutMs = null }) {
    const conn = this.homes.get(str(homeId));
    if (!conn) return { ok: false, code: 'home_offline', message: 'home 隧道不在线' };
    const id = conn.nextStreamId++;
    const bodyBuf = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const limits = this.limits;
    const waitMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : limits.forwardTimeoutMs;

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        conn.ws.sendJson({ t: 'cancel', id });
        this.counters.aborts++;
        resolve({ ok: false, code: 'timeout', message: `网关在 ${waitMs}ms 内未返回` });
      }, waitMs);
      timer.unref?.();
      const pending = new PendingResponse({ resolve: (result) => resolve(result), timer });
      conn.pending.set(id, pending);
      this.counters.forwarded++;
      try {
        const sent = conn.sendRequest({ id, method: method.toUpperCase(), path, headers: sanitizeHeaders(headers), bodyB64: bodyBuf ? bodyBuf.toString('base64') : undefined });
        this.#updateHomePressure(conn);
        if (!sent && !conn.ws.writable) {
          conn.pending.delete(id);
          pending.finish({ ok: false, code: 'home_offline', message: '隧道写入失败' });
        }
      } catch (err) {
        conn.pending.delete(id);
        pending.finish({ ok: false, code: 'internal', message: err.message });
      }
    });
  }

  // ---------------------------------------------------------------- 心跳 / 背压

  #startHeartbeat(conn) {
    const { intervalMs, timeoutMs } = this.config.heartbeat;
    conn.heartbeatTimer = setInterval(() => {
      // 顺序很重要（P0 修复）：**先发 ping，再判 idle**。
      // 旧顺序（先判后发）在 `timeoutMs === intervalMs` 时必然误杀：第 1 个 tick 时 idle 就已经 ≈ intervalMs，
      // 只要定时器晚几毫秒（实测 30008ms）`idle > timeoutMs` 就成立 → 连接被踢，而那个 ping 根本没发出去，
      // 对端因此永远收不到 JSON ping、也不会回 JSON pong → **不可自愈**的死循环。
      conn.ws.sendJson({ t: 'ping', id: ++conn.pingSeq });
      if (conn instanceof HomeConnection) this.#updateHomePressure(conn);

      const idle = this.now() - conn.lastSeenAt;
      this.logger?.debug?.(`心跳 tick key=${conn.key} idle=${idle}ms timeout=${timeoutMs}ms`);
      if (idle > timeoutMs) {
        // 契约 §3.1：超时无任何入站活动视为死链 —— 直接断开并清理，绝不留下半开连接。
        // `lastSeenAt` 现在由**任何入站活动**推进（含 RFC 层 ping/pong，见 #trackLiveness）。
        this.counters.heartbeatTimeouts++;
        this.logger?.warn?.(`心跳超时（${idle}ms 无任何入站活动，阈值 ${timeoutMs}ms），断开连接 key=${conn.key}`);
        if (conn instanceof HomeConnection) this.#dropHome(conn, 'timeout');
        else this.#dropDevice(conn, 'timeout');
        conn.ws.terminate();
        return;
      }
    }, intervalMs);
    conn.heartbeatTimer.unref?.();
    return conn.heartbeatTimer;
  }

  /**
   * 把"对端活着"的信号接到 `lastSeenAt` 上（P0 修复的核心）。
   *
   * 三类信号都要算：
   * 1. `activity`：WS 层收到的**任何字节**（含 RFC 6455 的 ping/pong 控制帧）；
   * 2. `pong`：协议级 pong —— RFC 层"对端确实活着"的权威信号（lead 指出旧实现完全漏了它）；
   * 3. JSON 文本帧（在 `onHomeFrame`/`onDeviceFrame` 里更新，保持原有语义）。
   * 旧实现只记账第 3 类，于是网关每 30s 发来的协议级 ping 完全不被计入 → 健康连接被判死链。
   */
  #trackLiveness(conn) {
    const touch = () => {
      conn.lastSeenAt = this.now();
    };
    conn.ws.on('activity', touch);
    conn.ws.on('pong', touch);
    conn.ws.on('ping', touch);
  }

  /**
   * 首帧超时：升级成功但迟迟不发 `hello` 的连接必须被**主动、有日志地**拒绝。
   *
   * 为什么与心跳解耦：第一版把这件事交给 30s 心跳兜底，而网关等 `ready` 只等 10s，
   * 于是双方反复重连、看起来像死锁（真联调 P0）。独立成 10s 截止时间后，协议违例立刻暴露。
   */
  #startHelloDeadline(conn) {
    conn.helloTimer = setTimeout(() => {
      if (conn.helloDone || !conn.ws.open) return;
      this.counters.helloTimeouts++;
      this.logger?.warn?.(`未收到 hello，关闭连接（等待 ${this.limits.helloTimeoutMs}ms 超时）key=${conn.key}`);
      conn.sendFrameError('bad_request', `未在规定时间内收到 hello（契约 §3.1：hello 必须最先发），已关闭连接`, true);
      if (conn instanceof HomeConnection) this.#dropHome(conn, 'timeout');
      else this.#dropDevice(conn, 'timeout');
      // 不立即 terminate：先让 close 帧发出去（对端不回则 3s 强制断开由 ws 层兜底）
    }, this.limits.helloTimeoutMs);
    conn.helloTimer.unref?.();
  }

  #clearHelloDeadline(conn) {
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
  }

  /** home 的 hello 通过后：回 ready、开始心跳、并通知在等的 device。 */
  #completeHomeHello(conn) {
    conn.ws.sendJson({ t: 'ready', proto: this.config.apiVersion, role: 'home', homeId: conn.homeId });
    this.#startHeartbeat(conn);
    this.logger?.info?.(`home 隧道上线 homeId=${conn.homeId} name=${conn.name}`);
    // 该 home 的 device 可能已经在等（此前收到过 home_offline）
    for (const device of this.devicesByHome.get(conn.homeId) ?? []) {
      device.ws.sendJson({ t: 'notice', kind: 'home_online', homeId: conn.homeId });
    }
  }

  /** device 的 hello 通过后：回 ready、开始心跳、并在 home 离线时补一条 notice。 */
  #completeDeviceHello(conn) {
    const homeOnline = this.homes.has(conn.homeId);
    conn.ws.sendJson({
      t: 'ready',
      proto: this.config.apiVersion,
      role: 'device',
      homeId: conn.homeId,
      homeName: conn.homeName,
      homeOnline,
    });
    this.#startHeartbeat(conn);
    this.logger?.info?.(`device 隧道上线 homeId=${conn.homeId} deviceId=${conn.deviceId} homeOnline=${homeOnline}`);
    if (!homeOnline) conn.ws.sendJson({ t: 'notice', kind: 'home_offline', homeId: conn.homeId });
  }

  /** 向 home 写一帧并顺带做写方向背压判定。 */
  #sendHome(conn, obj) {
    const ok = conn.ws.sendJson(obj);
    this.#updateHomePressure(conn);
    return ok;
  }

  /**
   * 写方向（device）缓冲增长 → 暂停读它的上游 home（契约 §3.2）。
   * 阈值取 bufferedAmount > 4 MiB；降到 1/4 时恢复，避免在阈值附近抖动。
   */
  #updateDevicePressure(conn) {
    const homeConn = this.homes.get(conn.homeId);
    if (!homeConn || !homeConn.ws.open) return;
    const bp = this.limits.backpressureBytes;
    if (conn.ws.pendingBytes > bp) {
      if (!homeConn.pressureHolders.has(conn.key)) {
        homeConn.pressureHolders.add(conn.key);
        if (homeConn.pressureHolders.size === 1) {
          homeConn.ws.pauseRead();
          this.counters.backpressurePauses++;
          this.logger?.warn?.(`背压：device 缓冲 ${conn.ws.pendingBytes} 字节 > ${bp}，暂停读取 home 连接`);
        }
      }
      return;
    }
    if (homeConn.pressureHolders.has(conn.key) && conn.ws.pendingBytes <= Math.floor(bp / 4)) {
      homeConn.pressureHolders.delete(conn.key);
      if (homeConn.pressureHolders.size === 0) homeConn.ws.resumeRead();
    }
  }

  /** 写方向（home）缓冲增长 → 暂停读该 home 的所有 device（对称背压）。 */
  #updateHomePressure(conn) {
    const bp = this.limits.backpressureBytes;
    for (const device of this.devicesByHome.get(conn.homeId) ?? []) {
      if (conn.ws.pendingBytes > bp) {
        if (!device.pressureHolders.has(conn.key)) {
          device.pressureHolders.add(conn.key);
          if (device.pressureHolders.size === 1) {
            device.ws.pauseRead();
            this.counters.backpressurePauses++;
          }
        }
      } else if (device.pressureHolders.has(conn.key) && conn.ws.pendingBytes <= Math.floor(bp / 4)) {
        device.pressureHolders.delete(conn.key);
        if (device.pressureHolders.size === 0) device.ws.resumeRead();
      }
    }
  }

  // ---------------------------------------------------------------- 清理

  #removeStream(stream) {
    if (stream.done) return;
    stream.done = true;
    stream.deviceConn.streams.delete(stream.deviceStreamId);
    stream.homeConn.streams.delete(stream.homeStreamId);
    // 单流缓冲记账随流结束清零；连接级缓冲仍由 WS 层维护
    stream.pendingBytes = 0;
  }

  /** 终止一条流：向 device 发 abort，并向 home 发 cancel（让网关停掉上游工作，例如 SSE）。 */
  #abortStream(stream, reason, message) {
    const finalReason = ABORT_REASONS.includes(reason) ? reason : 'internal';
    this.counters.aborts++;
    this.logger?.warn?.(`流被终止 id=${stream.deviceStreamId}→${stream.homeStreamId} reason=${finalReason}：${message}`);
    stream.deviceConn.ws.sendJson({ t: 'abort', id: stream.deviceStreamId, reason: finalReason });
    this.#sendHome(stream.homeConn, { t: 'cancel', id: stream.homeStreamId });
    this.#removeStream(stream);
  }

  /** home 连接断开：作废其所有流 + 通知该 home 的所有 device。 */
  #dropHome(conn, reason, { notify = true } = {}) {
    if (conn.dropped) return;
    conn.dropped = true;
    if (this.homes.get(conn.homeId) === conn) this.homes.delete(conn.homeId);
    for (const stream of [...conn.streams.values()]) {
      this.counters.aborts++;
      stream.deviceConn.ws.sendJson({ t: 'abort', id: stream.deviceStreamId, reason: reason === 'timeout' ? 'timeout' : 'home_offline' });
      this.#removeStream(stream);
    }
    conn.dispose();
    if (notify) {
      for (const device of this.devicesByHome.get(conn.homeId) ?? []) {
        device.ws.sendJson({ t: 'notice', kind: 'home_offline', homeId: conn.homeId });
      }
      this.logger?.info?.(`home 隧道下线 homeId=${conn.homeId}（reason=${reason}），已通知 device`);
    }
    for (const device of this.devicesByHome.get(conn.homeId) ?? []) {
      device.pressureHolders.delete(conn.key);
      if (device.pressureHolders.size === 0) device.ws.resumeRead();
    }
  }

  /** device 连接断开：向 home 发 cancel 释放上游工作。 */
  #dropDevice(conn, _reason) {
    if (conn.dropped) return;
    conn.dropped = true;
    this.devices.delete(conn.key);
    const set = this.devicesByHome.get(conn.homeId);
    set?.delete(conn);
    if (set && set.size === 0) this.devicesByHome.delete(conn.homeId);
    for (const stream of [...conn.streams.values()]) {
      this.#sendHome(stream.homeConn, { t: 'cancel', id: stream.homeStreamId });
      this.#removeStream(stream);
    }
    const homeConn = this.homes.get(conn.homeId);
    if (homeConn) {
      homeConn.pressureHolders.delete(conn.key);
      if (homeConn.pressureHolders.size === 0) homeConn.ws.resumeRead();
    }
    conn.dispose();
    this.logger?.info?.(`device 隧道下线 homeId=${conn.homeId} deviceId=${conn.deviceId}`);
  }

  /**
   * 主动断开某 home（homeToken 轮换时由 HTTP 层调用，契约 §2.2「旧连接被断开」）。
   * @param {string} homeId
   * @param {string} [reason]
   */
  disconnectHome(homeId, reason = 'revoked') {
    const conn = this.homes.get(str(homeId));
    if (!conn) return false;
    this.#dropHome(conn, 'peer_closed');
    conn.ws.close(CLOSE.POLICY_VIOLATION, reason);
    return true;
  }

  /**
   * 依据（轮换后的）注册表更新连接身份：令牌轮换后旧连接必须失效。
   * @param {string} homeId
   * @param {string} deviceId
   * @param {{exceptKey?: string}} [opts] exceptKey：保留这条连接（正在重新配对的手机不该被自己踢掉）
   */
  dropDeviceByIdentity(homeId, deviceId, { exceptKey = null } = {}) {
    let dropped = 0;
    for (const device of [...(this.devicesByHome.get(str(homeId)) ?? [])]) {
      if (device.deviceId !== str(deviceId)) continue;
      if (exceptKey && device.key === exceptKey) continue;
      device.ws.sendJson({ t: 'notice', kind: 'revoked', homeId: device.homeId });
      device.ws.close(CLOSE.POLICY_VIOLATION, 'revoked');
      this.#dropDevice(device, 'revoked');
      dropped++;
    }
    return dropped;
  }

  /** 服务优雅停止 / 测试收尾：关闭全部连接。 */
  closeAll(reason = 'relay shutting down') {
    for (const conn of [...this.homes.values()]) {
      this.#dropHome(conn, 'peer_closed', { notify: true });
      conn.ws.close(CLOSE.GOING_AWAY, reason);
    }
    for (const conn of [...this.devices.values()]) {
      this.#dropDevice(conn, 'peer_closed');
      conn.ws.close(CLOSE.GOING_AWAY, reason);
    }
  }

  /**
   * socket 关闭回调（HTTP 层在 ws 'close' 事件里调用）。
   * 必须幂等：主动断开与对端断开都会走到这里，重复清理会把统计与通知弄乱。
   * @param {HomeConnection} conn
   */
  handleHomeClosed(conn) {
    if (conn.dropped) return;
    this.#dropHome(conn, 'peer_closed');
  }

  /** @param {DeviceConnection} conn */
  handleDeviceClosed(conn) {
    if (conn.dropped) return;
    this.#dropDevice(conn, 'peer_closed');
  }

  /** @param {string} homeId @returns {boolean} */
  isHomeOnline(homeId) {
    return this.homes.has(str(homeId));
  }

  /**
   * 与（可能被外部进程改写过的）注册表对账：
   * - homeToken 已被轮换/删除 → 断开该 home 连接（契约 §2.2「旧连接被断开」）；
   * - deviceToken 已被轮换/吊销 → 推 `notice{kind:'revoked'}` 后断开（契约 §2.3）。
   * 由 HTTP 层的热加载定时器在检测到 homes.json 变更后调用。
   * @returns {{homes: number, devices: number}}
   */
  reconcileWithRegistry() {
    const dropped = { homes: 0, devices: 0 };
    for (const conn of [...this.homes.values()]) {
      const home = this.registry.findHome(conn.homeId);
      if (home && home.homeTokenHash === conn.homeTokenHash) continue;
      dropped.homes++;
      this.logger?.warn?.(`homeToken 已被轮换/删除，断开旧连接 homeId=${conn.homeId}`);
      this.#dropHome(conn, 'peer_closed');
      conn.ws.close(CLOSE.POLICY_VIOLATION, 'revoked');
    }
    for (const conn of [...this.devices.values()]) {
      const home = this.registry.findHome(conn.homeId);
      const device = home?.devices.get(conn.deviceId);
      if (device && device.deviceTokenHash === conn.deviceTokenHash) continue;
      dropped.devices++;
      this.logger?.warn?.(`deviceToken 已被轮换/吊销，断开旧连接 deviceId=${conn.deviceId}`);
      conn.ws.sendJson({ t: 'notice', kind: 'revoked', homeId: conn.homeId });
      conn.ws.close(CLOSE.POLICY_VIOLATION, 'revoked');
      this.#dropDevice(conn, 'revoked');
    }
    return dropped;
  }

  /** @returns {object} 运行期台账（测试/运维断言用）。 */
  stats() {
    // 注意：一条在途请求同时登记在 device 连接与 home 连接两张表里，
    // 因此只统计 device 侧，否则会把流数算成两倍（早期版本就因此让测试误判）。
    let streams = 0;
    for (const conn of this.devices.values()) streams += conn.streams.size;
    let paused = 0;
    for (const conn of this.homes.values()) {
      if (conn.ws.paused) paused++;
    }
    for (const conn of this.devices.values()) {
      if (conn.ws.paused) paused++;
    }
    return {
      homes: this.homes.size,
      devices: this.devices.size,
      streams,
      paused,
      pendingResponses: [...this.homes.values()].reduce((sum, conn) => sum + conn.pending.size, 0),
      tunnelUrl: deriveTunnelUrl(this.config),
      uptimeMs: this.now() - this.startedAt,
      ...this.counters,
    };
  }

  /** 测试/排障：某 home 的 device 数（避免测试直接摸内部结构）。 */
  deviceCountOf(homeId) {
    return this.devicesByHome.get(str(homeId))?.size ?? 0;
  }
}
