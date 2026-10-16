/**
 * 中继配置：默认值、深合并、校验、磁盘加载。
 *
 * 设计要点：
 * 1. 纯函数式为主（`mergeConfig`/`validateConfig` 不碰文件系统），便于单测直接构造配置。
 * 2. 运行目录解析优先级：CLI `--home` > 环境变量 `DSH_RELAY_HOME` > `config.home` > `~/.dsh-relay`。
 *    运行目录同时是 `homes.json`、日志、自签证书的根 —— 中继是**无状态业务、有状态身份**，
 *    唯一需要落盘的就是「谁是我认过的 home / device」（且只落 sha256）。
 * 3. 键名与 `scripts/setup-relay.ps1`（S1 运维脚本）锁定的草案一致：
 *    `relayName/host/port/relaySecret/tls/limits/heartbeat/pairWindowTtlMs/log`。
 *    其中 `heartbeat` 与 `pairWindowTtlMs` 放在顶层（而非 limits），是为了让运维脚本的
 *    「三行就能读懂」配置保持扁平；内部使用时统一在 `normalize()` 里折算成毫秒字段。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hostName } from './util.mjs';

/** 中继自身版本（契约 §2.1 `relayVersion`）。 */
export const RELAY_VERSION = '2.0.1';

/** 契约 API 版本（契约头表：v1 → v2）。 */
export const API_VERSION = 2;

/** 隧道 WS 端点（契约 §3）。 */
export const TUNNEL_HOME_PATH = '/api/v2/tunnel/home';
export const TUNNEL_DEVICE_PATH = '/api/v2/tunnel/device';

/** 配置错误：由调用方决定是打印用法还是退出。 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 允许的 TLS 模式。 */
export const TLS_MODES = Object.freeze(['off', 'selfsigned', 'file']);

/**
 * 默认配置工厂。
 * @param {Record<string, string|undefined>} [env]
 * @returns {object} 未经校验的配置对象
 */
export function defaultConfig(env = process.env) {
  return {
    relayName: hostName(),
    host: '0.0.0.0',
    port: 9443,
    /** 版本字段也进配置（而不是只在常量里）：health 必须回契约 §2.1 的形状，配置层漏字段会直接漏进响应。 */
    apiVersion: API_VERSION,
    relayVersion: RELAY_VERSION,
    /** 注册口令（契约 §2.2「可空」）：为空表示允许任何来源注册，仅限本机/内网调试。 */
    relaySecret: '',
    /** 对外可达基址（例如 `wss://relay.example.com`）；为空时按 relayName+port 推导。 */
    publicUrl: null,
    tls: {
      mode: 'off',
      certFile: null,
      keyFile: null,
      /** 自签证书落盘目录（相对运行目录或绝对路径），mode=selfsigned 时使用。 */
      selfSignedDir: 'tls',
      /** 自签证书 CN/SAN 覆盖；为空时取 relayName。 */
      commonName: null,
      /** 自签有效期天数。 */
      days: 825,
    },
    limits: {
      maxBodyBytes: 1_048_576, // HTTP 请求体与 WS req.bodyB64 解码后上限（沿用网关 v1 的 1MB）
      maxStreamsPerConnection: 64, // 契约 §3.2：单连接并发流上限
      maxChunkBytes: 262_144, // 契约 §3.2：单条 chunk 的 dataB64 解码后 ≤ 256 KiB
      maxStreamBufferBytes: 1_048_576, // 契约 §3.2：单个 id 缓冲上限 1 MiB
      backpressureBytes: 4_194_304, // 契约 §3.2：bufferedAmount > 4 MiB 暂停读对端
      maxMessageBytes: 8_388_608, // WS 单条消息（分片重组后）上限，防御性上限
      pairClaimPerMinute: 20, // pair/claim 每 IP 每分钟上限
      authFailPerMinute: 30, // 隧道握手/注册失败每 IP 每分钟上限
      helloTimeoutMs: 10_000, // 升级成功后在多久内必须收到 hello（防"连上不干活"占槽）
      forwardTimeoutMs: 15_000, // pair/claim 经隧道转发等待网关响应的上限
    },
    /**
     * 心跳（契约 §3.1：无活动超时视为死链）。
     * `timeoutMs` 必须 ≥ `intervalMs * 2`（校验强约束），默认取 **3 倍** ——
     * 即"连续 3 个心跳周期都没有**任何入站活动**"才算死链。
     * 为什么不能配成 1 倍（真实 P0 事故）：第 1 个 tick 时 idle 就已 ≈ intervalMs，定时器晚几毫秒就误杀，
     * 而那个 ping 还没发出去 → 对端不会回 pong → **不可自愈**，表现为"每 30 秒掉线一次"。
     */
    heartbeat: { intervalMs: 30_000, timeoutMs: 90_000 },
    pairWindowTtlMs: 300_000, // 契约 §3.4：配对窗口默认 TTL 5 分钟
    /** homes.json 热加载检查周期（`relay.mjs home-token` 是另一个进程，运行中的 relay 需要发现它的写入）。 */
    registryReloadIntervalMs: 5_000,
    log: { dirName: 'logs', filePrefix: 'relay', toConsole: true },
    /** 运行目录（null = 未显式指定，由 resolveHome 推导）。 */
    home: null,
    _env: env,
  };
}

/** 深合并：对象递归、数组整体覆盖。 */
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
 * 合并配置（变参，后者覆盖前者）。
 * 为什么变参：曾出现「调用方多传一个 patch 被静默忽略」导致用例级覆盖失效的缺陷，
 * 变参 + 单测锁定后不会再发生（沿用网关的同款防御）。
 * @param {object} base
 * @param {...object} patches
 */
export function mergeConfig(base, ...patches) {
  let out = base;
  for (const patch of patches) out = deepMerge(out, patch);
  return out;
}

/**
 * 解析运行目录。
 * @param {object} config
 * @param {{cliHome?: string|null, env?: Record<string, string|undefined>}} [opts]
 * @returns {string} 绝对路径
 */
export function resolveHome(config, { cliHome = null, env = process.env } = {}) {
  const chosen = cliHome || env.DSH_RELAY_HOME || config.home || path.join(os.homedir(), '.dsh-relay');
  return path.resolve(chosen);
}

/** 相对路径按运行目录解析，绝对路径原样规范化。 */
function resolveUnderHome(home, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(home, value);
}

/**
 * 校验配置，返回规范化副本（补齐运行目录与派生路径）。
 * @param {object} config
 * @param {{cliHome?: string|null, env?: Record<string, string|undefined>, requireTlsFiles?: boolean}} [opts]
 * @returns {object}
 */
export function validateConfig(config, { cliHome = null, env = process.env, requireTlsFiles = false } = {}) {
  const cfg = mergeConfig(defaultConfig(env), config);
  const intIn = (value, name, { min, max }) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ConfigError(`配置项 ${name} 必须是 ${min}~${max} 之间的整数（当前：${JSON.stringify(value)}）`);
    }
    return value;
  };

  if (typeof cfg.relayName !== 'string' || !cfg.relayName.trim()) throw new ConfigError('配置项 relayName 必须是非空字符串');
  cfg.relayName = cfg.relayName.trim();
  intIn(cfg.apiVersion, 'apiVersion', { min: 1, max: 100 });
  if (typeof cfg.relayVersion !== 'string' || !cfg.relayVersion) throw new ConfigError('配置项 relayVersion 必须是非空字符串');
  if (typeof cfg.host !== 'string' || !cfg.host.trim()) throw new ConfigError('配置项 host 必须是非空字符串');
  cfg.host = cfg.host.trim();
  intIn(cfg.port, 'port', { min: 0, max: 65535 }); // 0 = 系统分配（测试用）
  if (typeof cfg.relaySecret !== 'string') throw new ConfigError('配置项 relaySecret 必须是字符串（可空）');

  if (cfg.publicUrl !== null && cfg.publicUrl !== undefined) {
    if (typeof cfg.publicUrl !== 'string' || !/^(wss?|https?):\/\//.test(cfg.publicUrl)) {
      throw new ConfigError(`配置项 publicUrl 必须是 ws:// wss:// http:// https:// 开头的地址：${JSON.stringify(cfg.publicUrl)}`);
    }
    cfg.publicUrl = cfg.publicUrl.replace(/\/+$/, '');
  } else {
    cfg.publicUrl = null;
  }

  if (!TLS_MODES.includes(cfg.tls?.mode)) {
    throw new ConfigError(`配置项 tls.mode 必须是 ${TLS_MODES.join(' / ')} 之一（当前：${JSON.stringify(cfg.tls?.mode)}）`);
  }
  if (typeof cfg.tls.selfSignedDir !== 'string' || !cfg.tls.selfSignedDir.trim()) {
    throw new ConfigError('配置项 tls.selfSignedDir 必须是非空字符串');
  }
  if (cfg.tls.commonName !== null && cfg.tls.commonName !== undefined && typeof cfg.tls.commonName !== 'string') {
    throw new ConfigError('配置项 tls.commonName 必须是字符串或 null');
  }
  intIn(cfg.tls.days, 'tls.days', { min: 1, max: 3650 });

  intIn(cfg.limits.maxBodyBytes, 'limits.maxBodyBytes', { min: 1024, max: 1_073_741_824 });
  intIn(cfg.limits.maxStreamsPerConnection, 'limits.maxStreamsPerConnection', { min: 1, max: 65_536 });
  intIn(cfg.limits.maxChunkBytes, 'limits.maxChunkBytes', { min: 1024, max: 268_435_456 });
  intIn(cfg.limits.maxStreamBufferBytes, 'limits.maxStreamBufferBytes', { min: 1024, max: 1_073_741_824 });
  intIn(cfg.limits.backpressureBytes, 'limits.backpressureBytes', { min: 1024, max: 1_073_741_824 });
  intIn(cfg.limits.maxMessageBytes, 'limits.maxMessageBytes', { min: 1024, max: 1_073_741_824 });
  intIn(cfg.limits.pairClaimPerMinute, 'limits.pairClaimPerMinute', { min: 1, max: 100_000 });
  intIn(cfg.limits.authFailPerMinute, 'limits.authFailPerMinute', { min: 1, max: 100_000 });
  intIn(cfg.limits.helloTimeoutMs, 'limits.helloTimeoutMs', { min: 100, max: 600_000 });
  intIn(cfg.limits.forwardTimeoutMs, 'limits.forwardTimeoutMs', { min: 100, max: 600_000 });

  intIn(cfg.heartbeat.intervalMs, 'heartbeat.intervalMs', { min: 10, max: 600_000 });
  intIn(cfg.heartbeat.timeoutMs, 'heartbeat.timeoutMs', { min: 10, max: 600_000 });
  // 硬约束：timeoutMs 必须 ≥ intervalMs×2（推荐 3×）。
  // 1:1 的组合不是"更灵敏"，而是**必然误杀**：第 1 个 tick 的 idle 已 ≈ intervalMs，定时器抖几毫秒就超阈值，
  // 且那一次 ping 还没发出去 → 对端不回 pong → 每 30s 掉线一次且不可自愈（真实 P0）。宁可启动即报错。
  if (cfg.heartbeat.timeoutMs < cfg.heartbeat.intervalMs * 2) {
    throw new ConfigError(
      `配置项 heartbeat.timeoutMs（${cfg.heartbeat.timeoutMs}）必须 ≥ heartbeat.intervalMs×2（${cfg.heartbeat.intervalMs * 2}）；推荐 intervalMs×3。\n` +
        '  为什么要拒绝启动：1:1 的组合会让健康连接在**第一个心跳周期**就被误判为死链（定时器抖动几毫秒即超阈值，' +
        '且那一次 ping 还没发出去 → 对端不会回 pong → 每 30s 掉线一次且不可自愈）。\n' +
        `  怎么改：把 config.json 里的 "heartbeat": { "intervalMs": ${cfg.heartbeat.intervalMs}, "timeoutMs": ${cfg.heartbeat.intervalMs * 3} }，` +
        '或直接删掉整个 heartbeat 字段使用默认值（30s / 90s）；也可以跑 `node relay.mjs init --home <运行目录> --force` 重新生成配置。',
    );
  }
  intIn(cfg.pairWindowTtlMs, 'pairWindowTtlMs', { min: 1000, max: 3_600_000 });
  intIn(cfg.registryReloadIntervalMs, 'registryReloadIntervalMs', { min: 200, max: 600_000 });

  if (cfg.log && typeof cfg.log.dirName !== 'string') throw new ConfigError('配置项 log.dirName 必须是字符串');
  if (cfg.log && typeof cfg.log.filePrefix !== 'string') throw new ConfigError('配置项 log.filePrefix 必须是字符串');

  const home = resolveHome(cfg, { cliHome, env });
  cfg.home = home;
  cfg.homesFile = path.join(home, 'homes.json');
  cfg.logsDir = path.join(home, cfg.log?.dirName ?? 'logs');
  cfg.tlsDir = resolveUnderHome(home, cfg.tls.selfSignedDir);
  cfg.tls.certFile = resolveUnderHome(home, cfg.tls.certFile);
  cfg.tls.keyFile = resolveUnderHome(home, cfg.tls.keyFile);

  if (cfg.tls.mode === 'file') {
    if (!cfg.tls.certFile || !cfg.tls.keyFile) {
      throw new ConfigError('tls.mode=file 时必须同时提供 tls.certFile 与 tls.keyFile');
    }
    if (requireTlsFiles) {
      for (const [name, file] of [['tls.certFile', cfg.tls.certFile], ['tls.keyFile', cfg.tls.keyFile]]) {
        if (!fs.existsSync(file)) throw new ConfigError(`${name} 指向的文件不存在：${file}`);
      }
    }
  }

  // 安全底线：中继是**公网**服务，但 relaySecret 为空等于允许任意来源注册隧道凭据；
  // 本机/内网调试场景显式放行，公网部署必须配 relaySecret（README/部署手册里写明）。
  cfg.registrationOpen = cfg.relaySecret.length === 0;
  return cfg;
}

/**
 * 从磁盘加载配置。
 * 查找顺序：显式路径 > 环境变量 DSH_RELAY_CONFIG > `<脚本目录>/config.json`。
 * 文件不存在时使用默认值（仅打警告），便于「先跑起来再配置」。
 * @param {{configPath?: string|null, cliOverrides?: object, cliHome?: string|null, env?: Record<string,string|undefined>, defaultDir?: string|null, logger?: {warn: Function}|null, requireTlsFiles?: boolean}} [opts]
 * @returns {object} 规范化配置
 */
export function loadConfig({
  configPath = null,
  cliOverrides = {},
  cliHome = null,
  env = process.env,
  defaultDir = null,
  logger = null,
  requireTlsFiles = false,
} = {}) {
  const explicit = configPath || env.DSH_RELAY_CONFIG || null;
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
      fileConfig = JSON.parse(text.replace(/^\uFEFF/, '')); // 容忍 BOM（运维脚本在 PS5.1 下容易写出 BOM）
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
  const cfg = validateConfig(merged, { cliHome, env, requireTlsFiles });
  cfg.configPath = usedPath;
  return cfg;
}

/**
 * 推导手机可见的 device 隧道地址（契约 §2.3：中继从 tunnelUrl 起对手机可见）。
 * @param {object} config 已校验配置
 * @returns {string}
 */
export function deriveTunnelUrl(config) {
  const scheme = config.tls.mode === 'off' ? 'ws' : 'wss';
  if (config.publicUrl) {
    const base = config.publicUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
    return `${base}${TUNNEL_DEVICE_PATH}`;
  }
  const host = config.relayName;
  // relayName 里已经带端口就不再追加，避免出现 `relay.local:9443:9443`
  const defaultPort = scheme === 'wss' ? 443 : 80;
  const withPort = host.includes(':') || config.port === defaultPort ? host : `${host}:${config.port}`;
  return `${scheme}://${withPort}${TUNNEL_DEVICE_PATH}`;
}

/** 确保运行目录存在（homes/logs/tls）。 @param {object} config */
export async function ensureRuntimeDirs(config) {
  const fsp = await import('node:fs/promises');
  await fsp.mkdir(config.home, { recursive: true });
  await fsp.mkdir(config.logsDir, { recursive: true });
  if (config.tls.mode === 'selfsigned') await fsp.mkdir(config.tlsDir, { recursive: true });
}
