<#
.SYNOPSIS
    把 dsh-remote 网关注册为 Windows 计划任务，实现登录后自动启动（幂等，可卸载）。

.DESCRIPTION
    为什么用计划任务而不是 Windows 服务：
    - 服务运行在 Session 0，无法访问用户登录会话中的用户级环境（如用户的 DSH 凭据目录权限），
      且 dsh 子进程需要以当前用户身份运行；
    - 计划任务可以在"用户登录时"触发，与用户身份一致，且不需要额外的服务包装器（零依赖）。
    任务以隐藏窗口方式运行 dsh-remote.cmd serve，并把 stdout/stderr 追加到 home\logs 下的文件。

.PARAMETER Home
    网关运行时 home（凭据 + tasks + logs）。默认 %USERPROFILE%\.dsh-remote。

.PARAMETER Config
    配置文件路径。默认 tools\dsh-remote\config.json。

.PARAMETER TaskName
    计划任务名称，默认 DshRemoteGateway。

.PARAMETER Uninstall
    卸载：停止并删除计划任务。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-service.ps1
    powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Home,
    [string]$Config,
    [string]$TaskName = 'DshRemoteGateway',
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $scriptDir 'dsh-remote.cmd'
if (-not (Test-Path -LiteralPath $launcher)) { throw "找不到启动器：$launcher" }

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "计划任务 $TaskName 不存在，无需卸载。" -ForegroundColor Yellow
        exit 0
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已卸载计划任务 $TaskName。" -ForegroundColor Green
    exit 0
}

if (-not $Home) { $Home = Join-Path $env:USERPROFILE '.dsh-remote' }
if (-not $Config) { $Config = Join-Path $scriptDir 'config.json' }

New-Item -ItemType Directory -Force -Path $Home | Out-Null
$logDir = Join-Path $Home 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir 'autostart.out.log'
$errLog = Join-Path $logDir 'autostart.err.log'

$arguments = "serve --home `"$Home`""
if (Test-Path -LiteralPath $Config) { $arguments = "serve --config `"$Config`" --home `"$Home`"" }

$action = New-ScheduledTaskAction -Execute $launcher -Argument $arguments -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'DSH 远程任务网关：登录时自动启动（dsh-remote）' `
    -Force | Out-Null

Write-Host "已注册计划任务 $TaskName（登录时自动启动）。" -ForegroundColor Green
Write-Host "  home    : $Home"
Write-Host "  启动器  : $launcher"
Write-Host "  输出日志: $outLog"
Write-Host "  错误日志: $errLog"
Write-Host ""
Write-Host "立即试运行：Start-ScheduledTask -TaskName $TaskName" -ForegroundColor Cyan
Write-Host "卸载      ：powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -Uninstall" -ForegroundColor Cyan
Write-Host "提示：计划任务的 stdout 不会自动落盘，如需长期日志请依赖网关自身的 home\logs\gateway-YYYYMMDD.log。" -ForegroundColor Gray
