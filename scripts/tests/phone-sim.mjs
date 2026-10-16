// phone-sim.mjs —— 「纯 Node 手机模拟器」：经中继隧道扮演 Android 客户端（契约 §3/§4）。
//
// 为什么要有它：
//   docs/01-设计/协议契约-v2.md §6 的判据 B/D/E 需要证明「手机不直连 PC，只经中继可达」。
//   本脚本不依赖 Android/模拟器，用真实 TCP + 真实 WebSocket + 真实网关 HTTP handler
//   走完整链路：pair/claim → 隧道 hello/ready → req/res/chunk/end → SSE 增量 → 续聊。
//
// 子命令：
//   claim  用 6 位配对码在中继上换成设备令牌（HTTP POST /api/v2/pair/claim），写令牌文件
//   probe  判据 B：会话列表 / 会话详情 / transcript / 工作区文件 / 工作区改动 / 越界拒绝 / 续聊（POST turns + SSE）
//   watch  判据 D/E：长驻隧道，记录 notice(home_offline/home_online) 与周期性请求结果，供外层断言
//   http   单次请求（排障用）：--method/--path → 打印真实状态码与响应体
//
// 通用参数：
//   --relay <http(s)://host:port>   中继 base（也接受 ws://，内部归一为 http://）
//   --token-file <path>             claim 写出 / probe|watch 读入的令牌文件
//   --events <path>                 事件流 NDJSON（外层 PowerShell 轮询它做断言）
//   --insecure                      wss 自签证书（仅开发期；契约 §5.5 第 4 条）
//   --timeout <sec>                 单请求超时（默认 60）
//   --body-file <path>              http 子命令的请求体来源（**推荐**，见下）
//
// 为什么 http 子命令要有 --body-file：
//   Windows PowerShell 5.1 把带双引号的参数传给原生程序时会剥掉引号，
//   实测 `--body '{"prompt":"hi"}'` 到 node 里变成 `{prompt:hi}`，网关只能返回 400。
//   请求体是 JSON（必须带双引号），所以运维/脚本要用 --body-file 落盘再传，
//   同时也避免了 5.1 的 ANSI 解析把中文请求体变成乱码（见 README「已知坑」）。
//
// 事件（每行一个 JSON）：
//   { "at": <ms>, "kind": "log|phase|connected|ready|notice|http|sse|assert|error|summary",
//     "name": "...", "ok": true|false, "message": "...", "data": {...} }
//
// 零第三方依赖：只使用 Node 内置模块（契约 §5.1）。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ── 参数解析 ──────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
    } else {
      options._.push(arg);
    }
  }
  return options;
}

const args = parseArgv(process.argv.slice(2));
const command = args._[0];

function normalizeRelayBase(value) {
  if (!value) return null;
  let base = String(value).trim().replace(/\/+$/, '');
  if (base.startsWith('ws://')) base = `http://${base.slice(5)}`;
  else if (base.startsWith('wss://')) base = `https://${base.slice(6)}`;
  return base;
}

function toWsUrl(httpBase, role) {
  let base = String(httpBase).replace(/\/+$/, '');
  if (base.startsWith('https://')) base = `wss://${base.slice(8)}`;
  else if (base.startsWith('http://')) base = `ws://${base.slice(7)}`;
  return `${base}/api/v2/tunnel/${role}`;
}

const RELAY_BASE = normalizeRelayBase(args.relay || process.env.DSH_E2E_RELAY || 'http://127.0.0.1:9443');
const TOKEN_FILE = args['token-file'] || null;
const EVENTS_FILE = args.events || null;
const INSECURE = Boolean(args.insecure);
const TIMEOUT_SEC = Number(args.timeout || 60);
const DEVICE_NAME = String(args['device-name'] || 'phone-sim');

// 事件文件用「每次 append 后立即关闭」的写法：长连接的 createWriteStream 会让文件被独占，
// 外层 PowerShell（File.ReadAllText / FileShare.Read）读不到，判据 D/E 的断言会全部超时。
const EVENTS_PATH = EVENTS_FILE ? path.resolve(EVENTS_FILE) : null;
if (EVENTS_PATH) {
  fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
}

function emit(kind, name, extra = {}) {
  const record = { at: Date.now(), kind, ...(name ? { name } : {}), ...extra };
  const line = JSON.stringify(record);
  if (EVENTS_PATH) {
    try {
      fs.appendFileSync(EVENTS_PATH, `${line}\n`);
    } catch {
      /* 事件文件写失败不应影响主流程（stdout 仍有同样内容） */
    }
  }
  const okText = record.ok === undefined ? '' : record.ok ? ' ok' : ' FAIL';
  const msg = record.message ? ` — ${record.message}` : '';
  process.stdout.write(`[phone-sim] ${kind}${okText} ${name || ''}${msg}\n`);
  return record;
}

function die(message, code = 2) {
  emit('error', null, { ok: false, message });
  process.exit(code);
}

async function flushEvents() {
  // appendFileSync 模式下无需 flush（保留函数签名，调用点不动）
}

// ── HTTP 小工具（中继 HTTP 端点：pair/claim、health）────────────────────────────

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const payload = body === null ? null : Buffer.from(body, 'utf8');
    const request = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length } : {}),
          'X-Api-Version': '2',
          ...headers,
        },
        rejectUnauthorized: !INSECURE,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: response.statusCode, headers: response.headers, body: buffer, text: buffer.toString('utf8') });
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`HTTP 超时（${timeoutMs}ms）：${method} ${url}`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

// ── RFC6455 客户端（文本帧 + 分片 + ping/pong/close）───────────────────────────

class WebSocketClient {
  constructor(url, { headers = {}, insecure = false, onMessage, onClose, onError, pingIntervalMs = 20000 } = {}) {
    this.url = url;
    this.headers = headers;
    this.insecure = insecure;
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});
    this.onError = onError || (() => {});
    this.pingIntervalMs = pingIntervalMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.lastPong = Date.now();
    this.pingTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const target = new URL(this.url);
      const lib = target.protocol === 'wss:' ? https : http;
      const key = crypto.randomBytes(16).toString('base64');
      const request = lib.request({
        // 注意：不能把 `protocol: 'ws:'` 传给 http.request（Node 只认 http:/https:），
        // 用 ws→http / wss→https 的库选择来表达协议即可。
        hostname: target.hostname,
        port: target.port || (target.protocol === 'wss:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          ...this.headers,
        },
        rejectUnauthorized: !this.insecure,
      });
      const failHandshake = (message) => {
        this.closed = true;
        reject(new Error(message));
      };
      request.on('upgrade', (response, socket, head) => {
        const accept = response.headers['sec-websocket-accept'];
        const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        if (accept !== expected) {
          socket.destroy();
          failHandshake(`WebSocket 握手校验失败：Sec-WebSocket-Accept=${accept}`);
          return;
        }
        this.socket = socket;
        socket.on('data', (chunk) => this.#onData(chunk));
        socket.on('close', () => {
          if (this.closed) return;
          this.closed = true;
          if (this.pingTimer) clearInterval(this.pingTimer);
          this.onClose({ code: 1006, reason: 'socket closed' });
        });
        socket.on('error', (error) => {
          if (this.closed) return;
          this.closed = true;
          this.onError(error);
          // 关键：socket error（如中继进程被杀 → ECONNRESET）也必须走 onClose，
          // 否则上层永远收不到「连接已断」，既不重连也不报错，请求会一直"隧道未连接"。
          this.onClose({ code: 1006, reason: `socket error: ${error.message}` });
        });
        if (head && head.length) this.#onData(head);
        this.#startPing();
        resolve(response);
      });
      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          failHandshake(`WebSocket 升级被拒绝：HTTP ${response.statusCode} ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`);
        });
      });
      request.on('error', (error) => failHandshake(`WebSocket 连接失败：${error.message}`));
      request.end();
    });
  }

  #startPing() {
    if (!this.pingIntervalMs) return;
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastPong > this.pingIntervalMs * 3) {
        const error = new Error('心跳超时：30s 内未收到 pong');
        this.onError(error);
        if (!this.closed) {
          this.closed = true;
          this.onClose({ code: 1006, reason: error.message });
        }
        this.destroy();
        return;
      }
      try {
        this.#sendFrame(0x9, Buffer.alloc(0));
      } catch {
        /* socket 已断，交给 close 处理 */
      }
    }, this.pingIntervalMs);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.#decodeFrame();
      if (!frame) return;
      const { fin, opcode, payload } = frame;
      if (opcode === 0x8) {
        this.closed = true;
        if (this.pingTimer) clearInterval(this.pingTimer);
        try {
          this.socket.end(Buffer.from([0x88, 0x00]));
        } catch {
          /* ignore */
        }
        this.onClose({ code: 1000, reason: 'close frame' });
        return;
      }
      if (opcode === 0x9) {
        this.#sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) {
        this.lastPong = Date.now();
        continue;
      }
      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          this.onMessage(full.toString('utf8'), this.fragmentOpcode);
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this.onMessage(payload.toString('utf8'), opcode);
        } else {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
        }
        continue;
      }
      // 其余 opcode 按文本处理，够用即可
    }
  }

  #decodeFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;
    const first = buffer[0];
    const second = buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null;
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket 帧过大');
      length = Number(big);
      offset += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buffer.length < offset + length) return null;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  #sendFrame(opcode, payload) {
    if (!this.socket || this.closed) throw new Error('WebSocket 未连接');
    const mask = crypto.randomBytes(4);
    const data = Buffer.from(payload);
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    let header;
    if (data.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | data.length;
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, mask, data]));
  }

  sendText(text) {
    this.#sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  destroy() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      if (this.socket) this.socket.destroy();
    } catch {
      /* ignore */
    }
  }
}

// ── 隧道客户端：把 HTTP 请求变成 req/chunk/end 帧（契约 §3.1/§3.2）─────────────

class Tunnel {
  constructor({ wsUrl, token, name, onNotice }) {
    this.wsUrl = wsUrl;
    this.token = token;
    this.name = name;
    this.onNotice = onNotice || (() => {});
    this.ws = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.readyWaiters = [];
    this.closedByUser = false;
    this.closeHandled = false;
    this.autoReconnect = false;
    this.reconnects = 0;
    this.reconnectTimer = null;
  }

  async connect({ autoReconnect = true } = {}) {
    this.autoReconnect = autoReconnect;
    this.closeHandled = false;
    if (!this.token) throw new Error('缺少 deviceToken（先用 claim 子命令换取）');
    this.ws = new WebSocketClient(this.wsUrl, {
      insecure: INSECURE,
      headers: { Authorization: `Bearer ${this.token}`, 'X-Api-Version': '2' },
      onMessage: (text) => this.#onFrame(text),
      onClose: () => this.#onClosed('连接断开'),
      onError: (error) => emit('log', 'ws-error', { message: error.message }),
    });
    await this.ws.connect();
    this.ws.sendText(JSON.stringify({ t: 'hello', proto: 2, role: 'device', name: this.name }));
    const ready = await this.#waitReady(10000);
    emit('ready', 'tunnel', {
      ok: true,
      message: `homeId=${ready.homeId} homeName=${ready.homeName === undefined ? '?' : ready.homeName} homeOnline=${ready.homeOnline}`,
      data: ready,
    });
    return ready;
  }

  #waitReady(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`隧道 ready 超时（${timeoutMs}ms）`)), timeoutMs);
      this.readyWaiters.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  #onFrame(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      emit('log', 'bad-frame', { message: `无法解析帧：${text.slice(0, 200)}` });
      return;
    }
    if (args['verbose-frames']) {
      emit('frame', String(frame.t || '?'), {
        message: `id=${frame.id === undefined ? '-' : frame.id} status=${frame.status === undefined ? '-' : frame.status} len=${text.length}`,
      });
    }
    switch (frame.t) {
      case 'ready':
        this.ready = frame;
        for (const waiter of this.readyWaiters.splice(0)) waiter.resolve(frame);
        return;
      case 'error':
        emit('log', 'tunnel-error', { message: `code=${frame.code} message=${frame.message} fatal=${frame.fatal}` });
        for (const waiter of this.readyWaiters.splice(0)) waiter.reject(new Error(`隧道拒绝：${frame.code} ${frame.message}`));
        if (frame.fatal) this.destroy();
        return;
      case 'res': {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        entry.onRes({ status: frame.status, headers: frame.headers || {} });
        return;
      }
      case 'chunk': {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        const data = Buffer.from(frame.dataB64 || '', 'base64');
        entry.chunks.push(data);
        if (entry.onChunk) entry.onChunk(data);
        if (entry.chunks.length > 4096) {
          this.pending.delete(frame.id);
          try {
            this.ws.sendText(JSON.stringify({ t: 'cancel', id: frame.id }));
          } catch {
            /* ignore */
          }
          entry.onFail(new Error('响应分片过多（>4096），已取消'));
        }
        return;
      }
      case 'end': {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        this.pending.delete(frame.id);
        entry.onEnd({ aborted: false });
        return;
      }
      case 'abort': {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        this.pending.delete(frame.id);
        entry.onFail(new Error(`隧道 abort：reason=${frame.reason}`));
        return;
      }
      case 'notice':
        emit('notice', String(frame.kind || 'notice'), { ok: true, message: `homeId=${frame.homeId === undefined ? '?' : frame.homeId}`, data: frame });
        this.onNotice(frame);
        return;
      case 'ping':
        this.ws.sendText(JSON.stringify({ t: 'pong', id: frame.id }));
        return;
      case 'pong':
        return;
      default:
        emit('log', 'unknown-frame', { message: text.slice(0, 200) });
    }
  }

  #onClosed(reason) {
    if (this.closeHandled) return;
    this.closeHandled = true;
    for (const [, entry] of this.pending) entry.onFail(new Error(`隧道关闭（${reason}）`));
    this.pending.clear();
    if (this.closedByUser) {
      emit('closed', 'tunnel', { ok: true, message: '主动关闭' });
      return;
    }
    emit('closed', 'tunnel', { ok: false, message: `连接断开（${reason}）` });
    if (this.autoReconnect) this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnects += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.reconnects - 1, 5), 30000);
    emit('reconnecting', 'tunnel', { message: `第 ${this.reconnects} 次重连，${delay}ms 后（指数退避 1s→30s）` });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      try {
        await this.connect({ autoReconnect: true });
        emit('reconnected', 'tunnel', { ok: true, message: `第 ${this.reconnects} 次重连成功` });
      } catch (error) {
        emit('reconnecting', 'tunnel', { ok: false, message: `重连失败：${error.message}` });
        this.#onClosed('重连失败');
      }
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  /** 发起一次请求，返回 { id, resPromise, endPromise, chunks } */
  #startRequest(method, requestPath, { body = null, headers = {}, timeoutMs = TIMEOUT_SEC * 1000, onChunk = null } = {}) {
    if (!this.ws || this.ws.closed) throw new Error('隧道未连接');
    const id = this.nextId++;
    let resolveRes;
    let rejectRes;
    let resolveEnd;
    const resPromise = new Promise((resolve, reject) => {
      resolveRes = resolve;
      rejectRes = reject;
    });
    const endPromise = new Promise((resolve) => {
      resolveEnd = resolve;
    });
    resPromise.catch(() => {
      /* 由调用方处理，这里吞掉未处理的 rejection */
    });
    const chunks = [];
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        try {
          this.ws.sendText(JSON.stringify({ t: 'cancel', id }));
        } catch {
          /* ignore */
        }
        const error = new Error(`请求超时（${timeoutMs}ms）：${method} ${requestPath}`);
        rejectRes(error);
        resolveEnd({ aborted: true, error: error.message });
      }
    }, timeoutMs);
    const entry = {
      chunks,
      onChunk,
      onRes: (value) => resolveRes(value),
      onEnd: (info) => {
        clearTimeout(timer);
        resolveEnd(info);
      },
      onFail: (error) => {
        clearTimeout(timer);
        rejectRes(error);
        resolveEnd({ aborted: true, error: error.message });
      },
    };
    this.pending.set(id, entry);
    const frame = { t: 'req', id, method, path: requestPath, headers: { 'X-Api-Version': '2', ...headers } };
    if (body !== null && body !== undefined) {
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      frame.bodyB64 = payload.toString('base64');
    }
    this.ws.sendText(JSON.stringify(frame));
    return { id, resPromise, endPromise, chunks };
  }

  /** 普通请求：等 res + end，返回 { status, headers, body, text } */
  request(method, requestPath, options = {}) {
    const handle = this.#startRequest(method, requestPath, options);
    return new Promise((resolve, reject) => {
      let res = null;
      handle.resPromise.then(
        (value) => {
          res = value;
        },
        (error) => reject(error),
      );
      handle.endPromise.then((info) => {
        if (info.aborted) {
          reject(new Error(info.error || '请求被终止'));
          return;
        }
        if (!res) {
          reject(new Error('响应头缺失（res 帧未到达）'));
          return;
        }
        const body = Buffer.concat(handle.chunks);
        resolve({ status: res.status, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
  }

  /** SSE 长流：返回句柄 { id, status, headers, text, chunks, cancel(), waitEnd() } */
  async stream(method, requestPath, options = {}) {
    const handle = { id: 0, status: undefined, headers: {}, text: '', chunks: [], cancel: () => {}, waitEnd: () => Promise.resolve({ aborted: false }) };
    const inner = this.#startRequest(method, requestPath, {
      ...options,
      onChunk: (data) => {
        handle.chunks.push(data);
        handle.text += data.toString('utf8');
      },
    });
    handle.id = inner.id;
    handle.cancel = () => {
      try {
        this.ws.sendText(JSON.stringify({ t: 'cancel', id: inner.id }));
      } catch {
        /* ignore */
      }
    };
    handle.waitEnd = () => inner.endPromise;
    const res = await inner.resPromise;
    handle.status = res.status;
    handle.headers = res.headers;
    return handle;
  }

  destroy() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      if (this.ws) this.ws.destroy();
    } catch {
      /* ignore */
    }
  }
}

// ── 令牌文件 ──────────────────────────────────────────────────────────────────

function readTokenFile(file) {
  if (!file) die('缺少 --token-file');
  const full = path.resolve(file);
  if (!fs.existsSync(full)) die(`令牌文件不存在：${full}（先运行 claim 子命令）`);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!parsed.deviceToken) die(`令牌文件缺少 deviceToken：${full}`);
  return parsed;
}

function writeJsonFile(file, value) {
  const full = path.resolve(file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(value, null, 2), 'utf8');
  return full;
}

function mask(value) {
  const text = String(value || '');
  if (text.length <= 8) return '****';
  return `${text.slice(0, 4)}****${text.slice(-2)}`;
}

function sseEvents(text) {
  const events = [];
  for (const block of text.split(/\n\n/)) {
    let name = 'message';
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* 保留原始文本 */
    }
    events.push({ event: name, data });
  }
  return events;
}

// ── 子命令：claim ─────────────────────────────────────────────────────────────

async function cmdClaim() {
  const code = String(args.code || '');
  if (!/^\d{6}$/.test(code)) die(`--code 必须是 6 位数字（收到：${code || '(空)'}）`);
  const deviceId = String(args['device-id'] || crypto.randomUUID()).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deviceId)) {
    die(`deviceId 必须是 32 位小写 UUID：${deviceId}`);
  }
  const url = `${RELAY_BASE}/api/v2/pair/claim`;
  emit('phase', 'claim', { message: `POST ${url}（deviceName=${DEVICE_NAME} deviceId=${deviceId}）` });
  const started = Date.now();
  let response;
  try {
    response = await httpRequest(url, {
      method: 'POST',
      body: JSON.stringify({ code, deviceName: DEVICE_NAME, deviceId }),
      timeoutMs: TIMEOUT_SEC * 1000,
    });
  } catch (error) {
    die(`中继 pair/claim 请求失败：${error.message}`);
  }
  const summary = `HTTP ${response.status}（${Date.now() - started}ms）`;
  if (response.status !== 200) {
    emit('assert', 'pair/claim', { ok: false, message: `${summary}：${response.text.slice(0, 300)}` });
    return 2;
  }
  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch {
    die(`pair/claim 响应不是 JSON：${response.text.slice(0, 300)}`);
  }
  const relay = payload.relay || {};
  if (!relay.deviceToken || !relay.tunnelUrl) {
    emit('assert', 'pair/claim', { ok: false, message: `响应缺少 relay.deviceToken / relay.tunnelUrl：${response.text.slice(0, 300)}` });
    return 2;
  }
  const record = {
    relay: RELAY_BASE,
    homeId: relay.homeId || null,
    tunnelUrl: relay.tunnelUrl,
    deviceToken: relay.deviceToken,
    token: payload.token || null,
    tokenId: payload.tokenId || null,
    serverName: payload.serverName || null,
    deviceId,
    deviceName: DEVICE_NAME,
    claimedAt: Date.now(),
  };
  const file = writeJsonFile(TOKEN_FILE, record);
  emit('assert', 'pair/claim', {
    ok: true,
    message: `${summary} code=${code} homeId=${record.homeId} serverName=${record.serverName} ` +
      `deviceToken=${mask(record.deviceToken)} tunnelUrl=${record.tunnelUrl} → ${file}`,
    data: { status: response.status, homeId: record.homeId, serverName: record.serverName, tokenId: record.tokenId },
  });
  return 0;
}

// ── 子命令：probe（判据 B）────────────────────────────────────────────────────

async function cmdProbe() {
  const tokens = readTokenFile(TOKEN_FILE);
  const wsUrl = args['tunnel-url'] ? String(args['tunnel-url']) : tokens.tunnelUrl || toWsUrl(RELAY_BASE, 'device');
  const gatewayToken = tokens.token;
  if (!gatewayToken) die('令牌文件缺少 token（网关设备令牌），无法调用 /api/v2/*');
  const auth = { Authorization: `Bearer ${gatewayToken}` };
  const assertions = [];
  const check = (name, ok, message, data) => {
    assertions.push({ name, ok, message });
    emit('assert', name, { ok, message, ...(data ? { data } : {}) });
    return ok;
  };

  const tunnel = new Tunnel({ wsUrl, token: tokens.deviceToken, name: DEVICE_NAME });
  emit('phase', 'probe', { message: `连接中继隧道 ${wsUrl}` });
  try {
    await tunnel.connect({ autoReconnect: false });
  } catch (error) {
    check('隧道连接 + ready', false, error.message);
    tunnel.destroy();
    emit('summary', 'probe', { ok: false, message: `隧道连接失败：${error.message}` });
    return 2;
  }
  check('隧道连接 + ready', true, `wsUrl=${wsUrl} homeId=${tunnel.ready ? tunnel.ready.homeId : '?'} homeName=${tunnel.ready ? tunnel.ready.homeName : '?'}`);

  // 1) 会话列表
  const sessionsRes = await tunnel.request('GET', '/api/v2/sessions?limit=50', { headers: auth, timeoutMs: 30000 });
  let sessions = [];
  try {
    sessions = JSON.parse(sessionsRes.text).sessions || [];
  } catch {
    /* 下面断言会报出来 */
  }
  check(
    'GET /api/v2/sessions',
    sessionsRes.status === 200 && Array.isArray(sessions) && sessions.length > 0,
    `HTTP ${sessionsRes.status} 会话数=${sessions.length}`,
    { sample: sessions.slice(0, 3).map((s) => ({ id: s.id, title: s.title, workspace: s.workspace, live: s.live, turns: s.turns })) },
  );

  let sessionId = args.session ? String(args.session) : null;
  let session = sessionId ? sessions.find((s) => s.id === sessionId) || null : null;
  if (!sessionId) {
    // 优先挑「可续聊的手机会话」= source=phone + 网关进程内有活运行时（writable）：
    // 电脑端会话按契约 §4.2/§7.1 是只读镜像，`POST /turns` 必然 409 session_busy。
    // 注意 live 不能当排除条件：本进程自己拥有的手机会话即使 live=true 也能续聊
    // （session-runner 对 ownsRuntime 的会话刻意跳过 mtime 兜底，否则每轮结束后的 60s 内手机说不了第二句话）。
    const resumableList = sessions.filter((s) => s.source === 'phone' && s.writable === true);
    const pick =
      resumableList.find((s) => s.workspace) ||
      resumableList[0] ||
      sessions.find((s) => s.workspace && !s.live) ||
      sessions.find((s) => !s.live) ||
      sessions.find((s) => s.workspace) ||
      sessions[0];
    sessionId = pick.id;
    session = pick;
  }
  // 列表里的 writable 由网关按「本进程是否还有该会话的运行时」算出（http.mjs onListSessions）；
  // 只有手机会话才可能有它，电脑端会话（只读镜像）永远没有 → 不可续聊。
  let canResume = Boolean(session && session.source === 'phone' && session.writable === true);
  if (!sessionId) {
    check('定位目标会话', false, '会话列表为空，且未指定 --session');
    tunnel.destroy();
    emit('summary', 'probe', { ok: false, message: '会话列表为空' });
    return 2;
  }
  const busy = Boolean(session && session.live);
  check(
    '定位目标会话',
    true,
    `sessionId=${sessionId} source=${session ? session.source ?? 'computer' : '(未在列表中)'} 可续聊=${canResume} live=${session ? session.live : '(未在列表中)'} liveReason=${session ? session.liveReason ?? '-' : '-'} workspace=${session ? session.workspace : '(未在列表中)'}`,
  );

  // 2) 单会话元数据 + transcript
  const one = await tunnel.request('GET', `/api/v2/sessions/${sessionId}`, { headers: auth, timeoutMs: 30000 });
  let meta = null;
  try {
    meta = JSON.parse(one.text);
  } catch {
    /* 下面断言会报出来 */
  }
  // 以单会话元数据为准（它是服务端权威判据）：只有 source=phone 且本进程仍有运行时的会话可续聊。
  if (meta) canResume = (meta.source ?? 'computer') === 'phone' && meta.resumable === true;
  check(
    'GET /api/v2/sessions/{id}',
    one.status === 200,
    `HTTP ${one.status} source=${meta ? meta.source : '?'} resumable=${meta ? meta.resumable : '?'} writableReason=${meta ? meta.writableReason ?? '-' : '?'} 可续聊=${canResume}`,
  );

  const transcript1 = await tunnel.request('GET', `/api/v2/sessions/${sessionId}/transcript?tail=20`, { headers: auth, timeoutMs: 60000 });
  let messages = [];
  try {
    messages = JSON.parse(transcript1.text).messages || [];
  } catch {
    /* ignore */
  }
  const maxSeqBefore = messages.reduce((max, m) => Math.max(max, Number(m.seq || 0)), 0);
  const hasChinese = messages.some((m) => /[\u4e00-\u9fff]/.test(String(m.text || '')));
  check(
    'GET /api/v2/sessions/{id}/transcript',
    transcript1.status === 200 && messages.length > 0,
    `HTTP ${transcript1.status} 消息数=${messages.length} 最大seq=${maxSeqBefore} 含中文=${hasChinese}`,
    { tail: messages.slice(-2).map((m) => ({ seq: m.seq, role: m.role, text: String(m.text || '').slice(0, 80) })) },
  );

  // 3) 工作区：文件树 + 改动 + 越界拒绝
  const workspace = (session && session.workspace) || args.workspace || null;
  if (workspace) {
    // 关键：工作区用 `workspace=` 定位（相对路径才放 `path=`）。早期版本把绝对路径塞进 `path=`，
    // 网关按默认工作区判越界 → 403 workspace_outside，看着像链路故障其实是探针参数写错了。
    const files = await tunnel.request('GET', `/api/v2/workspaces/files?workspace=${encodeURIComponent(workspace)}&path=.&depth=1`, { headers: auth, timeoutMs: 30000 });
    let entries = [];
    try {
      entries = JSON.parse(files.text).entries || [];
    } catch {
      /* ignore */
    }
    check(
      'GET /api/v2/workspaces/files',
      files.status === 200 && entries.length > 0,
      `HTTP ${files.status} 条目数=${entries.length}（${entries.slice(0, 5).map((e) => e.name).join(', ')}）`,
    );

    const changes = await tunnel.request('GET', `/api/v2/workspaces/changes?workspace=${encodeURIComponent(workspace)}`, { headers: auth, timeoutMs: 30000 });
    let vcs = null;
    try {
      vcs = JSON.parse(changes.text).vcs;
    } catch {
      /* ignore */
    }
    check('GET /api/v2/workspaces/changes', changes.status === 200, `HTTP ${changes.status} vcs=${vcs}`);

    const outside = await tunnel.request('GET', `/api/v2/workspaces/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path.join('..', '..'))}`, { headers: auth, timeoutMs: 30000 });
    let outsideCode = null;
    try {
      outsideCode = JSON.parse(outside.text).error ? JSON.parse(outside.text).error.code : null;
    } catch {
      /* ignore */
    }
    check('工作区路径越界被拒（403 workspace_outside）', outside.status === 403, `HTTP ${outside.status} code=${outsideCode}`);
  } else {
    check('GET /api/v2/workspaces/files', false, '未能确定工作区路径（会话元数据缺 workspace，且未给 --workspace）');
  }

  // 4) 续聊（判据 B 的核心）：POST turns → SSE 增量 → transcript 复核
  if (args['skip-turns'] || !canResume) {
    emit('phase', 'turns', {
      message: args['skip-turns']
        ? '已指定 --skip-turns：跳过真实续聊'
        : `目标会话不可续聊（source=${meta ? meta.source : session?.source ?? 'computer'}，resumable=${meta ? meta.resumable : '-'}，live=${session?.live ?? '-'}）：电脑端会话是只读镜像、或该手机会话的运行时已随网关重启结束，网关按契约 §4.2 回 409 session_busy。续聊需先建一个手机会话（手机端新建任务，或 phone-sim http POST /api/v2/tasks）`,
    });
    check(
      '续聊阶段',
      true,
      args['skip-turns'] ? '按参数跳过' : '目标会话不可续聊，按预期跳过（非故障；续聊需先建手机会话）',
    );
  } else {
    const prompt = String(args.prompt || `请只回答一句话：这是经中继隧道续聊的验证轮次（时间戳 ${Date.now()}）。不要调用任何工具。`);
    const turnRes = await tunnel.request('POST', `/api/v2/sessions/${sessionId}/turns`, {
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, clientTurnId: crypto.randomUUID() }),
      timeoutMs: 30000,
    });
    let accepted = null;
    try {
      accepted = JSON.parse(turnRes.text);
    } catch {
      /* ignore */
    }
    check(
      'POST /api/v2/sessions/{id}/turns（202 accepted）',
      turnRes.status === 202 && Boolean(accepted) && accepted.accepted === true,
      `HTTP ${turnRes.status} turnId=${accepted ? accepted.turnId : '?'} fromSeq=${accepted ? accepted.fromSeq : '?'}`,
    );

    const fromSeq = accepted && accepted.fromSeq !== undefined ? accepted.fromSeq : maxSeqBefore;
    const deadline = Date.now() + Number(args['turn-timeout'] || 420) * 1000;
    let finished = false;
    let lastText = '';
    let sseStatus = null;
    let sseError = null;
    let sse = null;
    try {
      sse = await tunnel.stream('GET', `/api/v2/sessions/stream?fromSeq=${encodeURIComponent(fromSeq)}`, { headers: auth, timeoutMs: 30000 });
      sseStatus = sse.status;
      emit('phase', 'sse', { message: `SSE 已建立：HTTP ${sse.status}（逐 chunk 增量解析，fromSeq=${fromSeq}）` });
    } catch (error) {
      sseError = error.message;
      emit('phase', 'sse', { ok: false, message: `SSE 建立失败：${error.message}（回退为 transcript 轮询）` });
    }

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (sse) {
        for (const item of sseEvents(sse.text)) {
          const data = item.data && typeof item.data === 'object' ? item.data : null;
          if (!data || (data.sessionId && data.sessionId !== sessionId)) continue;
          if (item.event === 'message.delta' && data.text) lastText += String(data.text);
          if (item.event === 'turn.ended') {
            emit('sse', 'turn.ended', { ok: true, message: `reason=${data.reason}`, data });
            finished = true;
          }
          if (item.event === 'turn.failed') {
            emit('sse', 'turn.failed', { ok: false, message: JSON.stringify(data).slice(0, 200) });
          }
        }
      }
      if (finished) break;
      // SSE 不可用（或网关实现尚未推流）时的兜底：轮询 transcript 看新消息
      const probe = await tunnel.request('GET', `/api/v2/sessions/${sessionId}/transcript?tail=5`, { headers: auth, timeoutMs: 60000 });
      try {
        const now = JSON.parse(probe.text).messages || [];
        const fresh = now.filter((m) => Number(m.seq || 0) > maxSeqBefore && m.role === 'assistant' && String(m.text || '').trim());
        if (fresh.length > 0) {
          lastText = String(fresh[fresh.length - 1].text || '');
          finished = true;
        }
      } catch {
        /* ignore */
      }
    }
    if (sse) sse.cancel();

    check(
      '续聊完成（SSE turn.ended 或 transcript 出现新助手消息）',
      finished,
      finished
        ? `助手回复片段=${JSON.stringify(lastText.slice(0, 80))}${sseError ? `（SSE 降级：${sseError}）` : `（SSE HTTP ${sseStatus}）`}`
        : `等待 ${Number(args['turn-timeout'] || 420)}s 仍未见新助手消息`,
    );

    const transcript2 = await tunnel.request('GET', `/api/v2/sessions/${sessionId}/transcript?tail=10`, { headers: auth, timeoutMs: 60000 });
    let after = [];
    try {
      after = JSON.parse(transcript2.text).messages || [];
    } catch {
      /* ignore */
    }
    const promptSeen = after.some((m) => m.role === 'user' && Number(m.seq || 0) > maxSeqBefore && String(m.text || '').includes(prompt.slice(0, 24)));
    check('续聊写入同一会话（transcript 出现本轮提问）', promptSeen, `tail=10 内可检索到本轮提问=${promptSeen}（本轮 prompt 前缀=${JSON.stringify(prompt.slice(0, 24))}）`);
    const assistantFresh = after.filter((m) => m.role === 'assistant' && Number(m.seq || 0) > maxSeqBefore);
    check(
      '续聊产生助手回复（同会话新增消息）',
      assistantFresh.length > 0 && String(assistantFresh[assistantFresh.length - 1].text || '').trim().length > 0,
      `新增助手消息 ${assistantFresh.length} 条`,
    );
  }

  tunnel.destroy();
  const failed = assertions.filter((a) => !a.ok);
  emit('summary', 'probe', {
    ok: failed.length === 0,
    message: `断言 ${assertions.length} 项，失败 ${failed.length} 项`,
    data: { assertions },
  });
  return failed.length === 0 ? 0 : 2;
}

// ── 子命令：watch（判据 D/E）─────────────────────────────────────────────────

async function cmdWatch() {
  const tokens = readTokenFile(TOKEN_FILE);
  const wsUrl = args['tunnel-url'] ? String(args['tunnel-url']) : tokens.tunnelUrl || toWsUrl(RELAY_BASE, 'device');
  const gatewayToken = tokens.token;
  const seconds = Number(args.seconds || 60);
  const pollMs = Number(args['poll-ms'] || 2000);
  const tunnel = new Tunnel({ wsUrl, token: tokens.deviceToken, name: DEVICE_NAME });
  let connected = false;
  let okRequests = 0;
  let failedRequests = 0;

  emit('phase', 'watch', { message: `长驻监听 ${seconds}s（poll=${pollMs}ms）：${wsUrl}` });
  let attempt = 0;
  while (!connected && attempt < 10) {
    attempt += 1;
    try {
      await tunnel.connect({ autoReconnect: true });
      connected = true;
    } catch (error) {
      emit('log', 'watch', { message: `第 ${attempt} 次连接失败：${error.message}` });
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 15000)));
    }
  }
  if (!connected) {
    emit('assert', 'watch-connect', { ok: false, message: '10 次尝试仍无法建立隧道' });
    emit('summary', 'watch', { ok: false, message: '无法建立隧道' });
    return 2;
  }

  const deadline = Date.now() + seconds * 1000;
  let seq = 0;
  while (Date.now() < deadline) {
    seq += 1;
    const started = Date.now();
    try {
      const res = await tunnel.request('GET', '/api/v2/sessions?limit=5', {
        headers: gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {},
        timeoutMs: 15000,
      });
      const ok = res.status === 200;
      if (ok) okRequests += 1;
      else failedRequests += 1;
      emit('http', 'GET /api/v2/sessions', {
        ok,
        message: `HTTP ${res.status}（${Date.now() - started}ms）第 ${seq} 次`,
        data: { status: res.status, seq, bodyPreview: res.text.slice(0, 120) },
      });
    } catch (error) {
      failedRequests += 1;
      emit('http', 'GET /api/v2/sessions', { ok: false, message: `第 ${seq} 次失败：${error.message}`, data: { seq } });
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  tunnel.destroy();
  emit('summary', 'watch', {
    ok: true,
    message: `监听结束：成功请求 ${okRequests} 次，失败 ${failedRequests} 次`,
    data: { okRequests, failedRequests },
  });
  return 0;
}

// ── 子命令：http（排障）───────────────────────────────────────────────────────

async function cmdHttp() {
  const tokens = readTokenFile(TOKEN_FILE);
  const wsUrl = tokens.tunnelUrl || toWsUrl(RELAY_BASE, 'device');
  const method = String(args.method || 'GET').toUpperCase();
  const requestPath = String(args.path || '/api/v2/sessions');
  // --body-file 优先：Windows PowerShell 5.1 会剥掉参数里的双引号（见文件头注释），
  // 而 JSON 请求体必须带双引号，所以落盘再传是唯一可靠姿势。
  const bodyFile = args['body-file'] ? String(args['body-file']) : null;
  const body = bodyFile
    ? fs.readFileSync(bodyFile, 'utf8')
    : args.body
      ? String(args.body)
      : null;
  const tunnel = new Tunnel({ wsUrl, token: tokens.deviceToken, name: DEVICE_NAME });
  await tunnel.connect({ autoReconnect: false });
  const res = await tunnel.request(method, requestPath, {
    headers: tokens.token ? { Authorization: `Bearer ${tokens.token}` } : {},
    body,
    timeoutMs: TIMEOUT_SEC * 1000,
  });
  emit('http', `${method} ${requestPath}`, { ok: res.status < 400, message: `HTTP ${res.status} ${res.body.length} 字节` });
  process.stdout.write(`${res.text}\n`);
  tunnel.destroy();
  return res.status < 400 ? 0 : 2;
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

const handlers = { claim: cmdClaim, probe: cmdProbe, watch: cmdWatch, http: cmdHttp };
if (!command || !handlers[command]) {
  process.stderr.write(
    'phone-sim.mjs —— 纯 Node 手机模拟器（经中继隧道）\n' +
      '用法：node phone-sim.mjs <claim|probe|watch|http> [选项]\n' +
      '  claim --code <6位> [--device-id <uuid>] --token-file <f> [--events <f>]\n' +
      '  probe --token-file <f> [--session <id>] [--prompt <文本>] [--skip-turns] [--events <f>]\n' +
      '  watch --token-file <f> --seconds 60 [--poll-ms 2000] [--events <f>]\n' +
      '  http  --token-file <f> --method GET --path /api/v2/sessions [--events <f>]\n' +
      '        （POST/PUT 用 --body-file <json 文件>；不要用 --body 传带双引号的 JSON，PS 5.1 会剥引号）\n' +
      '通用：--relay <http://host:port> --insecure --timeout <sec>\n',
  );
  process.exit(64);
}

let exitCode = 2;
try {
  exitCode = await handlers[command]();
} catch (error) {
  emit('error', command, { ok: false, message: error && error.stack ? error.stack : String(error) });
  exitCode = 2;
}
await flushEvents();
process.exit(exitCode);
