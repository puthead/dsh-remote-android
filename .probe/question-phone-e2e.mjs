/**
 * 提问（ask_user_question）真·端到端，两段式（配合 adb 在 App 上点选）：
 *
 *   MODE=trigger  建桌面端会话 → 经网关投递「调用一次 ask_user_question」的轮次 →
 *                 轮询到未决提问后落状态文件并退出（**不回答**，留给手机点）。
 *   MODE=verify   轮询未决表清空 + 会话记录里出现手机的答案 → PASS/FAIL。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:18087';
const TOKEN_FILE = 'D:\\Workspace\\dsh_android\\.runtime\\live-env\\logs\\headless-device-token.txt';
const STATE_FILE = 'D:\\Workspace\\dsh_android\\.probe\\question-phone-state.json';
const MODE = process.env.MODE === 'verify' ? 'verify' : 'trigger';
const EXPECT = process.env.EXPECT ?? '生产';

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
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${label}）`);
}

if (MODE === 'trigger') {
  const api = new DesktopApi({});
  const created = await api.createSession({ cwd: 'D:\\Workspace\\dsh_android' });
  const sessionId = created.sessionId;
  log(`会话 ${sessionId}`);

  const prompt = [
    '请调用 ask_user_question 工具**一次**，不要调用别的工具，也不要自己回答这个问题：',
    '- questions 恰好一项：{ id: "q1", header: "发布环境", question: "这次发布到哪个环境？", options: [{label:"生产"},{label:"预发"},{label:"本地"}] }',
    '- 不要传 timeout 参数（我要一直等手机回答）。',
    '拿到答案后，用一行中文告诉我你收到的是哪个环境。',
  ].join('\n');

  const turn = await gateway(`/api/v2/sessions/${sessionId}/turns`, { method: 'POST', body: JSON.stringify({ prompt }) });
  log(`投递轮次 HTTP ${turn.status} ${JSON.stringify(turn.json)}`);
  if (turn.status >= 400) throw new Error(`投递失败 ${turn.status}`);

  const pending = await waitFor('提问出现在网关未决表', async () => {
    const r = await gateway(`/api/v2/approvals?sessionId=${encodeURIComponent(sessionId)}`);
    const hit = (r.json?.approvals ?? []).find((a) => a.kind === 'question');
    if (hit) return hit;
    log(`   轮询未决… pending=${r.json?.state?.pending ?? '?'}`);
    return null;
  }, 240_000, 5000);

  const listed = await gateway('/api/v2/sessions?limit=5');
  const title = (listed.json?.sessions ?? []).find((s) => s.id === sessionId)?.title ?? '(未知)';
  writeFileSync(STATE_FILE, JSON.stringify({ sessionId, eventId: pending.eventId, title, questions: pending.questions, at: Date.now() }, null, 2));
  log(`READY 未决提问 eventId=${pending.eventId} 会话标题=${title}`);
  log(`问题：${JSON.stringify(pending.questions)}`);
  log(`状态文件：${STATE_FILE}（现在请在 App 里选「${EXPECT}」并提交）`);
} else {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  log(`校验会话 ${state.sessionId}（${state.title}）/ eventId ${state.eventId}`);
  const cleared = await waitFor('未决表里这条提问消失', async () => {
    const r = await gateway('/api/v2/approvals');
    const still = (r.json?.approvals ?? []).some((a) => a.eventId === state.eventId);
    log(`   轮询未决表：pending=${r.json?.state?.pending ?? '?'} 本条仍在=${still}`);
    return still ? null : r.json?.state;
  }, 240_000, 4000).catch(() => null);

  const tr = await gateway(`/api/v2/sessions/${state.sessionId}/transcript?limit=40`);
  const text = JSON.stringify(tr.json ?? {});
  const sawAnswer = text.includes(EXPECT);
  log(`未决表清空 = ${Boolean(cleared)}；记录里出现「${EXPECT}」= ${sawAnswer}`);
  const pass = Boolean(cleared) && sawAnswer;
  log(pass ? 'RESULT: PASS（App 里的选择真的回到了电脑端那一轮）' : 'RESULT: FAIL');
  if (!pass) {
    log(`transcript 片段：${text.slice(0, 1200)}`);
    process.exitCode = 1;
  }
}
