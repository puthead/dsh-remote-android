/**
 * v2 HTTP 集成测试：真实 HTTP 服务 + 真实多帧 zstd 会话文件 + **替身 SDK 运行时**。
 *
 * 为什么用替身子进程而不是 mock 函数：`session-runner` 的关键行为（进程生命周期、
 * NDJSON 分帧、事件映射、轮次收束、落盘后刷新镜像、关闭时杀进程树）全都在
 * 「真子进程 + 真管道」这条路径上。把 spawn 换成假对象就等于把要验的东西删掉了。
 * 替身 `fixtures/fake-sdk.mjs` 说的是**真实 wire 形状**（NDJSON JSON-RPC），
 * 并且真的写多帧 zstd 会话文件，因此「轮次 → SSE → 落盘 → /transcript」是端到端闭环。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeWorkspaceSlug } from '../lib/dsh-home.mjs';
import { makeDesktopStub, sleep, waitFor } from './helpers.mjs';
import { collectSse, seedSession, startV2 } from './v2-harness.mjs';

// ---------------------------------------------------------------- health / 认证
test('v2：/api/v2/health 暴露双根与 SDK 启动器；v1 health 字段不变', async (t) => {
  const h = await startV2(t);
  const v1 = await h.request('GET', '/api/v1/health', { token: null });
  assert.equal(v1.status, 200);
  assert.equal(v1.json.apiVersion, 1, 'apiVersion 恒为 1');
  assert.deepEqual(v1.json.supportedApiVersions, [1, 2]);

  const v2 = await h.request('GET', '/api/v2/health', { token: null });
  assert.equal(v2.status, 200);
  assert.equal(v2.json.apiVersion, 1);
  assert.deepEqual(v2.json.supportedApiVersions, [1, 2]);
  assert.ok(v2.json.capabilities.includes('sessions'));
  assert.ok(v2.json.capabilities.includes('relay'));
  assert.equal(v2.json.sessionMirror.enabled, true);
  assert.deepEqual(v2.json.sessionMirror.roots.map((r) => r.source), ['phone', 'computer']);
  assert.equal(v2.json.sessionMirror.roots[1].writable, false);
  assert.equal(v2.json.sessionRunner.supportsSdk, true);
  assert.equal(v2.json.sessionRunner.launchSource, 'explicit');

  // v2 需要鉴权
  const noAuth = await h.request('GET', '/api/v2/sessions', { token: null });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.json.error.code, 'unauthorized');
  const badToken = await h.request('GET', '/api/v2/sessions', { token: 'dshr_wrong' });
  assert.equal(badToken.status, 401);
});

// ---------------------------------------------------------------- 会话列表 / detail / transcript
test('v2：会话列表同时给出 phone 与 computer 会话，带 writable/source', async (t) => {
  const h = await startV2(t);
  const res = await h.request('GET', '/api/v2/sessions?limit=50');
  assert.equal(res.status, 200);
  const computer = res.json.sessions.find((s) => s.id === h.seeded.id);
  assert.ok(computer, '合成的电脑端会话必须出现');
  assert.equal(computer.source, 'computer');
  assert.equal(computer.driver, 'desktop', '电脑端会话由桌面端 DSH runtime 驱动');
  assert.equal(computer.writable, false);
  assert.equal(computer.writableReason, 'desktop_disabled', '未接入桌面端 → 给出可解释的原因');
  assert.equal(computer.title, '构建排障');
  assert.equal(computer.turns, 1);
  assert.equal(computer.steps, 1);
  assert.equal(computer.origin, 'user');
  assert.equal(computer.agentPreset, 'standard');
  assert.equal(computer.bytes > 0, true);
  assert.ok(computer.eventCount >= 16);
  assert.equal(computer.hasChanges, true);
  assert.equal(computer.changeCount, 0, '该 fixture 里没有文件写入工具（toolCalls 只有 pwsh）');
  assert.deepEqual(computer.lastTurn, { state: 'ended', reason: 'completed' });
  assert.equal(res.json.roots.length, 2);

  // ?source 过滤只接受 computer/phone
  const onlyComputer = await h.request('GET', '/api/v2/sessions?source=computer');
  assert.ok(onlyComputer.json.sessions.every((s) => s.source === 'computer'));
  const bad = await h.request('GET', '/api/v2/sessions?source=pc');
  assert.equal(bad.status, 400, 'source 只接受 computer/phone（逐字对齐 lead 裁定）');

  // limit 边界
  assert.equal((await h.request('GET', '/api/v2/sessions?limit=0')).status, 400);
  assert.equal((await h.request('GET', '/api/v2/sessions?limit=9999')).status, 400);
});

test('v2：真实多帧 zstd 会话的 transcript 投影（工具调用/交付物/待办/中文）', async (t) => {
  const h = await startV2(t);
  const res = await h.request('GET', `/api/v2/sessions/${h.seeded.id}/transcript?limit=100`);
  assert.equal(res.status, 200);
  assert.equal(res.json.sessionId, h.seeded.id);
  const messages = res.json.messages;

  const user = messages.find((m) => m.role === 'user');
  assert.equal(user.text, '帮我看看构建失败的原因', '中文原样');
  const assistant = messages.find((m) => m.role === 'assistant' && m.toolCalls.length > 0);
  assert.equal(assistant.text, '定位到 AGP 版本不匹配。');
  assert.equal(assistant.reasoning, '先看 AGP 版本');
  const call = assistant.toolCalls[0];
  assert.equal(call.name, 'pwsh');
  assert.deepEqual(call.args, { command: 'gradlew -v', description: '版本' }, 'arguments 是 JSON 字符串，需二次解析');
  assert.equal(call.result, 'BUILD SUCCESSFUL');
  assert.equal(call.isError, false);
  assert.equal(call.durationMs, 9);
  assert.deepEqual(assistant.deliverables, [{ path: 'app-release.apk', description: 'release 包' }]);
  assert.ok(messages.some((m) => m.todos?.length === 1), 'todo/write 产出待办消息');
  assert.ok(!messages.some((m) => m.text.includes('You are an AI agent')), 'system prompt 默认不可见');
  assert.ok(!messages.some((m) => m.text.includes('Current runtime context')), 'runtime-context 默认不可见');
  assert.ok(res.text.includes('构建排障') || res.text.includes('帮我看看'), '响应体里中文未被 \\u 转义');

  // 分页：cursor 是排他上界，因此"更早一页"最多拿到 cursor 之前的所有（可能少于 limit）
  const tail = await h.request('GET', `/api/v2/sessions/${h.seeded.id}/transcript?tail=2`);
  assert.equal(tail.json.messages.length, 2);
  assert.ok(tail.json.nextCursor);
  const older = await h.request('GET', `/api/v2/sessions/${h.seeded.id}/transcript?limit=2&cursor=${tail.json.nextCursor}`);
  assert.ok(older.json.messages.length >= 1, `更早一页必须有内容（实际 ${older.json.messages.length}）`);
  assert.ok(older.json.messages[0].seq < tail.json.messages[0].seq, '更早一页的 seq 更小');
  assert.equal(older.json.nextCursor, null, '已到最早 → nextCursor 为 null');

  // include=internal 可拿到全量
  const internal = await h.request('GET', `/api/v2/sessions/${h.seeded.id}/transcript?limit=100&include=internal`);
  assert.ok(internal.json.messages.some((m) => m.internal === true));
  assert.ok(internal.json.messages.some((m) => m.text.includes('You are an AI agent')));

  // events（原始）
  const evs = await h.request('GET', `/api/v2/sessions/${h.seeded.id}/events?fromSeq=8&limit=5`);
  assert.equal(evs.status, 200);
  assert.ok(evs.json.events.every((e) => e.seq >= 8));
  assert.equal(evs.json.nextFromSeq, 13);
});

test('v2：不存在的会话 → 404 session_not_found；非法 id → 404', async (t) => {
  const h = await startV2(t);
  const missing = await h.request('GET', '/api/v2/sessions/session-99999999-9999-4999-8999-999999999999');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'session_not_found');
  assert.equal((await h.request('GET', '/api/v2/sessions/session-99999999-9999-4999-8999-999999999999/transcript')).status, 404);
  assert.equal((await h.request('GET', '/api/v2/sessions/..%2F..%2Fetc')).status, 404);
});

// ---------------------------------------------------------------- 电脑端会话（桌面端驱动）
test('v2：未接入桌面端时对电脑端会话续聊 → 503 desktop_unavailable（文案逐字）', async (t) => {
  const h = await startV2(t); // desktop: null —— 显式关闭桌面端接线，绝不自建真实 DesktopApi
  const res = await h.request('POST', `/api/v2/sessions/${h.seeded.id}/turns`, { body: { prompt: '继续' } });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'desktop_unavailable');
  assert.equal(
    res.json.error.message,
    '网关未接入桌面端 DSH runtime，无法驱动电脑端会话（需桌面端 DSH 正在运行，且网关能读到 ~/.dsh/.credentials.yaml）',
  );
  // 镜像源没有被写入（mtime/size 不变）
  const before = await fs.stat(h.seeded.file);
  await sleep(30);
  const after = await fs.stat(h.seeded.file);
  assert.equal(after.size, before.size, '只读镜像绝不能被写入');
});

// ---------------------------------------------------------------- 手机任务全链路
test('v2：POST /api/v2/tasks 新建手机任务 → 202 + SSE 流式增量 + 落盘 + transcript', async (t) => {
  const h = await startV2(t, { seed: { id: 'session-11111111-2222-4333-8444-555555555555' } });
  const ssePromise = collectSse(h.baseUrl, h.token, { until: (evs) => evs.some((e) => e.event === 'turn.ended') });

  const task = await h.request('POST', '/api/v2/tasks', { body: { prompt: '把测试跑一遍', workspace: h.extraWs } });
  assert.equal(task.status, 202);
  assert.equal(task.json.accepted, true);
  assert.equal(task.json.source, 'phone');
  assert.match(task.json.sessionId, /^session-[0-9a-f-]{36}$/, 'session-<uuid> 形状');
  assert.equal(task.json.fromSeq, 0, '新会话从 seq 0 起');
  assert.ok(task.json.turnId.startsWith('turn_'));

  const events = await ssePromise;
  const types = events.map((e) => e.event);
  assert.ok(types.includes('turn.started'), `SSE 必须含 turn.started（实际：${types.join(',')}）`);
  assert.ok(types.includes('message.delta'), 'SSE 必须含 message.delta');
  assert.ok(types.includes('turn.ended'), 'SSE 必须含 turn.ended');
  assert.ok(events.every((e, i, a) => i === 0 || e.id === null || a[i - 1].id === null || e.id > a[i - 1].id), 'SSE id 必须严格递增');
  const ids = events.map((e) => e.id).filter((id) => id !== null);
  assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]), '有 id 的帧必须严格递增');
  assert.ok(events.filter((e) => e.event === 'heartbeat').every((e) => e.id === null), '心跳不带 id（否则会推进客户端的 Last-Event-ID 续传游标）');
  assert.ok(events.every((e) => e.event === 'heartbeat' || e.data.sessionId === task.json.sessionId), '除心跳外每条事件都带 sessionId');
  assert.ok(events.filter((e) => e.event === 'heartbeat').every((e) => typeof e.data.at === 'number'), '心跳按契约只带 at');
  const started = events.find((e) => e.event === 'turn.started');
  assert.equal(started.data.source, 'phone', 'turn.started 带 source');
  assert.equal(started.data.fromSeq, 0);

  const deltas = events.filter((e) => e.event === 'message.delta');
  const joined = deltas.map((d) => d.data.text).join('');
  assert.equal(joined, '收到：把测试跑一遍', 'text-chunks 逐段拼接必须等于完整回复');
  assert.ok(deltas.length > 1, '必须是真的分片流式（不止一帧）');
  const ended = events.find((e) => e.event === 'turn.ended');
  assert.equal(ended.data.reason, 'completed');

  // 轮次结束后：会话文件已落盘，transcript 可读
  const id = task.json.sessionId;

  // ② 一致性：202 之后该会话必须**立即可见**（列表 + 详情），否则手机详情页会 404
  const listNow = await h.request('GET', '/api/v2/sessions?limit=50&include=all');
  assert.ok(listNow.json.sessions.some((s) => s.id === id), 'POST /tasks 202 之后列表必须立即可见该会话');
  const detailNow = await h.request('GET', `/api/v2/sessions/${id}`);
  assert.equal(detailNow.status, 200, `202 之后详情不能 404（实际 ${detailNow.status} ${detailNow.text.slice(0, 120)}）`);
  assert.equal(detailNow.json.id, id);

  await waitFor(async () => (await h.request('GET', `/api/v2/sessions/${id}/transcript?limit=50`)).json?.messages?.length > 0, { timeoutMs: 8000, message: '轮次结束后 transcript 仍为空' });
  const detail = await h.request('GET', `/api/v2/sessions/${id}`);
  assert.equal(detail.json.source, 'phone');
  assert.equal(detail.json.writable, true, '有活着的运行时 → 可续聊');
  assert.equal(detail.json.turns, 1);
  assert.equal(detail.json.lastTurn.reason, 'completed');
  const tx = await h.request('GET', `/api/v2/sessions/${id}/transcript?limit=50`);
  const assistant = tx.json.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.text, '收到：把测试跑一遍');

  // 第二轮：同一进程续聊（真续聊，不重启子进程）
  // **关键回归（P1 竞态）**：收到 `turn.ended` 的瞬间就必须能续聊。
  // 之前 `turn.ended` 是在 DSH `turn/end` 事件到达时发出的，而那时占用表还没释放，
  // 于是"AI 刚说完话、用户马上追问"会稳定吃到 503 session_taken。
  assert.equal(h.gw.live.isTaken(id), false, 'turn.ended 之后占用必须已释放');
  const pidBefore = h.gw.runner.runtimes.get(id)?.pid;
  const turn2 = await h.request('POST', `/api/v2/sessions/${id}/turns`, { body: { prompt: '再跑一遍' } });
  assert.equal(turn2.status, 202, `收到 turn.ended 后必须立即可续聊（实际 ${turn2.status} ${turn2.text.slice(0, 160)}）`);
  await waitFor(async () => {
    const res = await h.request('GET', `/api/v2/sessions/${id}/transcript?limit=50`);
    return (res.json?.messages ?? []).filter((m) => m.role === 'assistant' && m.text.trim()).length >= 2;
  }, { timeoutMs: 8000, message: '第二轮未产生助手回复' });
  assert.equal(h.gw.runner.runtimes.get(id)?.pid, pidBefore, '两轮必须复用同一个 SDK 进程（进程常驻）');
  const tx2 = await h.request('GET', `/api/v2/sessions/${id}/transcript?limit=50`);
  const texts = tx2.json.messages.filter((m) => m.role === 'assistant' && m.text.trim()).map((m) => m.text);
  assert.deepEqual(texts, ['收到：把测试跑一遍', '收到：再跑一遍']);
  assert.equal((await h.request('GET', `/api/v2/sessions/${id}`)).json.turns, 2);
});

test('v2：工具调用经 SSE 推送，且 tool/result 的 isError 被保留', async (t) => {
  const h = await startV2(t, { env: { FAKE_SDK_TOOLCALL: '1', FAKE_SDK_TOOLERROR: '1' } });
  const ssePromise = collectSse(h.baseUrl, h.token, { until: (evs) => evs.some((e) => e.event === 'turn.ended') });
  const task = await h.request('POST', '/api/v2/tasks', { body: { prompt: '写个文件' } });
  assert.equal(task.status, 202);
  const events = await ssePromise;
  const call = events.find((e) => e.event === 'tool.call');
  const result = events.find((e) => e.event === 'tool.result');
  assert.ok(call, 'SSE 必须含 tool.call');
  assert.equal(call.data.name, 'write');
  assert.deepEqual(call.data.args, { file_path: 'note.txt', content: '收到：写个文件' }, 'arguments 字符串被解析成对象');
  assert.ok(result, 'SSE 必须含 tool.result');
  assert.equal(result.data.isError, true, 'isError 必须透传');
  assert.equal(result.data.result, 'Error: denied');

  // transcript 里也能看到工具结果
  await waitFor(async () => (await h.request('GET', `/api/v2/sessions/${task.json.sessionId}/transcript?limit=50`)).json?.messages?.length > 0, { timeoutMs: 8000 });
  const tx = await h.request('GET', `/api/v2/sessions/${task.json.sessionId}/transcript?limit=50`);
  const toolCall = tx.json.messages.flatMap((m) => m.toolCalls || []).find((c) => c.name === 'write');
  assert.ok(toolCall);
  assert.equal(toolCall.isError, true);
  assert.equal(toolCall.result, 'Error: denied');
});

test('v2：轮次进行中重复提交 → 503 session_taken；模型报错 → turn.ended reason=error', async (t) => {
  const h = await startV2(t, { env: { FAKE_SDK_SLOW_MS: '1500' } });
  const first = await h.request('POST', '/api/v2/tasks', { body: { prompt: '慢任务' } });
  assert.equal(first.status, 202);
  const second = await h.request('POST', `/api/v2/sessions/${first.json.sessionId}/turns`, { body: { prompt: '插队' } });
  assert.equal(second.status, 503);
  assert.equal(second.json.error.code, 'session_taken');
  await waitFor(() => !h.gw.runner.isRunning(first.json.sessionId), { timeoutMs: 10_000, message: '轮次未结束' });

  // 模型报错路径（同一个网关换了 env 的新实例）
  const h2 = await startV2(t, { env: { FAKE_SDK_ERROR: '模型炸了' } });
  const ssePromise = collectSse(h2.baseUrl, h2.token, { until: (evs) => evs.some((e) => e.event === 'turn.ended') });
  const t2 = await h2.request('POST', '/api/v2/tasks', { body: { prompt: 'x' } });
  const events = await ssePromise;
  const ended = events.find((e) => e.event === 'turn.ended');
  assert.equal(ended.data.reason, 'error');
  assert.equal(ended.data.error.message, '模型炸了', '模型错误必须透传给手机');
  assert.ok(events.some((e) => e.event === 'message.delta'), '报错前的内容仍应推送');
  assert.ok(t2.json.sessionId);
});

test('v2：POST /api/v2/tasks 参数校验与不可用降级', async (t) => {
  const h = await startV2(t);
  assert.equal((await h.request('POST', '/api/v2/tasks', { body: {} })).status, 400);
  assert.equal((await h.request('POST', '/api/v2/tasks', { body: { prompt: '   ' } })).status, 400);
  const outside = await h.request('POST', '/api/v2/tasks', { body: { prompt: 'x', workspace: 'D:\\Windows' } });
  assert.equal(outside.status, 403);
  assert.equal(outside.json.error.code, 'workspace_outside');

  // 没有可用启动器 → 503 unavailable（关掉自动探测，否则会探测到本机真实的 dsh.cmd）
  const h2 = await startV2(t, {
    mutate: (cfg) => {
      cfg.dsh.autoDetectLauncher = false;
      cfg.dsh.electronPath = null;
      cfg.dsh.cliPath = null;
      cfg.dsh.launcher = null;
    },
  });
  // 本用例的意图是"探测不到启动器"（launcher probe），所以要钉 `sdkAvailable`；
  // 只看 `available` 会把桌面端通道的状态混进来（本装置里 desktop 显式注入 null）。
  assert.equal(h2.gw.runner.sdkAvailable, false, '关闭自动探测后不应找到启动器');
  assert.equal(h2.gw.runner.desktopAvailable, false, 'desktop: null → 桌面端通道不参与 available 判定');
  assert.equal(h2.gw.runner.available, false, '两条通道都不可用 → available 为假');
  const unavailable = await h2.request('POST', '/api/v2/tasks', { body: { prompt: 'x' } });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.error.code, 'unavailable');
});

test('v2：重启后旧手机会话不可续（SDK 协议限制）→ 409 且 writable=false', async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'dshr-v2r-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // 手工在 phone 根下放一个"上一进程遗留"的会话（没有活运行时）
  const seeded = await seedSession(root, { id: 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  const phoneHome = path.join(root, 'sdk-home');
  const slug = encodeWorkspaceSlug(seeded.workspace);
  await fs.mkdir(path.join(phoneHome, 'sessions', slug, seeded.id), { recursive: true });
  await fs.copyFile(seeded.file, path.join(phoneHome, 'sessions', slug, seeded.id, 'session.v4.jsonl.zstd'));

  const h = await startV2(t, { overrides: { dsh: { sessionsHome: phoneHome } }, seed: { id: seeded.id } });
  const detail = await h.request('GET', `/api/v2/sessions/${seeded.id}`);
  assert.equal(detail.json.source, 'phone', 'phone 根优先于 computer 根');
  assert.equal(detail.json.writable, false);
  assert.equal(detail.json.writableReason, 'runtime_gone');

  const res = await h.request('POST', `/api/v2/sessions/${seeded.id}/turns`, { body: { prompt: '继续' } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'session_busy');
  assert.match(res.json.error.message, /无法接管|无法再续/);
});

test('v2：abort 中止轮次（SDK 无 cancel → 杀进程，标记不可再续）', async (t) => {
  const h = await startV2(t, { env: { FAKE_SDK_SLOW_MS: '5000' } });
  const task = await h.request('POST', '/api/v2/tasks', { body: { prompt: '很慢的任务' } });
  assert.equal(task.status, 202);
  const id = task.json.sessionId;
  await waitFor(() => h.gw.runner.isRunning(id), { timeoutMs: 5000, message: '轮次未开始' });

  const abort = await h.request('POST', `/api/v2/sessions/${id}/abort`);
  assert.equal(abort.status, 200);
  assert.equal(abort.json.ok, true);
  assert.equal(abort.json.resumable, false, '必须如实告诉手机该会话不可再续');
  assert.ok(abort.json.turnId.startsWith('turn_'));
  await waitFor(() => !h.gw.runner.isRunning(id), { timeoutMs: 5000, message: '中止后占用未释放' });
  assert.equal(h.gw.live.isTaken(id), false, '占用表必须释放');

  // 没有在跑的轮次时 abort → 404
  const again = await h.request('POST', `/api/v2/sessions/${id}/abort`);
  assert.equal(again.status, 404);
});

// ---------------------------------------------------------------- SSE 语义
test('v2：SSE 心跳、Last-Event-ID 续传、会话过滤、断开后无泄漏', async (t) => {
  const h = await startV2(t);
  // 心跳（配置压到 40ms）
  const beats = await collectSse(h.baseUrl, h.token, { until: (evs) => evs.filter((e) => e.event === 'heartbeat').length >= 2, timeoutMs: 4000 });
  assert.ok(beats.filter((e) => e.event === 'heartbeat').length >= 2, 'SSE 必须按 sessionStream.heartbeatMs 发心跳');

  // 由总线推一条后，用 Last-Event-ID 续传：只应拿到之后的事件
  h.gw.sessionStream.emit('session.updated', { sessionId: h.seeded.id, source: 'computer', updatedAt: 1 }, { sessionId: h.seeded.id });
  h.gw.sessionStream.emit('session.updated', { sessionId: h.seeded.id, source: 'computer', updatedAt: 2 }, { sessionId: h.seeded.id });
  const first = await collectSse(h.baseUrl, h.token, { until: (evs) => evs.filter((e) => e.event === 'session.updated').length >= 2, timeoutMs: 4000 });
  const lastId = first.filter((e) => e.event === 'session.updated').at(-1).id;
  h.gw.sessionStream.emit('session.updated', { sessionId: h.seeded.id, source: 'computer', updatedAt: 3 }, { sessionId: h.seeded.id });
  const resumed = await collectSse(h.baseUrl, h.token, { sessionId: h.seeded.id, fromSeq: lastId, until: (evs) => evs.some((e) => e.event === 'session.updated' && e.data.updatedAt === 3), timeoutMs: 4000 });
  const resumedUpdates = resumed.filter((e) => e.event === 'session.updated');
  assert.equal(resumedUpdates.length, 1, `续传不应重放已确认的事件（实际拿到 ${resumedUpdates.length} 条）`);
  assert.ok(resumedUpdates[0].id > lastId, 'id 必须严格大于 Last-Event-ID');

  // 断开后台账清零（不泄漏定时器/订阅）
  await waitFor(() => h.gw.stats().sessionSseClients === 0, { timeoutMs: 4000, message: 'SSE 断开后客户端未清理' });
  assert.equal(h.gw.stats().sessionStreamSubscribers, 0, 'SSE 断开后订阅未退订');
  assert.equal(h.gw.stats().sseHeartbeats, 0, 'SSE 断开后心跳定时器未清理');
});

test('v2：SSE 连接数上限 → 429 busy', async (t) => {
  const h = await startV2(t, { overrides: { sessionStream: { maxClients: 1, heartbeatMs: 1000 } } });
  const ac = new AbortController();
  const held = fetch(new URL('/api/v2/sessions/stream', h.baseUrl), { headers: { Authorization: `Bearer ${h.token}` }, signal: ac.signal }).catch(() => {});
  await waitFor(() => h.gw.stats().sessionSseClients === 1, { timeoutMs: 4000, message: '首个 SSE 未建立' });
  const second = await h.request('GET', '/api/v2/sessions/stream');
  assert.equal(second.status, 429);
  assert.equal(second.json.error.code, 'busy');
  ac.abort();
  await held;
  await waitFor(() => h.gw.stats().sessionSseClients === 0, { timeoutMs: 4000 });
});

// ---------------------------------------------------------------- 安全：路径规范化 + 隧道标记
/**
 * 用**裸 socket** 发请求：`fetch`/`http.request` 都会在客户端就把 `/x/../y` 规范化掉，
 * 用它们测"路径绕过"等于什么都没测 —— 必须把字面路径原样写进请求行。
 */
async function rawRequest(port, requestLine, headers = {}) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    let buf = '';
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [`${requestLine} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', (c) => {
      buf += c.toString('utf8');
    });
    socket.on('close', () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0);
      resolve({ status, text: buf });
    });
    socket.on('error', () => resolve({ status: 0, text: buf }));
  });
}

test('安全：路径规范化绕过全部被拒（4 种写法不得命中管理路由）', async (t) => {
  const h = await startV2(t);
  const bypasses = [
    ['`/x/../`', 'GET /x/../api/v2/relay/status'],
    ['`/%2e%2e/`', 'GET /%2e%2e/api/v2/relay/status'],
    ['`/./`', 'GET /api/v2/relay/./status'],
    ['`//`（协议相对）', 'GET //api/v2/relay/status'],
    ['`/x/../pair/open`', 'POST /x/../api/v2/pair/open'],
  ];
  for (const [label, line] of bypasses) {
    const res = await rawRequest(h.port, line);
    assert.equal(res.status, 400, `${label} 必须 400（实际 ${res.status}）`);
    // 只检查"管理端点的真实载荷字段"是否泄露（错误体自己也有 "code"，不能用它判定）
    assert.ok(
      !/"relayName"|"homeId"|"reconnects"|"tunnelUrl"|"deviceToken"/.test(res.text),
      `${label} 不得泄露管理端点内容（响应：${res.text.slice(0, 160)}）`,
    );
  }
  // 基线：规范化路径本身仍正常（不能把功能一起关掉）
  const baseline = await rawRequest(h.port, 'GET /api/v2/relay/status');
  assert.equal(baseline.status, 200, '规范化路径必须照常可用');
});

test('安全：隧道标记头让管理端点拒绝，且伪造标记不获得任何特权', async (t) => {
  const h = await startV2(t);
  // 1) 带隧道标记 → 管理端点 403（与来源 IP 无关：这里就是本机回环直连）
  const statuses = [
    ['GET /api/v2/relay/status', { 'x-dsh-tunnel': '1' }],
    ['GET /api/v2/relay/status', { 'x-dsh-tunnel': '0' }], // 值为 0 也算"经隧道"，防止用 0 伪装直连
    ['POST /api/v2/relay/disconnect', { 'x-dsh-tunnel': '1' }],
    ['POST /api/v2/relay/connect', { 'x-dsh-tunnel': '1' }],
    ['POST /api/v2/pair/open', { 'x-dsh-tunnel': '1' }],
    ['POST /api/v1/pair/open', { 'x-dsh-tunnel': '1' }],
  ];
  for (const [line, headers] of statuses) {
    const res = await rawRequest(h.port, line, headers);
    assert.equal(res.status, 403, `${line} 带标记时必须 403（实际 ${res.status}）`);
    assert.match(res.text, /forbidden/);
  }
  // 2) 不带标记的本机直连仍可用（v1 行为不变）
  assert.equal((await rawRequest(h.port, 'GET /api/v2/relay/status')).status, 200);
  assert.equal((await h.request('GET', '/api/v2/relay/status')).status, 200);

  // 3) 伪造标记不影响业务端点（只是"被当成隧道来的"，业务照常）
  const sessions = await h.request('GET', '/api/v2/sessions', { headers: { 'x-dsh-tunnel': '1' } });
  assert.equal(sessions.status, 200, '业务端点不受标记影响');
  // 4) 伪造标记也不能让需要鉴权的端点免鉴权
  const noAuth = await h.request('GET', '/api/v2/sessions', { token: null, headers: { 'x-dsh-tunnel': '1' } });
  assert.equal(noAuth.status, 401, '标记不提供任何鉴权豁免');
});

// ---------------------------------------------------------------- 工作区
test('v2：工作区 files/file/changes/diff/search 与负向路径安全', async (t) => {
  const h = await startV2(t);
  const ws = encodeURIComponent(h.extraWs);

  const files = await h.request('GET', `/api/v2/workspaces/files?workspace=${ws}&depth=2`);
  assert.equal(files.status, 200);
  const names = files.json.entries.map((e) => e.relative);
  assert.ok(names.includes('note.txt'));
  assert.ok(names.includes('nested/deep.txt'), 'depth=2 必须递归到子目录');
  assert.equal(files.json.entries.find((e) => e.name === 'nested').type, 'dir');
  assert.equal(files.json.truncated, false);

  const file = await h.request('GET', `/api/v2/workspaces/file?workspace=${ws}&path=note.txt`);
  assert.equal(file.status, 200);
  assert.equal(file.json.text, '你好，这是文本内容\n', '中文原样');
  assert.equal(file.json.binary, false);
  assert.equal(file.json.lines, 2);
  assert.equal(file.json.mime, 'text/plain');

  const missing = await h.request('GET', `/api/v2/workspaces/file?workspace=${ws}&path=nope.bin`);
  assert.equal(missing.status, 404, '不存在的文件 → 404');

  const changes = await h.request('GET', `/api/v2/workspaces/changes?workspace=${ws}`);
  assert.equal(changes.status, 200);
  assert.equal(changes.json.vcs, 'none', '非 git 目录必须降级而不是报错');
  assert.deepEqual(changes.json.changed, []);
  assert.equal(changes.json.clean, null);

  const search = await h.request('GET', `/api/v2/workspaces/search?workspace=${ws}&q=needle`);
  assert.equal(search.status, 200);
  assert.equal(search.json.matches.length, 1);
  assert.equal(search.json.matches[0].type, 'content');
  assert.equal(search.json.matches[0].line, 1);
  assert.equal((await h.request('GET', `/api/v2/workspaces/search?workspace=${ws}`)).status, 400, '缺少 q → 400');

  const workspaces = await h.request('GET', '/api/v2/workspaces');
  assert.equal(workspaces.status, 200);
  assert.ok(Array.isArray(workspaces.json.workspaces));
  assert.ok(workspaces.json.workspaces.every((w) => 'vcs' in w));
  assert.equal(workspaces.json.mirrors.length, 2);

  // ---- 负向：必须 403 workspace_outside（回归：WorkspaceError 曾被误报 500）----
  const negatives = [
    ['.. 穿越', `/api/v2/workspaces/file?workspace=${ws}&path=${encodeURIComponent('..\\..\\..\\Windows\\win.ini')}`],
    ['工作区外绝对路径', `/api/v2/workspaces/file?workspace=${ws}&path=${encodeURIComponent('D:\\Windows\\win.ini')}`],
    ['UNC', `/api/v2/workspaces/file?workspace=${ws}&path=${encodeURIComponent('\\\\localhost\\c$\\Windows\\win.ini')}`],
    ['NTFS ADS', `/api/v2/workspaces/file?workspace=${ws}&path=${encodeURIComponent('note.txt:secret')}`],
    ['files 越界', `/api/v2/workspaces/files?workspace=${ws}&path=${encodeURIComponent('..\\..')}`],
    ['search 越界', `/api/v2/workspaces/search?workspace=${ws}&q=x&path=${encodeURIComponent('..\\..')}`],
    ['changes 越界', `/api/v2/workspaces/changes?workspace=${ws}&path=${encodeURIComponent('..\\..')}`],
    ['diff 越界', `/api/v2/workspaces/diff?workspace=${ws}&file=${encodeURIComponent('..\\..\\win.ini')}`],
  ];
  for (const [name, url] of negatives) {
    const res = await h.request('GET', url);
    assert.equal(res.status, 403, `${name} 必须 403（实际 ${res.status} ${res.text.slice(0, 120)}）`);
    assert.equal(res.json.error.code, 'workspace_outside', `${name} 的 code 必须是 workspace_outside`);
  }
  // workspace 本身不在白名单
  const outsideWs = await h.request('GET', `/api/v2/workspaces/files?workspace=${encodeURIComponent('D:\\Windows')}`);
  assert.equal(outsideWs.status, 403);
  assert.equal(outsideWs.json.error.code, 'workspace_outside');
  // depth 超上限
  assert.equal((await h.request('GET', `/api/v2/workspaces/files?workspace=${ws}&depth=99`)).status, 400);
  // 缺少 path
  assert.equal((await h.request('GET', `/api/v2/workspaces/file?workspace=${ws}`)).status, 400);
  assert.equal((await h.request('GET', `/api/v2/workspaces/diff?workspace=${ws}`)).status, 400);
});

test('v2：git 仓库的 changes/diff（真 git status/numstat）', async (t) => {
  const { runCommand } = await import('../lib/workspace-git.mjs');
  const probe = await runCommand('git', ['--version'], { cwd: process.cwd() });
  if (probe.code !== 0) {
    t.skip('本机没有 git，跳过');
    return;
  }
  const h = await startV2(t, { seedRepo: true });
  const repo = h.repoDir;
  const ws = encodeURIComponent(repo);

  const changes = await h.request('GET', `/api/v2/workspaces/changes?workspace=${ws}`);
  assert.equal(changes.status, 200, changes.text.slice(0, 200));
  assert.equal(changes.json.vcs, 'git', '必须识别为 git 仓库');
  assert.equal(changes.json.branch, 'master', '分支名（git init 默认 master）');
  assert.equal(changes.json.clean, false);
  const tracked = changes.json.changed.find((c) => c.path === 'tracked.txt');
  assert.ok(tracked, `changed 必须含 tracked.txt（实际 ${JSON.stringify(changes.json.changed)}）`);
  assert.equal(tracked.status, 'M');
  assert.equal(tracked.staged, false);
  assert.equal(tracked.insertions, 1, 'numstat 必须给出增行数');
  assert.equal(tracked.deletions, 0);
  assert.deepEqual(changes.json.untracked, ['untracked.txt']);

  const diff = await h.request('GET', `/api/v2/workspaces/diff?workspace=${ws}&file=tracked.txt`);
  assert.equal(diff.status, 200);
  assert.equal(diff.json.vcs, 'git');
  assert.equal(diff.json.status, 'M');
  assert.match(diff.json.diff, /\+three/, 'diff 必须含新增行');
  assert.match(diff.json.diff, /@@/, '必须是 unified diff');

  // 未跟踪文件的"全新增"diff
  const newDiff = await h.request('GET', `/api/v2/workspaces/diff?workspace=${ws}&file=untracked.txt`);
  assert.equal(newDiff.status, 200);
  assert.equal(newDiff.json.status, '??');
  assert.match(newDiff.json.diff, /\+new/, '未跟踪文件必须生成全新增 diff');

  // 非 git 子目录必须降级
  const plain = await h.request('GET', `/api/v2/workspaces/changes?workspace=${encodeURIComponent(h.extraWs)}`);
  assert.equal(plain.json.vcs, 'none');
});

test('v2：tasks 的 access 决定 SDK 子进程权限档，且续聊不重开进程也不降档', async (t) => {
  // 记录 SDK 子进程环境（权限档唯一可观测形态；DSH 没有权限命令行参数）
  const envFile = path.join(os.tmpdir(), `dshr-sdk-env-${process.pid}-${Date.now()}.jsonl`);
  const h = await startV2(t, { env: { FAKE_SDK_ENV_FILE: envFile } });
  const readRecords = async () => {
    const text = await fs.readFile(envFile, 'utf8').catch(() => '');
    return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  };

  // 能力宣告：手机据此决定是否显示权限档选择器
  const health = await h.request('GET', '/api/v2/health');
  assert.ok(health.json.capabilities.includes('task.access'), 'v2 能力表必须含 task.access');

  // 1) 缺省 → 仅当前工作区
  const byDefault = await h.request('POST', '/api/v2/tasks', { body: { prompt: '默认档' } });
  assert.equal(byDefault.status, 202);
  assert.equal(byDefault.json.access, 'workspace', '202 必须回显生效的权限档');
  assert.equal(byDefault.json.source, 'phone');
  await waitFor(async () => (await readRecords()).length >= 1, { timeoutMs: 8000, message: '未观察到 SDK 子进程启动' });

  // 2) access=full → 全部权限
  const full = await h.request('POST', '/api/v2/tasks', { body: { prompt: '全权限', access: 'full' } });
  assert.equal(full.status, 202);
  assert.equal(full.json.access, 'full');
  await waitFor(async () => (await readRecords()).length >= 2, { timeoutMs: 8000, message: '第二个 SDK 子进程未启动' });
  const records = await readRecords();
  assert.equal(records[0].permissionMode, 'workspace-write', '缺省任务只能是 workspace-write');
  assert.equal(records[1].permissionMode, 'danger-full-access', 'access=full 必须真正下发 danger-full-access');
  assert.ok(records[0].dshHome && records[0].dshHome === records[1].dshHome, '两个运行时都必须在网关自有 DSH_HOME 里');

  // 3) 续聊不带 access：沿用会话已定的档位，既不重开进程也不降档
  await waitFor(() => !h.gw.runner.isRunning(full.json.sessionId), { timeoutMs: 10_000, message: '首轮未结束' });
  const turn = await h.request('POST', `/api/v2/sessions/${full.json.sessionId}/turns`, { body: { prompt: '继续' } });
  assert.equal(turn.status, 202, `续聊应被接受：${turn.text.slice(0, 120)}`);
  await waitFor(() => !h.gw.runner.isRunning(full.json.sessionId), { timeoutMs: 10_000, message: '续聊未结束' });
  const after = await readRecords();
  assert.equal(after.length, records.length, '续聊必须复用同一个 SDK 运行时进程，不得重启');
  assert.equal(after[1].permissionMode, 'danger-full-access', '续聊不得把全部权限会话降档');

  // 4) 非法取值 → 400，且不产生新的子进程
  const bad = await h.request('POST', '/api/v2/tasks', { body: { prompt: 'x', access: 'yolo' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'bad_request');
  assert.match(bad.json.error.message, /access 只能是/);
  assert.equal((await readRecords()).length, after.length, '被拒的请求不得启动子进程');
});
