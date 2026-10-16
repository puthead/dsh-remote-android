#Requires -Version 5.1
<#
.SYNOPSIS
  卸载开机自启：移除 install-autostart.ps1 注册的计划任务 / Startup 文件夹启动器（可选清理防火墙规则）。

.DESCRIPTION
  卸载边界（刻意做得干净且可预期）：
    * 只删除计划任务（默认 DshRemoteGateway，以及看门狗任务 DshRemoteGatewayWatchdog）、
      用户「启动」文件夹里的 DshRemoteGateway.cmd，与可选的防火墙规则。
    * 默认顺手停掉常驻看门狗（它只是体检+拉起网关，不属于「自启」本身）；
      想保留看门狗就加 -KeepWatchdog。
    * **不删除**运行目录里的任何数据：凭据、config.json、tasks/、logs/ 全部保留。
    * 幂等：任务/文件/规则本来就不存在时提示「无需卸载」并以 0 退出。

.PARAMETER StopGateway
  卸载后顺便调用 stop-gateway.ps1 停掉当前正在运行的网关。

.PARAMETER KeepWatchdog
  保留看门狗：不删看门狗计划任务、不删 Startup 启动器、也不停常驻看门狗进程。

.EXAMPLE
  pwsh -File scripts/uninstall-autostart.ps1

.EXAMPLE
  pwsh -File scripts/uninstall-autostart.ps1 -RemoveFirewallRule -StopGateway

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [string]$TaskName = 'DshRemoteGateway',
    [int]$Port = 0,
    [switch]$RemoveFirewallRule,
    [switch]$StopGateway,
    [switch]$KeepWatchdog
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner -Title 'dsh-remote 卸载开机自启（uninstall-autostart.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
Write-Section '1/4 移除计划任务'
try { Import-Module ScheduledTasks -ErrorAction Stop } catch { throw "无法加载 ScheduledTasks 模块：$($_.Exception.Message)" }

$taskNames = @($TaskName)
if (-not $KeepWatchdog) { $taskNames += ($TaskName + 'Watchdog') }
$taskFailures = 0
foreach ($name in $taskNames) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Ok "计划任务 $name 不存在（无需卸载，幂等）。"
        continue
    }
    try {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        $still = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($still) {
            Write-Fail "卸载后仍能查到任务 $name，请用管理员 PowerShell 重试。"
            $taskFailures++
        } else {
            Write-Ok "已移除计划任务：$name"
        }
    } catch {
        Write-Fail "移除计划任务 $name 失败：$($_.Exception.Message)"
        Write-Info '若提示「拒绝访问」，请用管理员身份的 PowerShell 重新运行本脚本。'
        $taskFailures++
    }
}

Write-Section '2/4 移除 Startup 文件夹启动器'
if ($KeepWatchdog) {
    Write-Skip '按 -KeepWatchdog 保留 Startup 启动器（它就是「网关 + 看门狗」那条路线）'
} else {
    $startupDir = [Environment]::GetFolderPath('Startup')
    $launcherPath = ''
    if ($startupDir) { $launcherPath = Join-Path $startupDir 'DshRemoteGateway.cmd' }
    if (-not $startupDir) {
        Write-Warn '取不到当前用户的「启动」文件夹路径，跳过。'
    } elseif (Test-Path -LiteralPath $launcherPath -PathType Leaf) {
        try {
            Remove-Item -LiteralPath $launcherPath -Force
            Write-Ok "已删除登录启动器：$launcherPath"
        } catch {
            Write-Fail "删除启动器失败：$($_.Exception.Message)"
        }
    } else {
        Write-Ok "启动器不存在（无需卸载，幂等）：$launcherPath"
    }
}

Write-Section '3/4 清理防火墙规则（可选）'
if ($RemoveFirewallRule) {
    $effectivePort = $Port
    if ($effectivePort -le 0) {
        $config = Get-ConfigDefaults -Home $remoteHome
        $effectivePort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultPort)
    }
    $ruleName = "DSH Remote $effectivePort"
    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($rule) {
        try {
            Remove-NetFirewallRule -DisplayName $ruleName
            Write-Ok "已删除防火墙规则：$ruleName"
        } catch {
            Write-Warn "删除防火墙规则失败（可用管理员 PowerShell 手工删）：$($_.Exception.Message)"
        }
    } else {
        Write-Ok "防火墙规则 $ruleName 不存在（无需清理）。"
    }
} else {
    Write-Skip '未指定 -RemoveFirewallRule：保留既有防火墙规则（如需删除请加该参数）'
}

Write-Section '4/4 停止常驻看门狗（可选）与数据保留说明'
if ($KeepWatchdog) {
    Write-Skip '按 -KeepWatchdog 保留常驻看门狗（它还会继续体检并按需拉起网关）'
} else {
    $watchdogScript = Join-Path $PSScriptRoot 'watchdog-gateway.ps1'
    $watchdogPidFile = Join-Path $remoteHome 'logs\watchdog.pid'
    if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) {
        Write-Warn "找不到 watchdog-gateway.ps1：$watchdogScript（跳过）"
    } elseif (-not (Test-Path -LiteralPath $watchdogPidFile -PathType Leaf)) {
        Write-Ok '常驻看门狗当前没在运行（没有 watchdog.pid，无需停止）。'
    } else {
        Write-Info '调用 watchdog-gateway.ps1 -Stop 停止常驻看门狗…'
        # 必须走 Invoke-DshScript（-Command + UTF-8 包装）：直接用 Invoke-NativeCommand -File 时
        # 子进程中文按 GBK 写出、父进程按 UTF-8 解码 → 控制台出现乱码（实测过）。
        $wdRun = Invoke-DshScript -ScriptPath $watchdogScript -Arguments @('-Home', $remoteHome, '-Stop') -TimeoutSec 120
        Write-Host $wdRun.StdOut
        if ($wdRun.StdErr.Trim()) { Write-Host $wdRun.StdErr -ForegroundColor DarkGray }
        if ($wdRun.ExitCode -ne 0) { Write-Warn ('看门狗停止返回退出码 ' + [string]$wdRun.ExitCode + '，请手工确认。') }
    }
}

Write-Info "运行目录未被改动：$remoteHome"
Write-Info '  * .credentials.yaml / config.json / devices.json / tasks/ / logs/ 全部保留。'
Write-Info '  * 如需彻底清理，请手工删除运行目录（会一并删除任务历史与凭据）。'
if ($StopGateway) {
    $stopScript = Join-Path $PSScriptRoot 'stop-gateway.ps1'
    if (Test-Path -LiteralPath $stopScript -PathType Leaf) {
        Write-Info '按 -StopGateway 调用 stop-gateway.ps1 …'
        $stopArgs = @('-Home', $remoteHome)
        $run = Invoke-DshScript -ScriptPath $stopScript -Arguments $stopArgs -TimeoutSec 120
        Write-Host $run.StdOut
        if ($run.StdErr.Trim()) { Write-Host $run.StdErr -ForegroundColor DarkGray }
        if ($run.ExitCode -ne 0) { Write-Warn ('停止网关返回退出码 ' + [string]$run.ExitCode + '，请手工确认。') }
    } else {
        Write-Warn "找不到 stop-gateway.ps1：$stopScript"
    }
} else {
    Write-Skip '未指定 -StopGateway：当前运行的网关保持不变（重启电脑后不再自启）'
}

if ($taskFailures -gt 0) {
    Write-Fail ("有 $taskFailures 个计划任务没卸干净，请用管理员 PowerShell 重试。")
    exit 1
}
exit 0
