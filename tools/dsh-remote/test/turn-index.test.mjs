/**
 * 轮次索引测试（契约 §4.2.2，v2.9.0）。
 *
 * 这个端点唯一有价值的性质是**下标与 `/transcript` 完全对齐** —— 手机端拿到
 * `toIndex` 就 `GET /transcript?cursor=<toIndex>&limit=60`，指错一位就是"跳过去少一条/多一条"，
 * 而这种错位几乎无法从现象倒推回原因。所以用例的重点不是"字段都在"，而是：
 * 1. `[fromIndex, toIndex)` 真的切成一轮一轮（逐条比对 `turn` 字段）；
 * 2. 用 `cursor=toIndex` 取回的那一页**恰好**是那一轮（内容级断言，不只是长度相等）；
 * 3. 两个端点的 `from`/`to`/下标在同一个消息数组空间里（同一个 fixture 交叉验证）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTurnIndex } from '../lib/session-reader.mjs';
import { SEEDED_SESSION_ID, startV2 } from './v2-harness.mjs';

/** 本文件所有用例共用的 fixture：两轮 + 一张用户图 + 一张工具图。 */
const SEED = { withUserImage: true, withToolImage: true, withTurn2: true, withRealAttachments: true };

// ---------------------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------------------

test('buildTurnIndex：区间/文案/计数，且缺 turn 的消息不进任何一轮', () => {
  const messages = [
    { role: 'user', turn: null, text: '开场（turn/start 之前）', at: 1, step: null },
    { role: 'user', turn: 1, text: '  第一轮  问句 ', at: 2, step: null },
    { role: 'assistant', turn: 1, text: '第一版答复', at: 3, step: 1, toolCalls: [{ id: 'a' }] },
    { role: 'assistant', turn: 1, text: '最终答复', at: 4, step: 2, toolCalls: [{ id: 'b' }, { id: 'c' }] },
    { role: 'user', turn: 2, text: '第二轮问句', at: 5, step: null },
    { role: 'assistant', turn: 2, text: '第二轮答复', at: 6, step: 1, toolCalls: [] },
    { role: 'system', turn: null, text: '收尾合成消息', at: 7 },
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns.length, 2, '只有两轮有归属');
  assert.deepEqual(turns[0], {
    turn: 1,
    fromIndex: 1,
    toIndex: 4,
    at: 2,
    userText: '第一轮 问句',
    assistantText: '最终答复',
    steps: 2,
    toolCalls: 3,
  });
  assert.deepEqual(turns[1], {
    turn: 2,
    fromIndex: 4,
    toIndex: 6,
    at: 5,
    userText: '第二轮问句',
    assistantText: '第二轮答复',
    steps: 1,
    toolCalls: 0,
  });
  // 切出来的区间必须逐条自洽（这就是客户端依赖的那条性质）
  for (const entry of turns) {
    for (const msg of messages.slice(entry.fromIndex, entry.toIndex)) assert.equal(msg.turn, entry.turn);
    const before = messages[entry.fromIndex - 1];
    if (before) assert.notEqual(before.turn, entry.turn, '区间左侧不应还有同轮消息');
    const after = messages[entry.toIndex];
    if (after) assert.notEqual(after.turn, entry.turn, '区间右侧不应还有同轮消息');
  }
});

test('buildTurnIndex：文案按 UTF-8 安全截断（不把几 MB 正文搬到索引里）', () => {
  const long = '很长的正文'.repeat(5000);
  const turns = buildTurnIndex([{ role: 'assistant', turn: 1, text: long, at: 1, step: 1, toolCalls: [] }]);
  assert.ok(turns[0].assistantText.length < long.length);
  assert.ok(Buffer.byteLength(turns[0].assistantText, 'utf8') <= 200, '截断后不得超过 200 字节');
  assert.equal(turns[0].assistantText.startsWith('很长的正文'), true, '保留的是头部');
  // 截断不得切出非法 UTF-16（代理对与多字节字符都要完整）
  assert.equal(turns[0].assistantText.includes('\ufffd'), false);

  // 全是空白的正文 → null（客户端据此判空，不必自己 trim）
  assert.equal(buildTurnIndex([{ role: 'user', turn: 1, text: '   \n  ', at: 1 }])[0].userText, null);
  // 空数组 → 空索引，不抛错
  assert.deepEqual(buildTurnIndex([]), []);
});

// ---------------------------------------------------------------------------
// HTTP 端点
// ---------------------------------------------------------------------------

test('v2/turn-index：形状（sessionId/total/totalMessages/turns[]）与冻结字段齐备', async (t) => {
  const h = await startV2(t, { seed: SEED });
  const res = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/turn-index`);
  assert.equal(res.status, 200);
  assert.equal(res.json.sessionId, SEEDED_SESSION_ID);
  assert.equal(res.json.total, 2, 'fixture 有两轮');
  assert.ok(Number.isInteger(res.json.totalMessages) && res.json.totalMessages > 0);
  assert.equal(res.json.turns.length, 2);
  for (const entry of res.json.turns) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['assistantText', 'at', 'fromIndex', 'steps', 'toIndex', 'toolCalls', 'turn', 'userText'],
      '字段集合是冻结的，客户端按此解析',
    );
    assert.equal(Number.isInteger(entry.fromIndex), true);
    assert.equal(Number.isInteger(entry.toIndex), true);
    assert.ok(entry.toIndex > entry.fromIndex);
    assert.equal(Number.isInteger(entry.steps), true);
    assert.equal(Number.isInteger(entry.toolCalls), true);
  }
  assert.deepEqual(res.json.turns.map((entry) => entry.turn), [1, 2], '按轮号升序');
});

test('v2/turn-index：fromIndex/toIndex 与 /transcript 是同一套投影的下标（逐条交叉验证）', async (t) => {
  const h = await startV2(t, { seed: SEED });
  const tx = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/transcript?limit=100`);
  const index = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/turn-index`);
  const messages = tx.json.messages;

  assert.equal(index.json.totalMessages, tx.json.total, 'totalMessages 必须等于 transcript 的 total');
  assert.equal(index.json.turns.length, 2);

  // 断言写成**不变量**而不是写死下标：区间必须"恰好切出该轮"。
  // （写死 `[[0,3],[3,5]]` 会把 fixture 内部细节焊进用例 —— 注入消息、待办卡这些
  //   "没有 turn 归属"的消息一旦增减，用例就会以"索引错了"的名义失败，误导后来者。）
  for (const entry of index.json.turns) {
    const slice = messages.slice(entry.fromIndex, entry.toIndex);
    assert.ok(slice.length > 0, `第 ${entry.turn} 轮的区间不能是空的`);
    for (const msg of slice) assert.equal(msg.turn, entry.turn, `下标 [${entry.fromIndex},${entry.toIndex}) 里混进了别的轮次`);
    for (const msg of messages.slice(entry.toIndex).concat(messages.slice(0, entry.fromIndex))) {
      if (typeof msg.turn === 'number') assert.notEqual(msg.turn, entry.turn, `第 ${entry.turn} 轮还有消息落在区间外`);
    }
    assert.ok(entry.toIndex <= messages.length, 'toIndex 不能越界（客户端会直接拿它当 cursor）');
  }
  // 区间必须单调、不重叠，且覆盖所有"有轮次归属"的消息
  for (let i = 1; i < index.json.turns.length; i++) {
    assert.ok(index.json.turns[i].fromIndex >= index.json.turns[i - 1].toIndex, '区间不得重叠');
  }
  const covered = index.json.turns.reduce((sum, entry) => sum + (entry.toIndex - entry.fromIndex), 0);
  const withTurn = messages.filter((m) => typeof m.turn === 'number').length;
  assert.equal(covered, withTurn, '所有有 turn 的消息都必须落进某个区间（不能漏）');

  // 文案取自**消息投影的 `text`**（不是 reasoning、不是工具结果）：
  // 第 1 轮那条 assistant 消息有正文，所以必须原样出现；
  // 第 1 轮里没有任何 user 消息（fixture 的用户消息在 turn/start 之前，`turn:null`）
  // → `userText` 必须是 null 而不是空串，客户端据此决定要不要显示第二行。
  assert.equal(index.json.turns[0].userText, null);
  assert.equal(index.json.turns[0].assistantText, '定位到 AGP 版本不匹配。');
  assert.equal(index.json.turns[0].toolCalls, 1, '第一轮有一个工具调用');
  // 第 2 轮的用户消息只有图片、没有正文 → 文案为 null，但轮次本身必须在
  assert.equal(index.json.turns[1].userText, null);
  assert.equal(index.json.turns[1].assistantText, '第二轮答复完成。');
  assert.equal(index.json.turns[1].toolCalls, 0);
});

test('v2/turn-index：cursor=<toIndex>&limit=60 取回的那一页恰好是那一轮（内容级断言）', async (t) => {
  const h = await startV2(t, { seed: SEED });
  const index = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/turn-index`);
  const direct = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/transcript?limit=100`);

  for (const entry of index.json.turns) {
    const page = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/transcript?cursor=${entry.toIndex}&limit=60`);
    assert.equal(page.status, 200);
    assert.equal(page.json.to, entry.toIndex, '页尾必须正好落在 toIndex');
    assert.equal(page.json.total, index.json.totalMessages, '两条端点必须在同一个消息数组空间里');
    // 这一页是"以该轮结尾"的窗口（`[max(0,toIndex-60), toIndex)`，fixture 里 from=0）。
    // 关键性质：它与索引指出的那一段的**交集**必须逐字等于那一轮 —— 这就是手机端
    // "点第 N 轮 → cursor=toIndex 取一页 → 高亮这一轮"所依赖的全部。
    const paged = page.json.messages.slice(entry.fromIndex, entry.toIndex);
    assert.deepEqual(paged, direct.json.messages.slice(entry.fromIndex, entry.toIndex), `第 ${entry.turn} 轮取回的内容不一致`);
    for (const msg of paged) assert.equal(msg.turn, entry.turn);
    assert.ok(paged.length > 0);
  }

  // 具体一点：cursor 取到第一轮的 toIndex 时，整页（fixture 里 from=0）必须**全部**属于第 1 轮
  const first = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/transcript?cursor=${index.json.turns[0].toIndex}&limit=60`);
  assert.equal(first.json.to, index.json.turns[0].toIndex);
  assert.equal(first.json.messages.length, index.json.turns[0].toIndex);
  for (const msg of first.json.messages.slice(index.json.turns[0].fromIndex)) assert.equal(msg.turn, index.json.turns[0].turn);
  // 页尾那条必须是该轮最后一条（客户端据此把高亮落在正确的消息上）
  assert.equal(first.json.messages.at(-1).turn, index.json.turns[0].turn);
});

test('v2/turn-index：与既有 POST /turns 是两条独立路由（不是同一个端点的改写）', async (t) => {
  const h = await startV2(t, { seed: { withTurn2: true } });

  const wrongMethod = await h.request('POST', `/api/v2/sessions/${SEEDED_SESSION_ID}/turn-index`, { body: {} });
  assert.equal(wrongMethod.status, 405, 'turn-index 只允许 GET');
  assert.match(wrongMethod.json.error.message, /GET/);

  // 既有的发轮端点必须仍在、仍只接受 POST（本任务明确要求"不要动它"）。
  // 这里**故意只断言路由层**（405 与"请求确实进到了发轮处理器"）：
  // 发轮的端到端行为由 `v2-http.test.mjs` 覆盖，本文件再跑一遍会引入对 SDK 替身
  // 启动时序的依赖（全量并行跑时出现过 503 抖动），那是别人的用例该负责的失败面。
  const turnsGet = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/turns`);
  assert.equal(turnsGet.status, 405, 'POST /turns 不接受 GET');

  // 空体 → 由 `POST /turns` 的**参数校验**拒绝（400），证明请求真的进了发轮处理器；
  // 若路由被 `turn-index` 抢走，这里会得到 405 而不是 400。
  const post = await h.request('POST', `/api/v2/sessions/${SEEDED_SESSION_ID}/turns`, { body: {} });
  assert.notEqual(post.status, 405, 'POST /turns 必须仍然接受 POST');
  assert.equal(post.status, 400, `缺 prompt 应 400（实际 ${post.status}：${post.text.slice(0, 200)}）`);

  // 同一会话下 GET turn-index 仍可用，且不受 turns 那条路由影响
  const index = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/turn-index`);
  assert.equal(index.status, 200);
  assert.equal(index.json.sessionId, SEEDED_SESSION_ID);
  assert.ok(Array.isArray(index.json.turns));
});

test('v2/turn-index：会话不存在 → 404 session_not_found；未认证 → 401', async (t) => {
  const h = await startV2(t, {});
  const missing = await h.request('GET', '/api/v2/sessions/session-99999999-9999-4999-8999-999999999999/turn-index');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'session_not_found');

  const noAuth = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/turn-index`, { token: null });
  assert.equal(noAuth.status, 401);
});

test('v2/turn-index：没有任何轮次的会话返回空 turns（不报错、不返回 null）', async (t) => {
  const h = await startV2(t, { seed: { withToolCall: false } });
  const res = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/turn-index`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.turns, [], 'fixture 里所有消息都在 turn/start 之前');
  assert.equal(res.json.total, 0);
  assert.ok(res.json.totalMessages > 0, '消息仍然存在，只是没有轮次归属');
});

test('v2/turn-index：health 能力清单里声明 session.turnIndex', async (t) => {
  const h = await startV2(t, {});
  const res = await h.request('GET', '/api/v2/health');
  assert.ok(res.json.capabilities.includes('session.turnIndex'), res.json.capabilities.join(','));
  // 既有能力不得因为本次改动而消失
  for (const cap of ['sessions', 'session.transcript', 'session.turns', 'approvals']) {
    assert.ok(res.json.capabilities.includes(cap), `能力 ${cap} 不见了`);
  }
});
