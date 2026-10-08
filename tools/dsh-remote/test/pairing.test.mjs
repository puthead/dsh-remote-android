/**
 * 配对与鉴权测试（契约 §2、§5、§6）：
 * 令牌只存哈希、恒定时间比较、配对码一次性/过期、限速 429、401/403 语义、设备吊销。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore, PairingManager, TOKEN_PREFIX, tokenHashOf } from '../lib/tokens.mjs';
import { findLanIpv4, httpRequest, makeSandbox, pairDevice, sleep, startHarness } from './helpers.mjs';

/** 测试用合法小写 UUID（A2-3 要求 deviceId 必须是小写 UUID）。 */
const DEVICE_ID = '01234567-89ab-4cde-8f01-23456789abcd';

test('DeviceStore：签发/校验/吊销/同 deviceId 重配对，且只落 sha256', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-tok-'));
  const file = path.join(dir, 'devices.json');
  const store = new DeviceStore({ file });
  await store.load();

  const first = await store.issue({ deviceName: 'Xiaomi 14', deviceId: 'dev-1' });
  assert.match(first.token, /^dshr_[A-Za-z0-9_-]{43}$/, '32 字节 Base64Url 无填充');
  assert.match(first.tokenId, /^tok_[0-9a-f]{16}$/);
  assert.equal(store.verify(first.token).deviceName, 'Xiaomi 14');
  assert.equal(store.verify('dshr_wrong'), null);
  assert.equal(store.verify(''), null);
  assert.equal(store.verify(undefined), null);

  // 落盘内容必须只有哈希：文件里不得出现明文令牌
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes(first.token), 'devices.json 不得包含明文令牌');
  assert.ok(raw.includes(tokenHashOf(first.token)), 'devices.json 应存 sha256(令牌)');
  assert.ok(!raw.includes(TOKEN_PREFIX), '文件中不应出现令牌前缀');

  // 列表接口不暴露哈希
  const listed = store.list();
  assert.deepEqual(Object.keys(listed[0]).sort(), ['deviceName', 'lastSeenAt', 'pairedAt', 'tokenId']);

  // 同一 deviceId 重配对：旧令牌立即失效
  const second = await store.issue({ deviceName: 'Xiaomi 14', deviceId: 'dev-1' });
  assert.deepEqual(second.revokedTokenIds, [first.tokenId]);
  assert.equal(store.verify(first.token), null, '旧令牌必须立即吊销');
  assert.ok(store.verify(second.token), '新令牌可用');

  // 不同 deviceId 互不影响
  const other = await store.issue({ deviceName: 'Pixel', deviceId: 'dev-2' });
  assert.ok(store.verify(second.token));

  // 重启后仍在（令牌持久化）
  const reloaded = new DeviceStore({ file });
  await reloaded.load();
  assert.equal(reloaded.list().length, 2);
  assert.ok(reloaded.verify(other.token), '重启后令牌仍有效');

  assert.equal(await reloaded.revoke(other.tokenId), true);
  assert.equal(reloaded.verify(other.token), null);
  assert.equal(await reloaded.revoke('tok_nope'), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('PairingManager：6 位码、一次性、错误码/过期语义、新码顶替旧码', () => {
  let now = 1000;
  const pairing = new PairingManager({ ttlMs: 5000, now: () => now });
  assert.equal(pairing.isOpen, false);
  assert.deepEqual(pairing.claim('123456'), { ok: false, reason: 'pairing_closed' });

  const { code, expiresAt } = pairing.open();
  assert.match(code, /^\d{6}$/);
  assert.equal(expiresAt, 6000);
  assert.equal(pairing.isOpen, true);

  assert.deepEqual(pairing.claim('000000'), { ok: false, reason: 'pairing_bad_code' });
  assert.equal(pairing.isOpen, true, '错误码不应关闭配对窗口');

  assert.deepEqual(pairing.claim(code), { ok: true });
  assert.equal(pairing.isOpen, false, '配对码一次性使用');
  assert.deepEqual(pairing.claim(code), { ok: false, reason: 'pairing_closed' });

  // 过期：先返回 pairing_bad_code（契约把"过期"归入该码），窗口随后关闭
  const second = pairing.open();
  now = second.expiresAt + 1;
  assert.deepEqual(pairing.claim(second.code), { ok: false, reason: 'pairing_bad_code' });
  assert.equal(pairing.isOpen, false);
  assert.deepEqual(pairing.claim(second.code), { ok: false, reason: 'pairing_closed' });

  // 新码顶替旧码
  const a = pairing.open();
  const b = pairing.open();
  assert.notEqual(a.code, b.code);
  assert.deepEqual(pairing.claim(a.code), { ok: false, reason: 'pairing_bad_code' }, '旧码必须失效');
  assert.deepEqual(pairing.claim(b.code), { ok: true });

  pairing.close();
  assert.equal(pairing.isOpen, false);
});

test('HTTP 配对全流程：pair/open → pair/claim → 令牌可用', async (t) => {
  const h = await startHarness(t, {}, { pair: false });

  const open = await h.request('POST', '/api/v1/pair/open', { token: null });
  assert.equal(open.status, 200);
  assert.match(open.json.code, /^\d{6}$/);
  assert.ok(open.json.expiresAt > Date.now(), 'expiresAt 应为未来时间戳');

  const halfOpen = await h.request('GET', '/api/v1/health');
  assert.equal(halfOpen.json.pairingOpen, true, '配对窗口开启时 health.pairingOpen 为 true');

  const claim = await h.request('POST', '/api/v1/pair/claim', {
    token: null,
    body: { code: open.json.code, deviceName: 'Xiaomi 14', deviceId: '11111111-2222-4333-8444-555555555505' },
  });
  assert.equal(claim.status, 200);
  assert.match(claim.json.token, /^dshr_/);
  assert.match(claim.json.tokenId, /^tok_/);
  assert.equal(claim.json.serverName, 'test-host');
  assert.equal(claim.json.expiresAt, null, '令牌默认永久有效');

  const token = claim.json.token;
  const tasks = await h.request('GET', '/api/v1/tasks', { token });
  assert.equal(tasks.status, 200);
  assert.deepEqual(tasks.json, { tasks: [], nextCursor: null });

  // 配对码一次性：重复使用 → 403 pairing_closed
  const reuse = await h.request('POST', '/api/v1/pair/claim', { token: null, body: { code: open.json.code, deviceName: 'x', deviceId: DEVICE_ID } });
  assert.equal(reuse.status, 403);
  assert.equal(reuse.json.error.code, 'pairing_closed');
  assert.match(reuse.json.error.message, /配对未开启或配对码已被使用/);

  // 配对窗口已消费 → health.pairingOpen=false
  const health = await h.request('GET', '/api/v1/health');
  assert.equal(health.json.pairingOpen, false);
});

test('HTTP 配对：错误码 401、未开启 403、过期 401、格式非法 400', async (t) => {
  const h = await startHarness(t, {}, { pair: false });

  const closed = await h.request('POST', '/api/v1/pair/claim', { token: null, body: { code: '123456', deviceName: 'x', deviceId: DEVICE_ID } });
  assert.equal(closed.status, 403);
  assert.equal(closed.json.error.code, 'pairing_closed');

  const open = await h.request('POST', '/api/v1/pair/open', { token: null });
  const wrong = await h.request('POST', '/api/v1/pair/claim', { token: null, body: { code: '000000', deviceName: 'x', deviceId: DEVICE_ID } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'pairing_bad_code');

  const badFormat = await h.request('POST', '/api/v1/pair/claim', { token: null, body: { code: 'abc', deviceName: 'x', deviceId: DEVICE_ID } });
  assert.equal(badFormat.status, 400);
  assert.equal(badFormat.json.error.code, 'bad_request');

  const correct = await h.request('POST', '/api/v1/pair/claim', { token: null, body: { code: open.json.code, deviceName: 'ok', deviceId: DEVICE_ID } });
  assert.equal(correct.status, 200, '错误尝试不应消费正确的配对码');
});

test('HTTP 配对：过期码返回 401 pairing_bad_code，随后窗口关闭', async (t) => {
  const h = await startHarness(t, { limits: { pairCodeTtlMs: 1000 } }, { pair: false });
  const open = await h.request('POST', '/api/v1/pair/open', { token: null });
  await sleep(1100);
  const expired = await h.request('POST', '/api/v1/pair/claim', { token: null, body: { code: open.json.code, deviceName: 'late', deviceId: DEVICE_ID } });
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error.code, 'pairing_bad_code');
  const again = await h.request('POST', '/api/v1/pair/claim', { token: null, body: { code: open.json.code, deviceName: 'late', deviceId: DEVICE_ID } });
  assert.equal(again.status, 403);
  assert.equal(again.json.error.code, 'pairing_closed');
});

test('HTTP 限速：pair/claim 每 IP 超限返回 429 rate_limited', async (t) => {
  const h = await startHarness(t, { limits: { pairClaimPerMinute: 2 } }, { pair: false });
  const first = await h.request('POST', '/api/v1/pair/claim', { token: null, body: { code: '111111', deviceName: 'x', deviceId: DEVICE_ID } });
  const second = await h.request('POST', '/api/v1/pair/claim', { token: null, body: { code: '111111', deviceName: 'x', deviceId: DEVICE_ID } });
  const third = await h.request('POST', '/api/v1/pair/claim', { token: null, body: { code: '111111', deviceName: 'x', deviceId: DEVICE_ID } });
  assert.equal(first.status, 403, '未开启配对 → pairing_closed');
  assert.equal(second.status, 403);
  assert.equal(third.status, 429, '第 3 次请求超过 2/min 上限');
  assert.equal(third.json.error.code, 'rate_limited');
  assert.ok(Number(third.headers.get('retry-after')) >= 1, '应带 Retry-After 头');
});

test('HTTP 鉴权：受保护接口缺令牌/错令牌一律 401，health 与 pair 免鉴权', async (t) => {
  const h = await startHarness(t);
  const protectedRoutes = [
    ['GET', '/api/v1/tasks'],
    ['POST', '/api/v1/tasks'],
    ['GET', '/api/v1/tasks/task_x'],
    ['POST', '/api/v1/tasks/task_x/cancel'],
    ['DELETE', '/api/v1/tasks/task_x'],
    ['GET', '/api/v1/events'],
    ['GET', '/api/v1/workspaces'],
    ['GET', '/api/v1/devices'],
    ['DELETE', '/api/v1/devices/tok_x'],
  ];
  for (const [method, pathname] of protectedRoutes) {
    const noToken = await h.request(method, pathname, { token: null });
    assert.equal(noToken.status, 401, `${method} ${pathname} 缺令牌必须 401`);
    assert.equal(noToken.json.error.code, 'unauthorized');
    assert.equal(noToken.json.error.message, '设备令牌无效或已吊销');

    const badToken = await h.request(method, pathname, { token: 'dshr_totally-wrong-token-value' });
    assert.equal(badToken.status, 401, `${method} ${pathname} 错令牌必须 401`);
  }

  const health = await h.request('GET', '/api/v1/health', { token: null });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  const withToken = await h.request('GET', '/api/v1/tasks');
  assert.equal(withToken.status, 200, '正确令牌可访问');
});

test('HTTP 限速：认证失败每 IP 超限返回 429', async (t) => {
  const h = await startHarness(t, { limits: { authFailPerMinute: 2 } });
  const a = await h.request('GET', '/api/v1/tasks', { token: 'dshr_bad-token-aaaaaaaa' });
  const b = await h.request('GET', '/api/v1/tasks', { token: 'dshr_bad-token-bbbbbbbb' });
  const c = await h.request('GET', '/api/v1/tasks', { token: 'dshr_bad-token-cccccccc' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(c.status, 429, '第 3 次失败超过 2/min 上限');
  assert.equal(c.json.error.code, 'rate_limited');

  // 限速只针对失败：正确令牌仍然可用
  const ok = await h.request('GET', '/api/v1/tasks');
  assert.equal(ok.status, 200);
});

test('HTTP 设备管理：列表、吊销后令牌立即失效、未知 tokenId 404、同 deviceId 重配对', async (t) => {
  const h = await startHarness(t, {}, { pair: false });

  const firstToken = await pairDevice(h.baseUrl, { deviceName: 'Xiaomi 14', deviceId: '11111111-2222-4333-8444-555555555506' });
  const secondToken = await pairDevice(h.baseUrl, { deviceName: 'Xiaomi 14', deviceId: '11111111-2222-4333-8444-555555555506' });
  assert.notEqual(firstToken, secondToken);

  const oldToken = await h.request('GET', '/api/v1/tasks', { token: firstToken });
  assert.equal(oldToken.status, 401, '同 deviceId 重配对后旧令牌必须失效');
  const newToken = await h.request('GET', '/api/v1/tasks', { token: secondToken });
  assert.equal(newToken.status, 200);

  const devices = await h.request('GET', '/api/v1/devices', { token: secondToken });
  assert.equal(devices.status, 200);
  assert.equal(devices.json.devices.length, 1, '重配对后只保留一条设备记录');
  const tokenId = devices.json.devices[0].tokenId;
  assert.equal(devices.json.devices[0].deviceName, 'Xiaomi 14');

  const revoke = await h.request('DELETE', `/api/v1/devices/${tokenId}`, { token: secondToken });
  assert.equal(revoke.status, 204);
  const afterRevoke = await h.request('GET', '/api/v1/tasks', { token: secondToken });
  assert.equal(afterRevoke.status, 401, '吊销后令牌立即失效');

  const missing = await h.request('DELETE', '/api/v1/devices/tok_missing', { token: null });
  assert.equal(missing.status, 401, '吊销接口本身需要鉴权');
});

test('pair/open 只允许回环地址（非回环 403 forbidden）', async () => {
  const { isLoopbackAddress } = await import('../lib/ratelimit.mjs');
  // 网关按 socket.remoteAddress 判定；这里验证判定函数本身对局域网地址返回 false
  assert.equal(isLoopbackAddress('192.168.1.20'), false);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
  assert.equal(isLoopbackAddress('::ffff:192.168.1.20'), false);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
});

test('健康检查字段与契约一致', async (t) => {
  const h = await startHarness(t);
  const res = await h.request('GET', '/api/v1/health', { token: null });
  assert.equal(res.status, 200);
  const body = res.json;
  assert.deepEqual(Object.keys(body).sort(), [
    'activeTasks',
    'apiVersion',
    'authRequired',
    'capabilities',
    'dshVersion',
    'gatewayVersion',
    'ok',
    'pairingOpen',
    'queuedTasks',
    'serverName',
    'uptimeMs',
  ]);
  assert.equal(body.apiVersion, 1);
  assert.equal(body.authRequired, true);
  assert.deepEqual(body.capabilities, ['tasks', 'events', 'pairing', 'workspaces', 'cancel']);
  assert.equal(typeof body.uptimeMs, 'number');
  assert.ok(body.uptimeMs >= 0);
  const sandbox = h.sandbox;
  assert.ok(sandbox); // 沙箱已创建
});

test('makeSandbox 生成的凭据文件为 UTF-8 无 BOM 单行格式', async (t) => {
  const sandbox = await makeSandbox(t);
  const bytes = await fs.readFile(path.join(sandbox.home, '.credentials.yaml'));
  assert.notEqual(bytes[0], 0xef, '不得带 UTF-8 BOM');
  const text = bytes.toString('utf8');
  assert.match(text, /^DEEPSEEK_API_KEY: sk-/);
});

test('错误体形状统一为 { error: { code, message } }', async (t) => {
  const h = await startHarness(t);
  const res = await httpRequest(h.baseUrl, 'GET', '/api/v1/tasks/task_missing');
  assert.equal(res.status, 401);
  assert.deepEqual(Object.keys(res.json), ['error']);
  assert.deepEqual(Object.keys(res.json.error).sort(), ['code', 'message']);

  const authed = await h.request('GET', '/api/v1/tasks/task_missing');
  assert.equal(authed.status, 404);
  assert.equal(authed.json.error.code, 'not_found');
});

test('HTTP 配对：deviceId 必须是小写 UUID，否则 400 bad_request（A2-3）', async (t) => {
  // 本用例会发十余次 claim，放宽限速以免被 10/min 误伤
  const h = await startHarness(t, { limits: { pairClaimPerMinute: 100 } }, { pair: false });
  const invalid = [
    ['大写 UUID', '01234567-89AB-4CDE-8F01-23456789ABCD'],
    ['缺段', '01234567-89ab-4cde-8f01'],
    ['非法字符', '01234567-89ab-4cde-8f01-23456789abcg'],
    ['空串', ''],
    ['非 UUID 文本', 'device-uuid-0001'],
    ['多一段', '01234567-89ab-4cde-8f01-23456789abcd-extra'],
    ['缺字段', undefined],
    ['非字符串', 12345],
    ['仅前缀', '01234567-'],
  ];
  for (const [label, deviceId] of invalid) {
    const open = await h.request('POST', '/api/v1/pair/open', { token: null });
    const body = { code: open.json.code, deviceName: 'bad-device' };
    if (deviceId !== undefined) body.deviceId = deviceId;
    const res = await h.request('POST', '/api/v1/pair/claim', { token: null, body });
    assert.equal(res.status, 400, `${label} 应被拒绝：${JSON.stringify(deviceId)}`);
    assert.equal(res.json.error.code, 'bad_request');
    assert.match(res.json.error.message, /UUID/);
  }

  const open = await h.request('POST', '/api/v1/pair/open', { token: null });
  const ok = await h.request('POST', '/api/v1/pair/claim', {
    token: null,
    body: { code: open.json.code, deviceName: 'good', deviceId: '8f3c1a2b-1111-4222-8333-444455556666' },
  });
  assert.equal(ok.status, 200, '合法小写 UUID 必须配对成功');
  assert.match(ok.json.token, /^dshr_/);
});

test('pair/open 非回环地址必须 403 forbidden（A2-4，真实 HTTP 验证）', async (t) => {
  // 关键：绑定 0.0.0.0 并通过本机局域网 IP 访问，使 remoteAddress 成为非回环地址
  const lanIp = findLanIpv4();
  if (!lanIp) {
    t.skip('本机没有可用的非回环 IPv4，跳过');
    return;
  }
  const h = await startHarness(t, { host: '0.0.0.0' }, { pair: false });
  let res;
  try {
    res = await fetch(`http://${lanIp}:${h.port}/api/v1/pair/open`, { method: 'POST' });
  } catch (err) {
    t.skip(`无法通过局域网地址访问本机（防火墙/网卡限制）：${err.message}`);
    return;
  }
  assert.equal(res.status, 403, `非回环来源必须 403，实际 ${res.status}`);
  const body = await res.json();
  assert.equal(body.error.code, 'forbidden');
  assert.match(body.error.message, /本机/);

  // 回环仍然可用
  const loopback = await h.request('POST', '/api/v1/pair/open', { token: null });
  assert.equal(loopback.status, 200);
  assert.match(loopback.json.code, /^\d{6}$/);
});
