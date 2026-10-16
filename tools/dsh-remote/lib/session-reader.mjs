/**
 * 会话镜像：真实 DSH 会话的元数据 + transcript 投影（契约 §4.2）。
 *
 * 数据来源是**权威的 raw jsonl**（`session.v4.jsonl.zstd` 多帧解压后的 NDJSON），
 * 不是 `storages/session_projcache/*.json`。原因：projcache 只是桌面端的**派生缓存**
 * （`{version:7, record:{rows:{...}}}`），它没有 turn/step 计数、没有 lastTurn、
 * 也没有未投影的原始事件；镜像要能自证，就必须回到 raw。
 * projcache 只在 raw 里缺 title 时作为兜底标题来源（见 `readProjCacheTitle`）。
 *
 * 事件 schema 来自对真实会话（1779 事件 / 1153 帧）的逐类型取样，关键形状：
 * ```
 * {"type":"session","version":4,"id":"session-…","createdAt":…,"cwd":"…","delegationDepth":0,"agentPreset":"standard"}
 * {"type":"turn/start","seq":5,"time":…,"data":{"turn":1}}
 * {"type":"turn/end","seq":1751,"time":…,"data":{"turn":1,"reason":{"kind":"completed"}}}
 * {"type":"user/message","seq":9,"time":…,"data":{"content":[{"type":"text","text":"…"}],"source":{"kind":"user"},"role":"user","id":"…"}}
 * {"type":"assistant/message","seq":19,"time":…,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"…"},{"type":"text","text":"…"},{"type":"tool-call","id":"call_…","name":"pwsh","arguments":"{…json…}"}]},"usage":{…}}}
 * {"type":"tool/call","seq":20,"time":…,"data":{"turn":1,"step":1,"callId":"call_…","name":"pwsh","arguments":"{…}"}}
 * {"type":"tool/result","seq":21,"time":…,"data":{"turn":1,"step":1,"message":{"role":"tool","toolCallId":"call_…","content":[{"type":"text","text":"…"}],"isError":true}}}
 * {"type":"deliverables/presented","seq":1743,"time":…,"data":{"turn":1,"callId":"call_…","files":[{"path":"…","description":"…"}]}}
 * {"type":"todo/write","seq":304,"time":…,"data":{"todos":[{"content":"…","status":"completed"}]}}
 * ```
 */
import fs from 'node:fs';
import path from 'node:path';
import { MultiFrameReader } from './zstd-multiframe.mjs';
import { delegationDepthOf, discoverSessions, findSession, inferSessionOrigin, isDerivedSession, readSessionHeader, readWorkspaceIndex } from './dsh-home.mjs';
import { truncateUtf8, truncateUtf8Tail } from './util.mjs';
import { normalizeAttachmentId } from './attachments.mjs';

/** 契约 §4.2 的硬性上限。 */
export const CAPS = Object.freeze({
  /** 单条消息 text 上限 256 KiB（超出置 truncated + 只留头部）。 */
  messageText: 256 * 1024,
  /** toolCalls[].result 上限 32 KiB（超出只留**尾部**）。 */
  toolResult: 32 * 1024,
  /** reasoning 是**附加**字段（契约未列），给手机端渲染思考过程用，给个更小的上限。 */
  reasoning: 8 * 1024,
});

/** transcript 分页默认/上限。 */
export const TRANSCRIPT_LIMITS = Object.freeze({ default: 200, max: 1000, eventsDefault: 500, eventsMax: 5000 });

/** 契约角色枚举。 */
export const ROLES = Object.freeze(['user', 'assistant', 'system', 'tool']);

/**
 * 会改动工作区文件的工具名 → 用于推导 `hasChanges`/`changeCount`。
 * 这不是「猜」：名字与参数键都取自真实会话里 `tool/call` 的实测值
 * （`write`/`edit` 用 `file_path`，`read`/`grep` 用 `file_path`/`path` 但只读）。
 */
export const MUTATING_TOOLS = Object.freeze(new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'create_file', 'notebook_edit', 'str_replace_editor']));

/** 只读工具（显式列出来，避免把 `read` 误算成改动）。 */
export const READONLY_TOOLS = Object.freeze(new Set(['read', 'read_image', 'grep', 'glob', 'list_agents', 'job_output', 'job_list', 'team_task_list', 'team_task_get', 'wait_agent']));

/** 真实用户输入的 source.kind（其余是运行时注入，不属于"对话"）。 */
const REAL_USER_KINDS = Object.freeze(new Set(['user', 'user-approval']));

/**
 * 投影一份会话事件列表。
 * @param {object[]} events
 * @param {{header?: object|null, includeInternal?: boolean}} [opts]
 * @returns {{messages: object[], meta: object}}
 */
export function projectSession(events, { header = null, includeInternal = false } = {}) {
  const messages = [];
  const seenMessageIds = new Set();
  /** @type {Map<string, object>} callId → toolCall（跨消息共享，结果回填用） */
  const callIndex = new Map();
  /** @type {Map<string, number>} callId → tool/call 的 time */
  const callTime = new Map();
  /** 尚无归属的 tool/call（极少数顺序异常的会话）。 */
  let pendingOrphans = [];
  /** 已经被放进某条消息 toolCalls 的 callId：保证一个调用只出现一次（不重复挂载）。 */
  const placedCalls = new Set();

  let title = null;
  let turns = 0;
  let steps = 0;
  let lastTurnEnd = null;
  let openTurn = null;
  let workspaceChangeEvents = 0;
  let lastEventTime = null;
  let lastUsage = null;
  let model = null;
  let sandboxMode = null;
  let firstUserText = null;
  const changedPaths = new Set();
  let unknownMutations = 0;
  let lastAssistant = null;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const at = typeof ev.time === 'number' ? ev.time : null;
    if (at !== null && (lastEventTime === null || at > lastEventTime)) lastEventTime = at;

    switch (ev.type) {
      case 'session/title':
        if (typeof ev.data?.title === 'string' && ev.data.title.trim()) title = ev.data.title.trim();
        break;
      case 'turn/start':
        turns = Math.max(turns, Number(ev.data?.turn) || 0);
        openTurn = Number(ev.data?.turn) || null;
        break;
      case 'turn/end':
        lastTurnEnd = { turn: Number(ev.data?.turn) || null, reason: ev.data?.reason?.kind ?? null, at: typeof ev.time === 'number' ? ev.time : null };
        openTurn = null;
        break;
      case 'step/start':
        steps += 1;
        break;
      case 'model/selection':
        if (typeof ev.data?.model === 'string') model = { provider: ev.data.provider ?? null, model: ev.data.model, reasoningEffort: ev.data.reasoningEffort ?? null };
        break;
      case 'sandbox/mode':
        if (typeof ev.data?.mode === 'string') sandboxMode = ev.data.mode;
        break;
      case 'workspace/changes':
        workspaceChangeEvents += 1;
        break;
      case 'user/message': {
        const msg = projectUserMessage(ev, includeInternal, openTurn);
        if (!msg) break;
        if (msg.id && seenMessageIds.has(`u:${msg.id}`)) break;
        if (msg.id) seenMessageIds.add(`u:${msg.id}`);
        if (msg.role === 'user' && !firstUserText) firstUserText = userTitleCandidate(msg);
        messages.push(msg);
        break;
      }
      case 'system/message': {
        const text = contentText(ev.data?.message?.content);
        if (!text) break;
        messages.push(internalMessage({ seq: ev.seq, at: ev.time, role: 'system', text: text.text, truncated: text.truncated, kind: 'system-prompt' }));
        break;
      }
      case 'assistant/message': {
        const msg = projectAssistantMessage(ev, { callIndex, callTime, pendingOrphans, placedCalls });
        pendingOrphans = msg.pendingOrphans;
        if (!msg.message) break;
        const key = ev.data?.message?.id ? `a:${ev.data.message.id}` : null;
        if (key && seenMessageIds.has(key)) break;
        if (key) seenMessageIds.add(key);
        messages.push(msg.message);
        lastAssistant = msg.message;
        if (ev.data?.usage) lastUsage = ev.data.usage;
        break;
      }
      case 'tool/call': {
        const callId = ev.data?.callId;
        if (typeof callId !== 'string') break;
        if (typeof ev.time === 'number') callTime.set(callId, ev.time);
        if (!callIndex.has(callId)) {
          const call = { id: callId, name: ev.data?.name ?? 'unknown', args: parseArgs(ev.data?.arguments), result: null, isError: false, truncated: false, durationMs: null };
          callIndex.set(callId, call);
          // 归属一律交给"下一条 assistant/message"或收尾的合成消息（placedCalls 保证只挂一次）
          pendingOrphans.push(call);
        } else {
          const call = callIndex.get(callId);
          if (call.name === 'unknown' && ev.data?.name) call.name = ev.data.name;
        }
        recordMutation(ev.data?.name, ev.data?.arguments, changedPaths, () => { unknownMutations += 1; });
        break;
      }
      case 'tool/result': {
        const callId = ev.data?.message?.toolCallId ?? ev.data?.toolCallId;
        if (typeof callId !== 'string') break;
        const text = contentText(ev.data?.message?.content);
        const isError = ev.data?.message?.isError === true || Boolean(ev.data?.error);
        let call = callIndex.get(callId);
        if (!call) {
          call = { id: callId, name: ev.data?.message?.source?.name ?? 'unknown', args: {}, result: null, isError: false, truncated: false, durationMs: null };
          callIndex.set(callId, call);
          pendingOrphans.push(call);
        }
        const capped = truncateUtf8Tail(text.text, CAPS.toolResult);
        call.result = capped;
        call.truncated = text.truncated || capped.length < text.text.length;
        call.isError = isError;
        // 工具产物里的图片（`read_image`、截图类工具）：引用挂到**这个调用**上，
        // 手机端就能在「工具调用」卡里直接渲染 —— 以前只投影 text，图片块被整段丢掉，
        // 手机看到的是一张工具卡配一句"读取成功"却没有任何图。
        const resultImages = projectImages(ev.data?.message?.content);
        if (resultImages) call.images = resultImages;
        const started = callTime.get(callId);
        if (typeof started === 'number' && typeof ev.time === 'number') call.durationMs = Math.max(0, ev.time - started);
        break;
      }
      case 'deliverables/presented': {
        const files = Array.isArray(ev.data?.files) ? ev.data.files : [];
        if (files.length === 0) break;
        const deliverables = files
          .filter((f) => f && typeof f.path === 'string')
          .map((f) => ({ path: f.path, description: typeof f.description === 'string' ? f.description : '' }));
        if (deliverables.length === 0) break;
        const target = (ev.data?.callId && messages.find((m) => m.toolCalls?.some((c) => c.id === ev.data.callId))) || lastAssistant;
        if (target) {
          target.deliverables = [...(target.deliverables ?? []), ...deliverables];
        } else {
          messages.push({ seq: ev.seq ?? null, at: ev.time ?? null, role: 'assistant', text: '', toolCalls: [], deliverables });
        }
        break;
      }
      case 'todo/write': {
        const todos = Array.isArray(ev.data?.todos)
          ? ev.data.todos.filter((t) => t && typeof t.content === 'string').map((t) => ({ content: t.content, status: String(t.status ?? 'pending') }))
          : [];
        if (todos.length === 0) break;
        // 待办不是"内部噪声"：手机端要渲染待办卡，因此不标 internal
        messages.push({ seq: ev.seq ?? null, at: ev.time ?? null, role: 'system', kind: 'todos', text: '', toolCalls: [], todos });
        break;
      }
      default:
        break;
    }
  }

  // 收尾：把始终没有归属的 tool/call 挂到一条合成消息上，保证结果不丢
  const leftovers = pendingOrphans.filter((c) => !placedCalls.has(c.id));
  if (leftovers.length > 0) {
    if (lastAssistant) {
      lastAssistant.toolCalls.push(...leftovers);
      for (const c of leftovers) placedCalls.add(c.id);
    } else {
      messages.push({ seq: null, at: lastEventTime, role: 'assistant', text: '', toolCalls: leftovers, deliverables: [] });
      for (const c of leftovers) placedCalls.add(c.id);
    }
  }

  const visible = includeInternal ? messages : messages.filter((m) => !m.internal);
  const meta = {
    id: header?.id ?? null,
    title: title ?? (firstUserText ? truncateUtf8(firstUserText.replace(/\s+/g, ' ').trim(), 120) : null),
    workspace: header?.cwd ?? null,
    cwd: header?.cwd ?? null,
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
    updatedAt: lastEventTime,
    turns,
    steps,
    lastTurn: lastTurnEnd ? { state: 'ended', reason: lastTurnEnd.reason ?? null } : openTurn !== null ? { state: 'running', reason: null } : null,
    origin: inferSessionOrigin(header),
    agentPreset: header?.agentPreset ?? null,
    eventCount: events.length,
    hasChanges: changedPaths.size + unknownMutations > 0 || workspaceChangeEvents > 0,
    changeCount: changedPaths.size + unknownMutations,
    model,
    sandboxMode,
    usage: lastUsage,
  };
  return { messages: visible, meta, allMessages: messages };
}

/**
 * 投影 `user/message`；返回 null 表示这条不进入 transcript。
 *
 * @param {object} ev
 * @param {boolean} includeInternal
 * @param {number|null} [openTurn] 当前轮次（`turn/start` 设、`turn/end` 清）。
 *   这是手机端「第 N 轮」跳转的**唯一锚点**：`assistant/message` 自己带 `turn`，
 *   但 `user/message` 的 data 里没有该字段，只能由投影循环把"当前正在处理的轮次"传进来
 *   （真实日志里 `turn/start` 紧随用户消息，实测第 1 轮的第 1 条消息因此有正确归属）。
 *   若帧里**有** `data.turn` 则以它为准（老版本/未来版本可能补上这个字段，
 *   届时循环状态反而会滞后）。
 */
function projectUserMessage(ev, includeInternal, openTurn = null) {
  const source = ev.data?.source?.kind;
  const text = contentText(ev.data?.content);
  // 只有图片、一个 text 块都没有的轮次：`content` 存在所以能过这个判断（有意保留原行为，
  // `validateTurnContent` 的语义一个字都不能变）。标题回退见 `userTitleCandidate`。
  if (!text.text && !Array.isArray(ev.data?.content)) return null;
  const isUser = REAL_USER_KINDS.has(source);
  if (!isUser && !includeInternal) {
    // 运行时注入（runtime-context / skill-catalog / tool-jobs / team-message / subagent-settled）
    // 默认不进 transcript：它们是上下文快照，不是用户在说话。
    // 仍然解析出来（上面 contentText 已跑过），但不入列。
    return null;
  }
  // 轮次戳：消息自带的 `turn` 优先，否则用循环传来的当前轮次（`null` = 不在任何轮次里，
  // 例如会话开头的系统注入、或 turn/end 之后的收尾合成消息）。
  const turn = typeof ev.data?.turn === 'number' ? ev.data.turn : openTurn;
  const images = projectImages(ev.data?.content);
  return {
    seq: ev.seq ?? null,
    at: ev.time ?? null,
    role: isUser ? 'user' : 'system',
    ...(isUser ? {} : { internal: true, kind: `inject:${source ?? 'unknown'}` }),
    turn: typeof turn === 'number' ? turn : null,
    text: text.text,
    ...(text.truncated ? { truncated: true } : {}),
    ...(images ? { images } : {}),
    toolCalls: [],
    deliverables: [],
    id: typeof ev.data?.id === 'string' ? ev.data.id : null,
  };
}

/**
 * 从 content 块里投影图片引用数组（契约 §4.2.2，v2.9.0）。
 *
 * 图片字节**不在**会话日志里，这里只投影"引用"：客户端拿 `id` 去
 * `GET /api/v2/attachments/{id}` 取字节（见 `lib/attachments.mjs` 头注释）。
 *
 * 三处入口都走这一个函数（`user/message`、`assistant/message`、`tool/result`），
 * 保证字段形状**只有一份真相**；只要没有图片块就返回 `null`，
 * 调用方据此**不加字段** —— 老客户端看到的响应逐字不变（§4.5 向后兼容铁律）。
 *
 * @param {Array<object>|undefined} content
 * @returns {Array<{id: string, mediaType: string|null, width: number|null, height: number|null, bytes: number|null, name: string|null}>|null}
 */
function projectImages(content) {
  if (!Array.isArray(content)) return null;
  const images = [];
  for (const block of content) {
    if (!block || block.type !== 'image') continue;
    const attachment = block.attachment ?? null;
    // 归一化会顺带卡死形状：`..`、分隔符、非 hex 一律 null。形状不对的引用**整块丢弃**，
    // 绝不投影一个手机端必然 400 的 id（那会在 UI 上变成"永远转圈"的图）。
    const id = normalizeAttachmentId(attachment?.attachmentId ?? block.attachmentId ?? null);
    if (!id) continue;
    const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const textual = (v) => (typeof v === 'string' && v ? v : null);
    images.push({
      id,
      mediaType: textual(attachment?.mediaType),
      width: numeric(attachment?.width),
      height: numeric(attachment?.height),
      bytes: numeric(attachment?.bytes),
      name: textual(attachment?.name),
    });
  }
  return images.length > 0 ? images : null;
}

/**
 * 列表标题的取词：优先正文，没有正文时退回图片名。
 *
 * 修的是这样一个**真实缺陷**：纯图片轮次（`content` 只有 image 块，例如手机端只发一张图）
 * 在 `projectUserMessage` 里能过判断、`text` 却是空串，于是 `firstUserText` 永远为 null，
 * 列表标题回退到 `null` —— 会话在手机列表里没有标题，只能显示会话 id。
 * 现在退到图片文件名（`1000000051.png` 这种天然是用户认得出的描述），
 * 连名字都没有时给固定文案「（图片）」，保证**非空**。
 *
 * @param {{text?: string, images?: Array<{name?: string|null}>|null}} msg
 * @returns {string}
 */
function userTitleCandidate(msg) {
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (text) return text;
  const names = (msg.images ?? []).map((img) => img?.name).filter((n) => typeof n === 'string' && n.trim());
  if (names.length > 0) return `（图片）${names.join('、')}`;
  return '（图片）';
}

/** 投影 `assistant/message`。 */
function projectAssistantMessage(ev, { callIndex, callTime, pendingOrphans, placedCalls }) {
  const content = Array.isArray(ev.data?.message?.content) ? ev.data.message.content : [];
  const text = contentText(content.filter((c) => c?.type === 'text'));
  const reasoningRaw = content.filter((c) => c?.type === 'reasoning').map((c) => c.text ?? '').join('');
  const reasoning = reasoningRaw ? truncateUtf8(reasoningRaw, CAPS.reasoning) : null;

  const toolCalls = [];
  for (const block of content) {
    if (block?.type !== 'tool-call' || typeof block.id !== 'string') continue;
    let call = callIndex.get(block.id);
    if (!call) {
      call = { id: block.id, name: block.name ?? 'unknown', args: parseArgs(block.arguments), result: null, isError: false, truncated: false, durationMs: null };
      callIndex.set(block.id, call);
    } else {
      if (call.name === 'unknown' && block.name) call.name = block.name;
      if (Object.keys(call.args ?? {}).length === 0) call.args = parseArgs(block.arguments);
    }
    // 一个调用只挂一次：内容块是权威归属，若此前已挂到别处则不再重复
    if (placedCalls.has(call.id)) continue;
    placedCalls.add(call.id);
    toolCalls.push(call);
  }

  // 把暂无归属的调用补进这一条消息（顺序异常/缺 assistant/message 的会话）
  const absorbed = new Set();
  for (const call of pendingOrphans) {
    if (placedCalls.has(call.id)) {
      absorbed.add(call.id);
      continue;
    }
    placedCalls.add(call.id);
    toolCalls.push(call);
    absorbed.add(call.id);
  }
  const remaining = pendingOrphans.filter((c) => !absorbed.has(c.id));

  // 注意判空必须把 `images` 也算进来：只有图片的 assistant 消息（罕见但合法）若被这里丢掉，
  // 手机端会出现"这一轮凭空少了一条消息"，比多渲染一条空壳更难查。
  const images = projectImages(content);
  if (!text.text && !reasoning && toolCalls.length === 0 && !images) return { message: null, pendingOrphans: remaining };

  const message = {
    seq: ev.seq ?? null,
    at: ev.time ?? null,
    role: 'assistant',
    turn: ev.data?.turn ?? null,
    step: ev.data?.step ?? null,
    text: text.text,
    ...(text.truncated ? { truncated: true } : {}),
    ...(reasoning ? { reasoning } : {}),
    // assistant 自己产出的图片（与 `user/message`、`tool/result` 用**同一个**投影函数）：
    // 真实日志里这一支极罕见（图片大多走工具结果），但契约要求"内容块里有 image 块就投影"，
    // 漏一处就会出现"某些图在手机上永远不显示"这种最难查的不一致。
    ...(images ? { images } : {}),
    toolCalls,
    deliverables: [],
    ...(ev.data?.usage ? { usage: ev.data.usage } : {}),
    id: typeof ev.data?.message?.id === 'string' ? ev.data.message.id : null,
  };
  return { message, pendingOrphans: remaining };
}

/** 内部注入消息（默认被过滤掉）。 */
function internalMessage({ seq, at, role, text, truncated, kind }) {
  return { seq: seq ?? null, at: at ?? null, role, text, ...(truncated ? { truncated: true } : {}), internal: true, kind, toolCalls: [], deliverables: [] };
}

/**
 * 把 content 数组里的 **text** 块拼起来，并按 256 KiB 上限截断（只留头部）。
 *
 * 只取 `type === 'text'`（以及无 type 但带 text 的块）：`reasoning` 块也是 `{type,text}`，
 * 用一个宽松的「有 text 字段就算」会把思考过程混进正文（实测形状：
 * `[{type:'reasoning',text:'…'},{type:'text',text:'…'}]`）。
 * @param {Array<{type?:string,text?:string}>|undefined} content
 * @returns {{text: string, truncated: boolean}}
 */
export function contentText(content) {
  if (!Array.isArray(content)) return { text: '', truncated: false };
  const joined = content
    .filter((c) => c && typeof c.text === 'string' && (c.type === 'text' || c.type === undefined))
    .map((c) => c.text)
    .join('');
  const capped = truncateUtf8(joined, CAPS.messageText);
  return { text: capped, truncated: capped.length < joined.length };
}

/**
 * 解析工具参数：真实数据里 `arguments` 是 **JSON 字符串**。
 * 解析失败时保留原始字符串（放在 `raw` 里），绝不丢信息也不抛错。
 * @param {unknown} raw
 * @returns {object}
 */
export function parseArgs(raw) {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { value: raw };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return { value: parsed };
  } catch {
    return { raw };
  }
}

/** 记录一次可能改动工作区的调用。 */
function recordMutation(name, rawArgs, changedPaths, onUnknown) {
  if (typeof name !== 'string' || !MUTATING_TOOLS.has(name)) return;
  const args = parseArgs(rawArgs);
  const candidate = args.file_path ?? args.path ?? args.notebook_path ?? args.file;
  if (typeof candidate === 'string' && candidate.trim()) {
    // 归一化：Windows 大小写不敏感 + 统一分隔符，避免同一文件被算两次
    changedPaths.add(candidate.trim().replace(/\//g, '\\').toLowerCase());
    return;
  }
  onUnknown(); // 例如 apply_patch（补丁里含路径，无法从参数直接取）
}

/**
 * 读取 `storages/session_projcache/sessions/<id>.json`（桌面端的**派生缓存**）。
 *
 * 用它的三个理由（都已对真实文件核对过字段）：
 * 1. `rows.title.val` —— 标题，省掉一次全量解压；
 * 2. `rows.turnBoundary.val.openTurnStartSeq` / `rows.sessionStats.val.openStep` / `pendingCalls`
 *    —— **比 mtime 更可靠的"正在跑"信号**：实测有会话 6 秒 0 字节写入却仍在跑，
 *    只看 mtime/size 会漏判（侦察报告 §6）；
 * 3. `rows.turnBoundary.val.seq` —— 已投影的事件水位，可直接当 `fromSeq - 1` 用。
 *
 * 只读 `<id>.json`，**忽略** `session_projcache.json`（那是停更的遗留整单元文件）。
 * @param {string} dshHome
 * @param {string} id
 * @param {{fsImpl?: object}} [opts]
 * @returns {Promise<object|null>}
 */
export async function readProjCache(dshHome, id, { fsImpl = fs } = {}) {
  if (typeof id !== 'string' || !id) return null;
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return null;
  let raw;
  try {
    raw = JSON.parse(await fsImpl.promises.readFile(path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
  const rows = raw?.record?.rows ?? {};
  const val = (key) => (rows[key] && typeof rows[key] === 'object' && 'val' in rows[key] ? rows[key].val : null);
  const boundary = val('turnBoundary') ?? {};
  const stats = val('sessionStats') ?? {};
  const listMeta = val('sessionListMetadata') ?? {};
  const title = val('title');
  const seqs = Object.values(rows).map((row) => (row && typeof row === 'object' && typeof row.seq === 'number' ? row.seq : -1));
  return {
    title: typeof title === 'string' && title.trim() ? title.trim() : null,
    agentPreset: val('agentPreset'),
    createdAt: raw?.record?.identity?.createdAt ?? null,
    cwd: raw?.record?.identity?.cwd ?? null,
    lastPromptAt: typeof listMeta.lastPromptAt === 'number' ? listMeta.lastPromptAt : null,
    openTurnStartSeq: boundary.openTurnStartSeq ?? null,
    lastTurn: boundary.lastTurn ?? null,
    openStep: stats.openStep ?? null,
    pendingCalls: stats.pendingCalls ?? null,
    turns: typeof stats.turns === 'number' ? stats.turns : null,
    steps: typeof stats.steps === 'number' ? stats.steps : null,
    seq: seqs.length > 0 ? Math.max(...seqs) : -1,
    version: raw?.version ?? null,
  };
}

/** 兼容旧名（只取标题）。 */
export async function readProjCacheTitle(dshHome, id, { fsImpl = fs } = {}) {
  return (await readProjCache(dshHome, id, { fsImpl }))?.title ?? null;
}

/** projcache 是否显示该会话"仍在一轮中"。 */
export function projCacheIsRunning(projcache) {
  if (!projcache) return false;
  if (projcache.openTurnStartSeq !== null && projcache.openTurnStartSeq !== undefined) return true;
  if (projcache.openStep !== null && projcache.openStep !== undefined) return true;
  const pending = projcache.pendingCalls;
  if (pending && typeof pending === 'object' && Object.keys(pending).length > 0) return true;
  return false;
}

/**
 * 会话镜像（带缓存，支持**多个来源根**）。
 *
 * 为什么必须多根（lead 裁定 + SDK 实测约束）：
 * - `~/.dsh`（用户真实 home）= **只读镜像**，里面的桌面端会话 `writable:false`；
 * - `dsh.sessionsHome`（网关自己的 home）= 网关用 SDK profile 创建的会话，`writable:true`、可续聊。
 * 两类会话在手机端必须**分开呈现**（同样的 id 空间、不同的能力），因此每个会话都要带
 * `source` 与 `writable`，而不是靠调用方猜。
 *
 * 缓存策略：按 `${source}:${id}` 缓存 `{reader, header, summary}`；`reader` 是增量多帧读取器，
 * 文件追加新事件时只解压新增帧。失效条件只有两个：文件 size/mtime 变化，或显式 `invalidate`。
 */
export class SessionMirror {
  /**
   * @param {{dshHome?: string|null, roots?: Array<{home: string, source: string, writable: boolean, label?: string}>, fsImpl?: object, now?: () => number, liveWindowMs?: number, logger?: object|null}} opts
   */
  constructor({ dshHome = null, roots = null, fsImpl = fs, now = Date.now, liveWindowMs = 60_000, logger = null } = {}) {
    this.fs = fsImpl;
    this.now = now;
    this.liveWindowMs = liveWindowMs;
    this.logger = logger;
    const list = roots && roots.length > 0 ? roots : [{ home: dshHome, source: 'disk', writable: false, label: '会话' }];
    /** @type {Array<{home: string, source: string, writable: boolean, label: string}>} */
    this.roots = list.filter((r) => typeof r?.home === 'string' && r.home).map((r) => ({ home: r.home, source: r.source ?? 'disk', writable: r.writable === true, label: r.label ?? r.source ?? '会话' }));
    /** 兼容旧调用方（单根时指向第一个根）。 */
    this.dshHome = this.roots[0]?.home ?? dshHome;
    /** @type {Map<string, {key: string, id: string, root: object, file: string, reader: MultiFrameReader, header: object|null, summary: object|null, projected: object|null, size: number, mtimeMs: number, parsedAt: number}>} */
    this.cache = new Map();
  }

  /** 清空全部缓存。 */
  clear() {
    this.cache.clear();
  }

  /** 丢弃某个会话的缓存（全部根）。 */
  invalidate(id) {
    for (const key of [...this.cache.keys()]) if (this.cache.get(key).id === id) this.cache.delete(key);
  }

  /** 缓存条目数。 */
  get size() {
    return this.cache.size;
  }

  /** 可写根（网关自己的会话）。 */
  get writableRoot() {
    return this.roots.find((r) => r.writable) ?? null;
  }

  /**
   * 跨根定位一个会话（按 roots 顺序，第一个命中的胜出）。
   * 附带 projcache 信号与 `lastSeq`（供 fromSeq 计算）。
   * @param {string} id
   * @param {{workspace?: string|null}} [opts]
   * @returns {Promise<object|null>}
   */
  async locate(id, { workspace = null } = {}) {
    for (const root of this.roots) {
      const found = await findSession({ dshHome: root.home, id, workspace, fsImpl: this.fs });
      if (!found) continue;
      const projcache = await readProjCache(root.home, found.id, { fsImpl: this.fs });
      return {
        ...found,
        root,
        projcache,
        writable: root.writable,
        lastSeq: projcache && projcache.seq >= 0 ? projcache.seq : -1,
        runningFromCache: projCacheIsRunning(projcache),
      };
    }
    return null;
  }

  /**
   * 确保某个会话的缓存是最新的（增量）。
   * @param {{id: string, workspace?: string|null, force?: boolean, located?: object|null}} input
   * @returns {Promise<object|null>}
   */
  async ensure({ id, workspace = null, force = false, located = null }) {
    const found = located ?? (await this.locate(id, { workspace }));
    if (!found) return null;
    const key = `${found.root.source}:${found.id}`;
    let entry = this.cache.get(key);
    if (!entry) {
      entry = {
        key,
        id: found.id,
        root: found.root,
        file: found.file,
        header: found.header,
        reader: new MultiFrameReader({ file: found.file, fsImpl: this.fs }),
        summary: null,
        projected: null,
        size: found.size,
        mtimeMs: found.mtimeMs,
        parsedAt: 0,
      };
      this.cache.set(key, entry);
    }

    let stat;
    try {
      stat = await this.fs.promises.stat(entry.file);
    } catch {
      this.cache.delete(key);
      return null;
    }
    const unchanged = !force && entry.summary !== null && stat.size === entry.size && stat.mtimeMs === entry.mtimeMs;
    if (unchanged) return entry;

    // 文件被截断/重写 → 头部也可能变，重新读
    const header = await readSessionHeader(entry.file, { fsImpl: this.fs });
    if (header) entry.header = header;
    entry.size = stat.size;
    entry.mtimeMs = stat.mtimeMs;

    await entry.reader.refresh({ force: true });
    // 缓存**全部**消息（含 internal），过滤放在请求期做，这样 ?include=internal 不需要重新投影
    const { meta, allMessages } = projectSession(entry.reader.events, { header: entry.header ?? header, includeInternal: true });
    entry.summary = meta;
    entry.projected = { messages: allMessages };
    entry.parsedAt = this.now();
    return entry;
  }

  /**
   * 会话列表（契约 §4.2 `GET /api/v2/sessions`）。
   * @param {{workspace?: string|null, limit?: number, cursor?: string|null, includeSubagent?: boolean, source?: string|null}} [opts]
   */
  async list({ workspace = null, limit = 50, cursor = null, includeSubagent = false, source = null } = {}) {
    const offset = parseCursor(cursor);
    const collected = [];
    for (const root of this.roots) {
      if (source && root.source !== source) continue;
      const found = await discoverSessions({ dshHome: root.home, fsImpl: this.fs, includeSubagents: true });
      for (const item of found) collected.push({ ...item, root });
    }
    let items = collected;
    // 缺省只给**顶层会话**：判据与 DSH 桌面端侧边栏同源（`origin === 'subagent'` 一律隐藏），
    // 并额外认 `parentSession` / `delegationDepth` 两条独立信号——桌面端写顶层 header 时
    // 不带 origin，旧代码 `s.origin === 'user'` 会把这类派生会话放进默认列表。
    // 这里刻意**不**读 `config.mirror.includeSubagentsByDefault`：那是网关装配期的默认值，
    // `http.mjs` 已按它算出 `includeSubagent` 再传进来，两处都读会变成双份真相。
    if (!includeSubagent) items = items.filter((s) => !isDerivedSession(s.header));
    if (workspace) {
      const target = path.resolve(workspace).toLowerCase();
      items = items.filter((s) => s.workspace && path.resolve(s.workspace).toLowerCase() === target);
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const page = items.slice(offset, offset + limit);
    const sessions = [];
    for (const item of page) {
      const projcache = await readProjCache(item.root.home, item.id, { fsImpl: this.fs });
      const entry = await this.ensure({ id: item.id, workspace: item.workspace, located: { ...item, projcache } });
      const summary = entry?.summary ?? {};
      const running = projCacheIsRunning(projcache);
      sessions.push({
        id: item.id,
        title: summary.title ?? projcache?.title ?? null,
        workspace: summary.workspace ?? item.workspace,
        cwd: summary.cwd ?? item.cwd,
        createdAt: summary.createdAt ?? item.createdAt,
        // lead 裁定：max(createdAt, projcache.sessionListMetadata.lastPromptAt)；再与事件时间取大
        updatedAt: Math.max(summary.updatedAt ?? 0, projcache?.lastPromptAt ?? 0, item.createdAt ?? 0) || item.mtimeMs,
        turns: summary.turns ?? projcache?.turns ?? 0,
        steps: summary.steps ?? projcache?.steps ?? 0,
        lastTurn: summary.lastTurn ?? null,
        live: this.isLive(item.mtimeMs) || running,
        liveReason: this.isLive(item.mtimeMs) ? 'mtime' : running ? 'projcache' : null,
        taken: this.isTaken(item.id),
        origin: item.origin,
        parentSession: item.parentSession ?? null,
        // 列表也要下发 delegationDepth：手机端「含子代理」打开后要按层级展示父子关系，
        // 只有 parentSession 时无法区分"直接子代理"与"孙代理"。
        delegationDepth: delegationDepthOf(item.header),
        agentPreset: summary.agentPreset ?? item.agentPreset ?? projcache?.agentPreset ?? null,
        bytes: item.size,
        eventCount: summary.eventCount ?? 0,
        hasChanges: summary.hasChanges === true,
        changeCount: summary.changeCount ?? 0,
        // v2 扩展：手机端据此区分"可续聊的网关会话"与"只读的电脑端会话"
        source: item.root.source,
        writable: item.root.writable,
        writableReason: item.root.writable ? null : 'pc_mirror_readonly',
      });
    }
    const nextOffset = offset + page.length;
    return { sessions, nextCursor: nextOffset < items.length ? String(nextOffset) : null, total: items.length, roots: this.roots.map((r) => ({ source: r.source, home: r.home, writable: r.writable, label: r.label })) };
  }

  /** 单会话元数据（契约 §4.2 `GET /api/v2/sessions/{id}`）。 */
  async get(id, { workspace = null } = {}) {
    const located = await this.locate(id, { workspace });
    if (!located) return null;
    const entry = await this.ensure({ id, workspace, located });
    if (!entry) return null;
    const s = entry.summary;
    const running = located.runningFromCache;
    return {
      id: entry.id,
      title: s.title ?? located.projcache?.title ?? null,
      workspace: s.workspace,
      cwd: s.cwd,
      createdAt: s.createdAt,
      updatedAt: Math.max(s.updatedAt ?? 0, located.projcache?.lastPromptAt ?? 0, s.createdAt ?? 0) || entry.mtimeMs,
      turns: s.turns,
      steps: s.steps,
      lastTurn: s.lastTurn,
      live: this.isLive(entry.mtimeMs) || running,
      liveReason: this.isLive(entry.mtimeMs) ? 'mtime' : running ? 'projcache' : null,
      taken: this.isTaken(entry.id),
      origin: s.origin,
      parentSession: entry.header?.parentSession ?? null,
      delegationDepth: delegationDepthOf(entry.header),
      agentPreset: s.agentPreset ?? located.projcache?.agentPreset ?? null,
      bytes: entry.size,
      eventCount: s.eventCount,
      hasChanges: s.hasChanges,
      changeCount: s.changeCount,
      model: s.model,
      sandboxMode: s.sandboxMode,
      usage: s.usage,
      file: entry.file,
      source: located.root.source,
      writable: located.root.writable,
      writableReason: located.root.writable ? null : 'pc_mirror_readonly',
    };
  }

  /**
   * 取**已缓存**的投影（含 internal，过滤放在请求期做）。
   *
   * 抽出来的唯一理由是「下标一致性」：`/transcript` 与 `/turn-index`（契约 §4.2.1 / §4.2.3）
   * 必须建立在**同一套投影 + 同一种过滤**之上，否则索引里的 `fromIndex`/`toIndex`
   * 会指到别的消息上（这类错位在客户端表现为"跳过去少一条/多一条"，
   * 几乎不可能从现象倒推回原因）。两条端点都只经由这里拿消息数组，
   * 谁也不许自己再解析一遍事件。
   *
   * `entry.projected.messages` 是 `projectSession` 的 `allMessages` **数组本身**，
   * 调用方**必须**先 `filter` 出副本再切页（`paginate` 用 `slice`，天然是副本）。
   */
  async #projectionOf(id, { workspace = null, force = false } = {}) {
    const entry = await this.ensure({ id, workspace, force });
    const messages = entry?.projected?.messages ?? [];
    return { entry, messages };
  }

  /**
   * transcript 分页（契约 §4.2）。
   *
   * 分页语义（单一含义，便于手机端"上拉加载更早"）：
   * `cursor` 是**排他上界**（offset）；返回其之前最多 `limit` 条；`nextCursor` 是下一页
   * （更早）应传的 cursor；为 null 表示已经到最早。
   */
  async transcript(id, { tail = null, cursor = null, limit = null, includeInternal = false, workspace = null } = {}) {
    const { entry, messages: all } = await this.#projectionOf(id, { workspace });
    if (!entry) return null;
    // 默认隐藏运行时注入（system prompt / runtime-context 快照 / team 消息），
    // ?include=internal 可拿到全量。这不是丢数据：原始事件在 /events 里始终可查。
    const messages = includeInternal ? all : all.filter((m) => !m.internal);
    return { sessionId: entry.id, ...paginate(messages, { tail, cursor, limit }) };
  }

  /**
   * 轮次索引（契约 §4.2.3，v2.9.0）：每一轮在 transcript 消息数组里的位置。
   *
   * 手机端本地只持有最近一页消息，「点第 12 轮跳过去」必须先知道那一轮的区间；
   * 本方法给出的 `fromIndex`/`toIndex` 是**与 `/transcript` 完全同一套投影**（含同一种
   * `internal` 过滤）的 0 基下标，所以客户端可以直接
   * `GET /transcript?cursor=<toIndex>&limit=60` 取到"以该轮结尾"的一页。
   *
   * @param {string} id
   * @param {{workspace?: string|null, includeInternal?: boolean}} [opts]
   */
  async turnIndex(id, { workspace = null, includeInternal = false } = {}) {
    const { entry, messages: all } = await this.#projectionOf(id, { workspace });
    if (!entry) return null;
    const messages = includeInternal ? all : all.filter((m) => !m.internal);
    const turns = buildTurnIndex(messages);
    return { sessionId: entry.id, total: turns.length, totalMessages: messages.length, turns };
  }

  /** 原始事件（契约 §4.2 `GET /api/v2/sessions/{id}/events`）。 */
  async events(id, { fromSeq = null, tail = null, limit = null, workspace = null } = {}) {
    const entry = await this.ensure({ id, workspace });
    if (!entry) return null;
    const all = entry.reader.events;
    const cap = clampInt(limit, TRANSCRIPT_LIMITS.eventsDefault, 1, TRANSCRIPT_LIMITS.eventsMax);
    let slice;
    if (tail !== null && tail !== undefined) {
      slice = all.slice(Math.max(0, all.length - clampInt(tail, cap, 1, TRANSCRIPT_LIMITS.eventsMax)));
    } else if (fromSeq !== null && fromSeq !== undefined) {
      const from = Math.max(0, Number(fromSeq) || 0);
      const start = all.findIndex((ev) => typeof ev.seq === 'number' && ev.seq >= from);
      const at = start === -1 ? all.length : start;
      slice = all.slice(at, at + cap);
    } else {
      slice = all.slice(Math.max(0, all.length - cap));
    }
    const lastSeq = slice.reduce((max, ev) => (typeof ev.seq === 'number' && ev.seq > max ? ev.seq : max), -1);
    return {
      sessionId: entry.id,
      source: entry.root.source,
      events: slice,
      eventCount: all.length,
      returned: slice.length,
      fromSeq: fromSeq ?? null,
      nextFromSeq: lastSeq >= 0 ? lastSeq + 1 : null,
      truncated: slice.length < all.length,
      frames: entry.reader.frames,
      bytes: entry.size,
    };
  }

  /** live 判定（契约 §5.4）：会话文件 mtime 在窗口内。 */
  isLive(mtimeMs) {
    return typeof mtimeMs === 'number' && mtimeMs > 0 && this.now() - mtimeMs <= this.liveWindowMs;
  }

  /** 本进程轮次占用表（由 session-runner 注入查询函数，避免模块循环依赖）。 */
  isTaken(id) {
    return Boolean(this.occupancyQuery?.(id));
  }

  /** 由 runner 注入占用表查询。 */
  setOccupancy(query) {
    this.occupancyQuery = typeof query === 'function' ? query : null;
  }

  /** 工作区索引（转发 dsh-home）。 */
  workspaceIndex(source = null) {
    const root = source ? this.roots.find((r) => r.source === source) : this.roots[this.roots.length - 1];
    return readWorkspaceIndex(root?.home ?? this.dshHome, { fsImpl: this.fs });
  }
}

/**
 * 轮次索引里服务端截断文案的**字节**预算（契约 §4.2.3 写作"每段 ≤ 200 字符"）。
 *
 * 为什么按字节而不是字符卡：`truncateUtf8` 是仓库里现成的、UTF-8 安全的截断工具
 * （不会切断多字节字符与代理对），复用它就不用再写一套按码点计数的截断。
 * 代价是**中文更紧**（UTF-8 下 1 个汉字 3 字节）：200 字节 ≈ 66 个汉字。
 * 这里刻意选"更紧"而不是"更松"—— 本端点存在的意义就是**不让大正文上来**
 * （手机端一屏只需要看清是哪一轮），松到 200 个汉字等于把索引做成了第二份 transcript。
 */
const TURN_INDEX_TEXT_BYTES = 200;

/** 索引文案：空白归一化 + UTF-8 安全截断；空串一律给 `null`（不写空字符串，便于客户端判空）。 */
function indexText(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return truncateUtf8(flat, TURN_INDEX_TEXT_BYTES) || null;
}

/**
 * 从**已投影**的消息数组构建轮次索引（契约 §4.2.3，v2.9.0）。
 *
 * 归属规则（有意保持简单，逐条写在下面，客户端可依赖）：
 * 1. 只认消息上**显式的** `turn` 字段 —— `user/message` 由投影循环用 `openTurn` 打戳，
 *    `assistant/message` 自带。`turn` 为 `null` 的消息（会话开头的系统注入、`turn/end`
 *    之后的收尾合成消息、`deliverables/presented` 兜底生成的那条）**不进任何一轮**：
 *    把它们塞给"当前轮"会让区间端点落在非对话消息上，客户端按 `toIndex` 取页时会
 *    莫名其妙多/少一条，而这种错位几乎无法从现象倒推回原因。
 * 2. `fromIndex` = 该轮**第一条**有 turn 的消息下标；`toIndex` = **最后一条**下标 + 1（排他）。
 *    因为过滤保留顺序，同 turn 的消息天然连续，所以这等价于"这一轮的整段区间"。
 * 3. `userText` = 该轮**第一条**有正文的 user 消息；`assistantText` = 该轮**最后一条**
 *    有正文的 assistant 消息（取最后一条是因为长轮次里结论在末尾，取第一条只有"我看看…"）。
 * 4. `steps` = 该轮不同 `step` 的个数（缺 `step` 的消息不计）；`toolCalls` = 该轮
 *    `toolCalls` 数组长度之和。
 * 5. 没有任何消息属于某一轮时，该轮**不会**出现在数组里（总轮次以 `meta.turns` 为准，
 *    它是 `turn/start` 的计数）—— 宁可少一条空条目，也不要给客户端一个点进去是空页的入口。
 *
 * @param {object[]} messages 与 `/transcript` 同一套投影、**同一种过滤**之后的消息数组
 * @returns {Array<{turn: number, fromIndex: number, toIndex: number, at: number|null, userText: string|null, assistantText: string|null, steps: number, toolCalls: number}>}
 */
export function buildTurnIndex(messages) {
  /** @type {Map<number, {turn: number, fromIndex: number, toIndex: number, at: number|null, userText: string|null, assistantText: string|null, steps: Set<number>, toolCalls: number}>} */
  const byTurn = new Map();
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const turn = msg?.turn;
    if (typeof turn !== 'number' || !Number.isInteger(turn)) continue;
    let entry = byTurn.get(turn);
    if (!entry) {
      entry = { turn, fromIndex: index, toIndex: index + 1, at: null, userText: null, assistantText: null, steps: new Set(), toolCalls: 0 };
      byTurn.set(turn, entry);
    } else {
      entry.toIndex = index + 1;
    }
    if (entry.at === null && typeof msg.at === 'number') entry.at = msg.at;
    if (msg.role === 'user' && entry.userText === null) {
      const text = indexText(msg.text);
      if (text) entry.userText = text;
    }
    if (msg.role === 'assistant') {
      const text = indexText(msg.text);
      if (text) entry.assistantText = text;
    }
    if (typeof msg.step === 'number' && Number.isInteger(msg.step)) entry.steps.add(msg.step);
    if (Array.isArray(msg.toolCalls)) entry.toolCalls += msg.toolCalls.length;
  }
  return [...byTurn.values()]
    .sort((a, b) => a.turn - b.turn)
    .map((entry) => ({
      turn: entry.turn,
      fromIndex: entry.fromIndex,
      toIndex: entry.toIndex,
      at: entry.at,
      userText: entry.userText,
      assistantText: entry.assistantText,
      steps: entry.steps.size,
      toolCalls: entry.toolCalls,
    }));
}

/**
 * 分页工具：cursor 是排他上界。
 * @param {object[]} items
 * @param {{tail?: number|null, cursor?: string|null, limit?: number|null}} opts
 */
export function paginate(items, { tail = null, cursor = null, limit = null } = {}) {
  const total = items.length;
  const cap = clampInt(limit ?? (tail ?? TRANSCRIPT_LIMITS.default), TRANSCRIPT_LIMITS.default, 1, TRANSCRIPT_LIMITS.max);
  const end = cursor === null || cursor === undefined || cursor === '' ? total : Math.max(0, Math.min(total, parseCursor(cursor)));
  const start = Math.max(0, end - cap);
  const slice = items.slice(start, end);
  return { messages: slice, nextCursor: start > 0 ? String(start) : null, total, from: start, to: end };
}

/** 解析游标（十进制非负整数）；非法值当作 0。 */
export function parseCursor(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** 取整并 clamp。 */
export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
