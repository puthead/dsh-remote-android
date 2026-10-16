/**
 * v2 单元测试：多帧 zstd、slug 编解码、transcript 投影、路径安全、WS 帧编解码、配置闸门。
 *
 * 原则与 v1 一致：**不用 mock 顶替真实代码路径**。zstd 用例构造真的多帧 zstd 文件；
 * WS 用例走真的帧编解码（含分片、跨包、掩码）；路径安全用例在真临时目录里放真符号链接。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  MultiFrameReader,
  decompressMultiFrame,
  frameLengthAt,
  parseJsonl,
  scanFrames,
} from '../lib/zstd-multiframe.mjs';
import { decodeWorkspaceSlug, encodeWorkspaceSlug, readWorkspaceIndex, resolveDshHome, SESSION_DIR_RE } from '../lib/dsh-home.mjs';
import { CAPS, contentText, paginate, parseArgs, parseCursor, projectSession, readProjCache, projCacheIsRunning } from '../lib/session-reader.mjs';
import { LiveTracker, STREAM_EVENTS, SessionStream, mapRunnerLine } from '../lib/session-live.mjs';
import { isUncPath, hasAlternateDataStream, looksBinary, resolveTarget, guessMime } from '../lib/workspace-fs.mjs';
import { parseNumstatZ, parsePorcelainZ, mergeNumstat, noneVcs } from '../lib/workspace-git.mjs';
import { FrameDecoder, OPCODE, WebSocketClient, WebSocketHandshakeError, acceptKey, encodeFrame } from '../lib/ws.mjs';
import { backoffDelay, flattenHeaders, normalizeRelayUrl, postJson, sliceBuffer, RelayClient } from '../lib/relay-client.mjs';
import { parseDshLauncher, readCredentialEnv, resolveDshLaunch, safeJson, assistantFrames } from '../lib/session-runner.mjs';
import { ConfigError, defaultConfig, isLoopbackHost, mergeConfig, validateConfig } from '../lib/config.mjs';
import { createLogger } from '../lib/util.mjs';
import { makeSandbox } from './helpers.mjs';

// ---------------------------------------------------------------- 多帧 zstd
test('多帧 zstd：确定性块遍历能解出全部帧（含真实会话样例）', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-zstd-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.v4.jsonl.zstd');

  // 4 帧追加写，模拟 DSH 的写入方式
  const lines = [];
  const chunks = [];
  for (let i = 0; i < 4; i++) {
    const body = [`{"type":"session","version":4,"id":"session-x"}`, ...Array.from({ length: 3 }, (_, k) => `{"type":"turn/start","seq":${i * 3 + k},"time":${i * 3 + k},"data":{"turn":1}}`)].join('\n') + '\n';
    lines.push(body);
    chunks.push(zstdCompressSync(Buffer.from(body, 'utf8')));
  }
  await fs.writeFile(file, Buffer.concat(chunks));

  const { events, frames, bytes } = await (await import('../lib/zstd-multiframe.mjs')).readSessionEvents(file);
  assert.equal(frames, 4, '必须识别出 4 帧');
  assert.equal(bytes, Buffer.concat(chunks).length);
  assert.equal(events.length, 16, '4 帧 × 4 行');
  assert.equal(events[0].type, 'session');

  // 关键反例：zstdDecompressSync 只解第一帧 → 必须少于全部
  const { zstdDecompressSync } = await import('node:zlib');
  const firstOnly = zstdDecompressSync(Buffer.concat(chunks)).toString('utf8');
  assert.ok(firstOnly.split('\n').filter((l) => l.trim()).length < 16, 'node 内置只解第一帧，正是本模块存在的理由');
});

test('多帧 zstd：真实会话文件（%USERPROFILE%\\.dsh）可完整解析且 seq 单调', async (t) => {
  const home = process.env.USERPROFILE ?? os.homedir();
  const file = path.join(home, '.dsh', 'sessions', '--D-Workspace-dsh_android--', 'session-88e9459c-260c-4a61-8c2a-bb5f411d3270', 'session.v4.jsonl.zstd');
  try {
    await fs.access(file);
  } catch {
    t.skip('本机没有该真实会话样例，跳过');
    return;
  }
  const { readSessionEvents } = await import('../lib/zstd-multiframe.mjs');
  const { events, frames, bytes } = await readSessionEvents(file);
  // 该样例是本机**正在使用**的真实会话文件，DSH 每轮都会往里追加帧，帧数/事件数/字节数会持续增长。
  // 因此这里只断言"对任何快照都成立"的结构性事实，不钉死具体数值
  // （实测漂移：1153 帧/1779 事件/1598845B → 1278 帧/1975 事件/1788777B）。
  assert.ok(frames > 500, `应解出数百帧：${frames}`);
  assert.ok(events.length >= frames, `每帧至少一条事件：${events.length} vs ${frames}`);
  assert.ok(bytes > 100_000, `应读到真实量级的字节数：${bytes}`);
  assert.equal(events[0].type, 'session', '首行是 session header');
  assert.match(events[0].id, /^session-/);
  // 事件水位：除 header 外的行都带 seq，且单调不减（读错帧/丢帧会立刻破功）
  const seqs = events.map((e) => e.seq).filter((n) => Number.isInteger(n));
  assert.ok(seqs.length >= events.length - 1, `除 session header 外都应有 seq：${seqs.length}/${events.length}`);
  assert.equal(seqs[0], 0, '水位从 0 开始');
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] >= seqs[i - 1], `seq 必须单调不减：第 ${i} 项 ${seqs[i]} < ${seqs[i - 1]}`);
  }
  // 同一文件重复解码结果一致（防止解码器带隐藏状态）
  const again = await readSessionEvents(file);
  assert.equal(again.frames, frames);
  assert.equal(again.events.length, events.length);
  assert.equal(again.bytes, bytes);
});

test('多帧 zstd：尾部 torn frame 不报错、不产半条事件，补齐后可续读', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-torn-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.v4.jsonl.zstd');
  const f1 = zstdCompressSync(Buffer.from('{"type":"a","seq":0}\n', 'utf8'));
  const f2 = zstdCompressSync(Buffer.from('{"type":"b","seq":1}\n{"type":"c","seq":2}\n', 'utf8'));
  // 先写第一帧 + 第二帧的前 8 字节（模拟写入中途被读到）
  await fs.writeFile(file, Buffer.concat([f1, f2.subarray(0, 8)]));

  const reader = new MultiFrameReader({ file });
  const first = await reader.refresh();
  assert.deepEqual(first.added.map((e) => e.type), ['a'], '残帧不得产出事件');
  assert.equal(reader.consumed, f1.length, '已消费偏移停在最后一个完整帧');
  assert.equal(reader.invalidations, 0, '残帧不算损坏帧');

  // 补齐第二帧：必须续读出 b、c
  await fs.writeFile(file, Buffer.concat([f1, f2]));
  const second = await reader.refresh();
  assert.deepEqual(second.added.map((e) => e.type), ['b', 'c'], '补齐后只解新帧且内容完整');
  assert.equal(reader.events.length, 3);
  assert.equal(reader.unparsableCount, 0);
});

test('多帧 zstd：增量 tail 只解新帧，不重解历史', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-tail-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.v4.jsonl.zstd');
  const frames = Array.from({ length: 3 }, (_, i) => zstdCompressSync(Buffer.from(`{"type":"e","seq":${i}}\n`, 'utf8')));
  await fs.writeFile(file, frames[0]);
  const reader = new MultiFrameReader({ file });
  await reader.refresh();
  const afterFirst = reader.bytesRead;
  assert.equal(afterFirst, frames[0].length);

  await fs.writeFile(file, Buffer.concat(frames));
  const res = await reader.refresh();
  assert.equal(res.frames, 2, '第二次只解 2 个新帧');
  assert.equal(reader.bytesRead, afterFirst + frames[1].length + frames[2].length, '只读了新增字节');
  assert.equal(reader.events.length, 3);

  // 未变化时短路（不读盘）
  const idle = await reader.refresh();
  assert.equal(idle.added.length, 0);
  assert.equal(reader.bytesRead, afterFirst + frames[1].length + frames[2].length);
});

test('多帧 zstd：文件被截断重写时全量重来', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-reset-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.v4.jsonl.zstd');
  await fs.writeFile(file, Buffer.concat([zstdCompressSync(Buffer.from('{"type":"a","seq":0}\n')), zstdCompressSync(Buffer.from('{"type":"b","seq":1}\n'))]));
  const reader = new MultiFrameReader({ file });
  await reader.refresh();
  assert.equal(reader.events.length, 2);

  await fs.writeFile(file, zstdCompressSync(Buffer.from('{"type":"z","seq":0}\n', 'utf8')));
  const res = await reader.refresh();
  assert.equal(res.reset, true, '必须报告 reset');
  assert.deepEqual(reader.events.map((e) => e.type), ['z'], '旧事件被清空');
});

test('frameLengthAt / scanFrames：单帧、多帧、skippable、非法字节', () => {
  const one = zstdCompressSync(Buffer.from('hello'));
  assert.equal(frameLengthAt(one, 0), one.length);
  const skippable = Buffer.alloc(12);
  skippable.writeUInt32LE(0x184d2a50, 0);
  skippable.writeUInt32LE(4, 4);
  assert.equal(frameLengthAt(skippable, 0), 12, 'skippable 帧长度 = 8 + size');
  assert.equal(frameLengthAt(Buffer.from('nope'), 0), -1, '非法魔数');
  assert.equal(frameLengthAt(one.subarray(0, 3), 0), -1, '数据不足');
  const both = Buffer.concat([one, one]);
  assert.equal(scanFrames(both).frames.length, 2);
  // 压缩负载里出现 magic 字节不应被误判成帧边界
  const tricky = zstdCompressSync(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x58, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
  assert.equal(scanFrames(tricky).frames.length, 1, '块遍历不会把负载里的 magic 当成帧头');
  assert.deepEqual(decompressMultiFrame(both).toString('utf8'), 'hellohello');
});

test('parseJsonl：坏行保留为 __unparsable__ 而不是丢弃', () => {
  const events = parseJsonl('{"a":1}\nnot json\n\n{"b":2}\n');
  assert.equal(events.length, 3);
  assert.equal(events[0].a, 1);
  assert.equal(events[1].type, '__unparsable__');
  assert.equal(events[2].b, 2);
});

// ---------------------------------------------------------------- slug 编解码
test('slug 编解码：与 DSH 真实目录名逐字一致（含中文与下划线）', () => {
  // 三个真实样例（本机 .dsh/sessions 下实测存在）
  assert.equal(encodeWorkspaceSlug('D:\\Workspace\\dsh_android'), '--D-Workspace-dsh_android--');
  assert.equal(encodeWorkspaceSlug('D:\\Workspace\\canpy'), '--D-Workspace-canpy--');
  assert.equal(encodeWorkspaceSlug('D:\\Workspace\\论文'), '--D-Workspace-~8BBA~6587--', '非 ASCII 每码元 → ~ + 4 位大写 hex');

  assert.equal(decodeWorkspaceSlug('--D-Workspace-dsh_android--'), 'D:\\Workspace\\dsh_android');
  assert.equal(decodeWorkspaceSlug('--D-Workspace-~8BBA~6587--'), 'D:\\Workspace\\论文');
  // 往返：**只对不含 `-` 的路径成立** —— 目录名里的 `-` 与路径分隔符同形，
  // 这是编码本身的固有损失，所以生产路径一律优先用 storages/workspace.json 的权威 path。
  for (const p of ['D:\\Workspace\\dsh_android', 'D:\\a', 'C:\\x\\y']) {
    assert.equal(decodeWorkspaceSlug(encodeWorkspaceSlug(p)), p, `往返失败：${p}`);
  }
  // 有损样例：显式锁住行为，避免以后有人误以为它能还原
  assert.equal(encodeWorkspaceSlug('C:\\x\\y-z'), '--C-x-y-z--');
  assert.equal(decodeWorkspaceSlug('--C-x-y-z--'), 'C:\\x\\y\\z', '含 `-` 的目录名无法还原（已知有损）');
  // 非法输入不抛错：无法还原时返回 null（不猜一个错路径）
  assert.equal(decodeWorkspaceSlug(null), null);
  assert.equal(decodeWorkspaceSlug('nonsense'), null, '既不是盘符形态也没有前导 `-`，无法还原 → null');
  assert.equal(decodeWorkspaceSlug('123'), null);
  assert.equal(decodeWorkspaceSlug('-home-u-proj'), '/home/u/proj', 'POSIX 风格（前导 `-`）按分隔符还原');
});

test('resolveDshHome：优先级 config > DSH_REMOTE_MIRROR_HOME > DSH_HOME > ~/.dsh', () => {
  const env = { DSH_HOME: 'D:\\env-dsh', DSH_REMOTE_MIRROR_HOME: 'D:\\env-mirror' };
  assert.equal(resolveDshHome({ explicit: 'D:\\from-config', env }).source, 'config');
  assert.equal(resolveDshHome({ explicit: 'D:\\from-config', env }).path, 'D:\\from-config');
  assert.equal(resolveDshHome({ env }).path, 'D:\\env-mirror');
  assert.equal(resolveDshHome({ env: { DSH_HOME: 'D:\\env-dsh' } }).path, 'D:\\env-dsh');
  const fallback = resolveDshHome({ env: {}, homedir: 'C:\\Users\\u' });
  assert.equal(fallback.path, path.join('C:\\Users\\u', '.dsh'));
  assert.equal(fallback.source, 'homedir');
});

test('SESSION_DIR_RE：只接受 session-<uuid> 与裸 uuid 形态', () => {
  assert.ok(SESSION_DIR_RE.test('session-88e9459c-260c-4a61-8c2a-bb5f411d3270'));
  assert.ok(SESSION_DIR_RE.test('331ad15b-b54c-4db0-81d6-ce497c589585'));
  assert.ok(!SESSION_DIR_RE.test('..\\..\\windows'));
  assert.ok(!SESSION_DIR_RE.test('session-x'));
  assert.ok(!SESSION_DIR_RE.test('a/b'));
});

// ---------------------------------------------------------------- transcript 投影
/** 构造一段真实形状的事件序列。 */
function fixtureEvents() {
  return [
    { type: 'session', version: 4, id: 'session-test', createdAt: 1000, cwd: 'D:\\ws', delegationDepth: 0, agentPreset: 'standard' },
    { type: 'model/selection', seq: 0, time: 1001, data: { provider: 'p', model: 'm', reasoningEffort: 'max' } },
    { type: 'user/message', seq: 1, time: 1002, data: { content: [{ type: 'text', text: '你好，帮我看看构建' }], source: { kind: 'user' }, role: 'user', id: 'u1' } },
    { type: 'user/message', seq: 2, time: 1003, data: { content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'runtime-context' }, role: 'user', id: 'u2' } },
    { type: 'session/title', seq: 3, time: 1004, data: { title: '构建排障', messageSeqs: [1] } },
    { type: 'turn/start', seq: 4, time: 1005, data: { turn: 1 } },
    { type: 'step/start', seq: 5, time: 1006, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 6, time: 1007, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are an AI agent…' }] } } },
    {
      type: 'assistant/message',
      seq: 7,
      time: 1010,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          id: 'a1',
          content: [
            { type: 'reasoning', text: '先看看 gradle 版本' },
            { type: 'text', text: '我先查 AGP 版本。' },
            { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"gradlew -v","description":"版本"}' },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    },
    { type: 'tool/call', seq: 8, time: 1011, data: { turn: 1, step: 1, callId: 'call_1', name: 'pwsh', arguments: '{"command":"gradlew -v","description":"版本"}' } },
    { type: 'tool/result', seq: 9, time: 1019, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'Gradle 8.9' }], isError: false } } },
    { type: 'tool/call', seq: 10, time: 1020, data: { turn: 1, step: 1, callId: 'call_2', name: 'write', arguments: '{"file_path":"D:\\\\ws\\\\a.txt","content":"x"}' } },
    { type: 'tool/result', seq: 11, time: 1021, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: 'Error: denied' }], isError: true } } },
    { type: 'step/end', seq: 12, time: 1022, data: { turn: 1, step: 1 } },
    { type: 'todo/write', seq: 13, time: 1023, data: { todos: [{ content: '定位失败原因', status: 'completed' }, { content: '改配置', status: 'pending' }] } },
    { type: 'deliverables/presented', seq: 14, time: 1024, data: { turn: 1, callId: 'call_1', files: [{ path: 'out/app.apk', description: '安装包' }] } },
    { type: 'workspace/changes', seq: 15, time: 1025, data: { turn: 1 } },
    { type: 'turn/end', seq: 16, time: 1026, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

test('transcript 投影：用户/助手/工具调用/结果/交付物/待办全部还原，中文原样', () => {
  const events = fixtureEvents();
  const header = events[0];
  const { messages, meta } = projectSession(events, { header });

  assert.equal(meta.id, 'session-test');
  assert.equal(meta.title, '构建排障');
  assert.equal(meta.turns, 1);
  assert.equal(meta.steps, 1);
  assert.deepEqual(meta.lastTurn, { state: 'ended', reason: 'completed' });
  assert.equal(meta.origin, 'user');
  assert.equal(meta.changeCount, 1, 'write 命中 1 个文件');
  assert.equal(meta.hasChanges, true);
  assert.equal(meta.createdAt, 1000);
  assert.equal(meta.updatedAt, 1026);

  const user = messages.find((m) => m.role === 'user');
  assert.equal(user.text, '你好，帮我看看构建', '中文必须原样（不转义）');
  assert.equal(user.seq, 1);

  const assistant = messages.find((m) => m.role === 'assistant' && m.toolCalls.length > 0);
  assert.equal(assistant.text, '我先查 AGP 版本。');
  assert.equal(assistant.reasoning, '先看看 gradle 版本');
  assert.equal(assistant.toolCalls.length, 2, '两个工具调用都挂在这条消息上');

  const call1 = assistant.toolCalls.find((c) => c.id === 'call_1');
  assert.equal(call1.name, 'pwsh');
  assert.deepEqual(call1.args, { command: 'gradlew -v', description: '版本' }, 'arguments 是 JSON 字符串，必须二次解析');
  assert.equal(call1.result, 'Gradle 8.9');
  assert.equal(call1.isError, false);
  assert.equal(call1.durationMs, 8, 'durationMs = tool/result.time - tool/call.time');

  const call2 = assistant.toolCalls.find((c) => c.id === 'call_2');
  assert.equal(call2.isError, true);
  assert.equal(call2.result, 'Error: denied');

  assert.deepEqual(assistant.deliverables, [{ path: 'out/app.apk', description: '安装包' }], '交付物按 callId 归到对应消息');

  const todos = messages.find((m) => m.todos);
  assert.ok(todos, 'todo/write 必须产出一条待办消息');
  assert.equal(todos.todos.length, 2);
  assert.equal(todos.todos[0].status, 'completed');

  // 内部注入默认不可见
  assert.ok(!messages.some((m) => m.text.includes('You are an AI agent')), 'system prompt 默认不进 transcript');
  assert.ok(!messages.some((m) => m.text.includes('Current runtime context')), 'runtime-context 默认不进 transcript');

  // includeInternal 时可拿到
  const withInternal = projectSession(events, { header, includeInternal: true });
  assert.ok(withInternal.messages.some((m) => m.text.includes('You are an AI agent')));
  assert.ok(withInternal.messages.some((m) => m.internal === true));
});

test('transcript 投影：每个 callId 只出现一次（无重复挂载）', () => {
  const base = fixtureEvents();
  // 人为制造顺序异常：tool/call 先到、assistant/message 后到、且缺一条 assistant/message
  const events = [
    base[0],
    { type: 'user/message', seq: 1, time: 1002, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user', id: 'u1' } },
    { type: 'tool/call', seq: 2, time: 1003, data: { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: '{"file_path":"x"}' } },
    { type: 'tool/result', seq: 3, time: 1004, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c9', content: [{ type: 'text', text: 'data' }], isError: false } } },
    { type: 'assistant/message', seq: 4, time: 1005, data: { turn: 1, step: 1, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'ok' }, { type: 'tool-call', id: 'c9', name: 'read', arguments: '{"file_path":"x"}' }] } } },
  ];
  const { messages } = projectSession(events, { header: base[0] });
  const ids = [];
  for (const m of messages) for (const c of m.toolCalls ?? []) ids.push(c.id);
  assert.deepEqual(ids, ['c9'], '同一个 callId 只挂一次');
  const owner = messages.find((m) => m.toolCalls.some((c) => c.id === 'c9'));
  assert.equal(owner.text, 'ok', '归属到含该内容块的 assistant 消息');
  assert.equal(owner.toolCalls[0].result, 'data');
});

test('transcript 投影：消息 id 去重（surfaceOp 重放不产生重复）', () => {
  const base = fixtureEvents();
  const dup = [...base, base.find((e) => e.type === 'user/message'), base.find((e) => e.type === 'assistant/message').type === 'assistant/message' ? base.find((e) => e.type === 'assistant/message') : base.find((e) => e.type === 'assistant/message')];
  const { messages } = projectSession(dup, { header: base[0] });
  const users = messages.filter((m) => m.role === 'user');
  assert.equal(users.length, 1, '同一 user message id 只保留一次');
});

test('transcript 投影：text 超 256 KiB 截断且置 truncated；工具结果只留尾部 32 KiB', () => {
  const big = 'a'.repeat(300 * 1024);
  const events = [
    { type: 'session', id: 's', createdAt: 1, cwd: 'D:\\ws' },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: big }], source: { kind: 'user' }, role: 'user', id: 'u' } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 3,
      data: { turn: 1, step: 1, message: { role: 'assistant', id: 'a', content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }] } },
    },
    { type: 'tool/result', seq: 3, time: 4, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c', content: [{ type: 'text', text: `HEAD${'x'.repeat(40000)}TAIL` }], isError: false } } },
  ];
  const { messages } = projectSession(events, { header: events[0] });
  const user = messages.find((m) => m.role === 'user');
  assert.equal(user.truncated, true);
  assert.ok(Buffer.byteLength(user.text, 'utf8') <= CAPS.messageText);
  const call = messages.flatMap((m) => m.toolCalls).find((c) => c.id === 'c');
  assert.equal(call.truncated, true);
  assert.ok(Buffer.byteLength(call.result, 'utf8') <= CAPS.toolResult);
  assert.ok(call.result.endsWith('TAIL'), '工具结果只保留尾部');
});

test('parseArgs / contentText / safeJson：边界与容错', () => {
  assert.deepEqual(parseArgs('{"a":1}'), { a: 1 });
  assert.deepEqual(parseArgs({ a: 1 }), { a: 1 });
  assert.deepEqual(parseArgs('not json'), { raw: 'not json' });
  assert.deepEqual(parseArgs(''), {});
  assert.deepEqual(parseArgs(null), {});
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  assert.deepEqual(safeJson('x'), { raw: 'x' });

  assert.deepEqual(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), { text: 'ab', truncated: false });
  assert.deepEqual(contentText(undefined), { text: '', truncated: false });
  assert.deepEqual(contentText([{ type: 'reasoning', text: 'r' }, { type: 'text', text: 't' }]), { text: 't', truncated: false });
});

test('paginate：cursor 是排他上界，nextCursor 指向更早的一页', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ seq: i }));
  const tail = paginate(items, { limit: 4 });
  assert.deepEqual(tail.messages.map((m) => m.seq), [6, 7, 8, 9]);
  assert.equal(tail.nextCursor, '6');
  const older = paginate(items, { limit: 4, cursor: tail.nextCursor });
  assert.deepEqual(older.messages.map((m) => m.seq), [2, 3, 4, 5]);
  assert.equal(older.nextCursor, '2');
  const oldest = paginate(items, { limit: 4, cursor: older.nextCursor });
  assert.deepEqual(oldest.messages.map((m) => m.seq), [0, 1]);
  assert.equal(oldest.nextCursor, null, '到最早时 nextCursor 为 null');
  assert.equal(paginate(items, { tail: 3 }).messages.length, 3);
  assert.equal(parseCursor('abc'), 0);
  assert.equal(parseCursor('-5'), 0);
  assert.equal(parseCursor('7'), 7);
});

// ---------------------------------------------------------------- projcache / live
test('readProjCache：解析真实 projcache 行（title/turnBoundary/sessionStats）', async (t) => {
  const home = process.env.USERPROFILE ?? os.homedir();
  const id = 'session-88e9459c-260c-4a61-8c2a-bb5f411d3270';
  try {
    await fs.access(path.join(home, '.dsh', 'storages', 'session_projcache', 'sessions', `${id}.json`));
  } catch {
    t.skip('本机没有该 projcache 样例，跳过');
    return;
  }
  const cache = await readProjCache(path.join(home, '.dsh'), id);
  // 同上：这是仍在增长的真实会话，turns/steps/seq/lastPromptAt 都会随使用继续变化，
  // 只断言字段类型与不变量（下界取"当前快照已知的最小值"，不会随增长失效）。
  assert.equal(typeof cache.title, 'string');
  assert.ok(cache.title.length > 0, '标题非空');
  assert.ok(cache.turns >= 2, `turns 至少 2：${cache.turns}`);
  assert.ok(cache.steps >= 249, `steps 至少 249：${cache.steps}`);
  assert.ok(cache.seq >= 1777, `事件水位应随会话增长：${cache.seq}`);
  assert.ok(cache.openStep === null || Number.isInteger(cache.openStep), 'openStep 为 null 或整数');
  assert.ok(
    cache.openTurnStartSeq === null || Number.isInteger(cache.openTurnStartSeq),
    'openTurnStartSeq 为 null（已收尾）或整数（正在跑）',
  );
  assert.ok(Number.isInteger(cache.lastPromptAt) && cache.lastPromptAt > 0, 'lastPromptAt 为正整数');
  // 运行态是该真实会话的**瞬时**值（本机 DSH 可能正好在写它），所以只断言"与字段一致"，
  // 判定逻辑本身用可控输入验证，避免测试随本机使用而闪断。
  assert.equal(projCacheIsRunning(cache), cache.openTurnStartSeq !== null || cache.openStep !== null);
  assert.equal(projCacheIsRunning({ openTurnStartSeq: null, openStep: null }), false);
  assert.equal(projCacheIsRunning({ openTurnStartSeq: 12, openStep: null }), true);
  assert.equal(projCacheIsRunning({ openTurnStartSeq: null, openStep: 3 }), true);
  // 目录穿越防护
  assert.equal(await readProjCache(path.join(home, '.dsh'), '../../etc/passwd'), null);
});

test('LiveTracker：mtime 下界 + projcache 补漏，taken 优先于 busy', () => {
  const now = 1_000_000;
  const live = new LiveTracker({ windowMs: 60_000, now: () => now });

  assert.equal(live.isLive(now - 1000), true, '契约 §5.4：mtime 60s 内 = live');
  assert.equal(live.isLive(now - 61_000), false);
  assert.equal(live.isBusy({ mtimeMs: now - 1000 }), true);
  assert.equal(live.isBusy({ mtimeMs: 0 }), false);
  assert.equal(live.isBusy({ mtimeMs: 0, projcache: { openTurnStartSeq: 5 } }), true, '在跑但没写盘 → 必须判忙');
  assert.equal(live.isBusy({ mtimeMs: 0, projcache: { openTurnStartSeq: null, openStep: 3 } }), true);
  assert.equal(live.isBusy({ mtimeMs: 0, projcache: { openTurnStartSeq: null, openStep: null, pendingCalls: { c: 1 } } }), true);
  assert.equal(live.isBusy({ mtimeMs: 0, projcache: { openTurnStartSeq: null, openStep: null, pendingCalls: {} } }), false);

  assert.equal(live.acquire({ sessionId: 's1', turnId: 't1' }).ok, true);
  assert.deepEqual(live.admit({ sessionId: 's1', mtimeMs: 0 }), { ok: false, code: 'session_taken', message: '该会话已被本进程的另一个轮次占用：s1' });
  const busy = live.admit({ sessionId: 's2', mtimeMs: now });
  assert.equal(busy.code, 'session_busy');
  assert.equal(live.admit({ sessionId: 's3', mtimeMs: 0 }).ok, true);
  live.release('s1');
  assert.equal(live.isTaken('s1'), false);
});

test('SessionStream：全局 streamSeq 单调、可按 fromSeq 回放、按会话过滤', () => {
  const stream = new SessionStream({ bufferSize: 10, now: () => 1 });
  const a = stream.emit(STREAM_EVENTS.turnStarted, { sessionId: 's1', turn: 1 }, { sessionId: 's1' });
  const b = stream.emit(STREAM_EVENTS.messageDelta, { sessionId: 's1', seq: 7, text: 'x' }, { sessionId: 's1' });
  const c = stream.emit(STREAM_EVENTS.turnEnded, { sessionId: 's2' }, { sessionId: 's2' });
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3], 'streamSeq 全局单调');
  assert.equal(b.streamSeq, 2);
  // payload 里的 DSH seq 不得覆盖总线游标（否则 SSE id/续传游标全错）
  assert.equal(b.dshSeq, 7, 'DSH 事件 seq 存在 dshSeq 上');
  assert.equal(b.seq, 2, '总线游标必须仍为 2');

  const replayed = [];
  stream.subscribe({ fromSeq: 1, onEvent: (ev) => replayed.push(ev.seq) });
  assert.deepEqual(replayed, [2, 3], '回放 seq > fromSeq');

  const only = [];
  stream.subscribeSession({ sessionId: 's1', onEvent: (ev) => only.push(ev.seq) });
  assert.deepEqual(only, [1, 2], '按会话过滤，且不含 s2 的事件');
});

test('mapRunnerLine：把 dsh --json 事件映射为契约 SSE 事件', () => {
  const seqRef = { value: null };
  const out = mapRunnerLine({ type: 'status', phase: 'turn_start', turn: 1 }, { sessionId: 's', fromSeq: 5, seqRef });
  assert.equal(out[0].type, STREAM_EVENTS.turnStarted);
  assert.equal(out[0].data.fromSeq, 5, 'turn.started 带出本轮起始 seq');
  assert.equal(seqRef.value, null, 'turn_start 不消耗事件 seq');

  const text = mapRunnerLine({ type: 'text', text: '你好' }, { sessionId: 's', fromSeq: 5, seqRef });
  assert.equal(text[0].type, STREAM_EVENTS.messageDelta);
  assert.equal(text[0].data.text, '你好');
  assert.equal(text[0].data.seq, 5, '第一条增量就是 fromSeq（submit 已算好"下一个事件 seq"）');
  const text2 = mapRunnerLine({ type: 'text', text: '再一句' }, { sessionId: 's', fromSeq: 5, seqRef });
  assert.equal(text2[0].data.seq, 6, '后续递增');

  const end = mapRunnerLine({ type: 'status', phase: 'turn_end', turn: 2, reason: { kind: 'completed' } }, { sessionId: 's', fromSeq: 5, seqRef });
  assert.equal(end[0].type, STREAM_EVENTS.turnEnded);
  assert.equal(end[0].data.reason, 'completed');

  const stepEnd = mapRunnerLine({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 1 } }, { sessionId: 's', fromSeq: 5, seqRef });
  assert.equal(stepEnd[0].type, STREAM_EVENTS.sessionUpdated);

  assert.deepEqual(mapRunnerLine({ type: 'unknown-thing' }, { sessionId: 's' }), []);
  assert.deepEqual(mapRunnerLine(null, { sessionId: 's' }), []);
  // 空 thinking/text 不产生噪声帧
  assert.deepEqual(mapRunnerLine({ type: 'thinking', text: '' }, { sessionId: 's' }), []);
});

// ---------------------------------------------------------------- 路径安全
test('isUncPath / hasAlternateDataStream：UNC 与 NTFS ADS 必须被识别', () => {
  assert.equal(isUncPath('\\\\server\\share\\x'), true);
  assert.equal(isUncPath('//server/share'), true);
  assert.equal(isUncPath('D:\\ws\\x'), false);
  assert.equal(isUncPath('/api/v2'), false);
  assert.equal(hasAlternateDataStream('D:\\ws\\notes.txt:secret'), true);
  assert.equal(hasAlternateDataStream('D:\\ws\\notes.txt'), false);
  assert.equal(hasAlternateDataStream('/home/u/a:b'), true, 'POSIX 路径里的冒号也拒绝');
});

test('resolveTarget：工作区内放行，`..` 穿越/UNC/ADS/白名单外全部 403', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-sec-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  await fs.mkdir(path.join(ws, 'sub'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(ws, 'a.txt'), 'hello', 'utf8');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
  // 真符号链接指向工作区之外（Windows 上目录联接需要权限，失败则跳过该断言）
  let linkOk = false;
  try {
    await fs.symlink(outside, path.join(ws, 'escape'), 'junction');
    linkOk = true;
  } catch {
    linkOk = false;
  }
  const allowlist = [ws];

  const ok = await resolveTarget({ requestPath: 'a.txt', workspace: ws, allowlist });
  assert.equal(ok.isFile, true);
  assert.equal(ok.realPath.toLowerCase(), path.join(ws, 'a.txt').toLowerCase());

  const rel = await resolveTarget({ requestPath: 'sub', workspace: ws, allowlist });
  assert.equal(rel.isDir, true);

  await assert.rejects(
    () => resolveTarget({ requestPath: '..\\outside\\secret.txt', workspace: ws, allowlist }),
    (err) => err.code === 'workspace_outside',
    '.. 穿越必须 403 workspace_outside',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: outside, workspace: ws, allowlist }),
    (err) => err.code === 'workspace_outside',
    '工作区外的绝对路径必须 403',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: '\\\\server\\share\\x', workspace: ws, allowlist }),
    (err) => err.code === 'workspace_outside',
    'UNC 必须 403',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: 'a.txt:secret', workspace: ws, allowlist }),
    (err) => err.code === 'workspace_outside',
    'NTFS ADS 必须 403',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: 'nope.txt', workspace: ws, allowlist, mustExist: true }),
    (err) => err.code === 'not_found',
  );
  await assert.rejects(
    () => resolveTarget({ requestPath: 'a.txt', workspace: outside, allowlist }),
    (err) => err.code === 'workspace_outside',
    '工作区本身不在白名单内也必须拒绝',
  );

  if (linkOk) {
    await assert.rejects(
      () => resolveTarget({ requestPath: 'escape\\secret.txt', workspace: ws, allowlist }),
      (err) => err.code === 'workspace_symlink_escape',
      '符号链接逃逸必须在 realpath 检查处被拦下（写/默认模式；错误码与纯越界区分开）',
    );
    // 同一路径在读模式下必须放行（读放行、写拒绝），否则"工作区里的 junction 进不去"
    const readEscaped = await resolveTarget({ requestPath: 'escape\\secret.txt', workspace: ws, allowlist, mode: 'read' });
    assert.equal(readEscaped.isFile, true, '读模式必须能读到链接指向的文件');
    assert.equal(readEscaped.escaped, true, '读模式必须如实标记"经链接跑到根外"');
    assert.equal(readEscaped.escapedTo?.toLowerCase(), path.join(outside, 'secret.txt').toLowerCase());
  } else {
    t.diagnostic('无法创建 junction，跳过符号链接逃逸断言（Windows 权限）');
  }
});

test('looksBinary / guessMime：二进制嗅探与 MIME 猜测', () => {
  assert.equal(looksBinary(Buffer.from([0x00, 0x01])), true);
  assert.equal(looksBinary(Buffer.from('hello', 'utf8')), false);
  assert.equal(guessMime('a.mjs'), 'text/javascript');
  assert.equal(guessMime('a.apk'), 'application/vnd.android.package-archive');
  assert.equal(guessMime('a.unknown'), 'application/octet-stream');
});

// ---------------------------------------------------------------- git 解析
test('parsePorcelainZ：M/A/D/??/重命名 与 staged 判定', () => {
  const raw = 'M  a.txt\0 M b.txt\0?? c.txt\0A  d.txt\0D  e.txt\0R  f.txt\0g.txt\0';
  const { changed, untracked } = parsePorcelainZ(raw);
  assert.deepEqual(untracked, ['c.txt']);
  const byPath = Object.fromEntries(changed.map((c) => [c.path, c]));
  assert.equal(byPath['a.txt'].status, 'M');
  assert.equal(byPath['a.txt'].staged, true, 'X 位非空格 → staged');
  assert.equal(byPath['b.txt'].staged, false, '只看工作区 → 未暂存');
  assert.equal(byPath['d.txt'].status, 'A');
  assert.equal(byPath['e.txt'].status, 'D');
  assert.equal(byPath['g.txt'], undefined, '重命名时的原路径记录必须被跳过');
  assert.equal(byPath['f.txt'].status, 'R', '重命名取新路径（porcelain -z：<new>\\0<old>\\0）');
  assert.equal(changed.length, 5);
});

test('parseNumstatZ / mergeNumstat：增删行数、二进制标记、工作区+暂存相加', () => {
  const unstaged = parseNumstatZ('10\t2\ta.txt\0-\t-\tbin.png\0');
  assert.equal(unstaged.get('a.txt'.toLowerCase()).insertions, 10);
  assert.equal(unstaged.get('bin.png'.toLowerCase()).isBinary, true);
  const staged = parseNumstatZ('3\t1\ta.txt\0');
  const merged = mergeNumstat([unstaged, staged]);
  const a = merged.get('a.txt'.toLowerCase());
  assert.equal(a.insertions, 13, '工作区 + 暂存相加');
  assert.equal(a.deletions, 3);
  assert.equal(merged.get('bin.png'.toLowerCase()).isBinary, true);
});

test('noneVcs：非 git 目录的标准降级响应（不报错）', () => {
  const out = noneVcs('D:\\not-a-repo');
  assert.equal(out.vcs, 'none');
  assert.deepEqual(out.changed, []);
  assert.deepEqual(out.untracked, []);
  assert.equal(out.clean, null);
  assert.equal(out.branch, null);
});

// ---------------------------------------------------------------- WebSocket
test('acceptKey：RFC 6455 §1.3 官方示例向量', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame/FrameDecoder：文本往返、客户端掩码、服务端无掩码', () => {
  const decoder = new FrameDecoder();
  const masked = encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('你好 Hello', 'utf8'), mask: true });
  assert.equal((masked[1] & 0x80) !== 0, true, '客户端帧必须带掩码');
  const frames = decoder.push(masked);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, OPCODE.text);
  assert.equal(frames[0].payload.toString('utf8'), '你好 Hello');

  const plain = encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('server', 'utf8'), mask: false });
  assert.equal((plain[1] & 0x80) !== 0, false, '服务端帧不得带掩码');
  const decoded = new FrameDecoder().push(plain);
  assert.equal(decoded[0].payload.toString('utf8'), 'server');
});

test('FrameDecoder：跨 TCP 包半帧、分片重组、ping/pong/close、大帧（126/127 长度）', () => {
  // 半帧：逐字节喂入
  const full = encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('分片测试', 'utf8'), mask: true });
  const byteWise = new FrameDecoder();
  const collected = [];
  for (const byte of full) collected.push(...byteWise.push(Buffer.from([byte])));
  assert.equal(collected.length, 1);
  assert.equal(collected[0].payload.toString('utf8'), '分片测试');

  // 分片：text(first, fin=false) + continuation(fin=true)
  const frag = Buffer.concat([
    encodeFrame({ fin: false, opcode: OPCODE.text, payload: Buffer.from('part1-', 'utf8'), mask: true }),
    encodeFrame({ fin: true, opcode: OPCODE.continuation, payload: Buffer.from('part2', 'utf8'), mask: true }),
  ]);
  const assembled = new FrameDecoder().push(frag);
  assert.equal(assembled.length, 1, '分片重组为一条消息');
  assert.equal(assembled[0].payload.toString('utf8'), 'part1-part2');

  // 控制帧：ping/pong 不被分片状态影响
  const control = new FrameDecoder().push(encodeFrame({ opcode: OPCODE.ping, payload: Buffer.from('hb'), mask: true }));
  assert.equal(control[0].opcode, OPCODE.ping);
  assert.equal(control[0].payload.toString('utf8'), 'hb');

  // 长度 126（>125 → 2 字节扩展长度）
  const medium = Buffer.alloc(300, 0x41);
  const med = new FrameDecoder().push(encodeFrame({ opcode: OPCODE.text, payload: medium, mask: true }));
  assert.equal(med[0].payload.length, 300);

  // 长度 127（>65535 → 8 字节扩展长度）
  const large = Buffer.alloc(70_000, 0x42);
  const big = new FrameDecoder({ maxPayloadBytes: 200_000 }).push(encodeFrame({ opcode: OPCODE.text, payload: large, mask: true }));
  assert.equal(big[0].payload.length, 70_000);
});

test('FrameDecoder：非法帧（控制帧分片、超大负载、保留块类型、未知 opcode）被拒绝', () => {
  const errors = [];
  const mk = () => new FrameDecoder({ maxPayloadBytes: 100, onProtocolError: (m) => errors.push(m) });

  // 控制帧 fin=false
  const badControl = Buffer.concat([Buffer.from([0x09, 0x00])]);
  assert.deepEqual(mk().push(badControl), []);
  assert.ok(errors.some((m) => m.includes('控制帧不得分片')));

  // 超大负载：长度 127 声明 1 MiB
  const huge = Buffer.alloc(20);
  huge[0] = 0x81;
  huge[1] = 127;
  huge.writeBigUInt64BE(BigInt(1024 * 1024), 2);
  assert.deepEqual(mk().push(huge), []);
  assert.ok(errors.some((m) => m.includes('超过上限')));

  // 保留 opcode
  assert.deepEqual(mk().push(Buffer.from([0x83, 0x00])), []);
  assert.ok(errors.some((m) => m.includes('未知 opcode')));

  // RSV 位非零（未协商扩展）
  assert.deepEqual(mk().push(Buffer.from([0xc1, 0x00])), []);
  assert.ok(errors.some((m) => m.includes('RSV')));
});

test('WebSocketClient：非 ws 协议与非法 URL 直接拒绝，不发起连接', async () => {
  await assert.rejects(() => new WebSocketClient({ url: 'http://example.com' }).connect(), /ws:\/\/ 或 wss:\/\//);
  await assert.rejects(() => new WebSocketClient({ url: 'not a url' }).connect(), /非法的 WebSocket URL/);
  const client = new WebSocketClient({ url: 'ws://127.0.0.1:1/x' });
  assert.equal(client.isOpen, false);
  assert.equal(client.bufferedAmount, 0);
  assert.equal(client.send('x'), false, '未连接时发送返回 false 而不抛错');
});

test('WebSocketHandshakeError：携带状态码与响应体，便于给出可读原因', () => {
  const err = new WebSocketHandshakeError(401, '{"error":"nope"}', {});
  assert.equal(err.statusCode, 401);
  assert.match(err.message, /HTTP 401/);
  assert.match(err.message, /nope/);
});

// ---------------------------------------------------------------- relay 客户端工具
test('normalizeRelayUrl：ws/wss/http/https/裸 host:port 归一化', () => {
  assert.deepEqual(normalizeRelayUrl('http://127.0.0.1:9443'), { base: 'http://127.0.0.1:9443', wsUrl: 'ws://127.0.0.1:9443/api/v2/tunnel/home', secure: false });
  assert.deepEqual(normalizeRelayUrl('ws://r.example.com:9443'), { base: 'http://r.example.com:9443', wsUrl: 'ws://r.example.com:9443/api/v2/tunnel/home', secure: false });
  const tls = normalizeRelayUrl('https://r.example.com');
  assert.equal(tls.wsUrl, 'wss://r.example.com/api/v2/tunnel/home');
  assert.equal(tls.secure, true);
  assert.equal(normalizeRelayUrl('127.0.0.1:9443').base, 'http://127.0.0.1:9443');
  assert.equal(normalizeRelayUrl('wss://r/x', '/api/v2/tunnel/device').wsUrl, 'wss://r/x/api/v2/tunnel/device');
  assert.throws(() => normalizeRelayUrl(''), /未配置/);
});

test('backoffDelay：1s→30s 指数退避并封顶，带抖动', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map((n) => backoffDelay(n, { jitter: 0 })), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  // 抖动范围：±20%
  for (let i = 0; i < 50; i++) {
    const v = backoffDelay(3, { minMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.2 });
    assert.ok(v >= 3200 && v <= 4800, `抖动越界：${v}`);
  }
  assert.equal(backoffDelay(100, { minMs: 1000, maxMs: 30_000, jitter: 0 }), 30_000, '封顶 30s');
});

test('sliceBuffer：按上限切片且不越界（契约 §3.2 单 chunk ≤ 256 KiB）', () => {
  const buf = Buffer.alloc(1000, 1);
  const parts = sliceBuffer(buf, 256);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map((p) => p.length), [256, 256, 256, 232]);
  assert.equal(Buffer.concat(parts).length, 1000);
  assert.deepEqual(sliceBuffer(Buffer.alloc(10), 256).map((p) => p.length), [10]);
});

// ---------------------------------------------------------------- session-runner 纯函数
test('parseDshLauncher：从真实 dsh.cmd 形状抽出 exe + cli.js + flags', () => {
  const cmdText = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
    'exit /b %errorlevel%',
  ].join('\r\n');
  const spec = parseDshLauncher(cmdText, 'D:\\DSH\\resources\\runtime\\cli\\bin');
  assert.ok(spec, '必须解析成功');
  assert.equal(spec.command, 'D:\\DSH\\DeepSeek Harness.exe', '`..` 必须被归一化');
  assert.equal(spec.scriptPath, 'D:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js');
  assert.deepEqual(spec.prefixArgs, ['--expose-internals']);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');

  // POSIX shim：interpreter 是 node，路径必须原样保留（不能被 Windows 的 path.resolve 改写）
  const sh = '#!/bin/sh\nexec node "/opt/dsh/lib/cli.js" "$@"\n';
  const shSpec = parseDshLauncher(sh, '/opt/dsh/bin');
  assert.equal(shSpec.command, 'node');
  assert.equal(shSpec.scriptPath, '/opt/dsh/lib/cli.js', 'POSIX 路径不得被改写成 D:\\opt\\…');
  assert.deepEqual(shSpec.prefixArgs, []);

  assert.equal(parseDshLauncher('echo hi', 'D:\\x'), null);
  assert.equal(parseDshLauncher('', 'D:\\x'), null);
});

test('resolveDshLaunch：显式覆盖 > launcher 解析 > v1 兜底', () => {
  const explicit = resolveDshLaunch({
    dsh: { electronPath: 'D:\\e.exe', cliPath: 'D:\\c.js', exeArgs: ['--x'] },
    env: {},
    existsSync: () => false,
    readFileSync: () => '',
  });
  assert.equal(explicit.command, 'D:\\e.exe');
  assert.deepEqual(explicit.argsPrefix, ['--x', 'D:\\c.js']);
  assert.equal(explicit.source, 'explicit');
  assert.equal(explicit.supportsSdk, true);

  const viaLauncher = resolveDshLaunch({
    dsh: { launcher: 'D:\\fake\\dsh.cmd' },
    env: {},
    existsSync: (p) => p === 'D:\\fake\\dsh.cmd',
    readFileSync: () => '"%~dp0..\\e.exe" --expose-internals "%~dp0..\\c.js" %*',
  });
  assert.equal(viaLauncher.source, 'launcher:D:\\fake\\dsh.cmd');
  assert.equal(viaLauncher.supportsSdk, true);
  assert.equal(viaLauncher.env.ELECTRON_RUN_AS_NODE, '1', 'Electron 必须跑在 node 模式');

  const fallback = resolveDshLaunch({ dsh: { node: 'D:\\node.exe', binPath: 'D:\\bin.js' }, env: {}, existsSync: () => false, readFileSync: () => '' });
  assert.equal(fallback.source, 'node+binPath(v1)');
  assert.equal(fallback.supportsSdk, false, '旧版 CLI 不具备 SDK JSON-RPC 能力，必须显式标记');

  const none = resolveDshLaunch({ dsh: {}, env: {}, existsSync: () => false, readFileSync: () => '' });
  assert.equal(none.command, null);
  assert.equal(none.supportsSdk, false);
});

test('readCredentialEnv：从 .credentials.yaml 的 refs 段取出 key，不越段取值', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-cred-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.credentials.yaml');
  await fs.writeFile(
    file,
    ['version: 1', 'refs:', '  DEEPSEEK_API_KEY: sk-abc123', 'records:', '  DEEPSEEK_API_KEY: sk-should-not-be-read', '  other:', '    x: DEEPSEEK_API_KEY: no'].join('\n'),
    'utf8',
  );
  assert.deepEqual(await readCredentialEnv({ file, name: 'DEEPSEEK_API_KEY' }), { DEEPSEEK_API_KEY: 'sk-abc123' });
  assert.deepEqual(await readCredentialEnv({ file, name: 'MISSING' }), {});
  assert.deepEqual(await readCredentialEnv({ file: path.join(dir, 'nope.yaml'), name: 'X' }), {});
  assert.deepEqual(await readCredentialEnv({ file: null, name: 'X' }), {});

  // 引号包裹
  await fs.writeFile(file, 'refs:\n  K: "quoted-value"\n', 'utf8');
  assert.deepEqual(await readCredentialEnv({ file, name: 'K' }), { K: 'quoted-value' });
});

test('assistantFrames：优先用 stream 的 text-chunks 做真流式，退回整段文本；附带 tool.call', () => {
  const streamed = assistantFrames({
    seq: 15,
    data: {
      message: { content: [{ type: 'text', text: '完成' }, { type: 'tool-call', id: 'c1', name: 'write', arguments: '{"file_path":"a"}' }] },
      stream: [
        { type: 'chunk', chunk: { type: 'block-start' } },
        { type: 'text-chunks', texts: ['完', '成'] },
        { type: 'chunk', chunk: { type: 'block-end' } },
      ],
    },
  });
  const deltas = streamed.filter((f) => f.type === STREAM_EVENTS.messageDelta);
  assert.deepEqual(deltas.map((d) => d.data.text), ['完成'], 'text-chunks 合并为一条增量');
  assert.equal(deltas[0].data.seq, 15);
  const calls = streamed.filter((f) => f.type === STREAM_EVENTS.toolCall);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].data.args, { file_path: 'a' }, 'arguments 字符串必须被解析');

  // 没有 stream 时退回整段
  const plain = assistantFrames({ seq: 1, data: { message: { content: [{ type: 'text', text: '整段' }] } } });
  assert.deepEqual(plain.map((f) => f.data.text), ['整段']);
  // 空文本不产生 delta
  assert.deepEqual(assistantFrames({ seq: 1, data: { message: { content: [{ type: 'text', text: '' }] } } }), []);
});

// ---------------------------------------------------------------- relay 注册 TLS（自签）
test('relay 注册：postJson 必须尊重 relay.tls（自签中继否则完全注册不上）', async (t) => {
  // 用中继侧真实的证书生成器造一张自签证书：这是"真 TLS 握手"的回归，
  // 不是对选项对象的白盒断言。模块不可用时跳过（不制造对其他包的硬依赖）。
  let tlsMod;
  try {
    tlsMod = await import('../../dsh-relay/lib/tls.mjs');
  } catch {
    t.skip('无法加载 tools/dsh-relay/lib/tls.mjs，跳过自签 TLS 回归');
    return;
  }
  const { generateSelfSignedCertificate, toPem } = tlsMod;
  // altNames 元素形状是 `{type:'dns'|'ip', value}`（见 tls.mjs 的 derSubjectAltName）
  const material = generateSelfSignedCertificate({
    commonName: '127.0.0.1',
    altNames: [{ type: 'ip', value: '127.0.0.1' }, { type: 'dns', value: 'localhost' }],
  });
  // `material.cert` / `material.key` 本身就是 PEM 字符串（中继直接把它们写文件）；
  // 只有拿到 DER 时才需要 toPem 兜底。
  const asPem = (value, label) => (typeof value === 'string' && value.includes('-----BEGIN') ? value : toPem(value, label));
  const certPem = asPem(material.cert, 'CERTIFICATE');
  const keyPem = asPem(material.key, 'PRIVATE KEY');
  const https = await import('node:https');
  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ homeId: 'home_selfsigned', homeToken: 'homeToken_selfsigned', relayName: 'relay.selfsigned.test' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `https://127.0.0.1:${port}/api/v2/homes`;

  // 1) 旧行为（不传 tls）→ 必须因自签证书失败：这正是"wss 场景完全不可用"的成因
  await assert.rejects(
    () => postJson(url, '{}', { timeoutMs: 5000 }),
    (err) => /self-signed|self signed|certificate|unable to verify|DEPTH_ZERO|SELF_SIGNED/i.test(String(err?.message ?? err)),
    '不传 tls 时必须因自签证书被拒（复现旧缺陷）',
  );

  // 2) 显式信任自签 → 必须成功（修复后的行为）
  const trusted = await postJson(url, '{}', { timeoutMs: 5000, tls: { rejectUnauthorized: false } });
  assert.equal(trusted.status, 200);
  assert.equal(trusted.json.homeId, 'home_selfsigned');

  // 3) 显式要求校验 → 必须失败（开关真的有作用，不是无条件放行）
  await assert.rejects(() => postJson(url, '{}', { timeoutMs: 5000, tls: { rejectUnauthorized: true } }));

  // 4) 端到端：RelayClient 用同一份 relay.tls 完成注册并把凭据落盘
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-tls-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  await fs.mkdir(path.join(home, 'logs'), { recursive: true });
  const cfg = validateConfig(
    mergeConfig(defaultConfig({}), {
      host: '127.0.0.1',
      port: 0,
      dshHome: home,
      relay: { enabled: true, url: `wss://127.0.0.1:${port}`, homeName: 'tls-test', tls: { rejectUnauthorized: false, ca: null } },
      log: { toConsole: false },
    }),
    { env: {} },
  );
  const client = new RelayClient({ config: cfg, logger: createLogger({ dir: null, toConsole: false }) });
  const result = await client.connect();
  // 隧道握手会失败（这台 HTTPS 服务器不升级 WS），但**注册必须已经成功**
  assert.equal(client.homeId, 'home_selfsigned', `注册失败：${result.error ?? ''}`);
  assert.equal(client.homeToken, 'homeToken_selfsigned');
  const stateFile = path.join(cfg.home, 'relay.json');
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(saved.homeToken, 'homeToken_selfsigned', 'homeToken 必须持久化到 relay.json');
  assert.equal(saved.homeId, 'home_selfsigned');
  assert.notEqual(result.error, undefined, 'WS 隧道握手应失败（该服务器不升级 WS），但注册已成功');
  await client.shutdown();
});

test('relay：响应头过滤逐跳头（避免手机侧双重分帧歧义）', () => {
  const flat = flattenHeaders({
    'content-type': 'text/event-stream',
    'transfer-encoding': 'chunked',
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    upgrade: 'websocket',
    'proxy-authenticate': 'x',
    'x-custom': ['a', 'b'],
    'content-length': 12,
  });
  assert.equal(flat['transfer-encoding'], undefined, 'transfer-encoding 是逐跳头，必须过滤');
  assert.equal(flat.connection, undefined);
  assert.equal(flat['keep-alive'], undefined);
  assert.equal(flat.upgrade, undefined);
  assert.equal(flat['proxy-authenticate'], undefined);
  assert.equal(flat['content-type'], 'text/event-stream');
  assert.equal(flat['x-custom'], 'a, b', '数组要拍平成逗号分隔');
  assert.equal(flat['content-length'], '12');
});

test('ws：同一次断开只 emit 一次 close（否则上层会多排一次重连）', async (t) => {
  const net = await import('node:net');
  const crypto = await import('node:crypto');
  // 极简 WS 服务端：完成握手 → 立刻发 close 帧 → 关闭 TCP。
  // 这不 mock 传输层，走的正是"对端 close 帧 + socket 关闭"这条双触发路径。
  const server = net.createServer((socket) => {
    let buf = '';
    let handshaken = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (handshaken) return; // 客户端回 close 帧时会再次触发 data，不能重复写
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      handshaken = true;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(buf.slice(0, end))?.[1] ?? '';
      const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      // 然后发一帧 close（code 1000）并关闭 TCP → 触发"close 帧 + socket 关闭"双路径
      setTimeout(() => {
        if (socket.destroyed) return;
        socket.write(encodeFrame({ opcode: OPCODE.close, payload: Buffer.from([0x03, 0xe8]), mask: false }));
        socket.end();
      }, 20);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const client = new WebSocketClient({ url: `ws://127.0.0.1:${port}/x`, handshakeTimeoutMs: 3000 });
  const closes = [];
  const errors = [];
  client.on('close', (code) => closes.push(code));
  client.on('error', (err) => errors.push(err));
  await client.connect();
  await new Promise((resolve) => {
    client.on('close', resolve);
    setTimeout(resolve, 2000);
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(closes.length, 1, `同一次断开只能 emit 一次 close（实际 ${closes.length} 次：${JSON.stringify(closes)}）`);
  assert.equal(closes[0], 1000, 'close code 必须是收到的那一个');
  assert.equal(client.readyState, 'closed');
  client.terminate();
});
test('relay 安全红线：enabled 且 host 非回环 → 拒绝启动（契约 §5.5.1）', () => {
  assert.throws(
    () => validateConfig(mergeConfig(defaultConfig({}), { relay: { enabled: true, url: 'ws://127.0.0.1:9443' } }), { env: {} }),
    (err) => err instanceof ConfigError && /回环地址/.test(err.message) && /allowNonLoopback/.test(err.message),
    '默认 host=0.0.0.0 + relay.enabled 必须拒绝，且错误里给出两条出路',
  );
  // 逃生舱：显式 allowNonLoopback 才放行，并标记风险
  const escaped = validateConfig(mergeConfig(defaultConfig({}), { relay: { enabled: true, url: 'ws://x:1', allowNonLoopback: true } }), { env: {} });
  assert.equal(escaped.relay._nonLoopbackAccepted, true);
  // 回环则正常
  const ok = validateConfig(mergeConfig(defaultConfig({}), { host: '127.0.0.1', relay: { enabled: true, url: 'ws://127.0.0.1:9443' } }), { env: {} });
  assert.equal(ok.relay.enabled, true);
  assert.equal(ok.relayStateFile, path.join(ok.home, 'relay.json'));
  // 未启用时不影响 v1 默认（0.0.0.0 保持）
  assert.equal(validateConfig(defaultConfig({}), { env: {} }).host, '0.0.0.0');
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.5'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.5'), false);
});

test('v2 配置：apiVersion 恒为 1 + supportedApiVersions；会话双根；SDK 键校验', () => {
  const cfg = validateConfig(defaultConfig({}), { env: {} });
  assert.equal(cfg.apiVersion, 1, 'apiVersion 是 v1 端点的版本号，不得为 2');
  assert.deepEqual(cfg.supportedApiVersions, [1, 2]);
  assert.equal(cfg.mirror.enabled, true);
  assert.deepEqual(cfg.sessionRoots.map((r) => r.source), ['phone', 'computer']);
  assert.equal(cfg.sessionRoots[0].writable, true);
  assert.equal(cfg.sessionRoots[1].writable, false, '镜像根必须只读');
  assert.equal(cfg.dsh.sessionsHome, path.join(cfg.home, 'dsh-home'), 'SDK 会话 home 默认在网关 home 下');
  assert.notEqual(path.resolve(cfg.dsh.sessionsHome), path.resolve(cfg.home), 'SDK 会话 home 不能等于网关 home');
  assert.equal(cfg.sessionStream.heartbeatMs, 15_000, '契约 §4.2：SSE 心跳 15s');
  assert.equal(cfg.mirror.liveWindowMs, 60_000, '契约 §5.4：live 窗口 60s');

  // mirror.enabled=false → 只剩 phone 根
  const noMirror = validateConfig(mergeConfig(defaultConfig({}), { mirror: { enabled: false } }), { env: {} });
  assert.deepEqual(noMirror.sessionRoots.map((r) => r.source), ['phone']);

  // dsh.sessionsHome 不能等于网关运行时 home（否则 SDK 会话会和 devices.json/logs 混在一起）
  assert.throws(
    () => validateConfig(mergeConfig(defaultConfig({}), { dshHome: 'D:\\gw', dsh: { sessionsHome: 'D:\\gw' } }), { env: {} }),
    (err) => err instanceof ConfigError && /不能等于网关运行时 home/.test(err.message),
  );
  // sessionsHome 指向别处则放行
  const elsewhere = validateConfig(mergeConfig(defaultConfig({}), { dshHome: 'D:\\gw', dsh: { sessionsHome: 'D:\\gw-sessions' } }), { env: {} });
  assert.equal(elsewhere.dsh.sessionsHome, 'D:\\gw-sessions');
  assert.throws(() => validateConfig(mergeConfig(defaultConfig({}), { dsh: { provider: '' } }), { env: {} }), /provider/);
  assert.throws(() => validateConfig(mergeConfig(defaultConfig({}), { dsh: { maxTokens: -1 } }), { env: {} }), /maxTokens/);
  assert.throws(() => validateConfig(mergeConfig(defaultConfig({}), { mirror: { liveWindowMs: 1 } }), { env: {} }), /liveWindowMs/);
  assert.throws(() => validateConfig(mergeConfig(defaultConfig({}), { relay: { enabled: true, url: '' , allowNonLoopback: true } }), { env: {} }), /relay\.url/);
  assert.throws(() => validateConfig(mergeConfig(defaultConfig({}), { relay: { url: 'ftp://x' } }), { env: {} }), /relay\.url 非法/);
});

test('workspaceIndex：读取 storages/workspace.json 得到权威 slug→路径映射', async (t) => {
  const home = process.env.USERPROFILE ?? os.homedir();
  try {
    await fs.access(path.join(home, '.dsh', 'storages', 'workspace.json'));
  } catch {
    t.skip('本机没有 workspace.json，跳过');
    return;
  }
  const index = await readWorkspaceIndex(path.join(home, '.dsh'));
  assert.ok(index.paths.length >= 1);
  assert.ok(index.bySlug.has('--D-Workspace-dsh_android--'), 'slug→路径索引必须含实测样例');
  assert.equal(index.bySlug.get('--D-Workspace-dsh_android--'), 'D:\\Workspace\\dsh_android');
  assert.ok(index.bySlug.get('--D-Workspace-~8BBA~6587--'), '中文路径也能映射（有损解码的不确定性由它兜底）');
});

test('makeSandbox 冒烟：v2 会话根被正确装配（不触碰真实 ~/.dsh）', async (t) => {
  const sandbox = await makeSandbox(t, {}, { autoCleanup: true });
  assert.equal(sandbox.config.sessionRoots[0].source, 'phone');
  assert.ok(sandbox.config.sessionRoots[0].home.startsWith(sandbox.root), 'SDK 会话 home 必须落在沙箱内');
  // 沙箱内的 phone 根目录可能还不存在（首次创建会话时才建），这里只断言路径归属
  assert.equal(path.resolve(sandbox.config.dsh.sessionsHome), path.join(sandbox.home, 'dsh-home'));
});
