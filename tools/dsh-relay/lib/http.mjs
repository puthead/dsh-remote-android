/**
 * 中继 HTTP + WS 入口：对外端点（契约 §2）、隧道升级（契约 §3）、控制面转发。
 *
 * 分层理由：本文件只负责「HTTP 语义 + 准入」，隧道内部的多路复用/背压/心跳全在 `tunnel.mjs`。
 * 这样 `pair/claim` 这类"HTTP 请求经隧道转发成一个普通 HTTP 响应"的逻辑可以复用同一条路径，
 * 不必为它发明新的帧类型（契约 §3.4 对 home 反向调用也是同一个思路）。
 *
 * 端点清单（对外）：
 *   GET  /health                     无需认证（契约 §2.1）
 *   POST /api/v2/homes               注册隧道，返回一次性 homeToken（契约 §2.2）
 *   POST /api/v2/pair/claim          配对码换设备令牌，经隧道转发到网关（契约 §2.3）
 *   WS   /api/v2/tunnel/home         PC 网关出站长连接（Bearer homeToken）
 *   WS   /api/v2/tunnel/device       手机隧道（Bearer deviceToken）
 * 其余路径一律 404；home/device 都不能借隧道访问这些"人/PC 操作面"（见 tunnel.mjs 的路径门禁）。
 */
import http from 'node:http';
import https from 'node:https';
import { API_VERSION, TUNNEL_DEVICE_PATH, TUNNEL_HOME_PATH, deriveTunnelUrl } from './config.mjs';
import { createLogger } from './log.mjs';
import { RelayRegistry } from './registry.mjs';
import { ensureTlsMaterial } from './tls.mjs';
import { TunnelHub } from './tunnel.mjs';
import { DEVICE_ID_RE, hexEquals, normalizePairCode, redactSecrets, redactToken, sha256Hex, str } from './util.mjs';
import { acceptWebSocket, checkUpgradeRequest, rejectUpgrade } from './ws.mjs';

/** 关闭时等待 `server.close()` 回调的上限；超时就自己动手销毁剩余连接。 */
const CLOSE_CONNECTION_GRACE_MS = 3_000;
/** 强制销毁剩余连接后，再给回调这么长时间收尾（超时也不阻塞关闭）。 */
const CLOSE_FORCE_GRACE_MS = 1_000;

/** 一个可取消的超时：`promise` 到点 resolve(false)，`cancel()` 立刻撤销定时器。 */
function timeoutAfter(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** 契约错误码 → HTTP 状态码。 */
export const ERROR_STATUS = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  pairing_closed: 403,
  pairing_bad_code: 401,
  home_not_found: 404,
  not_found: 404,
  bad_request: 400,
  payload_too_large: 413,
  code_conflict: 409,
  too_many_streams: 429,
  rate_limited: 429,
  home_offline: 503,
  overflow: 500,
  timeout: 503,
  internal: 500,
});

/** 带契约错误码的 HTTP 异常。 */
export class HttpError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{status?: number, headers?: Record<string,string>}} [opts]
   */
  constructor(code, message, { status = null, headers = {} } = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code] ?? 500;
    this.headers = headers;
  }
}

/** 客户端在响应前断开：不是服务端错误，静默忽略。 */
class ClientGoneError extends Error {}

/** 简单滑动窗口限速器（只对失败/敏感操作计数）。 */
class RateLimiter {
  constructor({ limit, windowMs, now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  /** @param {string} key @returns {{allowed: boolean, retryAfterSec: number}} */
  hit(key) {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (recent.length > this.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((this.windowMs - (now - recent[0])) / 1000));
      return { allowed: false, retryAfterSec };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  get size() {
    return this.hits.size;
  }
}

/** 归一化远端 IP（去掉 IPv4-mapped 前缀），用于限速键。 */
function normalizeIp(raw) {
  const value = str(raw);
  return value.startsWith('::ffff:') ? value.slice(7) : value || 'unknown';
}

/** 从 Authorization 头取 Bearer 令牌。 */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

/** 固定时间比较两个秘密（relaySecret 校验用）；先哈希再比，长度差异也一并消掉。 */
function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  return hexEquals(sha256Hex(a), sha256Hex(b));
}

/**
 * 创建中继实例（不监听；调用 `listen()` 才开始服务）。
 * @param {object} config 已通过 validateConfig 的配置
 * @param {{logger?: object|null, now?: () => number}} [opts]
 */
export async function createRelay(config, { logger = null, now = Date.now } = {}) {
  const log =
    logger ??
    createLogger({
      dir: config.logsDir,
      filePrefix: config.log?.filePrefix ?? 'relay',
      toConsole: config.log?.toConsole ?? true,
      now,
    });

  const tlsMaterial = await ensureTlsMaterial(config, { logger: log });
  const registry = new RelayRegistry({ file: config.homesFile, logger: log, now, pairWindowTtlMs: config.pairWindowTtlMs });
  const loaded = await registry.load();
  if (loaded > 0) log.info(`已加载 ${loaded} 个 home 记录（只含 sha256 摘要）`);
  const hub = new TunnelHub({ config, registry, logger: log, now });

  const startedAt = now();
  const claimLimiter = new RateLimiter({ limit: config.limits.pairClaimPerMinute, windowMs: 60_000, now });
  const authLimiter = new RateLimiter({ limit: config.limits.authFailPerMinute, windowMs: 60_000, now });
  const counters = { upgradesAccepted: 0, upgradesRejected: 0, wsMessages: 0 };
  const maintenance = new Set();
  /**
   * 已升级为 WebSocket 的原始 socket。
   * 为什么单独记账：Node 的 `server.closeAllConnections()` **不回收已升级的连接**，
   * 只要有一个升级 socket 还活着，`server.close()` 的回调就永远不触发（优雅关闭会挂住）。
   * 因此这里显式跟踪，并在 close() 里强制销毁兜底。
   */
  const upgradedSockets = new Set();

  const handler = (req, res) => {
    handle(req, res).catch((err) => {
      log.error(`HTTP 处理器未捕获异常：${err?.stack ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'internal', message: '中继内部错误' } }));
      }
    });
  };

  const server = tlsMaterial ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, handler) : http.createServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
  server.on('upgrade', (req, socket, head) => onUpgrade(req, socket, head));
  server.on('clientError', (err, socket) => {
    // 畸形 HTTP（例如直接 telnet 灌垃圾）不应让进程抛未捕获异常
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    void err;
  });

  if (config.registrationOpen) {
    log.warn('警告：relaySecret 为空，任何能访问本端口的来源都可注册隧道；公网部署必须设置 relaySecret（见 README 安全章节）');
  }
  log.info(
    `中继初始化完成：relayName=${config.relayName} 监听=${config.host}:${config.port} tls=${config.tls.mode} 隧道=${deriveTunnelUrl(config)}`,
  );

  // 配对窗口是内存态 + TTL：定时清理，保证 `GET /api/v2/pair/window` 的读数及时
  const sweepTimer = setInterval(() => {
    const removed = registry.sweepPairWindows();
    if (removed > 0) log.debug(`清理过期配对窗口 ${removed} 个`);
  }, Math.max(1000, Math.min(60_000, Math.floor(config.pairWindowTtlMs / 5))));
  sweepTimer.unref?.();
  maintenance.add(sweepTimer);

  // homes.json 可能被 `relay.mjs home-token`（另一个进程）改写：周期性热加载，
  // 并对已在线连接做令牌对账（轮换后旧连接必须断开）。周期取 5s：运维"注册后立刻连"能马上生效。
  const registryTimer = setInterval(() => {
    void (async () => {
      await registry.flush();
      const reloaded = await registry.reloadIfChanged();
      if (!reloaded) return;
      const dropped = hub.reconcileWithRegistry();
      log.info(`检测到 homes.json 变更，已热加载（断开失效连接 home=${dropped.homes} device=${dropped.devices}）`);
    })().catch((err) => log.error(`homes.json 热加载失败：${err.message}`));
  }, config.registryReloadIntervalMs);
  registryTimer.unref?.();
  maintenance.add(registryTimer);

  // ------------------------------------------------------------ HTTP 路由

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = normalizeIp(req.socket?.remoteAddress);
    const method = req.method ?? 'GET';
    try {
      if (url.pathname === '/health') {
        if (method !== 'GET') throw new HttpError('bad_request', `方法不允许：${method} /health（允许 GET）`, { status: 405 });
        return sendJson(res, 200, healthPayload());
      }
      if (url.pathname === '/api/v2/homes') {
        if (method !== 'POST') throw new HttpError('bad_request', `方法不允许：${method} /api/v2/homes（允许 POST）`, { status: 405 });
        return await onRegisterHome(req, res, ip);
      }
      if (url.pathname === '/api/v2/pair/claim') {
        if (method !== 'POST') throw new HttpError('bad_request', `方法不允许：${method} /api/v2/pair/claim（允许 POST）`, { status: 405 });
        return await onPairClaim(req, res, ip);
      }
      if (url.pathname === TUNNEL_HOME_PATH || url.pathname === TUNNEL_DEVICE_PATH) {
        // 隧道必须走 WebSocket 升级：普通 HTTP 打到隧道端点时明确指路，而不是 404
        throw new HttpError('bad_request', `${url.pathname} 只接受 WebSocket 升级（Upgrade: websocket）`, { status: 426 });
      }
      throw new HttpError('not_found', `未知接口：${method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof ClientGoneError) return undefined;
      sendError(res, err);
      return undefined;
    }
  }

  function healthPayload() {
    const reg = registry.stats();
    // 严格按契约 §2.1 的形状：多余字段会被三方的契约测试当作偏差
    return {
      ok: true,
      relayVersion: config.relayVersion,
      apiVersion: config.apiVersion,
      uptimeMs: now() - startedAt,
      homes: reg.homes,
      devices: reg.devices,
      relayName: config.relayName,
    };
  }

  /** 契约 §2.2：PC 注册隧道，返回一次性 homeToken（只在本次响应出现）。 */
  async function onRegisterHome(req, res, ip) {
    const body = await readJsonBody(req);
    if (config.relaySecret) {
      const provided = str(body?.relaySecret);
      if (!secretEquals(provided, config.relaySecret)) {
        const gate = authLimiter.hit(ip);
        log.warn(`home 注册被拒（relaySecret 不匹配）ip=${ip} provided=${redactToken(provided)}`);
        if (!gate.allowed) throw new HttpError('rate_limited', '注册失败次数过多，请稍后重试', { headers: { 'Retry-After': String(gate.retryAfterSec) } });
        throw new HttpError('unauthorized', 'relaySecret 缺失或不正确');
      }
    } else {
      log.warn(`home 注册未校验 relaySecret（配置为空）ip=${ip}`);
    }
    const homeName = str(body?.homeName).trim();
    if (!homeName) throw new HttpError('bad_request', 'homeName 必须是非空字符串');
    if (homeName.length > 64) throw new HttpError('bad_request', 'homeName 过长（最多 64 字符）');

    const result = registry.registerHome({ homeName, gatewayVersion: str(body?.gatewayVersion) });
    await registry.flush();
    if (result.rotated) {
      // 契约 §2.2：同一 homeName 重复注册 → 轮换 homeToken，旧连接被断开
      hub.disconnectHome(result.homeId, 'rotated');
    }
    log.info(`home 注册${result.rotated ? '（复用并轮换令牌）' : ''} homeId=${result.homeId} name=${homeName} token=${redactToken(result.homeToken)} ip=${ip}`);
    return sendJson(res, 200, { homeId: result.homeId, homeToken: result.homeToken, relayName: config.relayName });
  }

  /** 契约 §2.3：按 code 找 home → 经隧道转发到网关 → 绑定 deviceToken 并把结果回给手机。 */
  async function onPairClaim(req, res, ip) {
    const gate = claimLimiter.hit(ip);
    if (!gate.allowed) throw new HttpError('rate_limited', '配对请求过于频繁，请稍后重试', { headers: { 'Retry-After': String(gate.retryAfterSec) } });

    const body = await readJsonBody(req);
    const code = normalizePairCode(body?.code);
    if (!code) throw new HttpError('bad_request', '缺少或非法的 code（必须是 6 位数字）');
    const deviceId = str(body?.deviceId);
    if (!DEVICE_ID_RE.test(deviceId)) {
      // 契约 §1 沿用 v1 裁定 A4：deviceId 必须是小写 UUID —— 它是"同设备重配对即吊销旧令牌"的唯一依据
      throw new HttpError('bad_request', 'deviceId 必须是客户端生成的小写 UUID，例如 8f3c1a2b-1111-4222-8333-444455556666');
    }

    const home = registry.findHomeByPairCode(code);
    if (!home) {
      log.warn(`pair/claim 找不到 home（码未声明或已过期）ip=${ip}`);
      throw new HttpError('home_not_found', '配对码未在中继上声明（PC 可能未连接中继或窗口已过期）');
    }
    if (!hub.isHomeOnline(home.homeId)) {
      log.warn(`pair/claim 但 home 离线 homeId=${home.homeId} ip=${ip}`);
      throw new HttpError('home_offline', '电脑离线：隧道未连接');
    }

    const deviceName = str(body?.deviceName, '未命名设备');
    const forward = await hub.forwardHttp(home.homeId, {
      method: 'POST',
      path: '/api/v2/pair/claim',
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-api-version': String(API_VERSION) },
      body: JSON.stringify({ code, deviceName, deviceId }),
    });

    if (!forward.ok) {
      // 超时也归入 503：对手机而言语义都是"PC 侧暂时不可用"，契约失败表里只有 home_offline 这一档
      log.warn(`pair/claim 转发失败 homeId=${home.homeId} code=${forward.code} ${forward.message ?? ''}`);
      throw new HttpError('home_offline', forward.code === 'timeout' ? '电脑响应超时：网关未在期限内返回' : '电脑离线：隧道中断');
    }

    const text = forward.body.toString('utf8');
    let json = null;
    try {
      json = text.trim() ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (forward.status !== 200) {
      // 网关的失败码原样透出（401 pairing_bad_code / 403 pairing_closed / 409 已用 …）
      log.info(`pair/claim 网关返回 ${forward.status} homeId=${home.homeId} ip=${ip}`);
      if (json && typeof json === 'object') return sendJson(res, forward.status, json);
      throw new HttpError(forward.status === 401 ? 'pairing_bad_code' : forward.status === 403 ? 'pairing_closed' : 'internal', `网关返回 ${forward.status}`, { status: forward.status });
    }

    if (!json || typeof json !== 'object') throw new HttpError('internal', '网关返回的不是合法 JSON', { status: 502 });
    const deviceToken = str(json?.relay?.deviceToken) || (typeof json?.token === 'string' ? json.token : '');
    if (!deviceToken) {
      // 没有隧道凭据就无法建立 device 隧道：明确报错，别把"半个成功"给手机
      throw new HttpError('internal', '网关响应缺少 relay.deviceToken（契约 §2.3）', { status: 502 });
    }

    const bound = registry.bindDevice({ homeId: home.homeId, deviceId, deviceName, deviceToken, tokenId: str(json?.tokenId) });
    await registry.flush();
    if (bound.rotated) {
      // 契约 §2.3：同一 deviceId 再次 claim → 轮换 deviceToken 并吊销其旧连接
      const dropped = hub.dropDeviceByIdentity(home.homeId, deviceId);
      log.info(`设备令牌轮换 deviceId=${deviceId} homeId=${home.homeId} 断开旧连接=${dropped}`);
    }
    log.info(`配对成功 homeId=${home.homeId} deviceId=${deviceId} tokenId=${bound.device.tokenId} deviceToken=${redactToken(deviceToken)} ip=${ip}`);

    // relay 块里 homeId/tunnelUrl 由**中继**填写（PC 不需要知道自己的公网地址）
    const payload = {
      ...json,
      relay: { ...(json.relay ?? {}), homeId: home.homeId, deviceToken, tunnelUrl: deriveTunnelUrl(config) },
    };
    return sendJson(res, 200, payload);
  }

  // ------------------------------------------------------------ WebSocket 升级

  function onUpgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = normalizeIp(req.socket?.remoteAddress);
    const check = checkUpgradeRequest(req);
    if (!check.ok) {
      counters.upgradesRejected++;
      return rejectUpgrade(socket, check.status, check.message, check.headers);
    }
    const pathname = url.pathname;
    if (pathname !== TUNNEL_HOME_PATH && pathname !== TUNNEL_DEVICE_PATH) {
      counters.upgradesRejected++;
      return rejectUpgrade(socket, 404, `未知隧道端点：${pathname}`);
    }

    const token = bearerToken(req);
    if (!token) {
      counters.upgradesRejected++;
      authLimiter.hit(ip);
      return rejectUpgrade(socket, 401, '缺少 Authorization: Bearer <token>', { 'WWW-Authenticate': 'Bearer' });
    }

    const isHome = pathname === TUNNEL_HOME_PATH;
    const home = isHome ? registry.findHomeByToken(token) : null;
    const binding = isHome ? null : registry.findDeviceByToken(token);
    if (isHome ? !home : !binding) {
      counters.upgradesRejected++;
      const gate = authLimiter.hit(ip);
      const what = isHome ? 'homeToken' : 'deviceToken';
      log.warn(`隧道鉴权失败（${what}）ip=${ip} token=${redactToken(token)}`);
      if (!gate.allowed) return rejectUpgrade(socket, 429, '鉴权失败次数过多，请稍后重试', { 'Retry-After': String(gate.retryAfterSec) });
      return rejectUpgrade(socket, 401, `${what} 无效或已轮换`, { 'WWW-Authenticate': 'Bearer' });
    }

    counters.upgradesAccepted++;
    const ws = acceptWebSocket(req, socket, head, { maxMessageBytes: config.limits.maxMessageBytes });
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    ws.on('error', (err) => log.debug?.(`隧道 socket 错误：${err.message}`));
    if (isHome) {
      const conn = hub.attachHome(ws, home, { name: str(home.homeName) });
      ws.on('message', (text) => {
        counters.wsMessages++;
        hub.onHomeFrame(conn, text);
      });
      ws.on('close', ({ code, reason }) => {
        log.info(`home 隧道 socket 关闭 homeId=${home.homeId} code=${code} reason=${reason || '-'}`);
        hub.handleHomeClosed(conn);
      });
    } else {
      const conn = hub.attachDevice(ws, binding);
      ws.on('message', (text) => {
        counters.wsMessages++;
        hub.onDeviceFrame(conn, text);
      });
      ws.on('close', ({ code, reason }) => {
        log.info(`device 隧道 socket 关闭 homeId=${binding.home.homeId} deviceId=${binding.device.deviceId} code=${code} reason=${reason || '-'}`);
        hub.handleDeviceClosed(conn);
      });
    }
    ws.start(); // 挂好监听器后再放行握手时可能已到达的字节
    return undefined;
  }

  // ------------------------------------------------------------ 请求体 / 响应

  async function readJsonBody(req) {
    const maxBytes = config.limits.maxBodyBytes;
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > maxBytes) {
        throw new HttpError('payload_too_large', `请求体超过上限 ${maxBytes} 字节`, { headers: { Connection: 'close' } });
      }
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) throw new HttpError('payload_too_large', `请求体超过上限 ${maxBytes} 字节`, { headers: { Connection: 'close' } });
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (req.destroyed || req.aborted) throw new ClientGoneError('客户端已断开');
      throw err;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError('bad_request', '请求体必须是 JSON 对象');
      return value;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError('bad_request', '请求体不是合法的 JSON');
    }
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    if (!res.headersSent) {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'X-Api-Version': String(config.apiVersion),
      });
    }
    res.end(text);
    return undefined;
  }

  /** 统一错误体：`{ error: { code, message } }`（契约 §4.4），令牌一律脱敏。 */
  function sendError(res, err) {
    const isHttp = err instanceof HttpError;
    const code = isHttp ? err.code : 'internal';
    const status = isHttp ? err.status : 500;
    const message = isHttp ? err.message : '中继内部错误';
    if (!isHttp) log.error(`未处理异常：${err?.stack ?? err}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    const text = JSON.stringify({ error: { code, message: redactSecrets(message) } });
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'X-Api-Version': String(config.apiVersion),
      ...(isHttp ? err.headers : {}),
    });
    res.end(text);
  }

  // ------------------------------------------------------------ 生命周期

  /** 启动监听，返回实际端口（配置 0 时由系统分配）。 */
  async function listen() {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : config.port;
    // 把系统实际分配的端口写回 config：`port: 0` 时 tunnelUrl 若仍按 0 推导，
    // 手机拿到的就是 `ws://relay.test:0/...`（不可用）。实测过这个坑，所以在此统一修正。
    config.port = port;
    log.info(`中继已启动：${config.tls.mode === 'off' ? 'ws' : 'wss'}://${config.host}:${port}（apiVersion=${config.apiVersion}）`);
    return port;
  }

  /** 优雅关闭：先断隧道（会向 device 推 home_offline），再停收连接，最后落盘。 */
  async function close() {
    for (const timer of maintenance) clearInterval(timer);
    maintenance.clear();
    hub.closeAll();
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    // 升级过的 socket 不在 server 的连接台账里：给它一个很短的优雅期，然后强制销毁
    const forceTimer = setTimeout(() => {
      for (const socket of upgradedSockets) socket.destroy();
      upgradedSockets.clear();
    }, 200);
    forceTimer.unref?.();
    // `server.close()` 的回调要等“所有连接都真正结束”。现场（Linux + Node 22 + TLS 隧道）出现过
    // 回调永不返回的情况：隧道 socket 已 close、进程却静默挂着，systemd 只能等 TimeoutStopSec
    // 再 SIGKILL（实测 90 秒）。所以这里给等待加上限，超时就自己动手销毁剩余连接。
    const grace = timeoutAfter(CLOSE_CONNECTION_GRACE_MS);
    const settled = await Promise.race([closed.then(() => true), grace.promise]);
    grace.cancel();
    if (!settled) {
      log.warn(`关闭时 server.close 回调 ${CLOSE_CONNECTION_GRACE_MS}ms 未返回，强制销毁剩余连接`);
      for (const socket of upgradedSockets) socket.destroy();
      upgradedSockets.clear();
      const forced = timeoutAfter(CLOSE_FORCE_GRACE_MS);
      const late = await Promise.race([closed.then(() => true), forced.promise]);
      forced.cancel();
      if (!late) log.warn('强制销毁后 server.close 回调仍未返回，继续关闭流程（不再等待）');
    }
    clearTimeout(forceTimer);
    for (const socket of upgradedSockets) socket.destroy();
    upgradedSockets.clear();
    await registry.flush();
  }

  return {
    config,
    logger: log,
    registry,
    hub,
    server,
    tls: tlsMaterial ? { mode: config.tls.mode, certFile: tlsMaterial.certFile, keyFile: tlsMaterial.keyFile, generated: tlsMaterial.generated, commonName: tlsMaterial.commonName } : { mode: 'off' },
    listen,
    close,
    get port() {
      const address = server.address();
      return address && typeof address === 'object' ? address.port : null;
    },
    /** 运行期台账：测试与运维断言用（不含任何秘密）。 */
    stats() {
      const address = server.address();
      return {
        uptimeMs: now() - startedAt,
        port: address && typeof address === 'object' ? address.port : null,
        tunnelUrl: deriveTunnelUrl(config),
        tlsMode: config.tls.mode,
        registrationOpen: config.registrationOpen,
        rateLimiterKeys: claimLimiter.size + authLimiter.size,
        ...counters,
        registry: registry.stats(),
        hub: hub.stats(),
      };
    },
  };
}
