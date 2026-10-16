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
  ULID_ALPHABET,
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
  truncateUtf8Tail,
  ulid,
} from '../lib/util.mjs';
import { EventBus } from '../lib/events.mjs';
import { RateLimiter, isLoopbackAddress, normalizeIp } from '../lib/ratelimit.mjs';
import { OutputAccumulator, buildChildEnv, buildDshArgv, readableError, sessionDirFor } from '../lib/runner.mjs';
import { ACCESS_FULL, ACCESS_WORKSPACE, describeAccess, permissionModeFor, resolveAccess } from '../lib/permission.mjs';
import {
  TURN_IMAGE_MEDIA_TYPES,
  TURN_IMAGE_ONLY_TEXT,
  TURN_MAX_IMAGES,
  TURN_MAX_IMAGE_BYTES,
  TURN_MAX_IMAGE_TOTAL_BASE64,
  formatEvent,
  normalizePairCode,
  parseSeq,
  routeOf,
  validateTurnContent,
} from '../lib/http.mjs';
import { SessionRunner, turnImageStats } from '../lib/session-runner.mjs';
import { desktopEvent, makeDesktopStub } from './helpers.mjs';
import { SEEDED_SESSION_ID, startV2 } from './v2-harness.mjs';

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

test('ulid/newTaskId：非法时间戳输入绝不产出畸形 id（回归：undefined 混入主键）', () => {
  const badInputs = [Number.NaN, 'abc', undefined, null, -1, 0, Number.POSITIVE_INFINITY, {}, [], 1e30, true];
  for (const bad of badInputs) {
    const id = newTaskId(bad);
    assert.match(id, /^task_[0-9A-HJKMNP-TV-Z]{26}$/, `输入 ${JSON.stringify(bad)} 产出了非法 id：${id}`);
    assert.ok(!id.includes('undefined'), `id 不得包含 undefined：${id}`);
    assert.ok(!id.includes('NaN'), `id 不得包含 NaN：${id}`);
  }

  // 合法时间戳必须被精确编码进前 10 位（可反解回原值）
  const decodeTime = (id) => {
    let value = 0;
    for (const ch of id.slice('task_'.length, 'task_'.length + 10)) value = value * 32 + ULID_ALPHABET.indexOf(ch);
    return value;
  };
  const ms = 1_730_000_000_000;
  assert.equal(decodeTime(newTaskId(ms)), ms, '时间前缀必须可无损反解');
  assert.equal(ulid(ms, Buffer.alloc(10)).length, 26);
  // 超出 48 位的时间戳被夹紧，但仍然只能是合法字符
  assert.match(ulid(2 ** 60, Buffer.alloc(10)), /^[0-9A-HJKMNP-TV-Z]{26}$/);
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

test('EventBus：来自未来的游标（网关重启后客户端带旧游标重连）不静默饿死，改为只接续实时事件', () => {
  // 场景：进程 A 把总线 seq 推到 900，手机端把游标 900 持久化；进程 B 重启后 seq 从 1 重开，
  // 手机端带 fromSeq=900 重连。旧实现把 afterSeq 设成 900，`publish()` 的 `ev.seq <= afterSeq`
  // 会永久吞掉所有事件 —— 连接在线、心跳正常、内容全无（2026-10-15 生产网关实测踩到）。
  const bus = new EventBus({ bufferSize: 10 });
  bus.publish('task.output', { delta: 'old-1' }, 'task_a');
  bus.publish('task.output', { delta: 'old-2' }, 'task_a');

  const seen = [];
  const sub = bus.subscribe({ fromSeq: 900, onEvent: (ev) => seen.push(ev.delta) });
  assert.equal(sub.epochReset, true, '游标超出本进程最大 seq 必须被识别为「上个进程的游标」');
  assert.equal(sub.replayed, 0, '别的进程里的事件本进程无从回放，不能假装补齐');
  bus.publish('task.output', { delta: 'new-1' }, 'task_a');
  assert.deepEqual(seen, ['new-1'], '收敛到当前 seq 后，实时事件必须照常投递');
  sub.unsubscribe();

  // 正常游标（等于当前 seq）不应被误判成 epochReset
  const normal = bus.subscribe({ fromSeq: bus.seq, onEvent: () => {} });
  assert.equal(normal.epochReset, false);
  normal.unsubscribe();
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
    '未截断时的不变式：客户端按 seq 拼接的 delta 必须等于 output',
  );
  assert.equal(acc.truncated, false);
});

test('OutputAccumulator：超限只保留尾部（A2-5），已推送的 delta 不回滚', () => {
  const acc = new OutputAccumulator({ maxBytes: 10 });
  const parts = [];
  parts.push(acc.push('头部内容会被丢弃'));
  parts.push(acc.push('尾部保留XYZ'));
  assert.equal(acc.truncated, true);
  assert.ok(Buffer.byteLength(acc.output, 'utf8') <= 10, 'output 必须被限制在 maxBytes 内');
  assert.equal(acc.output, '保留XYZ', '应精确保留末 10 字节且从字符边界开始');
  assert.ok(acc.output.endsWith('XYZ'), '必须保留的是尾部而不是头部');
  assert.ok(!acc.output.includes('头部'), '超限部分应从头部丢弃');
  // 已推送的 delta 不回滚：拼接结果比 output 更长，客户端以详情接口为准
  assert.ok(parts.join('').length > acc.output.length);
  assert.equal(parts[0], '头部内容会被丢弃', '已经下发的增量不改写');
  assert.ok(parts.join('').endsWith(acc.output), 'output 必须是已推送文本的后缀');
  assert.equal(acc.totalBytes, Buffer.byteLength(parts.join(''), 'utf8'));
  acc.finish();
});

test('OutputAccumulator：截断不切断多字节字符', () => {
  const acc = new OutputAccumulator({ maxBytes: 7 });
  const parts = [];
  parts.push(acc.push('😀😀😀😀'));
  assert.equal(acc.truncated, true);
  assert.ok(Buffer.byteLength(acc.output, 'utf8') <= 7);
  assert.ok(!acc.output.includes('\uFFFD'), '不得产生替换字符（说明切断了多字节序列）');
  assert.equal(acc.output, '😀');
});

test('truncateUtf8Tail：按字节保留尾部且不产生非法字符', () => {
  assert.equal(truncateUtf8Tail('abcdef', 3), 'def');
  assert.equal(truncateUtf8Tail('abc', 100), 'abc');
  assert.equal(truncateUtf8Tail('中文中文', 6), '中文');
  assert.ok(!truncateUtf8Tail('中文中文', 7).includes('\uFFFD'));
  assert.equal(Buffer.byteLength(truncateUtf8Tail('😀😀', 5), 'utf8'), 4);
  assert.equal(truncateUtf8Tail('abc', 0), '');
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

test('权限档纯函数：resolveAccess 只认两个契约值，未知取值一律收紧', () => {
  // 缺省 / 空值 → 仅当前工作区
  assert.deepEqual(resolveAccess(undefined), { ok: true, access: ACCESS_WORKSPACE });
  assert.deepEqual(resolveAccess(null), { ok: true, access: ACCESS_WORKSPACE });
  assert.deepEqual(resolveAccess(''), { ok: true, access: ACCESS_WORKSPACE });
  assert.deepEqual(resolveAccess('  '), { ok: true, access: ACCESS_WORKSPACE });
  // 两个契约取值
  assert.deepEqual(resolveAccess('workspace'), { ok: true, access: ACCESS_WORKSPACE });
  assert.deepEqual(resolveAccess('full'), { ok: true, access: ACCESS_FULL });
  // DSH 原生取值别名（脚本可能直接写它们）
  assert.deepEqual(resolveAccess('workspace-write'), { ok: true, access: ACCESS_WORKSPACE });
  assert.deepEqual(resolveAccess('danger-full-access'), { ok: true, access: ACCESS_FULL });
  assert.deepEqual(resolveAccess('danger_full_access'), { ok: true, access: ACCESS_FULL });
  // 前后空白只做 trim（不改变语义，因此不算"猜测"）
  assert.deepEqual(resolveAccess(' full '), { ok: true, access: ACCESS_FULL });
  assert.deepEqual(resolveAccess('workspace\n'), { ok: true, access: ACCESS_WORKSPACE });
  // 未知/危险取值：必须报错，绝不"猜测"（猜错就等于偷偷提权）
  for (const bad of ['yolo', 'danger', 'WORKSPACE', 'Full', 'full-access', 1, true, {}, []]) {
    const out = resolveAccess(bad);
    assert.equal(out.ok, false, `${JSON.stringify(bad)} 必须被拒绝`);
    assert.equal(out.code, 'bad_request');
  }
  assert.match(resolveAccess(1).message, /access 必须是字符串/);
  assert.match(resolveAccess('yolo').message, /access 只能是 workspace（仅当前工作区）或 full（全部权限）：yolo/);

  // 环境变量映射：未知值收紧为 workspace-write
  assert.equal(permissionModeFor(ACCESS_WORKSPACE), 'workspace-write');
  assert.equal(permissionModeFor(ACCESS_FULL), 'danger-full-access');
  assert.equal(permissionModeFor(undefined), 'workspace-write');
  assert.equal(permissionModeFor('full-speed'), 'workspace-write', '未知取值必须收紧而不是放开');

  assert.equal(describeAccess(ACCESS_FULL), '全部权限');
  assert.equal(describeAccess(ACCESS_WORKSPACE), '仅当前工作区');
  assert.equal(describeAccess(undefined), '仅当前工作区');
});

// ---------------------------------------------------------------------------
// `POST /sessions/{id}/turns` 的 content 块（图片透传，冻结线协议）
//
// 协议要点：`content` 缺省/空 → 与不带它逐字等价；有 content 时正文 = 所有 text 块按序
// `\n` 拼接（一个都没有就用占位正文）；图片只走桌面端通道，网关自持运行时一律 400。
// ---------------------------------------------------------------------------

test('content 块：缺省 / null / 空数组 → 与不带 content 完全等价（prompt 仍取自请求体）', () => {
  for (const empty of [undefined, null, []]) {
    const out = validateTurnContent(empty);
    assert.equal(out.ok, true);
    assert.equal(out.content, null, '必须归一化成 null，调用方据此走旧路径');
    assert.equal(out.prompt, null, 'prompt 保持 null → 用请求体的 prompt 字段');
    assert.deepEqual(out.images, { count: 0, bytes: 0 });
  }
  // 常量本身也是协议的一部分：写死在这里，改动必须是有意的
  assert.equal(TURN_MAX_IMAGES, 4);
  assert.equal(TURN_MAX_IMAGE_BYTES, 716_800);
  assert.deepEqual([...TURN_IMAGE_MEDIA_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  assert.equal(TURN_IMAGE_ONLY_TEXT, '（查看这张图片）');
});

test('content 块：text 块按顺序以 \\n 拼接；一个 text 块都没有 → 占位正文「（查看这张图片）」', () => {
  const image = { type: 'image', mediaType: 'image/png', data: Buffer.from('hi').toString('base64') };

  const mixed = validateTurnContent([{ type: 'text', text: '看这张' }, image, { type: 'text', text: '和这张' }]);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.prompt, '看这张\n和这张');
  assert.deepEqual(mixed.content, [{ type: 'text', text: '看这张' }, image, { type: 'text', text: '和这张' }], '归一化后逐字透传');
  assert.deepEqual(mixed.images, { count: 1, bytes: 2 });

  // 只拍一张发过来（手机端最常见的用法）
  assert.equal(validateTurnContent([image]).prompt, '（查看这张图片）');
  // 纯图轮次：占位正文必须**自己作为第一个 text 块**进 content。桌面端在 content 非空时会忽略
  // `text` 参数（`desktop-api.mjs:447`），只把占位放在参数里 = 它永远进不了用户消息，而纯图轮次
  // 会长期留在会话历史里，agent 与后来者需要一句可检索的正文。
  const onlyImage = validateTurnContent([image]);
  assert.equal(onlyImage.ok, true);
  assert.deepEqual(onlyImage.content, [{ type: 'text', text: '（查看这张图片）' }, image], '占位 text 块头插在图片之前');
  assert.equal(onlyImage.prompt, '（查看这张图片）', 'prompt 与 content 首块是同一条正文');
  assert.deepEqual(onlyImage.images, { count: 1, bytes: 2 }, '头插不影响张数/字节统计');
  // 空/纯空白 text 块按"没有文本"处理：不能把空正文丢给桌面端
  assert.equal(validateTurnContent([{ type: 'text', text: '' }, image]).prompt, '（查看这张图片）');
  assert.equal(validateTurnContent([{ type: 'text', text: '   ' }, image]).prompt, '（查看这张图片）');
  assert.deepEqual(
    validateTurnContent([{ type: 'text', text: '   ' }, image]).content,
    [{ type: 'text', text: '（查看这张图片）' }, { type: 'text', text: '   ' }, image],
    '空文本块保留原位，占位只插在头部',
  );
  // 只有空 text 块（无图）也走同一条头插，保证发出的 content 永远至少有一个非空 text 块
  assert.deepEqual(validateTurnContent([{ type: 'text', text: '' }]).content, [
    { type: 'text', text: '（查看这张图片）' },
    { type: 'text', text: '' },
  ]);
  // 纯文本 content：正文以拼接结果为准（图片不计入 -> 长度校验只作用于这些字符）
  assert.equal(validateTurnContent([{ type: 'text', text: '只有字' }]).prompt, '只有字');
});

test('content 块：一轮 ≤4 张图、单图**解码后** ≤716800 字节（700 KiB），按元素下标报错', () => {
  const img = (bytes) => ({ type: 'image', mediaType: 'image/jpeg', data: Buffer.alloc(bytes, 7).toString('base64') });

  const four = validateTurnContent([img(3), img(3), img(3), img(3)]);
  assert.equal(four.ok, true);
  assert.equal(four.images.count, 4);

  const five = validateTurnContent([img(3), img(3), img(3), img(3), img(3)]);
  assert.equal(five.ok, false);
  assert.match(five.message, /图片数量超过上限：一轮最多 4 张（收到 5 张）/);

  const max = validateTurnContent([img(716_800)]);
  assert.equal(max.ok, true, '正好 700 KiB 必须放行');
  assert.deepEqual(max.images, { count: 1, bytes: 716_800 });

  const over = validateTurnContent([{ type: 'text', text: 'x' }, img(716_801)]);
  assert.equal(over.ok, false, '多 1 字节必须拒绝');
  assert.match(over.message, /^content\[1\]/, '消息要指到具体哪一张');
  assert.match(over.message, /解码后 716801 字节，超过单图上限 716800 字节（700 KiB）/);

  // 字节数按填充位换算（不真解码），三种填充都要对
  assert.equal(validateTurnContent([{ type: 'image', mediaType: 'image/png', data: 'AA==' }]).images.bytes, 1);
  assert.equal(validateTurnContent([{ type: 'image', mediaType: 'image/png', data: 'aGk=' }]).images.bytes, 2);
  assert.equal(validateTurnContent([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]).images.bytes, 3);
});

test('content 块：非法输入一律拒绝，且消息能指认具体哪一条不合格', () => {
  const cases = [
    ['content 不是数组', 'nope', /content 必须是数组/],
    ['元素不是对象', [42], /content\[0\] 必须是对象/],
    ['未知 type', [{ type: 'video', data: 'AAAA' }], /content\[0\]\.type 未知："video"（只支持 text \/ image）/],
    ['text 不是字符串', [{ type: 'text', text: 7 }], /content\[0\]\.text 必须是字符串/],
    ['缺 mediaType', [{ type: 'image', data: 'AAAA' }], /content\[0\]\.mediaType 不在白名单内/],
    ['mediaType 不在白名单', [{ type: 'image', mediaType: 'image/bmp', data: 'AAAA' }], /"image\/bmp"/],
    ['缺 data', [{ type: 'image', mediaType: 'image/png' }], /content\[0\]\.data 必须是图片的 base64 字符串/],
    ['带 data: 前缀', [{ type: 'image', mediaType: 'image/png', data: 'data:image/png;base64,AAAA' }], /不是严格 base64/],
    ['长度不是 4 的倍数', [{ type: 'image', mediaType: 'image/png', data: 'AAA' }], /不是严格 base64/],
    ['含换行', [{ type: 'image', mediaType: 'image/png', data: 'AA\nAA' }], /不是严格 base64/],
    ['填充位非零', [{ type: 'image', mediaType: 'image/png', data: 'AB==' }], /填充位非法/],
    ['name 不是字符串', [{ type: 'image', mediaType: 'image/png', data: 'AAAA', name: 1 }], /content\[0\]\.name 必须是字符串/],
  ];
  for (const [label, content, pattern] of cases) {
    const out = validateTurnContent(content);
    assert.equal(out.ok, false, `${label} 必须被拒绝`);
    assert.match(out.message, pattern, `${label} 的消息指认不到问题（实际：${out.message}）`);
  }
});

test('turnImageStats：只数张数与解码后字节数，绝不触碰图片内容', () => {
  assert.deepEqual(turnImageStats(null), { count: 0, bytes: 0 });
  assert.deepEqual(turnImageStats(undefined), { count: 0, bytes: 0 });
  assert.deepEqual(turnImageStats([]), { count: 0, bytes: 0 });
  assert.deepEqual(turnImageStats([{ type: 'text', text: '你好' }]), { count: 0, bytes: 0 });

  const blocks = [
    { type: 'image', mediaType: 'image/png', data: Buffer.alloc(1, 1).toString('base64') },
    { type: 'text', text: 'x' },
    { type: 'image', mediaType: 'image/png', data: Buffer.alloc(716_800, 3).toString('base64') },
  ];
  assert.deepEqual(turnImageStats(blocks), { count: 2, bytes: 716_801 });
  // 与真解码一致：换算公式的钉子
  const decoded = blocks.reduce((n, b) => (b.type === 'image' ? n + Buffer.from(b.data, 'base64').byteLength : n), 0);
  assert.equal(turnImageStats(blocks).bytes, decoded);
});

/** 「桌面端索引里有这个会话」用的 id（形状必须是 `session-<uuid>`）。 */
const TURN_SESSION_ID = 'session-9f1c7a3e-5b2d-4c8f-a1e6-7d0b3c5a9e21';

/**
 * 造一个纯内存 SessionRunner：不 spawn、不联网、不碰 ~/.dsh
 * （与 `v2-desktop.test.mjs` 同一条隔离红线；`desktopWatch` 必须显式关掉，否则会起 2s 轮询）。
 */
function makeRunner({ locate, desktop }) {
  const events = [];
  const logs = [];
  const record = (m) => logs.push(String(m));
  const runner = new SessionRunner({
    config: { dsh: {}, desktopWatch: { enabled: false }, desktop: {} },
    mirror: { locate },
    live: { isTaken: () => false, isBusy: () => false, acquire: () => ({ ok: true }), release: () => {}, clear: () => {} },
    stream: { emit: (type, data, meta) => events.push({ type, data, meta }) },
    desktop,
    logger: { info: record, warn: record, error: record, debug: record },
    now: () => 1_700_000_000_000,
    existsSync: () => false,
    readFileSync: () => '',
  });
  return { runner, events, logs };
}

/** 桌面端替身 + 记录 `prompt()` 的**完整**入参（官方桩只记 sessionId/text/mode，看不到 content）。 */
function desktopStubRecordingPrompt(opts) {
  const stub = makeDesktopStub(opts);
  const prompted = [];
  const inner = stub.prompt.bind(stub);
  stub.prompt = async (args) => {
    prompted.push(args);
    return inner(args);
  };
  return { stub, prompted };
}

test('SessionRunner.submit：电脑端会话带图片 → content 透传到 desktop.prompt，回执/事件帧形状不变', async () => {
  const { stub, prompted } = desktopStubRecordingPrompt({
    entries: [{ sessionId: TURN_SESSION_ID, running: false, agentAvailable: true, turns: 2 }],
    autoFrames: [desktopEvent('turn/start', { turn: 3 }, { seq: 8 })],
  });
  const { runner, events, logs } = makeRunner({
    locate: async () => ({ root: { source: 'computer' }, lastSeq: 5, mtimeMs: 0, projcache: null, summary: { turns: 2 } }),
    desktop: stub,
  });

  const image = { type: 'image', mediaType: 'image/png', data: Buffer.alloc(300, 0x41).toString('base64'), name: 'shot.png' };
  const content = [{ type: 'text', text: '看这张图' }, image];

  const result = await runner.submit({ sessionId: TURN_SESSION_ID, prompt: '看这张图', clientTurnId: 'ct-1', content });

  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.match(result.body.turnId, /^turn_/);
  assert.deepEqual(result.body, {
    accepted: true,
    sessionId: TURN_SESSION_ID,
    turnId: result.body.turnId,
    fromSeq: 6,
    driver: 'desktop',
    source: 'computer',
    messageId: 'msg-stub-1',
    clientTurnId: 'ct-1',
  });
  // content 逐字透传（mediaType/data/name 一个不少，顺序不变）
  assert.deepEqual(prompted, [{ sessionId: TURN_SESSION_ID, text: '看这张图', mode: 'queue', content }]);
  // 事件帧形状就是契约面，不能因为带图而多/少字段。
  // 桩的首帧 `turn/start` 会被桌面端订阅那条链路翻译成**另一条不带 turnId 的** turn.started
  // （见 `v2-desktop.test.mjs` 的同类说明），所以这里只挑 `#submitDesktop` 自己发的那条权威事件。
  const authoritative = events.filter((e) => e.type === 'turn.started' && e.data.turnId === result.body.turnId);
  assert.deepEqual(authoritative, [{
    type: 'turn.started',
    data: { sessionId: TURN_SESSION_ID, source: 'computer', turn: 3, fromSeq: 6, turnId: result.body.turnId, messageId: 'msg-stub-1' },
    meta: { sessionId: TURN_SESSION_ID },
  }]);
  // 日志只记张数/字节：图片字节一个都不能出现（工单要求）
  assert.ok(logs.some((line) => line.includes('图片 1 张/300 字节')), `日志必须记张数与字节（实际：${logs.join(' | ')}）`);
  assert.ok(!logs.some((line) => line.includes(image.data)), '日志里绝不能出现图片 base64');
  await runner.shutdown?.();
});

test('SessionRunner.submit：content 为 null 时 desktop.prompt 的调用形状与加该参数之前逐字一致', async () => {
  const { stub, prompted } = desktopStubRecordingPrompt({
    entries: [{ sessionId: TURN_SESSION_ID, running: false, agentAvailable: true, turns: 1 }],
    autoFrames: [desktopEvent('turn/start', { turn: 2 }, { seq: 6 })],
  });
  const { runner } = makeRunner({
    locate: async () => ({ root: { source: 'computer' }, lastSeq: 5, mtimeMs: 0, projcache: null, summary: { turns: 1 } }),
    desktop: stub,
  });

  const result = await runner.submit({ sessionId: TURN_SESSION_ID, prompt: '只有文字' });
  assert.equal(result.status, 202);
  assert.equal(result.body.fromSeq, 6);
  // 严格相等：连 `content: undefined` 这个键都不许有
  assert.deepEqual(prompted, [{ sessionId: TURN_SESSION_ID, text: '只有文字', mode: 'queue' }]);
  await runner.shutdown?.();
});

test('SessionRunner.submit：网关自持会话（source=phone）带图片 → 400 逐字文案，绝不投到桌面端', async () => {
  const { stub, prompted } = desktopStubRecordingPrompt({ entries: [] });
  const { runner, events } = makeRunner({
    locate: async () => ({ root: { source: 'phone' }, lastSeq: 3, mtimeMs: 0, projcache: null, summary: { turns: 1 } }),
    desktop: stub,
  });

  const image = { type: 'image', mediaType: 'image/jpeg', data: Buffer.from('hi').toString('base64') };
  const result = await runner.submit({ sessionId: TURN_SESSION_ID, prompt: '看这张图', content: [image] });

  assert.deepEqual(result, {
    ok: false,
    code: 'bad_request',
    status: 400,
    message: '该会话由网关自带运行时执行，暂不支持发送图片（请在电脑端会话里使用）',
  });
  assert.deepEqual(prompted, [], '手机通道的会话绝不能把轮次投到桌面端');
  assert.deepEqual(events, [], '被拒绝的轮次不该发任何事件帧');
  assert.equal(stub.calls.follows.length, 0, '连订阅都不该开');
  assert.equal(stub.calls.listSessions, 0, '连桌面端索引都不该查');
  await runner.shutdown?.();
});

test('v2：POST /turns 带满额图片（716800 字节）→ 202，桌面端 session/prompt 收到图片块', async (t) => {
  const { stub, prompted } = desktopStubRecordingPrompt({
    entries: [{ sessionId: SEEDED_SESSION_ID, running: false, agentAvailable: true, turns: 1 }],
    autoFrames: [desktopEvent('turn/start', { turn: 2 }, { seq: 7 })],
  });
  const h = await startV2(t, { desktop: stub });

  // 单张图顶到 700 KiB：base64 后 955736 字符，仍在 `limits.maxBodyBytes`（1MB）之内
  const image = { type: 'image', mediaType: 'image/png', data: Buffer.alloc(716_800, 0x41).toString('base64'), name: 'shot.png' };
  const content = [{ type: 'text', text: '看这张图' }, image];
  const res = await h.request('POST', `/api/v2/sessions/${SEEDED_SESSION_ID}/turns`, {
    body: { prompt: '看这张图', content, clientTurnId: 'ct-img-1' },
  });

  assert.equal(res.status, 202, `实际 ${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(res.json.accepted, true);
  assert.equal(res.json.driver, 'desktop');
  assert.equal(res.json.source, 'computer');
  assert.equal(res.json.messageId, 'msg-stub-1');
  assert.equal(res.json.clientTurnId, 'ct-img-1', '回执字段一个都不能少');
  assert.equal(res.json.fromSeq, 16, 'fromSeq 语义不变：locate.lastSeq(15) + 1');
  assert.deepEqual(prompted, [{ sessionId: SEEDED_SESSION_ID, text: '看这张图', mode: 'queue', content }], '图片块必须原样到桌面端');
  assert.equal(prompted[0].content.length, content.length, '带了非空 text 块的轮次**不许**多出占位 text 块');
  assert.equal(stub.calls.follows.length, 1, '仍然是先开流、后投递');
});

test('v2：纯图轮次（content 里只有图片）→ 占位正文作为第一个 text 块到达桌面端', async (t) => {
  const { stub, prompted } = desktopStubRecordingPrompt({
    entries: [{ sessionId: SEEDED_SESSION_ID, running: false, agentAvailable: true, turns: 1 }],
    autoFrames: [desktopEvent('turn/start', { turn: 2 }, { seq: 7 })],
  });
  const h = await startV2(t, { desktop: stub });

  const image = { type: 'image', mediaType: 'image/png', data: Buffer.from('hi').toString('base64') };
  const res = await h.request('POST', `/api/v2/sessions/${SEEDED_SESSION_ID}/turns`, {
    body: { prompt: '（content 存在时这个字段不参与）', content: [image] },
  });

  assert.equal(res.status, 202, `实际 ${res.status} ${res.text.slice(0, 200)}`);
  assert.deepEqual(prompted, [{
    sessionId: SEEDED_SESSION_ID,
    text: '（查看这张图片）',
    mode: 'queue',
    content: [{ type: 'text', text: '（查看这张图片）' }, image],
  }], '占位正文既要在 text 参数里、也要在 content 首块里（桌面端只认 content）');
});

test('v2：POST /turns 的 content 非法 → 400 bad_request，且消息指认具体问题', async (t) => {
  const h = await startV2(t); // desktop: null —— 显式关闭桌面端接线（隔离红线）

  const cases = [
    ['content 不是数组', '看图', /content 必须是数组/],
    ['未知 type', [{ type: 'video', data: 'AAAA' }], /type 未知/],
    ['mediaType 不在白名单', [{ type: 'image', mediaType: 'image/bmp', data: 'AAAA' }], /不在白名单内/],
    ['data 非严格 base64', [{ type: 'image', mediaType: 'image/png', data: 'AA AA' }], /不是严格 base64/],
    ['图片超过 4 张', [0, 1, 2, 3, 4].map(() => ({ type: 'image', mediaType: 'image/png', data: 'AAAA' })), /图片数量超过上限/],
    ['单图超过 700 KiB', [{ type: 'image', mediaType: 'image/png', data: Buffer.alloc(716_801, 1).toString('base64') }], /超过单图上限 716800 字节/],
  ];
  for (const [label, content, pattern] of cases) {
    const res = await h.request('POST', `/api/v2/sessions/${SEEDED_SESSION_ID}/turns`, { body: { prompt: '看图', content } });
    assert.equal(res.status, 400, `${label} 必须是 400（实际 ${res.status} ${res.text.slice(0, 160)}）`);
    assert.equal(res.json.error.code, 'bad_request', label);
    assert.match(res.json.error.message, pattern, `${label}（实际：${res.json.error.message}）`);
  }
});

test('content 块：整包预算 —— 单图满额 700 KiB 放行，两张满额 → 400（绝不是 413）', () => {
  const img = (data) => ({ type: 'image', mediaType: 'image/png', data });

  // (a) 单图正好 716800 字节：协议允许的最大单图，**必须放行**（它也在整包预算内）。
  //     这条同时钉住了预算的取值下界：716800 字节 → 955736 个 base64 字符，
  //     所以整包预算不能小于 955736，否则"单图 ≤700 KiB"会被整包预算反噬成死代码。
  const one = img(Buffer.alloc(TURN_MAX_IMAGE_BYTES, 0x41).toString('base64'));
  assert.equal(one.data.length, 955_736, '716800 字节 → 955736 个 base64 字符（膨胀 4/3）');
  assert.ok(TURN_MAX_IMAGE_TOTAL_BASE64 > one.data.length, '整包预算必须容得下一张满额单图');
  const single = validateTurnContent([{ type: 'text', text: '看一下' }, one]);
  assert.equal(single.ok, true, single.message);
  assert.deepEqual(single.images, { count: 1, bytes: TURN_MAX_IMAGE_BYTES });

  // (b) 两张满额：每张都 ≤716800（单图那层放行），合起来 1_911_472 字符 → 整包预算 400。
  //     这条**绝不能落成 413**：1.9MB 的请求体会在 `readJsonBody` 被"不读体、直接关连接"，
  //     手机端只看到连接被重置，拿不到任何可展示的错误 —— 400 是唯一诚实的出口。
  const two = validateTurnContent([one, one]);
  assert.equal(two.ok, false);
  assert.equal(two.message, '图片总量超过单次请求预算（约 1 MB base64），请减少图片数量或压缩后再发');

  // (c) 边界：两张各半预算（各 500000 字符 / 375000 字节）正好等于预算 → 放行；
  //     其中一张多 4 个字符（多 3 字节，仍远低于单图上限）→ 整包预算拒。
  const half = img(Buffer.alloc((TURN_MAX_IMAGE_TOTAL_BASE64 / 2 / 4) * 3, 0x42).toString('base64'));
  assert.equal(half.data.length, TURN_MAX_IMAGE_TOTAL_BASE64 / 2);
  assert.equal(validateTurnContent([half, half]).ok, true);
  const over = validateTurnContent([img(`${half.data}AAAA`), half]);
  assert.equal(over.ok, false);
  assert.match(over.message, /图片总量超过单次请求预算/);
});

test('content 块：整包预算必然落在 1MB 请求体上限之内（否则预算就永远轮不到报错）', () => {
  // 这是**已知上限的交集**，不是本次改动引入的，但必须让它在测试里可见：
  // - `config.limits.maxBodyBytes` 只有 1_048_576（`config.mjs:216`，注明"契约/工单硬性要求"），
  //   作用于**整个 JSON 请求体**（lead 实测：body=1_048_500 通过，1_048_640 连接被关闭）；
  // - base64 膨胀 4/3 → "4 张 × 700 KiB" 原始量 2.8 MiB 会变成约 3.7 MiB 的体，在进入
  //   `validateTurnContent` **之前**就被 `readJsonBody` 挡掉（该分支不读请求体、直接
  //   413 + Connection: close，实测手机端表现为连接被重置）。
  // 因此校验器给出的整包预算**必须严格小于**体上限：凡是能送到校验器的带图请求，
  // 都能拿到可展示的 400；而比体上限还大的请求本来也读不完。
  assert.ok(TURN_MAX_IMAGE_TOTAL_BASE64 < 1_048_576, '预算必须留在 1MB 体上限之内');
  const encodedPerImage = Math.ceil(TURN_MAX_IMAGE_BYTES / 3) * 4;
  assert.ok(encodedPerImage < TURN_MAX_IMAGE_TOTAL_BASE64, '一张满额图片必须放得进整包预算');
  assert.ok(2 * encodedPerImage > TURN_MAX_IMAGE_TOTAL_BASE64, '两张满额图片必然超出整包预算');
  assert.ok(4 * encodedPerImage > 1_048_576, '四张满额图片连 1MB 请求体都超（会在传输层被砍）');
});

test('v2：多图总量越过整包预算、请求体却仍在 1 MiB 之内 → 400（而不是 413）', async (t) => {
  const h = await startV2(t);
  // 两张各 510000 字符（= 382500 字节）：合 1_020_000 > 1_000_000，而请求体只有约 1_020 KB < 1 MiB。
  // 这正是"整包预算"要覆盖的那个窗口 —— 校验器抢在 `readJsonBody` 的 413 之前给出可展示的 400。
  const image = { type: 'image', mediaType: 'image/png', data: Buffer.alloc(382_500, 0x43).toString('base64') };
  assert.equal(image.data.length, 510_000);
  const body = { prompt: '两张图', content: [image, image] };
  assert.ok(JSON.stringify(body).length < 1_048_576, '构造出的请求体必须仍在 1 MiB 之下，否则测的就是 413');
  assert.ok(2 * image.data.length > TURN_MAX_IMAGE_TOTAL_BASE64, '总量必须越过整包预算');

  const res = await h.request('POST', `/api/v2/sessions/${SEEDED_SESSION_ID}/turns`, { body });
  assert.equal(res.status, 400, `实际 ${res.status} ${res.text.slice(0, 160)}`);
  assert.equal(res.json.error.code, 'bad_request');
  assert.match(res.json.error.message, /图片总量超过单次请求预算/);
});
