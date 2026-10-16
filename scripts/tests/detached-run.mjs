// detached-run.mjs —— 分离启动一个小工具（供 scripts/_common.ps1 的 Start-DetachedCommand 调用）。
//
// 为什么需要它：
//   在「捕获输出的宿主」（DSH 桌面端 / CI / Agent）里，用 Start-Process 启动后台服务时，
//   子进程会继承宿主的标准句柄与作业对象，宿主会一直等到服务退出才返回（表现为脚本卡死）。
//   cmd.exe 重定向那套（start-gateway.ps1 的 WMI 路线）能用，但无法注入环境变量、也拿不到
//   真实服务 PID（拿到的是短命的 cmd.exe）。这里用 node 的 detached + unref 一步到位：
//     * 环境变量可以逐个注入（E2E 需要 DSH_HOME 指向隔离目录）；
//     * 日志重定向到文件（子进程不持有宿主管道）；
//     * 子进程 PID 写入 --pidfile，父进程（本脚本）立刻退出。
//
// 用法：
//   node detached-run.mjs --pidfile <file> --out <stdout.log> --err <stderr.log> \
//        [--cwd <dir>] [--env K=V]... -- <command> [args...]
//
// 退出码：0 = 已写入 PID；1 = 启动失败（--pidfile 里是 { "error": "..." }）。
// 只使用 Node 内置模块（契约 §5.1）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  const pidfile = process.argv[2];
  try {
    if (pidfile && pidfile.endsWith('.json')) {
      fs.writeFileSync(pidfile, JSON.stringify({ error: String(message) }, null, 2), 'utf8');
    }
  } catch {
    /* 忽略：尽量把原因写到 stderr */
  }
  process.stderr.write(`[detached-run] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = { env: [], command: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      result.command = argv.slice(i + 1);
      break;
    }
    if (arg === '--pidfile' || arg === '--out' || arg === '--err' || arg === '--cwd' || arg === '--env') {
      const value = argv[i + 1];
      if (value === undefined) fail(`参数 ${arg} 缺少取值`);
      if (arg === '--env') {
        const eq = value.indexOf('=');
        if (eq <= 0) fail(`--env 需要 K=V 形式：${value}`);
        result.env.push([value.slice(0, eq), value.slice(eq + 1)]);
      } else {
        result[arg.slice(2)] = value;
      }
      i += 2;
      continue;
    }
    fail(`未知参数：${arg}`);
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));
if (!options.pidfile) fail('必须指定 --pidfile');
if (!options.out) fail('必须指定 --out');
if (!options.command || options.command.length === 0) fail('必须在 `--` 之后给出要启动的命令');

const pidfile = path.resolve(options.pidfile);
const outLog = path.resolve(options.out);
const errLog = path.resolve(options.err || `${options.out}.err`);
const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();

for (const dir of [path.dirname(pidfile), path.dirname(outLog), path.dirname(errLog)]) {
  fs.mkdirSync(dir, { recursive: true });
}

const childEnv = { ...process.env };
for (const [key, value] of options.env) childEnv[key] = value;

let outFd;
let errFd;
try {
  outFd = fs.openSync(outLog, 'a');
  errFd = fs.openSync(errLog, 'a');
} catch (error) {
  fail(`无法打开日志文件：${error.message}`);
}

let child;
try {
  child = spawn(options.command[0], options.command.slice(1), {
    cwd,
    env: childEnv,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
  });
} catch (error) {
  fail(`spawn 失败：${error.message}`);
}

let spawnError = null;
child.on('error', (error) => {
  spawnError = error;
});

// 给 spawn 一点时间把 ENOENT 之类的错误抛出来（Windows 上是异步的）。
await new Promise((resolve) => setTimeout(resolve, 400));
if (spawnError) fail(`spawn 失败：${spawnError.message}`);
if (!child.pid) fail('spawn 未返回 PID');

child.unref();
fs.writeFileSync(
  pidfile,
  JSON.stringify(
    {
      pid: child.pid,
      command: options.command,
      cwd,
      envKeys: options.env.map(([k]) => k),
      stdoutLog: outLog,
      stderrLog: errLog,
      startedAt: new Date().toISOString(),
      launcherPid: process.pid,
    },
    null,
    2,
  ),
  'utf8',
);
process.stdout.write(`[detached-run] pid=${child.pid} cwd=${cwd}\n`);
process.exit(0);
