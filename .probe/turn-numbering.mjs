// 只读探针：桌面端投影里的「轮次编号」到底是几 —— 用来定 pickTurn 该不该 +1。
// 判据：正在跑的那一轮，它的 prompt 一定出现在 turnOutline 末尾（如果投影含运行中的轮次）；
// `sessionStats.turns` 与 outline 的 max turn 谁大谁小，决定中继补发 turn.started 时报几。
import fs from 'node:fs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const cfg = JSON.parse(fs.readFileSync('C:/Users/Administrator/.dsh-remote/config.json', 'utf8'));
const api = new DesktopApi({
  host: cfg.desktop?.host, port: cfg.desktop?.port, home: cfg.desktop?.dshHome,
  authority: cfg.desktop?.authority, timeoutMs: 15000, streamTimeoutMs: 15000,
});

const items = await api.listSessions();
const running = items.filter((i) => i.running === true);
console.log(`会话总数=${items.length} running=true 的=${running.length}`);
for (const it of running) {
  const v = it.projections?.values ?? {};
  const outline = Array.isArray(v.turnOutline) ? v.turnOutline : [];
  const maxOutline = outline.reduce((a, b) => Math.max(a, Number(b?.turn) || 0), 0);
  console.log(JSON.stringify({
    sessionId: it.sessionId,
    asOfSeq: it.projections?.asOfSeq,
    origin: it.origin ?? null,
    title: v.title ?? null,
    statsTurns: v.sessionStats?.turns ?? null,
    statsSteps: v.sessionStats?.steps ?? null,
    maxOutline,
    outlineLen: outline.length,
    lastOutline: outline.slice(-2).map((o) => ({ turn: o?.turn, seq: o?.seq, prompt: String(o?.prompt ?? '').slice(0, 60) })),
  }, null, 2));
}
