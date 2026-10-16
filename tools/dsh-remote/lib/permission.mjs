/**
 * 任务权限档（契约 §4.2 的 `access` 字段）。
 *
 * 用户需求：手机派任务时可选「全部权限」或「仅当前工作区」。DSH 侧的开关**不是命令行参数**
 * ——`dsh --profile headless --help` / SDK profile 都没有权限 flag，权限档由 base bundle 直接读环境变量
 * `DSH_PERMISSION_MODE`（`@deepseek-ai/dsh-sandbox-policy` 的 `mode` 与
 * `@deepseek-ai/dsh-user-approval` 的 `policy` 都取它，见 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`）。
 * 因此网关只能按任务给子进程注入这个环境变量：**这是网关唯一能影响权限档的接缝，也不需要改 DSH 本体**。
 *
 * 取值刻意与 DSH 的环境变量值区分开，避免客户端把「内部实现」当契约：
 * - `workspace`（默认）→ `workspace-write`：只能读写任务工作区，审批策略 `ask`（无人应答时按拒绝处理）
 * - `full`           → `danger-full-access`：无沙箱限制、审批策略 `never`
 *
 * 注意「全部权限」是**真实的提权**：任务可以读写工作区之外的任何路径（含用户目录、其它盘）。
 * 默认必须是 `workspace`，绝不能因为缺字段就放开。
 */

/** 仅当前工作区（默认）。 */
export const ACCESS_WORKSPACE = 'workspace';
/** 全部权限（danger-full-access）。 */
export const ACCESS_FULL = 'full';

/** 契约取值 → DSH 环境变量值。 */
const DSH_MODES = Object.freeze({
  [ACCESS_WORKSPACE]: 'workspace-write',
  [ACCESS_FULL]: 'danger-full-access',
});

/**
 * 容忍的别名（客户端/脚本手写时容易直接用 DSH 的值）。
 * 只做**输入**归一，响应里永远回契约值。
 */
const ALIASES = Object.freeze({
  'workspace-write': ACCESS_WORKSPACE,
  workspace_write: ACCESS_WORKSPACE,
  'danger-full-access': ACCESS_FULL,
  danger_full_access: ACCESS_FULL,
});

/**
 * 校验并归一化请求中的 `access`。
 * @param {unknown} requested 缺省（undefined/null/空串）时取 defaultAccess
 * @param {{defaultAccess?: string}} [opts]
 * @returns {{ok: true, access: string} | {ok: false, code: 'bad_request', message: string}}
 */
export function resolveAccess(requested, { defaultAccess = ACCESS_WORKSPACE } = {}) {
  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, access: defaultAccess };
  }
  if (typeof requested !== 'string') {
    return { ok: false, code: 'bad_request', message: `access 必须是字符串：${JSON.stringify(requested)}` };
  }
  const raw = requested.trim();
  if (raw === '') return { ok: true, access: defaultAccess };
  const normalized = raw === ACCESS_WORKSPACE || raw === ACCESS_FULL ? raw : ALIASES[raw];
  if (!normalized) {
    return {
      ok: false,
      code: 'bad_request',
      message: `access 只能是 ${ACCESS_WORKSPACE}（仅当前工作区）或 ${ACCESS_FULL}（全部权限）：${raw}`,
    };
  }
  return { ok: true, access: normalized };
}

/**
 * 契约取值 → 子进程 `DSH_PERMISSION_MODE` 的值。
 * 未知取值一律降级为默认档（**失败即收紧**，绝不因为拼错就放开权限）。
 * @param {string|null|undefined} access
 * @returns {'workspace-write'|'danger-full-access'}
 */
export function permissionModeFor(access) {
  return DSH_MODES[access] ?? DSH_MODES[ACCESS_WORKSPACE];
}

/** 中文标签（日志/UI/文档共用一处，避免各处自己拼）。 */
export function describeAccess(access) {
  return access === ACCESS_FULL ? '全部权限' : '仅当前工作区';
}
