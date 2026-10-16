/**
 * 中继出站客户端（契约 §3 / §4.1 / §5.5）。
 *
 * ## 三个不可让步的设计点
 *
 * 1. **PC 只出站**：本模块只主动连中继，绝不开任何入站端口（契约 §0.1）。`hello` 之后
 *    才是准入；被拒绝（401/error）时记 `lastError` 并按退避重试。
 *
 * 2. **隧道里的请求必须走本机真实 HTTP**（`http://127.0.0.1:<port>`），
 *    **不允许直接调内部 handler**。理由：内部调用会绕过 Bearer 鉴权、限速、请求体上限、
 *    SSE 台账与统一错误体 —— 那等于给隧道开了一条无鉴权的后门，
 *    而中继只做"字节转发"、不做业务鉴权（契约 §0.3）。这也是 §5.5.1 的安全前提。
 *
 * 3. **id 空间隔离**：契约 §3.2 说 id 由发起方分配、连接内唯一，但同一条 home 连接上
 *    两个方向都有 `req`（中继→home 派发设备请求；home→中继做控制面调用，见 §3.4），
 *    若两边都从 1 开始计数就会撞号，`res` 会认错请求。
 *    因此本客户端把自己的出站 id 分配在**高位区间**（`HOME_ID_BASE = 2^40`），
 *    把低区间留给中继派发；并对此在 status 里暴露 `idBase` 便于联调核对。
 */
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { WebSocketClient, WebSocketHandshakeError } from './ws.mjs';
import { atomicWriteJson, createLogger, readJsonFile, redactSecrets } from './util.mjs';
import { GATEWAY_VERSION } from './config.mjs';

/** 帧类型（契约 §3.1）。 */
export const FRAME = Object.freeze({
  hello: 'hello',
  ready: 'ready',
  error: 'error',
  req: 'req',
  res: 'res',
  chunk: 'chunk',
  end: 'end',
  abort: 'abort',
  ping: 'ping',
  pong: 'pong',
  cancel: 'cancel',
  notice: 'notice',
});

/** 出站 id 起始值：把低 2^32 留给中继派发的 id，避免同连接双方向撞号。 */
export const HOME_ID_BASE = 2 ** 40;

/** 单条 chunk 解码后上限（契约 §3.2：≤ 256 KiB）。留出 base64 膨胀余量取 128 KiB。 */
export const CHUNK_BYTES = 128 * 1024;

/**
 * 经隧道转发的内部标记头。
 *
 * 为什么需要它：**经隧道进来的请求，来源地址天然是 127.0.0.1**，
 * 因此契约 §4.1 的"仅回环"判定在隧道路径上形同虚设 —— 任何已配对手机都能
 * 读到 `GET /api/v2/relay/status`（内网信息）、`POST /api/v2/relay/disconnect`（远程断链 DoS）、
 * `POST /api/v2/pair/open`（自行开配对窗口 = 越权提权）。
 * 所以管理端点改为**按标记而非按 IP** 判定"这是手机来的"。
 *
 * 伪造这个头**没有收益**：带上它只会让管理端点拒绝你；而 `#dispatch` 转发前
 * 会先把客户端自带的同名头**剥掉**再强制置 1，所以手机也无法用它提权。
 */
export const TUNNEL_HEADER = 'x-dsh-tunnel';

/** 大小写不敏感地删除一个头（Node 会小写化入站头名，出站则原样发送）。 */
export function deleteHeaderInsensitive(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

/**
 * `abort` 帧的 `reason` 只能是契约 §3.3 的六值枚举。
 *
 * **为什么必须严格**：中继把未知 reason 归一为 `internal`，手机端于是把所有失败都显示成
 * "内部错误"，用户分不清"会话被取消"和"目标路径非法"。
 * 因此 **abort 只表达"传输层为什么断"**；业务失败一律走 `res{status}` + 响应体
 * `{error:{code,message}}` + `end`（§3.5「与真实 HTTP 语义一致」的延伸）。
 */
export const ABORT_REASONS = Object.freeze(new Set(['overflow', 'peer_closed', 'home_offline', 'timeout', 'canceled', 'internal']));

/** 把任意原因归一为合法的 abort reason（未知一律 `internal`，绝不把自由文本发到线上）。 */
export function normalizeAbortReason(reason) {
  return ABORT_REASONS.has(reason) ? reason : 'internal';
}

/** 退避参数（契约要求 1s → 30s）。 */
export const BACKOFF_DEFAULT = Object.freeze({ minMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.2 });

/**
 * 心跳**发送间隔**。
 *
 * 为什么不等于 30s：契约 §3.1 说的 30s 是"发 ping 后 30s 无 pong 视为死链"，
 * 那是**超时阈值**而不是发送间隔。早期实现把间隔也设成 30s，结果第一个 ping 恰好在
 * 对端 30s 空闲判定到期的同一刻发出 —— ms 级抖动就让对端先判死链并断开：
 * 实测中继日志每 ~31s 出现一次 `心跳超时（30004ms 无任何帧），断开连接`，
 * 网关随后重连，配对/任务请求正好落在这个窗口里就 503（ops-doc 的 B/D/E 判据）。
 * 间隔取 10s（< 阈值 1/3），既满足契约又留足抖动余量。
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** 契约 §3.1：30s 无 pong 视为死链。 */
export const HEARTBEAT_MS = 30_000;

/** 等待中继 `ready` 的上限（契约 §3.1：中继收到 hello 后应立刻回 ready）。 */
export const READY_TIMEOUT_MS = 10_000;

/** 控制面路径（契约 §3.4）。 */
export const CONTROL = Object.freeze({
  pairWindow: '/api/v2/pair/window',
  pairClose: '/api/v2/pair/close',
});

/**
 * 把配置里的中继地址归一为「HTTP base」与「隧道 WS URL」。
 * 接受 `ws://` `wss://` `http://` `https://`，以及不带协议的 `host:port`。
 * @param {string} raw
 * @param {string} [tunnelPath]
 * @returns {{base: string, wsUrl: string, secure: boolean}}
 */
export function normalizeRelayUrl(raw, tunnelPath = '/api/v2/tunnel/home') {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('relay.url 未配置');
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `ws://${text}`;
  const url = new URL(withProtocol);
  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') {
    throw new Error(`relay.url 协议不支持：${url.protocol}`);
  }
  const httpProtocol = secure ? 'https:' : 'http:';
  const wsProtocol = secure ? 'wss:' : 'ws:';
  const base = `${httpProtocol}//${url.host}`;
  const prefix = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '';
  const wsUrl = `${wsProtocol}//${url.host}${prefix}${tunnelPath}`;
  return { base, wsUrl, secure };
}

/**
 * 计算下一次退避延迟（指数 + 抖动，封顶 maxMs）。
 * @param {number} attempt 已重试次数（1 = 第一次重试）
 * @param {{minMs?: number, maxMs?: number, factor?: number, jitter?: number}} [opts]
 * @param {() => number} [random]
 */
export function backoffDelay(attempt, { minMs = 1000, maxMs = 30_000, factor = 2, jitter = 0.2 } = {}, random = Math.random) {
  const raw = Math.min(maxMs, minMs * Math.pow(factor, Math.max(0, attempt - 1)));
  const delta = raw * jitter;
  const value = raw - delta + random() * delta * 2;
  return Math.max(0, Math.round(Math.min(maxMs, Math.max(minMs, value))));
}

/**
 * 中继隧道客户端。
 */
export class RelayClient extends EventEmitter {
  /**
   * @param {{config: object, logger?: object|null, now?: () => number, onNotice?: Function|null, httpRequestImpl?: Function|null, wsFactory?: Function|null, localBaseUrl?: () => string|null}} opts
   */
  constructor({ config, logger = null, now = Date.now, onNotice = null, httpRequestImpl = null, wsFactory = null, localBaseUrl = null }) {
    super();
    this.config = config;
    this.relayCfg = config.relay ?? {};
    this.logger = logger ?? createLogger({ dir: null, toConsole: false });
    this.now = now;
    this.onNotice = onNotice;
    this.httpRequestImpl = httpRequestImpl;
    this.wsFactory = wsFactory ?? ((opts) => new WebSocketClient(opts));
    this.localBaseUrl = localBaseUrl;
    this.stateFile = config.relayStateFile ?? path.join(config.home ?? '.', 'relay.json');

    this.enabled = Boolean(this.relayCfg.enabled);
    this.ws = null;
    this.connected = false;
    this.homeId = this.relayCfg.homeId ?? null;
    this.homeToken = this.relayCfg.homeToken ?? null;
    this.relayName = this.relayCfg.relayName ?? null;
    this.lastError = null;
    this.since = null;
    this.reconnects = 0;
    this.attempt = 0;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.pongDeadline = null;
    this.lastPongAt = null;
    this.closedByUser = false;
    this.shuttingDown = false;

    this.nextId = HOME_ID_BASE;
    /** @type {Map<number, {resolve: Function, reject: Function, headers: object|null, chunks: Buffer[], timer: object, stream: boolean, onHeaders: Function|null, onChunk: Function|null}>} */
    this.outbound = new Map();
    /** @type {Map<number, {req: object, res: object|null, aborted: boolean, path: string}>} 中继派发进来的在途请求 */
    this.inbound = new Map();
    /** 统计。 */
    this.stats = { framesIn: 0, framesOut: 0, requests: 0, streams: 0, aborted: 0, errors: 0 };
  }

  /** 对外状态（契约 §4.1 `GET /api/v2/relay/status`）。 */
  status() {
    return {
      enabled: this.enabled,
      connected: this.connected,
      homeId: this.homeId,
      relayName: this.relayName,
      url: this.relayCfg.url ?? null,
      lastError: this.lastError,
      since: this.since,
      reconnects: this.reconnects,
      attempts: this.attempt,
      inFlight: this.inbound.size,
      idBase: HOME_ID_BASE,
      stats: { ...this.stats },
    };
  }

  /** 从状态文件补全 homeToken（config.json 里显式配的优先）。 */
  async loadState() {
    if (this.homeToken) return;
    const { value } = await readJsonFile(this.stateFile, null);
    if (value && typeof value.homeToken === 'string') {
      this.homeToken = value.homeToken;
      this.homeId = value.homeId ?? this.homeId;
      this.relayName = value.relayName ?? this.relayName;
      this.logger.info(`已从中继状态文件恢复凭据：${this.stateFile}（homeId=${this.homeId ?? '-'}）`);
    }
  }

  /** 原子落盘凭据（**不写用户的 config.json**，避免破坏其注释与格式）。 */
  async saveState() {
    const payload = {
      version: 1,
      relayUrl: this.relayCfg.url ?? null,
      homeId: this.homeId,
      homeToken: this.homeToken,
      relayName: this.relayName,
      registeredAt: this.now(),
    };
    try {
      await atomicWriteJson(this.stateFile, payload);
    } catch (err) {
      this.logger.warn(`中继凭据落盘失败：${err.message}`);
    }
  }

  /**
   * 用配置里的 relay 地址注册（若无凭据）并建立隧道（契约 §4.1 `POST /api/v2/relay/connect`）。
   * @returns {Promise<{ok: boolean, homeId: string|null, relayName: string|null, status: object, error?: string}>}
   */
  async connect() {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async #connect() {
    this.enabled = true;
    this.closedByUser = false;
    if (this.connected) return { ok: true, homeId: this.homeId, relayName: this.relayName, status: this.status() };
    let normalized;
    try {
      normalized = normalizeRelayUrl(this.relayCfg.url);
    } catch (err) {
      this.lastError = err.message;
      return { ok: false, homeId: null, relayName: null, status: this.status(), error: err.message };
    }
    this.normalized = normalized;

    await this.loadState();
    if (!this.homeToken) {
      const registered = await this.#register(normalized.base);
      if (!registered.ok) {
        this.lastError = registered.error;
        return { ok: false, homeId: null, relayName: null, status: this.status(), error: registered.error };
      }
    }

    try {
      await this.#openTunnel(normalized.wsUrl);
    } catch (err) {
      this.lastError = describeHandshakeError(err);
      this.connected = false;
      this.logger.warn(`连接中继失败：${redactSecrets(this.lastError)}`);
      this.#scheduleReconnect();
      return { ok: false, homeId: this.homeId, relayName: this.relayName, status: this.status(), error: this.lastError };
    }
    return { ok: true, homeId: this.homeId, relayName: this.relayName, status: this.status() };
  }

  /** `POST /api/v2/homes`（契约 §2.2）。 */
  async #register(base) {
    const body = JSON.stringify({
      relaySecret: this.relayCfg.relaySecret ?? '',
      homeName: this.relayCfg.homeName || safeHostname(),
      gatewayVersion: this.relayCfg.gatewayVersion ?? this.config.gatewayVersion ?? GATEWAY_VERSION,
    });
    try {
      // 与 WS 隧道路径共用同一份 `relay.tls`（自签场景下两者必须一致，否则注册先挂）
      const res = await postJson(`${base}/api/v2/homes`, body, { timeoutMs: 15_000, tls: this.relayCfg.tls ?? null });
      if (res.status !== 200 || !res.json?.homeToken) {
        const message = res.json?.error?.message ?? res.json?.error?.code ?? `HTTP ${res.status}`;
        return { ok: false, error: `中继注册失败：${message}` };
      }
      this.homeToken = res.json.homeToken;
      this.homeId = res.json.homeId ?? null;
      this.relayName = res.json.relayName ?? null;
      await this.saveState();
      this.logger.info(`中继注册成功 homeId=${this.homeId} relayName=${this.relayName}（凭据已写入 ${this.stateFile}）`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `中继注册请求失败：${err.message}` };
    }
  }

  /**
   * 建立 WS、**在 open 的那一刻立刻发 `hello`**、再等 `ready`。
   *
   * ## 两个曾经导致"真联调互相等待"的顺序陷阱（都是实测踩到的）
   *
   * 1. **`hello` 必须是 WS `open` 后的第一帧，且要同步发出**（契约 §3.1：`hello` 是
   *    C→S 首帧、"必须最先发"）。早期实现把 `send(hello)` 放在 `await client.connect()`
   *    **之后**，跨了一个 await 边界；配合"中继等 hello、网关等 ready"就成了**互相等待**：
   *    中继日志 `心跳超时（30008ms 无任何帧）`，网关日志 `等待中继 ready 帧超时（10s）`，
   *    双方各自 10s/30s 循环重连，`framesIn:0 framesOut:0`。
   * 2. **等 `ready` 的监听必须在 `connect()` 之前挂好**。中继完全可能在 WS 升级后
   *    立刻把 `ready` 和首个数据包一起发出来；若监听是 `await connect()` 之后才注册，
   *    这一帧会在"没人监听"的窗口里被 EventEmitter 丢掉 —— 表现为**偶发**的 10s 超时，
   *    最难排查。这里先把监听与超时挂好，再去连接。
   *
   * 超时错误里带上 `helloSent`/`framesIn`/`lastFrame` 三个诊断字段：
   * 下次再出现这类问题，一眼就能看出是"没发出去"还是"没收到"。
   */
  async #openTunnel(wsUrl) {
    const client = this.wsFactory({
      url: wsUrl,
      headers: { Authorization: `Bearer ${this.homeToken}` },
      tls: { rejectUnauthorized: this.relayCfg.tls?.rejectUnauthorized !== false, ca: this.relayCfg.tls?.ca },
      maxPayloadBytes: this.relayCfg.maxFrameBytes ?? 8 * 1024 * 1024,
    });
    this.ws = client;
    this.#bindEvents(client);

    // ---- 先把 ready 等待挂好，再连接（见上面陷阱 2）----
    this.helloSent = false;
    let settle = null;
    const readyPromise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const cleanup = () => {
      this.off('__ready', onReady);
      this.off('__fatal', onFatal);
      clearTimeout(timer);
    };
    const onReady = (frame) => {
      if (frame?.role && frame.role !== 'home') {
        cleanup();
        settle.reject(new Error(`中继把本连接识别为 role=${frame.role}，期望 home`));
        return;
      }
      cleanup();
      settle.resolve(frame);
    };
    const onFatal = (err) => {
      cleanup();
      settle.reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      settle.reject(
        new Error(
          `等待中继 ready 帧超时（${READY_TIMEOUT_MS}ms）：已发 hello=${this.helloSent}，已收帧=${this.stats.framesIn}，最后帧=${this.lastFrameType ?? 'none'}` +
            '（若"已发 hello=false"，说明 WS 没真正 open；若=true 且已收帧=0，说明中继没有应答 hello）',
        ),
      );
    }, READY_TIMEOUT_MS);
    timer.unref?.();
    this.once('__ready', onReady);
    this.once('__fatal', onFatal);

    // ---- hello 在 open 回调里**同步**发出（见上面陷阱 1）----
    client.on('open', () => {
      const hello = { t: FRAME.hello, proto: 2, role: 'home', name: this.relayCfg.homeName || safeHostname() };
      this.helloSent = client.send(JSON.stringify(hello));
      this.logger.info(`中继隧道已连接：${wsUrl}（已发 hello，等待 ready）`);
    });

    try {
      await client.connect();
      await readyPromise;
    } catch (err) {
      cleanup();
      throw err;
    }

    this.connected = true;
    this.attempt = 0;
    this.since = this.now();
    this.lastError = null;
    this.#startHeartbeat();
    // 立刻发一次心跳：不让对端的空闲计时从"连接那一刻"开始累积到阈值边缘
    this.pongDeadline = this.now() + HEARTBEAT_MS;
    try {
      this.ws?.ping();
      this.#send({ t: FRAME.ping, id: this.nextId++ });
    } catch {
      /* 刚连上就断开：交给 close 回调处理 */
    }
  }

  /** 绑定 WS 事件。 */
  #bindEvents(client) {
    client.on('message', (text) => this.#onFrame(text));
    client.on('pong', () => {
      this.lastPongAt = this.now();
      this.pongDeadline = null;
    });
    client.on('ping', () => {
      /* RFC 层已自动回 pong */
    });
    client.on('error', (err) => {
      this.stats.errors += 1;
      this.logger.warn(`中继隧道错误：${err?.message ?? err}`);
    });
    client.on('close', (code, reason) => {
      const wasConnected = this.connected;
      this.connected = false;
      this.#stopHeartbeat();
      this.#abortAllInbound('home_disconnected');
      this.#rejectAllOutbound(new Error('中继隧道已断开'));
      if (wasConnected) this.logger.warn(`中继隧道断开（code=${code}${reason ? ` ${redactSecrets(reason)}` : ''}）`);
      if (!this.closedByUser && !this.shuttingDown) this.#scheduleReconnect();
    });
  }

  /** 处理一帧。 */
  #onFrame(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.stats.errors += 1;
      this.logger.warn('中继发来非 JSON 帧，已忽略');
      return;
    }
    this.stats.framesIn += 1;
    this.lastFrameType = frame.t ?? null; // 诊断：ready 超时时能看出中继到底回了什么
    switch (frame.t) {
      case FRAME.ready:
        this.homeId = frame.homeId ?? this.homeId;
        this.emit('__ready', frame);
        break;
      case FRAME.error: {
        const message = `中继拒绝：${frame.code ?? 'error'} ${frame.message ?? ''}`.trim();
        this.lastError = message;
        this.logger.warn(message);
        if (frame.fatal) {
          this.closedByUser = true; // fatal 不再重连（例如 token 失效）
          this.emit('__fatal', new Error(message));
          client_close(this.ws);
        }
        break;
      }
      case FRAME.req:
        void this.#dispatch(frame);
        break;
      case FRAME.res:
        this.#onRes(frame);
        break;
      case FRAME.chunk:
        this.#onChunk(frame);
        break;
      case FRAME.end:
        this.#onEnd(frame);
        break;
      case FRAME.abort:
        this.#onAbort(frame);
        break;
      case FRAME.cancel:
        this.#cancelInbound(frame.id, frame.reason ?? 'canceled_by_relay');
        break;
      case FRAME.ping:
        this.#send({ t: FRAME.pong, id: frame.id });
        break;
      case FRAME.pong:
        this.lastPongAt = this.now();
        this.pongDeadline = null;
        break;
      case FRAME.notice:
        this.logger.info(`中继通知：${frame.kind}${frame.homeId ? ` homeId=${frame.homeId}` : ''}`);
        this.onNotice?.(frame);
        break;
      default:
        this.logger.warn(`中继发来未知帧类型：${frame.t}`);
    }
  }

  /**
   * 把中继派发的 `req` 转成本机真实 HTTP 请求（**不绕过鉴权**）。
   *
   * SSE 长连接由 `end` 永不发出自然表达；客户端离开时中继发 `cancel`，这里销毁本地请求。
   */
  async #dispatch(frame) {
    const id = frame.id;
    const base = this.localBaseUrl?.() ?? null;
    if (!base) {
      // 业务失败走 HTTP 语义（503 + 错误体 + end），不用 abort（见 ABORT_REASONS 注释）
      this.#replyError(id, 503, 'internal', '网关尚未就绪（未完成监听或本机地址不可用）');
      return;
    }
    if (this.inbound.size >= (this.relayCfg.maxStreams ?? 64)) {
      // 契约 §3.3 已有 `too_many_streams` 这个码，比通用的 rate_limited 更贴切
      this.#replyError(id, 429, 'too_many_streams', `隧道并发流已达上限（${this.relayCfg.maxStreams ?? 64}）`);
      return;
    }

    const method = String(frame.method ?? 'GET').toUpperCase();
    const target = String(frame.path ?? '/');
    const headers = { ...(frame.headers ?? {}) };
    // 交给本机 HTTP 自己决定 Host / Content-Length，避免中继传来的值把请求带偏
    delete headers.host;
    delete headers.Host;
    delete headers['content-length'];
    delete headers['Content-Length'];
    delete headers.connection;
    delete headers.Connection;
    delete headers.upgrade;
    delete headers.Upgrade;
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];
    // **先剥掉客户端自带的隧道标记，再强制置 1**：顺序不能反，
    // 否则手机可以用 `x-dsh-tunnel: 0` 伪装成"直连"从而绕过管理端点的拒绝。
    deleteHeaderInsensitive(headers, TUNNEL_HEADER);
    headers[TUNNEL_HEADER] = '1';
    if (frame.bodyB64) headers['Content-Length'] = String(Buffer.from(frame.bodyB64, 'base64').length);

    const timeoutMs = this.relayCfg.requestTimeoutMs ?? 60_000;
    let url;
    try {
      url = new URL(target.startsWith('http') ? target : `${base}${target.startsWith('/') ? '' : '/'}${target}`);
    } catch {
      this.#replyError(id, 400, 'bad_request', `请求路径无法解析：${target}`);
      return;
    }
    // **纵深防御（relay-dev 在 R2 审计里发现的真绕过）**：
    // `new URL()` 会把 `..`、`.`、`%2e%2e`、反斜杠折叠掉，而中继若按**字面路径**判定放行、
    // 网关折叠后再打本机 HTTP，回环/白名单检查就会被绕过
    // （实测 `GET /x/../api/v2/relay/status` 曾经能拿到 PC 的中继状态）。
    // 这里要求"字面路径 == 规范化后的路径"，否则直接 400，绝不让怪异路径进入本机 HTTP。
    const literalPath = target.startsWith('http') ? new URL(target).pathname : target.split('?')[0].split('#')[0];
    if (literalPath !== url.pathname) {
      this.#replyError(id, 400, 'bad_request', `路径必须已规范化（字面 ${literalPath} ≠ 规范化 ${url.pathname}）`);
      return;
    }
    // 只允许打自己的回环地址，防止被中继当作任意请求转发器
    const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
    if (!allowedHosts.has(url.hostname)) {
      this.#replyError(id, 403, 'forbidden', `隧道只允许访问网关本机回环地址，拒绝：${url.hostname}`);
      return;
    }

    const isStream = /text\/event-stream/i.test(String(headers.accept ?? headers.Accept ?? ''));
    const record = { req: null, res: null, aborted: false, path: `${method} ${url.pathname}`, isStream };
    this.inbound.set(id, record);
    this.stats.requests += 1;
    if (isStream) this.stats.streams += 1;

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      { method, hostname: url.hostname, port: url.port || 80, path: `${url.pathname}${url.search}`, headers },
      (res) => {
        if (record.aborted) {
          res.destroy();
          return;
        }
        record.res = res;
        this.#send({ t: FRAME.res, id, status: res.statusCode ?? 502, headers: flattenHeaders(res.headers) });
        res.on('data', (buf) => {
          if (record.aborted) return;
          for (const slice of sliceBuffer(buf, CHUNK_BYTES)) {
            this.#send({ t: FRAME.chunk, id, dataB64: slice.toString('base64') });
          }
        });
        res.on('end', () => {
          if (record.aborted) return;
          this.inbound.delete(id);
          this.#send({ t: FRAME.end, id });
        });
        res.on('error', () => this.#abortInbound(id, 'internal'));
      },
    );
    record.req = req;
    // 超时只对非流式请求生效：SSE 本来就要挂很久
    if (!isStream) req.setTimeout(timeoutMs, () => this.#abortInbound(id, 'timeout'));

    req.on('error', () => {
      // 本机 HTTP 层的 socket 级错误属于"传输层异常"，用 abort + `internal`
      if (record.aborted) return;
      this.inbound.delete(id);
      this.#abortStream(id, 'internal');
    });
    if (frame.bodyB64) req.write(Buffer.from(frame.bodyB64, 'base64'));
    req.end();
  }

  /**
   * 用 **HTTP 语义**回答一个在到达本机 HTTP 之前就失败的隧道请求：
   * `res{status}` + 错误体 + `end`。
   *
   * 为什么不用 `abort`：`abort.reason` 只允许契约 §3.3 的六值枚举，表达的是
   * "传输层为什么断"；把 `bad_path`/`forbidden_target` 这类**业务原因**塞进去，
   * 中继只能归一成 `internal`，手机端就看不到真正的原因了。
   */
  #replyError(id, status, code, message) {
    const body = Buffer.from(JSON.stringify({ error: { code, message } }), 'utf8');
    this.#send({
      t: FRAME.res,
      id,
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) },
    });
    for (const slice of sliceBuffer(body, CHUNK_BYTES)) {
      this.#send({ t: FRAME.chunk, id, dataB64: slice.toString('base64') });
    }
    this.#send({ t: FRAME.end, id });
  }

  /** 发一个 abort 帧（reason 会被归一为六值枚举之一）。 */
  #abortStream(id, reason) {
    this.stats.aborted += 1;
    this.#send({ t: FRAME.abort, id, reason: normalizeAbortReason(reason) });
  }

  /** 处理 `res`（我们出站请求的响应头）。 */
  #onRes(frame) {
    const pending = this.outbound.get(frame.id);
    if (!pending) return;
    pending.status = frame.status ?? 502;
    pending.headers = frame.headers ?? {};
    pending.onHeaders?.(pending.status, pending.headers);
  }

  /** 处理 `chunk`。 */
  #onChunk(frame) {
    const pending = this.outbound.get(frame.id);
    if (!pending || !frame.dataB64) return;
    const buf = Buffer.from(frame.dataB64, 'base64');
    if (pending.onChunk) pending.onChunk(buf);
    else pending.chunks.push(buf);
  }

  /** 处理 `end`。 */
  #onEnd(frame) {
    const pending = this.outbound.get(frame.id);
    if (!pending) return;
    this.outbound.delete(frame.id);
    clearTimeout(pending.timer);
    pending.resolve({
      status: pending.status ?? 200,
      headers: pending.headers ?? {},
      body: pending.onChunk ? null : Buffer.concat(pending.chunks),
      ok: true,
    });
  }

  /** 处理 `abort`。 */
  #onAbort(frame) {
    const pending = this.outbound.get(frame.id);
    if (!pending) {
      // 也可能是中继要求终止某条在途入站请求
      this.#cancelInbound(frame.id, frame.reason ?? 'aborted');
      return;
    }
    this.outbound.delete(frame.id);
    clearTimeout(pending.timer);
    pending.resolve({ status: pending.status ?? 502, headers: pending.headers ?? {}, body: null, ok: false, reason: frame.reason ?? 'aborted' });
  }

  /** 主动取消（中继要求终止某条在途请求）→ abort reason 固定为 `canceled`。 */
  #cancelInbound(id, reason) {
    const record = this.inbound.get(id);
    if (!record) return;
    record.aborted = true;
    this.stats.aborted += 1;
    try {
      record.req?.destroy();
    } catch {
      /* 已结束 */
    }
    this.inbound.delete(id);
    this.#abortStream(id, 'canceled');
    void reason;
  }

  /** 本地 HTTP 出错时终止这条流（传输层原因 → abort；业务原因走 #replyError）。 */
  #abortInbound(id, reason) {
    const record = this.inbound.get(id);
    if (!record) return;
    record.aborted = true;
    this.inbound.delete(id);
    this.#abortStream(id, reason);
  }

  /** 断开时清理所有在途出站请求（契约要求：home 掉线时清理进行中的流）。 */
  #abortAllInbound(reason) {
    for (const [id, record] of [...this.inbound]) {
      record.aborted = true;
      try {
        record.req?.destroy();
      } catch {
        /* 已结束 */
      }
      this.inbound.delete(id);
      void id;
    }
    if (this.inbound.size === 0) return;
    this.logger.warn(`隧道断开，已清理在途请求（${reason}）`);
  }

  #rejectAllOutbound(err) {
    for (const [id, pending] of [...this.outbound]) {
      clearTimeout(pending.timer);
      this.outbound.delete(id);
      pending.resolve({ status: 0, headers: {}, body: null, ok: false, reason: err.message });
    }
  }

  /**
   * 出站控制面请求（契约 §3.4）：home 通过隧道调用**中继自身**的端点。
   * @param {string} method
   * @param {string} pathname
   * @param {object|null} [body]
   * @param {{timeoutMs?: number, onHeaders?: Function, onChunk?: Function}} [opts]
   * @returns {Promise<{ok: boolean, status: number, headers: object, body: Buffer|null, json: object|null, reason?: string}>}
   */
  request(method, pathname, body = null, { timeoutMs = 20_000, onHeaders = null, onChunk = null } = {}) {
    if (!this.connected || !this.ws?.isOpen) {
      return Promise.resolve({ ok: false, status: 0, headers: {}, body: null, json: null, reason: 'relay_not_connected' });
    }
    const id = this.nextId++;
    const frame = { t: FRAME.req, id, method: String(method).toUpperCase(), path: pathname, headers: { 'Content-Type': 'application/json; charset=utf-8' } };
    if (body !== null && body !== undefined) {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      frame.bodyB64 = Buffer.from(text, 'utf8').toString('base64');
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.outbound.delete(id);
        resolve({ ok: false, status: 0, headers: {}, body: null, json: null, reason: 'timeout' });
      }, timeoutMs);
      timer.unref?.();
      this.outbound.set(id, {
        resolve: (result) => {
          let json = null;
          if (result.body) {
            try {
              json = JSON.parse(result.body.toString('utf8'));
            } catch {
              json = null;
            }
          }
          resolve({ ...result, json });
        },
        reject: () => {},
        chunks: [],
        headers: null,
        status: null,
        timer,
        onHeaders,
        onChunk,
      });
      this.#send(frame);
    });
  }

  /** 发一帧。 */
  #send(frame) {
    if (!this.ws?.isOpen) return false;
    this.stats.framesOut += 1;
    return this.ws.send(JSON.stringify(frame));
  }

  /**
   * 心跳：每 `HEARTBEAT_INTERVAL_MS`（10s）发一次 ping，`HEARTBEAT_MS`（30s）内无 pong 判死链。
   *
   * 两条健壮性要求（都是实测踩出来的）：
   * 1. **间隔必须显著小于超时阈值**，否则第一个 ping 会与对端的空闲判定同时到期而被先掐断；
   * 2. **判据用 socket 是否真开（`ws.isOpen`）而不是 `this.connected`**：
   *    后者在某些路径上可能被置 false 而 socket 仍在，那会让网关**静默停发心跳**，
   *    对端只看到"30s 无任何帧"（ops-doc 报的现象），排查时极难定位。
   */
  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws?.isOpen) return;
      if (this.pongDeadline !== null && this.now() > this.pongDeadline) {
        this.logger.warn(`${HEARTBEAT_MS / 1000}s 无 pong，判定死链并重连`);
        this.lastError = '心跳超时';
        try {
          this.ws?.terminate();
        } catch {
          /* 已断开 */
        }
        return;
      }
      if (this.pongDeadline === null) this.pongDeadline = this.now() + HEARTBEAT_MS;
      this.ws?.ping();
      this.#send({ t: FRAME.ping, id: this.nextId++ });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.pongDeadline = null;
  }

  /** 退避重连。 */
  #scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (!this.enabled || this.closedByUser || this.shuttingDown) return;
    this.attempt += 1;
    this.reconnects += 1;
    const delay = backoffDelay(this.attempt, this.relayCfg.reconnect ?? BACKOFF_DEFAULT);
    this.logger.info(`将在 ${delay}ms 后重连中继（第 ${this.attempt} 次，上限 ${(this.relayCfg.reconnect?.maxMs ?? 30_000) / 1000}s）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shuttingDown || this.closedByUser) return;
      void this.connect().then((result) => {
        if (!result.ok) this.#scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * 主动断开（契约 §4.1 `POST /api/v2/relay/disconnect`，配置保留）。
   * @param {{keepEnabled?: boolean}} [opts]
   */
  disconnect({ keepEnabled = true } = {}) {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.#stopHeartbeat();
    this.#abortAllInbound('disconnect');
    this.#rejectAllOutbound(new Error('已主动断开'));
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.since = null;
    this.attempt = 0;
    if (!keepEnabled) this.enabled = false;
    try {
      ws?.close(1000, 'client disconnect');
    } catch {
      /* 已断开 */
    }
    this.logger.info('中继隧道已主动断开（配置保留）');
    return { ok: true, status: this.status() };
  }

  /** 关闭（进程退出）。 */
  async shutdown() {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.#stopHeartbeat();
    this.#abortAllInbound('shutdown');
    this.#rejectAllOutbound(new Error('网关关闭'));
    try {
      this.ws?.close(1000, 'gateway shutdown');
    } catch {
      /* 已断开 */
    }
    this.connected = false;
  }

  /**
   * 声明配对窗口（契约 §3.4）。配对码由网关生成，撞号时返回 `conflict` 由调用方重试。
   * @param {{code: string, expiresAt: number}} input
   * @returns {Promise<{ok: boolean, conflict: boolean, status: number, homeId?: string, expiresAt?: number, error?: string}>}
   */
  async openPairWindow({ code, expiresAt }) {
    const res = await this.request('POST', CONTROL.pairWindow, { code, expiresAt });
    if (res.ok && res.status === 200) {
      return { ok: true, conflict: false, status: res.status, expiresAt: res.json?.expiresAt ?? expiresAt };
    }
    const errCode = res.json?.error?.code;
    if (res.status === 409 || errCode === 'code_conflict') return { ok: false, conflict: true, status: res.status, error: 'code_conflict' };
    return { ok: false, conflict: false, status: res.status, error: res.json?.error?.message ?? res.reason ?? `HTTP ${res.status}` };
  }

  /** 关闭配对窗口（契约 §3.4）。 */
  async closePairWindow() {
    const res = await this.request('POST', CONTROL.pairClose, {}, { timeoutMs: 5000 });
    return { ok: res.ok && (res.status === 200 || res.status === 204), status: res.status, error: res.ok ? null : res.reason ?? `HTTP ${res.status}` };
  }

  /** 查询配对窗口（契约 §3.4）。 */
  async getPairWindow() {
    const res = await this.request('GET', CONTROL.pairWindow, null, { timeoutMs: 5000 });
    if (!res.ok || res.status !== 200) return { open: false, expiresAt: null, error: res.reason ?? `HTTP ${res.status}` };
    return { open: res.json?.open === true, expiresAt: res.json?.expiresAt ?? null, error: null };
  }
}

/** 逐跳头（hop-by-hop）：由传输层自己处理，绝不能经隧道原样转发。 */
export const HOP_BY_HOP_HEADERS = Object.freeze(
  new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']),
);

/**
 * 把 node 的响应头拍平成字符串字典，并**过滤逐跳头**。
 *
 * 为什么必须过滤 `transfer-encoding`：隧道自己已经把响应分片成 `chunk` 帧传了，
 * 再把 `transfer-encoding: chunked` 交给手机侧，手机会面对"双重分帧"的歧义
 * （不知道该按 chunked 解析还是按隧道帧拼接），SSE/大响应下尤其危险。
 * @param {object} headers
 * @returns {Record<string,string>}
 */
export function flattenHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase().startsWith('proxy-')) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/** 把任意大小的 Buffer 切成 ≤ size 的片段。 */
export function sliceBuffer(buf, size) {
  if (buf.length <= size) return [buf];
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, Math.min(i + size, buf.length)));
  return out;
}

/** 极小的 POST JSON 客户端（注册用，不引入依赖）。 */
export function postJson(url, body, { timeoutMs = 15_000, tls = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    // **注册阶段必须与隧道阶段用同一份 TLS 策略**（`relay.tls`）。
    // 之前这里对 https 硬编码 `rejectUnauthorized: true`，导致自签中继 + 网关的组合
    // wss 场景**完全不可用**（注册必然失败），而自签是本轮唯一免域名/免证书的 TLS 方案。
    const tlsOptions =
      parsed.protocol === 'https:'
        ? { rejectUnauthorized: tls?.rejectUnauthorized !== false, ...(tls?.ca ? { ca: tls.ca } : {}) }
        : {};
    const req = transport.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
        ...tlsOptions,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(body);
  });
}

/** 握手失败时给出可读原因。 */
export function describeHandshakeError(err) {
  if (err instanceof WebSocketHandshakeError) {
    if (err.statusCode === 401) return '中继拒绝：homeToken 无效或已轮换（请重新 POST /api/v2/relay/connect）';
    if (err.statusCode === 404) return `中继隧道端点不存在（HTTP 404）：请确认中继实现了 /api/v2/tunnel/home`;
    return `中继握手被拒绝：HTTP ${err.statusCode}`;
  }
  return err?.message ?? String(err);
}

/** 安全取主机名。 */
function safeHostname() {
  try {
    return process.env.COMPUTERNAME || process.env.HOSTNAME || 'dsh-pc';
  } catch {
    return 'dsh-pc';
  }
}

/** 安全关闭 ws。 */
function client_close(ws) {
  try {
    ws?.close(1000, 'fatal');
  } catch {
    /* 已断开 */
  }
}

/** 便于测试：确认状态文件的默认路径。 */
export function relayStateFileFor(config) {
  return config.relayStateFile ?? path.join(config.home ?? '.', 'relay.json');
}

/** 便于测试：默认日志器（静默）。 */
export function silentLogger() {
  return createLogger({ dir: null, toConsole: false });
}
