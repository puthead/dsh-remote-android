/**
 * 测试用的 WebSocket 客户端：**独立实现**（raw net/tls + 自己编解码 RFC 6455）。
 *
 * 为什么不在测试里复用 `lib/ws.mjs` 的编解码：
 * 那会把"服务端写错、客户端照着同款错误解析"变成"测试通过"。
 * 这里的掩码规则、长度字段、分片、控制帧都是按 RFC 6455 独立写的，
 * 因此它同时是服务端的对照实现（例如：服务端帧若带了掩码，这里会记账并在断言里暴露）。
 */
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
// GUID 直接取自协议实现，避免"两边各自抄错同一个常量 → 自洽式全绿"。
// 该常量本身由 ws.test.mjs 里的 RFC 6455 §1.3 官方示例向量钉死。
import { WS_GUID } from '../lib/ws.mjs';

const OPCODE = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** 编码一个客户端帧（默认带掩码 —— 客户端必须带）。 */
export function encodeClientFrame({ fin = true, opcode = OPCODE.TEXT, payload = Buffer.alloc(0), mask = true }) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

/** 独立的帧解码器：服务端 → 客户端（服务端帧不允许带掩码，带了就记账）。 */
class ClientFrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    /** 协议违规记录（服务端帧带掩码 / RSV 非零），供断言使用 */
    this.violations = [];
  }

  /** @returns {Array<{fin:boolean, opcode:number, payload:Buffer}>} */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    for (;;) {
      const frame = this.#read();
      if (!frame) break;
      const assembled = this.#assemble(frame);
      if (assembled) frames.push(assembled);
    }
    return frames;
  }

  #read() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    if ((b0 & 0x70) !== 0) this.violations.push('RSV 位非零');
    const opcode = b0 & 0x0f;
    if ((b1 & 0x80) !== 0) this.violations.push('服务端帧带了掩码');
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      length = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    if (buf.length < offset + length) return null;
    const payload = buf.subarray(offset, offset + length);
    this.buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  #assemble(frame) {
    if (frame.opcode >= 0x8) return frame;
    if (frame.opcode === OPCODE.CONT) {
      this.fragments.push(frame.payload);
      this.fragmentBytes += frame.payload.length;
      if (!frame.fin) return null;
      const payload = Buffer.concat(this.fragments, this.fragmentBytes);
      this.fragments = [];
      this.fragmentBytes = 0;
      return { fin: true, opcode: OPCODE.TEXT, payload };
    }
    if (frame.fin) return frame;
    this.fragments = [frame.payload];
    this.fragmentBytes = frame.payload.length;
    return null;
  }
}

/**
 * 原始 WS 客户端基类。
 * 事件：`frame`（数据帧文本）、`close`（{code,reason}）、`error`。
 */
export class RawWsClient extends EventEmitter {
  constructor(socket, rest) {
    super();
    this.socket = socket;
    this.decoder = new ClientFrameDecoder();
    this.open = true;
    this.closeInfo = null;
    this.pongs = [];
    this.pings = [];
    this.closeFrames = [];
    /**
     * 所有收到的文本帧历史。
     * 为什么必须留历史：`ready` 帧常常与握手响应同批到达（甚至早于测试代码挂监听器），
     * 只靠事件会让"等待 ready"永远等不到 —— 这是本套测试早期最费时的坑。
     */
    this.frameHistory = [];
    /**
     * 握手响应之后紧跟的字节（很可能已经含着服务端的第一帧）。
     * 必须**等 start() 之后**再解析：子类字段（例如 TunnelClient.frames）在 super() 之后才初始化，
     * 在构造函数里直接回调 onWsFrame 会读到 undefined —— 这个坑最初表现为"随机崩溃 + 测试卡住"。
     */
    this._pendingChunks = rest && rest.length > 0 ? [rest] : [];
    this._started = false;
    socket.on('data', (chunk) => {
      if (!this._started) {
        this._pendingChunks.push(chunk);
        return;
      }
      this.feed(chunk);
    });
    socket.on('error', (err) => {
      // ECONNRESET 在"服务端刚关闭"的场景很常见，不应该让测试直接崩：
      // 有 error 监听器时才转发，否则只记下来（测试可断言 lastError）
      this.lastError = err;
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
    socket.on('close', () => {
      this.open = false;
      this.emit('close', this.closeInfo ?? { code: 1006, reason: 'socket closed' });
    });
  }

  /** 挂好监听器（含子类字段初始化）后调用：开始解析已到达的字节。 @returns {this} */
  start() {
    if (this._started) return this;
    this._started = true;
    const pending = this._pendingChunks;
    this._pendingChunks = [];
    for (const chunk of pending) this.feed(chunk);
    return this;
  }

  /** 喂入原始字节（构造/迁移时使用）。 */
  feed(chunk) {
    for (const frame of this.decoder.push(chunk)) this.onWsFrame(frame);
  }

  /** 子类可覆写。 */
  onWsFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.TEXT:
        this.frameHistory.push(frame.payload.toString('utf8'));
        this.emit('frame', frame.payload.toString('utf8'));
        break;
      case OPCODE.PING:
        this.pings.push(frame.payload);
        this.socket.write(encodeClientFrame({ opcode: OPCODE.PONG, payload: frame.payload }));
        break;
      case OPCODE.PONG:
        this.pongs.push(frame.payload);
        break;
      case OPCODE.CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
        this.closeInfo = this.closeInfo ?? { code, reason };
        this.closeFrames.push({ code, reason });
        // 回一个 close 完成握手；对端可能已经断开或已经回过 close（重复 close 帧要容忍）
        try {
          if (!this.socket.writableEnded && this.socket.writable) this.socket.end(encodeClientFrame({ opcode: OPCODE.CLOSE, payload: frame.payload }));
        } catch {
          /* 对端已断开 */
        }
        break;
      }
      default:
        break;
    }
  }

  sendText(text, { fin = true } = {}) {
    this.socket.write(encodeClientFrame({ fin, opcode: OPCODE.TEXT, payload: Buffer.from(text, 'utf8') }));
  }

  /** 发送 continuation 分片（手工构造分片消息用）。 */
  sendContinuation(text, { fin = true } = {}) {
    this.socket.write(encodeClientFrame({ fin, opcode: OPCODE.CONT, payload: Buffer.from(text, 'utf8') }));
  }

  /** 发送任意原始字节（构造畸形帧用）。 */
  sendRaw(buffer) {
    this.socket.write(buffer);
  }

  sendPing(payload = Buffer.from('p')) {
    this.socket.write(encodeClientFrame({ opcode: OPCODE.PING, payload }));
  }

  sendClose(code = 1000, reason = '') {
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.socket.write(encodeClientFrame({ opcode: OPCODE.CLOSE, payload }));
  }

  /** @returns {Promise<{code:number, reason:string}>} */
  waitClose(timeoutMs = 3000) {
    if (!this.open) return Promise.resolve(this.closeInfo ?? { code: 1006, reason: 'closed' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待连接关闭超时')), timeoutMs);
      this.once('close', (info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  /** 等一个满足条件的 WS 控制帧（ping/pong/close）。 */
  waitControl(kind, { timeoutMs = 3000 } = {}) {
    const has = () => (kind === 'ping' ? this.pings.length : kind === 'pong' ? this.pongs.length : this.closeFrames.length) > 0;
    if (has()) return Promise.resolve(kind === 'ping' ? this.pings.at(-1) : kind === 'pong' ? this.pongs.at(-1) : this.closeFrames.at(-1));
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (!has()) return;
        clearInterval(interval);
        clearTimeout(timer);
        resolve(kind === 'ping' ? this.pings.at(-1) : kind === 'pong' ? this.pongs.at(-1) : this.closeFrames.at(-1));
      }, 5);
      const timer = setTimeout(() => {
        clearInterval(interval);
        reject(new Error(`等待 WS ${kind} 帧超时`));
      }, timeoutMs);
    });
  }

  pause() {
    this.socket.pause();
  }

  resume() {
    this.socket.resume();
  }

  destroy() {
    this.socket.destroy();
  }
}

/**
 * 建立 WS 连接（握手 + 校验 `Sec-WebSocket-Accept`）。
 * @returns {Promise<{socket: import('node:net').Socket, rest: Buffer, headers: Record<string,string>, status: number}>}
 */
export async function wsHandshake(url, { headers = {}, timeoutMs = 5000, rejectUnauthorized = true, key = null } = {}) {
  const parsed = new URL(url);
  const isTls = parsed.protocol === 'wss:';
  const port = Number(parsed.port || (isTls ? 443 : 80));
  const keyValue = key ?? crypto.randomBytes(16).toString('base64');
  const request = [
    `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
    `Host: ${parsed.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${keyValue}`,
    'Sec-WebSocket-Version: 13',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '',
    '',
  ].join('\r\n');

  const socket = isTls
    ? tls.connect({ host: parsed.hostname, port, rejectUnauthorized, servername: parsed.hostname })
    : net.connect({ host: parsed.hostname, port });
  socket.setNoDelay(true);

  const expectedAccept = crypto.createHash('sha1').update(`${keyValue}${WS_GUID}`).digest('base64');
  const response = await new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`WS 握手超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const onData = (chunk) => {
      text += chunk.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end === -1) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      resolve({ head: text.slice(0, end), rest: Buffer.from(text.slice(end + 4), 'latin1') });
    };
    socket.on('data', onData);
    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 带出已收到的字节：升级前被拒时（例如 TLS 下 flush 竞态）能立刻看出是"没收到响应"还是"收到别的"
      reject(new Error(`连接在握手完成前被关闭（已收到 ${text.length} 字节：${JSON.stringify(text.slice(0, 120))}）`));
    });
    socket.on(isTls ? 'secureConnect' : 'connect', () => socket.write(request));
  });

  const statusLine = response.head.split('\r\n')[0];
  const status = Number(statusLine.split(' ')[1]);
  const headerMap = {};
  for (const line of response.head.split('\r\n').slice(1)) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    headerMap[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  if (status !== 101) {
    socket.destroy();
    const err = new Error(`WS 握手失败：${statusLine} body=${response.rest.toString('utf8')}`);
    err.status = status;
    err.headers = headerMap;
    err.body = response.rest.toString('utf8');
    throw err;
  }
  if (headerMap['sec-websocket-accept'] !== expectedAccept) {
    socket.destroy();
    throw new Error(`Sec-WebSocket-Accept 不正确：${headerMap['sec-websocket-accept']}（期望 ${expectedAccept}）`);
  }
  return { socket, rest: response.rest, headers: headerMap, status, cert: isTls ? socket.getPeerCertificate() : null };
}

/** 建立原始 WS 客户端。 */
export async function rawConnect(url, opts = {}) {
  const { socket, rest } = await wsHandshake(url, opts);
  return new RawWsClient(socket, rest).start();
}

/** 隧道 JSON 客户端：把 NDJSON 帧的收发、等待与断言封装起来。 */
export class TunnelClient extends RawWsClient {
  constructor(socket, rest, { role }) {
    super(socket, rest);
    this.role = role;
    /** @type {object[]} 已收到且未被消费的 JSON 帧 */
    this.frames = [];
    this.allFrames = [];
    this.frameWaiters = [];
  }

  onWsFrame(frame) {
    // 先走基类：维护 frameHistory、处理控制帧、发出 'frame' 事件。
    // （曾经这里直接 return，导致只监听 'frame' 的测试永远收不到数据 —— "服务端不回帧"的假象）
    super.onWsFrame(frame);
    if (frame.opcode !== OPCODE.TEXT) return;
    const text = frame.payload.toString('utf8');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { t: '<invalid-json>', raw: text };
    }
    this.frames.push(json);
    this.allFrames.push(json);
    for (const waiter of [...this.frameWaiters]) {
      if (!waiter.predicate(json)) continue;
      this.frameWaiters.splice(this.frameWaiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(json);
    }
  }

  /** 等一个满足条件的帧（超时错误里带最近的帧，便于排障）。 */
  waitFrame(predicate, { timeoutMs = 3000, what = '匹配帧' } = {}) {
    const found = this.frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this.frameWaiters.splice(this.frameWaiters.indexOf(waiter), 1);
        reject(new Error(`等待${what}超时（${timeoutMs}ms）；已收到：${JSON.stringify(this.allFrames.slice(-6))}`));
      }, timeoutMs);
      this.frameWaiters.push(waiter);
    });
  }

  waitType(t, opts = {}) {
    return this.waitFrame((frame) => frame.t === t, { what: `t=${t} 帧`, ...opts });
  }

  /** 从待消费队列里移除一帧。 */
  consume(frame) {
    const index = this.frames.indexOf(frame);
    if (index !== -1) this.frames.splice(index, 1);
  }

  send(frame) {
    this.sendText(JSON.stringify(frame));
  }

  /** hello → ready。 */
  async handshake({ proto = 2, name } = {}) {
    this.send({ t: 'hello', proto, role: this.role, ...(name ? { name } : {}) });
    return await this.waitType('ready');
  }

  /** device 侧：发 req。 */
  request({ id, method = 'GET', path, headers = {}, body = null, bodyB64 = undefined }) {
    const frame = { t: 'req', id, method, path, headers };
    if (bodyB64 !== undefined) frame.bodyB64 = bodyB64;
    else if (body !== null && body !== undefined) frame.bodyB64 = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8').toString('base64');
    this.send(frame);
    return frame;
  }

  /** home 侧：标准响应（res + chunk + end）。 */
  respond(id, status = 200, body = '', headers = { 'content-type': 'application/json; charset=utf-8' }) {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    this.send({ t: 'res', id, status, headers: { ...headers, 'content-length': String(buf.length) } });
    if (buf.length > 0) this.send({ t: 'chunk', id, dataB64: buf.toString('base64') });
    this.send({ t: 'end', id });
  }

  /** device 侧：收集一条流直到 end/abort。 */
  async collect(id, { timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let status = null;
    let headers = null;
    const chunks = [];
    let aborted = null;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) throw new Error(`收集流 ${id} 超时；已收到：${JSON.stringify(this.allFrames.slice(-8))}`);
      const frame = await this.waitFrame((f) => f.id === id && ['res', 'chunk', 'end', 'abort'].includes(f.t), { timeoutMs: remain, what: `流 ${id} 的 res/chunk/end` });
      this.consume(frame);
      if (frame.t === 'res') {
        status = frame.status;
        headers = frame.headers;
      } else if (frame.t === 'chunk') {
        chunks.push(Buffer.from(frame.dataB64, 'base64'));
      } else if (frame.t === 'end') {
        break;
      } else if (frame.t === 'abort') {
        aborted = frame.reason;
        break;
      }
    }
    const body = Buffer.concat(chunks);
    return { status, headers, body, text: body.toString('utf8'), aborted };
  }

  /** 便捷断言：一次请求 → 一个完整响应。 */
  async roundTrip({ id, method = 'GET', path, headers = {}, body = null, timeoutMs = 5000 }) {
    this.request({ id, method, path, headers, body });
    return await this.collect(id, { timeoutMs });
  }
}

/** 建立隧道客户端（自动带上 Bearer 头）。 */
export async function openTunnel(url, { token, role, headers = {}, timeoutMs = 5000, rejectUnauthorized = true } = {}) {
  const { socket, rest } = await wsHandshake(url, {
    headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    timeoutMs,
    rejectUnauthorized,
  });
  return new TunnelClient(socket, rest, { role }).start();
}
