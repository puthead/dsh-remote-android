// Probe: create a throwaway desktop session, trigger an `ask_user_question`, prove the
// `user-questions/request` waterfall reaches the `$events` stream, then answer it via
// `$events/result`. Prints everything; writes nothing.
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const api = new DesktopApi({ logger: { debug() {}, info: {} , warn: console.warn, error: console.error } });

const probe = await api.probe();
console.log('probe:', JSON.stringify(probe));
if (!probe.ok) process.exit(1);

// 1) subscribe FIRST (no replay guarantee for waterfall frames).
const ac = new AbortController();
const frames = [];
let clientId = null;
let resolveAnswer = null;
const answered = new Promise((r) => { resolveAnswer = r; });

const pump = (async () => {
  try {
    for await (const value of api.openStream({ endpoint: '$events', args: {}, signal: ac.signal, timeoutMs: 120_000 })) {
      if (value?.type === 'ready') {
        clientId = value.clientId;
        console.log('READY clientId=', clientId);
        continue;
      }
      if (value?.type !== 'waterfall') continue;
      const brief = { event: value.event, eventId: value.eventId, agentId: value.agentId, request: value.request };
      frames.push(brief);
      console.log('WATERFALL:', JSON.stringify(brief).slice(0, 600));
      if (value.event === 'user-questions/request') { resolveAnswer(value); return; }
      if (value.event === 'approval/request') { resolveAnswer(value); return; }
    }
  } catch (err) {
    console.log('stream error:', err?.code ?? '', String(err?.message ?? err).slice(0, 300));
  }
})();

await new Promise((r) => setTimeout(r, 1200));
console.log('clientId after warmup:', clientId);

// 2) create the throwaway session
const created = await api.createSession({ cwd: 'D:\\Workspace\\dsh_android' });
const sessionId = created?.sessionId ?? created?.session?.sessionId;
console.log('created:', JSON.stringify(created).slice(0, 400));
if (!sessionId) { ac.abort(); process.exit(1); }

// 3) prompt the agent to ask a question through the tool
await api.prompt({
  sessionId,
  text: 'Call the ask_user_question tool exactly once and nothing else. Ask one question: "Probe: pick a colour" with options "red" and "blue". Then stop after the answer arrives.',
});
console.log('prompted session', sessionId);

// 4) wait for the waterfall
const timer = setTimeout(() => resolveAnswer(null), 90_000);
const hit = await answered;
clearTimeout(timer);

if (!hit) {
  console.log('NO WATERFALL within window. frames seen:', frames.length);
  ac.abort();
  process.exit(2);
}

// 5) answer it
const outcome = hit.event === 'approval/request'
  ? { kind: 'result', value: 'allowed-once' }
  : { kind: 'result', value: { answers: [{ id: (hit.request?.questions?.[0]?.id) ?? 'probe', selected: ['red'] }] } };
console.log('answering eventId=', hit.eventId, 'outcome=', JSON.stringify(outcome));
const res = await api.callRaw('$events/result', { clientId, eventId: hit.eventId, outcome });
console.log('ANSWER RESPONSE:', JSON.stringify(res).slice(0, 500));

await new Promise((r) => setTimeout(r, 2500));
ac.abort();
await pump.catch(() => {});
console.log('total waterfall frames:', frames.length);
