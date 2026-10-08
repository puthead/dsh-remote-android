/**
 * SSE 事件流测试（契约 §4）：全量回放、fromSeq/Last-Event-ID 断点续传、
 * 按 taskId 过滤、15s 心跳（测试用 60ms）、delta 拼接等于 output、
 * 断开后定时器/订阅立即清理、连接数上限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scripted, startHarness, waitFor, waitForTask } from './helpers.mjs';

/**
 * 极简 SSE 客户端（零依赖）：解析 id/event/data 与注释行。
 * @returns {{state: object, ready: Promise<Response>, close: () => void}}
 */
function openSse(baseUrl, pathname, { token = null, headers = {} } = {}) {
  const controller = new AbortController();
  const state = { events: [], comments: [], closed: false, error: null, status: 0, contentType: null };
  const ready = (async () => {
    const res = await fetch(new URL(pathname, baseUrl), {
      headers: {
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      signal: controller.signal,
    });
    state.status = res.status;
    state.contentType = res.headers.get('content-type');
    if (res.status !== 200) {
      state.body = await res.text();
      state.closed = true;
      return res;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            parseBlock(buffer.slice(0, index), state);
            buffer = buffer.slice(index + 2);
          }
        }
      } catch (err) {
        state.error = err;
      }
      state.closed = true;
    })();
    return res;
  })();
  return { state, ready, close: () => controller.abort() };
}

/** 解析一个 SSE 帧：注释行与字段行分开处理。 */
function parseBlock(block, state) {
  if (!block) return;
  const lines = block.split('\n');
  const dataLines = [];
  let id = null;
  let event = null;
  let commentOnly = true;
  for (const line of lines) {
    if (line.startsWith(':')) {
      state.comments.push(line);
      continue;
    }
    commentOnly = false;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = (colon === -1 ? '' : line.slice(colon + 1)).replace(/^ /, '');
    if (field === 'id') id = Number(value);
    else if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (commentOnly || (event === null && dataLines.length === 0)) return;
  state.events.push({ id, event, data: dataLines.length > 0 ? JSON.parse(dataLines.join('\n')) : null });
}

test('SSE：连接成功、按 taskId 回放完整事件序列、data 为单行 JSON', async (t) => {
  const h = await startHarness(t);
  const created = await h.request('POST', '/api/v1/tasks', { body: { prompt: scripted({ mode: 'echo', text: '流式输出内容', chunks: 3, delayMs: 15 }), workspace: h.workspace } });
  const taskId = created.json.id;
  await waitForTask(h, taskId);

  const sse = openSse(h.baseUrl, `/api/v1/events?taskId=${taskId}&fromSeq=0`, { token: h.token });
  await sse.ready;
  assert.equal(sse.state.status, 200);
  assert.match(sse.state.contentType, /text\/event-stream/);

  const finish = await waitFor(() => sse.state.events.find((e) => e.event === 'task.finished'), {
    message: '未收到 task.finished 事件',
  });
  assert.equal(finish.data.taskId, taskId);
  assert.equal(finish.data.type, 'task.finished');
  assert.equal(finish.data.task.status, 'succeeded');

  const types = sse.state.events.map((e) => e.event);
  assert.equal(types[0], 'task.created');
  assert.ok(types.includes('task.started'));
  assert.ok(types.includes('task.output'));
  assert.equal(types.at(-1), 'task.finished');

  // 契约 §4：id 等于 seq，data.type 等于事件名，taskId 一致
  for (const ev of sse.state.events) {
    assert.equal(ev.id, ev.data.seq, 'SSE id 必须等于 seq');
    assert.equal(ev.event, ev.data.type);
    assert.equal(ev.data.taskId, taskId);
    assert.equal(typeof ev.data.at, 'number');
  }
  // 序号严格递增且不重复
  const seqs = sse.state.events.map((e) => e.data.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length, '事件不得重复投递');

  sse.close();
});

test('SSE：task.output 的 delta 拼接严格等于任务 output（契约不变式）', async (t) => {
  const h = await startHarness(t);
  const text = '第一段\n第二段\n第三段结束';
  const created = await h.request('POST', '/api/v1/tasks', {
    body: { prompt: scripted({ mode: 'echo', text, chunks: 5, delayMs: 10 }), workspace: h.workspace },
  });
  const taskId = created.json.id;
  await waitForTask(h, taskId);

  const sse = openSse(h.baseUrl, `/api/v1/events?taskId=${taskId}&fromSeq=0`, { token: h.token });
  await sse.ready;
  await waitFor(() => sse.state.events.some((e) => e.event === 'task.finished'), { message: '未收到终态事件' });
  const joined = sse.state.events
    .filter((e) => e.event === 'task.output')
    .map((e) => e.data.delta)
    .join('');

  const detail = await h.request('GET', `/api/v1/tasks/${taskId}`);
  assert.equal(detail.json.output, text);
  assert.equal(joined, detail.json.output, '客户端按 seq 拼接 delta 必须得到完全一致的 output');
  sse.close();
});

test('SSE：fromSeq 断点续传只补发缺失事件', async (t) => {
  const h = await startHarness(t);

  const first = await h.request('POST', '/api/v1/tasks', { body: { prompt: scripted({ mode: 'echo', text: 'A', chunks: 1 }), workspace: h.workspace } });
  await waitForTask(h, first.json.id);

  // 第一次连接：拿到 A 的全部事件后立刻断开（模拟手机切后台/断网）
  const session1 = openSse(h.baseUrl, '/api/v1/events?fromSeq=0', { token: h.token });
  await session1.ready;
  await waitFor(() => session1.state.events.some((e) => e.event === 'task.finished' && e.data.taskId === first.json.id), {
    message: '第一段会话未收到 A 的终态',
  });
  const lastSeq = Math.max(...session1.state.events.map((e) => e.data.seq));
  session1.close();
  await waitFor(() => h.gateway.stats().sseClients === 0, { message: '断开后 SSE 会话未清理' });

  // 断线期间产生新任务
  const second = await h.request('POST', '/api/v1/tasks', { body: { prompt: scripted({ mode: 'echo', text: 'B', chunks: 1 }), workspace: h.workspace } });
  await waitForTask(h, second.json.id);

  // 重连并带 fromSeq：必须从 lastSeq+1 开始，既不重复也不缺号
  const session2 = openSse(h.baseUrl, `/api/v1/events?fromSeq=${lastSeq}`, { token: h.token });
  await session2.ready;
  await waitFor(() => session2.state.events.some((e) => e.event === 'task.finished' && e.data.taskId === second.json.id), {
    message: '续传会话未收到 B 的终态',
  });
  const seqs = session2.state.events.map((e) => e.data.seq);
  assert.equal(seqs[0], lastSeq + 1, '续传必须从断点之后的第一条开始');
  assert.deepEqual(
    seqs,
    seqs.map((_, i) => lastSeq + 1 + i),
    '补发的事件必须连续无缺号',
  );
  const types = session2.state.events.map((e) => e.event);
  assert.ok(types.includes('task.created'));
  assert.ok(types.includes('task.finished'));
  session2.close();
});

test('SSE：Last-Event-ID 请求头等价于 fromSeq 参数', async (t) => {
  const h = await startHarness(t);
  const created = await h.request('POST', '/api/v1/tasks', { body: { prompt: scripted({ mode: 'echo', text: 'C', chunks: 1 }), workspace: h.workspace } });
  await waitForTask(h, created.json.id);

  const all = openSse(h.baseUrl, '/api/v1/events?fromSeq=0', { token: h.token });
  await all.ready;
  await waitFor(() => all.state.events.some((e) => e.event === 'task.finished'), { message: '未收到终态' });
  const lastSeq = Math.max(...all.state.events.map((e) => e.data.seq));
  all.close();
  await waitFor(() => h.gateway.stats().sseClients === 0);

  // 断线期间产生新事件；重连时用 Last-Event-ID 头而不是 query 参数
  const later = await h.request('POST', '/api/v1/tasks', { body: { prompt: scripted({ mode: 'echo', text: 'D', chunks: 1 }), workspace: h.workspace } });
  await waitForTask(h, later.json.id);

  const resumed = openSse(h.baseUrl, '/api/v1/events', { token: h.token, headers: { 'Last-Event-ID': String(lastSeq) } });
  await resumed.ready;
  await waitFor(() => resumed.state.events.some((e) => e.event === 'task.finished' && e.data.taskId === later.json.id), {
    message: 'Last-Event-ID 未生效（未补发缺失事件）',
  });
  for (const ev of resumed.state.events) {
    assert.ok(ev.data.seq > lastSeq, `Last-Event-ID=${lastSeq} 之后不应再收到 seq=${ev.data.seq}`);
  }
  assert.equal(resumed.state.events[0].data.seq, lastSeq + 1, '补发必须从断点之后第一条开始');
  resumed.close();
});

test('SSE：心跳注释行按 heartbeatMs 周期发送，且长连接不会被请求超时打断', async (t) => {
  // requestTimeout/headersTimeout 设得比心跳更短：证明 SSE 长连接不受其影响
  const h = await startHarness(t, { limits: { requestTimeoutMs: 300, headersTimeoutMs: 200 } });
  const sse = openSse(h.baseUrl, '/api/v1/events?fromSeq=0', { token: h.token });
  await sse.ready;
  await waitFor(() => sse.state.comments.some((c) => c.includes('ping')), { message: '未收到心跳注释行' });
  const afterFirstPing = sse.state.comments.filter((c) => c.includes('ping')).length;
  await waitFor(() => sse.state.comments.filter((c) => c.includes('ping')).length > afterFirstPing, {
    timeoutMs: 2000,
    message: '心跳未持续发送（长连接可能被超时中断）',
  });
  assert.equal(sse.state.closed, false, 'SSE 长连接必须保持打开');
  sse.close();
});

test('SSE：客户端断开后立即清理定时器与订阅（无内存/句柄泄漏）', async (t) => {
  const h = await startHarness(t);
  const sse = openSse(h.baseUrl, '/api/v1/events?fromSeq=0', { token: h.token });
  await sse.ready;
  await waitFor(() => h.gateway.stats().sseClients === 1, { message: 'SSE 未被登记' });
  assert.equal(h.gateway.stats().sseHeartbeats, 1);
  assert.equal(h.gateway.stats().busSubscribers, 1);

  sse.close(); // 模拟客户端断网/切后台
  await waitFor(() => h.gateway.stats().sseClients === 0, { message: '断开后连接未清理' });
  assert.equal(h.gateway.stats().sseHeartbeats, 0, '心跳定时器必须立刻清除');
  assert.equal(h.gateway.stats().busSubscribers, 0, '事件总线订阅必须立刻退订');

  // 反复连接/断开不应累积资源
  for (let i = 0; i < 5; i++) {
    const s = openSse(h.baseUrl, '/api/v1/events?fromSeq=0', { token: h.token });
    await s.ready;
    await waitFor(() => h.gateway.stats().sseClients === 1);
    s.close();
    await waitFor(() => h.gateway.stats().sseClients === 0);
  }
  assert.equal(h.gateway.stats().sseHeartbeats, 0);
  assert.equal(h.gateway.stats().busSubscribers, 0);
});

test('SSE：连接数超过 maxSseClients 返回 429 busy，未知 taskId 返回 404', async (t) => {
  const h = await startHarness(t, { limits: { maxSseClients: 1 } });
  const first = openSse(h.baseUrl, '/api/v1/events?fromSeq=0', { token: h.token });
  await first.ready;
  assert.equal(first.state.status, 200);

  const second = openSse(h.baseUrl, '/api/v1/events?fromSeq=0', { token: h.token });
  const res = await second.ready;
  assert.equal(res.status, 429);
  assert.equal(second.state.body.includes('busy'), true, '超限必须返回 busy 错误码');

  const unknown = openSse(h.baseUrl, '/api/v1/events?taskId=task_missing&fromSeq=0', { token: h.token });
  const unknownRes = await unknown.ready;
  assert.equal(unknownRes.status, 404);

  first.close();
  await waitFor(() => h.gateway.stats().sseClients === 0);
});

test('SSE：无令牌连接被拒绝（401），不会建立长连接', async (t) => {
  const h = await startHarness(t);
  const sse = openSse(h.baseUrl, '/api/v1/events?fromSeq=0', { token: null });
  const res = await sse.ready;
  assert.equal(res.status, 401);
  assert.equal(h.gateway.stats().sseClients, 0);
});

test('网关关闭时存在 SSE 长连接也能立即完成（不会挂到 keepAliveTimeout）', async (t) => {
  const h = await startHarness(t);
  const sse = openSse(h.baseUrl, '/api/v1/events?fromSeq=0', { token: h.token });
  await sse.ready;
  const started = Date.now();
  await h.gateway.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `关闭耗时 ${elapsed}ms，不应等待 keep-alive 超时`);
  assert.equal(h.gateway.stats().sseClients, 0);
  sse.close();
});
