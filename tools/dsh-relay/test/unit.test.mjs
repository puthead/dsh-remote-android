/**
 * 单元测试：工具函数（脱敏/原子写/摘要）、配置（默认值/校验/地址推导）、
 * 注册表（令牌轮换、只存 sha256、配对窗口 TTL 与冲突）。
 *
 * 为什么把这些放在同一个文件：它们共享同一条安全主线 ——
 * "明文令牌只出现一次、落盘只有 sha256、配对码只活在 TTL 窗口里"。
 * 放在一起评审时能一眼看全这条线的所有分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, API_VERSION, RELAY_VERSION, defaultConfig, deriveTunnelUrl, mergeConfig, resolveHome, validateConfig } from '../lib/config.mjs';
import { RelayRegistry } from '../lib/registry.mjs';
import { DEVICE_ID_RE, atomicWriteJson, hexEquals, newHomeId, normalizePairCode, randomPairCode, readJsonFile, redactSecrets, redactToken, sha256Hex } from '../lib/util.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-relay-unit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

// ---------------------------------------------------------------- 脱敏与工具

test('redactToken：前 4 位 + ****，超短令牌整体隐藏', () => {
  assert.equal(redactToken('dshr_9f2c8a1b2c3d4e5f'), 'dshr****');
  assert.equal(redactToken('abcd1234'), 'abcd****');
  assert.equal(redactToken('abc'), '****');
  assert.equal(redactToken(''), '');
  assert.equal(redactToken(undefined), '');
});

test('redactSecrets：日志文本里的 dshr_/home_/Bearer 令牌都被脱敏', () => {
  const text = 'auth Bearer dshr_abcdefghijklmnop homeId=home_9f2c8a1b2c3d device=dshr_zzzz1111yyyy';
  const out = redactSecrets(text);
  assert.ok(!out.includes('dshr_abcdefghijklmnop'), out);
  assert.ok(!out.includes('dshr_zzzz1111yyyy'), out);
  assert.match(out, /Bearer dshr\*\*\*\*/);
  assert.match(out, /home_9f2c\*\*\*\*/);
  // 令牌前 4 位保留（排障需要区分是哪把），但其余不可见
  assert.ok(!out.includes('abcdefghijklmnop'));
});

test('sha256Hex/hexEquals：摘要稳定且固定时间比较可用', () => {
  const a = sha256Hex('homeToken-1');
  assert.equal(a.length, 64);
  assert.equal(a, sha256Hex('homeToken-1'));
  assert.ok(hexEquals(a, sha256Hex('homeToken-1')));
  assert.ok(!hexEquals(a, sha256Hex('homeToken-2')));
  assert.ok(!hexEquals(a, a.slice(0, 32)));
});

test('homeId / 配对码形状符合契约 §1', () => {
  const homeId = newHomeId();
  assert.match(homeId, /^home_[A-Za-z0-9_-]{22}$/);
  for (let i = 0; i < 20; i++) assert.match(randomPairCode(), /^\d{6}$/);
  assert.equal(normalizePairCode(482913), '482913');
  assert.equal(normalizePairCode('000042'), '000042');
  assert.equal(normalizePairCode('12345'), null);
  assert.equal(normalizePairCode('abcdef'), null);
  assert.equal(normalizePairCode(null), null);
  assert.ok(DEVICE_ID_RE.test('8f3c1a2b-1111-4222-8333-444455556666'));
  assert.ok(!DEVICE_ID_RE.test('8F3C1A2B-1111-4222-8333-444455556666'), 'deviceId 必须小写（v1 裁定 A4）');
});

test('原子写 + 损坏隔离：坏 JSON 不会让服务起不来', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'homes.json');
  await atomicWriteJson(file, { version: 2, homes: [] });
  const ok = await readJsonFile(file, null);
  assert.equal(ok.corrupt, false);
  assert.deepEqual(ok.value, { version: 2, homes: [] });

  await fs.writeFile(file, '{ 这不是 JSON', 'utf8');
  const broken = await readJsonFile(file, { fallback: true });
  assert.equal(broken.corrupt, true);
  assert.deepEqual(broken.value, { fallback: true });
  const entries = await fs.readdir(dir);
  assert.ok(
    entries.some((name) => name.includes('.corrupt-')),
    `应为损坏文件留隔离副本，实际目录：${entries.join(',')}`,
  );
  const missing = await readJsonFile(path.join(dir, 'nope.json'), 'x');
  assert.equal(missing.value, 'x');
  assert.equal(missing.error, null);
});

// ---------------------------------------------------------------- 配置

test('默认配置：端口 9443 / apiVersion 2 / TLS off / 契约上限', () => {
  const cfg = validateConfig(defaultConfig({}), { cliHome: 'C:\\tmp\\relay-home' });
  assert.equal(cfg.port, 9443);
  assert.equal(cfg.apiVersion, API_VERSION);
  assert.equal(cfg.relayVersion, RELAY_VERSION);
  assert.equal(cfg.tls.mode, 'off');
  assert.equal(cfg.limits.maxStreamsPerConnection, 64, '契约 §3.2：单连接 64 流');
  assert.equal(cfg.limits.maxChunkBytes, 262_144, '契约 §3.2：单 chunk ≤ 256 KiB');
  assert.equal(cfg.limits.maxStreamBufferBytes, 1_048_576, '契约 §3.2：单流缓冲 ≤ 1 MiB');
  assert.equal(cfg.limits.backpressureBytes, 4_194_304, '契约 §3.2：4 MiB 反压');
  assert.equal(cfg.heartbeat.intervalMs, 30_000, '契约 §3.1：心跳 30s');
  assert.equal(cfg.pairWindowTtlMs, 300_000, '契约 §3.4：配对窗口 5 分钟');
  assert.equal(cfg.homesFile, path.join('C:\\tmp\\relay-home', 'homes.json'));
  assert.equal(cfg.logsDir, path.join('C:\\tmp\\relay-home', 'logs'));
});

test('配置校验：非法值必须报 ConfigError（不静默取默认）', () => {
  const base = defaultConfig({});
  assert.throws(() => validateConfig(mergeConfig(base, { port: 70_000 }), { cliHome: 'C:\\x' }), ConfigError);
  assert.throws(() => validateConfig(mergeConfig(base, { port: '9443' }), { cliHome: 'C:\\x' }), ConfigError);
  assert.throws(() => validateConfig(mergeConfig(base, { tls: { mode: 'maybe' } }), { cliHome: 'C:\\x' }), ConfigError);
  assert.throws(() => validateConfig(mergeConfig(base, { tls: { mode: 'file' } }), { cliHome: 'C:\\x' }), /certFile/);
  assert.throws(() => validateConfig(mergeConfig(base, { heartbeat: { intervalMs: 1 } }), { cliHome: 'C:\\x' }), ConfigError);
  assert.throws(() => validateConfig(mergeConfig(base, { limits: { maxStreamsPerConnection: 0 } }), { cliHome: 'C:\\x' }), ConfigError);
  assert.throws(() => validateConfig(mergeConfig(base, { relayName: '  ' }), { cliHome: 'C:\\x' }), ConfigError);
  assert.throws(() => validateConfig(mergeConfig(base, { publicUrl: 'relay.example.com' }), { cliHome: 'C:\\x' }), ConfigError);
});

test('mergeConfig：变参深合并，数组整体覆盖', () => {
  const merged = mergeConfig(defaultConfig({}), { limits: { maxChunkBytes: 1024 } }, { port: 1234 });
  assert.equal(merged.limits.maxChunkBytes, 1024);
  assert.equal(merged.limits.maxStreamsPerConnection, 64, '未覆盖的字段必须保留默认值');
  assert.equal(merged.port, 1234);
});

test('resolveHome：CLI > 环境变量 > 配置 > 默认', () => {
  const base = defaultConfig({});
  const env = { DSH_RELAY_HOME: 'C:\\env-home' };
  assert.equal(resolveHome({ ...base, home: 'C:\\cfg-home' }, { cliHome: 'C:\\cli-home', env }), 'C:\\cli-home');
  assert.equal(resolveHome({ ...base, home: 'C:\\cfg-home' }, { env }), 'C:\\env-home');
  assert.equal(resolveHome({ ...base, home: 'C:\\cfg-home' }, { env: {} }), 'C:\\cfg-home');
  assert.ok(resolveHome(base, { env: {} }).endsWith('.dsh-relay'));
});

test('deriveTunnelUrl：off→ws，自签→wss，relayName 带端口不重复追加', () => {
  const off = validateConfig(mergeConfig(defaultConfig({}), { relayName: 'relay.local', port: 9443 }), { cliHome: 'C:\\x' });
  assert.equal(deriveTunnelUrl(off), 'ws://relay.local:9443/api/v2/tunnel/device');

  const tlsCfg = validateConfig(mergeConfig(defaultConfig({}), { relayName: 'relay.example.com', port: 443, tls: { mode: 'selfsigned' } }), { cliHome: 'C:\\x' });
  assert.equal(deriveTunnelUrl(tlsCfg), 'wss://relay.example.com/api/v2/tunnel/device');

  const withPort = validateConfig(mergeConfig(defaultConfig({}), { relayName: 'relay.example.com:8443', tls: { mode: 'selfsigned' } }), { cliHome: 'C:\\x' });
  assert.equal(deriveTunnelUrl(withPort), 'wss://relay.example.com:8443/api/v2/tunnel/device');

  const explicit = validateConfig(mergeConfig(defaultConfig({}), { publicUrl: 'https://relay.example.com/' }), { cliHome: 'C:\\x' });
  assert.equal(deriveTunnelUrl(explicit), 'wss://relay.example.com/api/v2/tunnel/device', 'http(s) 基址也要换算成 ws(s)');
});

// ---------------------------------------------------------------- 注册表

async function makeRegistry(t, { now = Date.now, ttl = 300_000 } = {}) {
  const dir = await tempDir(t);
  const file = path.join(dir, 'homes.json');
  const registry = new RelayRegistry({ file, now, pairWindowTtlMs: ttl });
  await registry.load();
  return { dir, file, registry };
}

test('注册表：同一 homeName 复用 homeId 并轮换 homeToken（旧令牌立即失效）', async (t) => {
  const { file, registry } = await makeRegistry(t);
  const first = registry.registerHome({ homeName: 'DESKTOP-A', gatewayVersion: '2.0.0' });
  assert.match(first.homeId, /^home_/);
  assert.equal(first.rotated, false);
  assert.ok(registry.findHomeByToken(first.homeToken));

  const second = registry.registerHome({ homeName: 'DESKTOP-A', gatewayVersion: '2.0.0' });
  assert.equal(second.homeId, first.homeId, '同名 home 必须复用记录');
  assert.equal(second.rotated, true);
  assert.notEqual(second.homeToken, first.homeToken);
  assert.equal(registry.findHomeByToken(first.homeToken), null, '旧 homeToken 必须立即失效');
  assert.ok(registry.findHomeByToken(second.homeToken));

  const other = registry.registerHome({ homeName: 'DESKTOP-B' });
  assert.notEqual(other.homeId, first.homeId);
  assert.equal(registry.stats().homes, 2);

  await registry.flush();
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes(second.homeToken), 'homes.json 绝不能出现明文 homeToken');
  assert.ok(raw.includes(sha256Hex(second.homeToken)), 'homes.json 必须存 sha256(homeToken)');
});

test('注册表：device 令牌只存 sha256，同 deviceId 再次 claim 即轮换并吊销', async (t) => {
  const { file, registry } = await makeRegistry(t);
  const home = registry.registerHome({ homeName: 'DESKTOP-A' });
  const bind1 = registry.bindDevice({ homeId: home.homeId, deviceId: 'dev-1', deviceName: 'Xiaomi 14', deviceToken: 'dshr_token_one_0001', tokenId: 'tok_1' });
  assert.equal(bind1.rotated, false);
  assert.deepEqual(registry.findDeviceByToken('dshr_token_one_0001')?.device.deviceId, 'dev-1');

  const bind2 = registry.bindDevice({ homeId: home.homeId, deviceId: 'dev-1', deviceName: 'Xiaomi 14', deviceToken: 'dshr_token_two_0002', tokenId: 'tok_2' });
  assert.equal(bind2.rotated, true);
  assert.equal(registry.findDeviceByToken('dshr_token_one_0001'), null, '旧 deviceToken 必须立即失效');
  assert.equal(registry.findDeviceByToken('dshr_token_two_0002')?.device.tokenId, 'tok_2');

  await registry.flush();
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('dshr_token_two_0002'));
  assert.ok(raw.includes(sha256Hex('dshr_token_two_0002')));

  assert.equal(registry.revokeDevice(home.homeId, 'dev-1'), true);
  assert.equal(registry.findDeviceByToken('dshr_token_two_0002'), null);
  assert.equal(registry.stats().devices, 0);
});

test('注册表：重启后从 homes.json 恢复（索引重建，令牌仍可用）', async (t) => {
  const { file, registry } = await makeRegistry(t);
  const home = registry.registerHome({ homeName: 'DESKTOP-A' });
  registry.bindDevice({ homeId: home.homeId, deviceId: 'dev-1', deviceToken: 'dshr_persist_me_0001' });
  await registry.flush();

  const reloaded = new RelayRegistry({ file, logger: null });
  const count = await reloaded.load();
  assert.equal(count, 1);
  assert.ok(reloaded.findHomeByToken(home.homeToken), 'homeToken 摘要恢复后仍能鉴权');
  assert.ok(reloaded.findDeviceByToken('dshr_persist_me_0001'), 'deviceToken 摘要恢复后仍能鉴权');
  assert.equal(reloaded.listHomes()[0].homeName, 'DESKTOP-A');
});

test('配对窗口：声明/查询/关闭 + TTL 过期自动清除（§3.4）', async (t) => {
  let now = 1_000_000;
  const { registry } = await makeRegistry(t, { now: () => now, ttl: 300_000 });
  const home = registry.registerHome({ homeName: 'DESKTOP-A' });

  const opened = registry.openPairWindow(home.homeId, { code: '482913' });
  assert.equal(opened.ok, true);
  assert.equal(opened.code, '482913');
  assert.equal(opened.expiresAt, now + 300_000);
  assert.deepEqual(registry.getPairWindow(home.homeId), { open: true, expiresAt: now + 300_000 });
  assert.equal(registry.findHomeByPairCode('482913').homeId, home.homeId);

  // 过期时间被夹紧在上限内（网关声明更长也没用）
  const clamped = registry.openPairWindow(home.homeId, { code: '111111', expiresAt: now + 999_999 });
  assert.equal(clamped.expiresAt, now + 300_000);

  now += 300_001;
  assert.deepEqual(registry.getPairWindow(home.homeId), { open: false, expiresAt: null });
  assert.equal(registry.findHomeByPairCode('111111'), null, '过期码不得再命中');
  assert.equal(registry.closePairWindow(home.homeId), false, '窗口已过期，close 应为幂等 no-op');
});

test('配对窗口：与其他 home 的有效码撞号 → code_conflict（网关换码重试）', async (t) => {
  const { registry } = await makeRegistry(t);
  const a = registry.registerHome({ homeName: 'DESKTOP-A' });
  const b = registry.registerHome({ homeName: 'DESKTOP-B' });
  assert.equal(registry.openPairWindow(a.homeId, { code: '482913' }).ok, true);
  const conflict = registry.openPairWindow(b.homeId, { code: '482913' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'code_conflict');
  assert.equal(registry.findHomeByPairCode('482913').homeId, a.homeId, '冲突时不得覆盖原持有者');

  // 同一个 home 重复声明同一个码是允许的（覆盖自己的窗口）
  assert.equal(registry.openPairWindow(a.homeId, { code: '482913' }).ok, true);
  assert.equal(registry.openPairWindow(b.homeId, { code: '999999' }).ok, true);
  assert.equal(registry.findHomeByPairCode('999999').homeId, b.homeId);

  const bad = registry.openPairWindow(a.homeId, { code: 'abcdef' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_request');
});

test('注册表：homes.json 不落盘配对码（配对码只活在内存 TTL 窗口里）', async (t) => {
  const { file, registry } = await makeRegistry(t);
  const home = registry.registerHome({ homeName: 'DESKTOP-A' });
  registry.openPairWindow(home.homeId, { code: '482913' });
  await registry.flush();
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('482913'), 'homes.json 不得出现配对码');
});
