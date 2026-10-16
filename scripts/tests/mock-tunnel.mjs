// mock-tunnel.mjs —— 中继/网关的**测试替身**（test double），只用于在真实实现就绪前验证
// scripts/tests/phone-sim.mjs 与 scripts/e2e-crossnetwork.ps1 的编排逻辑。
//
// 重要：它**不是**工具交付物，也不得作为契约 §6 的验收证据。
//   真实判据 A~E 必须对 tools/dsh-relay 与 tools/dsh-remote 的真实进程执行。
//   本文件只是「线束自检」：证明手机模拟器的 WS 帧编解码、多路复用、chunk 重组、
//   SSE 增量解析、notice 处理、断线重连这些**客户端侧**逻辑是对的。
//
// 单进程内同时扮演三方：
//   * relay  ：HTTP /health、/api/v2/pair/claim；WS /api/v2/tunnel/{home,device}；id 重映射；notice 广播
//   * home   ：以 WS 客户端连回本进程的 relay（与真实网关同构），对 req 返回桩数据
//   * 控制面 ：POST /__mock/home/drop | /__mock/home/up | GET /__mock/state（用于测试判据 D/E 的编排）
//
// 用法：
//   node mock-tunnel.mjs --port 19443 [--pair-code 123456] [--no-home]
//
// 零第三方依赖（契约 §5.1）。

import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function parseArgv(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) options[key] = true;
      else {
        options[key] = next;
        i += 1;
      }
    }
  }
  return options;
}

const args = parseArgv(process.argv.slice(2));
const PORT = Number(args.port || 19443);
const PAIR_CODE = String(args['pair-code'] || '123456');
const WITH_HOME = !args['no-home'];
const HOME_ID = 'home_mock0000000000000000';
const HOME_TOKEN = 'mock-home-token-0123456789';
const DEVICE_TOKEN = 'dshr_mock_device_token_0123456789';
const STARTED_AT = Date.now();

function log(...parts) {
  process.stdout.write(`[mock-tunnel] ${parts.join(' ')}\n`);
}

// ── WS 帧编解码（服务端视角：收 masked，发 unmasked）──────────────────────────

function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodePong(payload) {
  return Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
}

function createFrameReader(onText, onClose) {
  let buffer = Buffer.alloc(0);
  const fragments = [];
  let fragmentOpcode = 0;
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        length = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        onClose();
        return;
      }
      if (opcode === 0x9) continue; // ping：由调用方回 pong
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments);
          fragments.length = 0;
          onText(full.toString('utf8'), fragmentOpcode);
        }
        continue;
      }
      if (fin) onText(payload.toString('utf8'), opcode);
      else {
        fragmentOpcode = opcode;
        fragments.length = 0;
        fragments.push(payload);
      }
    }
  };
}

// ── 中继状态 ──────────────────────────────────────────────────────────────────

const state = {
  home: null, // { socket, id, name, streams: Map<homeId, deviceId> }
  devices: new Set(),
  homeOnline: false,
  streamSeq: 1,
};

function sendJson(socket, value) {
  try {
    socket.write(encodeText(JSON.stringify(value)));
  } catch (error) {
    log('send failed:', error.message);
  }
}

function notifyDevices(kind) {
  for (const device of state.devices) {
    sendJson(device.socket, { t: 'notice', kind, homeId: HOME_ID });
  }
}

function closeHome(reason) {
  if (!state.home) return;
  const home = state.home;
  state.home = null;
  state.homeOnline = false;
  for (const [mappedId, entry] of home.streams) {
    sendJson(entry.deviceSocket, { t: 'abort', id: entry.deviceId, reason });
    void mappedId;
  }
  home.streams.clear();
  try {
    home.socket.destroy();
  } catch {
    /* ignore */
  }
  notifyDevices('home_offline');
  log(`home 断开（${reason}）→ 已向 ${state.devices.size} 个 device 推 notice{home_offline}`);
}

function handleHomeFrame(socket, frame) {
  switch (frame.t) {
    case 'hello':
      state.homeOnline = true;
      sendJson(socket, { t: 'ready', proto: 2, role: 'home', homeId: HOME_ID });
      notifyDevices('home_online');
      log('home ready（已推 notice{home_online}）');
      return;
    case 'res':
      {
        const entry = state.home.streams.get(frame.id);
        if (!entry) return;
        sendJson(entry.deviceSocket, { t: 'res', id: entry.deviceId, status: frame.status, headers: frame.headers || {} });
      }
      return;
    case 'chunk':
      {
        const entry = state.home.streams.get(frame.id);
        if (!entry) return;
        if (entry.cancelled) return;
        sendJson(entry.deviceSocket, { t: 'chunk', id: entry.deviceId, dataB64: frame.dataB64 });
      }
      return;
    case 'end':
      {
        const entry = state.home.streams.get(frame.id);
        if (!entry) return;
        state.home.streams.delete(frame.id);
        sendJson(entry.deviceSocket, { t: 'end', id: entry.deviceId });
      }
      return;
    case 'abort':
      {
        const entry = state.home.streams.get(frame.id);
        if (!entry) return;
        state.home.streams.delete(frame.id);
        sendJson(entry.deviceSocket, { t: 'abort', id: entry.deviceId, reason: frame.reason });
      }
      return;
    default:
      return;
  }
}

function handleDeviceFrame(socket, frame) {
  switch (frame.t) {
    case 'hello':
      sendJson(socket, {
        t: 'ready',
        proto: 2,
        role: 'device',
        homeId: HOME_ID,
        homeName: 'MOCK-PC',
        homeOnline: state.homeOnline,
      });
      log(`device ready（homeOnline=${state.homeOnline}）`);
      return;
    case 'req': {
      if (!state.home) {
        const body = Buffer.from(JSON.stringify({ error: { code: 'home_offline', message: '电脑当前离线' } }), 'utf8');
        sendJson(socket, { t: 'res', id: frame.id, status: 503, headers: { 'Content-Type': 'application/json' } });
        sendJson(socket, { t: 'chunk', id: frame.id, dataB64: body.toString('base64') });
        sendJson(socket, { t: 'end', id: frame.id });
        return;
      }
      const mappedId = state.streamSeq++;
      state.home.streams.set(mappedId, { deviceId: frame.id, deviceSocket: socket, cancelled: false });
      sendJson(state.home.socket, { ...frame, id: mappedId });
      return;
    }
    case 'cancel': {
      if (!state.home) return;
      for (const [mappedId, entry] of state.home.streams) {
        if (entry.deviceId === frame.id && entry.deviceSocket === socket) {
          entry.cancelled = true;
          sendJson(state.home.socket, { t: 'cancel', id: mappedId });
        }
      }
      return;
    }
    default:
      return;
  }
}

// ── HTTP（中继对外端点 + 控制面）──────────────────────────────────────────────

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function jsonResponse(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    jsonResponse(response, 200, {
      ok: true,
      relayVersion: '2.0.0-mock',
      apiVersion: 2,
      uptimeMs: Date.now() - STARTED_AT,
      homes: state.home ? 1 : 0,
      devices: state.devices.size,
      relayName: 'mock-relay',
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/v2/homes') {
    jsonResponse(response, 200, { homeId: HOME_ID, homeToken: HOME_TOKEN, relayName: 'mock-relay' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/v2/pair/claim') {
    const body = await readBody(request);
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      /* ignore */
    }
    if (!state.home) {
      jsonResponse(response, 503, { error: { code: 'home_offline', message: '电脑当前离线' } });
      return;
    }
    if (String(payload.code) !== PAIR_CODE) {
      jsonResponse(response, 401, { error: { code: 'pairing_bad_code', message: '配对码错误或已过期' } });
      return;
    }
    jsonResponse(response, 200, {
      token: DEVICE_TOKEN,
      tokenId: 'tok_mock0001',
      serverName: 'MOCK-PC',
      expiresAt: null,
      relay: { homeId: HOME_ID, deviceToken: DEVICE_TOKEN, tunnelUrl: `ws://127.0.0.1:${PORT}/api/v2/tunnel/device` },
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/__mock/home/drop') {
    closeHome('mock 控制面要求');
    jsonResponse(response, 200, { ok: true, homeOnline: state.homeOnline });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/__mock/home/up') {
    ensureHome();
    jsonResponse(response, 200, { ok: true, homeOnline: state.homeOnline });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/__mock/state') {
    jsonResponse(response, 200, { homeOnline: state.homeOnline, devices: state.devices.size, streams: state.home ? state.home.streams.size : 0 });
    return;
  }
  jsonResponse(response, 404, { error: { code: 'not_found', message: url.pathname } });
});

server.on('upgrade', (request, socket) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const role = url.pathname === '/api/v2/tunnel/home' ? 'home' : url.pathname === '/api/v2/tunnel/device' ? 'device' : null;
  const key = request.headers['sec-websocket-key'];
  if (!role || !key) {
    socket.destroy();
    return;
  }
  const auth = String(request.headers.authorization || '');
  if (!auth.startsWith('Bearer ') || auth.slice(7).length < 8) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const client = { socket, role, id: null, streams: new Map() };
  const reader = createFrameReader(
    (text) => {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (role === 'home') handleHomeFrame(socket, frame);
      else handleDeviceFrame(socket, frame);
    },
    () => {
      if (role === 'home' && state.home && state.home.socket === socket) closeHome('socket closed');
      else state.devices.delete(client);
    },
  );
  socket.on('data', reader);
  socket.on('error', () => {
    /* ignore */
  });
  socket.on('close', () => {
    if (role === 'home' && state.home && state.home.socket === socket) closeHome('socket closed');
    else state.devices.delete(client);
  });
  if (role === 'home') {
    if (state.home) closeHome('新 home 接管');
    state.home = { socket, id: HOME_ID, streams: new Map() };
    log('home WS 已连接');
  } else {
    state.devices.add(client);
    log(`device WS 已连接（当前 ${state.devices.size} 个）`);
  }
});

// ── 桩 home（以真实 WS 客户端连回本进程）──────────────────────────────────────

// 桩会话状态（让「续聊」在桩里也是真的有新消息，便于验证客户端断言逻辑）
let mockSeq = 40;
const mockMessages = [
  { seq: 12, role: 'user', at: STARTED_AT - 50000, text: '帮我看看构建失败的原因（中文往返）', toolCalls: [], deliverables: [] },
  { seq: 40, role: 'assistant', at: STARTED_AT - 40000, text: '定位到 AGP 版本不匹配…（中文原样）', toolCalls: [], deliverables: [] },
];

function stubHomeResponses(frame) {
  const pathname = String(frame.path || '').split('?')[0];
  const body = (value, status = 200) => ({ status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(value) });
  if (pathname === '/api/v2/sessions/stream') {
    // 注意：这个分支必须排在「单会话」正则之前，否则 /api/v2/sessions/stream 会被当成会话 id
    const seq = mockSeq;
    return {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      body:
        `event: turn.started\ndata: {"sessionId":"session-mock-0001","turn":3,"fromSeq":${seq}}\n\n` +
        `event: message.delta\ndata: {"sessionId":"session-mock-0001","seq":${seq + 1},"role":"assistant","text":"收到"}\n\n` +
        `event: message.delta\ndata: {"sessionId":"session-mock-0001","seq":${seq + 2},"role":"assistant","text":"，已按 --session-id 续聊。"}\n\n` +
        `event: turn.ended\ndata: {"sessionId":"session-mock-0001","turn":3,"reason":"completed"}\n\n`,
      keepOpen: true,
    };
  }
  if (pathname === '/api/v2/sessions') {
    return body({
      sessions: [
        {
          id: 'session-mock-0001',
          title: '中继线束自检',
          workspace: 'D:\\Workspace\\dsh_android\\.runtime\\e2e-crossnetwork\\ws',
          cwd: 'D:\\Workspace\\dsh_android\\.runtime\\e2e-crossnetwork\\ws',
          createdAt: STARTED_AT - 60000,
          updatedAt: Date.now(),
          turns: 2,
          steps: 12,
          lastTurn: { state: 'ended', reason: 'completed' },
          live: false,
          origin: 'user',
          agentPreset: 'standard',
          bytes: 2048,
          eventCount: 20,
          hasChanges: false,
          changeCount: 0,
        },
      ],
      nextCursor: null,
    });
  }
  if (/^\/api\/v2\/sessions\/[^/]+$/.test(pathname)) {
    return body({
      id: 'session-mock-0001',
      title: '中继线束自检',
      workspace: 'D:\\Workspace\\dsh_android\\.runtime\\e2e-crossnetwork\\ws',
      turns: mockMessages.filter((m) => m.role === 'user').length,
      live: false,
      origin: 'user',
    });
  }
  if (pathname.endsWith('/transcript')) {
    const tail = Number((String(frame.path).split('tail=')[1] || '20').split('&')[0]) || 20;
    return body({ sessionId: 'session-mock-0001', messages: mockMessages.slice(-tail), nextCursor: null });
  }
  if (pathname === '/api/v2/workspaces/files') {
    return body({
      workspace: 'D:\\Workspace\\dsh_android\\.runtime\\e2e-crossnetwork\\ws',
      path: 'D:\\Workspace\\dsh_android\\.runtime\\e2e-crossnetwork\\ws',
      entries: [
        { name: 'README.md', path: 'README.md', type: 'file', size: 128, modifiedAt: Date.now() },
        { name: 'src', path: 'src', type: 'dir', size: null, modifiedAt: Date.now() },
      ],
      truncated: false,
    });
  }
  if (pathname === '/api/v2/workspaces/changes') return body({ workspace: 'ws', vcs: 'git', branch: 'main', changed: [], untracked: [], clean: true });
  if (pathname === '/api/v2/workspaces/file') return body({ error: { code: 'workspace_outside', message: '路径越界' } }, 403);
  if (pathname.endsWith('/turns')) {
    let prompt = '';
    try {
      prompt = JSON.parse(Buffer.from(frame.bodyB64 || '', 'base64').toString('utf8')).prompt || '';
    } catch {
      /* ignore */
    }
    mockSeq += 1;
    mockMessages.push({ seq: mockSeq, role: 'user', at: Date.now(), text: prompt, toolCalls: [], deliverables: [] });
    mockSeq += 1;
    mockMessages.push({ seq: mockSeq, role: 'assistant', at: Date.now(), text: `桩回复：已收到「${prompt.slice(0, 20)}」并沿用同一 session（--session-id）。`, toolCalls: [], deliverables: [] });
    log(`桩 home 收到续聊请求，已追加消息至 seq=${mockSeq}`);
    return body({ accepted: true, sessionId: 'session-mock-0001', turnId: 'turn_mock_1', fromSeq: mockSeq - 2 }, 202);
  }
  return body({ error: { code: 'not_found', message: pathname } }, 404);
}

function ensureHome() {
  if (state.home) return;
  const request = http.request({
    host: '127.0.0.1',
    port: PORT,
    path: '/api/v2/tunnel/home',
    method: 'GET',
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      'Sec-WebSocket-Version': '13',
      Authorization: `Bearer ${HOME_TOKEN}`,
    },
  });
  request.on('upgrade', (response, socket) => {
    const send = (value) => socket.write(encodeText(JSON.stringify(value)));
    send({ t: 'hello', proto: 2, role: 'home', name: 'MOCK-PC' });
    const reader = createFrameReader(
      (text) => {
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        if (frame.t === 'ready') {
          log('桩 home 收到 ready');
          return;
        }
        if (frame.t === 'req') {
          const stub = stubHomeResponses(frame);
          send({ t: 'res', id: frame.id, status: stub.status, headers: stub.headers });
          if (stub.body) {
            // 刻意分两片发送，验证客户端 chunk 重组
            const payload = Buffer.from(stub.body, 'utf8');
            const half = Math.ceil(payload.length / 2);
            send({ t: 'chunk', id: frame.id, dataB64: payload.subarray(0, half).toString('base64') });
            send({ t: 'chunk', id: frame.id, dataB64: payload.subarray(half).toString('base64') });
          }
          if (!stub.keepOpen) send({ t: 'end', id: frame.id });
          return;
        }
        if (frame.t === 'cancel') {
          send({ t: 'end', id: frame.id });
          return;
        }
      },
      () => {
        /* close */
      },
    );
    socket.on('data', reader);
    socket.on('error', () => {
      /* ignore */
    });
  });
  request.on('error', (error) => log('桩 home 连接失败:', error.message));
  request.end();
}

server.listen(PORT, '0.0.0.0', () => {
  log(`已监听 0.0.0.0:${PORT}（relay + 桩 home），pairCode=${PAIR_CODE}`);
  if (WITH_HOME) ensureHome();
});
