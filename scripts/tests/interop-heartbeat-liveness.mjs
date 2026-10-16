/**
 * P0 心跳误杀专项（真实 relay 进程 × 真实 gateway 进程；**手动互操作脚本**，不属于自包含单测）。
 *
 * 背景：中继旧实现只在收到 **JSON 文本帧**时更新 `lastSeenAt`，而真实网关的活跃信号主要来自
 * **RFC 6455 协议级 ping**（`relay-client` 每 30s `ws.ping()`）；再叠加"先判 idle 后发 ping"的顺序，
 * 导致第 1 个心跳周期就把健康连接判死、且 ping 没发出去 → 不可自愈的每 30s 掉线。
 *
 * 本脚本把心跳压缩到 `intervalMs=1000 / timeoutMs=3000`（3 倍关系），跑 ≥4 个周期，断言：
 *   1. relay 日志里 **零次** 心跳超时；
 *   2. 网关 `relay/status.reconnects` **保持 0**（没有重连）；
 *   3. 隧道全程在线，且经隧道业务请求成功。
 *
 * 用法（在**仓库根目录**执行）：
 *   node scripts/tests/interop-heartbeat-liveness.mjs [cycles]      # 默认 5 个周期
 *   占用端口：relay 19600；证据目录默认 .runtime/interop/run/heartbeat-liveness-<时间戳>/
 *
 * 退出码：0=全部断言通过；1=有失败断言；2=脚本无法运行（参数/环境）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPO, httpJson, makeRunDir, openPhone, interopPort, pickPort, requirePositiveInt, printUsage, sleep, startGateway, startRelay, stopAll, waitFor } from './interop-lib.mjs';

printUsage({
  name: 'interop-heartbeat-liveness',
  usage: 'node scripts/tests/interop-heartbeat-liveness.mjs [cycles]',
  ports: 'relay 19600',
  extra: 'P0 心跳回归：压缩心跳（1000/3000ms）跑多个周期，断言零重连、零心跳超时',
});

const CYCLES = requirePositiveInt(process.argv[2], {
  argName: 'cycles',
  usage: 'node scripts/tests/interop-heartbeat-liveness.mjs [cycles]',
  min: 1,
  max: 60,
  fallback: 5,
});
const INTERVAL_MS = 1000;
const TIMEOUT_MS = INTERVAL_MS * 3;

const runDir = await makeRunDir('heartbeat-liveness');
const workspace = path.join(runDir, 'ws');
await fs.mkdir(workspace, { recursive: true });
const port = await pickPort(interopPort(19_600));
let relay = null;
let gateway = null;
let pass = true;
/** 断言计数：只统计 PASS/FAIL，**SKIP 不计入通过数**（"没测"不能算证据）。 */
const tally = { passed: 0, failed: 0, skipped: 0 };
const check = (ok, name, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
  if (ok) tally.passed++;
  else {
    tally.failed++;
    pass = false;
  }
};
const skip = (name, detail = '') => {
  tally.skipped++;
  console.log(`  SKIP  ${name}${detail ? `  —— ${detail}` : ''}`);
};

try {
  relay = await startRelay({ runDir, tlsMode: 'off', relayName: '127.0.0.1', relaySecret: 's', port, heartbeat: { intervalMs: INTERVAL_MS, timeoutMs: TIMEOUT_MS } });
  gateway = await startGateway({ runDir, relayUrl: relay.wsBase, relaySecret: 's', workspace });
  await waitFor(async () => (await httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status')).json?.connected === true, { timeoutMs: 20_000, what: '网关连上中继' });
  const homeId = (await httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status')).json.homeId;
  console.log(`relay port=${relay.port}  heartbeat=${INTERVAL_MS}/${TIMEOUT_MS}ms  homeId=${homeId}`);
  console.log(`观察 ${CYCLES} 个心跳周期（${(CYCLES * INTERVAL_MS) / 1000}s）…`);

  // 经隧道配一台手机，用来在观察期结束时验证链路仍可用
  const opened = await httpJson(gateway.httpBase, 'POST', '/api/v2/pair/open', { body: {} });
  const claimed = await httpJson(relay.httpBase, 'POST', '/api/v2/pair/claim', { body: { code: opened.json.code, deviceName: 'HB Phone', deviceId: 'ab000000-1111-4222-8333-444455556666' } });
  if (!claimed.json?.relay?.deviceToken) {
    console.log(`配对失败：pair/open=${opened.status} ${opened.text.slice(0, 200)}`);
    console.log(`          claim=${claimed.status} ${claimed.text.slice(0, 300)}`);
    console.log(`          relay/status=${JSON.stringify((await httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status')).json)}`);
    throw new Error('无法完成配对，后续断言无法进行');
  }
  const deviceToken = claimed.json.relay.deviceToken;

  const baseline = (await httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status')).json;
  await sleep(CYCLES * INTERVAL_MS + 700);

  const after = (await httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status')).json;
  const timeouts = [...String(relay.state.stderr).matchAll(/心跳超时/g)].length;
  const drops = [...String(relay.state.stderr).matchAll(/home 隧道下线/g)].length;

  check(after.connected === true, `跑满 ${CYCLES} 个心跳周期后隧道仍在线`, `connected=${after.connected}`);
  check(after.reconnects === baseline.reconnects, '网关 reconnects 未增长（零重连）', `${baseline.reconnects} → ${after.reconnects}`);
  check(after.homeId === homeId, 'homeId 未变（连接未被重建）', `${homeId} → ${after.homeId}`);
  check(timeouts === 0, 'relay 日志零次「心跳超时」', `匹配到 ${timeouts} 次`);
  check(drops === 0, 'relay 日志零次「home 隧道下线」', `匹配到 ${drops} 次`);
  // 这一条**不是断言**（心跳 tick 是 debug 级、默认不落盘，无法计数）——显式记为 SKIP，绝不计入通过数
  skip('心跳 tick 次数', 'debug 级日志默认不落盘，本脚本不做计数；如需请把 log 级别调到 debug');

  // 观察期结束后链路仍必须可用
  const phone = await openPhone({ wsBase: relay.wsBase, deviceToken });
  const health = await phone.call('GET', '/api/v1/health', { token: deviceToken });
  check(health.status === 200, '观察期结束后经隧道业务请求仍成功', `status=${health.status}`);
  check(phone.ready?.homeId === homeId, 'device 隧道 ready.homeId 与 home 一致', JSON.stringify(phone.ready));
  phone.close();
} finally {
  await fs.writeFile(path.join(runDir, 'relay.stderr.txt'), relay?.state?.stderr ?? '', 'utf8').catch(() => {});
  await fs.writeFile(path.join(runDir, 'gateway.stderr.txt'), gateway?.state?.stderr ?? '', 'utf8').catch(() => {});
  await stopAll(gateway, relay);
}
console.log(
  `\n总体：${pass ? 'PASS' : 'FAIL'}（断言 ${tally.passed}/${tally.passed + tally.failed} 通过` +
    `${tally.skipped ? `，另有 ${tally.skipped} 项 SKIP 不计入` : ''}）`,
);
console.log(`证据目录：${path.relative(REPO, runDir)}`);
console.log('退出码：0=全过；1=有失败断言；2=脚本无法运行');
process.exit(pass ? 0 : 1);
