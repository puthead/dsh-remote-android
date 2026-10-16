/**
 * 手机端 App 真·端到端（两段式，配合 adb 点击）：
 *
 *   MODE=trigger  建桌面端会话 → 设 /permission workspace-write → 经网关投递一个
 *                 **真的需要越界写**的任务（标题带 APPROVAL-PHONE-E2E 便于在 App 列表里认出来）
 *                 → 轮询到未决审批后落状态文件并退出（**不回答**，留给手机点）。
 *   MODE=verify   轮询「标记文件是否被创建」+「未决表是否清空」→ 判定手机那一下是否真的放行了。
 *
 * 与 approval-gateway-e2e.mjs 的区别：那个用 HTTP 冒充手机，这个把回答交给**模拟器上的 App**。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:18087';
const TOKEN_FILE = 'D:\\Workspace\\dsh_android\\.runtime\\live-env\\logs\\headless-device-token.txt';
const STATE_FILE = 'D:\\Workspace\\dsh_android\\.probe\\approval-phone-state.json';
const PROBE_DIR = 'C:\\ProgramData\\dsh-approval-probe';
const MARKER = `${PROBE_DIR}\\marker.txt`;
const TITLE_TAG = 'APPROVAL-PHONE-E2E';
const MODE = process.env.MODE === 'verify' ? 'verify' : 'trigger';

const log = (...a) => console.log(...a);

function gateway(path, init = {}) {
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  return fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

async function waitFor(label, fn, timeoutMs, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${label}）`);
}

if (MODE === 'trigger') {
  const api = new DesktopApi({});
  const created = await api.createSession({ cwd: 'D:\\Workspace\\dsh_android' });
  const sessionId = created.sessionId;
  const perm = await api.call('commands/execute', { agentId: sessionId, line: '/permission workspace-write', submittedAttachments: [] });
  log(`会话 ${sessionId}；设档 ${JSON.stringify(perm?.result ?? perm)}`);

  const prompt = [
    `${TITLE_TAG}：请完成一个需要越出工作区写入的任务，按顺序做：`,
    `1) 用 pwsh 执行：New-Item -ItemType Directory -Force -Path '${PROBE_DIR}' | Out-Null; Set-Content -Path '${MARKER}' -Value 'PHONE_APPROVED_OK'`,
    '2) 这一步大概率会被沙箱拒绝（工作区外写入）。如果被拒绝，请不要放弃：用同一个命令重试一次，',
    '   并在工具调用里带上最窄的更高沙箱档位 `sandbox_permissions` 与一句真实的 justification。',
    '3) 最后告诉我结果里是否出现 PHONE_APPROVED_OK。不要改写命令、不要换路径。',
  ].join('\n');

  const turn = await gateway(`/api/v2/sessions/${sessionId}/turns`, { method: 'POST', body: JSON.stringify({ prompt }) });
  log(`投递轮次 HTTP ${turn.status} ${JSON.stringify(turn.json)}`);
  if (turn.status >= 400) throw new Error(`投递失败 ${turn.status}`);

  const pending = await waitFor('审批出现在网关未决表', async () => {
    const r = await gateway(`/api/v2/approvals?sessionId=${encodeURIComponent(sessionId)}`);
    const hit = (r.json?.approvals ?? []).find((a) => a.kind === 'approval');
    if (hit) return hit;
    log(`   轮询未决… pending=${r.json?.state?.pending ?? '?'}`);
    return null;
  }, 240_000, 5000);

  writeFileSync(STATE_FILE, JSON.stringify({ sessionId, eventId: pending.eventId, toolName: pending.toolName, reason: pending.reason, at: Date.now() }, null, 2));
  log(`READY 未决审批 eventId=${pending.eventId} tool=${pending.toolName}`);
  log(`原因：${pending.reason}`);
  log(`状态文件：${STATE_FILE}（现在请用 adb 在 App 里点「允许一次」）`);
} else {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  log(`校验会话 ${state.sessionId} / eventId ${state.eventId}`);
  const appeared = await waitFor('手机点了「允许一次」→ 越界写真的发生', async () => existsSync(MARKER), 300_000, 4000).catch(() => false);
  const list = await gateway('/api/v2/approvals');
  log(`标记文件存在 = ${existsSync(MARKER)}`);
  log(`未决表 ${JSON.stringify(list.json?.approvals)} state=${JSON.stringify(list.json?.state)}`);
  const pass = appeared && (list.json?.state?.pending === 0);
  log(pass ? 'RESULT: PASS（App 的点击真的放行了电脑端那一轮）' : 'RESULT: FAIL');
  if (!pass) process.exitCode = 1;
}
