/**
 * HTTP 接入层：路由、Bearer 鉴权、限速、请求体上限、SSE 事件流、统一错误体。
 *
 * 为什么把所有 HTTP 细节集中在这里：契约只暴露一层 REST/SSE，
 * 把「协议细节」与「任务/令牌领域逻辑」分开，可以让领域模块用单测直接驱动，
 * 不必为每个业务分支都起一个 HTTP 服务。
 *
 * 防挂起（工单硬性要求 5）：
 * - 请求体：Content-Length 预检 + 流式累计，超过 1MB 立刻 413 并关闭连接，绝不无限收包；
 * - 头部/请求接收：server.headersTimeout / server.requestTimeout 兜底，慢速攻击得到 408；
 * - SSE：每个连接一个心跳定时器，客户端断开（req/res close/error）立即 clearInterval + 退订，
 *   并且支持 maxSseClients 上限，防止连接泄漏拖垮网关。
 */
import http from 'node:http';
import { EventBus } from './events.mjs';
import { DeviceStore, PairingManager } from './tokens.mjs';
import { RateLimiter, isLoopbackAddress, normalizeIp } from './ratelimit.mjs';
import { TaskError, TaskManager } from './tasks.mjs';
import { listWorkspaces, resolveWorkspace } from './workspace.mjs';
import { createLogger, redactSecrets } from './util.mjs';

/**
 * 契约错误码 → HTTP 状态码。
 * `conflict`(409) 与 `payload_too_large`(413) 是契约 v1.1（A2 硬约束）新增的码：
 * - A2-2 要求删除活动任务返回 409；
 * - A2-b 要求请求体超限返回 413 payload_too_large。
 * 二者是对 §0 错误码枚举的**追加**，不改动既有码语义。
 */
export const ERROR_STATUS = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  payload_too_large: 413,
  pairing_closed: 403,
  pairing_bad_code: 401,
  rate_limited: 429,
  busy: 429,
  internal: 500,
});

/** 设备 ID 必须是**小写** UUID（契约 v1.1 A2-3）。 */
export const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 携带契约错误码的 HTTP 异常。 */
export class HttpError extends Error {
  /**
   * @param {keyof ERROR_STATUS} code
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

/** 客户端在响应前断开：不是服务端错误，静默忽略即可。 */
class ClientGoneError extends Error {}

/** 把路径切成路由标识。 */
export function routeOf(pathname) {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments[0] !== 'api' || segments[1] !== 'v1') return { name: 'unknown' };
  const rest = segments.slice(2);
  if (rest.length === 1 && rest[0] === 'health') return { name: 'health' };
  if (rest.length === 2 && rest[0] === 'pair' && rest[1] === 'open') return { name: 'pairOpen' };
  if (rest.length === 2 && rest[0] === 'pair' && rest[1] === 'claim') return { name: 'pairClaim' };
  if (rest.length === 1 && rest[0] === 'events') return { name: 'events' };
  if (rest.length === 1 && rest[0] === 'workspaces') return { name: 'workspaces' };
  if (rest.length === 1 && rest[0] === 'devices') return { name: 'devices' };
  if (rest.length === 2 && rest[0] === 'devices') return { name: 'deviceRevoke', tokenId: safeDecode(rest[1]) };
  if (rest.length === 1 && rest[0] === 'tasks') return { name: 'tasks' };
  if (rest.length === 2 && rest[0] === 'tasks') return { name: 'taskDetail', id: safeDecode(rest[1]) };
  if (rest.length === 3 && rest[0] === 'tasks' && rest[2] === 'cancel') return { name: 'taskCancel', id: safeDecode(rest[1]) };
  return { name: 'unknown' };
}

/** 非法百分号编码不应让路由 500，按字面量处理。 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 每个路由允许的 HTTP 方法（其余方法返回 405）。 */
const ROUTE_METHODS = Object.freeze({
  health: ['GET'],
  pairOpen: ['POST'],
  pairClaim: ['POST'],
  events: ['GET'],
  workspaces: ['GET'],
  devices: ['GET'],
  deviceRevoke: ['DELETE'],
  tasks: ['GET', 'POST'],
  taskDetail: ['GET', 'DELETE'],
  taskCancel: ['POST'],
});

/** 无需 Bearer 令牌的路径（契约 §0）。 */
const PUBLIC_ROUTES = new Set(['health', 'pairOpen', 'pairClaim']);

/**
 * 创建网关实例（不监听；调用 listen() 才开始服务）。
 * @param {object} config 已通过 validateConfig 的配置
 * @param {{logger?: object, spawnImpl?: Function|null, now?: () => number, platform?: string}} [opts]
 */
export async function createGateway(config, { logger = null, spawnImpl = null, now = Date.now, platform = process.platform } = {}) {
  const log =
    logger ??
    createLogger({
      dir: config.logsDir,
      filePrefix: config.log.filePrefix,
      toConsole: config.log.toConsole,
      now,
    });

  const bus = new EventBus({ bufferSize: config.events.bufferSize, now });
  const devices = new DeviceStore({ file: config.devicesFile, now, logger: log });
  const loaded = await devices.load();
  const pairing = new PairingManager({ ttlMs: config.limits.pairCodeTtlMs, now });
  const tasks = new TaskManager({ config, logger: log, bus, spawnImpl, platform, now });
  await tasks.init();

  const claimLimiter = new RateLimiter({ limit: config.limits.pairClaimPerMinute, windowMs: 60_000, now });
  const authLimiter = new RateLimiter({ limit: config.limits.authFailPerMinute, windowMs: 60_000, now });

  const startedAt = now();
  /** SSE 连接与心跳的显式台账：用于优雅关闭与「断开即清理」的自动化验证。 */
  const sse = { clients: new Set(), heartbeats: new Set(), cleanups: new Set() };
  const maintenance = new Set();

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      /* handle 内部已兜底，这里只防止未捕获拒绝 */
    });
  });
  server.requestTimeout = config.limits.requestTimeoutMs;
  server.headersTimeout = config.limits.headersTimeoutMs;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
  // Node 默认每 30s 才巡检一次「请求/头部是否超时」，若不缩短巡检间隔，
  // 配置的 requestTimeout（默认 30s）最坏会被拖到 60s 才生效 —— 这正是「防挂起」要避免的。
  // 取超时值的 1/2（上限 1s，下限 50ms），保证超时后能及时回收连接。
  server.connectionsCheckingInterval = Math.max(
    50,
    Math.min(1000, Math.floor(Math.min(config.limits.requestTimeoutMs, config.limits.headersTimeoutMs) / 2)),
  );

  if (!config.authRequired) log.warn('警告：配置 authRequired=false，所有接口将不再校验设备令牌（仅建议本机调试使用）');
  if (loaded > 0) log.info(`已加载 ${loaded} 个设备令牌`);
  log.info(
    `网关初始化完成：home=${config.home} 并发=${config.maxConcurrent} 队列上限=${config.maxQueue} 白名单=${
      config.workspaceAllowlist.join(' | ') || '(空，拒绝所有任务)'
    }`,
  );

  // lastSeenAt 落盘节流：成功认证只改内存，由该定时器周期性持久化。
  // 顺序很重要：先接受外部（CLI）对设备库的改动，再落盘，避免把 CLI 吊销的设备写回去。
  const flushTimer = setInterval(() => {
    devices.reloadIfChangedSync();
    void devices.flush();
  }, 30_000);
  flushTimer.unref?.();
  maintenance.add(flushTimer);

  /** 统一的请求处理入口：解析 → 鉴权 → 路由 → 错误体。 */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = normalizeIp(req.socket?.remoteAddress);
    const route = routeOf(url.pathname);
    const method = req.method ?? 'GET';

    try {
      if (route.name === 'unknown') throw new HttpError('not_found', `未知接口：${method} ${url.pathname}`);
      const allowed = ROUTE_METHODS[route.name] ?? [];
      if (!allowed.includes(method)) {
        throw new HttpError('bad_request', `方法不允许：${method} ${url.pathname}（允许 ${allowed.join('/')}）`, { status: 405 });
      }

      let device = null;
      if (!PUBLIC_ROUTES.has(route.name) && config.authRequired) {
        device = authenticate(req, ip);
      }

      switch (route.name) {
        case 'health':
          return sendJson(res, 200, healthPayload());
        case 'pairOpen':
          return await onPairOpen(res, ip);
        case 'pairClaim':
          return await onPairClaim(req, res, ip);
        case 'events':
          return onEvents(req, res, url);
        case 'workspaces':
          return sendJson(res, 200, await listWorkspaces({ allowlist: config.workspaceAllowlist, defaultWorkspace: config.defaultWorkspace }));
        case 'devices':
          return sendJson(res, 200, { devices: devices.list() });
        case 'deviceRevoke': {
          const ok = await devices.revoke(route.tokenId);
          if (!ok) throw new HttpError('not_found', `设备令牌不存在：${route.tokenId}`);
          log.info(`设备令牌已吊销 tokenId=${route.tokenId}`);
          res.writeHead(204).end();
          return undefined;
        }
        case 'tasks':
          return method === 'POST' ? await onCreateTask(req, res) : onListTasks(res, url);
        case 'taskDetail':
          return method === 'DELETE' ? await onDeleteTask(res, route.id) : onGetTask(res, route.id);
        case 'taskCancel':
          return await onCancelTask(res, route.id);
        default:
          throw new HttpError('not_found', `未知接口：${url.pathname}`);
      }
    } catch (err) {
      if (err instanceof ClientGoneError) return;
      sendError(req, res, err, log);
      return undefined;
    }
  }

  /** Bearer 令牌校验 + 认证失败限速（只对失败计数）。 */
  function authenticate(req, ip) {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const device = token ? devices.verify(token) : null;
    if (device) return device;
    const gate = authLimiter.hit(ip);
    if (!gate.allowed) {
      throw new HttpError('rate_limited', '认证失败次数过多，请稍后重试', { headers: { 'Retry-After': String(gate.retryAfterSec) } });
    }
    throw new HttpError('unauthorized', '设备令牌无效或已吊销');
  }

  function healthPayload() {
    const stats = tasks.stats();
    return {
      ok: true,
      apiVersion: config.apiVersion,
      serverName: config.serverName,
      gatewayVersion: config.gatewayVersion,
      dshVersion: config.dsh.version,
      uptimeMs: now() - startedAt,
      activeTasks: stats.activeTasks,
      queuedTasks: stats.queuedTasks,
      pairingOpen: pairing.isOpen,
      authRequired: config.authRequired,
      capabilities: ['tasks', 'events', 'pairing', 'workspaces', 'cancel'],
    };
  }

  /** 配对码只能在 PC 本机生成（契约 §2.1），避免局域网内被抢注。 */
  async function onPairOpen(res, ip) {
    if (!isLoopbackAddress(ip)) {
      log.warn(`拒绝来自非回环地址的 pair/open：${ip}`);
      throw new HttpError('forbidden', '配对码只能在 PC 本机（127.0.0.1）生成');
    }
    const { code, expiresAt } = pairing.open();
    // 只记录过期时间，不记录配对码本身
    log.info(`配对窗口已开启 expiresAt=${new Date(expiresAt).toISOString()}`);
    return sendJson(res, 200, { code, expiresAt });
  }

  async function onPairClaim(req, res, ip) {
    const gate = claimLimiter.hit(ip);
    if (!gate.allowed) {
      throw new HttpError('rate_limited', '配对请求过于频繁，请稍后重试', { headers: { 'Retry-After': String(gate.retryAfterSec) } });
    }
    const body = await readJsonBody(req);
    const code = normalizePairCode(body?.code);
    if (!code) throw new HttpError('bad_request', '缺少或非法的 code（必须是 6 位数字）');
    // 契约 v1.1 A2-3：deviceId 必须是小写 UUID —— 它是"同设备重配对即吊销旧令牌"的唯一依据，
    // 格式不受控会让该保证失效（大小写不一致会被当成两台设备）。
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
    if (!DEVICE_ID_RE.test(deviceId)) {
      throw new HttpError('bad_request', 'deviceId 必须是客户端生成的小写 UUID，例如 8f3c1a2b-1111-4222-8333-444455556666');
    }

    const result = pairing.claim(code);
    if (!result.ok) {
      const message = result.reason === 'pairing_closed' ? '配对未开启或配对码已被使用' : '配对码错误或已过期';
      throw new HttpError(result.reason, message);
    }

    const { token, tokenId } = await devices.issue({
      deviceName: typeof body?.deviceName === 'string' ? body.deviceName : '未命名设备',
      deviceId,
    });
    log.info(`配对成功 deviceName=${body?.deviceName ?? '未命名设备'} tokenId=${tokenId} ip=${ip}`);
    // 明文令牌仅在本次响应中出现一次
    return sendJson(res, 200, { token, tokenId, serverName: config.serverName, expiresAt: null });
  }

  async function onCreateTask(req, res) {
    const body = await readJsonBody(req);
    const workspace = await resolveWorkspace(body?.workspace, {
      allowlist: config.workspaceAllowlist,
      defaultWorkspace: config.defaultWorkspace,
    });
    if (!workspace.ok) throw new HttpError('bad_request', workspace.message);

    let task;
    try {
      task = await tasks.submit({
        prompt: body?.prompt,
        workspace: workspace.path,
        title: typeof body?.title === 'string' ? body.title : null,
        model: typeof body?.model === 'string' ? body.model : null,
        reasoningEffort: typeof body?.reasoningEffort === 'string' ? body.reasoningEffort : null,
        timeoutSec: body?.timeoutSec === undefined ? null : body.timeoutSec,
      });
    } catch (err) {
      if (err instanceof TaskError) throw new HttpError(err.code, err.message);
      throw err;
    }
    log.info(`task accepted id=${task.id} workspace=${task.workspace} timeoutSec=${body?.timeoutSec ?? config.defaultTimeoutSec}`);
    return sendJson(res, 201, task);
  }

  function onListTasks(res, url) {
    const status = url.searchParams.get('status') ?? 'all';
    if (status !== 'all' && status !== 'active') throw new HttpError('bad_request', "status 只能是 all 或 active");
    const limitRaw = url.searchParams.get('limit');
    let limit = 50;
    if (limitRaw !== null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError('bad_request', 'limit 必须是 1~200 的整数');
    }
    const cursor = url.searchParams.get('cursor');
    return sendJson(res, 200, tasks.list({ status, limit, cursor }));
  }

  function onGetTask(res, id) {
    const task = tasks.get(id);
    if (!task) throw new HttpError('not_found', `任务不存在：${id}`);
    return sendJson(res, 200, task);
  }

  async function onCancelTask(res, id) {
    const task = await tasks.cancel(id);
    if (!task) throw new HttpError('not_found', `任务不存在：${id}`);
    log.info(`cancel requested id=${id} status=${task.status}`);
    return sendJson(res, 200, task);
  }

  async function onDeleteTask(res, id) {
    let ok = false;
    try {
      ok = await tasks.remove(id);
    } catch (err) {
      if (err instanceof TaskError) throw new HttpError(err.code, err.message);
      throw err;
    }
    if (!ok) throw new HttpError('not_found', `任务不存在：${id}`);
    log.info(`task deleted id=${id}`);
    res.writeHead(204).end();
    return undefined;
  }

  /** SSE 事件流（契约 §4）。 */
  function onEvents(req, res, url) {
    const taskId = url.searchParams.get('taskId') || null;
    const fromSeqParam = url.searchParams.get('fromSeq');
    const fromSeq = parseSeq(fromSeqParam ?? req.headers['last-event-id']);

    // 先校验请求本身是否合法（未知任务 → 404），再判断容量：
    // 这样客户端拿到的是准确的错误原因，而不是被容量问题掩盖的 429。
    if (taskId && !tasks.get(taskId)) throw new HttpError('not_found', `任务不存在：${taskId}`);
    if (sse.clients.size >= config.limits.maxSseClients) {
      throw new HttpError('busy', `SSE 连接数已达上限（${config.limits.maxSseClients}）`);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // SSE 是长连接：关闭该连接的请求/套接字空闲超时，由心跳与客户端断开事件驱动生命周期
    req.setTimeout(0);
    res.setTimeout?.(0);

    let closed = false;
    let subscription = null;
    let heartbeat = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat); // 立即释放定时器，避免断开后仍在跑（内存/句柄泄漏）
        sse.heartbeats.delete(heartbeat);
      }
      subscription?.unsubscribe();
      sse.clients.delete(res);
      sse.cleanups.delete(cleanup);
    };

    const write = (chunk) => {
      if (closed) return;
      try {
        res.write(chunk);
      } catch {
        cleanup();
      }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    sse.clients.add(res);
    sse.cleanups.add(cleanup);

    write(': connected\n\n');
    // 先回放后订阅在同一 tick 内完成，不会漏事件也不会重复投递
    subscription = bus.subscribe({
      taskId,
      fromSeq,
      onEvent: (ev) => write(formatEvent(ev)),
    });
    if (subscription.gap) {
      // 仅用 SSE 注释说明「客户端请求的断点早于缓冲区起点」，不发明新的事件类型
      write(`: gap requested=${fromSeq} oldest=${subscription.oldestSeq}\n\n`);
      log.warn(`SSE 断点早于事件缓冲起点：fromSeq=${fromSeq} oldest=${subscription.oldestSeq}（客户端应回源任务详情兜底）`);
    }

    heartbeat = setInterval(() => write(': ping\n\n'), config.events.heartbeatMs);
    heartbeat.unref?.();
    sse.heartbeats.add(heartbeat);
    return undefined;
  }

  /** 读取并解析 JSON 请求体，超限抛 413。 */
  async function readJsonBody(req) {
    const maxBytes = config.limits.maxBodyBytes;
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > maxBytes) {
        // 不读取超大请求体：直接 413 并关闭连接
        throw new HttpError('payload_too_large', `请求体超过上限 ${maxBytes} 字节`, { headers: { Connection: 'close' } });
      }
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
          throw new HttpError('payload_too_large', `请求体超过上限 ${maxBytes} 字节`, { headers: { Connection: 'close' } });
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // 客户端中途断开或 408 触发的流中断：静默处理，不产生 500 噪声日志
      if (req.destroyed || req.aborted) throw new ClientGoneError('客户端已断开');
      throw err;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
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

  /** 统一错误体：{ error: { code, message } }（契约 §0）；永不回显令牌等敏感信息。 */
  function sendError(req, res, err, logger) {
    const isHttp = err instanceof HttpError;
    const code = isHttp ? err.code : 'internal';
    const status = isHttp ? err.status : 500;
    const message = isHttp ? err.message : '网关内部错误';
    if (!isHttp) logger.error(`未处理异常：${err?.stack ?? err}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    const text = JSON.stringify({ error: { code, message: redactSecrets(message) } });
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'X-Api-Version': String(config.apiVersion),
      ...(isHttp ? err.headers : {}),
    };
    res.writeHead(status, headers);
    res.end(text);
    if (status === 413) {
      // 请求体未读完时不能让连接挂起：响应结束后立刻销毁
      res.on('finish', () => req.destroy());
    }
  }

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
    log.info(`监听 http://${config.host}:${port}（apiVersion=${config.apiVersion}）`);
    return port;
  }

  /** 优雅关闭：先断开 SSE，再停收新连接，最后终止子进程并落盘。 */
  async function close() {
    for (const cleanup of [...sse.cleanups]) cleanup();
    for (const timer of maintenance) clearInterval(timer);
    maintenance.clear();
    // 先发起 close（停止 accept），再强制释放 keep-alive/长连接：
    // 否则 server.close 的回调要等 keepAliveTimeout（65s）才触发，关闭流程会挂住。
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await closed;
    await tasks.shutdown();
    await devices.flush();
  }

  return {
    config,
    logger: log,
    bus,
    devices,
    pairing,
    tasks,
    server,
    listen,
    close,
    /** @returns {number|null} */
    get port() {
      const address = server.address();
      return address && typeof address === 'object' ? address.port : null;
    },
    /** 运行期台账：用于验证 SSE 断开后无定时器/连接泄漏。 */
    stats() {
      return {
        uptimeMs: now() - startedAt,
        port: address6(server),
        sseClients: sse.clients.size,
        sseHeartbeats: sse.heartbeats.size,
        maintenanceTimers: maintenance.size,
        busSubscribers: bus.subscriberCount,
        busBufferedEvents: bus.buffer.length,
        ...tasks.stats(),
      };
    },
  };
}

function address6(server) {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : null;
}

/** 解析 fromSeq / Last-Event-ID；非法值按 0（全量回放）处理。 */
export function parseSeq(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

/** 归一化配对码：接受字符串或数字，必须是 6 位数字。 */
export function normalizePairCode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value).padStart(6, '0');
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{6}$/.test(trimmed) ? trimmed : null;
}

/** SSE 帧格式化：data 恒为单行 JSON（JSON.stringify 会转义内部换行）。 */
export function formatEvent(ev) {
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}
