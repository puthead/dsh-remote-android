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
import { ConfigError, GATEWAY_VERSION, ensureRuntimeDirs, isLoopbackHost, loadConfig } from './lib/config.mjs';
import { createGateway, V2_CAPABILITIES } from './lib/http.mjs';
import { DeviceStore } from './lib/tokens.mjs';
import { createLogger } from './lib/util.mjs';
import { listWorkspaces } from './lib/workspace.mjs';
import { SessionMirror } from './lib/session-reader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `dsh-remote v${GATEWAY_VERSION} —— DSH 远程任务网关（零第三方依赖）

用法：
  node gateway.mjs serve [选项]              启动网关（默认命令）
  node gateway.mjs pair [选项]               在 PC 本机生成 6 位配对码（走 127.0.0.1 回环接口）
  node gateway.mjs devices list [选项]        列出已配对设备
  node gateway.mjs devices revoke <tokenId>  吊销设备令牌
  node gateway.mjs workspaces [选项]          打印工作区白名单

v2（协议契约-v2）：
  node gateway.mjs relay connect             连接中继（无凭据时自动注册并落盘）
  node gateway.mjs relay status              查看隧道状态（含 homeId/重连次数）
  node gateway.mjs relay disconnect          主动断开隧道（配置保留）
  node gateway.mjs relay window              在本机开配对窗口并同步到中继（打印配对码）
  node gateway.mjs sessions [--limit n]      列出会话镜像（手机任务会话 + 电脑端只读会话）
  node gateway.mjs health                    打印 /api/v1/health 与 /api/v2/health

  node gateway.mjs --help | --version

选项：
  --config <path>  指定配置文件（默认 <本目录>/config.json）
  --home <path>    指定运行时 home（凭据 + tasks + logs），等价于设置 DSH_REMOTE_HOME
  --port <n>       覆盖监听端口
  --host <h>       覆盖监听地址
  --limit <n>      列表类命令的条数上限

示例：
  node gateway.mjs serve --config ./config.json
  node gateway.mjs pair --port 8787
  node gateway.mjs relay connect --port 8787
`;

/** 极简参数解析：命令 + 具名选项（值型）。 */
export function parseArgs(argv) {
  const args = { command: null, sub: null, positional: [], config: null, home: null, port: null, host: null, limit: null, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--version' || token === '-v') args.version = true;
    else if (token === '--config' || token === '--home' || token === '--port' || token === '--host' || token === '--limit') {
      const value = argv[++i];
      if (value === undefined) throw new ConfigError(`选项 ${token} 缺少取值`);
      if (token === '--config') args.config = value;
      else if (token === '--home') args.home = value;
      else if (token === '--port') args.port = value;
      else if (token === '--limit') args.limit = value;
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
  // v2：把两类会话来源打印清楚 —— "手机看不到会话"最常见的原因就是镜像源指错了目录
  lines.push(
    `  能力代次 : gatewayVersion=${config.gatewayVersion}  /api/v1/health.apiVersion=${config.apiVersion}  supportedApiVersions=${JSON.stringify(config.supportedApiVersions)}`,
  );
  lines.push(
    // 这份清单直接取自 /api/v2/health 的真值（lib/http.mjs 的 V2_CAPABILITIES）：
    // 以前这里是手写死的字符串，审批能力上线后它还在打印旧清单，
    // 排障时会被误读成「能力没实现」——2026-10-15 真机事故的直接教训。
    `  可用能力 : ${V2_CAPABILITIES.join(',')}（同 GET /api/v2/health 的 capabilities）`,
  );
  lines.push(`  代次自检 : 本进程横幅含 "supportedApiVersions" 即为 v2 构建；v1 旧构建的 /api/v2/* 会返回 404`);
  lines.push(
    `  会话镜像 : ${config.mirror.enabled ? `${config.mirror.resolvedHome}（只读，来源 ${config.mirror.homeSource}）` : '已禁用'}`,
  );
  lines.push(`  手机会话 : ${config.dsh.sessionsHome}（SDK profile 创建，可续聊）`);
  lines.push(
    `  会话续聊 : ${gateway.runner.available ? `可用（${gateway.runner.launch.source} → --profile sdk）` : '不可用：未找到 dsh 启动器'}`,
  );
  lines.push(
    `  中继隧道 : ${config.relay.url ? `${config.relay.url}（enabled=${config.relay.enabled}）` : '未配置（relay.url 为空）'}`,
  );
  for (const line of lines) console.log(line);
  if (!isLoopbackHost(config.host)) {
    console.log(`  ⚠ 风险   : host=${config.host} 绑定了非回环地址，局域网可直接访问网关接口（v1 兼容行为，保持可用）`);
  }
  logger.info(`网关启动完成 port=${port}`);
  if (gateway.runner.available) void gateway.runner; // 已在构造时打印启动器信息

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

/** 走本机回环调一个 v2 管理端点（relay/* 只接受回环来源，因此必须本机发起）。 */
async function loopbackJson(config, pathname, { method = 'GET', body = undefined } = {}) {
  const url = `${loopbackBase(config)}${pathname}`;
  const init = { method, headers: { 'X-Api-Version': String(config.apiVersion) } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json; charset=utf-8';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** 网关未运行时给出可操作的提示（而不是一句 ECONNREFUSED）。 */
function reportGatewayDown(config, err) {
  console.error(`无法连接网关：${err.message}`);
  console.error(`请确认网关已在 ${loopbackBase(config)} 运行（node gateway.mjs serve）。`);
  console.error('');
  console.error('代次自检（本机常有多个网关实例，连错端口会拿到"看起来像 bug、其实是旧构建"的行为）：');
  console.error(`  1) 探测 v2 能力：curl ${loopbackBase(config)}/api/v2/health  → 200 且含 supportedApiVersions 即 v2 构建`);
  console.error('  2) 若 /api/v1/health 返回 200 但 /api/v2/health 返回 404 → 你连的是 **v1 旧构建**（正常，但本轮 v2 命令都不适用）');
  console.error('  3) 用 netstat 看谁在占端口：netstat -ano | findstr :' + config.port);
  process.exitCode = 1;
}

/** `relay connect | status | disconnect | window`（契约 §4.1）。 */
async function cmdRelay(args) {
  const bootstrap = createLogger({ dir: null, toConsole: true });
  const config = buildConfig(args, bootstrap);
  const sub = args.sub ?? 'status';
  try {
    if (sub === 'connect') {
      if (!config.relay?.url) {
        console.error('未配置 relay.url。请在 config.json 里填写中继地址，例如 "relay": { "enabled": true, "url": "ws://127.0.0.1:9443" }');
        process.exitCode = 2;
        return;
      }
      const res = await loopbackJson(config, '/api/v2/relay/connect', { method: 'POST', body: {} });
      console.log(`HTTP ${res.status}`);
      console.log(JSON.stringify(res.json, null, 2));
      if (res.status !== 200) process.exitCode = 1;
      return;
    }
    if (sub === 'disconnect') {
      const res = await loopbackJson(config, '/api/v2/relay/disconnect', { method: 'POST', body: {} });
      console.log(JSON.stringify(res.json, null, 2));
      return;
    }
    if (sub === 'window') {
      const res = await loopbackJson(config, '/api/v2/pair/open', { method: 'POST', body: {} });
      if (res.status !== 200) {
        console.error(`开配对窗口失败：HTTP ${res.status} ${res.json?.error?.message ?? res.text}`);
        process.exitCode = 1;
        return;
      }
      console.log('配对码（请在手机 App 输入）：');
      console.log('');
      console.log(`    ${res.json.code}`);
      console.log('');
      console.log(`有效期至：${new Date(res.json.expiresAt).toLocaleString()}（一次性使用）`);
      if (res.json.relay) {
        console.log(`中继：homeId=${res.json.relay.homeId ?? '-'} relayName=${res.json.relay.relayName ?? '-'}`);
        console.log(`设备隧道：${res.json.relay.tunnelUrl ?? '(未连接中继)'}`);
      } else {
        console.log('中继：未连接（配对码只能在本机直连时使用）');
      }
      return;
    }
    // status
    const res = await loopbackJson(config, '/api/v2/relay/status');
    if (res.status !== 200) {
      console.error(`HTTP ${res.status} ${res.json?.error?.message ?? res.text}`);
      process.exitCode = 1;
      return;
    }
    const s = res.json;
    console.log('中继隧道状态：');
    console.log(`  网关代次   : gatewayVersion=${config.gatewayVersion}（本命令走 /api/v2/relay/status，能返回即证明该网关含 v2 能力）`);
    console.log(`  enabled    : ${s.enabled}`);
    console.log(`  connected  : ${s.connected}`);
    console.log(`  url        : ${s.url ?? '(未配置)'}`);
    console.log(`  homeId     : ${s.homeId ?? '-'}`);
    console.log(`  relayName  : ${s.relayName ?? '-'}`);
    console.log(`  since      : ${s.since ? new Date(s.since).toLocaleString() : '-'}`);
    console.log(`  reconnects : ${s.reconnects}（当前退避尝试 ${s.attempts}）`);
    console.log(`  inFlight   : ${s.inFlight}`);
    console.log(`  lastError  : ${s.lastError ?? '-'}`);
    console.log(`  凭据文件   : ${config.relayStateFile}`);
    return;
  } catch (err) {
    reportGatewayDown(config, err);
  }
}

/** `sessions`：列出会话镜像（手机任务会话 + 电脑端只读会话）。 */
async function cmdSessions(args) {
  const bootstrap = createLogger({ dir: null, toConsole: true });
  const config = buildConfig(args, bootstrap);
  const limit = args.limit ? Number(args.limit) : 50;
  console.log(`镜像 home（只读）: ${config.mirror.resolvedHome}  [来源 ${config.mirror.homeSource}]`);
  console.log(`手机会话 home    : ${config.dsh.sessionsHome}（可续聊）`);
  console.log('');
  const mirror = new SessionMirror({ roots: config.sessionRoots, liveWindowMs: config.mirror.liveWindowMs });
  const result = await mirror.list({ limit, includeSubagent: false });
  if (result.sessions.length === 0) {
    console.log('没有会话。（若期望看到电脑端会话，请确认 mirror.dshHome 指向 %USERPROFILE%\\.dsh）');
    return;
  }
  console.log(`会话（${result.sessions.length}/${result.total}）：`);
  for (const s of result.sessions) {
    const flags = [s.source === 'phone' ? '手机' : '电脑', s.writable ? '可续聊' : '只读', s.live ? '运行中' : '-'].join('/');
    console.log(`  [${flags}] ${s.id}`);
    console.log(`      ${s.turns} turns / ${s.steps} steps / ${s.bytes} B / updatedAt=${new Date(s.updatedAt).toLocaleString()} / ${s.lastTurn ? `${s.lastTurn.state}:${s.lastTurn.reason}` : '-'}`);
    console.log(`      ${s.title ?? '(无标题)'}  @ ${s.workspace ?? '-'}`);
  }
}

/** `health`：并排打印 v1 与 v2 的 health，便于核对 apiVersion 语义。 */
async function cmdHealth(args) {
  const bootstrap = createLogger({ dir: null, toConsole: true });
  const config = buildConfig(args, bootstrap);
  try {
    const v1 = await loopbackJson(config, '/api/v1/health');
    const v2 = await loopbackJson(config, '/api/v2/health');
    console.log('--- GET /api/v1/health ---');
    console.log(JSON.stringify(v1.json, null, 2));
    console.log('--- GET /api/v2/health ---');
    console.log(JSON.stringify(v2.json, null, 2));
    console.log('');
    console.log(`说明：v1 的 apiVersion=${v1.json?.apiVersion} 是 **v1 端点**的版本号（已交付客户端据此判断兼容性）；`);
    console.log(`      supportedApiVersions=${JSON.stringify(v1.json?.supportedApiVersions)} 才是网关支持的最高版本。`);
  } catch (err) {
    reportGatewayDown(config, err);
  }
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
    case 'relay':
      await cmdRelay(args);
      break;
    case 'sessions':
      await cmdSessions(args);
      break;
    case 'health':
      await cmdHealth(args);
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
