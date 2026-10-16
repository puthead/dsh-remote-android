/**
 * 工作区文件系统：目录树 / 文件内容 / 搜索（契约 §4.3）。
 *
 * ## 路径安全（契约 §4.3 硬性规则 + 2026-10-14 读/写分流裁定）
 * 手机传来的 `path` 完全不可信，因此这里做**四道**检查：
 * 1. **拒绝 UNC**（`\\\\server\\share`、`//server/share`）：UNC 是逃出白名单的经典手法；
 * 2. **拒绝 NTFS 备用数据流**：盘符之后的 `:`（如 `notes.txt:secret`）也要挡掉；
 * 3. **词法包含检查**：`path.resolve` 后必须仍在工作区根之下，`..` 穿越在这里就死掉；
 * 4. **realpath 逃逸检查**：`fs.realpath` 解析符号链接/目录联接后的落点是否还受白名单约束。
 *
 * ### 第 4 道为什么必须按读/写分流（[WRITE] / [READ]）
 * 用户诉求原话是「工作区目录下的文件夹要都可以访问」。而 npm 装出来的工作区里到处是
 * **指向工作区之外的目录联接**（junction，Windows 上 `dirent.isDirectory()` 返回 false，
 * 只有 `lstat().isSymbolicLink()` 为真）：实测本仓库 3063 个重解析点，其中 3060 个逃到
 * `C:\\Users\\Administrator\\AppData\\Local\\npm-cache\\…`，例如
 * `D:\\Workspace\\dsh_android\\.runtime\\acceptance\\profiles\\node_modules\\accepts`。
 * 旧实现（第 4 道一律 throw）让这些目录**点不进去也读不了**，这就是"工作区里的文件夹进不去"。
 *
 * - **[READ]（`mode: 'read'`：list / read / search）**：只要求第 3 道（词法在根内）通过，
 *   I/O 走**词法路径**、顺着链接读，并允许链接落到根外 —— 可以读，但**绝不写**。
 *   链接离开根时额外回报 `escaped:true` + `escapedTo`，让手机端能显示"实际读的是哪里"。
 * - **[WRITE]（`mode: 'write'`：diff / 将来的写入类端点）**：第 4 道照旧严格 ——
 *   realpath 解析后必须仍在白名单条目内，否则拒绝。安全性一行不减：
 *   读放行不等于写放行，`escaped:true` 的路径写请求依旧拿不到。
 *
 * 第 4 道对着**白名单条目**而不是工作区根再查一次的原因不变：
 * 工作区本身可能是白名单条目的子目录（`workspace` 允许传子目录），
 * 对白名单条目做 realpath 检查才能保证"最终落点"永远受白名单约束。
 *
 * **错误码必须能区分**（否则手机端只能给出"路径在工作区之外"这种误导性文案）：
 * `workspace_outside` = 词法/词法外越界（真越界）；`workspace_symlink_escape` = 落在根外、
 * 且是经链接出去的（读放行、写拒绝的正是这一类）；`workspace_not_allowlisted` = 落点跑到
 * 白名单之外。三者在 `WorkspaceError` 上走同一个 403，但文案与 code 都不同。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isWithin } from './workspace.mjs';

/** 单目录条目上限（契约 §4.3：超出置 truncated）。 */
export const MAX_ENTRIES = 2000;
/** `depth` 上限（契约 §4.3）。 */
export const MAX_DEPTH = 4;
/** 文本文件读取上限（超出置 truncated）。 */
export const MAX_FILE_BYTES = 1024 * 1024;
/** 判定二进制前要看的字节数。 */
const BINARY_SNIFF_BYTES = 8192;

/** 越界/非法路径统一用这个错误码（契约 §4.4）。 */
export class WorkspaceError extends Error {
  /**
   * @param {'workspace_outside'|'workspace_symlink_escape'|'workspace_not_allowlisted'|'bad_request'|'not_found'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

/**
 * 访问模式（见文件头 [READ] / [WRITE] 裁定）。
 * - `read`：list / read / search —— 按"词法在根内"放行，允许顺链接读根外；
 * - `write`：必须 realpath 后仍受白名单约束。
 */
export const READ_MODE = 'read';
export const WRITE_MODE = 'write';

/** 绝对路径是否为 UNC。 */
export function isUncPath(p) {
  if (typeof p !== 'string') return false;
  return /^\\\\/.test(p) || /^\/\//.test(p);
}

/**
 * 拒绝 NTFS 备用数据流 / 非法盘符形态：`D:\a\b:c` 这类写法会让「文件名」带冒号。
 * 合法的盘符冒号只出现在 `^[A-Za-z]:` 的第二个字符。
 */
export function hasAlternateDataStream(p) {
  if (typeof p !== 'string') return false;
  const withoutDrive = /^[A-Za-z]:/.test(p) ? p.slice(2) : p;
  return withoutDrive.includes(':');
}

/**
 * 「这个真实落点算不算经链接逃逸到工作区之外」。
 *
 * 只在真实路径**既不在工作区根内、也不在任何白名单条目内**时才算逃逸：
 * 工作区之间互相链接（白名单条目 A 里放一个指向白名单条目 B 的 junction）是用户
 * 自己配的可信关系，不该让手机端弹"读到工作区之外"的警告；
 * 但如果白名单为空（默认拒绝语义），则一律按逃逸回报，宁可多提示不可少提示。
 */
function isEscapedReal(realPath, rootReal, allowReal) {
  if (isWithin(realPath, rootReal)) return false;
  if (allowReal.length === 0) return true;
  return !allowReal.some((base) => isWithin(realPath, base));
}

/**
 * 相对工作区根的路径，分隔符统一成 `/`（根自身为 `.`）。
 * 为什么必须归一：Windows 的 `path.relative` 产出 `a\b`，而 `listDirectory` 用 `/`
 * 拼 `entries[].relative`；两个端点对同一位置给出两种字符串会让手机端面包屑/回跳对不上。
 */
function toPosixRelative(root, target) {
  const rel = path.relative(root, target);
  if (!rel) return '.';
  return rel.split(path.sep).join('/');
}

/** realpath（失败返回 null）。 */
async function realpathOrNull(p, fsImpl) {
  try {
    return await fsImpl.promises.realpath(p);
  } catch {
    return null;
  }
}

/** 找到「存在的最近祖先」并 realpath 它（用于 mustExist=false 的写入/展示场景）。 */
async function realpathNearestAncestor(target, fsImpl) {
  let current = path.resolve(target);
  for (;;) {
    const real = await realpathOrNull(current, fsImpl);
    if (real) return { real, existed: current === path.resolve(target) };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 把请求里的 `path` 解析成工作区内的真实路径，并完成全部安全校验。
 *
 * @param {{requestPath?: string|null, workspace: string, allowlist: string[], fsImpl?: object, mustExist?: boolean, expect?: 'any'|'file'|'dir', mode?: 'read'|'write'}} opts
 * @returns {Promise<{path: string, realPath: string, lexicalPath: string, workspace: string, isDir: boolean, isFile: boolean, isSymlink: boolean, escaped: boolean, escapedTo: string|null, size: number, modifiedAt: number, relative: string}>}
 *   - `path`：解析后的落点。**默认取 realpath**，保持修复前的对外契约不变
 *     （`v2.test.mjs` 的 `resolveTarget：工作区内放行` 就断言 `target.path` 是 realpath）；
 *   - `realPath`：与 `path` 同源，保留旧字段名，调用方（http.mjs 的 changes/diff）在用；
 *   - `lexicalPath`：**词法**落点（`candidate`，未做 realpath）。要按用户给的路径做 I/O、
 *     或要把"链接名"原样当路径用时取这个；`listDirectory`/`readFileEntry`/`searchWorkspace`
 *     内部固定用它，这样链接目录里的条目路径不会被替换成真实目录名；
 *   - `escaped` / `escapedTo`：realpath 跑出工作区根（即"经链接逃逸"）时为真，
 *     `escapedTo` 是逃逸后的真实落点，供手机端提示"实际读的是哪里"。
 *     `escaped` 为真时 `path === realPath === escapedTo`（落点就是外面那个真实目录）。
 * @throws {WorkspaceError}
 */
export async function resolveTarget({
  requestPath = null,
  workspace,
  allowlist = [],
  fsImpl = fs,
  mustExist = true,
  expect = 'any',
  mode = WRITE_MODE,
}) {
  if (!workspace) throw new WorkspaceError('bad_request', '缺少 workspace');
  const rootReal = (await realpathOrNull(workspace, fsImpl)) ?? path.resolve(workspace);
  const rootLexical = path.resolve(workspace);
  const allowEscapes = mode === READ_MODE;

  // 白名单的 realpath 集合（越界判定对着它做）
  const allowReal = [];
  for (const entry of allowlist) {
    const resolved = path.resolve(entry);
    allowReal.push((await realpathOrNull(resolved, fsImpl)) ?? resolved);
  }
  const allowed = (p) => allowReal.some((base) => isWithin(p, base));
  if (allowReal.length > 0 && !allowed(rootReal)) {
    throw new WorkspaceError('workspace_outside', `工作区不在白名单内：${rootReal}`);
  }

  const raw = typeof requestPath === 'string' ? requestPath.trim() : '';
  if (raw && isUncPath(raw)) {
    throw new WorkspaceError('workspace_outside', `拒绝 UNC 路径：${raw}`);
  }
  if (raw && hasAlternateDataStream(raw)) {
    throw new WorkspaceError('workspace_outside', `拒绝含备用数据流的路径：${raw}`);
  }

  const candidate = raw === '' ? rootLexical : path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootLexical, raw);

  // 第 3 道：词法包含（`..` 穿越在这里就失败，不必碰文件系统）。
  // 读/写共用：用户要"工作区里的文件夹都能访问"，前提仍是这个文件夹在**工作区内**。
  if (!isWithin(candidate, rootLexical)) {
    throw new WorkspaceError('workspace_outside', `路径越界（不在工作区内）：${candidate}`);
  }

  let real = await realpathOrNull(candidate, fsImpl);
  let existed = real !== null;
  let isSymlink = false;
  let escapedTo = null;
  if (real === null) {
    if (mustExist) throw new WorkspaceError('not_found', `路径不存在或不可访问：${candidate}`);
    const nearest = await realpathNearestAncestor(candidate, fsImpl);
    if (!nearest) throw new WorkspaceError('not_found', `路径不存在或不可访问：${candidate}`);
    real = path.join(nearest.real, path.relative(path.resolve(path.dirname(candidate)), candidate));
  } else {
    // 第 4 道：realpath 落点检查（读/写分流，见文件头）
    const inRootReal = isWithin(real, rootReal);
    const inAllowReal = allowed(real);
    // escaped 的**唯一**判据是 isEscapedReal（根外 + 白名单外），
    // 不能写成"real ≠ candidate 就算逃逸"：白名单之间互链、工作区自身是链接
    // 这类情况 real 与 candidate 本就不同，但并不"跑到工作区之外"。
    const escaped = isEscapedReal(real, rootReal, allowReal);
    if (!escaped) {
      // 落点仍在（根 或 白名单）之内：读/写都放行，无需额外提示
    } else if (allowEscapes) {
      // [READ] 放行（用户要求"工作区里的文件夹都能访问"），但如实回报读到哪了
      escapedTo = real;
    } else if (!inAllowReal) {
      // [WRITE] 落点已在白名单之外 —— 典型的"工作区里放个指向 C:\\Windows 的软链"
      throw new WorkspaceError('workspace_symlink_escape', `路径经符号链接解析后越界：${real}`);
    } else {
      // [WRITE] 落点还在白名单内（例如嵌套的白名单工作区），但靠链接离开了本工作区
      throw new WorkspaceError('workspace_not_allowlisted', `路径越界（不在白名单内）：${real}`);
    }
  }

  let stat = null;
  try {
    stat = await fsImpl.promises.lstat(candidate);
    isSymlink = stat.isSymbolicLink();
    if (isSymlink || !existed) stat = await fsImpl.promises.stat(candidate).catch(() => stat);
  } catch {
    stat = null;
  }
  if (expect === 'file' && stat && !stat.isFile() && !isSymlink) throw new WorkspaceError('bad_request', `不是文件：${raw}`);
  if (expect === 'dir' && stat && !stat.isDirectory() && !isSymlink) throw new WorkspaceError('bad_request', `不是目录：${raw}`);

  const isDir = Boolean(stat?.isDirectory());
  const isFile = Boolean(stat?.isFile());
  if (expect === 'dir' && existed && !isDir) throw new WorkspaceError('bad_request', `不是目录：${raw}`);
  if (expect === 'file' && existed && !isFile) throw new WorkspaceError('bad_request', `不是文件：${raw}`);

  return {
    path: real,
    realPath: real,
    lexicalPath: candidate,
    workspace: rootReal,
    isDir,
    isFile,
    isSymlink,
    escaped: escapedTo !== null,
    escapedTo,
    size: stat?.size ?? null,
    modifiedAt: stat ? Math.round(stat.mtimeMs) : null,
    // 相对路径统一用 `/`（与 listDirectory 的 `entries[].relative`、手机端面包屑同一套写法）；
    // Windows 上 path.relative 给的是 `\`，直接透传会让两端对"同一个相对路径"给出两种字符串。
    relative: toPosixRelative(rootLexical, candidate),
  };
}

/** 目录条目类型（契约 §4.3 枚举）。 */
export function entryType(dirent, stats) {
  // 判据必须**以跟随后的 stat 优先**：Windows 的目录联接（junction）在 dirent 上是
  // isSymbolicLink() === true / isDirectory() === false，只有 stat() 才看得出它是目录。
  // 这个 type 直接决定手机端"点进去看目录"还是"当文件打开"
  // （ModelsV2.kt 的 isDir = type == "dir"，WorkspaceScreen.kt 的 onClick 分支），
  // 把 junction 报成 symlink 会让工作区里所有 npm/pnpm 链接目录点一下就 400「不是文件」
  // —— 2026-10-15 真机（模拟器经公网中继连真实网关）实测到的就是这个。
  if (stats?.isDirectory()) return 'dir'; // junction / 目录符号链接
  if (dirent.isDirectory()) return 'dir'; // 普通目录
  if (dirent.isSymbolicLink()) return 'symlink'; // 指向文件的链接、断链
  if (dirent.isFile() || stats?.isFile()) return 'file';
  return 'other';
}

/**
 * 目录树（契约 §4.3 `GET /workspaces/files`）。
 *
 * 读语义（文件头 [READ]）：递归**顺着词法路径**下钻，链接（junction/符号链接）目录
 * 也能列进去；`depth` 之外不再展开，但不影响手机逐层进入（手机每点一层发一次 `depth=1`）。
 *
 * `entries[i].escaped/escapedTo`：该条目经链接落到了工作区根外。
 *
 * @param {{workspace: string, allowlist: string[], requestPath?: string|null, depth?: number, showHidden?: boolean, fsImpl?: object, maxEntries?: number}} opts
 */
export async function listDirectory({ workspace, allowlist, requestPath = null, depth = 1, showHidden = false, fsImpl = fs, maxEntries = MAX_ENTRIES }) {
  const target = await resolveTarget({ requestPath, workspace, allowlist, fsImpl, mustExist: true, expect: 'dir', mode: READ_MODE });
  const wantDepth = Math.min(MAX_DEPTH, Math.max(1, Number.isInteger(Number(depth)) ? Number(depth) : 1));
  // 条目的"逃逸"判定要和 resolveTarget 用同一份白名单 realpath 集合（口径必须一致）
  const allowReal = [];
  for (const entry of allowlist) {
    const resolved = path.resolve(entry);
    allowReal.push((await realpathOrNull(resolved, fsImpl)) ?? resolved);
  }
  const entries = [];
  let truncated = false;

  /** 递归收集（depth-first，受 maxEntries 限制）。 */
  const walk = async (dirPath, level, prefixRel) => {
    if (truncated) return;
    let dirents;
    try {
      dirents = await fsImpl.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    const visible = showHidden ? dirents : dirents.filter((d) => !d.name.startsWith('.'));
    visible.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    for (const dirent of visible) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const childPath = path.join(dirPath, dirent.name);
      let stat = null;
      try {
        stat = await fsImpl.promises.stat(childPath);
      } catch {
        stat = null;
      }
      const type = entryType(dirent, stat);
      const rel = prefixRel ? `${prefixRel}/${dirent.name}` : dirent.name;
      // 链接目录（junction）在 Windows 上 dirent 不报 isDirectory，只有 stat 能看出是目录：
      // 因此"能不能下钻"按 stat.isDirectory() 判断，否则链接目录永远列不到下一层。
      const isDirLike = Boolean(stat?.isDirectory());
      const childReal = (await realpathOrNull(childPath, fsImpl)) ?? childPath;
      const escaped = isEscapedReal(childReal, target.workspace, allowReal);
      entries.push({
        name: dirent.name,
        path: childPath,
        relative: rel,
        type,
        size: isDirLike ? null : stat?.size ?? null,
        modifiedAt: stat ? Math.round(stat.mtimeMs) : null,
        depth: level,
        escaped,
        escapedTo: escaped ? childReal : null,
      });
      if (isDirLike && level < wantDepth) await walk(childPath, level + 1, rel);
    }
  };

  await walk(target.lexicalPath, 1, '');
  return {
    workspace: target.workspace,
    path: target.lexicalPath,
    escaped: target.escaped,
    escapedTo: target.escapedTo,
    entries,
    truncated,
    depth: wantDepth,
    showHidden,
  };
}

/** 嗅探二进制（出现 NUL 字节即认为是二进制）。 */
export function looksBinary(buffer) {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true;
  return false;
}

/**
 * 单文件内容 / 二进制元数据（契约 §4.3 `GET /workspaces/files/file`）。
 *
 * 读语义（文件头 [READ]）：I/O 走词法路径，工作区里指向根外的软链文件也能读；
 * 该文件经链接落到根外时回报 `escaped:true` + `escapedTo`，并附一句中文提示。
 *
 * @param {{workspace: string, allowlist: string[], requestPath: string, fsImpl?: object, maxBytes?: number, encoding?: string}} opts
 */
export async function readFileEntry({ workspace, allowlist, requestPath, fsImpl = fs, maxBytes = MAX_FILE_BYTES, encoding = 'utf8' }) {
  const target = await resolveTarget({ requestPath, workspace, allowlist, fsImpl, mustExist: true, expect: 'file', mode: READ_MODE });
  const filePath = target.lexicalPath;
  const stat = await fsImpl.promises.stat(filePath);
  const head = Buffer.allocUnsafe(Math.min(stat.size, BINARY_SNIFF_BYTES));
  if (head.length > 0) {
    const handle = await fsImpl.promises.open(filePath, 'r');
    try {
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
  }
  const base = {
    workspace: target.workspace,
    // 回显**用户输入**的那个路径（链接名原样保留）：手机端点开的文件在链接目录里时，
    // 若这里换成真实路径，界面上的位置会和用户点的那一项对不上
    path: target.lexicalPath,
    realPath: target.realPath,
    name: path.basename(filePath),
    size: stat.size,
    modifiedAt: Math.round(stat.mtimeMs),
    truncated: false,
    escaped: target.escaped,
    escapedTo: target.escapedTo,
    escapedNote: target.escaped ? `该文件经符号链接/目录联接读到工作区之外：${target.escapedTo}（只读放行，写入仍被拒绝）` : null,
  };
  if (looksBinary(head)) {
    return { ...base, binary: true, text: null, encoding: null, lines: null, mime: guessMime(filePath) };
  }
  const buf = await fsImpl.promises.readFile(filePath);
  const truncated = buf.length > maxBytes;
  const slice = truncated ? buf.subarray(0, maxBytes) : buf;
  const text = slice.toString(encoding);
  return {
    ...base,
    binary: false,
    text,
    encoding,
    truncated,
    lines: text.length === 0 ? 0 : text.split('\n').length,
    mime: guessMime(filePath),
  };
}

/** 极简 MIME 猜测（只覆盖手机端会高亮的几类，不引入依赖）。 */
export function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  const table = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.jsonl': 'application/x-ndjson',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.ts': 'text/typescript',
    '.kt': 'text/x-kotlin', '.java': 'text/x-java', '.xml': 'application/xml', '.yml': 'application/yaml',
    '.yaml': 'application/yaml', '.ps1': 'text/x-powershell', '.sh': 'text/x-shellscript', '.gradle': 'text/x-gradle',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.apk': 'application/vnd.android.package-archive', '.zip': 'application/zip', '.pdf': 'application/pdf',
  };
  return table[ext] ?? 'application/octet-stream';
}

/** 搜索时默认跳过的目录名（避免把 node_modules/.git 拖进来）。 */
export const DEFAULT_SKIP_DIRS = Object.freeze(new Set(['.git', 'node_modules', 'build', 'dist', '.gradle', '.idea', '.toolchain', '.runtime', 'out', 'target', '__pycache__', '.venv']));

/**
 * 文件名/内容轻量搜索（契约 §4.3 `GET /workspaces/search`）。
 *
 * 有界设计（为什么必须）：手机端一次搜索可能触发遍历几十万个文件，
 * 因此同时限制 **深度 / 文件数 / 单文件字节 / 总耗时**，任一超出即停止并置 `truncated`。
 * @param {{workspace: string, allowlist: string[], q: string, requestPath?: string|null, limit?: number, fsImpl?: object, now?: () => number, budgetMs?: number, maxFiles?: number, maxFileBytes?: number, skipDirs?: Set<string>}} opts
 */
export async function searchWorkspace({
  workspace,
  allowlist,
  q,
  requestPath = null,
  limit = 50,
  fsImpl = fs,
  now = Date.now,
  budgetMs = 5000,
  maxFiles = 20_000,
  maxFileBytes = 2 * 1024 * 1024,
  skipDirs = DEFAULT_SKIP_DIRS,
}) {
  const needle = typeof q === 'string' ? q.trim() : '';
  if (!needle) throw new WorkspaceError('bad_request', '缺少查询词 q');
  const target = await resolveTarget({ requestPath, workspace, allowlist, fsImpl, mustExist: true, mode: READ_MODE });
  const deadline = now() + budgetMs;
  const lowerNeedle = needle.toLowerCase();
  const matches = [];
  let scanned = 0;
  let truncated = false;
  // 搜索是唯一会"自己往下钻"的读端点，而 READ 模式会顺链接走 ——
  // 必须按 realpath 记已访问目录，否则 `dir -> ..` 这类链接会造成无限递归。
  // 实测本仓库有 3063 个重解析点，其中大量指向同一 npm-cache 目录，去重也顺带省掉重复扫描。
  const visitedDirs = new Set();

  const walk = async (dirPath) => {
    if (truncated) return;
    if (now() > deadline || scanned >= maxFiles) {
      truncated = true;
      return;
    }
    const dirReal = (await realpathOrNull(dirPath, fsImpl)) ?? dirPath;
    if (visitedDirs.has(dirReal)) return;
    visitedDirs.add(dirReal);
    let dirents;
    try {
      dirents = await fsImpl.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (truncated) return;
      if (dirent.name.startsWith('.')) continue;
      const childPath = path.join(dirPath, dirent.name);
      // 链接目录 dirent 不报 isDirectory，用 stat 兜底，否则 npm 装出来的 junction 搜不进去
      const isDirLike = dirent.isDirectory() || (dirent.isSymbolicLink() && (await isDirectoryOrFalse(childPath, fsImpl)));
      if (isDirLike) {
        if (skipDirs.has(dirent.name)) continue;
        await walk(childPath);
        continue;
      }
      scanned += 1;
      if (scanned % 200 === 0 && now() > deadline) {
        truncated = true;
        return;
      }
      // 文件名命中
      if (dirent.name.toLowerCase().includes(lowerNeedle)) {
        matches.push({ path: childPath, relative: toPosixRelative(target.lexicalPath, childPath), type: 'name', line: null, snippet: dirent.name });
        if (matches.length >= limit) {
          truncated = true;
          return;
        }
      }
      // 内容命中（只读小文件、跳过明显二进制扩展名）
      if (!dirent.isFile()) continue;
      let stat;
      try {
        stat = await fsImpl.promises.stat(childPath);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes) continue;
      if (isProbablyBinaryExt(dirent.name)) continue;
      let buf;
      try {
        buf = await fsImpl.promises.readFile(childPath);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      const text = buf.toString('utf8');
      if (!text.toLowerCase().includes(lowerNeedle)) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const at = lines[i].toLowerCase().indexOf(lowerNeedle);
        if (at === -1) continue;
        matches.push({
          path: childPath,
          relative: toPosixRelative(target.lexicalPath, childPath),
          type: 'content',
          line: i + 1,
          column: at + 1,
          snippet: lines[i].trim().slice(0, 400),
        });
        if (matches.length >= limit) {
          truncated = true;
          return;
        }
        break; // 一个文件最多报一条内容命中，避免刷屏
      }
    }
  };

  await walk(target.lexicalPath);
  return {
    workspace: target.workspace,
    path: target.lexicalPath,
    query: needle,
    matches,
    truncated,
    scanned,
    scannedDirs: visitedDirs.size,
    escaped: target.escaped,
    escapedTo: target.escapedTo,
  };
}

/** stat 判目录（失败按"不是目录"处理）。 */
async function isDirectoryOrFalse(p, fsImpl) {
  try {
    return (await fsImpl.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 明显是二进制的扩展名（避免白读大文件）。 */
function isProbablyBinaryExt(name) {
  return /\.(png|jpe?g|gif|webp|ico|bmp|zip|gz|tar|7z|apk|aar|jar|dex|so|dll|exe|pdf|woff2?|ttf|otf|mp4|mp3|zstd)$/i.test(name);
}
