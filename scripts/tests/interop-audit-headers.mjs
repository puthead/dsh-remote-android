/**
 * 代协议合规审计（**证据型脚本**，手动互操作，不属于自包含单测）：
 * 把网关经隧道回传的**响应头**原样打印出来，用来判断是否存在逐跳头
 * （`connection` / `transfer-encoding` / `keep-alive` / `upgrade` / `proxy-connection`）透传问题。
 *
 * 为什么值得单独验：`res` 帧按契约是"响应头"，手机侧 TunnelHttp 会把它当 HTTP 响应头用。
 * 若里面带着 `transfer-encoding: chunked`，隧道自己的 chunk 分帧就与该头语义重叠（双重分帧），
 * 手机解析容易出现"看着像截断/多出字节"的问题。
 * ⚠️ 实测结论（2026-10-08，真实 relay×gateway）：三类代表响应（JSON / 300KB 文件 / SSE）**都没有逐跳头**，
 *    所以这是"建议加防御性过滤"的观察项，**不是缺陷**。本脚本保留为回归证据。
 *
 * ⚠️ 会真起 relay/gateway 子进程，串行执行，占用端口段 19700。
 *
 * 用法（在**仓库根目录**执行）：
 *   node scripts/tests/interop-audit-headers.mjs
 *   证据目录：默认 .runtime/interop/run/audit-headers-<时间戳>/
 *
 * 退出码：0=采集完成（**不做断言**：逐跳头出现与否都由输出呈现，由人判定）；
 *         1=采集过程出错；2=脚本无法运行。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { openTunnel } from '../../tools/dsh-relay/test/ws-client.mjs';
import { REPO, httpJson, makeRunDir, interopPort, pickPort, printUsage, startGateway, startRelay, stopAll, waitFor } from './interop-lib.mjs';

printUsage({
  name: 'interop-audit-headers',
  usage: 'node scripts/tests/interop-audit-headers.mjs',
  ports: 'relay 19700',
  extra: '证据型：打印经隧道回传的 res 头，检查逐跳头（不做断言）',
});

const runDir = await makeRunDir('audit-headers');
const workspace = path.join(runDir, 'ws');
await fs.mkdir(workspace, { recursive: true });
const port = await pickPort(interopPort(19_700));
let relay = null;
let gateway = null;

try {
  relay = await startRelay({ runDir, tlsMode: 'off', relayName: '127.0.0.1', relaySecret: 's', port });
  gateway = await startGateway({ runDir, relayUrl: relay.wsBase, relaySecret: 's', workspace });
  await waitFor(async () => (await httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status')).json?.connected === true, { timeoutMs: 20_000, what: '网关连上中继' });
  const opened = await httpJson(gateway.httpBase, 'POST', '/api/v2/pair/open', { body: {} });
  const claimed = await httpJson(relay.httpBase, 'POST', '/api/v2/pair/claim', { body: { code: opened.json.code, deviceName: 'Audit Phone', deviceId: 'abcdabcd-1111-4222-8333-444455556666' } });
  const token = claimed.json.relay.deviceToken;

  const tunnel = await openTunnel(`${relay.wsBase}/api/v2/tunnel/device`, { role: 'device', token, rejectUnauthorized: false });
  await tunnel.handshake();

  const probes = [
    ['GET', '/api/v2/health', {}],
    ['GET', `/api/v2/workspaces/file?path=${encodeURIComponent(path.join(workspace, 'big.txt'))}`, {}],
    ['GET', '/api/v2/sessions/stream', { accept: 'text/event-stream' }],
  ];
  await fs.writeFile(path.join(workspace, 'big.txt'), 'A'.repeat(300_000), 'utf8');
  /** @type {Array<{probe: string, status: number, hopByHop: string[]}>} */
  const observations = [];

  let id = 1;
  for (const [method, p, extra] of probes) {
    const rid = id++;
    tunnel.send({ t: 'req', id: rid, method, path: p, headers: { authorization: `Bearer ${token}`, ...extra } });
    const head = await tunnel.waitFrame((f) => f.t === 'res' && f.id === rid, { timeoutMs: 10_000, what: `${p} 的 res 帧` }).catch(() => null);
    console.log(`\n--- ${method} ${p}`);
    if (!head) {
      console.log('  (未在 10s 内收到 res 帧)');
      continue;
    }
    console.log(`  status=${head.status}`);
    const hopByHop = [];
    for (const [k, v] of Object.entries(head.headers ?? {})) {
      console.log(`  ${k}: ${v}`);
      if (['connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-connection'].includes(k.toLowerCase())) hopByHop.push(k);
    }
    console.log(`  逐跳头：${hopByHop.length ? hopByHop.join(', ') : '(无)'}`);
    observations.push({ probe: `${method} ${p}`, status: head.status, hopByHop });
    tunnel.send({ t: 'cancel', id: rid });
  }
  const leaking = observations.filter((o) => o.hopByHop.length > 0);
  console.log(`\n=== 响应头审计：${observations.length} 条探针，逐跳头泄漏 ${leaking.length} 条 ===`);
  if (leaking.length > 0) {
    console.log('  发现的逐跳头（建议网关在 #dispatch 里过滤 hop-by-hop 头）：');
    for (const o of leaking) console.log(`  - ${o.probe}: ${o.hopByHop.join(', ')}`);
  } else {
    console.log('  结论：三类代表响应均无逐跳头 → 观察项，不列为缺陷（保留本脚本为回归证据）');
  }
  tunnel.destroy();
} finally {
  await stopAll(gateway, relay);
  console.log(`证据目录：${path.relative(REPO, runDir)}`);
  console.log('退出码：0=采集完成（不做断言，逐跳头情况见上方输出）；1=采集过程出错；2=脚本无法运行');
}
