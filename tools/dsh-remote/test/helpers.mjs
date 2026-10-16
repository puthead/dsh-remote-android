/**
 * 测试公共设施：临时沙箱、真实 HTTP 网关实例、请求/等待帮助函数。
 *
 * 设计原则：集成测试启动**真实 HTTP 服务**（端口 0 由系统分配），
 * 只把「dsh 子进程」替换为替身。这样路由、鉴权、限速、SSE、进程树终止、
 * 原子持久化等真实代码路径全部被覆盖，而不是被 mock 掉。
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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

/** 构造一帧「桌面端事件」原始值（`DesktopApi.openFollow` 的产出形状）。 */
export function desktopEvent(type, data, { seq = 0 } = {}) {
  return { type: 'event', event: { type, seq, data } };
}

/**
 * 纯内存的桌面端 DSH runtime 替身（`lib/desktop-api.mjs` 的同形状子集）。
 *
 * 为什么必须注入它：`createGateway` 在未显式传 `desktop` 时会自建真实 `DesktopApi`
 * 并去连 `127.0.0.1:19387`——那会读到用户真实 `~/.dsh` 凭据，甚至向用户正在跑的
 * Electron 会话投递轮次。本替身不 spawn、不联网、不碰 `~/.dsh`。
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.entries] `session/list` 的条目（sessionId/running/agentAvailable/title/turns…）
 * @param {object} [opts.projections] sessionId → `{values, asOfSeq}`
 * @param {Array<object>} [opts.autoFrames] 每次 `openFollow` 订阅先吐出的帧（至少一帧才会被 runner 认为订阅成功）
 * @param {string|null} [opts.createdSessionId] `createSession` 返回的会话 id（不传则随机一个合法形状的 uuid）
 */
export function makeDesktopStub({
  host = '127.0.0.1',
  port = 19387,
  entries = [],
  projections = {},
  autoFrames = [],
  listError = null,
  projectionsError = null,
  promptError = null,
  cancelError = null,
  followError = null,
  nextError = null,
  promptResult = null,
  createWorkspaceError = null,
  createSessionError = null,
  createdSessionId = null,
  // 模型两个 RPC（`session/modelCatalog` / `session/selectModel`）：手机端模型选择器的真值来源。
  // `selectModelError` 用来验证"切模型失败不能让任务失败"这条降级路径。
  modelCatalogResult = null,
  modelCatalogError = null,
  selectModelError = null,
  selectedModel = null,
} = {}) {
  const items = entries.map((entry) => {
    const values = { title: entry.title ?? null, sessionStats: { turns: entry.turns ?? 0 }, ...(entry.values ?? {}) };
    return {
      blank: false,
      cwd: null,
      running: false,
      agentAvailable: true,
      ...entry,
      projections: { kind: 'session', asOfSeq: entry.asOfSeq ?? 0, values: { ...values, ...(entry.projections?.values ?? {}) } },
    };
  });
  const calls = { listSessions: 0, projections: [], prompt: [], cancel: [], follows: [], createWorkspace: [], createSession: [], modelCatalog: 0, selectModel: [], order: [] };
  // `order` 是**跨方法**的调用顺序账本：模型选择（`session/selectModel`）必须先于首轮投递
  // （`session/prompt`）才有意义，而按方法分桶的 `calls.*` 数组证明不了先后关系。
  const note = (label) => { calls.order.push(label); };
  // `workspace/create` 是幂等的（真实 RPC 也是），按 path 记一份 workspaceId。
  const workspaces = [];
  // 每次 `openFollow` 都是**独立**的订阅（真实 DesktopApi 每条 RPC 流互不干扰），
  // 所以 push 是广播：同一会话的多个订阅各自收到一份。
  const states = new Map();
  const live = new Set();
  const stateOf = (id) => {
    let st = states.get(id);
    if (!st) {
      st = { subs: new Set(), pending: [], closed: null };
      states.set(id, st);
    }
    return st;
  };
  const find = (sessionId) => items.find((item) => item.sessionId === sessionId) ?? null;
  const deliver = (ch, value) => {
    if (ch.waiter) {
      const resolve = ch.waiter;
      ch.waiter = null;
      resolve({ value, done: false });
    } else {
      ch.queue.push(value);
    }
  };
  /** 投一帧进该会话的所有订阅（暂无订阅者就先留着，模拟 follow 的转录回放）。 */
  const push = (sessionId, value) => {
    const st = stateOf(sessionId);
    if (st.subs.size === 0) {
      st.pending.push(value);
      return;
    }
    for (const ch of [...st.subs]) deliver(ch, value);
  };
  /** 结束订阅：`iterator.next()` 之后会以 `{ended, error}` 作为返回值。 */
  const endFollow = (sessionId, { error = null } = {}) => {
    const st = stateOf(sessionId);
    const payload = { ended: true, error };
    if (st.subs.size === 0) {
      st.closed = payload; // 还没有订阅者 → 下一个订阅的首个事件就是终态
      return;
    }
    for (const ch of [...st.subs]) {
      ch.done = payload;
      if (ch.waiter) {
        const resolve = ch.waiter;
        ch.waiter = null;
        resolve({ value: payload, done: true });
      }
    }
    st.subs.clear();
  };

  return {
    host,
    port,
    calls,
    entries: items,
    get followCount() {
      return calls.follows.length;
    },
    get entryCount() {
      return items.length;
    },
    /** 还活着的订阅数（用于断言"断开后不泄漏"）。 */
    get liveFollowCount() {
      return live.size;
    },
    /**
     * 已经被关闭的订阅流数（生成器的 `finally` 跑过）。
     * 真实 `DesktopApi.openFollow` 的 `finally` 里才 `socket.close()`，而它只有在迭代器被
     * `return()` 或耗尽时才会执行——所以这个计数就是"WS 句柄有没有被放掉"的观测口。
     */
    get closedFollowCount() {
      return calls.follows.filter((f) => f.closed).length;
    },
    setRunning(sessionId, running) {
      const item = find(sessionId);
      if (item) item.running = running;
      return item;
    },
    setAgentAvailable(sessionId, available) {
      const item = find(sessionId);
      if (item) item.agentAvailable = available;
      return item;
    },
    push,
    endFollow,
    /**
     * `DesktopApi.callRaw`：网关读模型目录走的是它而不是 `modelCatalog()`
     * （要的是"失败就降级"，不是把异常抛成 5xx，见 http.mjs 的 loadModelCatalog）。
     * 替身必须提供**同样的信封** `{ok:true,value}` / `{ok:false,error:{code,message}}`，
     * 否则替身一接上就退化成"桌面端未实现 modelCatalog"，测试会安静地测了个假分支。
     * 计数仍在 `calls.modelCatalog` 上，与 `modelCatalog()` 共用（真实实现两者是同一个 RPC）。
     */
    async callRaw(endpoint, args = {}) {
      if (endpoint === 'session/modelCatalog') {
        try {
          return { ok: true, value: await this.modelCatalog() };
        } catch (err) {
          return { ok: false, error: { code: err?.code ?? 'desktop_error', message: String(err?.message ?? err) } };
        }
      }
      throw new Error(`桩未实现 callRaw(${endpoint}) args=${JSON.stringify(args)}`);
    },
    async listSessions() {
      calls.listSessions += 1;
      if (listError) throw listError instanceof Error ? listError : new Error(String(listError));
      // `DesktopApi.listSessions()` 把 RPC 的 `{items}` 摊平成**数组**再返回
      // （desktop-api.mjs:347 `Array.isArray(value?.items) ? value.items : []`）；
      // 调用方 http.mjs:929 / session-runner.mjs:1043 直接 `.map/.find`，给对象会炸。
      return items;
    },
    async projections(sessionId) {
      calls.projections.push(sessionId);
      if (projectionsError) throw projectionsError;
      return projections[sessionId] ?? { values: {}, asOfSeq: 0 };
    },
    async prompt(args = {}) {
      calls.prompt.push({ sessionId: args?.sessionId, text: args?.text ?? null, mode: args?.mode ?? null });
      note('prompt');
      if (promptError) throw promptError;
      return promptResult ?? { messageId: 'msg-stub-1' };
    },
    async cancel(sessionId) {
      calls.cancel.push(sessionId);
      if (cancelError) throw cancelError;
      return { ok: true };
    },
    /**
     * `workspace/create`：把一个已存在目录登记为工作区（幂等）。
     * 返回形状照抄真实 RPC：`{created, workspace: {workspaceId, path}}`——
     * `http.mjs` 读的是 `ws?.workspace?.workspaceId` 与 `ws.created`。
     */
    async createWorkspace(path) {
      calls.createWorkspace.push(path);
      note('createWorkspace');
      if (createWorkspaceError) throw createWorkspaceError;
      let entry = workspaces.find((w) => w.path === path) ?? null;
      const created = entry === null;
      if (!entry) {
        entry = { path, workspaceId: `ws-stub-${workspaces.length + 1}` };
        workspaces.push(entry);
      }
      return { created, workspace: { workspaceId: entry.workspaceId, path } };
    },
    /**
     * `session/create`：新建会话。新会话会被登记进 `entries`（`session/list` 立刻能看到），
     * 因为真实桌面端建完会话后 `session/list` 就会列出它——`#submitDesktop` 要据此判断
     * `running`/`agentAvailable`。
     */
    async createSession({ cwd = null, workspaceId = null, sessionId = null, agentPreset = null } = {}) {
      calls.createSession.push({ cwd, workspaceId, sessionId, agentPreset });
      note('createSession');
      if (createSessionError) throw createSessionError;
      const id = sessionId ?? createdSessionId ?? `session-${randomUUID()}`;
      if (!find(id)) {
        items.push({
          sessionId: id,
          blank: true,
          cwd,
          running: false,
          agentAvailable: true,
          origin: 'user',
          projections: { kind: 'session', asOfSeq: 0, values: { title: null, sessionStats: { turns: 0 } } },
        });
      }
      return { sessionId: id, workspaceId };
    },
    /**
     * `session/modelCatalog`：桌面端当前可路由的模型目录（无参数）。
     *
     * 返回值照抄真实形状 `{default, routableProviders, groups, failures}`；
     * 默认目录刻意做成"两个 provider、其中一个模型带 reasoning 档位、外加一条 provider 采集失败"，
     * 这样手机端要渲染的三块内容（分组 / 档位 / 部分不可用）在测试里都被覆盖到。
     */
    async modelCatalog() {
      calls.modelCatalog += 1;
      note('modelCatalog');
      if (modelCatalogError) throw modelCatalogError;
      return modelCatalogResult ?? {
        default: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
        routableProviders: ['deepseek-official'],
        groups: [
          {
            id: 'deepseek-official',
            name: 'DeepSeek 官方',
            models: [
              { id: 'deepseek-v4-flash', name: 'V4 Flash' },
              {
                id: 'deepseek-v4-pro',
                name: 'V4 Pro',
                description: '更强的推理档',
                reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' },
              },
            ],
          },
        ],
        failures: [{ id: 'dsh-llm-pi-ai', name: 'pi-ai', message: '未配置任何路由' }],
      };
    },
    /**
     * `session/selectModel`：把某个会话切到指定 provider/model。
     *
     * 真实 RPC 返回 `{selected:{provider,model,reasoningEffort?}}`（并且会**顺手把桌面端自己的
     * 默认模型也改掉**——`agentDefaultModel.saveSelection`，见 desktop-api.mjs 的注释）。
     * 替身只回形状，不假装有持久化。
     */
    async selectModel(args = {}) {
      calls.selectModel.push({
        sessionId: args?.sessionId ?? null,
        provider: args?.provider ?? null,
        model: args?.model ?? null,
        reasoningEffort: args?.reasoningEffort ?? null,
      });
      note('selectModel');
      if (selectModelError) throw selectModelError;
      return {
        selected: selectedModel ?? {
          provider: args?.provider ?? 'deepseek-official',
          model: args?.model ?? 'deepseek-v4-flash',
          ...(args?.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
        },
      };
    },
    openFollow(sessionId, opts = {}) {
      if (followError) throw followError;
      // 每条订阅一条可观测记录：`closed` 只有生成器真的被关闭/耗尽（`finally`）才为 true。
      // 消费方 `#consumeDesktopStream` 刻意用手写 `iterator.next()` 循环（要拿生成器返回值里的
      // `{ended, error}`），收到 `turn/end` 时是**提前 return** 的，此时异步生成器仍挂在 `yield`
      // 上；若 `#openDesktopTurnStream` 的 `finally` 不 `await iterator.return?.()`，真实实现就会
      // 每轮泄漏一个 WebSocket（未 unref 的 socket 吊住事件循环，网关进程再也退不出去）。
      const record = { sessionId, assistantStream: opts.assistantStream === true, timeoutMs: opts.timeoutMs ?? null, hasSignal: Boolean(opts.signal), closed: false };
      calls.follows.push(record);
      const st = stateOf(sessionId);
      const preClosed = st.closed; // endFollow 早于订阅 → 首个事件即终态
      st.closed = null;
      const ch = { queue: [...st.pending.splice(0)], waiter: null, done: null };
      st.subs.add(ch);
      live.add(ch);
      const signal = opts.signal ?? null;
      const onAbort = () => endFollow(sessionId, { error: { code: 'aborted', message: 'aborted' } });
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const frames = autoFrames.slice();
      async function* iterate() {
        try {
          if (nextError) throw nextError;
          for (const frame of frames) yield frame; // 每次订阅各一份
          if (preClosed) return preClosed;
          for (;;) {
            if (ch.queue.length) {
              yield ch.queue.shift();
              continue;
            }
            if (ch.done) return ch.done;
            const step = await new Promise((resolve) => {
              ch.waiter = resolve;
            });
            if (step.done) return step.value;
            yield step.value;
          }
        } finally {
          if (signal) signal.removeEventListener('abort', onAbort);
          ch.waiter = null;
          st.subs.delete(ch);
          live.delete(ch);
          record.closed = true; // 迭代器被 return/耗尽 → 生成器收尾（真实实现这里是 socket.close()）
        }
      }
      return iterate();
    },
  };
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
  // 与网关启动时的 ensureRuntimeDirs 保持一致：测试需要能在启动前预置任务文件
  await fs.mkdir(path.join(home, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(home, 'logs'), { recursive: true });

  // 注意：mergeConfig 为变参（后者覆盖前者），用例级 overrides 必须真正生效，
  // 否则 maxConcurrent/maxQueue/limits.* 会被静默忽略，导致「假失败/假通过」。
  const config = validateConfig(
    mergeConfig(
      defaultConfig(process.env),
      {
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
      },
      overrides,
    ),
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
 * @param {{pair?: boolean, recordArgv?: boolean, desktop?: object|null}} [opts]
 */
export async function startHarness(t, overrides = {}, { pair = true, recordArgv = true, desktop = null } = {}) {
  const sandbox = await makeSandbox(t, overrides, { autoCleanup: false });
  const argvFile = recordArgv ? path.join(sandbox.root, 'argv.jsonl') : null;
  if (argvFile) process.env.FAKE_DSH_ARGV_FILE = argvFile;

  const logger = createLogger({ dir: sandbox.config.logsDir, toConsole: sandbox.config.log.toConsole });
  // desktop 默认显式关闭（null）：绝不构造真实 DesktopApi——它会连 127.0.0.1:19387
  // 上用户正在跑的 Electron DSH，读真实 ~/.dsh 凭据。需要桌面端语义的用例显式传桩。
  const gateway = await createGateway(sandbox.config, { logger, desktop });
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
  if (pair) token = await pairDevice(baseUrl, { deviceName: 'test-device', deviceId: '01234567-89ab-4cde-8f01-23456789abcd' });

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
    desktop,
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
export async function pairDevice(baseUrl, { deviceName = 'test-device', deviceId = '01234567-89ab-4cde-8f01-23456789abcd' } = {}) {
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

/**
 * 找一个可用的非回环 IPv4（用于验证「pair/open 只允许回环」的真实 HTTP 路径）。
 * 没有则返回 null，调用方跳过该用例。
 * @returns {string|null}
 */
export function findLanIpv4() {
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (!entry.internal && entry.family === 'IPv4' && !entry.address.startsWith('169.254.')) return entry.address;
    }
  }
  return null;
}

/** 等待进程退出。 */
export async function waitForExit(pid, { timeoutMs = 5000 } = {}) {
  return waitFor(() => !isAlive(pid), { timeoutMs, message: `进程 ${pid} 未退出` });
}
