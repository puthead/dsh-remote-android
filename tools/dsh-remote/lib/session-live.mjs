/**
 * 会话运行态：`live` 判定、本进程轮次占用表、SSE 增量事件总线（契约 §4.2 / §5.4）。
 *
 * 三层"忙"的信号，强度递增 —— 三层必须分开，否则手机端会收到错误的错误码：
 *
 * | 信号 | 判据 | 含义 | 对应错误 |
 * |---|---|---|---|
 * | `live`  | 会话文件 mtime 在 60s 内（契约 §5.4 明文规定） | PC 上（可能是桌面端/别的进程）正在写这个会话 | `409 session_busy` |
 * | `taken` | 本进程的轮次占用表里有它 | **本网关**已经有一个轮次在跑 | `503 session_taken` |
 *
 * 为什么把 `taken` 放在 `live` 之前判定：`taken` 更具体、更可操作（"你自己已经在跑了"），
 * 而 `live` 可能是桌面端正在用（"别处正在写"）。手机端看到的原因不同，处理也不同。
 *
 * SSE 事件总线与 v1 的 `EventBus` 分开：v1 的 seq 空间属于任务事件，
 * v2 的 seq 空间属于会话事件，混用会让 `Last-Event-ID` 续传在两个接口间串号。
 */
import { EventBus } from './events.mjs';

/** 契约 §5.4：mtime 60s 内视为 live。 */
export const LIVE_WINDOW_MS = 60_000;

/** 契约 §4.2：SSE 心跳 15s。 */
export const STREAM_HEARTBEAT_MS = 15_000;

/** v2 SSE 事件类型（契约 §4.2 事件名枚举）。 */
export const STREAM_EVENTS = Object.freeze({
  sessionUpdated: 'session.updated',
  sessionCreated: 'session.created',
  turnStarted: 'turn.started',
  turnEnded: 'turn.ended',
  messageDelta: 'message.delta',
  toolCall: 'tool.call',
  toolResult: 'tool.result',
  heartbeat: 'heartbeat',
});

/**
 * 会话运行态与轮次占用表。
 */
export class LiveTracker {
  /**
   * @param {{windowMs?: number, now?: () => number, ttlMs?: number}} [opts]
   */
  constructor({ windowMs = LIVE_WINDOW_MS, now = Date.now, ttlMs = 24 * 3600_000 } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {Map<string, {sessionId: string, turnId: string, startedAt: number, pid: number|null, prompt: string|null}>} */
    this.occupancy = new Map();
    /** 本进程累计启动的轮次数（诊断）。 */
    this.started = 0;
    this.finished = 0;
  }

  /**
   * `live` 判定：会话文件 mtime 在窗口内。
   * @param {number|null|undefined} mtimeMs
   * @returns {boolean}
   */
  isLive(mtimeMs) {
    return typeof mtimeMs === 'number' && mtimeMs > 0 && this.now() - mtimeMs <= this.windowMs;
  }

  /**
   * 该会话是否被本进程占用。
   * @param {string} sessionId
   */
  isTaken(sessionId) {
    const held = this.occupancy.get(sessionId);
    if (!held) return false;
    // 兜底：占用超过 ttlMs 视为僵死记录（进程被强杀时 release 不会执行）
    if (this.now() - held.startedAt > this.ttlMs) {
      this.occupancy.delete(sessionId);
      return false;
    }
    return true;
  }

  /** 当前占用信息（诊断/SSE 用）。 */
  held(sessionId) {
    return this.isTaken(sessionId) ? this.occupancy.get(sessionId) : null;
  }

  /** 当前被占用的会话 id 列表。 */
  list() {
    return [...this.occupancy.keys()].filter((id) => this.isTaken(id));
  }

  /**
   * 占用一个会话。
   * @param {{sessionId: string, turnId: string, pid?: number|null, prompt?: string|null}} input
   * @returns {{ok: true, held: object} | {ok: false, code: 'session_taken', held: object}}
   */
  acquire({ sessionId, turnId, pid = null, prompt = null }) {
    if (this.isTaken(sessionId)) return { ok: false, code: 'session_taken', held: this.occupancy.get(sessionId) };
    const held = { sessionId, turnId, startedAt: this.now(), pid, prompt: prompt ? String(prompt).slice(0, 200) : null };
    this.occupancy.set(sessionId, held);
    this.started += 1;
    return { ok: true, held };
  }

  /** 释放占用（幂等）。 */
  release(sessionId) {
    const had = this.occupancy.delete(sessionId);
    if (had) this.finished += 1;
    return had;
  }

  /** 清空（测试/关闭）。 */
  clear() {
    this.occupancy.clear();
  }

  /**
   * 综合"正在跑"判定（契约 §5.4 的下界 + 侦察报告 §6 的补漏信号）。
   *
   * 三个信号，各自的来源与不确定性：
   * 1. **mtime 60s 内**（契约 §5.4 明文）：**必要不充分** —— 实测有会话在跑但 6 秒内 0 字节写入；
   *    反之一个刚结束的会话在 60s 内仍会被判 live（这是契约规定的保守下界，接受）。
   * 2. **projcache `turnBoundary.openTurnStartSeq !== null`**：桌面端投影缓存的权威"轮次未收尾"信号。
   *    不确定性：projcache 只在桌面端打开过该会话时才存在/更新，SDK 会话可能没有。
   * 3. **projcache `sessionStats.openStep` / `pendingCalls`**：同源的更细粒度信号
   *    （step 未收尾 / 工具调用未返回）。
   *
   * 三者取 **OR**：宁可偶发误判"忙"（手机端重试一次即可），也不要漏判导致两处同时写同一会话。
   * 唯一权威的"一轮已结束"信号是 `turn/end` 事件（对网关自己拉起的轮次，由占用表精确判定）。
   * @param {{mtimeMs?: number|null, projcache?: object|null}} input
   * @returns {boolean}
   */
  isBusy({ mtimeMs = null, projcache = null } = {}) {
    if (this.isLive(mtimeMs)) return true;
    if (!projcache) return false;
    if (projcache.openTurnStartSeq !== null && projcache.openTurnStartSeq !== undefined) return true;
    if (projcache.openStep !== null && projcache.openStep !== undefined) return true;
    const pending = projcache.pendingCalls;
    return Boolean(pending && typeof pending === 'object' && Object.keys(pending).length > 0);
  }

  /**
   * 续聊准入判定（契约 §4.2）。
   * @param {{sessionId: string, mtimeMs?: number|null, projcache?: object|null}} input
   * @returns {{ok: true} | {ok: false, code: 'session_taken'|'session_busy', message: string}}
   */
  admit({ sessionId, mtimeMs = null, projcache = null }) {
    if (this.isTaken(sessionId)) {
      return { ok: false, code: 'session_taken', message: `该会话已被本进程的另一个轮次占用：${sessionId}` };
    }
    if (this.isBusy({ mtimeMs, projcache })) {
      return { ok: false, code: 'session_busy', message: `该会话正在运行（文件在 ${Math.round(this.windowMs / 1000)}s 内有写入）；请等待当前轮次结束` };
    }
    return { ok: true };
  }

  /** 诊断快照。 */
  stats() {
    return { occupied: this.list().length, started: this.started, finished: this.finished, windowMs: this.windowMs };
  }
}

/**
 * v2 会话事件总线：全局单调 seq（= SSE 的 `id:`，供 `Last-Event-ID`/`?fromSeq=` 续传）。
 *
 * 注意两套 seq 的区别（这是最容易搞混的地方）：
 * - `streamSeq`（本总线分配）：**SSE 的 `id:` 行**与 `?fromSeq=` 用的续传游标；
 * - `dshSeq`（DSH 会话事件自带的 seq）：放在 `data.seq` 里，供手机端与 `/events` 对齐。
 * 契约示例里的 `data.seq: 1779` 指的是后者，因此两者都给出、不互相冒充。
 */
export class SessionStream extends EventBus {
  /**
   * @param {{bufferSize?: number, now?: () => number}} [opts]
   */
  constructor({ bufferSize = 4000, now = Date.now } = {}) {
    super({ bufferSize, now });
  }

  /**
   * 发布一条会话流事件。
   *
   * **seq 冲突处理**：`EventBus.publish` 用 `{seq: ++this.seq, ...payload}` 组装事件，
   * 若 payload 里也带 `seq`（契约 §4.2 的 `message.delta` 就要带 DSH 事件 seq），
   * 会把总线游标覆盖掉 —— 那会让 SSE 的 `id:` 与续传游标彻底错乱（实测踩过）。
   * 因此这里把 payload 的 `seq` 扣下来改名为 `dshSeq`，总线游标永远由 `seq` 独占；
   * HTTP 层在格式化 SSE 时再把它还原成 `data.seq`。
   * @param {string} type STREAM_EVENTS 里的类型
   * @param {object} payload 业务字段（sessionId/seq/role/text/...）
   * @param {{sessionId?: string|null}} [opts]
   * @returns {object} 含 `seq`（总线游标）、`streamSeq`（同值别名）、可选 `dshSeq`
   */
  emit(type, payload = {}, { sessionId = null } = {}) {
    const { seq: dshSeq, ...rest } = payload;
    // 这些字段必须在 `publish` **分发之前**挂上：订阅者是在 `publish` 内部同步收到事件的，
    // 事后 `ev.dshSeq = …` 只对拿返回值的人可见，SSE 客户端会拿不到 `data.seq`
    // （手机的 `appliedSeq` 去重闸与转录合并键都吃这个字段）。
    return this.publish(type, rest, sessionId, (ev) => {
      ev.streamSeq = ev.seq;
      if (dshSeq !== undefined && dshSeq !== null) ev.dshSeq = dshSeq;
      if (sessionId) ev.sessionId = sessionId;
    });
  }

  /** 会话过滤：只保留该会话的事件（heartbeat/session.* 无 sessionId 时仍放行）。 */
  subscribeSession({ sessionId = null, fromSeq = 0, includeGlobal = true, onEvent }) {
    const wrapped = (ev) => {
      if (sessionId && ev.sessionId && ev.sessionId !== sessionId) return;
      if (sessionId && !ev.sessionId && !includeGlobal) return;
      onEvent(ev);
    };
    return this.subscribe({ taskId: null, fromSeq, onEvent: wrapped });
  }
}

/**
 * 把 dsh `--json` 的一行事件映射为契约 §4.2 的 SSE 事件（可能映射为 0 条）。
 *
 * dsh `--json` 的真实形状（已实测）：
 * ```
 * {"type":"session","sessionId":"session-…","cwd":"…"}
 * {"type":"status","phase":"turn_start","turn":1}
 * {"type":"status","phase":"step_start","turn":1,"step":1}
 * {"type":"status","phase":"step_end","turn":1,"step":1,"usage":{…}}
 * {"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"completed"}}
 * {"type":"thinking","text":"…"}   {"type":"text","text":"…"}   {"type":"final","text":"…"}
 * ```
 * @param {object} line 解析后的一行
 * @param {{sessionId: string, fromSeq?: number|null, seqRef?: {value: number}}} ctx
 * @returns {Array<{type: string, data: object}>}
 */
export function mapRunnerLine(line, { sessionId, fromSeq = null, seqRef = null } = {}) {
  const out = [];
  if (!line || typeof line !== 'object') return out;
  const next = () => {
    if (!seqRef) return fromSeq ?? null;
    // 子进程事件没有 DSH 会话 seq（那是落盘后才有），这里给出可对齐的递增序号
    if (seqRef.value === null || seqRef.value === undefined) seqRef.value = fromSeq ?? 0;
    else seqRef.value += 1;
    return seqRef.value;
  };
  switch (line.type) {
    case 'session':
      out.push({ type: STREAM_EVENTS.sessionCreated, data: { sessionId: line.sessionId ?? sessionId, workspace: line.cwd ?? null } });
      break;
    case 'status':
      if (line.phase === 'turn_start') out.push({ type: STREAM_EVENTS.turnStarted, data: { sessionId, turn: line.turn ?? null, fromSeq: fromSeq ?? null } });
      else if (line.phase === 'turn_end') out.push({ type: STREAM_EVENTS.turnEnded, data: { sessionId, turn: line.turn ?? null, reason: line.reason?.kind ?? null, usage: line.usage ?? null } });
      else if (line.phase === 'step_end') out.push({ type: STREAM_EVENTS.sessionUpdated, data: { sessionId, step: line.step ?? null, usage: line.usage ?? null } });
      break;
    case 'thinking':
      if (line.text) out.push({ type: STREAM_EVENTS.messageDelta, data: { sessionId, seq: next(), role: 'assistant', channel: 'reasoning', text: line.text } });
      break;
    case 'text':
      if (line.text) out.push({ type: STREAM_EVENTS.messageDelta, data: { sessionId, seq: next(), role: 'assistant', channel: 'text', text: line.text } });
      break;
    case 'tool':
      // 未来的工具事件（当前 headless 不产出）：保守映射，不认识就丢弃
      if (line.phase === 'call' || line.name) out.push({ type: STREAM_EVENTS.toolCall, data: { sessionId, seq: next(), name: line.name ?? null, args: line.args ?? null } });
      break;
    case 'final':
      out.push({ type: STREAM_EVENTS.sessionUpdated, data: { sessionId, final: true, text: line.text ?? '' } });
      break;
    default:
      break;
  }
  return out;
}
