// Probe: answer a live `user-questions/request` waterfall over $events/result.
// Usage: node events-ask-roundtrip.mjs <questionId> <comma,separated,labels> [custom]
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const [qid, labelsArg, custom] = process.argv.slice(2);
const selected = labelsArg === undefined || labelsArg === '' ? [] : labelsArg.split(',');

const api = new DesktopApi({ logger: { debug() {}, info() {}, warn() {}, error() {} } });

const ac = new AbortController();
let clientId = null;
let pendingFrame = null;
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
let frameResolve;
const gotFrame = new Promise((r) => { frameResolve = r; });

const pump = (async () => {
  try {
    for await (const value of api.openStream({ endpoint: '$events', args: {}, signal: ac.signal, timeoutMs: 120_000 })) {
      if (value?.type === 'ready') { clientId = value.clientId; readyResolve(value); continue; }
      if (value?.type === 'waterfall') {
        console.log('FRAME:', JSON.stringify(value));
        if (pendingFrame === null && value.event === 'user-questions/request') {
          pendingFrame = value;
          frameResolve(value);
        }
      } else {
        console.log('OTHER:', JSON.stringify(value).slice(0, 300));
      }
    }
  } catch (err) {
    console.log('stream err:', err?.code ?? '', String(err?.message ?? err).slice(0, 200));
  }
})();

await ready;
console.log('READY clientId =', clientId);

// Wait (bounded) for the replayed pending ask.
const frame = await Promise.race([gotFrame, new Promise((r) => setTimeout(() => r(null), 8000))]);
if (frame === null) {
  console.log('NO user-questions/request frame within 8s');
  ac.abort(); await pump.catch(() => {});
  process.exit(2);
}

const questions = frame.request?.questions ?? [];
const target = qid === undefined ? questions[0]?.id : qid;
const answerItem = { id: target, selected };
if (custom !== undefined && custom !== '') answerItem.custom = custom;
const value = { answers: [answerItem] };

console.log('SENDING value =', JSON.stringify(value));
const raw = await api.callRaw('$events/result', {
  clientId,
  eventId: frame.eventId,
  outcome: { kind: 'result', value },
});
console.log('RAW RESPONSE =', JSON.stringify(raw));

ac.abort();
await pump.catch(() => {});
console.log('DONE');
