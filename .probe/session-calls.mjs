// Probe: 列出会话里所有工具调用（名字 + 时间 + callId），并打印 ask_user_question 的完整参数与结果。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const fmt = (ms) => {
  const d = new Date(ms + 8 * 3600_000);
  return d.toISOString().replace('T', ' ').slice(5, 19);
};
const calls = [];
for (const l of lines) {
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  if (o.type === 'tool/call') {
    const name = o.data?.name;
    calls.push({ time: o.time, name, callId: o.data?.callId, args: o.data?.arguments });
    console.log(`CALL  ${fmt(o.time)} turn=${o.data?.turn} step=${o.data?.step} ${name} (${String(o.data?.callId).slice(0, 12)})`);
  }
  if (o.type === 'tool/result') {
    const m = o.data?.message;
    const text = m?.content?.map((c) => c.text ?? '').join('') ?? '';
    if (m?.toolCallId) {
      console.log(`  RES ${fmt(o.time)} ${String(m.toolCallId).slice(0, 12)} ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
  }
}
const asks = calls.filter((c) => c.name === 'ask_user_question');
console.log(`\n总工具调用=${calls.length}，ask_user_question=${asks.length}`);
for (const a of asks) {
  console.log(`\n=== ask @ ${fmt(a.time)} callId=${a.callId}\n${a.args}`);
}
