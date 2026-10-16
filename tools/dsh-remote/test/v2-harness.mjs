/**
 * v2 集成测试公共装置：合成 DSH home 会话 fixture、装配真实网关的 `startV2`、SSE 收集器。
 *
 * 这三段代码原本内联在 `v2-http.test.mjs` 里；抽出到本模块是为了让
 * `v2-desktop.test.mjs`（桌面端驱动通道的隔离桩测试）复用**同一份**装置，
 * 而不是复制一份出来各自漂移。
 *
 * ⚠️ `desktop` 注入是隔离红线：不传时一律注入 `null`（显式关闭桌面端通道）。
 * `createGateway` 的 `desktop === undefined` 语义是"按 config 造**真实** DesktopApi"，
 * 那会连本机 127.0.0.1:19387 上用户正在运行的 Electron DSH、读用户真实 `~/.dsh`
 * 凭据、甚至向用户的电脑端会话投递轮次。测试里任何一处漏注入都是事故，不是不便。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync, crc32 } from 'node:zlib';
import { createGateway } from '../lib/http.mjs';
import { defaultConfig, mergeConfig, validateConfig } from '../lib/config.mjs';
import { createLogger } from '../lib/util.mjs';
import { encodeWorkspaceSlug } from '../lib/dsh-home.mjs';
import { httpRequest, sleep } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_SDK = path.join(HERE, 'fixtures', 'fake-sdk.mjs');

/** 合成电脑端会话的默认 id（各用例断言里直接引用这个字面量）。 */
export const SEEDED_SESSION_ID = 'session-11111111-2222-4333-8444-555555555555';

/**
 * fixture 里图片块引用的附件 id（**内容哈希是编的**，与真实对象库无关）。
 *
 * 为什么要在 fixture 里写死这两个常量：附件通道是"引用 → 字节"的转换，
 * 用例必须能同时断言**引用投影**（JSON 里的 id）与**字节取回**（HTTP 响应体），
 * 两边用同一个字面量才能证明是同一条链路。导出给用例引用，避免两处各写一遍 hex。
 */
export const SEEDED_USER_IMAGE_ID = `sha256:${'a'.repeat(64)}`;
export const SEEDED_TOOL_IMAGE_ID = `sha256:${'b'.repeat(64)}`;

/** 造一张**结构合法**的极小 PNG（签名 + IHDR + IEND），字节可复现。 */
function tinyPng(width = 2, height = 2) {
  const chunk = (type, data) => {
    const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    // PNG 每个 chunk 都要 CRC32（含类型字段）；zlib.crc32 是 Node 20.15+ 内置。
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(head), 0);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, head, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 在某个 DSH home 里造一个附件对象（`<home>/attachments/<版本>/objects/<前2>/<hex>`）。
 *
 * 版本目录**故意参数化**：真实布局实测是 `v1`，但网关必须靠 `readdir` 探测版本 ——
 * 用例里造一个 `v9` 就是这条约束的钉子（写死 `v1` 的实现会在这里 404）。
 * @param {string} home
 * @param {string} id `sha256:<64 hex>`
 * @param {{bytes?: Buffer, version?: string}} [opts]
 * @returns {Promise<string>} 对象文件的绝对路径
 */
export async function seedAttachmentObject(home, id, { bytes = tinyPng(), version = 'v1' } = {}) {
  const hex = String(id).replace(/^sha256:/, '');
  const dir = path.join(home, 'attachments', version, 'objects', hex.slice(0, 2));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, hex);
  await fs.writeFile(file, bytes);
  return file;
}

/**
 * 构造一个「真实形状」的合成 DSH 会话：多帧 zstd + workspace.json + projcache。
 *
 * 派生会话的三种真实形状（**header 字段是真的会缺的，测试必须能造出来**）：
 * - `origin: 'subagent'` + `delegationDepth: 1` + `parentSession`：`dsh-subagent/lib/index.js`
 *   的 `childSessionMeta()` 写的标准子代理 header（`subagent: true` 的快捷方式）；
 * - **无 origin** 但 `delegationDepth: 1`（老版本 / 别的 driver 写的子代理）；
 * - **无 origin** 但 `parentSession` 非空（fork / seeded 副本，真实 home 里就有这种）。
 * @param {string} root
 * @param {{id?: string, turns?: number, withToolCall?: boolean, subagent?: boolean, origin?: string|null, parentSession?: string|null, delegationDepth?: number, isSeeded?: boolean, withUserImage?: boolean, withToolImage?: boolean, withTurn2?: boolean, withRealAttachments?: boolean, attachmentVersion?: string}} [opts]
 *   `withUserImage` / `withToolImage` / `withTurn2` 都是**纯追加**开关：不开时事件序列与
 *   加图片能力之前**逐字节一致**（既有用例的断言因此不受影响）。
 */
export async function seedSession(root, { id = SEEDED_SESSION_ID, turns = 1, withToolCall = true, subagent = false, origin = null, parentSession = null, delegationDepth = null, isSeeded = false, withUserImage = false, withToolImage = false, withTurn2 = false, withRealAttachments = false, attachmentVersion = 'v1' } = {}) {
  const dshHome = path.join(root, 'real-dsh');
  const workspace = path.join(root, 'ws');
  const slug = encodeWorkspaceSlug(workspace);
  const dir = path.join(dshHome, 'sessions', slug, id);
  await fs.mkdir(dir, { recursive: true });

  const depth = delegationDepth ?? (subagent ? 1 : 0);
  const resolvedOrigin = origin ?? (subagent ? 'subagent' : null);
  const events = [
    {
      type: 'session',
      version: 4,
      id,
      createdAt: 1_700_000_000_000,
      cwd: workspace,
      isSeeded,
      delegationDepth: depth,
      agentPreset: 'standard',
      // 与真实 DSH 一致：**只有子代理 header 才带 origin，顶层会话不带**
      ...(resolvedOrigin === null ? {} : { origin: resolvedOrigin }),
      ...(parentSession === null ? {} : { parentSession }),
    },
    { type: 'permission/preset', seq: 0, time: 1_700_000_000_001, data: { preset: 'workspace-write' } },
    { type: 'agent/inbox/spliced', seq: 1, time: 1_700_000_000_002, data: { target: 'next-turn', start: 0, inserted: [] } },
    { type: 'user/message', seq: 2, time: 1_700_000_000_003, data: { content: [{ type: 'text', text: '帮我看看构建失败的原因' }], source: { kind: 'user' }, role: 'user', id: 'u-1' } },
    { type: 'user/message', seq: 3, time: 1_700_000_000_004, data: { content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'runtime-context' }, role: 'user', id: 'u-2' } },
    { type: 'session/title', seq: 4, time: 1_700_000_000_005, data: { title: '构建排障', messageSeqs: [2] } },
    { type: 'turn/start', seq: 5, time: 1_700_000_000_006, data: { turn: 1 } },
    { type: 'step/start', seq: 6, time: 1_700_000_000_007, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 7, time: 1_700_000_000_008, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are an AI agent…' }] } } },
  ];
  if (withToolCall) {
    events.push(
      {
        type: 'assistant/message',
        seq: 8,
        time: 1_700_000_000_010,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            id: 'a-1',
            content: [
              { type: 'reasoning', text: '先看 AGP 版本' },
              { type: 'text', text: '定位到 AGP 版本不匹配。' },
              { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: JSON.stringify({ command: 'gradlew -v', description: '版本' }) },
            ],
          },
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      },
      { type: 'tool/call', seq: 9, time: 1_700_000_000_011, data: { turn: 1, step: 1, callId: 'call_1', name: 'pwsh', arguments: JSON.stringify({ command: 'gradlew -v', description: '版本' }) } },
      {
        type: 'tool/result',
        seq: 10,
        time: 1_700_000_000_020,
        data: {
          turn: 1,
          step: 1,
          // 开关打开时**同时**给 text 与 image 块：真实的 `read_image` 结果就是这个形状
          // （一句话说明 + 图片），只投影 text 的旧实现恰好能过"有 text"的检查而静默丢掉图片。
          message: {
            role: 'tool',
            toolCallId: 'call_1',
            content: withToolImage
              ? [
                  { type: 'text', text: 'BUILD SUCCESSFUL' },
                  { type: 'image', attachment: { attachmentId: SEEDED_TOOL_IMAGE_ID, mediaType: 'image/png', bytes: 1234, width: 640, height: 480, name: 'shot.png' } },
                ]
              : [{ type: 'text', text: 'BUILD SUCCESSFUL' }],
            isError: false,
          },
        },
      },
      { type: 'deliverables/presented', seq: 11, time: 1_700_000_000_021, data: { turn: 1, callId: 'call_1', files: [{ path: 'app-release.apk', description: 'release 包' }] } },
    );
  }
  events.push(
    { type: 'todo/write', seq: 12, time: 1_700_000_000_022, data: { todos: [{ content: '定位失败原因', status: 'completed' }] } },
    { type: 'workspace/changes', seq: 13, time: 1_700_000_000_023, data: { turn: 1 } },
    { type: 'step/end', seq: 14, time: 1_700_000_000_024, data: { turn: 1, step: 1 } },
    // `turns` 是既有 fixture 的"最后一轮的轮号"参数（老用例用它造 turns=N 的会话），
    // 保持原样不动；`withTurn2` 追加的第二轮把自己的 turn 写死为 2。
    { type: 'turn/end', seq: 15, time: 1_700_000_000_025, data: { turn: turns, reason: { kind: 'completed' } } },
  );
  if (withTurn2) {
    // 第二轮：手机端只发一张图（真实形状 —— 网关网关侧 `validateTurnContent` 会补一条占位正文，
    // 但**也**存在完全没有 text 块的纯图轮次，这里就造那种）。它同时是轮次索引的第二个样本。
    events.push(
      { type: 'turn/start', seq: 16, time: 1_700_000_000_030, data: { turn: 2 } },
      { type: 'step/start', seq: 17, time: 1_700_000_000_031, data: { turn: 2, step: 1 } },
      {
        type: 'user/message',
        seq: 18,
        time: 1_700_000_000_032,
        data: {
          content: withUserImage
            ? [{ type: 'image', attachment: { attachmentId: SEEDED_USER_IMAGE_ID, mediaType: 'image/png', width: 1080, height: 2340, bytes: 246042, name: '01-电脑会话.png' } }]
            : [{ type: 'text', text: '第二轮：再确认一次' }],
          source: { kind: 'user' },
          role: 'user',
          id: 'u-3',
        },
      },
      { type: 'assistant/message', seq: 19, time: 1_700_000_000_040, data: { turn: 2, step: 1, message: { role: 'assistant', id: 'a-2', content: [{ type: 'text', text: '第二轮答复完成。' }] } } },
      { type: 'step/end', seq: 20, time: 1_700_000_000_041, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: 21, time: 1_700_000_000_042, data: { turn: 2, reason: { kind: 'completed' } } },
    );
  }
  if (withUserImage && !withTurn2) {
    // 只要"用户消息带图"但不要第二轮时，把图放进第一轮之前的那条真实用户消息里
    // （它没有 turn 归属 —— 正好也是"缺 turn 的消息不进索引"这条规则的真实样本）。
    events[3].data.content = [
      { type: 'text', text: '帮我看看构建失败的原因' },
      { type: 'image', attachment: { attachmentId: SEEDED_USER_IMAGE_ID, mediaType: 'image/png', width: 1080, height: 2340, bytes: 246042, name: '01-电脑会话.png' } },
    ];
  }

  if (withRealAttachments) {
    // 引用与字节分家（真实布局）：把 fixture 引用的两个 id 真的写进对象库，
    // 否则 `/api/v2/attachments/{id}` 必然 404 —— 那样"引用投影"能过、"取字节"过不了，
    // 用例会变成在测一个假前提。
    await seedAttachmentObject(dshHome, SEEDED_USER_IMAGE_ID, { version: attachmentVersion });
    await seedAttachmentObject(dshHome, SEEDED_TOOL_IMAGE_ID, { version: attachmentVersion });
  }

  // 关键：**逐行分帧追加**，模拟 DSH 的真实多帧写入（不是一次性整文件压缩）
  const frames = events.map((ev) => zstdCompressSync(Buffer.from(`${JSON.stringify(ev)}\n`, 'utf8')));
  await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));

  await fs.mkdir(path.join(dshHome, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  await fs.writeFile(
    path.join(dshHome, 'storages', 'workspace.json'),
    JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: { w1: { path: workspace, title: 'ws', sessionIds: [id], createdAt: 'x', updatedAt: 'y' } } } }),
    'utf8',
  );
  await fs.writeFile(
    path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`),
    JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1_700_000_000_000, cwd: workspace, isSeeded, inheritedEventCount: 0 },
        rows: {
          title: { ver: 1, seq: 15, val: '构建排障' },
          agentPreset: { ver: 1, seq: 15, val: 'standard' },
          turnBoundary: { ver: 2, seq: 15, val: { openTurnStartSeq: null, lastStepStartSeq: 6, lastStepBoundary: { kind: 'end', seq: 14 }, lastTurn: 1 } },
          sessionStats: { ver: 1, seq: 15, val: { turns: 1, steps: 1, openStep: null, pendingCalls: {} } },
          sessionListMetadata: { ver: 1, seq: 15, val: { blank: false, lastPromptAt: 1_700_000_000_003 } },
        },
      },
    }),
    'utf8',
  );
  return { dshHome, workspace, id, slug, file: path.join(dir, 'session.v4.jsonl.zstd') };
}

/**
 * 启动一个装配了真实 v2 组件的网关：镜像源是合成 DSH home，SDK 运行时是替身进程。
 *
 * `desktop` 默认 `null`：**显式关闭**桌面端通道，绝不构造真实 `DesktopApi`（见文件头注释）。
 * 需要验桌面通道时传 `makeDesktopStub(...)` 的纯内存替身。
 * @param {import('node:test').TestContext} t
 */
export async function startV2(t, { overrides = {}, seed = {}, env = {}, seedRepo = false, mutate = null, desktop = null } = {}) {
  const root = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'dshr-v2-'));
  const gwHome = path.join(root, 'gw-home');
  const sdkHome = path.join(root, 'sdk-home');
  await fs.mkdir(gwHome, { recursive: true });
  await fs.mkdir(sdkHome, { recursive: true });
  await fs.mkdir(path.join(gwHome, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(gwHome, 'logs'), { recursive: true });
  const seeded = await seedSession(root, seed);
  const extraWs = path.join(root, 'extra');
  await fs.mkdir(path.join(extraWs, 'nested'), { recursive: true });
  await fs.writeFile(path.join(extraWs, 'note.txt'), '你好，这是文本内容\n', 'utf8');
  await fs.writeFile(path.join(extraWs, 'nested', 'deep.txt'), 'needle here\n', 'utf8');

  // 可选：在 extraWs 下造一个**真 git 仓库**（extraWs 已在白名单内，子目录按 isWithin 规则放行）
  let repoDir = null;
  if (seedRepo) {
    const { runCommand } = await import('../lib/workspace-git.mjs');
    repoDir = path.join(extraWs, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    await runCommand('git', ['init', '-q'], { cwd: repoDir });
    await runCommand('git', ['config', 'user.email', 't@t'], { cwd: repoDir });
    await runCommand('git', ['config', 'user.name', 't'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: repoDir });
    await runCommand('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nthree\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'untracked.txt'), 'new\n', 'utf8');
  }

  const merged = mergeConfig(
    defaultConfig({}),
    {
      host: '127.0.0.1',
      port: 0,
      dshHome: gwHome,
      serverName: 'v2-test-host',
      workspaceAllowlist: [extraWs, seeded.workspace],
      defaultWorkspace: extraWs,
      // 显式 electronPath + cliPath → 替身进程；argsPrefix = [] + [fake-sdk.mjs]
      dsh: { electronPath: process.execPath, cliPath: FAKE_SDK, exeArgs: [], sessionsHome: sdkHome, provider: 'deepseek-official', model: 'deepseek-flash', runtimeIdleMs: 0 },
      mirror: { enabled: true, dshHome: seeded.dshHome, liveWindowMs: 60_000 },
      // 电脑端会话实时中继默认**关**：它按 2s 轮询桌面端运行态，开着会让
      // 「桌面端 running=true」的那些用例凭空多出 turn.started/turn.ended
      // （对断言是干扰，不是被测对象）。要测中继的用例自己传 `desktopWatch: {enabled:true}`。
      desktopWatch: { enabled: false },
      log: { toConsole: false },
      sessionStream: { heartbeatMs: 40, maxClients: 4 },
      limits: { requestTimeoutMs: 5000, headersTimeoutMs: 4000 },
    },
    overrides,
  );
  // `mergeConfig` 有意把 patch 里的 `null` 当作"不覆盖"（v1 语义），
  // 因此"清空某个已设值"要靠 mutate 直接改合并后的对象。
  if (mutate) mutate(merged);
  const config = validateConfig(merged, { env: {} });
  const oldEnv = {};
  for (const [k, v] of Object.entries(env)) {
    oldEnv[k] = process.env[k];
    process.env[k] = v;
  }
  const logger = createLogger({ dir: config.logsDir, toConsole: false });
  const gw = await createGateway(config, { logger, desktop });
  const port = await gw.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await gw.close().catch(() => {});
    for (const [k, v] of Object.entries(oldEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await sleep(50);
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const open = await httpRequest(baseUrl, 'POST', '/api/v2/pair/open');
  const claim = await httpRequest(baseUrl, 'POST', '/api/v2/pair/claim', { body: { code: open.json.code, deviceName: 'v2-test', deviceId: '01234567-89ab-4cde-8f01-23456789abcd' } });
  const token = claim.json.token;
  return { gw, config, root, gwHome, sdkHome, seeded, extraWs, repoDir, baseUrl, port, token, desktop, request: (m, p, o = {}) => httpRequest(baseUrl, m, p, { token: o.token === undefined ? token : o.token, ...o }) };
}

/** 读取 SSE 直到 predicate 命中或超时，返回解析后的事件数组。 */
export async function collectSse(baseUrl, token, { until, timeoutMs = 20_000, sessionId = null, fromSeq = null } = {}) {
  const ac = new AbortController();
  const events = [];
  const url = new URL('/api/v2/sessions/stream', baseUrl);
  if (sessionId) url.searchParams.set('sessionId', sessionId);
  if (fromSeq !== null) url.searchParams.set('fromSeq', String(fromSeq));
  const headers = { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' };
  // 两种续传方式都要能用（契约 §4.2：Last-Event-ID 或 ?fromSeq=）
  if (fromSeq !== null) headers['Last-Event-ID'] = String(fromSeq);
  const done = (async () => {
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buf += decoder.decode(value, { stream: true });
        let index;
        while ((index = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, index);
          buf = buf.slice(index + 2);
          if (!chunk.trim() || chunk.startsWith(':')) continue;
          const idLine = /^id: (\d+)$/m.exec(chunk);
          const evLine = /^event: (.+)$/m.exec(chunk);
          const dataLine = /^data: (.*)$/m.exec(chunk);
          events.push({ id: idLine ? Number(idLine[1]) : null, event: evLine ? evLine[1] : null, data: dataLine ? JSON.parse(dataLine[1]) : null });
          if (until && until(events)) {
            ac.abort();
            return events;
          }
        }
      }
    } catch {
      /* aborted */
    }
    return events;
  })();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  await done;
  clearTimeout(timer);
  return events;
}
