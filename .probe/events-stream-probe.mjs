// READ-ONLY-ish probe: verify the desktop runtime's `$events` forwarded-event stream
// and the `$events/result` answer endpoint exist and are usable through DesktopApi.
// Writes nothing anywhere; only reads the local runtime.
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const api = new DesktopApi({ logger: { debug() {}, info: {}, warn: console.warn, error: console.error } });

const probe = await api.probe();
console.log('probe:', JSON.stringify(probe));

if (!probe.ok) process.exit(1);

const sessions = await api.listSessions();
console.log('sessions:', sessions.length);
for (const s of sessions.slice(0, 5)) {
  console.log('  -', s.sessionId, 'running=', s.running, 'cwd=', s.cwd ?? '-');
}

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(new Error('probe window elapsed')), 8000);
let clientId = null;
const frames = [];
try {
  for await (const value of api.openStream({ endpoint: '$events', args: {}, signal: ac.signal, timeoutMs: 8000 })) {
    frames.push(value);
    if (clientId === null && value && typeof value === 'object' && typeof value.clientId === 'string') clientId = value.clientId;
    console.log('frame:', JSON.stringify(value).slice(0, 300));
    if (frames.length >= 4) break;
  }
} catch (err) {
  console.log('stream ended:', err.code ?? '', String(err.message).slice(0, 200));
} finally {
  clearTimeout(timer);
}
console.log('clientId:', clientId);
