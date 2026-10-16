#Requires -Version 5.1
<#
.SYNOPSIS
  停止中继（relay）：按 PID 文件结束进程树，校验端口已释放；对未运行的情况幂等返回 0。

.DESCRIPTION
  行为：
    1. 读 <运行目录>\relay.pid.json，结束其中的进程树（taskkill /T /F）。
    2. 删除 PID 文件并轮询端口确认已释放。
    3. 若端口上运行着「不是本脚本启动」的进程：默认只报告不杀；确需结束时加 -Force。

.EXAMPLE
  powershell -File scripts/stop-relay.ps1 -Home ".runtime\relay-home"

.EXAMPLE
  powershell -File scripts/stop-relay.ps1 -Home ".runtime\e2e-crossnetwork\relay" -Force

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$RelayHome,
    [int]$Port = 0,
    [switch]$Force,
    [int]$WaitSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner -Title 'dsh-relay 中继停止（stop-relay.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

$relayHomeResolved = Resolve-RelayHome -Home $RelayHome
$pidPath = Get-RelayPidFilePath -Home $relayHomeResolved
$pidInfo = Read-RelayPidInfo -Home $relayHomeResolved
$psHint = 'powershell'
$homeArg = ''
if ($RelayHome) { $homeArg = " -Home `"$relayHomeResolved`"" }

$effectivePort = 0
if ($Port -gt 0) { $effectivePort = $Port }
elseif ($pidInfo) { $effectivePort = [int](Get-JsonProp -Object $pidInfo -Name 'port' -Default 0) }
if ($effectivePort -le 0) {
    $config = Get-ConfigDefaults -Home $relayHomeResolved
    $effectivePort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultRelayPort)
}
$tlsMode = 'off'
if ($pidInfo) { $tlsMode = [string](Get-JsonProp -Object $pidInfo -Name 'tlsMode' -Default 'off') }
$insecure = ($tlsMode -ne 'off')
$baseUrl = Get-RelayBaseUrl -Home $relayHomeResolved -Port $effectivePort

Write-Section '1/3 状态检查'
Write-Kv -Key '运行目录' -Value $relayHomeResolved
Write-Kv -Key '端口' -Value ([string]$effectivePort)
Write-Kv -Key 'PID 文件' -Value $(if (Test-Path -LiteralPath $pidPath -PathType Leaf) { $pidPath } else { '(不存在)' })

$stoppedSomething = $false
$targetPid = 0
if ($pidInfo) { $targetPid = [int](Get-JsonProp -Object $pidInfo -Name 'pid' -Default 0) }

Write-Section '2/3 结束进程'
if ($targetPid -gt 0 -and (Test-ProcessAlive -ProcessId $targetPid)) {
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    $procName = ''
    if ($proc) { $procName = $proc.ProcessName }
    if ($procName -ne 'node' -and -not $Force) {
        Write-Fail "PID $targetPid 存在但不是 node 进程（进程名：$procName），疑似 PID 复用。已拒绝结束；确认无误可加 -Force。"
        exit 1
    }
    Write-Info "结束进程树 PID $targetPid（$procName）…"
    if (Stop-ProcessTree -ProcessId $targetPid) {
        Write-Ok "已结束 PID $targetPid"
        $stoppedSomething = $true
    } else {
        Write-Fail "结束 PID $targetPid 失败（可能需要管理员权限）。"
        exit 1
    }
} elseif ($targetPid -gt 0) {
    Write-Info "PID 文件中的进程 $targetPid 已不存在（上次未正常退出）。"
} else {
    Write-Info 'PID 文件不存在：本脚本未找到自己启动的中继。'
}

$launcherPid = 0
if ($pidInfo) { $launcherPid = [int](Get-JsonProp -Object $pidInfo -Name 'launcherPid' -Default 0) }
if ($launcherPid -gt 0 -and $launcherPid -ne $targetPid -and (Test-ProcessAlive -ProcessId $launcherPid)) {
    Write-Info "清理残留的启动器进程 PID $launcherPid …"
    [void](Stop-ProcessTree -ProcessId $launcherPid)
}

$owner = Get-PortOwnerProcessId -Port $effectivePort
if ($owner -gt 0) {
    $health = Get-RelayHealth -BaseUrl $baseUrl -TimeoutSec 3 -Insecure:$insecure
    if ($health -and -not $Force) {
        Write-Warn "端口 $effectivePort 上仍有中继在响应（PID $owner），但它不是本脚本启动的（无 PID 文件记录）。"
        Write-Info "若确认要结束它：$psHint -File scripts/stop-relay.ps1 -Port $effectivePort -Force"
        if (-not $stoppedSomething) { exit 1 }
    } elseif ($Force) {
        Write-Info "强制结束占用端口 $effectivePort 的进程 PID $owner …"
        if (Stop-ProcessTree -ProcessId $owner) {
            Write-Ok "已结束 PID $owner"
            $stoppedSomething = $true
        } else {
            Write-Fail "结束 PID $owner 失败。"
            exit 1
        }
    } else {
        Write-Warn "端口 $effectivePort 被 PID $owner 占用，但它不响应 /health（可能不是中继）。默认不动它；确认可加 -Force。"
    }
}

Write-Section '3/3 清理与校验'
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    Remove-Item -LiteralPath $pidPath -Force
    Write-Ok "已删除 PID 文件：$pidPath"
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$released = $false
while ((Get-Date) -lt $deadline) {
    if ((Get-PortOwnerProcessId -Port $effectivePort) -le 0) { $released = $true; break }
    Start-Sleep -Milliseconds 300
}
if ($released) {
    Write-Ok "端口 $effectivePort 已释放。"
} else {
    $stillOwner = Get-PortOwnerProcessId -Port $effectivePort
    Write-Fail "端口 $effectivePort 仍被 PID $stillOwner 占用（等待 ${WaitSeconds}s 超时）。"
    exit 1
}

if (Get-RelayHealth -BaseUrl $baseUrl -TimeoutSec 3 -Insecure:$insecure) {
    Write-Warn '/health 仍有响应（可能是别的服务在该端口）。'
} else {
    Write-Ok '/health 已无响应，中继已停止。'
}

Write-Host ''
if ($stoppedSomething) {
    Write-Ok '中继已停止。已注册 home 与日志保留在运行目录中（停止不会删除数据）。'
} else {
    Write-Ok '中继本来就没有运行（幂等：无需处理）。'
}
exit 0
