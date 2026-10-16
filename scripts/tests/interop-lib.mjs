/**
 * 互操作脚本共享库（**手动互操作脚本**，不属于自包含单测）。
 *
 * 本库会**真起 relay 与 gateway 子进程**，通过真实 TCP/WS 对话；不 mock 任何一侧。
 * 与 `tools/dsh-relay/test/*.test.mjs`（自包含、`port:0`、可在 CI 并发跑）的区别：
 * 这一组需要真实进程编排、按串行方式跑，且会占用固定端口段 19100–19800。
 *
 * ## 运行目录（可配置，不写死）
 * - 默认：`<仓库根>/.runtime/interop/run/<label>-<时间戳>/`
 * - 可用环境变量覆盖：`DSH_INTEROP_RUNDIR=<目录>`
 * - 每个运行目录里会留 `relay.stdout.txt`/`relay.stderr.txt`/`gateway.*`/`*-evidence.txt` 作为证据
 *
 * ## 退出码语义（所有 interop 脚本一致）
 * - `0`：全部断言通过（脚本会打印 `=== …：N/N 通过 ===` 或 `总体：PASS`）
 * - `1`：存在失败断言（细节打印在 `FAIL` 行与末尾汇总里）
 * - `2`：脚本自身无法运行（参数/依赖/环境问题）
 *
 * 设计原则（本轮的核心）：
 * **两侧都是通过命令行启动的真实进程，通过真实 TCP 对话；不 mock 任何一侧。**
 * 之所以要这样：GUID 事故的根因就是"两侧各自测试都自洽"。只有让两个独立进程真实对接，
 * 才能发现帧字段、时序、语义层面的口径偏差。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTunnel } from '../../tools/dsh-relay/test/ws-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（scripts/tests → scripts → repo）。 */
export const REPO = path.resolve(HERE, '..', '..');
export const NODE = process.execPath;
export const RELAY_ENTRY = path.join(REPO, 'tools', 'dsh-relay', 'relay.mjs');
export const GATEWAY_ENTRY = path.join(REPO, 'tools', 'dsh-remote', 'gateway.mjs');
/** 证据/运行目录根（可用 DSH_INTEROP_RUNDIR 覆盖，绝不写死）。 */
export const RUN_ROOT = path.resolve(process.env.DSH_INTEROP_RUNDIR || path.join(REPO, '.runtime', 'interop', 'run'));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立。 */
export async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 150, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
}

/** 建一个新的运行目录（每次运行都隔离，绝不污染真实运行目录）。 */
export async function makeRunDir(label) {
  const root = path.join(RUN_ROOT, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(root, { recursive: true });
  return root;
}

/**
 * 本次运行的启动时刻：用于"清理前的所有权校验"（只允许杀**本次运行之后**创建的进程）。
 * 为什么需要：PID 会被系统复用，且共享工作区里同时有队友的 relay/gateway 在跑。
 */
const RUN_STARTED_AT = Date.now();

/**
 * **本次运行私有的 PID 集合**（所有权登记表）。
 *
 * 铁律：本套件**只允许清理这里登记过的 PID**（以及它们派生的子进程树），
 * **绝不按进程名/命令行关键字匹配杀进程** —— 那会误伤队友在同一台机器上的中继/网关/手机模拟器。
 * 曾经的事故：验收脚本用关键字清理导致队友的隔离中继在 B/D 阶段被杀（`connect ECONNREFUSED`），
 * 让"正确实现的红色结论"与"被自己人杀掉的红色结论"在输出上无法区分。
 * @type {Map<number, {label: string, home: string|null, cwd: string, startedAt: number, gone: boolean, code: number|null, ports: number[]}>}
 */
const OWNED_PIDS = new Map();

/**
 * 已退出进程的**诊断历史**（只读，不参与清理授权）。
 *
 * 为什么需要：`killOwned()` 成功后会把它从 `OWNED_PIDS` 注销（授权表应保持最小），
 * 但诊断需要知道"这个端口原本属于谁、它什么时候退的"。
 * 权限与诊断分离：**清理授权只看 `OWNED_PIDS`，诊断可以查历史**。
 * @type {Map<number, {label: string, ports: number[], code: number|null}>}
 */
const EXITED_OWNED = new Map();

/** 登记某个 PID 实际监听/使用的端口（起进程时还不知道端口，拿到后回填）。 */
function setOwnerPort(pid, port) {
  const info = OWNED_PIDS.get(pid);
  if (info && Number.isInteger(port) && port > 0) info.ports = [...new Set([...(info.ports ?? []), port])];
}

/**
 * 把"连不上"翻译成可读的根因：端口属于本次运行、但那个进程已经退出。
 *
 * 为什么需要：relay 被外部脚本按关键字杀掉时（见 `interop.md`「禁止裸杀进程」），
 * 后续业务断言会连锁 `ECONNREFUSED`，在报告里看起来像 10 个功能缺陷 ——
 * 实际只有一句根因：「relay(pid=…) 已退出（exitCode=…）→ 端口 19500 无人监听」。
 * 错误状态必须可读，不能让工具有模糊行为（lead 反复强调的那条工程品质）。
 * @param {number} port
 * @returns {string|null}
 */
export function describeDeadOwnerByPort(port) {
  for (const [pid, info] of OWNED_PIDS) {
    if ((info.ports ?? []).includes(port) && info.gone) {
      return `${info.label}(pid=${pid}) 已退出（exitCode=${info.code ?? '未知'}）→ 端口 ${port} 无人监听`;
    }
  }
  for (const [pid, info] of EXITED_OWNED) {
    if (info.ports.includes(port)) {
      return `${info.label}(pid=${pid}) 已退出（exitCode=${info.code ?? '未知'}）→ 端口 ${port} 无人监听`;
    }
  }
  return null;
}

/** 本次运行登记过的 PID（只读，供自检/报告）。 */
export function ownedPids() {
  return [...OWNED_PIDS.entries()].map(([pid, info]) => ({ pid, ...info }));
}

/**
 * 查询一个 PID 的真实身份（创建时间 + 命令行）。只用 Win32_Process，不经进程名匹配。
 * 实现细节：结果写到临时文件再读，避免 Node 管道 stdio 在受限环境下的 EPERM 问题。
 * @param {number} pid
 * @returns {Promise<{creation: string, cmd: string}|null>}
 */
async function probeProcess(pid) {
  const outFile = path.join(os.tmpdir(), `dsh-interop-probe-${process.pid}-${pid}.json`);
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    `if ($p) { [pscustomobject]@{ creation = $p.CreationDate.ToString('o'); cmd = $p.CommandLine } | ConvertTo-Json -Compress | Set-Content -LiteralPath '${outFile.replace(/'/g, "''")}' -Encoding UTF8 }`,
  ].join('\n');
  try {
    await new Promise((resolve) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', resolve);
      ps.on('error', resolve);
    });
    const text = (await fs.readFile(outFile, 'utf8')).replace(/^\uFEFF/, '');
    await fs.unlink(outFile).catch(() => {});
    return JSON.parse(text);
  } catch {
    await fs.unlink(outFile).catch(() => {});
    return null;
  }
}

/**
 * **受保护地**清理一个进程（本套件唯一允许的杀进程入口）。
 *
 * 两道校验都通过才动手（lead 裁定）：
 * 1. 该 PID 在 `OWNED_PIDS` 里（由本脚本的 `spawnCollect` 登记）；
 * 2. 系统里的真实进程 `CreationDate` **晚于本次脚本启动**，且命令行里包含**本次运行的隔离 home 路径**。
 * 任一不满足 → 打印 `SKIP kill pid=…（不属于本次运行）` 并跳过（绝不动别人的进程）。
 *
 * 清理方式：`taskkill /PID <pid> /T /F` —— 只杀**这棵子树**（能带走网关派生的 dsh 子进程）。
 * **为什么必须带 `/F`**：Windows 上不带 `/F` 的 taskkill 对无窗口的 console 进程不可靠
 * （实测 relay 会拖到 8s 之后才退出，让"优雅收尾"变成时序赌博；本套件的子进程都是测试用，直接 TerminateProcess 即可）。
 * 收尾后**确认进程真的消失才注销登记**：否则保留登记，让后续兜底能再试一次（避免"以为杀了其实没杀"）。
 *
 * @param {number} pid
 * @param {{why?: string}} [opts]
 * @returns {Promise<boolean>} 是否执行了清理动作
 */
export async function killOwned(pid, { why = '' } = {}) {
  const info = OWNED_PIDS.get(pid);
  if (!info) {
    console.log(`  SKIP kill pid=${pid}（未登记：不属于本次运行，本套件绝不动别人的进程）${why ? `｜${why}` : ''}`);
    return false;
  }
  const probe = await probeProcess(pid);
  if (!probe) {
    OWNED_PIDS.delete(pid); // 已自行退出
    return false;
  }
  const created = Date.parse(probe.creation);
  const afterThisRun = Number.isFinite(created) ? created >= RUN_STARTED_AT - 2000 : false;
  const homeMatch = info.home ? String(probe.cmd ?? '').toLowerCase().includes(info.home.toLowerCase()) : false;
  if (!afterThisRun || !homeMatch) {
    console.log(
      `  SKIP kill pid=${pid}（不属于本次运行）｜created=${probe.creation} 本脚本启动=${new Date(RUN_STARTED_AT).toISOString()}` +
        `｜home=${info.home} 命令行=${String(probe.cmd ?? '').slice(0, 160)}`,
    );
    OWNED_PIDS.delete(pid);
    return false;
  }
  await new Promise((resolve) => {
    const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    tk.on('exit', resolve);
    tk.on('error', resolve);
  });
  // 确认消失后才注销；没消失就保留登记（兜底会再试），并明确告警
  if (await waitGone(pid, 5000)) OWNED_PIDS.delete(pid);
  else console.log(`  WARN kill pid=${pid} 发送 taskkill 后 5s 内仍未消失，保留登记供兜底重试${why ? `｜${why}` : ''}`);
  return true;
}

/**
 * 等 TCP 端口真正可连接（不只是 stdout 打印了启动 JSON）。
 *
 * 为什么需要：stdout 管道有缓冲/调度延迟，"打印了启动行" ≠ "已经能连"。
 * 先探测再继续，能把"还没监听"与"真的起不来"区分开 ——
 * 否则一次启动竞态会被放大成一连串业务断言失败（gateway-dev 实测到 `20/30` 的级联假红，
 * 末尾只有一句 `ECONNREFUSED`，看起来像 10 个功能缺陷）。
 * @param {number} port
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function waitPortReady(port, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = (value) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(1000, () => done(false));
    });
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await sleep(120);
  }
}

/** 轮询进程是否已消失（用 `process.kill(pid, 0)`，便宜且无需再起 PowerShell）。 */
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

/**
 * 起一个子进程并把 stdout/stderr 收集到缓冲区（供报告贴原始输出）。
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: object, label?: string, home?: string|null}} [opts]
 *   `home` 是本次运行给该进程的**隔离运行目录**：清理前的所有权校验会要求命令行包含它。
 */
function spawnCollect(file, args, { cwd = REPO, env = {}, label = 'child', home = null } = {}) {
  const proc = spawn(NODE, [file, ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true });
  const owner = { label, home, cwd, startedAt: Date.now(), gone: false, code: null, ports: [] };
  OWNED_PIDS.set(proc.pid, owner);
  const state = { stdout: '', stderr: '', exited: false, code: null };
  proc.stdout.on('data', (c) => (state.stdout += c.toString('utf8')));
  proc.stderr.on('data', (c) => (state.stderr += c.toString('utf8')));
  proc.on('exit', (code) => {
    state.exited = true;
    state.code = code;
    owner.gone = true;
    owner.code = code;
    // 诊断历史：清理授权表会被注销（killOwned 成功后 delete），但诊断需要记得"这个端口原本属于谁"。
    // 注意这里必须用 spawn 时捕获的 `owner` **对象引用**（setOwnerPort 是原地改它的 ports），
    // 不能在 exit 时回头查 OWNED_PIDS —— 那时条目可能已经被注销，ports 会读成空数组。
    EXITED_OWNED.set(proc.pid, { label: owner.label, ports: [...owner.ports], code });
  });
  return { proc, state };
}

/** 从流式输出里等一行匹配（用于拿真实端口）。 */
async function waitLine(state, read, regex, { timeoutMs = 20_000, what = '启动行' } = {}) {
  return await waitFor(() => {
    const match = regex.exec(read(state));
    return match ? match : null;
  }, { timeoutMs, what });
}

/**
 * 起真实 relay 进程。
 * @param {{runDir: string, tlsMode?: 'off'|'selfsigned', relayName?: string, relaySecret?: string, port?: number, env?: object}} opts
 */
export async function startRelay({ runDir, tlsMode = 'off', relayName = 'relay.interop.test', relaySecret = 'interop-secret', port = 0, publicUrl = null, limits = {}, env = {} }) {
  const home = path.join(runDir, 'relay-home');
  await fs.mkdir(home, { recursive: true });
  const config = {
    relayName,
    host: '127.0.0.1',
    port,
    relaySecret,
    publicUrl,
    tls: { mode: tlsMode, certFile: null, keyFile: null, selfSignedDir: 'tls', commonName: null, days: 30 },
    // forwardTimeoutMs 特意小于脚本的 HTTP 超时（15s）：网关不回时先由**中继**给出 503 home_offline，
    // 报告里看到的才是"中继如实报告电脑不可用"，而不是一个裸的客户端超时。
    limits: { pairClaimPerMinute: 1000, authFailPerMinute: 1000, forwardTimeoutMs: 8000, ...limits },
    heartbeat: { intervalMs: 30_000, timeoutMs: 90_000 },
    pairWindowTtlMs: 300_000,
    registryReloadIntervalMs: 1000,
    log: { dirName: 'logs', filePrefix: 'relay', toConsole: true },
  };
  await fs.writeFile(path.join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  // 固定端口时必须先等它真正空出来：重启 relay 时上一个进程可能还没退干净，
  // 直接 spawn 会因 "address in use" 起不来，表现为"等待 relay 启动 JSON 超时"（曾因此假红一次）。
  if (port !== 0) {
    const free = await waitPortFree(port, 8000);
    if (!free) {
      throw new Error(
        `端口 ${port} 仍被占用（可能有并发运行的互操作脚本/队友进程/TIME_WAIT 未释放）。\n` +
          `  处理：等它释放后重跑；或用 $env:DSH_INTEROP_PORT_BASE = <偏移> 让本次运行整体挪到别的端口段。`,
      );
    }
  }
  const { proc, state } = spawnCollect(RELAY_ENTRY, ['serve', '--home', home], { env, label: 'relay', home });
  const info = await waitLine(state, (s) => s.stdout, /\{"ok":true[^\n]*\}/, { what: 'relay 启动 JSON' });
  const json = JSON.parse(info[0]);
  setOwnerPort(proc.pid, json.port);
  // 端口就绪探测：stdout 打印了启动 JSON ≠ 已经能连（管道/调度延迟）。
  // 先连上再继续，避免一次启动竞态被放大成十几条业务断言失败（gateway-dev 实测到 20/30 的级联假红）。
  if (!(await waitPortReady(json.port, { timeoutMs: 8000 }))) {
    const dead = describeDeadOwnerByPort(json.port);
    throw new Error(
      `relay 启动后 8s 内端口 ${json.port} 仍不可连接${dead ? `（${dead}）` : ''}。` +
        `\n  relay stderr：${String(state.stderr).slice(0, 500) || '(空)'}`,
    );
  }
  const secure = tlsMode !== 'off';
  return {
    name: 'relay',
    proc,
    state,
    home,
    configPath: path.join(home, 'config.json'),
    port: json.port,
    tlsMode,
    secure,
    httpBase: `${secure ? 'https' : 'http'}://127.0.0.1:${json.port}`,
    wsBase: `${secure ? 'wss' : 'ws'}://127.0.0.1:${json.port}`,
    relayName,
    relaySecret,
    async stop() {
      if (state.exited) return;
      // 受保护清理：只允许杀**本次运行登记过、且校验通过**的 PID（见 killOwned）
      await killOwned(proc.pid, { why: 'relay 正常收尾' });
      await waitFor(() => state.exited, { timeoutMs: 8000, what: 'relay 退出' }).catch(() => {});
      // 退不干净就再来一次（同样受保护；此时通常已注销登记，会打印 SKIP 说明）
      if (!state.exited) {
        await killOwned(proc.pid, { why: 'relay 强制收尾' });
        await waitFor(() => state.exited, { timeoutMs: 4000, what: 'relay 强制退出' }).catch(() => {});
      }
      // 等监听端口真正释放（Windows 上 TerminateProcess 后可能还有几十毫秒的残留）
      await waitPortFree(json.port, 5000);
    },
  };
}

/**
 * 起真实 gateway 进程（绑 127.0.0.1，relay 指向给定中继）。
 */
export async function startGateway({ runDir, relayUrl, relaySecret = '', workspace, extra = {}, env = {}, port = 0, label = 'gw-home', serverName = 'INTEROP-PC', homeName = 'INTEROP-PC', relayExtra = {} }) {
  const home = path.join(runDir, label);
  await fs.mkdir(home, { recursive: true });
  const config = {
    host: '127.0.0.1',
    port,
    serverName,
    authRequired: true,
    workspaceAllowlist: [workspace],
    defaultWorkspace: workspace,
    relay: {
      enabled: true,
      url: relayUrl,
      relaySecret,
      homeName,
      reconnect: { minMs: 300, maxMs: 2000, factor: 2, jitter: 0 },
      tls: { rejectUnauthorized: false },
      ...relayExtra,
    },
    log: { dirName: 'logs', filePrefix: 'gateway', toConsole: true },
    ...extra,
  };
  const configPath = path.join(home, 'config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const { proc, state } = spawnCollect(GATEWAY_ENTRY, ['serve', '--config', configPath, '--home', home], { env, label: `gateway:${label}`, home });
  const match = await waitLine(state, (s) => s.stdout, /监听地址\s*:\s*https?:\/\/([\d.]+):(\d+)/, { what: 'gateway 监听地址' });
  const host = match[1];
  const actualPort = Number(match[2]);
  setOwnerPort(proc.pid, actualPort);
  if (!(await waitPortReady(actualPort, { timeoutMs: 8000 }))) {
    const dead = describeDeadOwnerByPort(actualPort);
    throw new Error(
      `gateway 启动后 8s 内端口 ${actualPort} 仍不可连接${dead ? `（${dead}）` : ''}。` +
        `\n  gateway stderr：${String(state.stderr).slice(0, 500) || '(空)'}`,
    );
  }
  return {
    name: 'gateway',
    proc,
    state,
    home,
    configPath,
    port: actualPort,
    httpBase: `http://${host}:${actualPort}`,
    async stop() {
      if (state.exited) return;
      // 受保护清理：`taskkill /T` 会带走网关派生的 dsh 子进程，避免残留
      await killOwned(proc.pid, { why: 'gateway 正常收尾' });
      await waitFor(() => state.exited, { timeoutMs: 8000, what: 'gateway 退出' }).catch(() => {});
    },
  };
}

/** HTTP(S) JSON 请求（自签证书场景自动放行，仅测试用）。 */
export function httpJson(baseUrl, method, pathname, { token = null, body = null, timeoutMs = 15_000, headers = {} } = {}) {
  const url = new URL(pathname, baseUrl);
  const secure = url.protocol === 'https:';
  const payload = body === null || body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const reqHeaders = { ...headers };
  if (token) reqHeaders.Authorization = `Bearer ${token}`;
  if (payload !== null) {
    reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
    reqHeaders['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const transport = secure ? https : http;
    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: reqHeaders,
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text.trim() ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP 超时：${method} ${pathname}`)));
    req.on('error', (err) => {
      // 把连接类错误翻译成可读根因：该端口属于本次运行的进程、但它已经退出。
      // 否则报告里只会看到一串 ECONNREFUSED，看起来像 N 个功能缺陷（实际只有一句根因）。
      const dead = describeDeadOwnerByPort(Number(url.port));
      if (dead && ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(err.code)) err.message = `${err.message}｜${dead}`;
      reject(err);
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** 端口是否可监听（用于挑一个空闲端口）。 */
export function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 端口基址偏移：允许多人/多轮**并发**跑互操作脚本而不抢端口。
 * 例：`$env:DSH_INTEROP_PORT_BASE = 50` 会让 19100 变成 19150。
 */
const PORT_OFFSET = Number(process.env.DSH_INTEROP_PORT_BASE ?? 0) || 0;

/** 把脚本里的固定基址加上环境偏移。 @param {number} base */
export function interopPort(base) {
  return base + PORT_OFFSET;
}

/** 找一个空闲端口。 */
export async function pickPort(start = 18_000) {
  for (let port = start; port < start + 500; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error(`找不到空闲端口（从 ${start} 起找了 500 个）`);
}

/**
 * 等端口释放（重启 relay 时上一个进程可能还没完全退干净；Windows 上尤其明显）。
 * 为什么不直接换成随机端口：重置场景必须让网关连回**同一个** URL，端口变了测试就没意义了。
 * @param {number} port
 * @param {number} timeoutMs
 */
export async function waitPortFree(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portFree(port)) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

/**
 * 手机模拟器：走 device 隧道发请求。
 * 复用 relay 仓库里那套独立实现的 WS 客户端（不复用任何被测代码）。
 */
export async function openPhone({ wsBase, deviceToken, timeoutMs = 10_000 }) {
  const tunnel = await openTunnel(`${wsBase}/api/v2/tunnel/device`, {
    role: 'device',
    token: deviceToken,
    timeoutMs,
    rejectUnauthorized: false,
  });
  const ready = await tunnel.handshake();
  let nextId = 1;
  return {
    tunnel,
    ready,
    /** 经隧道发一次请求，返回 {status, headers, text, json, aborted}。 */
    async call(method, pathname, { token = null, body = null, headers = {}, id = null, timeoutMs = 20_000 } = {}) {
      const rid = id ?? nextId++;
      const h = { ...headers };
      if (token) h.authorization = `Bearer ${token}`;
      const frame = { t: 'req', id: rid, method, path: pathname, headers: h };
      if (body !== null && body !== undefined) {
        frame.bodyB64 = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8').toString('base64');
      }
      tunnel.send(frame);
      const result = await tunnel.collect(rid, { timeoutMs });
      let json = null;
      try {
        json = result.text ? JSON.parse(result.text) : null;
      } catch {
        json = null;
      }
      return { ...result, json };
    },
    close() {
      try {
        tunnel.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 断言收集器：把 PASS/FAIL/SKIP 记录成报告，最后统一打印。
 *
 * ⚠️ 为什么要有 `skip`：**"跳过"绝不能被计成 PASS**。曾经有一行
 * `PASS （心跳 tick 为 debug 级，默认不落盘，故此处不做计数）` 其实是"没测"，
 * 复核时差点被当成一条有效证据（lead 指出）。计数口径：`N/M 通过` 里的 M 只统计 PASS+FAIL。
 */
export function createReport(title) {
  const checks = [];
  return {
    title,
    checks,
    ok(name, detail = '') {
      checks.push({ name, pass: true, skipped: false, detail });
      console.log(`  PASS  ${name}${detail ? `  —— ${detail}` : ''}`);
      return true;
    },
    fail(name, detail = '') {
      checks.push({ name, pass: false, skipped: false, detail });
      console.log(`  FAIL  ${name}${detail ? `  —— ${detail}` : ''}`);
      return false;
    },
    /** 明确"没有断言/环境不适用"——不计入通过数，也不影响退出码。 */
    skip(name, detail = '') {
      checks.push({ name, pass: null, skipped: true, detail });
      console.log(`  SKIP  ${name}${detail ? `  —— ${detail}` : ''}`);
      return null;
    },
    /** 断言并记录（不抛，让报告能跑完所有用例）。 */
    expect(cond, name, detail = '') {
      return cond ? this.ok(name, detail) : this.fail(name, detail);
    },
    get failed() {
      return checks.filter((c) => c.pass === false);
    },
    get skipped() {
      return checks.filter((c) => c.skipped);
    },
    get counted() {
      return checks.filter((c) => c.pass !== null);
    },
    summary() {
      const counted = this.counted.length;
      const passed = counted - this.failed.length;
      console.log(
        `\n=== ${title}：${passed}/${counted} 通过${this.skipped.length ? `（另有 ${this.skipped.length} 项 SKIP，不计入通过数）` : ''} ===`,
      );
      if (this.failed.length > 0) {
        console.log('失败项：');
        for (const item of this.failed) console.log(`  - ${item.name}${item.detail ? `：${item.detail}` : ''}`);
      }
      if (this.skipped.length > 0) {
        console.log('跳过项（未验证，不作为证据）：');
        for (const item of this.skipped) console.log(`  - ${item.name}${item.detail ? `：${item.detail}` : ''}`);
      }
      return this.failed.length === 0;
    },
  };
}

/** 清理：停掉所有进程。 */
/**
 * 收尾：先让各 target 走自己的受保护 `stop()`，再兜底清理**仍登记在册**的 PID。
 *
 * 铁律（lead 裁定）：**本套件只清理自己拉起的进程**，绝不按进程名/命令行关键字匹配杀进程。
 * 兜底这一步同样经过 `killOwned()` 的两道校验（登记 + 创建时间 + 隔离 home 路径）。
 */
export async function stopAll(...targets) {
  for (const target of targets) {
    try {
      await target?.stop?.();
    } catch {
      /* ignore */
    }
  }
  for (const [pid] of OWNED_PIDS) {
    try {
      await killOwned(pid, { why: 'stopAll 兜底' });
    } catch {
      /* ignore */
    }
  }
  await sleep(100);
}

export { fs, os, path };

/**
 * 打印自解释用法行（每个互操作脚本开头都调用一次）。
 * 为什么要有：这些脚本常在"临时排查"时被直接执行，运行日志里必须自带
 * 「我是谁 / 用法 / 会起哪些进程 / 退出码含义 / 证据在哪」，否则事后无法判断这次运行是什么档位。
 * @param {{name: string, usage: string, ports: string, extra?: string}} opts
 */
export function printUsage({ name, usage, ports, extra = '' }) {
  console.log(`# ${name}（手动互操作脚本：会真起 relay/gateway 进程，不入自包含单测）`);
  console.log(`# 用法：${usage}`);
  console.log(`# 端口：${ports}｜gateway 一律 port:0（系统分配）`);
  if (extra) console.log(`# 说明：${extra}`);
  console.log(`# 退出码：0=全部通过；1=有失败断言；2=参数/环境错误（未启动或未跑完）`);
  console.log(`# 证据目录根：${RUN_ROOT}（可用 DSH_INTEROP_RUNDIR 覆盖）`);
}

/**
 * 校验枚举型参数：非法值 → 打印允许值与用法行，然后 **exit 2**。
 *
 * 为什么必须有：`interop-boundary.mjs` 只接受 `off|selfsigned`，但有人会把 `interop-smoke.mjs` 的 `both` 传进来；
 * 旧行为是把 `both` 当成 tls 模式一路跑下去，最后卡在"等待 relay 启动 JSON 超时"——一个参数错误被伪装成超时，
 * 排查成本极高（gateway-dev 就踩了这一次）。参数错误必须**立刻、可读地**失败，且不启动任何进程。
 * @param {string|undefined} value
 * @param {string[]} allowed
 * @param {{argName: string, usage: string}} opts
 */
export function requireEnum(value, allowed, { argName, usage }) {
  if (allowed.includes(value)) return value;
  console.error(`参数非法：${argName}=${JSON.stringify(value)}；允许值：${allowed.join(' | ')}`);
  console.error(`用法：${usage}`);
  console.error('退出码：2（参数错误，未启动任何进程）');
  process.exit(2);
}

/**
 * 校验正整数型参数（缺省返回 fallback）。
 * @param {string|undefined} value
 * @param {{argName: string, usage: string, min?: number, max?: number, fallback: number}} opts
 */
export function requirePositiveInt(value, { argName, usage, min = 1, max = 1000, fallback }) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`参数非法：${argName}=${JSON.stringify(value)}；必须是 ${min}~${max} 的整数`);
    console.error(`用法：${usage}`);
    console.error('退出码：2（参数错误，未启动任何进程）');
    process.exit(2);
  }
  return n;
}
