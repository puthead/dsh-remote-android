/**
 * 桌面端随机端口发现（v2.11.0）。
 *
 * 根因：桌面端 0.2.0 起用 `--port 0` 启动 Host，端口由操作系统分配；网关配置里
 * 写死的 19387 连不上，于是审批、电脑端会话、权限修改全部静音。本文件用一个
 * **纯内存 fetch** 验证：配置端口失败 → 发现候选 → 用真实签名 cookie 探测 →
 * 切到命中端口 → 后续请求不再重复扫描。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopApi } from '../lib/desktop-api.mjs';
import { parseDiscoveredPorts } from '../lib/desktop-discovery.mjs';

/** 造一个带凭据的 DesktopApi（跳过文件读取；cookie 签名用固定 32 字节 secret）。 */
function makeApi(overrides = {}) {
  const api = new DesktopApi({
    dshHome: 'C:\\fake\\.dsh',
    port: 1111,
    autoDiscover: true,
    discoverPorts: async () => [2222],
    fetchImpl: null,
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  api.credentials = { secret: Buffer.alloc(32, 7), secretText: 'fake' };
  return api;
}

/** 一个最小 HTTP 响应对象（DesktopApi 只用 status/text）。 */
function jsonResponse(value, status = 200) {
  return { status, text: async () => JSON.stringify(value) };
}

test('parseDiscoveredPorts：兼容 JSON 标量/数组与空白分隔，剔除非法端口', () => {
  assert.deepEqual(parseDiscoveredPorts('55941'), [55941]);
  assert.deepEqual(parseDiscoveredPorts('[55941,16099,55941]'), [16099, 55941]);
  assert.deepEqual(parseDiscoveredPorts('55941\n19387'), [19387, 55941]);
  assert.deepEqual(parseDiscoveredPorts('0 65536 abc 8080'), [8080]);
  assert.deepEqual(parseDiscoveredPorts(''), []);
});

test('配置端口连不上时发现随机端口；成功后锁定，不再重复探测', async () => {
  const urls = [];
  const api = makeApi({
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes(':1111/')) throw new TypeError('fetch failed: ECONNREFUSED');
      if (String(url).includes('/api/session/projections')) {
        return jsonResponse({ result: { ok: true, value: null } });
      }
      if (String(url).includes('/api/session/list')) {
        return jsonResponse({ result: { ok: true, value: { items: [] } } });
      }
      throw new Error(`unexpected ${url}`);
    },
    discoverPorts: async () => [2222],
  });

  assert.deepEqual(await api.listSessions(), []);
  assert.equal(api.port, 2222, '应切到探测成功的端口');
  assert.equal(api.portLocked, true);
  assert.equal(api.discovery.port, 2222);
  assert.equal(api.discovery.configured, 1111);
  assert.ok(urls.some((url) => url.startsWith('http://127.0.0.1:1111/')), `应先试配置端口：${urls}`);
  assert.ok(urls.some((url) => url.startsWith('http://127.0.0.1:2222/')), `应探测发现端口：${urls}`);

  const before = urls.length;
  await api.listSessions();
  const after = urls.slice(before);
  assert.ok(after.every((url) => url.startsWith('http://127.0.0.1:2222/')), `已锁定端口后不应再试旧端口：${after}`);
});

test('一个候选都不可达时给出可解释错误（含尝试过的端口）', async () => {
  const api = makeApi({
    fetchImpl: async (url) => {
      throw new TypeError(`fetch failed: ${url}`);
    },
    discoverPorts: async () => [2222, 3333],
  });
  const outcome = await api.callRaw('session/list', { _request: {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'desktop_unreachable');
  assert.match(outcome.error.message, /1111/);
  assert.match(outcome.error.message, /2222/);
  assert.match(outcome.error.message, /3333/);
  assert.match(outcome.error.message, /desktop\.port/);
});

test('executeCommand：新版必填 submittedAttachments；旧版不认该字段时降级重试一次', async () => {
  const bodies = [];
  const api = makeApi({
    port: 4444,
    autoDiscover: false,
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return jsonResponse({
          result: {
            ok: false,
            error: { code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor: missing "submittedAttachments"' },
          },
        });
      }
      return jsonResponse({ result: { ok: true, value: { commandId: 'cmd-1', result: { kind: 'success', text: 'preset danger-full-access' } } } });
    },
  });

  const result = await api.executeCommand('session-11111111-2222-4333-8444-555555555555', '/permission danger-full-access');
  assert.equal(result.commandId, 'cmd-1');
  assert.equal(bodies.length, 2, '应在参数不匹配时重试一次');
  assert.deepEqual(bodies[0].payload.args.submittedAttachments, []);
  assert.equal(bodies[1].payload.args.submittedAttachments, undefined);
});

test('executeCommand：命令业务失败（kind=error）必须抛错，不能当成功', async () => {
  const api = makeApi({
    port: 4444,
    autoDiscover: false,
    fetchImpl: async () => jsonResponse({ result: { ok: true, value: { commandId: 'cmd-2', result: { kind: 'error', text: 'unknown preset "root"' } } } }),
  });
  await assert.rejects(
    () => api.executeCommand('session-11111111-2222-4333-8444-555555555555', '/permission root'),
    (err) => err.code === 'desktop_command_failed' && /unknown preset/.test(err.message),
  );
});
