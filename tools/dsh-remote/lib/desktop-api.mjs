/**
 * 桌面端 DSH runtime 的 Typert Remote 客户端（**双向同步的唯一通道**）。
 *
 * ## 为什么需要它
 *
 * 既有 `session-runner.mjs` 走 `dsh --profile sdk`，它的协议面只有
 * `initialize`/`session/prompt`/`shutdown`，且 `session/prompt` 的服务端实现**恒为**
 * `ctx.agents.create({sessionId})`（`dsh-sdk-jsonrpc-server/lib/index.js:143-155`），
 * 于是磁盘上已存在的会话必然抛 `-32603 session "…" already exists`
 * （`dsh-session/lib/index.js:1686`）。那条路**在物理上**无法续聊既有会话。
 *
 * 桌面端 runtime 则不然：它的会话控制器 `ensureSession()` + `composeAgent(presetId)`
 * （`dsh-api-session-controller/lib/index.js:253-275` 与 `:358-371`）以 preset 运行时组合的
 * 方式恢复**任何**它索引到的会话。所以「手机继续电脑的会话」必须走这里，而不是 SDK。
 *
 * ## 线协议（全部实测确认，2026-10，桌面端 0.2.0-rc.2）
 *
 * - 单次调用：`POST http://127.0.0.1:<port>/api/<namespace>/<method>`
 *   body `{type:'client-request', rpcId, method:'<ns>/<method>', payload:{args:{…}}}`
 *   → `{result:{ok:true,value}}` | `{result:{ok:false,error:{code,message}}}`
 * - 流式方法：`WS ws://127.0.0.1:<port>/api/remote.mux`
 *   发 `{type:'open',streamId,endpoint,payload}` → 收 `{type:'item',streamId,value}`
 *   / `{type:'end',streamId}` / `{type:'error',streamId,error}`
 * - `args` 的字段名必须与方法的**形参名逐字一致**（否则 `gateway/arguments-invalid`）。
 *   注意 `session/list` 的形参是 `_request`，其余多为 `request`。
 *
 * ## 鉴权
 *
 * `/api` 只要求一个**签名 cookie**：`dsh-auth-<base64url(sha256(authority))>`，
 * 值 `v1.<base64url(body)>.<base64url(HMAC-SHA256(secretBytes, body))>`，
 * secret 是 `$DSH_HOME/.credentials.yaml` 里 `client-connection/browser-session` 记录的
 * 32 字节密钥（base64url）。Host 头必须是回环地址（非浏览器客户端因此天然过 trust fence）。
 *
 * 这一层刻意做成**单一适配层**：DSH 升级若改动未公开线协议，只需要改这一个文件，
 * 而且调用方可以捕获 `DesktopApiError` 回退到既有 SDK 路线。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 桌面端 Web 运行时的默认端口（桌面端固定用它；`--port 0` 的独立实例不适用）。 */
export const DEFAULT_DESKTOP_PORT = 19387;

/**
 * 桌面端默认 home 的目录名（`$USERPROFILE/.dsh`）。
 *
 * 为什么需要一个"第二个候选"：桌面端 Web 运行时（DSH Harness）恒定用
 * `$USERPROFILE/.dsh` 作为自己的 home —— 那是**用户级**目录，与网关自己的 home
 * （`--home C:\Users\…\.dsh-remote`）没有关系。网关的凭据在 `.dsh-remote/.credentials.yaml`
 * 里（只有 `DEEPSEEK_API_KEY`），`client-connection/browser-session` 只在桌面端那个 home 里。
 * 真机实测：主 `dshHome` 里**没有**这条记录，于是 `cookieHeader()` 抛
 * `desktop_unavailable`，桌面端通道与审批桥全部不可用 —— 而配置里什么都没写错。
 *
 * 所以这里把"找得到桌面端凭据的那个 home"作为默认发现目标：显式配置永远优先，
 * 只有显式路径拿不到凭据时才回退（见 [DesktopApi.#resolveCredentialsHome]）。
 */
export const DEFAULT_DESKTOP_HOME_DIRNAME = '.dsh';

/** 单次 RPC 默认超时。 */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** 流式订阅默认超时（`session/follow` 是长连接，取一个足够大的值）。 */
const DEFAULT_STREAM_TIMEOUT_MS = 600_000;

/** 可注入的 WebSocket 实现（Node 22+ 的全局 `WebSocket`）。 */
const defaultWebSocket = () => globalThis.WebSocket;

/** 携带契约错误码的客户端异常。 */
export class DesktopApiError extends Error {
  /**
   * @param {string} code 网关/桌面端错误码，或本层的 `desktop_unavailable` / `transport_failure` / `timeout`
   * @param {string} message
   * @param {{status?: number, cause?: unknown}} [extra]
   */
  constructor(code, message, { status = 0, cause = undefined } = {}) {
    super(message);
    this.name = 'DesktopApiError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

/** base64url 编码（无 padding，URL 安全字母表）。 */
export function encodeBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 解码（容忍标准 base64 的 `+`/`/` 与缺失 padding）。 */
export function decodeBase64Url(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

/**
 * 从 `.credentials.yaml` 文本里取出 browser-session 的密钥。
 *
 * 刻意不引入 YAML 依赖：凭据文件是 DSH 自己生成的**固定形状**（缩进两格的记录名，
 * 其下嵌套 `payload.secret`），用极小状态机扫一段比拖一个解析器进零依赖网关更划算。
 * 形状不符时返回 null，由调用方转成 `desktop_unavailable`。
 *
 * @param {string} text
 * @returns {{secret: Buffer, secretText: string}|null}
 */
export function parseBrowserSessionSecret(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split(/\r?\n/);
  let inRecord = false;
  let recordIndent = -1;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (!inRecord) {
      if (line.trim() === 'client-connection/browser-session:') {
        inRecord = true;
        recordIndent = indent;
      }
      continue;
    }
    // 同级的下一记录（或更浅的键）意味着本记录结束。
    if (indent <= recordIndent) break;
    const match = /^secret:\s*(\S+)\s*$/.exec(line.trim());
    if (match) {
      const secret = decodeBase64Url(match[1]);
      if (secret.length === 0) return null;
      return { secret, secretText: match[1] };
    }
  }
  return null;
}

/**
 * 组装 `/api` 用的签名 cookie。
 *
 * body 与签名的字节序必须完全一致 —— 先 `JSON.stringify` 再 base64url，
 * 签名对象就是同一串 base64url 文本（`dsh-client-connection/lib/index.js:299-305`）。
 *
 * @param {{secret: Buffer, authority: string, now: number, ttlMs?: number}} opts
 * @returns {{name: string, value: string, header: string}}
 */
export function buildAuthCookie({ secret, authority, now, ttlMs = 86_400_000 }) {
  const body = encodeBase64Url(
    Buffer.from(
      JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + ttlMs }),
      'utf8',
    ),
  );
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest());
  const name = `dsh-auth-${encodeBase64Url(createHash('sha256').update(authority).digest())}`;
  const value = `v1.${body}.${signature}`;
  return { name, value, header: `${name}=${value}` };
}

/**
 * 桌面端 runtime 的 RPC 客户端。
 */
export class DesktopApi {
  /**
   * @param {{
   *   dshHome?: string|null,        // 读凭据的 DSH home（默认 ~/.dsh）
   *   port?: number,                // 桌面端 Web 运行时端口
   *   host?: string,                // 默认 127.0.0.1（必须回环才能过 trust fence）
   *   logger?: object|null,
   *   now?: () => number,
   *   fetchImpl?: Function|null,
   *   webSocketImpl?: Function|null,
   *   rpcTimeoutMs?: number,
   *   streamTimeoutMs?: number,
   *   readFileImpl?: Function,
   *   existsImpl?: Function,
   *   homedirImpl?: () => string,
   *   discoverHome?: string|null,   // 凭据自动发现的目标 home（默认 `~/.dsh`；null = 关闭发现）
   * }} [opts]
   */
  constructor({
    dshHome = null,
    port = DEFAULT_DESKTOP_PORT,
    host = '127.0.0.1',
    logger = null,
    now = Date.now,
    fetchImpl = null,
    webSocketImpl = null,
    rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    streamTimeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
    readFileImpl = readFileSync,
    existsImpl = existsSync,
    homedirImpl = homedir,
    discoverHome = undefined,
  } = {}) {
    this.dshHome = dshHome ?? join(homedirImpl(), '.dsh');
    this.host = host;
    this.port = port;
    this.authority = `${host}:${port}`;
    this.baseUrl = `http://${host}:${port}`;
    this.streamUrl = `ws://${host}:${port}/api/remote.mux`;
    this.logger = logger;
    this.now = now;
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    this.webSocketImpl = webSocketImpl;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.streamTimeoutMs = streamTimeoutMs;
    this.readFileImpl = readFileImpl;
    this.existsImpl = existsImpl;
    /**
     * 凭据发现的目标（undefined = 用默认 `~/.dsh`；显式 `null` = 关闭发现）。
     * 显式传了 `dshHome` 也**不**关闭发现：真机上"配了 home 但里面没有 browser-session"
     * 正是最常见的失败形态，只有主路径拿不到凭据时才回退，显式配置因此仍然优先。
     */
    this.discoverHome = discoverHome === undefined ? join(homedirImpl(), DEFAULT_DESKTOP_HOME_DIRNAME) : discoverHome;
    /** 初次构造时请求的 home（诊断用：能看出是不是"回退之后"的路径）。 */
    this.configuredHome = dshHome ?? null;
    /** @type {{secret: Buffer, secretText: string}|null} */
    this.credentials = null;
    /** 凭据解析失败的原因（诊断用）。 */
    this.credentialsError = null;
    /** 是否走了凭据发现（诊断用：`true` 表示显式 home 里没有凭据）。 */
    this.credentialsDiscovered = false;
    /** 缓存的 cookie（签名无状态，可复用；过期前刷新）。 */
    this.cookieCache = null;
  }

  /** 凭据文件路径（`$DSH_HOME/.credentials.yaml`）。 */
  get credentialsPath() {
    return join(this.dshHome, '.credentials.yaml');
  }

  /**
   * 依次尝试的凭据 home：显式/默认 home 优先，发现目标兜底（去重）。
   *
   * @returns {string[]}
   */
  credentialHomes() {
    const out = [this.dshHome];
    if (typeof this.discoverHome === 'string' && this.discoverHome.length > 0 && this.discoverHome !== this.dshHome) {
      out.push(this.discoverHome);
    }
    return out;
  }

  /**
   * 读取并解析凭据。返回是否成功（失败不抛，便于调用方按「桌面端不可用」降级）。
   *
   * 找到之后会把 [dshHome] **改写成**命中的那个 home：`authority` 与 cookie 不变，
   * 但后续的 `credentialsPath`、报错文案、诊断都指向真实使用的那份凭据 —— 否则
   * 排障时会看到"说好的路径里有凭据，为什么还说不可用"这种自相矛盾的状态。
   *
   * @returns {boolean}
   */
  loadCredentials() {
    const homes = this.credentialHomes();
    const failures = [];
    for (const home of homes) {
      const path = join(home, '.credentials.yaml');
      let text;
      try {
        if (!this.existsImpl(path)) {
          failures.push(`凭据文件不存在：${path}`);
          continue;
        }
        text = this.readFileImpl(path, 'utf8');
      } catch (err) {
        failures.push(`读取凭据失败：${path}（${String(err?.message ?? err)}）`);
        continue;
      }
      const parsed = parseBrowserSessionSecret(String(text));
      if (!parsed) {
        failures.push(`凭据文件里没有 client-connection/browser-session 记录：${path}`);
        continue;
      }
      const discovered = home !== homes[0];
      this.dshHome = home;
      this.credentials = parsed;
      this.credentialsError = null;
      this.credentialsDiscovered = discovered;
      if (discovered) {
        // 只在**真的换了 home** 时记一行：它是"默认配置即可用"的关键证据，
        // 而常规路径每 24h 才走一次这里，噪声可忽略。
        this.logger?.info?.(`桌面端凭据自动发现：显式 home 里没有 browser-session，改用 ${path}`);
      }
      return true;
    }
    this.credentials = null;
    this.credentialsDiscovered = false;
    this.credentialsError = failures.join('；') || '没有可用的凭据路径';
    return false;
  }

  /** 当前有效的 cookie 头（必要时刷新）。 */
  cookieHeader() {
    const now = this.now();
    if (this.cookieCache && this.cookieCache.expiresAt - 60_000 > now) return this.cookieCache.header;
    if (!this.credentials && !this.loadCredentials()) {
      throw new DesktopApiError('desktop_unavailable', this.credentialsError ?? '桌面端凭据不可用');
    }
    const built = buildAuthCookie({ secret: this.credentials.secret, authority: this.authority, now });
    // body 里的 expiresAt 就是 now + 24h，这里同步记录，避免重复解析。
    this.cookieCache = { header: built.header, name: built.name, value: built.value, expiresAt: now + 86_400_000 };
    return built.header;
  }

  /** 请求头（含 Host，保证 trust fence 走回环分支）。 */
  headers() {
    return {
      host: this.authority,
      cookie: this.cookieHeader(),
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  /**
   * 单次 RPC。成功返回 `value`，失败抛 [DesktopApiError]。
   *
   * @param {string} endpoint `<namespace>/<method>`，例如 `session/list`
   * @param {object} args 形参名 → 值（必须逐字匹配方法签名）
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<any>}
   */
  async call(endpoint, args = {}, { timeoutMs = this.rpcTimeoutMs, signal = null } = {}) {
    const outcome = await this.callRaw(endpoint, args, { timeoutMs, signal });
    if (!outcome.ok) throw new DesktopApiError(outcome.error.code, outcome.error.message);
    return outcome.value;
  }

  /**
   * 单次 RPC，**不抛错**，返回判别联合（供需要区分「桌面端不可达」与「业务拒绝」的调用方）。
   * @returns {Promise<{ok: true, value: any} | {ok: false, error: {code: string, message: string}}>}
   */
  async callRaw(endpoint, args = {}, { timeoutMs = this.rpcTimeoutMs, signal = null } = {}) {
    if (typeof this.fetchImpl !== 'function') {
      return { ok: false, error: { code: 'desktop_unavailable', message: '运行环境没有 fetch（需要 Node 18+）' } };
    }
    let headers;
    try {
      headers = this.headers();
    } catch (err) {
      return { ok: false, error: { code: err.code ?? 'desktop_unavailable', message: String(err.message ?? err) } };
    }
    const rpcId = randomUUID();
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('rpc timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/${endpoint}`, { method: 'POST', headers, body, signal: controller.signal });
      if (res.status === 401 || res.status === 403) {
        // 401 = cookie 不被接受（secret 轮换 / Host 不对）；403 = trust fence 拒绝。
        this.cookieCache = null;
        return { ok: false, error: { code: 'desktop_unauthorized', message: `桌面端拒绝该请求（HTTP ${res.status}）：${this.baseUrl}/api/${endpoint}` } };
      }
      if (res.status === 404) {
        return { ok: false, error: { code: 'desktop_no_route', message: `桌面端没有该接口：${endpoint}` } };
      }
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, error: { code: 'transport_failure', message: `桌面端响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}` } };
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.result) {
        return { ok: false, error: { code: 'transport_failure', message: `桌面端响应缺少 result 信封：${text.slice(0, 200)}` } };
      }
      if (parsed.result.ok) return { ok: true, value: parsed.result.value };
      const error = parsed.result.error ?? {};
      return { ok: false, error: { code: String(error.code ?? 'desktop_error'), message: String(error.message ?? '桌面端返回未知错误') } };
    } catch (err) {
      const aborted = controller.signal.aborted;
      const code = aborted ? (signal?.aborted ? 'aborted' : 'timeout') : 'desktop_unreachable';
      const message = aborted
        ? `${endpoint} 超时（${timeoutMs}ms）或已取消`
        : `无法连接桌面端 runtime（${this.baseUrl}）：${String(err?.message ?? err)}`;
      return { ok: false, error: { code, message } };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 连通性与能力探测：用一个极小 `session/list` 验证凭据与线协议都还成立。
   *
   * 刻意不用 `/api/health`：桌面端**没有**这个路由（实测 404），
   * 而 404 与「鉴权失败」在诊断上必须区分开 —— 用真实业务方法探活最直接。
   *
   * @returns {Promise<{ok: boolean, sessionCount?: number, desktopVersion?: string|null, error?: {code: string, message: string}}>}
   */
  async probe() {
    const outcome = await this.callRaw('session/list', { _request: {} });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    const items = Array.isArray(outcome.value?.items) ? outcome.value.items : [];
    return { ok: true, sessionCount: items.length };
  }

  // ---- 会话 ----

  /**
   * `session/list`：桌面端索引到的全部会话（含 subagent）。
   *
   * 实测形状 `{items:[{sessionId, running, agentAvailable, blank, cwd?, parentSessionId?, origin?,
   * projections:{kind, asOfSeq, values:{…}}}]}`（`typert.remote-client.js:441-448`）。
   * 注意形参名是 `_request` 而不是 `request` —— 写错会得到
   * `gateway/arguments-invalid: args fields do not match the descriptor`。
   */
  async listSessions() {
    const value = await this.call('session/list', { _request: {} });
    return Array.isArray(value?.items) ? value.items : [];
  }

  /** `session/projections`：单个会话的投影（形参 `request: {sessionId}`，不是数组）。 */
  async projections(sessionId) {
    return this.call('session/projections', { request: { sessionId } });
  }

  /**
   * `session/page`：按 seq 读转录。
   * @param {{sessionId: string, throughSeq?: number, beforeSeq?: number|null, maxMessages?: number}} input
   */
  async page({ sessionId, throughSeq = Number.MAX_SAFE_INTEGER, beforeSeq = null, maxMessages = 50 }) {
    return this.call('session/page', {
      request: { address: { kind: 'session', sessionId }, throughSeq, ...(beforeSeq === null ? {} : { beforeSeq }), maxMessages },
    });
  }

  /** `session/create`：新建会话（`cwd` 决定工作区；`sessionId` 可选以便网关自己定 id）。 */
  async createSession({ cwd = undefined, workspaceId = undefined, sessionId = undefined, agentPreset = undefined } = {}) {
    const request = {};
    if (cwd !== undefined) request.cwd = cwd;
    if (workspaceId !== undefined) request.workspaceId = workspaceId;
    if (sessionId !== undefined) request.sessionId = sessionId;
    if (agentPreset !== undefined) request.agentPreset = agentPreset;
    return this.call('session/create', { request });
  }

  /** `session/fork`：从某个 seq 之前分叉出一个新会话（不动原会话）。 */
  async forkSession({ sessionId, atSeq = undefined }) {
    return this.call('session/fork', { request: atSeq === undefined ? { sessionId } : { sessionId, atSeq } });
  }

  /**
   * `session/prompt`：投递一轮。
   * @param {{sessionId: string, text?: string|null, content?: object[]|null, mode?: 'queue'|'steer', clientTimeZone?: string|null}} input
   */
  async prompt({ sessionId, text = null, content = null, mode = 'queue', clientTimeZone = null }) {
    const blocks = Array.isArray(content) && content.length > 0 ? content : text === null ? [] : [{ type: 'text', text: String(text) }];
    if (blocks.length === 0) throw new DesktopApiError('bad_request', 'prompt 需要 text 或 content');
    const request = { requestId: randomUUID(), sessionId, mode, content: blocks };
    if (clientTimeZone) request.clientTimeZone = clientTimeZone;
    return this.call('session/prompt', { request }, { timeoutMs: 60_000 });
  }

  /** `session/cancel`：取消当前轮次（桌面端**有** cancel，这是相对 SDK 路线的额外能力）。 */
  async cancel(sessionId) {
    return this.call('session/cancel', { request: { sessionId } });
  }

  // ---- 模型（契约 §4.7 / §7.8 的模型选择器；手机端 `GET /api/v2/models` 的真值来源）----

  /**
   * `session/modelCatalog`：桌面端当前可选的全部模型（分组 + 默认项 + 采集失败项）。
   *
   * **形参为空**：`@Remote('modelCatalog') modelCatalog(): Promise<ModelCatalog>` 一个参数都没有，
   * 而网关的 RPC 入口做的是**逐字精确匹配**（多一个键就是
   * `gateway/arguments-invalid: args fields do not match the descriptor`），
   * 所以这里只能传 `{}` —— 不能像 `listSessions()` 那样塞 `{_request:{}}`。
   *
   * 返回形状（`typert.remote-client.js` 的 zod schema，实测字段名逐字如下）：
   * `{default:{provider,model,reasoningEffort?}, routableProviders:string[],
   *   groups:[{id,name,models:[{id,name,description?,reasoning?:{efforts:[{id,name,description?}],defaultEffort?}}]}],
   *   failures:[{id,name,message}]}`
   */
  async modelCatalog() {
    return this.call('session/modelCatalog');
  }

  /**
   * `session/selectModel`：把某个会话（以及桌面端自己的默认模型）切到指定 provider/model。
   *
   * 两个必须写下来的语义（都影响"手机端选模型"的产品行为）：
   * 1. 桌面端自己的 docstring 是「在**显式 resume 会话之后**切换会话级模型；默认模型后台保存」——
   *    也就是说它**同时**会改掉桌面端的默认模型。这正是用户在桌面端 GUI 里点一次模型的效果，
   *    所以照原样使用是合理的；但它意味着手机端换一次模型会改变电脑端后续新会话的默认选择。
   * 2. `reasoningEffort` 是**可选**的：桌面端 schema 里它是 `.optional()`，缺省即"沿用该模型自己的
   *    默认档"。因此只传调用方真的给了的值，绝不塞 `undefined`（严格模式下多余键会被拒）。
   *
   * @param {{sessionId: string, provider: string, model: string, reasoningEffort?: string|null}} input
   * @returns {Promise<{selected: {provider: string, model: string, reasoningEffort?: string}}>}
   */
  async selectModel({ sessionId, provider, model, reasoningEffort = null }) {
    const request = { sessionId, provider, model };
    if (reasoningEffort !== null && reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort;
    return this.call('session/selectModel', { request });
  }

  // ---- 工作区 ----

  /** `workspace/create`：把一个已存在目录登记为工作区（幂等）。 */
  async createWorkspace(path) {
    return this.call('workspace/create', { request: { path } });
  }

  /** `workspace/insertSessionBefore`：把会话登记进工作区列表（手机新建的会话要靠它出现在电脑端 UI 里）。 */
  async insertSessionBefore({ sessionId, beforeSessionId = null, workspaceId }) {
    const request = { sessionId };
    if (beforeSessionId) request.beforeSessionId = beforeSessionId;
    if (workspaceId) request.workspaceId = workspaceId;
    return this.call('workspace/insertSessionBefore', { request });
  }

  /** `directoryPicker/list`：列一层目录（用于让手机浏览 PC 文件系统的目录）。 */
  async listDirectory(path) {
    return this.call('directoryPicker/list', { path });
  }

  /**
   * 打开一个 WebSocket 载体上的流式方法，逐个产出 `item` 的 value。
   *
   * 只负责**载体**：`session/follow` 的业务语义（断线补读、事件翻译）在上层。
   * 失败与结束都通过返回值表达，不在这里重试 —— 重试策略属于业务。
   *
   * @param {{endpoint: string, args?: object, signal?: AbortSignal|null, timeoutMs?: number, maxItems?: number|null}} input
   * @returns {AsyncGenerator<any, {ended: boolean, error: {code: string, message: string}|null}>}
   */
  async *openStream({ endpoint, args = {}, signal = null, timeoutMs = this.streamTimeoutMs, maxItems = null }) {
    const WebSocketImpl = this.webSocketImpl ?? defaultWebSocket();
    if (typeof WebSocketImpl !== 'function') {
      return { ended: false, error: { code: 'desktop_unavailable', message: '运行环境没有 WebSocket（需要 Node 22+）' } };
    }
    let headers;
    try {
      headers = { host: this.authority, cookie: this.cookieHeader() };
    } catch (err) {
      return { ended: false, error: { code: err.code ?? 'desktop_unavailable', message: String(err.message ?? err) } };
    }
    const streamId = randomUUID();
    const socket = new WebSocketImpl(this.streamUrl, { headers });
    /** @type {any[]} */
    const queue = [];
    let notify = null;
    let settled = null; // {ended, error}
    const wake = () => {
      const fn = notify;
      notify = null;
      fn?.();
    };
    const timer = setTimeout(() => {
      settled = { ended: false, error: { code: 'timeout', message: `${endpoint} 流超时（${timeoutMs}ms）` } };
      try { socket.close(); } catch { /* 忽略关闭失败 */ }
      wake();
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      settled = settled ?? { ended: false, error: { code: 'aborted', message: '订阅已取消' } };
      try { socket.close(); } catch { /* 忽略 */ }
      wake();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
      } catch (err) {
        settled = { ended: false, error: { code: 'transport_failure', message: String(err?.message ?? err) } };
        wake();
      }
    });
    socket.addEventListener('message', (ev) => {
      let frame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (frame.streamId !== undefined && frame.streamId !== streamId) return;
      if (frame.type === 'item') {
        queue.push(frame.value);
        if (maxItems !== null && queue.length >= maxItems) {
          settled = settled ?? { ended: false, error: null };
          try { socket.send(JSON.stringify({ type: 'cancel', streamId })); socket.close(); } catch { /* 忽略 */ }
        }
        wake();
        return;
      }
      if (frame.type === 'end') {
        settled = { ended: true, error: null };
        wake();
        return;
      }
      if (frame.type === 'error') {
        settled = { ended: false, error: { code: String(frame.error?.code ?? 'desktop_error'), message: String(frame.error?.message ?? '流式方法返回错误') } };
        wake();
      }
    });
    socket.addEventListener('error', () => {
      settled = settled ?? { ended: false, error: { code: 'desktop_unreachable', message: `流式连接失败：${this.streamUrl}` } };
      wake();
    });
    socket.addEventListener('close', () => {
      settled = settled ?? { ended: false, error: { code: 'desktop_disconnected', message: '流式连接被关闭' } };
      wake();
    });

    try {
      while (true) {
        while (queue.length > 0) {
          const value = queue.shift();
          yield value;
          if (settled && queue.length === 0) break;
        }
        if (settled && queue.length === 0) return settled;
        if (signal?.aborted) return { ended: false, error: { code: 'aborted', message: '订阅已取消' } };
        await new Promise((resolve) => { notify = resolve; });
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { socket.close(); } catch { /* 忽略 */ }
    }
  }

  /**
   * `session/follow`：跟一个会话的实时事件。
   * @param {string} sessionId
   * @param {{assistantStream?: boolean, maxMessages?: number|null, signal?: AbortSignal|null, timeoutMs?: number}} [opts]
   */
  openFollow(sessionId, { assistantStream = true, maxMessages = null, signal = null, timeoutMs = this.streamTimeoutMs } = {}) {
    const request = { address: { kind: 'session', sessionId }, assistantStream };
    if (maxMessages !== null) request.maxMessages = maxMessages;
    return this.openStream({ endpoint: 'session/follow', args: { request }, signal, timeoutMs });
  }
}

/**
 * `session/follow` 的事件翻译：桌面端事件 → 手机端 SSE 词汇（`session-live.mjs` 的 STREAM_EVENTS）。
 *
 * 为什么在网关侧翻译而不是让 Android 端认两套词汇：契约 v2 §4.2 已经冻结了
 * `turn.started` / `message.delta` / `tool.call` / `turn.ended` 这套名字，
 * 手机端的 reducer 与单测都建立在它上面；在网关做一次映射，客户端零改动即可
 * 同时吃下「网关 SDK 会话」与「电脑端会话」两种来源。
 *
 * @param {any} value `session/follow` 产出的 snapshot 或 event 包装
 * @returns {{type: string, data: object}|null} null = 该事件对手机端无意义，丢弃
 */
export function translateDesktopEvent(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type !== 'event') return null;
  const event = value.event ?? {};
  const type = String(event.type ?? '');
  const data = event.data ?? {};
  const seq = typeof event.seq === 'number' ? event.seq : null;
  switch (type) {
    case 'turn/start':
      return { type: 'turn.started', data: { turn: data.turn ?? null, seq } };
    case 'turn/end':
      return { type: 'turn.ended', data: { turn: data.turn ?? null, seq, reason: data.reason?.kind ?? data.reason ?? null, usage: data.usage ?? null } };
    case 'step/end':
      return { type: 'session.updated', data: { seq, step: data.step ?? null, usage: data.usage ?? null } };
    case 'assistant/message': {
      const { text, reasoning } = extractAssistantText(data);
      if (reasoning) return { type: 'message.delta', data: { seq, role: 'assistant', channel: 'reasoning', text: reasoning } };
      if (!text) return null;
      return { type: 'message.delta', data: { seq, role: 'assistant', channel: 'text', text } };
    }
    case 'tool/call':
      return { type: 'tool.call', data: { seq, name: data.name ?? data.toolName ?? null, args: data.args ?? data.input ?? null, callId: data.callId ?? data.id ?? null } };
    case 'tool/result':
      return {
        type: 'tool.result',
        data: {
          seq,
          callId: data.callId ?? data.id ?? null,
          name: data.name ?? data.toolName ?? null,
          result: data.result ?? data.output ?? data.content ?? null,
          isError: Boolean(data.isError ?? data.error),
        },
      };
    default:
      return null;
  }
}

/**
 * 从 `assistant/message` 的 data 里取文本。
 *
 * DSH 的消息体是 content blocks 数组，文本块形如 `{type:'text', text}`；
 * 桌面端不同版本可能给字符串、数组或 `{content:[…]}`，这里都兼容。
 *
 * @param {any} data
 * @returns {{text: string, reasoning: string}}
 */
export function extractAssistantText(data) {
  if (data === null || data === undefined) return { text: '', reasoning: '' };
  if (typeof data === 'string') return { text: data, reasoning: '' };
  const blocks = Array.isArray(data) ? data : Array.isArray(data.content) ? data.content : Array.isArray(data.message?.content) ? data.message.content : null;
  if (!blocks) {
    const direct = typeof data.text === 'string' ? data.text : '';
    const reasoningDirect = typeof data.reasoning === 'string' ? data.reasoning : '';
    return { text: direct, reasoning: reasoningDirect };
  }
  let text = '';
  let reasoning = '';
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const kind = String(block.type ?? '');
    if (kind === 'text' && typeof block.text === 'string') text += block.text;
    else if ((kind === 'reasoning' || kind === 'thinking') && typeof block.text === 'string') reasoning += block.text;
  }
  return { text, reasoning };
}

/**
 * 判断一个会话 id 是不是桌面端原生会话（`session-<uuid>`），供网关做来源分派与路由防穿越。
 * @param {string} value
 */
export function isDesktopSessionId(value) {
  return /^session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(value ?? ''));
}
