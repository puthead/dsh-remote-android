#!/usr/bin/env node
/**
 * dsh-remote 网关入口与本地 CLI。
 *
 * 职责：解析命令行 → 加载配置 → 组装网关 → 监听/管理命令。
 *
 * 为什么把管理命令（pair / devices）做成同一个入口的子命令：
 * PC 端运维只需要记住一个程序；`pair` 走本地回环 HTTP（契约 §2.1 要求配对必须本地发起），
 * 而 `devices` 直接读写 %DSH_HOME%/devices.json —— 管理员本来就有文件权限，
 * 不需要在「还没有令牌」的鸡生蛋场景里再设计一套本地口令。
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ConfigError, GATEWAY_VERSION, ensureRuntimeDirs, loadConfig } from './lib/config.mjs';
import { createGateway } from './lib/http.mjs';
import { DeviceStore } from './lib/tokens.mjs';
import { createLogger } from './lib/util.mjs';
import { listWorkspaces } from './lib/workspace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `dsh-remote v${GATEWAY_VERSION} —— DSH 远程任务网关（零第三方依赖）

用法：
  node gateway.mjs serve [选项]              启动网关（默认命令）
  node gateway.mjs pair [选项]               在 PC 本机生成 6 位配对码（走 127.0.0.1 回环接口）
  node gateway.mjs devices list [选项]        列出已配对设备
  node gateway.mjs devices revoke <tokenId>  吊销设备令牌
  node gateway.mjs workspaces [选项]          打印工作区白名单
  node gateway.mjs --help | --version

选项：
  --config <path>  指定配置文件（默认 <本目录>/config.json）
  --home <path>    指定运行时 home（凭据 + tasks + logs），等价于设置 DSH_REMOTE_HOME
  --port <n>       覆盖监听端口
  --host <h>       覆盖监听地址

示例：
  node gateway.mjs serve --config ./config.json
  node gateway.mjs pair --port 8787
`;

/** 极简参数解析：命令 + 具名选项（值型）。 */
export function parseArgs(argv) {
  const args = { command: null, sub: null, positional: [], config: null, home: null, port: null, host: null, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--version' || token === '-v') args.version = true;
    else if (token === '--config' || token === '--home' || token === '--port' || token === '--host') {
      const value = argv[++i];
      if (value === undefined) throw new ConfigError(`选项 ${token} 缺少取值`);
      if (token === '--config') args.config = value;
      else if (token === '--home') args.home = value;
      else if (token === '--port') args.port = value;
      else args.host = value;
    } else if (token.startsWith('--')) {
      throw new ConfigError(`未知选项：${token}`);
    } else if (args.command === null) {
      args.command = token;
    } else if (args.sub === null) {
      args.sub = token;
    } else {
      args.positional.push(token);
    }
  }
  return args;
}

/** 组装配置（CLI 覆盖 > 配置文件 > 默认值）。 */
function buildConfig(args, logger) {
  const overrides = {};
  if (args.port !== null) {
    const port = Number(args.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`--port 非法：${args.port}`);
    overrides.port = port;
  }
  if (args.host !== null) overrides.host = args.host;
  return loadConfig({
    configPath: args.config,
    cliOverrides: overrides,
    cliHome: args.home,
    env: process.env,
    defaultDir: HERE,
    logger,
  });
}

/** 读取网关地址（pair 命令使用；只允许回环）。 */
function loopbackBase(config) {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}`;
}

async function cmdServe(args) {
  // 配置加载阶段还没有 home，因此先用仅控制台的引导日志器
  const bootstrap = createLogger({ dir: null, toConsole: true });
  const config = buildConfig(args, bootstrap);
  await ensureRuntimeDirs(config);
  const logger = createLogger({ dir: config.logsDir, filePrefix: config.log.filePrefix, toConsole: config.log.toConsole });

  const gateway = await createGateway(config, { logger });
  const port = await gateway.listen();

  if (!config.dsh.node || !config.dsh.binPath) {
    logger.warn('未配置 dsh.node / dsh.binPath，提交的任务将全部失败（请检查 config.json）');
  }

  const lines = [
    `dsh-remote v${config.gatewayVersion} 已启动`,
    `  监听地址 : http://${config.host}:${port}`,
    `  本机地址 : ${loopbackBase({ ...config, port })}`,
    `  DSH_HOME : ${config.home}`,
    `  白名单   : ${config.workspaceAllowlist.join(' | ') || '(空，将拒绝所有任务)'}`,
    `  并发/队列: ${config.maxConcurrent} / ${config.maxQueue}`,
    `  日志     : ${path.join(config.logsDir, `${config.log.filePrefix}-YYYYMMDD.log`)}`,
    `  下一步   : node gateway.mjs pair --port ${port}   （或用 pair.ps1 生成配对码）`,
  ];
  for (const line of lines) console.log(line);
  logger.info(`网关启动完成 port=${port}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在优雅关闭…`);
    try {
      await gateway.close();
      logger.info(`网关已关闭（${signal}）`);
    } catch (err) {
      logger.error(`关闭过程出错：${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error(`未处理的 Promise 拒绝：${reason?.stack ?? reason}`));
  process.on('uncaughtException', (err) => logger.error(`未捕获异常：${err?.stack ?? err}`));
  return gateway;
}

async function cmdPair(args) {
  const bootstrap = createLogger({ dir: null, toConsole: true });
  const config = buildConfig(args, bootstrap);
  const url = `${loopbackBase(config)}/api/v1/pair/open`;
  let payload;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'X-Api-Version': String(config.apiVersion) } });
    payload = await res.json().catch(() => null);
    if (!res.ok) {
      const message = payload?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(message);
    }
  } catch (err) {
    console.error(`生成配对码失败：${err.message}`);
    console.error(`请确认网关已在 ${loopbackBase(config)} 运行（node gateway.mjs serve）。`);
    process.exitCode = 1;
    return;
  }
  console.log('配对码（请在手机 App 的"配对"页面输入）：');
  console.log('');
  console.log(`    ${payload.code}`);
  console.log('');
  console.log(`有效期至：${new Date(payload.expiresAt).toLocaleString()}（一次性使用，过期请重新生成）`);
}

async function cmdDevices(args) {
  const bootstrap = createLogger({ dir: null, toConsole: true });
  const config = buildConfig(args, bootstrap);
  const store = new DeviceStore({ file: config.devicesFile });
  await store.load();

  if (args.sub === 'list' || args.sub === null) {
    const devices = store.list();
    if (devices.length === 0) {
      console.log('当前没有已配对设备。');
      return;
    }
    console.log(`已配对设备（${devices.length}）：`);
    for (const device of devices) {
      console.log(
        `  ${device.tokenId}  ${device.deviceName}  配对于 ${new Date(device.pairedAt).toLocaleString()}  最近使用 ${new Date(device.lastSeenAt).toLocaleString()}`,
      );
    }
    return;
  }

  if (args.sub === 'revoke') {
    const tokenId = args.positional[0];
    if (!tokenId) {
      console.error('用法：node gateway.mjs devices revoke <tokenId>');
      process.exitCode = 2;
      return;
    }
    const ok = await store.revoke(tokenId);
    if (!ok) {
      console.error(`未找到令牌：${tokenId}`);
      process.exitCode = 1;
      return;
    }
    console.log(`已吊销令牌 ${tokenId}（手机端下次请求将收到 401，需要重新配对）`);
    return;
  }

  console.error(`未知子命令：devices ${args.sub}`);
  process.exitCode = 2;
}

async function cmdWorkspaces(args) {
  const bootstrap = createLogger({ dir: null, toConsole: true });
  const config = buildConfig(args, bootstrap);
  const { workspaces, default: def } = await listWorkspaces({
    allowlist: config.workspaceAllowlist,
    defaultWorkspace: config.defaultWorkspace,
  });
  if (workspaces.length === 0) {
    console.log('白名单为空：网关将拒绝所有任务。请在 config.json 的 workspaceAllowlist 中配置目录。');
    return;
  }
  console.log('工作区白名单：');
  for (const item of workspaces) {
    const mark = item.path === def ? '*' : ' ';
    console.log(`${mark} ${item.path}  (${item.exists ? '存在' : '不存在'})`);
  }
  console.log('\n(*) 为默认工作区');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(GATEWAY_VERSION);
    return;
  }
  if (args.help || args.command === 'help') {
    console.log(USAGE);
    return;
  }
  switch (args.command ?? 'serve') {
    case 'serve':
      await cmdServe(args);
      break;
    case 'pair':
      await cmdPair(args);
      break;
    case 'devices':
      await cmdDevices(args);
      break;
    case 'workspaces':
      await cmdWorkspaces(args);
      break;
    default:
      console.error(`未知命令：${args.command}\n`);
      console.log(USAGE);
      process.exitCode = 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    if (err instanceof ConfigError) {
      console.error(`配置错误：${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`启动失败：${err?.stack ?? err}`);
    process.exitCode = 1;
  });
}

export { main, buildConfig, loopbackBase, USAGE, HERE };
