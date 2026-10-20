/**
 * 会话权限（v2.11.0）：手机在**对话里**改电脑端会话权限。
 *
 * 隔离红线同其它 v2 用例：桌面端一律 `makeDesktopStub()`，绝不连真实 19387/随机端口。
 * 本文件把整条链闭合起来验：
 * 请求 → 网关校验 → 桌面端 `commands/execute('/permission …')` → 回读投影 →
 * HTTP 回执 + `session.updated` 广播；并守住"网关自有会话不能在运行中改档"这条边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startV2, collectSse } from './v2-harness.mjs';
import { desktopEvent, makeDesktopStub, waitFor } from './helpers.mjs';

const SEEDED = 'session-11111111-2222-4333-8444-555555555555';

/** 一个可写、非派生的电脑端会话替身。 */
function desktopWithPermission(currentValue = 'workspace-write') {
  return makeDesktopStub({
    entries: [{
      sessionId: SEEDED,
      title: '权限测试会话',
      running: false,
      values: { permissions: { currentValue } },
    }],
    projections: { [SEEDED]: { values: { permissions: { currentValue } }, asOfSeq: 3 } },
  });
}

test('GET /sessions 与详情都下发电脑端权限视图（editable=true）', async (t) => {
  const desktop = desktopWithPermission('workspace-write');
  const h = await startV2(t, { desktop });

  const list = await h.request('GET', '/api/v2/sessions?limit=50');
  assert.equal(list.status, 200, list.text);
  const item = list.json.sessions.find((s) => s.id === SEEDED);
  assert.ok(item, `列表里应包含合成会话：${list.text}`);
  assert.equal(item.permission.currentValue, 'workspace-write');
  assert.equal(item.permission.editable, true);
  assert.equal(item.permission.source, 'desktop');
  assert.ok(item.permission.options.some((o) => o.value === 'danger-full-access'));

  const detail = await h.request('GET', `/api/v2/sessions/${SEEDED}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.permission.currentValue, 'workspace-write');
  assert.equal(detail.json.permission.editable, true);
});

test('POST /sessions/{id}/permission：写入 /permission 命令、回读投影、广播更新', async (t) => {
  const desktop = desktopWithPermission('workspace-write');
  const h = await startV2(t, { desktop });

  const ssePromise = collectSse(h.baseUrl, h.token, {
    sessionId: SEEDED,
    until: (events) => events.some((event) => event.event === 'session.updated' && event.data?.permission),
  });
  const res = await h.request('POST', `/api/v2/sessions/${SEEDED}/permission`, {
    body: { preset: 'danger-full-access' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.preset, 'danger-full-access');
  assert.equal(res.json.applied, true);
  assert.equal(res.json.verified, true);
  assert.equal(res.json.permission.currentValue, 'danger-full-access');
  assert.equal(res.json.permission.editable, true);

  assert.deepEqual(desktop.calls.executeCommand.map((entry) => entry.line), ['/permission danger-full-access']);
  // 桌面端投影确实被改了（替身实现；用于证明网关回读的是"真值"而不是请求体）
  assert.equal(desktop.entries[0].projections.values.permissions.currentValue, 'danger-full-access');

  const events = await ssePromise;
  const updated = events.find((event) => event.event === 'session.updated' && event.data?.permission);
  assert.ok(updated, `应广播 session.updated：${JSON.stringify(events)}`);
  assert.equal(updated.data.sessionId, SEEDED);
  assert.equal(updated.data.permission.currentValue, 'danger-full-access');
});

test('POST /sessions/{id}/permission：未知 preset / 未知会话 / 网关自有会话都明确拒绝', async (t) => {
  const desktop = desktopWithPermission('workspace-write');
  const h = await startV2(t, { desktop });

  const badPreset = await h.request('POST', `/api/v2/sessions/${SEEDED}/permission`, {
    body: { preset: 'root' },
  });
  assert.equal(badPreset.status, 400, badPreset.text);
  assert.match(badPreset.json.error.message, /preset/);

  const missing = await h.request('POST', '/api/v2/sessions/session-00000000-0000-4000-8000-000000000000/permission', {
    body: { preset: 'workspace-write' },
  });
  assert.equal(missing.status, 404, missing.text);

  // 网关自有会话（source=phone）：权限在创建时固定，不能运行中改。
  const gateway = makeDesktopStub({ entries: [] });
  const h2 = await startV2(t, { desktop: gateway });
  const task = await h2.request('POST', '/api/v2/tasks', {
    body: { host: 'gateway', workspace: h2.extraWs, prompt: '只在手机上跑', title: '网关会话' },
  });
  assert.ok([202, 200].includes(task.status), task.text);
  const phoneSessionId = task.json.sessionId;
  assert.ok(phoneSessionId, task.text);
  const denied = await h2.request('POST', `/api/v2/sessions/${phoneSessionId}/permission`, {
    body: { preset: 'danger-full-access' },
  });
  assert.equal(denied.status, 400, denied.text);
  assert.match(denied.json.error.message, /电脑端会话/);
});

test('POST /sessions/{id}/permission：桌面端命令失败 → 502，且不广播成功', async (t) => {
  // 用命令业务失败（kind=error）验证：HTTP 也要失败，而不是把 "unknown preset" 说成成功。
  const desktop = makeDesktopStub({
    entries: [{ sessionId: SEEDED, title: '权限测试会话', values: { permissions: { currentValue: 'workspace-write' } } }],
    projections: { [SEEDED]: { values: { permissions: { currentValue: 'workspace-write' } }, asOfSeq: 3 } },
    executeCommandResult: { commandId: 'cmd-bad', result: { kind: 'error', text: 'unknown preset "root"' } },
  });
  const h = await startV2(t, { desktop });

  const res = await h.request('POST', `/api/v2/sessions/${SEEDED}/permission`, {
    body: { preset: 'danger-full-access' },
  });
  assert.equal(res.status, 502, res.text);
  assert.match(res.json.error.message, /unknown preset/);
});

test('POST /v2/tasks（电脑端）在首轮投递前设置权限，并在回执里如实给 access', async (t) => {
  const created = 'session-22222222-3333-4444-8555-666666666666';
  const desktop = makeDesktopStub({
    createdSessionId: created,
    entries: [],
    // 桌面端首轮投递要求订阅真的出帧，否则 `#submitDesktop` 会一直等在第一帧（测试挂死）。
    autoFrames: [desktopEvent('turn/start', { turn: { id: 'turn-1' }, seq: 1 })],
  });
  const h = await startV2(t, { desktop });

  const res = await h.request('POST', '/api/v2/tasks', {
    body: { host: 'desktop', workspace: h.extraWs, prompt: '给我全部权限跑', access: 'full', title: '权限任务' },
  });
  assert.equal(res.status, 202, res.text);
  assert.equal(res.json.sessionId, created);
  assert.equal(res.json.access, 'full');
  assert.equal(res.json.permissionApplied, true);
  assert.equal(res.json.permission.currentValue, 'danger-full-access');

  // 顺序：先 executeCommand，再 prompt —— 否则首轮会按旧档位执行。
  const commandIndex = desktop.calls.order.indexOf('executeCommand');
  const promptIndex = desktop.calls.order.indexOf('prompt');
  assert.ok(commandIndex >= 0, `应调用 commands/execute：${desktop.calls.order}`);
  assert.ok(promptIndex >= 0, `应投递首轮：${desktop.calls.order}`);
  assert.ok(commandIndex < promptIndex, `权限必须先于首轮：${desktop.calls.order}`);
  assert.equal(desktop.calls.executeCommand[0].line, '/permission danger-full-access');
});

test('POST /v2/tasks（电脑端）权限设置失败：任务照跑，但回执明确 permissionApplied=false', async (t) => {
  const created = 'session-33333333-4444-4555-8666-777777777777';
  const desktop = makeDesktopStub({
    createdSessionId: created,
    entries: [],
    autoFrames: [desktopEvent('turn/start', { turn: { id: 'turn-1' }, seq: 1 })],
    executeCommandError: Object.assign(new Error('桌面端拒绝执行'), { code: 'desktop_command_failed' }),
  });
  const h = await startV2(t, { desktop });

  const res = await h.request('POST', '/api/v2/tasks', {
    body: { host: 'desktop', workspace: h.extraWs, prompt: '权限失败也要跑', access: 'full' },
  });
  assert.equal(res.status, 202, res.text);
  assert.equal(res.json.permissionApplied, false);
  assert.match(res.json.permissionWarning, /桌面端拒绝执行/);
  assert.equal(res.json.access, undefined, '没生效就不许回执 access（否则手机会显示已按全部权限执行）');
  // 任务仍然投递（软失败）
  await waitFor(() => desktop.calls.prompt.length === 1, { message: '权限失败不应挡住首轮投递' });
});
