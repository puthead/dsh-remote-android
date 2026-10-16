// 关闭路径回归：现场出现过「隧道已拆、进程却静默挂着」，systemd 等满 90 秒才 SIGKILL（2026-10-13）。
// 这里锁住三件事：双隧道在线时 close() 必须很快返回、关闭后端口立刻可复用、以及 server.close
// 回调永不返回时也必须有上限（3 秒兜底），不允许再把停机拖到 systemd 的 TimeoutStopSec。
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { setupPairing, startRelay } from './helpers.mjs';

test('关闭：home + device 双隧道在线时 close() 很快返回', async (t) => {
  const h = await setupPairing(t, {});
  assert.equal(h.homeReady?.t, 'ready');
  assert.equal(h.deviceReady?.t, 'ready', 'device 隧道应已 ready（否则这条回归测不到双隧道场景）');

  const t0 = Date.now();
  await h.relay.close();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `双隧道在线时 close() 应很快返回，实际 ${elapsed}ms`);
});

test('关闭：close() 之后监听端口立刻可以被重新绑定', async (t) => {
  const h = await startRelay(t, {});
  const registered = await h.registerHome({ homeName: 'DESKTOP-CLOSE' });
  await h.openHomeTunnel(registered.json.homeToken);

  await h.relay.close();
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(h.port, '127.0.0.1', resolve);
  });
  assert.equal(server.address().port, h.port, '关闭后同一端口应可立即复用');
  await new Promise((resolve) => server.close(resolve));
});

test('关闭：server.close 回调永不返回时也必须有上限（回归：现场卡满 90 秒）', async (t) => {
  const h = await startRelay(t, {});
  const realClose = h.relay.server.close.bind(h.relay.server);
  // 造出“回调永不触发”的现场：不调用回调即可
  h.relay.server.close = () => h.relay.server;

  const t0 = Date.now();
  await h.relay.close();
  const elapsed = Date.now() - t0;
  h.relay.server.close = realClose;
  await new Promise((resolve) => realClose(() => resolve()));

  assert.ok(elapsed >= 2500, `应走 3 秒兜底路径，实际 ${elapsed}ms`);
  assert.ok(elapsed < 6000, `兜底路径也必须有上限，实际 ${elapsed}ms`);
});
