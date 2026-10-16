/**
 * v2 桌面端驱动通道：`source: 'computer'` 的电脑端会话由**本机桌面端 DSH runtime** 驱动。
 *
 * 隔离红线（本文件最重要的一条）：桌面端一律用 `makeDesktopStub()` 的**纯内存替身**——
 * 不 spawn、不联网、不碰 `~/.dsh`。`createGateway(config, { desktop })` 的
 * `desktop === undefined` 语义是"按 config 自造**真实** DesktopApi"，它会连
 * 127.0.0.1:19387 上用户正在跑的 Electron DSH、读用户真实凭据，甚至往用户的电脑端
 * 会话里投递轮次。所以这里每一处 `startV2` 都显式传 `desktop`（桩或 `null`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopEvent, makeDesktopStub, sleep, waitFor } from './helpers.mjs';
import { SEEDED_SESSION_ID, collectSse, startV2 } from './v2-harness.mjs';

const ID = SEEDED_SESSION_ID;

// 逐字文案（`lib/session-runner.mjs` 的 #submitDesktop / #openDesktopTurnStream）。
// 注意 `可点"中止"结束它` 用的是 ASCII 直引号 U+0022，不是中文引号。
const MSG_DESKTOP_UNAVAILABLE = '网关未接入桌面端 DSH runtime，无法驱动电脑端会话（需桌面端 DSH 正在运行，且网关能读到 ~/.dsh/.credentials.yaml）';
const MSG_BUSY_RUNNING = '该会话正在电脑端运行一轮；请等待当前轮次结束（可点"中止"结束它），或在电脑端继续。';
const MSG_BUSY_NOT_DRIVABLE = '该会话在电脑端已不可驱动（桌面端未持有它的运行时）；请在电脑端打开它后再从手机继续。';

/** 一条"桌面端 session/list 索引里有这个会话"的条目。 */
function desktopEntry(extra = {}) {
  return { sessionId: ID, running: false, agentAvailable: true, title: '构建排障', turns: 1, ...extra };
}

/** 起一个接线到桩的网关（默认：会话在桌面端索引里，没在跑、可驱动）。 */
function startWired(t, { stub = null, ...rest } = {}) {
  const desktop = stub ?? makeDesktopStub({ entries: [desktopEntry()] });
  return startV2(t, { desktop, ...rest });
}

test('v2/desktop：接线后电脑端会话可续聊（driver=desktop / writable=true），live 以桌面端为真值', async (t) => {
  const h = await startWired(t);

  const list = await h.request('GET', '/api/v2/sessions?limit=50');
  assert.equal(list.status, 200);
  const computer = list.json.sessions.find((s) => s.id === ID);
  assert.ok(computer, '电脑端会话必须出现在列表里');
  assert.equal(computer.source, 'computer');
  assert.equal(computer.driver, 'desktop', '驱动者是桌面端 runtime，不是网关');
  assert.equal(computer.writable, true, '桌面端接线后电脑端会话可续聊');
  assert.equal(computer.writableReason, null);
  assert.equal(computer.live, false, '桌面端说没在跑 → 不信文件 mtime');
  assert.equal(computer.liveReason, null);

  const detail = await h.request('GET', `/api/v2/sessions/${ID}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.source, 'computer');
  assert.equal(detail.json.driver, 'desktop');
  assert.equal(detail.json.writable, true);
  assert.equal(detail.json.resumable, true);
  assert.equal(detail.json.writableReason, null);
  assert.equal(detail.json.live, false);

  // 注入确实生效：health 里的桌面端信息来自桩（不是真实 19387 桌面端）
  const health = await h.request('GET', '/api/v2/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.sessionRunner.desktop.host, h.desktop.host);
  assert.equal(health.json.sessionRunner.desktop.port, h.desktop.port);
  assert.equal(health.json.sessionRunner.desktop.activeTurns, 0);
  assert.equal(h.desktop.calls.listSessions > 0, true, '网关应真的问过桌面端 session/list');
});

test('v2/desktop：桌面端 running=true → live=true / liveReason=desktop_running（列表与详情一致）', async (t) => {
  const h = await startWired(t, { stub: makeDesktopStub({ entries: [desktopEntry({ running: true })] }) });

  const list = await h.request('GET', '/api/v2/sessions?limit=50');
  const computer = list.json.sessions.find((s) => s.id === ID);
  assert.equal(computer.live, true);
  assert.equal(computer.liveReason, 'desktop_running');

  const detail = await h.request('GET', `/api/v2/sessions/${ID}`);
  assert.equal(detail.json.live, true);
  assert.equal(detail.json.liveReason, 'desktop_running');
});

test('v2/desktop：桌面端不可达 → 列表/详情仍 200（live 退回 mtime），续聊 → 503 desktop_unreachable', async (t) => {
  const stub = makeDesktopStub({ entries: [desktopEntry()], listError: new Error('connect ECONNREFUSED 127.0.0.1:19387') });
  const h = await startWired(t, { stub });

  const list = await h.request('GET', '/api/v2/sessions?limit=50');
  assert.equal(list.status, 200, '桌面端不可达不是错误：只读镜像仍然可用');
  const computer = list.json.sessions.find((s) => s.id === ID);
  assert.equal(computer.live, true, '退回文件 mtime 判据（刚写好的会话是 live）');
  assert.equal(computer.liveReason, 'mtime');
  assert.equal(computer.writable, true, 'writable 只取决于是否接线，不取决于当下可达性');

  assert.equal((await h.request('GET', `/api/v2/sessions/${ID}`)).status, 200);

  const res = await h.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '继续' } });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'desktop_unreachable');
  assert.equal(res.json.error.message, '无法连接电脑端 DSH runtime（connect ECONNREFUSED 127.0.0.1:19387）；请确认桌面端 DSH 正在运行');
  assert.equal(h.gw.runner.isDesktopActive(ID), false);
});

test('v2/desktop：未接线（desktop=null）→ writable=false/desktop_disabled，续聊 → 503 desktop_unavailable', async (t) => {
  const h = await startV2(t); // 默认 desktop: null —— 显式关闭桌面端通道

  const list = await h.request('GET', '/api/v2/sessions?limit=50');
  const computer = list.json.sessions.find((s) => s.id === ID);
  assert.equal(computer.driver, 'desktop', 'driver 描述"谁本该驱动它"，与是否接线无关');
  assert.equal(computer.writable, false);
  assert.equal(computer.writableReason, 'desktop_disabled');
  assert.equal(computer.live, true, '没接线 → live 仍是 mtime 判据');
  assert.equal(computer.liveReason, 'mtime');

  const detail = await h.request('GET', `/api/v2/sessions/${ID}`);
  assert.equal(detail.json.writable, false);
  assert.equal(detail.json.writableReason, 'desktop_disabled');
  assert.equal(detail.json.resumable, false);

  const res = await h.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '继续' } });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'desktop_unavailable');
  assert.equal(res.json.error.message, MSG_DESKTOP_UNAVAILABLE);

  const health = await h.request('GET', '/api/v2/health');
  assert.equal(health.json.sessionRunner.desktop, null, '未接线 → health 里没有桌面端信息');
});

test('v2/desktop：桌面端正在跑一轮 → 409 session_busy（文案逐字）', async (t) => {
  const h = await startWired(t, { stub: makeDesktopStub({ entries: [desktopEntry({ running: true })] }) });
  const res = await h.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '插队' } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'session_busy');
  assert.equal(res.json.error.message, MSG_BUSY_RUNNING);
  assert.equal(h.desktop.calls.follows.length, 0, '忙的时候绝不订阅、更不投递');
  assert.equal(h.desktop.calls.prompt.length, 0);
});

test('v2/desktop：桌面端未持有运行时（agentAvailable=false）→ 409 session_busy（文案逐字）', async (t) => {
  const h = await startWired(t, { stub: makeDesktopStub({ entries: [desktopEntry({ agentAvailable: false })] }) });
  const res = await h.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '接着干' } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'session_busy');
  assert.equal(res.json.error.message, MSG_BUSY_NOT_DRIVABLE);
  assert.equal(h.desktop.calls.prompt.length, 0);
});

test('v2/desktop：投递成功 → 202（先订阅后投递），turn.started/turn.ended 走 SSE 且 resumable=true', async (t) => {
  const stub = makeDesktopStub({ entries: [desktopEntry({ turns: 0 })], autoFrames: [desktopEvent('turn/start', { turn: 1 }, { seq: 5 })] });
  const h = await startWired(t, { stub });

  const ssePromise = collectSse(h.baseUrl, h.token, { until: (evs) => evs.some((e) => e.event === 'turn.ended') });
  await waitFor(() => h.gw.stats().sessionSseClients === 1, { message: 'SSE 未建立' });

  const res = await h.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '继续把失败用例修掉' } });
  assert.equal(res.status, 202);
  assert.equal(res.json.accepted, true);
  assert.equal(res.json.sessionId, ID);
  assert.equal(res.json.driver, 'desktop');
  assert.equal(res.json.source, 'computer');
  assert.match(res.json.turnId, /^turn_/);
  assert.equal(typeof res.json.fromSeq, 'number');
  assert.equal(res.json.messageId, 'msg-stub-1');

  // **先开流、再投递**：订阅参数按 DesktopApi 形状传下去
  assert.equal(stub.calls.follows.length, 1);
  assert.equal(stub.calls.follows[0].sessionId, ID);
  assert.equal(stub.calls.follows[0].assistantStream, true);
  assert.equal(stub.calls.follows[0].timeoutMs, 600_000);
  assert.equal(stub.calls.follows[0].hasSignal, true);
  assert.deepEqual(stub.calls.prompt, [{ sessionId: ID, text: '继续把失败用例修掉', mode: 'queue' }]);
  assert.equal(h.gw.runner.isDesktopActive(ID), true);

  stub.push(ID, desktopEvent('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '正在修' }] } }, { seq: 8 }));
  stub.push(ID, desktopEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 15 }));

  const events = await ssePromise;
  // 会有两条 `turn.started`：一条是把桌面端 `turn/start` 帧翻译后转发的（没有 turnId），
  // 一条是 `#submitDesktop` 在投递成功后自己发的权威事件（带 turnId/fromSeq）。断言后者。
  const allStarted = events.filter((e) => e.event === 'turn.started');
  assert.ok(allStarted.length >= 1, '手机端必须收到 turn.started');
  const started = allStarted.find((e) => e.data.turnId === res.json.turnId);
  assert.ok(started, `权威 turn.started 必须带 turnId=${res.json.turnId}`);
  assert.equal(started.data.source, 'computer');
  assert.equal(started.data.sessionId, ID);
  assert.equal(started.data.turn, 1);
  assert.equal(started.data.fromSeq, res.json.fromSeq);
  assert.equal(started.data.messageId, 'msg-stub-1');
  assert.equal(events.find((e) => e.event === 'message.delta').data.text, '正在修');

  const ended = events.find((e) => e.event === 'turn.ended');
  assert.equal(ended.data.reason, 'completed');
  assert.equal(ended.data.source, 'computer');
  assert.equal(ended.data.resumable, true, '桌面端驱动的轮次收束后仍可续聊');

  await waitFor(() => h.gw.runner.isDesktopActive(ID) === false, { message: '轮次未收束（占用未释放）' });
  assert.equal((await h.request('GET', `/api/v2/sessions/${ID}`)).json.writable, true);
});

// 回归钉子：`#openDesktopTurnStream` 后台 finally 末尾的 `await iterator.return?.()`。
// `#consumeDesktopStream` 刻意用手写 `iterator.next()` 循环（要拿生成器返回值里的 `{ended, error}`），
// 所以收到 `turn/end` 提前 return 时异步生成器仍挂在 `yield` 上；真实 `DesktopApi.openStream` 的
// `socket.close()` 在它自己的 `finally` 里，不显式 `return()` 就每轮泄漏一个 WebSocket —— 未 unref 的
// socket 会吊住事件循环（实测：e2e 探针打印完 PASS 后 300s 进程仍不退出）。桩的 `closed` 只反映
// "生成器真的收尾了"，所以去掉那行 return() 这条必然红。
test('v2/desktop：收到 turn/end 后订阅流被显式关闭（WS 句柄不泄漏）', async (t) => {
  const stub = makeDesktopStub({ entries: [desktopEntry({ turns: 0 })], autoFrames: [desktopEvent('turn/start', { turn: 1 }, { seq: 5 })] });
  const h = await startWired(t, { stub });

  const res = await h.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '继续' } });
  assert.equal(res.status, 202);
  assert.equal(stub.calls.follows.length, 1);
  assert.equal(stub.calls.follows[0].closed, false, '轮次进行中，订阅流还活着');
  assert.equal(stub.liveFollowCount, 1);

  stub.push(ID, desktopEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 15 }));

  await waitFor(() => stub.calls.follows[0].closed === true, {
    message: '收到 turn/end 后订阅流未被关闭：异步生成器仍挂在 yield 上，真实实现会泄漏 WebSocket（iterator.return?.() 没跑到？）',
  });
  assert.equal(stub.closedFollowCount, 1);
  assert.equal(stub.liveFollowCount, 0, '关闭后不得再留在桩的活订阅集合里');
  assert.equal(h.gw.runner.isDesktopActive(ID), false, '占用也要释放（收束与关闭都要发生）');
});

test('v2/desktop：订阅/投递失败的分支都如实报错（502/503 + code 透传 + 占用释放）', async (t) => {
  // 1) openFollow 同步抛错 → 502 desktop_error
  const boom = makeDesktopStub({ entries: [desktopEntry()], followError: new Error('桩：订阅接口爆炸') });
  const h1 = await startWired(t, { stub: boom });
  const r1 = await h1.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '继续' } });
  assert.equal(r1.status, 502);
  assert.equal(r1.json.error.code, 'desktop_error');
  assert.equal(r1.json.error.message, '无法订阅桌面端会话事件流：桩：订阅接口爆炸');
  assert.equal(boom.calls.prompt.length, 0, '订阅失败绝不能把轮次投进电脑端');
  assert.equal(h1.gw.runner.isDesktopActive(ID), false, '失败后占用必须释放');

  // 2) 首个事件即终态且带错误 → code 透传；unauthorized 映射 502
  const denied = makeDesktopStub({ entries: [desktopEntry()] });
  denied.endFollow(ID, { error: { code: 'desktop_unauthorized', message: '凭据无效' } });
  const h2 = await startWired(t, { stub: denied });
  const r2 = await h2.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '继续' } });
  assert.equal(r2.status, 502);
  assert.equal(r2.json.error.code, 'desktop_unauthorized');
  assert.equal(r2.json.error.message, '无法订阅桌面端会话事件流：凭据无效');
  assert.equal(denied.calls.prompt.length, 0);

  // 3) 首个事件即结束但没有错误 → 503 desktop_error（"桌面端未返回任何事件"）
  const empty = makeDesktopStub({ entries: [desktopEntry()] });
  empty.endFollow(ID);
  const h3 = await startWired(t, { stub: empty });
  const r3 = await h3.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '继续' } });
  assert.equal(r3.status, 503);
  assert.equal(r3.json.error.code, 'desktop_error');
  assert.equal(r3.json.error.message, '无法订阅桌面端会话事件流：桌面端未返回任何事件');

  // 4) iterator.next() 抛错 → 502 desktop_error
  const broken = makeDesktopStub({ entries: [desktopEntry()], nextError: new Error('流断了') });
  const h4 = await startWired(t, { stub: broken });
  const r4 = await h4.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '继续' } });
  assert.equal(r4.status, 502);
  assert.equal(r4.json.error.code, 'desktop_error');
  assert.equal(r4.json.error.message, '订阅桌面端会话事件流失败：流断了');

  // 5) prompt 抛错 → 502 desktop_error，并且轮次已收束（不会把会话永久占住）
  const refuse = makeDesktopStub({ entries: [desktopEntry()], autoFrames: [desktopEvent('turn/start', { turn: 1 }, { seq: 1 })], promptError: new Error('电脑端拒绝投递') });
  const h5 = await startWired(t, { stub: refuse });
  const r5 = await h5.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '继续' } });
  assert.equal(r5.status, 502);
  assert.equal(r5.json.error.code, 'desktop_error');
  assert.equal(r5.json.error.message, '电脑端拒绝投递');
  assert.equal(refuse.calls.prompt.length, 1);
  assert.equal(h5.gw.runner.isDesktopActive(ID), false, '投递失败也必须收束占用');
});

test('v2/desktop：SSE 桥把桌面端帧按 source=computer 转发（独立序号空间，断开不泄漏）', async (t) => {
  const stub = makeDesktopStub({ entries: [desktopEntry()], autoFrames: [desktopEvent('turn/start', { turn: 1 }, { seq: 5 })] });
  const h = await startWired(t, { stub });

  // 手机端用 ?sessionId= 观察一个**正被电脑端使用**的会话：网关必须挂上桌面端订阅
  const ssePromise = collectSse(h.baseUrl, h.token, { sessionId: ID, until: (evs) => evs.some((e) => e.event === 'message.delta') });
  await waitFor(() => h.gw.stats().sessionSseClients === 1, { message: 'SSE 未建立' });
  await waitFor(() => stub.calls.follows.length === 1, { message: '网关没有订阅桌面端会话事件流' });
  assert.equal(stub.calls.follows[0].sessionId, ID);
  assert.equal(stub.calls.follows[0].assistantStream, true);
  assert.equal(h.gw.runner.isDesktopActive(ID), false, '这不是网关驱动的轮次，只是旁观电脑端');

  stub.push(ID, desktopEvent('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '来自电脑端' }] } }, { seq: 8 }));

  const events = await ssePromise;
  const forwarded = events.filter((e) => e.data?.source === 'computer');
  assert.equal(forwarded.length, 2, '桥接帧：turn.started + message.delta');
  assert.equal(forwarded[0].event, 'turn.started');
  assert.equal(forwarded[0].id, 1, '桥用独立序号空间，在会话总线之外从 1 开始');
  assert.equal(forwarded[0].data.sessionId, ID);
  assert.equal(forwarded[1].event, 'message.delta');
  assert.equal(forwarded[1].id, 2);
  assert.equal(forwarded[1].data.text, '来自电脑端');
  assert.equal(forwarded[1].data.role, 'assistant');
  assert.equal(forwarded[1].data.channel, 'text');
  assert.equal(forwarded[1].data.sessionId, ID);
  assert.equal(forwarded[1].data.source, 'computer');

  // 手机端断开 → 订阅必须一起收掉（否则每来一个客户端就在桌面端挂一条流）
  await waitFor(() => stub.liveFollowCount === 0, { message: 'SSE 断开后桌面端订阅未释放' });
});

test('v2/desktop：abort 走桌面端通道 → resumable=true（非破坏性，可立即再投）', async (t) => {
  const stub = makeDesktopStub({ entries: [desktopEntry()], autoFrames: [desktopEvent('turn/start', { turn: 1 }, { seq: 5 })] });
  const h = await startWired(t, { stub });

  const first = await h.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '第一轮' } });
  assert.equal(first.status, 202);
  assert.equal(h.gw.runner.isDesktopActive(ID), true);

  const abort = await h.request('POST', `/api/v2/sessions/${ID}/abort`);
  assert.equal(abort.status, 200);
  assert.deepEqual(abort.json, { ok: true, turnId: first.json.turnId, pid: null, sessionId: ID, driver: 'desktop', resumable: true });
  assert.deepEqual(stub.calls.cancel, [ID], '必须调用桌面端 session/cancel（非破坏性）');
  await waitFor(() => h.gw.runner.isDesktopActive(ID) === false, { message: '中止后占用未释放' });
  assert.equal(h.gw.live.isTaken(ID), false, '占用表必须释放');

  // 非破坏性：桌面端 runtime 还在，手机端可以立刻再投一轮
  const second = await h.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: '第二轮' } });
  assert.equal(second.status, 202);
  assert.notEqual(second.json.turnId, first.json.turnId);
  assert.deepEqual(stub.calls.prompt.map((p) => p.text), ['第一轮', '第二轮']);
  assert.equal((await h.request('GET', `/api/v2/sessions/${ID}`)).json.writable, true);

  stub.push(ID, desktopEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }, { seq: 16 }));
  await waitFor(() => h.gw.runner.isDesktopActive(ID) === false, { message: '第二轮未收束' });
});

test('v2/desktop：subagent 会话（include=all）的可见性与 driver', async (t) => {
  const h = await startV2(t, { seed: { subagent: true }, desktop: makeDesktopStub({ entries: [desktopEntry()] }) });

  const def = await h.request('GET', '/api/v2/sessions?limit=50');
  assert.equal(def.json.sessions.some((s) => s.id === h.seeded.id), false, '默认列表不含 subagent 会话');

  const all = await h.request('GET', '/api/v2/sessions?include=all&limit=50');
  const entry = all.json.sessions.find((s) => s.id === h.seeded.id);
  assert.ok(entry, 'include=all 时必须能看到 subagent 会话');
  assert.equal(entry.origin, 'subagent');
  assert.equal(entry.driver, 'desktop', '子代理会话同样由桌面端驱动');
});

// 回归钉子：subagent 的电脑端会话**不可续聊**。lib 曾经写成
// `s.writable = desktop !== null && !s.isSubagent;`（列表项没有 `isSubagent`，只有
// `origin`，见 session-reader.mjs:234/:614/:652），导致 `!undefined === true` → 错报可写。
// 现在 lib 已改为 `desktop !== null && s.origin !== 'subagent'`（列表 :918 与详情 :955-957 同口径）。
test('v2/desktop：subagent 会话不可续聊（writable=false / writableReason=subagent）', async (t) => {
  const h = await startV2(t, { seed: { subagent: true }, desktop: makeDesktopStub({ entries: [desktopEntry()] }) });

  const all = await h.request('GET', '/api/v2/sessions?include=all&limit=50');
  const entry = all.json.sessions.find((s) => s.id === h.seeded.id);
  assert.equal(entry.writable, false, '子代理会话不能被手机端续聊');
  assert.equal(entry.writableReason, 'subagent');

  // 详情端点（http.mjs:955-957）与列表同口径：接线但 origin==='subagent' → 不可写 + 原因 'subagent'，
  // 未接线才给 'desktop_disabled'。两条路径都必须一致，否则手机端列表与详情会互相打脸。
  const detail = await h.request('GET', `/api/v2/sessions/${h.seeded.id}`);
  assert.equal(detail.json.writable, false);
  assert.equal(detail.json.writableReason, 'subagent');
});

test('v2/desktop：driver 恒显式下发（phone=gateway / computer=desktop，列表与详情一致）', async (t) => {
  const h = await startV2(t); // driver 只取决于来源分派，不需要桌面端接线

  const task = await h.request('POST', '/api/v2/tasks', { body: { prompt: '手机端的活' } });
  assert.equal(task.status, 202);
  const phoneId = task.json.sessionId;
  await waitFor(() => h.gw.runner.isResumable(phoneId), { message: '手机任务运行时未就绪' });

  const list = await h.request('GET', '/api/v2/sessions?limit=50');
  const phone = list.json.sessions.find((s) => s.id === phoneId);
  assert.ok(phone, '手机任务会话必须出现在列表里');
  assert.equal(phone.source, 'phone');
  assert.equal(phone.driver, 'gateway');
  assert.equal(phone.createdBy, 'phone', '手机新建 → createdBy=phone');
  assert.equal(phone.writable, true);
  assert.equal(phone.writableReason, null);
  const computer = list.json.sessions.find((s) => s.id === h.seeded.id);
  assert.equal(computer.driver, 'desktop', '同一个列表里两种来源必须给出不同 driver');
  assert.equal(computer.createdBy, 'desktop', '电脑端 DSH 自己建的会话不是手机发起的');

  const phoneDetail = await h.request('GET', `/api/v2/sessions/${phoneId}`);
  assert.equal(phoneDetail.json.driver, 'gateway');
  assert.equal(phoneDetail.json.resumable, true);
  const computerDetail = await h.request('GET', `/api/v2/sessions/${h.seeded.id}`);
  assert.equal(computerDetail.json.driver, 'desktop');
  assert.equal(computerDetail.json.resumable, false, '未接线 → 不可续聊');
});

// 契约 §7.6：手机新建任务的通道由 `host` 选择，**缺省 = 电脑端可达就落电脑端**。
// 落电脑端时三个字段各说各的事（lib/phone-sessions.mjs 头部注释）：`createdBy` = 谁发起、
// `source` = 数据长在谁家、`driver` = 现在谁在驱动。客户端不得互相反推，所以三条都要钉住。
test('v2/desktop：手机新建任务缺省落电脑端（createWorkspace + createSession，202 三字段各说各的事）', async (t) => {
  const createdId = 'session-cccccccc-1111-4222-8333-444444444444';
  const stub = makeDesktopStub({
    createdSessionId: createdId,
    entries: [desktopEntry()],
    autoFrames: [desktopEvent('turn/start', { turn: { id: 'turn-1' }, seq: 1 })],
  });
  const h = await startWired(t, { stub });

  const res = await h.request('POST', '/api/v2/tasks', { body: { prompt: '手机派的活', workspace: h.extraWs, title: '派活' } });
  assert.equal(res.status, 202);
  assert.equal(res.json.accepted, true);
  assert.equal(res.json.sessionId, createdId);
  assert.equal(res.json.source, 'computer', '数据长在电脑端 home 里');
  assert.equal(res.json.createdBy, 'phone', '是手机发起的');
  assert.equal(res.json.driver, 'desktop', '由电脑端 runtime 驱动');
  assert.equal(res.json.host, 'desktop');
  assert.equal(res.json.workspace, h.extraWs);
  assert.match(res.json.turnId, /^turn_/);
  assert.equal(res.json.fromSeq, 0, '新会话还没有任何事件');

  // 建会话必须走 workspaceId 而不是 cwd：实测 `session/create {cwd}` 建的会话不会登记进
  // 任何工作区（http.mjs:872-875），电脑端会话列表里看不到它，也就谈不上"接手"。
  assert.deepEqual(stub.calls.createWorkspace, [h.extraWs]);
  assert.deepEqual(stub.calls.createSession, [{ cwd: null, workspaceId: 'ws-stub-1', sessionId: null, agentPreset: null }]);
  // 先订阅后投递：follow 必须在 prompt 之前建立，否则会漏掉首帧。
  assert.equal(stub.calls.follows.length, 1);
  assert.equal(stub.calls.follows[0].sessionId, createdId);
  assert.deepEqual(stub.calls.prompt, [{ sessionId: createdId, text: '手机派的活', mode: 'queue' }]);
  assert.equal(h.gw.runner.isDesktopActive(createdId), true, '首轮已交给电脑端');

  // 收束：电脑端 turn/end → 释放占用，不留悬挂的轮次记录（否则网关 close 时会卡住）。
  stub.push(createdId, desktopEvent('turn/end', { turn: { id: 'turn-1' }, reason: { kind: 'completed' }, seq: 2 }));
  await waitFor(() => h.gw.runner.isDesktopActive(createdId) === false, { message: 'turn/end 后占用未释放' });
});

test('v2/desktop：POST /api/v2/tasks 的 host 选择与降级（非法值 400 / 缺 workspace 400 / 未接线 503）', async (t) => {
  // 未接线：缺省仍落 gateway（老行为不变），只有显式 host:'desktop' 才报 503。
  const h = await startV2(t);
  const badHost = await h.request('POST', '/api/v2/tasks', { body: { prompt: 'x', host: 'yolo' } });
  assert.equal(badHost.status, 400);
  assert.equal(badHost.json.error.code, 'bad_request');
  assert.equal(badHost.json.error.message, 'host 只能是 desktop 或 gateway');

  const off = await h.request('POST', '/api/v2/tasks', { body: { prompt: 'x', host: 'desktop' } });
  assert.equal(off.status, 503);
  assert.equal(off.json.error.code, 'desktop_unavailable');
  assert.equal(off.json.error.message, '网关未接入桌面端 DSH runtime，无法在电脑端建会话；请改传 host:"gateway"，或先启动电脑端 DSH');

  // 接线：缺省落电脑端，但电脑端是**按工作区**登记会话的——没工作区就无法让它出现在电脑端列表里。
  const wired = await startWired(t);
  const noWs = await wired.request('POST', '/api/v2/tasks', { body: { prompt: 'x' } });
  assert.equal(noWs.status, 400);
  assert.equal(noWs.json.error.code, 'bad_request');
  assert.equal(noWs.json.error.message, '在电脑端新建任务必须指定 workspace（电脑端是按工作区登记会话的）');

  // 显式 host:'gateway' 是"仅在手机上执行"的语义：走 SDK 路径，落网关自有 home。
  const g = await wired.request('POST', '/api/v2/tasks', { body: { prompt: '只在手机上跑', host: 'gateway' } });
  assert.equal(g.status, 202);
  assert.equal(g.json.source, 'phone');
  assert.equal(g.json.createdBy, 'phone');
  assert.equal(g.json.driver, 'gateway');
  assert.equal(g.json.host, 'gateway');
  assert.equal(wired.desktop.calls.createWorkspace.length, 0, 'host=gateway 不该碰电脑端');
  assert.equal(wired.desktop.calls.createSession.length, 0);
});

test('v2/desktop：电脑端建会话失败 → 502 + code 透传（不吞错、不回落 500）', async (t) => {
  const stub = makeDesktopStub({ createSessionError: Object.assign(new Error('桩：建会话失败'), { code: 'desktop_error', status: 502 }) });
  const h = await startWired(t, { stub });

  const res = await h.request('POST', '/api/v2/tasks', { body: { prompt: 'x', workspace: h.extraWs } });
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, 'desktop_error');
  assert.equal(res.json.error.message, '在电脑端创建会话失败：桩：建会话失败');
  assert.equal(stub.calls.prompt.length, 0, '建会话都失败了，绝不能再去投递');
});

// 回归钉子：`http.mjs:1350` 的 `sessionStream.subscribeSession({ sessionId, fromSeq, onEvent })`。
// 旧写法 `subscribe({ fromSeq, onEvent })` 不带路由键，而事件总线的路由键**就是** sessionId
// （`session-live.mjs:191 publish(type, rest, sessionId)` → `events.mjs:38 sub.taskId !== taskId` 才跳过），
// 于是 `?sessionId=A` 的流会把**所有**会话的帧都写给这一个客户端（Lead 用真机探针
// `.runtime/gw-e2e-ssfilter.mjs` 复现过）。
// 为了不受竞态影响：B 的帧先投、A 的帧后投。若过滤失效，A 的流上第一条 message.delta 必然是 B 的，
// 所以"第一条必须是自己的"这条对投递顺序敏感，漏不掉。
test('v2/desktop：?sessionId= 的 SSE 流只收本会话事件（全局流仍全部会话都收）', async (t) => {
  // 桩必须给 autoFrames：`#openDesktopTurnStream` 会 `await iterator.next()` 等来第一条事件才返回
  // （拿它判"订阅是否真的建立"），桩一直不吐事件的话 POST /turns、POST /tasks 就一直挂着。
  const stub = makeDesktopStub({ entries: [desktopEntry()], autoFrames: [desktopEvent('turn/start', { turn: 1 }, { seq: 5 })] });
  const h = await startWired(t, { stub });

  // B：手机新建 → 缺省落电脑端（桩的 createSession 造出一个新的电脑端会话，首轮立刻在跑）
  const made = await h.request('POST', '/api/v2/tasks', { body: { host: 'desktop', workspace: h.extraWs, prompt: 'B 会话的首轮' } });
  assert.equal(made.status, 202);
  const B = made.json.sessionId;
  assert.notEqual(B, ID);
  // A：给磁盘上那个已存在的电脑端会话投一轮，让 A 也处于"在跑"状态
  const turned = await h.request('POST', `/api/v2/sessions/${ID}/turns`, { body: { prompt: 'A 会话的一轮' } });
  assert.equal(turned.status, 202);

  const firstDelta = (evs) => evs.some((e) => e.event === 'message.delta');
  const sseA = collectSse(h.baseUrl, h.token, { sessionId: ID, until: firstDelta });
  const sseB = collectSse(h.baseUrl, h.token, { sessionId: B, until: firstDelta });
  const sseAll = collectSse(h.baseUrl, h.token, { until: (evs) => evs.filter((e) => e.event === 'message.delta').length >= 2 });
  // 第 4 条也是全局流，但一收到第一条 message.delta 就返回：它钉住"先投的 B 在**未过滤**的流上必然
  // 先出现"——这正是 A 流那条断言不受竞态影响的前提（过滤失效时 A 的第一条必然也是 B 的）。
  const sseRaw = collectSse(h.baseUrl, h.token, { until: firstDelta });
  await waitFor(() => h.gw.stats().sessionSseClients === 4, { message: '四条 SSE 流未全部建立' });

  const delta = (text, seq) => desktopEvent('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }, { seq });
  h.desktop.push(B, delta('B 的正文', 9)); // B 先投：过滤失效时它会先落到 A 的流上
  h.desktop.push(ID, delta('A 的正文', 8));

  const [a, b, all, raw] = await Promise.all([sseA, sseB, sseAll, sseRaw]);

  const foreign = (evs, allowed) => evs.filter((e) => e.data?.sessionId != null && e.data.sessionId !== allowed).map((e) => `${e.event}:${e.data.sessionId}`);
  const aDeltas = a.filter((e) => e.event === 'message.delta');
  assert.ok(aDeltas.length >= 1, 'A 的流必须收到自己的帧（正对照：防止"把流滤空"也算通过）');
  assert.equal(aDeltas[0].data.text, 'A 的正文', 'A 的流第一条 message.delta 必须是 A 自己的；收到别的会话的帧 = ?sessionId= 没生效');
  assert.equal(aDeltas[0].data.sessionId, ID);
  assert.deepEqual(foreign(a, ID), [], 'A 的流一条别的会话的帧都不能有');
  assert.equal(a.every((e) => e.data?.sessionId !== B), true);

  const bDeltas = b.filter((e) => e.event === 'message.delta');
  assert.ok(bDeltas.length >= 1, 'B 的流同样要收到自己的帧');
  assert.equal(bDeltas[0].data.text, 'B 的正文');
  assert.deepEqual(foreign(b, B), [], 'B 的流一条别的会话的帧都不能有');

  // 不传 sessionId 的全局流：契约 §4.2 的主用法（手机端 ConsoleStreams 只带 fromSeq/tail），
  // 行为必须与旧版逐字一致 —— 两个会话的帧都要收到，客户端自己按 sessionId 分流。
  const allDeltas = all.filter((e) => e.event === 'message.delta');
  assert.deepEqual(allDeltas.map((e) => e.data.text).sort(), ['A 的正文', 'B 的正文']);
  assert.deepEqual([...new Set(allDeltas.map((e) => e.data.sessionId))].sort(), [ID, B].sort());

  const rawDeltas = raw.filter((e) => e.event === 'message.delta');
  assert.equal(rawDeltas[0].data.text, 'B 的正文', '未过滤的流上先到的是先投递的 B：A 流"第一条必须是自己的"才是不受竞态影响的判据');
});

/**
 * 回归钉子（真机 bug）：**电脑端 DSH 界面里自己发起**的轮次必须实时到达手机端。
 *
 * 根因：会话总线原本只由"手机经网关投递"的轮次驱动，用户在电脑端自己发起的轮次对总线
 * 完全静音 —— 手机端唯一会主动拉权威页的触发器是 `turn.ended`，它永远不来，于是
 * "答完 ask 之后对话再也不更新"（真机复现，用户截图里的「已加载 2/2 条」就是这么冻结的）。
 * `lib/desktop-watch.mjs` 负责补上这条通道。
 */
test('v2/desktop：实时中继把电脑端自己发起的轮次推进会话总线（手机端不再冻结）', async (t) => {
  // `running: true` = 桌面端说"这个会话正在跑一轮"，而网关**从未**投递过它（没有 POST /turns）。
  // `asOfSeq: 10` = 已经落盘的事件序号水位线，回放段必须被中继丢掉（历史转录手机自己会分页拉）。
  const stub = makeDesktopStub({ entries: [desktopEntry({ running: true, asOfSeq: 10, turns: 2 })] });
  const h = await startWired(t, { stub, overrides: { desktopWatch: { enabled: true, pollMs: 30 } } });

  // 手机端走的是**不带 sessionId** 的全局流（`ConsoleRepository` 的 ConsoleStreams 只带 fromSeq），
  // 所以这里也必须这样订阅：带 sessionId 会命中另一条直推路径（http.mjs 的观望型订阅），
  // 那条路径本来就通 —— 用它当判据会把"中继根本没接上"测成通过。
  // 收到 `turn.ended` 只是终态；中继紧接着还要广播 `session.updated`（手机端列表据此重排），
  // 所以等**两件**事都到齐再收流 —— 只等终态会在收尾之前就断开订阅，把后半段测丢。
  const sse = collectSse(h.baseUrl, h.token, {
    until: (evs) => evs.some((e) => e.event === 'turn.ended') && evs.some((e) => e.event === 'session.updated'),
  });
  await waitFor(() => h.gw.stats().sessionSseClients === 1, { message: 'SSE 未建立' });
  await sleep(500);
  console.error('[PROBE]', JSON.stringify((await h.request('GET', '/api/v2/health')).json.sessionRunner));
  await waitFor(() => stub.calls.follows.length === 1, { message: '中继没有订阅桌面端会话（running=true 未被发现）' });
  assert.equal(stub.calls.follows[0].sessionId, ID);
  assert.equal(stub.calls.follows[0].assistantStream, true, '中继要的是增量文本，必须开 assistantStream');
  assert.equal(h.gw.runner.isDesktopActive(ID), false, '这不是网关驱动的轮次，只是旁观电脑端');

  // 会话总线上必须先有"第 N 轮开始了"，否则手机端的直播条不会亮。
  // 这一条由**接入时**的那一刻发出（`: `#attach`）：真实场景里"发现 running"就意味着这一轮
  // 已经开始了，桌面端不会再把 `turn/start` 重发一遍（回放段又被水位线挡掉），所以这里不再
  // 补投 `turn/start` —— 补了就是"同一次开始被两条路径各说一遍"，那正是要避免的形状。
  const delta = (text, seq) => desktopEvent('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }, { seq });
  stub.push(ID, delta('电脑端正在跑', 12));
  stub.push(ID, desktopEvent('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'bash', args: {} }, { seq: 13 }));
  stub.push(ID, desktopEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }, { seq: 14 }));

  const events = await sse;
  const mine = events.filter((e) => e.data?.sessionId === ID);

  const started = mine.filter((e) => e.event === 'turn.started');
  assert.equal(started.length, 1, '中继必须发且只发一条 turn.started');
  assert.equal(started[0].data.source, 'computer');
  assert.equal(started[0].data.turn, 2);

  const deltas = mine.filter((e) => e.event === 'message.delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].data.text, '电脑端正在跑');
  assert.equal(deltas[0].data.role, 'assistant');
  // `data.seq` 必须是**DSH 事件序号**（http.mjs 把总线游标放进 `id:`，把 dshSeq 放进 data.seq）：
  // 手机端 `appliedSeq` 用它做去重闸，杂号会被静默丢弃，整条流就哑了。
  assert.equal(deltas[0].data.seq, 12);

  assert.equal(mine.filter((e) => e.event === 'tool.call').length, 1, '工具调用也要中继（手机端否则看不到正在干什么）');

  const ended = mine.filter((e) => e.event === 'turn.ended');
  assert.equal(ended.length, 1, '终态只能有一条：中继与 runner 双发会让手机端收尾跑两遍');
  assert.equal(ended[0].data.turnId, `watch-${ID.slice(-8)}`);
  assert.equal(ended[0].data.resumable, true, '电脑端会话中止后可续，与网关驱动的电脑端通道同口径');

  // 收尾善后：镜像刷新 + session.updated（手机端列表据此把这一条排到最前）。
  await waitFor(() => mine.some((e) => e.event === 'session.updated'), { message: '收尾未广播 session.updated' });
  await waitFor(() => stub.closedFollowCount >= 1, { message: '轮次结束后中继订阅未关闭（会泄漏 WebSocket）' });
});

/**
 * 同一个会话**只能有一个事件生产者**（真机上的重复文本就是这条被破坏的后果）。
 *
 * 两条路径：中继写会话总线；`?sessionId=` 的 SSE 连接由 `http.mjs` 开一条直推订阅。
 * 两边同时活着，同一个客户端会收到两份同样的 `message.delta`。
 * 这里钉住"直推先到 → 中继让开"这一半（另一半由上一个用例的 `follows.length === 1` 钉住）。
 */
test('v2/desktop：直推订阅活着时中继让开（同会话不出现两个生产者）', async (t) => {
  const stub = makeDesktopStub({ entries: [desktopEntry({ running: false, asOfSeq: 0 })] });
  const h = await startWired(t, { stub, overrides: { desktopWatch: { enabled: true, pollMs: 30 } } });

  const sse = collectSse(h.baseUrl, h.token, { sessionId: ID, until: (evs) => evs.some((e) => e.event === 'turn.ended') });
  await waitFor(() => stub.calls.follows.length === 1, { message: '?sessionId= 连接未开出直推订阅' });
  assert.equal(stub.calls.follows[0].closed, false);

  // 会话开始跑：中继会发现它，但直推还活着 → 必须让开（否则客户端收到两份）。
  stub.setRunning(ID, true);
  await sleep(200); // ≥ 6 个中继轮询周期，足够它发现并（错误地）追加一条订阅
  assert.equal(stub.calls.follows.length, 1, '直推订阅活着时中继又开了一条：同一条会话出现两个生产者');
  assert.equal(h.gw.runner.isWatchedSession(ID), false, '中继不该接管已被直推的会话');

  const delta = (text, seq) => desktopEvent('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }, { seq });
  stub.push(ID, desktopEvent('turn/start', { turn: 1 }, { seq: 1 }));
  stub.push(ID, delta('只应出现一次', 2));
  stub.push(ID, desktopEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 3 }));

  const events = await sse;
  assert.equal(events.filter((e) => e.event === 'message.delta' && e.data?.text === '只应出现一次').length, 1, '同一段文本被下发了两遍');
  assert.equal(events.filter((e) => e.event === 'turn.ended' && e.data?.sessionId === ID).length, 1);
});
