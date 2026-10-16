/**
 * 审批/提问桥（契约 v2 §7.7）：把桌面端 runtime 的 `$events` waterfall 帧接进网关，
 * 让**手机**能应答电脑端会话的审批（`approval/request`）与提问（`user-questions/request`）。
 *
 * ## 为什么必须是这条通道
 *
 * 已实测：审批**不是**一元 RPC。会话 RPC 面（`session/*`、`workspace/*`、
 * `agentPresets/*`、`directoryPicker/*`、`workspaceFiles/*`）里没有任何 approve/deny/confirm
 * 方法；`dsh-user-approval` 的 `decide()` 走的是 Cordis **waterfall**：
 *
 * ```
 * ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req,
 *               () => Promise.resolve('unavailable'))
 * ```
 *
 * 客户端可应答的转发事件**只有两条**（`dsh-api-remotes/lib/types/remote-events.js` 的
 * `API_REMOTE_FORWARDED_EVENTS`，27 条里仅 2 条 `mode:'waterfall'`）：
 * `approval/request` 与 `user-questions/request`。其余全部是 fire-and-forget 的 `emit`。
 *
 * 线协议（`dsh-api-gateway/lib/types/stream-protocol.js`）：
 * - 载体：WS `/api/remote.mux`，逻辑流 `$events`（`payload.args` 必须是**空对象**）；
 * - 首帧 `{type:'ready', clientId, host:{home}}`；
 * - 提问帧 `{type:'waterfall', event, eventId, agentId, request}`，
 *   其中 `request` 已被 `projectRemoteEventRequest` **剥掉 `agent`/`signal`**
 *   —— 所以线上没有 approvalId，客户端**只能用 `eventId` 关联**；
 * - 回答案：`POST /api/$events/result`，payload `{clientId, eventId, outcome}`，
 *   outcome ∈ `{kind:'next'}` / `{kind:'result', value?}` / `{kind:'rejected', error}`。
 *
 * ## 三个必须守住的约束（都是实测踩出来的）
 *
 * 1. **回答案时 `$events` 流必须活着**。网关按 `clientId` 查 `remoteEventClients`，
 *    流一断（`openRemoteEvents` 的 `finally` 会 `removeRemoteEventClient`）就查不到，
 *    回答案得到 `typert gateway: Remote event result identifies no active event stream`。
 *    所以这里用一条**常驻订阅**（断线重连），而不是"要答的时候临时开一条"。
 * 2. **没有 waterfall 重放保证** —— 订阅必须在提问**之前**建立。常驻订阅天然满足；
 *    而桌面端 `pendingRemoteEvents` 会把**未决**事件补给新客户端（实测：新连接立刻收到
 *    上一次遗留的 ask），所以重连后未决提问仍可答。
 * 3. **没有超时**。两棵树里都没有 approval 超时逻辑：无人应答时 waterfall 永远悬着，
 *    工具调用也永远不返回。所以"过期"只能是**网关侧**的记账（`approval.expired`），
 *    它不会让电脑端那边的轮次结束 —— 文档里必须如实写清。
 *    （唯一的例外是 `ask_user_question` 的**带 timeout 变体**：工具到点会先返回
 *    `{pending:true, callId}` 让本轮继续，而 waterfall 仍可被迟到答案填上，那条迟到的答案
 *    会以一条 `source.kind='user-question-reply'` 的用户消息进入会话 —— 即"答晚 ≠ 答不上"。）
 *
 * ## 扇出与竞态
 *
 * 桌面端 UI 自己也是一个 `$events` 客户端。谁先答谁赢（waterfall 取第一个终端答案），
 * 后到的答案拿不到错误也改不了结果。手机端因此要按"**可能是别人先答了**"来设计 UI：
 * 答案返回 `ok` 不代表这个决定是手机做的，只代表这次提交被网关受理了。
 *
 * ## 覆盖面（如实）
 *
 * 只覆盖**落在桌面端 runtime 里的会话**（`source=computer`，含手机新建但默认落电脑端的任务）。
 * 网关自己用 `dsh --profile sdk` 拉起的会话不在桌面端进程里，它的审批不会出现在这条流上。
 */

/** 网关 SSE 新增事件类型（沿用 `session-live.mjs` 的命名风格，`approval.*` 前缀）。 */
export const APPROVAL_EVENTS = Object.freeze({
  /** 有人（电脑端会话）在等一个决定：审批或提问。 */
  asked: 'approval.asked',
  /** 决定已经产生（本网关提交的，或被判定过期）。 */
  decided: 'approval.decided',
  /** 超过 TTL 仍未应答：只是网关侧记账，电脑端那轮仍然挂着。 */
  expired: 'approval.expired',
});

/** 两类可应答请求（对应两条 waterfall 事件）。 */
export const APPROVAL_KINDS = Object.freeze({ approval: 'approval', question: 'question' });

/** `ApprovalOutcome` 的合法取值（`dsh-user-approval` 的 `OUTCOMES`）。 */
export const APPROVAL_OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

/**
 * 桌面端通道的错误码 → 「为什么收不到审批」的原因码与下一步动作。
 *
 * 提成导出常量而不是写在 `#diagnose()` 的 if 链里，是为了让测试能直接钉住这张表：
 * 手机端的四句提示文案（`Approvals.kt` 的 `note` / `hint`）与这张表是**一份契约**，
 * 改一边不改另一边就会出现"网关说凭据不可用、手机说没连上"。
 *
 * 刻意不含 `desktop_disabled` / `not_connected` / `desktop_disconnected`：
 * 那三种由桥自己的状态（通道是否构造、是否连上、重连次数）决定。
 */
export const APPROVAL_REASONS = Object.freeze({
  desktop_unavailable: Object.freeze({
    reason: 'desktop_no_credentials',
    hint: '电脑端凭据不可用：请先在本机启动 DSH 桌面端（它会把 browser-session 写进 ~/.dsh/.credentials.yaml）',
  }),
  desktop_unauthorized: Object.freeze({
    reason: 'desktop_unauthorized',
    hint: '电脑端拒绝了网关的凭据：重启 DSH 桌面端让它重新签发 browser-session',
  }),
  desktop_unreachable: Object.freeze({
    reason: 'desktop_unreachable',
    hint: '连不上电脑端：确认 DSH 桌面端正在运行，且它监听的端口就是网关配置的那个',
  }),
  desktop_no_route: Object.freeze({
    reason: 'desktop_unreachable',
    hint: '连不上电脑端：桌面端 runtime 太旧，没有审批所需的事件流接口',
  }),
  transport_failure: Object.freeze({
    reason: 'desktop_unreachable',
    hint: '与电脑端的连接不稳定：检查桌面端是否被防火墙或代理拦下',
  }),
  desktop_disconnected: Object.freeze({
    reason: 'desktop_disconnected',
    hint: '与电脑端的连接断了，网关正在自动重连',
  }),
  bridge_crashed: Object.freeze({
    reason: 'bridge_crashed',
    hint: '审批通道内部出错：请查看电脑端网关日志',
  }),
});

/** `event → kind` 映射：只有这两条是 waterfall。 */
const WATERFALL_KINDS = Object.freeze({
  'approval/request': APPROVAL_KINDS.approval,
  'user-questions/request': APPROVAL_KINDS.question,
});

/** 未决请求的默认存活时间：15 分钟（**只影响网关记账**，见文件头约束 3）。 */
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;

/** 未决表上限：超出后先清过期，再丢最旧 —— 防止桌面端异常时内存无界增长。 */
export const DEFAULT_MAX_PENDING = 50;

/** 断线重连退避（固定值：桌面端重启是分钟级事件，指数退避在这里没有收益）。 */
export const DEFAULT_RECONNECT_MS = 2_000;

/** 常驻订阅的单条流超时：10 分钟（`openStream` 的 timeout 到点会关 socket，靠重连续上）。 */
export const DEFAULT_STREAM_TIMEOUT_MS = 10 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * 审批/提问桥。
 *
 * 只做三件事：**订阅 → 记账 → 提交答案**。不做重试投递、不改桌面端策略、不伪造结果。
 */
export class ApprovalBridge {
  /**
   * @param {object} input
   * @param {object|null} input.desktop `DesktopApi`（`null` = 桌面端通道关闭，桥退化为不可用）
   * @param {object|null} [input.stream] `SessionStream`（把 `approval.*` 事件发给手机）
   * @param {object|null} [input.logger]
   * @param {() => number} [input.now]
   * @param {number} [input.ttlMs]
   * @param {number} [input.maxPending]
   * @param {number} [input.reconnectMs]
   * @param {number} [input.streamTimeoutMs]
   * @param {number} [input.sweepMs] 过期巡检间隔
   */
  constructor({
    desktop,
    stream = null,
    logger = null,
    now = Date.now,
    ttlMs = DEFAULT_APPROVAL_TTL_MS,
    maxPending = DEFAULT_MAX_PENDING,
    reconnectMs = DEFAULT_RECONNECT_MS,
    streamTimeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
    sweepMs = 30_000,
  } = {}) {
    this.desktop = desktop ?? null;
    this.stream = stream;
    this.logger = logger;
    this.now = now;
    this.ttlMs = Math.max(1000, ttlMs);
    this.maxPending = Math.max(1, maxPending);
    this.reconnectMs = Math.max(0, reconnectMs);
    this.streamTimeoutMs = Math.max(1000, streamTimeoutMs);
    this.sweepMs = Math.max(1000, sweepMs);

    /** @type {Map<string, object>} eventId → 未决记录（插入顺序 = 时间顺序） */
    this.pending = new Map();
    /** 当前 `$events` 订阅的 clientId（回答案必须带它）。 */
    this.clientId = null;
    this.connected = false;
    this.lastError = null;
    this.reconnects = 0;
    this.startedAt = null;
    this.stopped = false;
    /** @type {AbortController|null} */
    this.ctl = null;
    /** @type {Promise<void>|null} */
    this.runner = null;
    this.sweeper = null;
    /** 累计记账（诊断用）。 */
    this.counters = { asked: 0, approved: 0, rejected: 0, expired: 0, answered: 0, failed: 0 };
  }

  /** 是否可用：桌面端通道开着就算可用（连不上时 `state()` 里能看到原因）。 */
  get available() {
    return this.desktop !== null;
  }

  /**
   * 启动常驻订阅（幂等）。**不 await 结果** —— 它内部是无限循环，await 会永远不返回。
   * @returns {boolean} 是否真的启动了（桌面端关闭时返回 false）
   */
  start() {
    if (this.runner !== null) return true;
    if (this.desktop === null) {
      this.logger?.warn?.('审批桥未启动：桌面端驱动通道已关闭');
      return false;
    }
    this.stopped = false;
    this.startedAt = this.now();
    this.ctl = new AbortController();
    this.runner = this.#run().catch((err) => {
      this.lastError = { code: 'bridge_crashed', message: String(err?.message ?? err) };
      this.logger?.error?.(`审批桥异常退出：${this.lastError.message}`);
    });
    this.sweeper = setInterval(() => this.sweepExpired(), this.sweepMs);
    this.sweeper.unref?.();
    return true;
  }

  /** 停止订阅并清空未决表（关闭时调用；不试图回答案，悬着的由电脑端自己处理）。 */
  async stop() {
    this.stopped = true;
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    this.ctl?.abort(new Error('审批桥已关闭'));
    const runner = this.runner;
    this.runner = null;
    this.connected = false;
    this.clientId = null;
    this.pending.clear();
    await runner?.catch(() => {});
  }

  /**
   * 诊断快照（`GET /api/v2/approvals` 的 `state` 字段）。
   *
   * 手机端**只知道** `available` / `connected` 两个布尔量时，能给出的提示只有
   * "未启用 / 没连上 / 暂无"三句 —— 用户看到"没连上"不知道该去开哪个开关。
   * 所以这里多给两个字段：
   * - `reason`：机器可读的原因码（手机端据此选文案，见 `Approvals.kt` 的 `reasonCode`）；
   * - `hint`：给用户看的**下一步动作**（"重启网关" / "打开电脑端 DSH" / …）。
   *
   * `credentials` 只在桌面端通道对象愿意自报时出现（真实现 `DesktopApi` 会报），
   * 这样测试用的假桌面端不需要实现新接口。
   */
  state() {
    const diagnosis = this.#diagnose();
    const out = {
      available: this.available,
      connected: this.connected,
      pending: this.pending.size,
      startedAt: this.startedAt,
      reconnects: this.reconnects,
      lastError: this.lastError,
      counters: { ...this.counters },
      reason: diagnosis.reason,
      hint: diagnosis.hint,
    };
    if (diagnosis.credentials) out.credentials = diagnosis.credentials;
    return out;
  }

  /**
   * 判断"现在为什么收不到审批"，并给出下一步动作。
   *
   * 顺序即优先级：通道没开 > 凭据不可用 > 桌面端错误码 > 没连上 > 正常。
   * 只读既有字段，**不**触发 I/O —— `state()` 会被 `/health` 与 `/approvals`
   * 每次调用，不能在这里读文件或发 RPC。
   *
   * @returns {{reason: string|null, hint: string|null, credentials: object|null}}
   */
  #diagnose() {
    if (this.desktop === null) {
      return {
        reason: 'desktop_disabled',
        hint: '审批通道已关闭：电脑端网关配置里 desktop.enabled=false，改回 true 后重启网关',
        credentials: null,
      };
    }
    const errCode = typeof this.lastError?.code === 'string' ? this.lastError.code : null;
    const credentials = this.#desktopCredentials();
    // 凭据缺失排在错误码之前：通道刚起来还没连上时（`lastError` 仍是 null），
    // "读不到凭据"就是唯一的根因，值得直接说出来而不是笼统的"正在连接"。
    if (errCode === 'desktop_unavailable' || (!this.connected && credentials?.ok === false)) {
      return { ...APPROVAL_REASONS.desktop_unavailable, credentials };
    }
    const mapped = errCode !== null ? APPROVAL_REASONS[errCode] : undefined;
    if (mapped) return { ...mapped, credentials };
    if (!this.connected) {
      return {
        reason: this.reconnects > 0 ? 'desktop_disconnected' : 'not_connected',
        hint: this.reconnects > 0 ? '与电脑端的连接断了，网关正在自动重连' : '正在连接电脑端事件流，稍后重试',
        credentials,
      };
    }
    return { reason: null, hint: null, credentials };
  }

  /**
   * 桌面端凭据自报（可选能力）。真实现 `DesktopApi` 有 `credentialsDiscovered` /
   * `credentialsError` 两个字段；假桌面端没有就返回 null（不报错）。
   *
   * 刻意**只回布尔量，不回传 `credentialsError` 的原文**：那句话里是
   * `C:\Users\<用户名>\.dsh-remote\.credentials.yaml` 这样的本机绝对路径，
   * 而 `state` 会经中继送到手机上（`GET /health` 也一样）—— 用户拿这条路径
   * 做不了任何事，泄漏用户名却是实打实的。详细原因留在**网关本机日志**与
   * `lastError.message`（只有本机的 `/health` 调用者看得到）里。
   *
   * @returns {{ok: boolean, discovered: boolean}|null}
   */
  #desktopCredentials() {
    const desktop = this.desktop;
    if (desktop === null || typeof desktop !== 'object') return null;
    if (!Object.hasOwn(desktop, 'credentialsError')) return null;
    return {
      ok: typeof desktop.credentials === 'object' && desktop.credentials !== null,
      discovered: desktop.credentialsDiscovered === true,
    };
  }

  /**
   * 未决列表（新→旧）。
   * @param {{sessionId?: string|null}} [opts]
   */
  list({ sessionId = null } = {}) {
    const out = [];
    for (const entry of this.pending.values()) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      out.push(publicEntry(entry));
    }
    return out.reverse();
  }

  /** 取一条未决记录（内部形态，含 eventId；HTTP 层用 `publicEntry`）。 */
  get(eventId) {
    const entry = this.pending.get(eventId);
    return entry ? publicEntry(entry) : null;
  }

  /**
   * 提交一个答案。**不抛异常**：所有失败都以 `{ok:false, code, message}` 返回，便于 HTTP 层映射状态码。
   *
   * @param {string} eventId
   * @param {{outcome?: string, answers?: Array<{id: string, selected?: string[], text?: string}>,
   *          abstain?: boolean}} answer
   * @returns {Promise<{ok: true, event: object, outcome: object, counters: object}
   *                 | {ok: false, code: string, message: string, event?: object}>}
   */
  async answer(eventId, answer = {}) {
    const entry = this.pending.get(eventId);
    if (!entry) {
      // 三种可能：从来没收到过 / 已被应答 / 已过期。客户端拿到 404，UI 应回退到列表刷新。
      return { ok: false, code: 'not_found', message: `没有未决请求：${eventId}` };
    }
    if (entry.expiresAt <= this.now()) {
      this.#expire(entry, 'answered-too-late');
      return { ok: false, code: 'expired', message: `该请求已超过 ${Math.round(this.ttlMs / 1000)}s 未应答，网关已标记过期` };
    }
    // 先校验请求，再判通道状态：400 是客户端错误，与"连没连上桌面端"无关。
    // 顺序反过来的话，一个明显写错的请求体在重连窗口里会被报成 503，手机端就会去重试一个永远不会成功的请求。
    const built = buildOutcome(entry, answer);
    if (!built.ok) return { ok: false, code: 'bad_request', message: built.message, event: publicEntry(entry) };

    if (!this.available || !this.connected || this.clientId === null) {
      return {
        ok: false,
        code: 'desktop_unavailable',
        message: '与桌面端的事件流未连接，暂不能提交答案（电脑端那轮仍在等待）',
        event: publicEntry(entry),
      };
    }

    let res;
    try {
      res = await this.desktop.callRaw('$events/result', { clientId: this.clientId, eventId, outcome: built.outcome });
    } catch (err) {
      this.counters.failed += 1;
      this.lastError = { code: err?.code ?? 'desktop_unreachable', message: String(err?.message ?? err) };
      return { ok: false, code: this.lastError.code, message: this.lastError.message, event: publicEntry(entry) };
    }
    if (!res || res.ok !== true) {
      this.counters.failed += 1;
      const code = res?.error?.code ?? 'gateway/internal';
      const message = res?.error?.message ?? '桌面端拒绝了这次答案提交';
      this.lastError = { code, message };
      // 桌面端说"没有活动事件流"= 我们的 clientId 已经失效：立刻把连接标成断开，触发重连。
      if (typeof message === 'string' && message.includes('no active event stream')) {
        this.connected = false;
        this.clientId = null;
      }
      return { ok: false, code, message, event: publicEntry(entry) };
    }

    this.pending.delete(eventId);
    this.counters.answered += 1;
    if (built.outcome.kind === 'next') this.counters.expired += 0;
    else if (built.decision === 'allowed-once') this.counters.approved += 1;
    else if (built.decision === 'rejected') this.counters.rejected += 1;
    this.#emit(APPROVAL_EVENTS.decided, {
      eventId,
      sessionId: entry.sessionId,
      kind: entry.kind,
      decision: built.decision,
      by: 'phone',
      at: this.now(),
    });
    this.logger?.info?.(`审批已由手机应答：${entry.kind} ${eventId} → ${built.decision ?? 'abstain'}`);
    return { ok: true, event: publicEntry(entry), outcome: built.outcome, counters: { ...this.counters } };
  }

  /** 过期巡检：只做网关侧记账 + 通知，**不会**让电脑端那轮结束。 */
  sweepExpired() {
    const at = this.now();
    for (const entry of [...this.pending.values()]) {
      if (entry.expiresAt <= at) this.#expire(entry, 'expired');
    }
    // 上限兜底：优先丢最旧的（Map 的插入顺序就是时间顺序）
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.values().next().value;
      if (!oldest) break;
      this.#expire(oldest, 'dropped');
    }
  }

  // ---- 内部 ----

  /** 常驻订阅循环：连上 → 消费帧 → 断了就退避重连。 */
  async #run() {
    while (!this.stopped) {
      let outcome = null;
      try {
        const frames = this.desktop.openStream({
          endpoint: '$events',
          args: {},
          signal: this.ctl?.signal ?? null,
          timeoutMs: this.streamTimeoutMs,
        });
        // 刻意用**手动迭代**而不是 `for await`：`openStream` 失败时是
        // `return {ended:false, error}`（见 desktop-api.mjs 的签名），不抛错。
        // `for await` 会把返回值吞掉，于是"电脑端没启动""凭据不可用"在日志里
        // 全都退化成一句"事件流中断"，手机端也只能说"没连上"。
        // 只有真的拿到 `done` 才知道刚才有没有错，所以这里必须自己收返回值。
        let step = await frames.next();
        while (step.done !== true) {
          if (this.stopped) break;
          this.#ingest(step.value);
          step = await frames.next();
        }
        if (this.stopped) await frames.return?.();
        else if (step.value) outcome = step.value;
      } catch (err) {
        outcome = { ended: false, error: { code: err?.code ?? 'events_stream_failed', message: String(err?.message ?? err) } };
      }
      if (outcome?.error) {
        this.lastError = {
          code: String(outcome.error.code ?? 'events_stream_failed'),
          message: String(outcome.error.message ?? '事件流中断'),
        };
        this.logger?.warn?.(`审批桥事件流中断：${this.lastError.code} ${this.lastError.message}`);
      }
      this.connected = false;
      this.clientId = null;
      if (this.stopped) break;
      this.reconnects += 1;
      await sleep(this.reconnectMs);
    }
  }

  /** 处理一帧 `$events`。 */
  #ingest(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'ready') {
      const first = this.connected === false;
      this.clientId = typeof frame.clientId === 'string' ? frame.clientId : null;
      this.connected = this.clientId !== null;
      this.lastError = null;
      if (first) this.logger?.info?.('审批桥已连上桌面端事件流（$events）');
      return;
    }
    if (frame.type !== 'waterfall') return; // emit 类事件本桥不消费
    const kind = WATERFALL_KINDS[frame.event];
    if (kind === undefined) return;
    const eventId = frame.eventId;
    if (typeof eventId !== 'string' || eventId.length === 0) return;
    if (this.pending.has(eventId)) return; // 重连后桌面端会重播未决帧，按 eventId 去重
    const req = frame.request && typeof frame.request === 'object' ? frame.request : {};
    const entry = {
      eventId,
      // 桌面端会话：实测 `agentId` 就是会话 id（形如 `session-8129a74b-…`）。
      // 其它 agent 作用域下这个值可能不是会话 id，手机端按"未知会话"处理即可。
      sessionId: typeof frame.agentId === 'string' ? frame.agentId : null,
      agentId: typeof frame.agentId === 'string' ? frame.agentId : null,
      kind,
      toolName: kind === APPROVAL_KINDS.approval ? (req.toolName ?? null) : 'ask_user_question',
      // 审批的 callId 在顶层（`ApprovalRequest.callId`）；提问的在 `request.wait.callId`（实测）。
      callId: req.callId ?? req.wait?.callId ?? null,
      reason: req.reason ?? null,
      // 提问的正文（审批没有正文，只有工具名与可选原因）
      questions: kind === APPROVAL_KINDS.question ? normalizeQuestions(req.questions) : null,
      at: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.pending.set(eventId, entry);
    // 先入表再巡检：`maxPending` 是**硬上限**，任何时刻都不该被突破。
    // 反过来（先巡检再入表）会让表长期停在 maxPending+1。
    this.sweepExpired();
    this.counters.asked += 1;
    this.#emit(APPROVAL_EVENTS.asked, { ...publicEntry(entry) });
    this.logger?.info?.(
      `桌面端请求${kind === APPROVAL_KINDS.approval ? '审批' : '提问'}：${entry.sessionId ?? '未知会话'} ${entry.toolName ?? ''} ${eventId}`,
    );
  }

  #expire(entry, reason) {
    if (!this.pending.delete(entry.eventId)) return;
    if (reason !== 'dropped') this.counters.expired += 1;
    this.#emit(APPROVAL_EVENTS.expired, {
      eventId: entry.eventId,
      sessionId: entry.sessionId,
      kind: entry.kind,
      reason,
      at: this.now(),
    });
    this.logger?.warn?.(`未决请求过期（电脑端那轮仍在等待）：${entry.eventId} reason=${reason}`);
  }

  #emit(type, payload) {
    this.stream?.emit?.(type, payload, { sessionId: payload.sessionId ?? null });
  }
}

/**
 * 把一条未决记录投影成对外的形状（手机端只认这些字段）。
 *
 * 刻意**不下发** `expiresAt` 之外的内部字段，也不下发 `agentId` 以外的 agent 作用域信息：
 * 手机端需要的是"能渲染 + 能回答"，多给字段只会让契约漂移。
 */
export function publicEntry(entry) {
  return {
    eventId: entry.eventId,
    sessionId: entry.sessionId,
    kind: entry.kind,
    toolName: entry.toolName,
    callId: entry.callId,
    reason: entry.reason,
    questions: entry.questions,
    at: entry.at,
    expiresAt: entry.expiresAt,
  };
}

/**
 * 规范化提问正文。桌面端的 `request.questions` 形状（实测两轮真实往返）：
 * `[{id, question, detail?, header?, options?: [{label, description?}], multiSelect?}]`
 * 外加可选的 `intent:{kind, approve}`；`ask()` 在 `intent.approve` 不指向本问题自己的某个
 * label 时抛 `BAD_INTENT`。
 *
 * 这里**只做形状收窄**（丢未知字段、把缺失的可选字段补成 null/false），不改语义、不补默认选项。
 * 两个实测到的坑：
 * - `multiSelect` 为假时**整个键都不出现**（不是 `false`）→ 对手机统一补成布尔，UI 不用判 undefined；
 * - 模型/工具实参拼 `multi_select`，而转发帧拼 `multiSelect` —— 线上只有后者。
 *
 * 刻意**不下发** `intent`：手机端对所有问题一视同仁地渲染成"选项/自由文本"，`intent.approve`
 * 只是"哪个 label 算同意"的提示，不改变可答性；多一个字段就多一处契约漂移。
 */
export function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions
    .filter((q) => q && typeof q === 'object')
    .map((q) => ({
      id: typeof q.id === 'string' ? q.id : String(q.id ?? ''),
      header: typeof q.header === 'string' ? q.header : null,
      question: typeof q.question === 'string' ? q.question : '',
      detail: typeof q.detail === 'string' ? q.detail : null,
      options: Array.isArray(q.options)
        ? q.options
            .filter((o) => o && typeof o === 'object')
            .map((o) => ({ label: typeof o.label === 'string' ? o.label : String(o.label ?? ''), description: typeof o.description === 'string' ? o.description : null }))
        : [],
      multiSelect: q.multiSelect === true,
    }));
}

/**
 * 把手机端的答案翻译成线协议的 `outcome`。
 *
 * - 审批：`{outcome:'allowed-once'|'rejected'}` → `{kind:'result', value:<outcome>}`
 *   （`dsh-user-approval` 的返回值就是这四个字符串之一）；
 * - 提问：`{answers:[{id, selected:[…], custom?}]}` → `{kind:'result', value:{answers}}`；
 * - 弃权：`{abstain:true}` → `{kind:'next'}`，让 waterfall 继续找下一个应答者
 *   （最终无人应答时 `dsh-user-approval` 归一为 `'unavailable'`，等于拒绝）。
 *
 * ## 提问答案的形状是实测出来的，别凭直觉改
 *
 * 桌面端 `dsh-tool-ask-user` 的输出 schema（工具实参那侧同名）与
 * `dsh-user-questions/lib/types/projection.js` 的 `answerSchema` 都要求每项
 * `{id: string, selected: string[], custom?: string}` 且 `.strict()` / `additionalProperties:false`
 * —— **只允许这三个键**。两个真实往返（单问 + 多选与自由文本同批）都 `{"ok":true}` 且
 * 工具结果逐字节一致。
 *
 * 两个必须在这里挡住的坑：
 * 1. 自由文本字段叫 **`custom`**，不是 `text`：多写一个 `text` 会被 strict 校验拒掉，
 *    整次应答白费（用户看到的是"点了没反应"）；
 * 2. `selected` **必须是数组**：工具内部做 `[...answer.selected]`，传裸字符串 `"blue"` 会
 *    静默展开成 `["b","l","u","e"]` 且**不报错** —— 答案被悄悄改成四个单字符选项。
 *    所以这里对字符串直接判非法（宁可 400，也不要静默污染）。
 *
 * @param {object} entry 未决记录
 * @param {object} answer 手机端提交的答案
 * @returns {{ok: true, outcome: object, decision: string|null} | {ok: false, message: string}}
 */
export function buildOutcome(entry, answer) {
  if (answer?.abstain === true) return { ok: true, outcome: { kind: 'next' }, decision: null };

  if (entry.kind === APPROVAL_KINDS.approval) {
    const outcome = answer?.outcome;
    if (typeof outcome !== 'string' || !APPROVAL_OUTCOMES.includes(outcome)) {
      return { ok: false, message: `审批的 outcome 必须是 ${APPROVAL_OUTCOMES.join(' / ')} 之一` };
    }
    return { ok: true, outcome: { kind: 'result', value: outcome }, decision: outcome };
  }

  const answers = answer?.answers;
  if (!Array.isArray(answers) || answers.length === 0) {
    return { ok: false, message: '提问的答案必须是 {answers:[{id, selected:[…]}]}，且至少一项' };
  }
  const normalized = [];
  for (const item of answers) {
    if (!item || typeof item !== 'object') return { ok: false, message: 'answers 的每一项都必须是 {id, selected, custom?} 对象' };
    if (typeof item.id !== 'string' || item.id.length === 0) return { ok: false, message: 'answers[].id 必须是非空字符串' };
    const selectedRaw = item.selected;
    if (typeof selectedRaw === 'string') {
      // 见上文坑 2：这里必须硬拒，不能"顺手包成数组"（那会掩盖手机端拼错形状的事实）
      return { ok: false, message: `answers[${item.id}].selected 必须是字符串数组，不能是单个字符串` };
    }
    if (selectedRaw !== undefined && !Array.isArray(selectedRaw)) {
      return { ok: false, message: `answers[${item.id}].selected 必须是字符串数组` };
    }
    const selected = Array.isArray(selectedRaw) ? selectedRaw.filter((s) => typeof s === 'string') : [];
    const custom = typeof item.custom === 'string' && item.custom.length > 0 ? item.custom : null;
    // `selected: []` 是合法的"跳过这一问"（schema 允许，语义是已回答而非拒答）；
    // 但两个字段都不给就是残缺请求 —— 手机端渲染不出这种状态，必是 bug。
    if (custom === null && selectedRaw === undefined) {
      return { ok: false, message: `answers[${item.id}] 必须给出 selected 数组（可为空）或 custom 文本` };
    }
    normalized.push(custom === null ? { id: item.id, selected } : { id: item.id, selected, custom });
  }
  return { ok: true, outcome: { kind: 'result', value: { answers: normalized } }, decision: null };
}
