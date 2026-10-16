#!/usr/bin/env node
/**
 * UI 证据用的**中继 + 网关夹具**（fixture），不是产品代码。
 *
 * 为什么需要它：Android 端的 UI 证据要求"真机跑通并截图"，而中继（tools/dsh-relay）与网关 v2
 * 由其他 teammate 并行开发，做到哪一步不由本任务决定。为了不等别人、同时又不伪造截图，
 * 这里按**契约 §2/§3/§4 的形状**自己起一个最小的中继 + 网关替身：
 *
 * - 手机侧看到的是**真实 WebSocket 握手 + 真实隧道帧**（req/res/chunk/end、SSE 长流）；
 *   也就是说 App 的 RelayClient / TunnelHttp / SSE 解析全部是当真在跑，只有"数据源"是夹具。
 * - 手机**不直连 PC**：本脚本监听 9443（中继角色），网关逻辑在同一进程内被隧道调用，
 *   与真实部署里"中继进程 + 网关进程"的差异只在进程数。
 * - 夹具数据按契约字段构造（含中文、emoji、工具调用、交付物、待办、git 徽标、diff）。
 *
 * 用法：
 *   node mock-tunnel.mjs --port 9443 [--home-name DESKTOP-DEV]
 * 控制面（供 run-ui-check.ps1 驱动"电脑离线/在线"）：
 *   POST /__control/offline | /__control/online | GET /__control/state
 */

import http from 'node:http';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const PORT = Number(argOf('--port', '9443'));
const HOME_NAME = argOf('--home-name', 'DESKTOP-DEV');
const HOME_ID = 'home_9f2cAbCdEfGh1234567890';
const DEVICE_TOKEN = 'dshr_fixtureDeviceToken1234567890';
const API_TOKEN = 'dshr_fixtureApiToken1234567890';
const PAIR_CODE = argOf('--code', '482913');
const WORKSPACE = 'D:\\Workspace\\dsh_android';

let homeOnline = true;
let turnCounter = 3;
// 模拟"旧网关"：pair/claim 不带 relay 块 → App 必须提示"该电脑未启用中继"
let legacyGateway = args.includes('--legacy-gateway');
const streams = new Set(); // 活跃的 SSE 流
const runningTurns = new Map(); // sessionId -> { timer, turn }（用于 abort 语义）

// ---------------------------------------------------------------- 夹具数据

const sessions = [
  {
    id: 'session-88e9459c-3f21-4b77-9c11-0a1b2c3d4e5f',
    title: '远程控制台开发',
    workspace: WORKSPACE,
    cwd: WORKSPACE,
    createdAt: Date.now() - 5 * 3600 * 1000,
    updatedAt: Date.now() - 40 * 1000,
    turns: 3,
    steps: 249,
    lastTurn: { state: 'ended', reason: 'completed' },
    live: true,
    origin: 'user',
    agentPreset: 'standard',
    bytes: 1598845,
    eventCount: 1779,
    hasChanges: true,
    changeCount: 7,
    source: 'computer',
    writable: false,
  },
  {
    id: 'session-3ab77d10-1111-4222-8333-444455556666',
    title: '排查构建失败原因',
    workspace: WORKSPACE,
    cwd: WORKSPACE,
    createdAt: Date.now() - 26 * 3600 * 1000,
    updatedAt: Date.now() - 3 * 3600 * 1000,
    turns: 2,
    steps: 88,
    lastTurn: { state: 'ended', reason: 'completed' },
    live: false,
    origin: 'user',
    agentPreset: 'standard',
    bytes: 240112,
    eventCount: 402,
    hasChanges: false,
    changeCount: 0,
    source: 'computer',
    writable: false,
  },
  {
    id: 'session-9c1e2f30-2222-4333-8444-555566667777',
    title: '整理协议契约文档',
    workspace: 'D:\\Workspace\\dsh_docs',
    cwd: 'D:\\Workspace\\dsh_docs',
    createdAt: Date.now() - 3 * 24 * 3600 * 1000,
    updatedAt: Date.now() - 30 * 3600 * 1000,
    turns: 5,
    steps: 311,
    lastTurn: { state: 'ended', reason: 'completed' },
    live: false,
    origin: 'user',
    agentPreset: 'standard',
    bytes: 998877,
    eventCount: 1201,
    hasChanges: true,
    changeCount: 3,
    source: 'computer',
    writable: false,
  },
  {
    id: 'session-sub-agent-0001',
    title: '子代理：扫描测试用例',
    workspace: WORKSPACE,
    cwd: WORKSPACE,
    createdAt: Date.now() - 2 * 3600 * 1000,
    updatedAt: Date.now() - 2 * 3600 * 1000,
    turns: 1,
    steps: 12,
    lastTurn: { state: 'ended', reason: 'completed' },
    live: false,
    origin: 'subagent',
    agentPreset: 'standard',
    bytes: 12000,
    eventCount: 40,
    hasChanges: false,
    changeCount: 0,
    source: 'computer',
    writable: false,
  },
  {
    id: 'session-sdk-7788-99aa-bbcc-ddeeff001122',
    title: '手机任务：跑一遍单元测试',
    workspace: WORKSPACE,
    cwd: WORKSPACE,
    createdAt: Date.now() - 25 * 60 * 1000,
    updatedAt: Date.now() - 4 * 60 * 1000,
    turns: 1,
    steps: 18,
    lastTurn: { state: 'ended', reason: 'completed' },
    live: false,
    origin: 'user',
    agentPreset: '',
    bytes: 41000,
    eventCount: 96,
    hasChanges: false,
    changeCount: 0,
    source: 'phone',
    writable: true,
  },
  {
    id: 'session-sdk-aabb-ccdd-eeff-001122334455',
    title: '手机任务：生成发布说明',
    workspace: WORKSPACE,
    cwd: WORKSPACE,
    createdAt: Date.now() - 2 * 24 * 3600 * 1000,
    updatedAt: Date.now() - 20 * 3600 * 1000,
    turns: 2,
    steps: 33,
    lastTurn: { state: 'ended', reason: 'completed' },
    live: false,
    origin: 'user',
    agentPreset: '',
    bytes: 66000,
    eventCount: 150,
    hasChanges: false,
    changeCount: 0,
    source: 'phone',
    writable: true,
  },
];

const transcripts = {
  'session-88e9459c-3f21-4b77-9c11-0a1b2c3d4e5f': [
    {
      seq: 12,
      role: 'user',
      at: Date.now() - 3 * 3600 * 1000,
      text: '帮我把 Android 客户端重构为深色对话式控制台，并留下真机截图证据 🚀',
      toolCalls: [],
      deliverables: [],
    },
    {
      seq: 40,
      role: 'assistant',
      at: Date.now() - 3 * 3600 * 1000 + 60000,
      text:
        '先把工具链与既有实现摸清楚，再动手改。\n' +
        '已确认：AGP 8.7.3 / Gradle 8.9 / Kotlin 2.0.21 / Compose BOM 2024.09.00，compileSdk 34、minSdk 26；' +
        '现有 75 个单元测试必须继续通过。',
      toolCalls: [
        {
          id: 'call_1',
          name: 'pwsh',
          args: { command: 'gradlew.bat :app:testDebugUnitTest --no-daemon --console=plain' },
          result: 'BUILD SUCCESSFUL in 25s\n212 tests completed, 0 failed',
          isError: false,
          truncated: false,
          durationMs: 25120,
        },
        {
          id: 'call_2',
          name: 'Read',
          args: { path: 'android/app/src/main/java/com/deepseek/dshremote/ui/theme/Color.kt' },
          result: 'ENOENT: no such file or directory, open Color.kt（旧调色板已删除，改用 DarkColors.kt）',
          isError: true,
          truncated: false,
          durationMs: 12,
        },
        {
          id: 'call_3',
          name: 'write_todos',
          args: {
            todos: [
              { content: '中继客户端 + 隧道 HTTP', status: 'completed' },
              { content: '对话流 UI + 工具折叠卡', status: 'completed' },
              { content: '工作区浏览 / 改动 / diff', status: 'completed' },
              { content: '真机截图证据', status: 'in_progress' },
            ],
          },
          result: '{"ok":true}',
          isError: false,
          truncated: false,
          durationMs: 8,
        },
      ],
      deliverables: [
        {
          path: `${WORKSPACE}\\android\\app\\build\\outputs\\apk\\debug\\app-debug.apk`,
          description: 'debug 包（18.0 MB，含中继隧道客户端）',
        },
      ],
    },
  ],
  'session-3ab77d10-1111-4222-8333-444455556666': [
    {
      seq: 5,
      role: 'user',
      at: Date.now() - 26 * 3600 * 1000,
      text: '构建失败了，帮我看下日志',
      toolCalls: [],
      deliverables: [],
    },
    {
      seq: 9,
      role: 'assistant',
      at: Date.now() - 26 * 3600 * 1000 + 30000,
      text: '定位到 AGP 版本与 Gradle 不匹配，已改回 8.7.3 + 8.9 组合。',
      toolCalls: [],
      deliverables: [],
    },
  ],
  'session-sdk-7788-99aa-bbcc-ddeeff001122': [
    {
      seq: 1,
      role: 'user',
      at: Date.now() - 25 * 60 * 1000,
      text: '把 android 模块的单元测试跑一遍，失败的话帮我定位原因',
      toolCalls: [],
      deliverables: [],
    },
    {
      seq: 6,
      role: 'assistant',
      at: Date.now() - 24 * 60 * 1000,
      text: '212 个用例全部通过，没有失败用例。',
      toolCalls: [
        {
          id: 'call_sdk_1',
          name: 'pwsh',
          args: { command: 'gradlew :app:testDebugUnitTest' },
          result: 'BUILD SUCCESSFUL：212 tests completed, 0 failed',
          isError: false,
          truncated: false,
          durationMs: 25000,
        },
      ],
      deliverables: [],
    },
  ],
};

const filesFixture = {
  [WORKSPACE]: [
    { name: 'android', path: `${WORKSPACE}\\android`, type: 'dir', size: null, modifiedAt: Date.now() - 60000 },
    { name: 'docs', path: `${WORKSPACE}\\docs`, type: 'dir', size: null, modifiedAt: Date.now() - 3600000 },
    { name: 'tools', path: `${WORKSPACE}\\tools`, type: 'dir', size: null, modifiedAt: Date.now() - 7200000 },
    { name: 'README.md', path: `${WORKSPACE}\\README.md`, type: 'file', size: 20565, modifiedAt: Date.now() - 86400000 },
    { name: 'build.gradle.kts', path: `${WORKSPACE}\\build.gradle.kts`, type: 'file', size: 812, modifiedAt: Date.now() - 43200000 },
  ],
  [`${WORKSPACE}\\android`]: [
    { name: 'app', path: `${WORKSPACE}\\android\\app`, type: 'dir', size: null, modifiedAt: Date.now() - 30000 },
    { name: 'gradle', path: `${WORKSPACE}\\android\\gradle`, type: 'dir', size: null, modifiedAt: Date.now() - 900000 },
    { name: 'BUILD.md', path: `${WORKSPACE}\\android\\BUILD.md`, type: 'file', size: 9436, modifiedAt: Date.now() - 120000 },
    { name: 'gradlew.bat', path: `${WORKSPACE}\\android\\gradlew.bat`, type: 'file', size: 2763, modifiedAt: Date.now() - 2000000 },
    { name: 'settings.gradle.kts', path: `${WORKSPACE}\\android\\settings.gradle.kts`, type: 'file', size: 612, modifiedAt: Date.now() - 3000000 },
  ],
};

const fileContent = {
  [`${WORKSPACE}\\README.md`]: '# DSH Remote v2\n\n手机经中继远程驱动家里的 PC。\n\n## 能力\n\n- 电脑会话：只读镜像\n- 手机任务：可续聊\n- 工作区：文件 / 改动 / diff\n\n## 构建\n\n```powershell\n.\\gradlew.bat :app:assembleDebug --no-daemon\n```\n\n| 项 | 值 |\n| --- | --- |\n| Kotlin | 2.0.21 |\n| AGP | 8.7.3 |\n\n> 提示：模拟器用 `10.0.2.2` 访问宿主机的夹具中继。\n\n1. 配对\n2. 连接中继\n\n详见 [BUILD.md](android/BUILD.md)。\n',
  [`${WORKSPACE}\\android\\BUILD.md`]: '# Android 客户端构建说明\n\n## 1. 工具链\nJDK17 + Gradle 8.9 + AGP 8.7.3\n\n## 7. 真机 / UI 自动化注意事项\n1. 明文提示卡会把按钮顶下去约 280px\n2. uiautomator dump 是 UTF-8\n',
  [`${WORKSPACE}\\build.gradle.kts`]: 'plugins {\n    id("com.android.application") version "8.7.3"\n}\n',
};

const diffFixture = `diff --git a/android/app/src/main/java/com/deepseek/dshremote/data/relay/RelayClient.kt b/android/app/src/main/java/com/deepseek/dshremote/data/relay/RelayClient.kt
index 1a2b3c4..5d6e7f8 100644
--- a/android/app/src/main/java/com/deepseek/dshremote/data/relay/RelayClient.kt
+++ b/android/app/src/main/java/com/deepseek/dshremote/data/relay/RelayClient.kt
@@ -1,6 +1,7 @@
 package com.deepseek.dshremote.data.relay
 
+import com.deepseek.dshremote.data.Logger
 import kotlinx.coroutines.delay
 
 /** 中继隧道客户端：手机只连中继，不直连 PC。 */
@@ -18,7 +19,9 @@ class RelayClient(
-        val handle = transport.connect(url, headers, listener)
+        val handle = transport.connect(url, headers, listener)
+        // 握手 15s 未 ready 视为失败，避免 UI 永久停在"连接中"
+        lastPongAt = clock()
         return handle
 
@@ -40,3 +43,4 @@ class RelayClient(
-        delay(1_000)
+        val delayMs = backoff.nextDelayMs()
+        delay(delayMs)
`;

// ---------------------------------------------------------------- WebSocket 服务端（RFC6455 最小实现）

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

const textFrame = (value) => encodeFrame(0x1, Buffer.from(value, 'utf8'));
const pongFrame = (payload) => encodeFrame(0xA, payload);

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.role = null;
    this.buffered = 0;
  }

  send(value) {
    if (this.closed) return;
    this.socket.write(textFrame(value));
  }

  sendFrame(frame) {
    if (this.closed) return;
    this.socket.write(frame);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {
      /* 忽略 */
    }
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b1 = this.buffer[0];
      const b2 = this.buffer[1];
      const opcode = b1 & 0x0f;
      const masked = (b2 & 0x80) !== 0;
      let len = b2 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;
      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.subarray(offset + maskLen + len);
      this.handle(opcode, payload);
    }
  }

  handle(opcode, payload) {
    if (opcode === 0x8) {
      this.closed = true;
      try {
        this.socket.end();
      } catch {
        /* 忽略 */
      }
      return;
    }
    if (opcode === 0x9) {
      this.sendFrame(pongFrame(payload));
      return;
    }
    if (opcode !== 0x1) return;
    let frame;
    try {
      frame = JSON.parse(payload.toString('utf8'));
    } catch {
      this.send(JSON.stringify({ t: 'error', code: 'bad_request', message: '夹具只接受 JSON 帧', fatal: false }));
      return;
    }
    onTunnelFrame(this, frame);
  }
}

// ---------------------------------------------------------------- 隧道帧处理

function onTunnelFrame(conn, frame) {
  switch (frame.t) {
    case 'hello':
      conn.role = frame.role;
      conn.send(
        JSON.stringify({
          t: 'ready',
          proto: 2,
          role: frame.role,
          homeId: HOME_ID,
          homeName: HOME_NAME,
          homeOnline,
        }),
      );
      log(`hello 已接受 role=${frame.role} name=${frame.name || '-'} homeOnline=${homeOnline}`);
      break;

    case 'ping':
      conn.send(JSON.stringify({ t: 'pong', id: frame.id }));
      break;

    case 'pong':
      break;

    case 'cancel':
      closeStream(frame.id, 'cancelled');
      break;

    case 'req':
      handleRequest(conn, frame);
      break;

    default:
      log(`忽略未知帧 ${frame.t}`);
  }
}

function mask(value) {
  return typeof value === 'string' && value.length > 4 ? `${value.slice(0, 4)}****` : '****';
}

function log(message) {
  process.stdout.write(`[fixture] ${message}\n`);
}

function sendJson(conn, id, status, body) {
  const payload = Buffer.from(body, 'utf8');
  conn.send(JSON.stringify({ t: 'res', id, status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  // 大响应刻意切片：验证 App 的 chunk 重组（契约 §3.2 单帧 ≤256KiB）
  const piece = 6000;
  for (let offset = 0; offset < payload.length; offset += piece) {
    conn.send(
      JSON.stringify({ t: 'chunk', id, dataB64: payload.subarray(offset, offset + piece).toString('base64') }),
    );
  }
  conn.send(JSON.stringify({ t: 'end', id }));
}

function sendError(conn, id, status, code, message) {
  sendJson(conn, id, status, JSON.stringify({ error: { code, message } }));
}

function requireOnline(conn, id) {
  if (homeOnline) return false;
  sendError(conn, id, 503, 'home_offline', '电脑离线：PC 网关隧道未连接');
  return true;
}

function handleRequest(conn, frame) {
  const url = new URL(frame.path, 'http://localhost');
  const path = url.pathname;
  const id = frame.id;
  log(`req ${frame.method} ${frame.path}`);

  if (requireOnline(conn, id)) return;

  // ---- v1 兼容端点
  if (path === '/api/v1/health') {
    return sendJson(
      conn,
      id,
      200,
      JSON.stringify({
        ok: true,
        // 契约 §4.5：apiVersion 恒为 1，v2 能力看 supportedApiVersions
        apiVersion: 1,
        supportedApiVersions: [1, 2],
        serverName: HOME_NAME,
        gatewayVersion: '2.0.0',
        dshVersion: '0.9.0-fixture',
        uptimeMs: 123456,
        activeTasks: 0,
        queuedTasks: 0,
        pairingOpen: false,
        authRequired: true,
        relay: { enabled: true, connected: homeOnline },
      }),
    );
  }
  if (path === '/api/v1/devices') {
    return sendJson(
      conn,
      id,
      200,
      JSON.stringify({
        devices: [
          { tokenId: 'tok_fixture01', deviceName: 'Pixel 8 (fixture)', pairedAt: Date.now() - 3600000, lastSeenAt: Date.now(), revoked: false },
        ],
      }),
    );
  }
  if (frame.method === 'DELETE' && path.startsWith('/api/v1/devices/')) {
    return sendJson(conn, id, 204, '');
  }

  // ---- 会话镜像
  if (path === '/api/v2/sessions' && frame.method === 'GET') {
    const source = url.searchParams.get('source');
    const include = url.searchParams.get('include');
    let list = sessions;
    if (source) list = list.filter((item) => item.source === source);
    if (include !== 'subagent') list = list.filter((item) => item.origin !== 'subagent');
    return sendJson(conn, id, 200, JSON.stringify({ sessions: list, nextCursor: null }));
  }
  const transcriptMatch = path.match(/^\/api\/v2\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch) {
    const sessionId = decodeURIComponent(transcriptMatch[1]);
    const messages = transcripts[sessionId] || [];
    return sendJson(conn, id, 200, JSON.stringify({ sessionId, messages, nextCursor: null }));
  }
  const turnsMatch = path.match(/^\/api\/v2\/sessions\/([^/]+)\/turns$/);
  if (turnsMatch && frame.method === 'POST') {
    const sessionId = decodeURIComponent(turnsMatch[1]);
    const session = sessions.find((item) => item.id === sessionId);
    if (session && session.source === 'computer') {
      return sendError(
        conn,
        id,
        409,
        'session_busy',
        '该会话正由电脑端驱动，请在电脑端继续或在手机端新建会话',
      );
    }
    turnCounter += 1;
    const turn = turnCounter;
    const accepted = JSON.stringify({ accepted: true, sessionId, turnId: `turn_${turn}`, fromSeq: 100 + turn });
    sendJson(conn, id, 202, accepted);
    simulateTurn(sessionId, turn);
    return undefined;
  }
  const abortMatch = path.match(/^\/api\/v2\/sessions\/([^/]+)\/abort$/);
  if (abortMatch) {
    const sessionId = decodeURIComponent(abortMatch[1]);
    clearRunningTurn(sessionId);
    const target = sessions.find((item) => item.id === sessionId);
    if (target) {
      target.live = false;
      target.updatedAt = Date.now();
      target.lastTurn = { state: 'aborted', reason: 'aborted' };
    }
    // 契约裁定：SDK 没有 cancel，abort 只能杀进程 ⇒ resumable:false
    for (const stream of streams) {
      pushSse(stream, 'turn.ended', { sessionId, turn: turnCounter, reason: 'aborted', turnId: `turn_${turnCounter}`, resumable: false });
    }
    log(`abort session=${sessionId} → resumable:false（夹具按契约语义返回）`);
    return sendJson(conn, id, 202, JSON.stringify({ accepted: true, sessionId, resumable: false }));
  }
  if (path === '/api/v2/sessions/stream') {
    return openSse(conn, id, url);
  }
  if (path === '/api/v2/tasks' && frame.method === 'POST') {
    turnCounter += 1;
    const sessionId = `session-sdk-new-${turnCounter}`;
    const prompt = safeJson(frame.bodyB64)?.prompt || '';
    sessions.unshift({
      id: sessionId,
      title: prompt.slice(0, 18) || '手机新任务',
      workspace: WORKSPACE,
      cwd: WORKSPACE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: 1,
      steps: 0,
      lastTurn: { state: 'running', reason: null },
      live: true,
      origin: 'user',
      agentPreset: '',
      bytes: 0,
      eventCount: 0,
      hasChanges: false,
      changeCount: 0,
      source: 'phone',
      writable: true,
    });
    transcripts[sessionId] = [
      { seq: 1, role: 'user', at: Date.now(), text: prompt, toolCalls: [], deliverables: [] },
    ];
    sendJson(
      conn,
      id,
      202,
      JSON.stringify({ sessionId, accepted: true, source: 'phone', fromSeq: 0 }),
    );
    setTimeout(() => simulateTurn(sessionId, 1), 400);
    return undefined;
  }

  // ---- 工作区
  if (path === '/api/v2/workspaces') {
    return sendJson(
      conn,
      id,
      200,
      JSON.stringify({
        workspaces: [
          { path: WORKSPACE, label: 'dsh_android', exists: true, vcs: 'git', branch: 'main', changed: 7, insertions: 412, deletions: 88 },
          { path: 'D:\\Workspace\\dsh_docs', label: 'dsh_docs', exists: true, vcs: 'git', branch: 'main', changed: 0, insertions: 0, deletions: 0 },
        ],
        default: WORKSPACE,
      }),
    );
  }
  if (path === '/api/v2/workspaces/files') {
    const target = url.searchParams.get('path') || WORKSPACE;
    const entries = filesFixture[target] || [];
    return sendJson(
      conn,
      id,
      200,
      JSON.stringify({ workspace: WORKSPACE, path: target, entries, truncated: false }),
    );
  }
  if (path === '/api/v2/workspaces/file') {
    const target = url.searchParams.get('path') || '';
    const text = fileContent[target];
    if (text === undefined) {
      return sendJson(
        conn,
        id,
        200,
        JSON.stringify({ path: target, name: target.split('\\').pop(), size: 2048, modifiedAt: Date.now(), binary: true, truncated: false, text: '' }),
      );
    }
    return sendJson(
      conn,
      id,
      200,
      JSON.stringify({
        path: target,
        name: target.split('\\').pop(),
        size: Buffer.byteLength(text, 'utf8'),
        modifiedAt: Date.now() - 120000,
        binary: false,
        truncated: false,
        text,
      }),
    );
  }
  if (path === '/api/v2/workspaces/changes') {
    return sendJson(
      conn,
      id,
      200,
      JSON.stringify({
        workspace: WORKSPACE,
        vcs: 'git',
        branch: 'main',
        changed: [
          { path: 'android/app/src/main/java/com/deepseek/dshremote/data/relay/RelayClient.kt', status: 'M', staged: false, insertions: 187, deletions: 12, isBinary: false },
          { path: 'android/app/src/main/java/com/deepseek/dshremote/data/relay/TunnelHttp.kt', status: 'A', staged: false, insertions: 74, deletions: 0, isBinary: false },
          { path: 'android/app/src/main/java/com/deepseek/dshremote/ui/HomeScreen.kt', status: 'D', staged: false, insertions: 0, deletions: 213, isBinary: false },
          { path: 'android/app/src/main/java/com/deepseek/dshremote/ui/screens/DiffScreen.kt', status: 'M', staged: true, insertions: 151, deletions: 63, isBinary: false },
        ],
        untracked: ['android/app/build/tmp.txt', 'android/evidence/v2/raw/'],
        clean: false,
      }),
    );
  }
  if (path === '/api/v2/workspaces/diff') {
    return sendJson(
      conn,
      id,
      200,
      JSON.stringify({
        workspace: WORKSPACE,
        path: WORKSPACE,
        file: url.searchParams.get('file') || '',
        vcs: 'git',
        unified: diffFixture,
        truncated: false,
      }),
    );
  }
  if (path === '/api/v2/workspaces/search') {
    const query = url.searchParams.get('q') || '';
    return sendJson(
      conn,
      id,
      200,
      JSON.stringify({
        hits: [
          { path: 'android/app/src/main/java/com/deepseek/dshremote/data/relay/RelayClient.kt', name: 'RelayClient.kt', line: 42, text: `中继隧道客户端：手机只连中继（匹配 "${query}"）`, kind: 'content' },
          { path: 'android/BUILD.md', name: 'BUILD.md', line: 7, text: '工具链：JDK17 + Gradle 8.9 + AGP 8.7.3', kind: 'content' },
          { path: 'docs/01-设计/协议契约-v2.md', line: null, text: '', kind: 'file' },
        ],
      }),
    );
  }

  return sendError(conn, id, 404, 'not_found', `夹具未实现：${frame.method} ${path}`);
}

function safeJson(bodyB64) {
  if (!bodyB64) return null;
  try {
    return JSON.parse(Buffer.from(bodyB64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- SSE 长流

function openSse(conn, id, url) {
  const stream = { id, conn };
  streams.add(stream);
  conn.send(
    JSON.stringify({
      t: 'res',
      id,
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    }),
  );
  const fromSeq = url.searchParams.get('fromSeq');
  log(`SSE 已建立 id=${id} fromSeq=${fromSeq || '-'}`);
  pushSse(stream, 'heartbeat', { at: Date.now() });
  for (const session of sessions) {
    pushSse(stream, 'session.updated', {
      sessionId: session.id,
      updatedAt: session.updatedAt,
      live: session.live,
      source: session.source,
    });
  }
  // 心跳 15s（契约 §4.2）
  stream.timer = setInterval(() => {
    if (!homeOnline) return;
    pushSse(stream, 'heartbeat', { at: Date.now() });
  }, 15000);
}

function pushSse(stream, event, data) {
  if (!stream || stream.conn.closed) return;
  const text = `id: ${data.seq || data.at || Date.now()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  stream.conn.send(JSON.stringify({ t: 'chunk', id: stream.id, dataB64: Buffer.from(text, 'utf8').toString('base64') }));
}

function closeStream(id, reason) {
  for (const stream of streams) {
    if (stream.id === id) {
      streams.delete(stream);
      if (stream.timer) clearInterval(stream.timer);
      log(`SSE 已取消 id=${id}（${reason}）`);
    }
  }
}

/** 编排一轮"网关自有会话"的增量事件（SDK profile 驱动的等价形状）。 */
function simulateTurn(sessionId, turn) {
  const session = sessions.find((item) => item.id === sessionId);
  if (session) {
    session.live = true;
    session.updatedAt = Date.now();
  }
  const phoneHead =
    '## 单元测试结果\n\n' +
    '收到，我先在本工作区里跑一遍测试。\n\n' +
    '```\n' +
    'gradlew :app:testDebugUnitTest\n' +
    '```\n\n';
  const phoneTail =
    '### 结论\n\n' +
    '- **212 个用例全部通过** ✅\n' +
    '- 失败用例：0\n\n' +
    '| 项目 | 结果 |\n' +
    '| --- | --- |\n' +
    '| 单元测试 | 通过 |\n' +
    '| 构建 | 通过 |\n\n' +
    '> 提示：跑真机 UI 证据前先 `pm clear`，否则旧令牌会让配对页被跳过。\n\n' +
    '- [x] 工具链核对\n' +
    '- [ ] 真机截图\n\n' +
    '详见 [BUILD.md](android/BUILD.md)。\n';
  const phoneReply = phoneHead + phoneTail;
  // 分段下发：中途会有一帧"围栏代码块还没闭合"的状态，用来验证流式解析不炸
  const pieces = [
    '## 单元测试结果\n\n',
    '收到，我先在本工作区里跑一遍测试。\n\n',
    '```\n',
    'gradlew :app:testDebugUnitTest\n',
    '```\n\n',
  ];
  let seq = 100 + turn * 10;
  const steps = [];
  steps.push({ delay: 400, event: 'turn.started', data: { sessionId, turn, fromSeq: seq, source: 'phone' } });
  for (const piece of pieces) {
    seq += 1;
    steps.push({ delay: 900, event: 'message.delta', data: { sessionId, seq, role: 'assistant', text: piece } });
  }
  seq += 1;
  steps.push({
    delay: 900,
    event: 'tool.call',
    data: { sessionId, seq, name: 'pwsh', args: { command: 'gradlew :app:testDebugUnitTest' } },
  });
  seq += 1;
  steps.push({
    delay: 1500,
    event: 'tool.result',
    data: { sessionId, seq, isError: false, result: 'BUILD SUCCESSFUL in 25s\n212 tests completed, 0 failed' },
  });
  seq += 1;
  steps.push({
    delay: 900,
    event: 'message.delta',
    data: { sessionId, seq, role: 'assistant', text: phoneTail },
  });
  // 契约裁定：turn.ended 带 turnId 与 resumable（正常结束 = 可继续）
  steps.push({ delay: 900, event: 'turn.ended', data: { sessionId, turn, reason: 'completed', turnId: `turn_${turn}`, resumable: true } });

  // 整轮约 9s：真机上一轮真实模型输出通常几十秒，夹具刻意放慢到
  // "足够被抓到流式中间态"（否则 uiautomator dump 还没跑完，轮次就结束了）
  let time = 0;
  const timers = [];
  for (const step of steps) {
    time += step.delay;
    timers.push(setTimeout(() => {
      for (const stream of streams) pushSse(stream, step.event, step.data);
      if (step.event === 'turn.ended') {
        runningTurns.delete(sessionId);
        const target = sessions.find((item) => item.id === sessionId);
        if (target) {
          target.live = false;
          target.turns = Math.max(target.turns, turn);
          target.updatedAt = Date.now();
          target.lastTurn = { state: 'ended', reason: 'completed' };
          const list = transcripts[sessionId] || (transcripts[sessionId] = []);
          list.push({
            seq: seq,
            role: 'assistant',
            at: Date.now(),
            text: phoneReply,
            toolCalls: [
              {
                id: `call_sim_${turn}`,
                name: 'pwsh',
                args: { command: 'gradlew :app:testDebugUnitTest' },
                result: 'BUILD SUCCESSFUL in 25s\n212 tests completed, 0 failed',
                isError: false,
                truncated: false,
                durationMs: 25000,
              },
            ],
            deliverables: [],
          });
        }
      }
    }, time));
  }
  runningTurns.set(sessionId, { timers, turn });
}

/** abort：清掉这一轮还没发出去的事件（模拟"杀进程"）。 */
function clearRunningTurn(sessionId) {
  const running = runningTurns.get(sessionId);
  if (!running) return;
  for (const timer of running.timers) clearTimeout(timer);
  runningTurns.delete(sessionId);
}

// ---------------------------------------------------------------- HTTP + WS 服务端

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/__control/offline') {
    setHomeOnline(false);
    return json(res, 200, { ok: true, homeOnline });
  }
  if (req.method === 'POST' && url.pathname === '/__control/online') {
    setHomeOnline(true);
    return json(res, 200, { ok: true, homeOnline });
  }
  if (url.pathname === '/__control/state') {
    return json(res, 200, {
      ok: true,
      homeOnline,
      legacyGateway,
      devices: deviceConnections.size,
      streams: streams.size,
      sessions: sessions.length,
      runningTurns: runningTurns.size,
      tunnelUrl: `ws://10.0.2.2:${PORT}/api/v2/tunnel/device`,
    });
  }
  if (req.method === 'POST' && url.pathname === '/__control/legacy-gateway') {
    legacyGateway = true;
    log('已切换到"旧网关"模式：pair/claim 不再返回 relay 块');
    return json(res, 200, { ok: true, legacyGateway });
  }
  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      relayVersion: '2.0.0-fixture',
      apiVersion: 2,
      uptimeMs: Math.round(process.uptime() * 1000),
      homes: 1,
      devices: deviceConnections.size,
      relayName: `relay.fixture:${PORT}`,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/v2/pair/claim') {
    return readBody(req, (body) => {
      const parsed = (() => {
        try {
          return JSON.parse(body || '{}');
        } catch {
          return {};
        }
      })();
      log(`pair/claim code=${mask(parsed.code)} deviceName=${parsed.deviceName || '-'}`);
      if (String(parsed.code || '') !== PAIR_CODE) {
        return json(res, 401, { error: { code: 'pairing_bad_code', message: '配对码错误或已过期' } });
      }
      if (!homeOnline) {
        return json(res, 503, { error: { code: 'home_offline', message: '电脑隧道不在线' } });
      }
      if (legacyGateway) {
        // 旧网关：没有 relay 块 —— App 必须提示"该电脑未启用中继"（契约裁定：relay 块是唯一判据）
        return json(res, 200, {
          token: API_TOKEN,
          tokenId: 'tok_fixture01',
          serverName: 'LEGACY-PC',
          expiresAt: null,
        });
      }
      return json(res, 200, {
        token: API_TOKEN,
        tokenId: 'tok_fixture01',
        serverName: HOME_NAME,
        expiresAt: null,
        relay: {
          homeId: HOME_ID,
          deviceToken: DEVICE_TOKEN,
          tunnelUrl: `ws://10.0.2.2:${PORT}/api/v2/tunnel/device`,
        },
      });
    });
  }
  return json(res, 404, { error: { code: 'not_found', message: '夹具只实现契约端点' } });
});

const deviceConnections = new Set();

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/v2/tunnel/device') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const auth = req.headers['authorization'] || '';
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  const conn = new WsConnection(socket);
  deviceConnections.add(conn);
  log(`设备隧道已连接 Authorization=Bearer ${mask(auth.replace(/^Bearer\s+/i, ''))}`);
  socket.on('data', (chunk) => conn.push(chunk));
  socket.on('close', () => {
    deviceConnections.delete(conn);
    log('设备隧道已断开');
  });
  socket.on('error', () => {
    deviceConnections.delete(conn);
  });
});

function setHomeOnline(next) {
  if (homeOnline === next) return;
  homeOnline = next;
  const kind = next ? 'home_online' : 'home_offline';
  for (const conn of deviceConnections) {
    conn.send(JSON.stringify({ t: 'notice', kind, homeId: HOME_ID }));
  }
  log(`电脑状态切换为 ${kind}（已通知 ${deviceConnections.size} 个设备连接）`);
  if (!next) {
    for (const stream of streams) closeStream(stream.id, 'home_offline');
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, done) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => done(body));
}

server.listen(PORT, '0.0.0.0', () => {
  log(`夹具已启动：中继 HTTP http://0.0.0.0:${PORT} · 隧道 ws://0.0.0.0:${PORT}/api/v2/tunnel/device`);
  log(`手机侧（模拟器）请填 ws://10.0.2.2:${PORT}，配对码 ${PAIR_CODE}`);
});
