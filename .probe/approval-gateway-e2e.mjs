/**
 * 真·端到端：手机侧（HTTP，经网关 → 中继语义）应答电脑端会话的**工具审批**。
 *
 * 链路：桌面端 runtime(19387) 产生 approval/request waterfall
 *   → 网关(live-env 18087, 跑新代码) 常驻订阅 $events 收帧并入未决表
 *   → 手机用真实设备令牌 GET /api/v2/approvals 看到它
 *   → POST /api/v2/approvals/{eventId} 提交 allowed-once
 *   → 网关把答案经 $events/result 回给桌面端 → 该轮继续执行。
 *
 * 触发方式（不是自然语言命令）：给 agent 一个**真的需要越界写**的任务，
 * 并明确允许它在被拒后用「最窄的更高档位 + 真实理由」重试 —— 这正是
 * `.probe/APPROVAL-TRIGGER.md` 里唯一可靠的配方。
 *
 * 读-only 于生产：不动 PID 396 的 8787，不动生产 config.json；探测目录用完即删。
 */
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:18087';
const TOKEN_FILE = process.env.DEVICE_TOKEN_FILE ?? 'D:\\Workspace\\dsh_android\\.runtime\\live-env\\logs\\headless-device-token.txt';
const PROBE_DIR = 'C:\\ProgramData\\dsh-approval-probe';
const MARKER = `${PROBE_DIR}\\marker.txt`;
const CWD = 'D:\\Workspace\\dsh_android';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 300_000);
const OUTCOME = process.env.OUTCOME === 'rejected' ? 'rejected' : 'allowed-once';

const token = readFileSync(TOKEN_FILE, 'utf8').trim();
const log = (...a) => console.log(...a);

async function gw(method, path, body) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 就保留原文 */ }
  return { status: res.status, json, text };
}

async function waitFor(label, fn, { timeoutMs = TIMEOUT_MS, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== null && last !== undefined && last !== false) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${label}）：最后结果 ${JSON.stringify(last)}`);
}

// 收尾：不留探测目录、不留挂住的轮次
async function cleanup(api, sessionId, reason) {
  try { rmSync(PROBE_DIR, { recursive: true, force: true }); log(`cleanup: 已删 ${PROBE_DIR}`); } catch (e) { log(`cleanup: 删 ${PROBE_DIR} 失败 ${e.message}`); }
  if (sessionId) { try { await api.cancel(sessionId); log(`cleanup: 已 cancel ${sessionId}`); } catch (e) { log(`cleanup: cancel 失败 ${e.message}`); } }
  log(`cleanup 原因：${reason}`);
}

const api = new DesktopApi({});
let sessionId = null;

try {
  // ---- 0. 网关在线且宣告了审批能力 ----
  const health = await gw('GET', '/api/v2/health');
  log(`0. gateway health ${health.status} capabilities=${JSON.stringify(health.json?.capabilities ?? [])} approvals=${JSON.stringify(health.json?.approvals ?? null)}`);
  if (!health.json?.capabilities?.includes('approvals')) throw new Error('网关未宣告 approvals 能力（是不是还在跑旧代码？）');

  const before = await gw('GET', '/api/v2/approvals');
  log(`0. 未决列表（应答前）${before.status} ${JSON.stringify(before.json)}`);

  // ---- 1. 建一个桌面端会话并把权限档设成 workspace-write（ask 策略）----
  const created = await api.createSession({ cwd: CWD });
  sessionId = created.sessionId;
  log(`1. 桌面端会话已建 ${sessionId} preset=${created.agentPreset}`);
  const perm = await api.call('commands/execute', { agentId: sessionId, line: '/permission workspace-write', submittedAttachments: [] });
  log(`1. /permission workspace-write → ${JSON.stringify(perm)}`);
  const proj = await api.projections(sessionId);
  log(`1. 读回 permissions.currentValue = ${JSON.stringify(proj?.values?.permissions?.currentValue ?? null)}`);

  // ---- 2. 经网关投递那一轮（手机走的就是这条：POST /api/v2/sessions/{id}/turns）----
  const prompt = [
    '请完成一个需要越出工作区写入的任务，按顺序做：',
    `1) 用 pwsh 执行：New-Item -ItemType Directory -Force -Path '${PROBE_DIR}' | Out-Null; Set-Content -Path '${MARKER}' -Value 'GATEWAY_APPROVAL_E2E_OK'`,
    '2) 这一步大概率会被沙箱拒绝（工作区外写入）。如果被拒绝，请**不要放弃**：',
    '   用同一个命令重试一次，并在工具调用里带上最窄的更高沙箱档位 `sandbox_permissions` 与一句**真实的** justification（说明该路径在工作区之外、确实需要更宽权限）。',
    '3) 然后告诉我结果里是否出现 GATEWAY_APPROVAL_E2E_OK。',
    '不要改写命令、不要换路径、不要用别的方式绕过。',
  ].join('\n');
  const turn = await gw('POST', `/api/v2/sessions/${sessionId}/turns`, { prompt });
  log(`2. 经网关投递轮次 ${turn.status} ${JSON.stringify(turn.json)}`);
  if (turn.status >= 400) throw new Error(`投递失败：${turn.status} ${turn.text}`);

  // ---- 3. 手机侧轮询未决列表，直到看到这次审批 ----
  const pending = await waitFor('approval.asked 出现在 /api/v2/approvals', async () => {
    const r = await gw('GET', `/api/v2/approvals?sessionId=${encodeURIComponent(sessionId)}`);
    const hit = (r.json?.approvals ?? []).find((a) => a.kind === 'approval');
    if (hit) return hit;
    const all = await gw('GET', '/api/v2/approvals');
    const other = (all.json?.approvals ?? []).length;
    log(`   轮询中… 本会话未决=0，全局未决=${other} state=${JSON.stringify(all.json?.state ?? null)}`);
    return null;
  }, { timeoutMs: 240_000, intervalMs: 5000 });
  log(`3. 手机看到审批 eventId=${pending.eventId} kind=${pending.kind} tool=${pending.toolName} reason=${JSON.stringify(pending.reason)} expiresAt=${pending.expiresAt}`);

  // ---- 4. 手机提交答案 ----
  const answered = await gw('POST', `/api/v2/approvals/${encodeURIComponent(pending.eventId)}`, { outcome: OUTCOME });
  log(`4. 手机提交 ${OUTCOME} → HTTP ${answered.status} ${JSON.stringify(answered.json)}`);
  if (answered.status !== 200) throw new Error(`提交失败：${answered.status} ${answered.text}`);

  // ---- 5. 结论：这个答案是**真闸门**，不是空操作 ----
  // 地面真相用文件系统判定（allowed-once ⇒ 越界写成功；rejected ⇒ 文件不存在）。
  const markerAppeared = await waitFor('标记文件出现', async () => existsSync(MARKER), {
    timeoutMs: OUTCOME === 'allowed-once' ? 180_000 : 0,
    intervalMs: 3000,
  }).catch(() => false);
  log(`5. 标记文件存在 = ${existsSync(MARKER)} （期望 ${OUTCOME === 'allowed-once' ? '存在' : '不存在'}）`);

  // 桌面端记录里的工具结果文本（经网关读，与手机端同一路径）
  const transcript = await waitFor('工具结果落入会话记录', async () => {
    const r = await gw('GET', `/api/v2/sessions/${sessionId}/transcript?limit=200`);
    const blob = r.text ?? '';
    if (OUTCOME === 'allowed-once' && blob.includes('GATEWAY_APPROVAL_E2E_OK')) return blob;
    if (OUTCOME === 'rejected' && (blob.includes('rejected') || blob.includes('denied'))) return blob;
    return null;
  }, { timeoutMs: 180_000, intervalMs: 4000 }).catch((e) => `（未取到：${e.message}）`);

  const blob = typeof transcript === 'string' ? transcript : '';
  const hitOk = blob.includes('GATEWAY_APPROVAL_E2E_OK');
  const hitReject = /reject|denied|拒绝/i.test(blob);
  log(`5. 会话记录命中：GATEWAY_APPROVAL_E2E_OK=${hitOk} 拒绝措辞=${hitReject}`);

  const counters = (await gw('GET', '/api/v2/approvals')).json?.state?.counters ?? {};
  log(`5. 桥计数器 ${JSON.stringify(counters)}`);
  const after = await gw('GET', '/api/v2/approvals');
  log(`5. 未决列表（应答后）approvals=${JSON.stringify(after.json?.approvals)} pending=${after.json?.state?.pending}`);

  // 判定：allowed-once 必须真的产生文件；rejected 必须真的没产生
  const pass = OUTCOME === 'allowed-once'
    ? (existsSync(MARKER) && hitOk)
    : (!existsSync(MARKER) && hitReject);
  log(pass ? 'RESULT: PASS' : 'RESULT: FAIL（答案没有真正改变桌面端的执行结果）');
  if (!pass) process.exitCode = 1;
  await cleanup(api, sessionId, pass ? 'PASS 后收尾' : 'FAIL 后收尾');
} catch (err) {
  log(`RESULT: FAIL — ${err.message}`);
  try { log(`调试：未决列表 ${JSON.stringify((await gw('GET', '/api/v2/approvals')).json)}`); } catch { /* ignore */ }
  await cleanup(api, sessionId, 'FAIL 后收尾');
  process.exitCode = 1;
}
