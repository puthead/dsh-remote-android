/**
 * 安全回归：**路径规范化绕过**（**手动互操作脚本**，不属于自包含单测）。
 *
 * ⚠️ 会真起 relay/gateway 子进程（真实 TCP/WS），串行执行，占用端口段 19750。
 *
 * 背景（R2 审计发现的真实绕过）：中继原先按**字面路径**判定管理面黑名单，而网关会把 `..`/`%2e%2e`
 * 规范化后再打本机 HTTP，且隧道转发的来源在网关看来就是 `127.0.0.1`（§4.1 回环检查形同虚设）。
 * 于是任何**已配对手机**都能经隧道调用 PC 的"仅回环"端点：
 *   - `GET  /x/../api/v2/relay/status`        → 修复前 **200**（拿到 relay 状态）
 *   - `GET  /%2e%2e/api/v2/relay/status`      → 修复前 **200**
 *   - 危害还包括 `POST /api/v2/relay/disconnect`（断掉 PC 隧道）、`POST /api/v2/pair/open`（自行开配对窗口）
 * 修复：中继所有管理面判定改为基于规范化后的 pathname（`normalizePathname`），协议相对路径 `//host/x` 直接 400。
 *
 * 本脚本把它变成**真实链路回归**：所有绕过写法必须 403，对照的合法业务端点必须 200；
 * 任一绕过成功 → 退出码 1。
 *
 * 用法（在**仓库根目录**执行）：
 *   node scripts/tests/interop-audit-path-bypass.mjs
 *   证据目录：默认 .runtime/interop/run/audit-path-bypass-<时间戳>/
 *
 * 退出码：0=绕过全部被挡住；1=存在绕过（回归！）；2=脚本无法运行。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { openTunnel } from '../../tools/dsh-relay/test/ws-client.mjs';
import { REPO, httpJson, makeRunDir, interopPort, pickPort, printUsage, startGateway, startRelay, stopAll, waitFor } from './interop-lib.mjs';

printUsage({
  name: 'interop-audit-path-bypass',
  usage: 'node scripts/tests/interop-audit-path-bypass.mjs',
  ports: 'relay 19750',
  extra: '安全回归：dot-segment / 百分号编码不得绕过管理面黑名单',
});

const runDir = await makeRunDir('audit-path-bypass');
const workspace = path.join(runDir, 'ws');
await fs.mkdir(workspace, { recursive: true });
const port = await pickPort(interopPort(19_750));
let relay = null;
let gateway = null;
let failures = 0;
/** 探针总数在外层累计（`cases` 是 try 块内的局部量，汇总时不能引用块内变量）。 */
let total = 0;

try {
  relay = await startRelay({ runDir, tlsMode: 'off', relayName: '127.0.0.1', relaySecret: 's', port });
  gateway = await startGateway({ runDir, relayUrl: relay.wsBase, relaySecret: 's', workspace });
  await waitFor(async () => (await httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status')).json?.connected === true, { timeoutMs: 20_000, what: '网关连上中继' });
  const opened = await httpJson(gateway.httpBase, 'POST', '/api/v2/pair/open', { body: {} });
  const claimed = await httpJson(relay.httpBase, 'POST', '/api/v2/pair/claim', { body: { code: opened.json.code, deviceName: 'Attacker Phone', deviceId: 'deadbeef-1111-4222-8333-444455556666' } });
  const token = claimed.json.relay.deviceToken;
  const tunnel = await openTunnel(`${relay.wsBase}/api/v2/tunnel/device`, { role: 'device', token, rejectUnauthorized: false });
  await tunnel.handshake();

  /** [method, path, 期望状态, 说明] */
  const cases = [
    ['GET', '/api/v2/relay/status', 403, '基线：直接路径'],
    ['GET', '/x/../api/v2/relay/status', 403, '绕过尝试：dot-segment（修复前 200）'],
    ['GET', '/%2e%2e/api/v2/relay/status', 403, '绕过尝试：百分号编码的点（修复前 200）'],
    ['GET', '/api/v2/tunnel/../../api/v2/relay/status', 403, '绕过尝试：tunnel 前缀 + dot-segment'],
    ['GET', '/health/../api/v2/homes', 403, '绕过尝试：health 前缀 + dot-segment'],
    ['GET', '/x/../api/v2/pair/window', 403, '绕过尝试：控制面 window'],
    ['POST', '/a/b/../../../api/v2/pair/open', 403, '绕过尝试：pair/open'],
    ['GET', '//evil.example/api/v2/relay/status', 400, '协议相对路径直接 400'],
    ['GET', '/api/v1/health', 200, '对照：合法业务端点必须仍然可用'],
  ];
  let id = 1;
  for (const [method, p, expected, label] of cases) {
    const rid = id++;
    total++;
    tunnel.send({ t: 'req', id: rid, method, path: p, headers: { authorization: `Bearer ${token}` } });
    const collected = await tunnel.collect(rid, { timeoutMs: 8000 }).catch((err) => ({ status: 'timeout', text: err.message, aborted: 'timeout' }));
    const body = String(collected.text ?? '').slice(0, 110).replace(/\s+/g, ' ');
    const ok = collected.status === expected;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${method} ${p} → status=${collected.status}（期望 ${expected}）${collected.aborted ? ` aborted=${collected.aborted}` : ''}`);
    console.log(`        ${label}｜${body}`);
  }
  tunnel.destroy();
} finally {
  await fs.writeFile(path.join(runDir, 'relay.stderr.txt'), relay?.state?.stderr ?? '', 'utf8').catch(() => {});
  await stopAll(gateway, relay);
}
console.log(`\n=== 路径绕过回归：${total - failures}/${total} 通过 ===`);
console.log(`证据目录：${path.relative(REPO, runDir)}`);
console.log('退出码：0=绕过全部被挡住；1=存在绕过（回归）；2=脚本无法运行');
process.exit(failures === 0 ? 0 : 1);
