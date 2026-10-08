#Requires -Version 5.1
<#
.SYNOPSIS
  停止 dsh-remote 网关（按 PID 文件结束进程树，校验端口已释放）。

.DESCRIPTION
  行为：
    1. 读 <home>\gateway.pid.json，结束其中的进程树（taskkill /T /F，能带走 dsh 子进程）。
    2. 删除 PID 文件，并轮询端口确认已释放；对未运行的情况幂等返回 0。
    3. 若端口上运行着「不是本脚本启动」的进程：默认只报告不杀；确需结束时加 -Force。

.EXAMPLE
  pwsh -File scripts/stop-gateway.ps1

.EXAMPLE
  pwsh -File scripts/stop-gateway.ps1 -Home ".runtime\scripts-selftest" -Force

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [int]$Port = 0,
    [switch]$Force,
    [int]$WaitSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner -Title 'dsh-remote 网关停止（stop-gateway.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
$pidPath = Get-PidFilePath -Home $remoteHome
$pidInfo = Read-GatewayPidInfo -Home $remoteHome
$psHint = 'pwsh'
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) { $psHint = 'powershell' }

$effectivePort = 0
if ($Port -gt 0) { $effectivePort = $Port }
elseif ($pidInfo) { $effectivePort = [int](Get-JsonProp -Object $pidInfo -Name 'port' -Default 0) }
if ($effectivePort -le 0) {
    $config = Get-ConfigDefaults -Home $remoteHome
    $effectivePort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultPort)
}
$baseUrl = "http://127.0.0.1:$effectivePort"

Write-Section '1/3 状态检查'
Write-Kv -Key '运行目录' -Value $remoteHome
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
    $ok = Stop-ProcessTree -ProcessId $targetPid
    if ($ok) {
        Write-Ok "已结束 PID $targetPid"
        $stoppedSomething = $true
    } else {
        Write-Fail "结束 PID $targetPid 失败（可能需要管理员权限）。"
        exit 1
    }
} elseif ($targetPid -gt 0) {
    Write-Info "PID 文件中的进程 $targetPid 已不存在（上次未正常退出）。"
} else {
    Write-Info 'PID 文件不存在：本脚本未找到自己启动的网关。'
}

# WMI 分离启动路线下，PID 文件里还会记录一个短命的 cmd.exe 启动器；顺手确认它已退出
$launcherPid = 0
if ($pidInfo) { $launcherPid = [int](Get-JsonProp -Object $pidInfo -Name 'launcherPid' -Default 0) }
if ($launcherPid -gt 0 -and $launcherPid -ne $targetPid -and (Test-ProcessAlive -ProcessId $launcherPid)) {
    Write-Info "清理残留的启动器进程 PID $launcherPid …"
    [void](Stop-ProcessTree -ProcessId $launcherPid)
}

# 端口上是否还有残留的网关进程
$owner = Get-PortOwnerProcessId -Port $effectivePort
if ($owner -gt 0) {
    $health = Get-GatewayHealth -BaseUrl $baseUrl -TimeoutSec 3
    if ($health -and -not $Force) {
        Write-Warn "端口 $effectivePort 上仍有网关在响应（PID $owner），但它不是本脚本启动的（无 PID 文件记录）。"
        Write-Info "若确认要结束它：$psHint -File scripts/stop-gateway.ps1 -Port $effectivePort -Force"
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
        Write-Warn "端口 $effectivePort 被 PID $owner 占用，但它不响应 health（可能不是网关）。默认不动它；确认可加 -Force。"
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

$healthAfter = Get-GatewayHealth -BaseUrl $baseUrl -TimeoutSec 3
if ($healthAfter) {
    Write-Warn 'health 仍有响应（可能是别的服务在该端口）。'
} else {
    Write-Ok 'health 已无响应，网关已停止。'
}

if ($stoppedSomething) {
    Write-Host ''
    Write-Ok '网关已停止。历史任务与日志保留在运行目录中（停止不会删除数据）。'
} else {
    Write-Host ''
    Write-Ok '网关本来就没有运行（幂等：无需处理）。'
}
exit 0
