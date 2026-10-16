/**
 * 互操作冒烟：真实 relay 进程 × 真实 gateway 进程 × WS 手机模拟器（**手动互操作脚本**，不属于自包含单测）。
 *
 * ⚠️ 本脚本会真起 relay/gateway 两个子进程（真实 TCP/WS，无 mock），串行执行，占用固定端口段 19100/19300；
 *    自包含单测请用 `tools/dsh-relay/test/*.test.mjs`（`port:0`，可 CI 并发）。
 *
 * 链路：手机模拟器（WS，独立实现）── ws/wss ──▶ relay 进程 ── 隧道 ──▶ gateway 进程 ──▶ 本机真实 HTTP
 * 判据：
 *   1. 隧道回来的 `/api/v1/health`、`/api/v2/health` 与**直连** gateway 的响应逐字段一致（易变字段除外）
 *   2. 真实业务面：`GET /api/v2/sessions`、`GET /api/v2/workspaces/files`
 *   3. **经隧道配对**（v1/v2）：响应恒带 `relay` 块，且新令牌真能建立 device 隧道
 *   4. 无令牌访问 → 401（隧道没有绕过鉴权）
 *   5. （可选，`--with-task`）`POST /api/v2/tasks` 真起 SDK 子进程 → 202 + `source:"phone"` + transcript 可读
 *
 * 用法（在**仓库根目录**执行）：
 *   node scripts/tests/interop-smoke.mjs [off|selfsigned|both] [--with-task]
 *   默认 both（先 off 再 selfsigned）；加 --with-task 才会真起 SDK 子进程（消耗额度，仅验收期用）
 *   证据目录：默认 .runtime/interop/run/<label>-<时间戳>/（脚本结尾会打印），可用 DSH_INTEROP_RUNDIR 覆盖
 *
 * 退出码：0=全部通过；1=有失败断言；2=脚本无法运行（参数/环境）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  REPO,
  createReport,
  httpJson,
  makeRunDir,
  openPhone,
  interopPort,
  requireEnum,
  pickPort,
  printUsage,
  sleep,
  startGateway,
  startRelay,
  stopAll,
  waitFor,
} from './interop-lib.mjs';

printUsage({
  name: 'interop-smoke',
  usage: 'node scripts/tests/interop-smoke.mjs [off|selfsigned|both] [--with-task]',
  ports: 'relay 19100(off)/19300(selfsigned)',
  extra: '手机模拟器经隧道跑真实业务面；--with-task 会真起 SDK 子进程（消耗额度）',
});

const MODE = requireEnum(process.argv[2] ?? 'both', ['off', 'selfsigned', 'both'], {
  argName: 'mode',
  usage: 'node scripts/tests/interop-smoke.mjs [off|selfsigned|both] [--with-task]',
});
/** 只跑会话/健康只读面（默认）；传 --with-task 才真起 SDK 子进程。 */
const WITH_TASK = process.argv.includes('--with-task');

/** 比较两个 health 对象：键集合一致，除易变字段外逐字段一致。 */
const VOLATILE = new Set(['uptimeMs', 'relay', 'sessionRunner', 'sessionsCached']);

function compareHealth(report, label, tunneled, direct, { volatile = VOLATILE } = {}) {
  const keysTunnel = Object.keys(tunneled ?? {}).sort();
  const keysDirect = Object.keys(direct ?? {}).sort();
  report.expect(
    JSON.stringify(keysTunnel) === JSON.stringify(keysDirect),
    `${label} health 字段集合一致`,
    `tunnel=[${keysTunnel}] direct=[${keysDirect}]`,
  );
  const mismatches = [];
  const skipped = [];
  for (const key of keysDirect) {
    if (volatile.has(key)) {
      skipped.push(key);
      continue;
    }
    const a = JSON.stringify(tunneled?.[key]);
    const b = JSON.stringify(direct?.[key]);
    if (a !== b) mismatches.push(`${key}: tunnel=${a} direct=${b}`);
  }
  report.expect(
    mismatches.length === 0,
    `${label} health 逐字段一致（易变字段 ${skipped.join('/')} 除外）`,
    mismatches.join(' | ') || `全部相同；已排除易变字段：${skipped.join(', ')}`,
  );
  report.expect(
    typeof tunneled?.uptimeMs === 'number' && typeof direct?.uptimeMs === 'number' && tunneled.uptimeMs >= direct.uptimeMs - 5000,
    `${label} uptimeMs 合理`,
    `tunnel=${tunneled?.uptimeMs} direct=${direct?.uptimeMs}`,
  );
}

async function runScenario(mode) {
  const report = createReport(`互操作冒烟（tls.mode=${mode}${WITH_TASK ? '，含真实 SDK 任务' : ''}）`);
  const runDir = await makeRunDir(`smoke-${mode}`);
  const workspace = path.join(runDir, 'ws');
  await fs.mkdir(workspace, { recursive: true });
  // 放一个文件让工作区浏览有内容
  await fs.writeFile(path.join(workspace, 'README.md'), '# interop workspace\n', 'utf8');

  console.log(`\n########## 场景：tls.mode=${mode} ##########`);
  console.log(`运行目录：${path.relative(REPO, runDir)}`);

  let relay = null;
  let gateway = null;
  try {
    relay = await startRelay({
      runDir,
      tlsMode: mode,
      // 固定端口 + relayName=127.0.0.1：让"中继推导的 tunnelUrl"与真实可连地址一致，
      // 这样 tunnelUrl 断言才有意义（生产里 relayName 就是公网域名，同理）。
      port: await pickPort(interopPort(mode === 'off' ? 19_100 : 19_300)),
      relayName: '127.0.0.1',
      relaySecret: 'interop-secret',
    });
    console.log(`relay  : pid=${relay.proc.pid} port=${relay.port} url=${relay.wsBase}`);
    const relayHealth = await httpJson(relay.httpBase, 'GET', '/health');
    report.expect(relayHealth.status === 200 && relayHealth.json?.ok === true, 'relay /health 200', JSON.stringify(relayHealth.json));

    gateway = await startGateway({
      runDir,
      relayUrl: relay.wsBase,
      relaySecret: relay.relaySecret,
      workspace,
    });
    console.log(`gateway: pid=${gateway.proc.pid} port=${gateway.port} base=${gateway.httpBase}`);

    const gwHealth = await httpJson(gateway.httpBase, 'GET', '/api/v1/health');
    report.expect(gwHealth.status === 200, 'gateway 直连 /api/v1/health 200', `apiVersion=${gwHealth.json?.apiVersion}`);

    // relay.enabled=true 时网关在 listen 后自动连中继；这里等它连上（并打印状态）
    const statusAfterBoot = await waitFor(async () => {
      const res = await httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status');
      return res.json?.connected === true ? res.json : null;
    }, { timeoutMs: 20_000, what: '网关自动连上中继' }).catch(async (err) => {
      const res = await httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status');
      report.fail('网关自动连上中继（relay.enabled 自动 connect）', `${err.message}；status=${JSON.stringify(res.json)}`);
      return null;
    });
    if (statusAfterBoot) {
      report.ok('网关自动连上中继（relay.enabled 自动 connect）', `homeId=${statusAfterBoot.homeId} reconnects=${statusAfterBoot.reconnects}`);
    }

    // 显式 connect（幂等）：验证 §4.1 端点
    const connect = await httpJson(gateway.httpBase, 'POST', '/api/v2/relay/connect', { body: {} });
    report.expect(connect.status === 200 && connect.json?.ok === true, 'POST /api/v2/relay/connect ok', JSON.stringify(connect.json?.homeId));

    const relayHealth2 = await httpJson(relay.httpBase, 'GET', '/health');
    report.expect(relayHealth2.json?.homes === 1, 'relay 视角 homes=1', JSON.stringify(relayHealth2.json));

    // 本机生成配对码 + 同步到中继（§4.1 pair/open）
    const open = await httpJson(gateway.httpBase, 'POST', '/api/v2/pair/open', { body: {} });
    report.expect(open.status === 200 && typeof open.json?.code === 'string', 'POST /api/v2/pair/open 返回配对码', `code=${open.json?.code} relay=${JSON.stringify(open.json?.relay)}`);
    report.expect(open.json?.relay?.tunnelUrl?.includes('/api/v2/tunnel/device'), 'pair/open 带回 device 隧道地址', String(open.json?.relay?.tunnelUrl));

    // 手机侧：中继的 pair/claim 转发到网关
    const deviceId = '8f3c1a2b-1111-4222-8333-444455556666';
    const claim = await httpJson(relay.httpBase, 'POST', '/api/v2/pair/claim', {
      body: { code: open.json.code, deviceName: 'Interop Phone', deviceId },
    });
    report.expect(claim.status === 200, 'relay /api/v2/pair/claim 200（中继→网关转发）', `status=${claim.status} body=${claim.text.slice(0, 200)}`);
    const deviceToken = claim.json?.relay?.deviceToken ?? null;
    report.expect(typeof deviceToken === 'string' && deviceToken.startsWith('dshr_'), 'claim 返回 relay.deviceToken（网关生成）', `token=${deviceToken ? `${deviceToken.slice(0, 4)}****` : '(缺)'}`);
    report.expect(typeof claim.json?.relay?.homeId === 'string', 'claim 返回 relay.homeId（中继补）', String(claim.json?.relay?.homeId));
    report.expect(
      claim.json?.relay?.tunnelUrl === `${relay.wsBase}/api/v2/tunnel/device`,
      'claim 返回 relay.tunnelUrl（中继补）',
      `${claim.json?.relay?.tunnelUrl} vs ${relay.wsBase}/api/v2/tunnel/device`,
    );

    // 手机：连 device 隧道
    const phone = await openPhone({ wsBase: relay.wsBase, deviceToken });
    report.expect(phone.ready?.homeId === claim.json.relay.homeId, 'device 隧道 ready.homeId 与 claim 一致', JSON.stringify(phone.ready));
    report.expect(phone.ready?.homeOnline === true, 'device 隧道 ready.homeOnline=true（PC 在线）', String(phone.ready?.homeOnline));

    // 判据 1：隧道里的 health 与直连 health 逐字段一致
    const direct = await httpJson(gateway.httpBase, 'GET', '/api/v1/health');
    const viaTunnel = await phone.call('GET', '/api/v1/health', { token: deviceToken });
    report.expect(viaTunnel.status === 200, '经隧道 GET /api/v1/health 200', `status=${viaTunnel.status}`);
    compareHealth(report, 'v1', viaTunnel.json, direct.json);

    const directV2 = await httpJson(gateway.httpBase, 'GET', '/api/v2/health');
    const viaTunnelV2 = await phone.call('GET', '/api/v2/health', { token: deviceToken });
    report.expect(viaTunnelV2.status === 200, '经隧道 GET /api/v2/health 200', `status=${viaTunnelV2.status}`);
    compareHealth(report, 'v2', viaTunnelV2.json, directV2.json);

    // 判据 2：真实业务面（会话镜像 + 工作区）
    const sessions = await phone.call('GET', '/api/v2/sessions?limit=5', { token: deviceToken });
    report.expect(sessions.status === 200 && Array.isArray(sessions.json?.sessions), '经隧道 GET /api/v2/sessions 200', `sessions=${sessions.json?.sessions?.length}`);
    const files = await phone.call('GET', `/api/v2/workspaces/files?path=${encodeURIComponent(workspace)}`, { token: deviceToken });
    report.expect(files.status === 200 && Array.isArray(files.json?.entries), '经隧道 GET /api/v2/workspaces/files 200', `entries=${files.json?.entries?.length}`);

    // 鉴权必须仍然生效：无令牌 → 401
    const noAuth = await phone.call('GET', '/api/v2/sessions');
    report.expect(noAuth.status === 401, '经隧道无令牌访问 → 401（隧道没有绕过鉴权）', `status=${noAuth.status} ${noAuth.text.slice(0, 120)}`);

    // 后续用例（经隧道配对 / 真实 SDK 任务）会更换 device 隧道：新令牌的新连接会替换同 deviceId 的旧连接
    let activePhone = phone;
    let activeToken = deviceToken;

    // 判据 3：**经隧道配对**（lead 裁定）—— v1/v2 的 pair/claim 经隧道转发时中继必须注入 relay 块，
    // 且注入后拿到的令牌必须真能建立新的 device 隧道（老 App 全靠这条）
    //
    // 注意链路是**串联**的：新令牌建立的新隧道会替换同 deviceId 的旧连接（§2.3 语义），
    // 因此每一步都要用"上一步新开的隧道"继续，不能回头用最初那条（那会被合法地 revoked）。
    {
      const openV1 = await httpJson(gateway.httpBase, 'POST', '/api/v1/pair/open', { body: {} });
      report.expect(openV1.status === 200 && typeof openV1.json?.code === 'string', 'v1 pair/open 生成配对码', `code=${openV1.json?.code}`);
      const viaV1 = await activePhone.call('POST', '/api/v1/pair/claim', {
        token: activeToken,
        body: { code: openV1.json.code, deviceName: 'Legacy Phone', deviceId },
      });
      report.expect(viaV1.status === 200, '经隧道 v1 pair/claim → 200', `status=${viaV1.status} ${viaV1.text.slice(0, 160)}`);
      report.expect(Boolean(viaV1.json?.relay), '经隧道 v1 pair/claim 响应带 relay 块（中继注入）', JSON.stringify(viaV1.json?.relay ?? null));
      report.expect(viaV1.json?.relay?.apiVersion === 2, 'relay.apiVersion=2（能力探测判据）', String(viaV1.json?.relay?.apiVersion));
      report.expect(viaV1.json?.relay?.tunnelUrl === `${relay.wsBase}/api/v2/tunnel/device`, 'relay.tunnelUrl 可用', String(viaV1.json?.relay?.tunnelUrl));
      const legacy = await openPhone({ wsBase: relay.wsBase, deviceToken: viaV1.json.relay.deviceToken });
      report.expect(legacy.ready?.homeId === claim.json.relay.homeId, 'v1 经隧道配对拿到的令牌能建立 device 隧道', JSON.stringify(legacy.ready));
      activePhone = legacy;
      activeToken = viaV1.json.relay.deviceToken;

      // v2：经隧道 v2 claim 同样必须注入（网关自己也给了 relay.deviceToken，中继补 homeId/tunnelUrl/apiVersion）
      const openV2 = await httpJson(gateway.httpBase, 'POST', '/api/v2/pair/open', { body: {} });
      const viaV2 = await activePhone.call('POST', '/api/v2/pair/claim', {
        token: activeToken,
        body: { code: openV2.json.code, deviceName: 'Modern Phone', deviceId },
      });
      report.expect(viaV2.status === 200, '经隧道 v2 pair/claim → 200', `status=${viaV2.status} ${viaV2.text.slice(0, 160)}`);
      report.expect(viaV2.json?.relay?.homeId === claim.json.relay.homeId && viaV2.json?.relay?.apiVersion === 2, '经隧道 v2 pair/claim 的 relay 块完整', JSON.stringify(viaV2.json?.relay ?? null));
      const modern = await openPhone({ wsBase: relay.wsBase, deviceToken: viaV2.json.relay.deviceToken });
      report.expect(modern.ready?.homeId === claim.json.relay.homeId, 'v2 经隧道配对拿到的令牌能建立 device 隧道', JSON.stringify(modern.ready));
      activePhone = modern;
      activeToken = viaV2.json.relay.deviceToken;
      void legacy;
    }

    // 判据 4：真实 SDK 子进程（可选，默认跳过以免每次跑都消耗额度）
    if (WITH_TASK) {
      const started = Date.now();
      const task = await activePhone.call('POST', '/api/v2/tasks', {
        token: activeToken,
        body: { prompt: '只回复两个字：收到', workspace },
        timeoutMs: 120_000,
      });
      report.expect(task.status === 202 && task.json?.accepted === true, '经隧道 POST /api/v2/tasks → 202', `status=${task.status} ${task.text.slice(0, 200)}（${Date.now() - started}ms）`);
      report.expect(task.json?.source === 'phone', '新任务 source="phone"', String(task.json?.source));
      report.expect(typeof task.json?.sessionId === 'string' && task.json.sessionId.startsWith('session-'), '返回 sessionId', String(task.json?.sessionId));
      if (task.json?.sessionId) {
        // 等这一轮真正跑完（会话可读），证明子进程真的执行了
        const transcript = await waitFor(async () => {
          const res = await activePhone.call('GET', `/api/v2/sessions/${task.json.sessionId}/transcript?tail=5`, { token: activeToken });
          return res.status === 200 && Array.isArray(res.json?.messages) && res.json.messages.length > 0 ? res : null;
        }, { timeoutMs: 180_000, intervalMs: 2000, what: '会话 transcript 可读' }).catch(() => null);
        report.expect(Boolean(transcript), '真实 SDK 子进程产出了会话记录', transcript ? `messages=${transcript.json.messages.length} 首条角色=${transcript.json.messages[0]?.role}` : '超时未见消息');
      }
    } else {
      report.skip('真实 SDK 任务（`POST /api/v2/tasks`）', '未加 --with-task；该档位不消耗模型额度，也不算通过项');
    }

    phone.close();
    return report;
  } catch (err) {
    report.fail('场景执行未抛异常', `${err?.stack ?? err}`);
    return report;
  } finally {
    // 把两侧原始输出留档，便于报告引用
    if (relay) await fs.writeFile(path.join(runDir, 'relay.stdout.txt'), relay.state.stdout, 'utf8').catch(() => {});
    if (relay) await fs.writeFile(path.join(runDir, 'relay.stderr.txt'), relay.state.stderr, 'utf8').catch(() => {});
    if (gateway) await fs.writeFile(path.join(runDir, 'gateway.stdout.txt'), gateway.state.stdout, 'utf8').catch(() => {});
    if (gateway) await fs.writeFile(path.join(runDir, 'gateway.stderr.txt'), gateway.state.stderr, 'utf8').catch(() => {});
    await stopAll(gateway, relay);
    await sleep(200);
  }
}

const modes = MODE === 'both' ? ['off', 'selfsigned'] : [MODE];
const reports = [];
for (const mode of modes) reports.push(await runScenario(mode));

let allPass = true;
for (const report of reports) allPass = report.summary() && allPass;
console.log(`\n总体：${allPass ? 'PASS' : 'FAIL'}（场景 ${modes.join(' + ')}）`);
process.exit(allPass ? 0 : 1);
