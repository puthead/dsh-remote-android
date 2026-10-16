/**
 * 会话续聊：以 **SDK profile（`dsh --profile sdk`，stdio JSON-RPC）** 为引擎（契约 §4.2 / §5.3）。
 *
 * ## 为什么不是 `dsh headless --json --session-id`（实测结论）
 * headless 是"一次性 runner"，它把工具直接组合在 base 上、**没有 preset realm**，
 * 因此**只能续聊它自己创建的会话**。对桌面端会话（`agentPreset:"standard"`）会直接失败：
 * ```
 * {"type":"error","message":"session \"session-f8a66cee…\" runs under agent preset \"standard\",
 *  which the one-shot runner does not compose"}
 * ```
 * 官方 SDK profile 是 stdio 上的 JSON-RPC 常驻服务：一次 `initialize` 后可以**多轮**
 * `session/prompt`，轮次之间进程存活、上下文与 KV cache 都留着。实测（隔离 home）：
 * 第一轮"请记住 7413，只回复 OK"，第二轮"我让你记住的数字是多少" → 回 `7413`，两轮都 `reason.kind=completed`。
 *
 * ## 启动形状（不要用 `dsh.cmd`）
 * Windows 上 Node 对 `.bat/.cmd` 直接 `spawn` 会 `EINVAL`，而开 `shell:true` 等于把
 * 手机发来的 prompt 拼进命令行（含 `& | ^ % "` 时就是命令注入）。因此这里解析 `dsh.cmd`
 * 的内容拿到「Electron 可执行文件 + app.asar 里的 cli.js + 前缀参数」，直接 spawn：
 * ```
 * cmd : D:\DSH\DeepSeek Harness.exe
 * args: --expose-internals <…>\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js --profile sdk
 * env : ELECTRON_RUN_AS_NODE=1  DSH_HOME=<网关自己的 sessions home>  DEEPSEEK_API_KEY=<从 .credentials.yaml 读出>
 * ```
 *
 * ## 三条实测约束（决定了本模块的形状）
 * 1. **会话 id 由客户端给**：`session/prompt{sessionId}` 会 `ctx.agents.create({sessionId})`，
 *    所以新建会话时 id 由我们（或手机）指定；留空会得到服务端生成的 id。
 * 2. **一个会话只能被创建它的那个进程使用**：新进程对既有会话 `session/prompt` 会得到
 *    `-32603 session "…" already exists`。因此网关**按需常驻**一个进程服务一个会话，
 *    且**重启后旧会话不可续聊**（`resumable:false`）—— 这一点必须如实告诉手机，不能假装能续。
 * 3. **没有 cancel 方法**（协议明文："a client abandons a turn by closing the runtime process"）。
 *    所以 `abort` 只能杀进程，杀完该会话同样不再可续 —— 与 2 是同一个根因。
 *
 * ## 与镜像的关系（lead 裁定）
 * `~/.dsh`（用户的真实 home）是**只读镜像**：里面的桌面端会话一律 `writable:false`，
 * 任何 `POST /turns` 都返回 `409 session_busy` + "该会话正由电脑端驱动"。
 * 可续聊的只有网关自己在 `dsh.sessionsHome` 下创建的会话。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildChildEnv, killProcessTree } from './runner.mjs';
import { ACCESS_WORKSPACE, describeAccess, permissionModeFor } from './permission.mjs';
import { STREAM_EVENTS } from './session-live.mjs';
import { newRunId } from './util.mjs';
import { DesktopApi, DEFAULT_DESKTOP_PORT, extractAssistantText, translateDesktopEvent } from './desktop-api.mjs';
import { DesktopTurnWatcher } from './desktop-watch.mjs';
import { isDerivedSession } from './dsh-home.mjs';

/** 默认的 dsh 启动器候选（按顺序探测，第一个存在的胜出）。 */
export const DEFAULT_LAUNCHER_CANDIDATES = Object.freeze([
  'D:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd',
  'D:\\DSH\\resources\\runtime\\cli\\bin\\dsh',
]);

/** SSE 事件的来源标识：SDK 轮次来自手机会话。 */
const PHONE_SOURCE = 'phone';

/**
 * SSE 事件的来源标识：**电脑端会话由桌面端 DSH runtime 驱动**（契约 §4.2 / §7）。
 *
 * 手机在这一类会话上投递的轮次跑在电脑上的桌面端进程里，所以事件带 `source:'computer'`，
 * 手机端据此把该会话显示为"电脑"并在旁边显示"手机已接入"。
 */
const COMPUTER_SOURCE = 'computer';

/**
 * `driver` 的契约取值（协议契约 §7.5）：**谁在驱动这一轮 / 这个会话**。
 *
 * 必须与 `http.mjs` 里的同名常量保持一致 —— 列表、详情、轮次回执、中止回执四处
 * 用的是同一个词汇，客户端才能只在一处判定。
 */
const DRIVER_DESKTOP = 'desktop';
const DRIVER_GATEWAY = 'gateway';

/** SDK profile 名。 */
export const SDK_PROFILE = 'sdk';

/** wire-stable 服务端标识（协议明文）。 */
export const SDK_SERVER_NAME = 'deepseek-harness-sdk-runtime';

/**
 * `turn/end` 之后等待 `session.status:idle` 的兜底时长。
 * 超时即强制收束，避免占用表被永久占住（那会让该会话再也无法续聊）。
 */
export const IDLE_FALLBACK_MS = 15_000;

/**
 * 数出 content 里的图片张数与**解码后**总字节数（只用于日志与限额）。
 *
 * 为什么不去 `Buffer.from(data,'base64')` 真解码：这里唯一的用途是写日志，
 * 而解码会把几 MB 的图片在网关进程里再复制一份。`data` 已在
 * `http.mjs` 的 `validateTurnContent()` 里过了严格 base64 校验（含填充位），
 * 所以按 base64 长度换算就足够精确：`floor(len/4)*3 - 填充字节数`。
 *
 * 返回的只有两个数字，**绝不含图片内容本身** —— 日志里不许出现图片字节。
 * @param {unknown} content 归一化后的 ContentBlock[]（允许 null）
 * @returns {{count: number, bytes: number}}
 */
export function turnImageStats(content) {
  if (!Array.isArray(content)) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  for (const block of content) {
    if (block === null || typeof block !== 'object' || block.type !== 'image' || typeof block.data !== 'string') continue;
    count += 1;
    const padding = block.data.endsWith('==') ? 2 : block.data.endsWith('=') ? 1 : 0;
    bytes += Math.floor((block.data.length / 4) * 3) - padding;
  }
  return { count, bytes };
}

/**
 * 解析 dsh 启动器（`.cmd` / 无扩展 shim），抽出真正的可执行文件与脚本。
 *
 * 识别 `dsh.cmd` 这种形状：
 * ```
 * set "ELECTRON_RUN_AS_NODE=1"
 * "%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\..\app.asar\…\cli.js" %*
 * ```
 * 也兼容 POSIX shim：`exec node "/path/cli.js" "$@"`。
 * @param {string} text 启动器文件内容
 * @param {string} dir 启动器所在目录（用于展开 `%~dp0`）
 * @returns {{command: string, scriptPath: string, prefixArgs: string[], env: Record<string,string>}|null}
 */
export function parseDshLauncher(text, dir) {
  if (typeof text !== 'string' || !text) return null;
  const withSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const expand = (token) => token.replace(/%~dp0\\?/gi, withSep).replace(/%~dp0/gi, dir);
  const env = {};
  for (const match of text.matchAll(/set\s+"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"/g)) {
    env[match[1]] = expand(match[2]);
  }

  const unquote = (token) => {
    const t = token.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
    return t;
  };
  // 展开 `%~dp0` 后归一化（原始文本里带 `..\..\`，直接用也能跑，但日志/对比会很难看）。
  // **只归一化 Windows 绝对路径**：对 POSIX 路径调 `path.resolve` 会把它变成
  // `D:\opt\dsh\cli.js` 这种凭空捏造的 Windows 路径（在本机验证 POSIX shim 时踩过）。
  const resolvePath = (token) => {
    const expanded = expand(token);
    return /^[A-Za-z]:[\\/]/.test(expanded) ? path.resolve(expanded) : expanded;
  };

  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const launchLines = lines.filter((l) => /%\*|"\$@"/.test(l) && !/^\s*(::|rem\b|#)/i.test(l));
  const candidateLines = launchLines.length > 0 ? launchLines : lines.filter((l) => /\.exe\b/i.test(l) || /\.js["'\s]/.test(l));

  for (const line of candidateLines) {
    const tokens = (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote).filter(Boolean);
    // 只剔除 shell 关键字，**保留 `node`** —— POSIX shim 的 interpreter 就是 `node`，
    // 上一版把它过滤掉会导致 `exec node "/…/cli.js" "$@"` 解析不出命令。
    const usable = tokens.filter((t) => !/^(set|setlocal|@echo|echo|exit|if|rem|::|exec|call|source)$/i.test(t) && !/%\*/.test(t) && !/^\$@$/.test(t));
    const scriptIndex = usable.findIndex((t) => /\.(c?js|mjs)$/i.test(t));
    if (scriptIndex === -1 || scriptIndex === 0) continue;
    const scriptPath = resolvePath(usable[scriptIndex]);
    const before = usable.slice(0, scriptIndex);
    // 命令 = 脚本之前的第一个非 flag token。不要求它长得像绝对路径：
    // `node`（POSIX shim）与 `"…\DeepSeek Harness.exe"`（Electron）都要能识别。
    const command = before.find((t) => !t.startsWith('-'));
    if (!command) continue;
    const prefixArgs = before.filter((t) => t !== command && t.startsWith('-'));
    return { command: resolvePath(command), scriptPath, prefixArgs, env };
  }
  return null;
}

/**
 * 解析出「怎么启动 dsh」。
 * 优先级：`dsh.electronPath` + `dsh.cliPath`（显式）> `dsh.launcher`（解析）> 默认候选（解析）> `dsh.node` + `dsh.binPath`（v1 形状兜底）。
 * @param {{dsh?: object, env?: Record<string,string|undefined>, existsSync?: Function, readFileSync?: Function}} [opts]
 * @returns {{command: string|null, argsPrefix: string[], env: Record<string,string>, source: string, supportsSdk: boolean}}
 */
export function resolveDshLaunch({ dsh = {}, env = process.env, existsSync = fs.existsSync, readFileSync = fs.readFileSync } = {}) {
  let parsed = null;
  let source = '';
  if (dsh.electronPath && dsh.cliPath) {
    parsed = { command: dsh.electronPath, scriptPath: dsh.cliPath, prefixArgs: dsh.exeArgs ?? ['--expose-internals'], env: {} };
    source = 'explicit';
  } else {
    // `autoDetectLauncher:false` 时**不把默认候选纳入**（部署希望"配置什么就是什么"，
    // 不受机器上 DSH 安装位置影响）。只在这里过滤一次，而不是事后兜底 ——
    // 事后兜底会让"已经探测到并解析成功"的结果仍然生效。
    const autoDetect = dsh.autoDetectLauncher !== false;
    const candidates = [dsh.launcher, env.DSH_REMOTE_DSH_LAUNCHER, ...(autoDetect ? DEFAULT_LAUNCHER_CANDIDATES : [])].filter((p) => typeof p === 'string' && p.trim());
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const spec = parseDshLauncher(readFileSync(candidate, 'utf8'), path.dirname(candidate));
        if (!spec) continue;
        parsed = { command: spec.command, scriptPath: spec.scriptPath, prefixArgs: spec.prefixArgs, env: spec.env };
        source = `launcher:${candidate}`;
        break;
      } catch {
        /* 试下一个候选 */
      }
    }
    if (!parsed && !autoDetect) return { command: null, argsPrefix: [], env: {}, source: 'disabled', supportsSdk: false };
  }
  if (parsed) {
    return {
      command: parsed.command,
      argsPrefix: [...(parsed.prefixArgs ?? []), parsed.scriptPath],
      env: { ...(parsed.env ?? {}), ELECTRON_RUN_AS_NODE: '1' },
      source,
      supportsSdk: true,
    };
  }
  if (dsh.node && dsh.binPath) {
    // v1 形状：旧版 CLI 没有 --profile sdk 的 JSON-RPC 服务端能力，明确标记不支持
    return { command: dsh.node, argsPrefix: [dsh.binPath], env: {}, source: 'node+binPath(v1)', supportsSdk: false };
  }
  return { command: null, argsPrefix: [], env: {}, source: 'none', supportsSdk: false };
}

/**
 * 从 DSH 凭据文件（`.credentials.yaml`）的 `refs:` 段读取 API key。
 *
 * 为什么需要：SDK profile 不像 headless 那样隐式读 `$DSH_HOME/.credentials.yaml`，
 * 它明确要求 `DEEPSEEK_API_KEY` 环境变量或凭据服务；否则每一轮都以
 * `{"kind":"error","error":{"code":"MISSING_CREDENTIAL"}}` 结束（实测）。
 * @param {{file: string, name: string, fsImpl?: object}} opts
 * @returns {Promise<Record<string,string>>} 空对象 = 没读到（调用方只警告，不阻断启动）
 */
export async function readCredentialEnv({ file, name, fsImpl = fs }) {
  if (!file) return {};
  let text;
  try {
    text = await fsImpl.promises.readFile(file, 'utf8');
  } catch {
    return {};
  }
  // 只解析 `refs:` 段下的 `KEY: value`（缩进两格），避免误取 records 里的其它字段
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (inRefs && /^\S/.test(line)) inRefs = false; // 回到顶层键
    if (!inRefs) continue;
    const match = new RegExp(`^\\s+${name}\\s*:\\s*(.+)$`).exec(line);
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, '');
      if (value) return { [name]: value };
    }
  }
  return {};
}

/**
 * 解析凭据文件候选路径：显式配置 > 镜像 home > 网关 home。
 * @param {object} config
 * @returns {string[]}
 */
export function credentialFileCandidates(config) {
  if (config.dsh?.credentialsFile) return [config.dsh.credentialsFile];
  const out = [];
  if (config.mirror?.resolvedHome) out.push(path.join(config.mirror.resolvedHome, '.credentials.yaml'));
  if (config.home) out.push(path.join(config.home, '.credentials.yaml'));
  if (config.dsh?.sessionsHome) out.push(path.join(config.dsh.sessionsHome, '.credentials.yaml'));
  return out;
}

/**
 * NDJSON 行切分器（stdout 是"一行一个 JSON-RPC 消息"，协议明文）。
 */
export class NdjsonSplitter {
  /** @param {{onLine: (msg: object) => void, onGarbage?: (line: string) => void}} opts */
  constructor({ onLine, onGarbage = null }) {
    this.onLine = onLine;
    this.onGarbage = onGarbage;
    this.buf = '';
    this.garbage = 0;
    this.bytes = 0;
  }

  push(chunk) {
    this.bytes += chunk.length;
    this.buf += chunk;
    let index;
    while ((index = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, index);
      this.buf = this.buf.slice(index + 1);
      this.#dispatch(line);
    }
  }

  flush() {
    const line = this.buf;
    this.buf = '';
    if (line.trim()) this.#dispatch(line);
  }

  #dispatch(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      this.onLine(JSON.parse(trimmed));
    } catch {
      // 协议明文：非 JSON 的行必须忽略（stdout 纯净性由 profile 保证，但用户插件可能破坏它）
      this.garbage += 1;
      this.onGarbage?.(trimmed.slice(0, 500));
    }
  }
}

/**
 * 一个 SDK 运行时进程（一个进程服务一个会话，按需常驻）。
 */
export class SdkRuntime {
  /**
   * @param {{sessionId: string, launch: object, cwd: string, env: Record<string,string>, logger?: object|null, spawnImpl?: Function, now?: Function, onEvent?: Function, onStatus?: Function, onExit?: Function, initTimeoutMs?: number}} opts
   */
  constructor({ sessionId, launch, cwd, env, logger = null, spawnImpl = spawn, now = Date.now, onEvent = null, onStatus = null, onExit = null, initTimeoutMs = 30_000 }) {
    this.sessionId = sessionId;
    this.launch = launch;
    this.cwd = cwd;
    this.env = env;
    this.logger = logger;
    // 同上：绝不让 null 传进 spawn
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : spawn;
    this.now = now;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onExit = onExit;
    this.initTimeoutMs = initTimeoutMs;

    this.child = null;
    this.pid = null;
    this.ready = false;
    this.serverInfo = null;
    this.stderr = '';
    this.garbage = 0;
    this.startedAt = null;
    this.lastActivityAt = null;
    this.turns = 0;
    /** @type {Map<number, {resolve: Function, timer: object, method: string}>} */
    this.pending = new Map();
    this.nextId = 1;
    this.exited = null;
    this.stopRequested = false;
    this.stopping = null;
  }

  /** 启动并完成 `initialize` 握手。 */
  async start() {
    const args = [...this.launch.argsPrefix, '--profile', SDK_PROFILE];
    this.child = this.spawnImpl(this.launch.command, args, {
      cwd: this.cwd,
      env: { ...this.env, ...this.launch.env },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.pid = this.child.pid ?? null;
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;

    const splitter = new NdjsonSplitter({
      onLine: (msg) => this.#onMessage(msg),
      onGarbage: (line) => {
        this.logger?.warn(`SDK 运行时输出非 JSON 行（已忽略）：${line.slice(0, 200)}`);
      },
    });
    this.splitter = splitter;
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk) => {
      try {
        splitter.push(chunk);
      } catch (err) {
        this.logger?.warn(`解析 SDK 输出失败：${err.message}`);
      }
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-16_384);
    });

    this.exited = new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      this.child.on('error', (err) => done({ code: null, signal: null, error: err.message }));
      this.child.on('close', (code, signal) => done({ code: code ?? null, signal: signal ?? null, error: null }));
    });
    void this.exited.then((result) => {
      this.ready = false;
      splitter.flush();
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.resolve({ error: { code: -32000, message: 'SDK 运行时已退出' } });
      }
      this.pending.clear();
      this.onExit?.(result, this);
    });

    const init = await this.#request(
      'initialize',
      {
        cwd: this.cwd,
        provider: this.launch.provider,
        model: this.launch.model,
        ...(this.launch.reasoningEffort ? { reasoningEffort: this.launch.reasoningEffort } : {}),
        ...(this.launch.maxTokens ? { maxTokens: this.launch.maxTokens } : {}),
      },
      { timeoutMs: this.initTimeoutMs },
    );
    if (init.error) throw new Error(`SDK initialize 失败：${init.error.message ?? JSON.stringify(init.error)}`);
    this.serverInfo = init.result?.serverInfo ?? null;
    if (this.serverInfo?.name && this.serverInfo.name !== SDK_SERVER_NAME) {
      this.logger?.warn(`SDK 服务端标识非预期：${this.serverInfo.name}（期望 ${SDK_SERVER_NAME}）`);
    }
    this.ready = true;
    this.logger?.info(`SDK 运行时就绪 sessionId=${this.sessionId} pid=${this.pid} cwd=${this.cwd} serverInfo=${JSON.stringify(this.serverInfo)}`);
    return this;
  }

  /** 发起一轮对话。 */
  async prompt(text) {
    if (!this.ready) throw new Error('SDK 运行时未就绪');
    this.lastActivityAt = this.now();
    this.turns += 1;
    const res = await this.#request('session/prompt', { sessionId: this.sessionId, contentBlocks: [{ type: 'text', text }] }, { timeoutMs: 60_000 });
    if (res.error) throw new Error(`session/prompt 失败：${res.error.code ?? ''} ${res.error.message ?? JSON.stringify(res.error)}`.trim());
    return res.result ?? {};
  }

  /** 空闲时长（用于回收）。 */
  idleMs() {
    return this.now() - (this.lastActivityAt ?? this.startedAt ?? this.now());
  }

  /** 发一个 JSON-RPC 请求。 */
  #request(method, params, { timeoutMs = 60_000 } = {}) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { code: -32001, message: `${method} 超时（${timeoutMs}ms）` } });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer, method });
      try {
        this.child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ error: { code: -32002, message: `写入 SDK stdin 失败：${err.message}` } });
      }
    });
  }

  /** 分发一条 JSON-RPC 消息。 */
  #onMessage(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        pending.resolve(msg);
      }
      return;
    }
    if (typeof msg.method !== 'string') return;
    this.lastActivityAt = this.now();
    if (msg.method === 'session.event') {
      const sessionId = msg.params?.sessionId;
      if (sessionId && sessionId !== this.sessionId) return; // 运行时可能服务多个会话，只关心自己的
      this.onEvent?.(msg.params?.event ?? {}, this);
      return;
    }
    if (msg.method === 'session.status') {
      const sessionId = msg.params?.sessionId;
      if (sessionId && sessionId !== this.sessionId) return;
      this.onStatus?.(msg.params?.status ?? 'unknown', this);
      return;
    }
    // subagent.started / subagent.finished：转发给上层（手机端可显示子代理活动）
    this.onEvent?.({ type: `__${msg.method}`, data: msg.params ?? {} }, this);
  }

  /** 优雅停止（`shutdown` → 等退出 → 兜底杀树）。 */
  async stop({ timeoutMs = 8000 } = {}) {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.stopRequested = true;
      if (!this.child || this.child.exitCode !== null) return;
      const shutdown = await this.#request('shutdown', {}, { timeoutMs: 5000 });
      if (shutdown.error) this.logger?.warn(`SDK shutdown 返回错误：${shutdown.error.message}`);
      const finished = await Promise.race([this.exited, new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
      if (finished === null) await this.kill();
    })();
    return this.stopping;
  }

  /** 强杀整棵进程树。 */
  async kill() {
    if (!this.pid) {
      try {
        this.child?.kill();
      } catch {
        /* 已退出 */
      }
      return false;
    }
    return killProcessTree(this.pid, { logger: this.logger, spawnImpl: this.spawnImpl });
  }

  /** 诊断。 */
  info() {
    return {
      sessionId: this.sessionId,
      pid: this.pid,
      ready: this.ready,
      cwd: this.cwd,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      turns: this.turns,
      serverInfo: this.serverInfo,
      stderrBytes: this.stderr.length,
      garbageLines: this.splitter?.garbage ?? 0,
      stdoutBytes: this.splitter?.bytes ?? 0,
    };
  }
}

/**
 * 会话轮次执行器（SDK 版）。
 */
export class SessionRunner {
  /**
   * @param {{config: object, mirror: object, live: object, stream: object, desktop?: object|null, logger?: object|null, spawnImpl?: Function, now?: Function, existsSync?: Function, readFileSync?: Function}} opts
   */
  constructor({ config, mirror, live, stream, desktop = null, logger = null, spawnImpl = spawn, now = Date.now, existsSync = fs.existsSync, readFileSync = fs.readFileSync }) {
    this.config = config;
    this.mirror = mirror;
    this.live = live;
    this.stream = stream;
    this.logger = logger;
    // 防御：createGateway 的 `spawnImpl` 默认是 null（v1 用它允许测试注入替身），
    // 直接透传会让 SDK 子进程创建时报 "this.spawnImpl is not a function"（e2e 实测踩到）。
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : spawn;
    this.now = now;
    this.launch = resolveDshLaunch({ dsh: config.dsh ?? {}, env: process.env, existsSync, readFileSync });
    /** @type {Map<string, SdkRuntime>} */
    this.runtimes = new Map();
    /** 因 abort/进程崩溃而**不可再续**的会话（SDK 协议限制：新进程无法接管既有会话）。 */
    this.exhausted = new Set();
    /**
     * 会话 → 权限档（`workspace`|`full`，见 `lib/permission.mjs`）。
     *
     * 为什么可以是纯内存：SDK 运行时**只在本进程内可接管**——网关重启后既有会话一律
     * 409「无法接管」，因此权限档不需要跨进程持久化（也就不会出现"重启后悄悄降档"）。
     * 运行时崩溃后本进程会重建运行时，那时仍从这张表取档，保证同一会话前后一致。
     * @type {Map<string, string>}
     */
    this.sessionAccess = new Map();
    /**
     * 会话 → 每任务模型选择 `{provider, model, reasoningEffort}`（契约 §7.8）。
     *
     * 为什么与 `sessionAccess` 一样可以是纯内存（同一条理由，逐字适用）：SDK 运行时只在本进程内
     * 可接管，网关重启后既有会话一律 409「无法接管」—— 也就是说重启之后**根本不会有**续聊
     * 走到 `#ensureRuntime`，落盘一份"重启后也用得上"的模型表纯属自欺。
     *
     * 与权限档的**唯一**差别在生效时机：权限档是环境变量，随时可改；模型走 `initialize` 握手，
     * 子进程一起来就定死了。所以这张表只在"为会话新建运行时时"被读一次，之后续聊传新模型
     * **不会**有任何效果（见 `#ensureRuntime` 注释）。
     * @type {Map<string, {provider: string|null, model: string, reasoningEffort: string|null}>}
     */
    this.sessionModel = new Map();
    /** @type {Map<string, {turnId: string, startedAt: number, prompt: string, fromSeq: number, reason: string|null, settled: boolean}>} */
    this.active = new Map();

    // ---- 电脑端会话驱动通道（契约 §7.4）----
    //
    // 桌面端 DSH runtime 就是一个"会话权威"：它的 `session/prompt` 能 resume 任何它索引到的
    // 会话（`dsh-api-session-controller` 的 `ensureSession()` → `composeAgent(presetId)` 是运行时
    // 组合 preset，因此没有 SDK profile 那堵墙）。所以电脑端会话不再是"只读镜像"：
    // 它在 `submit()` 里改走这条通道，轮次跑在**电脑上的桌面端进程**里。
    //
    // 凭据来自 `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session`（见 desktop-api.mjs）。
    this.desktop = desktop;
    /** @type {Map<string, {turnId: string, startedAt: number, prompt: string, fromSeq: number, reason: string|null, settled: boolean, abort: Function, settle: Function}>} */
    this.desktopActive = new Map();
    if (desktop === null) {
      logger?.warn('未接入桌面端 DSH runtime：电脑端会话（source=computer）将保持只读，POST /turns 返回 409');
    } else {
      logger?.info(`电脑端会话驱动通道：桌面端 DSH http://${desktop.host ?? '127.0.0.1'}:${desktop.port ?? config.desktop?.port ?? DEFAULT_DESKTOP_PORT}`);
    }

    // ---- 电脑端会话**实时中继**（见 lib/desktop-watch.mjs 头部注释）----
    //
    // 上面那条通道只覆盖"手机经网关投递"的轮次；用户在电脑端 DSH 界面里自己发起的轮次
    // 对手机总线是完全静音的（手机端会一直卡在"已加载 N/M 条"，后续回复永远不出现，实测复现）。
    // 这里轮询桌面端运行态发现那种轮次并补发事件。默认开启，`desktopWatch.enabled=false` 可关。
    const watchConfig = config.desktopWatch ?? {};
    /** 本轮发现里"值得中继"的会话 id（只在真正需要判定时由 `#watchableIds()` 重算）。 @type {Set<string>} */
    this.watchable = new Set();
    /** 「已经被 `http.mjs` 直推给客户端」的判据，由 `setDesktopDirectProbe()` 注入。 @type {((id: string) => boolean)|null} */
    this.desktopDirectProbe = null;
    this.desktopWatcher = null;
    if (desktop !== null && watchConfig.enabled !== false) {
      // 镜像全量扫描（`#watchableIds`）**必须惰性**：绝大多数 tick 里一个 running 的会话都没有，
      // 那种 tick 一次磁盘扫描都不该做（生产 home 实测 168 个会话，每 2s 扫一遍纯属浪费）。
      // 只有 `shouldWatch` 真被问到（= 存在 running 且尚未订阅的会话）才付这次扫描的代价。
      let watchableFresh = false;
      const watcher = new DesktopTurnWatcher({
        desktop,
        stream,
        logger,
        pollMs: watchConfig.pollMs ?? undefined,
        streamTimeoutMs: watchConfig.streamTimeoutMs ?? undefined,
        attachTimeoutMs: watchConfig.attachTimeoutMs ?? undefined,
        now,
        // 资格判定必须在这一层 —— 只有 runner 知道镜像与两张占用表：
        // 1) 镜像里存在（排除已删除的）；2) 不是派生会话（子代理/fork，手机端本就隐藏）；
        // 3) 没被本进程的回合占用表拿着；4) 本进程没在驱动它（那是上面那条通道的事，
        //    两个生产者会给同一个客户端发两份同样的帧）；5) `http.mjs` 没在给某个客户端直推它。
        shouldWatch: async (sessionId) => {
          if (!watchableFresh) {
            this.watchable = await this.#watchableIds();
            watchableFresh = true;
          }
          return (
            !this.active.has(sessionId) &&
            !this.desktopActive.has(sessionId) &&
            this.watchable.has(sessionId) &&
            !(this.desktopDirectProbe?.(sessionId) ?? false)
          );
        },
        onTurnEnd: (sessionId, info) => this.#onWatchedTurnEnd(sessionId, info),
      });
      // 每个 tick 重置惰性标记（`tick` 本体在 lib/desktop-watch.mjs）。
      // 替换实例方法而不是把 runner 整个传进去：中继因此不依赖 runner 的内部结构，可单独测。
      const baseTick = watcher.tick.bind(watcher);
      watcher.tick = async () => {
        watchableFresh = false;
        await baseTick();
      };
      this.desktopWatcher = watcher;
      watcher.start();
    }
    if (!this.launch.command) {
      logger?.warn('未找到可用的 dsh 启动器：会话续聊（POST /api/v2/sessions/{id}/turns）将返回 503');
    } else {
      logger?.info(`会话续聊启动器：${this.launch.source} → ${this.launch.command}（--profile ${SDK_PROFILE}）`);
      if (!this.launch.supportsSdk) {
        logger?.warn(`启动器 ${this.launch.source} 不支持 SDK profile，续聊将返回 503（请配置 dsh.launcher 指向 dsh.cmd）`);
      }
    }
  }

  /**
   * 续聊是否可用。
   *
   * 两条通道任一可用即可：手机会话走 SDK profile（`dsh.sessionsHome`），
   * 电脑端会话走桌面端 DSH runtime 的 HTTP RPC 面。
   */
  get available() {
    return this.sdkAvailable || this.desktopAvailable;
  }

  /** SDK 通道（手机会话）是否可用。 */
  get sdkAvailable() {
    return Boolean(this.launch.command) && this.launch.supportsSdk;
  }

  /** 桌面端通道（电脑端会话）是否已接入。 */
  get desktopAvailable() {
    return this.desktop !== null && this.desktop !== undefined;
  }

  /**
   * 该会话是否有一个活着的运行时（= 可续聊）。
   *
   * **只管手机会话**（SDK profile）：运行时在内存里且 ready 才算可续 —— 与既有语义逐字一致，
   * 不引入任何回归。电脑端会话的可写性由 `desktopAvailable` 单独表达（见 http.mjs 的
   * `onListSessions`/`onSessionDetail`），因为桌面端随时能 resume 它索引到的会话，
   * 不存在"运行时不在了"这种状态。
   */
  isResumable(sessionId) {
    return this.runtimes.has(sessionId) && this.runtimes.get(sessionId).ready;
  }

  /** 该会话是否正在跑一轮（SDK 或桌面端）。 */
  isRunning(sessionId) {
    return this.active.has(sessionId) || this.desktopActive.has(sessionId);
  }

  /**
   * 该会话是否正由**网关发起的桌面端轮次**占用。
   *
   * `http.mjs` 用它决定要不要额外开一条观望型 `session/follow`：网关驱动的轮次已经把翻译后的
   * 事件经会话总线推给手机了，再开一条观望订阅就会重复投递。
   */
  isDesktopActive(sessionId) {
    const record = this.desktopActive.get(sessionId);
    return Boolean(record) && !record.settled;
  }

  /**
   * 注册「这个会话是否已经被**另一条**路径直推给客户端」的判据。
   *
   * 同一个会话必须只有一个事件生产者：`http.mjs` 对 `?sessionId=` 的 SSE 连接会开一条
   * 「观望型」`session/follow` 直推给那个响应，而实时中继是把它写进会话总线 ——
   * 两条同时活着，同一个客户端就会收到两份 `message.delta`（文本成对出现）。
   *
   * 所以中继在每轮发现前先问一句：这条会话已经在被直推了吗？是就让开。
   * 直推随最后一个关注者断开而消失（`desktopSse.subscriptions` 被删），下一轮中继自然接手，
   * 中间不会有两边都不管的窗口。
   *
   * @param {(sessionId: string) => boolean} probe
   */
  setDesktopDirectProbe(probe) {
    this.desktopDirectProbe = typeof probe === 'function' ? probe : null;
  }

  /**
   * 该会话是否已被实时中继接管。
   *
   * 与 `setDesktopDirectProbe()` 是一对，方向相反：`http.mjs` 在给某个 `?sessionId=` 连接
   * 开直推之前问这一句，中继在发现新轮次之前问那一句。两边各问一次，任何一种先后顺序
   * 都只会有一个生产者。
   */
  isWatchedSession(sessionId) {
    return this.desktopWatcher?.isWatching(sessionId) ?? false;
  }

  /** 生成一个新的手机会话 id（`session-<uuid>` 形状，与 DSH 惯例一致）。 */
  newSessionId() {
    return `session-${crypto.randomUUID()}`;
  }

  /**
   * 提交一轮续聊（契约 §4.2）。
   *
   * `host` 用来**显式指定通道**，用于会话刚被创建、镜像还没索引到它的时候：
   * `onCreateTaskV2` 先让桌面端建好会话再投首轮，此刻 `mirror.locate()` 可能还找不到它
   * （会话文件还没落盘 / 索引未刷新），靠 `source` 判据会误落到 SDK 路径，得到一个
   * "already exists" 的 409。显式 `host:'desktop'` 让这条路径不依赖文件系统时序。
   *
   * @param {{sessionId: string, prompt: string, workspace?: string|null, clientTurnId?: string|null, access?: string|null, host?: 'desktop'|'gateway'|null, content?: object[]|null, provider?: string|null, model?: string|null, reasoningEffort?: string|null}} input
   *   `content` 是网关已校验归一化的 ContentBlock[]（图片/文本，见 `http.mjs` 的
   *   `validateTurnContent()`）；`null` 表示"这一轮只有 prompt 文本"，与加 content 之前完全等价。
   *   `provider`/`model`/`reasoningEffort` 是**每任务模型选择**（契约 §7.8），只在为这个会话
   *   **新建** SDK 运行时时才会被采纳（见 `#ensureRuntime`）；续聊传了也不会重启进程。
   * @returns {Promise<{ok: true, status: number, body: object} | {ok: false, code: string, status: number, message: string}>}
   */
  async submit({ sessionId, prompt, workspace = null, clientTurnId = null, access = null, host = null, content = null, provider = null, model = null, reasoningEffort = null }) {
    const images = turnImageStats(content);
    // 每任务模型：**必须在任何"建运行时"的路径之前记下**——`#ensureRuntime` 起的子进程
    // 一开场就用 `initialize` 把模型定死，晚一步记就等于这一轮跑在别的模型上。
    // 放在 `host` 分支之前是为了让"电脑端会话"也走同一条记录（桌面通道的模型由
    // `http.mjs` 的 `selectModel` 决定，这里记的是**兜底**：万一同一会话后来落回 SDK 路径，
    // 用的仍是用户在手机上选过的那个模型，而不是悄悄退回 `dsh.model`）。
    if (typeof model === 'string' && model.trim()) {
      this.sessionModel.set(sessionId, {
        provider: typeof provider === 'string' && provider.trim() ? provider.trim() : null,
        model: model.trim(),
        reasoningEffort: typeof reasoningEffort === 'string' && reasoningEffort.trim() ? reasoningEffort.trim() : null,
      });
    }
    if (host === 'desktop') {
      if (!this.desktopAvailable) {
        return {
          ok: false,
          code: 'desktop_unavailable',
          status: 503,
          message: '网关未接入桌面端 DSH runtime，无法驱动电脑端会话（需桌面端 DSH 正在运行，且网关能读到 ~/.dsh/.credentials.yaml）',
        };
      }
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return { ok: false, code: 'bad_request', status: 400, message: '缺少 prompt（必须是非空字符串）' };
      }
      if (prompt.length > 32_000) {
        return { ok: false, code: 'bad_request', status: 400, message: `prompt 过长（${prompt.length} 字符，上限 32000）` };
      }
      // 新建的会话还没有任何事件：`located` 传 null，`fromSeq` 由 #submitDesktop 取 0。
      return this.#submitDesktop({ sessionId, prompt, workspace, clientTurnId, located: null, content });
    }
    if (!this.available) {
      return {
        ok: false,
        code: 'unavailable',
        status: 503,
        message: '网关既没有可用的 dsh 启动器，也没有接入桌面端 DSH runtime，无法续聊任何会话',
      };
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, code: 'bad_request', status: 400, message: '缺少 prompt（必须是非空字符串）' };
    }
    if (prompt.length > 32_000) {
      return { ok: false, code: 'bad_request', status: 400, message: `prompt 过长（${prompt.length} 字符，上限 32000）` };
    }

    const located = await this.mirror.locate(sessionId, { workspace });
    // 1) 电脑端会话（桌面端 DSH 自己的会话）：交由桌面端 runtime 驱动（契约 §7.4）。
    //
    // 这里是本项目"手机接手电脑后续任务"的落地点。能这么做的前提是桌面端 runtime 持有
    // **会话权威**：它的会话控制器用运行时组合的 preset 恢复任何已持久化会话 —— 这正是
    // SDK/headless 路线缺的那一环（见本文件头部注释）。凭据与线协议收敛在 `desktop-api.mjs`。
    if (located && located.root.source === COMPUTER_SOURCE) {
      return this.#submitDesktop({ sessionId, prompt, workspace, clientTurnId, located, content });
    }
    // 图片轮次只能走电脑端通道（位置有意：先按 source 定通道，再问"这一轮能不能带图"）。
    //
    // SDK 运行时的 `session/prompt` 只吃文本 contentBlocks（`lib/runner.mjs`），**没有**图片参数；
    // 在这里悄悄把图丢掉是最坏的选择——用户以为发出去了，agent 从头到尾没看见，且没有任何报错。
    // 明确 400 让手机端能提示"改用电脑端会话"，是唯一诚实的做法。
    if (images.count > 0) {
      return {
        ok: false,
        code: 'bad_request',
        status: 400,
        message: '该会话由网关自带运行时执行，暂不支持发送图片（请在电脑端会话里使用）',
      };
    }
    // 2) 手机会话：只有活着的运行时才能续（SDK 协议限制：新进程无法接管既有会话）
    if (located && located.root.source === 'phone') {
      if (this.exhausted.has(sessionId)) {
        return { ok: false, code: 'session_busy', status: 409, message: '该会话的运行时已被中止或已随网关重启结束，无法再续；请在手机端新建会话。' };
      }
      if (!this.isResumable(sessionId)) {
        return {
          ok: false,
          code: 'session_busy',
          status: 409,
          message: '该会话由上一位网关进程创建，SDK 运行时无法接管既有会话（协议限制）；请在手机端新建会话。',
        };
      }
    }

    // 3) 本进程占用表：比 live 更具体，先判
    if (this.live.isTaken(sessionId)) {
      return { ok: false, code: 'session_taken', status: 503, message: `该会话已有轮次在运行：${sessionId}` };
    }
    // 4) live（mtime 60s 内 / projcache 显示仍有未结束的 turn）兜底。
    //
    // **关键：对"本进程自己拥有的手机会话"必须跳过这一判据。**
    // 本进程刚跑完一轮，必然把会话文件的 mtime 刷成"刚刚"，用它拦自己会导致
    // 「每轮结束后的 60s 内，手机无法在同一会话里说第二句话」—— 100% 误判、且看起来像
    // "续聊不支持"，而不是像 bug。契约 §5.4 的 mtime 信号本意是发现**别处**正在写；
    // 自己这一侧由上面的占用表精确判定，不需要也不应该用 mtime 二次拦截。
    const ownsRuntime = this.isResumable(sessionId);
    if (!ownsRuntime && located && this.live.isBusy({ mtimeMs: located.mtimeMs, sessionId, projcache: located.projcache })) {
      return {
        ok: false,
        code: 'session_busy',
        status: 409,
        message: `该会话正在运行（文件在 ${Math.round((this.config.mirror?.liveWindowMs ?? 60_000) / 1000)}s 内有写入）；请等待当前轮次结束`,
      };
    }

    const turnId = `turn_${newRunId()}`;
    const fromSeq = located ? located.lastSeq + 1 : 0;

    // 权限档只在**首次**（为这个会话建运行时之前）记录：续聊（`/turns`）不带 access，
    // 既不会覆盖已建会话的档位，也不会因为缺字段就把「全部权限」会话降档。
    if (access) this.sessionAccess.set(sessionId, access);

    // 5) 取或建运行时
    let runtime;
    try {
      runtime = await this.#ensureRuntime(sessionId, { workspace, located });
    } catch (err) {
      const message = String(err?.message ?? err);
      // "already exists" = 会话在盘上但不在本进程的运行时表里 → 不可接管
      if (/already exists/i.test(message)) {
        this.exhausted.add(sessionId);
        return { ok: false, code: 'session_busy', status: 409, message: '该会话的运行时已结束（网关重启或曾被中止），无法再续；请在手机端新建会话。' };
      }
      this.logger?.error(`创建 SDK 运行时失败：${message}`);
      return { ok: false, code: 'internal', status: 500, message: `无法启动会话运行时：${message}` };
    }

    const acquired = this.live.acquire({ sessionId, turnId, pid: runtime.pid, prompt });
    if (!acquired.ok) {
      return { ok: false, code: 'session_taken', status: 503, message: `该会话已被本进程的另一个轮次占用：${sessionId}` };
    }
    const record = { turnId, startedAt: this.now(), prompt, fromSeq, reason: null, settled: false, runtime, clientTurnId, sawRunning: false, turn: located ? (located.summary?.turns ?? 0) + 1 : 1, idleFallback: null, turnEndSeen: false };
    this.active.set(sessionId, record);

    try {
      const result = await runtime.prompt(prompt);
      this.stream.emit(STREAM_EVENTS.turnStarted, { sessionId, source: PHONE_SOURCE, turn: record.turn, fromSeq, turnId, messageId: result.messageId ?? null }, { sessionId });
      this.logger?.info(`会话轮次已入队 sessionId=${sessionId} turnId=${turnId} messageId=${result.messageId ?? '-'} pid=${runtime.pid}`);
      return { ok: true, status: 202, body: { accepted: true, sessionId, turnId, fromSeq, driver: DRIVER_GATEWAY, source: PHONE_SOURCE, ...(result.messageId ? { messageId: result.messageId } : {}), ...(clientTurnId ? { clientTurnId } : {}) } };
    } catch (err) {
      this.active.delete(sessionId);
      this.live.release(sessionId);
      return { ok: false, code: 'internal', status: 500, message: String(err?.message ?? err) };
    }
  }

  /**
   * 电脑端会话投递一轮（契约 §7.4）。
   *
   * 与 SDK 路径的**本质差别**：这里没有"进程"可管，也没有"运行时会不会丢"的问题 ——
   * 桌面端 DSH 自己就是那个常驻进程，它按需 resume 会话。所以：
   * - 只读性不再是拒绝理由（用户已批准手机端权限与电脑端等同）；
   * - 中止是**非破坏性**的（`session/cancel`，会话仍可续），不像 SDK 那样杀进程后不可续；
   * - 忙判定以**桌面端自己的运行态**为准（`running`/`agentAvailable`），而不是文件 mtime ——
   *   这是 Windows 上没有 flock 时唯一可靠的真值来源。
   *
   * @param {{sessionId: string, prompt: string, workspace?: string|null, clientTurnId?: string|null, located?: object|null, content?: object[]|null}} input
   *   `content` 非空时整轮内容以它为准（文本 + 图片），`prompt` 只用于日志/占用表/事件；
   *   为 `null` 时投递形状与加该参数之前逐字一致（`{sessionId, text, mode}`）。
   * @returns {Promise<{ok: true, status: number, body: object} | {ok: false, code: string, status: number, message: string}>}
   */
  async #submitDesktop({ sessionId, prompt, workspace = null, clientTurnId = null, located = null, content = null }) {
    const images = turnImageStats(content);
    if (!this.desktopAvailable) {
      return {
        ok: false,
        code: 'desktop_unavailable',
        status: 503,
        message: '网关未接入桌面端 DSH runtime，无法驱动电脑端会话（需桌面端 DSH 正在运行，且网关能读到 ~/.dsh/.credentials.yaml）',
      };
    }
    const held = this.desktopActive.get(sessionId);
    if (held && !held.settled) {
      return { ok: false, code: 'session_taken', status: 503, message: `该会话已有轮次在运行：${sessionId}` };
    }

    // 忙判定：以桌面端运行态为真值（Windows 无 flock，文件 mtime 只能作兜底）。
    const snapshot = await this.#desktopSnapshot(sessionId);
    if (!snapshot.ok) return snapshot.error;
    const entry = snapshot.entry;
    const fromSeq = located?.lastSeq !== undefined && located?.lastSeq !== null ? located.lastSeq + 1 : 0;

    if (entry && entry.running) {
      return {
        ok: false,
        code: 'session_busy',
        status: 409,
        message: '该会话正在电脑端运行一轮；请等待当前轮次结束（可点"中止"结束它），或在电脑端继续。',
      };
    }
    if (entry && entry.agentAvailable === false) {
      return {
        ok: false,
        code: 'session_busy',
        status: 409,
        message: '该会话在电脑端已不可驱动（桌面端未持有它的运行时）；请在电脑端打开它后再从手机继续。',
      };
    }

    const startedAt = this.now();
    // 先挂占用表再 await：否则"几乎同时"的两条 POST /turns 会双双通过上面的检查（竞态实测经验）。
    const record = {
      turnId: `turn_${newRunId()}`,
      startedAt,
      prompt,
      fromSeq,
      reason: null,
      settled: false,
      clientTurnId,
      turn: (entry?.projections?.values?.sessionStats?.turns ?? located?.summary?.turns ?? 0) + 1,
      text: '',
      reasoning: '',
      toolCalls: [],
      toolResults: [],
      sawTurnEnd: false,
      sawError: null,
      stream: null,
      abort: null,
      settle: null,
    };
    this.desktopActive.set(sessionId, record);
    // 占用表也占上：这样并发进来的第二条请求会吃到 503 session_taken（与 SDK 路径同语义），
    // 而且既有的"该会话被本进程占用"判定（mirror.setOccupancy → live.isTaken）也会生效。
    const acquired = this.live.acquire({ sessionId, turnId: record.turnId, pid: null, prompt });
    if (!acquired.ok) {
      this.desktopActive.delete(sessionId);
      return { ok: false, code: 'session_taken', status: 503, message: `该会话已被本进程的另一个轮次占用：${sessionId}` };
    }

    const controller = new AbortController();
    record.abort = () => controller.abort();

    // **先开流、再投递**：`session/follow` 会先回放既有转录、再增量推送。先订阅才不会漏掉
    // 首轮的最快几个事件（这是实测出来的时序，反过来的话手机端偶尔会看不到开头的 message.delta）。
    const streamError = await this.#openDesktopTurnStream(sessionId, record, controller.signal);
    if (streamError) {
      this.desktopActive.delete(sessionId);
      this.live.release(sessionId);
      return streamError;
    }

    let delivered;
    try {
      // 有 content 块时走 `desktop.prompt({sessionId, text, mode, content})`：`text` 仍然传
      // （桌面端只在 content 为空时才用它，留作兜底与可读性）；没有 content 时**连键都不加**，
      // 保证老路径的调用形状一分不差（桌面端替身/真实 DesktopApi 都按 args 形状断言过）。
      const input = { sessionId, text: prompt, mode: 'queue' };
      if (Array.isArray(content) && content.length > 0) input.content = content;
      delivered = await this.desktop.prompt(input);
    } catch (err) {
      await this.#settleDesktop(sessionId, record, 'failed', { message: String(err?.message ?? err) });
      return { ok: false, code: err?.code ?? 'desktop_error', status: err?.status ?? 502, message: String(err?.message ?? err) };
    }

    this.stream.emit(STREAM_EVENTS.turnStarted, {
      sessionId,
      source: COMPUTER_SOURCE,
      turn: record.turn,
      fromSeq,
      turnId: record.turnId,
      messageId: delivered?.messageId ?? null,
    }, { sessionId });
    // 日志只记张数与字节数（`turnImageStats` 只产数字），图片内容绝不落日志。
    const imageNote = images.count > 0 ? `，图片 ${images.count} 张/${images.bytes} 字节` : '';
    this.logger?.info(`电脑端会话轮次已投递 sessionId=${sessionId} turnId=${record.turnId}（桌面端 runtime 驱动${imageNote}）`);
    return {
      ok: true,
      status: 202,
      body: {
        accepted: true,
        sessionId,
        turnId: record.turnId,
        fromSeq,
        driver: DRIVER_DESKTOP,
        source: COMPUTER_SOURCE,
        ...(delivered?.messageId ? { messageId: delivered.messageId } : {}),
        ...(clientTurnId ? { clientTurnId } : {}),
      },
    };
  }

  /**
   * 订阅桌面端会话事件流，把事件翻译成手机端 SSE 词汇并累积成最终消息。
   *
   * **在投递之前先等第一个事件**：`openStream` 是异步生成器（函数体在第一次 `next()` 才执行），
   * 所以只有推进第一步才能知道订阅是否真的成功 —— 凭据失效/路由不存在/桌面端没起都会在这里
   * 以 `{error}` 的形式暴露出来。这样"订阅失败"就不会变成"prompt 已经投进电脑，手机却看不到"。
   *
   * 失败时返回错误信封，成功返回 null。
   */
  async #openDesktopTurnStream(sessionId, record, signal) {
    let iterator;
    try {
      iterator = this.desktop.openFollow(sessionId, {
        assistantStream: true,
        signal,
        timeoutMs: this.config.desktop?.streamTimeoutMs ?? 600_000,
      });
    } catch (err) {
      return { ok: false, code: 'desktop_error', status: 502, message: `无法订阅桌面端会话事件流：${String(err?.message ?? err)}` };
    }

    let firstStep;
    try {
      firstStep = await iterator.next();
    } catch (err) {
      return { ok: false, code: 'desktop_error', status: 502, message: `订阅桌面端会话事件流失败：${String(err?.message ?? err)}` };
    }
    if (firstStep.done) {
      const failure = firstStep.value?.error ?? null;
      return {
        ok: false,
        code: failure?.code ?? 'desktop_error',
        status: failure?.code === 'desktop_unauthorized' ? 502 : 503,
        message: `无法订阅桌面端会话事件流：${failure?.message ?? '桌面端未返回任何事件'}`,
      };
    }

    // 事件消费放在后台：推进生成器直到终态，不阻塞 HTTP 响应。
    void (async () => {
      let failed = null;
      try {
        await this.#consumeDesktopStream(sessionId, record, iterator, firstStep);
      } catch (err) {
        failed = err;
        if (!signal.aborted) this.logger?.warn(`桌面端事件流中断 sessionId=${sessionId}：${String(err?.message ?? err)}`);
      } finally {
        // 正常结束（收到 turn/end）或流被取消/出错：都要收束占用，否则该会话再也投不进去。
        if (!record.settled) {
          const reason = record.reason ?? (failed ? 'failed' : 'completed');
          await this.#finishDesktopTurn(sessionId, record, reason, failed ? { message: String(failed.message ?? failed) } : null);
        }
        // 收到 `turn/end` 时是**提前 return** 的，异步生成器仍挂在 `yield` 上：`openStream` 的
        // `finally`（里面才 `socket.close()`）只有迭代器被 return 或耗尽才会跑。而
        // `#finishDesktopTurn` 已经把 `desktopActive` 里的条目删掉，`shutdown()` 再也找不到它
        // —— 于是每跑一轮泄漏一个 WebSocket，未 unref 的 socket 会一直吊住事件循环，
        // 网关进程再也退不出去（实测：e2e 探针打印完 PASS 后 300s 仍未退出）。手动收尾迭代器。
        try {
          await iterator.return?.();
        } catch {
          /* 关闭失败不影响本轮已完成的收束 */
        }
      }
    })().catch(() => {
      /* #finishDesktopTurn 内部已兜底；这里只防止未捕获拒绝 */
    });
    return null;
  }

  /** 逐条消费桌面端事件：翻译 → 发 SSE → 累积最终消息。 */
  async #consumeDesktopStream(sessionId, record, iterator, firstStep) {
    // 手写迭代（而不是 `for await`）是为了拿到生成器的**返回值** `{ended, error}`：
    // 流中途断掉时错误只在返回值里，不在抛出的异常里。
    let step = firstStep;
    while (true) {
      if (step.done) {
        record.streamResult = step.value ?? null;
        return;
      }
      const frame = translateDesktopEvent(step.value);
      if (frame === null) {
        step = await iterator.next();
        continue;
      }
      // 终态交由 `#finishDesktopTurn` 独家发出：只有它同时知道 `turnId`、`resumable`
      // 与"占用是否已释放"。若这里也发一条，手机端会收到两个 `turn.ended`
      // （实测：一个带 usage 无 resumable，一个带 resumable 无 usage），UI 的收尾逻辑会跑两遍。
      if (frame.type === STREAM_EVENTS.turnEnded) {
        record.sawTurnEnd = true;
        record.reason = frame.data.reason ?? 'completed';
        if (frame.data.error) record.sawError = frame.data.error;
        return;
      }
      const data = { ...frame.data, sessionId, source: COMPUTER_SOURCE };
      this.stream.emit(frame.type, data, { sessionId });

      if (frame.type === STREAM_EVENTS.messageDelta) {
        if (frame.data.channel === 'reasoning') record.reasoning += frame.data.text ?? '';
        else record.text += frame.data.text ?? '';
      } else if (frame.type === STREAM_EVENTS.toolCall) {
        // 字段名与 SDK 路径（`#onSessionEvent` 的 `tool/call` 分支）保持一致，
        // 这样 Android 端的 reducer 不用分辨事件来自哪条通道。
        record.toolCalls.push({ name: frame.data.name ?? null, args: frame.data.args ?? null, callId: frame.data.callId ?? null });
      } else if (frame.type === STREAM_EVENTS.toolResult) {
        record.toolResults.push({ name: frame.data.name ?? null, callId: frame.data.callId ?? null, isError: Boolean(frame.data.isError), result: frame.data.result ?? null });
      }
      step = await iterator.next();
    }
  }

  /** 收束一次电脑端轮次：释放占用 + 发 `turn.ended`（顺序与 SDK 路径一致）。 */
  async #finishDesktopTurn(sessionId, record, reason, error) {
    if (record.settled) return;
    record.settled = true;
    this.desktopActive.delete(sessionId);
    this.live.release(sessionId);
    if (record.reason === null) record.reason = reason;
    await this.#emitDesktopTurnEnd(sessionId, record.turn ?? null, record.turnId, record.reason ?? reason, error ?? record.sawError ?? null);
  }

  /**
   * 电脑端轮次的终态广播（两条通道共用）。
   *
   * **只有调用方能决定终态**：它同时知道 `turnId`、`resumable` 与"占用是否已释放"。
   * 电脑端会话实时中继（`lib/desktop-watch.mjs`）发现别的通道也发过终态时会跳过这里，
   * 否则手机端会收到两个 `turn.ended`（实测：一个带 usage 无 resumable，一个带 resumable
   * 无 usage），UI 的收尾逻辑会跑两遍。
   *
   * @param {string} sessionId
   * @param {number|null} turn
   * @param {string} turnId
   * @param {string} reason
   * @param {{message: string}|null} error
   * @param {{text?: number, toolCalls?: number, source?: string}} [meta]
   */
  async #emitDesktopTurnEnd(sessionId, turn, turnId, reason, error, meta = {}) {
    const source = meta.source ?? COMPUTER_SOURCE;
    this.stream.emit(STREAM_EVENTS.turnEnded, {
      sessionId,
      source,
      turn: turn ?? null,
      reason,
      turnId,
      // 桌面端会话中止后仍可续（`session/cancel` 不是破坏性的），所以恒为 true。
      resumable: true,
      ...(error ? { error } : {}),
    }, { sessionId });
    await this.#afterDesktopTurnEnd(sessionId, reason, source, { ...meta, turnId });
  }

  /**
   * 轮次终态之后的善后（**不发 `turn.ended`**）。
   *
   * 拆出来是因为中继通道自己已经发过终态了：它调用的善后必须正好是这一半，
   * 否则手机端会收到两条 `turn.ended`（实测过这种双发，UI 收尾会跑两遍）。
   *
   * @param {string} sessionId
   * @param {string} reason
   * @param {string} source
   * @param {{text?: number, toolCalls?: number, turnId?: string}} [meta]
   */
  async #afterDesktopTurnEnd(sessionId, reason, source, meta = {}) {
    // 刷新镜像缓存，让手机端随后拉到的列表/详情看到最新 seq（失败不影响可续聊这一不变式）。
    try {
      await this.mirror.ensure({ id: sessionId, force: true });
    } catch (err) {
      this.logger?.warn(`电脑端轮次结束后刷新会话失败：${err.message}`);
    }
    this.stream.emit(STREAM_EVENTS.sessionUpdated, {
      sessionId,
      source,
      updatedAt: this.now(),
      reason,
    }, { sessionId });
    this.logger?.info(
      `电脑端会话轮次结束 sessionId=${sessionId} turnId=${meta.turnId ?? '-'} reason=${reason}` +
        (meta.text === undefined ? '' : ` text=${meta.text} 字 工具调用=${meta.toolCalls ?? 0} 次`),
    );
  }

  /**
   * 一条**不由本进程投递**的电脑端轮次（用户在电脑端 DSH 界面里自己发起的）刚刚结束。
   *
   * 中继通道（`lib/desktop-watch.mjs`）已经把 `turn.ended` 发过了，这里只做善后：
   * 刷新镜像 + 广播 `session.updated`，让手机端的列表与详情页立刻对齐。
   *
   * @param {string} sessionId
   * @param {{reason: string, error: object|null, watch: object, turnId?: string}} info
   */
  async #onWatchedTurnEnd(sessionId, info) {
    const ended = info?.watch ?? {};
    await this.#afterDesktopTurnEnd(sessionId, info?.reason ?? 'completed', COMPUTER_SOURCE, {
      turnId: info?.turnId ?? `watch-${String(sessionId).slice(-8)}`,
      text: ended.text ?? 0,
      toolCalls: ended.toolCalls ?? 0,
    });
  }

  /**
   * 电脑端会话实时中继的"值守范围"。
   *
   * 三条判据缺一不可，都是为了不惊扰别的通道：
   * 1. **本进程没在驱动它**（`active`/`desktopActive`）—— 那条路自己会发全一套事件，
   *    两边同时发 `turn.ended` 会让手机端收尾跑两遍；
   * 2. **镜像里存在且不是派生会话** —— 与列表端点同口径（`isDerivedSession`）：
   *    子代理 / fork 出来的副本在手机端本来就是隐藏的，中继它们只会白开 WebSocket；
   * 3. **不在本进程的回合占用表里**（`mirror.isTaken`）—— 手机刚投递、抢占表已挂但桌面端
   *    还没把 `running` 翻转的那一瞬间属于这种状态。
   *
   * 需要读镜像列表，所以由中继在每一轮发现前调用一次并把结果传进 `shouldWatch`。
   */
  async #watchableIds() {
    /** @type {Set<string>} */
    const ids = new Set();
    let result = null;
    try {
      // `mirror.list()` 是**分页信封**（`{sessions, nextCursor…}`），不是数组 —— 直接 `for…of`
      // 会得到 `TypeError: items is not iterable`（中继的 tick 会被打断，真机上表现为"中继完全不工作"）。
      result = await this.mirror.list({ includeSubagent: false, limit: 1000 });
    } catch (err) {
      this.logger?.warn(`读取会话镜像列表失败（本轮不中继任何电脑端会话）：${String(err?.message ?? err)}`);
      return ids;
    }
    for (const item of result?.sessions ?? []) {
      if (!item?.id) continue;
      if (isDerivedSession(item)) continue;
      if (item.taken) continue;
      ids.add(item.id);
    }
    return ids;
  }

  /**
   * 主动收束一次电脑端轮次。
   *
   * 与 SDK 路径的差别：这里**不把会话标记为 exhausted** —— 桌面端取消一轮不会让会话不可续，
   * 手机随后可以立刻再投一轮（这正是 `session/cancel` 相比"杀进程"的价值）。
   */
  async #settleDesktop(sessionId, record, reason, error = null) {
    if (record.settled) return null;
    record.reason = reason;
    // 取消订阅：abort 会关掉 WebSocket，事件消费循环随之结束，不会与收束竞争。
    try {
      record.abort?.();
    } catch {
      /* 忽略取消失败 */
    }
    await this.#finishDesktopTurn(sessionId, record, reason, error);
    return { sessionId, turnId: record.turnId, reason };
  }

  /**
   * 中止一个电脑端会话的当前轮次（契约 §4.2 `POST /abort`）。
   *
   * 走桌面端的 `session/cancel`：**非破坏性**，会话随后仍可从手机或电脑继续。
   * 返回 `resumable: true`，与 SDK 路径的 `resumable: false` 形成对照。
   */
  async #abortDesktop(sessionId, record) {
    let cancelError = null;
    try {
      await this.desktop.cancel(sessionId);
    } catch (err) {
      cancelError = String(err?.message ?? err);
      this.logger?.warn(`桌面端取消失败 sessionId=${sessionId}：${cancelError}`);
    }
    await this.#settleDesktop(sessionId, record, 'aborted', cancelError ? { message: cancelError } : null);
    return { ok: true, turnId: record.turnId, pid: null, sessionId, driver: DRIVER_DESKTOP, resumable: true };
  }

  /** 读桌面端运行态：`{ok:true, entry}`；桌面端不可达时返回错误信封。 */
  async #desktopSnapshot(sessionId) {
    let items;
    try {
      items = await this.desktop.listSessions();
    } catch (err) {
      return {
        ok: false,
        error: {
          ok: false,
          code: err?.code ?? 'desktop_unreachable',
          status: err?.status ?? 503,
          message: `无法连接电脑端 DSH runtime（${String(err?.message ?? err)}）；请确认桌面端 DSH 正在运行`,
        },
      };
    }
    const entry = items.find((item) => item?.sessionId === sessionId) ?? null;
    return { ok: true, entry };
  }

  /**
   * 取或建一个会话的 SDK 运行时。
   *
   * **模型是"每会话/每进程"的，不是"每轮"的**：`dsh --profile sdk` 的模型只能通过
   * `initialize` 握手下发，而 `initialize` 一个子进程只做一次。因此：
   * - 首次为会话建运行时 → 采用 `submit()` 记下的每任务模型，缺省回落 `dsh.provider/model`；
   * - 运行中途（同一会话第二次 `submit`）→ **保持进程原来的模型**，新传的模型被有意忽略。
   * 这是刻意的取舍：想让手机端中途换模型，代价是**杀掉正在跑的轮次**（进程里可能有未落盘的
   * 工具调用与上下文），把"跑完这一轮"换成"换模型"是错的默认值。要换模型就新建任务/新会话。
   */
  async #ensureRuntime(sessionId, { workspace, located }) {
    const existing = this.runtimes.get(sessionId);
    if (existing?.ready) return existing;
    if (existing && !existing.ready) {
      await existing.stop().catch(() => {});
      this.runtimes.delete(sessionId);
    }
    const cwd = located?.summary?.cwd ?? located?.cwd ?? workspace ?? this.config.defaultWorkspace ?? process.cwd();
    const access = this.sessionAccess.get(sessionId) ?? ACCESS_WORKSPACE;
    const env = await this.#childEnv(access);
    // 每任务模型优先于网关配置（与权限档同一优先级方向）：手机上选的就是这个会话的模型。
    const wanted = this.sessionModel.get(sessionId) ?? null;
    const provider = wanted?.provider ?? this.config.dsh.provider;
    const model = wanted?.model ?? this.config.dsh.model;
    const reasoningEffort = wanted?.reasoningEffort ?? this.config.dsh.reasoningEffort ?? null;
    const modelOrigin = wanted ? '任务' : '配置';
    this.logger?.info(`会话运行时权限档 sessionId=${sessionId} access=${access}（${describeAccess(access)} / DSH_PERMISSION_MODE=${permissionModeFor(access)}）`);
    this.logger?.info(`会话运行时模型 sessionId=${sessionId} provider=${provider ?? '-'} model=${model ?? '-'} reasoningEffort=${reasoningEffort ?? '-'}（来自${modelOrigin}）`);
    const runtime = new SdkRuntime({
      sessionId,
      cwd,
      env,
      logger: this.logger,
      spawnImpl: this.spawnImpl,
      now: this.now,
      launch: {
        ...this.launch,
        provider,
        model,
        reasoningEffort,
        maxTokens: this.config.dsh.maxTokens ?? null,
      },
      onEvent: (event, rt) => this.#onSessionEvent(sessionId, event, rt),
      onStatus: (status, rt) => this.#onStatus(sessionId, status, rt),
      onExit: (result, rt) => this.#onRuntimeExit(sessionId, result, rt),
    });
    await runtime.start();
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  /**
   * 组装 SDK 子进程环境（DSH_HOME 指向网关自己的 sessions home；注入 API key）。
   * @param {string} [access] 权限档（`workspace`|`full`）→ `DSH_PERMISSION_MODE`
   */
  async #childEnv(access = ACCESS_WORKSPACE) {
    // 权限档必须放在静态配置 `dsh.env` 之后：任务级选择优先于配置文件里的默认值。
    const base = buildChildEnv({
      baseEnv: process.env,
      home: this.config.dsh.sessionsHome,
      extraEnv: { ...(this.config.dsh?.env ?? {}), DSH_PERMISSION_MODE: permissionModeFor(access) },
    });
    const name = this.config.dsh.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
    let creds = {};
    for (const candidate of credentialFileCandidates(this.config)) {
      creds = await readCredentialEnv({ file: candidate, name });
      if (Object.keys(creds).length > 0) {
        this.credLog = candidate;
        break;
      }
    }
    if (Object.keys(creds).length === 0) {
      this.logger?.warn(
        `未在凭据文件里找到 ${name}（候选：${credentialFileCandidates(this.config).join(' | ') || '无'}）；` +
          'SDK 轮次会以 MISSING_CREDENTIAL 结束。可设 dsh.credentialsFile 或直接在环境里导出该变量。',
      );
    } else if (!this.credLogged) {
      this.credLogged = true;
      this.logger?.info(`已从凭据文件注入 ${name}：${this.credLog}`);
    }
    return { ...base, ...creds };
  }

  /** SDK 事件 → 契约 §4.2 的 SSE 事件。 */
  #onSessionEvent(sessionId, event, runtime) {
    const type = event?.type;
    if (typeof type !== 'string') return;
    if (type.startsWith('__')) return; // subagent.* 通知暂不映射
    const seq = typeof event.seq === 'number' ? event.seq : null;
    const src = PHONE_SOURCE;

    switch (type) {
      case 'session/title':
        this.stream.emit(STREAM_EVENTS.sessionUpdated, { sessionId, source: src, title: event.data?.title ?? null }, { sessionId });
        return;
      case 'turn/start':
        // turn.started 已由 submit() 在入队时发出（带 turnId），这里只补 turn 号
        this.stream.emit(STREAM_EVENTS.sessionUpdated, { sessionId, source: src, turn: event.data?.turn ?? null, phase: 'turn_start' }, { sessionId });
        return;
      case 'turn/end': {
        // **不要在这里发 `turn.ended`。**
        // DSH 的 `turn/end` 事件到达时，本进程的占用表还持有该会话（要等 `session.status:idle`
        // 才收束），此时发 `turn.ended` 会让手机"收到结束 → 立刻追问"吃到 503 session_taken。
        // 不变式要求：**收到 `turn.ended` ⇒ 立刻可以续聊**。
        // 所以这里只记终态 + 发一条信息性的 session.updated，`turn.ended` 统一由
        // #finishTurn 在**释放占用之后**发出。
        const record = this.active.get(sessionId);
        const reason = event.data?.reason?.kind ?? null;
        if (record) {
          record.reason = reason;
          // 错误详情必须随 `turn.ended` 一起到手机（"为什么失败"是它最需要的信息），
          // 因此在这里记下来，由 #finishTurn 在释放占用之后统一发出。
          record.reasonError = event.data?.reason?.error ?? null;
          record.turnEndSeen = true;
          // 兜底：万一 `session.status:idle` 没来（进程异常/通知丢失），
          // 不能把占用永久挂着，否则该会话再也不能续聊。
          record.idleFallback = setTimeout(() => {
            const held = this.active.get(sessionId);
            if (held && !held.settled) {
              held.settled = true;
              this.logger?.warn(`turn/end 后 ${IDLE_FALLBACK_MS}ms 未见 session.status:idle，强制收束 sessionId=${sessionId}`);
              void this.#finishTurn(sessionId, held, reason ?? 'completed');
            }
          }, IDLE_FALLBACK_MS);
          record.idleFallback.unref?.();
        }
        this.stream.emit(STREAM_EVENTS.sessionUpdated, {
          sessionId,
          source: src,
          turn: event.data?.turn ?? null,
          phase: 'turn_end',
          reason,
          error: event.data?.reason?.error ?? null,
        }, { sessionId });
        return;
      }
      case 'assistant/message': {
        for (const frame of assistantFrames(event)) {
          frame.data.sessionId = sessionId;
          frame.data.source = src;
          this.stream.emit(frame.type, frame.data, { sessionId });
        }
        return;
      }
      case 'tool/call':
        this.stream.emit(STREAM_EVENTS.toolCall, { sessionId, source: src, seq, name: event.data?.name ?? null, args: safeJson(event.data?.arguments) }, { sessionId });
        return;
      case 'tool/result': {
        const text = (event.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        this.stream.emit(STREAM_EVENTS.toolResult, {
          sessionId,
          source: src,
          seq,
          isError: event.data?.message?.isError === true,
          result: text.length > 4096 ? text.slice(-4096) : text,
        }, { sessionId });
        return;
      }
      default:
        // 其余事件（step/start、system/message、request/*、deliverables/presented…）不进 SSE，
        // 手机端需要时通过 /transcript 与 /events 拉取，避免把上下文快照刷到聊天流里。
        return;
    }
  }

  /** `session.status` → 轮次结束信号（实测：`turn/end` 之后紧跟 status=idle）。 */
  #onStatus(sessionId, status, runtime) {
    const record = this.active.get(sessionId);
    if (status === 'running') {
      if (record) record.sawRunning = true;
      return;
    }
    if (status !== 'idle' || !record || record.settled) return;
    record.settled = true;
    void this.#finishTurn(sessionId, record, record.reason ?? 'completed');
  }

  /** 运行时进程意外退出。 */
  #onRuntimeExit(sessionId, result, runtime) {
    this.runtimes.delete(sessionId);
    const record = this.active.get(sessionId);
    if (record && !record.settled) {
      record.settled = true;
      const reason = record.killed ? 'aborted' : 'error';
      void this.#finishTurn(sessionId, record, reason, result);
      return;
    }
    if (!this.stopAll) {
      this.logger?.warn(`SDK 运行时退出（无进行中的轮次）：sessionId=${sessionId} code=${result.code} signal=${result.signal ?? '-'}`);
      if (!record) this.exhausted.add(sessionId); // 进程没了 → 该会话不可再续
    }
  }

  /** 收尾一轮：**先释放占用**（保证"收到 turn.ended ⇒ 可立即续聊"），再刷新镜像、发事件。 */
  async #finishTurn(sessionId, record, reason, exitInfo = null) {
    if (record.idleFallback) {
      clearTimeout(record.idleFallback);
      record.idleFallback = null;
    }
    // 顺序是有意的：先释放句柄与占用，再发 turn.ended。
    // 反过来会让"收到 turn.ended 就立刻 POST /turns"的客户端吃到 503 session_taken（实测竞态）。
    this.active.delete(sessionId);
    this.live.release(sessionId);
    // 注意 `exitInfo?.code !== 0` 的陷阱：exitInfo 为 null 时可选链结果是 undefined，
    // `undefined !== 0` 为 **true** —— 会把每一次正常收尾都误判成"进程异常退出"并标记不可续
    // （实测表现：第一轮正常完成，第二轮 `POST /turns` 直接 409 "运行时已被中止"）。
    const exitedBadly = exitInfo !== null && exitInfo?.code !== 0;
    if (reason === 'aborted' || exitedBadly) this.exhausted.add(sessionId);

    // 1) 先发 turn.ended（此刻占用已释放，客户端可以安全追问）
    this.stream.emit(STREAM_EVENTS.turnEnded, {
      sessionId,
      source: PHONE_SOURCE,
      turn: record.turn ?? null,
      reason,
      turnId: record.turnId,
      resumable: !this.exhausted.has(sessionId),
      ...(record.reasonError ? { error: record.reasonError } : {}),
      ...(exitInfo ? { exitCode: exitInfo.code } : {}),
    }, { sessionId });

    // 2) 再刷新镜像并广播会话状态（失败不影响"可续聊"这一不变式）
    let refreshed = null;
    try {
      refreshed = await this.mirror.ensure({ id: sessionId, force: true });
    } catch (err) {
      this.logger?.warn(`轮次结束后刷新会话失败：${err.message}`);
    }
    this.stream.emit(STREAM_EVENTS.sessionUpdated, {
      sessionId,
      source: PHONE_SOURCE,
      updatedAt: refreshed?.summary?.updatedAt ?? this.now(),
      turns: refreshed?.summary?.turns ?? null,
      eventCount: refreshed?.summary?.eventCount ?? null,
      reason,
    }, { sessionId });
    if (!refreshed) {
      // 镜像还没看到文件（子进程落盘时序）→ 明确告知，便于排障；
      // 下一次任何请求都会重新 locate，因此不会长期不一致。
      this.logger?.warn(`轮次结束但镜像尚未发现会话文件 sessionId=${sessionId}（下一次请求会重新发现）`);
    }
    this.logger?.info(`会话轮次结束 sessionId=${sessionId} turnId=${record.turnId} reason=${reason}${exitInfo ? ` exit=${exitInfo.code}` : ''}`);
  }

  /**
   * 中止当前轮次（契约 §4.2 `POST /abort`）。
   *
   * 两条通道的语义**有意不同**，别把它们统一：
   * - **SDK（手机会话）**：协议**没有 cancel**，只能杀进程；而新进程无法接管既有会话，
   *   因此中止是**破坏性**的（该会话之后不可再续，本进程会记住并给出明确文案）。
   * - **桌面端（电脑端会话）**：走 `session/cancel`，**非破坏性**，中止后仍可从任一端继续。
   *
   * @returns {Promise<{ok: true, turnId: string, pid: number|null, sessionId: string, driver?: string, resumable: boolean} | null>}
   */
  async abort(sessionId) {
    // 电脑端会话优先：它跑在桌面端进程里，没有"本进程运行时"可杀。
    const desktopRecord = this.desktopActive.get(sessionId);
    if (desktopRecord && !desktopRecord.settled && this.desktopAvailable) {
      return this.#abortDesktop(sessionId, desktopRecord);
    }
    const record = this.active.get(sessionId);
    if (!record) return null;
    record.killed = true;
    const runtime = this.runtimes.get(sessionId) ?? record.runtime;
    this.runtimes.delete(sessionId);
    this.exhausted.add(sessionId);
    await runtime?.kill().catch(() => {});
    // 进程退出回调会走 #finishTurn；这里也兜一次，保证即使回调丢失也能释放占用
    if (!record.settled) {
      record.settled = true;
      await this.#finishTurn(sessionId, record, 'aborted');
    }
    return { ok: true, turnId: record.turnId, pid: runtime?.pid ?? null, sessionId, resumable: false };
  }

  /** 回收空闲运行时（避免长期占着内存与 API 连接）。 */
  async reapIdle() {
    const idleMs = this.config.dsh?.runtimeIdleMs ?? 0;
    if (!idleMs) return 0;
    let reaped = 0;
    for (const [sessionId, runtime] of [...this.runtimes]) {
      if (this.active.has(sessionId)) continue;
      if (runtime.idleMs() < idleMs) continue;
      this.runtimes.delete(sessionId);
      this.exhausted.add(sessionId); // 进程回收后该会话不可再续（SDK 限制）
      await runtime.stop().catch(() => {});
      reaped += 1;
      this.logger?.info(`回收空闲 SDK 运行时 sessionId=${sessionId}（空闲 ${Math.round(runtime.idleMs() / 1000)}s）`);
    }
    return reaped;
  }

  /** 关闭：停掉全部运行时、电脑端事件流与实时中继。 */
  async shutdown() {
    this.stopAll = true;
    await this.desktopWatcher?.stop().catch(() => {});
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map((r) => r.stop().catch(() => {})));
    for (const id of this.active.keys()) this.live.release(id);
    this.active.clear();
    // 电脑端轮次：只取消订阅（关 WebSocket），**不取消桌面端的轮次** ——
    // 关掉网关不应该把电脑上正在跑的活儿掐掉；手机重连后照样能从流里接着看。
    for (const [id, record] of [...this.desktopActive]) {
      this.desktopActive.delete(id);
      record.settled = true;
      try {
        record.abort?.();
      } catch {
        /* 忽略 */
      }
    }
    this.live.clear();
  }

  /** 诊断。 */
  stats() {
    return {
      runtimes: this.runtimes.size,
      activeTurns: this.active.size,
      exhausted: this.exhausted.size,
      desktop: this.desktopAvailable ? { host: this.desktop.host, port: this.desktop.port, activeTurns: this.desktopActive.size } : null,
      desktopWatch: this.desktopWatcher === null
        ? null
        : { active: this.desktopWatcher.activeSessions(), watchable: this.watchable.size, ...this.desktopWatcher.stats },
      launchSource: this.launch.source,
      launcher: this.launch.command,
      supportsSdk: this.launch.supportsSdk,
      sessionsHome: this.config.dsh?.sessionsHome ?? null,
      runtimesDetail: [...this.runtimes.values()].map((r) => r.info()),
    };
  }
}

/**
 * 把一条 `assistant/message` 事件拆成 SSE 帧。
 *
 * 优先用事件自带的 `data.stream` 里的 `text-chunks`（真实 token 片段，实测形状：
 * `{type:'text-chunks', texts:['OK']}`），这样手机端能逐段流式渲染；
 * 没有 `stream` 时退回"整条文本一次性下发"。
 * 同时把 `tool-call` 内容块映射成 `tool.call`。
 * @param {object} event
 * @returns {Array<{type: string, data: object}>}
 */
export function assistantFrames(event) {
  const out = [];
  const data = event?.data ?? {};
  const seq = typeof event.seq === 'number' ? event.seq : null;
  const content = Array.isArray(data.message?.content) ? data.message.content : [];

  const chunks = [];
  for (const entry of Array.isArray(data.stream) ? data.stream : []) {
    if (entry?.type === 'text-chunks' && Array.isArray(entry.texts)) {
      const text = entry.texts.join('');
      if (text) chunks.push(text);
    }
  }
  if (chunks.length === 0) {
    const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (text) chunks.push(text);
  }
  for (const text of chunks) {
    out.push({ type: STREAM_EVENTS.messageDelta, data: { sessionId: null, seq, role: 'assistant', text } });
  }

  for (const block of content) {
    if (block?.type !== 'tool-call') continue;
    out.push({ type: STREAM_EVENTS.toolCall, data: { sessionId: null, seq, name: block.name ?? null, args: safeJson(block.arguments), callId: block.id ?? null } });
  }
  return out;
}

/** 安全解析 JSON 字符串参数（失败返回原串包装）。 */
export function safeJson(raw) {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { value: raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}
