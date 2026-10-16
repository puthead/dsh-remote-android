/**
 * P0 死锁回归专项（真实 relay 进程，真实 TCP/WS；**手动互操作脚本**，不属于自包含单测）。
 *
 * 复现"网关客户端顺序"——先升级、之后才挂 ready 监听、再发 hello：
 *   场景 A：完全不发 hello → 中继在任何帧之前静默，并在 helloTimeout 时主动关闭（1008 + error{fatal}）
 *   场景 B：按网关的顺序发 hello（监听器晚于 connect 挂载）→ ready 必须正常到达
 *
 * 为什么必须单独跑一遍真实进程：这两个场景就是真联调死锁的两半，
 * 单测能覆盖逻辑，但"真实进程 + 真实 TCP 分段"才是当初踩到竞态的地方。
 *
 * 用法（在**仓库根目录**执行）：
 *   node scripts/tests/interop-hello-handshake.mjs
 *   占用端口：relay 由系统分配（port:0）；证据目录默认 .runtime/interop/run/hello-deadlock-<时间戳>/
 *
 * 退出码：0=9 项全过；1=有失败；2=脚本无法运行。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { rawConnect, wsHandshake } from '../../tools/dsh-relay/test/ws-client.mjs';
import { REPO, httpJson, makeRunDir, printUsage, sleep, startRelay, stopAll } from './interop-lib.mjs';

printUsage({
  name: 'interop-hello-handshake',
  usage: 'node scripts/tests/interop-hello-handshake.mjs',
  ports: 'relay 由系统分配（port:0）',
  extra: 'P0 死锁回归：未收到 hello 前中继不得发任何帧，超时以 1008 关闭',
});

const runDir = await makeRunDir('hello-deadlock');
let relay = null;
let pass = true;
const check = (ok, name, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
  if (!ok) pass = false;
};

try {
  relay = await startRelay({
    runDir,
    tlsMode: 'off',
    relayName: '127.0.0.1',
    relaySecret: 's',
    limits: { helloTimeoutMs: 1200 },
  });
  const registered = await httpJson(relay.httpBase, 'POST', '/api/v2/homes', { body: { relaySecret: 's', homeName: 'HELLO-PC' } });
  const token = registered.json.homeToken;
  console.log(`relay port=${relay.port}（helloTimeoutMs=1200，心跳保持默认 30s）`);

  // ---------------- 场景 A：不发 hello
  {
    const client = await rawConnect(`${relay.wsBase}/api/v2/tunnel/home`, { headers: { Authorization: `Bearer ${token}` } });
    const t0 = Date.now();
    await sleep(400);
    check(client.frameHistory.length === 0, 'A1 未发 hello 的前 400ms：中继一个帧都没发', JSON.stringify(client.frameHistory));
    const err = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      client.on('frame', (text) => {
        const frame = JSON.parse(text);
        if (frame.t !== 'error') return;
        clearTimeout(timer);
        resolve(frame);
      });
    });
    const closed = await client.waitClose(4000).catch((e) => ({ code: 'timeout', reason: e.message }));
    const elapsed = Date.now() - t0;
    check(Boolean(err?.fatal), 'A2 超时后收到 error{fatal:true}', JSON.stringify(err));
    check(closed.code === 1008, 'A3 close code = 1008（策略关闭）', JSON.stringify(closed));
    check(elapsed >= 1000 && elapsed < 3000, 'A4 在 helloTimeout 量级关闭，而不是等 30s 心跳', `${elapsed}ms`);
    check(String(relay.state.stderr).includes('未收到 hello'), 'A5 日志明确写「未收到 hello，关闭连接」', '见 relay.stderr');
    await sleep(200);
    check(String(relay.state.stderr).includes('home 隧道下线'), 'A6 连接已被清理（日志有「home 隧道下线」）', '见 relay.stderr');
    // 注：`/health.homes` 是**注册过的 home 数**（homes.json 里的记录），不是在线连接数，故不拿它判在线态
  }

  // ---------------- 场景 B：按网关的真实顺序（监听器晚于 connect 挂载）发 hello
  {
    const { socket, rest } = await wsHandshake(`${relay.wsBase}/api/v2/tunnel/home`, { headers: { Authorization: `Bearer ${token}` } });
    // 模拟网关：此刻**还没**挂应用层监听与 ready 等待（rest 先攒着，不解析）
    await sleep(300);
    let ready = null;
    const frames = [];
    const onData = (chunk) => {
      // 极简解析：服务端帧不掩码，文本帧 opcode=0x1
      const opcode = chunk[0] & 0x0f;
      if (opcode !== 0x1) return;
      const len = chunk[1] & 0x7f;
      const payload = chunk.subarray(2, 2 + len).toString('utf8');
      frames.push(payload);
      const frame = JSON.parse(payload);
      if (frame.t === 'ready') ready = frame;
    };
    socket.on('data', onData);
    if (rest.length > 0) onData(rest); // 晚挂监听：先把攒下的字节解析掉（此刻应为空，因为中继没发过帧）
    check(rest.length === 0, 'B1 晚挂监听时 rest 为空（中继确实没抢跑）', `rest=${rest.length}B`);
    socket.write(encodeText(JSON.stringify({ t: 'hello', proto: 2, role: 'home', name: 'gateway-order-sim' })));
    for (let i = 0; i < 60 && !ready; i++) await sleep(50);
    check(Boolean(ready?.homeId), 'B2 按 hello 先行的顺序，ready 正常到达', JSON.stringify(ready));
    socket.destroy();
    await sleep(200);
    // 场景 A 的连接若没被真正清理，这里会出现"home 重复连接，替换旧连接"的警告
    check(!String(relay.state.stderr).includes('重复连接，替换旧连接'), 'B3 场景 A 的连接确实已被清理（未出现"替换旧连接"）', '见 relay.stderr');
  }
} finally {
  await fs.writeFile(path.join(runDir, 'relay.stderr.txt'), relay?.state?.stderr ?? '', 'utf8').catch(() => {});
  await stopAll(relay);
}
console.log(`\n总体：${pass ? 'PASS' : 'FAIL'}（证据目录 ${path.relative(REPO, runDir)}）`);
process.exit(pass ? 0 : 1);

/** 客户端帧编码（带掩码，文本帧，长度 < 126 足够本用例）。 */
function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
