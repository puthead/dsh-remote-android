/**
 * 工作区白名单校验（契约 §6.6）。
 *
 * 为什么必须在服务端做：workspace 决定子进程的 cwd，等于决定 Agent 能读写哪个目录。
 * 手机端传来的路径不可信，因此这里既做「绝对路径」校验，也做 realpath 归一
 * （防 `..\` 穿越、防 Windows 目录联接/符号链接指向白名单之外），并且默认拒绝——
 * 白名单为空时不允许任何目录，避免「忘记配置 == 全盘开放」。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 判断 child 是否等于 parent 或位于其下（Windows 上大小写不敏感，由 path.relative 处理）。
 * @param {string} child 已归一化的绝对路径
 * @param {string} parent 已归一化的绝对路径
 * @returns {boolean}
 */
export function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 解析真实路径（不存在或不可访问返回 null）。 */
async function realpathOrNull(p, fsImpl = fsp) {
  try {
    return await fsImpl.realpath(p);
  } catch {
    return null;
  }
}

/**
 * 校验并归一化请求中的 workspace。
 * @param {string|undefined|null} requested
 * @param {{allowlist: string[], defaultWorkspace?: string|null, fsImpl?: object}} opts
 * @returns {Promise<{ok: true, path: string, matchedAllowlistEntry: string} | {ok: false, code: 'bad_request', message: string}>}
 */
export async function resolveWorkspace(requested, { allowlist = [], defaultWorkspace = null, fsImpl = fsp } = {}) {
  const raw = typeof requested === 'string' && requested.trim() ? requested.trim() : defaultWorkspace;
  if (!raw) {
    return { ok: false, code: 'bad_request', message: '缺少 workspace 字段，且网关未配置 defaultWorkspace' };
  }
  if (!path.isAbsolute(raw)) {
    return { ok: false, code: 'bad_request', message: `workspace 必须是绝对路径：${raw}` };
  }

  const real = await realpathOrNull(path.resolve(raw), fsImpl);
  if (!real) {
    return { ok: false, code: 'bad_request', message: `workspace 不存在或不可访问：${raw}` };
  }
  let stat;
  try {
    stat = await fsImpl.stat(real);
  } catch (err) {
    return { ok: false, code: 'bad_request', message: `workspace 无法访问：${err.message}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: 'bad_request', message: `workspace 必须是目录：${raw}` };
  }

  for (const entry of allowlist) {
    const entryReal = (await realpathOrNull(path.resolve(entry), fsImpl)) ?? path.resolve(entry);
    if (isWithin(real, entryReal)) {
      return { ok: true, path: real, matchedAllowlistEntry: entry };
    }
  }
  return {
    ok: false,
    code: 'bad_request',
    message: `workspace 不在白名单内：${real}（允许：${allowlist.join(', ') || '未配置任何白名单'}）`,
  };
}

/**
 * 构造 `GET /api/v1/workspaces` 的响应体。
 * @param {{allowlist: string[], defaultWorkspace?: string|null, fsImpl?: object}} opts
 * @returns {Promise<{workspaces: Array<{path: string, label: string, exists: boolean}>, default: string|null}>}
 */
export async function listWorkspaces({ allowlist = [], defaultWorkspace = null, fsImpl = fsp } = {}) {
  const workspaces = [];
  for (const entry of allowlist) {
    const resolved = path.resolve(entry);
    const real = (await realpathOrNull(resolved, fsImpl)) ?? resolved;
    let exists = false;
    try {
      exists = (await fsImpl.stat(real)).isDirectory();
    } catch {
      exists = false;
    }
    workspaces.push({ path: resolved, label: path.basename(resolved) || resolved, exists });
  }
  return { workspaces, default: defaultWorkspace ?? workspaces.find((w) => w.exists)?.path ?? null };
}
