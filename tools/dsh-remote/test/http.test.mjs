/**
 * HTTP 协议层测试：请求体 1MB 上限（413）、非法 JSON、404/405、
 * 慢速请求防挂起（408/连接回收）、以及拒绝后服务仍可正常使用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { httpRequest, scripted, sleep, startHarness } from './helpers.mjs';

/**
 * 裸 socket 交互：按顺序写入若干片段，收集服务端返回的原始文本。
 * 为什么不用 fetch：需要精确控制「声明了 Content-Length 却不发完」「只发头部」这类畸形请求。
 */
function rawExchange(port, payloads, { timeoutMs = 2000, endAfterWrite = false } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let text = '';
    let settled = false;
    const done = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ text, ...extra });
    };
    const timer = setTimeout(() => done({ timedOut: true }), timeoutMs);
    socket.on('connect', () => {
      for (const payload of payloads) socket.write(payload);
      if (endAfterWrite) socket.end();
    });
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('end', () => done({ closedByServer: true }));
    socket.on('close', () => done({ closedByServer: true }));
    socket.on('error', (err) => done({ error: err.code }));
  });
}

/** 以分块（chunked）方式持续发送，直到服务端给出响应为止。 */
async function rawChunkedFlood(port, headerText, { blockSize = 65_536, maxTotal = 1_310_720, pauseMs = 5 } = {}) {
  const socket = net.connect({ host: '127.0.0.1', port });
  let text = '';
  let responded = false;
  socket.on('data', (chunk) => {
    text += chunk.toString('utf8');
    responded = true;
  });
  socket.on('error', () => {
    responded = true;
  });
  await once(socket, 'connect');
  socket.write(headerText);
  const block = 'x'.repeat(blockSize);
  let sent = 0;
  while (sent < maxTotal && !responded) {
    socket.write(`${blockSize.toString(16)}\r\n`);
    socket.write(block);
    socket.write('\r\n');
    sent += blockSize;
    await sleep(pauseMs);
  }
  const deadline = Date.now() + 2000;
  while (!responded && Date.now() < deadline) await sleep(10);
  socket.destroy();
  return { text, sent };
}

test('请求体上限：Content-Length 超过 1MB 立即返回 413（不读取请求体）', async (t) => {
  const h = await startHarness(t);
  const header = [
    'POST /api/v1/tasks HTTP/1.1',
    'Host: 127.0.0.1',
    `Authorization: Bearer ${h.token}`,
    'Content-Type: application/json',
    `Content-Length: ${2 * 1024 * 1024}`,
    '',
    '',
  ].join('\r\n');
  const result = await rawExchange(h.port, [header, 'x'.repeat(1024)]);
  assert.match(result.text, /HTTP\/1\.1 413/, `期望 413，实际响应：${result.text.slice(0, 120)}`);
  assert.match(result.text, /bad_request/);
  assert.match(result.text, /请求体超过上限/);

  // 拒绝之后服务仍然健康
  const health = await h.request('GET', '/api/v1/health', { token: null });
  assert.equal(health.status, 200);
});

test('请求体上限：分块传输累计超过 1MB 同样 413', async (t) => {
  const h = await startHarness(t);
  const header = [
    'POST /api/v1/tasks HTTP/1.1',
    'Host: 127.0.0.1',
    `Authorization: Bearer ${h.token}`,
    'Content-Type: application/json',
    'Transfer-Encoding: chunked',
    '',
    '',
  ].join('\r\n');
  const { text, sent } = await rawChunkedFlood(h.port, header);
  assert.ok(sent > 1024 * 1024, '测试应发送超过 1MB 的数据');
  assert.match(text, /HTTP\/1\.1 413/, `期望 413，实际响应：${text.slice(0, 200)}`);
  assert.match(text, /请求体超过上限/);

  const health = await h.request('GET', '/api/v1/health', { token: null });
  assert.equal(health.status, 200, '超限请求不应影响后续请求');
});

test('慢速请求防挂起：声明 Content-Length 却不发送 body → 服务端主动超时回收', async (t) => {
  const h = await startHarness(t, { limits: { requestTimeoutMs: 500, headersTimeoutMs: 400 } });
  const header = [
    'POST /api/v1/tasks HTTP/1.1',
    'Host: 127.0.0.1',
    `Authorization: Bearer ${h.token}`,
    'Content-Type: application/json',
    'Content-Length: 1000',
    '',
    '',
  ].join('\r\n');
  const started = Date.now();
  const result = await rawExchange(h.port, [header, 'abc'], { timeoutMs: 3000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500, `应在超时后很快回收连接，实际 ${elapsed}ms`);
  assert.ok(
    result.text.includes('408') || result.closedByServer || result.error === 'ECONNRESET',
    `服务端必须超时回收（408 或关闭连接），实际：${JSON.stringify({ text: result.text.slice(0, 120), error: result.error })}`,
  );

  const health = await h.request('GET', '/api/v1/health', { token: null });
  assert.equal(health.status, 200);
});

test('慢速请求防挂起：只建立连接不发送任何数据也会被回收', async (t) => {
  const h = await startHarness(t, { limits: { requestTimeoutMs: 500, headersTimeoutMs: 400 } });
  const started = Date.now();
  const result = await rawExchange(h.port, [], { timeoutMs: 3000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500, `空闲连接应被回收，实际 ${elapsed}ms`);
  assert.ok(result.closedByServer || result.error === 'ECONNRESET' || result.text.includes('408'));
});

test('非法 JSON → 400 bad_request；空体 → 400（缺少必要字段）', async (t) => {
  const h = await startHarness(t);
  const badJson = await h.request('POST', '/api/v1/tasks', { body: '{ not json at all', raw: true });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, 'bad_request');
  assert.match(badJson.json.error.message, /不是合法的 JSON/);

  const empty = await h.request('POST', '/api/v1/tasks', { body: '' , raw: true });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error.message, /prompt 不能为空/);
});

test('未知路径 404、方法不允许 405（错误体仍为契约形状）', async (t) => {
  const h = await startHarness(t);

  const root = await h.request('GET', '/', { token: null });
  assert.equal(root.status, 404);
  assert.equal(root.json.error.code, 'not_found');

  const unknown = await h.request('GET', '/api/v1/nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'not_found');
  assert.match(unknown.json.error.message, /未知接口/);

  const wrongMethod = await h.request('DELETE', '/api/v1/health', { token: null });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error.code, 'bad_request');
  assert.match(wrongMethod.json.error.message, /方法不允许/);

  const putTasks = await h.request('PUT', '/api/v1/tasks');
  assert.equal(putTasks.status, 405);
  assert.match(putTasks.json.error.message, /GET\/POST/);
});

test('health 是唯一无需鉴权的探测接口，且契约字段类型正确', async (t) => {
  const h = await startHarness(t);
  const res = await httpRequest(h.baseUrl, 'GET', '/api/v1/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(typeof res.json.serverName, 'string');
  assert.equal(typeof res.json.gatewayVersion, 'string');
  assert.equal(typeof res.json.dshVersion, 'string');
  assert.equal(typeof res.json.uptimeMs, 'number');
  assert.equal(typeof res.json.activeTasks, 'number');
  assert.equal(typeof res.json.queuedTasks, 'number');
  assert.equal(typeof res.json.pairingOpen, 'boolean');
  assert.equal(res.json.authRequired, true);
  assert.ok(Array.isArray(res.json.capabilities));
});

test('workspaces 接口返回白名单与默认工作区', async (t) => {
  const h = await startHarness(t);
  const res = await h.request('GET', '/api/v1/workspaces');
  assert.equal(res.status, 200);
  assert.equal(res.json.workspaces.length, 1);
  assert.equal(res.json.workspaces[0].exists, true);
  assert.equal(res.json.workspaces[0].label, 'ws');
  assert.equal(res.json.default, h.config.defaultWorkspace);
});

test('默认工作区：请求未带 workspace 时使用配置默认值', async (t) => {
  const h = await startHarness(t);
  const res = await h.request('POST', '/api/v1/tasks', { body: { prompt: scripted({ mode: 'echo', text: '默认工作区', chunks: 1 }) } });
  assert.equal(res.status, 201);
  assert.equal(res.json.workspace, await h.sandbox.config.defaultWorkspace);
});
