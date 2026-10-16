import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';
const api = new DesktopApi({ logger: { debug() {}, info() {}, warn() {}, error() {} } });
const sid = process.argv[2];
const through = Number(process.argv[3] ?? 28);
const r = await api.callRaw('session/page', {
  request: { address: { kind: 'session', sessionId: sid }, throughSeq: through, maxMessages: 60 },
});
const t = JSON.stringify(r);
console.log('ok =', r.ok, ' jsonLen =', t.length);
console.log('has typed-word-42 :', t.includes('typed-word-42'));
console.log('has red,green     :', t.includes('red') && t.includes('green'));
const i = t.indexOf('typed-word-42');
if (i > 0) console.log('CTX:', t.slice(Math.max(0, i - 500), i + 120));
