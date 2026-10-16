// 只读探针：解析 session/follow 的 snapshot —— cursor / records.seq 的语义，
// 以及有没有「只回放不回放历史」的姿势（maxMessages:0 / turnWindow）。
import fs from 'node:fs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';

const cfg = JSON.parse(fs.readFileSync('C:/Users/Administrator/.dsh-remote/config.json', 'utf8'));
const api = new DesktopApi({
  host: cfg.desktop?.host, port: cfg.desktop?.port, home: cfg.desktop?.dshHome,
  authority: cfg.desktop?.authority, timeoutMs: 15000, streamTimeoutMs: 15000,
});

const target = process.argv[2];
const optsArg = process.argv[3] ?? 'default';

for (const variant of [optsArg]) {
  const opts = variant === 'maxMessages0'
    ? { assistantStream: true, maxMessages: 0 }
    : variant === 'plain'
      ? { assistantStream: false, maxMessages: null }
      : { assistantStream: true, maxMessages: null };
  console.log(`\n########## follow ${target} opts=${JSON.stringify(opts)} ##########`);
  const c = new AbortController();
  const it = api.openFollow(target, { ...opts, signal: c.signal });
  const t0 = Date.now();
  const step = await it.next().catch((e) => ({ done: true, value: { error: { message: String(e.message) } } }));
  if (step.done) { console.log('立刻结束：', JSON.stringify(step.value)); c.abort(); await it.return?.().catch(() => {}); continue; }
  const v = step.value;
  if (v.type !== 'snapshot') { console.log('第一帧不是 snapshot：', JSON.stringify(v).slice(0, 300)); c.abort(); await it.return?.().catch(() => {}); continue; }
  console.log('  第一条 record 原样：', JSON.stringify((v.records ?? [])[0]).slice(0, 400));
  const seqs = (v.records ?? []).map((r) => r.seq ?? r.event?.seq).filter((n) => typeof n === 'number');
  const evs = (v.records ?? []).filter((r) => r.type === 'event');
  const minSeq = Math.min(...seqs);
  const maxSeq = Math.max(...seqs);
  console.log(`[${Date.now() - t0}ms] snapshot: cursor=${v.cursor} records=${v.records?.length} hasMore=${v.hasMore}`);
  console.log(`  records.seq: min=${minSeq} max=${maxSeq} 有 seq 的=${seqs.length}  event 类=${evs.length}`);
  console.log(`  cursor 与 seq 的关系： cursor-1=${v.cursor - 1} cursor+1=${v.cursor + 1}  maxSeq=${maxSeq}`);
  console.log(`  最后 6 条 record:`, JSON.stringify((v.records ?? []).slice(-6).map((r) => ({ type: r.type, seq: r.seq, ev: r.event?.type }))));
  console.log(`  最初 6 条 record:`, JSON.stringify((v.records ?? []).slice(0, 6).map((r) => ({ type: r.type, seq: r.seq, ev: r.event?.type }))));
  console.log(`  projections.values.sessionStats:`, JSON.stringify(v.projections?.values?.sessionStats ?? null));
  c.abort();
  await it.return?.().catch(() => {});
}
