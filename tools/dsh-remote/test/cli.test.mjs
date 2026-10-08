/**
 * CLI 子命令测试（A2-6）：`devices list` / `devices revoke <tokenId>` 必须与 REST
 * 操作**同一份设备库**（%DSH_HOME%/devices.json）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHarness } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.join(HERE, '..', 'gateway.mjs');

/** 运行 CLI 子命令并收集输出。 */
function runCli(args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATEWAY, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('devices list / revoke 与 REST 共用同一份设备库', async (t) => {
  const h = await startHarness(t);

  // REST 视角：网关已配对 1 台设备
  const viaRest = await h.request('GET', '/api/v1/devices');
  assert.equal(viaRest.json.devices.length, 1);
  const tokenId = viaRest.json.devices[0].tokenId;
  assert.ok(h.token.startsWith('dshr_'), 'REST 颁发的令牌应当是 dshr_ 前缀');

  // CLI 视角：同一个 home 应当看到同一台设备
  const list = await runCli(['devices', 'list', '--home', h.home]);
  assert.equal(list.code, 0, `devices list 退出码应为 0，stderr=${list.stderr}`);
  assert.match(list.stdout, /已配对设备（1）/);
  assert.ok(list.stdout.includes(tokenId), 'CLI 列表必须包含 REST 颁发的 tokenId');
  assert.ok(list.stdout.includes('test-device'), 'CLI 列表必须显示设备名');
  assert.ok(!list.stdout.includes(h.token), 'CLI 不得打印令牌明文（只允许 tokenId）');

  // CLI 吊销 → REST 立即失效（证明共用同一份存储，而不是两份副本）
  const revoke = await runCli(['devices', 'revoke', tokenId, '--home', h.home]);
  assert.equal(revoke.code, 0, `devices revoke 退出码应为 0，stderr=${revoke.stderr}`);
  assert.match(revoke.stdout, /已吊销令牌/);

  const afterRevoke = await h.request('GET', '/api/v1/tasks', { token: h.token });
  assert.equal(afterRevoke.status, 401, 'CLI 吊销后，REST 必须立即拒绝该令牌');

  // 再吊销一次：应报未找到并以非 0 退出（幂等但不假装成功）
  const again = await runCli(['devices', 'revoke', tokenId, '--home', h.home]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /未找到令牌/);

  const emptyList = await runCli(['devices', 'list', '--home', h.home]);
  assert.match(emptyList.stdout, /当前没有已配对设备/);
});

test('CLI：--help / --version 可用且不启动服务', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /dsh-remote v/);
  assert.match(help.stdout, /devices revoke/);
  assert.match(help.stdout, /--home/);

  const version = await runCli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('CLI：未知命令/未知选项以非 0 退出并给出用法', async () => {
  const unknown = await runCli(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /未知命令/);

  const badOption = await runCli(['serve', '--nope']);
  assert.equal(badOption.code, 2);
  assert.match(badOption.stderr, /未知选项/);
});

test('CLI：workspaces 打印白名单与默认工作区标记', async (t) => {
  const h = await startHarness(t);
  const cfgPath = path.join(h.sandbox.root, 'cli-config.json');
  await fs.writeFile(
    cfgPath,
    JSON.stringify({ dshHome: h.home, workspaceAllowlist: [h.workspace], defaultWorkspace: h.workspace }),
    'utf8',
  );
  const res = await runCli(['workspaces', '--config', cfgPath, '--home', h.home]);
  assert.equal(res.code, 0, `workspaces 应以 0 退出，stderr=${res.stderr}`);
  assert.ok(res.stdout.includes(h.workspace), '应打印白名单路径');
  assert.match(res.stdout, /\* /, '默认工作区应有 * 标记');
  assert.match(res.stdout, /\(存在\)/);

  // 显式指定的配置文件不存在 → 明确报错（排障友好），而不是静默用默认值
  const bad = await runCli(['workspaces', '--config', path.join(h.sandbox.root, 'missing.json')]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /配置文件不存在/);
});
