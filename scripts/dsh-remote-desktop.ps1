#Requires -Version 5.1
<#
.SYNOPSIS
  DSH 远程（手机指挥 PC）多合一工具 —— 一个入口管完网关、看门狗、配对码、状态与日志。

.DESCRIPTION
  把原来分散的 scripts/*.ps1 收成一个在桌面上双击就能用的入口（默认进菜单）：

    1. 启动服务    start-gateway.ps1 + 拉起常驻看门狗（两者都幂等，已在跑就只报告）
    2. 停止服务    stop-gateway.ps1 + watchdog-gateway.ps1 -Stop
    3. 重启服务    = 2 + 1
    4. 查看状态    网关 health / 中继隧道 / 看门狗 / 端口占用（只读）
    5. 生成配对码  relay-pair.ps1（6 位码，5 分钟有效，带上文本二维码）
    6. 看门狗管理  查看 / 停止 / 启动（单独控制，不动网关）
    7. 开机自启    install-autostart.ps1 -StartupFolder（免管理员）；已装则可卸载
    8. 打开日志    今天最新的 gateway-console-*.log / watchdog.log / relay 日志

  本脚本只做「编排 + 状态展示」，真正的启停判定仍交给仓库里原有脚本，行为与命令行一致。

.PARAMETER Menu
  进入交互菜单（不带参数时的默认行为）。

.PARAMETER Start / Stop / Restart / Status / Pair
  非交互动作，供快捷方式 / 任务计划 / 命令行直接调用。

.PARAMETER Watchdog
  看门狗管理。可加 -WatchdogStop、-WatchdogStart，或 -WatchdogStatus 只查看。

.PARAMETER Autostart
  开机自启管理。可加 -AutostartUninstall，或 -AutostartStatus 只查看。

.PARAMETER Logs
  打开今天的日志。

.PARAMETER Home
  dsh-remote 运行目录，默认 C:\Users\Administrator\.dsh-remote（也给 DSH_REMOTE_HOME 环境变量让位）。

.PARAMETER Port
  网关端口，0 = 读 config.json（默认 8787）。

.PARAMETER RelayUrl
  配对码走的中继地址，默认 wss://123.207.183.237:9443（公网生产）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-remote-desktop.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-remote-desktop.ps1 -Status
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-remote-desktop.ps1 -Restart
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-remote-desktop.ps1 -Pair
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dsh-remote-desktop.ps1 -Watchdog -WatchdogStop

.NOTES
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x；脚本本身为纯中文注释/输出的 UTF-8(no BOM)，
  控制台编码在本脚本内统一设为 UTF-8，中文不会乱码。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [int]$Port = 0,
    [string]$RelayUrl = 'wss://123.207.183.237:9443',

    [switch]$Menu,
    [switch]$Start,
    [switch]$Stop,
    [switch]$Restart,
    [switch]$Status,
    [switch]$Pair,
    [switch]$Watchdog,
    [switch]$WatchdogStop,
    [switch]$WatchdogStart,
    [switch]$WatchdogStatus,
    [switch]$Autostart,
    [switch]$AutostartUninstall,
    [switch]$AutostartStatus,
    [switch]$Logs,
    [switch]$NoPause
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── 控制台编码：先钉成 UTF-8，避免中文在 936 代码页下变成乱码 ──────────────────
try {
    [void][System.Text.Encoding]::UTF8
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
} catch { }

$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Split-Path -Parent $MyInvocation.MyCommand.Path) }
. (Join-Path $ScriptRoot '_common.ps1')

# ── 配置常量（与桌面快捷方式、README 保持一致） ────────────────────────────────
if (-not $DshRemoteHome) { $DshRemoteHome = Resolve-DshRemoteHome }
$Home_ = $DshRemoteHome
$ConfigPath = Join-Path $Home_ 'config.json'
$PidPath = Join-Path $Home_ 'gateway.pid.json'
$GateLogDir = Join-Path $Home_ 'logs'
$WatchdogPidPath = Join-Path $GateLogDir 'watchdog.pid'

$ScriptStartGateway = Join-Path $ScriptRoot 'start-gateway.ps1'
$ScriptStopGateway = Join-Path $ScriptRoot 'stop-gateway.ps1'
$ScriptWatchdog = Join-Path $ScriptRoot 'watchdog-gateway.ps1'
$ScriptRelayPair = Join-Path $ScriptRoot 'relay-pair.ps1'
$ScriptAutostart = Join-Path $ScriptRoot 'install-autostart.ps1'
$ScriptAutostartOff = Join-Path $ScriptRoot 'uninstall-autostart.ps1'
$ScriptSetupPc = Join-Path $ScriptRoot 'setup-pc.ps1'

$Script:EffectivePort = 8787

# ── 小工具 ─────────────────────────────────────────────────────────────────────
function Get-HomeArg {
    if ($DshRemoteHome) { return " -Home `"$Home_`"" }
    return ''
}

function Invoke-ScriptFile {
    <#
      调子脚本：输出直接透传到当前控制台，返回真实退出码。

      为什么不用 `& $psExe ... -File $Path @Arguments`：
        调用方一旦捕获/重定向子进程输出（例如把本脚本接进管道或写日志），
        原生命令的 $LASTEXITCODE 就可能拿不到整数——实测会变成输出字符串，
        于是"启动成功"被误判成失败。Start-Process -Wait -PassThru 读的是
        ExitCode 属性，与调用方是否捕获输出无关。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Arguments = @(),
        # 默认共用本控制台（-NoNewWindow），子脚本的输出才会出现在你眼前。
        # 只有常驻后台的看门狗例外：它必须有自己的一份控制台，控制台一关就跟着退。
        [switch]$SeparateConsole
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-Fail "找不到脚本：$Path"
        return 127
    }
    $psExe = (Get-Process -Id $PID).Path
    $argList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Path) + $Arguments
    # -NoNewWindow 与 -WindowStyle 互斥，二选一。
    $proc = if ($SeparateConsole) {
        Start-Process -FilePath $psExe -ArgumentList $argList -WindowStyle Hidden -Wait -PassThru
    } else {
        Start-Process -FilePath $psExe -ArgumentList $argList -NoNewWindow -Wait -PassThru
    }
    if ($null -eq $proc -or $null -eq $proc.ExitCode) { return 1 }
    return [int]$proc.ExitCode
}

function Get-LoopbackBase { return "http://127.0.0.1:$Script:EffectivePort" }

function Get-RelayStatus {
    <# 只读：GET /api/v2/relay/status。网关没起或代次太老时返回 $null。 #>
    try {
        $r = Invoke-DshApi -Url ((Get-LoopbackBase) + '/api/v2/relay/status') -Method GET -TimeoutSec 4 -ApiVersion '2'
        if ($r.Ok) { return $r.Json }
        return $null
    } catch { return $null }
}

function Get-WatchdogProc {
    <# 确认 PID 文件里的进程确实在跑 watchdog-gateway.ps1（防 PID 复用误判）。 #>
    if (-not (Test-Path -LiteralPath $WatchdogPidPath -PathType Leaf)) { return $null }
    $pidValue = 0
    try {
        $raw = Get-Content -LiteralPath $WatchdogPidPath -Raw
        $obj = $raw | ConvertFrom-Json
        $pidValue = [int](Get-JsonProp -Object $obj -Name 'pid' -Default 0)
    } catch {
        try { $pidValue = [int]$raw.Trim() } catch { $pidValue = 0 }
    }
    if ($pidValue -le 0) { return $null }
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    $isWatchdog = $false
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
        if ($cim -and $cim.CommandLine -and $cim.CommandLine -match 'watchdog-gateway') { $isWatchdog = $true }
    } catch { }
    if (-not $isWatchdog) { return $null }
    return [pscustomobject]@{ Pid = $pidValue; StartTime = $proc.StartTime }
}

function Format-RelayLine {
    param($Relay)
    if (-not $Relay) { return '未知（网关不可达或网关代次不支持 /api/v2/relay/status）' }
    $enabled = [bool](Get-JsonProp -Object $Relay -Name 'enabled' -Default $false)
    if (-not $enabled) { return '已禁用（config.json relay.enabled=false）' }
    $connected = [bool](Get-JsonProp -Object $Relay -Name 'connected' -Default $false)
    $url = [string](Get-JsonProp -Object $Relay -Name 'url' -Default '')
    if ($connected) {
        $reconnects = [string](Get-JsonProp -Object $Relay -Name 'reconnects' -Default 0)
        return "已连接  $url（重连次数 $reconnects）"
    }
    $lastError = [string](Get-JsonProp -Object $Relay -Name 'lastError' -Default '')
    if ($lastError) { return "未连接  $url（最后错误：$lastError）" }
    return "未连接  $url"
}

function Get-LogDirCandidates {
    $dirs = New-Object System.Collections.ArrayList
    [void]$dirs.Add($GateLogDir)
    [void]$dirs.Add((Join-Path $Home_ 'logs'))
    $relayLogDir = Join-Path (Join-Path (Get-RepoRoot) '.runtime') 'relay-home\logs'
    [void]$dirs.Add($relayLogDir)
    $liveRelayLogDir = Join-Path (Join-Path (Get-RepoRoot) '.runtime') 'live-env\logs'
    [void]$dirs.Add($liveRelayLogDir)
    return @($dirs | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -Unique)
}

function Get-NewestFileByPattern {
    param([string[]]$Patterns, [string]$FilterLabel)
    $best = $null
    foreach ($dir in (Get-LogDirCandidates)) {
        foreach ($pattern in $Patterns) {
            $candidate = Get-ChildItem -LiteralPath $dir -Filter $pattern -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($candidate -and (-not $best -or $candidate.LastWriteTime -gt $best.LastWriteTime)) { $best = $candidate }
        }
    }
    return $best
}

# ── 状态展示（只读） ───────────────────────────────────────────────────────────
function Show-Status {
    Write-Section 'DSH 远程 · 当前状态'

    Write-Kv -Key '运行目录' -Value $Home_
    Write-Kv -Key '服务地址' -Value (Get-LoopbackBase)

    # 网关
    $health = Get-GatewayHealth -BaseUrl (Get-LoopbackBase) -TimeoutSec 4
    if ($health) {
        Write-Ok '网关：运行中'
        Write-Kv -Key '  服务名' -Value ([string](Get-JsonProp -Object $health -Name 'serverName' -Default ''))
        Write-Kv -Key '  网关版本' -Value ([string](Get-JsonProp -Object $health -Name 'gatewayVersion' -Default ''))
        Write-Kv -Key '  dsh 版本' -Value ([string](Get-JsonProp -Object $health -Name 'dshVersion' -Default ''))
        $uptimeMs = [double](Get-JsonProp -Object $health -Name 'uptimeMs' -Default 0)
        if ($uptimeMs -gt 0) {
            $span = [TimeSpan]::FromMilliseconds($uptimeMs)
            Write-Kv -Key '  已运行' -Value ("{0:N1} 小时" -f $span.TotalHours)
        }
        Write-Kv -Key '  任务' -Value ("进行中 " + [string](Get-JsonProp -Object $health -Name 'activeTasks' -Default 0) + " / 排队 " + [string](Get-JsonProp -Object $health -Name 'queuedTasks' -Default 0))
    } else {
        Write-Fail '网关：未运行（health 无响应）'
        $health = $null
    }

    # 进程 / PID 文件
    $pidInfo = Read-GatewayPidInfo -Home $Home_
    $pidValue = [int](Get-JsonProp -Object $pidInfo -Name 'pid' -Default 0)
    if ($pidValue -gt 0) {
        if (Test-ProcessAlive -ProcessId $pidValue) {
            Write-Kv -Key '网关 PID' -Value ("$pidValue（存活）")
        } else {
            Write-Warn ("PID 文件里的 $pidValue 已不存在（过期记录，下次启动会自动清理）")
        }
    } elseif ($health) {
        $owner = Get-PortOwnerProcessId -Port $Script:EffectivePort
        if ($owner -gt 0) { Write-Kv -Key '网关 PID' -Value ("$owner（按端口推断，无 PID 文件）") }
    }

    # 中继隧道
    $relay = Get-RelayStatus
    $relayLine = Format-RelayLine -Relay $relay
    if ($relay -and [bool](Get-JsonProp -Object $relay -Name 'connected' -Default $false)) {
        Write-Ok ("中继隧道：$relayLine")
    } else {
        Write-Warn ("中继隧道：$relayLine")
    }
    if ($relay) {
        $stats = Get-JsonProp -Object $relay -Name 'stats'
        if ($stats) {
            Write-Kv -Key '  隧道流量' -Value ("收 " + [string](Get-JsonProp -Object $stats -Name 'framesIn' -Default 0) + " 帧 / 发 " + [string](Get-JsonProp -Object $stats -Name 'framesOut' -Default 0) + " 帧")
        }
    }

    # 看门狗
    $wd = Get-WatchdogProc
    if ($wd) {
        Write-Ok ("看门狗：运行中（PID " + $wd.Pid + "，启动于 " + $wd.StartTime.ToString('yyyy-MM-dd HH:mm:ss') + "）")
    } else {
        Write-Warn '看门狗：未运行（网关中途死掉不会自动拉起，建议用菜单 1 启动）'
    }

    # 端口
    $owner = Get-PortOwnerProcessId -Port $Script:EffectivePort
    if ($owner -gt 0) {
        Write-Kv -Key '端口占用' -Value ("$Script:EffectivePort → PID $owner")
    } else {
        Write-Kv -Key '端口占用' -Value ("$Script:EffectivePort → 空闲")
    }

    # 配对设备数
    $devicesPath = Join-Path $Home_ 'devices.json'
    if (Test-Path -LiteralPath $devicesPath -PathType Leaf) {
        try {
            $devices = (Read-JsonFile -Path $devicesPath).devices
            $count = 0
            if ($devices) { $count = @($devices).Count }
            Write-Kv -Key '已配对设备' -Value ("$count 个凭据（devices.json）")
        } catch { }
    }

    # 日志时间
    $latestGatewayLog = Get-NewestFileByPattern -Patterns @('gateway-*.log') -FilterLabel 'gateway'
    if ($latestGatewayLog) {
        Write-Kv -Key '最新网关日志' -Value ($latestGatewayLog.FullName + "（" + $latestGatewayLog.LastWriteTime.ToString('MM-dd HH:mm:ss') + "）")
    }

    if (-not $health) {
        Write-Host ''
        Write-Info ('首次使用请先初始化：' + $ScriptSetupPc)
        Write-Info '或用菜单 1 直接启动（配置文件缺失时会给出明确提示）。'
    }
}

# ── 动作：启动 / 停止 / 重启 ───────────────────────────────────────────────────
function Start-WatchdogIfNeeded {
    $wd = Get-WatchdogProc
    if ($wd) {
        Write-Ok ("看门狗已在运行（PID " + $wd.Pid + "），不重复拉起。")
        return
    }
    Write-Section '拉起常驻看门狗（每 120 秒体检，网关死掉自动重启）'
    $psExe = (Get-Process -Id $PID).Path
    $args = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $ScriptWatchdog,
        '-Home', $Home_,
        '-IntervalSeconds', '120',
        '-Quiet'
    )
    # -WindowStyle Hidden + 独立控制台：看门狗是常驻后台，不该在桌面上留一个黑窗；
    # 它也**不能**用 -NoNewWindow——那样它会挂在调用方的控制台上，控制台一关就被带走
    # （= 你关掉桌面窗口，自愈能力就没了）。所以既有的「看门狗存活期间管道不 EOF」
    # 取舍仍然成立：真要把本启动器输出接进管道，请用 Start-Process -RedirectStandardOutput
    # 配一个有上限的 WaitForExit（见部署手册 §4.0）。
    [void](Start-Process -FilePath $psExe -ArgumentList $args -WindowStyle Hidden -PassThru)
    Start-Sleep -Milliseconds 1200
    $wd2 = Get-WatchdogProc
    if ($wd2) {
        Write-Ok ("看门狗已启动（PID " + $wd2.Pid + "）。")
    } else {
        Write-Warn '看门狗已请求启动，但 PID 文件尚未出现；可稍后用状态再确认。'
    }
}

function Invoke-StartGateway {
    Write-Section '启动网关'
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        Write-Fail "找不到配置文件：$ConfigPath"
        Write-Info ("请先初始化：powershell -File `"" + $ScriptSetupPc + "`" -ApiKey <你的 Key>")
        return 1
    }
    $code = Invoke-ScriptFile -Path $ScriptStartGateway -Arguments @('-Home', $Home_)
    if ($code -ne 0) {
        Write-Fail "网关启动失败（退出码 $code），请按上面的提示处理。"
        return $code
    }
    Start-WatchdogIfNeeded
    Write-Host ''
    Show-Status
    return 0
}

function Invoke-StopAll {
    Write-Section '停止网关'
    [void](Invoke-ScriptFile -Path $ScriptStopGateway -Arguments @('-Home', $Home_))

    Write-Section '停止看门狗'
    $wd = Get-WatchdogProc
    if ($wd) {
        [void](Invoke-ScriptFile -Path $ScriptWatchdog -Arguments @('-Home', $Home_, '-Stop'))
    } else {
        Write-Info '看门狗本来就没在跑。'
    }

    Write-Host ''
    $health = Get-GatewayHealth -BaseUrl (Get-LoopbackBase) -TimeoutSec 3
    if ($health) {
        Write-Warn '网关 health 仍有响应，可能还在退出中；稍等再执行一次状态。'
    } else {
        Write-Ok '网关已停止（health 无响应）。'
    }
    return 0
}

function Invoke-RestartAll {
    Write-Section '重启：先停'
    [void](Invoke-StopAll)
    Start-Sleep -Seconds 1
    Write-Host ''
    return (Invoke-StartGateway)
}

# ── 动作：配对码 ───────────────────────────────────────────────────────────────
function Invoke-PairCode {
    $health = Get-GatewayHealth -BaseUrl (Get-LoopbackBase) -TimeoutSec 5
    if (-not $health) {
        Write-Fail ("网关未运行，无法生成配对码：" + (Get-LoopbackBase) + "/api/v1/health")
        $choice = 'Y'
        if (-not $NoPause) {
            $choice = Read-Host '是否现在启动网关并继续？(Y/N)'
        }
        if ($choice -and $choice.Trim().ToUpperInvariant() -eq 'Y') {
            if ((Invoke-StartGateway) -ne 0) { return 1 }
        } else {
            return 1
        }
    }
    $code = Invoke-ScriptFile -Path $ScriptRelayPair -Arguments @('-Home', $Home_, '-RelayUrl', $RelayUrl)
    if ($code -eq 0) {
        Write-Host ''
        Write-Info ('手机端：中继地址填 ' + $RelayUrl + '，再输入上面 6 位配对码（5 分钟内有效）。')
    }
    return $code
}

# ── 动作：看门狗单独管理 ───────────────────────────────────────────────────────
function Show-Watchdog {
    $wd = Get-WatchdogProc
    Write-Section '看门狗'
    if ($wd) {
        Write-Ok ("运行中：PID " + $wd.Pid + "，启动于 " + $wd.StartTime.ToString('yyyy-MM-dd HH:mm:ss'))
        Write-Kv -Key 'PID 文件' -Value $WatchdogPidPath
    } else {
        Write-Warn '未运行'
    }
}

function Invoke-WatchdogStart {
    Show-Watchdog
    Start-WatchdogIfNeeded
}

function Invoke-WatchdogStop {
    Show-Watchdog
    $wd = Get-WatchdogProc
    if (-not $wd) {
        Write-Info '无需停止。'
        return 0
    }
    $code = Invoke-ScriptFile -Path $ScriptWatchdog -Arguments @('-Home', $Home_, '-Stop')
    Start-Sleep -Milliseconds 800
    $after = Get-WatchdogProc
    if ($after) { Write-Warn ("看门狗仍在（PID " + $after.Pid + "），可稍后重试。") } else { Write-Ok '看门狗已停止（网关不受影响）。' }
    return $code
}

# ── 动作：开机自启 ─────────────────────────────────────────────────────────────
function Get-AutostartState {
    $state = [ordered]@{ StartupFolder = $false; StartupCmdPath = ''; ScheduledTask = $false; TaskName = '' }
    $startupDir = [Environment]::GetFolderPath('Startup')
    if ($startupDir) {
        $cmd = Join-Path $startupDir 'DshRemoteGateway.cmd'
        if (Test-Path -LiteralPath $cmd -PathType Leaf) { $state.StartupFolder = $true; $state.StartupCmdPath = $cmd }
    }
    try {
        $task = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'DshRemote|dsh-remote|Dsh.*Gateway' } | Select-Object -First 1
        if ($task) { $state.ScheduledTask = $true; $state.TaskName = $task.TaskName }
    } catch { }
    return [pscustomobject]$state
}

function Show-Autostart {
    $state = Get-AutostartState
    Write-Section '开机自启'
    if ($state.StartupFolder) {
        Write-Ok ('已安装（免管理员 Startup 启动器）：' + $state.StartupCmdPath)
    } else {
        Write-Warn '未安装 Startup 启动器'
    }
    if ($state.ScheduledTask) {
        Write-Ok ('已安装计划任务：' + $state.TaskName + '（注册/删除需要管理员权限）')
    }
    if (-not $state.StartupFolder -and -not $state.ScheduledTask) {
        Write-Info '安装（免管理员）：install-autostart.ps1 -StartupFolder；登录后自动起「网关 + 看门狗」。'
    }
}

function Invoke-AutostartInstall {
    Show-Autostart
    $state = Get-AutostartState
    if ($state.StartupFolder) {
        Write-Info 'Startup 启动器已存在，install-autostart.ps1 是幂等的，会刷新为最新内容。'
    }
    $code = Invoke-ScriptFile -Path $ScriptAutostart -Arguments @('-Home', $Home_, '-StartupFolder')
    Write-Host ''
    Show-Autostart
    return $code
}

function Invoke-AutostartUninstall {
    Show-Autostart
    $code = Invoke-ScriptFile -Path $ScriptAutostartOff -Arguments @('-Home', $Home_, '-KeepWatchdog')
    Write-Host ''
    Show-Autostart
    return $code
}

# ── 动作：日志 ─────────────────────────────────────────────────────────────────
function Invoke-OpenLogs {
    $target = Get-NewestFileByPattern -Patterns @('gateway-console-*.log', 'gateway-*.log', 'relay-*.log', 'relay-console-*.log')
    Write-Section '打开日志'
    if (-not $target) {
        Write-Warn '没找到日志文件（可能网关还没启动过）。'
        return 1
    }
    Write-Kv -Key '文件' -Value $target.FullName
    Write-Kv -Key '最后写入' -Value $target.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    Write-Info '用记事本打开；日志是持续追加的，记事本不会自动刷新，需要重新打开。'
    try {
        Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $target.FullName + '"')
    } catch {
        Write-Warn ('打开失败：' + $_.Exception.Message)
        return 1
    }
    return 0
}

# ── 菜单 ───────────────────────────────────────────────────────────────────────
function Show-Banner {
    Clear-Host
    Write-Host ''
    Write-Host '  ================================================================' -ForegroundColor DarkCyan
    Write-Host '    DSH Remote  ·  多合一控制台' -ForegroundColor Cyan
    Write-Host '    手机远程指挥这台 PC 上的 DSH' -ForegroundColor DarkGray
    Write-Host '  ================================================================' -ForegroundColor DarkCyan
    Write-Host ("    运行目录 : " + $Home_) -ForegroundColor DarkGray
    Write-Host ("    服务地址 : " + (Get-LoopbackBase)) -ForegroundColor DarkGray
    Write-Host ("    中继地址 : " + $RelayUrl) -ForegroundColor DarkGray
    Write-Host ''
}

function Show-Menu {
    Show-Banner
    $health = Get-GatewayHealth -BaseUrl (Get-LoopbackBase) -TimeoutSec 3
    $wd = Get-WatchdogProc
    $relay = Get-RelayStatus
    $relayOk = $false
    if ($relay) { $relayOk = [bool](Get-JsonProp -Object $relay -Name 'connected' -Default $false) }

    if ($health) {
        Write-Host ("    [网关]   运行中   " + [string](Get-JsonProp -Object $health -Name 'serverName' -Default '') + " / dsh " + [string](Get-JsonProp -Object $health -Name 'dshVersion' -Default '')) -ForegroundColor Green
    } else {
        Write-Host '    [网关]   未运行' -ForegroundColor Red
    }
    if ($relayOk) {
        Write-Host ("    [中继]   已连接   " + [string](Get-JsonProp -Object $relay -Name 'url' -Default '')) -ForegroundColor Green
    } elseif ($health) {
        Write-Host ('    [中继]   未连接   ' + (Format-RelayLine -Relay $relay)) -ForegroundColor Yellow
    } else {
        Write-Host '    [中继]   未知（网关未运行）' -ForegroundColor DarkGray
    }
    if ($wd) {
        Write-Host ("    [看门狗] 运行中   PID " + $wd.Pid) -ForegroundColor Green
    } else {
        Write-Host '    [看门狗] 未运行   （网关死掉不会自动拉活）' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '    ---- 服务 ----' -ForegroundColor DarkCyan
    Write-Host '     1  启动服务        网关 + 看门狗（幂等，已在跑只报告）'
    Write-Host '     2  停止服务        网关 + 看门狗'
    Write-Host '     3  重启服务        先停后启'
    Write-Host '     4  查看状态        只读，不改任何状态'
    Write-Host ''
    Write-Host '    ---- 手机 ----' -ForegroundColor DarkCyan
    Write-Host '     5  生成配对码      6 位码，5 分钟有效（带二维码）'
    Write-Host ''
    Write-Host '    ---- 维护 ----' -ForegroundColor DarkCyan
    Write-Host '     6  看门狗管理      查看 / 停止 / 启动'
    Write-Host '     7  开机自启        安装 / 卸载（免管理员路线）'
    Write-Host '     8  打开日志        今天最新的网关 / 中继日志'
    Write-Host ''
    Write-Host '     0  退出' -ForegroundColor DarkGray
    Write-Host ''
}

function Start-Menu {
    while ($true) {
        Show-Menu
        $choice = Read-Host '  请选择'
        if ($null -eq $choice) { $choice = '0' }
        $choice = ([string]$choice).Trim()
        Write-Host ''
        switch ($choice) {
            '1' { [void](Invoke-StartGateway) }
            '2' { [void](Invoke-StopAll) }
            '3' { [void](Invoke-RestartAll) }
            '4' { Show-Status }
            '5' { [void](Invoke-PairCode) }
            '6' {
                Show-Watchdog
                Write-Host ''
                Write-Host '    1) 启动看门狗    2) 停止看门狗    3) 返回' -ForegroundColor DarkCyan
                $sub = Read-Host '  请选择'
                if (([string]$sub).Trim() -eq '1') { [void](Invoke-WatchdogStart) }
                elseif (([string]$sub).Trim() -eq '2') { [void](Invoke-WatchdogStop) }
                else { Write-Info '已返回。' }
            }
            '7' {
                Show-Autostart
                Write-Host ''
                Write-Host '    1) 安装自启    2) 卸载自启    3) 返回' -ForegroundColor DarkCyan
                $sub = Read-Host '  请选择'
                if (([string]$sub).Trim() -eq '1') { [void](Invoke-AutostartInstall) }
                elseif (([string]$sub).Trim() -eq '2') { [void](Invoke-AutostartUninstall) }
                else { Write-Info '已返回。' }
            }
            '8' { [void](Invoke-OpenLogs) }
            '0' { Write-Info '已退出（网关在后台继续运行，关窗口不影响）。'; return }
            '' { Write-Info '没输入任何内容，按回车回到菜单。' }
            default { Write-Warn ("未知选项：" + $choice) }
        }
        Write-Host ''
        # -NoPause：脚本/自动化一次性喂菜单时跳过「按回车」停留，便于端到端取证。
        if (-not $NoPause) { [void](Read-Host '  按回车回到菜单') }
    }
}

# ── 入口 ───────────────────────────────────────────────────────────────────────
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    try {
        $cfg = Read-JsonFile -Path $ConfigPath
        $cfgPort = [int](Get-JsonProp -Object $cfg -Name 'port' -Default 0)
        if ($cfgPort -gt 0) { $Script:EffectivePort = $cfgPort }
    } catch { }
}
if ($Port -gt 0) { $Script:EffectivePort = $Port }

Write-Banner -Title 'DSH 远程 · 多合一控制台' -SubTitle 'scripts/dsh-remote-desktop.ps1'

$code = 0
if ($Start -or $Stop -or $Restart -or $Status -or $Pair -or $Watchdog -or $Autostart -or $Logs) {
    if ($Start) { $code = Invoke-StartGateway }
    elseif ($Stop) { $code = Invoke-StopAll }
    elseif ($Restart) { $code = Invoke-RestartAll }
    elseif ($Status) { Show-Status }
    elseif ($Pair) { $code = Invoke-PairCode }
    elseif ($Watchdog) {
        if ($WatchdogStop) { $code = Invoke-WatchdogStop }
        elseif ($WatchdogStart) { Invoke-WatchdogStart }
        else { Show-Watchdog }
    }
    elseif ($Autostart) {
        if ($AutostartUninstall) { $code = Invoke-AutostartUninstall }
        elseif ($AutostartStatus) { Show-Autostart }
        else { $code = Invoke-AutostartInstall }
    }
    elseif ($Logs) { $code = Invoke-OpenLogs }
} else {
    if ($Watchdog -and $WatchdogStatus) { Show-Watchdog }
    Start-Menu
    $code = 0
}

exit $code
