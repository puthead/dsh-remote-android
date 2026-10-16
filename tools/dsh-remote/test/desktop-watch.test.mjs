/**
 * 电脑端会话实时中继（`lib/desktop-watch.mjs`）。
 *
 * 这一层修的是一个**只在真机上才看得见**的洞：用户在电脑端 DSH 界面里自己发起的轮次
 * 不属于网关的任何一条驱动通道，手机端因此收不到 `message.delta` / `turn.ended`，
 * 详情页会一直卡在「已加载 N/M 条」。所以这里逐条钉住中继的对外可观测行为：
 *
 * 1. 水位线：`snapshot.cursor` 之前的事件**一律不重发**（否则手机端历史会翻倍）；
 * 2. 翻译：桌面端事件 → 手机端 SSE 词汇，且 `sessionId`/`source` 由中继补齐；
 * 3. 终态唯一：`turn/end` 由中继独家发一条 `turn.ended`，不出现两条（UI 收尾会跑两遍）；
 * 4. 收束：运行态消失 / 流断开 / stop() 都要回到 `onTurnEnd`，不留下悬空订阅；
 * 5. 值守范围：`shouldWatch` 说不的会话一个字节都不订阅（不许惊扰手机自己投递的轮次）。
 *
 * 装置的关键一条（照抄真实桌面端，否则测的就不是同一条路）：**`session/follow` 的首帧
 * 必须是 snapshot**，它随订阅立刻到达、不等任何后续事件。中继会阻塞在这一帧上取水位线，
 * 所以替身必须在 `openFollow()` 里就把它推出去。
 *
 * 全程纯内存：`desktop` 是本文件里的替身，不 spawn、不联网、不碰 `~/.dsh`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopTurnWatcher, pickTurn } from '../lib/desktop-watch.mjs';

/** 会话事件总线替身：只记 `emit(type, data, {sessionId})`。 */
function makeStream() {
  const events = [];
  return {
    events,
    emit(type, data, opts = {}) {
      const ev = { type, data, sessionId: opts.sessionId ?? null };
      events.push(ev);
      return ev;
    },
    ofType(type) {
      return events.filter((e) => e.type === type);
    },
  };
}

/**
 * `session/follow` 的替身订阅：异步迭代器，帧由测试逐条推。
 *
 * 复刻真实 `DesktopApi.openStream` 的三条关键语义：**首帧是 snapshot**、
 * 消费者不取就排队、以及"消费者 return / signal.abort 之后迭代器结束"
 * （否则中继停不掉，WebSocket 会漏）。
 */
function makeFollow({ signal = null } = {}) {
  const queue = [];
  let waiter = null;
  let closed = null;
  let returned = false;
  const push = (value) => {
    if (returned || closed) return;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ value, done: false });
    } else {
      queue.push(value);
    }
  };
  const iterator = {
    async next() {
      if (queue.length > 0) return { value: queue.shift(), done: false };
      if (closed !== null) return { value: closed, done: true };
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    async return(value) {
      returned = true;
      const payload = value ?? { ended: true, error: null, aborted: true };
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: payload, done: true });
      }
      closed = payload;
      return { value: payload, done: true };
    },
  };
  // 真实 DesktopApi 把 signal 接到 WebSocket 上：abort 即关流、迭代器结束。
  // 替身必须复刻这一点，否则"中继 stop() 之后到底有没有关掉订阅"就测不出来。
  signal?.addEventListener?.('abort', () => {
    returned = true;
    closed = closed ?? { ended: true, error: null, aborted: true };
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ value: closed, done: true });
    }
  });
  return {
    iterator,
    push,
    /** 结束这一路订阅，`error` 非空表示异常断开（返回值里的 error）。 */
    end({ error = null } = {}) {
      closed = { ended: true, error };
      const payload = closed;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: payload, done: true });
      }
      return payload;
    },
    get returned() {
      return returned;
    },
    get pending() {
      return queue.length;
    },
  };
}

/**
 * 桌面端替身：`listSessions()` 返回给定条目；`openFollow()` 先推 snapshot 再交给测试推后续帧。
 *
 * @param {object} [opts]
 * @param {string[]} [opts.followModes] 逐次 `openFollow` 的行为：`ok`（默认）/ `throw` / `end-error`
 * @param {number|null} [opts.autoCursor] `openFollow` 自动推的 snapshot 水位线（`null` = 不自动推）
 */
function makeDesktop(entries = [], { followModes = [], autoCursor = 120 } = {}) {
  const follows = [];
  const modes = [...followModes];
  let items = entries;
  return {
    follows,
    /** 改运行态（模拟桌面端那一轮开跑 / 跑完）。 */
    setEntries(next) {
      items = next;
    },
    async listSessions() {
      return items;
    },
    openFollow(sessionId, opts = {}) {
      const mode = modes.shift() ?? 'ok';
      if (mode === 'throw') throw new Error('桩：订阅接口爆炸');
      const follow = makeFollow({ signal: opts.signal ?? null });
      const record = { sessionId, opts, follow };
      follows.push(record);
      /** 推一帧后续事件。 */
      record.push = (value) => follow.push(value);
      /** 结束订阅（模拟桌面端那一轮结束 / 连接断开）。 */
      record.end = (opts2) => follow.end(opts2);
      if (mode === 'end-error') {
        // 连不上：订阅根本没起来，第一帧就是终态（带 error），压根没有 snapshot。
        follow.end({ error: { code: 'desktop_unreachable', message: '桩：连不上桌面端' } });
        return follow.iterator;
      }
      if (autoCursor !== null) {
        // 真实 follow 的第一帧就是 snapshot，不等任何事件。
        follow.push(snapshotFrame({ cursor: autoCursor }));
      }
      return follow.iterator;
    },
  };
}

const SESSION = 'session-3d921c21-f2bc-440e-b093-4a8b67b4463b';

/** `session/list` 里"桌面端正在跑一轮"的条目。 */
function runningEntry(extra = {}) {
  return {
    sessionId: SESSION,
    running: true,
    agentAvailable: true,
    projections: { asOfSeq: 120, values: { title: '手机端排查', sessionStats: { turns: 4 } } },
    ...extra,
  };
}

/** `session/follow` 的 snapshot 帧。 */
function snapshotFrame({ cursor = 120, turns = 4 } = {}) {
  return { type: 'snapshot', cursor, projections: { values: { sessionStats: { turns } } } };
}

/** `session/follow` 的事件帧（与 `helpers.mjs` 的 desktopEvent 同形状）。 */
function eventFrame(type, data, { seq = 0 } = {}) {
  return { type: 'event', event: { type, seq, data } };
}

/** 等一件事发生（中继是异步消费的，断言前必须等帧落地）。 */
async function waitFor(fn, { timeoutMs = 3000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = fn();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待${label}超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('中继：snapshot 水位线之前的事件不重发，之后的事件翻译成手机端词汇', async () => {
  const stream = makeStream();
  const desktop = makeDesktop([runningEntry()]);
  const watcher = new DesktopTurnWatcher({ desktop, stream, pollMs: 3600_000 });

  await watcher.attachNow(runningEntry());
  const follow = desktop.follows[0];
  // 水位线 120 → seq ≤ 120 全是回放，不该出现在手机端。
  follow.push(eventFrame('assistant/message', { text: '回放里的旧话' }, { seq: 118 }));
  follow.push(eventFrame('assistant/message', { text: '第一句新话' }, { seq: 121 }));
  follow.push(eventFrame('tool/call', { name: 'read', args: { path: 'a.mjs' }, callId: 'c1' }, { seq: 122 }));

  await waitFor(() => stream.ofType('message.delta').length === 1, { label: '新 delta 中继' });
  const deltas = stream.ofType('message.delta');
  assert.equal(deltas.length, 1, '回放段必须被水位线挡掉');
  assert.equal(deltas[0].data.text, '第一句新话');
  assert.equal(deltas[0].data.seq, 121, 'dshSeq 要带给手机端做幂等');
  assert.equal(deltas[0].data.sessionId, SESSION);
  assert.equal(deltas[0].data.source, 'computer');
  assert.equal(deltas[0].sessionId, SESSION, '总线订阅靠这个字段过滤会话');

  await waitFor(() => stream.ofType('tool.call').length === 1, { label: '工具调用中继' });
  assert.equal(stream.ofType('tool.call')[0].data.name, 'read');

  // 接入时补发的 turn.started 让手机端显示"正在执行第 N 轮"
  const started = stream.ofType('turn.started');
  assert.equal(started.length, 1);
  assert.equal(started[0].data.source, 'computer');
  assert.equal(started[0].data.turn, 4, '取大不 +1：投影里 stats.turns=4 就是"正在跑第 4 轮"（实测口径）');
  assert.equal(started[0].data.messageId, null, '中继补发的 turn.started 不是任何手机投递的消息');

  await watcher.stop();
  assert.equal(follow.follow.returned, true, 'stop() 必须关掉订阅，不能漏 WebSocket');
});

test('中继：turn/end 只发一条 turn.ended（带 resumable），并交回 onTurnEnd', async () => {
  const stream = makeStream();
  const desktop = makeDesktop([runningEntry()]);
  const ended = [];
  const watcher = new DesktopTurnWatcher({
    desktop,
    stream,
    pollMs: 3600_000,
    onTurnEnd: (sessionId, info) => ended.push({ sessionId, info }),
  });

  await watcher.attachNow(runningEntry());
  const follow = desktop.follows[0];
  follow.push(eventFrame('assistant/message', { text: '收尾这句' }, { seq: 130 }));
  follow.push(eventFrame('turn/end', { turn: 5, reason: { kind: 'completed' } }, { seq: 131 }));

  await waitFor(() => stream.ofType('turn.ended').length === 1, { label: '终态' });
  const endings = stream.ofType('turn.ended');
  assert.equal(endings.length, 1, '终态必须唯一：两条会让手机端收尾逻辑跑两遍');
  assert.equal(endings[0].data.reason, 'completed');
  assert.equal(endings[0].data.resumable, true, '桌面端取消不是破坏性的，轮次仍可续聊');
  assert.equal(endings[0].data.relayed, true);
  assert.equal(endings[0].data.source, 'computer');

  await waitFor(() => ended.length === 1, { label: 'onTurnEnd 回调' });
  assert.equal(ended[0].sessionId, SESSION);
  assert.equal(ended[0].info.reason, 'completed');
  assert.equal(watcher.activeSessions().length, 0, '收束后不留下悬空订阅');

  await watcher.stop();
});

test('中继：运行态消失（用户没等到 turn/end 就断了流）也会收束并发终态', async () => {
  const stream = makeStream();
  const desktop = makeDesktop([runningEntry()]);
  const watcher = new DesktopTurnWatcher({ desktop, stream, pollMs: 3600_000 });

  await watcher.attachNow(runningEntry());
  await waitFor(() => stream.ofType('turn.started').length === 1, { label: '接入' });

  // 下一轮发现：桌面端说这个会话不在跑了 → 中继必须收束，而不是挂着等一帧永远不来的 turn/end。
  desktop.setEntries([{ ...runningEntry(), running: false }]);
  await watcher.tick();

  await waitFor(() => stream.ofType('turn.ended').length === 1, { label: '运行态消失后的终态' });
  assert.equal(watcher.activeSessions().length, 0);
  await watcher.stop();
});

test('中继：shouldWatch 说不的会话一个字节都不订阅（手机投递的轮次由 runner 独占）', async () => {
  const stream = makeStream();
  const desktop = makeDesktop([runningEntry(), runningEntry({ sessionId: 'session-phone-owned' })]);
  const asked = [];
  const watcher = new DesktopTurnWatcher({
    desktop,
    stream,
    pollMs: 3600_000,
    shouldWatch: (sessionId) => {
      asked.push(sessionId);
      return sessionId !== 'session-phone-owned';
    },
  });

  await watcher.tick();
  assert.deepEqual(asked.sort(), ['session-3d921c21-f2bc-440e-b093-4a8b67b4463b', 'session-phone-owned'].sort());
  assert.equal(desktop.follows.length, 1, '只订阅被认可的那一个');
  assert.equal(desktop.follows[0].sessionId, SESSION);
  assert.equal(desktop.follows[0].opts.assistantStream, true, '必须带助手流，否则拿不到增量文本');

  // 同一个会话在后续轮次里不会重复订阅
  await watcher.tick();
  assert.equal(desktop.follows.length, 1);
  await watcher.stop();
});

test('中继：shouldWatch 抛异常只跳过该会话，不打断整轮发现', async () => {
  const stream = makeStream();
  const desktop = makeDesktop([runningEntry({ sessionId: 'session-boom' }), runningEntry({ sessionId: SESSION })]);
  const watcher = new DesktopTurnWatcher({
    desktop,
    stream,
    pollMs: 3600_000,
    shouldWatch: (sessionId) => {
      if (sessionId === 'session-boom') throw new Error('桩：判定爆炸');
      return true;
    },
  });

  await watcher.tick();
  assert.equal(desktop.follows.length, 1);
  assert.equal(desktop.follows[0].sessionId, SESSION, '炸掉的那个被跳过，后面的照常订阅');
  await watcher.stop();
});

test('中继：assistant-stream 帧与无关事件被丢弃（手机端没有这套词汇）', async () => {
  const stream = makeStream();
  const desktop = makeDesktop([runningEntry()]);
  const watcher = new DesktopTurnWatcher({ desktop, stream, pollMs: 3600_000 });

  await watcher.attachNow(runningEntry());
  const follow = desktop.follows[0];
  follow.push({ type: 'assistant-stream', delta: { text: '流式片段' } });
  follow.push(eventFrame('step/end', { step: 1 }, { seq: 140 }));
  follow.push(eventFrame('workspace/changed', { files: ['a'] }, { seq: 141 }));

  await waitFor(() => stream.ofType('session.updated').length === 1, { label: 'step/end 中继' });
  assert.equal(stream.ofType('message.delta').length, 0, 'assistant-stream 不是手机端词汇');
  assert.equal(stream.events.filter((e) => e.type === 'workspace.changed').length, 0, '未映射事件必须丢弃');
  await watcher.stop();
});

test('中继：订阅首帧就是终态 / 桌面端不可达 → 不占位、可重试，且不抛给调用方', async () => {
  const stream = makeStream();
  // 第一次连不上（首帧即终态带 error），第二次同步抛错，第三次正常。
  const desktop = makeDesktop([runningEntry()], { followModes: ['end-error', 'throw'] });
  const watcher = new DesktopTurnWatcher({ desktop, stream, pollMs: 3600_000 });

  await watcher.attachNow(runningEntry());
  assert.equal(watcher.activeSessions().length, 0, '拿不到首帧就不能登记为"已订阅"');
  assert.equal(watcher.stats.attachesFailed, 1);
  assert.equal(stream.events.length, 0, '没接上就什么也不该发');
  assert.equal(stream.ofType('turn.ended').length, 0, '没接上不算一轮结束');

  await watcher.attachNow(runningEntry());
  assert.equal(watcher.stats.attachesFailed, 2, '同步抛错也要记失败而不是冒泡');

  // 桌面端恢复后仍能接上（失败不能把会话永久拉黑）
  await watcher.attachNow(runningEntry());
  assert.equal(watcher.activeSessions().length, 1);
  assert.equal(desktop.follows.length, 2, '两次订阅都真的发出了请求（失败的那次是流里报错，不是没发）');
  const live = desktop.follows[1];
  assert.equal(live.opts.assistantStream, true);
  assert.equal(live.opts.signal instanceof AbortSignal, true, '订阅要能用 signal 取消');

  await watcher.stop();
  assert.equal(live.follow.returned, true, 'stop() 之后订阅必须关掉');
});

test('中继：listSessions 失败只记错误并跳过本轮，不抛出', async () => {
  const stream = makeStream();
  const desktop = makeDesktop([]);
  desktop.listSessions = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:19387');
  };
  const watcher = new DesktopTurnWatcher({ desktop, stream, pollMs: 3600_000 });

  await watcher.tick();
  assert.match(watcher.stats.lastError ?? '', /ECONNREFUSED/);
  assert.equal(desktop.follows.length, 0);
  await watcher.stop();
});

test('pickTurn：turnOutline 与 sessionStats 取大（不 +1），全空则 null', () => {
  // 实测口径：投影里两处**都**包含正在跑的那一轮（`.probe/turn-numbering.mjs`：跑第 4 轮时
  // stats.turns=4 且 turnOutline max=4），所以取大就是"这一轮是第几轮"，再 +1 会多报一轮。
  assert.equal(pickTurn({ projections: { values: { sessionStats: { turns: 4 } } } }, { turns: 4 }), 4);
  assert.equal(
    pickTurn({ projections: { values: { turnOutline: [{ turn: 1 }, { turn: 2 }, { turn: 7 }] } } }, { turns: 2 }),
    7,
    '两处投影哪个更新就用哪个：outline 走到 7 而 stats 只到 2 时，7 才是真值',
  );
  assert.equal(pickTurn({}, { turns: 0 }), null);
  assert.equal(pickTurn({}, null), null);
});
