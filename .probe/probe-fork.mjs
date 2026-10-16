import { SessionMirror } from '../tools/dsh-remote/lib/session-reader.mjs';
const m = new SessionMirror({ roots: [{ home: 'C:\\Users\\Administrator\\.dsh', source: 'computer', writable: false, label: 'pc' }], liveWindowMs: 60000 });
const all = await m.list({ limit: 200, includeSubagent: true });
const b = all.sessions.find((s) => s.id.includes('b64b78d8'));
console.log('b64b78d8 in include=all ?', JSON.stringify(b));
const def = await m.list({ limit: 200 });
console.log('default has b64b78d8 ?', def.sessions.some((s) => s.id.includes('b64b78d8')), 'default total', def.total);
