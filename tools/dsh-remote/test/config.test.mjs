/**
 * 配置模块测试：默认值、校验、home 解析优先级、配置文件加载与容错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, defaultConfig, loadConfig, mergeConfig, resolveHome, validateConfig } from '../lib/config.mjs';

test('默认配置符合契约与工单要求', () => {
  const cfg = defaultConfig({});
  assert.equal(cfg.port, 8787, '默认端口必须是 8787');
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.apiVersion, 1);
  assert.equal(cfg.authRequired, true);
  assert.equal(cfg.maxConcurrent, 2, '默认并发上限 2');
  assert.equal(cfg.defaultTimeoutSec, 3600, '默认超时 3600 秒');
  assert.equal(cfg.maxTimeoutSec, 86400, '超时上限 86400 秒');
  assert.equal(cfg.events.bufferSize, 2000, '事件缓冲保留 2000 条');
  assert.equal(cfg.events.heartbeatMs, 15000, 'SSE 心跳 15 秒');
  assert.equal(cfg.limits.maxBodyBytes, 1_048_576, '请求体上限 1MB');
  assert.equal(cfg.limits.pairCodeTtlMs, 300_000, '配对码 5 分钟有效');
  assert.equal(cfg.limits.pairClaimPerMinute, 10);
  assert.equal(cfg.limits.authFailPerMinute, 30);
  assert.deepEqual(cfg.workspaceAllowlist, []);
  assert.equal(cfg.dsh.profile, 'headless');
});

test('mergeConfig：对象深合并、数组整体替换', () => {
  const merged = mergeConfig(defaultConfig({}), {
    limits: { maxBodyBytes: 2048 },
    workspaceAllowlist: ['D:\\a'],
  });
  assert.equal(merged.limits.maxBodyBytes, 2048);
  assert.equal(merged.limits.pairClaimPerMinute, 10, '未覆盖的兄弟字段应保留');
  assert.deepEqual(merged.workspaceAllowlist, ['D:\\a']);
});

test('mergeConfig：变参合并（回归：多余的 patch 参数曾被静默忽略）', () => {
  const merged = mergeConfig(
    defaultConfig({}),
    { maxConcurrent: 1, limits: { maxBodyBytes: 2048 } },
    { maxQueue: 0, limits: { pairClaimPerMinute: 2 } },
  );
  assert.equal(merged.maxConcurrent, 1, '第一个 patch 必须生效');
  assert.equal(merged.maxQueue, 0, '第二个 patch 必须生效（0 是合法值，不能被当作"未提供"）');
  assert.equal(merged.limits.maxBodyBytes, 2048, '跨 patch 的嵌套字段应各自生效');
  assert.equal(merged.limits.pairClaimPerMinute, 2);
  assert.equal(merged.port, 8787, '未被覆盖的字段保持默认');
});

test('validateConfig：非法值必须抛出 ConfigError 且信息可读', () => {
  const cases = [
    [{ port: 70000 }, /port/],
    [{ maxConcurrent: 0 }, /maxConcurrent/],
    [{ defaultTimeoutSec: 100, maxTimeoutSec: 10 }, /defaultTimeoutSec/],
    [{ workspaceAllowlist: ['relative\\path'] }, /绝对路径/],
    [{ workspaceAllowlist: [123] }, /workspaceAllowlist/],
    [{ defaultWorkspace: 'rel' }, /defaultWorkspace/],
    [{ host: '' }, /host/],
    [{ events: { heartbeatMs: 1 } }, /heartbeatMs/],
    [{ limits: { maxBodyBytes: 10 } }, /maxBodyBytes/],
    [{ dsh: { profile: '' } }, /dsh.profile/],
  ];
  for (const [patch, pattern] of cases) {
    assert.throws(() => validateConfig(mergeConfig(defaultConfig({}), patch), { env: {} }), ConfigError);
    try {
      validateConfig(mergeConfig(defaultConfig({}), patch), { env: {} });
    } catch (err) {
      assert.match(err.message, pattern, `错误信息应指出问题字段：${err.message}`);
    }
  }
});

test('validateConfig：派生 home/tasksDir/logsDir/devicesFile，默认工作区取白名单首项', () => {
  const cfg = validateConfig(
    mergeConfig(defaultConfig({}), { dshHome: path.join(os.tmpdir(), 'dshr-cfg'), workspaceAllowlist: ['D:\\a', 'D:\\b'] }),
    { env: {} },
  );
  assert.equal(cfg.home, path.resolve(path.join(os.tmpdir(), 'dshr-cfg')));
  assert.equal(cfg.tasksDir, path.join(cfg.home, 'tasks'));
  assert.equal(cfg.logsDir, path.join(cfg.home, 'logs'));
  assert.equal(cfg.devicesFile, path.join(cfg.home, 'devices.json'));
  assert.equal(cfg.credentialsFile, path.join(cfg.home, '.credentials.yaml'));
  assert.equal(cfg.defaultWorkspace, path.resolve('D:\\a'));
});

test('resolveHome：CLI > DSH_REMOTE_HOME > config.dshHome > DSH_HOME > 默认', () => {
  const cfg = { dshHome: 'D:\\from-config' };
  assert.equal(resolveHome(cfg, { cliHome: 'D:\\from-cli', env: { DSH_REMOTE_HOME: 'D:\\from-remote-env', DSH_HOME: 'D:\\from-dsh-env' } }), path.resolve('D:\\from-cli'));
  assert.equal(resolveHome(cfg, { env: { DSH_REMOTE_HOME: 'D:\\from-remote-env', DSH_HOME: 'D:\\from-dsh-env' } }), path.resolve('D:\\from-remote-env'));
  assert.equal(resolveHome(cfg, { env: { DSH_HOME: 'D:\\from-dsh-env' } }), path.resolve('D:\\from-config'));
  assert.equal(resolveHome({ dshHome: null }, { env: { DSH_HOME: 'D:\\from-dsh-env' } }), path.resolve('D:\\from-dsh-env'));
  assert.equal(resolveHome({ dshHome: null }, { env: {} }), path.join(os.homedir(), '.dsh-remote'));
});

test('loadConfig：读取 JSON 文件并叠加 CLI 覆盖，容忍 BOM', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-load-'));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(
    file,
    `\uFEFF${JSON.stringify({ port: 9001, maxConcurrent: 4, workspaceAllowlist: ['D:\\ws'], dshHome: path.join(dir, 'home') })}`,
    'utf8',
  );
  const cfg = loadConfig({ configPath: file, cliOverrides: { port: 9500 }, env: {} });
  assert.equal(cfg.port, 9500, 'CLI 覆盖优先于文件');
  assert.equal(cfg.maxConcurrent, 4);
  assert.equal(cfg.configPath, file);
  await fs.rm(dir, { recursive: true, force: true });
});

test('loadConfig：显式路径不存在 → ConfigError；默认目录缺失 → 仅警告并使用默认值', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-load2-'));
  assert.throws(
    () => loadConfig({ configPath: path.join(dir, 'missing.json'), env: {} }),
    (err) => err instanceof ConfigError && /不存在/.test(err.message),
  );

  const warnings = [];
  const cfg = loadConfig({ defaultDir: dir, env: {}, logger: { warn: (m) => warnings.push(m) } });
  assert.equal(cfg.port, 8787);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /未找到 config\.json/);

  const broken = path.join(dir, 'bad.json');
  await fs.writeFile(broken, '{ not json', 'utf8');
  assert.throws(() => loadConfig({ configPath: broken, env: {} }), /不是合法 JSON/);
  await fs.rm(dir, { recursive: true, force: true });
});
