/**
 * 桌面端 DSH runtime 的本地端口发现（**网关连不上电脑端的根因修复**）。
 *
 * ## 为什么必须发现端口
 *
 * DSH 桌面端（0.2.0 起）的 Host 进程由 Electron 用 `--port 0` 启动：操作系统分配
 * 一个**随机高位端口**，URL 只经 IPC 交给 Electron 窗口，既不写配置文件也不占固定端口。
 * 网关过去把 `desktop.port` 默认写死 19387，于是从桌面端升级后：
 * - 审批桥每一轮都在 `ws://127.0.0.1:19387` 重连失败；
 * - `session/list` 永远不可达 → 电脑端会话运行态、会话投影、实时中继全静音；
 * - 手机端工作区只能看见网关配置文件里的白名单，电脑端新建的工作区根本同步不过去。
 *
 * ## 做法
 *
 * 只做**发现候选端口**，不做任何信任判断：真正的鉴权仍由 DesktopApi 用
 * `~/.dsh/.credentials.yaml` 里的 browser-session secret 自签 cookie 完成。
 * 候选来自「命令行里带 `dsh-desktop-host/lib/index.js` 的进程」正在监听的
 * 回环端口；另一个 DSH 实例、别的应用、甚至恶意进程都可以出现在候选里，
 * 但它们拿不到该 home 的签名 cookie，会在下一层被拒。
 *
 * Windows 用 PowerShell（`Get-CimInstance` + `Get-NetTCPConnection`，失败时退回
 * `netstat -ano`）；类 Unix 用 `pgrep` + `lsof`。两边的输出都只取端口数字。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 桌面端 Host 入口在命令行里的稳定片段（Windows 反斜杠与 POSIX 斜杠都接受）。 */
export const DESKTOP_HOST_COMMAND_MARKER = 'dsh-desktop-host';

/** 一次发现的最长等待；超时按"没发现"处理，绝不能把网关启动/请求挂死。 */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Windows 端口发现脚本。
 *
 * 刻意输出**纯 JSON 数组**（单个端口时 `ConvertTo-Json` 会给标量，解析层兼容两种）。
 * `$ErrorActionPreference='SilentlyContinue'` 让 `Get-NetTCPConnection` 在旧系统上
 * 缺失时安静走 netstat 兜底，而不是把一整屏红字写进网关日志。
 */
export const WINDOWS_DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$marker = 'dsh-desktop-host[\\/]lib[\\/]index\.js'
$pids = @(Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $marker } |
  ForEach-Object { [int]$_.ProcessId })
if ($pids.Count -eq 0) {
  # 命令行读不到（权限/WMI 关闭）时的兜底：DSH 桌面端的进程名是稳定的。
  $pids = @(Get-Process -Name 'DeepSeek Harness' |
    Where-Object { $_.Id -gt 0 } |
    ForEach-Object { [int]$_.Id })
}
$ports = @()
if ($pids.Count -gt 0) {
  $ports = @(Get-NetTCPConnection -State Listen |
    Where-Object { $pids -contains [int]$_.OwningProcess } |
    ForEach-Object { [int]$_.LocalPort } |
    Sort-Object -Unique)
}
if ($ports.Count -eq 0 -and $pids.Count -gt 0) {
  # 旧系统没有 Get-NetTCPConnection：netstat 的输出最后一段就是 PID。
  $ports = @(netstat -ano -p tcp |
    Select-String 'LISTENING' |
    ForEach-Object {
      $line = ($_.Line.Trim() -split '\s+')
      if ($line.Length -ge 5 -and $pids -contains [int]$line[-1]) {
        $local = $line[1]
        $colon = $local.LastIndexOf(':')
        if ($colon -gt 0) { [int]$local.Substring($colon + 1) }
      }
    } |
    Sort-Object -Unique)
}
$ports | ConvertTo-Json -Compress
`.trim();

/**
 * 把 PowerShell / netstat 的端口输出归一成 `number[]`。
 *
 * 接受 `55941`、`[55941,16099]`、以及空白/换行分隔的数字串；其余内容一律忽略。
 * 去重、排序、剔除非法端口 —— 调用方拿到的就是可以逐个探测的候选。
 *
 * @param {string} text
 * @returns {number[]}
 */
export function parseDiscoveredPorts(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw.split(/[^0-9]+/).filter((part) => part !== '');
  }
  const list = Array.isArray(value) ? value : [value];
  const ports = new Set();
  for (const item of list) {
    const port = Number(item);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * 列出本机 DSH 桌面端 Host 正在监听的端口。
 *
 * 失败/超时/平台不支持都返回空数组（调用方仍会尝试配置端口，并给出可解释的失败）。
 *
 * @param {{platform?: string, timeoutMs?: number, execFileImpl?: Function}} [opts]
 * @returns {Promise<number[]>}
 */
export async function discoverDesktopHostPorts({
  platform = process.platform,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  execFileImpl = execFileAsync,
} = {}) {
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DISCOVERY_SCRIPT],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 },
      );
      return parseDiscoveredPorts(stdout);
    }
    if (platform === 'linux' || platform === 'darwin') {
      return await discoverWithLsof({ timeoutMs, execFileImpl });
    }
  } catch {
    /* 发现失败不是错误：让 DesktopApi 用配置端口再试一次，并把两端都写进错误文案 */
  }
  return [];
}

/**
 * 类 Unix 兜底：pgrep 找 Host 进程 → lsof 看该进程的 LISTEN 端口。
 *
 * @param {{timeoutMs: number, execFileImpl: Function}} opts
 * @returns {Promise<number[]>}
 */
async function discoverWithLsof({ timeoutMs, execFileImpl }) {
  const { stdout: pidsOut } = await execFileImpl('pgrep', ['-f', 'dsh-desktop-host/lib/index.js'], {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
  });
  const pids = String(pidsOut)
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  const ports = new Set();
  for (const pid of pids) {
    try {
      const { stdout } = await execFileImpl(
        'lsof',
        ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', String(pid), '-Fn'],
        { timeout: timeoutMs, maxBuffer: 128 * 1024 },
      );
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!line.startsWith('n')) continue;
        const match = /:(\d+)$/.exec(line);
        if (match) ports.add(Number(match[1]));
      }
    } catch {
      /* 单个进程查不到不影响其它进程 */
    }
  }
  return [...ports].filter((port) => port > 0 && port <= 65_535).sort((a, b) => a - b);
}
