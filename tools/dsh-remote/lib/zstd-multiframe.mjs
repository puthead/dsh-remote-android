/**
 * 多帧 zstd 读取器（契约 §5.2）。
 *
 * 背景：DSH 的会话文件 `session.v4.jsonl.zstd` 是**追加写**的多帧 zstd 拼接文件
 * （真实样例 1153 帧）。`node:zlib` 的 `zstdDecompressSync` 只解**第一帧**，
 * 直接丢整个文件进去只能拿到开头一小段（真实样例仅 206 B / 全量 4.88 MB），
 * 因此必须自己按帧边界切分再逐帧解压。
 *
 * 为什么不用「扫描 magic 字节」的启发式（见早期 `.runtime/zstd-probe.mjs`）：
 * 压缩后的负载里**完全可能出现** `28 b5 2f fd` 这 4 个字节，
 * 靠 magic 扫描切帧会切错位置，切错的那一段解压失败被静默丢弃 —— 表现为"事件偶尔少几条"，
 * 是最难排查的一类缺陷。本实现改为**按 RFC 8878 解析帧头 + 逐块走完 block 链**，
 * 帧长度是**算出来的**而不是猜出来的，不存在误切。
 *
 * 增量 tail：会话文件是 append-only 的，已消费的帧字节永远不变。
 * 因此 `MultiFrameReader` 记住「已消费到的字节偏移」，后续只解新追加的帧，
 * 并把跨读取被截断的最后一行 JSON 扣留到下次拼接 —— 这样 4.8 MB 的会话
 * 轮询时只需解压新增的几十 KB。
 */
import fs from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528; // 帧魔数（LE 读作整数）
const SKIPPABLE_MIN = 0x184d2a50;
const SKIPPABLE_MAX = 0x184d2a5f;

/** 帧类型枚举（诊断用）。 */
export const FRAME_KIND = Object.freeze({ zstd: 'zstd', skippable: 'skippable' });

/**
 * 解析从 `at` 开始的 zstd 帧头，返回帧头长度与元信息；头部不完整返回 null。
 * @param {Buffer} buf
 * @param {number} at
 * @returns {{headerSize: number, checksum: boolean} | null}
 */
function parseZstdHeader(buf, at) {
  if (at + 5 > buf.length) return null;
  const descriptor = buf[at + 4];
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const reserved = (descriptor >> 3) & 1;
  const checksum = ((descriptor >> 2) & 1) === 1;
  const dictIdFlag = descriptor & 3;
  // bit3 是保留位，必须为 0；为 1 说明这里不是合法帧头（不是真帧边界）
  if (reserved !== 0) return null;
  const windowDescriptorSize = singleSegment === 1 ? 0 : 1;
  const dictIdSize = dictIdFlag === 0 ? 0 : dictIdFlag === 1 ? 1 : dictIdFlag === 2 ? 2 : 4;
  const fcsSize = fcsFlag === 0 ? (singleSegment === 1 ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  const headerSize = 1 + 4 + windowDescriptorSize + dictIdSize + fcsSize;
  if (at + headerSize > buf.length) return null;
  return { headerSize, checksum };
}

/**
 * 计算从 `buf[at]` 开始的一帧的**精确**字节长度。
 * 帧头不完整或块链未走完（尾部被截断）→ 返回 -1。
 * @param {Buffer} buf
 * @param {number} at
 * @returns {number} 帧字节长度，或 -1（数据不足）
 */
export function frameLengthAt(buf, at) {
  if (at + 4 > buf.length) return -1;
  const magic = buf.readUInt32LE(at);
  if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
    // 可跳过帧：4B 魔数 + 4B 长度 + 负载，负载对我们无意义
    if (at + 8 > buf.length) return -1;
    const size = buf.readUInt32LE(at + 4);
    const total = 8 + size;
    return at + total <= buf.length ? total : -1;
  }
  if (magic !== ZSTD_MAGIC) return -1;

  const head = parseZstdHeader(buf, at);
  if (!head) return -1;

  let pos = at + head.headerSize;
  for (;;) {
    if (pos + 3 > buf.length) return -1; // 块头被截断
    const blockHeader = buf.readUIntLE(pos, 3);
    const lastBlock = (blockHeader & 1) === 1;
    const blockType = (blockHeader >> 1) & 3;
    const blockSize = blockHeader >> 3;
    pos += 3;
    if (blockType === 3) return -1; // 保留块类型：非法
    if (blockType === 1) {
      // RLE 块：Block_Size 是解压后大小，负载恒为 1 字节
      pos += 1;
    } else {
      // Raw / Compressed 块：负载长度就是 Block_Size
      pos += blockSize;
    }
    if (pos > buf.length) return -1; // 负载被截断
    if (lastBlock) break;
  }
  if (head.checksum) pos += 4;
  if (pos > buf.length) return -1;
  return pos - at;
}

/**
 * 从 `from` 开始扫描出所有**完整**帧的边界。
 * @param {Buffer} buf
 * @param {number} [from]
 * @returns {{frames: Array<{start: number, end: number}>, completeEnd: number, tailStart: number}}
 *   `completeEnd` = 最后一个完整帧的结束偏移；`tailStart` 之后是未完成的残帧（等待下次读取）。
 */
export function scanFrames(buf, from = 0) {
  const frames = [];
  let pos = from;
  while (pos < buf.length) {
    const length = frameLengthAt(buf, pos);
    if (length <= 0) break; // 残帧或不认识的字节：停在这里等待更多数据
    frames.push({ start: pos, end: pos + length });
    pos += length;
  }
  return { frames, completeEnd: pos, tailStart: pos };
}

/**
 * 解压缓冲区中所有拼接的 zstd 帧，拼接结果返回。
 * 无法识别任何帧头时退回整体解压（单帧文件的兼容路径）。
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function decompressMultiFrame(buf) {
  const { frames } = scanFrames(buf);
  if (frames.length === 0) return zstdDecompressSync(buf);
  const pieces = [];
  for (const frame of frames) {
    const slice = buf.subarray(frame.start, frame.end);
    if (slice.readUInt32LE(0) !== ZSTD_MAGIC) continue; // 跳过 skippable 帧
    pieces.push(zstdDecompressSync(slice));
  }
  return Buffer.concat(pieces);
}

/**
 * 解析解压后的 JSONL 文本。
 * 空行跳过；无法解析的行**不静默丢弃**，而是保留为 `{type:'__unparsable__', raw}`，
 * 这样上层既能统计损坏行数，也不会因为一行噪声而丢掉整段会话。
 * @param {string} text
 * @returns {object[]}
 */
export function parseJsonl(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      events.push({ type: '__unparsable__', raw: trimmed });
    }
  }
  return events;
}

/**
 * 增量多帧读取器：只解压新追加的帧。
 *
 * 用法：
 * ```js
 * const reader = new MultiFrameReader({ file });
 * await reader.refresh();   // 首次全量
 * reader.events;            // 累计事件（含解析后的对象）
 * await reader.refresh();   // 第二次只解新帧
 * ```
 */
export class MultiFrameReader {
  /** @param {{file: string, fsImpl?: object}} opts */
  constructor({ file, fsImpl = fs }) {
    this.file = file;
    this.fs = fsImpl;
    /** 已消费的字节偏移（= 最后一个完整帧的结束位置）。 */
    this.consumed = 0;
    /** 已解压并拼接的文本（只含完整行）。 */
    this.text = '';
    /** 被扣留的半行（帧边界恰好切开一个 JSON 行时）。 */
    this.pendingLine = '';
    /** @type {object[]} */
    this.events = [];
    this.frames = 0;
    this.bytesRead = 0;
    this.invalidations = 0;
    this.size = 0;
    this.mtimeMs = 0;
    /** 上次 refresh 起点的文件大小，用于判定是否真的有新数据。 */
    this._lastSize = -1;
    this._lastMtime = -1;
  }

  /** 文件是否在上次读取后被改动过（大小或 mtime 变化）。 */
  get changed() {
    return this._lastSize !== this.size || this._lastMtime !== this.mtimeMs;
  }

  /**
   * 读取新增数据并增量更新事件集。
   * @param {{force?: boolean}} [opts] force=true 时忽略"未变化"短路
   * @returns {Promise<{added: object[], addedLines: number, reset: boolean, frames: number}>}
   */
  async refresh({ force = false } = {}) {
    let stat;
    try {
      stat = await this.fs.promises.stat(this.file);
    } catch {
      // 文件消失（会话被清理）：视为重置为空
      const had = this.consumed > 0 || this.events.length > 0;
      this.reset();
      return { added: [], addedLines: 0, reset: had, frames: 0 };
    }
    this.size = stat.size;
    this.mtimeMs = stat.mtimeMs;
    if (!force && !this.changed) return { added: [], addedLines: 0, reset: false, frames: 0 };
    this._lastSize = stat.size;
    this._lastMtime = stat.mtimeMs;

    // 文件被截断/重写（大小回退到已消费偏移之前）→ 全量重来
    let reset = false;
    if (stat.size < this.consumed) {
      this.reset();
      reset = true;
    }
    if (stat.size === this.consumed) return { added: [], addedLines: 0, reset, frames: 0 };

    const start = this.consumed;
    const handle = await this.fs.promises.open(this.file, 'r');
    let chunk;
    try {
      const length = stat.size - start;
      chunk = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(chunk, read, length - read, start + read);
        if (bytesRead <= 0) break;
        read += bytesRead;
      }
      if (read < length) chunk = chunk.subarray(0, read);
    } finally {
      await handle.close();
    }
    this.bytesRead += chunk.length;

    const { frames, completeEnd } = scanFrames(chunk);
    if (frames.length === 0 && completeEnd === 0) {
      // 连一个完整帧都还没有：保留残帧等待下次
      return { added: [], addedLines: 0, reset, frames: 0 };
    }

    const pieces = [];
    for (const frame of frames) {
      const slice = chunk.subarray(frame.start, frame.end);
      if (slice.readUInt32LE(0) !== ZSTD_MAGIC) continue;
      try {
        pieces.push(zstdDecompressSync(slice));
      } catch {
        // 极少数情况下帧头合法但负载损坏：跳过该帧并记录，绝不中断整个读取
        this.invalidations += 1;
      }
    }
    this.frames += frames.length;
    this.consumed = start + completeEnd;

    const decoded = Buffer.concat(pieces).toString('utf8');
    const addedEvents = this._ingest(decoded);
    return { added: addedEvents, addedLines: addedEvents.length, reset, frames: frames.length };
  }

  /** 把新解出的文本切行、扣留半行、增量解析事件。 */
  _ingest(decoded) {
    const combined = this.pendingLine + decoded;
    const lastNewline = combined.lastIndexOf('\n');
    if (lastNewline === -1) {
      this.pendingLine = combined;
      return [];
    }
    const complete = combined.slice(0, lastNewline + 1);
    this.pendingLine = combined.slice(lastNewline + 1);
    this.text += complete;
    const added = parseJsonl(complete);
    if (added.length > 0) this.events.push(...added);
    return added;
  }

  /** 清空全部状态（文件被重写或删除时）。 */
  reset() {
    this.consumed = 0;
    this.text = '';
    this.pendingLine = '';
    this.events = [];
    this.frames = 0;
    this.bytesRead = 0;
    this._lastSize = -1;
    this._lastMtime = -1;
  }

  /** 已解析事件中无法解析的行数（诊断）。 */
  get unparsableCount() {
    return this.events.reduce((n, ev) => (ev?.type === '__unparsable__' ? n + 1 : n), 0);
  }
}

/**
 * 一次性读取（无增量状态）：解压整文件并返回事件数组。
 * @param {string} file
 * @param {{fsImpl?: object}} [opts]
 * @returns {Promise<{events: object[], text: string, bytes: number, frames: number}>}
 */
export async function readSessionEvents(file, { fsImpl = fs } = {}) {
  const stat = await fsImpl.promises.stat(file);
  const buf = await fsImpl.promises.readFile(file);
  const { frames } = scanFrames(buf);
  const text = decompressMultiFrame(buf).toString('utf8');
  return { events: parseJsonl(text), text, bytes: stat.size, frames: frames.length };
}
