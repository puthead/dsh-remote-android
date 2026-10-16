/**
 * 持久化测试：homes.json 的原子性、并发写、损坏隔离、热加载、重启后令牌仍有效。
 *
 * 为什么单独成文件：中继是"无状态业务、有状态身份"，`homes.json` 是唯一会被写坏的资产；
 * 一旦半截 JSON 落盘，重启后所有 PC/手机绑定全丢，必须被专门盯着。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRelay } from '../lib/http.mjs';
import { RelayRegistry } from '../lib/registry.mjs';
import { defaultConfig, mergeConfig, validateConfig } from '../lib/config.mjs';
import { sha256Hex } from '../lib/util.mjs';
import { startRelay, waitFor } from './helpers.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-relay-persist-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

test('并发注册 + 并发 flush：50 条记录一条不丢，文件始终是合法 JSON', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'homes.json');
  const registry = new RelayRegistry({ file, logger: null });
  await registry.load();

  const flushes = [];
  for (let i = 0; i < 50; i++) {
    registry.registerHome({ homeName: `PC-${String(i).padStart(2, '0')}` });
    flushes.push(registry.flush());
  }
  await Promise.all(flushes);

  const text = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(text); // 半截 JSON 会在这里直接抛错
  assert.equal(parsed.version, 2);
  assert.equal(parsed.homes.length, 50, '并发 flush 不得互相覆盖');

  const reloaded = new RelayRegistry({ file, logger: null });
  assert.equal(await reloaded.load(), 50);
  assert.equal(reloaded.listHomes().length, 50);
});

test('落盘内容审计：任何令牌都只以 sha256 形式出现（home + device 混跑）', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'homes.json');
  const registry = new RelayRegistry({ file, logger: null });
  await registry.load();

  const plaintexts = [];
  for (let i = 0; i < 5; i++) {
    const home = registry.registerHome({ homeName: `PC-${i}` });
    plaintexts.push(home.homeToken);
    for (let d = 0; d < 3; d++) {
      const token = `dshr_plaintext_${i}_${d}_${'x'.repeat(20)}`;
      registry.bindDevice({ homeId: home.homeId, deviceId: `dev-${i}-${d}`, deviceToken: token });
      plaintexts.push(token);
    }
  }
  registry.openPairWindow(registry.listHomes()[0].homeId, { code: '482913' });
  await registry.flush();

  const raw = await fs.readFile(file, 'utf8');
  for (const secret of plaintexts) assert.ok(!raw.includes(secret), `homes.json 泄露了明文：${secret}`);
  assert.ok(!raw.includes('482913'), 'homes.json 不得出现配对码');
  for (const secret of plaintexts) assert.ok(raw.includes(sha256Hex(secret)), '缺失摘要说明绑定没真正落盘');
});

test('损坏文件：启动时隔离为 .corrupt-*，服务照常起来（不因坏文件拒绝服务）', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'homes.json');
  await fs.writeFile(file, '{"homes": [{"homeId": "home_trunc', 'utf8');

  const registry = new RelayRegistry({ file, logger: null });
  const count = await registry.load();
  assert.equal(count, 0);
  const entries = await fs.readdir(dir);
  assert.ok(entries.some((name) => name.startsWith('homes.json.corrupt-')), `实际目录：${entries.join(',')}`);
  // 隔离后新注册仍可正常落盘
  registry.registerHome({ homeName: 'PC-AFTER-CORRUPT' });
  await registry.flush();
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(parsed.homes.length, 1);
});

test('热加载：外部新增 home 立即生效、已有窗口不被清掉（运行期状态与文件状态分离）', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'homes.json');
  const registry = new RelayRegistry({ file, logger: null });
  await registry.load();
  const original = registry.registerHome({ homeName: 'PC-ORIGINAL' });
  registry.openPairWindow(original.homeId, { code: '482913' });
  await registry.flush();

  // 另一个进程新增一台 PC
  const external = new RelayRegistry({ file, logger: null });
  await external.load();
  const added = external.registerHome({ homeName: 'PC-ADDED' });
  await external.flush();

  assert.equal(await registry.reloadIfChanged(), true);
  assert.ok(registry.findHomeByToken(original.homeToken), '已有 home 必须保留');
  assert.ok(registry.findHomeByToken(added.homeToken), '外部新增的 home 必须被加载');
  assert.deepEqual(registry.getPairWindow(original.homeId), { open: true, expiresAt: registry.getPairWindow(original.homeId).expiresAt });
  assert.equal(registry.getPairWindow(original.homeId).open, true, '热加载不得清掉运行期的配对窗口');
  assert.equal(await registry.reloadIfChanged(), false, '内容未变时不应重复重载');
});

test('热加载：外部轮换令牌 → 运行中的 relay 断开旧连接并接受新令牌（无需重启）', async (t) => {
  const h = await startRelay(t, { registryReloadIntervalMs: 200 });
  const registered = await h.registerHome({ homeName: 'PC-HOT' });
  const { tunnel } = await h.openHomeTunnel(registered.json.homeToken);

  const external = new RelayRegistry({ file: h.config.homesFile, logger: null });
  await external.load();
  const rotated = external.registerHome({ homeName: 'PC-HOT' });
  await external.flush();

  await tunnel.waitClose(5000);
  await waitFor(() => h.relay.stats().hub.homes === 0, { timeoutMs: 5000, what: '旧连接被断开' });
  const fresh = await h.openHomeTunnel(rotated.homeToken);
  assert.equal(fresh.tunnel.open, true);
  fresh.tunnel.destroy();
});

test('重启后令牌仍有效：真实 relay 关停 → 新实例 → 旧 homeToken / deviceToken 都能握手', async (t) => {
  const dir = await tempDir(t);
  const home = path.join(dir, 'home');
  const makeConfig = () =>
    validateConfig(
      mergeConfig(defaultConfig({}), { host: '127.0.0.1', port: 0, relayName: 'relay.restart.test', relaySecret: 's', log: { toConsole: false } }),
      { cliHome: home },
    );

  const first = await createRelay(makeConfig());
  const p1 = await first.listen();
  const homeToken = first.registry.registerHome({ homeName: 'PC-RESTART' }).homeToken;
  const deviceToken = 'dshr_restart_token_0001_abcdefghijkl';
  const homeRecord = first.registry.findHomeByToken(homeToken);
  first.registry.bindDevice({ homeId: homeRecord.homeId, deviceId: 'dev-restart', deviceToken, deviceName: 'Xiaomi' });
  await first.registry.flush();
  await first.close();

  const second = await createRelay(makeConfig());
  const p2 = await second.listen();
  assert.ok(p2 > 0);
  const restoredHome = second.registry.findHomeByToken(homeToken);
  assert.ok(restoredHome, '重启后 homeToken 摘要必须可用');
  assert.equal(restoredHome.homeId, homeRecord.homeId);
  const restoredDevice = second.registry.findDeviceByToken(deviceToken);
  assert.ok(restoredDevice, '重启后 deviceToken 摘要必须可用');
  assert.equal(restoredDevice.device.deviceId, 'dev-restart');

  // 真实握手：device 隧道用旧令牌可连（home 离线 → 回 notice）
  const { openTunnel } = await import('./ws-client.mjs');
  const device = await openTunnel(`ws://127.0.0.1:${p2}/api/v2/tunnel/device`, { role: 'device', token: deviceToken });
  const ready = await device.handshake();
  assert.equal(ready.homeId, homeRecord.homeId);
  assert.equal(ready.homeOnline, false);
  const notice = await device.waitFrame((frame) => frame.t === 'notice', { timeoutMs: 2000 });
  assert.equal(notice.kind, 'home_offline');
  device.destroy();
  await second.close();
  void p1;
});
