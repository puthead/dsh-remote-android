/**
 * 探针：用**真实 HTTP/SSE**（手机端走的那条路）验证「电脑端自己发起的轮次」能被实时中继推给客户端。
 *
 * 与 `.probe/relay-live-e2e.mjs` 的分工：
 *   - 那一支直接订阅进程内的会话总线（证明中继把帧搬进了总线）；
 *   - 这一支带设备令牌连 `GET /api/v2/sessions/stream?fromSeq=<n>`（`ConsoleStreams.path()` 的地址，
 *     **不带 sessionId**，与手机端逐字一致），证明这些帧会经 HTTP 落到客户端，且带 `data.seq`。
 *
 * 只读：不投递 prompt、不取消轮次、不写会话。默认打 live-env 网关（18087），不碰生产网关 8787。
 * 令牌从 `.runtime/live-env/logs/headless-device-token.txt` 读（**不打印**）。
 *
 * 用法：`node .probe/relay-sse-e2e.mjs`（可配 GATEWAY / RUN_MS / SESSION_ID / FROM_SEQ）
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:18087';
const RUN_MS = Number(process.env.RUN_MS ?? 60_000);
const SESSION_ID = process.env.SESSION_ID ?? null;
const TOKEN_FILE =
  process.env.TOKEN_FILE ?? path.resolve(import.meta.dirname, '../.runtime/live-env/logs/headless-device-token.txt');
const FROM_SEQ = process.env.FROM_SEQ ?? '0'; // 0 ⇒ 回放当前总线缓冲（网关刚重启时缓冲很小）
/** 每种类型的打印上限：缓冲回放可能一次来几百帧，全打出来只会淹掉结论。 */
const PRINT_CAP = Number(process.env.PRINT_CAP ?? 12);

const token = (await fs.readFile(TOKEN_FILE, 'utf8')).trim();
if (!token) throw new Error(`令牌文件为空：${TOKEN_FILE}`);

const url = `${GATEWAY}/api/v2/sessions/stream?fromSeq=${FROM_SEQ}&tail=1`;
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const counts = new Map();
const relayed = [];
let frames = 0;
let current = { id: null, event: null, dataLines: [] };

const controller = new AbortController();
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
  signal: controller.signal,
});
console.log(`${at()} GET ${url} → HTTP ${res.status} ${res.headers.get('content-type')}`);
if (!res.ok) {
  console.log(`${at()} 响应体：${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}

function handleFrame() {
  if (!current.event) return;
  frames += 1;
  let data = {};
  const raw = current.dataLines.join('\n');
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { _unparsed: raw.slice(0, 120) };
  }
  const type = current.event;
  counts.set(type, (counts.get(type) ?? 0) + 1);
  if (SESSION_ID && data.sessionId && data.sessionId !== SESSION_ID) return;
  const isDesktop = data.source === 'computer' || data.relayed === true;
  const tail = [];
  if (data.seq !== undefined) tail.push(`data.seq=${data.seq}`);
  if (current.id) tail.push(`id=${current.id}`);
  if (data.turn !== undefined) tail.push(`turn=${data.turn}`);
  if (data.text !== undefined) tail.push(`text=${JSON.stringify(String(data.text).slice(0, 50))}`);
  if (data.name !== undefined) tail.push(`name=${data.name}`);
  if (data.reason !== undefined) tail.push(`reason=${JSON.stringify(data.reason)}`);
  console.log(`${at()} ← ${type}${isDesktop ? ' [desktop]' : ''} ${tail.join(' ')}`);
  if (isDesktop) relayed.push({ at: at(), type, seq: data.seq ?? null, data });
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
const deadline = setTimeout(() => controller.abort(), RUN_MS);
try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split(/\r?\n/)) {
      if (line === '') {
        handleFrame();
        current = { id: null, event: null, dataLines: [] };
      } else if (line.startsWith('id:')) current.id = line.slice(3).trim();
      else if (line.startsWith('event:')) current.event = line.slice(6).trim();
      else if (line.startsWith('data:')) current.dataLines.push(line.slice(5).trimStart());
    }
  }
} catch (err) {
  if (err.name !== 'AbortError') console.log(`${at()} 流中断：${err.message}`);
}
clearTimeout(deadline);

console.log(`\n${at()} ===== 汇总 =====`);
console.log(`收到 SSE 帧（含心跳/全局事件）：${frames}，按类型：${JSON.stringify([...counts.entries()])}`);
console.log(`其中电脑端来源（source=computer / relayed=true）的帧：${relayed.length}`);
for (const f of relayed.slice(0, 25)) console.log(`  ${f.at} ${f.type} data.seq=${f.seq}`);
const withSeq = relayed.filter((f) => f.seq !== null).length;
const hasDelta = relayed.some((f) => f.type === 'message.delta' && f.seq !== null);
const hasEnd = relayed.some((f) => f.type === 'turn.ended');
console.log(`带 data.seq 的电脑端帧：${withSeq}/${relayed.length}`);
console.log(`结论：${hasDelta ? 'PASS' : 'INCONCLUSIVE'}（实时增量${hasEnd ? ' + 轮次结束' : '（本次窗口内未见轮次结束）'}）`);
process.exit(0);
