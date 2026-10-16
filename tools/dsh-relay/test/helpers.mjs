/**
 * 测试公共设施：临时沙箱、**真实**中继实例、HTTP 请求帮助、假网关（home 侧隧道客户端）。
 *
 * 设计原则（沿用 tools/dsh-remote/test/helpers.mjs）：
 * 集成测试启动真实 HTTP/WS 服务（端口 0 由系统分配）、真实 TCP、真实 WS 握手，
 * 只有"对端的网关/手机"用测试替身 —— 因为中继的职责就是与它们对话。
 * 这样路由、鉴权、多路复用、背压、心跳、原子持久化等真实代码路径全部被覆盖。
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, mergeConfig, validateConfig } from '../lib/config.mjs';
import { createRelay } from '../lib/http.mjs';
import { openTunnel } from './ws-client.mjs';

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件成立（用于"最终一致"的断言，例如背压标记、持久化落盘）。 */
export async function waitFor(fn, { timeoutMs = 3000, intervalMs = 20, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
}

/**
 * 创建临时沙箱：独立运行目录（homes.json/logs/tls）。
 * @param {import('node:test').TestContext} [t]
 * @param {object} [overrides]
 * @param {{autoCleanup?: boolean}} [opts]
 */
export async function makeSandbox(t, overrides = {}, { autoCleanup = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-relay-test-'));
  const home = path.join(root, 'home');
  await fs.mkdir(home, { recursive: true });
  const config = validateConfig(
    mergeConfig(
      defaultConfig(process.env),
      {
        host: '127.0.0.1',
        port: 0, // 系统分配，避免并行测试端口冲突
        relayName: 'relay.test',
        relaySecret: 'test-secret',
        log: { toConsole: false },
        limits: { pairClaimPerMinute: 1000, authFailPerMinute: 1000 },
      },
      overrides,
    ),
    { cliHome: home, env: process.env },
  );
  const cleanup = async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  };
  if (t && autoCleanup) t.after(cleanup);
  return { root, home, config, cleanup };
}

/** 发一个 HTTP 请求（Node 内置 http/https；不解 JSON，交给调用方）。 */
export function httpRequest(baseUrl, method, pathname, { headers = {}, body = null, timeoutMs = 5000 } = {}) {
  const url = new URL(pathname, baseUrl);
  const isTls = url.protocol === 'https:';
  const payload = body === null || body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const reqHeaders = { ...headers };
  if (payload !== null && reqHeaders['content-type'] === undefined && reqHeaders['Content-Type'] === undefined) {
    reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
  }
  if (payload !== null) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const transport = isTls ? https : http;
    const req = transport.request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: reqHeaders,
        ...(isTls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text.trim() ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json, cert: isTls ? req.socket?.getPeerCertificate?.() ?? null : null });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP 超时：${method} ${pathname}`)));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * 启动一个真实中继实例。
 * @param {import('node:test').TestContext} t
 * @param {object} [overrides] 配置覆盖
 */
export async function startRelay(t, overrides = {}) {
  const sandbox = await makeSandbox(t, overrides, { autoCleanup: false });
  const relay = await createRelay(sandbox.config);
  const port = await relay.listen();

  t?.after(async () => {
    await relay.close().catch(() => {});
    await sleep(20);
    await sandbox.cleanup();
  });

  const isTls = sandbox.config.tls.mode !== 'off';
  const baseUrl = `${isTls ? 'https' : 'http'}://127.0.0.1:${port}`;
  const wsUrl = `${isTls ? 'wss' : 'ws'}://127.0.0.1:${port}`;
  return {
    sandbox,
    config: sandbox.config,
    home: sandbox.home,
    relay,
    port,
    baseUrl,
    wsUrl,
    /** 带公网名的 device 隧道地址（契约 §2.3 tunnelUrl 用 relayName） */
    deviceTunnelUrl: `${wsUrl}/api/v2/tunnel/device`,
    request: (method, pathname, opts = {}) => httpRequest(baseUrl, method, pathname, opts),
    /** POST /api/v2/homes（契约 §2.2） */
    registerHome: (opts = {}) =>
      httpRequest(baseUrl, 'POST', '/api/v2/homes', {
        body: { relaySecret: opts.relaySecret === undefined ? sandbox.config.relaySecret : opts.relaySecret, homeName: opts.homeName ?? 'DESKTOP-TEST', gatewayVersion: opts.gatewayVersion ?? '2.0.0' },
      }),
    /** POST /api/v2/pair/claim（契约 §2.3） */
    pairClaim: (opts = {}) =>
      httpRequest(baseUrl, 'POST', '/api/v2/pair/claim', {
        body: { code: opts.code, deviceName: opts.deviceName ?? 'Xiaomi 14', deviceId: opts.deviceId ?? '8f3c1a2b-1111-4222-8333-444455556666' },
      }),
    /** 打开 home 隧道并完成 hello/ready。 */
    openHomeTunnel: async (homeToken, opts = {}) => {
      const tunnel = await openTunnel(`${wsUrl}/api/v2/tunnel/home`, { role: 'home', token: homeToken, ...opts });
      const ready = await tunnel.handshake({ name: opts.name });
      return { tunnel, ready };
    },
    /** 打开 device 隧道并完成 hello/ready。 */
    openDeviceTunnel: async (deviceToken, opts = {}) => {
      const tunnel = await openTunnel(`${wsUrl}/api/v2/tunnel/device`, { role: 'device', token: deviceToken, ...opts });
      const ready = await tunnel.handshake();
      return { tunnel, ready };
    },
  };
}

/** 注册一台 home 并返回可用凭据（测试里最常用的一步）。 */
export async function registerHomeToken(h, { homeName = 'DESKTOP-TEST', relaySecret } = {}) {
  const res = await h.registerHome({ homeName, relaySecret });
  if (res.status !== 200) throw new Error(`home 注册失败：${res.status} ${res.text}`);
  return { homeId: res.json.homeId, homeToken: res.json.homeToken, homeName, relayName: res.json.relayName };
}

/** home 侧：声明配对窗口（契约 §3.4 控制面）。 */export async function declarePairWindow(tunnel, { code = null, expiresAt = null, id = null } = {}, { timeoutMs = 3000 } = {}) {
  const reqId = id ?? 900_000 + Math.floor(Math.random() * 1000);
  const body = {};
  if (code !== null) body.code = code;
  if (expiresAt !== null) body.expiresAt = expiresAt;
  const frame = { t: 'req', id: reqId, method: 'POST', path: '/api/v2/pair/window', headers: { 'content-type': 'application/json; charset=utf-8' } };
  frame.bodyB64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  tunnel.send(frame);
  return await collectTunnel(tunnel, reqId, { timeoutMs });
}

/** home 侧：查询配对窗口。 */
export async function queryPairWindow(tunnel, { id = null } = {}, { timeoutMs = 3000 } = {}) {
  const reqId = id ?? 910_000 + Math.floor(Math.random() * 1000);
  tunnel.send({ t: 'req', id: reqId, method: 'GET', path: '/api/v2/pair/window', headers: {} });
  return await collectTunnel(tunnel, reqId, { timeoutMs });
}

/** home 侧：关闭配对窗口。 */
export async function closePairWindow(tunnel, { id = null } = {}, { timeoutMs = 3000 } = {}) {
  const reqId = id ?? 920_000 + Math.floor(Math.random() * 1000);
  tunnel.send({ t: 'req', id: reqId, method: 'POST', path: '/api/v2/pair/close', headers: { 'content-type': 'application/json; charset=utf-8' } });
  return await collectTunnel(tunnel, reqId, { timeoutMs });
}

/** 收集中继对 home 控制面请求的应答（res + chunk + end）。 */
export async function collectTunnel(tunnel, id, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  let headers = null;
  const chunks = [];
  for (;;) {
    const remain = deadline - Date.now();
    if (remain <= 0) throw new Error(`收集控制面应答 id=${id} 超时`);
    const frame = await tunnel.waitFrame((f) => f.id === id && ['res', 'chunk', 'end', 'abort'].includes(f.t), { timeoutMs: remain, what: `控制面应答 id=${id}` });
    tunnel.consume(frame);
    if (frame.t === 'res') {
      status = frame.status;
      headers = frame.headers;
    } else if (frame.t === 'chunk') {
      chunks.push(Buffer.from(frame.dataB64, 'base64'));
    } else if (frame.t === 'end') {
      break;
    } else if (frame.t === 'abort') {
      return { status, headers, body: Buffer.concat(chunks).toString('utf8'), json: null, aborted: frame.reason };
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null;
  try {
    json = text.trim() ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status, headers, body: text, json };
}

/**
 * 假网关：在 home 隧道上应答中继转发来的 `req`。
 * @param {object} tunnel TunnelClient（home 角色）
 * @param {Record<string, any>} routes 形如 `{'POST /api/v2/pair/claim': {status, body}}` 或 `(frame, api) => void`
 */
export function createFakeGateway(tunnel, routes = {}) {
  const calls = [];
  /** 未应答的请求 id（测试里用于断言"中继确实转发了"） */
  const api = {
    res: (id, status, headers = {}) => tunnel.send({ t: 'res', id, status, headers }),
    chunk: (id, buf) => tunnel.send({ t: 'chunk', id, dataB64: Buffer.from(buf).toString('base64') }),
    end: (id) => tunnel.send({ t: 'end', id }),
    abort: (id, reason = 'internal') => tunnel.send({ t: 'abort', id, reason }),
    respond: (id, status, body, headers) => tunnel.respond(id, status, body, headers),
  };
  const onFrame = async (text) => {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.t !== 'req') return;
    calls.push(frame);
    // 路由匹配同时支持「带 query 的完整路径」与「去掉 query 的路径名」：
    // 测试里大量写 `routes['GET /api/v2/echo']` 而后端路径带 `?n=1`，只按完整路径匹配会得到一堆假 404。
    const pathname = String(frame.path).split(/[?#]/)[0];
    const handler = routes[`${frame.method} ${pathname}`] ?? routes[`${frame.method} ${frame.path}`] ?? routes[pathname] ?? routes[frame.path];
    if (!handler) {
      api.respond(frame.id, 404, { error: { code: 'not_found', message: `假网关没有 ${frame.method} ${frame.path}` } });
      return;
    }
    if (typeof handler === 'function') {
      await handler(frame, api);
      return;
    }
    const status = handler.status ?? 200;
    const body = handler.body === undefined ? '' : typeof handler.body === 'string' ? handler.body : JSON.stringify(handler.body);
    if (Array.isArray(handler.chunks)) {
      api.res(frame.id, status, handler.headers ?? { 'content-type': 'application/octet-stream' });
      for (const chunk of handler.chunks) api.chunk(frame.id, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      if (handler.end !== false) api.end(frame.id);
      return;
    }
    api.respond(frame.id, status, body, handler.headers);
  };
  tunnel.on('frame', (text) => void onFrame(text).catch(() => {}));
  return { calls, api };
}

/**
 * 一把搭好"PC 已注册 + home 在线 + 配对窗口已开 + 手机已配对 + device 隧道在线"的场景。
 * @param {import('node:test').TestContext} t
 * @param {{code?: string, overrides?: object, deviceId?: string, pairRoutes?: object}} [opts]
 */
export async function setupPairing(t, { code = '482913', overrides = {}, deviceId = '8f3c1a2b-1111-4222-8333-444455556666', gwRoutes = null } = {}) {
  const h = await startRelay(t, overrides);
  const registered = await h.registerHome({ homeName: 'DESKTOP-TEST' });
  const { tunnel: homeTunnel, ready: homeReady } = await h.openHomeTunnel(registered.json.homeToken);
  // 假网关先答 pair/claim（真实网关由 gateway-dev 实现，形状按契约 §2.3）。
  // 注意：**每个 deviceId 返回不同的 deviceToken** —— 否则两个设备共用一个摘要，
  // 注册表的 token 索引会互相覆盖，多路复用测试会得出错误结论。
  const gateway = createFakeGateway(homeTunnel, {
    'POST /api/v2/pair/claim': (frame, api) => {
      const body = frame.bodyB64 ? JSON.parse(Buffer.from(frame.bodyB64, 'base64').toString('utf8')) : {};
      const deviceId = String(body.deviceId ?? '');
      const token = `dshr_${deviceId.replace(/-/g, '').slice(0, 20)}_tunnel_token`;
      api.respond(frame.id, 200, {
        token,
        tokenId: `tok_${deviceId.replace(/-/g, '').slice(0, 8)}`,
        serverName: 'DESKTOP-TEST',
        expiresAt: null,
        relay: { deviceToken: token },
      });
    },
    ...(gwRoutes ?? {}),
  });
  const window = await declarePairWindow(homeTunnel, { code });
  const claim = await h.pairClaim({ code, deviceId });
  const deviceToken = claim.json?.relay?.deviceToken ?? null;
  const device = deviceToken ? await h.openDeviceTunnel(deviceToken) : { tunnel: null, ready: null };
  return { ...h, registered, homeId: registered.json.homeId, homeToken: registered.json.homeToken, homeTunnel, homeReady, gateway, window, claim, deviceToken, deviceTunnel: device.tunnel, deviceReady: device.ready, code, deviceId };
}

/** 再配一台设备（同一个配对窗口内可多次 claim，deviceId 不同即可）。 */
export async function pairAnotherDevice(h, { code, deviceId, deviceName = 'Xiaomi 14 Pro' } = {}) {
  const claim = await h.pairClaim({ code, deviceId, deviceName });
  if (claim.status !== 200) throw new Error(`第二个 device 配对失败：${claim.status} ${claim.text}`);
  const token = claim.json.relay.deviceToken;
  const { tunnel, ready } = await h.openDeviceTunnel(token);
  return { tunnel, ready, token, claim, deviceId };
}

/** 假网关：原样回显请求（用于多路复用/内容一致性断言）。 */
export function echoRoute(frame, api) {
  const body = frame.bodyB64 ? Buffer.from(frame.bodyB64, 'base64') : Buffer.alloc(0);
  api.respond(
    frame.id,
    200,
    JSON.stringify({ id: frame.id, method: frame.method, path: frame.path, auth: frame.headers.authorization ?? null, echo: body.toString('utf8') }),
  );
}

/** 假网关：只记录请求、不应答（用于制造"在途流"，测流数上限/掉线）。 */
export function holdRoute() {
  /* 故意不应答 */
}
