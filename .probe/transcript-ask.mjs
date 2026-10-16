// Probe: pull the ask_user_question call + result + reply out of a decoded transcript.
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.trim() !== '');
console.log('records =', lines.length);

const out = [];
for (const line of lines) {
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  const ev = obj.event ?? obj;
  const d = ev.data ?? {};
  const blob = JSON.stringify(d);
  const interesting =
    blob.includes('probe_colour') ||
    ev.type === 'tool/result' ||
    ev.type === 'tool/call' ||
    ev.type === 'tool/result-update' ||
    blob.includes('answer_to_pending_question');
  if (!interesting) continue;

  const rec = { recordType: obj.type ?? null, eventType: ev.type ?? null, seq: ev.seq ?? null };
  if (d.callId !== undefined) rec.callId = d.callId;
  if (d.name !== undefined) rec.name = d.name;
  if (d.arguments !== undefined) rec.arguments = d.arguments;
  if (d.result !== undefined) rec.result = d.result;
  if (d.status !== undefined) rec.status = d.status;
  if (d.message !== undefined) {
    rec.role = d.message.role ?? null;
    const c = d.message.content;
    rec.text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? JSON.stringify(p)).join(' ') : JSON.stringify(c);
  }
  out.push(rec);
}

for (const rec of out) {
  let s = JSON.stringify(rec);
  if (s.length > 2200) s = s.slice(0, 2200) + '…TRUNC';
  console.log(s);
}
console.log('\nMATCHED =', out.length);
