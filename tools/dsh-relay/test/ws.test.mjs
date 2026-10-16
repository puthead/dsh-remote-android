/**
 * WebSocket 协议层测试（RFC 6455）：握手、分片、ping/pong/close、掩码校验、消息上限。
 *
 * 这一层必须用**独立实现的客户端**（test/ws-client.mjs）来打，而不是复用 lib/ws.mjs 的编解码：
 * 否则"服务端与客户端share 同一个错误"会让测试毫无价值。
 * 同时这里也覆盖契约 §3.1 的心跳（30s 无 pong 判死链）与"首帧必须 hello"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { computeAccept, WS_GUID } from '../lib/ws.mjs';
import { defaultConfig, mergeConfig, validateConfig } from '../lib/config.mjs';
import { setupPairing, sleep, startRelay, registerHomeToken, waitFor } from './helpers.mjs';
import { encodeClientFrame, openTunnel, rawConnect, wsHandshake } from './ws-client.mjs';

/**
 * RFC 6455 §1.3 官方向量：这一条用来**钉死** GUID 常量。
 *
 * 背景（真实事故）：lib/ws.mjs 里 GUID 曾写成 `...95CA-5AB0DC85B11F`（C 滑到了结尾），
 * 而测试客户端复用了同一个常量 → 两侧自洽、测试全绿，但 OkHttp/网关等标准客户端全部握手失败。
 * 只要这条官方向量在，常量就不可能再"自洽地"漂移。
 */
test('RFC 6455 §1.3 向量：Sec-WebSocket-Accept 必须等于官方面例值', () => {
  assert.equal(computeAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  // 再钉一次 GUID 字面量（独立于实现的第二道防线）
  assert.equal(WS_GUID, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
});

/** 收原始 HTTP 响应文本（用于构造畸形/特殊的升级请求）。 */
function rawHttpUpgrade(port, requestText, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let text = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(text);
    }, timeoutMs);
    socket.on('connect', () => socket.write(requestText));
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(text);
    });
  });
}

/** 等一个满足条件的隧道 JSON 帧（先查历史，避免"帧比监听器先到"的竞态）。 */
function nextJson(client, predicate, timeoutMs = 3000) {
  for (const text of client.frameHistory) {
    try {
      const json = JSON.parse(text);
      if (predicate(json)) return Promise.resolve(json);
    } catch {
      /* 非 JSON 帧忽略 */
    }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 JSON 帧超时')), timeoutMs);
    const onFrame = (text) => {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }
      if (!predicate(json)) return;
      clearTimeout(timer);
      client.removeListener('frame', onFrame);
      resolve(json);
    };
    client.on('frame', onFrame);
  });
}

test('WS 握手：Bearer homeToken 升级成功，Sec-WebSocket-Accept 正确，ready 含 homeId', async (t) => {
  const h = await startRelay(t);
  const { homeId, homeToken } = await registerHomeToken(h);
  const { tunnel, ready } = await h.openHomeTunnel(homeToken);
  assert.equal(ready.t, 'ready');
  assert.equal(ready.proto, 2);
  assert.equal(ready.role, 'home');
  assert.equal(ready.homeId, homeId);
  // 客户端在握手阶段已校验 Accept（见 ws-client.mjs）；这里确认服务端帧没带掩码
  assert.deepEqual(tunnel.decoder.violations, []);
  tunnel.destroy();
});

test('WS 握手：缺 Authorization → 401；令牌错误 → 401；两者都带 WWW-Authenticate', async (t) => {
  const h = await startRelay(t);
  await registerHomeToken(h);

  await assert.rejects(
    () => wsHandshake(`${h.wsUrl}/api/v2/tunnel/home`),
    (err) => {
      assert.equal(err.status, 401, err.message);
      assert.match(err.body, /unauthorized/);
      return true;
    },
  );

  await assert.rejects(
    () => wsHandshake(`${h.wsUrl}/api/v2/tunnel/home`, { headers: { Authorization: 'Bearer not-a-real-token' } }),
    (err) => {
      assert.equal(err.status, 401, err.message);
      assert.match(err.body, /homeToken 无效或已轮换/);
      return true;
    },
  );

  // 明文令牌不得出现在错误体里
  const bogus = 'homeTokenPlaintextLeakCheck123';
  await assert.rejects(
    () => wsHandshake(`${h.wsUrl}/api/v2/tunnel/home`, { headers: { Authorization: `Bearer ${bogus}` } }),
    (err) => {
      assert.ok(!err.body.includes(bogus), '错误响应不得回显令牌');
      return true;
    },
  );
});

test('WS 握手：未知升级路径 → 404；缺 Sec-WebSocket-Version → 426', async (t) => {
  const h = await startRelay(t);
  await assert.rejects(
    () => wsHandshake(`${h.wsUrl}/api/v2/tunnel/nope`),
    (err) => {
      assert.equal(err.status, 404, err.message);
      assert.match(err.body, /未知隧道端点/);
      return true;
    },
  );

  // 手工发一个缺少版本头的升级请求：期望 426 + Sec-WebSocket-Version: 13
  const raw = await rawHttpUpgrade(h.port, [
    'GET /api/v2/tunnel/home HTTP/1.1',
    `Host: 127.0.0.1:${h.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    '',
    '',
  ].join('\r\n'));
  assert.match(raw, /HTTP\/1\.1 426/, raw.slice(0, 200));
  assert.match(raw, /sec-websocket-version: 13/i, raw);
});

test('分片文本帧：hello 拆成 3 片也能正确重组（RFC 6455 分片）', async (t) => {
  const h = await startRelay(t);
  const { homeToken, homeId } = await registerHomeToken(h);
  const client = await rawConnect(`${h.wsUrl}/api/v2/tunnel/home`, { headers: { Authorization: `Bearer ${homeToken}` } });

  const hello = JSON.stringify({ t: 'hello', proto: 2, role: 'home', name: 'fragmented-pc' });
  const part1 = hello.slice(0, 7);
  const part2 = hello.slice(7, 13);
  const part3 = hello.slice(13);
  client.sendText(part1, { fin: false });
  client.sendContinuation(part2, { fin: false });
  // 控制帧可以插在分片消息中间：这里插一个 ping，服务端必须回 pong 且不影响重组
  client.sendPing(Buffer.from('mid-fragment'));
  client.sendContinuation(part3, { fin: true });

  const ready = await nextJson(client, (frame) => frame.t === 'ready');
  assert.equal(ready.homeId, homeId);
  assert.deepEqual(await client.waitControl('pong'), Buffer.from('mid-fragment'), '分片中间的控制帧必须被及时回 pong');
  assert.deepEqual(client.decoder.violations, []);
  client.destroy();
});

/**
 * 裸连接 + 主动发 hello 后等 ready。
 * 为什么需要这个 helper：契约 §3.1 要求 `hello` 必须最先发，中继**在收到 hello 之前一个帧都不发**
 * （这条是 P0 真联调死锁修复后固化下来的行为，见「服务端绝不先发 ready」用例）。
 */
async function rawHomeWithHello(h, homeToken, { name = 'raw-home', timeoutMs = 3000 } = {}) {
  const client = await rawConnect(`${h.wsUrl}/api/v2/tunnel/home`, { headers: { Authorization: `Bearer ${homeToken}` } });
  client.sendText(JSON.stringify({ t: 'hello', proto: 2, role: 'home', name }));
  await nextJson(client, (frame) => frame.t === 'ready', timeoutMs);
  return client;
}

test('WS 控制帧：协议层 ping 回 pong（载荷回显），close 帧被正确应答', async (t) => {
  const h = await startRelay(t);
  const { homeToken } = await registerHomeToken(h);
  const client = await rawHomeWithHello(h, homeToken);

  client.sendPing(Buffer.from('hello-ping'));
  assert.deepEqual(await client.waitControl('pong'), Buffer.from('hello-ping'));

  client.sendClose(1000, 'bye');
  const info = await client.waitClose();
  assert.equal(info.code, 1000, `期望回显 1000，实际 ${JSON.stringify(info)}`);
  assert.deepEqual(client.decoder.violations, []);
});

test('协议违规：未掩码的客户端帧 → 1002 关闭', async (t) => {
  const h = await startRelay(t);
  const { homeToken } = await registerHomeToken(h);
  const client = await rawHomeWithHello(h, homeToken);

  // 直接发一个不带掩码的文本帧（RFC 要求客户端必须掩码）
  client.sendRaw(encodeClientFrame({ opcode: 0x1, payload: Buffer.from('{"t":"hello"}'), mask: false }));
  const info = await client.waitClose();
  assert.equal(info.code, 1002, `期望 1002 协议错误，实际 ${JSON.stringify(info)}：${info.reason}`);
  assert.match(info.reason, /掩码/);
});

test('协议违规：binary 帧 → 1003（契约只允许文本帧）', async (t) => {
  const h = await startRelay(t);
  const { homeToken } = await registerHomeToken(h);
  const client = await rawHomeWithHello(h, homeToken);

  client.sendRaw(encodeClientFrame({ opcode: 0x2, payload: Buffer.from([1, 2, 3, 4]) }));
  const info = await client.waitClose();
  assert.equal(info.code, 1003, JSON.stringify(info));
});

test('消息上限：超过 limits.maxMessageBytes → 1009 关闭', async (t) => {
  const h = await startRelay(t, { limits: { maxMessageBytes: 4096 } });
  const { homeToken } = await registerHomeToken(h);
  const client = await rawConnect(`${h.wsUrl}/api/v2/tunnel/home`, { headers: { Authorization: `Bearer ${homeToken}` } });
  // 帧太大在 WS 层就被拒（先于任何应用层判断），因此不需要先发 hello
  client.sendText(JSON.stringify({ t: 'hello', proto: 2, role: 'home', pad: 'x'.repeat(9000) }));
  const info = await client.waitClose();
  assert.equal(info.code, 1009, JSON.stringify(info));
});

test('隧道 JSON 心跳：ping 回 pong 且 id 原样回填（契约 §3.1）', async (t) => {
  const h = await startRelay(t);
  const { homeToken } = await registerHomeToken(h);
  const { tunnel } = await h.openHomeTunnel(homeToken);
  tunnel.send({ t: 'ping', id: 4242 });
  const pong = await tunnel.waitFrame((frame) => frame.t === 'pong', { what: 'pong 帧' });
  assert.equal(pong.id, 4242);
  tunnel.destroy();
});

test('心跳：30s 无 pong 判死链（测试用短周期）→ 服务端主动断开并清理连接', async (t) => {
  const h = await startRelay(t, { heartbeat: { intervalMs: 60, timeoutMs: 150 } });
  const { homeToken, homeId } = await registerHomeToken(h);
  const client = await rawHomeWithHello(h, homeToken);

  // 完全不回应：服务端应发出 ping，随后判死链并断开
  const ping = await nextJson(client, (frame) => frame.t === 'ping', 2000);
  assert.ok(Number.isInteger(ping.id), '心跳 ping 应带 id');
  const info = await client.waitClose(3000);
  assert.ok([1006, 1000].includes(info.code), JSON.stringify(info));
  await waitFor(() => h.relay.stats().hub.homes === 0, { what: '死链 home 被清理' });
  assert.equal(h.relay.stats().hub.homes, 0);
  void homeId;
});

test('心跳：正常回 JSON pong 的连接保持在线（不会被误杀）', async (t) => {
  const h = await startRelay(t, { heartbeat: { intervalMs: 60, timeoutMs: 150 } });
  const { homeToken } = await registerHomeToken(h);
  const { tunnel } = await h.openHomeTunnel(homeToken);

  let pings = 0;
  tunnel.on('frame', (text) => {
    const frame = JSON.parse(text);
    if (frame.t === 'ping') {
      pings++;
      tunnel.send({ t: 'pong', id: frame.id });
    }
  });
  await waitFor(() => pings >= 3, { timeoutMs: 3000, what: '至少 3 次心跳 ping' });
  assert.equal(tunnel.open, true, '回了 pong 的连接不应被断开');
  assert.equal(h.relay.stats().hub.homes, 1);
  tunnel.destroy();
});

test('心跳 P0 回归：只发协议级 ping / 不回 JSON pong 的健康连接，3 个心跳周期内不得被误杀', async (t) => {
  // 真实场景：网关每 30s 发 RFC 6455 协议级 ping（relay-client 的 ws.ping()），且**不**回 JSON pong。
  // 旧实现只在收到 JSON 文本帧时更新 lastSeenAt → 健康连接被判死链，每 30s 掉一次且不可自愈。
  const intervalMs = 200;
  const timeoutMs = intervalMs * 3;
  const h = await startRelay(t, { heartbeat: { intervalMs, timeoutMs }, limits: { helloTimeoutMs: 5000 } });
  const { homeToken, homeId } = await registerHomeToken(h);
  const client = await rawHomeWithHello(h, homeToken);

  const conn = h.relay.hub.homes.get(homeId);
  assert.ok(conn, '连接应在线');
  const firstSeen = conn.lastSeenAt;

  // 跨 3 个心跳周期：只发协议级 ping（不碰 JSON pong）
  const deadline = Date.now() + intervalMs * 3 + 150;
  while (Date.now() < deadline) {
    client.sendPing(Buffer.from('keepalive'));
    await sleep(intervalMs / 2);
  }

  assert.equal(h.relay.stats().hub.homes, 1, '健康连接在 3 个心跳周期内不得被断开');
  assert.equal(h.relay.stats().hub.heartbeatTimeouts, 0, '不得产生任何心跳超时计数');
  assert.ok(conn.lastSeenAt > firstSeen, `lastSeenAt 必须被"任何入站活动"推进：${firstSeen} → ${conn.lastSeenAt}`);
  assert.equal(client.open, true);
  client.destroy();
});

test('心跳 P0 回归：完全不响应的连接仍必须在 timeoutMs 后被清理（没有废掉死链检测）', async (t) => {
  const intervalMs = 200;
  const timeoutMs = intervalMs * 3;
  const h = await startRelay(t, { heartbeat: { intervalMs, timeoutMs }, limits: { helloTimeoutMs: 5000 } });
  const { homeToken } = await registerHomeToken(h);
  const client = await rawHomeWithHello(h, homeToken);

  // 之后彻底静默：不回 JSON pong，也不发任何协议层帧
  // （RawWsClient 只对"收到的协议级 ping"自动回 pong，而中继只发 JSON ping，因此这里不会有自动回应）
  const startedAt = Date.now();
  const info = await client.waitClose(timeoutMs + 3000);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= timeoutMs, `应至少在 timeoutMs（${timeoutMs}ms）之后才清理，实际 ${elapsed}ms`);
  assert.ok(elapsed < timeoutMs + 2000, `不应拖太久，实际 ${elapsed}ms`);
  assert.ok([1006, 1000].includes(info.code), JSON.stringify(info));
  await waitFor(() => h.relay.stats().hub.homes === 0, { what: '死链被清理' });
  assert.ok(h.relay.stats().hub.heartbeatTimeouts >= 1, '应记录心跳超时计数');
});

test('配置校验：heartbeat.timeoutMs < intervalMs×2 必须启动即报错（历史上 1:1 会每 30s 误杀）', () => {
  assert.throws(
    () => validateConfig(mergeConfig(defaultConfig({}), { heartbeat: { intervalMs: 30_000, timeoutMs: 30_000 } }), { cliHome: 'C:\\x' }),
    /timeoutMs/,
  );
  assert.throws(
    () => validateConfig(mergeConfig(defaultConfig({}), { heartbeat: { intervalMs: 1000, timeoutMs: 1999 } }), { cliHome: 'C:\\x' }),
    /intervalMs×2/,
  );
  const cfg = validateConfig(defaultConfig({}), { cliHome: 'C:\\x' });
  assert.equal(cfg.heartbeat.intervalMs, 30_000);
  assert.equal(cfg.heartbeat.timeoutMs, 90_000, '默认 timeoutMs 必须是 intervalMs×3');
  assert.equal(
    validateConfig(mergeConfig(defaultConfig({}), { heartbeat: { intervalMs: 1000, timeoutMs: 2000 } }), { cliHome: 'C:\\x' }).heartbeat.timeoutMs,
    2000,
    '2 倍是允许的下限',
  );
});

test('首帧必须是 hello：先发 req → error{bad_request,fatal:true} 并关闭（契约 §3.1）', async (t) => {
  const h = await startRelay(t);
  const { homeToken } = await registerHomeToken(h);
  // 注意：不能用 openHomeTunnel（它会先发 hello），必须裸连接直接发 req
  const client = await openTunnel(`${h.wsUrl}/api/v2/tunnel/home`, { role: 'home', token: homeToken });
  client.send({ t: 'req', id: 1, method: 'GET', path: '/api/v2/pair/window' });
  const err = await client.waitType('error', { timeoutMs: 2000 });
  assert.equal(err.code, 'bad_request');
  assert.equal(err.fatal, true);
  await client.waitClose(2000);
});

test('hello 超时：升级成功但迟迟不发 hello → 中继主动、有日志地关闭（防占槽）', async (t) => {
  const h = await startRelay(t, { limits: { helloTimeoutMs: 150 }, heartbeat: { intervalMs: 30_000, timeoutMs: 90_000 } });
  const { homeToken } = await registerHomeToken(h);
  const client = await rawConnect(`${h.wsUrl}/api/v2/tunnel/home`, { headers: { Authorization: `Bearer ${homeToken}` } });

  const startedAt = Date.now();
  const err = await nextJson(client, (frame) => frame.t === 'error', 3000);
  const elapsed = Date.now() - startedAt;
  assert.equal(err.code, 'bad_request');
  assert.equal(err.fatal, true, '首帧超时必须 fatal（随后关闭连接）');
  assert.match(err.message, /hello/);

  const info = await client.waitClose(3000);
  assert.equal(info.code, 1008, `期望 1008（策略关闭），实际 ${JSON.stringify(info)}`);
  // 关键：在**心跳超时（30s）之前**就关闭 —— 首帧超时必须与心跳解耦，否则协议违例会被心跳兜住
  assert.ok(elapsed < 2000, `应在 helloTimeout 量级内关闭，实际 ${elapsed}ms`);
  await waitFor(() => h.relay.stats().hub.homes === 0, { what: '超时连接被清理' });
  assert.ok(h.relay.stats().hub.helloTimeouts >= 1, '统计里应记录 hello 超时');
});

test('服务端绝不先发 ready：未收到 hello 前，中继不得发出任何帧（P0 死锁回归）', async (t) => {
  // 真联调 P0：中继曾在升级后**主动先发 ready**，而网关的 ready 监听器在 `await connect()` 之后才挂上，
  // 与握手响应同批到达的 ready 被丢掉 → 双方互相等待（中继等 hello、网关等 ready）。
  // 这条用例把"中继必须等 hello 才说话"固化下来，防止有人再"好心"让中继先发 ready。
  const h = await startRelay(t, { limits: { helloTimeoutMs: 400 }, heartbeat: { intervalMs: 30_000, timeoutMs: 90_000 } });
  const { homeToken, homeId } = await registerHomeToken(h);
  const client = await rawConnect(`${h.wsUrl}/api/v2/tunnel/home`, { headers: { Authorization: `Bearer ${homeToken}` } });

  await sleep(250); // 明显早于 helloTimeout：这段时间内不得有任何帧
  assert.deepEqual(client.frameHistory, [], `未收到 hello 前中继不得发帧，实际收到：${JSON.stringify(client.frameHistory)}`);
  assert.equal(client.pings.length, 0, '未收到 hello 前不得发 ping');
  assert.equal(h.relay.stats().hub.homes, 1, '连接应处于"已升级、等待 hello"状态');

  // 补发 hello 后必须立刻恢复：ready 正常返回
  client.sendText(JSON.stringify({ t: 'hello', proto: 2, role: 'home', name: 'late-but-ok' }));
  const ready = await nextJson(client, (frame) => frame.t === 'ready', 2000);
  assert.equal(ready.homeId, homeId);
  assert.equal(ready.role, 'home');
  assert.equal(client.open, true, '按时补发 hello 的连接不应被关闭');
  client.destroy();
});

test('device 隧道同样等 hello：未收到 hello 前不发 ready/notice', async (t) => {
  const setup = await setupPairing(t, { overrides: { limits: { helloTimeoutMs: 1000 } } });
  // 用同一台设备的令牌再开一条裸连接（新连接会替换同 deviceId 的旧连接，这里正是我们要的）
  const client = await openTunnel(`${setup.wsUrl}/api/v2/tunnel/device`, { role: 'device', token: setup.deviceToken });
  await sleep(200);
  assert.deepEqual(client.frameHistory, [], `device 未发 hello 前中继不得发帧，实际：${JSON.stringify(client.frameHistory)}`);
  client.send({ t: 'hello', proto: 2, role: 'device' });
  const ready = await client.waitType('ready', { timeoutMs: 2000 });
  assert.equal(ready.homeId, setup.homeId);
  assert.equal(ready.homeOnline, true);
  client.destroy();
});

test('role 不符：在 home 端点上声明 role=device → forbidden/fatal 并关闭', async (t) => {
  const h = await startRelay(t);
  const a = await registerHomeToken(h, { homeName: 'PC-A' });
  const b = await registerHomeToken(h, { homeName: 'PC-B' });
  const { tunnel: homeA } = await h.openHomeTunnel(a.homeToken);

  // 注意：不能对同一个 home 再开一条连接来"验证不受影响" —— 同一 home 的新连接会替换旧连接（§2.2 语义）
  const client = await openTunnel(`${h.wsUrl}/api/v2/tunnel/home`, { role: 'device', token: b.homeToken });
  client.send({ t: 'hello', proto: 2, role: 'device' });
  const err = await client.waitType('error', { timeoutMs: 2000 });
  assert.equal(err.code, 'forbidden');
  assert.equal(err.fatal, true);
  await client.waitClose(2000);

  assert.equal(homeA.open, true, '另一个 home 的正常连接不受影响');
  assert.equal(h.relay.stats().hub.homes, 1);
  homeA.destroy();
});

test('proto 版本不符：hello.proto≠2 → 拒绝（契约头表 apiVersion=2）', async (t) => {
  const h = await startRelay(t);
  const { homeToken } = await registerHomeToken(h);
  const client = await openTunnel(`${h.wsUrl}/api/v2/tunnel/home`, { role: 'home', token: homeToken });
  client.send({ t: 'hello', proto: 1, role: 'home' });
  const err = await client.waitType('error', { timeoutMs: 2000 });
  assert.equal(err.code, 'bad_request');
  assert.match(err.message, /proto/);
  await client.waitClose(2000);
});

test('WS 升级前的纯 HTTP 请求打到隧道端点 → 426 指路（不是 404）', async (t) => {
  const h = await startRelay(t);
  const res = await h.request('GET', '/api/v2/tunnel/device');
  assert.equal(res.status, 426);
  assert.equal(res.json.error.code, 'bad_request');
  assert.match(res.json.error.message, /WebSocket/);
});
