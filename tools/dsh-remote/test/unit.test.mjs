/**
 * 单元测试：工具函数、事件总线、限速器、进程执行器（argv/输出聚合/错误文案）、HTTP 纯函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  atomicWriteFile,
  atomicWriteJson,
  createLogger,
  dateStamp,
  newTaskId,
  newTokenId,
  randomPairCode,
  readJsonFile,
  redactSecrets,
  sha256,
  truncateUtf8,
  ulid,
} from '../lib/util.mjs';
import { EventBus } from '../lib/events.mjs';
import { RateLimiter, isLoopbackAddress, normalizeIp } from '../lib/ratelimit.mjs';
import { OutputAccumulator, buildChildEnv, buildDshArgv, readableError, sessionDirFor } from '../lib/runner.mjs';
import { formatEvent, normalizePairCode, parseSeq, routeOf } from '../lib/http.mjs';

const tmpRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), 'dshr-unit-'));

test('ulid：26 位 Crockford Base32、时间前缀可排序、随机段不含 undefined', () => {
  const rand = Buffer.from('0123456789', 'binary');
  const a = ulid(1_730_000_000_000, rand);
  const b = ulid(1_730_000_000_001, rand);
  assert.equal(a.length, 26);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.notEqual(a.slice(0, 10), b.slice(0, 10), '毫秒时间戳必须体现在 ULID 前缀');
  assert.ok(a < b, '时间戳更大的 ULID 字典序应更大');
  assert.ok(!a.includes('undefined'), '随机段不能出现 undefined（历史缺陷回归）');

  // 随机性：100 个 id 长度一致且互不相同
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(newTaskId());
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^task_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('newTokenId / randomPairCode 格式符合契约', () => {
  assert.match(newTokenId(), /^tok_[0-9a-f]{16}$/);
  for (let i = 0; i < 50; i++) {
    const code = randomPairCode();
    assert.match(code, /^\d{6}$/, `配对码必须是 6 位数字：${code}`);
  }
});

test('truncateUtf8 不会切断代理对（emoji）', () => {
  const text = '中文😀abc';
  const cut = truncateUtf8(text, 7); // "中文" 6 字节 + emoji 4 字节放不下
  assert.equal(cut, '中文');
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 7);
  assert.equal(truncateUtf8(text, 1000), text);
  assert.equal(truncateUtf8(text, 0), '');
});

test('redactSecrets 屏蔽 API Key / 设备令牌 / Bearer 头', () => {
  const token = 'dshr_ELf5rmQ-Lx6QS7_KdqRUaPMwhCacbHIf0hw3xdKwDDg';
  const line = `Authorization: Bearer ${token} key=sk-abcdef1234567890`;
  const masked = redactSecrets(line);
  assert.ok(!masked.includes(token), '令牌明文必须被屏蔽');
  assert.ok(!masked.includes('sk-abcdef1234567890'), 'API Key 明文必须被屏蔽');
  assert.ok(masked.includes('REDACTED'));
});

test('sha256 稳定且与 node crypto 一致', () => {
  assert.equal(sha256('abc').toString('hex'), crypto.createHash('sha256').update('abc').digest('hex'));
});

test('atomicWriteFile：可覆盖、无残留临时文件、自动建目录', async () => {
  const dir = await tmpRoot();
  const file = path.join(dir, 'nested', 'state.json');
  await atomicWriteJson(file, { n: 1 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { n: 1 });
  await atomicWriteJson(file, { n: 2, 中文: '✓' });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { n: 2, 中文: '✓' });

  const entries = await fs.readdir(path.dirname(file));
  assert.deepEqual(entries, ['state.json'], `不得残留 .tmp 文件：${entries.join(',')}`);

  await atomicWriteFile(path.join(dir, 'plain.txt'), 'hello');
  assert.equal(await fs.readFile(path.join(dir, 'plain.txt'), 'utf8'), 'hello');
  await fs.rm(dir, { recursive: true, force: true });
});

test('readJsonFile：缺失返回 fallback、损坏则隔离并返回 fallback', async () => {
  const dir = await tmpRoot();
  const missing = await readJsonFile(path.join(dir, 'nope.json'), { ok: true });
  assert.equal(missing.error, null);
  assert.deepEqual(missing.value, { ok: true });

  const broken = path.join(dir, 'broken.json');
  await fs.writeFile(broken, '{ this is not json', 'utf8');
  const result = await readJsonFile(broken, null);
  assert.equal(result.corrupt, true);
  assert.equal(result.value, null);
  const entries = await fs.readdir(dir);
  assert.ok(
    entries.some((f) => f.startsWith('broken.json.corrupt-')),
    '损坏文件应被隔离重命名',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('日志：按天滚动、UTF-8 落盘、写盘前强制脱敏', async () => {
  const dir = await tmpRoot();
  const logger = createLogger({ dir, toConsole: false, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });
  logger.info('中文日志 ✓ 配对成功 tokenId=tok_abc');
  logger.error('Authorization: Bearer dshr_SECRETSECRETSECRETSECRET key=sk-abcdef1234567890');

  const file = path.join(dir, `gateway-${dateStamp(new Date(Date.UTC(2026, 0, 2)))}.log`);
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.includes('中文日志 ✓'), '日志必须是可读的 UTF-8');
  assert.ok(!text.includes('dshr_SECRETSECRETSECRETSECRET'), '禁止写入令牌明文');
  assert.ok(!text.includes('sk-abcdef1234567890'), '禁止写入 API Key 明文');
  assert.equal(logger.currentFile(), file);
  await fs.rm(dir, { recursive: true, force: true });
});

test('EventBus：seq 单调、缓冲上限、fromSeq 回放、taskId 过滤、无重复投递', () => {
  const bus = new EventBus({ bufferSize: 3, now: () => 1000 });
  for (let i = 1; i <= 5; i++) bus.publish('task.output', { delta: String(i) }, 'task_a');
  bus.publish('task.output', { delta: 'x' }, 'task_b');

  assert.equal(bus.seq, 6);
  assert.equal(bus.buffer.length, 3, '缓冲只保留最近 3 条');
  assert.equal(bus.firstSeq, 4);

  const seen = [];
  const sub = bus.subscribe({ fromSeq: 0, onEvent: (ev) => seen.push(ev) });
  assert.deepEqual(
    seen.map((e) => e.seq),
    [4, 5, 6],
  );
  assert.equal(sub.replayed, 3);

  // 实时投递：新事件立刻到达，且 seq <= afterSeq 的不会重复
  bus.publish('task.output', { delta: 'live' }, 'task_a');
  assert.equal(seen.at(-1).seq, 7);
  assert.equal(seen.at(-1).delta, 'live');

  // taskId 过滤
  const filtered = [];
  const sub2 = bus.subscribe({ taskId: 'task_b', fromSeq: 0, onEvent: (ev) => filtered.push(ev) });
  assert.deepEqual(
    filtered.map((e) => e.seq),
    [6],
  );
  bus.publish('task.output', { delta: 'zzz' }, 'task_b');
  assert.equal(filtered.length, 2);
  sub2.unsubscribe();
  sub.unsubscribe();
  assert.equal(bus.subscriberCount, 0, '退订后不得残留订阅者');
});

test('EventBus：fromSeq 早于缓冲起点时给出 gap 标记（调用方需回源兜底）', () => {
  const bus = new EventBus({ bufferSize: 2 });
  for (let i = 1; i <= 5; i++) bus.publish('task.output', { delta: String(i) }, 'task_a');
  const sub = bus.subscribe({ fromSeq: 1, onEvent: () => {} });
  assert.equal(sub.gap, true);
  assert.equal(sub.oldestSeq, 4);
  sub.unsubscribe();

  const fresh = new EventBus({ bufferSize: 10 });
  fresh.publish('task.output', { delta: 'a' }, 'task_a');
  const ok = fresh.subscribe({ fromSeq: 1, onEvent: () => {} });
  assert.equal(ok.gap, false, '缓冲起点为 1、客户端已收到 1 → 无缺失，不应误报 gap');
  ok.unsubscribe();
});

test('RateLimiter：窗口内计数、超限拒绝、窗口滚动后恢复、reset', () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 3, windowMs: 1000, now: () => now });
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit('ip1').allowed, true);
  const blocked = limiter.hit('ip1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.equal(limiter.hit('ip2').allowed, true, '不同 IP 互不影响');

  now = 1001; // 窗口滑动
  assert.equal(limiter.hit('ip1').allowed, true);
  limiter.reset('ip1');
  assert.equal(limiter.peek('ip1').used, 0);
});

test('normalizeIp / isLoopbackAddress', () => {
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('::1'), '::1');
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('192.168.1.10'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('OutputAccumulator：delta 拼接 === output，尾部空白被扣留', () => {
  const acc = new OutputAccumulator({ maxBytes: 1024 });
  const parts = [];
  parts.push(acc.push('hello\n\n'));
  assert.equal(acc.output, 'hello', '尾部空行被扣留，不进入 output');
  parts.push(acc.push('world'));
  assert.equal(acc.output, 'hello\n\nworld', '后续非空白内容会把扣留的空白"救回"并保持顺序');
  parts.push(acc.push('\n\n\n'));
  acc.finish();
  assert.equal(acc.output, 'hello\n\nworld');
  assert.equal(
    parts.join(''),
    acc.output,
    '契约不变式：客户端按 seq 拼接的 delta 必须等于 output',
  );
  assert.equal(acc.truncated, false);
});

test('OutputAccumulator：超限截断并标记 truncated', () => {
  const acc = new OutputAccumulator({ maxBytes: 10 });
  const first = acc.push('一二三四五六七八九十'); // 30 字节
  const second = acc.push('后续内容继续写入');
  assert.equal(acc.truncated, true);
  assert.ok(first.includes('[输出超过网关上限，已截断]'));
  assert.equal(second, '');
  assert.equal(first + second, acc.output);
  assert.equal(acc.output, '一二三' + '\n[输出超过网关上限，已截断]\n');
});

test('buildDshArgv：prompt 作为单个 argv 元素零改写传递', () => {
  const dsh = { binPath: 'C:\\x\\bin.js', profile: 'headless' };
  const prompt = '运行 "dir" 并报告\n路径 D:\\proj\\a 与 中文\t和 \'单引号\' & ^ %PATH% `反引号`';
  const argv = buildDshArgv(dsh, prompt);
  assert.deepEqual(argv, ['C:\\x\\bin.js', '--profile', 'headless', prompt]);
  assert.equal(argv.length, 4, 'argv 数组长度固定，prompt 不被拆词');
  assert.equal(argv[3], prompt, 'prompt 必须逐字节一致（不经 shell 解析）');
});

test('buildDshArgv：launcherArgs 插在 profile 之后、prompt 之前', () => {
  const argv = buildDshArgv({ binPath: 'b.js', profile: 'headless', launcherArgs: ['--patch', 'p.yml'] }, '任务');
  assert.deepEqual(argv, ['b.js', '--profile', 'headless', '--patch', 'p.yml', '任务']);
});

test('buildChildEnv：DSH_HOME 指向网关 home，且关闭 ANSI 颜色', () => {
  const env = buildChildEnv({ baseEnv: { PATH: 'x', DSH_HOME: 'C:\\Users\\x\\.dsh' }, home: 'D:\\home', extraEnv: { FOO: '1' } });
  assert.equal(env.DSH_HOME, 'D:\\home');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.FORCE_COLOR, '0');
  assert.equal(env.FOO, '1');
  assert.equal(env.PATH, 'x');
});

test('readableError：失败/超时/取消/无法启动 文案可读', () => {
  const stderr = [
    'node.exe : 出错了',
    '所在位置 行:1 字符: 1',
    '+ & $node $dsh --profile headless "x"',
    'CategoryInfo : NotSpecified: (:) [], RemoteException',
    'Error: dsh: plugin tree failed to load: credentials-local 缺少 DEEPSEEK_API_KEY',
  ].join('\n');
  const failed = readableError({ code: 1, signal: null, stderr });
  assert.match(failed, /退出码 1/);
  assert.ok(failed.includes('plugin tree failed to load'), '应保留真正的错误信息');
  assert.ok(!failed.includes('CategoryInfo'), '应过滤 PowerShell 包装噪声');
  assert.ok(failed.length < 500, '错误文案必须截断到可读长度');

  assert.match(readableError({ code: null, signal: 'SIGKILL', timedOut: true, timeoutSec: 5 }), /任务超时：超过 5 秒/);
  assert.match(readableError({ code: null, signal: null, canceled: true }), /已取消/);
  assert.match(readableError({ code: null, signal: null, spawnError: new Error('ENOENT') }), /无法启动 dsh 进程/);
  assert.equal(readableError({ code: 0 }), null);
  assert.match(readableError({ code: 3, signal: null, stderr: '' }), /dsh 进程异常结束（退出码 3）/);
});

test('sessionDirFor：与 DSH 实际目录编码一致（实测样例）', () => {
  const dir = sessionDirFor('C:\\home\\.dsh', 'D:\\Workspace\\dsh_android\\.probe\\home\\ws');
  assert.equal(path.basename(dir), '--D-Workspace-dsh_android-.probe-home-ws--');
});

test('routeOf：契约全部路径可识别，非法路径归入 unknown', () => {
  assert.deepEqual(routeOf('/api/v1/health'), { name: 'health' });
  assert.deepEqual(routeOf('/api/v1/pair/open'), { name: 'pairOpen' });
  assert.deepEqual(routeOf('/api/v1/pair/claim'), { name: 'pairClaim' });
  assert.deepEqual(routeOf('/api/v1/events'), { name: 'events' });
  assert.deepEqual(routeOf('/api/v1/workspaces'), { name: 'workspaces' });
  assert.deepEqual(routeOf('/api/v1/devices'), { name: 'devices' });
  assert.deepEqual(routeOf('/api/v1/devices/tok_1'), { name: 'deviceRevoke', tokenId: 'tok_1' });
  assert.deepEqual(routeOf('/api/v1/tasks'), { name: 'tasks' });
  assert.deepEqual(routeOf('/api/v1/tasks/task_1'), { name: 'taskDetail', id: 'task_1' });
  assert.deepEqual(routeOf('/api/v1/tasks/task_1/cancel'), { name: 'taskCancel', id: 'task_1' });
  assert.equal(routeOf('/api/v1/nope').name, 'unknown');
  assert.equal(routeOf('/').name, 'unknown');
  assert.equal(routeOf('/api/v1/tasks/a/b/c').name, 'unknown');
  // 非法百分号编码不得抛异常
  assert.deepEqual(routeOf('/api/v1/tasks/%E0%A4%A'), { name: 'taskDetail', id: '%E0%A4%A' });
});

test('parseSeq / normalizePairCode / formatEvent', () => {
  assert.equal(parseSeq(null), 0);
  assert.equal(parseSeq('42'), 42);
  assert.equal(parseSeq('-1'), 0);
  assert.equal(parseSeq('abc'), 0);

  assert.equal(normalizePairCode('482913'), '482913');
  assert.equal(normalizePairCode(482913), '482913');
  assert.equal(normalizePairCode('048291'), '048291');
  assert.equal(normalizePairCode('12345'), null);
  assert.equal(normalizePairCode('1234567'), null);
  assert.equal(normalizePairCode(undefined), null);

  const frame = formatEvent({ seq: 42, taskId: 'task_1', at: 1, type: 'task.output', delta: '第一行\n第二行' });
  const lines = frame.split('\n');
  assert.equal(lines[0], 'id: 42');
  assert.equal(lines[1], 'event: task.output');
  assert.ok(lines[2].startsWith('data: {'));
  assert.equal(lines[3], '');
  assert.equal(lines[4], '');
  // data 必须单行（内部换行以 \n 转义）
  const data = JSON.parse(lines[2].slice('data: '.length));
  assert.equal(data.delta, '第一行\n第二行');
  assert.equal(data.seq, 42);
});
