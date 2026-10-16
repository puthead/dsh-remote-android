/**
 * CLI 测试：`serve` / `init` / `home-token` / `homes` / `version`。
 *
 * 全部用**真实子进程**（`process.execPath` = DSH 自带 node）跑，因为这些子命令是
 * S1 运维脚本（setup-relay/start-relay/relay-pair）唯一的对接面：
 * 输出格式（stdout 单行 JSON、日志走 stderr）一旦漂移，脚本就会解析失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { httpRequest, sleep, waitFor } from './helpers.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, '..', 'relay.mjs');

/** 跑一次 CLI，返回 { code, stdout, stderr, json }。 */
async function runCli(args, { timeoutMs = 30_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [RELAY, ...args], { timeout: timeoutMs, windowsHide: true });
    return { code: 0, stdout, stderr, json: parseJson(stdout) };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '', json: parseJson(err.stdout ?? '') };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(String(text).trim());
  } catch {
    return null;
  }
}

async function tempHome(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-relay-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return path.join(dir, 'relay-home');
}

test('version：输出版本 JSON（apiVersion=2）', async () => {
  const { code, json, stderr } = await runCli(['version']);
  assert.equal(code, 0, stderr);
  assert.equal(json.ok, true);
  assert.equal(json.apiVersion, 2);
  assert.equal(json.relayVersion, '2.0.1');
  assert.match(json.node, /^v\d+/);
});

test('init --public-url / --common-name：必须落盘并决定 tunnelUrl（部署"手机连不上"的根因回归）', async (t) => {
  const home = await tempHome(t);
  // 为什么这条必须存在：`deploy-relay.ps1` 会把 -PublicUrl 透传给远端 `init`，
  // 但 init 曾经**手工逐项拼配置且漏了 public-url**（只覆盖 relay-name/host/port/secret/tls），
  // 于是传了也静默丢弃 → 中继退回按 relayName 派生 tunnelUrl → 手机拿到
  // `wss://<IP>:<port>`，与自签证书 CN 不匹配且不可达，表现为"手机永远连不上"。
  // 两侧各自的测试都覆盖不到这个接缝：中继测的是配置文件→tunnelUrl 的推导，
  // 部署脚本测的是命令是否打印，没人测「CLI 参数有没有真的写进配置」。
  const { code, json, stderr } = await runCli([
    'init', '--home', home, '--force',
    '--port', '9443', '--host', '0.0.0.0',
    '--relay-name', 'relay.example.com',
    '--tls-mode', 'selfsigned',
    '--common-name', 'relay.example.com',
    '--public-url', 'wss://relay.example.com',
    '--relay-secret', 'TEST_SECRET_0123456789abcdef',
  ]);
  assert.equal(code, 0, stderr);

  const cfg = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.publicUrl, 'wss://relay.example.com', 'publicUrl 必须落盘（否则部署时被静默丢弃）');
  assert.equal(cfg.tls.commonName, 'relay.example.com', 'commonName 必须落盘（否则自签证书主机名不匹配）');

  // tunnelUrl 必须用 publicUrl 而不是 relayName 派生
  assert.equal(json.tunnelUrl, 'wss://relay.example.com/api/v2/tunnel/device');

  // 对照：不传 publicUrl 时仍按 relayName 派生（行为不回归）
  const home2 = await tempHome(t);
  const second = await runCli([
    'init', '--home', home2, '--force', '--port', '9443',
    '--relay-name', '47.98.12.34', '--tls-mode', 'off',
    '--relay-secret', 'TEST_SECRET_0123456789abcdef',
  ]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(home2, 'config.json'), 'utf8')).publicUrl, null);
  assert.equal(second.json.tunnelUrl, 'ws://47.98.12.34:9443/api/v2/tunnel/device');
});

test('init --tls-mode file --cert/--key：证书路径必须落盘（公网正式证书形态的 CLI 接缝）', async (t) => {
  const home = await tempHome(t);
  // 为什么这条必须存在：`deploy-relay.ps1 -TlsMode file` 会传 `--tls-mode file --cert ... --key ...`，
  // 但 init 曾经只认 relay-name/host/port/secret/tls-mode/public-url/common-name ——
  // `--cert`/`--key` 被静默丢弃 → validateConfig 直接抛
  // "tls.mode=file 时必须同时提供 tls.certFile 与 tls.keyFile"，
  // 结果是「公网 + 正式证书（wss:// + Let's Encrypt）」这条唯一的生产形态**根本无法初始化**。
  const seed = await runCli(['init', '--home', home, '--relay-name', 'relay.file.cli', '--tls-mode', 'selfsigned']);
  assert.equal(seed.code, 0, seed.stderr);

  const result = await runCli([
    'init', '--home', home, '--force',
    '--port', '9443', '--host', '0.0.0.0',
    '--relay-name', 'relay.file.cli',
    '--tls-mode', 'file', '--cert', 'tls/relay.crt', '--key', 'tls/relay.key',
    '--public-url', 'wss://203.0.113.9:9443',
  ]);
  assert.equal(result.code, 0, result.stderr);

  const cfg = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.tls.mode, 'file');
  // 相对路径按运行目录解析（绝对路径也接受）——两种写法都必须指向 home 下的同一份文件
  assert.equal(path.resolve(home, cfg.tls.certFile), path.join(home, 'tls', 'relay.crt'));
  assert.equal(path.resolve(home, cfg.tls.keyFile), path.join(home, 'tls', 'relay.key'));
  assert.equal(result.json.tunnelUrl, 'wss://203.0.113.9:9443/api/v2/tunnel/device');
});

test('init：写 config.json/homes.json/logs 并输出 JSON；重复执行不覆盖已有配置', async (t) => {
  const home = await tempHome(t);
  const first = await runCli(['init', '--home', home, '--port', '19443', '--relay-name', 'relay.cli.test', '--tls-mode', 'off']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.port, 19443);
  assert.equal(first.json.configPath, path.join(home, 'config.json'));
  assert.ok(first.json.relaySecret.length >= 16, 'init 必须生成 relaySecret');

  const config = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'));
  assert.equal(config.relayName, 'relay.cli.test');
  assert.equal(config.tls.mode, 'off');
  await fs.access(path.join(home, 'homes.json'));
  await fs.access(path.join(home, 'logs'));

  // 二次 init 不带 --force：保留原 relaySecret（不能把已下发给网关的口令改掉）
  const second = await runCli(['init', '--home', home, '--port', '19443', '--relay-name', 'relay.cli.test', '--tls-mode', 'off']);
  assert.equal(second.code, 0);
  const config2 = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'));
  assert.equal(config2.relaySecret, config.relaySecret);
});

test('init --tls-mode selfsigned：生成自签证书并落盘', async (t) => {
  const home = await tempHome(t);
  const result = await runCli(['init', '--home', home, '--relay-name', 'relay.tls.cli', '--tls-mode', 'selfsigned']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.tls.mode, 'selfsigned');
  assert.equal(result.json.tls.generated, true);
  const cert = await fs.readFile(result.json.tls.certFile, 'utf8');
  assert.match(cert, /BEGIN CERTIFICATE/);
  const key = await fs.readFile(result.json.tls.keyFile, 'utf8');
  assert.match(key, /BEGIN PRIVATE KEY/);
});

test('home-token：注册并打印一次明文令牌；重复调用轮换；homes 可列出', async (t) => {
  const home = await tempHome(t);
  await runCli(['init', '--home', home, '--relay-name', 'relay.cli.test', '--tls-mode', 'off']);

  const first = await runCli(['home-token', '--home', home, '--name', 'DESKTOP-CLI']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.json.homeId, /^home_/);
  assert.ok(first.json.homeToken.length > 30);
  assert.equal(first.json.rotated, false);
  assert.match(first.json.tunnelHomeUrl, /^ws:\/\/relay\.cli\.test:9443\/api\/v2\/tunnel\/home$/);
  assert.match(first.stderr, /只在此处出现一次/);
  assert.match(first.stderr, new RegExp(first.json.homeToken.slice(0, 4)), '提示里也必须只出现前 4 位');

  const raw = await fs.readFile(path.join(home, 'homes.json'), 'utf8');
  assert.ok(!raw.includes(first.json.homeToken), 'homes.json 不得有明文令牌');

  const second = await runCli(['home-token', '--home', home, '--name', 'DESKTOP-CLI']);
  assert.equal(second.json.homeId, first.json.homeId, '同名必须复用 homeId');
  assert.equal(second.json.rotated, true);
  assert.notEqual(second.json.homeToken, first.json.homeToken);

  const listed = await runCli(['homes', '--home', home]);
  assert.equal(listed.code, 0);
  assert.equal(listed.json.homes.length, 1);
  assert.equal(listed.json.homes[0].homeName, 'DESKTOP-CLI');
  assert.ok(!JSON.stringify(listed.json).includes(second.json.homeToken), 'homes 输出不得含明文令牌');
});

test('serve：stdout 只输出一行 JSON（含真实端口），日志走 stderr，/health 可访问', async (t) => {
  const home = await tempHome(t);
  await runCli(['init', '--home', home, '--relay-name', 'relay.serve.test', '--tls-mode', 'off', '--port', '0']);

  const child = spawn(process.execPath, [RELAY, 'serve', '--home', home], { windowsHide: true });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));

  const info = await waitFor(() => parseJson(stdout), { timeoutMs: 15_000, what: 'serve 启动 JSON' });
  assert.equal(info.ok, true);
  assert.ok(info.port > 0, 'port=0 时必须回报系统分配的真实端口');
  assert.equal(info.relayName, 'relay.serve.test');

  const health = await httpRequest(`http://127.0.0.1:${info.port}`, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.relayName, 'relay.serve.test');
  assert.match(stderr, /中继已启动/, '人读日志必须在 stderr');

  // stdout 自始至终只有一行 JSON（ops 脚本靠这个解析端口）
  assert.equal(stdout.trim().split('\n').length, 1, `stdout 出现了多余输出：${stdout}`);

  // 配置文件里的 relaySecret 生效：不带口令注册 → 401
  const rejected = await httpRequest(`http://127.0.0.1:${info.port}`, 'POST', '/api/v2/homes', { body: { homeName: 'PC-X' } });
  assert.equal(rejected.status, 401);
  const config = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'));
  const accepted = await httpRequest(`http://127.0.0.1:${info.port}`, 'POST', '/api/v2/homes', { body: { relaySecret: config.relaySecret, homeName: 'PC-X' } });
  assert.equal(accepted.status, 200);

  child.kill();
  await sleep(50);
});

test('serve --port 覆盖配置文件端口（运维临时改端口不用改文件）', async (t) => {
  const home = await tempHome(t);
  await runCli(['init', '--home', home, '--relay-name', 'relay.port.test', '--tls-mode', 'off', '--port', '19999']);
  const child = spawn(process.execPath, [RELAY, 'serve', '--home', home, '--port', '0'], { windowsHide: true });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
  const info = await waitFor(() => parseJson(stdout), { timeoutMs: 15_000, what: 'serve 启动 JSON' });
  assert.notEqual(info.port, 19999);
  assert.ok(info.port > 0);
  child.kill();
  await sleep(50);
});

test('未知子命令：退出码 2 并打印用法（不静默当 help）', async () => {
  const result = await runCli(['definitely-not-a-command']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /未知子命令/);
  assert.match(result.stderr, /用法/);
});

test('help：打印用法且退出码 0', async () => {
  const result = await runCli(['help']);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /serve/);
  assert.match(result.stderr, /home-token/);
});

test('配置文件非法时：退出码 2 且给出可读错误（不会带着半截配置起来）', async (t) => {
  const home = await tempHome(t);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'config.json'), '{ "port": "not-a-number" }', 'utf8');
  const result = await runCli(['serve', '--home', home]);
  assert.equal(result.code, 2, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stderr, /配置错误/);
});
