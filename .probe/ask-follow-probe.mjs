// Probe: capture the session's messages after the answer, to prove the tool received it.
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const sessionId = process.argv[2];
const api = new DesktopApi({ logger: { debug() {}, info() {}, warn() {}, error() {} } });
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(new Error('probe window elapsed')), 20_000);
let n = 0;
try {
  for await (const value of api.openFollow(sessionId, { maxMessages: 25, signal: ac.signal, timeoutMs: 20_000 })) {
    n += 1;
    const s = JSON.stringify(value);
    console.log(`--- follow[${n}] ${value?.type ?? ''} len=${s.length}`);
    console.log(s.length > 3000 ? s.slice(0, 3000) + '…TRUNC' : s);
  }
} catch (err) {
  console.log('follow err:', String(err?.message ?? err).slice(0, 200));
}
clearTimeout(timer);
console.log('FOLLOW COUNT =', n);
