#!/usr/bin/env node
/**
 * 最小复现：中继在 **101 响应的同一个 TCP 段**里就把 `ready` 帧发了出去。
 *
 * Node 的 `http.ClientRequest` 在 `'upgrade'` 事件里把这段"已经到达的剩余字节"作为**第三个参数**
 * `head` 交给调用方。WS 客户端如果只写 `(res, socket) => {...}` 而丢掉 `head`，
 * 就会**静默丢掉第一帧**（这里是 `ready`），表现为"隧道连上了但一直等不到 ready"。
 *
 * 用法：node probe-upgrade-head.mjs <ws url> <homeToken>
 * 期望输出：status=101 且 head.length > 0，head 里能解析出 {"t":"ready",...}
 */

import http from 'node:http';
import crypto from 'node:crypto';

const [, , rawUrl, token] = process.argv;
if (!rawUrl || !token) {
  console.error('用法：node probe-upgrade-head.mjs ws://127.0.0.1:9643/api/v2/tunnel/home <homeToken>');
  process.exit(2);
}

const url = new URL(rawUrl);
const key = crypto.randomBytes(16).toString('base64');

const request = http.request({
  host: url.hostname,
  port: url.port,
  path: url.pathname,
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    Authorization: `Bearer ${token}`,
  },
});

request.on('upgrade', (res, socket, head) => {
  console.log(`status = ${res.statusCode}`);
  console.log(`sec-websocket-accept = ${res.headers['sec-websocket-accept']}`);
  console.log(`head.length = ${head ? head.length : 0}  ← 非 0 就证明"101 与 ready 同段到达"`);
  if (head && head.length >= 2) {
    const opcode = head[0] & 0x0f;
    let length = head[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      length = head.readUInt16BE(2);
      offset = 4;
    }
    const payload = head.subarray(offset, offset + length);
    console.log(`第一帧：opcode=0x${opcode.toString(16)} length=${length}`);
    console.log(`第一帧载荷：${payload.toString('utf8')}`);
  }
  socket.end();
  process.exit(0);
});

request.on('response', (res) => {
  console.log(`未升级：HTTP ${res.statusCode}`);
  res.resume();
  process.exit(1);
});

request.on('error', (err) => {
  console.error(`连接失败：${err.message}`);
  process.exit(1);
});

request.end();
