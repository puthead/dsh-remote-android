// E2E: flip a fresh desktop session to approval policy `ask` via `commands/execute`,
// then make the agent request a sandbox escalation so the runtime emits a real
// `approval/request` waterfall frame, answer it from this client with `allowed-once`,
// and prove the tool call then ran.
import fs from 'node:fs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const api = new DesktopApi({ logger: { debug() {}, info() {}, warn() {}, error() {} } });
const out = { startedAt: new Date().toISOString() };
const say = (...a) => console.log(...a);

const probe = await api.probe();
out.probe = probe;
say('probe:', JSON.stringify(probe));
if (!probe.ok) process.exit(1);

// ---- 1) subscribe to the forwarded-event stream FIRST and keep it alive ----
const ac = new AbortController();
const frames = [];
let clientId = null;
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
let approvalResolve;
const approvalSeen = new Promise((r) => { approvalResolve = r; });

const pump = (async () => {
  try {
    for await (const value of api.openStream({ endpoint: '$events', args: {}, signal: ac.signal, timeoutMs: 240_000 })) {
      if (value?.type === 'ready') { clientId = value.clientId; out.ready = value; readyResolve(value); continue; }
      frames.push(value);
      if (value?.type === 'waterfall') {
        say('WATERFALL:', JSON.stringify(value).slice(0, 500));
        if (value.event === 'approval/request') approvalResolve(value);
      }
    }
  } catch (err) {
    say('stream error:', String(err?.message ?? err).slice(0, 200));
  }
})();

await ready;
say('READY clientId=', clientId);

// ---- 2) throwaway session + explicit policy flip through the client RPC ----
const created = await api.createSession({ cwd: 'D:\\Workspace\\dsh_android' });
const sessionId = created?.sessionId ?? created?.session?.sessionId;
out.created = created;
out.sessionId = sessionId;
say('created:', JSON.stringify(created));

const projBefore = await api.callRaw('session/projections', { request: { sessionId } });
out.permissionsBefore = projBefore.value?.values?.permissions ?? projBefore;
say('permissions BEFORE:', JSON.stringify(out.permissionsBefore));

const flip = await api.callRaw('commands/execute', {
  agentId: sessionId,
  line: '/permission workspace-write',
  submittedAttachments: [],
});
out.flipResponse = flip;
say('flip response:', JSON.stringify(flip));

const projAfter = await api.callRaw('session/projections', { request: { sessionId } });
out.permissionsAfter = projAfter.value?.values?.permissions ?? projAfter;
say('permissions AFTER:', JSON.stringify(out.permissionsAfter));

// ---- 3) force a tool call that must ask for approval (strictly-wider escalation) ----
const promptText = [
  'Call the pwsh tool exactly once with these arguments:',
  'command: "Write-Output APPROVAL_PROBE_OK"',
  'sandbox_permissions: "danger-full-access"',
  'justification: "The probe needs wider access than the workspace-write sandbox allows."',
  'Do not use any other tool. After the call returns, reply with the single word DONE.',
].join('\n');
out.prompt = promptText;
await api.prompt({ sessionId, text: promptText });
say('prompted');

// ---- 4) wait for the approval waterfall frame ----
const timer = setTimeout(() => approvalResolve(null), 150_000);
const hit = await approvalSeen;
clearTimeout(timer);
if (!hit) {
  out.verdict = 'NO_APPROVAL_FRAME';
  say('NO approval/request frame. frames seen:', JSON.stringify(frames).slice(0, 1500));
} else {
  out.approvalFrame = hit;
  say('APPROVAL FRAME (raw):', JSON.stringify(hit));
  const outcome = { kind: 'result', value: 'allowed-once' };
  out.outcome = outcome;
  const res = await api.callRaw('$events/result', { clientId, eventId: hit.eventId, outcome });
  out.resultResponse = res;
  say('$events/result:', JSON.stringify(res));
}

// ---- 5) keep the stream alive, then collect transcript evidence ----
await new Promise((r) => setTimeout(r, 15_000));
const page = await api.callRaw('session/page', {
  request: { address: { kind: 'session', sessionId }, throughSeq: Number.MAX_SAFE_INTEGER, maxMessages: 50 },
});
out.page = page;
const pageText = JSON.stringify(page);
say('PAGE has APPROVAL_PROBE_OK:', pageText.includes('APPROVAL_PROBE_OK'));
say('PAGE has approval:', pageText.includes('approval'));
say('PAGE tail:', pageText.slice(-2500));

out.frames = frames;
out.verdict = hit ? 'APPROVAL_FRAME_ANSWERED' : 'NO_APPROVAL_FRAME';
ac.abort();
await pump.catch(() => {});
fs.writeFileSync(new URL('./approval-e2e-evidence.json', import.meta.url), JSON.stringify(out, null, 2));
say('SESSION', sessionId);
