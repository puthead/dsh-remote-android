/**
 * 审批/提问桥测试（契约 §7.7）。
 *
 * 分三层，每层盯一个真实失败模式：
 * 1. **纯函数**：`buildOutcome` 的线协议形状。形状错了，桌面端只会静默地不认账
 *    （`dsh-user-approval` 把非法返回值一律归一为 `unavailable` = 拒绝），所以必须逐字节钉死；
 * 2. **桥自身**：常驻订阅、按 `eventId` 去重、`clientId` 必须取自 ready 帧、
 *    提交失败后要能自愈（`no active event stream` → 标记断开触发重连）、TTL 只做网关侧记账；
 * 3. **HTTP 集成**：真网关 + 真 HTTP，验证 `GET/POST /api/v2/approvals` 的状态码映射，
 *    以及手机是通过既有 SSE 通道得知"有东西在等我"的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  APPROVAL_EVENTS,
  APPROVAL_KINDS,
  APPROVAL_REASONS,
  ApprovalBridge,
  buildOutcome,
  normalizeQuestions,
  publicEntry,
} from '../lib/approvals.mjs';
import { DEFAULT_DESKTOP_HOME_DIRNAME, DEFAULT_DESKTOP_PORT, DesktopApi } from '../lib/desktop-api.mjs';
import { makeDesktopStub, sleep, waitFor } from './helpers.mjs';
import { collectSse, startV2 } from './v2-harness.mjs';

// ---------------------------------------------------------------- 测试用事件通道

/**
 * 一个可手动投帧的 `$events` 流。
 *
 * 刻意实现成「客户端 abort 就收尾」：真实 `openStream` 在 signal abort 时关 WebSocket、
 * 生成器随之结束 —— 桥的 `stop()` 依赖这一点（否则 `await runner` 会永远挂着）。
 */
function makeChannel() {
  const queue = [];
  let waiter = null;
  let done = false;
  const finish = () => {
    done = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ done: true });
    }
  };
  return {
    push(value) {
      if (done) return;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value, done: false });
      } else queue.push(value);
    },
    finish,
    async *iterate() {
      try {
        for (;;) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (done) return;
          const step = await new Promise((resolve) => {
            waiter = resolve;
          });
          if (step.done) return;
          yield step.value;
        }
      } finally {
        finish();
      }
    },
  };
}

/** 最小桌面端桩：只实现桥用到的两个方法，并记录调用。 */
function makeFakeDesktop({ callRawResult = { ok: true }, callRawError = null } = {}) {
  const channel = makeChannel();
  const calls = { openStream: [], callRaw: [] };
  return {
    channel,
    calls,
    openStream({ endpoint, args, signal, timeoutMs } = {}) {
      calls.openStream.push({ endpoint, args, timeoutMs, hasSignal: Boolean(signal) });
      if (signal) {
        const onAbort = () => channel.finish();
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      return channel.iterate();
    },
    async callRaw(endpoint, payload) {
      calls.callRaw.push({ endpoint, payload });
      if (callRawError) throw callRawError;
      return callRawResult;
    },
  };
}

/** 收集桥往会话总线上发的事件（不启动真网关，直接用数组接）。 */
function makeStreamSpy() {
  const events = [];
  return { events, emit: (type, payload, meta) => events.push({ type, payload, meta }) };
}

const readyFrame = (clientId = 'client-abc') => ({ type: 'ready', clientId, host: { home: 'C:\\Users\\x' } });

const requestFrame = ({ eventId = 'ev-1', sessionId = 'session-1', toolName = 'pwsh', reason = '需要跑构建' } = {}) => ({
  type: 'waterfall',
  event: 'approval/request',
  eventId,
  agentId: sessionId,
  request: { toolName, callId: 'call-9', reason },
});

const questionFrame = ({ eventId = 'ev-q1', sessionId = 'session-1' } = {}) => ({
  type: 'waterfall',
  event: 'user-questions/request',
  eventId,
  agentId: sessionId,
  request: {
    questions: [
      {
        id: 'colour',
        header: '选择',
        question: '用哪个颜色？',
        options: [{ label: '红', description: '暖' }, { label: '蓝' }],
        unknownField: 'drop-me',
      },
      { id: 'note', question: '补充说明' },
      'junk',
    ],
  },
});

/** 起一个桥 + 假桌面端，并等到 `connected`（ready 帧已被消费）。 */
async function startBridge({ callRawResult, callRawError, now, ttlMs } = {}) {
  const desktop = makeFakeDesktop({ callRawResult, callRawError });
  const stream = makeStreamSpy();
  const clock = now ? { value: now } : { value: 1_000_000 };
  const bridge = new ApprovalBridge({
    desktop,
    stream,
    now: () => clock.value,
    ttlMs,
    reconnectMs: 10,
  });
  bridge.start();
  desktop.channel.push(readyFrame());
  await waitFor(() => bridge.connected, { message: '桥未在 ready 帧后连上' });
  return { bridge, desktop, stream, clock };
}

const typesOf = (stream) => stream.events.map((e) => e.type);

// ---------------------------------------------------------------- 1. 纯函数

test('approvals：buildOutcome 把审批结论翻成线协议的 {kind:\'result\', value}', () => {
  const entry = { kind: APPROVAL_KINDS.approval };
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
    const built = buildOutcome(entry, { outcome });
    assert.deepEqual(built, { ok: true, outcome: { kind: 'result', value: outcome }, decision: outcome });
  }
  // 弃权 = 让 waterfall 继续找下一个应答者（不是"拒绝"，语义不同，不能混）
  assert.deepEqual(buildOutcome(entry, { abstain: true }), { ok: true, outcome: { kind: 'next' }, decision: null });
  // 非法值必须被拒：桌面端会把非法返回值静默归一为 unavailable（= 拒绝），手机端却以为批准了
  for (const bad of [undefined, null, '', 'allow', 'allowed', 1, {}]) {
    const built = buildOutcome(entry, { outcome: bad });
    assert.equal(built.ok, false, `非法 outcome 必须被拒：${JSON.stringify(bad)}`);
  }
  assert.equal(buildOutcome(entry, {}).ok, false);
});

test('approvals：buildOutcome 把提问答案翻成 {answers:[{id,selected,custom?}]} 并做逐项校验', () => {
  const entry = { kind: APPROVAL_KINDS.question };
  assert.deepEqual(buildOutcome(entry, { answers: [{ id: 'colour', selected: ['红'] }] }), {
    ok: true,
    outcome: { kind: 'result', value: { answers: [{ id: 'colour', selected: ['红'] }] } },
    decision: null,
  });
  // 自由文本：字段名必须是 `custom`（不是 text），且 `selected` 仍要在
  assert.deepEqual(buildOutcome(entry, { answers: [{ id: 'note', selected: [], custom: '照旧' }] }).outcome, {
    kind: 'result',
    value: { answers: [{ id: 'note', selected: [], custom: '照旧' }] },
  });
  // 只给 custom（selected 省略）→ 补成空数组，schema 仍要求 selected 存在
  assert.deepEqual(buildOutcome(entry, { answers: [{ id: 'note', custom: '照旧' }] }).outcome, {
    kind: 'result',
    value: { answers: [{ id: 'note', selected: [], custom: '照旧' }] },
  });
  // `selected: []` 是合法的"跳过这一问"（schema 允许，语义是已回答）
  assert.deepEqual(buildOutcome(entry, { answers: [{ id: 'skip', selected: [] }] }).outcome, {
    kind: 'result',
    value: { answers: [{ id: 'skip', selected: [] }] },
  });
  // 多问题一次提交
  const both = buildOutcome(entry, { answers: [{ id: 'colour', selected: ['蓝'] }, { id: 'note', custom: '好' }] });
  assert.equal(both.ok, true);
  assert.equal(both.outcome.value.answers.length, 2);
  // 未知键不得透传（桌面端是 .strict()，多一个键整批被拒）
  const extra = buildOutcome(entry, { answers: [{ id: 'colour', selected: ['红'], text: '错的字段名' }] });
  assert.deepEqual(extra.outcome.value.answers, [{ id: 'colour', selected: ['红'] }]);

  const bad = [
    undefined,
    {},
    { answers: [] },
    { answers: 'red' },
    { answers: ['red'] },
    { answers: [{ selected: ['红'] }] }, // 缺 id
    { answers: [{ id: '', selected: ['红'] }] },
    { answers: [{ id: 'colour' }] }, // 既没 selected 也没 custom
    { answers: [{ id: 'colour', selected: '红' }] }, // 裸字符串：会被工具静默拆成 ["红"]
    { answers: [{ id: 'colour', selected: { 0: '红' } }] },
  ];
  for (const answer of bad) {
    assert.equal(buildOutcome(entry, answer).ok, false, `非法答案必须被拒：${JSON.stringify(answer)}`);
  }
  // selected 里的非字符串要被丢掉（线上只接受字符串数组）
  assert.deepEqual(buildOutcome(entry, { answers: [{ id: 'x', selected: ['a', 1, null, 'b'] }] }).outcome.value.answers, [
    { id: 'x', selected: ['a', 'b'] },
  ]);
});

test('approvals：normalizeQuestions 只做形状收窄（丢未知字段、缺省补 null、过滤垃圾项）', () => {
  const questions = normalizeQuestions(questionFrame().request.questions);
  assert.equal(questions.length, 2, '字符串垃圾项必须被丢掉');
  assert.deepEqual(questions[0], {
    id: 'colour',
    header: '选择',
    question: '用哪个颜色？',
    detail: null,
    options: [{ label: '红', description: '暖' }, { label: '蓝', description: null }],
    multiSelect: false,
  });
  assert.deepEqual(questions[1], { id: 'note', header: null, question: '补充说明', detail: null, options: [], multiSelect: false });
  // `multiSelect` 为假时桌面上整个键都不出现 → 这里必须补成布尔 false，UI 不用判 undefined
  assert.equal(normalizeQuestions([{ id: 'q', question: 'x' }])[0].multiSelect, false);
  assert.equal(normalizeQuestions([{ id: 'q', question: 'x', multiSelect: true }])[0].multiSelect, true);
  // `detail` 是用户可见文案，必须原样带上（原型 README：不得悄悄删字段）
  assert.equal(normalizeQuestions([{ id: 'q', question: 'x', detail: '更长的解释' }])[0].detail, '更长的解释');
  assert.deepEqual(normalizeQuestions(undefined), []);
  assert.deepEqual(normalizeQuestions('nope'), []);
  assert.deepEqual(normalizeQuestions([null, 7]), []);
});

test('approvals：publicEntry 只下发手机端需要的 8 个字段', () => {
  const entry = {
    eventId: 'ev-1',
    sessionId: 'session-1',
    agentId: 'session-1',
    kind: 'approval',
    toolName: 'pwsh',
    callId: 'call-9',
    reason: 'r',
    questions: null,
    at: 1,
    expiresAt: 2,
    internal: 'must-not-leak',
  };
  assert.deepEqual(Object.keys(publicEntry(entry)).sort(), ['at', 'callId', 'eventId', 'expiresAt', 'kind', 'questions', 'reason', 'sessionId', 'toolName'].sort());
  assert.equal(publicEntry(entry).internal, undefined);
});

// ---------------------------------------------------------------- 2. 桥

test('approvals：ready 帧给出 clientId；waterfall 帧进未决表并发 approval.asked', async (t) => {
  const { bridge, desktop, stream } = await startBridge();
  t.after(() => bridge.stop());

  assert.equal(desktop.calls.openStream.length, 1, '只应开一条常驻订阅');
  assert.equal(desktop.calls.openStream[0].endpoint, '$events');
  // `$events` 的 args 必须是空对象（传别的会被桌面端判为 arguments-invalid）
  assert.deepEqual(desktop.calls.openStream[0].args, {});

  desktop.channel.push(requestFrame());
  await waitFor(() => bridge.list().length === 1, { message: 'waterfall 帧未进未决表' });

  const entry = bridge.list()[0];
  assert.equal(entry.eventId, 'ev-1');
  assert.equal(entry.sessionId, 'session-1', '桌面端 agentId 就是会话 id');
  assert.equal(entry.kind, 'approval');
  assert.equal(entry.toolName, 'pwsh');
  assert.equal(entry.reason, '需要跑构建');
  assert.deepEqual(typesOf(stream), [APPROVAL_EVENTS.asked]);
  assert.equal(stream.events[0].meta.sessionId, 'session-1', '事件必须带 sessionId，否则按会话订阅的手机收不到');

  // 重连后桌面端会重播未决帧 → 必须按 eventId 去重（不能出现两条卡）
  desktop.channel.push(requestFrame());
  await sleep(50);
  assert.equal(bridge.list().length, 1);
  assert.equal(stream.events.length, 1, '重播帧不得再发一次 approval.asked');
});

test('approvals：只有两条 waterfall 事件被消费（emit 帧、未知 waterfall 一律忽略）', async (t) => {
  const { bridge, desktop, stream } = await startBridge();
  t.after(() => bridge.stop());
  desktop.channel.push({ type: 'emit', event: 'api-session/status', value: {} });
  desktop.channel.push({ type: 'waterfall', event: 'plugin-manager/install', eventId: 'x', agentId: 'session-1', request: {} });
  desktop.channel.push({ type: 'waterfall', event: 'approval/request', agentId: 'session-1', request: {} }); // 缺 eventId
  await sleep(60);
  assert.equal(bridge.list().length, 0);
  assert.equal(stream.events.length, 0);
});

test('approvals：answer 用 ready 帧的 clientId 提交，成功后清空未决并广播 approval.decided', async (t) => {
  const { bridge, desktop, stream } = await startBridge();
  t.after(() => bridge.stop());
  desktop.channel.push(requestFrame());
  await waitFor(() => bridge.list().length === 1);

  const result = await bridge.answer('ev-1', { outcome: 'allowed-once' });
  assert.equal(result.ok, true);
  assert.equal(result.event.eventId, 'ev-1');
  assert.deepEqual(desktop.calls.callRaw, [
    { endpoint: '$events/result', payload: { clientId: 'client-abc', eventId: 'ev-1', outcome: { kind: 'result', value: 'allowed-once' } } },
  ]);
  assert.equal(bridge.list().length, 0, '应答后不能再出现在未决列表里');
  assert.deepEqual(typesOf(stream), [APPROVAL_EVENTS.asked, APPROVAL_EVENTS.decided]);
  const decided = stream.events[1].payload;
  assert.equal(decided.by, 'phone');
  assert.equal(decided.decision, 'allowed-once');
  assert.deepEqual(bridge.state().counters, { asked: 1, approved: 1, rejected: 0, expired: 0, answered: 1, failed: 0 });
});

test('approvals：提问答案走同一条通道，value 形状是 {answers}', async (t) => {
  const { bridge, desktop } = await startBridge();
  t.after(() => bridge.stop());
  desktop.channel.push(questionFrame());
  await waitFor(() => bridge.list().length === 1);
  assert.equal(bridge.list()[0].kind, 'question');
  assert.equal(bridge.list()[0].toolName, 'ask_user_question');
  const result = await bridge.answer('ev-q1', { answers: [{ id: 'colour', selected: ['红'] }] });
  assert.equal(result.ok, true);
  assert.deepEqual(desktop.calls.callRaw[0].payload.outcome, { kind: 'result', value: { answers: [{ id: 'colour', selected: ['红'] }] } });
});

test('approvals：未知 / 非法 / 未连接 三种失败各自给不同错误码（手机端据此决定刷新还是重试）', async (t) => {
  const { bridge, desktop } = await startBridge();
  t.after(() => bridge.stop());

  const missing = await bridge.answer('nope', { outcome: 'allowed-once' });
  assert.equal(missing.code, 'not_found');

  desktop.channel.push(requestFrame());
  await waitFor(() => bridge.list().length === 1);
  const badBody = await bridge.answer('ev-1', { outcome: 'maybe' });
  assert.equal(badBody.code, 'bad_request');
  assert.equal(desktop.calls.callRaw.length, 0, '非法答案不得打到桌面端');

  // 连接断开（模拟网关重连窗口）→ 不能假装成功
  bridge.connected = false;
  bridge.clientId = null;
  const offline = await bridge.answer('ev-1', { outcome: 'rejected' });
  assert.equal(offline.code, 'desktop_unavailable');
  assert.equal(offline.event.eventId, 'ev-1', '失败回执里要带上事件，UI 才能继续显示那张卡');
  assert.equal(bridge.list().length, 1, '未提交成功的请求必须留在未决表里');
});

test('approvals：桌面端报 "no active event stream" → 立即标记断开，等重连（而不是死循环重试同一条）', async (t) => {
  const { bridge, desktop, stream } = await startBridge({
    callRawResult: { ok: false, error: { code: 'gateway/internal', message: 'typert gateway: Remote event result identifies no active event stream' } },
  });
  t.after(() => bridge.stop());
  desktop.channel.push(requestFrame());
  await waitFor(() => bridge.list().length === 1);
  const result = await bridge.answer('ev-1', { outcome: 'rejected' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'gateway/internal');
  assert.equal(bridge.connected, false, 'clientId 已失效，必须让常驻订阅重连');
  assert.equal(bridge.clientId, null);
  assert.equal(bridge.list().length, 1, '没答上就仍是未决');
  assert.deepEqual(typesOf(stream), [APPROVAL_EVENTS.asked]);
  assert.equal(bridge.state().counters.failed, 1);
});

test('approvals：TTL 只做网关侧记账 —— 过期后不能再答，并广播 approval.expired', async (t) => {
  const { bridge, desktop, stream, clock } = await startBridge({ ttlMs: 60_000 });
  t.after(() => bridge.stop());
  desktop.channel.push(requestFrame());
  await waitFor(() => bridge.list().length === 1);
  assert.equal(bridge.list()[0].expiresAt, clock.value + 60_000);

  clock.value += 60_001;
  bridge.sweepExpired();
  assert.equal(bridge.list().length, 0);
  assert.equal(typesOf(stream).at(-1), APPROVAL_EVENTS.expired);
  assert.equal(stream.events.at(-1).payload.reason, 'expired');

  const late = await bridge.answer('ev-1', { outcome: 'allowed-once' });
  assert.equal(late.code, 'not_found', '已过期的事件已不在未决表里');
  assert.equal(desktop.calls.callRaw.length, 0);
  assert.equal(bridge.state().counters.expired, 1);
});

test('approvals：未决表有上限，超出时丢最旧的（桌面端异常时不无界增长）', async (t) => {
  const desktop = makeFakeDesktop();
  const stream = makeStreamSpy();
  const bridge = new ApprovalBridge({ desktop, stream, maxPending: 3, reconnectMs: 10 });
  bridge.start();
  desktop.channel.push(readyFrame());
  await waitFor(() => bridge.connected);
  t.after(() => bridge.stop());
  for (let i = 1; i <= 5; i++) desktop.channel.push(requestFrame({ eventId: `ev-${i}` }));
  await waitFor(() => bridge.list().length === 3, { message: '未决表未被截到上限' });
  assert.deepEqual(
    bridge.list().map((e) => e.eventId),
    ['ev-5', 'ev-4', 'ev-3'],
    '列表新→旧，且保留的是最新的三条',
  );
});

test('approvals：stop() 清空未决表并结束常驻订阅（不留下永不返回的循环）', async () => {
  const { bridge, desktop } = await startBridge();
  desktop.channel.push(requestFrame());
  await waitFor(() => bridge.list().length === 1);
  await bridge.stop();
  assert.equal(bridge.list().length, 0);
  assert.equal(bridge.connected, false);
  assert.equal(bridge.stoppable === undefined, true);
  // stop 后再投帧也不应复活
  desktop.channel.push(requestFrame({ eventId: 'ev-late' }));
  await sleep(40);
  assert.equal(bridge.list().length, 0);
});

test('approvals：桌面端通道为 null 时桥不可用且 start() 是安全空操作', async () => {
  const bridge = new ApprovalBridge({ desktop: null, stream: makeStreamSpy() });
  assert.equal(bridge.available, false);
  assert.equal(bridge.start(), false);
  assert.equal(bridge.state().connected, false);
  await bridge.stop();
});

// ---------------------------------------------------------------- 3. HTTP 集成

/** 给真网关注入一个带 `$events` 能力的桌面端桩（原有桩只实现被用到的方法）。 */
function stubWithEvents() {
  const stub = makeDesktopStub();
  const channel = makeChannel();
  const answers = [];
  stub.openStream = ({ endpoint, args, signal, timeoutMs } = {}) => {
    stub.streamCalls = (stub.streamCalls ?? 0) + 1;
    stub.streamCall = { endpoint, args, timeoutMs };
    // 真实 `openStream` 的第一帧就是 ready（clientId 由服务端给），桥的 clientId 只能来自它 ——
    // 桩若不发这一帧，"提交答案"就会因为拿不到 clientId 而永远 503。
    channel.push(readyFrame('client-http-1'));
    if (signal) {
      if (signal.aborted) channel.finish();
      else signal.addEventListener('abort', () => channel.finish(), { once: true });
    }
    return channel.iterate();
  };
  stub.callRaw = async (endpoint, payload) => {
    answers.push({ endpoint, payload });
    return { ok: true };
  };
  stub.pushFrame = (frame) => channel.push(frame);
  stub.answers = answers;
  return stub;
}

test('HTTP：GET /api/v2/approvals 需要 Bearer；未知方法 405；health 宣告能力与桥状态', async (t) => {
  const desktop = stubWithEvents();
  const h = await startV2(t, { desktop });

  const noAuth = await h.request('GET', '/api/v2/approvals', { token: null });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.json.error.code, 'unauthorized');

  const del = await h.request('DELETE', '/api/v2/approvals');
  assert.equal(del.status, 405);

  const list = await h.request('GET', '/api/v2/approvals');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.approvals, []);
  assert.equal(list.json.state.available, true);
  assert.equal(typeof list.json.state.connected, 'boolean');

  const health = await h.request('GET', '/api/v2/health', { token: null });
  assert.ok(health.json.capabilities.includes('approvals'));
  assert.ok(health.json.capabilities.includes('approvals.answer'));
  assert.equal(health.json.approvals.available, true, 'health 要暴露桥状态，手机端才知道审批能不能用');

  // `$events` 订阅确实是网关自己开的（args 必须是空对象）
  await waitFor(() => desktop.streamCall !== undefined, { message: '网关未订阅 $events' });
  assert.equal(desktop.streamCall.endpoint, '$events');
  assert.deepEqual(desktop.streamCall.args, {});
});

test('HTTP：拿不到凭据时，手机从 /api/v2/approvals 就能看到原因与下一步动作', async (t) => {
  // 手机端只认这个端点：`state.reason` / `state.hint` 必须真的走到线上，
  // 否则 App 里那条诊断条永远显示不出来（这正是"手机上看不到东西"的成因之一）。
  const desktop = makeDesktopStub();
  desktop.credentials = null;
  desktop.credentialsDiscovered = false;
  desktop.credentialsError = '凭据文件不存在：C:\\Users\\Administrator\\.dsh-remote\\.credentials.yaml';
  desktop.openStream = async function* () {
    return { ended: false, error: { code: 'desktop_unavailable', message: '桌面端凭据不可用' } };
  };
  const h = await startV2(t, { desktop });

  await waitFor(
    async () => {
      const res = await h.request('GET', '/api/v2/approvals');
      return res.json.state.reason !== null;
    },
    { message: '桥一直没把凭据问题报成 reason' },
  );
  const res = await h.request('GET', '/api/v2/approvals');
  assert.equal(res.status, 200);
  assert.equal(res.json.state.reason, 'desktop_no_credentials');
  assert.match(res.json.state.hint, /启动 DSH 桌面端/);
  assert.equal(res.json.state.credentials.ok, false);
  // 端点会经中继送到手机，本机路径一个字都不许出去
  assert.equal(res.text.includes('Administrator'), false, `响应里带了本机路径：${res.text}`);
});

test('HTTP：桌面端提问 → 手机从 SSE 看到 approval.asked → POST 答案 200 且带 event/outcome', async (t) => {
  const desktop = stubWithEvents();
  const h = await startV2(t, { desktop });

  const sse = collectSse(h.baseUrl, h.token, {
    until: (events) => events.some((e) => e.event === 'approval.asked'),
    timeoutMs: 8000,
  });
  await sleep(80); // 让 SSE 连接先建立（审批没有重放保证，订阅必须先于提问）
  desktop.pushFrame(requestFrame({ eventId: 'ev-http-1', sessionId: 'session-http-1' }));

  const events = await sse;
  const asked = events.find((e) => e.event === 'approval.asked');
  assert.ok(asked, `手机端未收到 approval.asked：${JSON.stringify(events)}`);
  assert.equal(asked.data.eventId, 'ev-http-1');
  assert.equal(asked.data.kind, 'approval');
  assert.equal(asked.data.toolName, 'pwsh');

  const list = await h.request('GET', '/api/v2/approvals?sessionId=session-http-1');
  assert.equal(list.json.approvals.length, 1);
  assert.deepEqual(list.json.approvals[0].eventId, 'ev-http-1');

  const answered = await h.request('POST', '/api/v2/approvals/ev-http-1', { body: { outcome: 'allowed-once' } });
  assert.equal(answered.status, 200);
  assert.equal(answered.json.ok, true);
  assert.equal(answered.json.event.kind, 'approval');
  assert.deepEqual(answered.json.outcome, { kind: 'result', value: 'allowed-once' });
  assert.equal(desktop.answers.length, 1);
  assert.equal(desktop.answers[0].endpoint, '$events/result');
  assert.equal(desktop.answers[0].payload.eventId, 'ev-http-1');
  assert.equal(desktop.answers[0].payload.clientId, 'client-http-1', 'clientId 必须取自 ready 帧');
  assert.deepEqual(desktop.answers[0].payload.outcome, { kind: 'result', value: 'allowed-once' });

  const after = await h.request('GET', '/api/v2/approvals');
  assert.deepEqual(after.json.approvals, [], '应答后列表必须清空');
});

test('HTTP：?sessionId= 过滤真的生效（两条未决分属两个会话）', async (t) => {
  const desktop = stubWithEvents();
  const h = await startV2(t, { desktop });

  desktop.pushFrame(requestFrame({ eventId: 'ev-a', sessionId: 'session-a' }));
  desktop.pushFrame(requestFrame({ eventId: 'ev-b', sessionId: 'session-b' }));
  await waitFor(async () => (await h.request('GET', '/api/v2/approvals')).json.approvals.length === 2, {
    message: '两条未决帧未被网关接收',
  });

  // 回归：过滤参数曾因为只读 pathname 而完全失效 —— 只有 1 条未决时看不出区别，
  // 必须用「两条分属不同会话」才能证伪。
  const onlyA = await h.request('GET', '/api/v2/approvals?sessionId=session-a');
  assert.equal(onlyA.status, 200);
  assert.deepEqual(
    onlyA.json.approvals.map((e) => e.eventId),
    ['ev-a'],
  );

  const onlyB = await h.request('GET', '/api/v2/approvals?sessionId=session-b');
  assert.deepEqual(
    onlyB.json.approvals.map((e) => e.eventId),
    ['ev-b'],
  );

  const none = await h.request('GET', '/api/v2/approvals?sessionId=session-zzz');
  assert.deepEqual(none.json.approvals, []);

  const all = await h.request('GET', '/api/v2/approvals');
  assert.equal(all.json.approvals.length, 2, '不带参数时不过滤');
});

test('HTTP：答案的错误码映射 —— 未知 404 / 非法 400 / 已过期 409', async (t) => {
  const desktop = stubWithEvents();
  const h = await startV2(t, { desktop });

  const missing = await h.request('POST', '/api/v2/approvals/never-seen', { body: { outcome: 'allowed-once' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');

  desktop.pushFrame(requestFrame({ eventId: 'ev-bad-1' }));
  await waitFor(async () => (await h.request('GET', '/api/v2/approvals')).json.approvals.length === 1, {
    message: '未决帧未被网关接收',
  });

  const bad = await h.request('POST', '/api/v2/approvals/ev-bad-1', { body: { outcome: 'maybe' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'bad_request');
  assert.equal(desktop.answers.length, 0, '非法答案不得打到桌面端');

  // 非 JSON 对象请求体也必须 400，而不是 500
  const notObject = await h.request('POST', '/api/v2/approvals/ev-bad-1', { body: [] });
  assert.equal(notObject.status, 400);
  assert.equal(notObject.json.error.code, 'bad_request');
});

// ---------------------------------------------------------------- 4. 默认可用（凭据自动发现）

/**
 * 造一个假文件系统：只有 [files] 里列出的路径存在。
 *
 * 用假 FS 而不是真建临时目录，是因为要断言的恰恰是"**哪个** home 被读到了" ——
 * 真机上两种 home 都可能存在，只有注入才能确定测的是回退那一路。
 */
function makeFakeFs(files) {
  const reads = [];
  return {
    reads,
    existsImpl: (path) => Object.hasOwn(files, path),
    readFileImpl: (path) => {
      reads.push(path);
      if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
  };
}

/** 一份形状正确的 `.credentials.yaml`（`parseBrowserSessionSecret` 只认这个形状）。 */
function credentialsYaml(secret = 'c2VjcmV0LXRleHQ') {
  return ['version: 1', 'records:', '  client-connection/browser-session:', `    secret: ${secret}`, '  other/record:', '    secret: aWdub3JlLW1l'].join('\n');
}

/** 造一个只用于凭据解析的 DesktopApi（不发请求）。 */
function makeApi({ files, dshHome, discoverHome, logger = null }) {
  const fs = makeFakeFs(files);
  const api = new DesktopApi({
    dshHome,
    discoverHome,
    homedirImpl: () => 'C:\\Users\\tester',
    existsImpl: fs.existsImpl,
    readFileImpl: fs.readFileImpl,
    logger,
    fetchImpl: null,
  });
  return { api, fs };
}

test('默认可用：显式 home 里没有 browser-session 时，回退到桌面端 home（~/.dsh）', () => {
  // 真机形态：网关 home 是自己的目录（只有 DEEPSEEK_API_KEY），
  // browser-session 在桌面端的 home 里。配置里什么都没写错，凭据就是找不到。
  const gatewayHome = 'C:\\Users\\tester\\.dsh-remote';
  const desktopHome = 'C:\\Users\\tester\\.dsh';
  const logs = [];
  const { api, fs } = makeApi({
    files: { [join(desktopHome, '.credentials.yaml')]: credentialsYaml() },
    dshHome: gatewayHome,
    logger: { info: (m) => logs.push(m) },
  });

  assert.equal(api.credentialsPath, join(gatewayHome, '.credentials.yaml'), '构造后先指向显式 home');
  assert.equal(api.loadCredentials(), true, '显式 home 拿不到凭据时必须回退，而不是直接判不可用');
  assert.equal(api.dshHome, desktopHome, '命中后 home 要改写成真实使用的那份');
  assert.equal(api.credentialsPath, join(desktopHome, '.credentials.yaml'));
  assert.equal(api.credentialsDiscovered, true);
  assert.equal(api.credentialsError, null);
  assert.equal(api.credentials.secretText, 'c2VjcmV0LXRleHQ');
  assert.deepEqual(fs.reads, [join(desktopHome, '.credentials.yaml')], '缺失的候选不该被读');
  assert.equal(logs.length, 1, '回退必须留一行日志（这是"默认即可用"的证据）');
  assert.match(logs[0], /凭据自动发现/);
  assert.ok(logs[0].includes(join(desktopHome, '.credentials.yaml')), `日志里要写明真实使用的路径：${logs[0]}`);
});

test('默认可用：两个候选都没有凭据时给出逐候选原因，而不是笼统的不可用', () => {
  const gatewayHome = 'C:\\Users\\tester\\.dsh-remote';
  const { api } = makeApi({
    // 第二个候选存在但里面是别的记录（桌面端装了但没登录过）
    files: { [join('C:\\Users\\tester\\.dsh', '.credentials.yaml')]: 'version: 1\nrecords:\n  other/record:\n    secret: eA' },
    dshHome: gatewayHome,
  });

  assert.equal(api.loadCredentials(), false);
  assert.equal(api.credentialsDiscovered, false);
  assert.equal(api.dshHome, gatewayHome, '没命中就不该改写 home');
  assert.match(api.credentialsError, /不存在/, '第一个候选：文件不存在');
  assert.match(api.credentialsError, /没有 client-connection\/browser-session 记录/, '第二个候选：形状不对');
  assert.ok(api.credentialsError.includes('；'), `多条原因要拼起来，排障时能看出试过哪些路径：${api.credentialsError}`);
  assert.throws(() => api.cookieHeader(), (err) => err.code === 'desktop_unavailable');
});

test('默认可用：凭据发现默认目标是 ~/.dsh，可用 null 关掉', () => {
  const { api: defaulted } = makeApi({ files: {}, dshHome: null, discoverHome: undefined });
  assert.equal(defaulted.configuredHome, null);
  assert.deepEqual(defaulted.credentialHomes(), [join('C:\\Users\\tester', '.dsh')], '默认 home 与发现目标重合，只留一个候选');

  const { api: explicit } = makeApi({ files: {}, dshHome: null, discoverHome: null });
  assert.deepEqual(explicit.credentialHomes(), [join('C:\\Users\\tester', '.dsh')], '关掉发现后退化为单候选');

  const { api: two } = makeApi({ files: {}, dshHome: 'D:\\gw', discoverHome: undefined });
  assert.deepEqual(two.credentialHomes(), ['D:\\gw', join('C:\\Users\\tester', DEFAULT_DESKTOP_HOME_DIRNAME)]);
  assert.equal(two.port, DEFAULT_DESKTOP_PORT, '端口缺省就是桌面端默认端口');
});

// ---------------------------------------------------------------- 5. 桥的诊断（reason / hint）

test('诊断：桌面端通道为 null → 说明是配置关掉的，不是"没连上"', () => {
  const bridge = new ApprovalBridge({ desktop: null, stream: makeStreamSpy() });
  const state = bridge.state();
  assert.equal(state.available, false);
  assert.equal(state.reason, 'desktop_disabled');
  assert.match(state.hint, /desktop\.enabled=false/);
  assert.equal(state.credentials, undefined, '通道都没构造，没有凭据可报');
});

test('诊断：事件流以返回值的形态报错时，原因必须传到 state（不能只写一句"中断"）', async () => {
  // 回归：`openStream` **不抛错**，失败在生成器的返回值里。原来用 `for await`
  // 把它吞了，于是 lastError 永远是 null，手机端只能看到"没连上"。
  const desktop = {
    openStream: async function* () {
      return { ended: false, error: { code: 'desktop_unreachable', message: '无法连接桌面端 runtime' } };
    },
  };
  const bridge = new ApprovalBridge({ desktop, stream: makeStreamSpy(), reconnectMs: 1000 });
  bridge.start();
  await waitFor(() => bridge.state().lastError !== null, { message: '返回值的错误没有被记进 lastError' });
  const state = bridge.state();
  assert.equal(state.lastError.code, 'desktop_unreachable');
  assert.match(state.lastError.message, /无法连接桌面端/);
  assert.equal(state.reason, 'desktop_unreachable');
  assert.match(state.hint, /确认 DSH 桌面端正在运行/);
  await bridge.stop();
});

test('诊断：凭据读不到时报 desktop_no_credentials，并带上不泄漏路径的凭据摘要', async () => {
  const desktop = {
    credentials: null,
    credentialsDiscovered: false,
    credentialsError: '凭据文件不存在：C:\\Users\\Administrator\\.dsh-remote\\.credentials.yaml',
    openStream: async function* () {
      return { ended: false, error: { code: 'desktop_unavailable', message: '桌面端凭据不可用' } };
    },
  };
  const bridge = new ApprovalBridge({ desktop, stream: makeStreamSpy(), reconnectMs: 1000 });
  bridge.start();
  await waitFor(() => bridge.state().lastError !== null, { message: '未记录凭据错误' });
  const state = bridge.state();
  assert.equal(state.reason, 'desktop_no_credentials');
  assert.match(state.hint, /启动 DSH 桌面端/);
  assert.equal(state.credentials.ok, false);
  assert.equal(state.credentials.discovered, false);
  assert.equal(JSON.stringify(state).includes('Administrator'), false, 'state 会经中继送到手机，不得回传本机路径');
  await bridge.stop();
});

test('诊断：连上之后 reason/hint 归 null，手机端据此显示"暂无"', async () => {
  const { bridge } = await startBridge();
  const state = bridge.state();
  assert.equal(state.connected, true);
  assert.equal(state.reason, null);
  assert.equal(state.hint, null);
  assert.equal(state.available, true);
});

test('诊断：原因码表与手机端文案是一份契约（键与取值都不许静默漂移）', () => {
  assert.deepEqual(Object.keys(APPROVAL_REASONS).sort(), [
    'bridge_crashed',
    'desktop_disconnected',
    'desktop_no_route',
    'desktop_unauthorized',
    'desktop_unavailable',
    'desktop_unreachable',
    'transport_failure',
  ]);
  assert.deepEqual(
    Object.values(APPROVAL_REASONS).map((v) => v.reason).sort(),
    [
      'bridge_crashed',
      'desktop_disconnected',
      'desktop_no_credentials',
      'desktop_unauthorized',
      'desktop_unreachable',
      'desktop_unreachable',
      'desktop_unreachable',
    ],
  );
  for (const [code, value] of Object.entries(APPROVAL_REASONS)) {
    assert.equal(typeof value.hint, 'string', `${code} 必须有给用户看的下一步动作`);
    assert.ok(value.hint.length > 0, `${code} 的 hint 不能为空`);
  }
});
