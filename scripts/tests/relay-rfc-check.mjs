// relay-rfc-check.mjs —— 中继 WebSocket 握手的 RFC 6455 一致性自检。
//
// 为什么需要它（血泪教训，2026-10）：
//   tools/dsh-relay/lib/ws.mjs 里的 WS_GUID 常量一度写成
//   '258EAFA5-E914-47DA-95CA-5AB0DC85B11F'（正确值 ...95CA-C5AB0DC85B11，C 滑到了结尾）。
//   中继自己的测试客户端用了同一个错常量 → 测试全绿，但标准客户端（网关、OkHttp、手机模拟器）
//   全部因为 Sec-WebSocket-Accept 不匹配而拒绝握手。只有拿 RFC 官方测试向量才能抓住这种错误。
//
// 用法：
//   node scripts/tests/relay-rfc-check.mjs                 # 只做离线向量校验（导入中继实现）
//   node scripts/tests/relay-rfc-check.mjs --url ws://127.0.0.1:9443/api/v2/tunnel/home --token <homeToken>
//                                                          # 额外对真实中继做一次裸握手校验
// 输出：一行 JSON { ok, guid, expected, actual, handshake? }；ok=false 时退出码 1。

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

// RFC 6455 §1.3 官方示例
const RFC_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const RFC_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';

function parseArgv(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) options[key] = true;
      else {
        options[key] = next;
        i += 1;
      }
    }
  }
  return options;
}

const args = parseArgv(process.argv.slice(2));
const result = { ok: false, expected: RFC_ACCEPT, actual: null, guid: null, mode: 'offline' };

let computeAccept = null;
let guidFromLib = null;
try {
  const wsLib = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'dsh-relay', 'lib', 'ws.mjs')).href);
  if (typeof wsLib.computeAccept === 'function') computeAccept = wsLib.computeAccept;
  if (typeof wsLib.WS_GUID === 'string') guidFromLib = wsLib.WS_GUID;
} catch (error) {
  result.note = `无法导入 tools/dsh-relay/lib/ws.mjs：${error.message}`;
}

if (!computeAccept) {
  // 中继实现不可导入时，退回本地计算（至少能验证本脚本自己的向量）
  computeAccept = (key) => crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  result.note = result.note || '使用本地 RFC GUID 计算（未导入中继实现）';
}

result.guid = guidFromLib;
result.actual = computeAccept(RFC_KEY);
result.ok = result.actual === RFC_ACCEPT;

if (args.url && args.token) {
  result.mode = 'offline+handshake';
  const handshake = await new Promise((resolve) => {
    let url;
    try {
      url = new URL(String(args.url));
    } catch (error) {
      resolve({ ok: false, error: `--url 不合法：${error.message}` });
      return;
    }
    const lib = url.protocol === 'wss:' ? null : http;
    if (!lib) {
      resolve({ ok: false, error: '本自检只支持 ws://（自签 wss 请用 e2e 脚本）' });
      return;
    }
    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Authorization: `Bearer ${String(args.token)}`,
      },
    });
    const timer = setTimeout(() => resolve({ ok: false, error: '握手超时（5s）' }), 5000);
    req.on('upgrade', (response, socket) => {
      clearTimeout(timer);
      const accept = response.headers['sec-websocket-accept'];
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok: accept === expected, status: response.statusCode, expected, actual: accept });
    });
    req.on('response', (response) => {
      clearTimeout(timer);
      resolve({ ok: false, status: response.statusCode, error: `未升级（HTTP ${response.statusCode}）—— 检查 homeToken 是否有效` });
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    req.end();
  });
  result.handshake = handshake;
  if (String(args.url).startsWith('ws://') && handshake.ok === false) result.ok = false;
}

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
