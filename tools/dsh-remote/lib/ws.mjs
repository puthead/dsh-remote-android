/**
 * WebSocket 客户端（RFC 6455，零第三方依赖，契约 §5.1）。
 *
 * 为什么自己写：契约 §5.1 明确要求网关只用 Node 内置模块，`ws` 之类不能用。
 * 实现范围「够用即可」但必须正确：
 * - 握手：`Sec-WebSocket-Key` + 校验 `Sec-WebSocket-Accept`（sha1(key + GUID)）；
 * - 客户端→服务端**必须**加掩码（RFC 6455 §5.3），服务端→客户端**必须**不加；
 * - 支持**分片**（continuation 帧重组）、ping/pong/close 控制帧；
 * - 控制帧不得分片、负载 ≤ 125 字节（违反即协议错误）；
 * - 单帧负载上限（默认 8 MiB）防内存打爆 —— 中继的 chunk 上限是 256 KiB，还有余量。
 *
 * 事件：`open` / `message`（文本字符串）/ `binary` / `ping` / `pong` / `close` / `error`。
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';

/** RFC 6455 握手用的固定 GUID。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = Object.freeze({ continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa });

/** 关闭码。 */
export const CLOSE_CODE = Object.freeze({ normal: 1000, goingAway: 1001, protocolError: 1002, unsupportedData: 1003, abnormal: 1006, policyViolation: 1008, tooLarge: 1009 });

/**
 * 计算握手应答值（导出以便单测直接锁定 RFC 的示例向量）。
 * @param {string} key
 * @returns {string}
 */
export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * 编码一帧。
 * @param {{fin?: boolean, opcode: number, payload?: Buffer, mask?: boolean}} opts
 * @returns {Buffer}
 */
export function encodeFrame({ fin = true, opcode, payload = Buffer.alloc(0), mask = true }) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  const first = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  let headerLength = 2;
  if (len >= 65536) headerLength += 8;
  else if (len > 125) headerLength += 2;
  if (mask) headerLength += 4;
  const buf = Buffer.allocUnsafe(headerLength + len);
  buf[0] = first;
  let offset = 2;
  if (len >= 65536) {
    buf[1] = 127;
    buf.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  } else if (len > 125) {
    buf[1] = 126;
    buf.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    buf[1] = len;
  }
  if (mask) {
    buf[1] |= 0x80;
    const key = crypto.randomBytes(4);
    key.copy(buf, offset);
    offset += 4;
    for (let i = 0; i < len; i++) buf[offset + i] = data[i] ^ key[i & 3];
  } else {
    data.copy(buf, offset);
  }
  return buf;
}

/**
 * 增量帧解码器：处理跨 TCP 包的半帧与分片重组。
 */
export class FrameDecoder {
  /**
   * @param {{maxPayloadBytes?: number, requireMask?: boolean, onProtocolError?: (message: string) => void}} [opts]
   */
  constructor({ maxPayloadBytes = 8 * 1024 * 1024, requireMask = false, onProtocolError = null } = {}) {
    this.maxPayloadBytes = maxPayloadBytes;
    this.requireMask = requireMask;
    this.onProtocolError = onProtocolError;
    this.buffer = Buffer.alloc(0);
    /** 分片重组状态。 */
    this.fragments = [];
    this.fragmentOpcode = null;
    this.fragmentBytes = 0;
  }

  /**
   * 喂入数据，返回解出的完整消息/控制帧。
   * @param {Buffer} chunk
   * @returns {Array<{fin: boolean, opcode: number, payload: Buffer}>}
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out = [];
    for (;;) {
      const frame = this.#readFrame();
      if (!frame) break;
      const done = this.#handle(frame, out);
      if (done === false) break;
    }
    return out;
  }

  /** 从缓冲区头部尝试解出一帧；数据不足返回 null。 */
  #readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const rsv = buf[0] & 0x70;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (rsv !== 0) {
      this.onProtocolError?.('RSV 位非零（未协商扩展）');
      return null;
    }
    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.onProtocolError?.('帧长度超出安全整数');
        return null;
      }
      length = Number(big);
      offset = 10;
    }
    if (length > this.maxPayloadBytes) {
      this.onProtocolError?.(`帧负载 ${length} 超过上限 ${this.maxPayloadBytes}`);
      return null;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    } else if (this.requireMask) {
      this.onProtocolError?.('客户端收到的帧不应缺掩码');
      return null;
    }
    if (buf.length < offset + length) return null;
    let payload = buf.subarray(offset, offset + length);
    if (masked) {
      const copy = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) copy[i] = payload[i] ^ maskKey[i & 3];
      payload = copy;
    }
    this.buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  /** 处理一帧：控制帧直接产出，数据帧做分片重组。返回 false 表示终止解码循环。 */
  #handle(frame, out) {
    const { fin, opcode, payload } = frame;
    if (opcode >= 0x8) {
      // 控制帧：不得分片、负载 ≤125
      if (!fin) {
        this.onProtocolError?.('控制帧不得分片');
        return false;
      }
      if (payload.length > 125) {
        this.onProtocolError?.('控制帧负载超过 125 字节');
        return false;
      }
      out.push({ fin: true, opcode, payload });
      return true;
    }
    if (opcode === OPCODE.continuation) {
      if (this.fragmentOpcode === null) {
        this.onProtocolError?.('收到无起始帧的 continuation 帧');
        return false;
      }
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxPayloadBytes) {
        this.onProtocolError?.('分片重组后超过负载上限');
        return false;
      }
      if (fin) {
        const merged = Buffer.concat(this.fragments);
        const op = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = null;
        this.fragmentBytes = 0;
        out.push({ fin: true, opcode: op, payload: merged });
      }
      return true;
    }
    if (opcode !== OPCODE.text && opcode !== OPCODE.binary) {
      this.onProtocolError?.(`未知 opcode ${opcode}`);
      return false;
    }
    if (fin) {
      out.push({ fin: true, opcode, payload });
      return true;
    }
    this.fragments = [payload];
    this.fragmentOpcode = opcode;
    this.fragmentBytes = payload.length;
    return true;
  }
}

/**
 * WebSocket 客户端。
 */
export class WebSocketClient extends EventEmitter {
  /**
   * @param {{url: string, headers?: Record<string,string>, handshakeTimeoutMs?: number, maxPayloadBytes?: number, tls?: {rejectUnauthorized?: boolean, ca?: string|Buffer, servername?: string}, onProtocolError?: (m: string) => void, agent?: object}} opts
   */
  constructor({ url, headers = {}, handshakeTimeoutMs = 15_000, maxPayloadBytes = 8 * 1024 * 1024, tls = {}, onProtocolError = null, agent = null }) {
    super();
    this.url = url;
    this.extraHeaders = headers;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.maxPayloadBytes = maxPayloadBytes;
    this.tls = tls;
    this.agent = agent;
    this.socket = null;
    this.req = null;
    this.readyState = 'closed'; // closed | connecting | open | closing
    this.decoder = new FrameDecoder({
      maxPayloadBytes,
      requireMask: false,
      onProtocolError: (m) => {
        onProtocolError?.(m);
        this.emit('protocolError', new Error(m));
        this.close(CLOSE_CODE.protocolError, 'protocol error');
      },
    });
    this.closeInfo = null;
    /** `close` 事件只允许发一次（对端 close 帧 + socket 关闭会同一次断开触发两次）。 */
    this.closeEmitted = false;
  }

  /** 是否已连接。 */
  get isOpen() {
    return this.readyState === 'open';
  }

  /** 待发送字节数（背压观察用）。 */
  get bufferedAmount() {
    return this.socket?.writableLength ?? 0;
  }

  /**
   * 建立连接。
   * @returns {Promise<{headers: object, statusCode: number}>}
   */
  connect() {
    if (this.readyState !== 'closed') return Promise.reject(new Error('连接已建立或正在建立'));
    let parsed;
    try {
      parsed = new URL(this.url);
    } catch {
      return Promise.reject(new Error(`非法的 WebSocket URL：${this.url}`));
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return Promise.reject(new Error(`WebSocket URL 必须是 ws:// 或 wss://（收到 ${parsed.protocol}//）`));
    }
    const secure = parsed.protocol === 'wss:';
    this.readyState = 'connecting';
    const key = crypto.randomBytes(16).toString('base64');
    const pathWithQuery = `${parsed.pathname || '/'}${parsed.search || ''}`;
    const options = {
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (secure ? 443 : 80),
      path: pathWithQuery,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...this.extraHeaders,
      },
      ...(secure
        ? {
            rejectUnauthorized: this.tls.rejectUnauthorized !== false,
            ...(this.tls.ca ? { ca: this.tls.ca } : {}),
            ...(this.tls.servername ? { servername: this.tls.servername } : {}),
          }
        : {}),
      ...(this.agent ? { agent: this.agent } : {}),
    };

    return new Promise((resolve, reject) => {
      const transport = secure ? https : http;
      const req = transport.request(options);
      this.req = req;
      const timer = setTimeout(() => {
        req.destroy(new Error(`WebSocket 握手超时（${this.handshakeTimeoutMs}ms）`));
      }, this.handshakeTimeoutMs);

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.readyState = 'closed';
        reject(err);
      };

      req.on('upgrade', (res, socket, head) => {
        if (settled) return;
        const accept = res.headers['sec-websocket-accept'];
        if (accept !== acceptKey(key)) {
          socket.destroy();
          fail(new Error('WebSocket 握手校验失败：Sec-WebSocket-Accept 不匹配'));
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.socket = socket;
        this.readyState = 'open';
        socket.setNoDelay?.(true);
        socket.on('data', (chunk) => this.#onData(chunk));
        socket.on('error', (err) => this.emit('error', err));
        socket.on('close', () => this.#onSocketClose());
        // **关键**：`head` 是与 101 响应**同批到达**的已读字节（HTTP 解析器读过头之后剩下的）。
        // Node 只把它交到这里，不会再从 socket 上发一次；丢掉它就等于丢掉对端"紧跟着握手发的第一帧"。
        // 实测后果：中继在升级成功那一刻就发 `ready`（旧实现），这一帧被静默丢弃 →
        // 网关等 ready 10s 超时、中继等 hello 30s 超时，双方循环重连（P0 死锁里最隐蔽的一环）。
        // 现在无论对端是否抢跑，首帧都不会丢。
        if (head && head.length > 0) this.#onData(head);
        this.emit('open', res.headers);
        resolve({ headers: res.headers, statusCode: res.statusCode, headBytes: head?.length ?? 0 });
      });

      req.on('response', (res) => {
        // 没升级成功：把响应体读完（可能是 401 的 JSON 错误），便于上层给出可读原因
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 500);
          fail(new WebSocketHandshakeError(res.statusCode ?? 0, body, res.headers));
        });
      });

      req.on('error', (err) => fail(err));
      req.end();
    });
  }

  /** 处理 socket 数据。 */
  #onData(chunk) {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.emit('error', err);
      this.close(CLOSE_CODE.protocolError, 'decode error');
      return;
    }
    for (const frame of frames) {
      switch (frame.opcode) {
        case OPCODE.text:
          this.emit('message', frame.payload.toString('utf8'), false);
          break;
        case OPCODE.binary:
          this.emit('binary', frame.payload);
          break;
        case OPCODE.ping:
          this.#write(encodeFrame({ opcode: OPCODE.pong, payload: frame.payload }));
          this.emit('ping', frame.payload);
          break;
        case OPCODE.pong:
          this.emit('pong', frame.payload);
          break;
        case OPCODE.close: {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : CLOSE_CODE.normal;
          const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
          this.closeInfo = { code, reason, remote: true };
          this.readyState = 'closing';
          this.#write(encodeFrame({ opcode: OPCODE.close, payload: frame.payload.subarray(0, 2) }));
          this.socket?.end();
          // 只在这里发一次：随后 socket 的 'close' 会走 #onSocketClose()，
          // 它靠 `closeEmitted` 守卫避免对同一次断开重复 emit（重复 emit 会让上层多排一次重连）。
          this.#emitClose(code, reason);
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * 发送一帧文本。
   * @param {string} text
   * @returns {boolean} 是否已写入（false = 未连接）
   */
  send(text) {
    return this.#write(encodeFrame({ opcode: OPCODE.text, payload: Buffer.from(String(text), 'utf8') }));
  }

  /** 发送 ping。 */
  ping(payload = Buffer.alloc(0)) {
    return this.#write(encodeFrame({ opcode: OPCODE.ping, payload: Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)) }));
  }

  /** 发送 pong。 */
  pong(payload = Buffer.alloc(0)) {
    return this.#write(encodeFrame({ opcode: OPCODE.pong, payload: Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)) }));
  }

  /** 底层写入。 */
  #write(buf) {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(buf);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 正常关闭。
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = CLOSE_CODE.normal, reason = '') {
    if (this.readyState === 'closed') return;
    if (this.readyState === 'connecting') {
      this.req?.destroy();
      this.readyState = 'closed';
      return;
    }
    if (this.readyState === 'open') {
      this.readyState = 'closing';
      const reasonBuf = Buffer.from(String(reason), 'utf8').subarray(0, 123);
      const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      this.#write(encodeFrame({ opcode: OPCODE.close, payload }));
    }
    this.socket?.end();
    // 兜底：对端不回应 close 时 3s 后强断
    const timer = setTimeout(() => this.terminate(), 3000);
    timer.unref?.();
  }

  /** 强制断开（不握手 close）。 */
  terminate() {
    try {
      this.socket?.destroy();
    } catch {
      /* 已断开 */
    }
    this.readyState = 'closed';
  }

  /** socket 关闭：保证 `close` 事件对同一次断开只发一次。 */
  #onSocketClose() {
    const wasOpen = this.readyState !== 'closed';
    this.readyState = 'closed';
    if (wasOpen) {
      const info = this.closeInfo ?? { code: CLOSE_CODE.abnormal, reason: '', remote: true };
      this.#emitClose(info.code, info.reason);
    }
  }

  /**
   * 唯一的 `close` 出口。
   *
   * 为什么需要守卫：收到对端 close 帧时会 emit 一次，随后 socket 真正关闭又会走
   * `#onSocketClose()` —— 那时 `readyState` 还是 `'closing'`，会被判成"曾打开"从而**再 emit 一次**。
   * 同一次断开触发两次 `close`，会让上层（relay-client）多排一次重连，
   * 退避次数被凭空 +1，极端时序下还会叠加多个重连定时器。
   */
  #emitClose(code, reason) {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.emit('close', code, reason);
  }
}

/** 握手被 HTTP 状态码拒绝（例如 401），携带响应体便于上层给出可读原因。 */
export class WebSocketHandshakeError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} body
   * @param {object} headers
   */
  constructor(statusCode, body, headers = {}) {
    super(`WebSocket 握手被拒绝：HTTP ${statusCode}${body ? `（${body}）` : ''}`);
    this.name = 'WebSocketHandshakeError';
    this.statusCode = statusCode;
    this.body = body;
    this.headers = headers;
  }
}
