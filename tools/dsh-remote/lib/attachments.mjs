/**
 * 附件对象库：把会话日志里的 `{type:'image', attachment:{attachmentId}}` 引用
 * 解析成本机上**真实可读的图片文件**（契约 §4.6）。
 *
 * ## 为什么日志里有引用、却没有图片字节
 *
 * DSH 会话是多帧 zstd 追加的 NDJSON，图片字节**从不**写进会话日志（实测 155 个会话：
 * `user/message` / `tool/result` 里的 image 块只有一个对象库引用，没有 base64）。
 * 真实形状（2026-10-20 逐会话取样）：
 * ```
 * {"type":"user/message","data":{"content":[
 *    {"type":"text","text":"…"},
 *    {"type":"image","attachment":{"attachmentId":"sha256:2734d6…96cc","mediaType":"image/png",
 *                                  "width":1080,"height":2340,"bytes":312799,"name":"1000000051.png"}}]}}
 * ```
 * 图片本体落在桌面端/运行时写出的**内容寻址对象库**里：
 * `~/.dsh/attachments/<版本目录>/objects/<hash 前 2 位>/<完整 64 位 hex>`（文件**无扩展名**，
 * 内容与多帧 zstd 无关）。引用与字节分家的好处是日志可以只追加、不因图片膨胀；
 * 代价是任何想看图的客户端都必须自己会查这个库 —— 网关就是替手机做这件事的那一层。
 *
 * ## 为什么要嗅探魔数，而不是信日志里的 `mediaType`
 *
 * 1. `HTTP Content-Type` 必须**准确**：手机端（Compose）按它选解码器，标错就是一张裂图；
 * 2. 日志里的 `mediaType` 是**写入端的声明**，历史数据里并不保证存在（老帧可能整个
 *    `attachment` 里只有 `attachmentId`），也不保证与落盘字节一致（复制/转码过的对象）；
 * 3. 对象库文件名是内容哈希、无扩展名，`path.extname()` 那条路根本走不通。
 * 因此以**磁盘上的真实字节**为唯一真值：读前 12 字节认签名，认不出给
 * `application/octet-stream`（不猜、不报错 —— 能下载下来总比 500 好）。
 *
 * ## 为什么要搜多个 home 根
 *
 * 网关进程同时服务两类会话（§4.2），它们的图片可能落在不同 home 的对象库里：
 * - `config.dsh.sessionsHome`：网关自己 `dsh --profile sdk` 起的会话（手机发的图）；
 * - `config.mirror.resolvedHome`：`~/.dsh`，电脑端真实会话（电脑端发的图、read_image 的产物）；
 * - `config.desktop?.dshHome`：桌面端通道显式配置的 home（可能与前两者都不同）。
 * 附件 id 是**内容哈希**，与"哪个 home"无关，所以命中即返回 —— 同一个 id 在多个 home 里
 * 存在时字节**必然相同**（sha256 寻址），先后顺序不产生语义差异，只影响 I/O 次数。
 * 版本目录（实测为 `v1`）用 `readdir` 探测而**不写死**：DSH 升级后目录名可能变成 `v2`，
 * 写死会让所有图片在某次升级后集体 404（这种故障极难从现象倒推回原因）。
 *
 * ## 安全边界（安全红线，改这个文件前先读）
 *
 * `attachmentId` **直接参与拼路径**，所以必须是**内容哈希**这一种形状：本模块用
 * `ATTACHMENT_ID_RE` 严格卡死（`sha256:` + 64 位小写 hex），任何 `..`、`/`、`\`、盘符、
 * UNC、百分号都进不了路径。**不要**为了"支持更多 id 形式"放宽这个正则 ——
 * 网关不做按会话的二次授权（已配对设备本来就能读所有会话与工作区，见 §5.5），
 * 唯一挡住"读对象库以外任意文件"的就是这个正则。
 *
 * 另注：`attachment_too_large`（8 MiB 上限）的理由见 `ATTACHMENT_MAX_BYTES` 注释。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 附件 id 的**唯一**合法形状：`sha256:` 前缀 + 64 位小写十六进制。
 *
 * 大小写**不容忍**（虽然 `normalizeAttachmentId` 会先转小写再校验）：
 * 对象库的目录名与文件名都是小写 hex，大写形式在磁盘上根本不存在，
 * 放行只会变成一次必然 404 的 I/O。
 */
export const ATTACHMENT_ID_RE = /^sha256:[0-9a-f]{64}$/;

/** 裸 64 位 hex（`normalizeAttachmentId` 会给它补前缀）。 */
const BARE_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * 单个附件可服务的**字节上限**（8 MiB）。
 *
 * 为什么不是中继侧那个 1 MiB：`relay-client.mjs` 的 1 MiB 是**单条隧道流的未刷出积压**上限
 * （背压阈值），不是响应总量 —— 图片是一个普通 HTTP 响应体，可以分很多帧流过去，
 * 只要生产者不一次性把整个文件怼进未刷出队列就不会撞它（实现用 `createReadStream` 让
 * Node 自己按 highWaterMark 拉，天然满足）。压到 1 MiB 会让手机端截图（实测单张
 * 1080×2340 PNG 就有 150~320 KiB，长截图/多图拼接轻松过 MB）莫名其妙地取不到。
 *
 * 8 MiB 这个数是为了**防内存与流量放大**：手机端按引用渲染时会把整个响应读进内存，
 * 二进制垃圾或超大对象被当成图片请求会直接打爆客户端；网关侧一次性读入的上限也按它算
 * （见 `readWholeObject`）。真机实测最大的附件远小于此（样例 71 KB~320 KB）。
 */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/** 探测签名需要的前导字节数（WEBP 的 `RIFF....WEBP` 要到第 12 字节）。 */
const SNIFF_BYTES = 12;

/**
 * 容错解析一个附件 id：接受 `sha256:<hex>`、裸 64 位 hex、大小写混写。
 *
 * 为什么需要容错：日志是**历史数据**，实测同一字段在不同时期的帧里写法并不统一；
 * 客户端也可能把 `sha256:` 丢掉（Android 侧就出现过只带 64 位 hex 的实现）。
 * 统一转小写后再校验 —— 十六进制大小写不影响语义，但会影响路径命中。
 *
 * @param {unknown} raw
 * @returns {string|null} 规范化的 `sha256:<64 位小写 hex>`；不合法一律 `null`
 */
export function normalizeAttachmentId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (ATTACHMENT_ID_RE.test(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (ATTACHMENT_ID_RE.test(lower)) return lower;
  if (BARE_HEX_RE.test(trimmed)) return `sha256:${lower}`;
  return null;
}

/**
 * 按魔数嗅探 MIME 类型。
 *
 * 覆盖 PNG / JPEG / GIF / WEBP 四种（正好是 `TURN_IMAGE_MEDIA_TYPES` 允许上传的集合，
 * 也是 DSH 两个图片入口 —— 手机发图与 `read_image` —— 实际会产生的类型）。
 * 认不出返回 `application/octet-stream`：**不猜**，让客户端自己决定（它至少还能存下来）。
 *
 * @param {Buffer|Uint8Array|null|undefined} head 文件前若干字节（≥12 字节足够）
 * @returns {string}
 */
export function sniffMediaType(head) {
  if (!head || head.length < SNIFF_BYTES) return 'application/octet-stream';
  const b = head;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF（第三个字节区分 JFIF/EXIF/其它，这里不细分）
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF8"（87a/89a 都是这个前缀）
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  // WEBP: "RIFF" .... "WEBP"（第 4~7 字节是文件长度，必须跳过再比）
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

/**
 * 校验并取出可用的 promise 版文件系统接口。
 *
 * 为什么值得写这一段：本仓库的 `fsImpl` 注入约定是"传 **`node:fs`**（带 `.promises`）"，
 * 而不是"传 `node:fs/promises`"。两者外观极像，传错的表现却是**所有附件静默 404**
 * （`fsImpl.promises` 是 undefined，`readdir` 抛错被 catch 成"没这个目录"），
 * 排障时会一路怀疑到对象库布局、版本目录名、权限，就是怀疑不到自己传参错了
 * —— 实测踩过一次。这里把它变成一个**启动即炸**的显式错误。
 * @param {object} fsImpl
 */
function promisesOf(fsImpl) {
  const promises = fsImpl?.promises;
  if (!promises || typeof promises.readdir !== 'function' || typeof promises.stat !== 'function' || typeof promises.open !== 'function') {
    throw new TypeError('attachments：fsImpl 必须是 node:fs 模块（带 .promises），不能传 node:fs/promises');
  }
  return promises;
}

/**
 * 在一个 home 根下定位附件对象。
 *
 * 两级探测都是**目录扫描**（`<home>/attachments/<ver>/objects/<前2位>/<hex>`）而不是拼死路径：
 * 版本目录按 §头注释的理由探测；两级目录都要求 "名字 == 规范化后的目标名"，
 * 因此 `readdir` 返回什么都不会把结果带出对象库之外。
 *
 * @param {string} home
 * @param {string} id 已规范化的 `sha256:<64 hex>`
 * @param {{fsImpl?: object}} [opts]
 * @returns {Promise<{path: string, size: number, mtimeMs: number}|null>}
 */
async function findInHome(home, id, { fsImpl = fs } = {}) {
  if (typeof home !== 'string' || !home.trim()) return null;
  const io = promisesOf(fsImpl);
  const hex = id.slice('sha256:'.length);
  const prefix = hex.slice(0, 2);
  const attachRoot = path.join(home, 'attachments');

  /** @type {string[]} */
  let versions;
  try {
    const entries = await io.readdir(attachRoot, { withFileTypes: true });
    versions = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    // home 不存在 / 没有对象库：这是**正常**情况（例如网关自有 home 从没发过图）
    return null;
  }

  for (const version of versions) {
    const prefixDir = path.join(attachRoot, version, 'objects', prefix);
    let names;
    try {
      names = await io.readdir(prefixDir);
    } catch {
      continue;
    }
    // 只认**完全一致**的文件名（大小写敏感比较，与磁盘上的小写 hex 对齐）
    if (!names.includes(hex)) continue;
    const file = path.join(prefixDir, hex);
    let stat;
    try {
      stat = await io.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    return { path: file, size: stat.size, mtimeMs: stat.mtimeMs };
  }
  return null;
}

/**
 * 在若干 DSH home 根下解析一个附件。
 *
 * 顺序与去重：调用方给的 `roots` 顺序即查找顺序，**空白项与重复项先去掉**
 * （`mirror.resolvedHome` 与 `desktop.dshHome` 在默认配置下是同一个 `~/.dsh`，
 * 不去重就是白读一遍目录）。命中即返回，不做"全部搜一遍再挑"。
 *
 * @param {{id?: unknown, roots?: Array<string|null|undefined>|string|null, fsImpl?: object}} input
 * @returns {Promise<{path: string, size: number, mediaType: string}|null>}
 *   `null` 表示：id 不合法、所有根都没命中、或命中的文件不是普通文件。
 *   **超限不在这里判**（调用方要区分 404 与 413，见 §4.6 失败表）。
 */
export async function resolveAttachment({ id, roots = [], fsImpl = fs } = {}) {
  const normalized = normalizeAttachmentId(id);
  // id 不合法就**不碰文件系统**（也不校验 fsImpl：调用方可能会用"形状都不对"的输入
  // 探测这个函数，那种路径上抛参数错只会误导排障）。传错 fsImpl 的报错留给真正要读盘的那一支。
  if (!normalized) return null;
  const io = promisesOf(fsImpl);
  const list = Array.isArray(roots) ? roots : [roots];
  const seen = new Set();
  const homes = [];
  for (const root of list) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    homes.push(root);
  }

  for (const home of homes) {
    const found = await findInHome(home, normalized, { fsImpl });
    if (!found) continue;
    let mediaType = 'application/octet-stream';
    try {
      const handle = await io.open(found.path, 'r');
      try {
        const buf = Buffer.alloc(SNIFF_BYTES);
        const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
        mediaType = sniffMediaType(bytesRead === SNIFF_BYTES ? buf : buf.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    } catch {
      // 读不到前导字节（权限/竞态删除）：仍返回路径，让调用方按**实际**情况失败，
      // 不要把"能定位到文件"降级成"文件不存在"（否则排障时看不到真实原因）。
      mediaType = 'application/octet-stream';
    }
    return { path: found.path, size: found.size, mediaType };
  }
  return null;
}
