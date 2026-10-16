// 只读探针：看桌面端 session/follow 到底先吐什么（snapshot 回放量、cursor、seq）。
// 目的：给「电脑端发起的轮次」做实时中继时，需要知道如何避免把历史消息重复推给手机。
// 用法：node .probe/follow-shape.mjs [sessionId]
import fs from 'node:fs';
import { DesktopApi, translateDesktopEvent } from '../tools/dsh-remote/lib/desktop-api.mjs';

const cfgPath = 'C:/Users/Administrator/.dsh-remote/config.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
console.log('config.desktop =', JSON.stringify(cfg.desktop ?? null));

const api = new DesktopApi({
  host: cfg.desktop?.host,
  port: cfg.desktop?.port,
  home: cfg.desktop?.home,
  homeDirname: cfg.desktop?.homeDirname,
  authority: cfg.desktop?.authority,
  timeoutMs: 15000,
  streamTimeoutMs: 20000,
});

console.log('probe() →', JSON.stringify(await api.probe().catch((e) => ({ err: String(e.message) }))));

const items = await api.listSessions();
console.log(`listSessions: ${items.length} 条`);
const running = items.filter((i) => i.running);
console.log('running 的会话：');
for (const i of items) {
  console.log(`  ${i.running ? '▶' : ' '} ${i.sessionId}  turns=${i.projections?.values?.sessionStats?.turns ?? '?'} title=${JSON.stringify(i.projections?.values?.title ?? null)}`);
}

const target = process.argv[2] ?? running[0]?.sessionId ?? items[0]?.sessionId;
console.log(`\n=== follow ${target}（assistantStream:true, maxMessages:null）前 25 帧 ===`);
const controller = new AbortController();
const it = api.openFollow(target, { assistantStream: true, signal: controller.signal, timeoutMs: 20000 });
let n = 0;
const t0 = Date.now();
const seen = new Map();
try {
  while (n < 25) {
    const step = await it.next();
    if (step.done) {
      console.log(`[${Date.now() - t0}ms] done:`, JSON.stringify(step.value)?.slice(0, 300));
      break;
    }
    const v = step.value;
    n += 1;
    if (v?.type === 'snapshot') {
      console.log(`[${Date.now() - t0}ms] #${n} snapshot  cursor=${v.cursor} records=${v.records?.length} hasMore=${v.hasMore} keys=${Object.keys(v).join(',')}`);
      const kinds = {};
      for (const r of v.records ?? []) {
        const k = `${r.type ?? '?'}/${r.event?.type ?? '?'}`;
        kinds[k] = (kinds[k] ?? 0) + 1;
      }
      console.log(`        records 类型分布:`, JSON.stringify(kinds));
      console.log(`        assistantStream baseline:`, JSON.stringify(v.assistantStream ?? null)?.slice(0, 400));
      console.log(`        projections keys:`, Object.keys(v.projections ?? {}).join(','));
    } else if (v?.type === 'event') {
      const t = v.event?.type;
      seen.set(t, (seen.get(t) ?? 0) + 1);
      const tr = translateDesktopEvent(v);
      console.log(`[${Date.now() - t0}ms] #${n} event seq=${v.seq} ${t} → ${tr ? tr.type : '(丢弃)'} ${JSON.stringify(tr?.data ?? {}).slice(0, 120)}`);
    } else if (v?.type === 'assistant-stream') {
      console.log(`[${Date.now() - t0}ms] #${n} assistant-stream ${JSON.stringify(v.frame).slice(0, 160)}`);
    } else {
      console.log(`[${Date.now() - t0}ms] #${n} 其他类型:`, JSON.stringify(v).slice(0, 200));
    }
  }
} catch (err) {
  console.log('消费出错：', String(err?.message ?? err));
}
console.log('事件类型累计：', JSON.stringify([...seen]));
controller.abort();
await it.return?.().catch(() => {});
