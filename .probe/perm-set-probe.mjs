// Probe A: can a remote client flip a desktop session's approval policy via `commands/execute`?
// Read-only w.r.t. the repo; creates one throwaway session and cancels it at the end.
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const log = (...a) => console.log(...a);
const api = new DesktopApi({ logger: { debug() {}, info() {}, warn: console.warn, error: console.error } });

log('probe:', JSON.stringify(await api.probe()));

// 1) is the permission-presets service mounted? (read-only remote)
log('catalog:', JSON.stringify(await api.callRaw('permissionPresets/catalog', {})));

// 2) create the throwaway session
const created = await api.createSession({ cwd: 'D:\\Workspace\\dsh_android' });
const sessionId = created?.sessionId ?? created?.session?.sessionId;
log('created:', JSON.stringify(created).slice(0, 400));
if (!sessionId) process.exit(1);

// 3) which commands exist for this agent?
const cmds = await api.callRaw('commands/list', { agentId: sessionId });
log('commands/list:', JSON.stringify(cmds).slice(0, 2500));

// 4) permissions projection BEFORE
const before = await api.callRaw('session/projections', { request: { sessionId } });
log('projections.permissions BEFORE:', JSON.stringify(before?.value?.values?.permissions ?? before).slice(0, 400));

// 5) try each plausible spelling of the command line
for (const line of ['/permission danger-full-access', '/permission workspace-write', '/permission read-only', '/permission workspace-write']) {
  const res = await api.callRaw('commands/execute', { agentId: sessionId, line, submittedAttachments: [] });
  const p = await api.callRaw('session/projections', { request: { sessionId } });
  log(`execute(${JSON.stringify(line)}):`, JSON.stringify(res).slice(0, 400));
  log('   -> permissions:', JSON.stringify(p?.value?.values?.permissions ?? p).slice(0, 200));
}

// 6) permissions projection AFTER
const after = await api.callRaw('session/projections', { request: { sessionId } });
log('projections.permissions AFTER:', JSON.stringify(after?.value?.values?.permissions ?? after).slice(0, 400));

log('SESSION', sessionId);
