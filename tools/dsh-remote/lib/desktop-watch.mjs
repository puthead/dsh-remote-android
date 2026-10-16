/**
 * 电脑端会话实时中继（契约 §7.4 的补环）。
 *
 * ## 为什么需要它
 *
 * 网关的会话事件总线（`session-live.mjs` 的 `SessionStream`）原本只在两条路上发事件：
 * 手机经网关投递的轮次（`session-runner.mjs` 的 `#submitDesktop` / SDK 路径），
 * 以及网关自己拉起的 SDK 子进程（`#onSessionEvent`）。
 * **在电脑端 DSH 界面里自己发起的轮次不属于这两条路**，对手机总线是完全静音的：
 * 手机端因此永远看不到那一轮的 `message.delta` / `tool.call` / `turn.ended`，
 * 详情页标题栏会一直卡在「已加载 N/M 条」，后续回复永远不出现（实测复现）。
 *
 * 桌面端提供了真值判据与订阅接口，本模块把它们补成一条中继：
 * - 真值：`session/list` 条目的 `running`（Windows 无 flock，文件 mtime 只能作兜底）；
 * - 订阅：`session/follow`（`assistantStream:true`）。它的**第一帧是 `snapshot`**，
 *   `snapshot.cursor` 即"已经包含的最后一条事件 seq"——把它当作水位线，
 *   只中继 `seq > cursor` 的事件，就不会把历史转录重复推给手机。
 *
 * ## 与"手机投递轮次"的边界（重要）
 *
 * 手机经网关投递的轮次由 `SessionRunner.desktopActive` 持有，**本模块必须让开**：
 * 两边同时发 `turn.ended` 会让手机端收尾逻辑跑两遍（实测过这种双发）。
 * 因此 `shouldWatch` 里显式排除 `desktopActive` 持有的会话，且轮次结束时
 * 由 `onTurnEnd` 回到 runner —— 只有 runner 同时知道 `turnId`/`resumable`/占用是否释放。
 */

import { translateDesktopEvent } from './desktop-api.mjs';

/** 发现「电脑端在跑的会话」的轮询间隔。2s 换来的是"最多晚 2 秒开始中继"。 */
export const DEFAULT_WATCH_POLL_MS = 2000;/** 中继订阅的流超时。必须远大于一轮的时长，否则长轮次会被自己的超时切断。 */
export const DEFAULT_WATCH_STREAM_TIMEOUT_MS = 30 * 60_000;
/** 首帧（snapshot）等待上限：桌面端不可达时不能把轮询循环挂死。 */
export const DEFAULT_WATCH_ATTACH_TIMEOUT_MS = 15_000;

export class DesktopTurnWatcher {
  /**
   * @param {{
   *   desktop: object,
   *   stream: object,
   *   logger?: object|null,
   *   pollMs?: number,
   *   streamTimeoutMs?: number,
   *   attachTimeoutMs?: number,
   *   shouldWatch?: (sessionId: string, entry: object) => boolean|Promise<boolean>,
   *   onTurnEnd?: (sessionId: string, info: object) => void|Promise<void>,
   *   now?: () => number,
   * }} opts
   */
  constructor({
    desktop,
    stream,
    logger = null,
    pollMs = DEFAULT_WATCH_POLL_MS,
    streamTimeoutMs = DEFAULT_WATCH_STREAM_TIMEOUT_MS,
    attachTimeoutMs = DEFAULT_WATCH_ATTACH_TIMEOUT_MS,
    shouldWatch = () => true,
    onTurnEnd = null,
    now = Date.now,
  }) {
    this.desktop = desktop;
    this.stream = stream;
    this.logger = logger;
    this.pollMs = pollMs;
    this.streamTimeoutMs = streamTimeoutMs;
    this.attachTimeoutMs = attachTimeoutMs;
    this.shouldWatch = shouldWatch;
    this.onTurnEnd = onTurnEnd;
    this.now = now;
    /** @type {Map<string, {sessionId: string, controller: AbortController, watermark: number, turn: number|null, startedAt: number, emitting: boolean, relayed: number, text: number, toolCalls: number, done: boolean, settle: Function|null}>} */
    this.watches = new Map();
    this.timer = null;
    this.ticking = false;
    // `stopped` 只表示"已经停掉"（`stop()` 之后不再发现），不表示"定时器还没起来"：
    // `start()` 之外也可以手工 `tick()`（单测就是靠这个精确驱动发现循环的）。
    this.stopped = false;
    this.stats = { polls: 0, attaches: 0, attachesFailed: 0, relays: 0, turnsEnded: 0, lastError: null, lastPollAt: null };
  }

  /** 已订阅中继的会话 id（供健康检查/排障展示）。 */
  activeSessions() {
    return [...this.watches.values()].filter((w) => !w.done).map((w) => w.sessionId);
  }

  /**
   * 这条会话是否已经由中继接管（事件正在经会话总线下发）。
   *
   * `http.mjs` 用它避免"两条生产者"：中继已经在写总线了，就不该再对同一个会话开一条
   * 直推的观望型订阅 —— 那个客户端的响应会同时收到总线和直推两份同样的 `message.delta`。
   */
  isWatching(sessionId) {
    const watch = this.watches.get(sessionId);
    return Boolean(watch) && !watch.done;
  }

  /**
   * 起轮询（幂等：已经在跑就直接返回）。
   *
   * 判据是 `timer` 而不是 `stopped` —— 这两件事在语义上是分开的：`stopped` 表示"已经停掉、
   * 别再发现"，而"定时器起没起"由 `timer` 表示。早先这里写成 `if (!this.stopped) return this;`
   * 时，构造函数把 `stopped` 初始化为 `false`（为了允许手工 `tick()`），于是 `start()` 每次都
   * 立刻返回、一个 tick 都不跑：中继在真机上完全不会工作（被 `v2/desktop` 的中继用例钉住）。
   */
  start() {
    if (this.timer !== null) return this;
    if (this.desktop === null || this.desktop === undefined) {
      this.logger?.warn('未接入桌面端 runtime：电脑端会话实时中继未启动');
      return this;
    }
    this.stopped = false;
    this.logger?.info(
      `电脑端会话实时中继已启动：每 ${this.pollMs}ms 轮询桌面端运行态，发现 running 的会话即订阅 session/follow（手机端无需任何改动）`,
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    // 轮询是后台能力，绝不能吊住事件循环（否则网关进程退不出去）。
    this.timer.unref?.();
    void this.tick();
    return this;
  }

  async stop() {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const active = [...this.watches.values()];
    for (const watch of active) {
      watch.done = true;
      try {
        watch.settle?.();
      } catch {
        /* 收尾失败不影响关停 */
      }
      await this.#closeStream(watch);
      try {
        watch.controller.abort();
      } catch {
        /* 忽略取消失败 */
      }
    }
    this.watches.clear();
    // 给迭代器的 finally 一点时间关掉 WebSocket（否则关停时 socket 会漏一个）。
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 20);
      timer.unref?.();
    });
  }

  /** 一轮发现。并发调用会被 `ticking` 挡住（interval 与手动触发可能重叠）。 */
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      let items;
      try {
        items = await this.desktop.listSessions();
      } catch (err) {
        this.stats.lastError = `读取桌面端会话运行态失败：${String(err?.message ?? err)}`;
        this.logger?.warn(`${this.stats.lastError}（电脑端会话实时中继本轮跳过）`);
        return;
      }
      this.stats.polls += 1;
      this.stats.lastPollAt = this.now();
      const running = items.filter((item) => item?.running === true && typeof item?.sessionId === 'string');
      this.#reapFinished(running);
      if (this.stopped) return;
      for (const entry of running) {
        if (this.watches.has(entry.sessionId)) continue;
        if (!(await this.#eligible(entry))) continue;
        // 顺序等待：一次只订阅一路，避免同时开一堆 WebSocket。
        await this.attachNow(entry);
        if (this.stopped) return;
      }
    } finally {
      this.ticking = false;
    }
  }

  /** 运行态已消失（或已由别的通道收束）→ 停掉中继订阅。 */
  #reapFinished(running) {
    const stillRunning = new Set(running.map((item) => item.sessionId));
    for (const watch of [...this.watches.values()]) {
      if (watch.done) {
        this.watches.delete(watch.sessionId);
        continue;
      }
      if (!stillRunning.has(watch.sessionId)) {
        this.logger?.info(
          `电脑端会话轮次已结束（运行态消失）sessionId=${watch.sessionId} relayed=${watch.relayed} 条 delta=${watch.text} 字 工具=${watch.toolCalls} 次`,
        );
        void this.#retire(watch.sessionId, 'completed', null);
      }
    }
  }

  /** 值守范围：桌面端正在跑、且调用方认可（通常是"顶层会话、镜像里可见、非本进程占用"）。 */
  async #eligible(entry) {
    try {
      return (await this.shouldWatch(entry.sessionId, entry)) === true;
    } catch (err) {
      this.logger?.warn(`会话中继资格判定异常 sessionId=${entry.sessionId}：${String(err?.message ?? err)}`);
      return false;
    }
  }

  /**
   * 订阅一个会话的后续事件。
   *
   * 首帧必须是 `snapshot`：它给出水位线 `cursor` 与当前投影，
   * 于是"中途接入"既不会重复历史，也能立刻告诉手机"这一轮在跑"。
   *
   * 公开而非私有：单测需要在不跑轮询循环的前提下精确驱动"发现 → 订阅 → 中继"，
   * 轮询循环本身只是它的调度器。
   *
   * @param {object} entry 桌面端 `session/list` 的条目（至少要有 sessionId）
   */
  async attachNow(entry) {
    const sessionId = entry.sessionId;
    const controller = new AbortController();
    const watch = {
      sessionId,
      controller,
      watermark: Number.isFinite(entry?.projections?.asOfSeq) ? Number(entry.projections.asOfSeq) : 0,
      turn: sessionTurnOf(entry),
      startedAt: this.now(),
      emitting: false,
      relayed: 0,
      text: 0,
      toolCalls: 0,
      done: false,
      reason: null,
      settle: null,
      title: entry?.projections?.values?.title ?? null,
    };
    // 先登记再 await：否则同一个会话会被下一轮 tick 重复订阅（interval 与 tick 可能重叠）。
    this.watches.set(sessionId, watch);
    this.stats.attaches += 1;

    let iterator;
    try {
      iterator = this.desktop.openFollow(sessionId, {
        assistantStream: true,
        signal: controller.signal,
        timeoutMs: this.streamTimeoutMs,
      });
    } catch (err) {
      this.watches.delete(sessionId);
      this.stats.attachesFailed += 1;
      this.logger?.warn(`订阅电脑端会话事件流失败 sessionId=${sessionId}：${String(err?.message ?? err)}`);
      return;
    }
    // 记在 watch 上：中继在 `turn/end` 上是**提前跳出消费循环**的，生成器仍挂在 `yield` 上，
    // 只有显式 `return()` 才会跑它的 `finally`（真实实现那里才 `socket.close()`）。
    watch.iterator = iterator;

    let firstStep;
    try {
      firstStep = await withTimeout(iterator.next(), this.attachTimeoutMs);
    } catch (err) {
      this.watches.delete(sessionId);
      this.stats.attachesFailed += 1;
      await this.#closeStream(watch);
      try {
        controller.abort();
      } catch {
        /* 忽略 */
      }
      this.logger?.warn(`订阅电脑端会话事件流失败 sessionId=${sessionId}：${String(err?.message ?? err)}`);
      return;
    }
    if (firstStep?.done) {
      this.watches.delete(sessionId);
      this.stats.attachesFailed += 1;
      await this.#closeStream(watch);
      const failure = firstStep.value?.error ?? null;
      this.logger?.warn(`订阅电脑端会话事件流结束 sessionId=${sessionId}：${failure?.message ?? '桌面端未返回任何帧'}`);
      return;
    }

    const snapshot = firstStep.value;
    if (snapshot?.type === 'snapshot' && Number.isFinite(snapshot.cursor)) {
      watch.watermark = Math.max(watch.watermark, Number(snapshot.cursor));
    }
    const stats = snapshot?.projections?.values?.sessionStats;
    if (stats) watch.turn = pickTurn(entry, stats);
    watch.emitting = true;

    // 手机端靠 `turn.started` 才能显示"正在执行第 N 轮"；中途接入时这一帧已经过去，
    // 由中继补发一次（`messageId:null` 表示不是它投递的轮次）。
    this.stream.emit(
      'turn.started',
      { sessionId, source: 'computer', turn: watch.turn, fromSeq: watch.watermark + 1, turnId: `watch-${sessionId.slice(-8)}`, messageId: null, relayed: true },
      { sessionId },
    );
    this.logger?.info(
      `已接入电脑端会话实时中继 sessionId=${sessionId} 水位线 seq=${watch.watermark} turn=${watch.turn ?? '?'}`,
    );

    void this.#consume(watch, iterator, firstStep).catch((err) => {
      this.logger?.warn(`电脑端会话中继消费异常 sessionId=${sessionId}：${String(err?.message ?? err)}`);
    });
  }

  /**
   * 消费中继流：丢弃回放（`seq <= watermark`），其余翻译成手机端 SSE 词汇下发。
   *
   * `assistant-stream` 帧**有意忽略**：手机端没有 `assistant-stream` 词汇，
   * 它需要的增量文本由 `assistant/message` 事件承载（与 `#consumeDesktopStream` 同口径）。
   */
  async #consume(watch, iterator, firstStep) {
    let step = firstStep;
    while (!watch.done && !this.stopped) {
      if (step.done) {
        const result = step.value ?? null;
        if (!watch.done && result?.error) {
          this.logger?.warn(`电脑端会话中继流结束 sessionId=${watch.sessionId}：${result.error.message ?? result.error.code}`);
        }
        break;
      }
      const value = step.value;
      if (value?.type === 'snapshot') {
        if (Number.isFinite(value.cursor)) watch.watermark = Math.max(watch.watermark, Number(value.cursor));
        step = await iterator.next();
        continue;
      }
      if (value?.type === 'event') {
        const seq = typeof value.event?.seq === 'number' ? value.event.seq : null;
        if (seq !== null && seq <= watch.watermark) {
          // 回放段：历史转录不该再推给手机（手机自己会分页拉）。
          step = await iterator.next();
          continue;
        }
        if (seq !== null) watch.watermark = seq;
        const frame = translateDesktopEvent(value);
        if (frame !== null) {
          if (frame.type === 'turn.ended') {
            // 终态交由 `#retire` 独家发出（口径与 runner 的 `#finishDesktopTurn` 一致）。
            watch.reason = frame.data.reason ?? 'completed';
            break;
          }
          const data = { ...frame.data, sessionId: watch.sessionId, source: 'computer' };
          this.stream.emit(frame.type, data, { sessionId: watch.sessionId });
          watch.relayed += 1;
          this.stats.relays += 1;
          if (frame.type === 'message.delta') watch.text += (frame.data.text ?? '').length;
          else if (frame.type === 'tool.call') watch.toolCalls += 1;
        }
      }
      step = await iterator.next();
    }
    if (!watch.done) await this.#retire(watch.sessionId, watch.reason ?? 'completed', null);
  }

  /** 收束一路中继：发终态、交回 runner 善后，并关掉订阅。 */
  async #retire(sessionId, reason, error) {
    const watch = this.watches.get(sessionId);
    if (!watch || watch.done) return;
    watch.done = true;
    this.watches.delete(sessionId);
    this.stats.turnsEnded += 1;
    // `turnId` 在两条通道里必须一致：上面发的终态与回给 runner 的善后用的都是它，
    // 否则日志里会出现"发了 X 却收尾 Y"，排障时无从对账。
    const turnId = `watch-${sessionId.slice(-8)}`;
    this.stream.emit(
      'turn.ended',
      {
        sessionId,
        source: 'computer',
        turn: watch.turn ?? null,
        reason,
        turnId,
        // 桌面端取消一轮不是破坏性的，与 runner 的电脑端通道同口径。
        resumable: true,
        relayed: true,
        ...(error ? { error } : {}),
      },
      { sessionId },
    );
    try {
      await this.onTurnEnd?.(sessionId, { reason, error, watch, turnId });
    } catch (err) {
      this.logger?.warn(`电脑端会话中继收尾失败 sessionId=${sessionId}：${String(err?.message ?? err)}`);
    }
    try {
      watch.settle?.();
    } catch {
      /* 忽略 */
    }
    await this.#closeStream(watch);
    try {
      watch.controller.abort();
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 关掉一路中继的桌面端订阅。
   *
   * 必须显式 `iterator.return()`：真实 `DesktopApi.openStream` 的 `socket.close()` 写在生成器的
   * `finally` 里（`desktop-api.mjs:578-582`），而中继收到 `turn/end` 是**提前跳出消费循环**的，
   * 生成器还挂在 `yield` 上 —— 不动它就等于每轮漏一个 WebSocket（未 unref 的 socket 会把网关
   * 进程吊住退不出去）。`abort()` 只是兜底（真实实现里 abort 也会关 socket，但那不解除
   * `abort` 监听与生成器状态）。
   */
  async #closeStream(watch) {
    const iterator = watch?.iterator ?? null;
    if (!iterator) return;
    watch.iterator = null;
    try {
      await iterator.return?.();
    } catch {
      /* 关闭失败不影响收尾 */
    }
  }
}

/**
 * 当前轮次序号：投影里已知的最大轮号。
 *
 * **不要 +1。** 这里报的是"正在跑的这一轮是第几轮"，不是"下一轮是第几轮"：中继是在轮次
 * 进行中接入的，那一轮**已经**开始了。实测（`.probe/turn-numbering.mjs`，2026-10-15 21:0x，
 * 正在跑第 4 轮、prompt「手机端还是这样，修复下这个问题」）：
 * `sessionStats.turns = 4`、`turnOutline` 的 max turn = 4、`turnOutline` 末尾就是这一轮的 prompt
 * —— 两处投影**都**已包含运行中的轮次，取大即得真值；再 +1 会报成第 5 轮。
 *
 * 两处取大是为了兜住投影滞后：`turnOutline` 由转录派生、`sessionStats` 由统计派生，任一可能
 * 落后一轮，取大者更接近真值。
 */
export function pickTurn(entry, stats) {
  const outline = Array.isArray(entry?.projections?.values?.turnOutline) ? entry.projections.values.turnOutline : [];
  let last = 0;
  for (const item of outline) {
    const turn = Number(item?.turn);
    if (Number.isFinite(turn) && turn > last) last = turn;
  }
  const count = Number(stats?.turns);
  const base = Math.max(last, Number.isFinite(count) ? count : 0);
  return base > 0 ? base : null;
}

function sessionTurnOf(entry) {
  return pickTurn(entry, entry?.projections?.values?.sessionStats ?? null);
}

/** 给 `iterator.next()` 加超时：桌面端不回帧时不能把发现循环挂死。 */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`等待首帧超时（${ms}ms）`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
