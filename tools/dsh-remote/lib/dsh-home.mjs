/**
 * 真实 DSH home 定位、会话目录 slug 编解码、会话发现。
 *
 * 为什么单独一个模块：网关自己有运行时 home（`config.home` = 凭据 + tasks + logs，
 * 默认 `~/.dsh-remote`），而**会话镜像读的是用户真实在用的那个 DSH home**
 * （默认 `%USERPROFILE%\.dsh`）。两者绝不能混为一谈 —— 混了就会出现
 * 「手机上一条会话都看不到」这种看起来像 bug、其实是路径搞错的故障。
 *
 * 真实布局（已在本机实测，含中文路径）：
 * ```
 * %USERPROFILE%\.dsh\sessions\<workspace-slug>\<session-id>\session.v4.jsonl.zstd
 * %USERPROFILE%\.dsh\sessions\--D-Workspace-dsh_android--\session-88e9459c-…\session.v4.jsonl.zstd
 * %USERPROFILE%\.dsh\sessions\--D-Workspace-~8BBA~6587--\session-78c5008b-…\session.v4.jsonl.zstd
 * ```
 * slug 编码规则（对 3 个真实目录名逐一验证过）：
 * 去掉盘符冒号、`\` 与 `/` 变 `-`、**每个非 ASCII UTF-16 码元**变为 `~` + 4 位大写十六进制、
 * 两侧包 `--`。所以 `D:\Workspace\论文` → `--D-Workspace-~8BBA~6587--`（论=8BBA 文=6587）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { scanFrames } from './zstd-multiframe.mjs';

/** 会话文件候选名（新版 zstd 追加文件优先，兼容旧版未压缩 jsonl）。 */
export const SESSION_FILE_NAMES = Object.freeze(['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']);

/**
 * 会话 id 形态：`session-<uuid>` 或裸 `<uuid>`（子代理会话是后者，实测样例
 * `session-88e9459c-…` 与 `331ad15b-b54c-4db0-81d6-ce497c589585` 都存在）。
 * 前缀必须整体可选 —— `session-?` 的写法只让连字符可选，会把裸 uuid 判成非法。
 */
export const SESSION_DIR_RE = /^(?:session-)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 解析真实 DSH home 目录。
 *
 * 优先级（前者胜出）：`explicit` > `DSH_REMOTE_MIRROR_HOME` > `DSH_HOME` > `~/.dsh`。
 * **刻意不使用网关自己的 `config.home` 作为候选**：它默认是 `~/.dsh-remote`，
 * 作为镜像源只会得到空目录；测试要隔离镜像源时请显式传 `mirror.dshHome`
 * 或设置 `DSH_HOME`，避免误读真实用户会话。
 * @param {{explicit?: string|null, env?: Record<string,string|undefined>, homedir?: string}} [opts]
 * @returns {{path: string, source: 'config'|'env-mirror'|'env-dsh-home'|'homedir'}}
 */
export function resolveDshHome({ explicit = null, env = process.env, homedir = os.homedir() } = {}) {
  if (explicit && String(explicit).trim()) return { path: path.resolve(String(explicit).trim()), source: 'config' };
  const mirror = env.DSH_REMOTE_MIRROR_HOME;
  if (mirror && mirror.trim()) return { path: path.resolve(mirror.trim()), source: 'env-mirror' };
  const dshHome = env.DSH_HOME;
  if (dshHome && dshHome.trim()) return { path: path.resolve(dshHome.trim()), source: 'env-dsh-home' };
  return { path: path.join(homedir, '.dsh'), source: 'homedir' };
}

/**
 * 编码 workspace 路径为会话目录 slug（与 DSH 自身的编码一致）。
 * @param {string} workspacePath
 * @returns {string}
 */
export function encodeWorkspaceSlug(workspacePath) {
  const resolved = path.resolve(String(workspacePath));
  let out = '';
  for (let i = 0; i < resolved.length; i++) {
    const ch = resolved[i];
    const code = resolved.charCodeAt(i);
    if (ch === ':') continue; // 盘符冒号被丢掉：D:\x → D-x
    if (ch === '\\' || ch === '/') {
      out += '-';
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
      continue;
    }
    out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `--${out}--`;
}

/**
 * 从 session header 推断 `origin`（**绝不在 origin 缺失时默认成 `user`**）。
 *
 * 为什么必须推断而不是默认 `user`（真实 home 实测，2026-10-15）：
 * 桌面端写顶层会话 header 时**不写 `origin` 字段**（135 条真实会话里 30 条顶层全无 origin），
 * 子代理会话才由 `dsh-subagent` 的 `childSessionMeta` 显式写 `origin:'subagent'`。
 * 于是「origin 缺失 ⇒ user」这条回退会把**子代理会话当成用户会话**列出去——这正是
 * 手机「电脑会话」页被刷屏的成因。DSH 桌面端 GUI 的判据也不是"缺字段就放行"，
 * 而是 `session.origin === 'subagent'` 一律隐藏，并且**另有** delegationDepth 这条
 * 独立信号（见 `dsh-workspace-changes`：`origin === "subagent" || (delegationDepth ?? 0) > 0`）。
 * 因此这里把两条信号合并：显式 origin 优先，缺失时按 `parentSession` / `delegationDepth` 推断。
 * @param {object|null|undefined} header
 * @returns {'user'|'subagent'}
 */
export function inferSessionOrigin(header) {
  const explicit = typeof header?.origin === 'string' ? header.origin.trim().toLowerCase() : '';
  if (explicit) return explicit;
  return isDerivedSession(header) ? 'subagent' : 'user';
}

/**
 * 会话的 `delegationDepth`（非负整数才认，缺失/异常一律 0）。
 * 顶层用户会话是 0；子代理会话由 `dsh-subagent` 写成 `父深度 + 1`（真实 home 实测 1 或 2）。
 * @param {object|null|undefined} header
 * @returns {number}
 */
export function delegationDepthOf(header) {
  const depth = header?.delegationDepth;
  return typeof depth === 'number' && Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0;
}

/**
 * 子代理会话：显式 `origin:'subagent'`，或 `delegationDepth > 0`（深度是权威计数，父 id 可能缺失）。
 * @param {object|null|undefined} header
 * @returns {boolean}
 */
export function isSubagentSession(header) {
  return inferOrigin(header) === 'subagent' || delegationDepthOf(header) > 0;
}

/**
 * 派生会话（**不该作为顶层会话单独列出**）：子代理会话，**或**任何带 `parentSession` 的会话。
 *
 * 为什么"有父 id"也要算派生：`parentSession` 是 fork / seeded 副本 / 子代理三条路径共用的字段，
 * 只要是别人的派生物，在手机列表里平铺就会制造"父与子同标题并列"的困惑。
 * 失败方向是刻意选的——**宁可少显示一条，也不刷屏**：这类会话在 `?include=subagent|all`
 * 时全部可见（`SessionMirror.list` 只过滤缺省情况），详情端点也仍然按 id 可达。
 * @param {object|null|undefined} header
 * @returns {boolean}
 */
export function isDerivedSession(header) {
  if (isSubagentSession(header)) return true;
  const parent = header?.parentSession;
  return typeof parent === 'string' && parent.trim().length > 0;
}

/** `origin` 的显式取值（只认非空字符串），缺失/空白/非字符串一律 null。 */
function inferOrigin(header) {
  return typeof header?.origin === 'string' && header.origin.trim() ? header.origin.trim().toLowerCase() : null;
}

/**
 * 解码 slug 回 workspace 路径（**有损**：目录名里的 `-` 与分隔符无法区分）。
 *
 * 因此优先用 `storages/workspace.json` 里的权威 `path`（见 `readWorkspaceIndex`），
 * 本函数只在缺少索引时作为兜底，并尽量验证「解码结果确实存在」。
 * @param {string} slug
 * @returns {string|null} 还原出的路径；无法还原返回 null
 */
export function decodeWorkspaceSlug(slug) {
  if (typeof slug !== 'string') return null;
  let body = slug;
  if (body.startsWith('--')) body = body.slice(2);
  if (body.endsWith('--')) body = body.slice(0, -2);
  // `~XXXX` → 该 UTF-16 码元；单独的 `~` 原样保留
  const unescaped = body.replace(/~([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const drive = /^([A-Za-z])-(.*)$/.exec(unescaped);
  if (drive) return `${drive[1].toUpperCase()}:\\${drive[2].replace(/-/g, '\\')}`;
  // POSIX：/home/u/proj → -home-u-proj
  if (unescaped.startsWith('-')) return unescaped.replace(/-/g, '/');
  return null;
}

/**
 * slug 是否与某个工作区路径匹配（用于把 slug 目录映射回真实路径）。
 * @param {string} slug
 * @param {string} workspacePath
 */
export function slugMatchesPath(slug, workspacePath) {
  return encodeWorkspaceSlug(workspacePath) === slug;
}

/**
 * 读取 DSH 的 `storages/workspace.json`，得到权威的 slug → 工作区路径映射。
 *
 * 为什么需要它：slug 编码是有损的（路径里的 `-` 与分隔符同形），
 * 而这份文件记录了 DSH 自己认为的 `path`，是唯一无歧义的来源。
 * 返回值里**新增** `workspaces`（按 `global.workspaceIds` 的显示顺序），是为了让网关能
 * 把电脑端工作区同步给手机：`paths` 只够做白名单，手机端还需要标题与稳定 id。
 * 旧的 `paths/bySlug` 字段保持不变，现有调用方（会话发现）不受影响。
 *
 * @param {string} dshHome
 * @param {{fsImpl?: object}} [opts]
 * @returns {Promise<{paths: string[], bySlug: Map<string, string>, workspaces: Array<{workspaceId: string, path: string, title: string, sessionIds: string[]}>, archivedSessionIds: string[], pinnedSessionIds: string[]}>}
 */
export async function readWorkspaceIndex(dshHome, { fsImpl = fs } = {}) {
  const file = path.join(dshHome, 'storages', 'workspace.json');
  const empty = { paths: [], bySlug: new Map(), workspaces: [], archivedSessionIds: [], pinnedSessionIds: [] };
  let raw;
  try {
    raw = JSON.parse(await fsImpl.promises.readFile(file, 'utf8'));
  } catch {
    return empty;
  }
  const table = raw?.tables?.workspaces ?? {};
  const order = Array.isArray(raw?.global?.workspaceIds) ? raw.global.workspaceIds : Object.keys(table);
  const seen = new Set();
  /** @type {Array<{workspaceId: string, path: string, title: string, sessionIds: string[]}>} */
  const workspaces = [];
  for (const workspaceId of order) {
    if (typeof workspaceId !== 'string' || seen.has(workspaceId)) continue;
    const entry = table[workspaceId];
    if (typeof entry?.path !== 'string' || !entry.path) continue;
    seen.add(workspaceId);
    workspaces.push({
      workspaceId,
      path: entry.path,
      title: typeof entry.title === 'string' && entry.title ? entry.title : path.basename(entry.path),
      sessionIds: Array.isArray(entry.sessionIds) ? entry.sessionIds.filter((id) => typeof id === 'string') : [],
    });
  }
  // `global.workspaceIds` 漏项/损坏时仍把表里其余的带上：宁可少一点顺序语义，也不丢工作区。
  for (const [workspaceId, entry] of Object.entries(table)) {
    if (seen.has(workspaceId)) continue;
    if (typeof entry?.path !== 'string' || !entry.path) continue;
    seen.add(workspaceId);
    workspaces.push({
      workspaceId,
      path: entry.path,
      title: typeof entry.title === 'string' && entry.title ? entry.title : path.basename(entry.path),
      sessionIds: Array.isArray(entry.sessionIds) ? entry.sessionIds.filter((id) => typeof id === 'string') : [],
    });
  }
  const paths = workspaces.map((entry) => entry.path);
  const bySlug = new Map();
  for (const entry of workspaces) bySlug.set(encodeWorkspaceSlug(entry.path), entry.path);
  return {
    paths,
    bySlug,
    workspaces,
    archivedSessionIds: Array.isArray(raw?.global?.archivedSessionIds) ? raw.global.archivedSessionIds : [],
    pinnedSessionIds: Array.isArray(raw?.global?.pinnedSessionIds) ? raw.global.pinnedSessionIds : [],
  };
}

/**
 * 读取会话文件的**第一个 zstd 帧**并解析出首行 header。
 * 首帧只有几百字节，列表接口对几十个会话调用它也很便宜（不必解全量 4.8 MB）。
 * @param {string} file
 * @param {{fsImpl?: object, maxBytes?: number}} [opts]
 * @returns {Promise<object|null>}
 */
export async function readSessionHeader(file, { fsImpl = fs, maxBytes = 262_144 } = {}) {
  let handle;
  try {
    handle = await fsImpl.promises.open(file, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    if (length === 0) return null;
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    const head = buf.subarray(0, bytesRead);
    if (!file.endsWith('.zstd')) {
      const line = head.toString('utf8').split('\n')[0];
      return line ? JSON.parse(line) : null;
    }
    const { frames } = scanFrames(head);
    if (frames.length === 0) return null;
    const text = zstdDecompressSync(head.subarray(frames[0].start, frames[0].end)).toString('utf8');
    const line = text.split('\n').find((l) => l.trim());
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * 发现某个 DSH home 下的全部会话。
 *
 * 返回的每一项都带 `file`（会话文件绝对路径）与 `slug`/`slugDir`；
 * `id` 以 header 为准（目录名与 header 在实测中一致，但 header 才是权威）。
 * @param {{dshHome: string, fsImpl?: object, includeSubagents?: boolean}} opts
 * @returns {Promise<Array<{id: string, file: string, slug: string, slugDir: string, dir: string, size: number, mtimeMs: number, cwd: string|null, header: object|null}>>}
 */
export async function discoverSessions({ dshHome, fsImpl = fs, includeSubagents = true }) {
  const root = path.join(dshHome, 'sessions');
  const index = await readWorkspaceIndex(dshHome, { fsImpl });
  let slugDirs;
  try {
    slugDirs = await fsImpl.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const slugEntry of slugDirs) {
    if (!slugEntry.isDirectory()) continue;
    const slug = slugEntry.name;
    const slugDir = path.join(root, slug);
    let sessionDirs;
    try {
      sessionDirs = await fsImpl.promises.readdir(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(slugDir, entry.name);
      const file = await pickSessionFile(dir, fsImpl);
      if (!file) continue;
      let stat;
      try {
        stat = await fsImpl.promises.stat(file);
      } catch {
        continue;
      }
      const header = await readSessionHeader(file, { fsImpl });
      const origin = inferSessionOrigin(header);
      // 默认（`includeSubagents:false`）只列**顶层用户会话**：origin 缺失时靠 parentSession /
      // delegationDepth 推断，不再像旧代码那样只看 origin（那会让缺 origin 的派生会话漏出去）。
      // 显式 `includeSubagents:true` 时全部返回——手机「含子代理」开关与 `?include=subagent|all`
      // 都靠它，所以过滤**只能**发生在这一个开关上。
      if (!includeSubagents && isDerivedSession(header)) continue;
      const cwd = typeof header?.cwd === 'string' && header.cwd ? header.cwd : null;
      found.push({
        id: typeof header?.id === 'string' && header.id ? header.id : entry.name,
        file,
        slug,
        slugDir,
        dir,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
        cwd,
        // 优先用 workspace.json 的权威路径，其次才是有损解码
        workspace: (cwd && path.resolve(cwd)) || index.bySlug.get(slug) || decodeWorkspaceSlug(slug),
        origin,
        parentSession: header?.parentSession ?? null,
        isSeeded: header?.isSeeded === true,
        agentPreset: header?.agentPreset ?? null,
        header,
      });
    }
  }
  return found;
}

/** 在会话目录里挑出会话文件（优先 zstd 追加文件）。 */
async function pickSessionFile(dir, fsImpl) {
  for (const name of SESSION_FILE_NAMES) {
    const candidate = path.join(dir, name);
    try {
      if ((await fsImpl.promises.stat(candidate)).isFile()) return candidate;
    } catch {
      /* 继续尝试下一个候选名 */
    }
  }
  return null;
}

/**
 * 按 id 精确定位会话（避免全量扫描）。
 *
 * 目录名与 id 在实测中一致，因此可以直接拼路径；拼不出来时退回全量发现。
 * @param {{dshHome: string, id: string, workspace?: string|null, fsImpl?: object}} opts
 * @returns {Promise<{id, file, slug, slugDir, dir, size, mtimeMs, cwd, workspace, origin, header}|null>}
 */
export async function findSession({ dshHome, id, workspace = null, fsImpl = fs }) {
  if (typeof id !== 'string' || !id.trim()) return null;
  const clean = id.trim();
  // 防路径穿越：id 必须是会话 id 形态，绝不接受 `..` 或分隔符
  if (clean.includes('/') || clean.includes('\\') || clean.includes('..')) return null;
  if (!SESSION_DIR_RE.test(clean)) return null;

  const candidates = [];
  if (workspace) candidates.push(encodeWorkspaceSlug(workspace));
  try {
    const entries = await fsImpl.promises.readdir(path.join(dshHome, 'sessions'), { withFileTypes: true });
    for (const entry of entries) if (entry.isDirectory()) candidates.push(entry.name);
  } catch {
    /* 没有 sessions 目录：只试 workspace 推出的那个 slug */
  }
  for (const slug of [...new Set(candidates)]) {
    const dir = path.join(dshHome, 'sessions', slug, clean);
    const file = await pickSessionFile(dir, fsImpl);
    if (!file) continue;
    let stat;
    try {
      stat = await fsImpl.promises.stat(file);
    } catch {
      continue;
    }
    const header = await readSessionHeader(file, { fsImpl });
    return {
      id: typeof header?.id === 'string' ? header.id : clean,
      file,
      slug,
      slugDir: path.join(dshHome, 'sessions', slug),
      dir,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
      cwd: typeof header?.cwd === 'string' ? header.cwd : null,
      workspace: typeof header?.cwd === 'string' && header.cwd ? path.resolve(header.cwd) : decodeWorkspaceSlug(slug),
      origin: inferSessionOrigin(header),
      parentSession: header?.parentSession ?? null,
      isSeeded: header?.isSeeded === true,
      agentPreset: header?.agentPreset ?? null,
      header,
    };
  }
  return null;
}
