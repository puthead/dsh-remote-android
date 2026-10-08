/**
 * 测试公共设施：临时沙箱、真实 HTTP 网关实例、请求/等待帮助函数。
 *
 * 设计原则：集成测试启动**真实 HTTP 服务**（端口 0 由系统分配），
 * 只把「dsh 子进程」替换为替身。这样路由、鉴权、限速、SSE、进程树终止、
 * 原子持久化等真实代码路径全部被覆盖，而不是被 mock 掉。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../lib/http.mjs';
import { defaultConfig, mergeConfig, validateConfig } from '../lib/config.mjs';
import { createLogger } from '../lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 替身可执行文件（用 process.execPath 运行它，与真实调用形状一致）。 */
export const FAKE_DSH = path.join(HERE, 'fixtures', 'fake-dsh.mjs');

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造脚本化 prompt。 */
export function scripted(obj) {
  return JSON.stringify(obj);
}

/**
 * 创建临时沙箱：独立的 home（凭据 + tasks + logs）与 workspace。
 * 清理顺序很重要（先关网关再删目录），因此 startHarness 用 autoCleanup:false 自行编排。
 * @param {import('node:test').TestContext} t
 * @param {object} [overrides]
 * @param {{autoCleanup?: boolean}} [opts]
 */
export async function makeSandbox(t, overrides = {}, { autoCleanup = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-test-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  // 假凭据：替身不校验内容，这里只用于证明凭据文件被放在正确位置
  await fs.writeFile(path.join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-test-fake-key-not-real\n', 'utf8');

  const config = validateConfig(
    mergeConfig(defaultConfig(process.env), {
      host: '127.0.0.1',
      port: 0, // 系统分配，避免并行测试端口冲突
      dshHome: home,
      serverName: 'test-host',
      workspaceAllowlist: [workspace],
      defaultWorkspace: workspace,
      dsh: {
        node: process.execPath,
        binPath: FAKE_DSH,
        profile: 'headless',
        version: '0.0.0-test',
        discoverSessionId: false,
      },
      events: { heartbeatMs: 60 },
      limits: { requestTimeoutMs: 3000, headersTimeoutMs: 2500, outputFlushMs: 20, outputFlushBytes: 64 },
      log: { toConsole: false },
    }, overrides),
    { env: process.env },
  );

  const cleanup = async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  };
  if (t && autoCleanup) t.after(cleanup);
  return { root, home, workspace, config, cleanup };
}

/**
 * 启动一个真实网关实例并通过配对拿到设备令牌。
 * @param {import('node:test').TestContext} t
 * @param {object} [overrides] 配置覆盖
 * @param {{pair?: boolean, recordArgv?: boolean}} [opts]
 */
export async function startHarness(t, overrides = {}, { pair = true, recordArgv = true } = {}) {
  const sandbox = await makeSandbox(t, overrides, { autoCleanup: false });
  const argvFile = recordArgv ? path.join(sandbox.root, 'argv.jsonl') : null;
  if (argvFile) process.env.FAKE_DSH_ARGV_FILE = argvFile;

  const logger = createLogger({ dir: sandbox.config.logsDir, toConsole: sandbox.config.log.toConsole });
  const gateway = await createGateway(sandbox.config, { logger });
  const port = await gateway.listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  // 单个 after 钩子内按「先关网关、后删目录」的顺序收尾，避免依赖多个钩子的执行次序
  t?.after(async () => {
    await gateway.close().catch(() => {});
    if (argvFile) delete process.env.FAKE_DSH_ARGV_FILE;
    await sleep(50); // 让被终止的子进程完成退出，避免影响后续断言
    await sandbox.cleanup();
  });

  let token = null;
  if (pair) token = await pairDevice(baseUrl, { deviceName: 'test-device', deviceId: 'device-uuid-0001' });

  /** 记录到的子进程调用（argv/cwd/DSH_HOME）。 */
  const recorded = async () => {
    if (!argvFile) return [];
    const text = await fs.readFile(argvFile, 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  };

  return {
    sandbox,
    config: sandbox.config,
    home: sandbox.home,
    workspace: sandbox.workspace,
    gateway,
    logger,
    baseUrl,
    port,
    token,
    argvFile,
    recorded,
    request: (method, pathname, opts = {}) =>
      httpRequest(baseUrl, method, pathname, { token: opts.token === undefined ? token : opts.token, ...opts }),
  };
}

/** 完成一次配对，返回明文令牌。 */
export async function pairDevice(baseUrl, { deviceName = 'test-device', deviceId = 'device-uuid-0001' } = {}) {
  const open = await httpRequest(baseUrl, 'POST', '/api/v1/pair/open');
  if (open.status !== 200) throw new Error(`pair/open 失败：${open.status} ${open.text}`);
  const claim = await httpRequest(baseUrl, 'POST', '/api/v1/pair/claim', {
    body: { code: open.json.code, deviceName, deviceId },
  });
  if (claim.status !== 200) throw new Error(`pair/claim 失败：${claim.status} ${claim.text}`);
  return claim.json.token;
}

/**
 * 发一个 HTTP 请求（Node 内置 fetch）。
 * @returns {Promise<{status: number, headers: Headers, text: string, json: any}>}
 */
export async function httpRequest(baseUrl, method, pathname, { token = null, body = undefined, headers = {}, raw = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    if (raw) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = init.headers['Content-Type'] ?? 'application/json; charset=utf-8';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
  }
  const res = await fetch(new URL(pathname, baseUrl), init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * 轮询等待条件成立。
 * @template T
 * @param {() => T|Promise<T>} predicate
 * @returns {Promise<T>}
 */
export async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 20, message = '条件未满足' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${message}`);
    await sleep(intervalMs);
  }
}

/** 轮询任务直到进入终态。 */
export async function waitForTask(harness, id, { timeoutMs = 10_000 } = {}) {
  return waitFor(
    async () => {
      const res = await harness.request('GET', `/api/v1/tasks/${id}`);
      if (res.status !== 200) return null;
      return ['succeeded', 'failed', 'canceled'].includes(res.json.status) ? res.json : null;
    },
    { timeoutMs, message: `任务 ${id} 未进入终态` },
  );
}

/** 进程是否存活（signal 0 探测）。 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等待进程退出。 */
export async function waitForExit(pid, { timeoutMs = 5000 } = {}) {
  return waitFor(() => !isAlive(pid), { timeoutMs, message: `进程 ${pid} 未退出` });
}
