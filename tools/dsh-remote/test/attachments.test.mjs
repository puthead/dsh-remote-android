/**
 * 附件对象库测试（契约 §4.6，v2.9.0）。
 *
 * 覆盖四层，**每层都要能单独失败**（混在一起测的话，"归一化把大小写改对了"这种结论
 * 会被"HTTP 正好命中"掩盖过去）：
 * 1. 纯函数：id 归一化 / 形状卡死 / 魔数嗅探；
 * 2. 目录探测：多 home 根、多版本目录、越界形状；
 * 3. HTTP：200 的四个响应头 + 字节逐字一致、400/404/413 三种失败、鉴权与方法；
 * 4. 投影：`user/message`、`assistant/message`、`tool/result` 三处的图片引用与 `turn` 戳。
 *
 * 全部用 `mkdtemp` 造合成 home，**绝不碰**真实 `~/.dsh` 的对象库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import {
  ATTACHMENT_ID_RE,
  ATTACHMENT_MAX_BYTES,
  normalizeAttachmentId,
  resolveAttachment,
  sniffMediaType,
} from '../lib/attachments.mjs';
import { projectSession } from '../lib/session-reader.mjs';
import { encodeWorkspaceSlug } from '../lib/dsh-home.mjs';
import { SEEDED_SESSION_ID, SEEDED_TOOL_IMAGE_ID, SEEDED_USER_IMAGE_ID, seedAttachmentObject, startV2 } from './v2-harness.mjs';

// ---------------------------------------------------------------------------
// 合成字节：每种魔数都造一份，且**不是合法图片**也无所谓 —— 嗅探只看前 12 字节
// ---------------------------------------------------------------------------

/** 结构合法的极小 PNG（签名 + IHDR + IEND，CRC 正确）。 */
function pngBytes(width = 2, height = 2) {
  const chunk = (type, data) => {
    const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(head), 0);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, head, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 0x11)]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(24, 0x22)]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ', 'ascii'), Buffer.alloc(16, 0x33)]);
const UNKNOWN_BYTES = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(24, 0x44)]);

/** 造一个临时 home 根；`t.after` 负责清理。 */
async function makeRoot(t, label) {
  const dir = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', `dshr-att-${label}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// 1. id 归一化与形状卡死
// ---------------------------------------------------------------------------

test('attachments：normalizeAttachmentId 接受三种写法并统一成小写前缀形式', () => {
  assert.equal(normalizeAttachmentId(`sha256:${HEX_A}`), `sha256:${HEX_A}`);
  assert.equal(normalizeAttachmentId(HEX_A), `sha256:${HEX_A}`, '裸 64 位 hex 要补前缀');
  assert.equal(normalizeAttachmentId(`SHA256:${HEX_A.toUpperCase()}`), `sha256:${HEX_A}`, '大小写混写要统一成小写');
  assert.equal(normalizeAttachmentId(`  sha256:${HEX_A}  `), `sha256:${HEX_A}`, '首尾空白要容忍（日志里出现过）');
  assert.equal(normalizeAttachmentId(`sha256:${'A'.repeat(64)}`), `sha256:${HEX_A}`);
});

test('attachments：非法 id 一律 null（路径穿越、分隔符、长度不对、非 hex）', () => {
  const bad = [
    null,
    undefined,
    123,
    '',
    '   ',
    'sha256:',
    'sha256:' + 'a'.repeat(63),
    'sha256:' + 'a'.repeat(65),
    'sha256:' + 'g'.repeat(64),
    'md5:' + HEX_A,
    // 下面这些是**安全红线**：任何一条被放行，`resolveAttachment` 就会把用户输入拼进路径
    'sha256:../../../../windows/win.ini',
    '../../etc/passwd',
    '..\\..\\windows\\win.ini',
    `sha256:${HEX_A}/../../x`,
    'C:\\Windows\\win.ini',
    '\\\\server\\share\\x',
    'sha256%3A' + HEX_A,
  ];
  for (const value of bad) {
    assert.equal(normalizeAttachmentId(value), null, `应拒绝：${JSON.stringify(value)}`);
  }
  // 正则本身也不能容忍上面任何一种
  assert.equal(ATTACHMENT_ID_RE.test(`sha256:${HEX_A} `), false, '正则不允许尾随空白（归一化才负责 trim）');
});

test('attachments：sniffMediaType 认 PNG/JPEG/GIF/WEBP，认不出给 octet-stream', () => {
  assert.equal(sniffMediaType(pngBytes()), 'image/png');
  assert.equal(sniffMediaType(JPEG_BYTES), 'image/jpeg');
  assert.equal(sniffMediaType(GIF_BYTES), 'image/gif');
  assert.equal(sniffMediaType(WEBP_BYTES), 'image/webp');
  assert.equal(sniffMediaType(UNKNOWN_BYTES), 'application/octet-stream');
  // 边界：空、太短、null 都不能抛错（调用方可能拿到 0 字节对象）
  assert.equal(sniffMediaType(Buffer.alloc(0)), 'application/octet-stream');
  assert.equal(sniffMediaType(Buffer.from([0x89, 0x50])), 'application/octet-stream');
  assert.equal(sniffMediaType(null), 'application/octet-stream');
  // "RIFF" 但不是 WEBP（例如 WAV）必须落到兜底，不能靠前 4 字节就下结论
  assert.equal(sniffMediaType(Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt ', 'ascii')])), 'application/octet-stream');
});

// ---------------------------------------------------------------------------
// 2. 目录探测：多 home 根 / 多版本目录
// ---------------------------------------------------------------------------

test('attachments：resolveAttachment 在多 home 根里找到对象并返回嗅探出的 mediaType', async (t) => {
  const empty = await makeRoot(t, 'empty');
  const home = await makeRoot(t, 'one');
  const file = await seedAttachmentObject(home, `sha256:${HEX_A}`, { bytes: pngBytes(4, 3) });

  const found = await resolveAttachment({ id: `sha256:${HEX_A}`, roots: [empty, home, null, undefined, ''] });
  assert.ok(found, '第二个根里有对象，必须命中');
  assert.equal(found.path, file);
  assert.equal(found.size, (await fs.stat(file)).size);
  assert.equal(found.mediaType, 'image/png', 'mediaType 必须来自**字节嗅探**（对象名无扩展名，日志声明不可信）');
});

test('attachments：根不存在、对象不存在、对象是目录 → 一律 null（不抛错）', async (t) => {
  const home = await makeRoot(t, 'miss');
  assert.equal(await resolveAttachment({ id: `sha256:${HEX_A}`, roots: [home] }), null, 'home 里没有 attachments 目录');
  assert.equal(await resolveAttachment({ id: `sha256:${HEX_A}`, roots: [path.join(home, 'nope')] }), null);
  assert.equal(await resolveAttachment({ id: `sha256:${HEX_A}`, roots: [] }), null);
  assert.equal(await resolveAttachment({ id: 'not-an-id', roots: [home] }), null, 'id 不合法时**不碰文件系统**');

  // 造一个与 id 同名的**目录**：不是普通文件，不能被服务
  const hex = HEX_B;
  await fs.mkdir(path.join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex), { recursive: true });
  assert.equal(await resolveAttachment({ id: `sha256:${hex}`, roots: [home] }), null, '目录不是可服务的附件');
});

test('attachments：版本目录靠 readdir 探测，写死 v1 的实现会在 v9 布局上 404', async (t) => {
  const home = await makeRoot(t, 'ver');
  const file = await seedAttachmentObject(home, `sha256:${HEX_A}`, { bytes: JPEG_BYTES, version: 'v9' });
  const found = await resolveAttachment({ id: `sha256:${HEX_A}`, roots: [home] });
  assert.ok(found, '版本目录名不是 v1 时仍要能找到（DSH 升级后目录名可能变）');
  assert.equal(found.path, file);
  assert.equal(found.mediaType, 'image/jpeg');
});

test('attachments：重复根只查一次，且先命中先返回（不遍历全部）', async (t) => {
  const home = await makeRoot(t, 'dup');
  await seedAttachmentObject(home, `sha256:${HEX_A}`, { bytes: GIF_BYTES });
  const seen = [];
  const fsImpl = {
    promises: {
      readdir: async (dir, opts) => {
        seen.push(dir);
        return fs.readdir(dir, opts);
      },
      stat: (...args) => fs.stat(...args),
      open: (...args) => fs.open(...args),
    },
  };
  const found = await resolveAttachment({ id: `sha256:${HEX_A}`, roots: [home, home, home.toUpperCase()], fsImpl });
  assert.ok(found);
  assert.equal(found.mediaType, 'image/gif');
  // 三个"不同写法"的同一个根（含 Windows 大小写差异）只应产生一次 <home>/attachments 读取。
  // 只统计这一层：`objects/<前2位>` 是命中后**必然**要读的第二层，不参与去重断言。
  const attachmentRoots = seen.filter((dir) => path.basename(dir) === 'attachments');
  assert.equal(attachmentRoots.length, 1, `同一个根被查了 ${attachmentRoots.length} 次：${attachmentRoots.join(' | ')}`);
});

test('attachments：对象存在但读不到前导字节时仍返回路径，mediaType 退化为 octet-stream', async (t) => {
  const home = await makeRoot(t, 'unreadable');
  await seedAttachmentObject(home, `sha256:${HEX_A}`, { bytes: pngBytes() });
  const fsImpl = {
    promises: {
      readdir: (...args) => fs.readdir(...args),
      stat: (...args) => fs.stat(...args),
      open: async () => {
        throw new Error('EACCES');
      },
    },
  };
  const found = await resolveAttachment({ id: `sha256:${HEX_A}`, roots: [home], fsImpl });
  assert.ok(found, '能定位到文件就不该降级成"不存在"');
  assert.equal(found.mediaType, 'application/octet-stream');
});

test('attachments：fsImpl 传成 node:fs/promises 时立刻抛错（不静默变成"全部 404"）', async (t) => {
  const home = await makeRoot(t, 'wrongfs');
  await seedAttachmentObject(home, `sha256:${HEX_A}`, { bytes: pngBytes() });
  // 这是本项目真实踩过的坑：两者外观极像，传错的表现是所有附件静默 404
  await assert.rejects(
    () => resolveAttachment({ id: `sha256:${HEX_A}`, roots: [home], fsImpl: fs }),
    /fsImpl 必须是 node:fs 模块/,
  );
});

// ---------------------------------------------------------------------------
// 3. HTTP 端点
// ---------------------------------------------------------------------------

/** 取原始字节（`httpRequest` 会 `res.text()` 把二进制毁掉，所以这里直接用 fetch）。 */
async function fetchBytes(url, { token = null, method = 'GET', headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, init);
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

test('v2/attachments：GET 返回原始字节 + 四个响应头（Content-Type/Length/Cache-Control/X-Api-Version）', async (t) => {
  const h = await startV2(t, { seed: { withUserImage: true, withRealAttachments: true } });
  const expected = await fs.readFile(path.join(h.seeded.dshHome, 'attachments', 'v1', 'objects', 'aa', 'a'.repeat(64)));
  const res = await fetchBytes(`${h.baseUrl}/api/v2/attachments/${SEEDED_USER_IMAGE_ID}`, { token: h.token });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png', 'Content-Type 必须来自字节嗅探');
  assert.equal(Number(res.headers.get('content-length')), expected.length);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  // 与其余 v2 端点（health/sessions/transcript）逐字一致：都回 `config.apiVersion`（=1）。
  // 这个头在契约 §4.5 里的定义是"v1 端点的版本号"，不是"端点属于第几代"；曾经按"新端点"
  // 写成字面量 2，沦为全网关唯一的孤例 ⇒ 已按一致性裁决改回 1。**能力协商请一律看
  // `/api/v2/health` 的 `capabilities`（本端点 = `attachments`）**，不要解析这个头。
  assert.equal(res.headers.get('x-api-version'), '1');
  assert.deepEqual(res.bytes, expected, '响应体必须与对象库里的字节**逐字一致**');
});

test('v2/attachments：百分号编码（%3A / %61）与裸 hex 都要命中同一条路由', async (t) => {
  const h = await startV2(t, { seed: { withToolImage: true, withRealAttachments: true } });
  const encoded = `sha256%3A${'b'.repeat(64)}`;
  const upper = await fetchBytes(`${h.baseUrl}/api/v2/attachments/${encoded}`, { token: h.token });
  assert.equal(upper.status, 200, `百分号编码的冒号必须能命中（${encoded}）`);
  assert.equal(upper.headers.get('content-type'), 'image/png');

  const bare = await fetchBytes(`${h.baseUrl}/api/v2/attachments/${'b'.repeat(64)}`, { token: h.token });
  assert.equal(bare.status, 200, '裸 64 位 hex 也要接受（容错解析）');
  assert.deepEqual(bare.bytes, upper.bytes);

  const mixedCase = await fetchBytes(`${h.baseUrl}/api/v2/attachments/sha256:${'B'.repeat(64)}`, { token: h.token });
  assert.equal(mixedCase.status, 200, '大写 hex 归一化后仍应命中');
});

test('v2/attachments：400 bad_request（形状非法）、404 not_found（形状合法但不存在）逐条区分', async (t) => {
  const h = await startV2(t, {});

  // 形状非法 → 400，消息必须写清期望形状
  for (const badId of ['sha256:' + 'a'.repeat(63), 'md5:' + 'a'.repeat(64), '..%2F..%2Fwin.ini', 'zzzz']) {
    const res = await h.request('GET', `/api/v2/attachments/${badId}`);
    assert.equal(res.status, 400, `应 400：${badId}`);
    assert.equal(res.json.error.code, 'bad_request');
    assert.match(res.json.error.message, /sha256/);
    assert.match(res.json.error.message, /64 位小写十六进制/, '消息要写清期望形状，便于手机端直接呈现');
  }

  // 形状合法但对象库里没有 → 404
  const missing = await h.request('GET', `/api/v2/attachments/sha256:${'c'.repeat(64)}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');

  // 多段路径没被当成会话/附件 id 吃掉
  const extra = await h.request('GET', `/api/v2/attachments/sha256:${'a'.repeat(64)}/extra`);
  assert.equal(extra.status, 404, '多余路径段必须落到"未知接口"而不是命中附件路由');
  assert.equal(extra.json.error.code, 'not_found');
});

test('v2/attachments：超过 ATTACHMENT_MAX_BYTES 走 413 attachment_too_large（与 404 分开）', async (t) => {
  const home = await makeRoot(t, 'toobig');
  const bigId = `sha256:${'d'.repeat(64)}`;
  // 用稀疏写造一个"表观尺寸 > 8 MiB"的对象：不必真的写 8 MiB 到磁盘
  const file = await seedAttachmentObject(home, bigId, { bytes: Buffer.alloc(16) });
  await fs.truncate(file, ATTACHMENT_MAX_BYTES + 1);

  const h = await startV2(t, { overrides: { mirror: { dshHome: home } } });
  const res = await h.request('GET', `/api/v2/attachments/${bigId}`);
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'attachment_too_large');
  assert.match(res.json.error.message, new RegExp(String(ATTACHMENT_MAX_BYTES)));

  // 同一根下刚好等于上限的对象**可以**服务（边界是"超过"而不是"达到"）
  const exactId = `sha256:${'e'.repeat(64)}`;
  const exact = await seedAttachmentObject(home, exactId, { bytes: Buffer.alloc(16) });
  await fs.truncate(exact, ATTACHMENT_MAX_BYTES);
  const okRes = await fetchBytes(`${h.baseUrl}/api/v2/attachments/${exactId}`, { token: h.token });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.bytes.length, ATTACHMENT_MAX_BYTES);
});

test('v2/attachments：受 Bearer 保护（401），只允许 GET（405），不进 PUBLIC_ROUTES', async (t) => {
  const h = await startV2(t, { seed: { withRealAttachments: true } });
  const noToken = await h.request('GET', `/api/v2/attachments/${SEEDED_USER_IMAGE_ID}`, { token: null });
  assert.equal(noToken.status, 401, '与 sessions/workspaces 同档，必须带令牌');
  assert.equal(noToken.json.error.code, 'unauthorized');

  const badToken = await h.request('GET', `/api/v2/attachments/${SEEDED_USER_IMAGE_ID}`, { token: 'dshr_not_a_real_token' });
  assert.equal(badToken.status, 401);

  const post = await h.request('POST', `/api/v2/attachments/${SEEDED_USER_IMAGE_ID}`, { body: {} });
  assert.equal(post.status, 405, '只允许 GET');
  const del = await h.request('DELETE', `/api/v2/attachments/${SEEDED_USER_IMAGE_ID}`);
  assert.equal(del.status, 405);
});

test('v2/attachments：health 能力清单声明 attachments 与 session.turnIndex', async (t) => {
  const h = await startV2(t, {});
  const res = await h.request('GET', '/api/v2/health');
  assert.ok(res.json.capabilities.includes('attachments'), res.json.capabilities.join(','));
  assert.ok(res.json.capabilities.includes('session.turnIndex'));
});

// ---------------------------------------------------------------------------
// 4. 投影：三处图片引用 + user 消息的 turn 戳
// ---------------------------------------------------------------------------

/** 造一份最小事件序列（直接喂 projectSession，不经 HTTP，失败点更清楚）。 */
function imageEvents() {
  const userImage = { type: 'image', attachment: { attachmentId: SEEDED_USER_IMAGE_ID, mediaType: 'image/png', width: 1080, height: 2340, bytes: 246042, name: '01-电脑会话.png' } };
  return [
    { type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:\\ws' },
    { type: 'turn/start', seq: 1, time: 10, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 11, data: { content: [{ type: 'text', text: '看这张图' }, userImage], source: { kind: 'user' }, role: 'user', id: 'u-1' } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 12,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          id: 'a-1',
          content: [
            { type: 'text', text: '我看看' },
            { type: 'tool-call', id: 'call_1', name: 'read_image', arguments: '{"path":"a.png"}' },
            { type: 'image', attachment: { attachmentId: SEEDED_TOOL_IMAGE_ID, mediaType: 'image/webp', width: 640, height: 480, bytes: 99, name: 'inline.webp' } },
          ],
        },
      },
    },
    { type: 'tool/call', seq: 4, time: 13, data: { turn: 1, step: 1, callId: 'call_1', name: 'read_image', arguments: '{"path":"a.png"}' } },
    {
      type: 'tool/result',
      seq: 5,
      time: 14,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_1',
          isError: false,
          content: [
            { type: 'text', text: '读取成功' },
            { type: 'image', attachment: { attachmentId: SEEDED_TOOL_IMAGE_ID, mediaType: 'image/png', bytes: 1234, name: 'shot.png' } },
          ],
        },
      },
    },
    { type: 'turn/end', seq: 6, time: 15, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

test('投影：user / assistant / tool-result 三处都带 images，字段缺失时为 null', () => {
  const { messages } = projectSession(imageEvents(), { header: { id: 'session-x', cwd: 'C:\\ws' } });

  const user = messages.find((m) => m.role === 'user');
  assert.equal(user.text, '看这张图');
  assert.deepEqual(user.images, [
    { id: SEEDED_USER_IMAGE_ID, mediaType: 'image/png', width: 1080, height: 2340, bytes: 246042, name: '01-电脑会话.png' },
  ]);
  assert.equal(user.turn, 1, 'user 消息的 turn 戳来自投影循环的 openTurn（轮次导航的锚点）');

  const assistant = messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.turn, 1, 'assistant 自带的 turn 本来就是 1');
  assert.deepEqual(assistant.images, [
    { id: SEEDED_TOOL_IMAGE_ID, mediaType: 'image/webp', width: 640, height: 480, bytes: 99, name: 'inline.webp' },
  ]);

  const call = assistant.toolCalls.find((c) => c.id === 'call_1');
  assert.ok(call, '工具调用仍要挂在 assistant 消息上');
  assert.deepEqual(call.images, [
    // width/height 在真实日志里可能缺（这条就没有）→ 必须是 null 而不是被丢掉
    { id: SEEDED_TOOL_IMAGE_ID, mediaType: 'image/png', width: null, height: null, bytes: 1234, name: 'shot.png' },
  ]);
});

test('投影：没有图片块时**不加** images 字段（老客户端响应形状逐字不变）', () => {
  const events = imageEvents().filter((ev) => !JSON.stringify(ev).includes('"image"') || ev.type === 'session');
  const { messages } = projectSession(events, { header: { id: 'session-x' } });
  assert.ok(messages.length > 0);
  for (const msg of messages) {
    assert.equal('images' in msg, false, `${msg.role} 不该有 images 字段`);
    for (const call of msg.toolCalls ?? []) assert.equal('images' in call, false);
  }
});

test('投影：形状不对的图片引用整块丢弃（不投影必然 400 的 id）', () => {
  const events = [
    { type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:\\ws' },
    {
      type: 'user/message',
      seq: 1,
      time: 10,
      data: {
        content: [
          { type: 'text', text: '混进坏引用' },
          { type: 'image', attachment: { attachmentId: 'sha256:short', name: 'bad.png' } },
          { type: 'image', attachment: { attachmentId: '../../etc/passwd', name: 'evil' } },
          { type: 'image', attachment: { attachmentId: SEEDED_USER_IMAGE_ID, name: 'good.png' } },
        ],
        source: { kind: 'user' },
        role: 'user',
        id: 'u-1',
      },
    },
  ];
  const { messages } = projectSession(events, { header: { id: 'session-x' } });
  assert.deepEqual(messages[0].images.map((i) => i.name), ['good.png'], '只留合法的那条');
});

test('投影：纯图片轮次的列表标题回退到图片名（不再是无标题会话）', () => {
  const events = [
    { type: 'session', version: 4, id: 'session-img', createdAt: 1, cwd: 'C:\\ws' },
    { type: 'turn/start', seq: 1, time: 10, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: 11,
      data: {
        content: [{ type: 'image', attachment: { attachmentId: SEEDED_USER_IMAGE_ID, mediaType: 'image/png', bytes: 10, width: 1, height: 1, name: '只有图片.png' } }],
        source: { kind: 'user' },
        role: 'user',
        id: 'u-1',
      },
    },
    { type: 'turn/end', seq: 3, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const withName = projectSession(events, { header: { id: 'session-img' } });
  assert.equal(withName.messages[0].text, '', '纯图轮次正文就是空串（老行为不变）');
  assert.equal(withName.meta.title, '（图片）只有图片.png');

  // 连文件名都没有时给固定文案，绝不返回 null
  events[2].data.content[0].attachment = { attachmentId: SEEDED_USER_IMAGE_ID };
  const noName = projectSession(events, { header: { id: 'session-img' } });
  assert.equal(noName.meta.title, '（图片）');
});

test('投影：不在任何轮次里的 user 消息 turn 为 null（不许硬塞给"当前轮"）', () => {
  const events = [
    { type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:\\ws' },
    // 真实形状：turn/start 之前的那条用户消息（本 fixture 里 seq=2 就是这种）
    { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: '开场' }], source: { kind: 'user' }, role: 'user', id: 'u-0' } },
    { type: 'turn/start', seq: 2, time: 11, data: { turn: 1 } },
    { type: 'user/message', seq: 3, time: 12, data: { content: [{ type: 'text', text: '轮内' }], source: { kind: 'user' }, role: 'user', id: 'u-1' } },
    { type: 'turn/end', seq: 4, time: 13, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'user/message', seq: 5, time: 14, data: { content: [{ type: 'text', text: '轮后' }], source: { kind: 'user' }, role: 'user', id: 'u-2' } },
  ];
  const { messages } = projectSession(events, { header: { id: 'session-x' } });
  const byText = Object.fromEntries(messages.map((m) => [m.text, m.turn]));
  assert.deepEqual(byText, { 开场: null, 轮内: 1, 轮后: null });
});

// ---------------------------------------------------------------------------
// 5. 端到端：fixture 里的引用 → HTTP 取字节（引用与字节是同一条链路）
// ---------------------------------------------------------------------------

test('v2/attachments：会话里的图片引用能被 /transcript 投影出来，再用同一 id 取回字节', async (t) => {
  const h = await startV2(t, { seed: { withUserImage: true, withToolImage: true, withTurn2: true, withRealAttachments: true } });
  const tx = await h.request('GET', `/api/v2/sessions/${SEEDED_SESSION_ID}/transcript?limit=100`);
  assert.equal(tx.status, 200);

  const imageMessages = tx.json.messages.filter((m) => Array.isArray(m.images));
  assert.equal(imageMessages.length, 1, 'fixture 里只有第二轮那条纯图用户消息');
  assert.equal(imageMessages[0].turn, 2);
  const toolImage = tx.json.messages.flatMap((m) => m.toolCalls ?? []).flatMap((c) => c.images ?? []);
  assert.deepEqual(toolImage.map((i) => i.id), [SEEDED_TOOL_IMAGE_ID]);

  for (const ref of [...imageMessages[0].images, ...toolImage]) {
    const res = await fetchBytes(`${h.baseUrl}/api/v2/attachments/${ref.id}`, { token: h.token });
    assert.equal(res.status, 200, `引用 ${ref.id} 必须能取回字节`);
    assert.match(res.headers.get('content-type'), /^image\//);
  }
});

test('v2/attachments：客户端中途断开不会让网关产生未捕获异常（进程仍能继续服务）', async (t) => {
  const h = await startV2(t, { seed: { withRealAttachments: true } });
  // 发起请求后立刻 abort：服务端此时正在 pipe 或刚 writeHead
  const ac = new AbortController();
  const pending = fetch(`${h.baseUrl}/api/v2/attachments/${SEEDED_USER_IMAGE_ID}`, {
    headers: { Authorization: `Bearer ${h.token}` },
    signal: ac.signal,
  }).catch(() => null);
  ac.abort();
  await pending;
  // 网关必须还活着：紧接着一个正常请求要成功
  const after = await h.request('GET', `/api/v2/attachments/${SEEDED_USER_IMAGE_ID}`);
  assert.equal(after.status, 200, '断开事件不能带走请求处理链路');
});
