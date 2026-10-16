// Read back round-trip #2 evidence via session/page with a valid cursor,
// and dump the on-disk transcript for the new session.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const sessionId = process.argv[2] ?? 'session-ff7b807b-f63b-4e67-b4db-89ce015d4aaa';
const api = new DesktopApi({ logger: { debug() {}, info() {}, warn() {}, error() {} } });

// 1) page with no throughSeq (or cursor-sized)
const p1 = await api.callRaw('session/page', {
  request: { address: { kind: 'session', sessionId }, maxMessages: 60 },
});
console.log('=== session/page (no throughSeq) ok =', JSON.stringify(p1).slice(0, 300));
const cursor = p1?.value?.cursor ?? p1?.cursor;
console.log('cursor =', cursor);
let page = p1;
if (cursor !== undefined) {
  page = await api.callRaw('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq: cursor, maxMessages: 60 },
  });
}
const txt = JSON.stringify(page);
console.log('has typed-word-42 :', txt.includes('typed-word-42'));
console.log('has probe_multi    :', txt.includes('probe_multi'));
console.log('has ask_user_question:', txt.includes('ask_user_question'));
const m = txt.match(/.{700}typed-word-42.{300}/s);
console.log('--- context around typed-word-42 ---');
console.log(m ? m[0] : '(not found in page)');

// 2) on-disk transcript, zstd frame walk
const dir = `C:\\Users\\Administrator\\.dsh\\sessions\\--D-Workspace-dsh_android--\\${sessionId}`;
console.log('\n=== on-disk:', dir);
let raw = null;
for (const f of fs.readdirSync(dir)) {
  if (f.startsWith('session.') && f.includes('jsonl')) {
    const p = path.join(dir, f);
    console.log('  file:', f, fs.statSync(p).size);
    raw = fs.readFileSync(p);
  }
}
if (raw) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let i = 0; i + 4 <= raw.length; i++) if (raw.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i);
  console.log('  zstd frames:', starts.length);
  let all = '';
  for (let k = 0; k < starts.length; k++) {
    const slice = raw.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : raw.length);
    try { all += zlib.zstdDecompressSync(slice).toString('utf8'); } catch (e) { console.log('  frame', k, 'err', String(e.message).slice(0, 80)); }
  }
  fs.writeFileSync(new URL('./transcript2b.jsonl', import.meta.url), all);
  fs.writeFileSync(new URL('./page2.json', import.meta.url), JSON.stringify(page, null, 2));
  const lines = all.split('\n').filter(Boolean);
  console.log('  records:', lines.length);
  for (const line of lines) {
    if (line.includes('typed-word-42') || line.includes('probe_multi') || line.includes('ASK') || line.includes('ask_user_question')) {
      console.log('  >>', line.slice(0, 900));
    }
  }
}
