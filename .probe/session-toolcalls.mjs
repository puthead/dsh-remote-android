/**
 * 从 DSH 会话记录（zstd jsonl）里抽出「工具调用序列 + 时间戳」，用来复盘
 * 某个会话到底在什么时刻调用了什么工具（例如 ask_user_question 的弹窗时刻）。
 *
 * 用法: node session-toolcalls.mjs <session.v4.jsonl.zstd> [过滤子串]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ZSTD_CANDIDATES = [
  'D:/DSH/resources/app.asar.unpacked/node_modules/@mongodb-js/zstd',
  'D:/DSH/resources/app.asar/node_modules/@mongodb-js/zstd',
  'zstddec',
];
let zstd = null;
for (const c of ZSTD_CANDIDATES) {
  try {
    zstd = require(c);
    console.log(`# zstd 模块: ${c}`);
    break;
  } catch (e) {
    /* try next */
  }
}
if (!zstd) {
  console.error('找不到 zstd 解压模块');
  process.exit(2);
}

const file = process.argv[2];
const filter = process.argv[3] ?? '';
const raw = readFileSync(file);
const text = zstd.decompress
  ? zstd.decompress(raw).toString('utf8')
  : Buffer.from(await zstd.decompress(raw)).toString('utf8');

const lines = text.split('\n').filter((l) => l.trim());
console.log(`# 记录行数: ${lines.length}`);
for (const line of lines) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  const s = JSON.stringify(ev);
  if (filter && !s.includes(filter)) continue;
  const t = ev.at ?? ev.timestamp ?? ev.time ?? ev.ts ?? '';
  const kind = ev.kind ?? ev.type ?? '';
  const name = ev.name ?? ev.toolName ?? ev.tool?.name ?? '';
  if (/tool|ask|question|approval/i.test(String(kind)) || /ask_user_question/i.test(s)) {
    const brief = s.length > 400 ? `${s.slice(0, 400)}…` : s;
    console.log(`[${t}] ${kind} ${name} :: ${brief}`);
  }
}
