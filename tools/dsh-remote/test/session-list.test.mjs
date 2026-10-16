/**
 * 会话列表的**派生会话过滤**（用户诉求 m00121：「子智能体的会话不要全都在手机上面显示」）。
 *
 * 这条链路上有三个各自独立、都可能被写歪的地方，因此这里**三层都锁**：
 * 1. 判据本身（`lib/dsh-home.mjs` 的 `isDerivedSession` / `inferSessionOrigin`）——纯函数，直接测；
 * 2. `SessionMirror.list()` 缺省只列顶层（`lib/session-reader.mjs`）；
 * 3. `GET /api/v2/sessions` 端到端：默认不下发派生会话、`include=subagent|all` 才下发，
 *    且**缺 origin 的派生会话也必须被挡住**（旧实现 `s.origin === 'user'` 会漏出去）。
 *
 * 为什么必须覆盖"缺 origin"这一格：真实桌面端 home 里 135 条会话中 30 条顶层 header
 * **根本没有 origin 字段**（桌面端写顶层会话时不写它），子代理才由 `dsh-subagent` 写
 * `origin:'subagent'`。所以"缺 origin ⇒ user"这条回退等于"把子代理当用户会话列出去"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isDerivedSession, isSubagentSession, inferSessionOrigin, delegationDepthOf } from '../lib/dsh-home.mjs';
import { SessionMirror } from '../lib/session-reader.mjs';
import { SEEDED_SESSION_ID, seedSession, startV2 } from './v2-harness.mjs';

/** 四种真实形状的会话 id（断言里直接引用这些字面量，避免"测试自己算出来的期望值"）。 */
const TOP_LEVEL_ID = SEEDED_SESSION_ID;
const SUBAGENT_ID = 'session-22222222-2222-4222-8222-222222222222';
const DEPTH_ONLY_ID = 'session-33333333-3333-4333-8333-333333333333';
const FORK_ID = 'session-44444444-4444-4444-8444-444444444444';

/** 真实形状的四种 header（字段取自真实 home 实测，见文件头注释）。 */
const HEADERS = {
  /** 顶层用户会话：桌面端真实 header，**没有 origin、没有 parent**。 */
  topLevel: { type: 'session', version: 4, id: TOP_LEVEL_ID, cwd: 'D:\\ws', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
  /** 标准子代理：`dsh-subagent` 的 `childSessionMeta()` 形状。 */
  subagent: { type: 'session', version: 4, id: SUBAGENT_ID, cwd: 'D:\\ws', isSeeded: true, delegationDepth: 1, agentPreset: 'standard', origin: 'subagent', parentSession: TOP_LEVEL_ID },
  /** 只有深度、没有 origin 的子代理（旧版本/别的 driver 写的）—— 旧代码会漏放。 */
  depthOnly: { type: 'session', version: 4, id: DEPTH_ONLY_ID, cwd: 'D:\\ws', isSeeded: true, delegationDepth: 2, agentPreset: 'standard' },
  /** fork / seeded 副本：origin 缺失、深度 0，但**有 parentSession**。 */
  fork: { type: 'session', version: 4, id: FORK_ID, cwd: 'D:\\ws', isSeeded: true, delegationDepth: 0, agentPreset: 'standard', parentSession: TOP_LEVEL_ID },
};

test('判据：缺 origin 时按 delegationDepth / parentSession 推断，不再默认成 user', () => {
  // 顶层：真实 header 就是"什么都没有"，必须仍然是 user
  assert.equal(inferSessionOrigin(HEADERS.topLevel), 'user');
  assert.equal(isDerivedSession(HEADERS.topLevel), false, '顶层会话绝不能被当成派生');
  assert.equal(delegationDepthOf(HEADERS.topLevel), 0);

  // 显式 origin 优先
  assert.equal(inferSessionOrigin(HEADERS.subagent), 'subagent');
  assert.equal(isDerivedSession(HEADERS.subagent), true);
  assert.equal(isSubagentSession(HEADERS.subagent), true);

  // 缺 origin 但 depth>0 ⇒ 子代理（旧实现会判成 user）
  assert.equal(inferSessionOrigin(HEADERS.depthOnly), 'subagent');
  assert.equal(isDerivedSession(HEADERS.depthOnly), true);
  assert.equal(delegationDepthOf(HEADERS.depthOnly), 2);

  // 缺 origin、depth=0，但 parentSession 非空 ⇒ 派生
  assert.equal(inferSessionOrigin(HEADERS.fork), 'subagent');
  assert.equal(isDerivedSession(HEADERS.fork), true);

  // 异常输入不得抛错，且**不得**因为脏值把顶层会话吞掉
  for (const bad of [null, undefined, {}, { origin: '  ' }, { origin: 42 }, { delegationDepth: -1 }, { parentSession: '   ' }]) {
    assert.equal(isDerivedSession(bad), false, `脏 header 不能算派生：${JSON.stringify(bad)}`);
    assert.equal(inferSessionOrigin(bad), 'user');
  }
  // 负数/非数字深度一律归 0（`dsh-session` 只接受非负安全整数）
  assert.equal(delegationDepthOf({ delegationDepth: -3 }), 0);
  assert.equal(delegationDepthOf({ delegationDepth: '2' }), 0);
  assert.equal(delegationDepthOf({ delegationDepth: 2.9 }), 2);
});

/** 在同一个镜像源里造齐四种会话（全部落在 `real-dsh` 这一个 mirror 根）。 */
async function seedFourKinds(t, overrides = {}) {
  const h = await startV2(t, { overrides });
  await seedSession(h.root, { id: SUBAGENT_ID, subagent: true, parentSession: TOP_LEVEL_ID });
  await seedSession(h.root, { id: DEPTH_ONLY_ID, delegationDepth: 2 });
  await seedSession(h.root, { id: FORK_ID, parentSession: TOP_LEVEL_ID });
  return h;
}

/** `GET /api/v2/sessions?source=computer` 的 id 集合（只取镜像根，不受手机任务干扰）。 */
async function listIds(h, query = '') {
  const res = await h.request('GET', `/api/v2/sessions?source=computer&limit=50${query}`);
  assert.equal(res.status, 200);
  return res.json.sessions;
}

test('v2/sessions：默认列表只给顶层会话（缺 origin 的派生会话也必须挡住）', async (t) => {
  const h = await seedFourKinds(t);

  const def = await listIds(h);
  const ids = def.map((s) => s.id);
  assert.deepEqual(ids, [TOP_LEVEL_ID], `默认列表只应有顶层会话，实际=${JSON.stringify(ids)}`);

  // 顶层会话自己必须带着"我是顶层"的证据，手机端才能正确判 isSubagent
  assert.equal(def[0].origin, 'user');
  assert.equal(def[0].parentSession, null);
  assert.equal(def[0].delegationDepth, 0);

  // 三条派生会话：显式 origin / 缺 origin 但 depth>0 / 缺 origin 但有 parent，一个都不能漏
  for (const id of [SUBAGENT_ID, DEPTH_ONLY_ID, FORK_ID]) {
    assert.equal(ids.includes(id), false, `${id} 是派生会话，默认列表不得出现`);
  }
});

test('v2/sessions：?include=subagent 与 ?include=all 才返回派生会话（且带上父子信息）', async (t) => {
  const h = await seedFourKinds(t);

  for (const query of ['&include=subagent', '&include=all']) {
    const all = await listIds(h, query);
    const byId = new Map(all.map((s) => [s.id, s]));
    assert.equal(all.length, 4, `${query} 应返回全部 4 条，实际=${all.length}`);
    assert.equal(byId.get(SUBAGENT_ID)?.origin, 'subagent');
    assert.equal(byId.get(SUBAGENT_ID)?.parentSession, TOP_LEVEL_ID);
    assert.equal(byId.get(SUBAGENT_ID)?.delegationDepth, 1);
    // 缺 origin 的两条也要被**推断**成 subagent 下发，否则手机端认不出来
    assert.equal(byId.get(DEPTH_ONLY_ID)?.origin, 'subagent');
    assert.equal(byId.get(DEPTH_ONLY_ID)?.delegationDepth, 2);
    assert.equal(byId.get(FORK_ID)?.origin, 'subagent');
    assert.equal(byId.get(FORK_ID)?.parentSession, TOP_LEVEL_ID);
    assert.equal(byId.get(TOP_LEVEL_ID)?.origin, 'user');
  }
});

test('v2/sessions：mirror.includeSubagentsByDefault=true 时默认即全量', async (t) => {
  const h = await seedFourKinds(t, { mirror: { includeSubagentsByDefault: true } });

  const def = await listIds(h);
  assert.equal(def.length, 4, `includeSubagentsByDefault=true 时默认列表应含派生会话，实际=${def.length}`);
  assert.equal(def.some((s) => s.id === SUBAGENT_ID), true);

  // 显式 `include=` 给别的值时不当作全量（与旧行为一致：只有 subagent/all 才开）
  const other = await listIds(h, '&include=internal');
  assert.equal(other.length, 1, `include=internal 不应打开全量开关，实际=${other.length}`);
});

test('v2/sessions：派生会话不可续聊（writable=false / writableReason=subagent）', async (t) => {
  const { makeDesktopStub } = await import('./helpers.mjs');
  const ID = 'session-77777777-7777-4777-8777-777777777777';
  // 桌面端索引里有它（否则 writableReason 会是 desktop_disabled，测不出 subagent 这条分支）
  const desktop = makeDesktopStub({
    entries: [{ sessionId: ID, running: false, agentAvailable: true, title: '子智能体任务', turns: 1 }],
  });
  const h = await startV2(t, { desktop });
  await seedSession(h.root, { id: ID, origin: 'subagent', parentSession: TOP_LEVEL_ID, delegationDepth: 1 });

  const all = await listIds(h, '&include=all');
  const entry = all.find((s) => s.id === ID);
  assert.ok(entry, 'include=all 时必须能看到子代理会话');
  assert.equal(entry.writable, false);
  assert.equal(entry.writableReason, 'subagent');

  // 详情端点与列表同口径（http.mjs 里两处都用 isDerivedSession）
  const detail = await h.request('GET', `/api/v2/sessions/${ID}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.writable, false);
  assert.equal(detail.json.writableReason, 'subagent');
  assert.equal(detail.json.origin, 'subagent');
  assert.equal(detail.json.parentSession, TOP_LEVEL_ID);
});

test('SessionMirror.list：缺省只给顶层，includeSubagent:true 全给', async (t) => {
  const h = await seedFourKinds(t);
  const mirror = new SessionMirror({ roots: [{ home: h.seeded.dshHome, source: 'computer', writable: false }] });

  const def = await mirror.list({ limit: 50 });
  assert.deepEqual(def.sessions.map((s) => s.id), [TOP_LEVEL_ID]);
  assert.equal(def.total, 1, 'total 必须反映过滤后的条数（分页用）');

  const all = await mirror.list({ limit: 50, includeSubagent: true });
  assert.equal(all.total, 4);
  assert.equal(all.sessions.length, 4);
});
