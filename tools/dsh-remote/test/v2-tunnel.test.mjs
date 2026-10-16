/**
 * 隧道路径回归测试：用一个**模仿中继的极简 WS 服务端**驱动真实 `RelayClient`，
 * 断言 v1/v2 端点经隧道后与直连语义一致，且隧道**不绕过鉴权**。
 *
 * 为什么必须有一条这样的用例（lead 裁定 ④）：中继第一版把整个 `/api/v1/` 对 device 拦死了，
 * 会让已装机的 v1 App 经隧道完全不可用。只看 relay-dev 的外部互操作脚本不够 ——
 * 网关侧的 "req → 本机真实 HTTP → chunk 回传" 这条链路必须有自己的回归，
 * 否则以后有人改 `#dispatch`（例如"绕过 HTTP 直接调 handler"）不会被任何用例拦住。
 *
 * 这里不 mock 传输层：WS 握手与帧编解码都是真的（复用 lib/ws.mjs 的编解码器），
 * 隧道的另一端是一个真的 TCP 服务端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../lib/http.mjs';
import { defaultConfig, mergeConfig, validateConfig } from '../lib/config.mjs';
import { createLogger } from '../lib/util.mjs';
import { FrameDecoder, OPCODE, acceptKey, encodeFrame } from '../lib/ws.mjs';
import { httpRequest, sleep, waitFor, FAKE_DSH } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 极简中继替身：只做「握手 + hello/ready + 收发 req/res/chunk/end/abort」。
 * 帧编解码直接用网关自己的实现（真编解码，不是假对象）。
 */
class FakeRelay {
  /**
   * @param {{readyMode?: 'require-hello'|'eager'}} [opts]
   *   `require-hello`（默认）= 模拟真实中继：收到 hello 才回 ready；
   *   `eager` = 升级成功后**立刻**回 ready（用来复现"监听挂晚了丢 ready"的竞态）。
   */
  constructor({ readyMode = 'require-hello' } = {}) {
    this.readyMode = readyMode;
    this.server = null;
    this.socket = null;
    this.decoder = new FrameDecoder();
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, status: number|null, headers: object|null, chunks: Buffer[], events: object[]}>} */
    this.pending = new Map();
    this.readySockets = 0;
    this.messages = [];
    this.homeToken = null;
    this.hello = null;
    /** @type {Set<import('node:net').Socket>} 所有升级过的连接（close 时必须逐个销毁）。 */
    this.sockets = new Set();
    /** @type {string[]} 网关发来的所有 abort.reason（在收帧侧收集，不是在发送侧）。 */
    this.aborts = [];
    /** 最近一次 `request()` 分配的 id。 */
    this.lastId = null;
  }

  async listen() {
    this.server = http.createServer((req, res) => {
      res.writeHead(404).end();
    });
    this.server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      this.homeToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
      this.socket = socket;
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('data', (chunk) => {
        let frames;
        try {
          frames = this.decoder.push(chunk);
        } catch {
          return;
        }
        for (const frame of frames) {
          if (frame.opcode !== OPCODE.text) continue;
          let msg;
          try {
            msg = JSON.parse(frame.payload.toString('utf8'));
          } catch {
            continue;
          }
          this.#onMessage(msg);
        }
      });
      socket.on('error', () => {});
      // eager 模式：**升级成功后立刻**回 ready（不等 hello）——
      // 真实中继有可能这么做，若网关在 `await connect()` 之后才注册 ready 监听，就会丢帧。
      if (this.readyMode === 'eager') {
        this.send({ t: 'ready', proto: 2, role: 'home', homeId: 'home_faketunnel', homeName: 'FAKE-PC' });
      }
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this.server.address().port;
  }

  #onMessage(msg) {
    this.messages.push(msg);
    if (msg.t === 'hello') {
      this.hello = msg;
      this.readySockets += 1;
      // **替身必须模拟对端的真实契约行为**：真实中继在拿到 hello 之前不会回 ready。
      // （这正是"双方各自自洽、真对接死锁"的来源：替身若一升级就回 ready，
      //   就永远测不出"网关没及时发 hello"这个缺陷。）
      if (this.readyMode === 'require-hello') this.send({ t: 'ready', proto: 2, role: 'home', homeId: 'home_faketunnel', homeName: 'FAKE-PC' });
      return;
    }
    if (msg.t === 'ping') {
      this.send({ t: 'pong', id: msg.id });
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    entry.events.push(msg);
    if (msg.t === 'res') {
      entry.status = msg.status;
      entry.headers = msg.headers ?? {};
      entry.onHeaders?.(msg.status, entry.headers);
    } else if (msg.t === 'chunk') {
      entry.chunks.push(Buffer.from(msg.dataB64 ?? '', 'base64'));
      entry.onChunk?.(Buffer.from(msg.dataB64 ?? '', 'base64'));
    } else if (msg.t === 'end') {
      this.pending.delete(msg.id);
      entry.resolve({ status: entry.status ?? 200, headers: entry.headers ?? {}, body: Buffer.concat(entry.chunks), events: entry.events });
    } else if (msg.t === 'abort') {
      this.aborts.push(msg.reason); // 网关→中继方向的 abort（测试要断言的就是它）
      this.pending.delete(msg.id);
      entry.resolve({ status: entry.status ?? 0, headers: entry.headers ?? {}, body: Buffer.concat(entry.chunks), abort: msg.reason, events: entry.events });
    }
  }

  send(obj) {
    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(encodeFrame({ opcode: OPCODE.text, payload: Buffer.from(JSON.stringify(obj), 'utf8'), mask: false }));
    return true;
  }

  /** 经隧道发一个请求（模拟中继把手机的请求转给 PC）。 */
  request(method, pathname, { headers = {}, body = null, timeoutMs = 10_000, onHeaders = null, onChunk = null, cancelAfterMs = null } = {}) {
    const id = this.nextId++;
    this.lastId = id; // 供用例精确取到"这一条"的 id（不能用 nextId-1 猜）
    const frame = { t: 'req', id, method, path: pathname, headers };
    if (body !== null) frame.bodyB64 = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8').toString('base64');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0), timeout: true, events: [] });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        status: null,
        headers: null,
        chunks: [],
        events: [],
        onHeaders,
        onChunk,
      });
      this.send(frame);
      if (cancelAfterMs !== null) setTimeout(() => this.send({ t: 'cancel', id }), cancelAfterMs);
    });
  }

  async close() {
    // upgraded socket 不会被 http.Server 的 close() 主动断开，必须自己全量销毁，
    // 否则 `server.close()` 会一直挂着（实测每个用例多花 ~20s，甚至永不 resolve）。
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        /* 已断开 */
      }
    }
    this.sockets.clear();
    this.server.closeAllConnections?.();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      this.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** 启动一个已连上替身中继的网关。 */
async function startTunnelHarness(t, { readyMode = 'require-hello', relayOverrides = {} } = {}) {
  const root = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'dshr-tunnel-'));
  const gwHome = path.join(root, 'gw-home');
  const ws = path.join(root, 'ws');
  await fs.mkdir(path.join(gwHome, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(gwHome, 'logs'), { recursive: true });
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'note.txt'), 'tunnel-ws\n', 'utf8');

  const relay = new FakeRelay({ readyMode });
  const relayPort = await relay.listen();

  const config = validateConfig(
    mergeConfig(defaultConfig({}), {
      host: '127.0.0.1',
      port: 0,
      dshHome: gwHome,
      serverName: 'TUNNEL-PC',
      workspaceAllowlist: [ws],
      defaultWorkspace: ws,
      // 预置 homeToken → 跳过注册，直接建隧道（本用例只关心隧道路径）
      relay: { enabled: true, url: `ws://127.0.0.1:${relayPort}`, homeToken: 'homeToken_faketunnel', homeName: 'FAKE-PC', ...relayOverrides },
      dsh: { node: process.execPath, binPath: FAKE_DSH, launcher: null, autoDetectLauncher: false, sessionsHome: path.join(root, 'sdk-home') },
      mirror: { enabled: false },
      log: { toConsole: false },
      limits: { requestTimeoutMs: 5000 },
    }),
    { env: {} },
  );
  const logger = createLogger({ dir: config.logsDir, toConsole: false });
  // desktop: null → 显式关闭桌面端接线，避免构造真实 DesktopApi（会连 127.0.0.1:19387）
  const gw = await createGateway(config, { logger, desktop: null });
  const port = await gw.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await gw.close().catch(() => {});
    await relay.close().catch(() => {});
    await sleep(50);
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  // 建隧道（relay.enabled 时 createGateway→listen 会自动 connect；显式再来一次是幂等的）
  const connected = await gw.relay.connect();
  assert.equal(connected.ok, true, `隧道未连上替身中继：${connected.error ?? ''}`);
  await waitFor(() => gw.relay.connected, { timeoutMs: 5000, message: 'relay.connected 未变 true' });

  // 直连配对拿一个令牌（隧道用例要验证"带令牌能过、不带令牌 401"）
  const open = await httpRequest(baseUrl, 'POST', '/api/v1/pair/open');
  const claim = await httpRequest(baseUrl, 'POST', '/api/v1/pair/claim', { body: { code: open.json.code, deviceName: 'tunnel-test', deviceId: '01234567-89ab-4cde-8f01-23456789abcd' } });
  const token = claim.json.token;
  return { gw, config, relay, baseUrl, token, ws, root };
}

const asJson = (result) => {
  try {
    return JSON.parse(result.body.toString('utf8'));
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- 握手顺序（P0 回归）
test('P0 回归：hello 必须是 WS open 后的第一帧（替身中继收到 hello 才回 ready）', async (t) => {
  // 替身按**真实契约行为**模拟：没有 hello 就永远不回 ready。
  // 修复前网关把 send(hello) 放在 `await connect()` 之后，双方互相等待：
  // 中继"30s 无任何帧"、网关"等待 ready 超时 10s"，无限重连。
  const h = await startTunnelHarness(t, { readyMode: 'require-hello' });
  assert.equal(h.gw.relay.connected, true, '网关必须在只收到 hello 应答的情况下完成握手');
  assert.ok(h.gw.relay.helloSent, '网关必须已发 hello');
  assert.equal(h.relay.hello?.t, 'hello');
  assert.equal(h.relay.messages[0].t, 'hello', 'hello 必须是网关发出的第一个帧');
  assert.ok(h.gw.relay.status().stats.framesIn >= 1, '网关必须真的收到了 ready 帧');
  assert.equal(h.gw.relay.homeId, 'home_faketunnel', 'ready 里的 homeId 必须被采纳');
  // 连上后会立刻发一次心跳（间隔 10s），所以"最后收到的帧"可能是 pong —— 断言集合而不是末帧
  assert.ok(['ready', 'pong'].includes(h.gw.relay.lastFrameType), `最后帧类型应为 ready 或 pong（实际 ${h.gw.relay.lastFrameType}）`);
  assert.ok(h.relay.messages.some((m) => m.t === 'ping'), '连上后应立即发一次心跳（不让对端空闲计时累积到阈值边缘）');
});

test('P0 回归：ready 在 connect() 返回前就到，也不能丢（监听必须提前挂好）', async (t) => {
  // eager 替身：WS 升级成功后立刻回 ready。若监听是在 `await connect()` 之后注册，
  // 这一帧会在"无人监听"的窗口里被 EventEmitter 丢掉 → 偶发 10s 超时。
  const h = await startTunnelHarness(t, { readyMode: 'eager' });
  assert.equal(h.gw.relay.connected, true, '提前到达的 ready 不得被丢弃');
  assert.equal(h.gw.relay.homeId, 'home_faketunnel');
  // 隧道可用（拿它与 require-hello 模式对照，确认不是"靠重连碰运气"）
  assert.equal(h.gw.relay.status().reconnects, 0, '不得靠重连才连上（否则就是丢了第一帧）');
  assert.equal(h.relay.readySockets, 1, '只应有一次 hello（没有多余重连）');
  const res = await h.relay.request('GET', '/api/v1/health');
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------- abort reason 枚举（lead 裁定）
test('abort.reason 只能是契约 §3.3 六值枚举；业务失败必须走 HTTP 语义', async (t) => {
  const h = await startTunnelHarness(t, { relayOverrides: { maxStreams: 1 } });

  // 1) 隧道只允许访问本机回环：绝对 URL 指向外部主机 → 403 + 错误体 + end（**不是** abort）
  const forbidden = await h.relay.request('GET', 'http://169.254.169.254/latest/meta-data/', { headers: { Authorization: `Bearer ${h.token}` } });
  assert.equal(forbidden.status, 403, `越权目标必须 403（实际 ${forbidden.status}）`);
  const forbiddenBody = asJson(forbidden);
  assert.equal(forbiddenBody.error.code, 'forbidden', '业务失败原因必须通过响应体表达');
  assert.match(forbiddenBody.error.message, /回环/);
  assert.equal(forbidden.abort, undefined, '不得用 abort 表达业务失败');

  // 2) 无法解析的路径 → 400 + 错误体 + end
  const badPath = await h.relay.request('GET', 'http://[bad/url', { headers: { Authorization: `Bearer ${h.token}` } });
  assert.equal(badPath.status, 400);
  assert.equal(asJson(badPath).error.code, 'bad_request');
  assert.equal(badPath.abort, undefined);

  // 3) 并发流上限 → 429 + 错误体 + end（错误码用契约 §3.3 的 too_many_streams）
  const held = h.relay.request('GET', '/api/v1/events', {
    headers: { Authorization: `Bearer ${h.token}`, Accept: 'text/event-stream' },
    timeoutMs: 6000,
  });
  const heldId = h.relay.lastId; // 精确取 SSE 那一条的 id（后面的请求会把它顶掉，不能事后猜）
  await waitFor(() => h.gw.relay.status().inFlight >= 1, { timeoutMs: 5000, message: '首个流未建立' });
  const overflow = await h.relay.request('GET', '/api/v2/health');
  assert.equal(overflow.status, 429, `超出并发上限必须 429（实际 ${overflow.status}）`);
  assert.equal(asJson(overflow).error.code, 'too_many_streams', '业务失败原因必须通过响应体表达');
  assert.equal(overflow.abort, undefined);

  // 4) 客户端 cancel → 网关必须发 abort 且 reason 为 `canceled`
  await h.relay.send({ t: 'cancel', id: heldId });
  await waitFor(() => h.relay.aborts.length >= 1, { timeoutMs: 6000, message: 'cancel 未触发 abort' });
  assert.equal(h.relay.aborts.at(-1), 'canceled');

  // 5) **全量断言**：所有 abort 帧的 reason 都必须在六值枚举内（最容易再次跑偏的地方）
  const enumSet = new Set(['overflow', 'peer_closed', 'home_offline', 'timeout', 'canceled', 'internal']);
  for (const reason of h.relay.aborts) {
    assert.ok(enumSet.has(reason), `abort.reason 越界：${JSON.stringify(reason)}（只允许 ${[...enumSet].join('|')}）`);
  }
  await held;
  assert.ok(h.relay.aborts.length >= 1);
});

test('relay：响应头过滤逐跳头，避免手机侧"双重分帧"歧义', async (t) => {
  const h = await startTunnelHarness(t);
  const res = await h.relay.request('GET', '/api/v2/health', { headers: { Authorization: `Bearer ${h.token}` } });
  assert.equal(res.status, 200);
  const headerNames = Object.keys(res.headers).map((k) => k.toLowerCase());
  for (const banned of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade']) {
    assert.ok(!headerNames.includes(banned), `逐跳头 ${banned} 不得经隧道回传（实际头：${headerNames.join(',')}）`);
  }
  assert.ok(!headerNames.some((k) => k.startsWith('proxy-')), 'proxy-* 逐跳头不得回传');
  // 正常业务头必须保留
  assert.ok(headerNames.includes('content-type'));
  assert.ok(headerNames.includes('content-length') || headerNames.includes('x-api-version'));
});

// ---------------------------------------------------------------- §4.1 三个端点形状一致（扁平）
test('契约 §4.1：relay/status、relay/connect、relay/disconnect、health.relay 四处形状一致（扁平）', async (t) => {
  const h = await startTunnelHarness(t);

  // 1) GET /relay/status → 扁平
  const status = await httpRequest(h.baseUrl, 'GET', '/api/v2/relay/status');
  assert.equal(status.status, 200);
  assert.equal(typeof status.json.connected, 'boolean', 'status 顶层必须有 connected（扁平读法）');
  assert.equal(status.json.status, undefined, 'status 不得再包一层 status');
  assert.equal(status.json.connected, true);
  assert.equal(typeof status.json.homeId, 'string');
  assert.equal(typeof status.json.reconnects, 'number');

  // 2) POST /relay/connect（幂等再连）→ { ok, ...扁平状态 }
  const connect = await httpRequest(h.baseUrl, 'POST', '/api/v2/relay/connect');
  assert.equal(connect.status, 200);
  assert.equal(connect.json.ok, true, 'ok 表示"本次操作成功与否"');
  assert.equal(typeof connect.json.connected, 'boolean', 'connect 顶层也必须有 connected');
  assert.equal(connect.json.connected, true);
  assert.equal(connect.json.status, undefined, 'connect 不得再包一层 status');
  assert.equal(connect.json.homeId, 'home_faketunnel');

  // 3) POST /relay/disconnect → { ok, ...扁平状态 }
  const disconnect = await httpRequest(h.baseUrl, 'POST', '/api/v2/relay/disconnect');
  assert.equal(disconnect.status, 200);
  assert.equal(disconnect.json.ok, true);
  assert.equal(typeof disconnect.json.connected, 'boolean');
  assert.equal(disconnect.json.connected, false);
  assert.equal(disconnect.json.status, undefined);

  // 4) GET /health 内嵌 relay 也是扁平
  const health = await httpRequest(h.baseUrl, 'GET', '/api/v2/health');
  assert.equal(health.status, 200);
  assert.equal(typeof health.json.relay.connected, 'boolean', 'health.relay 也是扁平状态');
  assert.equal(health.json.relay.status, undefined);

  // 5) **形状一致性总断言**：四处对同一时刻的同一字段读法必须相同
  await h.gw.relay.connect();
  const [s2, c2, h2] = await Promise.all([
    httpRequest(h.baseUrl, 'GET', '/api/v2/relay/status'),
    httpRequest(h.baseUrl, 'POST', '/api/v2/relay/connect'),
    httpRequest(h.baseUrl, 'GET', '/api/v2/health'),
  ]);
  const shapes = [s2, c2, h2].map((r, i) => ({
    where: ['status', 'connect', 'health.relay'][i],
    path: i === 2 ? r.json.relay : r.json,
  }));
  for (const { where, path } of shapes) {
    assert.equal(typeof path.connected, 'boolean', `${where} 必须能在顶层读到 connected`);
    assert.equal(path.status, undefined, `${where} 不得嵌套 status`);
    assert.equal(path.connected, true, `${where} 的 connected 必须一致为 true`);
    assert.equal(path.homeId, 'home_faketunnel', `${where} 的 homeId 必须一致`);
  }
});

// ---------------------------------------------------------------- 隧道可用性
test('隧道：hello 带 Bearer homeToken，收到 ready 后 connected=true', async (t) => {
  const h = await startTunnelHarness(t);
  assert.equal(h.relay.hello.t, 'hello');
  assert.equal(h.relay.hello.proto, 2);
  assert.equal(h.relay.hello.role, 'home');
  assert.equal(h.relay.homeToken, 'homeToken_faketunnel', 'hello 必须携带 homeToken（契约 §3 隧道认证）');
  assert.equal(h.gw.relay.connected, true);
  assert.equal(h.gw.relay.homeId, 'home_faketunnel');
  const status = await httpRequest(h.baseUrl, 'GET', '/api/v2/relay/status');
  assert.equal(status.json.connected, true);
  assert.equal(status.json.homeId, 'home_faketunnel');
});

// ---------------------------------------------------------------- v1 端点经隧道
test('隧道：v1 端点全部照常工作（health/pair·claim/devices/tasks），语义与直连一致', async (t) => {
  const h = await startTunnelHarness(t);

  // 1) /api/v1/health —— 与直连逐字段一致（uptimeMs 易变，排除）
  const tunnelHealth = await h.relay.request('GET', '/api/v1/health');
  assert.equal(tunnelHealth.status, 200);
  const directHealth = await httpRequest(h.baseUrl, 'GET', '/api/v1/health');
  const th = asJson(tunnelHealth);
  const dh = directHealth.json;
  assert.deepEqual(Object.keys(th).sort(), Object.keys(dh).sort(), '隧道与直连的字段集合必须一致');
  for (const key of Object.keys(dh)) {
    if (key === 'uptimeMs') continue;
    assert.deepEqual(th[key], dh[key], `字段 ${key} 经隧道后必须一致`);
  }
  assert.equal(th.apiVersion, 1, 'v1 health 的 apiVersion 经隧道也必须是 1');

  // 2) 管理端点经隧道必须被拒（安全裁定）：`pair/open` 是**本机**才允许的端点，
  //    真实流程是用户在 PC 上执行 `gateway.mjs pair` 拿码，手机只负责 claim。
  const tunnelOpen = await h.relay.request('POST', '/api/v1/pair/open');
  assert.equal(tunnelOpen.status, 403, `pair/open 经隧道必须 403（实际 ${tunnelOpen.status}）`);
  assert.equal(asJson(tunnelOpen).error.code, 'forbidden');
  const tunnelRelayStatus = await h.relay.request('GET', '/api/v2/relay/status');
  assert.equal(tunnelRelayStatus.status, 403, 'relay/status 经隧道必须 403（内网信息不外泄）');
  const tunnelDisconnect = await h.relay.request('POST', '/api/v2/relay/disconnect');
  assert.equal(tunnelDisconnect.status, 403, 'relay/disconnect 经隧道必须 403（防远程断链 DoS）');

  // 配对码在**本机**生成（真实流程），再经隧道 claim —— 这才是 v1 App 的路径
  const open = await httpRequest(h.baseUrl, 'POST', '/api/v1/pair/open');
  assert.equal(open.status, 200);
  const code = open.json.code;
  assert.match(code, /^\d{6}$/);

  // 3) /api/v1/pair/claim 经隧道 → 必须发令牌（老 App 走的就是这条）
  const tunnelClaim = await h.relay.request('POST', '/api/v1/pair/claim', {
    headers: { 'Content-Type': 'application/json' },
    body: { code, deviceName: 'tunnel-v1-app', deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  });
  assert.equal(tunnelClaim.status, 200, `v1 pair/claim 经隧道必须成功（实际 ${tunnelClaim.status} ${tunnelClaim.body.toString().slice(0, 160)}）`);
  const claimBody = asJson(tunnelClaim);
  assert.match(claimBody.token, /^dshr_/);
  assert.equal(typeof claimBody.tokenId, 'string');
  assert.equal(claimBody.serverName, 'TUNNEL-PC');
  assert.equal(claimBody.expiresAt, null);
  assert.equal(claimBody.relay, undefined, 'v1 直连响应体逐字不变：relay 块由中继在隧道路径注入，网关不加');

  // 4) /api/v1/devices 带令牌 → 200；不带 → 401（**隧道不绕过鉴权**）
  const withToken = await h.relay.request('GET', '/api/v1/devices', { headers: { Authorization: `Bearer ${claimBody.token}` } });
  assert.equal(withToken.status, 200);
  assert.ok(Array.isArray(asJson(withToken).devices));

  const noToken = await h.relay.request('GET', '/api/v1/devices');
  assert.equal(noToken.status, 401, '无令牌经隧道必须 401');
  assert.equal(asJson(noToken).error.code, 'unauthorized');

  const badToken = await h.relay.request('GET', '/api/v1/devices', { headers: { Authorization: 'Bearer dshr_wrong' } });
  assert.equal(badToken.status, 401);

  // 5) /api/v1/tasks 经隧道提交真实子进程任务（替身 dsh）→ 201，随后能取到终态
  const created = await h.relay.request('POST', '/api/v1/tasks', {
    headers: { Authorization: `Bearer ${claimBody.token}`, 'Content-Type': 'application/json' },
    body: { prompt: 'tunnel task', workspace: h.ws },
  });
  assert.equal(created.status, 201, `v1 tasks 经隧道必须成功（实际 ${created.status} ${created.body.toString().slice(0, 200)}）`);
  const task = asJson(created);
  assert.match(task.id, /^task_/);
  await waitFor(async () => {
    const res = await h.relay.request('GET', `/api/v1/tasks/${task.id}`, { headers: { Authorization: `Bearer ${claimBody.token}` } });
    return ['succeeded', 'failed', 'canceled'].includes(asJson(res)?.status);
  }, { timeoutMs: 10_000, message: '经隧道提交的任务未进入终态' });

  // 6) /api/v2 端点经隧道（带令牌）
  const v2 = await h.relay.request('GET', '/api/v2/sessions', { headers: { Authorization: `Bearer ${claimBody.token}` } });
  assert.equal(v2.status, 200);
  assert.ok(Array.isArray(asJson(v2).sessions));
  const v2Health = await h.relay.request('GET', '/api/v2/health');
  assert.equal(v2Health.status, 200);
  assert.deepEqual(asJson(v2Health).supportedApiVersions, [1, 2]);
});

// ---------------------------------------------------------------- SSE 经隧道
test('隧道：SSE 以无损长流推送（res + chunk*，end 不发；cancel 后网关清理）', async (t) => {
  const h = await startTunnelHarness(t);
  const chunks = [];
  let headers = null;
  const pending = h.relay.request('GET', '/api/v1/events', {
    headers: { Authorization: `Bearer ${h.token}`, Accept: 'text/event-stream' },
    timeoutMs: 8000,
    cancelAfterMs: 1500,
    onHeaders: (status, hdrs) => {
      headers = { status, hdrs };
    },
    onChunk: (buf) => chunks.push(buf.toString('utf8')),
  });
  await waitFor(() => chunks.length > 0, { timeoutMs: 5000, message: 'SSE 未推任何 chunk' });
  assert.equal(headers.status, 200);
  assert.match(String(headers.hdrs['content-type']), /text\/event-stream/);
  assert.ok(chunks.join('').includes(': connected'), 'SSE 首块应为连接注释');

  // 期间推一个任务事件，验证增量真的流过来了
  void h.gw.bus.publish('task.created', { task: { id: 'task_x' } }, 'task_x');
  await waitFor(() => chunks.join('').includes('task.created'), { timeoutMs: 5000, message: 'SSE 未推送任务事件' });

  const result = await pending;
  // 中继发 cancel 后，网关应回 abort（或连接结束时 end）——两种都属于"正常终止"，不得挂死
  const aborted = result.events.some((e) => e.t === 'abort');
  assert.ok(aborted || result.status === 200, `SSE 取消后网关必须有响应（events=${JSON.stringify(result.events.map((e) => e.t))}）`);
  // 取消后网关的 SSE 台账必须归零（否则长连接会泄漏）
  await waitFor(() => h.gw.stats().sseClients === 0, { timeoutMs: 5000, message: 'cancel 后 SSE 客户端未清理' });
  assert.equal(h.gw.stats().sseHeartbeats, 0, 'cancel 后心跳定时器未清理');
  void result;
});

// ---------------------------------------------------------------- 分段与大响应
test('隧道：大响应按 ≤128 KiB 分片回传，拼接后与直连字节一致', async (t) => {
  const h = await startTunnelHarness(t);
  const big = Buffer.alloc(300_001, 0x41); // 300 KB > 单 chunk 上限
  await fs.writeFile(path.join(h.ws, 'big.txt'), big);
  const result = await h.relay.request('GET', '/api/v2/workspaces/file?path=big.txt', {
    headers: { Authorization: `Bearer ${h.token}` },
  }).catch(() => null);
  // v2 需要令牌；直接用 v1 路径不可得 300KB，因此改用 v2 文件接口
  assert.ok(result, '请求必须完成');
  assert.equal(result.status, 200);
  const json = asJson(result);
  const chunkFrames = result.events.filter((e) => e.t === 'chunk');
  assert.ok(chunkFrames.length >= 2, `300 KB 响应必须被切成多片（实际 ${chunkFrames.length} 片）`);
  const maxChunk = Math.max(...chunkFrames.map((e) => Buffer.from(e.dataB64, 'base64').length));
  assert.ok(maxChunk <= 128 * 1024, `单片解码后不得超过 128 KiB（实际 ${maxChunk}）`);
  assert.equal(json.size, big.length);
  assert.equal(json.text.length, big.length, '拼接后的内容长度必须与直连一致');
  assert.ok(result.events.some((e) => e.t === 'end'), '正常响应必须以 end 收尾');
});

// ---------------------------------------------------------------- 隧道断开清理
test('隧道：断开时清理在途流并触发重连（不泄漏、不挂死）', async (t) => {
  const h = await startTunnelHarness(t);
  // 开一条 SSE 挂着
  const inflight = h.relay.request('GET', '/api/v1/events', {
    headers: { Authorization: `Bearer ${h.token}`, Accept: 'text/event-stream' },
    timeoutMs: 6000,
  });
  await waitFor(() => h.gw.stats().sseClients >= 1, { timeoutMs: 5000, message: 'SSE 未建立' });
  assert.equal(h.gw.relay.status().inFlight >= 1, true, '网关应记录在途隧道流');

  // 硬断隧道
  h.relay.socket.destroy();
  await waitFor(() => h.gw.relay.connected === false, { timeoutMs: 5000, message: '隧道断开未被感知' });
  assert.equal(h.gw.relay.status().inFlight, 0, '断开时必须清理全部在途流');
  await waitFor(() => h.gw.stats().sseClients === 0, { timeoutMs: 5000, message: '断开后在途 SSE 未清理' });
  assert.equal(h.gw.stats().sseHeartbeats, 0, '断开后 SSE 心跳定时器未清理');

  // 注意：socket 已经被硬断，中继侧**不可能**再收到任何帧（包括 abort），
  // 所以这里不能断言"收到 abort"——能断言的是**网关侧不留悬挂状态**（上面三条），
  // 以及随后能自动重连。真正的 abort 收尾由上面的 cancel 用例覆盖。
  await inflight;

  // 退避重连：连上新的替身连接（同一个 server 仍在监听）
  await waitFor(() => h.gw.relay.connected === true, { timeoutMs: 15_000, message: '网关未自动重连' });
  assert.ok(h.gw.relay.status().reconnects >= 1, 'reconnects 计数必须递增');
  assert.equal(h.relay.readySockets >= 2, true, '替身中继应收到第二次 hello');
});
