// Cleanup: cancel the throwaway sessions created by the approval probes and remove
// the out-of-workspace escalation target.
import fs from 'node:fs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const ids = [
  'session-5bba3338-4a59-41a0-adad-f11ef88fcf3e',
  'session-d2575457-d125-421f-8d57-43e49ae7b6e0',
  'session-248a9093-4b35-402a-949d-73d0a6a31152',
  'session-17a11025-c08f-47a7-86e9-b3a32abe8385',
  'session-69b3bf69-33af-4f07-b6ee-f4cbe7fd30b2',
];
const api = new DesktopApi({ logger: { debug() {}, info() {}, warn() {}, error() {} } });
for (const id of ids) {
  try { console.log(id, JSON.stringify(await api.cancel(id))); }
  catch (err) { console.log(id, 'CANCEL FAILED', String(err?.message ?? err).slice(0, 160)); }
}
const target = 'C:\\ProgramData\\dsh-approval-probe';
try { fs.rmSync(target, { recursive: true, force: true }); console.log('rmdir', target, '->', fs.existsSync(target) ? 'STILL THERE' : 'gone'); }
catch (err) { console.log('rmdir failed:', String(err?.message ?? err).slice(0, 160)); }
