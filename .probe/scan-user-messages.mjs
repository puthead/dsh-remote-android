// 扫描 DSH 会话 JSONL，打印每条 user/message 的 seq/time/source.kind 与文本前 80 字，
// 用来核对「手机端本地乐观回声文案」与「服务端投影文案」是否逐字一致。
import fs from 'node:fs';
import readline from 'node:readline';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scan-user-messages.mjs <session.jsonl>');
  process.exit(2);
}

const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
let line2 = 0;
for await (const line of rl) {
  line2 += 1;
  const t = line.trim();
  if (!t) continue;
  let ev;
  try { ev = JSON.parse(t); } catch { console.log(`L${line2} <not json>`); continue; }
  const type = ev.type ?? ev.event ?? '?';
  if (type !== 'user/message') continue;
  const d = ev.data ?? {};
  const blocks = Array.isArray(d.content) ? d.content : [];
  const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
  const others = blocks.filter((b) => b.type !== 'text').map((b) => b.type);
  console.log(JSON.stringify({
    line: line2,
    seq: ev.seq,
    time: ev.time,
    kind: d.source?.kind,
    id: d.id,
    others,
    text: texts.join('\n'),
  }));
}
