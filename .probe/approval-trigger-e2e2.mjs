// Probe C: reliable approval trigger.
// Lesson from probe B: the model refuses to attach `sandbox_permissions` when the
// justification is not credible. So the agent is given a task that genuinely needs
// out-of-workspace write access; the workspace-write sandbox denies the first call,
// the denial carries the escalation hint marker, and the retry must ask for approval.
import fs from 'node:fs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const api = new DesktopApi({ logger: { debug() {}, info() {}, warn() {}, error() {} } });
const EVID = new URL('./approval-trigger-evidence.json', import.meta.url);
const out = { startedAt: new Date().toISOString(), frames: [] };
const save = () => fs.writeFileSync(EVID, JSON.stringify(out, null, 2));
const say = (...a) => console.log(...a);

out.probe = await api.probe();
say('probe:', JSON.stringify(out.probe));
const ac = new AbortController();
let clientId = null;
let sessionId = null;
let readyResolve, approvalResolve;
const ready = new Promise((r) => { readyResolve = r; });
const approvalSeen = new Promise((r) => { approvalResolve = r; });

const pump = (async () => {
  try {
    for await (const value of api.openStream({ endpoint: '$events', args: {}, signal: ac.signal, timeoutMs: 300_000 })) {
      if (value?.type === 'ready') { clientId = value.clientId; out.ready = value; save(); readyResolve(value); continue; }
      if (value?.type === 'waterfall') {
        say('WATERFALL', value.event, 'agentId=', value.agentId);
        if (!sessionId || value.agentId === sessionId) { out.frames.push(value); save(); }
        if (value.event === 'approval/request' && value.agentId === sessionId) approvalResolve(value);
      }
    }
  } catch (err) { say('stream error:', String(err?.message ?? err).slice(0, 200)); }
})();

await ready;
say('READY clientId=', clientId);

const created = await api.createSession({ cwd: 'D:\\Workspace\\dsh_android' });
sessionId = created?.sessionId ?? created?.session?.sessionId;
out.created = created; out.sessionId = sessionId; save();
say('created:', sessionId);

// explicit policy flip through the only client-callable write path
out.flipResponse = await api.callRaw('commands/execute', { agentId: sessionId, line: '/permission workspace-write', submittedAttachments: [] });
const proj = await api.callRaw('session/projections', { request: { sessionId } });
out.permissions = proj.value?.values?.permissions ?? proj;
say('flip:', JSON.stringify(out.flipResponse.value?.value?.result), 'permissions:', JSON.stringify(out.permissions));
save();

const target = 'C:\\ProgramData\\dsh-approval-probe\\marker.txt';
const promptText = [
  'Operator-authorized end-to-end test of the DSH approval channel. Do not ask me questions; just do it.',
  `Using the pwsh tool, create the file ${target} containing exactly APPROVAL_PROBE_OK.`,
  'My session workspace is D:\\Workspace\\dsh_android, so that path is outside it and the sandbox may deny the write.',
  'If the write is denied: follow the sandbox hint marker exactly — retry that same command with',
  'sandbox_permissions (the narrowest wider mode that suffices) and a truthful one-sentence justification.',
  'The approval prompt is expected and will be answered. When the write succeeds, reply with the single word DONE.',
].join('\n');
out.prompt = promptText; save();
await api.prompt({ sessionId, text: promptText });
say('prompted; waiting for approval/request…');

const timer = setTimeout(() => approvalResolve(null), 240_000);
const hit = await approvalSeen;
clearTimeout(timer);

if (!hit) {
  out.verdict = 'NO_APPROVAL_FRAME';
  say('NO approval/request frame for', sessionId);
} else {
  out.approvalFrame = hit;
  out.verdict = 'APPROVAL_FRAME_ANSWERED';
  save();
  say('APPROVAL FRAME (raw):', JSON.stringify(hit));
  const outcome = { kind: 'result', value: 'allowed-once' };
  out.outcome = outcome;
  const res = await api.callRaw('$events/result', { clientId, eventId: hit.eventId, outcome });
  out.resultResponse = res;
  say('$events/result:', JSON.stringify(res));
  save();
}

// keep the stream open (never abort before the answer) and let the turn finish
await new Promise((r) => setTimeout(r, 20_000));
out.fileExists = fs.existsSync(target);
out.fileContent = out.fileExists ? fs.readFileSync(target, 'utf8') : null;
say('target file exists:', out.fileExists, JSON.stringify(out.fileContent));
save();
ac.abort();
await pump.catch(() => {});
out.endedAt = new Date().toISOString();
save();
say('SESSION', sessionId);
say('EVIDENCE', EVID.pathname);
