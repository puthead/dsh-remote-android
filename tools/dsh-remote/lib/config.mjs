/**
 * 配置加载、默认值与校验。
 *
 * 设计要点：
 * 1. 纯函数式为主（mergeConfig/validateConfig 不碰文件系统），便于单元测试直接构造配置。
 * 2. home（%DSH_HOME%）解析优先级：CLI --home > 环境变量 DSH_REMOTE_HOME > config.dshHome
 *    > 环境变量 DSH_HOME > ~/.dsh-remote。
 *    为什么这样排：config 文件里的显式配置应当胜过进程环境；
 *    但若 config 未指定，则尊重 DSH_HOME，这样把网关丢进已有 DSH 环境也能开箱工作。
 * 3. home 同时是「凭据目录 + 任务历史 + 日志」的根：子进程 dsh 的 DSH_HOME 也指向它，
 *    因为 headless profile 只认 $DSH_HOME/.credentials.yaml 这一种凭据位置。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hostName } from './util.mjs';

/** 网关自身版本（契约 health.gatewayVersion）。 */
export const GATEWAY_VERSION = '1.0.0';

/** 契约 API 版本。 */
export const API_VERSION = 1;

/** 配置错误：由调用方决定是打印用法还是退出。 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 默认配置工厂。
 * @param {Record<string, string|undefined>} [env]
 * @returns {object} 未经校验的配置对象（dshHome 为 null 表示"未显式指定"）
 */
export function defaultConfig(env = process.env) {
  return {
    host: '0.0.0.0',
    port: 8787,
    dshHome: null,
    serverName: hostName(),
    gatewayVersion: GATEWAY_VERSION,
    apiVersion: API_VERSION,
    authRequired: true,
    maxConcurrent: 2,
    maxQueue: 100,
    defaultTimeoutSec: 3600,
    maxTimeoutSec: 86400,
    workspaceAllowlist: [],
    defaultWorkspace: null,
    dsh: {
      node: null, // DSH 自带 node.exe 绝对路径（避免依赖系统 PATH 与版本）
      binPath: null, // dsh CLI 入口 bin.js 绝对路径
      profile: 'headless',
      version: '0.1.0-rc.7',
      discoverSessionId: true,
      forwardModel: false, // 是否把任务的 model 映射为 CLI 参数（见 README「已知限制」）
      forwardReasoningEffort: false,
      extraArgs: [],
      env: {},
    },
    events: { bufferSize: 2000, heartbeatMs: 15000 },
    limits: {
      maxBodyBytes: 1_048_576, // 契约/工单硬性要求：请求体上限 1MB
      maxOutputBytes: 1_048_576, // 单任务输出上限，防止内存与事件缓冲被撑爆
      pairClaimPerMinute: 10,
      authFailPerMinute: 30,
      pairCodeTtlMs: 300_000, // 契约：配对码默认 5 分钟
      maxSseClients: 16,
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 20_000,
      outputFlushMs: 200,
      outputFlushBytes: 8192,
    },
    tasks: { dirName: 'tasks' },
    log: { dirName: 'logs', filePrefix: 'gateway', toConsole: true },
    _env: env,
  };
}

/** 深合并：对象递归、数组整体覆盖（白名单等语义上应整体替换而非拼接）。 */
function deepMerge(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

/**
 * 合并配置。
 * @param {object} base
 * @param {object} patch
 */
export function mergeConfig(base, patch) {
  return deepMerge(base, patch);
}

/**
 * 解析运行时 home 目录（同时作为 DSH_HOME 传给子进程）。
 * @param {object} config
 * @param {{cliHome?: string|null, env?: Record<string, string|undefined>}} [opts]
 * @returns {string} 绝对路径
 */
export function resolveHome(config, { cliHome = null, env = process.env } = {}) {
  const chosen =
    cliHome ||
    env.DSH_REMOTE_HOME ||
    config.dshHome ||
    env.DSH_HOME ||
    path.join(os.homedir(), '.dsh-remote');
  return path.resolve(chosen);
}

/**
 * 校验配置，返回规范化后的副本（补齐 home 与派生路径）。
 * @param {object} config
 * @param {{cliHome?: string|null, env?: Record<string, string|undefined>}} [opts]
 * @returns {object} 规范化配置（含 home/tasksDir/logsDir/devicesFile）
 */
export function validateConfig(config, { cliHome = null, env = process.env } = {}) {
  const cfg = mergeConfig(defaultConfig(env), config);
  const intIn = (value, name, { min, max }) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ConfigError(`配置项 ${name} 必须是 ${min}~${max} 之间的整数（当前：${JSON.stringify(value)}）`);
    }
    return value;
  };

  intIn(cfg.port, 'port', { min: 0, max: 65535 }); // 0 = 由系统分配（测试用）
  intIn(cfg.maxConcurrent, 'maxConcurrent', { min: 1, max: 64 });
  intIn(cfg.maxQueue, 'maxQueue', { min: 0, max: 10_000 });
  intIn(cfg.defaultTimeoutSec, 'defaultTimeoutSec', { min: 1, max: cfg.maxTimeoutSec });
  intIn(cfg.maxTimeoutSec, 'maxTimeoutSec', { min: 1, max: 604_800 });
  intIn(cfg.events.bufferSize, 'events.bufferSize', { min: 1, max: 1_000_000 });
  intIn(cfg.events.heartbeatMs, 'events.heartbeatMs', { min: 10, max: 600_000 });
  intIn(cfg.limits.maxBodyBytes, 'limits.maxBodyBytes', { min: 1024, max: 1_073_741_824 });
  intIn(cfg.limits.maxOutputBytes, 'limits.maxOutputBytes', { min: 1024, max: 1_073_741_824 });
  intIn(cfg.limits.pairClaimPerMinute, 'limits.pairClaimPerMinute', { min: 1, max: 100_000 });
  intIn(cfg.limits.authFailPerMinute, 'limits.authFailPerMinute', { min: 1, max: 100_000 });
  intIn(cfg.limits.pairCodeTtlMs, 'limits.pairCodeTtlMs', { min: 1000, max: 86_400_000 });
  intIn(cfg.limits.maxSseClients, 'limits.maxSseClients', { min: 1, max: 10_000 });
  intIn(cfg.limits.requestTimeoutMs, 'limits.requestTimeoutMs', { min: 100, max: 3_600_000 });
  intIn(cfg.limits.headersTimeoutMs, 'limits.headersTimeoutMs', { min: 100, max: 3_600_000 });

  if (typeof cfg.host !== 'string' || !cfg.host) throw new ConfigError('配置项 host 必须是非空字符串');
  if (typeof cfg.serverName !== 'string' || !cfg.serverName) throw new ConfigError('配置项 serverName 必须是非空字符串');
  if (typeof cfg.dsh.profile !== 'string' || !cfg.dsh.profile) throw new ConfigError('配置项 dsh.profile 必须是非空字符串');
  if (!Array.isArray(cfg.dsh.extraArgs)) throw new ConfigError('配置项 dsh.extraArgs 必须是字符串数组');

  if (!Array.isArray(cfg.workspaceAllowlist)) throw new ConfigError('配置项 workspaceAllowlist 必须是数组');
  cfg.workspaceAllowlist = cfg.workspaceAllowlist.map((entry) => {
    const raw = typeof entry === 'string' ? entry : entry?.path;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new ConfigError(`workspaceAllowlist 条目必须是路径字符串：${JSON.stringify(entry)}`);
    }
    if (!path.isAbsolute(raw)) {
      throw new ConfigError(`workspaceAllowlist 条目必须是绝对路径：${raw}`);
    }
    return path.resolve(raw);
  });

  if (cfg.defaultWorkspace !== null && cfg.defaultWorkspace !== undefined) {
    if (typeof cfg.defaultWorkspace !== 'string' || !path.isAbsolute(cfg.defaultWorkspace)) {
      throw new ConfigError(`defaultWorkspace 必须是绝对路径：${JSON.stringify(cfg.defaultWorkspace)}`);
    }
    cfg.defaultWorkspace = path.resolve(cfg.defaultWorkspace);
  } else {
    cfg.defaultWorkspace = cfg.workspaceAllowlist[0] ?? null;
  }

  const home = resolveHome(cfg, { cliHome, env });
  cfg.home = home;
  cfg.tasksDir = path.join(home, cfg.tasks.dirName);
  cfg.logsDir = path.join(home, cfg.log.dirName);
  cfg.devicesFile = path.join(home, 'devices.json');
  cfg.credentialsFile = path.join(home, '.credentials.yaml');
  return cfg;
}

/**
 * 从磁盘加载配置。
 * 查找顺序：显式路径 > 环境变量 DSH_REMOTE_CONFIG > <脚本目录>/config.json。
 * 文件不存在时使用默认值（仅打警告），便于「先跑起来再配置」。
 * @param {{configPath?: string|null, cliOverrides?: object, cliHome?: string|null, env?: Record<string, string|undefined>, defaultDir?: string, logger?: {warn: Function}}} [opts]
 * @returns {object} 规范化配置
 */
export function loadConfig({
  configPath = null,
  cliOverrides = {},
  cliHome = null,
  env = process.env,
  defaultDir = null,
  logger = null,
} = {}) {
  const explicit = configPath || env.DSH_REMOTE_CONFIG || null;
  const candidate = explicit ? path.resolve(explicit) : defaultDir ? path.join(defaultDir, 'config.json') : null;
  let fileConfig = {};
  let usedPath = null;

  if (candidate && fs.existsSync(candidate)) {
    let text;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch (err) {
      throw new ConfigError(`无法读取配置文件 ${candidate}：${err.message}`);
    }
    try {
      fileConfig = JSON.parse(text.replace(/^\uFEFF/, '')); // 容忍 BOM
    } catch (err) {
      throw new ConfigError(`配置文件 ${candidate} 不是合法 JSON：${err.message}`);
    }
    usedPath = candidate;
  } else if (explicit) {
    throw new ConfigError(`指定的配置文件不存在：${candidate}`);
  } else if (logger) {
    logger.warn(`未找到 config.json（${candidate ?? '无默认目录'}），使用内置默认配置`);
  }

  const merged = mergeConfig(mergeConfig(defaultConfig(env), fileConfig), cliOverrides);
  const cfg = validateConfig(merged, { cliHome, env });
  cfg.configPath = usedPath;
  return cfg;
}

/**
 * 确保运行时目录存在（home/tasks/logs）。
 * @param {object} config
 */
export async function ensureRuntimeDirs(config) {
  const fsp = await import('node:fs/promises');
  await fsp.mkdir(config.tasksDir, { recursive: true });
  await fsp.mkdir(config.logsDir, { recursive: true });
}
