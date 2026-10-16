/**
 * 事件总线：全局单调递增 seq + 最近 N 条环形缓冲 + 订阅分发。
 *
 * 为什么自己做而不是 EventEmitter：契约要求 SSE 断点续传（fromSeq/Last-Event-ID 补齐），
 * 这要求事件带全局序号且可回溯，EventEmitter 无法回放。
 * 为什么保留 2000 条：契约 §4 明确规定。
 */
export class EventBus {
  /**
   * @param {{bufferSize?: number, now?: () => number}} [opts]
   */
  constructor({ bufferSize = 2000, now = Date.now } = {}) {
    this.bufferSize = Math.max(1, bufferSize);
    this.now = now;
    /** @type {Array<{seq:number, taskId:string|null, at:number, type:string}>} */
    this.buffer = [];
    this.seq = 0;
    /** @type {Set<{taskId: string|null, afterSeq: number, onEvent: (ev: object) => void}>} */
    this.subscribers = new Set();
    this.dropped = 0; // 因缓冲上限被丢弃的事件数，用于向客户端说明「补不齐」
  }

  /**
   * 发布事件并分发给订阅者。
   *
   * `decorate` 在**入缓冲与分发之前**调用，收到的就是最终事件对象（`seq` 已就位）。
   * 这是 `SessionStream.emit` 用来补 `dshSeq`/`streamSeq`/`sessionId` 的钩子：订阅者是
   * 在 `publish` 里**同步**收到事件的，事后再往对象上挂字段对它们不可见 ——
   * 曾因此让所有实时 SSE 客户端拿不到 `data.seq`（手机端的 `appliedSeq` 去重闸失效）。
   * @param {string} type 事件类型（task.created/task.started/task.output/task.finished/task.progress）
   * @param {object} payload 业务字段（task/delta/phase/note 等）
   * @param {string|null} [taskId]
   * @param {((ev: object) => void)|null} [decorate] 分发前修饰事件（可选）
   * @returns {object} 完整事件对象（含 seq/at/type）
   */
  publish(type, payload = {}, taskId = null, decorate = null) {
    const ev = { seq: ++this.seq, taskId, at: this.now(), type, ...payload };
    if (typeof decorate === 'function') decorate(ev);
    this.buffer.push(ev);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
      this.dropped++;
    }
    for (const sub of this.subscribers) {
      if (sub.taskId && sub.taskId !== taskId) continue;
      if (ev.seq <= sub.afterSeq) continue; // 订阅建立时已回放过的序号，避免重复投递
      try {
        sub.onEvent(ev);
      } catch {
        /* 单个订阅者异常不影响其它订阅者 */
      }
    }
    return ev;
  }

  /**
   * 构造一个「起止可续传」的订阅：先回放缓冲内 seq > fromSeq 的事件，再接续实时事件。
   * 关键点：回放与注册订阅在同一 tick 内完成（Node 单线程），期间不可能插入新事件，
   * 因此既不漏（先订阅会有夹缝）也不重（后订阅会有夹缝）。
   *
   * **来自未来的游标**（最容易静默出事的一种）：本总线的 `seq` 是**进程内**计数器，网关一重启就
   * 从 1 重新开始，而客户端（手机端把游标持久化在 prefs 里，见 `ConsoleRepository.busCursor`）
   * 会带着上一个进程的游标重连。若照单全收，`afterSeq` 就落在一个本进程永远够不到的高位，
   * `publish()` 的 `ev.seq <= sub.afterSeq` 会把这条订阅**永久静音** —— 连接还在、心跳还在、
   * 客户端显示"在线"，但一个字都收不到（2026-10-15 生产网关上重启后实测）。
   * 因此 `fromSeq > this.seq` 时收敛到当前最大 seq：不假装能补齐（那些事件在别的进程里，
   * 本进程也无从回放），只接续**实时**事件，让客户端下一帧就活过来。
   * @param {{taskId?: string|null, fromSeq?: number, onEvent: (ev: object) => void}} opts
   * @returns {{unsubscribe: () => void, replayed: number, gap: boolean, oldestSeq: number|null, epochReset: boolean}}
   */
  subscribe({ taskId = null, fromSeq = 0, onEvent }) {
    const epochReset = Number.isFinite(fromSeq) && fromSeq > this.seq;
    const cursor = epochReset ? this.seq : fromSeq;
    const all = this.since(cursor, taskId);
    const oldestSeq = this.buffer.length ? this.buffer[0].seq : null;
    // gap=true 表示客户端请求的 fromSeq 已早于缓冲区起点，缺失部分无法补齐
    const gap = oldestSeq !== null && cursor > 0 && cursor < oldestSeq - 1;
    const lastReplayed = all.length ? all[all.length - 1].seq : cursor;

    const sub = { taskId, afterSeq: lastReplayed, onEvent };
    this.subscribers.add(sub);

    for (const ev of all) onEvent(ev);

    return {
      unsubscribe: () => this.subscribers.delete(sub),
      replayed: all.length,
      gap,
      oldestSeq,
      epochReset,
    };
  }

  /**
   * 取出缓冲中 seq > fromSeq 的事件（可选按任务过滤）。
   * @param {number} fromSeq
   * @param {string|null} [taskId]
   */
  since(fromSeq, taskId = null) {
    const out = [];
    for (const ev of this.buffer) {
      if (ev.seq <= fromSeq) continue;
      if (taskId && ev.taskId !== taskId) continue;
      out.push(ev);
    }
    return out;
  }

  /** @returns {number} 缓冲区中最小 seq（无事件时为 0） */
  get firstSeq() {
    return this.buffer.length ? this.buffer[0].seq : 0;
  }

  /** 订阅者数量（测试用，用于验证 SSE 断开后无泄漏）。 */
  get subscriberCount() {
    return this.subscribers.size;
  }
}
