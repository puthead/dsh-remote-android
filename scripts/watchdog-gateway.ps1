#Requires -Version 5.1
<#
.SYNOPSIS
  网关看门狗：定时体检网关是否还活着，进程没了就自动重新拉起（人在外地也能继续用手机指挥）。

.DESCRIPTION
  为什么需要：
    2026-10-13 22:21:49 实测到网关进程意外结束（gateway-console-*.err.log 末尾出现 ^C）。
    进程没了以后 /api/v1/health 与 /api/v2/health 都没有响应、中继侧 homes:0，
    手机拿到的是 503 home_offline，直到人回家手动重启才恢复。
    这个脚本把「体检 → 重启 → 复验」做成可反复执行的动作：
      * 默认循环模式：自己常驻，每 -IntervalSeconds 秒体检一次（桌面启动器 / Startup 文件夹用）。
      * -Once：只体检一次就退出，交给 Windows 计划任务按重复间隔调用。

  判定与动作：
    1. GET http://127.0.0.1:<port>/api/v1/health 不可达 → 判定「网关没了」，重启。
    2. 网关活着但 /api/v2/relay/status.connected 连续为 false 超过 -RelayGraceSeconds → 判定「隧道卡死」，重启。
       （秒数起算点持久化在 state 文件里，所以 -Once 模式跨调用同样有效。）
    3. 重启 = 调用 scripts\start-gateway.ps1（它自带重复启动检测、分离启动与就绪等待），随后复验 30 秒。
    4. 一小时内重启次数超过 -MaxRestartsPerHour → 停手并写日志（避免「起不来就一直重启」的风暴）。

  日志：<运行目录>\logs\watchdog.log（追加写，UTF-8）。
  状态：<运行目录>\logs\watchdog-state.json（最近一小时的重启时间戳 + 中继断开起算点）。

  注意：本脚本只负责「进程死了拉起来」，不负责开机自启本身。开机自启两条路线见
  scripts\install-autostart.ps1：计划任务（-WithWatchdog，需要管理员）/ 用户 Startup 文件夹（-StartupFolder，不需要管理员）。

.PARAMETER DshRemoteHome
  运行目录，默认 C:\Users\<你>\.dsh-remote。

.PARAMETER Port
  网关端口；不传则读 config.json 的 port（默认 8787）。

.PARAMETER IntervalSeconds
  循环模式的体检间隔，默认 60 秒；最小 5 秒。

.PARAMETER Once
  只体检一次（计划任务用）。退出码：0 = 健康或已恢复，1 = 仍不可用，2 = 触发限流拒绝重启。

.PARAMETER MaxRestartsPerHour
  最近一小时最多重启几次，默认 12。

.PARAMETER RelayGraceSeconds
  网关活着但中继隧道连续断开超过这个秒数就重启网关，默认 180；给 0 表示不做这项判定。

.PARAMETER Quiet
  不往控制台打印，只写日志文件。

.PARAMETER Stop
  停止「常驻（循环模式）看门狗」：读 <运行目录>\logs\watchdog.pid，确认那个进程的命令行里确实是本脚本，再结束它。
  只结束看门狗，不动网关本体；-Once 模式不留 PID 文件，所以对本参数无影响。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watchdog-gateway.ps1 -Stop

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watchdog-gateway.ps1 -Once

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watchdog-gateway.ps1

.EXAMPLE
  # 用测试运行目录与测试端口（不会碰真网关）
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watchdog-gateway.ps1 -Home .runtime\scripts-selftest -Port 18787 -Once

.NOTES
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x；文件必须是 UTF-8 带 BOM。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [int]$Port = 0,
    [int]$IntervalSeconds = 60,
    [switch]$Once,
    [int]$MaxRestartsPerHour = 12,
    [int]$RelayGraceSeconds = 180,
    [switch]$Stop,
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

if ($IntervalSeconds -lt 5) { throw ("-IntervalSeconds 不能小于 5（收到 $IntervalSeconds）。") }
if ($MaxRestartsPerHour -lt 1) { throw ("-MaxRestartsPerHour 至少为 1（收到 $MaxRestartsPerHour）。") }
if ($RelayGraceSeconds -lt 0) { throw ("-RelayGraceSeconds 不能为负数（收到 $RelayGraceSeconds）。") }

$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
$configPath = Join-Path $remoteHome 'config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw ("找不到运行目录里的 config.json：" + $configPath + "`n  请先执行：powershell -File scripts\setup-pc.ps1")
}
$config = Read-JsonFile -Path $configPath
$effectivePort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultPort)
if ($Port -gt 0) { $effectivePort = $Port }
$baseUrl = 'http://127.0.0.1:' + $effectivePort

$logsDir = Join-Path $remoteHome 'logs'
$logPath = Join-Path $logsDir 'watchdog.log'
$statePath = Join-Path $logsDir 'watchdog-state.json'
$startScript = Join-Path $PSScriptRoot 'start-gateway.ps1'
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) { throw ("找不到 start-gateway.ps1：" + $startScript) }

# 常驻看门狗自己的 PID 文件（只有循环模式写）：给 -Stop 用，也给文档/排障用。
$watchdogPidPath = Join-Path $logsDir 'watchdog.pid'

function Test-IsWatchdogProcess {
    <#
      确认某个 PID 确实在跑本脚本：防止 PID 被系统复用后「-Stop 停了别的进程」。
      取命令行失败时返回 $false（宁可拒绝停，也不误杀）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    try {
        $proc = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $ProcessId) -ErrorAction Stop
        if (-not $proc) { return $false }
        return ([string]$proc.CommandLine -like '*watchdog-gateway.ps1*')
    } catch {
        return $false
    }
}

# ── -Stop：结束常驻看门狗 ─────────────────────────────────────────────────────
if ($Stop) {
    Write-Banner -Title 'dsh-remote 网关看门狗 · 停止' -SubTitle 'watchdog-gateway.ps1 -Stop'
    Write-Kv -Key '运行目录' -Value $remoteHome
    Write-Kv -Key 'PID 文件' -Value $watchdogPidPath
    if (-not (Test-Path -LiteralPath $watchdogPidPath -PathType Leaf)) {
        Write-Info 'PID 文件不存在：常驻看门狗当前没在运行（-Once 模式不留 PID 文件）。'
        exit 0
    }
    $record = $null
    try { $record = Read-JsonFile -Path $watchdogPidPath } catch { $record = $null }
    $watchdogPid = [int](Get-JsonProp -Object $record -Name 'pid' -Default 0)
    if ($watchdogPid -le 0) {
        Write-Warn 'PID 文件内容不可用，直接清理。'
        Remove-Item -LiteralPath $watchdogPidPath -Force -ErrorAction SilentlyContinue
        exit 0
    }
    Write-Kv -Key '看门狗 PID' -Value ([string]$watchdogPid)
    if (-not (Test-ProcessAlive -ProcessId $watchdogPid)) {
        Write-Info ('进程 ' + $watchdogPid + ' 已经不存在，清理 PID 文件。')
        Remove-Item -LiteralPath $watchdogPidPath -Force -ErrorAction SilentlyContinue
        exit 0
    }
    if (-not (Test-IsWatchdogProcess -ProcessId $watchdogPid)) {
        Write-Fail ('PID ' + $watchdogPid + ' 的命令行里没有 watchdog-gateway.ps1，拒绝结束这个进程。')
        Write-Info ('如确认要结束，请手工执行：Stop-Process -Id ' + $watchdogPid + ' -Force')
        exit 1
    }
    Write-Info '结束常驻看门狗…（只停看门狗，不动网关本体）'
    if (Stop-ProcessTree -ProcessId $watchdogPid) {
        Remove-Item -LiteralPath $watchdogPidPath -Force -ErrorAction SilentlyContinue
        Write-Ok '常驻看门狗已停止；网关本体仍在运行。'
        Write-NextStep '要停网关用：powershell -File scripts\stop-gateway.ps1'
        exit 0
    }
    Write-Fail '看门狗进程结束失败，请手工检查。'
    exit 1
}

# ── 日志与状态 ────────────────────────────────────────────────────────────────

function Write-WatchdogLog {
    <#
      追加一行看门狗日志。写日志失败不能影响看门狗本身（所以单独 try/catch）。
    #>
    param([string]$Message, [string]$Level = 'info')
    $line = ('{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message)
    try {
        if (-not (Test-Path -LiteralPath $logsDir -PathType Container)) {
            [void](New-Item -ItemType Directory -Force -Path $logsDir)
        }
        Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    } catch {
        if (-not $Quiet) { Write-Host ('  [warn] 写看门狗日志失败：' + $_.Exception.Message) }
    }
    if (-not $Quiet) { Write-Host $line }
}

function ConvertTo-DateTimeOrNull {
    param([string]$Text)
    if (-not $Text) { return $null }
    try { return [datetime]::Parse($Text, [System.Globalization.CultureInfo]::InvariantCulture) }
    catch { return $null }
}

function Read-WatchdogStateRaw {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
    try { return (Read-JsonFile -Path $statePath) } catch { return $null }
}

function Get-RecentRestartMarks {
    <#
      最近一小时内的重启时间戳（更早的自动丢弃）。跨 -Once 调用也能限流。
    #>
    $raw = Read-WatchdogStateRaw
    $cutoff = (Get-Date).AddHours(-1)
    $marks = New-Object System.Collections.ArrayList
    foreach ($item in @(Get-JsonProp -Object $raw -Name 'restarts' -Default @())) {
        $parsed = ConvertTo-DateTimeOrNull -Text ([string]$item)
        if ($null -ne $parsed -and $parsed -ge $cutoff) { [void]$marks.Add($parsed) }
    }
    return @($marks)
}

function Save-WatchdogState {
    param([object[]]$Restarts = @(), $RelayDownSince = $null)
    $list = New-Object System.Collections.ArrayList
    foreach ($m in @($Restarts)) { [void]$list.Add(([datetime]$m).ToString('o')) }
    $downText = ''
    if ($null -ne $RelayDownSince) { $downText = ([datetime]$RelayDownSince).ToString('o') }
    $payload = [ordered]@{
        updatedAt      = (Get-Date).ToString('o')
        restarts       = @($list)
        relayDownSince = $downText
    }
    if (-not (Test-Path -LiteralPath $logsDir -PathType Container)) {
        [void](New-Item -ItemType Directory -Force -Path $logsDir)
    }
    Write-JsonFileNoBom -Path $statePath -Object $payload
}

function Add-RestartMark {
    $marks = New-Object System.Collections.ArrayList
    foreach ($m in @(Get-RecentRestartMarks)) { [void]$marks.Add($m) }
    [void]$marks.Add((Get-Date))
    $raw = Read-WatchdogStateRaw
    Save-WatchdogState -Restarts @($marks) -RelayDownSince (Get-RelayDownSince)
}

function Get-RelayDownSince {
    $raw = Read-WatchdogStateRaw
    return (ConvertTo-DateTimeOrNull -Text ([string](Get-JsonProp -Object $raw -Name 'relayDownSince' -Default '')))
}

function Set-RelayDownSince {
    param($Value)
    Save-WatchdogState -Restarts @(Get-RecentRestartMarks) -RelayDownSince $Value
}

# ── 体检与重启 ────────────────────────────────────────────────────────────────

function Get-GatewayProbe {
    <#
      体检一次。返回 [pscustomobject]@{ Up; ServerName; RelayConnected; RelayUrl; RelayError }。
    #>
    $health = Get-GatewayHealth -BaseUrl $baseUrl -TimeoutSec 4
    if (-not $health) {
        return [pscustomobject]@{
            Up = $false; ServerName = ''; RelayConnected = $false; RelayUrl = ''; RelayError = 'health 不可达'
        }
    }
    $relay = Get-GatewayRelayStatus -BaseUrl $baseUrl -TimeoutSec 4
    return [pscustomobject]@{
        Up             = $true
        ServerName     = [string](Get-JsonProp -Object $health -Name 'serverName' -Default '')
        RelayConnected = [bool](Get-JsonProp -Object $relay -Name 'connected' -Default $false)
        RelayUrl       = [string](Get-JsonProp -Object $relay -Name 'url' -Default '')
        RelayError     = [string](Get-JsonProp -Object $relay -Name 'lastError' -Default '')
    }
}

function Get-PidFileSummary {
    $info = Read-GatewayPidInfo -Home $remoteHome
    if (-not $info) { return '（没有 PID 文件）' }
    $pidValue = Get-JsonProp -Object $info -Name 'pid' -Default ''
    $alive = '（PID 未记录）'
    if ($pidValue) {
        if (Test-ProcessAlive -ProcessId ([int]$pidValue)) { $alive = '（进程仍在运行）' } else { $alive = '（进程已不存在）' }
    }
    return ('pid=' + [string]$pidValue + $alive + '；err 日志=' + [string](Get-JsonProp -Object $info -Name 'stderrLog' -Default ''))
}

function Get-PortOwnerSummary {
    $owner = Get-PortOwnerProcessId -Port $effectivePort
    if (-not $owner) { return '（端口空闲）' }
    return ('pid=' + [string]$owner)
}

function Invoke-GatewayRestart {
    <#
      限流检查 → 调 start-gateway.ps1 → 复验 30 秒。返回 'recovered' / 'failed' / 'throttled'。
    #>
    param([string]$Reason)
    $recent = @(Get-RecentRestartMarks)
    if ($recent.Count -ge $MaxRestartsPerHour) {
        Write-WatchdogLog -Level 'error' -Message ('最近一小时已重启 ' + $recent.Count + ' 次，达到上限 ' + $MaxRestartsPerHour + ' 次，本轮不再重启（避免重启风暴）。请人工检查：' + $logPath)
        return 'throttled'
    }

    Add-RestartMark
    Write-WatchdogLog -Level 'warn' -Message ('准备重启网关。原因：' + $Reason + '。PID 文件：' + (Get-PidFileSummary) + '；端口 ' + $effectivePort + ' 占用者：' + (Get-PortOwnerSummary))

    $startArgs = @('-Home', $remoteHome, '-Port', [string]$effectivePort, '-WaitSeconds', '30')
    $result = $null
    try {
        $result = Invoke-DshScript -ScriptPath $startScript -Arguments $startArgs -TimeoutSec 120
    } catch {
        Write-WatchdogLog -Level 'error' -Message ('调用 start-gateway.ps1 失败：' + $_.Exception.Message)
        return 'failed'
    }

    $exitCode = Get-JsonProp -Object $result -Name 'ExitCode' -Default '?'
    Write-WatchdogLog -Message ('start-gateway.ps1 结束：退出码 ' + [string]$exitCode + '，耗时 ' + [string](Get-JsonProp -Object $result -Name 'ElapsedSec' -Default '?') + ' 秒')
    $text = ([string](Get-JsonProp -Object $result -Name 'StdOut' -Default '')) + "`n" + ([string](Get-JsonProp -Object $result -Name 'StdErr' -Default ''))
    foreach ($line in @($text -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed) { Write-WatchdogLog -Message ('  | ' + $trimmed) }
    }

    $health = Wait-GatewayHealth -BaseUrl $baseUrl -TimeoutSec 30 -IntervalMs 500
    if ($health) {
        Write-WatchdogLog -Level 'ok' -Message ('网关已恢复：' + [string](Get-JsonProp -Object $health -Name 'serverName' -Default '') + ' @ ' + $baseUrl)
        return 'recovered'
    }
    Write-WatchdogLog -Level 'error' -Message ('重启后 30 秒内仍未就绪，请人工检查 ' + $baseUrl + ' 与 <运行目录>\logs\gateway-console-*.err.log')
    return 'failed'
}

# ── 主流程 ────────────────────────────────────────────────────────────────────

$modeText = '循环模式（每 ' + $IntervalSeconds + ' 秒体检一次）'
if ($Once) { $modeText = '单次模式（-Once，给计划任务用）' }

Write-Banner -Title 'dsh-remote 网关看门狗（watchdog-gateway.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))
Write-Kv -Key '运行目录' -Value $remoteHome
Write-Kv -Key '健康检查' -Value ($baseUrl + '/api/v1/health')
Write-Kv -Key '运行模式' -Value $modeText
Write-Kv -Key '重启上限' -Value ($MaxRestartsPerHour.ToString() + ' 次/小时')
Write-Kv -Key '中继观察期' -Value ($RelayGraceSeconds.ToString() + ' 秒（0 = 不判定）')
Write-Kv -Key '日志文件' -Value $logPath

# 循环模式：先做单例判定 —— 桌面启动器与 Startup 启动器都可能拉起看门狗，
# 两个实例同时体检会重复重启网关、白耗限流额度，所以已经有活着的实例就退出。
if (-not $Once) {
    $existingRecord = $null
    if (Test-Path -LiteralPath $watchdogPidPath -PathType Leaf) {
        try { $existingRecord = Read-JsonFile -Path $watchdogPidPath } catch { $existingRecord = $null }
    }
    $existingPid = [int](Get-JsonProp -Object $existingRecord -Name 'pid' -Default 0)
    if ($existingPid -gt 0 -and $existingPid -ne $PID -and (Test-ProcessAlive -ProcessId $existingPid) -and
        (Test-IsWatchdogProcess -ProcessId $existingPid)) {
        Write-Warn ('已有常驻看门狗在运行（PID ' + $existingPid + '），本次退出，避免重复体检/重复重启网关。')
        Write-NextStep '要换成新的实例：先跑 powershell -File scripts\watchdog-gateway.ps1 -Stop'
        exit 0
    }
}

# 循环模式：把自己的 PID 落到 watchdog.pid，方便 watchdog-gateway.ps1 -Stop 精确停止。
if (-not $Once) {
    try {
        Write-JsonFileNoBom -Path $watchdogPidPath -Object ([ordered]@{
                pid             = $PID
                startedAt       = (Get-Date).ToString('o')
                home            = $remoteHome
                port            = $effectivePort
                intervalSeconds = $IntervalSeconds
                commandLine     = ('powershell -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Home "' + $remoteHome + '" -IntervalSeconds ' + $IntervalSeconds)
            })
        Write-Kv -Key '看门狗 PID' -Value ([string]$PID + '（写入 ' + $watchdogPidPath + '）')
        Write-NextStep '停止常驻看门狗：powershell -File scripts\watchdog-gateway.ps1 -Stop'
    } catch {
        Write-Warn ('写 PID 文件失败（不影响体检，但 -Stop 会失效）：' + $_.Exception.Message)
    }
}

$exitCode = 0
$iteration = 0

while ($true) {
    $iteration++
    $probe = Get-GatewayProbe
    $needRestart = $false
    $reason = ''

    if (-not $probe.Up) {
        Set-RelayDownSince -Value $null
        $needRestart = $true
        $reason = '健康检查不可达（网关进程可能已结束）'
    } elseif ($RelayGraceSeconds -gt 0 -and -not $probe.RelayConnected) {
        $since = Get-RelayDownSince
        if (-not $since) {
            Set-RelayDownSince -Value (Get-Date)
            Write-WatchdogLog -Level 'warn' -Message ('网关活着但中继未连接（' + $probe.RelayError + '）；观察 ' + $RelayGraceSeconds + ' 秒，仍断开就重启网关')
        } else {
            $downSeconds = [int]((Get-Date) - ([datetime]$since)).TotalSeconds
            if ($downSeconds -ge $RelayGraceSeconds) {
                $needRestart = $true
                $reason = '中继隧道已断开 ' + $downSeconds + ' 秒（' + $probe.RelayError + '）'
            } else {
                Write-WatchdogLog -Level 'warn' -Message ('中继仍未连接，已断开 ' + $downSeconds + '/' + $RelayGraceSeconds + ' 秒')
            }
        }
    } else {
        if (Get-RelayDownSince) {
            Set-RelayDownSince -Value $null
            Write-WatchdogLog -Level 'ok' -Message '中继隧道已连接'
        }
        if (($iteration -eq 1) -or (($iteration % 30) -eq 0)) {
            Write-WatchdogLog -Message ('体检正常：' + $probe.ServerName + ' @ ' + $baseUrl + '；中继 ' + $probe.RelayUrl + ' 已连接')
        }
    }

    if ($needRestart) {
        $outcome = Invoke-GatewayRestart -Reason $reason
        if ($outcome -eq 'throttled') { $exitCode = 2 }
        elseif ($outcome -eq 'failed') { $exitCode = 1 }
        else { $exitCode = 0 }
        if ($Once) { break }
        if ($outcome -eq 'recovered') {
            Start-Sleep -Seconds $IntervalSeconds
            continue
        }
        # 起不来先退避 10 分钟，别把日志刷爆
        Start-Sleep -Seconds ([Math]::Max($IntervalSeconds, 600))
        continue
    }

    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSeconds
}

if (-not $Quiet) {
    if ($exitCode -eq 0) { Write-Ok '看门狗本轮结束：网关健康（或已恢复）。' }
    elseif ($exitCode -eq 1) { Write-Fail '看门狗本轮结束：网关仍不可用，需要人工介入。' }
    else { Write-Warn '看门狗本轮结束：触发重启限流，未做动作。' }
    Write-NextStep ('日志：' + $logPath)
}

exit $exitCode
