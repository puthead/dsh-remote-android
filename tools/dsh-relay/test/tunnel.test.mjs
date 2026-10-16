/**
 * 隧道层测试（契约 §3）：多路复用 / id 重映射 / 并发 / 背压 / 掉线 / 越权 / 控制面。
 *
 * 全部走**真实 TCP + 真实 WS**，home 与 device 都是本文件里的隧道客户端，
 * 中继侧不做任何 mock —— 因为这一层最容易出的错就是"两端各自以为对"的多路复用与背压语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePairWindow, collectTunnel, createFakeGateway, declarePairWindow, echoRoute, holdRoute, pairAnotherDevice, queryPairWindow, setupPairing, sleep, startRelay, waitFor } from './helpers.mjs';
import { openTunnel } from './ws-client.mjs';

/** 造一个指定大小的响应体（含中文，验证 UTF-8 透传不损坏）。 */
function payload(size, marker = '块') {
  const unit = Buffer.from(`${marker}`, 'utf8');
  const times = Math.ceil(size / unit.length);
  return Buffer.concat(Array.from({ length: times }, () => unit)).subarray(0, size);
}

test('id 重映射：两台 device 都用 id=1，home 侧看到两个不同的 id，响应各自回填原 id', async (t) => {
  const h = await setupPairing(t, { gwRoutes: { 'GET /api/v2/echo': echoRoute } });
  const second = await pairAnotherDevice(h, { code: h.code, deviceId: 'aaaabbbb-1111-4222-8333-444455556666' });

  h.deviceTunnel.request({ id: 1, method: 'GET', path: '/api/v2/echo?who=A', headers: { authorization: 'Bearer device-A' } });
  second.tunnel.request({ id: 1, method: 'GET', path: '/api/v2/echo?who=B', headers: { authorization: 'Bearer device-B' } });

  const [resA, resB] = await Promise.all([h.deviceTunnel.collect(1), second.tunnel.collect(1)]);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  const jsonA = JSON.parse(resA.text);
  const jsonB = JSON.parse(resB.text);
  assert.equal(jsonA.path, '/api/v2/echo?who=A');
  assert.equal(jsonB.path, '/api/v2/echo?who=B');
  assert.equal(jsonA.auth, 'Bearer device-A');
  assert.equal(jsonB.auth, 'Bearer device-B');
  assert.notEqual(jsonA.id, jsonB.id, 'home 连接上两条流必须拿到不同 id（避免两台手机撞号）');

  // 两台 device 看到的流 id 都是自己发的 1（中继回填原 id）
  assert.equal(Number.isInteger(jsonA.id), true);
  second.tunnel.destroy();
});

test('多路复用：同一连接 20 个并发流全部正确结束，且 home 侧 id 单调递增', async (t) => {
  const h = await setupPairing(t, {
    gwRoutes: {
      'GET /api/v2/echo': async (frame, api) => {
        // 随机小延迟：制造乱序完成，验证"响应按 id 归属"而不是按到达顺序
        await sleep(Math.floor(Math.random() * 30));
        echoRoute(frame, api);
      },
    },
  });

  const ids = Array.from({ length: 20 }, (_, i) => i + 1);
  for (const id of ids) h.deviceTunnel.request({ id, method: 'GET', path: `/api/v2/echo?n=${id}`, headers: {} });
  const results = await Promise.all(ids.map((id) => h.deviceTunnel.collect(id)));
  for (const [index, res] of results.entries()) {
    assert.equal(res.status, 200, `第 ${index + 1} 条流状态异常：${res.text}`);
    const json = JSON.parse(res.text);
    assert.equal(json.path, `/api/v2/echo?n=${ids[index]}`, '响应必须回到发起它的那条流');
  }
  const forwarded = h.gateway.calls.filter((call) => call.path.startsWith('/api/v2/echo'));
  assert.equal(forwarded.length, 20);
  const seen = forwarded.map((call) => call.id);
  assert.equal(new Set(seen).size, 20, 'home 侧 id 必须互不相同');
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `home 侧 id 应单调递增：${seen.join(',')}`);
  await waitFor(() => h.relay.stats().hub.streams === 0, { what: '所有流结束' });
});

test('数据透传：大响应分片拼回后字节完全一致（含中文与二进制）', async (t) => {
  const body = Buffer.concat([payload(300_000, '中文数据'), Buffer.from([0, 1, 2, 255, 254])]);
  const h = await setupPairing(t, {
    gwRoutes: {
      'GET /api/v2/big': (frame, api) => {
        api.res(frame.id, 200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
        for (let offset = 0; offset < body.length; offset += 32_768) api.chunk(frame.id, body.subarray(offset, offset + 32_768));
        api.end(frame.id);
      },
    },
  });
  const res = await h.deviceTunnel.roundTrip({ id: 7, path: '/api/v2/big', timeoutMs: 10_000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, body.length);
  assert.ok(res.body.equals(body), '分片重组后的字节必须与原始响应体逐字节一致');
});

test('chunk 上限：单条 chunk 解码后 > maxChunkBytes → abort overflow，且向上游发 cancel（§3.2）', async (t) => {
  const h = await setupPairing(t, {
    overrides: { limits: { maxChunkBytes: 4096 } },
    gwRoutes: {
      'GET /api/v2/too-big': (frame, api) => {
        api.res(frame.id, 200, { 'content-type': 'application/octet-stream' });
        api.chunk(frame.id, Buffer.alloc(8192, 0x41)); // 超过 4096 上限
        api.end(frame.id);
      },
    },
  });
  const res = await h.deviceTunnel.roundTrip({ id: 3, path: '/api/v2/too-big' });
  assert.equal(res.aborted, 'overflow', `期望 abort overflow，实际：${JSON.stringify(res)}`);
  const cancel = await h.homeTunnel.waitFrame((frame) => frame.t === 'cancel', { timeoutMs: 2000, what: 'home 收到的 cancel' });
  assert.equal(cancel.id, h.gateway.calls.at(-1).id, 'cancel 必须指向 home 连接上的那条流 id');
  assert.ok(h.relay.stats().hub.overflows >= 1);
  await waitFor(() => h.relay.stats().hub.streams === 0, { what: '流被清理' });
});

test('单流缓冲上限：device 不读导致缓冲 > maxStreamBufferBytes → abort overflow（§3.2）', async (t) => {
  const h = await setupPairing(t, {
    // 关掉"连接级背压"以便精确命中"单流缓冲"这条规则
    overrides: { limits: { maxStreamBufferBytes: 8192, backpressureBytes: 64 * 1024 * 1024 } },
    gwRoutes: {
      'GET /api/v2/flood': (frame, api) => {
        api.res(frame.id, 200, { 'content-type': 'application/octet-stream' });
        for (let i = 0; i < 20; i++) api.chunk(frame.id, Buffer.alloc(16_384, 0x42));
        api.end(frame.id);
      },
    },
  });
  h.deviceTunnel.pause(); // 不读 → 中继写缓冲堆积
  h.deviceTunnel.request({ id: 5, path: '/api/v2/flood' });
  await waitFor(() => h.relay.stats().hub.overflows >= 1, { timeoutMs: 5000, what: '单流缓冲溢出' });
  await waitFor(() => h.relay.stats().hub.streams === 0, { timeoutMs: 5000, what: '溢出后流被清理' });
  h.deviceTunnel.resume();
  const abort = await h.deviceTunnel.waitFrame((frame) => frame.t === 'abort' && frame.id === 5, { timeoutMs: 5000, what: 'abort 帧' });
  assert.equal(abort.reason, 'overflow');
});

test('背压：device 不读 → 中继暂停读取 home 连接；恢复读取后数据继续送达（§3.2）', async (t) => {
  const total = 64;
  const chunkSize = 32_768;
  const h = await setupPairing(t, {
    overrides: { limits: { backpressureBytes: 131_072, maxStreamBufferBytes: 8 * 1024 * 1024 } },
    gwRoutes: {
      'GET /api/v2/stream': (frame, api) => {
        api.res(frame.id, 200, { 'content-type': 'application/octet-stream' });
        for (let i = 0; i < total; i++) api.chunk(frame.id, Buffer.alloc(chunkSize, i & 0xff));
        api.end(frame.id);
      },
    },
  });

  h.deviceTunnel.pause();
  h.deviceTunnel.request({ id: 11, path: '/api/v2/stream' });
  const stats = await waitFor(() => {
    const s = h.relay.stats().hub;
    return s.backpressurePauses >= 1 && s.paused >= 1 ? s : null;
  }, { timeoutMs: 8000, what: '触发背压暂停' });
  assert.ok(stats.backpressurePauses >= 1, '中继必须因 bufferedAmount 超阈值暂停读 home');

  h.deviceTunnel.resume();
  const res = await h.deviceTunnel.collect(11, { timeoutMs: 15_000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, total * chunkSize, '恢复读取后必须把全部数据送达（背压只暂停、不丢数据）');
  await waitFor(() => h.relay.stats().hub.paused === 0, { timeoutMs: 5000, what: '背压解除' });
});

test('流数上限：超过 maxStreamsPerConnection → 429 too_many_streams（§3.5）', async (t) => {
  const h = await setupPairing(t, {
    overrides: { limits: { maxStreamsPerConnection: 3 } },
    gwRoutes: { 'GET /api/v2/hold': holdRoute, 'GET /api/v2/quick': echoRoute },
  });
  for (const id of [1, 2, 3]) h.deviceTunnel.request({ id, path: '/api/v2/hold' });
  await waitFor(() => h.relay.stats().hub.streams === 3, { what: '3 条在途流' });

  const res = await h.deviceTunnel.roundTrip({ id: 4, path: '/api/v2/hold' });
  assert.equal(res.status, 429);
  assert.equal(JSON.parse(res.text).error.code, 'too_many_streams');
  assert.equal(h.gateway.calls.filter((call) => call.path === '/api/v2/hold').length, 3, '被拒的请求不得转发到 home');

  // 释放一条后必须能再发起（上限是"在途数量"，不是总配额）
  const firstCall = h.gateway.calls.find((call) => call.path === '/api/v2/hold');
  h.homeTunnel.respond(firstCall.id, 200, '{"ok":true}');
  const first = await h.deviceTunnel.collect(1);
  assert.equal(first.status, 200);
  const again = await h.deviceTunnel.roundTrip({ id: 5, path: '/api/v2/quick?after=slot-free' });
  assert.equal(again.status, 200, `释放槽位后应可继续请求，实际 ${again.status} ${again.text}`);
  assert.equal(JSON.parse(again.text).path, '/api/v2/quick?after=slot-free');
});

test('abort.reason 严格六值（lead 裁定）：合法值透出，越界值一律归一为 internal（防御）', async (t) => {
  const h = await setupPairing(t, {
    gwRoutes: {
      'GET /api/v2/canceled': (frame, api) => api.abort(frame.id, 'canceled'),
      'GET /api/v2/timeout': (frame, api) => api.abort(frame.id, 'timeout'),
      'GET /api/v2/overflow': (frame, api) => api.abort(frame.id, 'overflow'),
      'GET /api/v2/invented': (frame, api) => api.abort(frame.id, 'gateway_error:ECONNREFUSED'),
      'GET /api/v2/nonenum': (frame, api) => api.abort(frame.id, 'too_many_streams'),
    },
  });
  for (const [pathname, expected] of [
    ['/api/v2/canceled', 'canceled'],
    ['/api/v2/timeout', 'timeout'],
    ['/api/v2/overflow', 'overflow'],
  ]) {
    const res = await h.deviceTunnel.roundTrip({ id: 61, path: pathname });
    assert.equal(res.aborted, expected, `${pathname}：${JSON.stringify(res)}`);
  }
  // 契约 §3.5 的六值是**枚举**：网关不得发明 reason（业务失败原因走 HTTP 状态码 + 响应体），
  // 中继把越界值归一为 internal —— 这是防御（不让协议因对端越界而崩），不是正常路径。
  for (const pathname of ['/api/v2/invented', '/api/v2/nonenum']) {
    const res = await h.deviceTunnel.roundTrip({ id: 62, path: pathname });
    assert.equal(res.aborted, 'internal', `${pathname} 越界 reason 必须归一为 internal：${JSON.stringify(res)}`);
  }
});

test('路径规范化绕过（R2 审计发现的真绕过）：dot-segment / 百分号编码不得绕过管理面黑名单', async (t) => {
  // 真实绕过（修复前实测）：GET /x/../api/v2/relay/status → 200（拿到 PC 的 relay 状态）。
  // 根因：中继按**字面路径**判定，而网关用 new URL() 折叠 `..`/`%2e%2e` 后再打本机 HTTP。
  // 修复：中继按规范化后的 pathname 判定（见 normalizePathname）。
  const h = await setupPairing(t, { gwRoutes: { 'GET /api/v1/health': (frame, api) => api.respond(frame.id, 200, '{"ok":true}') } });
  /** 规范化后**落在管理面**的写法：必须 403。 */
  const mustBlock = [
    ['GET', '/x/../api/v2/relay/status'], // 修复前 → 200（真绕过）
    ['GET', '/%2e%2e/api/v2/relay/status'], // 修复前 → 200（百分号编码的点）
    ['GET', '/health/../api/v2/homes'],
    ['GET', '/api/v2/tunnel/../../api/v2/relay/status'], // 字面命中 tunnel 前缀
    ['GET', '/api/v2/relay/%2e%2e/relay/status'],
    ['GET', '/x/../api/v2/pair/window'],
    ['GET', '/x/../api/v1/pair/open'],
    ['POST', '/a/b/../../../api/v2/pair/open'],
  ];
  const before = h.gateway.calls.length;
  let id = 700;
  for (const [method, p] of mustBlock) {
    const res = await h.deviceTunnel.roundTrip({ id: id++, method, path: p, body: method === 'POST' ? {} : null });
    assert.equal(res.status, 403, `${method} ${p} 必须被拒：${res.status} ${res.text}`);
  }
  // 协议相对路径直接 400（不进 URL 解析的灰色地带）
  const protoRelative = await h.deviceTunnel.roundTrip({ id: id++, method: 'GET', path: '//evil.example/api/v2/relay/status' });
  assert.equal(protoRelative.status, 400, `//host 形式必须 400：${protoRelative.status} ${protoRelative.text}`);

  // 有些写法规范化后并不落在管理面（例如 `/api/v1/../api/v2/...` → `/api/api/v2/...`，无害 404）。
  // 真正要守的不变量是：**没有任何请求以管理面路径到达 home**。
  const odd = await h.deviceTunnel.roundTrip({ id: id++, method: 'GET', path: '/api/v1/../api/v2/relay/status' });
  assert.notEqual(odd.status, 200, `可疑写法不得成功：${odd.status} ${odd.text}`);
  const isManagement = (p) => {
    const n = new URL(p, 'http://relay.invalid').pathname;
    return n === '/health' || n === '/api/v2/homes' || n.startsWith('/api/v2/relay/') || n === '/api/v2/pair/open' || n === '/api/v2/pair/window' || n === '/api/v2/pair/close' || n === '/api/v1/pair/open';
  };
  const landed = h.gateway.calls.slice(before).filter((call) => isManagement(String(call.path)));
  assert.equal(landed.length, 0, `任何写法都不得把管理面路径送到 home：${JSON.stringify(landed)}`);
  assert.ok(h.relay.stats().hub.deviceForbidden >= mustBlock.length, '统计里应记录这些拒绝');
});

test('控制面路径同样规范化：/api/v2/pair/./window 命中白名单，越界写法仍 404', async (t) => {
  const h = await startRelay(t);
  const registered = await h.registerHome({ homeName: 'DESKTOP-TEST' });
  const { tunnel } = await h.openHomeTunnel(registered.json.homeToken);

  tunnel.send({
    t: 'req',
    id: 880_002,
    method: 'POST',
    path: '/api/v2/pair/./window',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    bodyB64: Buffer.from(JSON.stringify({ code: '654321' }), 'utf8').toString('base64'),
  });
  const opened = await collectTunnel(tunnel, 880_002, { timeoutMs: 3000 });
  assert.equal(opened.status, 200, `规范化后应命中控制面白名单：${opened.status} ${opened.body}`);

  tunnel.send({ t: 'req', id: 880_003, method: 'GET', path: '/x/../health', headers: {} });
  const rejected = await collectTunnel(tunnel, 880_003, { timeoutMs: 3000 });
  assert.equal(rejected.status, 404, `规范化后仍越界的一律 404：${rejected.status} ${rejected.body}`);
  tunnel.destroy();
});

test('经隧道配对：v1/v2 pair/claim 恒注入 relay 块，且新令牌能建立 device 隧道（lead 裁定）', async (t) => {
  // 背景：老 App 经隧道配对时拿不到 relay 块 → 拿不到 tunnelUrl → 无法建设备隧道（gateway-dev 真联调发现）。
  // 裁定：经隧道的 /api/v1/pair/claim 与 /api/v2/pair/claim 响应**恒有** relay 块；
  //       直连 /api/v1/pair/claim 响应体逐字不变（v1 兼容铁律，由网关保证，中继不参与该路径）。
  let counter = 0;
  const h = await setupPairing(t, {
    gwRoutes: {
      'POST /api/v1/pair/claim': (frame, api) => {
        counter++;
        // 模拟真实网关的 v1 响应：**没有** relay 块
        api.respond(frame.id, 200, JSON.stringify({ token: `dshr_v1_token_${counter}_abcdefghij`, tokenId: `tok_v1_${counter}`, serverName: 'DESKTOP-TEST', expiresAt: null }));
      },
      'POST /api/v2/pair/claim': (frame, api) => {
        counter++;
        // v2 响应自带 relay.deviceToken（网关生成），但没有 homeId/tunnelUrl
        api.respond(frame.id, 200, JSON.stringify({ token: `dshr_v2_token_${counter}_abcdefghij`, tokenId: `tok_v2_${counter}`, relay: { deviceToken: `dshr_v2_token_${counter}_abcdefghij` } }));
      },
      'POST /api/v2/pair/fail': (frame, api) => api.respond(frame.id, 401, JSON.stringify({ error: { code: 'pairing_bad_code', message: '码错' } })),
    },
  });

  for (const [path, tag, deviceId] of [
    ['/api/v1/pair/claim', 'v1', '9f3c1a2b-1111-4222-8333-444455556666'],
    ['/api/v2/pair/claim', 'v2', '9f3c1a2b-2222-4222-8333-444455556666'],
  ]) {
    // 每条路径用**独立的手机连接**：新令牌建立的新隧道会替换同 deviceId 的旧连接（§2.3），
    // 复用同一条隧道会让下一条断言拿到 revoked。
    const phone = await pairAnotherDevice(h, { code: h.code, deviceId });
    const res = await phone.tunnel.roundTrip({
      id: tag === 'v1' ? 201 : 202,
      method: 'POST',
      path,
      body: { code: '482913', deviceName: 'Legacy Phone', deviceId },
    });
    assert.equal(res.status, 200, `${path} 应成功：${res.text}`);
    const json = JSON.parse(res.text);
    assert.ok(json.relay, `${path} 响应必须带 relay 块（老 App 靠它拿 tunnelUrl）：${res.text}`);
    assert.equal(json.relay.homeId, h.homeId, `${path} relay.homeId 必须是中继知道的 homeId`);
    assert.equal(json.relay.apiVersion, 2, `${path} relay.apiVersion 必须是 2`);
    assert.match(json.relay.tunnelUrl, /\/api\/v2\/tunnel\/device$/, `${path} relay.tunnelUrl 必须是设备隧道地址`);
    assert.equal(json.relay.deviceToken, json.token, `${path} relay.deviceToken 应与网关签发的一致`);
    // 最关键的一条：注入后拿到的令牌必须真能建立 device 隧道（否则"注入"只是好看）
    const { tunnel, ready } = await h.openDeviceTunnel(json.relay.deviceToken);
    assert.equal(ready.homeId, h.homeId, `${path} 新令牌必须能建立隧道`);
    tunnel.destroy();
    phone.tunnel.destroy();
  }

  // 非 200：原样透出，**不得**注入 relay 块（错误语义归网关）
  const errPhone = await pairAnotherDevice(h, { code: h.code, deviceId: '9f3c1a2b-3333-4222-8333-444455556666' });
  const failed = await errPhone.tunnel.roundTrip({ id: 203, method: 'POST', path: '/api/v2/pair/fail', body: {} });
  assert.equal(failed.status, 401, failed.text);
  assert.equal(JSON.parse(failed.text).error.code, 'pairing_bad_code');
  assert.equal(JSON.parse(failed.text).relay, undefined, '失败响应不得被注入 relay 块');
  errPhone.tunnel.destroy();
  assert.ok(h.relay.stats().hub.pairClaimInjected >= 2, '统计里应记录注入次数');
});

test('home 掉线：device 收到 notice{home_offline}，在途流 abort，后续请求 503（§3.5/§6 判据 D）', async (t) => {
  const h = await setupPairing(t, { gwRoutes: { 'GET /api/v2/echo': echoRoute, 'GET /api/v2/hold': holdRoute } });
  h.deviceTunnel.request({ id: 21, path: '/api/v2/hold' });
  await waitFor(() => h.relay.stats().hub.streams === 1, { what: '在途流建立' });

  h.homeTunnel.destroy(); // 模拟 PC 掉线
  const notice = await h.deviceTunnel.waitFrame((frame) => frame.t === 'notice' && frame.kind === 'home_offline', { timeoutMs: 3000, what: 'home_offline 通知' });
  assert.equal(notice.homeId, h.homeId);
  const abort = await h.deviceTunnel.waitFrame((frame) => frame.t === 'abort' && frame.id === 21, { timeoutMs: 3000, what: '在途流 abort' });
  assert.equal(abort.reason, 'home_offline');

  const offline = await h.deviceTunnel.roundTrip({ id: 22, path: '/api/v2/echo' });
  assert.equal(offline.status, 503, `离线请求应回 503，实际 ${offline.status} ${offline.text}`);
  assert.equal(JSON.parse(offline.text).error.code, 'home_offline');
  assert.equal(h.deviceTunnel.open, true, 'device 隧道本身保持在线（只显示"电脑离线"）');
});

test('home 重新上线：device 收到 notice{home_online} 且请求恢复', async (t) => {
  const h = await setupPairing(t, { gwRoutes: { 'GET /api/v2/echo': echoRoute } });
  h.homeTunnel.destroy();
  await h.deviceTunnel.waitFrame((frame) => frame.t === 'notice' && frame.kind === 'home_offline', { timeoutMs: 3000 });

  const { tunnel: homeAgain } = await h.openHomeTunnel(h.homeToken);
  // 新连接需要重新挂假网关（旧客户端的监听器随旧连接一起废弃）
  createFakeGateway(homeAgain, { 'GET /api/v2/echo': echoRoute });
  const online = await h.deviceTunnel.waitFrame((frame) => frame.t === 'notice' && frame.kind === 'home_online', { timeoutMs: 3000, what: 'home_online 通知' });
  assert.equal(online.homeId, h.homeId);

  const res = await h.deviceTunnel.roundTrip({ id: 31, path: '/api/v2/echo?after=reconnect' });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).path, '/api/v2/echo?after=reconnect');
  homeAgain.destroy();
});

test('越权拒绝：device 不得借隧道访问中继/网管端点（403 forbidden）', async (t) => {
  const h = await setupPairing(t, { gwRoutes: { 'GET /api/v2/echo': echoRoute } });
  // 只拦"真正的管理面"。这份名单经两轮真互操作纠正：
  // ① 第一版拦了整个 /api/v1/ → 破坏 v1 契约「task 端点全部保留」；
  // ② 第二版拦了整个 /api/v2/pair/ → 与 lead 裁定冲突（经隧道 pair/claim 必须放行以便注入 relay 块）。
  const forbidden = [
    ['POST', '/api/v2/homes'],
    ['GET', '/health'],
    ['POST', '/api/v2/pair/open'],
    ['POST', '/api/v2/pair/window'],
    ['GET', '/api/v2/pair/window'],
    ['POST', '/api/v2/pair/close'],
    ['POST', '/api/v2/relay/connect'],
    ['GET', '/api/v2/relay/status'],
    ['POST', '/api/v2/relay/disconnect'],
    ['POST', '/api/v1/pair/open'],
    ['GET', '/api/v2/tunnel/device'],
  ];
  // 只检查这些越权请求**之后**新增的转发：setupPairing 自己那次 pair/claim 转发是合法的
  const callsBefore = h.gateway.calls.length;
  let id = 100;
  for (const [method, path] of forbidden) {
    const res = await h.deviceTunnel.roundTrip({ id: id++, method, path, body: method === 'POST' ? {} : null });
    assert.equal(res.status, 403, `${method} ${path} 应被拒，实际 ${res.status} ${res.text}`);
    assert.equal(JSON.parse(res.text).error.code, 'forbidden');
  }
  assert.ok(h.relay.stats().hub.deviceForbidden >= forbidden.length);
  const forbiddenPaths = new Set(forbidden.map(([, path]) => path));
  const leaked = h.gateway.calls.slice(callsBefore).filter((call) => forbiddenPaths.has(String(call.path).split(/[?#]/)[0]));
  assert.equal(leaked.length, 0, `被拒请求不得到达 home：${JSON.stringify(leaked)}`);

  // 正常业务路径不受影响
  const ok = await h.deviceTunnel.roundTrip({ id: 999, path: '/api/v2/echo?ok=1' });
  assert.equal(ok.status, 200);
});

test('v1 兼容性（R2 互操作回归）：/api/v1/* 业务端点必须能经隧道到达 home', async (t) => {
  const h = await setupPairing(t, {
    gwRoutes: {
      'GET /api/v1/health': (frame, api) => api.respond(frame.id, 200, '{"ok":true,"apiVersion":1}'),
      'GET /api/v1/tasks': (frame, api) => api.respond(frame.id, 200, '{"tasks":[],"nextCursor":null}'),
      'POST /api/v1/tasks': (frame, api) => api.respond(frame.id, 201, '{"id":"task_1"}'),
      'GET /api/v1/workspaces': (frame, api) => api.respond(frame.id, 200, '{"workspaces":[]}'),
      'DELETE /api/v1/devices/tok_1': (frame, api) => api.respond(frame.id, 204, ''),
    },
  });
  const cases = [
    ['GET', '/api/v1/health', 200],
    ['GET', '/api/v1/tasks?status=all&limit=5', 200],
    ['POST', '/api/v1/tasks', 201],
    ['GET', '/api/v1/workspaces', 200],
    ['DELETE', '/api/v1/devices/tok_1', 204],
  ];
  let id = 500;
  for (const [method, path, expected] of cases) {
    const res = await h.deviceTunnel.roundTrip({ id: id++, method, path, body: method === 'POST' ? { prompt: 'x' } : null });
    assert.equal(res.status, expected, `${method} ${path} 必须转发到 home（实际 ${res.status} ${res.text}）`);
  }
  // 归一化到 pathname 再比较（不能拿"去掉 query 的记录"去比"带 query 的期望"——那必然不等）
  const forwarded = h.gateway.calls.map((call) => String(call.path).split(/[?#]/)[0]);
  for (const [, path] of cases) {
    const pathname = path.split(/[?#]/)[0];
    assert.ok(forwarded.includes(pathname), `${pathname} 必须出现在 home 收到的请求里：${forwarded.join(',')}`);
  }
  // query 必须原样透传（分页/过滤参数全靠它）
  const withQuery = h.gateway.calls.map((call) => String(call.path)).find((path) => path.startsWith('/api/v1/tasks?'));
  assert.equal(withQuery, '/api/v1/tasks?status=all&limit=5', `query 必须逐字透传，实际：${withQuery}`);
});

test('取消传播：device cancel → home 收到 cancel；device 断开 → home 收到 cancel（SSE 必须能停）', async (t) => {
  const h = await setupPairing(t, {
    gwRoutes: { 'GET /api/v2/hold': holdRoute },
  });
  h.deviceTunnel.request({ id: 41, path: '/api/v2/hold' });
  const forwarded = await waitFor(() => h.gateway.calls.find((call) => call.path === '/api/v2/hold'), { what: '请求被转发' });

  h.deviceTunnel.send({ t: 'cancel', id: 41 });
  const cancel = await h.homeTunnel.waitFrame((frame) => frame.t === 'cancel' && frame.id === forwarded.id, { timeoutMs: 3000, what: 'home 收到 cancel' });
  assert.equal(cancel.id, forwarded.id);
  const abort = await h.deviceTunnel.waitFrame((frame) => frame.t === 'abort' && frame.id === 41, { timeoutMs: 3000 });
  assert.equal(abort.reason, 'canceled');
  await waitFor(() => h.relay.stats().hub.streams === 0, { what: '流被清理' });

  // device 直接断开：在途流也必须向上游发 cancel
  h.gateway.calls.length = 0;
  const second = await pairAnotherDevice(h, { code: h.code, deviceId: 'ccccdddd-1111-4222-8333-444455556666' });
  second.tunnel.request({ id: 42, path: '/api/v2/hold' });
  const forwarded2 = await waitFor(() => h.gateway.calls.find((call) => call.path === '/api/v2/hold'), { what: '第二条流被转发' });
  second.tunnel.destroy();
  const cancel2 = await h.homeTunnel.waitFrame((frame) => frame.t === 'cancel' && frame.id === forwarded2.id, { timeoutMs: 3000, what: '断开后 home 收到 cancel' });
  assert.equal(cancel2.id, forwarded2.id);
  await waitFor(() => h.relay.stats().hub.devices === 1, { what: 'device 被清理' });
});

test('控制面 §3.4：home 反向调用只允许三条路由，未命中一律拒绝（含中继对外端点）', async (t) => {
  const h = await startRelay(t);
  const registered = await h.registerHome({ homeName: 'DESKTOP-TEST' });
  const { tunnel } = await h.openHomeTunnel(registered.json.homeToken);

  const opened = await declarePairWindow(tunnel, { code: '135790' });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.code, '135790');
  assert.ok(opened.json.expiresAt > Date.now());

  const queried = await queryPairWindow(tunnel);
  assert.equal(queried.status, 200);
  assert.deepEqual(Object.keys(queried.json).sort(), ['expiresAt', 'open']);
  assert.equal(queried.json.open, true);
  assert.ok(!JSON.stringify(queried.json).includes('135790'), 'GET window 不回显配对码本身');

  const closed = await closePairWindow(tunnel);
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.json, { open: false });
  assert.deepEqual((await queryPairWindow(tunnel)).json, { open: false, expiresAt: null });

  // home 借隧道访问中继的对外管理端点：必须被拒（lead 明确要求 + 契约 §3.4）
  tunnel.send({ t: 'req', id: 999_001, method: 'POST', path: '/api/v2/homes', headers: {} });
  const homes = await collectTunnel(tunnel, 999_001, { timeoutMs: 3000 });
  assert.equal(homes.status, 404, `home 不得访问 /api/v2/homes，实际 ${homes.status} ${homes.body}`);
  assert.equal(homes.json.error.code, 'not_found');

  tunnel.send({ t: 'req', id: 999_002, method: 'GET', path: '/health', headers: {} });
  const health = await collectTunnel(tunnel, 999_002, { timeoutMs: 3000 });
  assert.equal(health.status, 404, `home 不得访问 /health，实际 ${health.status} ${health.body}`);
  assert.equal(health.json.error.code, 'not_found');

  tunnel.send({ t: 'req', id: 999_003, method: 'POST', path: '/api/v2/pair/claim', headers: {} });
  const claimAttempt = await collectTunnel(tunnel, 999_003, { timeoutMs: 3000 });
  assert.equal(claimAttempt.status, 404, 'home 不得经隧道调用 pair/claim');

  tunnel.send({ t: 'req', id: 999_004, method: 'POST', path: '/api/v2/pair/window', headers: {} });
  const okOpen = await collectTunnel(tunnel, 999_004, { timeoutMs: 3000 });
  assert.equal(okOpen.status, 200, '合法控制面路由仍必须可用');
  tunnel.destroy();
});

test('控制面 §3.4：码冲突 → 409 code_conflict（网关换码重试）', async (t) => {
  const h = await startRelay(t);
  const a = await h.registerHome({ homeName: 'PC-A' });
  const b = await h.registerHome({ homeName: 'PC-B' });
  const { tunnel: tunnelA } = await h.openHomeTunnel(a.json.homeToken);
  const { tunnel: tunnelB } = await h.openHomeTunnel(b.json.homeToken);

  assert.equal((await declarePairWindow(tunnelA, { code: '246810' })).status, 200);
  const conflict = await declarePairWindow(tunnelB, { code: '246810' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'code_conflict');

  // 换一个码就能成功（网关重试路径）
  assert.equal((await declarePairWindow(tunnelB, { code: '112233' })).status, 200);
  tunnelA.destroy();
  tunnelB.destroy();
});

test('homeToken 轮换：同名 home 重新注册 → 旧连接被断开、旧令牌 401（§2.2）', async (t) => {
  const h = await startRelay(t);
  const first = await h.registerHome({ homeName: 'DESKTOP-SAME' });
  const { tunnel: oldTunnel } = await h.openHomeTunnel(first.json.homeToken);
  assert.equal(h.relay.stats().hub.homes, 1);

  const second = await h.registerHome({ homeName: 'DESKTOP-SAME' });
  assert.equal(second.json.homeId, first.json.homeId);
  assert.notEqual(second.json.homeToken, first.json.homeToken);
  const closed = await oldTunnel.waitClose(3000);
  assert.ok([1008, 1001].includes(closed.code), `旧连接应被策略关闭，实际 ${JSON.stringify(closed)}`);
  await waitFor(() => h.relay.stats().hub.homes === 0, { what: '旧连接被清理' });

  await assert.rejects(
    () => openTunnel(`${h.wsUrl}/api/v2/tunnel/home`, { role: 'home', token: first.json.homeToken }),
    (err) => {
      assert.equal(err.status, 401);
      return true;
    },
  );
  const { tunnel: newTunnel } = await h.openHomeTunnel(second.json.homeToken);
  assert.equal(newTunnel.open, true);
  newTunnel.destroy();
});
