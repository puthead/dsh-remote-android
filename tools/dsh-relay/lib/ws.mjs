/**
 * 自实现的 RFC 6455 WebSocket 服务端（零第三方依赖，契约 §5.1）。
 *
 * 为什么只做「够用」的子集：
 * 中继的两个隧道端点只需要——握手 + **文本帧** + ping/pong/close + 分片重组 + 掩码校验。
 * 不做扩展协商（permessage-deflate 一律拒绝：RSV≠0 即协议错误），不做二进制消息
 * （契约 §帧格式：每帧一个 JSON 对象的文本帧；收到 binary 直接以 1003 关闭）。
 *
 * 两个易踩的坑（都在这里显式处理，避免在隧道层再兜：
 * 1. **掩码**：客户端→服务端必须带掩码，否则 1002；服务端→客户端必须不带掩码；
 * 2. **控制帧可以插在分片消息中间**（RFC 允许），因此分片状态机必须能与 ping/pong/close 交错。
 *
 * 背压：所有写都经过 `write()`，内部统计「尚未 flush 的字节数」（write 回调触发时扣减），
 * 隧道层据此决定是否暂停读对端（契约 §3.2）。
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * RFC 6455 规定的握手 GUID。
 * ⚠️ 这个常量**必须逐字节等于 RFC 6455 §1.3**：
 * `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`。
 * 早期版本这里写成了 `...95CA-5AB0DC85B11F`（C 从开头滑到了结尾），
 * 而测试客户端当时复用了同一个常量，于是"两侧自洽、全绿，但任何标准客户端都连不上"。
 * 现在由 RFC 官方示例向量（test/ws.test.mjs 的 computeAccept 用例）钉死。
 */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 操作码。 */
export const OPCODE = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });

/** 关闭码（只列用到的）。 */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
});

/**
 * 计算 `Sec-WebSocket-Accept`。
 * @param {string} key 客户端 `Sec-WebSocket-Key`
 * @returns {string}
 */
export function computeAccept(key) {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

/**
 * 判断是否是一次合法的 WebSocket 升级请求（只看必要头，方法由 http 层保证）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ok: true} | {ok: false, status: number, message: string, headers?: Record<string,string>}}
 */
export function checkUpgradeRequest(req) {
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket') return { ok: false, status: 400, message: '缺少 Upgrade: websocket' };
  const connection = String(req.headers.connection ?? '').toLowerCase();
  if (!connection.split(',').map((s) => s.trim()).includes('upgrade')) {
    return { ok: false, status: 400, message: '缺少 Connection: Upgrade' };
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !key.trim()) return { ok: false, status: 400, message: '缺少 Sec-WebSocket-Key' };
  const version = String(req.headers['sec-websocket-version'] ?? '');
  if (version !== '13') {
    return { ok: false, status: 426, message: `不支持的 WebSocket 版本：${version || '(空)'}`, headers: { 'Sec-WebSocket-Version': '13' } };
  }
  return { ok: true };
}

/**
 * 在原始 socket 上回一个 HTTP 错误（升级前的拒绝路径）。
 * 为什么不在 WS 层用 `error` 帧拒绝鉴权：握手在 HTTP 层失败时客户端还没进入 WS 状态机，
 * 回 `401 + WWW-Authenticate` 才是标准做法，也让运维能用 curl 直接复现。
 * @param {import('node:net').Socket} socket
 * @param {number} status
 * @param {string} message
 * @param {Record<string,string>} [extraHeaders]
 */
export function rejectUpgrade(socket, status, message, extraHeaders = {}) {
  const body = JSON.stringify({ error: { code: statusToCode(status), message } });
  const headers = [
    `HTTP/1.1 ${status} ${httpReason(status)}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
    '',
    '',
  ].join('\r\n');
  try {
    // 用 end() 而不是 write()+destroy()：destroy 会立刻丢弃尚未 flush 的写缓冲。
    // 明文下通常侥幸能收到 401；**TLS 下会变成客户端侧 ECONNRESET**（尾随的 TLS 记录被丢掉），
    // 表现为"鉴权失败时报错不可读、且偶发"。end() 会先 flush 再 FIN（TLS 下走 close_notify）。
    socket.end(headers + body);
  } catch {
    socket.destroy();
    return;
  }
  // 对端不读就兜底强断，避免半开连接挂住（1s 足够一次本地 flush）
  const timer = setTimeout(() => {
    try {
      socket.destroy();
    } catch {
      /* 已关闭 */
    }
  }, 1000);
  timer.unref?.();
}

function statusToCode(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'bad_request';
}

function httpReason(status) {
  return { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required', 429: 'Too Many Requests' }[status] ?? 'Error';
}

/**
 * 帧解码器：把字节流切成帧。可增量喂入（TCP 不保证帧边界）。
 * 只在服务端使用：因此**要求客户端帧带掩码**，服务端帧（我们发的）不带。
 */
export class FrameDecoder {
  /** @param {{maxMessageBytes?: number}} [opts] */
  constructor({ maxMessageBytes = 8_388_608 } = {}) {
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
    /** 分片消息重组状态。 */
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmented = false;
    /** 协议错误：一旦置位，后续 push 直接返回该错误（连接即将关闭）。 */
    this.failure = null;
  }

  /**
   * 喂入字节，返回本次可解析出的完整帧。
   * @param {Buffer} chunk
   * @returns {{frames: Array<{fin: boolean, opcode: number, payload: Buffer}>, error: {code: number, reason: string}|null}}
   */
  push(chunk) {
    if (this.failure) return { frames: [], error: this.failure };
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    for (;;) {
      const frame = this.#readFrame();
      if (frame === null) break;
      if (frame.error) {
        this.failure = frame.error;
        return { frames, error: frame.error };
      }
      const assembled = this.#assemble(frame.frame);
      if (assembled?.error) {
        this.failure = assembled.error;
        return { frames, error: assembled.error };
      }
      if (assembled?.message) frames.push(assembled.message);
    }
    return { frames, error: null };
  }

  /** 读一个帧；数据不足返回 null。 */
  #readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) return { error: { code: CLOSE.PROTOCOL_ERROR, reason: 'RSV 位非零（未协商任何扩展）' } };
    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { error: { code: CLOSE.MESSAGE_TOO_BIG, reason: '帧长度超出可表示范围' } };
      length = Number(big);
      offset += 8;
    }
    if (!masked) return { error: { code: CLOSE.PROTOCOL_ERROR, reason: '客户端帧必须带掩码' } };
    if (length > this.maxMessageBytes) return { error: { code: CLOSE.MESSAGE_TOO_BIG, reason: `帧长度 ${length} 超过上限 ${this.maxMessageBytes}` } };
    if (buf.length < offset + 4 + length) return null;

    const isControl = opcode >= 0x8;
    if (isControl) {
      if (!fin) return { error: { code: CLOSE.PROTOCOL_ERROR, reason: '控制帧不允许分片' } };
      if (length > 125) return { error: { code: CLOSE.PROTOCOL_ERROR, reason: '控制帧载荷不得超过 125 字节' } };
    }
    if (opcode !== OPCODE.CONT && opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY && !isControl) {
      return { error: { code: CLOSE.PROTOCOL_ERROR, reason: `未知操作码 0x${opcode.toString(16)}` } };
    }

    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    this.buffer = buf.subarray(offset + length);
    return { frame: { fin, opcode, payload } };
  }

  /**
   * 分片重组 / 控制帧直通。
   * @returns {{message: {fin:boolean, opcode:number, payload:Buffer}}|{error:{code:number,reason:string}}|null}
   */
  #assemble(frame) {
    if (frame.opcode >= 0x8) return { message: frame }; // 控制帧不受分片状态影响
    if (frame.opcode === OPCODE.BINARY) return { error: { code: CLOSE.UNSUPPORTED_DATA, reason: '只支持文本帧' } };
    if (frame.opcode === OPCODE.CONT) {
      if (!this.fragmented) return { error: { code: CLOSE.PROTOCOL_ERROR, reason: '未开始分片就收到 continuation' } };
      this.fragmentBytes += frame.payload.length;
      if (this.fragmentBytes > this.maxMessageBytes) return { error: { code: CLOSE.MESSAGE_TOO_BIG, reason: '分片消息超过上限' } };
      this.fragments.push(frame.payload);
      if (!frame.fin) return null;
      const payload = Buffer.concat(this.fragments, this.fragmentBytes);
      this.fragments = [];
      this.fragmentBytes = 0;
      this.fragmented = false;
      return { message: { fin: true, opcode: OPCODE.TEXT, payload } };
    }
    // TEXT
    if (this.fragmented) return { error: { code: CLOSE.PROTOCOL_ERROR, reason: '分片未结束又收到新的文本帧' } };
    if (frame.fin) return { message: frame };
    this.fragmented = true;
    this.fragments = [frame.payload];
    this.fragmentBytes = frame.payload.length;
    return null;
  }
}

/**
 * 一个已建立的 WebSocket 连接（服务端视角）。
 * 事件：`message`(text) / `ping`(Buffer) / `pong`(Buffer) / `close`({code, reason}) / `error`(Error)。
 */
export class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{head?: Buffer, maxMessageBytes?: number, remoteAddress?: string}} opts
   */
  constructor(socket, { head = Buffer.alloc(0), maxMessageBytes = 8_388_608, remoteAddress = null } = {}) {
    super();
    this.socket = socket;
    this.remoteAddress = remoteAddress ?? socket.remoteAddress ?? null;
    this.decoder = new FrameDecoder({ maxMessageBytes });
    this.open = true;
    this.closedByUs = false;
    /** 尚未 flush 到内核的字节数（写回调触发时扣减），用于背压判定。 */
    this.pendingBytes = 0;
    this._closeTimer = null;
    this._closeEmitted = false;
    this._closeSent = false;
    /** 已发出的控制帧序号（WS 协议层 ping 载荷）。 */
    this._pingSeq = 0;
    /** 是否已 start()（`data` 监听器只在 start 后挂上，保证不丢首帧）。 */
    this._started = false;
    socket.setNoDelay?.(true);
    socket.setTimeout?.(0);
    socket.on('error', (err) => {
      this.emit('error', err);
      this.#finalize(1006, 'socket error');
    });
    socket.on('close', () => this.#finalize(1006, 'socket closed'));
    socket.on('end', () => this.#finalize(1006, 'socket ended'));
    if (head && head.length > 0) this.decoder.buffer = head;
  }

  /**
   * 挂好监听器后调用：开始处理握手时可能已经到达的字节。
   * @returns {this}
   */
  start() {
    if (this._started) return this;
    this._started = true;
    this.socket.on('data', (chunk) => this.#onData(chunk));
    const head = this.decoder.buffer;
    if (head && head.length > 0) {
      this.decoder.buffer = Buffer.alloc(0);
      this.#onData(head);
    }
    return this;
  }

  /** @returns {number} 待 flush 字节数（隧道层背压用） */
  get bufferedAmount() {
    return this.pendingBytes;
  }

  get writable() {
    return this.open && this.socket.writable;
  }

  #onData(chunk) {
    // `activity`：**任何**入站字节都算"对端活着"的权威信号（RFC 层 ping/pong 与普通数据都包含在内）。
    // 为什么必须由 WS 层报这件事：隧道层原先只按 JSON 文本帧更新 lastSeenAt，而真实网关会周期性发
    // **协议级 ping**（`tools/dsh-remote/lib/relay-client.mjs` 每 30s `ws.ping()`），
    // 只认 JSON 帧就会把健康连接判成死链（P0：每 30s 误杀一次，且因"中继的 JSON ping 还没发出去就被踢"而不可自愈）。
    if (this.listenerCount('activity') > 0) this.emit('activity', chunk.length);
    if (this.listenerCount('raw-data') > 0) this.emit('raw-data', chunk.length);
    const { frames, error } = this.decoder.push(chunk);
    for (const frame of frames) {
      // 关键：`open === false` 只代表"业务上已 finalize"，**不能**因此停止解析 CLOSE 帧。
      // 曾经的写法在这里直接 return，导致：服务端发出 close 后收到对端的 close 应答时不再解析，
      // close 握手永远完不成，只能等 3s 强制断开（表现为"关闭慢 3 秒"）。
      if (frame.opcode === OPCODE.CLOSE) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
        if (this.open) {
          // RFC 6455：只有还没发过 close 才需要回一个（否则会形成 close 帧来回发送）
          if (!this._closeSent) this.#sendClose(code === 1005 ? CLOSE.NORMAL : code, '');
          this.#finalize(code, reason);
        }
        // close 握手完成即关 TCP：只回 close 帧而不关连接会让对端一直等到超时（半开连接）
        this.#finishSocket();
        continue;
      }
      if (!this.open) continue;
      switch (frame.opcode) {
        case OPCODE.TEXT:
          this.emit('message', frame.payload.toString('utf8'));
          break;
        case OPCODE.PING:
          this.sendPong(frame.payload);
          this.emit('ping', frame.payload);
          break;
        case OPCODE.PONG:
          this.emit('pong', frame.payload);
          break;
        default:
          break;
      }
    }
    if (error) {
      if (this.open) {
        this.close(error.code, error.reason);
        this.#finalize(error.code, error.reason);
      }
      // 解码器进入"失败态"后会拒绝解析后续所有字节 —— 那样对端的 close 应答永远解析不出来，
      // close 握手只能等 3s 强制断开（实测表现为"协议错误后关闭慢 3 秒"）。
      // 这里把它复位：业务帧仍被忽略（open=false），只允许 CLOSE 帧走完握手。
      this.decoder.failure = null;
      this.decoder.buffer = Buffer.alloc(0);
    }
  }

  /**
   * 写原始帧。
   * @param {number} opcode
   * @param {Buffer} payload
   * @param {(pending: number) => void} [cb] flush 完成后回调（隧道层用它做单流缓冲记账）
   * @returns {boolean} 是否已全部交给内核（false 表示进入缓冲，需要等待 drain）
   */
  writeFrame(opcode, payload, cb = null) {
    if (!this.writable) {
      cb?.(this.pendingBytes);
      return false;
    }
    const buf = encodeFrame(opcode, payload);
    this.pendingBytes += buf.length;
    let ok = false;
    try {
      ok = this.socket.write(buf, () => {
        this.pendingBytes = Math.max(0, this.pendingBytes - buf.length);
        cb?.(this.pendingBytes);
        this.emit('drain-bytes', this.pendingBytes);
      });
    } catch {
      this.pendingBytes = Math.max(0, this.pendingBytes - buf.length);
      cb?.(this.pendingBytes);
      return false;
    }
    if (!ok) {
      // 进入内核缓冲即已"离开"应用层队列？不：pendingBytes 仍计入，直到 flush 回调触发。
      // 这里只把 socket 的背压信号透出（emit 'drain'），让隧道层知道该暂停读对端了。
      this.emit('saturated', this.pendingBytes);
    }
    return ok;
  }

  /** @param {string} text @param {(pending: number) => void} [cb] @returns {boolean} */
  sendText(text, cb = null) {
    return this.writeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'), cb);
  }

  /**
   * 发送 JSON 文本帧（隧道帧一律走这里）。
   * @param {object} obj
   * @param {(pending: number) => void} [cb]
   */
  sendJson(obj, cb = null) {
    return this.sendText(JSON.stringify(obj), cb);
  }

  /** WS 协议层 ping（载荷 ≤125 字节）。 @returns {boolean} */
  sendPing(payload = null) {
    const data = payload ?? Buffer.from(String(++this._pingSeq));
    return this.writeFrame(OPCODE.PING, data);
  }

  /** @param {Buffer} payload */
  sendPong(payload = Buffer.alloc(0)) {
    return this.writeFrame(OPCODE.PONG, payload);
  }

  /**
   * 发起关闭握手（发送 close 帧 + 等对端 close / 超时强断）。
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = CLOSE.NORMAL, reason = '') {
    if (!this.open) return;
    this.closedByUs = true;
    this.#sendClose(code, reason);
    // 对端可能不回 close：3s 后强断，避免半开连接挂住服务
    if (!this._closeTimer) {
      this._closeTimer = setTimeout(() => this.terminate(), 3000);
      this._closeTimer.unref?.();
    }
  }

  #sendClose(code, reason) {
    if (this._closeSent || !this.socket.writable) return;
    this._closeSent = true;
    const reasonBuf = Buffer.from(reason ?? '', 'utf8').subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    const buf = encodeFrame(OPCODE.CLOSE, payload);
    try {
      this.socket.write(buf);
    } catch {
      /* 对端已断开 */
    }
  }

  /** 立即断开（不发 close 帧）。 */
  terminate() {
    this.#finalize(1006, 'terminated');
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }

  /** close 握手结束后关闭 TCP（写缓冲先 flush，再销毁）。 */
  #finishSocket() {
    try {
      if (typeof this.socket.destroySoon === 'function') this.socket.destroySoon();
      else this.socket.end();
    } catch {
      /* ignore */
    }
  }

  /** 暂停读对端（背压）。 */
  pauseRead() {
    try {
      this.socket.pause();
    } catch {
      /* ignore */
    }
  }

  /** 恢复读对端。 */
  resumeRead() {
    try {
      this.socket.resume();
    } catch {
      /* ignore */
    }
  }

  get paused() {
    return this.socket.isPaused?.() ?? false;
  }

  #finalize(code, reason) {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.open = false;
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    this.pendingBytes = 0;
    this.emit('close', { code, reason });
  }
}

/**
 * 编码一个服务端帧（服务端→客户端不带掩码）。
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65_536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/**
 * 完成握手并返回连接对象（已成功时调用方负责后续帧处理）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{maxMessageBytes?: number}} [opts]
 * @returns {WebSocketConnection}
 */
export function acceptWebSocket(req, socket, head = Buffer.alloc(0), { maxMessageBytes = 8_388_608 } = {}) {
  const key = String(req.headers['sec-websocket-key']);
  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${computeAccept(key)}`,
    '',
    '',
  ].join('\r\n');
  socket.write(response);
  return new WebSocketConnection(socket, { head, maxMessageBytes, remoteAddress: req.socket?.remoteAddress ?? null });
}
