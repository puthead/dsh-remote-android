/**
 * HTTP 层测试（契约 §2）：/health 形状、home 注册与轮换、pair/claim 转发与失败码、
 * 设备令牌绑定/轮换、错误体、限速、以及 homes.json 热加载（运维用 CLI 注册后无需重启）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RelayRegistry } from '../lib/registry.mjs';
import { createFakeGateway, declarePairWindow, registerHomeToken, setupPairing, startRelay, waitFor } from './helpers.mjs';
import { openTunnel } from './ws-client.mjs';

/** 网关侧 pair/claim 响应（形状按契约 §2.3：token/tokenId/serverName/expiresAt + relay.deviceToken）。 */
function claimResponse(deviceToken, tokenId = 'tok_test') {
  return { token: deviceToken, tokenId, serverName: 'DESKTOP-TEST', expiresAt: null, relay: { deviceToken } };
}

test('GET /health：形状严格等于契约 §2.1（字段不多不少）', async (t) => {
  const h = await startRelay(t, { relayName: 'relay.example.com' });
  const res = await h.request('GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['apiVersion', 'devices', 'homes', 'ok', 'relayName', 'relayVersion', 'uptimeMs']);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.apiVersion, 2);
  assert.equal(res.json.relayVersion, '2.0.1');
  assert.equal(res.json.relayName, 'relay.example.com');
  assert.equal(res.json.homes, 0);
  assert.equal(res.json.devices, 0);
  assert.equal(typeof res.json.uptimeMs, 'number');

  await registerHomeToken(h);
  const after = await h.request('GET', '/health');
  assert.equal(after.json.homes, 1);
});

test('POST /api/v2/homes：relaySecret 校验、homeName 校验、一次性 homeToken', async (t) => {
  const h = await startRelay(t);

  const missingSecret = await h.request('POST', '/api/v2/homes', { body: { homeName: 'PC-1' } });
  assert.equal(missingSecret.status, 401);
  assert.equal(missingSecret.json.error.code, 'unauthorized');

  const wrongSecret = await h.request('POST', '/api/v2/homes', { body: { relaySecret: 'nope', homeName: 'PC-1' } });
  assert.equal(wrongSecret.status, 401);

  const noName = await h.request('POST', '/api/v2/homes', { body: { relaySecret: h.config.relaySecret, homeName: '   ' } });
  assert.equal(noName.status, 400);
  assert.equal(noName.json.error.code, 'bad_request');

  const ok = await h.request('POST', '/api/v2/homes', { body: { relaySecret: h.config.relaySecret, homeName: 'PC-1', gatewayVersion: '2.0.0' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json).sort(), ['homeId', 'homeToken', 'relayName']);
  assert.match(ok.json.homeId, /^home_/);
  assert.ok(ok.json.homeToken.length >= 32);
  assert.match(ok.headers['x-api-version'], /^2/);

  // 明文 homeToken 只在响应里出现一次：homes.json 里必须只有摘要
  const raw = await fs.readFile(h.config.homesFile, 'utf8');
  assert.ok(!raw.includes(ok.json.homeToken), 'homes.json 不得包含明文 homeToken');
});

test('POST /api/v2/homes：relaySecret 为空时允许注册（本机/内网调试模式）', async (t) => {
  const h = await startRelay(t, { relaySecret: '' });
  const res = await h.request('POST', '/api/v2/homes', { body: { homeName: 'PC-OPEN' } });
  assert.equal(res.status, 200, res.text);
});

test('POST /api/v2/pair/claim：非法入参 400、无窗口 404 home_not_found（契约 §2.3 失败表）', async (t) => {
  const h = await startRelay(t);

  const badCode = await h.pairClaim({ code: '12ab' });
  assert.equal(badCode.status, 400);
  assert.equal(badCode.json.error.code, 'bad_request');

  const badDevice = await h.pairClaim({ code: '482913', deviceId: 'NOT-A-UUID' });
  assert.equal(badDevice.status, 400);
  assert.match(badDevice.json.error.message, /UUID/);

  const noWindow = await h.pairClaim({ code: '482913' });
  assert.equal(noWindow.status, 404);
  assert.equal(noWindow.json.error.code, 'home_not_found');
});

test('POST /api/v2/pair/claim：窗口已开但 home 离线 → 503 home_offline', async (t) => {
  const h = await startRelay(t);
  const registered = await h.registerHome({ homeName: 'PC-OFFLINE' });
  const { tunnel } = await h.openHomeTunnel(registered.json.homeToken);
  await declarePairWindow(tunnel, { code: '482913' });
  tunnel.destroy();
  await waitFor(() => h.relay.stats().hub.homes === 0, { what: 'home 掉线' });

  const res = await h.pairClaim({ code: '482913' });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'home_offline');
  assert.match(res.json.error.message, /离线/);
});

test('POST /api/v2/pair/claim：成功 → 网关响应原样透出 + relay 块补 homeId/tunnelUrl/deviceToken；中继只存 sha256', async (t) => {
  const h = await startRelay(t);
  const registered = await h.registerHome({ homeName: 'PC-1' });
  const { tunnel } = await h.openHomeTunnel(registered.json.homeToken);
  const token = 'dshr_pair_token_0001abcdefghijklmnop';
  createFakeGateway(tunnel, { 'POST /api/v2/pair/claim': { status: 200, body: claimResponse(token, 'tok_7a1b') } });
  await declarePairWindow(tunnel, { code: '482913' });

  const res = await h.pairClaim({ code: '482913', deviceId: '8f3c1a2b-1111-4222-8333-444455556666', deviceName: 'Xiaomi 14' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.token, token, '网关字段原样透出（v1 兼容）');
  assert.equal(res.json.tokenId, 'tok_7a1b');
  assert.equal(res.json.serverName, 'DESKTOP-TEST');
  assert.equal(res.json.relay.homeId, registered.json.homeId, 'relay.homeId 由中继补');
  assert.equal(res.json.relay.deviceToken, token);
  assert.equal(res.json.relay.tunnelUrl, `ws://relay.test:${h.port}/api/v2/tunnel/device`, 'tunnelUrl 由中继补（PC 不需要知道自己的公网地址）');

  // 中继侧只存 sha256
  const raw = await fs.readFile(h.config.homesFile, 'utf8');
  assert.ok(!raw.includes(token), 'homes.json 不得包含明文 deviceToken');
  const { sha256Hex } = await import('../lib/util.mjs');
  assert.ok(raw.includes(sha256Hex(token)), 'homes.json 必须存 sha256(deviceToken)');

  // 拿到的 deviceToken 能建立 device 隧道
  const { tunnel: deviceTunnel, ready } = await h.openDeviceTunnel(token);
  assert.equal(ready.homeId, registered.json.homeId);
  assert.equal(ready.homeName, 'PC-1');
  assert.equal(ready.homeOnline, true);
  deviceTunnel.destroy();
  tunnel.destroy();
});

test('POST /api/v2/pair/claim：网关失败码原样透出（401 pairing_bad_code / 403 pairing_closed）', async (t) => {
  const h = await startRelay(t);
  const registered = await h.registerHome({ homeName: 'PC-1' });
  const { tunnel } = await h.openHomeTunnel(registered.json.homeToken);
  let status = 401;
  createFakeGateway(tunnel, {
    'POST /api/v2/pair/claim': (frame, api) => {
      api.respond(frame.id, status, { error: { code: status === 401 ? 'pairing_bad_code' : 'pairing_closed', message: status === 401 ? '配对码错误或已过期' : '配对未开启' } });
    },
  });
  await declarePairWindow(tunnel, { code: '482913' });

  const bad = await h.pairClaim({ code: '482913' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'pairing_bad_code');

  status = 403;
  const closed = await h.pairClaim({ code: '482913' });
  assert.equal(closed.status, 403);
  assert.equal(closed.json.error.code, 'pairing_closed');
  tunnel.destroy();
});

test('deviceToken 轮换：同一 deviceId 再次 claim → 旧令牌 401 且旧连接收到 notice{revoked}（§2.3）', async (t) => {
  const h = await startRelay(t);
  const registered = await h.registerHome({ homeName: 'PC-1' });
  const { tunnel: homeTunnel } = await h.openHomeTunnel(registered.json.homeToken);
  let counter = 0;
  createFakeGateway(homeTunnel, {
    'POST /api/v2/pair/claim': (frame, api) => {
      counter++;
      api.respond(frame.id, 200, claimResponse(`dshr_rotated_token_${counter}_abcdefghijk`, `tok_${counter}`));
    },
  });
  await declarePairWindow(homeTunnel, { code: '482913' });

  const deviceId = '8f3c1a2b-1111-4222-8333-444455556666';
  const first = await h.pairClaim({ code: '482913', deviceId });
  const firstToken = first.json.relay.deviceToken;
  const { tunnel: deviceTunnel } = await h.openDeviceTunnel(firstToken);

  const second = await h.pairClaim({ code: '482913', deviceId });
  const secondToken = second.json.relay.deviceToken;
  assert.notEqual(secondToken, firstToken);

  const notice = await deviceTunnel.waitFrame((frame) => frame.t === 'notice', { timeoutMs: 3000, what: 'revoked 通知' });
  assert.equal(notice.kind, 'revoked');
  await deviceTunnel.waitClose(3000);
  assert.equal(h.relay.stats().hub.devices, 0, '旧 device 连接必须被清理');

  await assert.rejects(
    () => openTunnel(`${h.wsUrl}/api/v2/tunnel/device`, { role: 'device', token: firstToken }),
    (err) => {
      assert.equal(err.status, 401);
      return true;
    },
  );
  const fresh = await h.openDeviceTunnel(secondToken);
  assert.equal(fresh.tunnel.open, true);
  fresh.tunnel.destroy();
  homeTunnel.destroy();
});

test('错误处理：未知路径 404、方法不允许 405、非 JSON 400、超限 413（统一错误体 §4.4）', async (t) => {
  const h = await startRelay(t, { limits: { maxBodyBytes: 4096 } });
  const notFound = await h.request('GET', '/api/v2/nope');
  assert.equal(notFound.status, 404);
  assert.deepEqual(Object.keys(notFound.json), ['error']);
  assert.equal(notFound.json.error.code, 'not_found');

  const wrongMethod = await h.request('GET', '/api/v2/homes');
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.json.error.message, /方法不允许/);

  const badJson = await h.request('POST', '/api/v2/homes', { body: '{ 不是 JSON', headers: { 'Content-Type': 'application/json' } });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, 'bad_request');

  const tooBig = await h.request('POST', '/api/v2/homes', { body: JSON.stringify({ homeName: 'x'.repeat(8192), relaySecret: h.config.relaySecret }) });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.json.error.code, 'payload_too_large');

  const stillAlive = await h.request('GET', '/health');
  assert.equal(stillAlive.status, 200, '错误请求不应影响服务');
});

test('限速：pair/claim 超频 → 429 rate_limited 且带 Retry-After', async (t) => {
  const h = await startRelay(t, { limits: { pairClaimPerMinute: 2 } });
  const first = await h.pairClaim({ code: '482913' });
  const second = await h.pairClaim({ code: '482913' });
  const third = await h.pairClaim({ code: '482913' });
  assert.equal(first.status, 404);
  assert.equal(second.status, 404);
  assert.equal(third.status, 429);
  assert.equal(third.json.error.code, 'rate_limited');
  assert.ok(Number(third.headers['retry-after']) >= 1);
});

test('homes.json 热加载：外部进程注册/轮换后，运行中的 relay 立即生效且断开失效连接', async (t) => {
  const h = await startRelay(t, { registryReloadIntervalMs: 200 });
  const registered = await h.registerHome({ homeName: 'PC-EXTERNAL' });
  const { tunnel: liveTunnel } = await h.openHomeTunnel(registered.json.homeToken);
  assert.equal(h.relay.stats().hub.homes, 1);

  // 模拟 `relay.mjs home-token`（另一个进程）轮换同一台 PC 的令牌
  const external = new RelayRegistry({ file: h.config.homesFile, logger: null });
  await external.load();
  const rotated = external.registerHome({ homeName: 'PC-EXTERNAL', gatewayVersion: 'cli' });
  await external.flush();
  assert.equal(rotated.homeId, registered.json.homeId);
  assert.notEqual(rotated.homeToken, registered.json.homeToken);

  // 无需重启：旧连接被断开、新令牌可用
  await liveTunnel.waitClose(5000);
  await waitFor(() => h.relay.stats().hub.homes === 0, { timeoutMs: 5000, what: '热加载后断开失效 home 连接' });
  const fresh = await h.openHomeTunnel(rotated.homeToken);
  assert.equal(fresh.tunnel.open, true);
  fresh.tunnel.destroy();

  await assert.rejects(
    () => openTunnel(`${h.wsUrl}/api/v2/tunnel/home`, { role: 'home', token: registered.json.homeToken }),
    (err) => {
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test('pipeline：注册 → 声明窗口 → claim → device 隧道 → 经隧道拿到业务响应（端到端串联）', async (t) => {
  const h = await startRelay(t);
  const registered = await h.registerHome({ homeName: 'PC-E2E' });
  const homeTunnel = await h.openHomeTunnel(registered.json.homeToken);
  createFakeGateway(homeTunnel.tunnel, {
    'POST /api/v2/pair/claim': (frame, api) => {
      const body = JSON.parse(Buffer.from(frame.bodyB64, 'base64').toString('utf8'));
      assert.equal(body.code, '482913');
      assert.equal(body.deviceId, '8f3c1a2b-1111-4222-8333-444455556666');
      api.respond(frame.id, 200, claimResponse('dshr_e2e_token_0001'));
    },
    'GET /api/v2/sessions': (frame, api) => {
      assert.equal(frame.headers.authorization, 'Bearer dshr_e2e_token_0001', '网关必须收到原样的 Authorization');
      api.respond(frame.id, 200, { sessions: [{ id: 'session-1', title: '远程控制台开发' }], nextCursor: null });
    },
  });
  assert.equal((await declarePairWindow(homeTunnel.tunnel, { code: '482913' })).status, 200);

  const claim = await h.pairClaim({ code: '482913' });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.relay.homeId, registered.json.homeId);
  assert.equal(claim.json.relay.tunnelUrl, `ws://relay.test:${h.port}/api/v2/tunnel/device`);

  const device = await h.openDeviceTunnel(claim.json.relay.deviceToken);
  const res = await device.tunnel.roundTrip({
    id: 1,
    method: 'GET',
    path: '/api/v2/sessions?limit=10',
    headers: { authorization: `Bearer ${claim.json.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).sessions[0].title, '远程控制台开发', '中文必须原样透传');
  device.tunnel.destroy();
  homeTunnel.tunnel.destroy();
});

test('relayName 与 tunnelUrl 推导：publicUrl 优先、wss 端口省略（运维部署口径）', async (t) => {
  const h = await startRelay(t, { publicUrl: 'https://relay.example.com' });
  const registered = await h.registerHome({ homeName: 'PC-1' });
  const { tunnel } = await h.openHomeTunnel(registered.json.homeToken);
  createFakeGateway(tunnel, { 'POST /api/v2/pair/claim': { status: 200, body: claimResponse('dshr_public_url_token_0001') } });
  await declarePairWindow(tunnel, { code: '482913' });
  const res = await h.pairClaim({ code: '482913' });
  assert.equal(res.json.relay.tunnelUrl, 'wss://relay.example.com/api/v2/tunnel/device');
  tunnel.destroy();
});

test('setupPairing 脚手架自检：避免"测试脚手架坏了导致全部用例假通过"', async (t) => {
  const h = await setupPairing(t);
  assert.equal(h.claim.status, 200, h.claim.text);
  assert.ok(h.deviceTunnel, 'device 隧道必须建立');
  assert.equal(h.deviceReady.homeOnline, true);
  assert.equal(h.relay.stats().hub.homes, 1);
  assert.equal(h.relay.stats().hub.devices, 1);
  assert.equal(h.relay.stats().registry.devices, 1);
  const raw = await fs.readFile(h.config.homesFile, 'utf8');
  assert.ok(!raw.includes(h.deviceToken));
  assert.equal(h.window.status, 200);
  void path;
});
