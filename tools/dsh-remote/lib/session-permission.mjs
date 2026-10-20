/**
 * 会话权限档的**对外词表**（契约 §4.2 / §7.9）。
 *
 * 桌面端 DSH 的权限是「三档预设」：每档把 `sandbox/mode` 与 `approval/policy` 绑在一起。
 * 手机端不应该自己拼这两个底层旋钮 —— 那既容易拼出 `custom` 这种不可选状态，也会在
 * 桌面端表项改名时悄悄漂移。所以网关只暴露预设名，写入路径统一走桌面端的
 * `/permission <preset>` 命令（见 `desktop-api.mjs#executeCommand`）。
 *
 * 真值来源有一个现实限制：桌面端 0.2.0-rc.2 的 `permissions` 投影只给
 * `{currentValue}`，**不返回 options**（0.1.0 的 UI 代码曾期待过 options，但实测
 * 投影里没有）。因此这里维护一份与桌面端默认预设表一致的固定词表：
 * - `read-only` = read-only + ask
 * - `workspace-write` = workspace-write + ask（默认）
 * - `danger-full-access` = danger-full-access + never
 *
 * 如果桌面端进程被配置了自定义 preset 表，`currentValue` 可能出现别的名字：
 * 此时仍原样显示（作为不可选中的当前值），写入只接受下面三个稳定值。
 */

/** 稳定的三档预设（顺序即界面顺序）。 */
export const PERMISSION_PRESETS = Object.freeze([
  Object.freeze({
    value: 'read-only',
    name: 'Read Only',
    description: '只能读取；任何写文件/执行命令都会被沙箱拒绝',
    sandbox: 'read-only',
    approval: 'ask',
  }),
  Object.freeze({
    value: 'workspace-write',
    name: 'Workspace Write',
    description: '可以读写会话所在工作区；越界写与敏感操作仍会请求审批',
    sandbox: 'workspace-write',
    approval: 'ask',
  }),
  Object.freeze({
    value: 'danger-full-access',
    name: 'Full Access',
    description: '放开沙箱并关闭审批（approval=never）；请只在信任当前任务时使用',
    sandbox: 'danger-full-access',
    approval: 'never',
  }),
]);

/** 预设名集合（写入白名单）。 */
export const PERMISSION_VALUES = Object.freeze(PERMISSION_PRESETS.map((entry) => entry.value));

/** 桌面端未给投影时的默认档（与 DSH 部署默认一致）。 */
export const DEFAULT_PERMISSION_PRESET = 'workspace-write';

/**
 * 校验用户提交的预设名；未知值返回 null（调用方回 400，绝不静默回落）。
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizePermissionPreset(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return PERMISSION_VALUES.includes(trimmed) ? trimmed : null;
}

/**
 * 构造下发给手机端的权限视图。
 *
 * @param {{currentValue?: string|null, editable?: boolean, source?: 'desktop'|'gateway'|null, reason?: string|null, gatewayAccess?: boolean}} [input]
 * @returns {{currentValue: string, options: Array<{value: string, name: string, description: string, selectable: boolean}>, editable: boolean, source: string|null, reason: string|null}}
 */
export function permissionView({ currentValue = null, editable = false, source = null, reason = null, gatewayAccess = false } = {}) {
  const current = typeof currentValue === 'string' && currentValue.trim()
    ? currentValue.trim()
    : (source === 'gateway' && gatewayAccess ? 'workspace-write' : DEFAULT_PERMISSION_PRESET);
  // 网关自有 SDK 会话只支持「工作区 / 全部权限」两档（DSH_PERMISSION_MODE），
  // 而且档位在进程启动时固定，所以不可编辑；列表里仍要如实显示当前档位。
  const table = gatewayAccess
    ? PERMISSION_PRESETS.filter((entry) => entry.value !== 'read-only')
    : PERMISSION_PRESETS;
  const options = table.map((entry) => ({
    value: entry.value,
    name: entry.name,
    description: entry.description,
    selectable: true,
  }));
  if (!options.some((entry) => entry.value === current)) {
    // custom / 自定义表项：只如实显示当前值，不允许手机端选中它。
    options.push({
      value: current,
      name: 'Custom',
      description: '当前沙箱与审批组合不在预设表内；请到电脑端确认',
      selectable: false,
    });
  }
  return {
    currentValue: current,
    options,
    editable: editable === true,
    source: source === 'desktop' || source === 'gateway' ? source : null,
    reason: typeof reason === 'string' && reason ? reason : null,
  };
}

/**
 * 旧 API 的 `access`（`workspace` | `full`）→ 桌面端预设名。
 *
 * 新建任务沿用既有 `access` 字段（老客户端/老网关都知道它），但电脑端执行时
 * 必须把它落到具体预设上，否则手机会以为"给了全部权限"而实际没有。
 *
 * @param {unknown} access
 * @returns {string|null} 未知/缺失 → null（表示"不指定，跟随电脑端当前默认"）
 */
export function permissionPresetFromAccess(access) {
  if (typeof access !== 'string') return null;
  switch (access.trim().toLowerCase()) {
    case 'workspace':
    case 'workspace-write':
    case 'workspace_write':
      return 'workspace-write';
    case 'full':
    case 'danger-full-access':
    case 'danger_full_access':
      return 'danger-full-access';
    case 'read-only':
      return 'read-only';
    default:
      return null;
  }
}

/**
 * 反向映射（回执用）：桌面端预设名 → 旧 `access` 词表的两个稳定取值。
 * `read-only` 没有对应的旧档位，按 `workspace` 报会撒谎，所以返回 null。
 *
 * @param {unknown} preset
 * @returns {'workspace'|'full'|null}
 */
export function accessFromPermissionPreset(preset) {
  if (preset === 'workspace-write') return 'workspace';
  if (preset === 'danger-full-access') return 'full';
  return null;
}

/**
 * 从桌面端 `session/projections` 的 `permissions` 投影里取当前档位。
 *
 * 兼容两种形状（实测桌面端 0.2.0-rc.2 是第一种）：
 * - `{currentValue: 'workspace-write'}`
 * - `'workspace-write'`（老/新版本的简化投影）
 *
 * @param {unknown} projection
 * @returns {string|null}
 */
export function permissionPresetFromProjection(projection) {
  if (typeof projection === 'string' && projection.trim()) return projection.trim();
  if (projection && typeof projection === 'object' && typeof projection.currentValue === 'string' && projection.currentValue.trim()) {
    return projection.currentValue.trim();
  }
  return null;
}
