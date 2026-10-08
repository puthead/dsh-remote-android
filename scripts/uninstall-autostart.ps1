#Requires -Version 5.1
<#
.SYNOPSIS
  卸载开机自启：移除 install-autostart.ps1 注册的计划任务（可选清理防火墙规则）。

.DESCRIPTION
  卸载边界（刻意做得干净且可预期）：
    * 只删除计划任务（默认 DshRemoteGateway）与可选的防火墙规则。
    * **不删除**运行目录里的任何数据：凭据、config.json、tasks/、logs/ 全部保留。
    * 幂等：任务/规则本来就不存在时提示「无需卸载」并以 0 退出。

.PARAMETER StopGateway
  卸载后顺便调用 stop-gateway.ps1 停掉当前正在运行的网关。

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
    [switch]$StopGateway
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner -Title 'dsh-remote 卸载开机自启（uninstall-autostart.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
Write-Section '1/3 移除计划任务'
try { Import-Module ScheduledTasks -ErrorAction Stop } catch { throw "无法加载 ScheduledTasks 模块：$($_.Exception.Message)" }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        $still = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($still) {
            Write-Fail "卸载后仍能查到任务 $TaskName，请用管理员 PowerShell 重试。"
            exit 1
        }
        Write-Ok "已移除计划任务：$TaskName"
    } catch {
        Write-Fail "移除计划任务失败：$($_.Exception.Message)"
        Write-Info '若提示「拒绝访问」，请用管理员身份的 PowerShell 重新运行本脚本。'
        exit 1
    }
} else {
    Write-Ok "计划任务 $TaskName 不存在（无需卸载，幂等）。"
}

Write-Section '2/3 清理防火墙规则（可选）'
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

Write-Section '3/3 数据保留说明与可选停止'
Write-Info "运行目录未被改动：$remoteHome"
Write-Info '  * .credentials.yaml / config.json / devices.json / tasks/ / logs/ 全部保留。'
Write-Info '  * 如需彻底清理，请手工删除运行目录（会一并删除任务历史与凭据）。'
if ($StopGateway) {
    $stopScript = Join-Path $PSScriptRoot 'stop-gateway.ps1'
    if (Test-Path -LiteralPath $stopScript -PathType Leaf) {
        Write-Info '按 -StopGateway 调用 stop-gateway.ps1 …'
        $stopArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $stopScript)
        if ($DshRemoteHome) { $stopArgs += @('-Home', $remoteHome) }
        $psExe = Join-Path $PSHOME 'powershell.exe'
        if (Test-Path -LiteralPath (Join-Path $PSHOME 'pwsh.exe') -PathType Leaf) { $psExe = Join-Path $PSHOME 'pwsh.exe' }
        $run = Invoke-NativeCommand -FilePath $psExe -ArgumentList $stopArgs -TimeoutSec 120
        Write-Host $run.StdOut
        if ($run.StdErr.Trim()) { Write-Host $run.StdErr -ForegroundColor DarkGray }
    } else {
        Write-Warn "找不到 stop-gateway.ps1：$stopScript"
    }
} else {
    Write-Skip '未指定 -StopGateway：当前运行的网关保持不变（重启电脑后不再自启）'
}
exit 0
