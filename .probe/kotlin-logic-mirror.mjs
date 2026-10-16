// 用 JS 逐字复刻 Kotlin 侧的实现（SessionSummary.isSubagent / derivedLabel /
// List<SessionSummary>.withParentTitles / SessionsViewModel.UiState.visible），
// 再把两个 Kotlin 单测里的断言原样搬过来跑一遍。
//
// 为什么这么做：这台机器只有 JRE（D:\finalshell\jre，而且被裁成只剩 java.base，
// 连 sun.misc.Unsafe 都没有），没有 JDK，kotlinc 起不来，gradle 又是 Lead 统一跑。
// 所以用"同输入同输出"的镜像实现把断言跑通——它验证的是**判据逻辑**，
// 不能替代编译（Kotlin 语法用 .probe/kotlin-structure-check.mjs 保底）。
//
// 用法: node .probe/kotlin-logic-mirror.mjs

// ---------- Kotlin: SessionSummary.isSubagent ----------
function isSubagent(s) {
  const explicit = s.origin == null ? null : String(s.origin).trim().toLowerCase();
  if (explicit !== null && explicit !== '') return explicit === 'subagent';
  return (s.delegationDepth ?? 0) > 0 || !(s.parentSession == null || String(s.parentSession).trim() === '');
}

// ---------- Kotlin: SessionSummary.derivedLabel ----------
function shortId(id) {
  const body = id.startsWith('session-') ? id.slice('session-'.length) : id;
  return body.length <= 8 ? body : body.slice(0, 8);
}

function derivedLabel(s) {
  if (!isSubagent(s)) return null;
  const parentId = s.parentSession != null && String(s.parentSession).trim() !== '' ? s.parentSession : null;
  const parent = s.parentTitle != null && String(s.parentTitle).trim() !== '' ? s.parentTitle : null;
  const depth = s.delegationDepth ?? 0;
  if (parent != null && depth > 1) return `子代理 · 父会话「${parent}」· 第 ${depth} 层`;
  if (parent != null) return `子代理 · 父会话「${parent}」`;
  if (parentId != null && depth > 1) return `子代理 · 父会话 ${shortId(parentId)} · 第 ${depth} 层`;
  if (parentId != null) return `子代理 · 父会话 ${shortId(parentId)}`;
  return '子代理';
}

// ---------- Kotlin: List<SessionSummary>.withParentTitles() ----------
function withParentTitles(list) {
  if (!list.some((s) => s.parentSession != null)) return list;
  const titles = new Map(list.map((s) => [s.id, s.title]));
  return list.map((s) => {
    const title = s.parentSession != null ? titles.get(s.parentSession) : undefined;
    if (title == null || String(title).trim() === '') return s;
    return { ...s, parentTitle: title };
  });
}

// ---------- Kotlin: SessionsViewModel.UiState ----------
function uiState(sessions, { includeSubagent = false, query = '' } = {}) {
  const isComputer = (s) => (s.source ?? 'computer') === 'computer';
  const visible = sessions
    .filter(isComputer)
    .filter((s) => includeSubagent || !isSubagent(s))
    .filter(
      (s) =>
        query.trim() === '' ||
        s.title.toLowerCase().includes(query.toLowerCase()) ||
        s.workspace.toLowerCase().includes(query.toLowerCase()) ||
        s.id.includes(query),
    );
  return {
    visible,
    topLevelCount: sessions.filter((s) => isComputer(s) && !isSubagent(s)).length,
    hiddenDerivedCount: includeSubagent ? 0 : sessions.filter((s) => isComputer(s) && isSubagent(s)).length,
    liveCount: visible.filter((s) => s.live).length,
  };
}

// ---------- Kotlin: JsonV2.optStringOrNull / parseSession 的派生三字段 ----------
function parseDerivationFields(json) {
  const raw = JSON.parse(json);
  const optStringOrNull = (obj, key) =>
    !(key in obj) || obj[key] === null ? null : String(obj[key]).length === 0 ? null : String(obj[key]);
  return (raw.sessions ?? []).map((obj) => ({
    id: String(obj.id ?? ''),
    title: obj.title == null ? '' : String(obj.title),
    workspace: String(obj.workspace ?? ''),
    source: obj.source ?? 'computer',
    origin: optStringOrNull(obj, 'origin'),
    parentSession: optStringOrNull(obj, 'parentSession'),
    delegationDepth: Math.max(0, Number.isInteger(obj.delegationDepth) ? obj.delegationDepth : 0),
  }));
}

// ---------- Kotlin: JsonV2.sessionsToJson / sessionsFromJson（只关心派生字段的往返） ----------
function cacheRoundTrip(list) {
  const packed = list.map((s) => {
    const o = { id: s.id, title: s.title, workspace: s.workspace, source: s.source };
    if (s.origin != null) o.origin = s.origin;
    if (s.parentSession != null) o.parentSession = s.parentSession;
    if ((s.delegationDepth ?? 0) > 0) o.delegationDepth = s.delegationDepth;
    return o;
  });
  return parseDerivationFields(JSON.stringify({ sessions: packed }));
}

// ================= 断言（原样搬自两个 Kotlin 单测） =================
let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}
const eq = (name, expected, actual) =>
  check(`${name}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`, JSON.stringify(expected) === JSON.stringify(actual));

// 对应 Kotlin 测试里的 `title: String = "会话 $id"`
const mk = (o) => ({ workspace: 'D:\\Workspace\\dsh_android', source: 'computer', live: false, title: `会话 ${o.id}`, ...o });

// --- SessionDerivationTest ---
check('缺 origin + depth=1 ⇒ 子代理', isSubagent(mk({ origin: null, delegationDepth: 1 })));
check('缺 origin 读成 null', mk({ origin: null, delegationDepth: 1 }).origin === null);
check('缺 origin + depth=2 ⇒ 子代理', isSubagent(mk({ origin: null, delegationDepth: 2 })));
check('缺 origin + depth=0 + 无 parent ⇒ 顶层', !isSubagent(mk({ origin: null, delegationDepth: 0 })));
check('缺 origin + 有 parent ⇒ 派生（fork）', isSubagent(mk({ origin: null, parentSession: 'session-c6116e3f', delegationDepth: 0 })));
check('origin=subagent ⇒ 派生', isSubagent(mk({ origin: 'subagent' })));
check('origin=subagent 且无深度 ⇒ 派生', isSubagent(mk({ origin: 'subagent', delegationDepth: 0 })));
check('origin=user ⇒ 顶层', !isSubagent(mk({ origin: 'user' })));
check('origin=SUBAGENT 容错', isSubagent(mk({ origin: 'SUBAGENT' })));
check('origin=" subagent " 容错', isSubagent(mk({ origin: ' subagent ' })));
check('origin="" + depth=1 ⇒ 派生', isSubagent(mk({ origin: '', delegationDepth: 1 })));
check('origin="" + depth=0 ⇒ 顶层', !isSubagent(mk({ origin: '', delegationDepth: 0 })));

eq('父标题已回填', '子代理 · 父会话「优化手机端 App 界面」',
  derivedLabel(mk({ origin: 'subagent', parentSession: 'session-1716c25b-c832-4e00-bae5-8827a8ee4aa2', parentTitle: '优化手机端 App 界面' })));
eq('深层带层号', '子代理 · 父会话「根任务」· 第 2 层',
  derivedLabel(mk({ origin: 'subagent', parentSession: 'session-x', delegationDepth: 2, parentTitle: '根任务' })));
eq('父未知退回 id 短写', '子代理 · 父会话 1716c25b',
  derivedLabel(mk({ origin: 'subagent', parentSession: 'session-1716c25b-c832-4e00-bae5-8827a8ee4aa2' })));
check('顶层无徽标', derivedLabel(mk({ origin: null, delegationDepth: 0 })) === null);

{
  const root = mk({ id: 'session-root', title: '优化手机端 App 界面', origin: null });
  const child = mk({ id: '0b3c9651', origin: 'subagent', parentSession: 'session-root' });
  const orphan = mk({ id: 'orphan', origin: 'subagent', parentSession: 'session-不在本批里' });
  const filled = withParentTitles([root, child, orphan]);
  eq('本批内回填父标题', '优化手机端 App 界面', filled[1].parentTitle);
  check('父不在本批 ⇒ 保持 null', filled[2].parentTitle == null);
  eq('回填后可读', '子代理 · 父会话「优化手机端 App 界面」', derivedLabel(filled[1]));
  const plain = [root];
  check('无派生会话时原样返回（同一引用）', withParentTitles(plain) === plain);
}

{
  const parsed = parseDerivationFields(JSON.stringify({
    sessions: [
      { id: 'session-6a3cd446', title: '顶层', workspace: 'D:\\W', origin: 'user', delegationDepth: 0, source: 'computer' },
      { id: '0b3c9651', title: '子代理', workspace: 'D:\\W', parentSession: 'session-1716c25b-c832-4e00-bae5-8827a8ee4aa2', delegationDepth: 1, origin: 'subagent', source: 'computer' },
      { id: 'session-b64b78d8', title: 'fork', workspace: 'D:\\W', parentSession: 'session-c6116e3f-6f3a-479b-bd34-5d9f13d79007', delegationDepth: 0, source: 'computer' },
    ],
  }));
  eq('解析条数', 3, parsed.length);
  eq('显式 user 原样保留', 'user', parsed[0].origin);
  check('显式 user 不是派生', !isSubagent(parsed[0]));
  eq('subagent origin', 'subagent', parsed[1].origin);
  eq('深度解析', 1, parsed[1].delegationDepth);
  eq('父会话解析', 'session-1716c25b-c832-4e00-bae5-8827a8ee4aa2', parsed[1].parentSession);
  check('子代理判派生', isSubagent(parsed[1]));
  check('缺 origin 读成 null（不默认 user）', parsed[2].origin === null);
  check('缺 origin + 有 parent ⇒ 派生', isSubagent(parsed[2]));
}

{
  const fork = mk({ id: 'session-b64b78d8', origin: null, parentSession: 'session-c6116e3f-6f3a-479b-bd34-5d9f13d79007', delegationDepth: 0 });
  const child = mk({ id: '0b3c9651', origin: 'subagent', parentSession: 'session-root', delegationDepth: 2 });
  const root = mk({ id: 'session-root', title: '顶层', origin: null });
  const restored = cacheRoundTrip([fork, child, root]);
  eq('缓存往返条数', 3, restored.length);
  check('缓存不把缺 origin 补成 user', restored[0].origin === null);
  check('离线回放仍折叠 fork', isSubagent(restored[0]));
  eq('缓存保留 origin', 'subagent', restored[1].origin);
  eq('缓存保留深度', 2, restored[1].delegationDepth);
  check('顶层不被误折叠', !isSubagent(restored[2]));
}

// --- SessionListFilterTest ---
const realWorld = [
  mk({ id: 'session-a', title: '优化手机端 App 界面' }),
  mk({ id: 'session-b', title: '折叠工具调用并修复移动端稳定性' }),
  mk({ id: '0b3c9651', origin: 'subagent', parentSession: 'session-a', delegationDepth: 1 }),
  mk({ id: '0d77a600', origin: 'subagent', parentSession: 'session-a', delegationDepth: 1 }),
  mk({ id: 'deep-001', origin: 'subagent', parentSession: '0b3c9651', delegationDepth: 2 }),
  mk({ id: 'session-b64b78d8', parentSession: 'session-c6116e3f', title: 'CAN通信库开发虚拟测试环境方案' }),
];
{
  const ui = uiState(realWorld);
  eq('默认只留顶层', 2, ui.visible.length);
  eq('默认可见的 id', ['session-a', 'session-b'], ui.visible.map((s) => s.id));
  check('fork 不漏出', !ui.visible.some((s) => s.id === 'session-b64b78d8'));
}
{
  const closed = uiState(realWorld);
  eq('关着时折叠 4 条', 4, closed.hiddenDerivedCount);
  eq('顶层计数不受开关影响', 2, closed.topLevelCount);
  const opened = uiState(realWorld, { includeSubagent: true });
  eq('打开后 6 条', 6, opened.visible.length);
  eq('打开后无折叠', 0, opened.hiddenDerivedCount);
  eq('打开后顶层计数不变', 2, opened.topLevelCount);
}
{
  const leaked = realWorld.concat([mk({ id: 'leaked-1', origin: 'subagent', parentSession: 'session-a', delegationDepth: 1 })]);
  const ui = uiState(leaked);
  check('第二层防线挡住泄漏', !ui.visible.some((s) => s.id === 'leaked-1'));
  eq('仍然只显示 2 条', 2, ui.visible.length);
}
{
  const sessions = [
    mk({ id: 'session-a', title: '优化手机端 App 界面' }),
    mk({ id: 'sdk-1', source: 'phone', title: '手机派活' }),
    mk({ id: '0b3c9651', origin: 'subagent', parentSession: 'session-a', delegationDepth: 1, title: '优化手机端 App 界面' }),
  ];
  const ui = uiState(sessions);
  eq('电脑会话页不列手机任务', 1, ui.visible.length);
  const searched = uiState(sessions, { query: '手机' });
  eq('搜索不搜出子代理', 1, searched.visible.length);
  eq('搜索命中的是顶层', 'session-a', searched.visible[0].id);
}
{
  const withTitles = withParentTitles(realWorld);
  const ui = uiState(withTitles, { includeSubagent: true });
  eq('子代理标注', '子代理 · 父会话「优化手机端 App 界面」', derivedLabel(ui.visible.find((s) => s.id === '0b3c9651')));
  eq('深层标注', '子代理 · 父会话「会话 0b3c9651」· 第 2 层', derivedLabel(ui.visible.find((s) => s.id === 'deep-001')));
  eq('顶层无标注', null, derivedLabel(ui.visible.find((s) => s.id === 'session-a')));
  eq('fork 父未知退回短写', '子代理 · 父会话 c6116e3f', derivedLabel(ui.visible.find((s) => s.id === 'session-b64b78d8')));
}
{
  const sessions = [
    mk({ id: 'session-a', live: true }),
    mk({ id: 'session-b' }),
    mk({ id: '0b3c9651', origin: 'subagent', parentSession: 'session-a', delegationDepth: 1, live: true }),
  ];
  const ui = uiState(sessions);
  eq('live 计数只算可见', 1, ui.liveCount);
  check('live 计数不超过可见条数', ui.liveCount <= ui.visible.length);
}

console.log(`断言: ${passed} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  process.exit(1);
}
