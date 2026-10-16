/**
 * 边界与恶意输入（公网暴露面）+ 控制面合规（**手动互操作脚本**，不属于自包含单测）。
 *
 * ⚠️ 本脚本会真起 relay/gateway 子进程（真实 TCP/WS），并会**强杀**网关进程做掉线验证；
 *    串行执行，占用固定端口段 19500；自包含单测请用 `tools/dsh-relay/test/*.test.mjs`。
 *
 * 覆盖（每条都打印真实结果）：
 *   - 伪造/缺 homeToken、deviceToken → 401，且**不透传**到 home（网关 relay.stats.requests 不变）
 *   - 令牌轮换后旧连接被吊销（notice{revoked} + close 1008）与旧令牌 401
 *   - 两台真实网关 A/B：各自的令牌只能到各自（serverName 断言）
 *   - home 经隧道访问中继对外端点 → 404（用**网关自己的 RelayClient** 打，含三条合法控制面路由）
 *   - 单条 chunk >256 KiB / 单流缓冲 >1 MiB → abort{reason:'overflow'}
 *   - 真实网关大响应（300 KB）：分片 ≤256 KiB 且与**直连响应逐字节一致**
 *   - 并发超限 → 429（中继侧上限 / 网关侧上限两种）
 *   - 网关进程**强杀**（SIGKILL）→ device 收到 notice{home_offline}、后续请求 503
 *   - relay 重启（同端口、复用 homes.json）→ 网关**无人工干预**自动重连（reconnects 递增）且业务恢复
 *
 * 用法（在**仓库根目录**执行）：
 *   node scripts/tests/interop-boundary.mjs [off|selfsigned]
 *   证据目录：默认 .runtime/interop/run/boundary-<mode>-<时间戳>/（脚本结尾会打印）
 *
 * 退出码：0=全部通过；1=有失败断言；2=脚本无法运行（参数/环境）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFakeGateway, declarePairWindow } from '../../tools/dsh-relay/test/helpers.mjs';
import { openTunnel } from '../../tools/dsh-relay/test/ws-client.mjs';
import {
  REPO,
  createReport,
  httpJson,
  killOwned,
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
  name: 'interop-boundary',
  usage: 'node scripts/tests/interop-boundary.mjs [off|selfsigned]',
  ports: 'relay 19500',
  extra: '边界与恶意输入；会强杀网关进程验证掉线，并重启 relay 验证自愈',
});

const MODE = requireEnum(process.argv[2] ?? 'off', ['off', 'selfsigned'], {
  argName: 'mode',
  usage: 'node scripts/tests/interop-boundary.mjs [off|selfsigned]（注意：没有 both，两种模式要分别跑）',
});
const report = createReport(`边界与恶意输入（tls.mode=${MODE}）`);

const runDir = await makeRunDir(`boundary-${MODE}`);
const workspace = path.join(runDir, 'ws');
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(path.join(workspace, 'big.txt'), `${'A'.repeat(300_000)}\n`, 'utf8'); // 300KB 大文件

let relay = null;
let gateway = null;
const relayPort = await pickPort(interopPort(19_500));
const raw = []; // 原始证据行

function note(text) {
  raw.push(text);
  console.log(text);
}

try {
  console.log(`\n########## 边界场景（tls.mode=${MODE}） ##########`);
  console.log(`运行目录：${path.relative(REPO, runDir)}`);

  relay = await startRelay({ runDir, tlsMode: MODE, relayName: '127.0.0.1', relaySecret: 'interop-secret', port: relayPort });
  gateway = await startGateway({ runDir, relayUrl: relay.wsBase, relaySecret: relay.relaySecret, workspace, serverName: 'INTEROP-PC' });
  note(`relay port=${relay.port}  gateway port=${gateway.port}`);

  const gwStatus = () => httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status');

  /** 走完整真实链路配一台设备：本机开窗口 → 中继 claim → 返回 deviceToken。 */
  async function pairFresh(deviceId, deviceName, gatewayBase = gateway.httpBase) {
    const opened = await httpJson(gatewayBase, 'POST', '/api/v2/pair/open', { body: {} });
    const claimed = await httpJson(relay.httpBase, 'POST', '/api/v2/pair/claim', { body: { code: opened.json.code, deviceName, deviceId } });
    if (claimed.status !== 200) throw new Error(`配对失败：${claimed.status} ${claimed.text}`);
    return { token: claimed.json.relay.deviceToken, homeId: claimed.json.relay.homeId, claim: claimed, code: opened.json.code };
  }

  await waitFor(async () => (await gwStatus()).json?.connected === true, { timeoutMs: 20_000, what: '网关连上中继' });
  const first = await pairFresh('8f3c1a2b-1111-4222-8333-444455556666', 'Boundary Phone');
  report.expect(typeof first.token === 'string', '前置：配对成功拿到 deviceToken', `code=${first.code}`);
  const phone = await openPhone({ wsBase: relay.wsBase, deviceToken: first.token });
  report.expect(phone.ready?.homeOnline === true, '前置：device 隧道在线且 PC 在线', JSON.stringify(phone.ready));

  // ---------------------------------------------------------------- 1) 伪造/缺令牌 → 401 且不透传
  {
    const before = (await gwStatus()).json.stats.requests;
    const attempts = [];
    await assert.rejects(
      () => openTunnel(`${relay.wsBase}/api/v2/tunnel/home`, { role: 'home', token: 'forged-home-token-aaaa', rejectUnauthorized: false }),
      (err) => {
        attempts.push(['伪造 homeToken', err.status, err.body]);
        return true;
      },
    );
    await assert.rejects(
      () => openTunnel(`${relay.wsBase}/api/v2/tunnel/device`, { role: 'device', token: 'dshr_forged_device_token_zzzz', rejectUnauthorized: false }),
      (err) => {
        attempts.push(['伪造 deviceToken', err.status, err.body]);
        return true;
      },
    );
    await assert.rejects(() => openTunnel(`${relay.wsBase}/api/v2/tunnel/home`, { role: 'home', rejectUnauthorized: false }), (err) => {
      attempts.push(['缺 Authorization', err.status, err.body]);
      return true;
    });
    for (const [what, status, body] of attempts) {
      report.expect(status === 401, `${what} → 401`, `status=${status} body=${body}`);
      report.expect(!String(body).includes('forged') && !String(body).includes('dshr_'), `${what} 响应不回显令牌`, String(body).slice(0, 120));
    }
    note(`伪造令牌尝试：${attempts.map(([w, s]) => `${w}=${s}`).join('，')}`);
    const after = (await gwStatus()).json.stats.requests;
    report.expect(after === before, '伪造令牌**不透传**到 home（网关 relay.stats.requests 不变）', `before=${before} after=${after}`);
  }

  // ---------------------------------------------------------------- 2) 过期令牌（轮换后旧令牌失效）
  {
    // 配对码在**网关侧是一次性的**（v1 语义）：轮换必须重新开窗口拿新码
    const rotated = await pairFresh('8f3c1a2b-1111-4222-8333-444455556666', 'Boundary Phone');
    report.expect(rotated.token !== first.token, '同 deviceId 再次 claim 轮换令牌', `tokenChanged=${rotated.token !== first.token}`);
    report.expect(rotated.homeId === first.homeId, '轮换后 homeId 不变（同一台 PC）', rotated.homeId);
    const revoked = await phone.tunnel.waitFrame((f) => f.t === 'notice', { timeoutMs: 5000, what: 'revoked 通知' }).catch(() => null);
    report.expect(revoked?.kind === 'revoked', '旧 device 连接收到 notice{kind:revoked}', JSON.stringify(revoked));
    const closed = await phone.tunnel.waitClose(5000).catch(() => null);
    report.expect(Boolean(closed), '轮换后旧 device 连接被中继断开', JSON.stringify(closed));
    await assert.rejects(
      () => openTunnel(`${relay.wsBase}/api/v2/tunnel/device`, { role: 'device', token: first.token, rejectUnauthorized: false }),
      (err) => {
        report.expect(err.status === 401, '旧（已轮换）deviceToken → 401', `status=${err.status}`);
        return true;
      },
    );
    const working = await openPhone({ wsBase: relay.wsBase, deviceToken: rotated.token });
    report.expect(working.ready?.homeOnline === true, '新令牌可正常建立隧道', JSON.stringify(working.ready));
    working.close();
  }

  // 后面的用例需要一条可用的 device 隧道
  const freshPair = await pairFresh('aaaabbbb-1111-4222-8333-444455556666', 'Boundary Phone 2');
  const phone2 = await openPhone({ wsBase: relay.wsBase, deviceToken: freshPair.token });
  report.expect(phone2.ready?.homeOnline === true, '前置2：新 device 隧道在线', JSON.stringify(phone2.ready));

  // ---------------------------------------------------------------- 3) A 的令牌访问不到 B（两台真实网关）
  {
    const runDirB = path.join(runDir, 'gwB');
    const workspaceB = path.join(runDirB, 'ws');
    await fs.mkdir(workspaceB, { recursive: true });
    const gatewayB = await startGateway({
      runDir: runDirB,
      relayUrl: relay.wsBase,
      relaySecret: relay.relaySecret,
      workspace: workspaceB,
      serverName: 'INTEROP-PC-B',
      homeName: 'INTEROP-PC-B',
    });
    await waitFor(async () => (await httpJson(gatewayB.httpBase, 'GET', '/api/v2/relay/status')).json?.connected === true, { timeoutMs: 20_000, what: 'B 网关连上中继' });
    const freshB = await pairFresh('ccccdddd-1111-4222-8333-444455556666', 'Phone B', gatewayB.httpBase);
    const phoneB = await openPhone({ wsBase: relay.wsBase, deviceToken: freshB.token });
    report.expect(phoneB.ready?.homeId !== phone2.ready?.homeId, 'A/B 两台 PC 的 homeId 不同', `A=${phone2.ready.homeId} B=${phoneB.ready.homeId}`);

    const viaA = await phone2.call('GET', '/api/v1/health', { token: freshPair.token });
    const viaB = await phoneB.call('GET', '/api/v1/health', { token: freshB.token });
    report.expect(viaA.json?.serverName === 'INTEROP-PC', 'A 的令牌 → 只到 A（serverName=INTEROP-PC）', `serverName=${viaA.json?.serverName}`);
    report.expect(viaB.json?.serverName === 'INTEROP-PC-B', 'B 的令牌 → 只到 B（serverName=INTEROP-PC-B）', `serverName=${viaB.json?.serverName}`);
    // B 的令牌去访问 A 的工作区文件路径：B 的白名单里没有它 → 必须被拒（结构上也没有跨 home 的路径）
    const cross = await phoneB.call('GET', `/api/v2/workspaces/file?path=${encodeURIComponent(path.join(workspace, 'big.txt'))}`, { token: freshB.token });
    report.expect([400, 403, 404].includes(cross.status), 'B 访问 A 的工作区路径被拒', `status=${cross.status} ${cross.text.slice(0, 140)}`);
    phoneB.close();
    await gatewayB.stop();
  }

  // ---------------------------------------------------------------- 4) home 经隧道访问中继对外端点 → 404（用**网关自己的** RelayClient）
  {
    const { RelayClient } = await import('../../tools/dsh-remote/lib/relay-client.mjs');
    const probeHome = path.join(runDir, 'probe-home');
    await fs.mkdir(probeHome, { recursive: true });
    const probeCfg = {
      relay: {
        enabled: true,
        url: relay.wsBase,
        relaySecret: relay.relaySecret,
        homeName: 'CONTROL-PROBE',
        reconnect: { minMs: 300, maxMs: 1000, factor: 2, jitter: 0 },
        tls: { rejectUnauthorized: false },
      },
      home: probeHome,
      gatewayVersion: '2.0.0',
    };
    const client = new RelayClient({ config: probeCfg });
    const connected = await client.connect();
    report.expect(
      connected.ok === true,
      '网关的 RelayClient 可建立 home 隧道（用于控制面探测）',
      // 形状注意（§4.1，2026-10-09 统一为扁平）：connect 现为 `{ok, ...status, homeId, relayName}`，
      // 状态字段在**顶层**。旧写法 `connected.status?.homeId` 在扁平后永远打印 undefined ——
      // 判定不受影响，但失败时这条 detail 就帮不上忙了（正是"形状不一致"最坑人的地方）。
      `ok=${connected.ok} homeId=${connected.homeId} 已连接=${connected.connected}`,
    );

    const legal = await client.request('POST', '/api/v2/pair/window', { code: '135790' });
    report.expect(legal.ok && legal.status === 200, '合法控制面 POST /api/v2/pair/window → 200', `status=${legal.status} body=${JSON.stringify(legal.json)}`);
    const legalGet = await client.request('GET', '/api/v2/pair/window', null);
    report.expect(legalGet.ok && legalGet.status === 200 && typeof legalGet.json?.open === 'boolean', '合法控制面 GET /api/v2/pair/window → 200 {open,expiresAt}', JSON.stringify(legalGet.json));
    const legalClose = await client.request('POST', '/api/v2/pair/close', {});
    report.expect(legalClose.status === 200, '合法控制面 POST /api/v2/pair/close → 200', JSON.stringify(legalClose.json));

    const illegalCases = [
      ['GET', '/health'],
      ['POST', '/api/v2/homes'],
      ['POST', '/api/v2/pair/claim'],
      ['GET', '/api/v2/relay/status'],
      ['POST', '/api/v2/tasks'],
    ];
    for (const [method, p] of illegalCases) {
      const res = await client.request(method, p, method === 'POST' ? {} : null);
      report.expect(res.status === 404, `home 借隧道访问 ${method} ${p} → 404`, `status=${res.status} body=${JSON.stringify(res.json)}`);
      note(`  控制面拒绝：${method} ${p} → ${res.status} ${JSON.stringify(res.json)}`);
    }
    await client.shutdown();
  }

  // ---------------------------------------------------------------- 5) 超大 chunk / 单流缓冲溢出（替身 home 故意违规）
  {
    const registered = await httpJson(relay.httpBase, 'POST', '/api/v2/homes', { body: { relaySecret: relay.relaySecret, homeName: 'BAD-HOME' } });
    const bad = await openTunnel(`${relay.wsBase}/api/v2/tunnel/home`, { role: 'home', token: registered.json.homeToken, rejectUnauthorized: false });
    await bad.handshake();
    const gate = createFakeGateway(bad, {
      'POST /api/v2/pair/claim': (frame, api) => {
        const badToken = 'dshr_bad_home_device_token_0001';
        api.respond(frame.id, 200, { token: badToken, tokenId: 'tok_bad', serverName: 'BAD-HOME', expiresAt: null, relay: { deviceToken: badToken } });
      },
      'GET /api/v2/oversize': (frame, api) => {
        api.res(frame.id, 200, { 'content-type': 'application/octet-stream' });
        api.chunk(frame.id, Buffer.alloc(300 * 1024, 0x41)); // 300 KiB > 256 KiB
        api.end(frame.id);
      },
      'GET /api/v2/flood': (frame, api) => {
        api.res(frame.id, 200, { 'content-type': 'application/octet-stream' });
        for (let i = 0; i < 40; i++) api.chunk(frame.id, Buffer.alloc(32 * 1024, 0x42));
        api.end(frame.id);
      },
    });
    await declarePairWindow(bad, { code: '246810' });
    const claimBad = await httpJson(relay.httpBase, 'POST', '/api/v2/pair/claim', { body: { code: '246810', deviceName: 'P', deviceId: 'eeeeffff-1111-4222-8333-444455556666' } });
    const badPhone = await openPhone({ wsBase: relay.wsBase, deviceToken: claimBad.json.relay.deviceToken });

    const oversize = await badPhone.call('GET', '/api/v2/oversize');
    report.expect(oversize.aborted === 'overflow', '单条 chunk 300 KiB > 256 KiB → abort{reason:overflow}', `aborted=${oversize.aborted} status=${oversize.status}`);
    const cancelSeen = await bad.waitFrame((f) => f.t === 'cancel', { timeoutMs: 3000, what: '中继向违规 home 发 cancel' }).catch(() => null);
    report.expect(Boolean(cancelSeen), '违规后中继向 home 发 cancel（停止上游工作）', JSON.stringify(cancelSeen));

    badPhone.tunnel.pause(); // device 不读 → 中继写缓冲堆积
    badPhone.tunnel.send({ t: 'req', id: 999, method: 'GET', path: '/api/v2/flood', headers: {} });
    const overflowed = await waitFor(
      () => (badPhone.tunnel.allFrames.some((f) => f.t === 'abort' && f.reason === 'overflow') ? true : null),
      { timeoutMs: 8000, what: '单流缓冲溢出 abort' },
    ).catch(() => null);
    badPhone.tunnel.resume();
    report.expect(Boolean(overflowed), '单流缓冲 > 1 MiB → abort{reason:overflow}', JSON.stringify(badPhone.tunnel.allFrames.filter((f) => f.t === 'abort')));
    report.expect(gate.calls.length >= 2, '替身 home 确实收到这两条请求（是"被强制终止"而非"转发失败"）', `calls=${gate.calls.length}`);
    badPhone.close();
    bad.destroy();
  }

  // ---------------------------------------------------------------- 5b) 真实网关大响应：分片 ≤256 KiB 且与直连响应逐字节一致
  {
    const filePath = path.join(workspace, 'big.txt');
    const onDisk = await fs.readFile(filePath);
    const endpoint = `/api/v2/workspaces/file?path=${encodeURIComponent(filePath)}`;
    const direct = await httpJson(gateway.httpBase, 'GET', endpoint, { token: freshPair.token });
    const tunnel = await openTunnel(`${relay.wsBase}/api/v2/tunnel/device`, { role: 'device', token: freshPair.token, rejectUnauthorized: false });
    await tunnel.handshake();
    tunnel.request({ id: 77, method: 'GET', path: endpoint, headers: { authorization: `Bearer ${freshPair.token}` } });
    let status = null;
    const chunks = [];
    let aborted = null;
    for (;;) {
      const frame = await tunnel.waitFrame((f) => f.id === 77 && ['res', 'chunk', 'end', 'abort'].includes(f.t), { timeoutMs: 15_000, what: '大文件响应' });
      tunnel.consume(frame);
      if (frame.t === 'res') status = frame.status;
      else if (frame.t === 'chunk') chunks.push(Buffer.from(frame.dataB64, 'base64'));
      else if (frame.t === 'end') break;
      else if (frame.t === 'abort') {
        aborted = frame.reason;
        break;
      }
    }
    const body = Buffer.concat(chunks);
    const maxChunk = chunks.reduce((max, buf) => Math.max(max, buf.length), 0);
    report.expect(status === 200 && !aborted, '真实网关 300KB 响应经隧道完整送达', `status=${status} aborted=${aborted}`);
    report.expect(maxChunk > 0 && maxChunk <= 262_144, '真实网关的每条 chunk ≤ 256 KiB（契约 §3.2）', `maxChunk=${maxChunk} chunks=${chunks.length}`);
    // 真正的互操作断言：**同一条请求**，直连与经隧道必须逐字节一致
    const directBytes = Buffer.from(direct.text, 'utf8');
    report.expect(body.equals(directBytes), '经隧道响应与直连响应逐字节一致', `tunnel=${body.length} direct=${directBytes.length}`);
    const parsed = JSON.parse(body.toString('utf8'));
    const contentBytes = typeof parsed.content === 'string' ? Buffer.from(parsed.content, parsed.encoding === 'base64' ? 'base64' : 'utf8') : null;
    report.expect(contentBytes ? contentBytes.equals(onDisk) : parsed.size === onDisk.length, '响应体内的文件内容与磁盘文件一致', `keys=${Object.keys(parsed).join(',')} size=${parsed.size} encoding=${parsed.encoding}`);
    tunnel.destroy();
  }

  // ---------------------------------------------------------------- 6) 单连接并发上限 → 429 too_many_streams
  {
    // 用真实网关的 SSE 长流占满槽位；中继上限临时设 3（默认 64，规则同一套）
    await stopAll(gateway, relay);
    relay = await startRelay({ runDir, tlsMode: MODE, relayName: '127.0.0.1', relaySecret: 'interop-secret', port: relayPort, limits: { maxStreamsPerConnection: 3 } });
    gateway = await startGateway({ runDir, relayUrl: relay.wsBase, relaySecret: relay.relaySecret, workspace, serverName: 'INTEROP-PC' });
    await waitFor(async () => (await gwStatus()).json?.connected === true, { timeoutMs: 20_000, what: '网关重新连上中继' });
    const c = await pairFresh('11112222-1111-4222-8333-444455556666', 'Phone C');
    const phoneC = await openPhone({ wsBase: relay.wsBase, deviceToken: c.token });

    for (const id of [1, 2, 3]) {
      phoneC.tunnel.send({
        t: 'req',
        id,
        method: 'GET',
        path: '/api/v2/sessions/stream',
        headers: { authorization: `Bearer ${c.token}`, accept: 'text/event-stream' },
      });
    }
    const held = await phoneC.tunnel.waitFrame((f) => f.t === 'res' && f.id === 3, { timeoutMs: 10_000, what: '第 3 条 SSE 响应头' });
    report.expect(held.status === 200, '3 条 SSE 已占用 3 个流（真实网关）', `status=${held.status}`);
    await sleep(300);
    const over = await phoneC.call('GET', '/api/v1/health', { token: c.token, id: 99 });
    report.expect(over.status === 429, '第 4 条并发请求 → 429 too_many_streams', `status=${over.status} body=${over.text.slice(0, 160)}`);
    report.expect(over.json?.error?.code === 'too_many_streams', '错误体 code=too_many_streams', JSON.stringify(over.json));
    phoneC.tunnel.send({ t: 'cancel', id: 1 });
    await sleep(300);
    const again = await phoneC.call('GET', '/api/v1/health', { token: c.token, id: 100 });
    report.expect(again.status === 200, 'cancel 释放槽位后可继续请求', `status=${again.status}`);
    phoneC.close();
  }

  // ---------------------------------------------------------------- 6b) 网关侧并发上限 → abort reason 保真
  // 中继侧修过的坑：网关用 §3.3 的合法错误码发 abort{reason:'too_many_streams'}，中继第一版归一成 'internal'，
  // 手机就看不到"并发超限"。这里让**网关**先到上限（relay 放宽到 100、网关 maxStreams=3）来端到端验证保真。
  {
    await stopAll(gateway, relay);
    relay = await startRelay({ runDir, tlsMode: MODE, relayName: '127.0.0.1', relaySecret: 'interop-secret', port: relayPort, limits: { maxStreamsPerConnection: 100 } });
    gateway = await startGateway({ runDir, relayUrl: relay.wsBase, relaySecret: relay.relaySecret, workspace, serverName: 'INTEROP-PC', relayExtra: { maxStreams: 3 } });
    await waitFor(async () => (await gwStatus()).json?.connected === true, { timeoutMs: 20_000, what: '网关重新连上中继' });
    const g = await pairFresh('77778888-1111-4222-8333-444455556666', 'Phone G');
    const phoneG = await openPhone({ wsBase: relay.wsBase, deviceToken: g.token });
    for (const id of [1, 2, 3]) {
      phoneG.tunnel.send({
        t: 'req',
        id,
        method: 'GET',
        path: '/api/v2/sessions/stream',
        headers: { authorization: `Bearer ${g.token}`, accept: 'text/event-stream' },
      });
    }
    await phoneG.tunnel.waitFrame((f) => f.t === 'res' && f.id === 3, { timeoutMs: 10_000, what: '前 3 条 SSE 响应头' });
    await sleep(300);
    phoneG.tunnel.send({ t: 'req', id: 4, method: 'GET', path: '/api/v1/health', headers: { authorization: `Bearer ${g.token}` } });
    // 按 lead 裁定 1：**业务失败原因走 HTTP 状态码 + 响应体**，abort.reason 只保留六值枚举。
    // 因此这里接受两种合法表现，但都不允许"成功"，也不允许出现越界 reason。
    const outcome = await phoneG.tunnel.collect(4, { timeoutMs: 10_000 }).catch((err) => ({ status: 'timeout', aborted: 'timeout', text: err.message }));
    let outcomeCode = null;
    try {
      outcomeCode = JSON.parse(outcome.text ?? '').error?.code ?? null;
    } catch {
      outcomeCode = null;
    }
    const viaHttp = outcome.status === 429 && (outcomeCode === 'too_many_streams' || outcomeCode === 'rate_limited');
    const viaAbort = outcome.aborted === 'internal';
    report.expect(
      viaHttp || viaAbort,
      '网关侧并发上限：按契约语义失败（HTTP 429 + error 体，或 abort 归一为 internal）',
      `status=${outcome.status} aborted=${outcome.aborted} code=${outcomeCode}`,
    );
    note(`  网关侧上限的实际表现：status=${outcome.status} aborted=${outcome.aborted} code=${outcomeCode}`);
    // 观察项（不判失败）：§3.3 里"并发超限"的码是 too_many_streams，网关现在回的是 rate_limited；
    // 两者都是 429 家族，手机可处理，但码名更精确会更利于 UI 文案。
    if (outcomeCode === 'rate_limited') note('  注：网关用 rate_limited 表达"并发超限"，§3.3 里更贴切的码是 too_many_streams（观察项，非阻塞）');
    report.expect(
      outcome.aborted === null || outcome.aborted === 'internal',
      'abort.reason 严格六值（不出现 too_many_streams 等越界值）',
      String(outcome.aborted),
    );
    phoneG.close();
  }

  // ---------------------------------------------------------------- 7) 网关强杀 → notice{home_offline} + 503
  let phoneD = null;
  let tokenD = null;
  {
    const d = await pairFresh('33334444-1111-4222-8333-444455556666', 'Phone D');
    tokenD = d.token;
    phoneD = await openPhone({ wsBase: relay.wsBase, deviceToken: d.token });
    report.expect(phoneD.ready?.homeOnline === true, '前置：PC 在线', String(phoneD.ready?.homeOnline));

    // 强杀（判据 D 要的就是"没来得及优雅退出"）：仍走受保护清理 —— taskkill /T /F 同样是 TerminateProcess，
    // 不会给进程任何收尾机会，但只作用于**本脚本拉起的那棵子树**，不会误伤队友的进程。
    await killOwned(gateway.proc.pid, { why: '判据 D：强杀网关模拟崩溃（taskkill /T /F = TerminateProcess，无收尾机会）' });
    await waitFor(() => gateway.state.exited, { timeoutMs: 8000, what: '网关进程退出' });
    note(`  已强杀网关 pid=${gateway.proc.pid}，exitCode=${gateway.state.code}`);
    const notice = await phoneD.tunnel.waitFrame((f) => f.t === 'notice' && f.kind === 'home_offline', { timeoutMs: 8000, what: 'home_offline 通知' });
    report.expect(notice.kind === 'home_offline', 'device 收到 notice{kind:home_offline}', JSON.stringify(notice));
    const offline = await phoneD.call('GET', '/api/v1/health', { token: tokenD, id: 50 });
    report.expect(offline.status === 503 && offline.json?.error?.code === 'home_offline', '掉线后请求 → 503 home_offline', `status=${offline.status} body=${offline.text.slice(0, 160)}`);
  }

  // ---------------------------------------------------------------- 8) relay 重启 → 网关自动重连（reconnects 递增）
  {
    gateway = await startGateway({ runDir, relayUrl: relay.wsBase, relaySecret: relay.relaySecret, workspace, serverName: 'INTEROP-PC' });
    await waitFor(async () => (await gwStatus()).json?.connected === true, { timeoutMs: 20_000, what: '网关首次连上中继' });
    const before = (await gwStatus()).json;
    note(`  relay 重启前：connected=${before.connected} reconnects=${before.reconnects} homeId=${before.homeId}`);

    await relay.stop();
    note('  已停止 relay 进程');
    await waitFor(async () => {
      const s = (await gwStatus().catch(() => ({ json: null }))).json;
      return s && s.connected === false ? s : null;
    }, { timeoutMs: 15_000, what: '网关感知到断开' }).catch(() => {});
    const during = (await gwStatus()).json;
    report.expect(during.connected === false, 'relay 停止后网关标记 connected=false', `lastError=${during.lastError}`);

    relay = await startRelay({ runDir, tlsMode: MODE, relayName: '127.0.0.1', relaySecret: 'interop-secret', port: relayPort, limits: { maxStreamsPerConnection: 3 } });
    note(`  已在同一端口 ${relay.port} 重启 relay（复用同一 homes.json）`);
    const reconnected = await waitFor(async () => {
      const s = (await gwStatus().catch(() => ({ json: null }))).json;
      return s && s.connected === true ? s : null;
    }, { timeoutMs: 30_000, what: '网关自动重连' }).catch(() => null);
    report.expect(Boolean(reconnected), '网关**无人工干预**自动重连成功', reconnected ? `homeId=${reconnected.homeId}` : '超时');
    if (reconnected) {
      report.expect(reconnected.reconnects > before.reconnects, 'reconnects 递增', `${before.reconnects} → ${reconnected.reconnects}`);
      report.expect(reconnected.homeId === before.homeId, '重连后 homeId 不变（凭据复用，未重复注册）', `${before.homeId} → ${reconnected.homeId}`);
      const e = await pairFresh('55556666-1111-4222-8333-444455556666', 'Phone E');
      const phoneE = await openPhone({ wsBase: relay.wsBase, deviceToken: e.token });
      const ok = await phoneE.call('GET', '/api/v1/health', { token: e.token });
      report.expect(ok.status === 200, '重连后经隧道业务恢复', `status=${ok.status} serverName=${ok.json?.serverName}`);
      phoneE.close();
    }
  }

  phone.close();
  phone2.close();
  phoneD?.close();
  await fs.writeFile(path.join(runDir, 'boundary-evidence.txt'), raw.join('\n'), 'utf8').catch(() => {});
} catch (err) {
  report.fail('边界场景执行未抛异常', `${err?.stack ?? err}`);
} finally {
  if (relay) await fs.writeFile(path.join(runDir, 'relay.stdout.txt'), relay.state.stdout, 'utf8').catch(() => {});
  if (gateway) await fs.writeFile(path.join(runDir, 'gateway.stdout.txt'), gateway.state.stdout, 'utf8').catch(() => {});
  await stopAll(gateway, relay);
}

const pass = report.summary();
console.log(`证据文件：${path.relative(REPO, path.join(runDir, 'boundary-evidence.txt'))}`);
process.exit(pass ? 0 : 1);
