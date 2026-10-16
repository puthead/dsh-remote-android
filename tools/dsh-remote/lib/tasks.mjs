/**
 * 任务队列与生命周期管理。
 *
 * 职责：入队 → 并发调度 → 子进程执行 → 事件发布 → 原子持久化。
 *
 * 关键决策（为什么）：
 * 1. **超出并发时排队而不是拒绝**：工单要求「并发上限可配（默认 2），超出进入 queued 队列」，
 *    而契约 §3.1 又要求并发满时返回 `busy`。二者兼容的折中是：并发满 → 进入队列（status=queued）；
 *    仅当**队列也满**（maxQueue，默认 100）时才返回 429 busy。见 README「与契约的取舍」。
 * 2. **任务对象严格按契约字段返回**：`toPublicTask()` 只输出契约表格里的字段（13 个，
 *    含 `access`）；执行细节（runId/timeoutSec/model/stderrTail）放在内部 `meta` 中，
 *    落库保留、不出现在响应里，保证 Android 端解析逻辑不受网关内部演进影响。
 * 3. **output 与 delta 流严格相等**：`task.output` 只在事件真正下发时累加，
 *    因此任何时候 `GET /tasks/{id}` 的 output 都等于客户端按 seq 拼接出的文本。
 * 4. **重启恢复**：网关重启后 queued/running 任务不可能继续（子进程已死），
 *    统一标记为 failed('网关重启，任务执行已中断')，绝不留下永远卡在 running 的僵尸任务。
 * 5. **权限档按任务注入环境变量**：任务参数 `access`（`workspace`|`full`）翻译成子进程的
 *    `DSH_PERMISSION_MODE`（见 `lib/permission.mjs`）。缺字段=仅当前工作区，未知取值也收紧到该档。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventBus } from './events.mjs';
import { ACCESS_FULL, ACCESS_WORKSPACE, describeAccess, permissionModeFor } from './permission.mjs';
import { atomicWriteJson, newRunId, newTaskId, readJsonFile, sleep, truncateUtf8 } from './util.mjs';
import {
  OutputAccumulator,
  TaskProcess,
  buildChildEnv,
  buildDshArgv,
  discoverSessionId,
  listSessions,
  readableError,
} from './runner.mjs';

/** 活动态（契约状态机）。 */
export const ACTIVE_STATUSES = Object.freeze(['queued', 'running']);
/** 终态（契约状态机）。 */
export const TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'canceled']);

/** @param {string} status */
export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/** 携带契约错误码的业务异常，HTTP 层据此生成统一错误体。 */
export class TaskError extends Error {
  /**
   * @param {'bad_request'|'not_found'|'busy'|'conflict'|'internal'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

/**
 * 把内部任务对象裁剪为契约 Task 对象。
 * @param {object} task
 */
export function toPublicTask(task) {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    workspace: task.workspace,
    access: task.access ?? ACCESS_WORKSPACE,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    output: task.output,
    error: task.error,
    truncated: task.truncated,
    sessionId: task.sessionId,
  };
}

/** 契约：title 缺省取 prompt 前 40 字。 */
export function defaultTitle(prompt) {
  const flat = String(prompt).replace(/\s+/g, ' ').trim();
  return flat.length <= 40 ? flat : `${flat.slice(0, 40)}…`;
}

/** prompt 上限：防止一个请求把内存和事件缓冲撑爆（1MB 请求体的安全余量）。 */
const MAX_PROMPT_CHARS = 200_000;

export class TaskManager {
  /**
   * @param {{config: object, logger: object, bus?: EventBus, spawnImpl?: Function|null, platform?: string, now?: () => number}} opts
   */
  constructor({ config, logger, bus = null, spawnImpl = null, platform = process.platform, now = Date.now }) {
    this.config = config;
    this.logger = logger;
    this.bus = bus ?? new EventBus({ bufferSize: config.events.bufferSize, now });
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.now = now;
    /** @type {Map<string, object>} */
    this.tasks = new Map();
    /** @type {string[]} 等待执行的 task id，FIFO */
    this.queue = [];
    /** @type {Map<string, object>} 正在运行的任务句柄 */
    this.running = new Map();
    /**
     * 已被删除的任务 id（墓碑）。
     *
     * 为什么单靠 `this.tasks.has()` 不够：`persist()` 的判定与 `atomicWriteJson` 的
     * `rename` 之间隔着多个 await（mkdir/open/writeFile/sync），DELETE 可以在这个窗口里
     * 完成「删内存 + 删文件」，随后在途的 rename 把文件**重新写回**——表现为"删掉的任务
     * 文件复活"。实测该竞态在并发套件下约 3/5 概率复现（`test/tasks.test.mjs` 的
     * 「删除任务」用例）。墓碑一旦设置就不清除，且只增不减（任务 id 不复用）。
     * @type {Set<string>}
     */
    this.deletedIds = new Set();
    /**
     * 每个任务一条写链：把「落盘」与「删除」串行化到同一队列，保证删除的文件操作
     * 一定发生在该任务所有在途落盘之后。
     * @type {Map<string, Promise<unknown>>}
     */
    this.writeChains = new Map();
    this.closed = false;
  }

  /**
   * 把一次文件操作排到该任务的写链尾部。
   * @param {string} id
   * @param {() => Promise<unknown>} op
   * @returns {Promise<unknown>}
   */
  #enqueueIo(id, op) {
    const prev = this.writeChains.get(id) ?? Promise.resolve();
    const next = prev.then(op, op);
    // 链尾只用于排序，失败已在各 op 内部消化；catch 避免 unhandledRejection。
    this.writeChains.set(id, next.catch(() => {}));
    return next;
  }

  /** 加载历史任务；清理崩溃残留的临时文件；修复中断的活动任务。 */
  async init() {
    await fsp.mkdir(this.config.tasksDir, { recursive: true });
    let files = [];
    try {
      files = await fsp.readdir(this.config.tasksDir);
    } catch (err) {
      this.logger.warn(`任务目录不可读（按空历史处理）：${err.message}`);
      return 0;
    }

    // 崩溃残留：atomicWriteFile 的临时文件在 rename 前中断不会被使用，直接清理
    for (const file of files.filter((f) => f.includes('.tmp-'))) {
      await fsp.rm(path.join(this.config.tasksDir, file), { force: true }).catch(() => {});
    }

    let restored = 0;
    let repaired = 0;
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const { value, error, corrupt } = await readJsonFile(path.join(this.config.tasksDir, file), null);
      if (corrupt) {
        this.logger.warn(`任务文件损坏已隔离：${file}`);
        continue;
      }
      if (error || !value || typeof value.id !== 'string') continue;
      const task = {
        id: value.id,
        title: typeof value.title === 'string' ? value.title : defaultTitle(value.prompt ?? ''),
        prompt: typeof value.prompt === 'string' ? value.prompt : '',
        workspace: typeof value.workspace === 'string' ? value.workspace : '',
        // 老任务文件没有该字段 → 按默认档（仅当前工作区）恢复，绝不因为缺字段就放开权限
        access: value.access === ACCESS_FULL ? ACCESS_FULL : ACCESS_WORKSPACE,
        status: ACTIVE_STATUSES.includes(value.status) || TERMINAL_STATUSES.includes(value.status) ? value.status : 'failed',
        createdAt: Number(value.createdAt) || this.now(),
        startedAt: value.startedAt ?? null,
        finishedAt: value.finishedAt ?? null,
        exitCode: value.exitCode ?? null,
        output: typeof value.output === 'string' ? value.output : '',
        error: typeof value.error === 'string' ? value.error : null,
        truncated: Boolean(value.truncated),
        sessionId: value.sessionId ?? null,
        meta: { runId: value.meta?.runId ?? newRunId(), timeoutSec: value.meta?.timeoutSec ?? this.config.defaultTimeoutSec, model: value.meta?.model ?? null, reasoningEffort: value.meta?.reasoningEffort ?? null, pid: null, stderrTail: '' },
      };
      if (!isTerminal(task.status)) {
        task.status = 'failed';
        task.error = '网关重启，任务执行已中断';
        task.finishedAt = task.finishedAt ?? this.now();
        await this.persist(task);
        repaired++;
      }
      this.tasks.set(task.id, task);
      restored++;
    }
    if (repaired) this.logger.warn(`重启恢复：${repaired} 个中断任务已标记 failed；共加载 ${restored} 条历史`);
    return restored;
  }

  /** 当前并发/排队统计（health 用）。 */
  stats() {
    return { activeTasks: this.running.size, queuedTasks: this.queue.length };
  }

  /**
   * 提交任务。workspace 的白名单校验由 HTTP 层完成后传入（已归一化的真实路径）。
   * @param {{prompt: string, workspace: string, title?: string|null, model?: string|null, reasoningEffort?: string|null, timeoutSec?: number|null, access?: string}} input
   * @returns {Promise<object>} 契约 Task 对象
   */
  async submit({ prompt, workspace, title = null, model = null, reasoningEffort = null, timeoutSec = null, access = ACCESS_WORKSPACE }) {
    if (this.closed) throw new TaskError('internal', '网关正在关闭，暂不接受新任务');
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new TaskError('bad_request', 'prompt 不能为空');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new TaskError('bad_request', `prompt 过长（上限 ${MAX_PROMPT_CHARS} 字符）`);
    }
    // 防御性归一：HTTP 层已经用 resolveAccess 校验过，这里再收一次口，
    // 保证任何调用路径（脚本、测试、将来的其它入口）都拿不到第三种取值。
    const normalizedAccess = access === ACCESS_FULL ? ACCESS_FULL : ACCESS_WORKSPACE;
    // 契约 A2 语义：maxConcurrent 只限制同时 running 的数量，超出进入 queued；
    // 只有「当前没有空闲槽位、且排队数已达 maxQueue」时才算队列满 → 429 busy。
    // 因此能立刻开跑的任务不占用队列额度（maxQueue=0 时第一个任务依然应当被接受）。
    const canStartNow = this.running.size < this.config.maxConcurrent;
    if (!canStartNow && this.queue.length >= this.config.maxQueue) {
      throw new TaskError('busy', `任务队列已满（上限 ${this.config.maxQueue}），请稍后重试`);
    }
    const timeout = this.#normalizeTimeout(timeoutSec);

    const at = this.now();
    const task = {
      id: newTaskId(at),
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : defaultTitle(prompt),
      prompt,
      workspace,
      access: normalizedAccess,
      status: 'queued',
      createdAt: at,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      truncated: false,
      sessionId: null,
      meta: {
        runId: newRunId(),
        timeoutSec: timeout,
        model: model || null,
        reasoningEffort: reasoningEffort || null,
        pid: null,
        stderrTail: '',
      },
    };
    this.tasks.set(task.id, task);
    this.queue.push(task.id);
    await this.persist(task);
    this.bus.publish('task.created', { task: toPublicTask(task) }, task.id);
    if (this.running.size >= this.config.maxConcurrent) {
      this.bus.publish(
        'task.progress',
        { phase: 'queued', note: `并发已满（${this.config.maxConcurrent}），任务排队等待` },
        task.id,
      );
    }
    if (model || reasoningEffort) {
      // headless profile（rc.7）只接受任务文本这一个位置参数（`dsh --profile headless --help`），
      // 强行追加 --model 会被并入任务文本造成污染，因此这里只记录不转发。
      this.logger.info(`task ${task.id} 请求的 model/reasoningEffort 仅记录未转发（headless 无对应参数）`);
    }
    this.pump();
    return toPublicTask(task);
  }

  /** @param {string} id @returns {object|null} 契约 Task 对象 */
  get(id) {
    const task = this.tasks.get(id);
    return task ? toPublicTask(task) : null;
  }

  /**
   * 任务列表（createdAt 倒序，游标分页）。
   * @param {{status?: string, limit?: number, cursor?: string|null}} [opts]
   */
  list({ status = 'all', limit = 50, cursor = null } = {}) {
    let items = [...this.tasks.values()];
    if (status === 'active') items = items.filter((t) => !isTerminal(t.status));
    items.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    if (cursor) {
      const idx = items.findIndex((t) => t.id === cursor);
      items = idx >= 0 ? items.slice(idx + 1) : [];
    }
    const page = items.slice(0, limit);
    const nextCursor = items.length > limit && page.length > 0 ? page[page.length - 1].id : null;
    return { tasks: page.map(toPublicTask), nextCursor };
  }

  /**
   * 取消任务（幂等）：queued 直接出队；running 终止进程树并等待收尾。
   * @param {string} id
   * @returns {Promise<object|null>} 取消后的契约 Task 对象
   */
  async cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (isTerminal(task.status)) return toPublicTask(task);

    if (task.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      task.status = 'canceled';
      task.finishedAt = this.now();
      await this.persist(task);
      this.bus.publish('task.finished', { task: toPublicTask(task) }, id);
      this.logger.info(`task canceled id=${id} phase=queued runId=${task.meta.runId}`);
      return toPublicTask(task);
    }

    const handle = this.running.get(id);
    if (handle) {
      handle.canceled = true;
      // 只终止本任务自己的进程树：pid 来自该任务独有的子进程
      await handle.proc?.terminate();
      // 等收尾完成，使响应里的状态就是终态（有界等待，避免 kill 慢时把 HTTP 请求挂住）
      await Promise.race([handle.finished, sleep(8000)]);
      if (!isTerminal(task.status)) {
        // 兜底：进程迟迟不退出也要给客户端一个确定状态
        task.status = 'canceled';
        task.finishedAt = this.now();
        task.error = null;
        await this.persist(task);
        this.bus.publish('task.finished', { task: toPublicTask(task) }, id);
      }
    }
    return toPublicTask(task);
  }

  /**
   * 删除任务记录。契约 v1.1 A2-2：**仅终态可删**，活动态返回 409 conflict。
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (!isTerminal(task.status)) {
      throw new TaskError('conflict', `仅终态任务可删除（当前状态：${task.status}）`);
    }
    this.tasks.delete(id);
    // 先立墓碑，再排队删文件：这样任何「已通过 has() 判定、但还没 rename」的在途落盘
    // 都会在写链内部被墓碑挡下，不会把已删除的任务写回磁盘。
    this.deletedIds.add(id);
    await this.#enqueueIo(id, async () => {
      await fsp.rm(this.taskFile(id), { force: true }).catch(() => {});
    });
    return true;
  }

  /** 关闭：终止所有运行中任务并落盘（避免留下继续烧 API 配额的孤儿进程）。 */
  async shutdown() {
    this.closed = true;
    const handles = [...this.running.values()];
    for (const handle of handles) {
      handle.canceled = true;
      await handle.proc?.terminate();
    }
    await Promise.race([Promise.allSettled(handles.map((h) => h.finished)), sleep(5000)]);
    for (const id of [...this.queue]) {
      const task = this.tasks.get(id);
      if (!task) continue;
      task.status = 'canceled';
      task.finishedAt = this.now();
      await this.persist(task);
      this.bus.publish('task.finished', { task: toPublicTask(task) }, id);
    }
    this.queue = [];
  }

  /** 调度：在并发允许的范围内启动队首任务。 */
  pump() {
    while (!this.closed && this.running.size < this.config.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      this.#spawnRun(id);
    }
  }

  /** @returns {string} 任务持久化文件绝对路径 */
  taskFile(id) {
    return path.join(this.config.tasksDir, `${id}.json`);
  }

  /** 原子落盘（含内部 meta，便于重启后排障）。 */
  async persist(task) {
    // 已被 DELETE 的任务不再落盘：否则「删除」与运行收尾阶段的在途 persist 竞争，
    // 会把已删除的任务文件重新写回磁盘。
    if (this.deletedIds.has(task.id) || !this.tasks.has(task.id)) return;
    // 入链即快照状态：落盘取的是排队那一刻的语义，不是写到磁盘那一刻的内存状态。
    // 为什么必须快照：运行期间每 5 秒一次节流落盘（见 #persistThrottled），它与收尾的
    // 终态落盘共用同一条写链；若排在前面的节流写持有的是「running」中间态，而它实际执行
    // 时任务已进入终态，就会把已经写好的终态记录覆盖回 running——表现为任务完成后
    // 仍是"进行中"、sessionId/exitCode 丢失。实测该竞态会让 6 条历史里出现 2 条僵尸 running。
    const queued = { id: task.id, status: task.status, finishedAt: task.finishedAt ?? null };
    await this.#enqueueIo(task.id, async () => {
      // 进入写链后再判一次：排队期间可能已被删除，此时绝不能 rename。
      if (this.deletedIds.has(task.id) || !this.tasks.has(task.id)) return;
      const live = this.tasks.get(task.id);
      // 排队时是中间态、写盘时已成终态 → 这次写已过期，丢弃；终态由收尾那次 persist 负责。
      if (!isTerminal(queued.status) && live && isTerminal(live.status)) return;
      try {
        await atomicWriteJson(this.taskFile(task.id), live ?? task);
      } catch (err) {
        this.logger.error(`任务落盘失败 id=${task.id}：${err.message}`);
      }
    });
  }

  /** 节流落盘：运行中的输出每 5 秒最多写一次，避免高频磁盘写。 */
  async #persistThrottled(task) {
    const now = this.now();
    if (now - (task.meta.lastPersistAt ?? 0) < 5000) return;
    task.meta.lastPersistAt = now;
    await this.persist(task);
  }

  #normalizeTimeout(timeoutSec) {
    if (timeoutSec === null || timeoutSec === undefined) return this.config.defaultTimeoutSec;
    if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > this.config.maxTimeoutSec) {
      throw new TaskError('bad_request', `timeoutSec 必须是 1~${this.config.maxTimeoutSec} 的整数`);
    }
    return timeoutSec;
  }

  /** 创建运行句柄并异步执行；句柄保证异常也被转成 failed 状态。 */
  #spawnRun(id) {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'queued') return;
    const handle = {
      taskId: id,
      proc: null,
      acc: null,
      canceled: false,
      timedOut: false,
      flushTimer: null,
      pending: '',
      finished: null,
    };
    this.running.set(id, handle);
    handle.finished = this.#run(task, handle)
      .catch((err) => this.#failInternal(task, err))
      .finally(() => {
        this.running.delete(id);
        this.pump();
      });
  }

  /** 一次完整执行：spawn → 流式增量 → 终态判定 → 落盘 → 事件。 */
  async #run(task, handle) {
    const id = task.id;
    if (!this.config.dsh?.node || !this.config.dsh?.binPath) {
      throw new Error('未配置 dsh.node / dsh.binPath，无法执行任务');
    }

    task.status = 'running';
    task.startedAt = this.now();
    await this.persist(task);
    this.bus.publish('task.started', { task: toPublicTask(task) }, id);

    const acc = new OutputAccumulator({ maxBytes: this.config.limits.maxOutputBytes });
    handle.acc = acc;

    const argv = buildDshArgv(this.config.dsh, task.prompt);
    // 权限档只能靠环境变量下发（headless/sdk profile 都没有权限 flag）；
    // 顺序很关键：任务级取值放在静态配置 `dsh.env` **之后**，保证被授权的任务不会被配置里的默认值覆盖。
    const permissionMode = permissionModeFor(task.access);
    const env = buildChildEnv({
      home: this.config.home,
      extraEnv: { ...(this.config.dsh.env ?? {}), DSH_PERMISSION_MODE: permissionMode },
    });
    const discover = Boolean(this.config.dsh.discoverSessionId);
    const before = discover ? await listSessions({ home: this.config.home, workspace: task.workspace }) : null;

    const proc = new TaskProcess({
      command: this.config.dsh.node,
      args: argv,
      cwd: task.workspace,
      env,
      logger: this.logger,
      spawnImpl: this.spawnImpl ?? undefined,
      platform: this.platform,
    });
    handle.proc = proc;
    proc.onStdout((chunk) => this.#onOutput(task, handle, chunk));
    proc.onStderr((chunk) => {
      task.meta.stderrTail = truncateUtf8(`${task.meta.stderrTail ?? ''}${chunk}`, 4000);
    });
    proc.start();
    task.meta.pid = proc.pid;
    this.logger.info(
      `task started id=${id} runId=${task.meta.runId} pid=${proc.pid} timeoutSec=${task.meta.timeoutSec} workspace=${task.workspace} access=${task.access}(${permissionMode}/${describeAccess(task.access)})`,
    );

    const timeoutTimer = setTimeout(() => {
      handle.timedOut = true;
      void proc.terminate();
    }, task.meta.timeoutSec * 1000);
    timeoutTimer.unref?.(); // 不阻止进程退出；但运行期间照常触发

    const { code, signal, spawnError } = await proc.done;
    clearTimeout(timeoutTimer);
    this.#flush(task, handle); // 冲刷最后一段增量
    acc.finish();

    task.exitCode = code;
    task.meta.signal = signal ?? null;
    if (handle.canceled) {
      task.status = 'canceled';
      task.error = null; // 用户主动取消不是错误
    } else if (handle.timedOut) {
      task.status = 'failed';
      task.error = readableError({ code, signal, timedOut: true, timeoutSec: task.meta.timeoutSec });
    } else if (spawnError) {
      task.status = 'failed';
      task.error = readableError({ code, signal, spawnError });
    } else if (code === 0) {
      task.status = 'succeeded';
      task.error = null;
    } else {
      task.status = 'failed';
      task.error = readableError({ code, signal, stderr: task.meta.stderrTail });
    }

    task.output = acc.output;
    task.truncated = acc.truncated;
    task.finishedAt = this.now();
    if (discover) {
      task.sessionId = await discoverSessionId({ home: this.config.home, workspace: task.workspace, before });
    }
    await this.persist(task);

    this.bus.publish('task.finished', { task: toPublicTask(task) }, id);
    const elapsed = task.finishedAt - (task.startedAt ?? task.createdAt);
    this.logger.info(
      `task finished id=${id} status=${task.status} exitCode=${task.exitCode} sessionId=${task.sessionId ?? 'null'} runId=${task.meta.runId} elapsedMs=${elapsed} bytes=${Buffer.byteLength(task.output, 'utf8')}`,
    );
  }

  /** stdout 增量：扣留尾部空白后按阈值/定时器批量下发，减少事件缓冲压力。 */
  #onOutput(task, handle, chunk) {
    const visible = handle.acc.push(chunk);
    if (!visible) return;
    handle.pending += visible;
    if (Buffer.byteLength(handle.pending, 'utf8') >= this.config.limits.outputFlushBytes) {
      this.#flush(task, handle);
      return;
    }
    if (!handle.flushTimer) {
      handle.flushTimer = setTimeout(() => {
        handle.flushTimer = null;
        this.#flush(task, handle);
      }, this.config.limits.outputFlushMs);
      handle.flushTimer.unref?.();
    }
  }

  /** 真正下发一次 task.output 事件，并同步 output/truncated（截断策略见 OutputAccumulator）。 */
  #flush(task, handle) {
    if (handle.flushTimer) {
      clearTimeout(handle.flushTimer);
      handle.flushTimer = null;
    }
    const delta = handle.pending;
    if (!delta) return;
    handle.pending = '';
    // 注意：这里用 acc.output 覆盖而非累加 —— 超限时 output 只保留尾部（A2-5），
    // 而本次 delta 已经全量下发，客户端拼接结果可能更长，以详情接口为准。
    task.output = handle.acc.output;
    task.truncated = handle.acc.truncated;
    this.bus.publish('task.output', { delta }, task.id);
    void this.#persistThrottled(task);
  }

  /** 内部异常也要有确定终态，不能让任务永远停在 running。 */
  async #failInternal(task, err) {
    this.logger.error(`task internal error id=${task.id}：${err?.message ?? err}`);
    if (task.status === 'canceled' || isTerminal(task.status)) return;
    task.status = 'failed';
    task.error = `网关内部错误：${err?.message ?? String(err)}`;
    task.finishedAt = this.now();
    await this.persist(task);
    this.bus.publish('task.finished', { task: toPublicTask(task) }, task.id);
  }
}
