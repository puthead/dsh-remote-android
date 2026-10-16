/**
 * 手机侧会话索引（网关权威，落盘在网关自有 home）。
 *
 * ## 为什么需要它
 *
 * 手机新建的任务现在**默认落在电脑端 DSH 的 home 与工作区**里（契约 §7.6）：只有那样，
 * 电脑端的会话列表里才会出现它，用户才能在电脑上接手同一个会话。代价是这些会话的
 * `source` 变成 `computer` —— 手机端再也无法靠 `source === 'phone'` 认出"这是我发的任务"。
 * 本模块登记"由手机创建的会话 id"，列表/详情据此下发 `createdBy`。
 *
 * ## 三个字段各说各的事（客户端不得互相反推）
 *
 * - `createdBy`：**谁发起**的（`phone` | `desktop`）。
 * - `source`：会话**数据长在谁家里**（`phone` = 网关自有 DSH_HOME，`computer` = 真实 `~/.dsh`）。
 * - `driver`：**现在谁在驱动**它（`gateway` | `desktop`）。
 *
 * 手机新建 + 落电脑端的会话因此是 `createdBy:'phone' + source:'computer' + driver:'desktop'`，
 * 而电脑端自己在 DSH 里建的会话是 `createdBy:'desktop'`。
 *
 * ## 为什么不写进 DSH 自己的会话文件
 *
 * DSH 的会话头是 DSH 的格式（`session.v4.jsonl.zstd` 的 header），往里塞网关私有字段会污染
 * 用户真实 home、且随 DSH 版本变化失效。这里刻意用网关自己的文件，DSH 侧完全无感。
 */
import path from 'node:path';
import { atomicWriteJson, readJsonFile } from './util.mjs';

/** 索引文件版本。读到不认识的值时按空索引处理（宁可丢"我发起"标记，也不能让网关起不来）。 */
const INDEX_VERSION = 1;

/**
 * 最多记多少条。手机任务会一直增长，而这是给列表页打标用的，
 * 保留最近的一批即可；超出部分按 createdAt 淘汰。
 */
const MAX_ENTRIES = 500;

/**
 * @typedef {object} PhoneSessionEntry
 * @property {number} createdAt 登记时间（ms）
 * @property {'desktop'|'gateway'} host 这个会话跑在哪一侧
 * @property {string|null} workspace 目标工作区真实路径
 * @property {string|null} access 权限档（仅 `host==='gateway'` 有意义；桌面端通道由电脑端 DSH 决定）
 * @property {string|null} title 用户给的标题（可空）
 */

/** 手机任务索引。 */
export class PhoneSessionIndex {
  /**
   * @param {{file: string, now?: () => number, logger?: object|null}} options
   */
  constructor({ file, now = Date.now, logger = null }) {
    this.file = file;
    this.now = now;
    this.logger = logger;
    /** @type {Map<string, PhoneSessionEntry>} */
    this.entries = new Map();
    this.loaded = false;
    /** 落盘串行链（与 tasks.mjs 同样的理由：并发 add 不能让两次 rename 互相覆盖）。 */
    this.writeChain = Promise.resolve();
  }

  /** 从磁盘加载。文件不存在/损坏都按空索引处理 —— 这个索引丢了只会少个标记，不该拦住启动。 */
  async init() {
    const { value, error, corrupt } = await readJsonFile(this.file, null);
    if (corrupt) {
      this.logger?.warn(`手机任务索引损坏已隔离（按空索引继续）：${path.basename(this.file)}`);
      this.loaded = true;
      return 0;
    }
    if (error || !value || typeof value !== 'object' || value.version !== INDEX_VERSION) {
      this.loaded = true;
      return 0;
    }
    const sessions = value.sessions && typeof value.sessions === 'object' ? value.sessions : {};
    for (const [id, raw] of Object.entries(sessions)) {
      if (typeof id !== 'string' || !id) continue;
      if (!raw || typeof raw !== 'object') continue;
      this.entries.set(id, {
        createdAt: Number(raw.createdAt) || this.now(),
        host: raw.host === 'gateway' ? 'gateway' : 'desktop',
        workspace: typeof raw.workspace === 'string' ? raw.workspace : null,
        access: typeof raw.access === 'string' ? raw.access : null,
        title: typeof raw.title === 'string' ? raw.title : null,
      });
    }
    this.loaded = true;
    return this.entries.size;
  }

  /** 这个会话是不是手机发起的。 */
  has(sessionId) {
    return this.entries.has(sessionId);
  }

  /** 取登记信息（没有则 null）。 */
  get(sessionId) {
    return this.entries.get(sessionId) ?? null;
  }

  /** 当前条数。 */
  get size() {
    return this.entries.size;
  }

  /**
   * 登记一个由手机创建的会话。**必须在新任务被接受时立刻调用**（在首轮投递之前）：
   * 哪怕首轮投递失败，会话已经真实存在于电脑端了，手机也应该能在"我的任务"里看到它。
   * @param {string} sessionId
   * @param {{host?: 'desktop'|'gateway', workspace?: string|null, access?: string|null, title?: string|null}} [meta]
   */
  async add(sessionId, meta = {}) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    this.entries.set(sessionId, {
      createdAt: this.now(),
      host: meta.host === 'gateway' ? 'gateway' : 'desktop',
      workspace: typeof meta.workspace === 'string' ? meta.workspace : null,
      access: typeof meta.access === 'string' ? meta.access : null,
      title: typeof meta.title === 'string' ? meta.title : null,
    });
    this.#prune();
    await this.#persist();
  }

  /** 取消登记（会话被删除时用）。 */
  async remove(sessionId) {
    if (!this.entries.delete(sessionId)) return;
    await this.#persist();
  }

  /** 超出上限时按 createdAt 淘汰最旧的。 */
  #prune() {
    if (this.entries.size <= MAX_ENTRIES) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of sorted.slice(0, this.entries.size - MAX_ENTRIES)) this.entries.delete(id);
  }

  /** 落盘（串行化，快照式：调用时刻的内容就是写下去的内容）。 */
  #persist() {
    const snapshot = { version: INDEX_VERSION, sessions: Object.fromEntries(this.entries) };
    const op = this.writeChain.then(
      () => atomicWriteJson(this.file, snapshot),
      () => atomicWriteJson(this.file, snapshot),
    );
    this.writeChain = op.catch((err) => {
      this.logger?.warn(`写入手机任务索引失败（内存索引仍生效）：${err.message}`);
    });
    return op;
  }
}
