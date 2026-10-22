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
import { resolveDshHome } from './dsh-home.mjs';

/**
 * 网关自身版本（契约 health.gatewayVersion）。
 *
 * 2.10.0：新建任务可选模型（`GET /api/v2/models` 模型目录；`POST /api/v2/tasks` 的
 * `provider`/`reasoningEffort`；202 回 `modelApplied`/`modelWarning`；电脑端在首轮投递前
 * 调 `session/selectModel`，手机的 provider 走 per-session 覆盖 SDK 启动参数）。
 * 2.9.0：附件通道（GET /api/v2/attachments/{id} + 转录 images[]）与轮次索引（turn-index）。tools/dsh-remote/lib/attachments.mjs
 * 按内容哈希在 home 的附件对象库里解析对象，手机端因此能在对话里内联看图、按轮跳转。
 * 2.2.0：电脑端会话**实时中继**（`lib/desktop-watch.mjs`）——用户在自己电脑的 DSH 界面里发起的
 * 轮次，手机端不再"冻结"，而是实时收到 message.delta/tool.call/tool.result/turn.ended。
 */
export const GATEWAY_VERSION = '2.12.0';

/**
 * `/api/v1/health` 的 `apiVersion`。
 *
 * **注意：这是 v1 端点的版本号，不是网关支持的最高版本。**
 * 已交付的 v1 Android 客户端用该字段做兼容性判断，把它改成 2 会让老客户端
 * 误判不兼容而拒绝连接（这是唯一会伤到已交付客户端的风险点）。
 * v2 能力改用新增字段 `supportedApiVersions: [1, 2]` 宣告 —— 老客户端忽略未知字段，
 * 天然向后兼容。契约 §4.4 已记录这条教训。
 */
export const API_VERSION = 1;

/** 网关支持的 API 版本列表（health.supportedApiVersions）。 */
export const SUPPORTED_API_VERSIONS = Object.freeze([1, 2]);

/**
 * 回环地址白名单（契约 §5.5.1）。
 * relay 功能只有在 `config.host` 是其中之一时才允许启动 —— 否则拒绝启动并给出明确错误。
 */
export const LOOPBACK_HOSTS = Object.freeze(new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', '[::1]', '0:0:0:0:0:0:0:1']));

/** `config.host` 是否是回环地址。 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const trimmed = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(trimmed) || trimmed.startsWith('127.');
}

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
    // 契约 §5.5.1 要求网关**只监听 127.0.0.1**，但 v1 时代的默认值就是 0.0.0.0。
    // 这里保留 v1 默认值（既有部署与测试不受影响），安全由两件事保证：
    //   1) `relay.enabled=true` 时 `config.host` 非回环 → 启动即报错（见 validateRelay）；
    //   2) 随包发布的 config.json / config.example.json 与 scripts/setup-pc.ps1 写 127.0.0.1。
    host: '0.0.0.0',
    port: 8787,
    dshHome: null,
    serverName: hostName(),
    gatewayVersion: GATEWAY_VERSION,
    /** `/api/v1/health` 的版本号（= 1，见 API_VERSION 注释）。 */
    apiVersion: API_VERSION,
    /** health 新增的能力宣告：老客户端忽略未知字段，v2 客户端据此判断支持范围。 */
    supportedApiVersions: [...SUPPORTED_API_VERSIONS],
    authRequired: true,
    maxConcurrent: 2,
    maxQueue: 100,
    defaultTimeoutSec: 3600,
    maxTimeoutSec: 86400,
    workspaceAllowlist: [],
    defaultWorkspace: null,
    dsh: {
      node: null, // DSH 自带 node.exe 绝对路径（避免依赖系统 PATH 与版本）
      binPath: null, // dsh CLI 入口 bin.js 绝对路径（v1 任务用）
      // v2 会话续聊用：`dsh.cmd` 包装器路径（自动解析出 electron + cli.js + 前缀参数），
      // 或显式给 electronPath + cliPath。见 lib/session-runner.mjs 的 parseDshLauncher。
      launcher: null,
      electronPath: null,
      cliPath: null,
      exeArgs: null,
      /**
       * 是否自动探测 `dsh.cmd`（默认 true）。
       * 设 false 时只用显式 `launcher` / `electronPath`+`cliPath`；
       * 部署若希望"配置什么就是什么"、不受机器上 DSH 安装位置影响，就关掉它。
       */
      autoDetectLauncher: true,
      /**
       * **网关自己创建的 SDK 会话**所在的 DSH home（可续聊、可写）。
       * 与 `mirror.dshHome`（用户真实 `~/.dsh`，只读镜像）严格分离：
       * SDK profile 的会话 header 没有 agentPreset，写进真实 `~/.dsh` 会污染桌面端列表。
       * null = `<config.home>/dsh-home`。
       */
      sessionsHome: null,
      /** SDK profile 的 provider/model（`initialize` 必填；不填会落到无意义的默认值 "deepseek-official"）。 */
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      /** 单个 SDK 进程最多驻留多久（毫秒）；0 = 不限。用于回收僵尸运行时。 */
      runtimeIdleMs: 30 * 60_000,
      /** `initialize` 的 maxTokens（null = 用适配器默认）。 */
      maxTokens: null,
      /**
       * 凭据文件：SDK profile 不认 `$DSH_HOME/.credentials.yaml` 的隐式读取，
       * 它会明确要求 `DEEPSEEK_API_KEY` 环境变量或走凭据服务。
       * 因此这里从该 YAML 的 `refs:` 段读出 key 并注入子进程环境。
       * null = 自动探测（镜像 home → 网关 home）。
       */
      credentialsFile: null,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      /** 单轮超时（秒）。 */
      turnTimeoutSec: 1800,
      profile: 'headless',
      version: '0.1.0-rc.7',
      discoverSessionId: true,
      forwardModel: false, // 是否把任务的 model 映射为 CLI 参数（见 README「已知限制」）
      forwardReasoningEffort: false,
      extraArgs: [],
      env: {},
    },
    /** 会话镜像（契约 §4.2）：读**真实** DSH home，与网关自身运行时 home 无关。 */
    mirror: {
      enabled: true,
      // null = 自动：DSH_REMOTE_MIRROR_HOME > DSH_HOME > %USERPROFILE%\.dsh（见 lib/dsh-home.mjs）
      dshHome: null,
      liveWindowMs: 60_000, // 契约 §5.4
      // 默认镜像**所有**工作区的会话；设 true 则只列 workspaceAllowlist 命中的（更保守）
      onlyAllowlistedWorkspaces: false,
      listLimit: 50,
      listLimitMax: 200,
      includeSubagentsByDefault: false, // 契约 §4.2：手机默认只列 origin=user
    },
    /**
     * 电脑端（DSH 桌面端 / Web 运行时）通道：手机端的「审批 / 提问」全靠它（契约 §7.7）。
     *
     * **缺省即启用**：只有显式写 `enabled: false` 才关闭。判据在 lib/http.mjs 里是
     * `config.desktop?.enabled === false ? null : new DesktopApi({...})` —— 注意
     * `undefined === false` 为假，所以**没有这一段配置也会连**（这是刻意保留的默认可用行为，
     * 2026-10-15 真机排障时确认过：整块缺失 ≠ 关闭，别据此误判"审批没开"）。
     *
     * `dshHome`: null = 用桌面端的默认 home（`~/.dsh`，`client-connection/browser-session`
     * 凭据就在那里）。它必须与网关自身的运行时 home 分开 —— 网关 home 里通常只有
     * `DEEPSEEK_API_KEY`，指错了就会得到一句「找不到电脑端凭据」。
     */
    desktop: {
      enabled: true,
      host: '127.0.0.1',
      // 与 lib/desktop-api.mjs 的 DEFAULT_DESKTOP_PORT 同值；这里写字面量是为了避免 config ← → desktop-api 的循环导入。
      // **它只是一个提示**：桌面端 0.2.0 起用 --port 0 随机端口，autoDiscover 会在连不上时
      // 从进程监听表里找真实端口。显式固定端口的旧版本仍在第一顺位被尝试。
      port: 19_387,
      /**
       * 自动发现桌面端真实端口（默认开）。关掉它 = 只认 `port`，桌面端升级到随机端口后
       * 审批/电脑端会话/权限修改会全部不可用。
       */
      autoDiscover: true,
      dshHome: null,
    },
    /**
     * 电脑端工作区同步（默认开）：桌面端把工作区登记在 `<desktopHome>/storages/workspace.json`，
     * 这里定时读它并合并进网关的有效白名单 —— 手机端 `GET /api/v2/workspaces` 才能看到
     * 电脑上新建的工作区，工作区文件接口也才认这些路径。
     *
     * 为什么不是走桌面端 RPC：随机端口/桌面端未运行时 `workspace/follow` 不可达，
     * 而 `workspace.json` 是桌面端的**权威持久化**，读文件在离线时也仍然可用。
     * 只同步该 home 里**已被用户登记**的工作区，不扫描磁盘、不扩大授权范围。
     */
    desktopWorkspaces: {
      enabled: true,
      /** 轮询间隔：桌面端新建工作区后，手机端最多晚这么久看到。 */
      pollMs: 5_000,
      /** null = `desktop.dshHome` / `mirror.resolvedHome` 自动。 */
      home: null,
    },
    /**
     * 电脑端会话**实时中继**（`lib/desktop-watch.mjs`）：轮询桌面端运行态，发现"电脑端自己发起的
     * 轮次"就订阅 `session/follow` 并把事件补发进会话总线，让手机端也能实时看到。
     *
     * 默认开启：关掉它，用户在电脑端 DSH 界面里发起的轮次对手机就是完全静音的
     * （手机端会永远停在"已加载 N/M 条"，后续回复不出现）。
     */
    desktopWatch: {
      enabled: true,
      /** 发现 running 会话的轮询间隔：越短越"实时"，但每次 tick 都要问一次桌面端。 */
      pollMs: 2000,
      /**
       * 单条中继订阅的最长存活时间。一轮对话可能跑很久（长任务/多步工具），
       * 所以给得比普通流超时宽得多；到点后中继会结束这一路，下一 tick 若仍在 running 会重新订阅。
       */
      streamTimeoutMs: 30 * 60_000,
      /** 订阅握手（首帧 snapshot）的等待上限：桌面端没响应时不能把发现循环卡死。 */
      attachTimeoutMs: 15_000,
    },
    /** 中继隧道（契约 §3 / §4.1）。 */
    relay: {
      enabled: false,
      url: '',
      homeName: '',
      homeToken: null,
      relaySecret: '',
      relayName: null,
      gatewayVersion: GATEWAY_VERSION,
      maxStreams: 64,
      requestTimeoutMs: 60_000,
      maxFrameBytes: 8 * 1024 * 1024,
      reconnect: { minMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.2 },
      tls: { rejectUnauthorized: true, ca: null },
      pairWindow: { attempts: 5 },
      /**
       * 逃生舱（契约 §5.5.1）：`relay.enabled=true` 且 `host` 非回环时默认**拒绝启动**。
       * 只有显式设 true 才放行（并在启动横幅里打风险警告）。
       * 为什么留这个开关：v1 的局域网直连是已交付能力，运维可能在调试拓扑时确实需要它，
       * 但绝不能是"默认悄悄放行"。
       */
      allowNonLoopback: false,
    },
    events: { bufferSize: 2000, heartbeatMs: 15000 },
    /** v2 会话 SSE（契约 §4.2：心跳 15s）。 */
    sessionStream: { bufferSize: 4000, heartbeatMs: 15_000, maxClients: 16 },
    /** 工作区浏览限制（契约 §4.3）。 */
    workspaceFs: { maxEntries: 2000, maxDepth: 4, maxFileBytes: 1024 * 1024, searchBudgetMs: 5000, searchMaxFiles: 20_000, searchMaxFileBytes: 2 * 1024 * 1024 },
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

/**
 * 整数区间校验（模块级：`validateMirror`/`validateRelay` 也要用，
 * 之前做成 validateConfig 的内部闭包会导致子函数 ReferenceError）。
 * @param {unknown} value
 * @param {string} name
 * @param {{min: number, max: number}} range
 */
function intInRange(value, name, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`配置项 ${name} 必须是 ${min}~${max} 之间的整数（当前：${JSON.stringify(value)}）`);
  }
  return value;
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
 * 合并配置。支持任意数量的补丁（后者覆盖前者）。
 * 为什么做成变参：曾出现「调用方多传一个 patch 参数被静默忽略」的缺陷
 * （测试脚手架因此丢掉了所有用例级覆盖，表现为假失败）。变参 + 单测锁定后不会再发生。
 * @param {object} base
 * @param {...object} patches
 */
export function mergeConfig(base, ...patches) {
  let out = base;
  for (const patch of patches) out = deepMerge(out, patch);
  return out;
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
  // 安装脚本会持久化整份默认配置；旧配置中的版本不能覆盖当前运行的实现版本。
  cfg.gatewayVersion = GATEWAY_VERSION;
  if (cfg.relay) cfg.relay.gatewayVersion = GATEWAY_VERSION;
  const intIn = intInRange;

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

  // ---- v2 校验 ----
  validateMirror(cfg, env);
  validateRelay(cfg);
  validateDsh(cfg);
  // 会话来源：网关自己创建的（可写/可续聊） + 真实 DSH 镜像（只读）。
  // `source` 取值按 lead 裁定与契约逐字一致：`phone`（手机新建、可续聊）/ `computer`（电脑端只读镜像）。
  // 顺序即优先级：先查网关自己的 home（小且可写），再查镜像。
  const roots = [{ home: cfg.dsh.sessionsHome, source: 'phone', writable: true, label: '手机任务会话' }];
  if (cfg.mirror.enabled) {
    roots.push({ home: cfg.mirror.resolvedHome, source: 'computer', writable: false, label: '电脑端会话（只读镜像）' });
  }
  cfg.sessionRoots = roots;
  intIn(cfg.sessionStream.bufferSize, 'sessionStream.bufferSize', { min: 1, max: 1_000_000 });
  intIn(cfg.sessionStream.heartbeatMs, 'sessionStream.heartbeatMs', { min: 10, max: 600_000 });
  intIn(cfg.sessionStream.maxClients, 'sessionStream.maxClients', { min: 1, max: 10_000 });
  for (const key of ['maxEntries', 'maxDepth', 'maxFileBytes', 'searchBudgetMs', 'searchMaxFiles', 'searchMaxFileBytes']) {
    const max = key === 'maxDepth' ? 16 : 1_073_741_824;
    intIn(cfg.workspaceFs[key], `workspaceFs.${key}`, { min: 1, max });
  }
  if (cfg.dsh.exeArgs !== null && cfg.dsh.exeArgs !== undefined && !Array.isArray(cfg.dsh.exeArgs)) {
    throw new ConfigError('配置项 dsh.exeArgs 必须是字符串数组或 null');
  }
  for (const key of ['launcher', 'electronPath', 'cliPath']) {
    const value = cfg.dsh[key];
    if (value !== null && value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new ConfigError(`配置项 dsh.${key} 必须是非空字符串或 null`);
    }
  }
  return cfg;
}

/** 校验 dsh 启动配置，并解析出 SDK 会话 home。 */
function validateDsh(cfg) {
  const sessionsHome = cfg.dsh.sessionsHome;
  if (sessionsHome !== null && sessionsHome !== undefined) {
    if (typeof sessionsHome !== 'string' || !sessionsHome.trim()) {
      throw new ConfigError('配置项 dsh.sessionsHome 必须是非空字符串或 null');
    }
    cfg.dsh.sessionsHome = path.resolve(sessionsHome);
  } else {
    cfg.dsh.sessionsHome = path.join(cfg.home, 'dsh-home');
  }
  if (path.resolve(cfg.dsh.sessionsHome) === path.resolve(cfg.home)) {
    throw new ConfigError('配置项 dsh.sessionsHome 不能等于网关运行时 home（会把 SDK 会话与 devices.json/logs 混在一起）');
  }
  for (const key of ['provider', 'model', 'apiKeyEnv']) {
    if (typeof cfg.dsh[key] !== 'string' || !cfg.dsh[key].trim()) throw new ConfigError(`配置项 dsh.${key} 必须是非空字符串`);
  }
  if (cfg.dsh.reasoningEffort !== null && (typeof cfg.dsh.reasoningEffort !== 'string' || !cfg.dsh.reasoningEffort.trim())) {
    cfg.dsh.reasoningEffort = null; // 空串视为"用模型默认"
  }
  if (cfg.dsh.maxTokens !== null && (!Number.isSafeInteger(cfg.dsh.maxTokens) || cfg.dsh.maxTokens <= 0)) {
    throw new ConfigError('配置项 dsh.maxTokens 必须是正整数或 null');
  }
  intInRange(cfg.dsh.turnTimeoutSec, 'dsh.turnTimeoutSec', { min: 5, max: 86_400 });
  intInRange(cfg.dsh.runtimeIdleMs, 'dsh.runtimeIdleMs', { min: 0, max: 86_400_000 });
  if (cfg.dsh.credentialsFile !== null && cfg.dsh.credentialsFile !== undefined) {
    if (typeof cfg.dsh.credentialsFile !== 'string' || !cfg.dsh.credentialsFile.trim()) {
      throw new ConfigError('配置项 dsh.credentialsFile 必须是非空字符串或 null');
    }
    cfg.dsh.credentialsFile = path.resolve(cfg.dsh.credentialsFile);
  }
}

/** 校验会话镜像配置，并解析出实际的镜像 home（启动横幅会打印它，便于运维核对）。 */
function validateMirror(cfg, env = process.env) {
  // 电脑端通道（审批/提问）。校验的意义不是"拦住误配"，而是让"审批收不到"在**启动时**
  // 就变成一句明确的配置错误，而不是等用户在手机上发现什么都没有。
  const desktop = cfg.desktop ?? {};
  if (typeof desktop.enabled !== 'boolean') throw new ConfigError('配置项 desktop.enabled 必须是布尔值');
  if (typeof desktop.host !== 'string' || !desktop.host.trim()) {
    throw new ConfigError('配置项 desktop.host 必须是非空字符串（默认 127.0.0.1）');
  }
  // 0 = 不做固定端口尝试，只靠 autoDiscover；老版本桌面端仍可用 19387。
  if (!Number.isInteger(desktop.port) || desktop.port < 0 || desktop.port > 65_535) {
    throw new ConfigError('配置项 desktop.port 必须是 0~65535 之间的整数（默认 19387；0 = 只自动发现）');
  }
  if (typeof desktop.autoDiscover !== 'boolean') throw new ConfigError('配置项 desktop.autoDiscover 必须是布尔值');
  if (desktop.dshHome !== null && desktop.dshHome !== undefined) {
    if (typeof desktop.dshHome !== 'string' || !desktop.dshHome.trim()) {
      throw new ConfigError('配置项 desktop.dshHome 必须是非空字符串或 null');
    }
    desktop.dshHome = path.resolve(desktop.dshHome);
  }
  cfg.desktop = desktop;

  // 电脑端会话实时中继。校验的意义同样是"把静音变成启动时的一句明确错误"：
  // `pollMs` 配成 0 或负数会让 watcher 变成忙轮询，`attachTimeoutMs` 配太小则订阅永远握不上手。
  const desktopWatch = cfg.desktopWatch ?? {};
  if (typeof desktopWatch.enabled !== 'boolean') throw new ConfigError('配置项 desktopWatch.enabled 必须是布尔值');
  // 下限只防"0/负数变成忙轮询"；测试装置合法地会用几十毫秒的间隔精确驱动发现循环。
  desktopWatch.pollMs = intInRange(desktopWatch.pollMs, 'desktopWatch.pollMs', { min: 20, max: 600_000 });
  desktopWatch.streamTimeoutMs = intInRange(desktopWatch.streamTimeoutMs, 'desktopWatch.streamTimeoutMs', {
    min: 1000,
    max: 24 * 3600_000,
  });
  desktopWatch.attachTimeoutMs = intInRange(desktopWatch.attachTimeoutMs, 'desktopWatch.attachTimeoutMs', {
    min: 500,
    max: 600_000,
  });
  cfg.desktopWatch = desktopWatch;

  const mirror = cfg.mirror ?? {};
  if (typeof mirror.enabled !== 'boolean') throw new ConfigError('配置项 mirror.enabled 必须是布尔值');
  if (mirror.dshHome !== null && mirror.dshHome !== undefined) {
    if (typeof mirror.dshHome !== 'string' || !mirror.dshHome.trim()) {
      throw new ConfigError('配置项 mirror.dshHome 必须是非空字符串或 null');
    }
    mirror.dshHome = path.resolve(mirror.dshHome);
  }
  if (typeof mirror.onlyAllowlistedWorkspaces !== 'boolean') throw new ConfigError('配置项 mirror.onlyAllowlistedWorkspaces 必须是布尔值');
  if (typeof mirror.includeSubagentsByDefault !== 'boolean') throw new ConfigError('配置项 mirror.includeSubagentsByDefault 必须是布尔值');
  if (!Number.isInteger(mirror.liveWindowMs) || mirror.liveWindowMs < 1000 || mirror.liveWindowMs > 86_400_000) {
    throw new ConfigError('配置项 mirror.liveWindowMs 必须是 1000~86400000 之间的整数');
  }
  if (!Number.isInteger(mirror.listLimit) || mirror.listLimit < 1 || mirror.listLimit > 1000) {
    throw new ConfigError('配置项 mirror.listLimit 必须是 1~1000 之间的整数');
  }
  if (!Number.isInteger(mirror.listLimitMax) || mirror.listLimitMax < mirror.listLimit || mirror.listLimitMax > 1000) {
    throw new ConfigError('配置项 mirror.listLimitMax 必须 ≥ mirror.listLimit 且 ≤ 1000');
  }
  // 刻意不经 `config.home`：那是网关自身运行时 home（默认 ~/.dsh-remote），作为镜像源只会读到空目录
  const resolved = resolveDshHome({ explicit: mirror.dshHome, env });
  mirror.resolvedHome = resolved.path;
  mirror.homeSource = resolved.source;
  cfg.mirror = mirror;

  // 电脑端工作区同步：home 缺省跟 desktop / mirror 走（三者指向同一个 ~/.dsh 是常态）。
  const desktopWorkspaces = cfg.desktopWorkspaces ?? {};
  if (typeof desktopWorkspaces.enabled !== 'boolean') {
    throw new ConfigError('配置项 desktopWorkspaces.enabled 必须是布尔值');
  }
  desktopWorkspaces.pollMs = intInRange(desktopWorkspaces.pollMs, 'desktopWorkspaces.pollMs', { min: 500, max: 600_000 });
  if (desktopWorkspaces.home !== null && desktopWorkspaces.home !== undefined) {
    if (typeof desktopWorkspaces.home !== 'string' || !desktopWorkspaces.home.trim()) {
      throw new ConfigError('配置项 desktopWorkspaces.home 必须是非空字符串或 null');
    }
    desktopWorkspaces.home = path.resolve(desktopWorkspaces.home);
  }
  cfg.desktopWorkspaces = desktopWorkspaces;
}

/**
 * 校验中继配置。
 *
 * **安全红线（契约 §5.5.1）**：relay 功能开启时 `config.host` 必须是回环地址。
 * 为什么在**配置校验**阶段就拦：网关自己不做业务鉴权以外的入站保护，
 * 一旦把带隧道能力的网关绑到 0.0.0.0，局域网上任何设备都能打到它的 v1/v2 接口；
 * 这种错误必须在进程启动时炸掉，而不是等出了事再排查。
 */
function validateRelay(cfg) {
  const relay = cfg.relay ?? {};
  if (typeof relay.enabled !== 'boolean') throw new ConfigError('配置项 relay.enabled 必须是布尔值');
  if (typeof relay.url !== 'string') throw new ConfigError('配置项 relay.url 必须是字符串');
  if (relay.url.trim() && !/^(wss?|https?):\/\//i.test(relay.url.trim()) && !/^[a-z0-9.\-]+(:\d+)?$/i.test(relay.url.trim())) {
    throw new ConfigError(`配置项 relay.url 非法：${relay.url}（示例 ws://relay.example.com:9443）`);
  }
  for (const key of ['maxStreams', 'requestTimeoutMs', 'maxFrameBytes']) {
    intInRange(relay[key], `relay.${key}`, { min: key === 'maxStreams' ? 1 : 1000, max: key === 'maxStreams' ? 1024 : 1_073_741_824 });
  }
  intInRange(relay.pairWindow?.attempts, 'relay.pairWindow.attempts', { min: 1, max: 20 });
  intInRange(relay.reconnect?.minMs, 'relay.reconnect.minMs', { min: 100, max: 600_000 });
  intInRange(relay.reconnect?.maxMs, 'relay.reconnect.maxMs', { min: relay.reconnect.minMs, max: 3_600_000 });
  if (typeof relay.reconnect?.factor !== 'number' || relay.reconnect.factor < 1) throw new ConfigError('配置项 relay.reconnect.factor 必须是 ≥1 的数字');
  if (typeof relay.reconnect?.jitter !== 'number' || relay.reconnect.jitter < 0 || relay.reconnect.jitter > 1) throw new ConfigError('配置项 relay.reconnect.jitter 必须是 0~1 的数字');
  if (relay.enabled) {
    if (!relay.url.trim()) throw new ConfigError('relay.enabled=true 时必须配置 relay.url');
    if (!isLoopbackHost(cfg.host) && relay.allowNonLoopback !== true) {
      throw new ConfigError(
        `拒绝启动：relay 功能开启时 config.host 必须是回环地址（127.0.0.1 / ::1 / localhost），当前是 ${JSON.stringify(cfg.host)}。` +
          '网关绝不能把带中继隧道的接口暴露到局域网/公网（协议契约-v2 §5.5.1）。\n' +
          '两条出路：\n' +
          '  1) 把 config.json 的 "host" 改成 "127.0.0.1"（推荐，中继拓扑下 PC 本来就不需要入站端口）；\n' +
          '  2) 若你确实要让局域网也能直连（v1 行为），显式加 "relay": { "allowNonLoopback": true } —— 风险自担：\n' +
          '     绑到 0.0.0.0 后，同网段任何设备都能访问网关的 v1/v2 接口（仍有 Bearer 鉴权，但攻击面显著变大）。',
      );
    }
    if (!isLoopbackHost(cfg.host)) {
      relay._nonLoopbackAccepted = true; // 供启动横幅打风险警告
    }
  }
  if (typeof relay.allowNonLoopback !== 'boolean') throw new ConfigError('配置项 relay.allowNonLoopback 必须是布尔值');
  relay.homeToken = typeof relay.homeToken === 'string' && relay.homeToken.trim() ? relay.homeToken.trim() : null;
  cfg.relay = relay;
  cfg.relayStateFile = path.join(cfg.home, 'relay.json');
  cfg.relayEnabled = relay.enabled;
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
