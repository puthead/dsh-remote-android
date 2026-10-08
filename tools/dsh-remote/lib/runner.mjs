/**
 * 子进程执行器：argv 数组 spawn、stdout 增量聚合、进程树终止、超时收尾。
 *
 * 三个关键决策（为什么这么做）：
 * 1. **argv 数组而非 shell 字符串**：任务 prompt 来自手机，可能含中文、`"`、`'`、换行、
 *    反斜杠、反引号、`$`。只要不经过 shell，这些字符就是普通字节，不存在注入与转义错误。
 *    因此这里永远使用 `spawn(command, argsArray, opts)`，且不设置 `shell: true`。
 * 2. **进程树终止用 taskkill /PID <pid> /T /F**：headless CLI 会派生工作进程，
 *    只 kill 直接子进程会留下孤儿进程继续占用 API 配额。/T 只作用于该 PID 的子孙树，
 *    天然不会误杀其它任务（每个任务有独立子进程与独立 pid）。
 * 3. **stdout 的语义**：headless profile 的帮助明确写着 "print the final assistant message, and exit"，
 *    因此 stdout 即助手最终答复。为兼容可能出现的尾部空行，OutputAccumulator 采用
 *    「扣留尾部纯空白」策略：既保证流式增量可用，又保证
 *    `Task.output === 客户端按 seq 拼接的所有 delta` 这一契约不变式严格成立。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { truncateUtf8, truncateUtf8Tail } from './util.mjs';

export const IS_WINDOWS = process.platform === 'win32';

/**
 * 构造 dsh headless 的 argv 数组（第一个元素之后即 spawn 的 args）。
 * headless 应用只接受「任务文本」一个位置参数（见 `dsh --profile headless --help`），
 * 因此 prompt 必须作为**单个**数组元素传递，绝不能拆词或用 shell 拼接。
 * @param {{binPath: string, profile: string, launcherArgs?: string[]}} dsh
 * @param {string} prompt
 * @returns {string[]}
 */
export function buildDshArgv(dsh, prompt) {
  const argv = [dsh.binPath, '--profile', dsh.profile];
  // launcherArgs 供 `--patch <file>` 这类**启动器级**参数使用；
  // headless 应用不认识的参数会被并入任务文本，因此默认必须为空数组。
  for (const arg of dsh.launcherArgs ?? []) argv.push(arg);
  argv.push(prompt);
  return argv;
}

/**
 * 构造子进程环境变量。
 * DSH_HOME 必须指向含 `.credentials.yaml` 的目录（headless profile 只认这一处凭据）。
 * NO_COLOR/FORCE_COLOR 关闭 ANSI 颜色，避免转义序列污染落库输出。
 * @param {{baseEnv?: Record<string,string|undefined>, home: string, extraEnv?: Record<string,string>}} opts
 * @returns {Record<string,string>}
 */
export function buildChildEnv({ baseEnv = process.env, home, extraEnv = {} }) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.DSH_HOME = home;
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  for (const [key, value] of Object.entries(extraEnv)) env[key] = String(value);
  return env;
}

/**
 * 终止一个进程及其整棵子树。
 * @param {number} pid
 * @param {{logger?: {warn: Function}, platform?: string, spawnImpl?: typeof spawn, timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>} 是否发出了终止请求
 */
export async function killProcessTree(pid, { logger = null, platform = process.platform, spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  // 防御：pid 非法时不动作。绝不允许把 0/负数交给 kill —— 那会命中当前进程组。
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (platform === 'win32') {
    // /T = 连同子孙进程；/F = 强制。/PID 精确锚定本任务子进程，不会波及其它任务。
    const killer = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      killer.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      killer.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return true;
  }

  // POSIX：进程组终止（spawn 时使用了 detached:true，子进程自成进程组）
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch (err) {
      logger?.warn(`终止进程 ${pid} 失败（可能已退出）：${err.message}`);
      return false;
    }
  }
}

/**
 * 一个受控子进程：负责 spawn、流回调、退出等待与进程树终止。
 */
export class TaskProcess {
  /**
   * @param {{command: string, args: string[], cwd: string, env: Record<string,string>, logger?: object, spawnImpl?: typeof spawn, platform?: string}} opts
   */
  constructor({ command, args, cwd, env, logger = null, spawnImpl = spawn, platform = process.platform }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.child = null;
    this.pid = null;
    this._alive = false;
    this._stdoutCbs = [];
    this._stderrCbs = [];
    this._resolveDone = null;
    /** @type {Promise<{code: number|null, signal: string|null, spawnError: Error|null}>} */
    this.done = new Promise((resolve) => {
      this._resolveDone = resolve;
    });
    this.killRequested = false;
  }

  onStdout(cb) {
    this._stdoutCbs.push(cb);
    return this;
  }

  onStderr(cb) {
    this._stderrCbs.push(cb);
    return this;
  }

  get alive() {
    return this._alive;
  }

  /** 启动子进程。spawn 失败（如 ENOENT）不会抛出，而是通过 done 返回 spawnError。 */
  start() {
    const child = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true, // 关键：Windows 上不弹出控制台窗口
      // POSIX 下自成进程组以便整组终止；Windows 下用 taskkill /T，无需 detached
      // （detached 在 Windows 上会创建新控制台，反而与 windowsHide 冲突）
      detached: this.platform !== 'win32',
      // stdin 必须忽略：headless 若读到管道会等待，任务将无法结束
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false, // 显式声明：永不经 shell 解析
    });
    this.child = child;
    this.pid = child.pid ?? null;
    this._alive = true;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      for (const cb of this._stdoutCbs) {
        try {
          cb(chunk);
        } catch {
          /* 回调异常不影响子进程读取 */
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      for (const cb of this._stderrCbs) {
        try {
          cb(chunk);
        } catch {
          /* 同上 */
        }
      }
    });

    child.on('error', (err) => {
      this._alive = false;
      this._resolveDone({ code: null, signal: null, spawnError: err });
    });
    child.on('close', (code, signal) => {
      this._alive = false;
      this._resolveDone({ code: code ?? null, signal: signal ?? null, spawnError: null });
    });
    return this;
  }

  /** 终止整棵进程树（幂等）。 */
  async terminate() {
    if (!this.pid) return false;
    if (!this._alive) return false;
    this.killRequested = true;
    const ok = await killProcessTree(this.pid, { logger: this.logger, platform: this.platform, spawnImpl: this.spawnImpl });
    return ok;
  }
}

/**
 * 输出聚合器：把 stdout 分片转成「可安全流式下发的增量」，并实施总量上限。
 *
 * 截断策略（契约 v1.1 A2-5）：
 * - 超过 `maxBytes` 时**只保留尾部**，并置 `truncated=true`；
 * - **已推送的 delta 不回滚**：客户端按 seq 拼出的文本可能比 output 长，
 *   此时应以任务详情接口的 `output` 为准（详见 README「输出截断」）。
 * 为什么保留尾部而不是头部：命令输出的结论通常在末尾，尾部信息量更大。
 *
 * 空白处理：尾部纯空白会被扣留（不进入 output），一旦后续来了非空白内容再按序放出，
 * 因此在未截断时依然满足「客户端拼接 delta === 详情接口 output」。
 */
export class OutputAccumulator {
  /** @param {{maxBytes: number}} opts */
  constructor({ maxBytes }) {
    this.maxBytes = maxBytes;
    /** 契约字段 output：未截断时为全部输出；截断后为其尾部。 */
    this.output = '';
    /** 已产出的总字节数（诊断用，截断后仍可知道真实体积）。 */
    this.totalBytes = 0;
    this.truncated = false;
    this.pending = ''; // 扣留的尾部纯空白（可能还会被后续非空白内容"救回"）
  }

  /**
   * 追加一段 stdout。
   * @param {string} chunk
   * @returns {string} 可以立即作为 task.output 增量下发的内容（可能为空串）
   */
  push(chunk) {
    this.pending += chunk;
    // 只放出到「最后一个非空白字符」为止，尾部空白继续扣留
    let cut = this.pending.length;
    while (cut > 0 && /\s/.test(this.pending[cut - 1])) cut--;
    const visible = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    if (!visible) return '';

    this.totalBytes += Buffer.byteLength(visible, 'utf8');
    this.output += visible;
    if (Buffer.byteLength(this.output, 'utf8') > this.maxBytes) {
      // 超限：丢弃头部、只保留尾部（truncateUtf8Tail 不会切断多字节字符）
      this.truncated = true;
      this.output = truncateUtf8Tail(this.output, this.maxBytes);
    }
    return visible; // 全量下发：已推送的 delta 不回滚
  }

  /** 子进程结束后调用：丢弃尾部纯空白（output 已是有界尾部或完整内容）。 */
  finish() {
    this.pending = '';
    return '';
  }
}

/**
 * 把失败信息整理成人类可读的一行（契约要求 failed 任务 error 可读）。
 * dsh 的 stderr 往往是多行堆栈 + PowerShell 包装噪声，这里挑出最有信息量的头几行。
 * @param {{code: number|null, signal: string|null, stderr: string, timedOut?: boolean, timeoutSec?: number, canceled?: boolean, spawnError?: Error|null}} input
 * @returns {string}
 */
export function readableError({ code, signal, stderr, timedOut = false, timeoutSec = 0, canceled = false, spawnError = null }) {
  if (spawnError) return `无法启动 dsh 进程：${spawnError.message}`;
  if (canceled) return '任务已取消（进程树已终止）';
  if (timedOut) return `任务超时：超过 ${timeoutSec} 秒仍未结束，已终止进程树`;
  if (code === 0) return null;

  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // 过滤 PowerShell 的包装噪声，保留真正的错误信息
    .filter((l) => !/^(所在位置 行|CategoryInfo|FullyQualifiedErrorId|At line:|\+ |~)/.test(l))
    .filter((l) => !/^\+/.test(l));

  const detail = lines.slice(0, 3).join(' | ');
  const head = detail ? truncateUtf8(detail, 400) : '';
  const codeText = code === null ? `信号 ${signal ?? 'unknown'}` : `退出码 ${code}`;
  return head ? `${codeText}：${head}` : `dsh 进程异常结束（${codeText}）`;
}

/**
 * 发现本次执行写入的 DSH session（尽力而为）。
 *
 * 为什么这么做：headless CLI 不打印 session id，但会在
 * `$DSH_HOME/sessions/<按 cwd 编码的目录>/session-<uuid>/session.jsonl.zstd`
 * 下留下会话记录（旧版本为 `session-<uuid>.jsonl` 文件，这里两种布局都兼容）。
 * 执行前记录已有条目集合，执行后取新增条目即可精确归属；若出现 0 个或多个候选
 * （极端并发、同一工作区并发执行），返回 null 而不是猜一个错误的值。
 * @param {{home: string, workspace: string, before?: Set<string>, fsImpl?: object}} opts
 * @returns {Promise<string|null>}
 */
export async function discoverSessionId({ home, workspace, before = null, fsImpl = null }) {
  const fsp = fsImpl ?? (await import('node:fs/promises'));
  try {
    const entries = await fsp.readdir(sessionDirFor(home, workspace), { withFileTypes: true });
    const candidates = entries
      .filter((entry) => SESSION_ENTRY_RE.test(entry.name))
      .map((entry) => entry.name.replace(/\.jsonl$/, ''))
      .filter((name) => !(before?.has(name)));
    if (candidates.length !== 1) return null;
    return candidates[0];
  } catch {
    return null;
  }
}

/** 列出现有 session 条目名（用于执行前快照）。 */
export async function listSessions({ home, workspace, fsImpl = null }) {
  const fsp = fsImpl ?? (await import('node:fs/promises'));
  try {
    const entries = await fsp.readdir(sessionDirFor(home, workspace));
    return new Set(entries.map((name) => name.replace(/\.jsonl$/, '')));
  } catch {
    return new Set();
  }
}

/** 匹配 `session-<uuid>` 目录或 `session-<uuid>.jsonl` 文件。 */
const SESSION_ENTRY_RE = /^session-[0-9a-fA-F-]{8,}(\.jsonl)?$/;

/**
 * DSH 把 session 按工作目录编码到子目录名：去掉盘符冒号、把路径分隔符换成 `-`、两侧加 `--`。
 * 例：D:\Workspace\proj\.probe\ws → --D-Workspace-proj-.probe-ws--
 * @param {string} home
 * @param {string} workspace
 */
export function sessionDirFor(home, workspace) {
  const encoded = workspace.replace(/:/g, '').replace(/[\\/]/g, '-');
  return path.join(home, 'sessions', `--${encoded}--`);
}
