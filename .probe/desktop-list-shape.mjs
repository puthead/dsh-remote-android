// 只读探针：桌面端 listSessions 的条目形状 —— 判断「哪些条目值得我们中继」。
// 关键问题：167 条里有多少是子代理（derived）会话？running 字段是否可信？
import fs from 'node:fs';
import { DesktopApi } from '../tools/dsh-remote/lib/desktop-api.mjs';
import { isDerivedSession } from '../tools/dsh-remote/lib/dsh-home.mjs';

const cfg = JSON.parse(fs.readFileSync('C:/Users/Administrator/.dsh-remote/config.json', 'utf8'));
const api = new DesktopApi({
  host: cfg.desktop?.host, port: cfg.desktop?.port, home: cfg.desktop?.dshHome,
  authority: cfg.desktop?.authority, timeoutMs: 20000,
});

const items = await api.listSessions();
console.log(`总数=${items.length}`);
console.log('第一条原始形状：');
console.log(JSON.stringify(items[0], null, 2).slice(0, 1200));

const derived = items.filter((i) => isDerivedSession(i));
const top = items.filter((i) => !isDerivedSession(i));
console.log(`\nderived（子代理/派生）=${derived.length}  顶层=${top.length}`);
console.log(`顶层里 running=true 的 = ${top.filter((i) => i.running).length}`);
for (const i of top.filter((x) => x.running)) {
  console.log(`  ▶ ${i.sessionId}  origin=${i.origin ?? i.header?.origin ?? '?'} turns=${i.projections?.values?.sessionStats?.turns ?? '?'} title=${JSON.stringify(i.projections?.values?.title ?? '').slice(0, 40)} keys=${Object.keys(i).join(',')}`);
}
console.log(`\nderived 里 running=true 的 = ${derived.filter((i) => i.running).length}（若很大，说明 running 不可单独作为判据）`);
console.log('derived 样例 keys:', Object.keys(derived[0] ?? {}).join(','));
console.log('derived 样例:', JSON.stringify(derived[0] ?? null).slice(0, 500));
