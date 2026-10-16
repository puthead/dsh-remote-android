/**
 * 真相取证：直接读 PC 真实桌面端 home 的 session header，
 * 按「顶层会话判据」给每个会话打标，并汇总 30 条里到底有多少派生会话。
 *
 * 判据（与 DSH 桌面端 sessionVisible 对齐）：
 *   top = origin !== 'subagent' && !!origin && (delegationDepth ?? 0) === 0 && !parentSession
 * 另打印 origin 原值（区分「显式 user」与「字段缺失」），因为缺 origin 时
 * discoverSessions 会悄悄兜底成 'user'。
 */
import path from 'node:path';
import { discoverSessions } from '../tools/dsh-remote/lib/dsh-home.mjs';

const HOME = process.argv[2] ?? 'C:\\Users\\Administrator\\.dsh';
const TOPN = Number(process.argv[3] ?? 40);
const DEDUP = process.argv.includes('--dedup');

const all = await discoverSessions({ dshHome: HOME, includeSubagents: true });
const key = (x) => `${x.id}|${x.mtimeMs}`;
const seen = new Set();
const rows = all
  .filter((x) => (DEDUP ? !seen.has(key(x)) && seen.add(key(x)) : true))
  .sort((a, b) => b.mtimeMs - a.mtimeMs);

const byId = new Map(all.map((x) => [x.id, x]));
// 顶层判据
const isTop = (x) =>
  x.origin === 'user' &&
  x.header?.origin !== undefined &&
  (x.header?.delegationDepth ?? 0) === 0 &&
  !x.parentSession;
const isTopLoose = (x) => x.origin !== 'subagent' && (x.header?.delegationDepth ?? 0) === 0 && !x.parentSession;

const counts = {};
for (const x of all) {
  const k = `origin=${x.origin} depth=${x.header?.delegationDepth ?? 'absent'} parent=${x.parentSession ? 'yes' : 'no'} originField=${x.header?.origin ?? 'ABSENT'}`;
  counts[k] = (counts[k] ?? 0) + 1;
}
console.log(`=== ${HOME} : ${all.length} 个会话目录 ===`);
console.log('--- 元数据组合直方图 ---');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

console.log(`\n--- 顶层判据统计 ---`);
console.log(`  严格（origin 字段显式为 user 且 depth=0 且无 parent）: ${all.filter(isTop).length}`);
console.log(`  宽松（仅 origin!==subagent 且 depth=0 且无 parent）  : ${all.filter(isTopLoose).length}`);
console.log(`  现行网关口径（origin==='user'，即 discoverSessions 兜底后）: ${all.filter((x) => x.origin === 'user').length}`);
console.log(`  派生（origin==='subagent'）: ${all.filter((x) => x.origin === 'subagent').length}`);

console.log(`\n--- 最近 ${TOPN} 条（按 mtime 倒序，网关列表顺序） ---`);
console.log('  #  判定   id                                    origin字段  depth parent                              title');
for (const [i, x] of rows.slice(0, TOPN).entries()) {
  const verdict = isTop(x) ? '顶层' : x.origin === 'subagent' ? '子代理' : '派生?';
  const par = x.parentSession ? (byId.get(x.parentSession)?.id ?? x.parentSession).slice(0, 34) : '-';
  console.log(
    `  ${String(i + 1).padStart(2)} ${verdict.padEnd(5)} ${x.id.padEnd(38)} ${String(x.header?.origin ?? 'ABSENT').padEnd(10)} ${String(x.header?.delegationDepth ?? 'ABSENT').padEnd(5)} ${par.padEnd(35)} ${(x.header && (x.header.agentPreset ?? '')) || ''}`,
  );
}
