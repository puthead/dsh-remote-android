/**
 * 替身 SDK 运行时（测试用）：按 `dsh --profile sdk` 的真实 wire 形状说 NDJSON JSON-RPC。
 *
 * 形状取自实测（见 lib/session-runner.mjs 注释）：
 * - 请求：`{"jsonrpc":"2.0","id":N,"method":"initialize"|"session/prompt"|"shutdown","params":{…}}`
 * - 响应：`{"jsonrpc":"2.0","id":N,"result":{…}}`
 * - 通知：`{"jsonrpc":"2.0","method":"session.event","params":{sessionId,event}}`
 *         `{"jsonrpc":"2.0","method":"session.status","params":{sessionId,status}}`
 *
 * 它还会**真的写一个多帧 zstd 会话文件**到 `$DSH_HOME/sessions/<slug>/<id>/session.v4.jsonl.zstd`，
 * 这样 "轮次 → SSE → 落盘 → /transcript" 的完整回路能在测试里被验证，而不是只验证推送。
 *
 * 可控钩子（环境变量）：
 * - `FAKE_SDK_REPLY`：助手回复文本（默认回显传入的 prompt）
 * - `FAKE_SDK_TOOLCALL=1`：额外推一组 tool/call + tool/result
 * - `FAKE_SDK_ERROR=<text>`：`turn/end` 以 `{kind:'error',error:{message}}` 结束
 * - `FAKE_SDK_TOOLERROR=1`：工具结果带 isError
 * - `FAKE_SDK_SLOW_MS=<n>`：在推送 assistant/message 前等待（用于测试轮次进行中的语义）
 * - `FAKE_SDK_NO_SESSION_FILE=1`：不写会话文件
 * - `FAKE_SDK_INIT_FILE=<路径>`：把 `initialize` 的 params 追加成一行 JSON
 *   （每任务模型只在这一个握手里下发，测试没有别的口子能证明它真的到了子进程）
 */
import { zstdCompressSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { encodeWorkspaceSlug } from '../../lib/dsh-home.mjs';

const DSH_HOME = process.env.DSH_HOME ?? '';
const reply = process.env.FAKE_SDK_REPLY ?? null;
const withToolCall = process.env.FAKE_SDK_TOOLCALL === '1';
const toolError = process.env.FAKE_SDK_TOOLERROR === '1';
const errorText = process.env.FAKE_SDK_ERROR ?? null;
const slowMs = Number(process.env.FAKE_SDK_SLOW_MS ?? '0');
const noSessionFile = process.env.FAKE_SDK_NO_SESSION_FILE === '1';

// 记录子进程环境里的权限档：DSH 没有权限命令行参数，任务权限档（`access`）只能靠
// DSH_PERMISSION_MODE 环境变量下发（见 lib/permission.mjs），因此测试必须能观测到它。
const envRecordFile = process.env.FAKE_SDK_ENV_FILE;
if (envRecordFile) {
  fs.appendFileSync(
    envRecordFile,
    `${JSON.stringify({
      permissionMode: process.env.DSH_PERMISSION_MODE ?? null,
      dshHome: DSH_HOME || null,
      cwd: process.cwd(),
    })}\n`,
    'utf8',
  );
}

// 记录 `initialize` 的 params：模型**只**在这个握手里下发（见 lib/session-runner.mjs 的
// #ensureRuntime），所以"手机选的模型真的生效了"这句话，在网关路径上唯一的证据就是它。
const initRecordFile = process.env.FAKE_SDK_INIT_FILE;
function recordInit(params) {
  if (!initRecordFile) return;
  fs.appendFileSync(initRecordFile, `${JSON.stringify(params ?? null)}\n`, 'utf8');
}

const sessions = new Map();
let pending = [];
let buf = '';
let nextSeq = 0;
let writeChain = Promise.resolve();

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}
function event(sessionId, ev) {
  notify('session.event', { sessionId, event: ev });
}
function status(sessionId, value) {
  notify('session.status', { sessionId, status: value });
}

function textContent(text) {
  return [{ type: 'text', text }];
}

/** 把会话事件按追加帧写入真实的多帧 zstd 会话文件。 */
function appendSessionFrame(sessionId, events) {
  if (noSessionFile || !DSH_HOME) return Promise.resolve();
  writeChain = writeChain.then(() => {
    const slug = encodeWorkspaceSlug(process.cwd());
    const dir = path.join(DSH_HOME, 'sessions', slug, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    const body = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    fs.appendFileSync(file, zstdCompressSync(Buffer.from(body, 'utf8')));
  });
  return writeChain;
}

async function handlePrompt(msg) {
  const { sessionId, contentBlocks } = msg.params ?? {};
  const prompt = (contentBlocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let state = sessions.get(sessionId);
  if (!state) {
    state = { id: sessionId, turn: 0, headerWritten: false };
    sessions.set(sessionId, state);
  }
  state.turn += 1;
  const turn = state.turn;

  const headerEvents = [];
  if (!state.headerWritten) {
    state.headerWritten = true;
    headerEvents.push({ type: 'session', version: 4, id: sessionId, createdAt: Date.now(), cwd: process.cwd(), isSeeded: false, delegationDepth: 0 });
  }

  send({ jsonrpc: '2.0', id: msg.id, result: { messageId: `msg-${turn}` } });
  status(sessionId, 'running');

  const seqBase = nextSeq;
  nextSeq += 10;
  await appendSessionFrame(sessionId, [...headerEvents, { type: 'turn/start', seq: seqBase, time: Date.now(), data: { turn } }]);
  event(sessionId, { type: 'turn/start', seq: seqBase, time: Date.now(), data: { turn } });

  if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));

  const text = reply ?? `收到：${prompt}`;
  const content = [{ type: 'reasoning', text: '（替身思考）' }, { type: 'text', text }];
  const toolEvents = [];
  if (withToolCall) {
    content.push({ type: 'tool-call', id: `call_${turn}`, name: 'write', arguments: JSON.stringify({ file_path: 'note.txt', content: text }) });
    toolEvents.push({ type: 'tool/call', seq: seqBase + 1, time: Date.now(), data: { turn, step: 1, callId: `call_${turn}`, name: 'write', arguments: JSON.stringify({ file_path: 'note.txt', content: text }) } });
    toolEvents.push({
      type: 'tool/result',
      seq: seqBase + 2,
      time: Date.now(),
      data: { turn, step: 1, message: { role: 'tool', toolCallId: `call_${turn}`, content: textContent(toolError ? 'Error: denied' : 'ok'), isError: toolError } },
    });
  }

  const assistantEvent = {
    type: 'assistant/message',
    seq: seqBase + 3,
    time: Date.now(),
    data: {
      turn,
      step: 1,
      message: { role: 'assistant', content, id: `a-${turn}` },
      usage: { inputTokens: 10, outputTokens: 2 },
      // 拆成**两个** text-chunks 组，模拟真实流式（真实样例里每个 block 一组）
      stream: [
        { type: 'chunk', chunk: { type: 'block-start', index: 1, blockType: 'text' } },
        { type: 'text-chunks', time0: Date.now(), index: 1, dt: [], texts: text.slice(0, Math.ceil(text.length / 2)).split('') },
        { type: 'text-chunks', time0: Date.now(), index: 1, dt: [], texts: text.slice(Math.ceil(text.length / 2)).split('') },
        { type: 'chunk', chunk: { type: 'block-end', index: 1, block: { type: 'text', text } } },
      ],
    },
  };

  const reason = errorText ? { kind: 'error', error: { message: errorText, code: 'FAKE_ERROR' } } : { kind: 'completed' };
  const endEvent = { type: 'turn/end', seq: seqBase + 4, time: Date.now(), data: { turn, reason } };

  for (const ev of toolEvents) event(sessionId, ev);
  event(sessionId, assistantEvent);
  await appendSessionFrame(sessionId, [...toolEvents, assistantEvent, endEvent]);
  event(sessionId, endEvent);
  status(sessionId, 'idle');
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let index;
  while ((index = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    pending.push(msg);
  }
  void drain();
});

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      const msg = pending.shift();
      if (msg.method === 'initialize') {
        recordInit(msg.params);
        send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } });
      } else if (msg.method === 'session/prompt') {
        await handlePrompt(msg);
      } else if (msg.method === 'shutdown') {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
        process.exit(0);
      }
    }
  } finally {
    draining = false;
  }
}

// stdin EOF → 退出（与真实 SDK 一致：客户端靠关闭进程放弃轮次）
process.stdin.on('end', () => process.exit(0));
