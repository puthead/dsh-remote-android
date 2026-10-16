/**
 * Lead 独立复核：管理端点「仅回环」在隧道场景下的绕过是否真的被堵住。
 *
 * 不复用被测代码的任何判定：起一个**真实网关进程**，用**裸 HTTP 请求**去打，
 * 看状态码。绕过写法必须被拒（400/403/404），正常业务端点必须仍然可用。
 *
 * 用法：node .runtime/verify-admin-bypass.mjs <gatewayDir> <nodeExe>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const gatewayDir = path.resolve(process.argv[2]);
const nodeExe = process.argv[3];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-bypass-'));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(ws, { recursive: true });

const config = {
  host: '127.0.0.1',
  port: 0,
  home,
  workspaceAllowlist: [ws],
  defaultWorkspace: ws,
  authRequired: true,
  log: { toConsole: false },
};
const configPath = path.join(root, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

const child = spawn(nodeExe, [path.join(gatewayDir, 'gateway.mjs'), 'serve', '--config', configPath], {
  cwd: gatewayDir,
  env: { ...process.env, DSH_REMOTE_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => (out += c));
let errOut = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => (errOut += c));

/** 从 stdout 抓真实端口。 */
async function waitPort() {
  for (let i = 0; i < 100; i++) {
    const m = /http:\/\/[\d.]+:(\d+)/.exec(out);
    if (m) return Number(m[1]);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`网关未在 10s 内报告端口。stdout=${out.slice(0, 400)} stderr=${errOut.slice(0, 400)}`);
}

/** 裸请求：用 http.request 而不是 fetch，避免客户端自作主张规范化路径。 */
function rawRequest(port, rawPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
      req.end();
    });
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

try {
  const port = await waitPort();
  console.log(`网关已在 127.0.0.1:${port} 就绪（隔离 home=${home}）\n`);

  // ---- 1) 基线：直连管理端点，回环来源 → 应当被允许（200） ----
  const base = await rawRequest(port, '/api/v2/relay/status');
  check('基线：直连 /api/v2/relay/status 回环来源可用', base.status === 200, `status=${base.status}`);

  // ---- 2) 4 种绕过写法：必须被拒，且不得命中管理路由 ----
  const bypasses = [
    '/x/../api/v2/relay/status',
    '/%2e%2e/api/v2/relay/status',
    '/api/v2/relay/./status',
    '/api/v2/relay/%2e/status',
    '/.%2e/api/v2/relay/status',
    '//api/v2/relay/status',
    '/x/../api/v2/pair/open',
    '/%2e%2e/api/v2/pair/open',
  ];
  for (const raw of bypasses) {
    const res = await rawRequest(port, raw);
    const rejected = res.status === 400 || res.status === 403 || res.status === 404;
    check(`绕过被拒 ${raw}`, rejected, `status=${res.status} body=${res.body.slice(0, 80)}`);
  }

  // ---- 3) 伪造隧道标记：直连时不得因该头获得任何特权 ----
  // 注意：这个头是 relay-client 的**内部**标记，客户端永远不该带它。
  // 因此"带了就被拒"是**正确的 fail-closed 行为**，不是缺陷 —— 断言应为 403。
  const forged = await rawRequest(port, '/api/v2/relay/status', { headers: { 'x-dsh-tunnel': '0' } });
  check(
    '直连携带 x-dsh-tunnel（任意值）→ 管理端点 fail-closed 拒绝',
    forged.status === 403,
    `status=${forged.status}（该头为内部标记，客户端携带即拒绝）`,
  );
  const forgedZero = await rawRequest(port, '/api/v2/relay/status', { headers: { 'x-dsh-tunnel': '' } });
  check(
    '直连携带空 x-dsh-tunnel → 同样 fail-closed',
    forgedZero.status === 403,
    `status=${forgedZero.status}`,
  );
  const forged2 = await rawRequest(port, '/api/v2/relay/connect', { method: 'POST', headers: { 'x-dsh-tunnel': '1' } });
  check('伪造 x-dsh-tunnel:1 打管理端点被拒', forged2.status === 403, `status=${forged2.status} body=${forged2.body.slice(0, 90)}`);
  const forged3 = await rawRequest(port, '/api/v2/relay/disconnect', { method: 'POST', headers: { 'x-dsh-tunnel': '1' } });
  check('伪造 x-dsh-tunnel:1 打 disconnect 被拒', forged3.status === 403, `status=${forged3.status}`);
  // 关键性质：该头**不得**成为业务端点的授权依据（业务端点仍要令牌）
  const forgedBiz = await rawRequest(port, '/api/v2/sessions', { headers: { 'x-dsh-tunnel': '1' } });
  check(
    '伪造隧道标记不得让业务端点免鉴权（仍须 401）',
    forgedBiz.status === 401,
    `status=${forgedBiz.status}`,
  );

  // ---- 4) 正常业务端点不受影响（health 公共、需鉴权的返回 401 而非 403/400） ----
  const health = await rawRequest(port, '/api/v1/health');
  check('公共端点 /api/v1/health 仍 200', health.status === 200, `status=${health.status}`);
  const sessions = await rawRequest(port, '/api/v2/sessions');
  check('/api/v2/sessions 未鉴权 → 401（而不是被路径门禁误杀）', sessions.status === 401, `status=${sessions.status}`);
} catch (error) {
  check('执行', false, error.message);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length} / 共 ${results.length}`);
process.exitCode = failed.length === 0 ? 0 : 1;
