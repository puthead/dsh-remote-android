#!/usr/bin/env node
/**
 * 中继服务入口（CLI）。
 *
 * 子命令：
 *   serve        启动中继（HTTP/HTTPS + WS 隧道）
 *   init         初始化运行目录 / 写 config.json / 生成自签证书（幂等）
 *   home-token   在本机注册一台 PC 的隧道凭据并打印**一次**明文 homeToken
 *   homes        列出已注册的 home（只含摘要与元数据，无明文）
 *   version      打印版本
 *
 * 为什么把 `init` 与 `serve` 分开：部署时"生成配置与证书"和"跑服务"是两种权限模型
 * （前者写目录、后者只读配置），分开后 VPS 上可以用只读账号跑 serve。
 *
 * 输出约定：**机器可读的 JSON 走 stdout**，人类提示走 stderr —— 这样
 * `scripts/setup-relay.ps1` / `start-relay.ps1` 可以直接解析 stdout，不会被提示语污染。
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { API_VERSION, ConfigError, RELAY_VERSION, defaultConfig, deriveTunnelUrl, ensureRuntimeDirs, loadConfig, mergeConfig, validateConfig } from './lib/config.mjs';
import { createLogger, silentLogger } from './lib/log.mjs';
import { RelayRegistry } from './lib/registry.mjs';
import { ensureTlsMaterial } from './lib/tls.mjs';
import { randomBase64Url, redactToken, str } from './lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `serve` 收到 SIGTERM/SIGINT 后允许优雅关闭的最长时间；到点无论如何都退出（systemd 的
 * TimeoutStopSec 应大于它，见部署脚本模板）。现场曾卡满 90 秒被 SIGKILL，见验收报告 §10。 */
const SHUTDOWN_GRACE_MS = Number(process.env.DSH_RELAY_SHUTDOWN_GRACE_MS ?? 8000);
const USAGE = `DSH 中继服务 v${RELAY_VERSION}（契约 apiVersion=${API_VERSION}）

用法：
  node relay.mjs serve      [--config <path>] [--home <dir>] [--host <ip>] [--port <n>]
                            [--relay-name <name>] [--relay-secret <s>] [--tls off|selfsigned|file]
                            [--cert <crt>] [--key <key>]
  node relay.mjs init       [--home <dir>] [--config <path>] [--force] [--port <n>] [--host <ip>]
                            [--relay-name <name>] [--relay-secret <s>] [--tls-mode selfsigned|off|file]
  node relay.mjs home-token [--home <dir>] [--config <path>] [--name <PC 名称>]
  node relay.mjs homes      [--home <dir>] [--config <path>]
  node relay.mjs version

运行目录解析优先级：--home > 环境变量 DSH_RELAY_HOME > config.home > ~/.dsh-relay
配置文件解析优先级：--config > 环境变量 DSH_RELAY_CONFIG > <运行目录>/config.json`;

/**
 * 极简参数解析：只支持 `--key value` 与 `--key=value` 与布尔开关。
 * 为什么不用第三方解析器：零依赖约束；顺带保证 `-` / `--` 混用时行为可预期。
 * @param {string[]} argv
 * @returns {{_: string[], flags: Record<string, string|boolean>}}
 */
export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        out.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
      continue;
    }
    out._.push(arg);
  }
  return out;
}

/** 从 flags 构造 loadConfig 用的 CLI 覆盖（只覆盖显式给出的项）。 */
function cliOverrides(flags) {
  const overrides = {};
  if (flags.host !== undefined) overrides.host = String(flags.host);
  if (flags.port !== undefined) overrides.port = Number(flags.port);
  if (flags['relay-name'] !== undefined) overrides.relayName = String(flags['relay-name']);
  if (flags['relay-secret'] !== undefined) overrides.relaySecret = String(flags['relay-secret']);
  if (flags['public-url'] !== undefined) overrides.publicUrl = String(flags['public-url']);
  if (flags['pair-ttl'] !== undefined) overrides.pairWindowTtlMs = Number(flags['pair-ttl']);
  if (flags.tls !== undefined) overrides.tls = { ...(overrides.tls ?? {}), mode: String(flags.tls) };
  if (flags['tls-mode'] !== undefined) overrides.tls = { ...(overrides.tls ?? {}), mode: String(flags['tls-mode']) };
  if (flags.cert !== undefined) overrides.tls = { ...(overrides.tls ?? {}), certFile: String(flags.cert) };
  if (flags.key !== undefined) overrides.tls = { ...(overrides.tls ?? {}), keyFile: String(flags.key) };
  if (flags['self-signed-dir'] !== undefined) overrides.tls = { ...(overrides.tls ?? {}), selfSignedDir: String(flags['self-signed-dir']) };
  return overrides;
}

/** 供 config.json 落盘的形态（去掉所有派生字段，避免"配置文件里出现绝对路径"）。 */
function toConfigFile(config) {
  return {
    relayName: config.relayName,
    host: config.host,
    port: config.port,
    relaySecret: config.relaySecret,
    publicUrl: config.publicUrl,
    tls: {
      mode: config.tls.mode,
      certFile: config.tls.mode === 'file' ? config.tls.certFile : null,
      keyFile: config.tls.mode === 'file' ? config.tls.keyFile : null,
      selfSignedDir: config.tls.selfSignedDir,
      commonName: config.tls.commonName,
      days: config.tls.days,
    },
    limits: { ...config.limits },
    heartbeat: { ...config.heartbeat },
    pairWindowTtlMs: config.pairWindowTtlMs,
    log: { ...config.log },
  };
}

/** 载入配置文件（不存在则用默认值）。 */
function load({ flags, logger = null }) {
  // 给了 --home 就去那里找 config.json：`init --home X` 正是把配置写进 X 的，
  // 否则用户必须同时记住 --home 与 --config 两个参数，这是纯粹的脚枪。
  const home = flags.home ? path.resolve(String(flags.home)) : process.env.DSH_RELAY_HOME ? path.resolve(process.env.DSH_RELAY_HOME) : null;
  return loadConfig({
    configPath: flags.config ? String(flags.config) : null,
    cliOverrides: cliOverrides(flags),
    cliHome: home,
    defaultDir: home ?? HERE,
    logger,
    requireTlsFiles: true,
  });
}

/** 人类提示写 stderr（stdout 只留给机器可读 JSON）。 */
function note(text) {
  process.stderr.write(`${text}\n`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- 子命令

async function cmdServe(flags) {
  const config = load({ flags, logger: silentLogger });
  await ensureRuntimeDirs(config);
  const logger = createLogger({
    dir: config.logsDir,
    filePrefix: config.log.filePrefix,
    toConsole: config.log.toConsole,
    // 关键约定：**stdout 只留给机器可读 JSON**，控制台日志一律走 stderr。
    // 否则 ops 脚本解析 stdout 时会把日志行混进 JSON（第一版就踩了这个坑）。
    consoleLike: { log: (...args) => process.stderr.write(`${args.join(' ')}\n`), error: (...args) => process.stderr.write(`${args.join(' ')}\n`), warn: (...args) => process.stderr.write(`${args.join(' ')}\n`) },
  });
  const { createRelay } = await import('./lib/http.mjs');
  const relay = await createRelay(config, { logger });
  const port = await relay.listen();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`收到 ${signal}，开始优雅关闭`);
    // 看门狗：现场出现过「隧道已拆、进程却静默挂着」，systemd 只能等 TimeoutStopSec 再 SIGKILL
    // （实测 90 秒）。这里保证关闭永远有上限，并把残留句柄写进日志便于定位。
    const watchdog = setTimeout(() => {
      const handles = process.getActiveResourcesInfo().join(', ') || '无';
      logger.warn(`优雅关闭超过 ${SHUTDOWN_GRACE_MS}ms 仍未完成，强制退出（残留句柄：${handles}）`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    try {
      await relay.close();
    } catch (err) {
      logger.error(`关闭时出错：${err.message}`);
    }
    clearTimeout(watchdog);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // stdout 一行 JSON：ops 脚本据此拿到真实端口（port=0 时由系统分配）
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      pid: process.pid,
      relayVersion: RELAY_VERSION,
      apiVersion: API_VERSION,
      host: config.host,
      port,
      tlsMode: config.tls.mode,
      relayName: config.relayName,
      tunnelUrl: deriveTunnelUrl({ ...config, port }),
      home: config.home,
      configPath: config.configPath,
    })}\n`,
  );
  note(`中继已启动：${config.tls.mode === 'off' ? 'ws' : 'wss'}://${config.host}:${port}  health=http://127.0.0.1:${port}/health`);
  return 0;
}

async function cmdInit(flags) {
  const home = path.resolve(str(flags.home) || process.env.DSH_RELAY_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh-relay'));
  const configFile = flags.config ? path.resolve(String(flags.config)) : path.join(home, 'config.json');
  const force = flags.force === true;
  const tlsMode = str(flags['tls-mode'] || flags.tls, 'selfsigned');

  let base = defaultConfig(process.env);
  if (flags['relay-name']) base.relayName = String(flags['relay-name']);
  if (flags.host) base.host = String(flags.host);
  if (flags.port) base.port = Number(flags.port);
  base.relaySecret = flags['relay-secret'] !== undefined ? String(flags['relay-secret']) : randomBase64Url(24);
  base.tls = { ...base.tls, mode: tlsMode };
  if (flags['self-signed-dir']) base.tls.selfSignedDir = String(flags['self-signed-dir']);
  // `--public-url`：手机侧看到的隧道地址基址。**这里曾经漏赋值**（只在 cliOverrides 里处理过，
  // 而 init 走的是这条独立路径），后果是部署时传了也静默丢弃 → 中继退回按 relayName 派生
  // tunnelUrl（config.mjs:deriveTunnelUrl）→ 手机连不上（"手机连不上"的头号原因）。
  // `--common-name` 同理：自签证书的 CN/SAN，漏了会让证书与 publicUrl 主机名不匹配。
  if (flags['public-url'] !== undefined) base.publicUrl = String(flags['public-url']);
  if (flags['common-name'] !== undefined) base.tls.commonName = String(flags['common-name']);
  // `--cert` / `--key`：`tls.mode=file`（正式证书，如 Let's Encrypt）的证书链与私钥路径。
  // 与 public-url 同一类接缝：cliOverrides 里有这两项（serve/home-token 走 load() 时生效），
  // 但 init 走的是上面这条独立拼装路径 —— 漏了就会直接抛
  // "tls.mode=file 时必须同时提供 tls.certFile 与 tls.keyFile"，
  // 于是**公网正式证书形态无法用 CLI 初始化**，只能手工改 config.json。
  if (flags.cert !== undefined) base.tls.certFile = String(flags.cert);
  if (flags.key !== undefined) base.tls.keyFile = String(flags.key);
  base.home = home;

  const config = validateConfig(base, { cliHome: home, env: process.env });
  await ensureRuntimeDirs(config);

  const fs = await import('node:fs/promises');
  const exists = await fs
    .access(configFile)
    .then(() => true)
    .catch(() => false);
  if (exists && !force && flags['relay-secret'] === undefined) {
    note(`配置文件已存在，保留原样：${configFile}（如需覆盖请加 --force 或显式传 --relay-secret）`);
  } else {
    await fs.writeFile(configFile, `${JSON.stringify(toConfigFile(config), null, 2)}\n`, 'utf8');
    note(`已写入配置：${configFile}`);
  }

  const material = await ensureTlsMaterial(config, { logger: silentLogger, regenerate: force && tlsMode === 'selfsigned' });
  const registry = new RelayRegistry({ file: config.homesFile, logger: silentLogger });
  await registry.load();
  await registry.flush({ force: true });

  printJson({
    ok: true,
    home: config.home,
    configPath: configFile,
    homesFile: config.homesFile,
    logsDir: config.logsDir,
    relayName: config.relayName,
    host: config.host,
    port: config.port,
    tls: { mode: config.tls.mode, certFile: material?.certFile ?? null, keyFile: material?.keyFile ?? null, generated: material?.generated ?? false },
    relaySecret: config.relaySecret,
    tunnelUrl: deriveTunnelUrl(config),
    next: [
      `node relay.mjs serve --home "${config.home}"`,
      `node relay.mjs home-token --home "${config.home}" --name "${config.relayName}"`,
    ],
  });
  note('init 完成。relaySecret 与 homeToken 都是秘密：请只放在 PC 侧配置里，不要贴进聊天/日志。');
  return 0;
}

async function cmdHomeToken(flags) {
  const config = load({ flags, logger: silentLogger });
  await ensureRuntimeDirs(config);
  const logger = createLogger({ dir: config.logsDir, filePrefix: config.log.filePrefix, toConsole: false });
  const registry = new RelayRegistry({ file: config.homesFile, logger, now: Date.now, pairWindowTtlMs: config.pairWindowTtlMs });
  await registry.load();
  const name = str(flags.name) || config.relayName;
  const result = registry.registerHome({ homeName: name, gatewayVersion: `relay-cli/${RELAY_VERSION}` });
  await registry.flush();
  printJson({
    ok: true,
    homeId: result.homeId,
    homeToken: result.homeToken,
    rotated: result.rotated,
    homeName: result.homeName,
    relayName: config.relayName,
    tunnelHomeUrl: `${config.tls.mode === 'off' ? 'ws' : 'wss'}://${config.relayName}:${config.port}/api/v2/tunnel/home`,
    deviceTunnelUrl: deriveTunnelUrl(config),
    home: config.home,
  });
  note(`homeToken 只在此处出现一次（${redactToken(result.homeToken)}）；请写入 PC 侧网关配置的 relay.homeToken，切勿写进日志或提交到仓库。`);
  return 0;
}

async function cmdHomes(flags) {
  const config = load({ flags, logger: silentLogger });
  const registry = new RelayRegistry({ file: config.homesFile, logger: silentLogger });
  await registry.load();
  printJson({ ok: true, home: config.home, homesFile: config.homesFile, homes: registry.listHomes() });
  return 0;
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const { _, flags } = parseArgs(argv);
  const command = _[0] ?? 'help';
  switch (command) {
    case 'serve':
      return await cmdServe(flags);
    case 'init':
      return await cmdInit(flags);
    case 'home-token':
    case 'token':
      return await cmdHomeToken(flags);
    case 'homes':
      return await cmdHomes(flags);
    case 'version': {
      printJson({ ok: true, relayVersion: RELAY_VERSION, apiVersion: API_VERSION, node: process.version });
      return 0;
    }
    case 'help':
    case '--help':
    case '-h':
      note(USAGE);
      return 0;
    default:
      note(`未知子命令：${command}\n\n${USAGE}`);
      return 2;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof ConfigError) {
      note(`配置错误：${err.message}`);
      process.exitCode = 2;
      return;
    }
    note(`启动失败：${err?.stack ?? err}`);
    process.exitCode = 1;
  });
