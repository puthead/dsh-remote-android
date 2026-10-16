/**
 * 清理所有权自检（**手动互操作脚本**，不属于自包含单测）：证明"只杀自己拉起的进程"。
 *
 * ⚠️ 会真起 relay/gateway 子进程与一个**测试替身**进程（都不是外部的）；串行执行，占用端口段 19200。
 *
 * 背景（lead 裁定必须根治）：验收脚本/队友脚本曾按**进程名或命令行关键字**清理进程，
 * 导致别人正在跑的隔离中继在 B/D 阶段被杀（`connect ECONNREFUSED`），
 * 让"正确实现的红色结论"与"被自己人杀掉的红色结论"在输出上无法区分。
 * 本套件的铁律：**只清理自己登记过的 PID**（`OWNED_PIDS`），且清理前用
 * 「创建时间晚于本次脚本启动」+「命令行含本次运行的隔离 home 路径」两道校验兜底。
 *
 * 本脚本断言：
 *   1. 对一个**不是本套件拉起**的进程调用 `killOwned()` → 打印 `SKIP kill pid=…（不属于本次运行）`，
 *      且该进程**仍然存活**（绝不误杀）；
 *   2. 本套件自己拉起的 relay：`stop()` 真能清掉，且端口释放；
 *   3. 强杀网关（判据 D 的路径）只影响它自己，relay 不受牵连；
 *   4. 结束时 `ownedPids()` 为空（无残留进程）。
 *
 * 用法（在**仓库根目录**执行）：
 *   node scripts/tests/interop-selftest-cleanup.mjs
 *   证据目录：默认 .runtime/interop/run/selftest-cleanup-<时间戳>/
 *
 * 退出码：0=全部断言通过；1=有失败断言；2=脚本无法运行（参数/环境）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  NODE,
  REPO,
  httpJson,
  interopPort,
  killOwned,
  makeRunDir,
  ownedPids,
  pickPort,
  printUsage,
  sleep,
  startGateway,
  startRelay,
  stopAll,
  waitFor,
  waitPortFree,
} from './interop-lib.mjs';

printUsage({
  name: 'interop-selftest-cleanup',
  usage: 'node scripts/tests/interop-selftest-cleanup.mjs',
  ports: 'relay 19200',
  extra: '证明清理只作用于自己拉起的 PID：外部替身进程绝不被杀',
});

const runDir = await makeRunDir('selftest-cleanup');
const workspace = path.join(runDir, 'ws');
await fs.mkdir(workspace, { recursive: true });
let pass = true;
let tally = { passed: 0, failed: 0 };
const check = (ok, name, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
  if (ok) tally.passed++;
  else {
    tally.failed++;
    pass = false;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 一个"别人的进程"：**不走 spawnCollect**，因此不在 OWNED_PIDS 里（模拟队友的 relay/网关）。 */
const bystander = spawn(NODE, ['-e', 'setTimeout(() => {}, 120000)'], { windowsHide: true, stdio: 'ignore' });
await sleep(400);

let relay = null;
let gateway = null;
try {
  check(alive(bystander.pid), '前置：外部替身进程已启动', `pid=${bystander.pid}`);

  // --- 1) 误杀防护 ---------------------------------------------------------
  console.log('\n[1] 对"别人的进程"调用 killOwned（必须 SKIP 且不杀）');
  const killed = await killOwned(bystander.pid, { why: '自检：外部替身' });
  check(killed === false, 'killOwned 返回 false（拒绝清理非本次运行的进程）', `returned=${killed}`);
  await sleep(300);
  check(alive(bystander.pid), '外部替身进程仍然存活（未被误杀）', `pid=${bystander.pid}`);

  // --- 2) 自己的 relay：stop() 真能清掉 ------------------------------------
  console.log('\n[2] 自己拉起的 relay：stop() 必须真的清掉');
  const port = await pickPort(interopPort(19_200));
  relay = await startRelay({ runDir, tlsMode: 'off', relayName: '127.0.0.1', relaySecret: 's', port });
  const relayPid = relay.proc.pid;
  check(alive(relayPid), 'relay 已启动并登记在册', `pid=${relayPid}`);
  check(
    ownedPids().some((o) => o.pid === relayPid && String(o.home).includes('selftest-cleanup')),
    'ownedPids() 里能看到它，且带着本次运行的隔离 home',
    JSON.stringify(ownedPids().find((o) => o.pid === relayPid) ?? null),
  );
  await relay.stop();
  await waitFor(() => !alive(relayPid), { timeoutMs: 5000, what: 'relay 进程消失' }).catch(() => {});
  check(!alive(relayPid), 'relay 已被清理', `pid=${relayPid}`);
  const free = await waitPortFree(port, 4000);
  check(free, 'relay 端口已释放', `port=${port}`);

  // --- 3) 强杀网关只影响它自己 --------------------------------------------
  console.log('\n[3] 强杀网关（判据 D 路径）：不得牵连 relay');
  relay = await startRelay({ runDir, tlsMode: 'off', relayName: '127.0.0.1', relaySecret: 's', port });
  gateway = await startGateway({ runDir, relayUrl: relay.wsBase, relaySecret: 's', workspace });
  await waitFor(async () => (await httpJson(gateway.httpBase, 'GET', '/api/v2/relay/status')).json?.connected === true, { timeoutMs: 20_000, what: '网关连上中继' });
  const gwPid = gateway.proc.pid;
  await killOwned(gwPid, { why: '自检：强杀网关' });
  await waitFor(() => !alive(gwPid), { timeoutMs: 5000, what: '网关进程消失' }).catch(() => {});
  check(!alive(gwPid), '网关已被强杀', `pid=${gwPid}`);
  check(alive(relay.proc.pid), 'relay 不受牵连（只杀了目标的子树）', `relay pid=${relay.proc.pid}`);
  const health = await httpJson(relay.httpBase, 'GET', '/health');
  check(health.status === 200 && health.json?.ok === true, '中继仍健康（/health 200）', `status=${health.status}`);
} finally {
  // 测试替身是本自检脚本自己的子进程，用它的句柄收尾（同样不是按名字匹配）
  try {
    bystander.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  await stopAll(gateway, relay);
  await fs.writeFile(path.join(runDir, 'relay.stderr.txt'), relay?.state?.stderr ?? '', 'utf8').catch(() => {});
  await fs.writeFile(path.join(runDir, 'gateway.stderr.txt'), gateway?.state?.stderr ?? '', 'utf8').catch(() => {});
}

// --- 4) 无残留 -------------------------------------------------------------
await sleep(500);
const leftovers = ownedPids().filter((o) => !o.gone);
check(leftovers.length === 0, '结束时本次运行的登记表已清空（无残留进程）', JSON.stringify(leftovers));

console.log(`\n总体：${pass ? 'PASS' : 'FAIL'}（断言 ${tally.passed}/${tally.passed + tally.failed} 通过）`);
console.log(`证据目录：${path.relative(REPO, runDir)}`);
console.log('退出码：0=全过；1=有失败断言；2=脚本无法运行');
process.exit(pass ? 0 : 1);
