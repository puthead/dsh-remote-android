/**
 * 基线/回归证据：用与线上镜像完全相同的 SessionMirror（只读根 = 真实桌面端 home）
 * 走 `list()`，把「默认列表」与「includeSubagent=true」逐条打出来。
 *
 * 这不是模拟：`tools/dsh-remote` 的 mirror 装配与 config.mjs 的 sessionRoots 一致，
 * 线上 8787 网关的会话列表就是这条代码路径产出的。
 *
 * usage: node probe-session-list.mjs [dshHome]
 */
import { SessionMirror } from '../tools/dsh-remote/lib/session-reader.mjs';

const HOME = process.argv[2] ?? 'C:\\Users\\Administrator\\.dsh';

const mirror = new SessionMirror({
  roots: [{ home: HOME, source: 'computer', writable: false, label: '电脑端镜像' }],
  liveWindowMs: 60_000,
});

const pad = (s, n) => String(s ?? '').padEnd(n);
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');

const def = await mirror.list({ limit: 200 });
const all = await mirror.list({ limit: 200, includeSubagent: true });

console.log(`=== HOME=${HOME} ===`);
console.log(`默认（includeSubagent 缺省=false）：total=${def.total}  返回=${def.sessions.length}`);
console.log(`显式 include=subagent|all：        total=${all.total}  返回=${all.sessions.length}`);

const derived = all.sessions.filter((s) => s.origin === 'subagent' || s.parentSession || (s.delegationDepth ?? 0) > 0);
console.log(`\n--- 派生会话（origin=subagent 或 有 parentSession 或 delegationDepth>0），隐藏了多少条 ---`);
console.log(`  共 ${derived.length} 条；其中 origin=subagent ${derived.filter((s) => s.origin === 'subagent').length}，仅有 parentSession ${derived.filter((s) => s.origin !== 'subagent').length}`);
for (const s of derived.filter((x) => x.origin !== 'subagent')) {
  console.log(`  [有 parent 但 origin!=subagent] id=${s.id} origin=${s.origin} parent=${s.parentSession} depth=${s.delegationDepth} isSeeded=${s.isSeeded} workspace=${s.workspace}`);
}
console.log(`\n--- include=all 前 8 条（父子关系在 include 下可见） ---`);
console.log('  #  id                                     origin    depth parent                                    title');
for (const [i, s] of all.sessions.slice(0, 8).entries()) {
  console.log(`  ${pad(i + 1, 2)} ${pad(s.id, 38)} ${pad(s.origin, 9)} ${pad(s.delegationDepth ?? '-', 5)} ${pad(s.parentSession ?? '-', 41)} ${cut(s.title, 30)}`);
}

console.log(`\n--- 默认列表 ${def.sessions.length} 条（这就是手机端「电脑会话」页看到的集合） ---`);
console.log('  #  id                                     source    origin  parent                                    title');
for (const [i, s] of def.sessions.entries()) {
  console.log(`  ${pad(i + 1, 2)} ${pad(s.id, 38)} ${pad(s.source, 9)} ${pad(s.origin, 7)} ${pad(s.parentSession ?? '-', 41)} ${cut(s.title, 40)}`);
}
