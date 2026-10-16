/**
 * HTTP 接入层：路由、Bearer 鉴权、限速、请求体上限、SSE 事件流、统一错误体。
 *
 * 为什么把所有 HTTP 细节集中在这里：契约只暴露一层 REST/SSE，
 * 把「协议细节」与「任务/令牌领域逻辑」分开，可以让领域模块用单测直接驱动，
 * 不必为每个业务分支都起一个 HTTP 服务。
 *
 * 防挂起（工单硬性要求 5）：
 * - 请求体：Content-Length 预检 + 流式累计，超过 1MB 立刻 413 并关闭连接，绝不无限收包；
 * - 头部/请求接收：server.headersTimeout / server.requestTimeout 兜底，慢速攻击得到 408；
 * - SSE：每个连接一个心跳定时器，客户端断开（req/res close/error）立即 clearInterval + 退订，
 *   并且支持 maxSseClients 上限，防止连接泄漏拖垮网关。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { EventBus } from './events.mjs';
import { DeviceStore, PairingManager } from './tokens.mjs';
import { RateLimiter, isLoopbackAddress, normalizeIp } from './ratelimit.mjs';
import { TaskError, TaskManager } from './tasks.mjs';
import { describeAccess, resolveAccess } from './permission.mjs';
import { isWithin, listWorkspaces, resolveWorkspace } from './workspace.mjs';
import { createLogger, redactSecrets, randomBase64Url } from './util.mjs';
import { SessionMirror, TRANSCRIPT_LIMITS } from './session-reader.mjs';
import { LiveTracker, SessionStream, STREAM_EVENTS } from './session-live.mjs';
import { SessionRunner } from './session-runner.mjs';
import { PhoneSessionIndex } from './phone-sessions.mjs';
import { DesktopApi, DEFAULT_DESKTOP_PORT, translateDesktopEvent } from './desktop-api.mjs';
import { ApprovalBridge } from './approvals.mjs';
import { RelayClient, normalizeRelayUrl } from './relay-client.mjs';
import { READ_MODE, WorkspaceError, listDirectory, readFileEntry, searchWorkspace } from './workspace-fs.mjs';
import { gitDiff, gitStatus, listWorkspacesWithVcs } from './workspace-git.mjs';
import { isDerivedSession, SESSION_DIR_RE } from './dsh-home.mjs';
import { ATTACHMENT_ID_RE, ATTACHMENT_MAX_BYTES, normalizeAttachmentId, resolveAttachment } from './attachments.mjs';

/** transcript / events 分页上限（契约 §4.2）。 */
const TRANSCRIPT_MAX = TRANSCRIPT_LIMITS.max;

/**
 * 契约错误码 → HTTP 状态码。
 * `conflict`(409) 与 `payload_too_large`(413) 是契约 v1.1（A2 硬约束）新增的码：
 * - A2-2 要求删除活动任务返回 409；
 * - A2-b 要求请求体超限返回 413 payload_too_large。
 * 二者是对 §0 错误码枚举的**追加**，不改动既有码语义。
 */
export const ERROR_STATUS = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  payload_too_large: 413,
  pairing_closed: 403,
  pairing_bad_code: 401,
  rate_limited: 429,
  busy: 429,
  internal: 500,
  // ---- v2 新增码（契约 §4.4）----
  home_offline: 503, // PC 隧道不在线
  home_not_found: 404, // 码对不上任何 home（中继侧）
  session_busy: 409, // 会话正在跑（live），拒绝两处同时写
  session_taken: 503, // 已被本进程的另一个轮次占用
  session_not_found: 404,
  workspace_outside: 403, // 路径越界（realpath 后不在白名单内）
  unavailable: 503, // 功能不可用（例如未配置 dsh 启动器）
  relay_disabled: 503, // relay 功能未启用
  not_git: 409, // 非 git 仓库但请求了 git 专属能力
  too_many_streams: 429, // 契约 §3.3 的隧道并发上限（与 rate_limited 区分）
  // ---- v2.4.0 新增：桌面端驱动通道（契约 §7.4 / §7.5）----
  desktop_unreachable: 503, // 连不上桌面端 DSH runtime（没在跑 / 端口不对）
  desktop_unavailable: 503, // 配置层面关闭了桌面端通道（desktop.enabled=false）
  desktop_disabled: 503, // 单个会话层面不可用（保留位，通常用 session_busy/desktop_unavailable）
  desktop_unauthorized: 502, // 桌面端凭据失效（读不到/对不上 ~/.dsh/.credentials.yaml）
  desktop_error: 502, // 桌面端返回了协议级错误
  // ---- v2.6.0 新增：审批/提问应答（契约 §7.7）----
  approval_expired: 409, // 未决请求超过网关 TTL（只是网关侧记账：电脑端那一轮仍然挂着）
  // ---- v2.9.0 新增：附件对象库（契约 §4.6）----
  // 为什么单独一个码而不是复用 payload_too_large：413 在契约里已经表示"**请求体**超限"
  // （手机发图那条路上会真的出现），两者一个是上行、一个是下行，混用后客户端排障时
  // 会去查自己的请求体。这里的语义是"附件本身超过网关愿意服务的上限（8 MiB）"。
  attachment_too_large: 413,
});

/**
 * `/api/v2/health` 的 `capabilities` 真值。
 *
 * 导出成常量是为了让 `gateway.mjs` 的启动横幅打印**同一份**清单：横幅以前手写死一份，
 * 审批能力上线后它仍写着旧内容，2026-10-15 真机排障时被误读成「能力没实现」。
 * 新增能力时只改这里一处。
 */
export const V2_CAPABILITIES = Object.freeze([
  'tasks', 'events', 'pairing', 'workspaces', 'cancel',
  'sessions', 'session.transcript', 'session.events', 'session.turns', 'session.abort', 'session.stream',
  'workspace.files', 'workspace.file', 'workspace.changes', 'workspace.diff', 'workspace.search',
  'relay', 'relay.pairing', 'task.access',
  'approvals', 'approvals.answer',
  // 「电脑端自己发起的轮次也能实时推到手机」—— `lib/desktop-watch.mjs` 的实时中继。
  // 单列一条能力是有意的：2026-10-15 那次真机排障就是因为**看不出网关进程里跑的是哪一版代码**，
  // 只能靠"手机上看不到效果"倒推。以后核对 `GET /api/v2/health` 有没有这一条即可。
  'session.desktopRelay',
  // 附件对象库（`GET /api/v2/attachments/{id}`，契约 §4.6）：手机端靠它把会话里的
  // `{type:'image'}` 块渲染成真图。单列一条的理由与上面 `session.desktopRelay` 相同 ——
  // 真机排障时"手机上图片全是占位符"必须先能一眼确认**这个网关进程有没有这条能力**。
  'attachments',
  // 轮次索引（`GET /api/v2/sessions/{id}/turn-index`，契约 §4.2.2）：手机端「第 N 轮」跳转。
  'session.turnIndex',
  // 模型目录与每任务模型选择（`GET /api/v2/models` + `POST /api/v2/tasks` 的
  // `provider`/`model`/`reasoningEffort`，契约 §4.7 / §7.8）。单列一条的理由同上：手机端的模型选择器
  // 必须能先问清"这个网关到底支不支持选模型"，否则老网关会把 `model` 静默丢掉
  // （旧版只记录不转发），用户看到的是"选了但用的是别的模型"这种最难查的现象。
  'models', 'task.model',
]);

/** 设备 ID 必须是**小写** UUID（契约 v1.1 A2-3）。 */
export const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// `POST /sessions/{id}/turns` 的 content 块（冻结线协议：手机端 ↔ 网关 ↔ 桌面端 runtime）
//
// 为什么校验放在网关而不是桌面端：网关是**唯一**能被不可信手机端直连的一层，
// 而图片要一路透传到桌面端 runtime 的 `session/prompt`。所有上限都在这里卡死，
// 免得一个坏请求把几 MB 的垃圾灌进桌面端 IPC，或者让桌面端抛一个手机端看不懂的错误。
// ---------------------------------------------------------------------------

/** 一轮最多携带的图片张数。 */
export const TURN_MAX_IMAGES = 4;

/** 单张图片 base64 **解码后**的字节上限（700 KiB）。 */
export const TURN_MAX_IMAGE_BYTES = 716_800;

/**
 * **整包预算**：一轮里所有 image 块 `data` 的 base64 字符数之和上限（1_000_000）。
 *
 * 为什么单图上限不够：`limits.maxBodyBytes`（`config.mjs:216`，注明"契约/工单硬性要求"）是
 * **1_048_576（1 MiB）作用于整个 JSON 请求体**。base64 膨胀 4/3 → "最多 4 张 × 700 KiB"
 * 原始量 2.8 MiB 会变成约 3.7 MiB 的请求体，**必然**在 `readJsonBody` 里撞 413；而那一支是
 * "不读请求体、直接 413 + Connection: close"，手机端只会看到连接被重置，拿不到结构化错误体。
 *
 * 取值必须同时满足两件事（这也是为什么不是更小的 900 KiB）：
 * 1. **一张满额单图必须放得进**：716_800 字节 → `Math.ceil(716800/3)*4 = 955_736` 字符。
 *    若预算取 921_600（900 KiB），单图上限会被整包预算反噬成 691_200 字节，
 *    与冻结协议的"单图解码后 ≤716800 字节"直接矛盾 —— 单图那层就成了死代码。
 * 2. **必须留在 1 MiB 体上限之内**：1_000_000 留 48_576 字节给 JSON 键名/引号/逗号、
 *    `prompt` 文本与 `clientTurnId`（`prompt` 本身另有 32_000 字符的上限）。
 */
export const TURN_MAX_IMAGE_TOTAL_BASE64 = 1_000_000;

/** 允许的图片 mediaType 白名单（不在表里一律 400，不做嗅探）。 */
export const TURN_IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 只发图片、一个 text 块都没给时用的占位正文（桌面端要求正文非空）。 */
export const TURN_IMAGE_ONLY_TEXT = '（查看这张图片）';

/**
 * 严格 base64：标准字母表 + 结尾 0~2 个 `=`，**不允许**换行/空白/URL-safe 字母表。
 * 光看这个正则还不够（`AB==` 的填充位非零也能匹配），所以下面还要解码后重编码比对。
 */
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 数出一个真 ContentBlock（对象、type==='image'）——只用于「先快速拒绝超量」的一眼判断。 */
const isImageBlock = (block) => block !== null && typeof block === 'object' && !Array.isArray(block) && block.type === 'image';

/**
 * 校验并归一化 `POST /sessions/{id}/turns` 请求体里的 `content`。
 *
 * 返回 `{ok:true, content, prompt, images}`：
 * - `content`：归一化后的 ContentBlock[]（丢掉未知字段）；**输入缺省/null/空数组时是 `null`**，
 *   调用方据此走"和没有 content 时一模一样"的旧路径。没有任何**非空** text 块时，这里会多出一个
 *   头部 text 块（占位正文），理由见函数尾部注释 —— 这是唯一一处"输出与输入不同形"的地方。
 * - `prompt`：所有 text 块按出现顺序以 `\n` 拼接；一个 text 块都没有（或全是空串）时是占位正文。
 *   `content` 为 null 时本字段也是 `null`，表示"prompt 由请求体的 `prompt` 字段决定"。
 * - `images`：`{count, bytes}`，`bytes` 是**解码后**总字节数（只用于日志与限额，日志绝不写图片本身）。
 *
 * 校验三层：单块结构/媒体类型/严格 base64 → 单图 ≤700 KiB → **整包 base64 总量 ≤1_000_000 字符**
 * （最后一层是为了不撞 1 MiB 请求体上限，见 `TURN_MAX_IMAGE_TOTAL_BASE64`）。
 *
 * **刻意不修的边界（别以为漏了）**：比 1 MiB 更大的请求体在 `readJsonBody` 那一支就被砍掉
 * —— 它不读请求体、直接 413 + `Connection: close`，手机端只能看到连接被重置，**拿不到结构化错误**。
 * 对用户兜底的方式是客户端按**同值**做预校验（本地拦下、给可执行文案），不是靠这里报错，
 * 所以本函数的消息里不要承诺"超 1 MB 会告诉你多少"。放宽 `limits.maxBodyBytes` 也不在选项内：
 * 那是契约硬性要求，且网关/中继两侧都得改。
 *
 * 返回 `{ok:false, message}`：`message` 必须能指认具体哪一条不合格（手机端要把它原样展示给用户）。
 * @param {unknown} content
 * @returns {{ok: true, content: object[]|null, prompt: string|null, images: {count: number, bytes: number}}
 *   | {ok: false, message: string}}
 */
export function validateTurnContent(content) {
  if (content === undefined || content === null) return { ok: true, content: null, prompt: null, images: { count: 0, bytes: 0 } };
  if (!Array.isArray(content)) return { ok: false, message: 'content 必须是数组（ContentBlock[]）' };
  // 空数组按"没带 content"处理：老客户端带 `content: []` 时行为必须与不带一模一样。
  if (content.length === 0) return { ok: true, content: null, prompt: null, images: { count: 0, bytes: 0 } };

  // 先按 type 一眼数一遍：超量就不必去解码那几 MB base64 了。
  const declared = content.filter(isImageBlock).length;
  if (declared > TURN_MAX_IMAGES) {
    return { ok: false, message: `图片数量超过上限：一轮最多 ${TURN_MAX_IMAGES} 张（收到 ${declared} 张）` };
  }

  const blocks = [];
  const texts = [];
  let count = 0;
  let bytes = 0;
  let base64Chars = 0;
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i];
    const at = `content[${i}]`;
    if (block === null || typeof block !== 'object' || Array.isArray(block)) return { ok: false, message: `${at} 必须是对象` };

    if (block.type === 'text') {
      if (typeof block.text !== 'string') return { ok: false, message: `${at}.text 必须是字符串` };
      texts.push(block.text);
      blocks.push({ type: 'text', text: block.text });
      continue;
    }

    if (block.type !== 'image') {
      return { ok: false, message: `${at}.type 未知：${JSON.stringify(block.type)}（只支持 text / image）` };
    }
    if (typeof block.mediaType !== 'string' || !TURN_IMAGE_MEDIA_TYPES.includes(block.mediaType)) {
      return {
        ok: false,
        message: `${at}.mediaType 不在白名单内（${TURN_IMAGE_MEDIA_TYPES.join(' / ')}）：${JSON.stringify(block.mediaType ?? null)}`,
      };
    }
    if (typeof block.data !== 'string' || block.data.length === 0) {
      return { ok: false, message: `${at}.data 必须是图片的 base64 字符串（不允许 data: 前缀）` };
    }
    if (block.name !== undefined && typeof block.name !== 'string') return { ok: false, message: `${at}.name 必须是字符串` };
    if (block.data.length % 4 !== 0 || !STRICT_BASE64_RE.test(block.data)) {
      return { ok: false, message: `${at}.data 不是严格 base64（只允许 A-Za-z0-9+/ 与结尾 = 填充，长度须为 4 的倍数，不允许换行/空白）` };
    }
    const decoded = Buffer.from(block.data, 'base64');
    if (decoded.toString('base64') !== block.data) {
      return { ok: false, message: `${at}.data 不是严格 base64（解码后重编码与原串不一致，填充位非法）` };
    }
    count += 1;
    const size = decoded.byteLength;
    if (size > TURN_MAX_IMAGE_BYTES) {
      return {
        ok: false,
        message: `${at} 解码后 ${size} 字节，超过单图上限 ${TURN_MAX_IMAGE_BYTES} 字节（700 KiB）`,
      };
    }
    bytes += size;
    base64Chars += block.data.length;
    blocks.push(block.name === undefined
      ? { type: 'image', mediaType: block.mediaType, data: block.data }
      : { type: 'image', mediaType: block.mediaType, data: block.data, name: block.name });
  }

  // 单图都合规、加起来却会撞传输层上限：这是"4 张满配"那条路的唯一体面出口。
  // 位置有意放在循环之后：先报"哪一张不合格"（下标可见），再报"合起来太多"。
  if (base64Chars > TURN_MAX_IMAGE_TOTAL_BASE64) {
    return { ok: false, message: '图片总量超过单次请求预算（约 1 MB base64），请减少图片数量或压缩后再发' };
  }

  const joined = texts.join('\n');
  const hasText = joined.trim().length > 0;
  // 没有任何**非空** text 块（纯图，或只有空/空白 text）时，占位正文必须**自己作为第一个 text 块**
  // 进 content：桌面端在 content 非空时会忽略 `text` 参数（`desktop-api.mjs:447`），只把 `text`
  // 放在参数里等于占位正文永远不进用户消息。纯图轮次会长期留在会话历史中，agent 与后来者需要
  // 一句可检索的正文才知道这张图是怎么来的 —— 代价是 `prompt` 与 forwarded content 首块一致、
  // 而客户端发来的原始 content（纯图片）没有这一块，这是刻意接受的（契约里写明）。
  // 有非空 text 块时**不插入、不重排**：客户端发什么就是什么。
  const outgoing = hasText ? blocks : [{ type: 'text', text: TURN_IMAGE_ONLY_TEXT }, ...blocks];
  return {
    ok: true,
    content: outgoing,
    prompt: hasText ? joined : TURN_IMAGE_ONLY_TEXT,
    images: { count, bytes },
  };
}

/** 携带契约错误码的 HTTP 异常。 */
export class HttpError extends Error {
  /**
   * @param {keyof ERROR_STATUS} code
   * @param {string} message
   * @param {{status?: number, headers?: Record<string,string>}} [opts]
   */
  constructor(code, message, { status = null, headers = {} } = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code] ?? 500;
    this.headers = headers;
  }
}

/** 客户端在响应前断开：不是服务端错误，静默忽略即可。 */
class ClientGoneError extends Error {}

/** 把路径切成路由标识。 */
export function routeOf(pathname) {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments[0] !== 'api') return { name: 'unknown' };
  if (segments[1] === 'v2') return routeOfV2(segments.slice(2));
  if (segments[1] !== 'v1') return { name: 'unknown' };
  const rest = segments.slice(2);
  if (rest.length === 1 && rest[0] === 'health') return { name: 'health' };
  if (rest.length === 2 && rest[0] === 'pair' && rest[1] === 'open') return { name: 'pairOpen' };
  if (rest.length === 2 && rest[0] === 'pair' && rest[1] === 'claim') return { name: 'pairClaim' };
  if (rest.length === 1 && rest[0] === 'events') return { name: 'events' };
  if (rest.length === 1 && rest[0] === 'workspaces') return { name: 'workspaces' };
  if (rest.length === 1 && rest[0] === 'devices') return { name: 'devices' };
  if (rest.length === 2 && rest[0] === 'devices') return { name: 'deviceRevoke', tokenId: safeDecode(rest[1]) };
  if (rest.length === 1 && rest[0] === 'tasks') return { name: 'tasks' };
  if (rest.length === 2 && rest[0] === 'tasks') return { name: 'taskDetail', id: safeDecode(rest[1]) };
  if (rest.length === 3 && rest[0] === 'tasks' && rest[2] === 'cancel') return { name: 'taskCancel', id: safeDecode(rest[1]) };
  return { name: 'unknown' };
}

/**
 * v2 路由（契约 §4）。
 * 注意 `/api/v2/sessions/stream` 必须**先于** `/api/v2/sessions/{id}` 判定，
 * 否则 `stream` 会被当成一个会话 id。
 */
function routeOfV2(rest) {
  if (rest.length === 1 && rest[0] === 'health') return { name: 'healthV2' };
  if (rest.length === 2 && rest[0] === 'pair' && rest[1] === 'open') return { name: 'pairOpenV2' };
  if (rest.length === 2 && rest[0] === 'pair' && rest[1] === 'claim') return { name: 'pairClaimV2' };
  if (rest.length === 2 && rest[0] === 'relay') {
    if (rest[1] === 'connect') return { name: 'relayConnect' };
    if (rest[1] === 'status') return { name: 'relayStatus' };
    if (rest[1] === 'disconnect') return { name: 'relayDisconnect' };
    return { name: 'unknown' };
  }
  if (rest[0] !== 'sessions') {
    if (rest[0] === 'workspaces') return routeOfWorkspaces(rest.slice(1));
    // v2 新增：手机新建任务（唯一入口），见 handler 内注释
    if (rest.length === 1 && rest[0] === 'tasks') return { name: 'tasksV2' };
    // v2.10.0 新增：模型目录（手机端模型选择器的数据源）。**恒定 200**，见 handler 内注释。
    if (rest.length === 1 && rest[0] === 'models') return { name: 'models' };
    // v2.6.0 新增：审批/提问（§7.7）—— 未决列表与应答
    if (rest[0] === 'approvals') return routeOfApprovals(rest.slice(1));
    // v2.9.0 新增：附件对象库（§4.6）。路径参数**含冒号**（`sha256:…`），
    // 因此这里要把被 `split('/')` 切开的整段拿回来再 `safeDecode`
    // （客户端可能百分号编码成 `sha256%3A…`，两种写法都必须命中）。
    if (rest.length === 2 && rest[0] === 'attachments') return { name: 'attachment', id: safeDecode(rest[1]) };
    return { name: 'unknown' };
  }
  if (rest.length === 1) return { name: 'sessions' };
  if (rest.length === 2 && rest[1] === 'stream') return { name: 'sessionsStream' };
  if (rest.length === 2) return { name: 'sessionDetail', id: safeDecode(rest[1]) };
  if (rest.length === 3) {
    const id = safeDecode(rest[1]);
    if (rest[2] === 'transcript') return { name: 'sessionTranscript', id };
    if (rest[2] === 'events') return { name: 'sessionEvents', id };
    if (rest[2] === 'turns') return { name: 'sessionTurns', id };
    if (rest[2] === 'abort') return { name: 'sessionAbort', id };
    // v2.9.0 新增：轮次索引（§4.2.2）。注意它与 `turns` **只差一个后缀**，
    // 是并列的两条路由：`turns` 是发一轮（POST），`turn-index` 是读索引（GET）。
    if (rest[2] === 'turn-index') return { name: 'sessionTurnIndex', id };
  }
  return { name: 'unknown' };
}

/**
 * v2 审批/提问子路由（契约 §7.7）。
 *
 * 只有两个端点，形状刻意镜像 `tasks`：
 * - `GET  /api/v2/approvals`            未决列表（可 `?sessionId=` 过滤）
 * - `POST /api/v2/approvals/{eventId}`  提交答案
 *
 * 为什么用桌面端的 `eventId` 而不是 approvalId 作路径参数：线上帧里的 `request`
 * 已被剥掉 `agent`/`signal`，**唯一稳定的关联键就是 `eventId`**（见 approvals.mjs 头注释）。
 */
function routeOfApprovals(rest) {
  if (rest.length === 0) return { name: 'approvals' };
  if (rest.length === 1) return { name: 'approvalAnswer', eventId: safeDecode(rest[0]) };
  return { name: 'unknown' };
}

/** v2 工作区子路由（契约 §4.3）。 */
function routeOfWorkspaces(rest) {
  if (rest.length === 0) return { name: 'workspacesV2' };
  if (rest.length !== 1) return { name: 'unknown' };
  switch (rest[0]) {
    case 'files':
      return { name: 'workspaceFiles' };
    case 'file':
      return { name: 'workspaceFile' };
    case 'changes':
      return { name: 'workspaceChanges' };
    case 'diff':
      return { name: 'workspaceDiff' };
    case 'search':
      return { name: 'workspaceSearch' };
    default:
      return { name: 'unknown' };
  }
}

/** 非法百分号编码不应让路由 500，按字面量处理。 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 每个路由允许的 HTTP 方法（其余方法返回 405）。 */
const ROUTE_METHODS = Object.freeze({
  health: ['GET'],
  pairOpen: ['POST'],
  pairClaim: ['POST'],
  events: ['GET'],
  workspaces: ['GET'],
  devices: ['GET'],
  deviceRevoke: ['DELETE'],
  tasks: ['GET', 'POST'],
  taskDetail: ['GET', 'DELETE'],
  taskCancel: ['POST'],
  // ---- v2（契约 §4）----
  healthV2: ['GET'],
  pairOpenV2: ['POST'],
  pairClaimV2: ['POST'],
  relayConnect: ['POST'],
  relayStatus: ['GET'],
  relayDisconnect: ['POST'],
  tasksV2: ['POST'],
  approvals: ['GET'],
  approvalAnswer: ['POST'],
  sessions: ['GET'],
  sessionsStream: ['GET'],
  sessionDetail: ['GET'],
  sessionTranscript: ['GET'],
  sessionEvents: ['GET'],
  sessionTurns: ['POST'],
  sessionAbort: ['POST'],
  sessionTurnIndex: ['GET'],
  // v2.9.0：附件对象库。**只允许 GET**，且**不在** PUBLIC_ROUTES 里 ——
  // 与 sessions/workspaces 同档：内容哈希只能由"读到过会话记录的人"得知，
  // 而能读到会话记录的只可能是已配对设备（见 handler 内的安全注释）。
  attachment: ['GET'],
  workspacesV2: ['GET'],
  // v2.10.0：模型目录。与 sessions/workspaces 同档（**不在** PUBLIC_ROUTES 里）——
  // 它暴露的是"这台电脑上装了哪些 provider/模型"，属于内网信息，只该给已配对设备看。
  models: ['GET'],
  workspaceFiles: ['GET'],
  workspaceFile: ['GET'],
  workspaceChanges: ['GET'],
  workspaceDiff: ['GET'],
  workspaceSearch: ['GET'],
});

/**
 * 无需 Bearer 令牌的路径（契约 §0）。
 * v2 的 `pair/*` 必须公开：手机在配对时**还没有**任何令牌；
 * `relay/*` 管理端点沿用 v1 的「只接受回环来源」策略（见 handler 内的 isLoopbackAddress 校验），
 * 因此也不要求 Bearer（PC 本机脚本可直接调用）。
 */
const PUBLIC_ROUTES = new Set(['health', 'pairOpen', 'pairClaim', 'healthV2', 'pairOpenV2', 'pairClaimV2', 'relayConnect', 'relayStatus', 'relayDisconnect']);

/** v2 管理端点：只接受回环来源（契约 §4.1 / §5.5.5）。 */
const LOOPBACK_ONLY_ROUTES = new Set(['relayConnect', 'relayStatus', 'relayDisconnect', 'pairOpenV2', 'pairOpen']);

/**
 * 经隧道转发的内部标记头（必须与 `lib/relay-client.mjs` 的 `TUNNEL_HEADER` 一致）。
 *
 * 为什么要靠标记而不是来源 IP：**经隧道进来的请求来源天然是 127.0.0.1**，
 * 只按 IP 判"仅回环"在隧道路径上等于没判 —— 已配对手机就能读 `relay/status`（内网信息）、
 * `relay/disconnect`（远程断链 DoS）、`pair/open`（自行开配对窗口 = 越权提权）。
 * 伪造该头没有收益：带上它只会让管理端点拒绝；而 relay-client 转发前会先剥掉客户端自带的同名头。
 */
const TUNNEL_HEADER = 'x-dsh-tunnel';

/**
 * `driver` 的契约取值（协议契约 §7.5）：**谁在驱动这个会话**。
 *
 * 这两个值在三个地方必须完全一致 —— `GET /sessions` 列表、`GET /sessions/{id}` 详情、
 * `POST /turns`·`POST /abort` 回执 —— 否则客户端要么静默回退到"按 source 推导"，
 * 要么把回执里的通道标识误当会话属性。
 */
const DRIVER_DESKTOP = 'desktop';
const DRIVER_GATEWAY = 'gateway';

/**
 * 创建网关实例（不监听；调用 listen() 才开始服务）。
 * @param {object} config 已通过 validateConfig 的配置
 * @param {{logger?: object, spawnImpl?: Function|null, now?: () => number, platform?: string,
 *          desktop?: object|null|undefined}} [opts]
 *   `opts.desktop` 用于依赖注入：`undefined` = 按 `config.desktop` 自行构造；
 *   `null` = 显式关闭桌面端通道；传对象 = 用它（测试用的桩，或调用方自己配好的 `DesktopApi`）。
 */
export async function createGateway(config, { logger = null, spawnImpl = null, now = Date.now, platform = process.platform, desktop: injectedDesktop } = {}) {
  const log =
    logger ??
    createLogger({
      dir: config.logsDir,
      filePrefix: config.log.filePrefix,
      toConsole: config.log.toConsole,
      now,
    });

  const bus = new EventBus({ bufferSize: config.events.bufferSize, now });
  const devices = new DeviceStore({ file: config.devicesFile, now, logger: log });
  const loaded = await devices.load();
  const pairing = new PairingManager({ ttlMs: config.limits.pairCodeTtlMs, now });
  const tasks = new TaskManager({ config, logger: log, bus, spawnImpl, platform, now });
  await tasks.init();

  // ---- v2：会话镜像 / 运行态 / 续聊 / 中继 ----
  const mirror = new SessionMirror({
    // 兜底只用于"测试直接构造 config、没走 validateConfig"的情形：`source` 必须是 `computer`，
    // 否则这一根会被当成手机会话（不可写、也不会走桌面端通道），与契约 §4.2 的判据不符。
    roots: config.sessionRoots ?? [{ home: config.mirror?.resolvedHome ?? config.home, source: 'computer', writable: false, label: '电脑端会话（只读镜像）' }],
    now,
    liveWindowMs: config.mirror?.liveWindowMs ?? 60_000,
    logger: log,
  });
  const live = new LiveTracker({ windowMs: config.mirror?.liveWindowMs ?? 60_000, now });
  mirror.setOccupancy((id) => live.isTaken(id));
  const sessionStream = new SessionStream({ bufferSize: config.sessionStream?.bufferSize ?? 4000, now });

  /**
   * 桌面端 DSH runtime 客户端（契约 §7.4）：电脑端会话的驱动通道。
   *
   * 构造**不会**碰磁盘/网络（凭据是惰性读的），所以这里可以把"桌面端没起/没凭据"留到
   * 第一次真正使用时再暴露 —— 网关启动不会因为桌面端没开而失败。
   */
  const desktop =
    injectedDesktop !== undefined
      ? injectedDesktop
      : config.desktop?.enabled === false
        ? null
        : new DesktopApi({
            dshHome: config.desktop?.dshHome ?? null,
            port: config.desktop?.port ?? DEFAULT_DESKTOP_PORT,
            host: config.desktop?.host ?? '127.0.0.1',
            logger: log,
          });
  if (desktop === null) log.warn('配置已关闭桌面端驱动通道（desktop.enabled=false）：电脑端会话将保持只读');

  /**
   * 审批/提问桥（契约 §7.7）：让**手机**能应答电脑端会话的审批与提问。
   *
   * 为什么值得常驻一条到桌面端的事件流：审批不是一元 RPC，它是 Cordis waterfall，
   * 而 waterfall **没有重放保证** —— 订阅必须先于提问建立。(见 `lib/approvals.mjs` 头注释。)
   *
   * 为什么在 `openStream` 不存在时不启动：测试注入的桌面端桩只实现被用到的那几个方法，
   * 硬启动会让重连循环每 2s 记一条"桩不支持"的噪声日志，掩盖真正的失败。
   */
  const approvals = new ApprovalBridge({ desktop, stream: sessionStream, logger: log, now });
  if (desktop !== null && typeof desktop.openStream === 'function') {
    approvals.start();
  } else if (desktop !== null) {
    log.info('审批桥未启动：注入的桌面端客户端未实现 openStream');
  }

  /**
   * 手机任务索引（契约 §7.6）：记住"哪些会话是手机发起的"。
   *
   * 手机新建的任务默认落在**电脑端**的工作区里（那样电脑才能接手同一个会话），
   * 于是它们的 `source` 是 `computer`；手机端要认出"这是我发的任务"，只能靠这份登记。
   * 索引丢了只会少个标记，绝不该拦住网关启动 —— 所以加载失败按空索引继续。
   */
  const phoneSessions = new PhoneSessionIndex({
    file: path.join(config.home, 'phone-sessions.json'),
    now,
    logger: log,
  });
  const phoneSessionsLoaded = await phoneSessions.init();
  if (phoneSessionsLoaded) log.info(`手机任务索引已加载：${phoneSessionsLoaded} 条`);

  const runner = new SessionRunner({ config, mirror, live, stream: sessionStream, desktop, logger: log, spawnImpl, now });
  /** 中继客户端：`localBaseUrl` 指向**本机真实 HTTP**，隧道请求因此走完整鉴权/限流链路。 */
  const relay = new RelayClient({
    config,
    logger: log,
    now,
    localBaseUrl: () => localBaseUrl(),
    onNotice: (frame) => {
      if (frame.kind === 'home_offline' || frame.kind === 'revoked') log.warn(`中继通知：${frame.kind}`);
    },
  });

  const claimLimiter = new RateLimiter({ limit: config.limits.pairClaimPerMinute, windowMs: 60_000, now });
  const authLimiter = new RateLimiter({ limit: config.limits.authFailPerMinute, windowMs: 60_000, now });

  const startedAt = now();
  /** SSE 连接与心跳的显式台账：用于优雅关闭与「断开即清理」的自动化验证。 */
  const sse = { clients: new Set(), sessionClients: new Set(), heartbeats: new Set(), cleanups: new Set() };

  /**
   * 电脑端会话的 SSE 客户端分组：`sessionId → Set<res>`（契约 §7.4）。
   *
   * 手机打开一个电脑端会话时，事件不来自本进程的 SDK 运行时，而来自**桌面端 runtime 的
   * `session/follow` 流**。同一会话只开**一条**桌面端订阅，多个 SSE 客户端共享它 ——
   * 每条手机连接各开一条 WebSocket 会白白放大桌面端的连接数与事件扇出。
   */
  const desktopSse = { watchers: new Map(), subscriptions: new Map() };
  // 会话级生产者去重（与实时中继配合，见 `watchDesktopSession` 与 `runner.setDesktopDirectProbe`）：
  // 直推还活着时中继让开，中继接管后直推不再开 —— 任何一个会话任何时刻只有一个生产者。
  runner.setDesktopDirectProbe((sessionId) => desktopSse.subscriptions.has(sessionId));
  /** 桌面端 SSE 帧的独立序号空间（`id:` 行；不与会话总线的 streamSeq 混用）。 */
  let desktopSseSeq = 0;
  const maintenance = new Set();

  /** 实际监听端口（listen 后填充）；中继客户端用它拼本机回环基址。 */
  let boundPort = null;

  /**
   * 本机回环基址。
   *
   * **关键**：隧道里的请求必须打到这里（真实 HTTP），不能直接调内部 handler ——
   * 否则会绕过 Bearer 鉴权、限速、请求体上限与 SSE 台账（契约 §5.5.1 的安全前提）。
   */
  function localBaseUrl() {
    const port = boundPort ?? (server.address() && typeof server.address() === 'object' ? server.address().port : config.port);
    return port ? `http://127.0.0.1:${port}` : null;
  }

  /**
   * 附件对象库的**搜索根**（契约 §4.6）。
   *
   * 顺序即查找顺序，且**必须**按这个顺序：
   * 1. `config.dsh.sessionsHome` —— 网关自己的 home。手机发的图由这一档落的盘，
   *    命中率最高，放第一位能省掉对大 home（可能上百个会话目录）的一次 `readdir`；
   * 2. `config.mirror.resolvedHome` —— `~/.dsh`，电脑端真实会话与 `read_image` 的产物；
   * 3. `config.desktop?.dshHome` —— 桌面端通道显式配置的 home（缺省时不配，与第 2 项同值）。
   *
   * 去重与空值过滤在 `resolveAttachment` 里做：`mirror.resolvedHome` 与 `desktop.dshHome`
   * 在默认配置下是**同一个路径**，两处都判会让每次请求白读一遍目录。
   */
  function attachmentRoots() {
    return [config.dsh?.sessionsHome ?? null, config.mirror?.resolvedHome ?? null, config.desktop?.dshHome ?? null];
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      /* handle 内部已兜底，这里只防止未捕获拒绝 */
    });
  });
  server.requestTimeout = config.limits.requestTimeoutMs;
  server.headersTimeout = config.limits.headersTimeoutMs;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
  // Node 默认每 30s 才巡检一次「请求/头部是否超时」，若不缩短巡检间隔，
  // 配置的 requestTimeout（默认 30s）最坏会被拖到 60s 才生效 —— 这正是「防挂起」要避免的。
  // 取超时值的 1/2（上限 1s，下限 50ms），保证超时后能及时回收连接。
  server.connectionsCheckingInterval = Math.max(
    50,
    Math.min(1000, Math.floor(Math.min(config.limits.requestTimeoutMs, config.limits.headersTimeoutMs) / 2)),
  );

  if (!config.authRequired) log.warn('警告：配置 authRequired=false，所有接口将不再校验设备令牌（仅建议本机调试使用）');
  if (loaded > 0) log.info(`已加载 ${loaded} 个设备令牌`);
  log.info(
    `网关初始化完成：home=${config.home} 并发=${config.maxConcurrent} 队列上限=${config.maxQueue} 白名单=${
      config.workspaceAllowlist.join(' | ') || '(空，拒绝所有任务)'
    }`,
  );

  // lastSeenAt 落盘节流：成功认证只改内存，由该定时器周期性持久化。
  // 顺序很重要：先接受外部（CLI）对设备库的改动，再落盘，避免把 CLI 吊销的设备写回去。
  const flushTimer = setInterval(() => {
    devices.reloadIfChangedSync();
    void devices.flush();
  }, 30_000);
  flushTimer.unref?.();
  maintenance.add(flushTimer);

  /** 统一的请求处理入口：解析 → 鉴权 → 路由 → 错误体。 */
  async function handle(req, res) {
    const rawTarget = req.url ?? '/';
    const ip = normalizeIp(req.socket?.remoteAddress);
    const method = req.method ?? 'GET';
    /** @type {URL} */
    let url;

    try {
      // ---- 纵深防御 1：路径必须已规范化 ----
      // `new URL()` 会折叠 `..`/`.`/`%2e%2e`/反斜杠，也会把 `//host/path` 当成协议相对地址。
      // 攻击场景：客户端送 `/x/../api/v2/relay/status`，中继按**字面前缀**放行，
      // 网关折叠后却命中了管理路由 —— 白名单形同虚设（relay-dev 在 R2 审计里实测到 200）。
      // 这里要求"字面路径 == 规范化路径"，不一致直接 400，两层都防。
      const rawPath = rawTarget.split('?')[0];
      if (!rawPath.startsWith('/') || rawPath.startsWith('//')) {
        throw new HttpError('bad_request', `请求路径必须是绝对路径且不得是协议相对形式：${rawTarget}`);
      }
      url = new URL(rawTarget, 'http://localhost');
      if (url.pathname !== rawPath) {
        throw new HttpError('bad_request', `请求路径必须已规范化（字面 ${rawPath} ≠ 规范化 ${url.pathname}）`);
      }

      const route = routeOf(url.pathname);

      // ---- 纵深防御 2：管理端点拒绝携带隧道标记的请求 ----
      // 与来源 IP 无关：隧道请求的 remoteAddress 就是 127.0.0.1，IP 判定在隧道路径上不可靠。
      // 触发条件是"请求带了内部标记头"，不一定是真的经隧道（也可能是伪造），措辞按此写，
      // 免得排障时被误导。
      if (LOOPBACK_ONLY_ROUTES.has(route.name) && req.headers[TUNNEL_HEADER] !== undefined) {
        log.warn(`拒绝携带隧道标记的管理端点请求：${method} ${url.pathname}（${TUNNEL_HEADER}=${req.headers[TUNNEL_HEADER]}）`);
        throw new HttpError('forbidden', `该请求携带内部隧道标记，管理端点拒绝（客户端不应发送 ${TUNNEL_HEADER} 头）：${url.pathname}`);
      }

      if (route.name === 'unknown') throw new HttpError('not_found', `未知接口：${method} ${url.pathname}`);
      const allowed = ROUTE_METHODS[route.name] ?? [];
      if (!allowed.includes(method)) {
        throw new HttpError('bad_request', `方法不允许：${method} ${url.pathname}（允许 ${allowed.join('/')}）`, { status: 405 });
      }

      let device = null;
      if (!PUBLIC_ROUTES.has(route.name) && config.authRequired) {
        device = authenticate(req, ip);
      }

      switch (route.name) {
        case 'health':
          return sendJson(res, 200, healthPayload());
        case 'pairOpen':
          return await onPairOpen(res, ip);
        case 'pairClaim':
          return await onPairClaim(req, res, ip);
        case 'events':
          return onEvents(req, res, url);
        case 'workspaces':
          return sendJson(res, 200, await listWorkspaces({ allowlist: config.workspaceAllowlist, defaultWorkspace: config.defaultWorkspace }));
        case 'devices':
          return sendJson(res, 200, { devices: devices.list() });
        case 'deviceRevoke': {
          const ok = await devices.revoke(route.tokenId);
          if (!ok) throw new HttpError('not_found', `设备令牌不存在：${route.tokenId}`);
          log.info(`设备令牌已吊销 tokenId=${route.tokenId}`);
          res.writeHead(204).end();
          return undefined;
        }
        case 'tasks':
          return method === 'POST' ? await onCreateTask(req, res) : onListTasks(res, url);
        case 'taskDetail':
          return method === 'DELETE' ? await onDeleteTask(res, route.id) : onGetTask(res, route.id);
        case 'taskCancel':
          return await onCancelTask(res, route.id);
        // ---- v2（契约 §4）----
        case 'healthV2':
          return sendJson(res, 200, healthV2Payload());
        case 'pairOpenV2':
          return await onPairOpenV2(res, ip);
        case 'pairClaimV2':
          return await onPairClaimV2(req, res, ip);
        case 'relayConnect':
          return await onRelayConnect(res);
        case 'relayStatus':
          return sendJson(res, 200, relayStatusPayload());
        case 'relayDisconnect':
          return await onRelayDisconnect(res);
        case 'sessions':
          return await onListSessions(res, url);
        case 'tasksV2':
          return await onCreateTaskV2(req, res);
        case 'approvals':
          return onListApprovals(res, url);
        case 'approvalAnswer':
          return await onApprovalAnswer(req, res, route.eventId);
        case 'sessionsStream':
          return onSessionsStream(req, res, url);
        case 'sessionDetail':
          return await onSessionDetail(res, route.id, url);
        case 'sessionTranscript':
          return await onSessionTranscript(res, route.id, url);
        case 'sessionEvents':
          return await onSessionEvents(res, route.id, url);
        case 'sessionTurns':
          return await onCreateTurn(req, res, route.id);
        case 'sessionAbort':
          return await onAbortTurn(res, route.id);
        case 'sessionTurnIndex':
          return await onSessionTurnIndex(res, route.id, url);
        case 'attachment':
          return await onAttachment(req, res, route.id);
        case 'workspacesV2':
          return await onWorkspacesV2(res);
        case 'models':
          return await onModelsV2(res);
        case 'workspaceFiles':
          return await onWorkspaceFiles(res, url);
        case 'workspaceFile':
          return await onWorkspaceFile(res, url);
        case 'workspaceChanges':
          return await onWorkspaceChanges(res, url);
        case 'workspaceDiff':
          return await onWorkspaceDiff(res, url);
        case 'workspaceSearch':
          return await onWorkspaceSearch(res, url);
        default:
          throw new HttpError('not_found', `未知接口：${url.pathname}`);
      }
    } catch (err) {
      if (err instanceof ClientGoneError) return;
      // 工作区层抛的是 WorkspaceError（code 已经是契约 §4.4 的取值），
      // 必须在这里翻译成 HttpError —— 否则 403 workspace_outside 会退化成 500 internal
      // （e2e 的路径安全负向用例实测踩到）。
      const httpErr = err instanceof WorkspaceError ? new HttpError(err.code, err.message) : err;
      sendError(req, res, httpErr, log);
      return undefined;
    }
  }

  /** Bearer 令牌校验 + 认证失败限速（只对失败计数）。 */
  function authenticate(req, ip) {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const device = token ? devices.verify(token) : null;
    if (device) return device;
    const gate = authLimiter.hit(ip);
    if (!gate.allowed) {
      throw new HttpError('rate_limited', '认证失败次数过多，请稍后重试', { headers: { 'Retry-After': String(gate.retryAfterSec) } });
    }
    throw new HttpError('unauthorized', '设备令牌无效或已吊销');
  }

  /**
   * `GET /api/v1/health` 响应。
   *
   * **`apiVersion` 是 v1 端点的版本号，不是网关支持的最高版本** —— 已交付的 v1 客户端用它
   * 判断兼容性，把它改成 2 会让老客户端误判不兼容。v2 能力改用新增的
   * `supportedApiVersions: [1, 2]` 宣告（老客户端忽略未知字段，天然安全）。
   * 除该字段外，**字段集合与 v1 完全一致**（有回归用例锁住，见 test/pairing.test.mjs）。
   */
  function healthPayload() {
    const stats = tasks.stats();
    return {
      ok: true,
      apiVersion: config.apiVersion,
      supportedApiVersions: config.supportedApiVersions,
      serverName: config.serverName,
      gatewayVersion: config.gatewayVersion,
      dshVersion: config.dsh.version,
      uptimeMs: now() - startedAt,
      activeTasks: stats.activeTasks,
      queuedTasks: stats.queuedTasks,
      pairingOpen: pairing.isOpen,
      authRequired: config.authRequired,
      capabilities: ['tasks', 'events', 'pairing', 'workspaces', 'cancel'],
    };
  }

  /** 配对码只能在 PC 本机生成（契约 §2.1），避免局域网内被抢注。 */
  async function onPairOpen(res, ip) {
    requireLoopback(ip, 'pair/open');
    // v2 起：v1 的 pair/open 也要把配对窗口同步到中继。
    // 为什么：手机（含已交付的 v1 App）经隧道调用 `/api/v1/pair/claim` 时，
    // 中继需要 `code → homeId` 索引才能把请求转给本网关；只在 v2 的 pair/open 里建索引，
    // 会让 v1 路径经隧道时必然 `home_not_found`。
    const attempts = config.relay?.pairWindow?.attempts ?? 5;
    let code = null;
    let expiresAt = null;
    let relayOpened = false;
    for (let i = 1; i <= attempts; i++) {
      ({ code, expiresAt } = pairing.open());
      if (!relay.connected) break;
      const opened = await relay.openPairWindow({ code, expiresAt });
      if (opened.ok) {
        relayOpened = true;
        break;
      }
      if (!opened.conflict) {
        log.warn(`v1 配对窗口同步中继失败（仅本机可用）：${opened.error}`);
        break;
      }
      log.warn(`中继配对码撞号（code_conflict），第 ${i}/${attempts} 次重试`);
    }
    // 响应体与 v1 逐字一致（只记录过期时间，不记录配对码本身）
    log.info(`配对窗口已开启 expiresAt=${new Date(expiresAt).toISOString()} relay=${relayOpened ? '已同步' : relay.connected ? '同步失败' : '未连接'}`);
    return sendJson(res, 200, { code, expiresAt });
  }

  async function onPairClaim(req, res, ip) {
    const body = await readJsonBody(req);
    const token = await claimPairing(body, ip);
    // 明文令牌仅在本次响应中出现一次
    return sendJson(res, 200, { token: token.token, tokenId: token.tokenId, serverName: config.serverName, expiresAt: null });
  }

  /**
   * 配对码兑换的公共实现（v1 `/api/v1/pair/claim` 与 v2 `/api/v2/pair/claim` 共用）。
   *
   * 为什么抽出来：v2 的差别只在响应体多一个 `relay` 块，鉴权/限速/deviceId 校验/
   * 同设备重配对吊销旧令牌这些**语义必须逐字一致** —— 复制一份迟早会漂移。
   * @returns {Promise<{token: string, tokenId: string}>}
   */
  async function claimPairing(body, ip) {
    const gate = claimLimiter.hit(ip);
    if (!gate.allowed) {
      throw new HttpError('rate_limited', '配对请求过于频繁，请稍后重试', { headers: { 'Retry-After': String(gate.retryAfterSec) } });
    }
    const code = normalizePairCode(body?.code);
    if (!code) throw new HttpError('bad_request', '缺少或非法的 code（必须是 6 位数字）');
    // 契约 v1.1 A2-3：deviceId 必须是小写 UUID —— 它是"同设备重配对即吊销旧令牌"的唯一依据，
    // 格式不受控会让该保证失效（大小写不一致会被当成两台设备）。
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
    if (!DEVICE_ID_RE.test(deviceId)) {
      throw new HttpError('bad_request', 'deviceId 必须是客户端生成的小写 UUID，例如 8f3c1a2b-1111-4222-8333-444455556666');
    }

    const result = pairing.claim(code);
    if (!result.ok) {
      const message = result.reason === 'pairing_closed' ? '配对未开启或配对码已被使用' : '配对码错误或已过期';
      throw new HttpError(result.reason, message);
    }

    const { token, tokenId } = await devices.issue({
      deviceName: typeof body?.deviceName === 'string' ? body.deviceName : '未命名设备',
      deviceId,
    });
    log.info(`配对成功 deviceName=${body?.deviceName ?? '未命名设备'} tokenId=${tokenId} ip=${ip}`);
    return { token, tokenId };
  }

  async function onCreateTask(req, res) {
    const body = await readJsonBody(req);
    const workspace = await resolveWorkspace(body?.workspace, {
      allowlist: config.workspaceAllowlist,
      defaultWorkspace: config.defaultWorkspace,
    });
    if (!workspace.ok) throw new HttpError('bad_request', workspace.message);
    // 权限档：缺字段=仅当前工作区；未知取值直接 400（不猜测、不放开）
    const access = resolveAccess(body?.access);
    if (!access.ok) throw new HttpError(access.code, access.message);

    let task;
    try {
      task = await tasks.submit({
        prompt: body?.prompt,
        workspace: workspace.path,
        title: typeof body?.title === 'string' ? body.title : null,
        model: typeof body?.model === 'string' ? body.model : null,
        reasoningEffort: typeof body?.reasoningEffort === 'string' ? body.reasoningEffort : null,
        timeoutSec: body?.timeoutSec === undefined ? null : body.timeoutSec,
        access: access.access,
      });
    } catch (err) {
      if (err instanceof TaskError) throw new HttpError(err.code, err.message);
      throw err;
    }
    log.info(
      `task accepted id=${task.id} workspace=${task.workspace} access=${task.access}(${describeAccess(task.access)}) timeoutSec=${body?.timeoutSec ?? config.defaultTimeoutSec}`,
    );
    return sendJson(res, 201, task);
  }

  function onListTasks(res, url) {
    const status = url.searchParams.get('status') ?? 'all';
    if (status !== 'all' && status !== 'active') throw new HttpError('bad_request', "status 只能是 all 或 active");
    const limitRaw = url.searchParams.get('limit');
    let limit = 50;
    if (limitRaw !== null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError('bad_request', 'limit 必须是 1~200 的整数');
    }
    const cursor = url.searchParams.get('cursor');
    return sendJson(res, 200, tasks.list({ status, limit, cursor }));
  }

  function onGetTask(res, id) {
    const task = tasks.get(id);
    if (!task) throw new HttpError('not_found', `任务不存在：${id}`);
    return sendJson(res, 200, task);
  }

  async function onCancelTask(res, id) {
    const task = await tasks.cancel(id);
    if (!task) throw new HttpError('not_found', `任务不存在：${id}`);
    log.info(`cancel requested id=${id} status=${task.status}`);
    return sendJson(res, 200, task);
  }

  async function onDeleteTask(res, id) {
    let ok = false;
    try {
      ok = await tasks.remove(id);
    } catch (err) {
      if (err instanceof TaskError) throw new HttpError(err.code, err.message);
      throw err;
    }
    if (!ok) throw new HttpError('not_found', `任务不存在：${id}`);
    log.info(`task deleted id=${id}`);
    res.writeHead(204).end();
    return undefined;
  }

  /**
   * 回环来源校验（v2 管理端点，契约 §4.1 / §5.5.5）。
   *
   * **注意语义差别**：v1 的 `pair/open` 也用回环校验，但 v2 的 `relay/*` 是「PC 只出站」拓扑下
   * 唯一的管理入口，一旦被局域网访问就等于把隧道能力交出去，所以这里连 `GET status` 也拦。
   */
  function requireLoopback(ip, what) {
    if (isLoopbackAddress(ip)) return;
    log.warn(`拒绝来自非回环地址的 ${what}：${ip}`);
    throw new HttpError('forbidden', `${what} 只能在 PC 本机（127.0.0.1）调用`);
  }

  /** `/api/v2/health`：v1 字段超集 + v2 能力宣告（v1 的 health 字段集合**保持不变**）。 */
  function healthV2Payload() {
    const stats = tasks.stats();
    return {
      ok: true,
      // apiVersion 保持 1：它是 **v1 端点**的版本号，已交付客户端据此判断兼容性
      apiVersion: config.apiVersion,
      supportedApiVersions: config.supportedApiVersions,
      gatewayVersion: config.gatewayVersion,
      serverName: config.serverName,
      dshVersion: config.dsh.version,
      uptimeMs: now() - startedAt,
      activeTasks: stats.activeTasks,
      queuedTasks: stats.queuedTasks,
      pairingOpen: pairing.isOpen,
      authRequired: config.authRequired,
      capabilities: [...V2_CAPABILITIES],
      sessionMirror: {
        enabled: config.mirror.enabled,
        onlyAllowlistedWorkspaces: config.mirror.onlyAllowlistedWorkspaces,
        liveWindowMs: config.mirror.liveWindowMs,
        roots: (config.sessionRoots ?? []).map((r) => ({ source: r.source, home: r.home, writable: r.writable, label: r.label })),
      },
      sessionRunner: runner.stats(),
      relay: relayStatusPayload(),
      // 审批桥状态：`connected:false` 时手机端要显示"暂时收不到审批"而不是静默无反应
      approvals: approvals.state(),
      sessionsCached: mirror.size,
    };
  }

  /**
   * `GET /api/v2/relay/status`（契约 §4.1）：**扁平**返回状态本身。
   *
   * 三个 relay 端点的形状口径（lead 裁定统一为扁平，别一个包一层一个不包）：
   * - `GET  /relay/status`     → `{ ...status }`
   * - `POST /relay/connect`    → `{ ok, ...status, error? }`（`ok` 表示"本次操作成功与否"，与状态不同义）
   * - `POST /relay/disconnect` → `{ ok, ...status }`
   * - `GET  /api/v2/health`    → `.relay` 同样是扁平状态
   * 为什么统一：`relay/status` 的语义就是"返回状态本身"，包一层 `{status:{...}}` 会让
   * "两个端点都读"的调用方必须写两套取值逻辑；实测已经坑过一次（按 `.status.connected` 取到 `undefined`）。
   */
  function relayStatusPayload() {
    return relay.status();
  }

  /** 把"操作结果"与"状态"合成统一的扁平响应：`{ ok, ...status }`。 */
  function flatRelayResult({ ok, status, extra = {} }) {
    return { ok, ...status, ...extra };
  }

  /** `POST /api/v2/relay/connect`（契约 §4.1）：注册（若无凭据）并建立隧道。 */
  async function onRelayConnect(res) {
    if (!config.relay?.url) throw new HttpError('bad_request', '未配置 relay.url（请在 config.json 里填写中继地址，例如 ws://127.0.0.1:9443）');
    const result = await relay.connect();
    const body = flatRelayResult({
      ok: result.ok,
      status: result.status,
      extra: { homeId: result.homeId, relayName: result.relayName },
    });
    if (result.error) body.error = { code: 'home_not_found', message: result.error };
    return sendJson(res, result.ok ? 200 : 502, body);
  }

  /** `POST /api/v2/relay/disconnect`（契约 §4.1）：主动断开，配置保留。 */
  async function onRelayDisconnect(res) {
    const result = relay.disconnect({ keepEnabled: true });
    return sendJson(res, 200, flatRelayResult({ ok: true, status: result.status }));
  }

  /**
   * `POST /api/v2/pair/open`（契约 §4.1）：本机生成配对码，并**同时**在中继上打开配对窗口。
   * 撞码（409 code_conflict）时重新生成，最多 `relay.pairWindow.attempts` 次。
   */
  async function onPairOpenV2(res, ip) {
    requireLoopback(ip, 'pair/open');
    const attempts = config.relay?.pairWindow?.attempts ?? 5;
    let last = null;
    for (let i = 1; i <= attempts; i++) {
      const { code, expiresAt } = pairing.open();
      if (!relay.connected) {
        log.info(`v2 配对窗口已开启（仅本机，中继未连接）expiresAt=${new Date(expiresAt).toISOString()}`);
        return sendJson(res, 200, { code, expiresAt, relay: null });
      }
      const opened = await relay.openPairWindow({ code, expiresAt });
      if (opened.ok) {
        log.info(`v2 配对窗口已开启（含中继）attempt=${i} expiresAt=${new Date(expiresAt).toISOString()}`);
        return sendJson(res, 200, { code, expiresAt, relay: relayInfoForDevice() });
      }
      last = opened;
      if (!opened.conflict) break;
      log.warn(`中继配对码撞号（code_conflict），第 ${i}/${attempts} 次重试`);
    }
    pairing.close();
    throw new HttpError('internal', `在中继上打开配对窗口失败：${last?.error ?? '未知原因'}`);
  }

  /** 中继给手机的信息（homeId + 设备隧道 URL）。 */
  function relayInfoForDevice() {
    if (!relay.connected) return null;
    let tunnelUrl = null;
    try {
      tunnelUrl = normalizeRelayUrl(config.relay.url, '/api/v2/tunnel/device').wsUrl;
    } catch {
      tunnelUrl = null;
    }
    return { homeId: relay.homeId, relayName: relay.relayName, tunnelUrl };
  }

  /**
   * `POST /api/v2/pair/claim`（契约 §2.3 / §4.2）。
   *
   * `relay.deviceToken` 与 v1 的 `token` **是同一个值**：契约 §1 说 deviceToken 由网关生成、
   * 网关与中继都只存 sha256 —— 只有一个令牌才能同时满足「§3 隧道用 Bearer deviceToken 准入」
   * 与「§4 API 用 Bearer deviceToken 鉴权」，且中继不需要新增控制端点就能拿到哈希
   * （它从本响应体里取）。返回值里明文只出现这一次，落库的仍只有 sha256。
   */
  async function onPairClaimV2(req, res, ip) {
    const body = await readJsonBody(req);
    const token = await claimPairing(body, ip);
    const relayInfo = relayInfoForDevice();
    return sendJson(res, 200, {
      token: token.token,
      tokenId: token.tokenId,
      serverName: config.serverName,
      expiresAt: null,
      relay: relayInfo
        ? { homeId: relayInfo.homeId, deviceToken: token.token, tunnelUrl: relayInfo.tunnelUrl }
        : { homeId: null, deviceToken: token.token, tunnelUrl: null },
    });
  }

  /**
   * 工作区上下文：v2 的 `?workspace=` 必须命中白名单，否则用默认工作区。
   *
   * 为什么还要从 `path` 反推工作区（2026-10-15 修「越界」误拒）：
   * 手机端 2.6.0 及更早版本的工作区请求**只发绝对 `path`、从不发 `workspace`**
   * （`DshApiV2.entries/file/changes/diff/search`），于是这里回落到 `defaultWorkspace`，
   * 紧接着 `resolveTarget` 拿「默认工作区的根」去装「另一个白名单工作区里的绝对路径」，
   * 词法包含必然失败 → 403 workspace_outside，实测文案
   * `路径越界（不在工作区内）：D:\Workspace\插件`（用户在手机上选 D:\Workspace\插件 时 100% 复现）。
   *
   * 白名单里的每个工作区本来就是用户显式授权的，所以「`path` 落在哪个白名单工作区里，
   * 就用哪个工作区当上下文」**不扩大任何权限**，只是把被默认值吃掉的一维信息补回来；
   * 反推结果仍要过 [resolveWorkspace] 的完整校验（存在、是目录、命中白名单），
   * 越界仍由 `resolveTarget` 的四道检查拒绝。
   */
  async function workspaceContext(url) {
    const requested = url.searchParams.get('workspace');
    let effective = requested;
    if (!requested || !requested.trim()) {
      const inferred = await inferWorkspaceFromPath(url.searchParams.get('path') ?? url.searchParams.get('file'));
      if (inferred) effective = inferred;
    }
    const resolved = await resolveWorkspace(effective, { allowlist: config.workspaceAllowlist, defaultWorkspace: config.defaultWorkspace });
    if (!resolved.ok) {
      // 契约 §4.3：路径越界一律 403 workspace_outside；其余（缺省/不存在）按 400 报
      const code = effective ? 'workspace_outside' : 'bad_request';
      throw new HttpError(code, resolved.message);
    }
    return resolved.path;
  }

  /**
   * 从请求里的绝对 `path`（或 `file`）反推它所在的白名单工作区，取**最长匹配**
   * （白名单里可能同时配了 `D:\ws` 与 `D:\ws\sub`，必须选更深的那个）。
   *
   * 只接受「真实存在、且 realpath 后落在某个白名单工作区内」的路径：
   * 相对路径、不存在的路径、以及任何工作区之外的路径一律返回 null（回落默认工作区，
   * 保持改动前的行为）。因此这个函数不可能为越界路径"开绿灯"。
   */
  async function inferWorkspaceFromPath(raw) {
    if (typeof raw !== 'string') return null;
    const target = raw.trim();
    if (!target || !path.isAbsolute(target)) return null;
    const real = await realpathNearestAncestor(path.resolve(target));
    if (!real) return null;
    let best = null;
    for (const entry of config.workspaceAllowlist ?? []) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      const entryReal = (await realpathOrNull(path.resolve(entry.trim()))) ?? path.resolve(entry.trim());
      if (isWithin(real, entryReal) && (best === null || entryReal.length > best.length)) best = entryReal;
    }
    return best;
  }

  /** realpath（不存在/不可访问返回 null）。 */
  async function realpathOrNull(p) {
    try {
      return await fsp.realpath(p);
    } catch {
      return null;
    }
  }

  /**
   * 向上取最近一个真实存在的祖先的 realpath（不存在返回 null）。
   *
   * 为什么要"最近祖先"而不是直接 realpath：请求的叶子可能还不存在（刚被删掉的文件、
   * 尚未创建的目录），但**它挂在哪个工作区下**仍然可以从祖先判断出来。
   * 这不放松任何检查：反推出来的工作区仍要走 [resolveWorkspace] 的完整校验，
   * 目标路径的包含关系仍由 `resolveTarget` 的四道检查裁决。
   */
  async function realpathNearestAncestor(target) {
    let cur = path.resolve(target);
    for (;;) {
      const real = await realpathOrNull(cur);
      if (real) return real;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }

  /**
   * 读取"可选、但一旦出现就必须合法"的模型字段（契约 §7.8 的 `provider` / `reasoningEffort`）。
   *
   * 为什么不能像 `model` 那样"非字符串就当没传"：这两个字段是**纯粹的模型选择意图**，
   * 电话端发来 `{"provider":123}` 或 `{"provider":"  "}` 就是请求畸形。静默降级成"没选模型"
   * 会让界面显示着 A provider、实际跑的是网关默认 —— 正是本任务要消灭的"模型选择被悄悄丢掉"。
   * 所以这里一律 400；`model` 保持历史口径（非字符串 = 没传），不在此列。
   */
  function optionalModelField(body, field) {
    const raw = body?.[field];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string' || !raw.trim()) throw new HttpError('bad_request', `${field} 必须是非空字符串`);
    return raw.trim();
  }

  /**
   * `POST /api/v2/tasks`（lead 裁定新增）：**手机新建任务的唯一入口**。
   *
   * 为什么不复用 `POST /api/v2/sessions/{id}/turns`：新会话的 id 必须由**会话权威**生成，
   * 手机拿不到"还没创建的会话 id"。
   *
   * 两条通道（契约 §7.6）由 `host` 选择：
   *
   * - `desktop`（**缺省**）：在电脑端 DSH 里建会话 —— `workspace/create {path}`（幂等）→
   *   `session/create {workspaceId}`。**必须走 workspaceId 而不是 cwd**：实测 `session/create {cwd}`
   *   建的会话不会被登记进任何工作区，事后 `workspace/insertSessionBefore` 也会被拒
   *   （`the session is not accounted`），电脑端的会话列表里根本看不到它，也就谈不上接手。
   * - `gateway`：网关自有 DSH_HOME + SDK profile 起会话，可指定每任务权限档 `access`；
   *   代价是电脑端 DSH 看不到它（这正是"仅在手机上执行"的语义）。
   *
   * 响应里 `source` 与 `/api/v2/sessions` 同一套取值；`createdBy`/`driver`/`host` 见 §7.6。
   */
  async function onCreateTaskV2(req, res) {
    const body = await readJsonBody(req);
    const prompt = body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError('bad_request', '缺少 prompt');

    // host：这个任务的会话长在谁家里。缺字段 = 电脑端可达就落电脑端 ——
    // 这是"电脑接手手机后续任务"的前提，也是本端点现在的默认语义。
    const hostRaw = body?.host ?? null;
    if (hostRaw !== null && hostRaw !== 'desktop' && hostRaw !== 'gateway') {
      throw new HttpError('bad_request', "host 只能是 desktop 或 gateway");
    }
    const host = hostRaw ?? (desktop !== null ? 'desktop' : 'gateway');

    let workspace = null;
    if (body?.workspace) workspace = await workspaceContext(new URL(`/?workspace=${encodeURIComponent(body.workspace)}`, 'http://localhost'));
    const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : null;
    const clientTurnId = typeof body?.clientTurnId === 'string' ? body.clientTurnId : null;

    // 每任务模型（契约 §7.8）：三个字段都是**可选**的。
    //
    // 但"可选"不等于"可以畸形"：`provider`/`reasoningEffort` 只要出现就必须是非空字符串，
    // 否则 400（见 `optionalModelField`）。`model` 保持历史口径：非字符串 = 没传。
    //
    // 为什么不在这里把它们与 `dsh.provider/model/reasoningEffort` 合并：
    // 那个合并是 **runner 的职责**，而且只有网关路径（SdkRuntime）才需要兜底默认值；
    // 桌面端路径的默认值由**桌面端自己**决定（用户可能在电脑上选了别的模型，网关不该覆盖它）。
    // 这里再把配置默认值填进来的话，"手机没选模型"与"手机选了网关默认模型"就分不清了。
    const provider = optionalModelField(body, 'provider');
    const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : null;
    const reasoningEffort = optionalModelField(body, 'reasoningEffort');
    const wantedModel = model !== null;

    if (host === 'desktop') {
      if (desktop === null) {
        throw new HttpError('desktop_unavailable', '网关未接入桌面端 DSH runtime，无法在电脑端建会话；请改传 host:"gateway"，或先启动电脑端 DSH', { status: 503 });
      }
      // 电脑端按**工作区**登记会话，没有工作区就没法让它出现在电脑端的会话列表里。
      if (!workspace) throw new HttpError('bad_request', '在电脑端新建任务必须指定 workspace（电脑端是按工作区登记会话的）');

      let sessionId = null;
      try {
        const ws = await desktop.createWorkspace(workspace);
        const workspaceId = ws?.workspace?.workspaceId ?? null;
        if (!workspaceId) throw new Error('桌面端未返回 workspaceId');
        if (ws.created) log.info(`已在电脑端登记工作区 path=${workspace} workspaceId=${workspaceId}`);
        const created = await desktop.createSession({ workspaceId });
        sessionId = created?.sessionId ?? null;
        if (!sessionId) throw new Error('桌面端未返回 sessionId');
      } catch (err) {
        throw new HttpError(err?.code ?? 'desktop_error', `在电脑端创建会话失败：${err?.message ?? err}`, { status: err?.status ?? 502 });
      }

      // 先登记再投递：会话此刻已经真实存在于电脑端了，哪怕首轮投递失败，
      // 用户也应该能在手机端"我的任务"里看到它并重试，而不是变成一个谁都不知道的孤儿。
      await phoneSessions.add(sessionId, { host: 'desktop', workspace, title });

      // 模型必须在**首轮投递之前**切好：桌面端的会话模型是"下一次组合 agent 时生效"，
      // 而首轮投递就会触发组合 —— 顺序反了这个任务会用它并不想用的模型跑完一整轮。
      //
      // 失败**不**让任务失败，理由与上面「先登记再投递」完全一致：会话已经真实存在，
      // 手机端必须能看见它、能在里面继续说话、之后还能再切一次模型；
      // 为了一个"选模型没生效"把整个任务判死，用户失去的比得到的多。
      // 于是把失败降级成响应字段 `modelApplied:false` + `modelWarning`，由手机端如实提示。
      const modelFields = {};
      if (wantedModel) {
        try {
          // 手机可能只传了 model（契约 §7.8 允许），而 `session/selectModel` 的 provider 是必填的。
          const resolved = await resolveRequestedProvider({ provider, model });
          if (resolved.provider) {
            await desktop.selectModel({ sessionId, provider: resolved.provider, model, reasoningEffort });
            modelFields.modelApplied = true;
            log.info(`已为电脑端新会话选择模型 sessionId=${sessionId} provider=${resolved.provider} model=${model} reasoningEffort=${reasoningEffort ?? '-'}`);
          } else {
            // 推断不出 provider（模型不在目录里，或多 provider 且目录没有默认项；契约 §7.8 铁律 4）：
            // 不猜、也不拿默认 provider 顶替 —— 如实降级成 `modelWarning`，任务照常投递。
            modelFields.modelApplied = false;
            modelFields.modelWarning = resolved.reason;
            log.warn(`未为电脑端新会话切换模型（任务照常投递）sessionId=${sessionId} model=${model}：${resolved.reason}`);
          }
        } catch (err) {
          modelFields.modelApplied = false;
          modelFields.modelWarning = String(err?.message ?? err);
          log.warn(`电脑端会话模型切换失败（任务照常投递）sessionId=${sessionId} provider=${provider ?? '-'} model=${model}：${modelFields.modelWarning}`);
        }
      }

      const result = await runner.submit({ sessionId, prompt, workspace, host: 'desktop', clientTurnId, provider, model, reasoningEffort });
      if (!result.ok) {
        throw new HttpError(
          result.code,
          `会话已在电脑端建立（sessionId=${sessionId}），但首轮投递失败：${result.message}`,
          { status: result.status },
        );
      }
      log.info(`手机新任务已接受（电脑端）sessionId=${sessionId} turnId=${result.body.turnId} workspace=${workspace} host=desktop`);
      return sendJson(res, 202, {
        accepted: true,
        sessionId,
        source: 'computer',
        createdBy: 'phone',
        driver: DRIVER_DESKTOP,
        host: 'desktop',
        turnId: result.body.turnId,
        fromSeq: result.body.fromSeq,
        workspace,
        ...modelFields,
      });
    }

    if (!runner.sdkAvailable) throw new HttpError('unavailable', '网关未找到可用的 dsh 启动器，无法在手机上创建任务（需配置 dsh.launcher）');
    // 权限档：决定这个会话后面所有轮次的沙箱档（续聊不再重复传，见 session-runner 的 sessionAccess）
    const access = resolveAccess(body?.access);
    if (!access.ok) throw new HttpError(access.code, access.message);
    const sessionId = runner.newSessionId();
    const result = await runner.submit({
      sessionId,
      prompt,
      workspace,
      clientTurnId,
      access: access.access,
      // 网关路径的模型走 SDK `initialize` 握手（见 session-runner 的 #ensureRuntime）：
      // 这里只是把"手机上选了什么"透传下去，缺省（null）由 runner 回落 `dsh.provider/model`。
      provider,
      model,
      reasoningEffort,
    });
    if (!result.ok) throw new HttpError(result.code, result.message, { status: result.status });
    await phoneSessions.add(sessionId, { host: 'gateway', workspace, access: access.access, title });
    log.info(
      `手机新任务已接受（网关自持）sessionId=${sessionId} turnId=${result.body.turnId} access=${access.access}(${describeAccess(access.access)})`
        + (wantedModel ? ` model=${provider ?? '-'}/${model}` : ''),
    );
    return sendJson(res, 202, {
      accepted: true,
      sessionId,
      source: 'phone',
      createdBy: 'phone',
      driver: DRIVER_GATEWAY,
      host: 'gateway',
      turnId: result.body.turnId,
      fromSeq: result.body.fromSeq,
      access: access.access,
      // 网关路径的"模型已生效"就是"initialize 已带上去"，不需要再问谁（SDK 没有反悔的余地）。
      ...(wantedModel ? { modelApplied: true } : {}),
    });
  }

  /** `GET /api/v2/sessions`（契约 §4.2）。 */
  async function onListSessions(res, url) {
    // `?include=subagent|all` 是显式全量开关；缺省时取 `mirror.includeSubagentsByDefault`
    // （契约 §4.2 的手机默认值，config.mjs 里是 false）。这个开关只决定"要不要全量"，
    // 真正的"哪些算子代理"判定在 `discoverSessions` / `SessionMirror.list` 里（同一条判据）。
    const includeRaw = url.searchParams.get('include') ?? '';
    const includeSubagent = includeRaw === 'subagent' || includeRaw === 'all'
      || (includeRaw === '' && config.mirror.includeSubagentsByDefault === true);
    if (!config.mirror.enabled && !config.sessionRoots?.some((r) => r.writable)) throw new HttpError('unavailable', '会话镜像未启用');
    const limitRaw = url.searchParams.get('limit');
    let limit = config.mirror.listLimit;
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1 || n > config.mirror.listLimitMax) throw new HttpError('bad_request', `limit 必须是 1~${config.mirror.listLimitMax} 的整数`);
      limit = n;
    }
    const workspace = url.searchParams.get('workspace');
    const source = url.searchParams.get('source');
    if (source !== null && source !== 'computer' && source !== 'phone') throw new HttpError('bad_request', "source 只能是 computer 或 phone");
    const result = await mirror.list({
      workspace: workspace ? path.resolve(workspace) : null,
      limit,
      cursor: url.searchParams.get('cursor'),
      includeSubagent,
      source,
    });
    // 手机会话只有"有活着的运行时"才可续聊（SDK 协议限制，见 session-runner 注释）
    for (const s of result.sessions) {
      if (s.source === 'phone') {
        s.writable = runner.isResumable(s.id);
        s.writableReason = s.writable ? null : 'runtime_gone';
      } else if (s.source === 'computer') {
        // 电脑端会话：**可续聊**（契约 §7.4）—— 桌面端 runtime 是会话权威，随时能 resume。
        // 这是本项目"手机接手电脑后续任务"的对外表现：同一个会话在两端都能继续。
        // 但**派生会话（子代理 / 带 parentSession 的副本）不可写**：它们由父会话驱动，
        // 手机直接往里发消息会插进别人的子代理循环；判据与列表默认过滤同源
        // （`isDerivedSession`，桌面端也是 `origin === "subagent"` 一律隐藏）。
        s.writable = desktop !== null && !isDerivedSession(s);
        s.writableReason = s.writable ? null : desktop === null ? 'desktop_disabled' : 'subagent';
      }
      // `driver` 恒显式下发（契约 §7.5）：谁在驱动这个会话。客户端不得靠 `source` 反推，
      // 否则分不清"服务端漏字段"与"老网关"，也就无法在字段缺失时给出正确的降级提示。
      s.driver = s.source === 'computer' ? DRIVER_DESKTOP : DRIVER_GATEWAY;
      // `createdBy`（契约 §7.6）：谁**发起**的。手机新建的任务现在默认落在电脑端
      // （`source:'computer'`），手机端的"我的任务"列表只能靠这个字段认出它们；
      // 反过来电脑端 DSH 里自己建的会话是 `desktop`。三字段各说各的事，不得互相反推。
      s.createdBy = phoneSessions.has(s.id) ? 'phone' : 'desktop';
    }
    // 用桌面端的**真实运行态**覆盖文件 mtime 推断出的 live（若桌面端可达）。
    // Windows 上没有 flock，`session/list` 的 `running` 是唯一可靠的真值来源。
    if (desktop !== null) {
      try {
        const items = await desktop.listSessions();
        const byId = new Map(items.map((item) => [item.sessionId, item]));
        for (const s of result.sessions) {
          const entry = byId.get(s.id);
          if (!entry) continue;
          s.live = entry.running === true;
          s.liveReason = entry.running ? 'desktop_running' : null;
          if (entry.projections?.values?.title && !s.title) s.title = entry.projections.values.title;
          const stats = entry.projections?.values?.sessionStats;
          if (stats) s.turns = stats.turns ?? s.turns ?? null;
        }
      } catch (err) {
        // 桌面端不可达不是错误：镜像仍然可用，只是 live 退回 mtime 判据。
        log.warn(`读取桌面端会话运行态失败（live 退回文件 mtime 判据）：${err.message}`);
      }
    }
    return sendJson(res, 200, result);
  }

  /** `GET /api/v2/sessions/{id}`（契约 §4.2）。 */
  async function onSessionDetail(res, id, url) {
    const meta = await mirror.get(id, { workspace: url.searchParams.get('workspace') });
    if (!meta) throw new HttpError('session_not_found', `会话不存在：${id}`);
    if (meta.source === 'phone') {
      meta.writable = runner.isResumable(id);
      meta.writableReason = meta.writable ? null : 'runtime_gone';
    } else if (meta.source === 'computer') {
      // 派生会话（子代理 / 带 parentSession 的副本）的转录是父会话的派生物，桌面端 runtime
      // 也不把它当独立会话驱动 —— 与列表端点同口径（两边都用 `isDerivedSession`）。
      meta.writable = desktop !== null && !isDerivedSession(meta);
      meta.writableReason = meta.writable ? null : desktop === null ? 'desktop_disabled' : 'subagent';
      if (desktop !== null) {
        try {
          const proj = await desktop.projections(id);
          if (proj?.values) {
            meta.projections = proj.values;
            meta.asOfSeq = proj.asOfSeq ?? null;
            if (proj.values.title && !meta.title) meta.title = proj.values.title;
          }
        } catch (err) {
          log.warn(`读取桌面端会话投影失败 sessionId=${id}：${err.message}`);
        }
        // live 必须以桌面端运行态为真值：镜像的 mtime 判据在"刚跑完一轮"的 liveWindowMs（默认 60s）
        // 内会误报 live=true，手机端会因此一直显示"电脑端正在驱动"。与 onListSessions 用同一个真值源，
        // 否则同一个会话在列表与详情里会给出互相矛盾的 live。
        try {
          const entry = (await desktop.listSessions()).find((item) => item.sessionId === id);
          if (entry) {
            meta.live = entry.running === true;
            meta.liveReason = entry.running ? 'desktop_running' : null;
            const stats = entry.projections?.values?.sessionStats;
            if (stats) meta.turns = stats.turns ?? meta.turns ?? null;
          }
        } catch (err) {
          log.warn(`读取桌面端会话运行态失败 sessionId=${id}（live 退回文件 mtime 判据）：${err.message}`);
        }
      }
    }
    meta.driver = meta.source === 'computer' ? DRIVER_DESKTOP : DRIVER_GATEWAY;
    meta.createdBy = phoneSessions.has(id) ? 'phone' : 'desktop';
    meta.resumable = meta.writable;
    meta.liveReason = meta.live ? meta.liveReason : null;
    return sendJson(res, 200, meta);
  }

  /** `GET /api/v2/sessions/{id}/transcript`（契约 §4.2）。 */
  async function onSessionTranscript(res, id, url) {
    const tail = intParam(url, 'tail', { min: 1, max: TRANSCRIPT_MAX });
    const limit = intParam(url, 'limit', { min: 1, max: TRANSCRIPT_MAX });
    const includeInternal = ['internal', 'all'].includes(url.searchParams.get('include') ?? '');
    const result = await mirror.transcript(id, {
      tail: tail ?? null,
      limit: limit ?? null,
      cursor: url.searchParams.get('cursor'),
      includeInternal,
      workspace: url.searchParams.get('workspace'),
    });
    if (!result) throw new HttpError('session_not_found', `会话不存在：${id}`);
    return sendJson(res, 200, result);
  }

  /**
   * `GET /api/v2/sessions/{id}/turn-index`（契约 §4.2.3，v2.9.0）。
   *
   * 手机端本地只加载最近一页消息，要做到「点第 12 轮跳到那一轮」就必须先知道
   * **每一轮在消息数组里的位置**；本端点只回那点索引信息（每轮一条，文案服务端截断），
   * 客户端拿到 `toIndex` 后直接用既有的 `GET /transcript?cursor=<toIndex>&limit=60`
   * 就能取到"以该轮结尾"的一页 —— 不需要新增加载路径，也不需要客户端自己解析事件。
   */
  async function onSessionTurnIndex(res, id, url) {
    const result = await mirror.turnIndex(id, {
      workspace: url.searchParams.get('workspace'),
      includeInternal: ['internal', 'all'].includes(url.searchParams.get('include') ?? ''),
    });
    if (!result) throw new HttpError('session_not_found', `会话不存在：${id}`);
    return sendJson(res, 200, result);
  }

  /**
   * `GET /api/v2/attachments/{id}`（契约 §4.6，v2.9.0）：把会话里的图片引用还原成字节。
   *
   * ## 为什么必须由网关做
   * 附件对象库在**电脑上**（`~/.dsh/attachments/…`），手机拿不到文件系统；
   * 会话日志里只有内容哈希引用。这一层就是"哈希 → 字节"的唯一转换点。
   *
   * ## 安全（安全红线，改动前先读 §5.5）
   * - id 是**内容哈希**，只有读到过会话记录的人（= 已配对设备）才知道它。
   *   网关**不做**按会话的二次授权：已配对设备本来就能读所有会话与工作区（§4.2/§4.3），
   *   再叠一层"这个附件属不属于这条会话"只会给出一种虚假的安全感（引用会被转发/复制）。
   * - 但**能读什么**必须被卡死：id 直接参与拼路径，`normalizeAttachmentId` 只放行
   *   `sha256:` + 64 位小写 hex，`..`/分隔符/盘符/UNC 全部进不来；
   *   `resolveAttachment` 内部两级目录都用 `readdir` 结果比对，绝不把用户输入拼成路径段。
   * - 本路由**不在** `PUBLIC_ROUTES`：与 sessions/workspaces 同档，必须带 Bearer。
   *
   * ## 失败码（契约 §4.6 失败表）
   * - `400 bad_request`：id 形状非法（含"像但不对"的，例如 63 位 hex、大写、带 `..`）；
   * - `404 not_found`：形状合法但所有搜索根里都没有这个对象（也包含"不是普通文件"）；
   * - `413 attachment_too_large`：对象存在但超过 `ATTACHMENT_MAX_BYTES`。
   *
   * 为什么 413 不并进 404：手机端对这两者的处理**必须**不同 —— 404 是"这条引用坏了"
   * （长期缓存可以记住，渲染成占位符即可），413 是"图太大，网关不愿意服务"
   * （应提示用户去电脑上看，且**不该**被当成缓存命中的负结果）。
   */
  async function onAttachment(req, res, rawId) {
    if (typeof rawId !== 'string' || !ATTACHMENT_ID_RE.test(normalizeAttachmentId(rawId) ?? '')) {
      throw new HttpError(
        'bad_request',
        `附件 id 必须是内容哈希 sha256:<64 位小写十六进制>（可省略 sha256: 前缀，大小写不敏感）；收到：${String(rawId).slice(0, 120)}`,
      );
    }
    const id = normalizeAttachmentId(rawId);
    // `fsImpl` 有意传 **`node:fs` 而不是 `node:fs/promises`**：`attachments.mjs` 约定的是
    // "有 `.promises` 的 fs 模块"（与 `session-reader.mjs` 的 `fsImpl` 同一约定，
    // 测试也因此能注入一行桩）。传错的表现是**全部 404**，排查时极难看出，
    // 所以这里写死注释钉住（`resolveAttachment` 里另有形状校验，传错会抛错而不是静默失配）。
    const found = await resolveAttachment({ id, roots: attachmentRoots(), fsImpl: fs });
    if (!found) throw new HttpError('not_found', `附件不存在：${id}`);
    if (found.size > ATTACHMENT_MAX_BYTES) {
      throw new HttpError('attachment_too_large', `附件超过网关可服务的上限 ${ATTACHMENT_MAX_BYTES} 字节（实际 ${found.size} 字节）：${id}`);
    }

    // 客户端可能在网关吐字节的过程中挂断（手机切网/息屏）。必须**先**挂上监听再写头：
    // Node 的流错误如果没有监听器，会升级成 `uncaughtException` 直接带走整个网关进程 ——
    // 一个已经走掉的手机就能把 PC 端会话全断掉，是这类"只读文件转发"最典型的坑。
    // 断开事件本身不写日志（不是服务端错误，网关靠 SSE 台账之外的连接复用无需求）；
    // 真正的读盘错误（权限/竞态删除）由 `error` 分支兜底。
    let aborted = false;
    const source = fs.createReadStream(found.path);
    source.on('error', (err) => {
      aborted = true;
      if (!res.headersSent) {
        sendError(req, res, new HttpError('not_found', `附件读取失败：${id}（${err.code ?? err.message}）`), log);
        return;
      }
      log.warn(`附件读取中断：${id}（${err.code ?? err.message}）`);
      res.destroy();
    });
    res.on('close', () => {
      if (!source.destroyed) source.destroy();
    });
    req.on('aborted', () => {
      aborted = true;
      if (!source.destroyed) source.destroy();
    });

    try {
      if (!aborted) {
        res.writeHead(200, {
          'Content-Type': found.mediaType,
          'Content-Length': found.size,
          // 内容哈希寻址 = 字节**永不变**：同一个 id 今天与一年后必然同字节，
          // 所以可以放心 immutable + 一年。private 是因为它受 Bearer 保护，
          // 共享缓存（反代）不得留存（同一台 PC 上可能有多个 home 的对象库）。
          'Cache-Control': 'private, max-age=31536000, immutable',
          // 与其余 v2 端点一致地回 `config.apiVersion`（=1）：这个头在契约 §4.5 里的定义是
          // "v1 端点的版本号"，不是"端点属于第几代"。此前这里一度按"本端点是 v2 新端点"
          // 写了字面量 2，结果是**全网关唯一**回 2 的端点 —— 那种孤例只会让客户端以为
          // 它可以用这个头做能力协商。协商一律看 `/api/v2/health` 的 `capabilities`
          // （本端点对应能力名 `attachments`）。
          'X-Api-Version': String(config.apiVersion),
        });
        source.pipe(res);
      }
    } catch (err) {
      if (!source.destroyed) source.destroy();
      if (err instanceof HttpError) throw err;
      if (req.destroyed || req.aborted) throw new ClientGoneError('客户端已断开');
      throw new HttpError('not_found', `附件读取失败：${id}`);
    }
    return undefined;
  }

  /** `GET /api/v2/sessions/{id}/events`（契约 §4.2，调试/深度视图）。 */
  async function onSessionEvents(res, id, url) {
    const result = await mirror.events(id, {
      fromSeq: intParam(url, 'fromSeq', { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? null,
      tail: intParam(url, 'tail', { min: 1, max: 5000 }) ?? null,
      limit: intParam(url, 'limit', { min: 1, max: 5000 }) ?? null,
      workspace: url.searchParams.get('workspace'),
    });
    if (!result) throw new HttpError('session_not_found', `会话不存在：${id}`);
    return sendJson(res, 200, result);
  }

  /** `POST /api/v2/sessions/{id}/turns`（契约 §4.2 / §5.3）。 */
  async function onCreateTurn(req, res, id) {
    const body = await readJsonBody(req);
    // content 块（图片）：校验与归一化都在网关做完，runner 只负责按通道放行/拒绝。
    // content 缺省 / null / [] → `prompt===null && content===null` → 下面走的是**原来的**那条路，
    // 行为与加这个功能之前逐字一致（老客户端不受影响）。
    const turn = validateTurnContent(body?.content);
    if (!turn.ok) throw new HttpError('bad_request', turn.message);
    const workspace = body?.workspace ? await workspaceContext(new URL(`/?workspace=${encodeURIComponent(body.workspace)}`, 'http://localhost')) : null;
    // 电脑端会话：先让出观望型订阅，再由 runner 开自己那条（它把事件经会话总线推回手机）。
    // 顺序有意：必须在 submit 之前让出，否则投递后两条订阅会同时产帧 → 手机端看到重复事件。
    if (desktop !== null) {
      const meta = await mirror.get(id, {}).catch(() => null);
      if (meta?.source === 'computer') stopDesktopSubscription(id);
    }
    const result = await runner.submit({
      sessionId: id,
      // 有 content 时正文来自 text 块（拼接/占位）；图片只走 content，不进 prompt 长度校验。
      prompt: turn.prompt ?? body?.prompt,
      workspace,
      clientTurnId: typeof body?.clientTurnId === 'string' ? body.clientTurnId : null,
      content: turn.content,
    });
    if (!result.ok) throw new HttpError(result.code, result.message, { status: result.status });
    // 日志只记张数与字节数：图片内容本身绝不落日志。
    const imageNote = turn.images.count > 0 ? ` images=${turn.images.count} bytes=${turn.images.bytes}` : '';
    log.info(`会话轮次已接受 sessionId=${id} turnId=${result.body.turnId} fromSeq=${result.body.fromSeq}${imageNote}`);
    return sendJson(res, result.status, result.body);
  }

  /** `POST /api/v2/sessions/{id}/abort`（契约 §4.2）。 */
  async function onAbortTurn(res, id) {
    const result = await runner.abort(id);
    if (!result) throw new HttpError('not_found', `该会话当前没有在运行的轮次：${id}`);
    // 两条通道的后果不同，日志必须说清楚（排障时最容易误判的一点）。
    if (result.driver === DRIVER_DESKTOP) {
      log.info(`电脑端会话轮次已中止 sessionId=${id} turnId=${result.turnId}（桌面端 session/cancel，非破坏性，该会话仍可续）`);
    } else {
      log.warn(`会话轮次已中止 sessionId=${id} turnId=${result.turnId}（SDK 无 cancel，进程已终止 → 该会话不可再续）`);
    }
    return sendJson(res, 200, result);
  }

  /**
   * `GET /api/v2/approvals`（契约 §7.7）：当前等在电脑端会话上的审批与提问。
   *
   * 为什么列表要单独存在（不靠 SSE 就够）：手机可能在提问**之后**才连上来，
   * 虽然桌面端会把未决帧补给新客户端、会话总线也能回放，但"打开 App 就知道有没有东西等我"
   * 只靠事件流就得等一次完整往返；列表端点是 REST 语义，重连/冷启动都能直接问。
   */
  function onListApprovals(res, url) {
    // 过滤参数必须从 query 读：`routeOf()` 只吃 pathname，路由对象里从来没有 sessionId。
    const sessionId = url.searchParams.get('sessionId') || null;
    return sendJson(res, 200, {
      ok: true,
      approvals: approvals.list({ sessionId }),
      state: approvals.state(),
    });
  }

  /** `POST /api/v2/approvals/{eventId}`（契约 §7.7）：提交答案（审批结论或提问回答）。 */
  async function onApprovalAnswer(req, res, eventId) {
    if (typeof eventId !== 'string' || eventId.length === 0) throw new HttpError('bad_request', '缺少 eventId');
    const body = await readJsonBody(req);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('bad_request', '请求体必须是 JSON 对象');
    const result = await approvals.answer(eventId, body);
    if (!result.ok) throw new HttpError(approvalErrorCode(result.code), result.message);
    log.info(`审批/提问已由手机应答 eventId=${eventId} kind=${result.event.kind} decision=${result.outcome.kind === 'next' ? 'abstain' : (result.event.kind === 'approval' ? result.outcome.value : 'answers')}`);
    return sendJson(res, 200, { ok: true, event: result.event, outcome: result.outcome });
  }

  /**
   * 桥的错误码 → 契约错误码。
   *
   * `not_found` / `bad_request` / `desktop_unavailable` 直接复用既有码（语义完全一致）；
   * 桥自己的 `expired` 必须映射成**新码** `approval_expired`：它不是 404（请求确实存在过），
   * 也不是 `conflict`（没有任何并发写冲突），混用会让手机端分不清"该刷新列表"还是"该重试"。
   */
  function approvalErrorCode(code) {
    if (code === 'not_found' || code === 'bad_request' || code === 'desktop_unavailable') return code;
    if (code === 'expired') return 'approval_expired';
    if (code === 'desktop_unreachable' || code === 'desktop_unauthorized') return code;
    // 其余（含桌面端透传的 `gateway/*`）统一归到 desktop_error：是**通道**的问题，不是请求的问题。
    return 'desktop_error';
  }

  /** 电脑端 SSE 帧：解析出 `{type,data}` 后逐条写给所有在看这个会话的手机连接。 */
  function broadcastDesktopFrame(sessionId, value) {
    const frame = translateDesktopEvent(value);
    if (frame === null) return;
    const watchers = desktopSse.watchers.get(sessionId);
    if (!watchers || watchers.size === 0) return;
    desktopSseSeq += 1;
    const line = `id: ${desktopSseSeq}\nevent: ${frame.type}\ndata: ${JSON.stringify({ ...frame.data, sessionId, source: 'computer' })}\n\n`;
    for (const res of [...watchers]) {
      try {
        res.write(line);
      } catch {
        watchers.delete(res);
      }
    }
  }

  /** 桌面端订阅结束时给在看的人一条说明，避免手机端"永远转圈"。 */
  function broadcastDesktopNotice(sessionId, text) {
    const watchers = desktopSse.watchers.get(sessionId);
    if (!watchers || watchers.size === 0) return;
    desktopSseSeq += 1;
    const line = `id: ${desktopSseSeq}\nevent: ${STREAM_EVENTS.sessionUpdated}\ndata: ${JSON.stringify({ sessionId, source: 'computer', notice: text })}\n\n`;
    for (const res of [...watchers]) {
      try {
        res.write(line);
      } catch {
        watchers.delete(res);
      }
    }
  }

  /**
   * 确保某个电脑端会话有一条通往桌面端的 `session/follow` 订阅（同会话去重）。
   *
   * 订阅**不设超时**（`timeoutMs` 上限 24h）：它是长连接而非一轮订阅，靠 abort 关闭。
   * 事件在被订阅的那一刻起就会被翻译并广播，因此"先订阅再投递"的时序由 `runner.submit`
   * 那边保证；这里只负责把流管道接好。
   */
  function ensureDesktopSubscription(sessionId) {
    if (desktop === null) return false;
    if (desktopSse.subscriptions.has(sessionId)) return true;
    const controller = new AbortController();
    const subscription = { controller, alive: true, stream: null };
    desktopSse.subscriptions.set(sessionId, subscription);
    subscription.stream = (async () => {
      let notice = null;
      try {
        const iterator = desktop.openFollow(sessionId, { assistantStream: true, signal: controller.signal, timeoutMs: 24 * 3600_000 });
        while (true) {
          const step = await iterator.next();
          if (step.done) {
            const error = step.value?.error ?? null;
            if (error && error.code !== 'aborted') notice = `电脑端事件流已结束：${error.message}`;
            break;
          }
          broadcastDesktopFrame(sessionId, step.value);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          notice = `电脑端事件流中断：${String(err?.message ?? err)}`;
          log.warn(`电脑端事件流中断 sessionId=${sessionId}：${String(err?.message ?? err)}`);
        }
      } finally {
        subscription.alive = false;
        desktopSse.subscriptions.delete(sessionId);
        if (notice) broadcastDesktopNotice(sessionId, notice);
      }
    })().catch(() => {
      /* 上面已兜底 */
    });
    log.info(`已建立电脑端事件订阅 sessionId=${sessionId}`);
    return true;
  }

  /**
   * 主动断开某个电脑端会话的**观望型**订阅（只断 `session/follow`，不动桌面端的轮次）。
   *
   * 用在 `POST /turns` 之前：一旦网关开始驱动这个会话，`SessionRunner` 会自己开一条
   * `session/follow` 来统计这一轮，并把翻译后的事件**经由会话总线**推给所有手机连接。
   * 如果此时观望型的订阅还活着，同一条桌面端事件会被两个生产者各翻译一次写进同一条 SSE
   * 响应（实测：一轮出现 3 个 `turn.started`），手机端会看到重复内容。
   *
   * 只 abort 订阅、保留 `watchers`：看这个会话的手机连接本来就订阅着会话总线，
   * 断掉观望订阅后它们改由总线收帧，不会断流。
   */
  function stopDesktopSubscription(sessionId) {
    const subscription = desktopSse.subscriptions.get(sessionId);
    if (!subscription) return false;
    desktopSse.subscriptions.delete(sessionId);
    subscription.alive = false;
    try {
      subscription.controller.abort();
    } catch {
      /* 忽略 */
    }
    log.info(`已让出电脑端事件订阅（改由网关轮次通道驱动）sessionId=${sessionId}`);
    return true;
  }

  /** 一个手机 SSE 连接开始关注某个电脑端会话。 */
  function watchDesktopSession(sessionId, res) {
    let watchers = desktopSse.watchers.get(sessionId);
    if (!watchers) {
      watchers = new Set();
      desktopSse.watchers.set(sessionId, watchers);
    }
    watchers.add(res);
    // 两条独立的"不要开观望订阅"理由，都必须先问：
    // 1. 网关正在驱动这个会话（`isDesktopActive`）—— 那一轮的帧已经经由会话总线到达这里；
    // 2. 实时中继已经接管了这个会话（`isWatchedSession`）—— 同上，而且它还会一直中继下去。
    // 漏掉第 2 条时，手机端（或任何 `?sessionId=` 的连接）会同时从总线和直推各收一份
    // `message.delta`，文本成对出现。
    if (!runner.isDesktopActive(sessionId) && !runner.isWatchedSession(sessionId)) ensureDesktopSubscription(sessionId);
    return () => {
      const set = desktopSse.watchers.get(sessionId);
      if (!set) return;
      set.delete(res);
      if (set.size === 0) {
        desktopSse.watchers.delete(sessionId);
        // 没有手机在看这个会话了 → 断开桌面端订阅（桌面端的轮次不受影响，仍在跑）。
        const subscription = desktopSse.subscriptions.get(sessionId);
        if (subscription) {
          try {
            subscription.controller.abort();
          } catch {
            /* 忽略 */
          }
        }
      }
    };
  }

  /**
   * `GET /api/v2/sessions/stream`（SSE，契约 §4.2）。
   *
   * 两套 seq 的分工（最容易搞混的地方）：
   * - SSE 的 `id:` 行 = 本总线分配的 `streamSeq`，也是 `Last-Event-ID` / `?fromSeq=` 的续传游标；
   * - `data.seq` = DSH 会话事件自带的 seq，供手机端与 `/events` 对齐。
   *
   * 第三套（仅电脑端会话）：帧直接来自桌面端 runtime 的 `session/follow`，`id:` 用独立的
   * `desktopSseSeq` 空间 —— 它不经过会话总线，混用会让 `Last-Event-ID` 串号。
   */
  function onSessionsStream(req, res, url) {
    const sessionId = url.searchParams.get('sessionId') || null;
    const fromSeq = parseSeq(url.searchParams.get('fromSeq') ?? req.headers['last-event-id']);
    if (sessionId && !isSessionIdShape(sessionId)) throw new HttpError('bad_request', `sessionId 形态非法：${sessionId}`);
    const maxClients = config.sessionStream?.maxClients ?? 16;
    if (sse.sessionClients.size >= maxClients) throw new HttpError('busy', `会话 SSE 连接数已达上限（${maxClients}）`);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    req.setTimeout(0);
    res.setTimeout?.(0);

    let closed = false;
    let subscription = null;
    let unwatchDesktop = null;
    let heartbeat = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        sse.heartbeats.delete(heartbeat);
      }
      subscription?.unsubscribe();
      unwatchDesktop?.();
      sse.sessionClients.delete(res);
      sse.cleanups.delete(cleanup);
    };
    const write = (chunk) => {
      if (closed) return;
      try {
        res.write(chunk);
      } catch {
        cleanup();
      }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    sse.sessionClients.add(res);
    sse.cleanups.add(cleanup);

    write(': connected\n\n');

    // 电脑端会话 → 走桌面端事件流（异步判定：本函数不是 async，所以用 IIFE + 兜底）。
    if (sessionId && desktop !== null) {
      void (async () => {
        try {
          const meta = await mirror.get(sessionId, {});
          if (closed || meta?.source !== 'computer') return;
          unwatchDesktop = watchDesktopSession(sessionId, res);
        } catch (err) {
          log.warn(`判定会话来源失败（回落到会话总线）sessionId=${sessionId}：${err.message}`);
        }
      })();
    }

    // `?sessionId=`（可选）：只把该会话的事件写给这一个客户端。
    // 不传时行为与旧版逐字一致（`subscribeSession` 的 sessionId 为 null 时就是全收）——
    // 契约 §4.2 的主用法是"一条流覆盖两类会话、客户端按 sessionId 分流"，
    // 手机端（ConsoleStreams.path 只带 fromSeq/tail）走的就是这条路，不受影响。
    subscription = sessionStream.subscribeSession({
      sessionId,
      fromSeq,
      onEvent: (ev) => {
        // 总线游标 → SSE 的 `id:` 行（Last-Event-ID 续传游标）；
        // dshSeq → data.seq（契约 §4.2 示例里的 `seq` 指 DSH 事件序号）。
        // 同时剥掉总线的封装字段（taskId/type/streamSeq）：`taskId` 在这里是会话 id，
        // 用任务时代的字段名承载会话语义会误导客户端。
        const { seq, dshSeq, streamSeq, taskId, type, ...payload } = ev;
        void streamSeq;
        void taskId;
        void type;
        if (dshSeq !== undefined) payload.seq = dshSeq;
        write(`id: ${seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(payload)}\n\n`);
      },
    });
    if (subscription.gap) write(`: gap requested=${fromSeq} oldest=${subscription.oldestSeq}\n\n`);
    // 游标来自上一个网关进程（本总线 seq 从 1 重开）：这条订阅按「只接续实时事件」处理。
    // 必须留痕：否则症状是「连接在线、心跳正常、内容全无」，从日志里完全看不出发生了什么。
    if (subscription.epochReset) {
      log.warn(`会话 SSE 客户端带着上一个进程的游标重连（fromSeq=${fromSeq} > 本进程最大 seq），已改为只接续实时事件`);
    }

    heartbeat = setInterval(() => {
      const at = now();
      write(`event: ${STREAM_EVENTS.heartbeat}\ndata: ${JSON.stringify({ at })}\n\n`);
    }, config.sessionStream?.heartbeatMs ?? 15_000);
    heartbeat.unref?.();
    sse.heartbeats.add(heartbeat);
    return undefined;
  }

  /** `GET /api/v2/workspaces`（契约 §4.3：白名单 + git 摘要）。 */
  async function onWorkspacesV2(res) {
    const base = await listWorkspaces({ allowlist: config.workspaceAllowlist, defaultWorkspace: config.defaultWorkspace });
    const withVcs = await listWorkspacesWithVcs({ workspaces: base.workspaces, default: base.default, spawnImpl });
    return sendJson(res, 200, { ...withVcs, mirrors: (config.sessionRoots ?? []).map((r) => ({ source: r.source, home: r.home, writable: r.writable })) });
  }

  // ---------------------------------------------------------------------------
  // `GET /api/v2/models`：手机端模型选择器的数据源（契约 §4.7）
  //
  // 这个端点有一条**刻意**的契约：**永不 503**。
  //
  // 选择器是手机端「新建任务」页的常驻控件，而"桌面端没在跑"是完全正常的稳态
  // （用户可能就在手机上发任务，电脑那边 DSH 没开）。若这里按 `desktop_unreachable` 报错，
  // 手机端就只能渲染一个空/报错的选择器，用户失去的是"看到网关自身默认模型"这个**已有信息**。
  // 所以降级路径返回 `source:'config'` + `groups:[]` + 网关配置里的那一个默认项：
  // 列表短归短，但它是真的（就是网关接下来会用的那个模型），用户能据此判断"要不要先开电脑"。
  // `source` 字段就是给手机端区分"真目录 / 仅网关默认"用的唯一判据。
  //
  // 顺带一提，这里**不做**任何缓存：目录来自桌面端内存态（用户可能在电脑上刚装了一个 provider），
  // 缓存只会让手机端看到过期列表；一次 RPC 的成本远低于一次"选了但用不上"的困惑。
  // ---------------------------------------------------------------------------

  /** 桌面端目录 → 只保留契约字段（它是内网进程给的数据，仍然按不可信输入逐字段收口）。 */
  function normalizeModelEntry(value) {
    if (!value || typeof value !== 'object') return null;
    const id = typeof value.id === 'string' && value.id ? value.id : null;
    const name = typeof value.name === 'string' && value.name ? value.name : id;
    if (!id || !name) return null;
    const entry = { id, name };
    if (typeof value.description === 'string' && value.description) entry.description = value.description;
    // `reasoning`（档位列表）是可选的：只有支持 reasoning 的模型才有，手机端据它渲染档位选择器。
    const reasoning = value.reasoning;
    if (reasoning && typeof reasoning === 'object' && Array.isArray(reasoning.efforts)) {
      const efforts = reasoning.efforts
        .map((effort) => {
          const effortId = typeof effort?.id === 'string' && effort.id ? effort.id : null;
          if (!effortId) return null;
          const item = { id: effortId, name: typeof effort?.name === 'string' && effort.name ? effort.name : effortId };
          if (typeof effort?.description === 'string' && effort.description) item.description = effort.description;
          return item;
        })
        .filter((effort) => effort !== null);
      if (efforts.length > 0) {
        entry.reasoning = { efforts };
        const defaultEffort = typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort ? reasoning.defaultEffort : null;
        if (defaultEffort) entry.reasoning.defaultEffort = defaultEffort;
      }
    }
    return entry;
  }

  /** 桌面端目录 → `groups`（丢掉空组；组内模型逐个收口）。 */
  function normalizeModelGroups(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((group) => {
        const id = typeof group?.id === 'string' && group.id ? group.id : null;
        const name = typeof group?.name === 'string' && group.name ? group.name : id;
        if (!id || !name) return null;
        const models = (Array.isArray(group.models) ? group.models : []).map(normalizeModelEntry).filter((model) => model !== null);
        if (models.length === 0) return null;
        return { id, name, models };
      })
      .filter((group) => group !== null);
  }

  /** 桌面端目录 → `failures`（某个 provider 采集失败；手机端可以据此提示"部分不可用"）。 */
  function normalizeModelFailures(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((failure) => {
        const id = typeof failure?.id === 'string' && failure.id ? failure.id : null;
        if (!id) return null;
        return {
          id,
          name: typeof failure?.name === 'string' && failure.name ? failure.name : id,
          message: typeof failure?.message === 'string' && failure.message ? failure.message : '桌面端未给出原因',
        };
      })
      .filter((failure) => failure !== null);
  }

  /** 网关配置里的那一个默认模型（降级路径与"桌面端没给 default"时的兜底都是它）。 */
  function configModelDefault() {
    return {
      provider: config.dsh?.provider ?? null,
      model: config.dsh?.model ?? null,
      reasoningEffort: config.dsh?.reasoningEffort ?? null,
    };
  }

  /**
   * 读一次桌面端模型目录并按契约形状收口。
   *
   * **不抛异常**（降级是正常路径，见端点注释）。`POST /api/v2/tasks` 也要用它：
   * 手机只传了 `model` 没传 `provider` 时，必须先从目录里把这个 provider 查出来
   * —— `session/selectModel` 的 `provider` 是**必填**的，送空串只会换来一次必失败。
   */
  async function loadModelCatalog() {
    // 降级形状**每次现造**，不要共用常量对象：`failures[0].message` 说的是"这一次"为什么降级，
    // 共用一份的话，将来任何缓存/复用都会把 A 请求的原因显示到 B 请求上。
    //
    // `failures` 里那一条是**必需的**（契约 §4.7）：手机端只有这个字段能解释
    // "为什么列表里只剩一个模型"。只写 log.warn 等于让用户永远看不到原因 ——
    // "手机上只有两个模型，没人看得出是桌面端没连上"正是这个端点要避免的失败模式。
    const degraded = (message) => ({
      ok: true,
      source: 'config',
      default: configModelDefault(),
      routableProviders: [],
      groups: [],
      failures: [{ id: 'desktop', name: '电脑端', message }],
    });
    if (desktop === null) {
      const reason = '网关未接入桌面端 DSH runtime（desktop.enabled=false 或未配置）';
      log.warn(`模型目录降级为配置默认值：${reason}`);
      return degraded(reason);
    }
    // 用 `callRaw` 而不是 `call`：这里要的是"失败就降级"，不是把异常抛成 5xx。
    const outcome = await desktop.callRaw?.('session/modelCatalog') ?? null;
    if (!outcome || outcome.ok !== true || !outcome.value || typeof outcome.value !== 'object') {
      // 降级**必须留痕**：否则用户报"手机上只有两个模型"时，没人能看出是桌面端没连上，
      // 还是会以为网关把目录丢了。message 里带上是哪一类失败（不可达 / 无路由 / 协议错误），
      // 并且**原样进响应**（`failures[0].message`）而不只是进日志。
      const reason = outcome?.error ? `${outcome.error.code}: ${outcome.error.message}` : '桌面端未实现 modelCatalog';
      log.warn(`模型目录降级为配置默认值（桌面端不可用）：${reason}`);
      return degraded(reason);
    }
    const catalog = outcome.value;
    const configured = configModelDefault();
    const desktopDefault = catalog.default && typeof catalog.default === 'object' ? catalog.default : null;
    return {
      ok: true,
      source: 'desktop',
      default: {
        provider: typeof desktopDefault?.provider === 'string' && desktopDefault.provider ? desktopDefault.provider : configured.provider,
        model: typeof desktopDefault?.model === 'string' && desktopDefault.model ? desktopDefault.model : configured.model,
        reasoningEffort: typeof desktopDefault?.reasoningEffort === 'string' && desktopDefault.reasoningEffort ? desktopDefault.reasoningEffort : null,
      },
      // `routableProviders` 是"这个桌面端实际能路由到的 provider"，与 `groups` 不是一回事
      // （某些 provider 可能没有任何可选模型却仍可路由）。手机端可以据此判断选中的 provider 是否可用。
      routableProviders: Array.isArray(catalog.routableProviders) ? catalog.routableProviders.filter((p) => typeof p === 'string') : [],
      groups: normalizeModelGroups(catalog.groups),
      failures: normalizeModelFailures(catalog.failures),
    };
  }

  /**
   * 手机只给了 `model` 时补齐 `provider`（契约 §7.8 铁律 4，lead 裁定）。
   *
   * 为什么值得为它多跑一次 RPC：`session/selectModel` 的 `provider` 是**必填**的，
   * 而契约允许手机只报模型名。反查**只推断 provider，绝不改 `model`**（不得编造 model id），三个分支：
   *
   * 1. **唯一命中**：恰好一个分组提供这个 id → 用那个分组 id。这是唯一无歧义的推断。
   * 2. **多命中**：同一个 id 经多个 provider 路由是**真实存在**的（实测 `deepseek-flash` 同时在
   *    `deepseek-official` 与 `deepseek-account` 下）。用户选的是"模型"而不是"账号"，这些 id 指向
   *    同一个模型，所以落到目录默认 provider 上是可接受的推断，不是把模型悄悄换成另一个 ——
   *    为此回 4xx 会打断一个合法场景，且失败对用户毫无解释力。
   * 3. **零命中**：目录里没有这个 id（桌面端没把它列为可路由）。此时**绝不拿默认 provider 顶替**：
   *    那等于用另一个模型冒充用户选的模型。改为跳过切换、如实报 `modelApplied:false` +
   *    `modelWarning`（任务照常投递），由手机端提示"选的模型没生效"。
   *
   * 返回 `{provider, reason}`：`reason !== null` 表示**推断不出 provider**，调用方必须跳过切换并把它
   * 当 `modelWarning` 原样下发（不是异常、也不回 4xx —— 模型名本身可能是合法的，只是当前路由不到）。
   */
  async function resolveRequestedProvider({ provider, model }) {
    if (provider || !model) return { provider, reason: null };
    const catalog = await loadModelCatalog();
    const hits = catalog.groups.flatMap((group) => group.models.filter((entry) => entry.id === model).map(() => group.id));
    const unique = [...new Set(hits)];
    if (unique.length === 1) return { provider: unique[0], reason: null };
    if (unique.length > 1) {
      const fallback = catalog.default?.provider ?? null;
      if (fallback) {
        log.warn(`模型 ${model} 在 ${unique.length} 个分组里都有（${unique.join(', ')}）；用户选的是模型而非账号，按目录默认 provider ${fallback} 尝试`);
        return { provider: fallback, reason: null };
      }
      log.warn(`模型 ${model} 在多个分组里都有（${unique.join(', ')}）且目录没有默认 provider；无法推断 provider`);
      return { provider: null, reason: `模型 ${model} 在多个 provider（${unique.join(', ')}）下都有，且目录没有默认 provider；未切换模型` };
    }
    log.warn(`桌面端模型目录里没有 ${model}；无法推断 provider，跳过切换`);
    return { provider: null, reason: `桌面端模型目录里没有 ${model}，无法确定 provider；未切换模型` };
  }

  /**
   * `GET /api/v2/models`（契约 §4.7）。
   *
   * 形状 `{ok, source, default, routableProviders, groups, failures}`：
   * - `source:'desktop'` → 桌面端 `session/modelCatalog` 的真目录；
   * - `source:'config'`  → 桌面端不可用/未接线/返回畸形数据，只有网关配置里的一个默认项。
   */
  async function onModelsV2(res) {
    return sendJson(res, 200, await loadModelCatalog());
  }

  /** `GET /api/v2/workspaces/files`（契约 §4.3）。 */
  async function onWorkspaceFiles(res, url) {
    const workspace = await workspaceContext(url);
    const depth = intParam(url, 'depth', { min: 1, max: 4 }) ?? 1;
    const showHidden = ['1', 'true', 'yes'].includes((url.searchParams.get('showHidden') ?? '').toLowerCase());
    const result = await listDirectory({
      workspace,
      allowlist: config.workspaceAllowlist,
      requestPath: url.searchParams.get('path'),
      depth,
      showHidden,
      maxEntries: config.workspaceFs.maxEntries,
    });
    return sendJson(res, 200, result);
  }

  /** `GET /api/v2/workspaces/file`（契约 §4.3：文本内容 / 二进制元数据）。 */
  async function onWorkspaceFile(res, url) {
    const requestPath = url.searchParams.get('path');
    if (!requestPath) throw new HttpError('bad_request', '缺少 path 参数');
    const workspace = await workspaceContext(url);
    const result = await readFileEntry({
      workspace,
      allowlist: config.workspaceAllowlist,
      requestPath,
      maxBytes: config.workspaceFs.maxFileBytes,
    });
    return sendJson(res, 200, result);
  }

  /** `GET /api/v2/workspaces/changes`（契约 §4.3）。 */
  async function onWorkspaceChanges(res, url) {
    const requestPath = url.searchParams.get('path');
    const workspace = await workspaceContext(url);
    let target = workspace;
    if (requestPath) {
      // 复用 workspace-fs 的越界防护：改动列表的目录同样不能越界。
      // mode: READ_MODE ⇒ 只读语义（工作区里指向外部的链接目录放行），
      // lexicalPath ⇒ 保留用户进来的那个名字（见下面 /diff 的同款注释）。
      const { resolveTarget } = await import('./workspace-fs.mjs');
      target = (await resolveTarget({ requestPath, workspace, allowlist: config.workspaceAllowlist, mustExist: true, expect: 'dir', mode: READ_MODE })).lexicalPath;
    }
    const status = await gitStatus({ workspace: target, spawnImpl });
    return sendJson(res, 200, status);
  }

  /** `GET /api/v2/workspaces/diff`（契约 §4.3）。 */
  async function onWorkspaceDiff(res, url) {
    const file = url.searchParams.get('file') ?? url.searchParams.get('path');
    if (!file) throw new HttpError('bad_request', '缺少 file 参数');
    const workspace = await workspaceContext(url);
    const { resolveTarget } = await import('./workspace-fs.mjs');
    // 只读接口：mode=READ_MODE 与 /files、/file 口径一致；
    // 路径用 lexicalPath（用户进来的名字）而不是 realPath —— workspace-git.mjs:238 用
    // `path.relative(workspace, file)` 生成 git pathspec，链接目录指向别的盘时 realPath 会
    // 让 path.relative 返回绝对路径，git 直接报错。
    const target = await resolveTarget({ requestPath: file, workspace, allowlist: config.workspaceAllowlist, mustExist: true, expect: 'file', mode: READ_MODE });
    const result = await gitDiff({ workspace, file: target.lexicalPath, relative: target.relative, spawnImpl });
    return sendJson(res, 200, { ...result, path: target.lexicalPath, workspace: target.workspace });
  }

  /** `GET /api/v2/workspaces/search`（契约 §4.3）。 */
  async function onWorkspaceSearch(res, url) {
    const q = url.searchParams.get('q');
    if (!q || !q.trim()) throw new HttpError('bad_request', '缺少查询词 q');
    const limit = intParam(url, 'limit', { min: 1, max: 200 }) ?? 50;
    const workspace = await workspaceContext(url);
    const result = await searchWorkspace({
      workspace,
      allowlist: config.workspaceAllowlist,
      q,
      requestPath: url.searchParams.get('path'),
      limit,
      now,
      budgetMs: config.workspaceFs.searchBudgetMs,
      maxFiles: config.workspaceFs.searchMaxFiles,
      maxFileBytes: config.workspaceFs.searchMaxFileBytes,
    });
    return sendJson(res, 200, result);
  }

  /** SSE 事件流（契约 §4）。 */
  function onEvents(req, res, url) {
    const taskId = url.searchParams.get('taskId') || null;
    const fromSeqParam = url.searchParams.get('fromSeq');
    const fromSeq = parseSeq(fromSeqParam ?? req.headers['last-event-id']);

    // 先校验请求本身是否合法（未知任务 → 404），再判断容量：
    // 这样客户端拿到的是准确的错误原因，而不是被容量问题掩盖的 429。
    if (taskId && !tasks.get(taskId)) throw new HttpError('not_found', `任务不存在：${taskId}`);
    if (sse.clients.size >= config.limits.maxSseClients) {
      throw new HttpError('busy', `SSE 连接数已达上限（${config.limits.maxSseClients}）`);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // SSE 是长连接：关闭该连接的请求/套接字空闲超时，由心跳与客户端断开事件驱动生命周期
    req.setTimeout(0);
    res.setTimeout?.(0);

    let closed = false;
    let subscription = null;
    let heartbeat = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat); // 立即释放定时器，避免断开后仍在跑（内存/句柄泄漏）
        sse.heartbeats.delete(heartbeat);
      }
      subscription?.unsubscribe();
      sse.clients.delete(res);
      sse.cleanups.delete(cleanup);
    };

    const write = (chunk) => {
      if (closed) return;
      try {
        res.write(chunk);
      } catch {
        cleanup();
      }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    sse.clients.add(res);
    sse.cleanups.add(cleanup);

    write(': connected\n\n');
    // 先回放后订阅在同一 tick 内完成，不会漏事件也不会重复投递
    subscription = bus.subscribe({
      taskId,
      fromSeq,
      onEvent: (ev) => write(formatEvent(ev)),
    });
    if (subscription.gap) {
      // 仅用 SSE 注释说明「客户端请求的断点早于缓冲区起点」，不发明新的事件类型
      write(`: gap requested=${fromSeq} oldest=${subscription.oldestSeq}\n\n`);
      log.warn(`SSE 断点早于事件缓冲起点：fromSeq=${fromSeq} oldest=${subscription.oldestSeq}（客户端应回源任务详情兜底）`);
    }
    if (subscription.epochReset) {
      log.warn(`事件 SSE 客户端带着上一个进程的游标重连（fromSeq=${fromSeq} > 本进程最大 seq），已改为只接续实时事件`);
    }

    heartbeat = setInterval(() => write(': ping\n\n'), config.events.heartbeatMs);
    heartbeat.unref?.();
    sse.heartbeats.add(heartbeat);
    return undefined;
  }

  /** 读取并解析 JSON 请求体，超限抛 413。 */
  async function readJsonBody(req) {
    const maxBytes = config.limits.maxBodyBytes;
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > maxBytes) {
        // 不读取超大请求体：直接 413 并关闭连接
        throw new HttpError('payload_too_large', `请求体超过上限 ${maxBytes} 字节`, { headers: { Connection: 'close' } });
      }
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
          throw new HttpError('payload_too_large', `请求体超过上限 ${maxBytes} 字节`, { headers: { Connection: 'close' } });
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // 客户端中途断开或 408 触发的流中断：静默处理，不产生 500 噪声日志
      if (req.destroyed || req.aborted) throw new ClientGoneError('客户端已断开');
      throw err;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError('bad_request', '请求体不是合法的 JSON');
    }
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    if (!res.headersSent) {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'X-Api-Version': String(config.apiVersion),
      });
    }
    res.end(text);
    return undefined;
  }

  /** 统一错误体：{ error: { code, message } }（契约 §0）；永不回显令牌等敏感信息。 */
  function sendError(req, res, err, logger) {
    const isHttp = err instanceof HttpError;
    const code = isHttp ? err.code : 'internal';
    const status = isHttp ? err.status : 500;
    const message = isHttp ? err.message : '网关内部错误';
    if (!isHttp) logger.error(`未处理异常：${err?.stack ?? err}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    const text = JSON.stringify({ error: { code, message: redactSecrets(message) } });
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'X-Api-Version': String(config.apiVersion),
      ...(isHttp ? err.headers : {}),
    };
    res.writeHead(status, headers);
    res.end(text);
    if (status === 413) {
      // 请求体未读完时不能让连接挂起：响应结束后立刻销毁
      res.on('finish', () => req.destroy());
    }
  }

  /** 启动监听，返回实际端口（配置 0 时由系统分配）。 */
  async function listen() {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : config.port;
    boundPort = port;
    log.info(`监听 http://${config.host}:${port}（apiVersion=${config.apiVersion} supported=${config.supportedApiVersions.join('/')}）`);
    // v2：会话运行时的空闲回收 + 中继自动连接（relay.enabled=true 时）
    if (config.dsh?.runtimeIdleMs) {
      const reaper = setInterval(() => void runner.reapIdle().catch(() => {}), Math.max(30_000, Math.floor(config.dsh.runtimeIdleMs / 2)));
      reaper.unref?.();
      maintenance.add(reaper);
    }
    if (config.relay?.enabled && config.relay?.url) {
      log.info(`relay.enabled=true，尝试连接中继 ${config.relay.url}`);
      void relay.connect().then((result) => {
        if (!result.ok) log.warn(`中继首次连接失败（将按退避重试）：${redactSecrets(result.error ?? '未知原因')}`);
      });
    }
    return port;
  }

  /** 优雅关闭：先断开 SSE，再停收新连接，最后终止子进程并落盘。 */
  async function close() {
    for (const cleanup of [...sse.cleanups]) cleanup();
    // 电脑端事件的 WebSocket 订阅不是 HTTP 连接，server.close 管不到它们，必须显式断开，
    // 否则进程会挂着不退出（每个在看电脑端会话的手机连接各留一条到桌面端的 WebSocket）。
    for (const [sessionId, subscription] of [...desktopSse.subscriptions]) {
      desktopSse.subscriptions.delete(sessionId);
      try {
        subscription.controller.abort();
      } catch {
        /* 忽略 */
      }
    }
    desktopSse.watchers.clear();
    for (const timer of maintenance) clearInterval(timer);
    maintenance.clear();
    // 先发起 close（停止 accept），再强制释放 keep-alive/长连接：
    // 否则 server.close 的回调要等 keepAliveTimeout（65s）才触发，关闭流程会挂住。
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await closed;
    // v2：先停中继与会话运行时（避免 SDK 子进程泄漏），再收尾 v1 任务
    await approvals.stop().catch(() => {});
    await relay.shutdown().catch(() => {});
    await runner.shutdown().catch(() => {});
    await tasks.shutdown();
    await devices.flush();
  }

  return {
    config,
    logger: log,
    bus,
    devices,
    pairing,
    tasks,
    // ---- v2 暴露（测试/e2e 需要直接驱动这些对象）----
    mirror,
    live,
    runner,
    relay,
    approvals,
    sessionStream,
    server,
    listen,
    close,
    /** @returns {number|null} */
    get port() {
      const address = server.address();
      return address && typeof address === 'object' ? address.port : null;
    },
    /** 运行期台账：用于验证 SSE 断开后无定时器/连接泄漏。 */
    stats() {
      return {
        uptimeMs: now() - startedAt,
        port: address6(server),
        sseClients: sse.clients.size,
        sessionSseClients: sse.sessionClients.size,
        sseHeartbeats: sse.heartbeats.size,
        maintenanceTimers: maintenance.size,
        busSubscribers: bus.subscriberCount,
        busBufferedEvents: bus.buffer.length,
        sessionStreamSubscribers: sessionStream.subscriberCount,
        sessionStreamBuffered: sessionStream.buffer.length,
        mirrorCached: mirror.size,
        ...runner.stats(),
        relay: relay.status(),
        ...tasks.stats(),
      };
    },
  };
}

function address6(server) {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : null;
}

/** 解析 fromSeq / Last-Event-ID；非法值按 0（全量回放）处理。 */
export function parseSeq(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * 解析整数查询参数。
 * @param {URL} url
 * @param {string} name
 * @param {{min: number, max: number}} range
 * @returns {number|null} 缺省返回 null（调用方用 `?? 默认值`）
 */
export function intParam(url, name, { min, max }) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError('bad_request', `${name} 必须是 ${min}~${max} 之间的整数（当前：${raw}）`);
  }
  return n;
}

/** 会话 id 形态校验（防路径穿越；与 dsh-home 的目录约定一致）。 */
export function isSessionIdShape(id) {
  return typeof id === 'string' && SESSION_DIR_RE.test(id);
}

/** 归一化配对码：接受字符串或数字，必须是 6 位数字。 */
export function normalizePairCode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value).padStart(6, '0');
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{6}$/.test(trimmed) ? trimmed : null;
}

/** SSE 帧格式化：data 恒为单行 JSON（JSON.stringify 会转义内部换行）。 */
export function formatEvent(ev) {
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}
