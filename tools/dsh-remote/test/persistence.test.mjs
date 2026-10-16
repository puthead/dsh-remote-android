/**
 * 持久化与重启恢复测试（工单硬性要求 6）：
 * 任务历史与设备令牌在网关重启后仍在、中断任务被修复、原子写残留被清理、
 * 损坏文件被隔离、日志包含 sessionId 与耗时且不含任何明文密钥。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGateway } from '../lib/http.mjs';
import { createLogger } from '../lib/util.mjs';
import { httpRequest, makeSandbox, pairDevice, scripted, startHarness, waitFor, waitForTask } from './helpers.mjs';

/** 在同一个 sandbox 上启动一个网关实例（模拟一次重启）。 */
async function boot(config) {
  const logger = createLogger({ dir: config.logsDir, toConsole: false });
  // desktop: null → 显式关闭桌面端接线，避免构造真实 DesktopApi（会连 127.0.0.1:19387）
  const gateway = await createGateway(config, { logger, desktop: null });
  const port = await gateway.listen();
  return { gateway, logger, port, baseUrl: `http://127.0.0.1:${port}` };
}

test('重启后：任务历史与设备令牌仍在，旧令牌继续可用', async (t) => {
  const sandbox = await makeSandbox(t, {}, { autoCleanup: false });
  const opened = [];
  t.after(async () => {
    for (const item of opened) await item.gateway.close().catch(() => {});
    await sandbox.cleanup();
  });

  // 第一次启动：配对 + 跑一个任务
  const first = await boot(sandbox.config);
  opened.push(first);
  const token = await pairDevice(first.baseUrl, { deviceName: 'Xiaomi 14', deviceId: '11111111-2222-4333-8444-555555555501' });
  const created = await httpRequest(first.baseUrl, 'POST', '/api/v1/tasks', {
    token,
    body: { prompt: scripted({ mode: 'echo', text: '重启前的结果', chunks: 2 }), workspace: sandbox.workspace },
  });
  assert.equal(created.status, 201);
  const done = await waitForTask({ request: (m, p, o) => httpRequest(first.baseUrl, m, p, { token, ...o }) }, created.json.id);
  assert.equal(done.status, 'succeeded');
  await first.gateway.close();

  // 第二次启动：同一个 home
  const second = await boot(sandbox.config);
  opened.push(second);

  const list = await httpRequest(second.baseUrl, 'GET', '/api/v1/tasks', { token });
  assert.equal(list.status, 200, '重启后旧令牌必须仍然有效');
  assert.equal(list.json.tasks.length, 1);
  assert.equal(list.json.tasks[0].id, created.json.id);
  assert.equal(list.json.tasks[0].status, 'succeeded');
  assert.equal(list.json.tasks[0].output, '重启前的结果');
  assert.equal(list.json.tasks[0].exitCode, 0);

  const detail = await httpRequest(second.baseUrl, 'GET', `/api/v1/tasks/${created.json.id}`, { token });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.output, '重启前的结果');

  const devices = await httpRequest(second.baseUrl, 'GET', '/api/v1/devices', { token });
  assert.equal(devices.json.devices.length, 1);
  assert.equal(devices.json.devices[0].deviceName, 'Xiaomi 14');
  await second.gateway.close();
});

test('重启恢复：中断的 running/queued 任务被标记为 failed 并说明原因', async (t) => {
  const sandbox = await makeSandbox(t, {}, { autoCleanup: false });
  // 手工构造"网关崩溃时留下的"任务文件
  const interrupted = {
    id: 'task_01AAAAAAAAAAAAAAAAAAAAAAAA',
    title: '崩溃前正在跑',
    prompt: 'x',
    workspace: sandbox.workspace,
    status: 'running',
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 59_000,
    finishedAt: null,
    exitCode: null,
    output: '半截输出',
    error: null,
    truncated: false,
    sessionId: null,
    meta: { runId: 'run_dead', timeoutSec: 3600 },
  };
  const queued = { ...interrupted, id: 'task_01BBBBBBBBBBBBBBBBBBBBBBBB', status: 'queued', startedAt: null, output: '' };
  await fs.writeFile(path.join(sandbox.config.tasksDir, `${interrupted.id}.json`), JSON.stringify(interrupted), 'utf8');
  await fs.writeFile(path.join(sandbox.config.tasksDir, `${queued.id}.json`), JSON.stringify(queued), 'utf8');

  const { gateway, baseUrl } = await boot(sandbox.config);
  t.after(async () => {
    await gateway.close().catch(() => {});
    await sandbox.cleanup();
  });
  const token = await pairDevice(baseUrl, { deviceName: 'pc', deviceId: '11111111-2222-4333-8444-555555555502' });

  for (const id of [interrupted.id, queued.id]) {
    const res = await httpRequest(baseUrl, 'GET', `/api/v1/tasks/${id}`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'failed', '不允许留下永远 running 的僵尸任务');
    assert.match(res.json.error, /网关重启，任务执行已中断/);
    assert.ok(res.json.finishedAt > 0);
  }
  const restored = await httpRequest(baseUrl, 'GET', `/api/v1/tasks/${interrupted.id}`, { token });
  assert.equal(restored.json.output, '半截输出', '已产出的输出必须保留');
});

test('权限档持久化：重启后 access 保持原值，老任务文件（无该字段）回落为 workspace', async (t) => {
  const sandbox = await makeSandbox(t, {}, { autoCleanup: false });
  const base = {
    title: 'x',
    prompt: 'x',
    workspace: sandbox.workspace,
    status: 'succeeded',
    createdAt: Date.now() - 120_000,
    startedAt: Date.now() - 119_000,
    finishedAt: Date.now() - 118_000,
    exitCode: 0,
    output: '',
    error: null,
    truncated: false,
    sessionId: null,
    meta: { runId: 'run_x', timeoutSec: 600 },
  };
  const fullTask = { ...base, id: 'task_01CCCCCCCCCCCCCCCCCCCCCCCC', access: 'full' };
  // 老版本写下的文件：没有 access 字段
  const legacyTask = { ...base, id: 'task_01DDDDDDDDDDDDDDDDDDDDDDDD' };
  await fs.writeFile(path.join(sandbox.config.tasksDir, `${fullTask.id}.json`), JSON.stringify(fullTask), 'utf8');
  await fs.writeFile(path.join(sandbox.config.tasksDir, `${legacyTask.id}.json`), JSON.stringify(legacyTask), 'utf8');

  const { gateway, baseUrl } = await boot(sandbox.config);
  t.after(async () => {
    await gateway.close().catch(() => {});
    await sandbox.cleanup();
  });
  const token = await pairDevice(baseUrl, { deviceName: 'pc', deviceId: '11111111-2222-4333-8444-555555555503' });

  const full = await httpRequest(baseUrl, 'GET', `/api/v1/tasks/${fullTask.id}`, { token });
  assert.equal(full.json.access, 'full', '全部权限任务重启后不得被静默降档');
  const legacy = await httpRequest(baseUrl, 'GET', `/api/v1/tasks/${legacyTask.id}`, { token });
  assert.equal(legacy.json.access, 'workspace', '缺字段的老任务一律按"仅当前工作区"处理');
});

test('启动清理：原子写残留的 .tmp 文件被删除，损坏的任务文件被隔离而非导致启动失败', async (t) => {
  const sandbox = await makeSandbox(t, {}, { autoCleanup: false });
  const tasksDir = sandbox.config.tasksDir;
  await fs.writeFile(path.join(tasksDir, 'task_x.json.tmp-999-abcdef'), '{"half":', 'utf8');
  await fs.writeFile(path.join(tasksDir, 'task_bad.json'), '{ 这不是 JSON', 'utf8');

  const { gateway, baseUrl } = await boot(sandbox.config);
  t.after(async () => {
    await gateway.close().catch(() => {});
    await sandbox.cleanup();
  });

  const files = await fs.readdir(tasksDir);
  assert.ok(!files.some((f) => f.includes('.tmp-')), `残留临时文件必须清理：${files.join(',')}`);
  assert.ok(
    files.some((f) => f.startsWith('task_bad.json.corrupt-')),
    '损坏文件必须被隔离重命名',
  );

  const token = await pairDevice(baseUrl, { deviceName: 'pc', deviceId: '11111111-2222-4333-8444-555555555503' });
  const list = await httpRequest(baseUrl, 'GET', '/api/v1/tasks', { token });
  assert.equal(list.status, 200, '隔离后网关仍可正常工作');
  assert.equal(list.json.tasks.length, 0);
});

test('日志：包含任务 id、sessionId 与耗时，且不出现明文令牌/API Key', async (t) => {
  const h = await startHarness(t, { dsh: { discoverSessionId: true } });
  const created = await h.request('POST', '/api/v1/tasks', {
    body: { prompt: scripted({ mode: 'echo', text: '写日志', chunks: 1 }), workspace: h.workspace },
  });
  await waitForTask(h, created.json.id);
  // 触发一次认证失败，验证失败路径也不落令牌明文
  await h.request('GET', '/api/v1/tasks', { token: 'dshr_SHOULD-NEVER-APPEAR-IN-LOGS-000' });

  const logDir = h.config.logsDir;
  const files = (await fs.readdir(logDir)).filter((f) => f.endsWith('.log'));
  assert.equal(files.length, 1, '日志按天滚动为单文件');
  assert.match(files[0], /^gateway-\d{8}\.log$/, '日志文件名必须是 gateway-YYYYMMDD.log');
  // 任务状态先于日志写入内存，日志是随后追加的；这里轮询等待，避免读得过早导致假失败
  const text = await waitFor(
    async () => {
      const content = await fs.readFile(path.join(logDir, files[0]), 'utf8');
      return content.includes(`task finished id=${created.json.id}`) ? content : null;
    },
    { message: '日志未记录任务结束' },
  );

  assert.ok(text.includes(`task started id=${created.json.id}`), '日志应记录任务开始');
  assert.ok(text.includes(`task finished id=${created.json.id}`), '日志应记录任务结束');
  assert.match(text, /sessionId=\S+/, '日志应记录 sessionId 字段（无会话时为 null）');
  assert.match(text, /elapsedMs=\d+/, '日志应记录任务耗时');
  assert.ok(!text.includes(h.token), '日志绝不能出现明文设备令牌');
  assert.ok(!text.includes('dshr_SHOULD-NEVER-APPEAR-IN-LOGS-000'), '认证失败也不会记录令牌明文');
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(text), '日志绝不能出现 API Key');
  assert.ok(text.includes('中文') || text.includes('监听'), '日志必须是可读 UTF-8 中文');
});

test('devices.json 只存哈希，且重启后哈希校验依然工作', async (t) => {
  const sandbox = await makeSandbox(t, {}, { autoCleanup: false });
  const opened = [];
  t.after(async () => {
    for (const item of opened) await item.gateway.close().catch(() => {});
    await sandbox.cleanup();
  });

  const first = await boot(sandbox.config);
  opened.push(first);
  const token = await pairDevice(first.baseUrl, { deviceName: 'Pixel', deviceId: '11111111-2222-4333-8444-555555555504' });
  const raw = await fs.readFile(sandbox.config.devicesFile, 'utf8');
  assert.ok(!raw.includes(token), 'devices.json 不得出现明文令牌');
  assert.ok(!raw.includes('dshr_'), 'devices.json 不得出现令牌前缀');
  const parsed = JSON.parse(raw);
  assert.match(parsed.devices[0].tokenHash, /^[0-9a-f]{64}$/, '必须是 sha256 十六进制');
  await first.gateway.close();

  const second = await boot(sandbox.config);
  opened.push(second);
  const ok = await httpRequest(second.baseUrl, 'GET', '/api/v1/tasks', { token });
  assert.equal(ok.status, 200, '重启后 sha256 校验仍然通过');
  const bad = await httpRequest(second.baseUrl, 'GET', '/api/v1/tasks', { token: `${token}x` });
  assert.equal(bad.status, 401);
  await second.gateway.close();
});
