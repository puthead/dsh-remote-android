// Probe: distinguish "clientId not registered" from "eventId not found" on $events/result.
import { randomUUID } from 'node:crypto';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const api = new DesktopApi({ logger: { debug() {}, info() {}, warn() {}, error() {} } });

const ac = new AbortController();
let clientId = null;
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });

const pump = (async () => {
  try {
    for await (const value of api.openStream({ endpoint: '$events', args: {}, signal: ac.signal, timeoutMs: 60_000 })) {
      if (value?.type === 'ready') { clientId = value.clientId; readyResolve(value); }
      else console.log('EVENT:', JSON.stringify(value).slice(0, 200));
    }
  } catch (err) { console.log('stream err:', err?.code ?? '', String(err?.message ?? err).slice(0, 160)); }
})();

await ready;
console.log('ready clientId =', clientId);

// keep the WS alive: wait a beat, then fire the two probes.
await new Promise((r) => setTimeout(r, 500));

const bogus = await api.callRaw('$events/result', {
  clientId: randomUUID(),
  eventId: randomUUID(),
  outcome: { kind: 'result', value: 'allowed-once' },
});
console.log('BOGUS clientId ->', JSON.stringify(bogus));

const realClient = await api.callRaw('$events/result', {
  clientId,
  eventId: randomUUID(),
  outcome: { kind: 'result', value: 'allowed-once' },
});
console.log('REAL clientId  ->', JSON.stringify(realClient));

ac.abort();
await pump.catch(() => {});
