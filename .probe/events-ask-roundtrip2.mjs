// Round-trip #2: prove multi-select AND free-text `custom` on one live ask.
// Fresh session -> prompt the model to call ask_user_question with a multi_select
// question plus an option-less (free-text) question -> answer over `$events/result`
// with {selected:[...labels]} and {selected:[], custom:"..."} -> collect evidence.
import fs from 'node:fs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const api = new DesktopApi({ logger: { debug() {}, info() {}, warn() {}, error() {} } });
const out = { startedAt: new Date().toISOString() };
const say = (...a) => console.log(...a);

const probe = await api.probe();
if (!probe.ok) { say('probe failed'); process.exit(1); }
say('probe ok');

const ac = new AbortController();
let clientId = null;
let readyResolve; const ready = new Promise((r) => { readyResolve = r; });
let askResolve; const asked = new Promise((r) => { askResolve = r; });
const frames = [];

const pump = (async () => {
  try {
    for await (const v of api.openStream({ endpoint: '$events', args: {}, signal: ac.signal, timeoutMs: 300_000 })) {
      if (v?.type === 'ready') { clientId = v.clientId; readyResolve(v); continue; }
      frames.push(v);
      if (v?.type === 'waterfall') {
        say('WATERFALL event=', v.event);
        if (v.event === 'user-questions/request') askResolve(v);
      }
    }
  } catch (err) { say('stream error:', String(err?.message ?? err).slice(0, 200)); }
})();

await ready;
say('READY clientId=', clientId);

const created = await api.createSession({ cwd: 'D:\\Workspace\\dsh_android' });
const sessionId = created?.sessionId ?? created?.session?.sessionId;
out.sessionId = sessionId;
say('session:', sessionId);

const promptText = [
  'Call the ask_user_question tool exactly once with EXACTLY these arguments, copied verbatim:',
  '{"questions":[{"id":"probe_multi","header":"Probe","question":"Probe: pick colours","multi_select":true,"options":[{"label":"red"},{"label":"blue"},{"label":"green"}]},{"id":"probe_free","header":"Probe","question":"Probe: type a word"}]}',
  'Do not pass a timeout argument. Do not use any other tool. After the tool returns, reply with exactly DONE.',
].join('\n');
out.prompt = promptText;
await api.prompt({ sessionId, text: promptText });
say('prompted; waiting for user-questions/request ...');

const timer = setTimeout(() => askResolve(null), 180_000);
const hit = await asked;
clearTimeout(timer);

if (!hit) {
  out.verdict = 'NO_ASK_FRAME';
  say('NO ask frame. frames:', JSON.stringify(frames).slice(0, 1200));
} else {
  out.askFrame = hit;
  say('ASK FRAME (raw):', JSON.stringify(hit));

  const value = { answers: [
    { id: 'probe_multi', selected: ['red', 'green'] },
    { id: 'probe_free', selected: [], custom: 'typed-word-42' },
  ] };
  out.sentValue = value;
  say('SENDING value =', JSON.stringify(value));

  const res = await api.callRaw('$events/result', { clientId, eventId: hit.eventId, outcome: { kind: 'result', value } });
  out.resultResponse = res;
  say('$events/result ->', JSON.stringify(res));
}

// keep the stream open a bit, then read back the transcript through session/page
await new Promise((r) => setTimeout(r, 20_000));
const page = await api.callRaw('session/page', {
  request: { address: { kind: 'session', sessionId }, throughSeq: Number.MAX_SAFE_INTEGER, maxMessages: 60 },
});
const pageText = JSON.stringify(page);
out.pageHasCustom = pageText.includes('typed-word-42');
out.pageHasMulti = pageText.includes('red') && pageText.includes('green');
out.pageTail = pageText.slice(-3000);
say('PAGE has typed-word-42:', out.pageHasCustom);
say('PAGE tail:', out.pageTail);

out.verdict = hit ? 'ASK_FRAME_ANSWERED' : 'NO_ASK_FRAME';
ac.abort();
await pump.catch(() => {});
fs.writeFileSync(new URL('./events-ask-roundtrip2.json', import.meta.url), JSON.stringify(out, null, 2));
say('DONE session=', sessionId);
