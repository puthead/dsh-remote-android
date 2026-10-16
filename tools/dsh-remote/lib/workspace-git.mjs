/**
 * 工作区 git 状态 / 分支 / diff（契约 §4.3）。
 *
 * 两个硬性要求：
 * 1. **非 git 目录必须优雅降级**为 `{vcs:'none', changed:[], branch:null, clean:null}`，绝不报错 ——
 *    手机端浏览工作区时不该因为某个目录不是仓库就整页失败。
 * 2. **绝不经 shell**：`git` 用 argv 数组 spawn，cwd 固定为工作区，避免手机传来的路径被解释成命令。
 *
 * 状态码映射（`git status --porcelain=v1 -z`）：
 * 每条形如 `XY <path>\0`，X = 暂存区状态、Y = 工作区状态：
 * - `??` → 未跟踪（契约放在 `untracked` 数组里，不进 `changed`）
 * - 其余 → `changed`，`status` 取 X/Y 中非空格的那个（优先暂存位），`staged` = X 不是空格或 `?`
 * 增删行数来自 `git diff --numstat`（工作区）+ `git diff --cached --numstat`（暂存），按路径相加。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

/** 非 git 目录的标准降级响应。 */
export function noneVcs(workspace) {
  return { workspace, vcs: 'none', branch: null, changed: [], untracked: [], clean: null, insertions: 0, deletions: 0, error: null };
}

/**
 * 执行一条命令并收集输出（argv 数组，绝不经 shell）。
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string, timeoutMs?: number, spawnImpl?: Function, env?: object, maxBytes?: number}} opts
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, failed: boolean, timedOut: boolean, spawnError: Error|null}>}
 */
export function runCommand(command, args, { cwd, timeoutMs = 15_000, spawnImpl = spawn, env = null, maxBytes = 8 * 1024 * 1024 } = {}) {
  // 防御：HTTP 层透传的 `spawnImpl` 可能是 null（v1 用它允许测试注入替身），
  // 直接传给 spawn 会抛 "spawnImpl is not a function"，被 catch 后表现为
  // "工作区不是 git 仓库" —— 一个看起来像环境问题、实则是参数透传的假故障（e2e 实测踩到）。
  const doSpawn = typeof spawnImpl === 'function' ? spawnImpl : spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = doSpawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: env ?? process.env,
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err?.message ?? err), failed: true, timedOut: false, spawnError: err });
      return;
    }
    const out = [];
    const errs = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      size += Buffer.byteLength(chunk, 'utf8');
      if (size <= maxBytes) out.push(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => errs.push(chunk));
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.on('error', (err) => done({ code: null, stdout: out.join(''), stderr: errs.join('') || String(err.message), failed: true, timedOut, spawnError: err }));
    child.on('close', (code) => done({ code: code ?? null, stdout: out.join(''), stderr: errs.join(''), failed: code !== 0, timedOut, spawnError: null }));
  });
}

/**
 * 读取工作区 git 状态。
 * @param {{workspace: string, spawnImpl?: Function, timeoutMs?: number, command?: string}} opts
 * @returns {Promise<object>} 契约 §4.3 的 changes 响应体
 */
export async function gitStatus({ workspace, spawnImpl = spawn, timeoutMs = 15_000, command = 'git' }) {
  const opts = { cwd: workspace, spawnImpl, timeoutMs };
  const probe = await runCommand(command, ['rev-parse', '--is-inside-work-tree'], opts);
  if (probe.spawnError || probe.code !== 0 || probe.stdout.trim() !== 'true') {
    // git 不存在 / 不是仓库：都降级，不报错
    return noneVcs(workspace);
  }

  const [branchRes, statusRes, numstatRes, cachedNumstatRes] = await Promise.all([
    runCommand(command, ['rev-parse', '--abbrev-ref', 'HEAD'], opts),
    runCommand(command, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], opts),
    runCommand(command, ['diff', '--numstat', '-z'], opts),
    runCommand(command, ['diff', '--cached', '--numstat', '-z'], opts),
  ]);

  if (statusRes.spawnError) return noneVcs(workspace);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;
  const { changed, untracked } = parsePorcelainZ(statusRes.stdout);
  const stats = mergeNumstat([parseNumstatZ(numstatRes.stdout), parseNumstatZ(cachedNumstatRes.stdout)]);

  const changedOut = changed.map((item) => {
    const key = normalizeKey(item.path);
    const s = stats.get(key);
    return {
      path: item.path,
      status: item.status,
      staged: item.staged,
      insertions: s?.insertions ?? 0,
      deletions: s?.deletions ?? 0,
      isBinary: s?.isBinary ?? false,
    };
  });

  let insertions = 0;
  let deletions = 0;
  for (const item of changedOut) {
    insertions += item.insertions;
    deletions += item.deletions;
  }
  return {
    workspace,
    vcs: 'git',
    branch,
    changed: changedOut,
    untracked,
    clean: changedOut.length === 0 && untracked.length === 0,
    insertions,
    deletions,
    error: null,
  };
}

/** 归一化路径键（Windows 大小写不敏感）。 */
function normalizeKey(p) {
  const normalized = String(p).replace(/\//g, '\\');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 解析 `git status --porcelain=v1 -z`。
 * 每个记录以 NUL 分隔；重命名/复制记录后面还跟一个 NUL 分隔的原路径。
 * @param {string} raw
 */
export function parsePorcelainZ(raw) {
  if (!raw) return { changed: [], untracked: [] };
  const parts = raw.split('\0');
  const changed = [];
  const untracked = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(file);
      continue;
    }
    const rename = x === 'R' || y === 'R' || x === 'C' || y === 'C';
    if (rename) i += 1; // 跳过原路径
    const staged = x !== ' ' && x !== '?';
    const status = x !== ' ' && x !== '?' ? x : y;
    changed.push({ path: file, status: status.trim() || 'M', staged });
  }
  return { changed, untracked };
}

/**
 * 解析 `git diff --numstat -z`。
 * 记录形状：`<ins>\t<del>\t<path>\0`；二进制时 ins/del 都是 `-`。
 * 重命名时 z 模式下还会带一个 NUL 分隔的原路径。
 * @param {string} raw
 */
export function parseNumstatZ(raw) {
  const out = new Map();
  if (!raw) return out;
  const parts = raw.split('\0').filter((s) => s.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const tab = entry.indexOf('\t');
    const tab2 = entry.indexOf('\t', tab + 1);
    if (tab === -1 || tab2 === -1) continue;
    const insRaw = entry.slice(0, tab);
    const delRaw = entry.slice(tab + 1, tab2);
    let file = entry.slice(tab2 + 1);
    if (file === '') {
      // 重命名：路径在下一个记录里
      file = parts[++i] ?? '';
    }
    if (!file) continue;
    const isBinary = insRaw === '-' && delRaw === '-';
    out.set(normalizeKey(file), {
      insertions: isBinary ? 0 : Number(insRaw) || 0,
      deletions: isBinary ? 0 : Number(delRaw) || 0,
      isBinary,
    });
  }
  return out;
}

/** 合并两组 numstat（工作区 + 暂存），相加。 */
export function mergeNumstat(maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, value] of map) {
      const prev = merged.get(key) ?? { insertions: 0, deletions: 0, isBinary: false };
      merged.set(key, {
        insertions: prev.insertions + value.insertions,
        deletions: prev.deletions + value.deletions,
        isBinary: prev.isBinary || value.isBinary,
      });
    }
  }
  return merged;
}

/**
 * 单文件 unified diff（契约 §4.3 `GET /workspaces/diff`）。
 *
 * 已跟踪文件：`git diff [--cached] -- <file>`；
 * 未跟踪文件：git 没有"基线"，用 `--no-index /dev/null <file>` 生成「全新增」diff
 * （该命令对"有差异"返回 1，是**预期**而非失败，因此单独判定）。
 * @param {{workspace: string, file: string, relative?: string|null, spawnImpl?: Function, timeoutMs?: number, command?: string, maxBytes?: number}} opts
 * @returns {Promise<{workspace: string, vcs: string, file: string, diff: string, truncated: boolean, binary: boolean, status: string|null}>}
 */
export async function gitDiff({ workspace, file, relative = null, spawnImpl = spawn, timeoutMs = 15_000, command = 'git', maxBytes = 512 * 1024 }) {
  const opts = { cwd: workspace, spawnImpl, timeoutMs };
  const probe = await runCommand(command, ['rev-parse', '--is-inside-work-tree'], opts);
  if (probe.spawnError || probe.code !== 0 || probe.stdout.trim() !== 'true') {
    return { workspace, vcs: 'none', file, diff: '', truncated: false, binary: false, status: null, error: null };
  }

  const target = relative ?? path.relative(workspace, file);
  const statusRes = await runCommand(command, ['status', '--porcelain=v1', '-z', '--', target], opts);
  const { changed, untracked } = parsePorcelainZ(statusRes.stdout);
  const isUntracked = untracked.length > 0;
  const status = changed[0]?.status ?? (isUntracked ? '??' : null);

  let diff = '';
  let binary = false;
  if (isUntracked) {
    const res = await runCommand(command, ['diff', '--no-color', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', target], opts);
    // --no-index 在"有差异"时退出码为 1，这正是我们要的结果
    diff = res.stdout || '';
  } else {
    const [unstaged, staged] = await Promise.all([
      runCommand(command, ['diff', '--no-color', '--', target], opts),
      runCommand(command, ['diff', '--cached', '--no-color', '--', target], opts),
    ]);
    diff = [staged.stdout, unstaged.stdout].filter(Boolean).join('');
  }
  if (/^Binary files /m.test(diff) || diff.includes('GIT binary patch')) binary = true;
  const truncated = Buffer.byteLength(diff, 'utf8') > maxBytes;
  if (truncated) diff = Buffer.from(diff, 'utf8').subarray(0, maxBytes).toString('utf8');
  return { workspace, vcs: 'git', file, relative: target, diff, truncated, binary, status, error: null };
}

/**
 * 带 git 摘要的工作区列表（契约 §4.3 `GET /workspaces`）。
 * @param {{workspaces: Array<{path: string, label: string, exists: boolean}>, default: string|null, spawnImpl?: Function, includeVcs?: boolean}} opts
 */
export async function listWorkspacesWithVcs({ workspaces, default: def = null, spawnImpl = spawn, includeVcs = true }) {
  const out = [];
  for (const item of workspaces) {
    let vcs = null;
    if (includeVcs && item.exists) {
      try {
        const status = await gitStatus({ workspace: item.path, spawnImpl });
        vcs = { vcs: status.vcs, branch: status.branch, clean: status.clean, changed: status.changed.length, untracked: status.untracked.length, insertions: status.insertions, deletions: status.deletions };
      } catch (err) {
        vcs = { vcs: 'unknown', error: String(err?.message ?? err) };
      }
    }
    out.push({ ...item, vcs });
  }
  return { workspaces: out, default: def ?? out.find((w) => w.exists)?.path ?? null };
}

/** 供测试断言用：目录是否存在且是 git 仓库。 */
export async function isGitRepo(dir, { spawnImpl = spawn } = {}) {
  const res = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, spawnImpl });
  return res.code === 0 && res.stdout.trim() === 'true';
}

/** 供其它模块复用：确认 git 可执行文件存在。 */
export function gitAvailable({ spawnImpl = spawn } = {}) {
  return runCommand('git', ['--version'], { cwd: process.cwd(), spawnImpl, timeoutMs: 5000 });
}

/** 供测试用：把文件写进工作区（不改动真实仓库）。 */
export async function touchFile(file, content) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content, 'utf8');
}
