#Requires -Version 5.1
<#
.SYNOPSIS
  安装开机自启：注册「用户登录时触发」的 Windows 计划任务，登录后自动后台启动 dsh-remote 网关。

.DESCRIPTION
  设计说明：
    * 触发方式刻意选「登录时（AtLogOn）」而不是「开机时」：
      网关需要当前用户的 %USERPROFILE%（凭据、任务历史、日志），
      以 SYSTEM/服务账户运行会读到另一套目录，凭据也会对不上。
    * 幂等：同名任务已存在时用 -Force 覆盖注册，不会产生重复任务；参数变化即更新。
    * 只写计划任务（可选加一条防火墙规则），不复制任何密钥，不删除既有数据。
    * 运行账户 = 当前登录用户，权限级别 = Limited（不需要管理员常驻）。

.PARAMETER TaskName
  计划任务名，默认 DshRemoteGateway。

.PARAMETER PowerShellPath
  用哪个 PowerShell 承载脚本，默认优先 pwsh.exe（PowerShell 7），否则用系统 Windows PowerShell。

.PARAMETER StartNow
  注册后立刻启动一次（便于当场验证）。

.PARAMETER AddFirewallRule
  顺带放行入站 TCP 端口（仅「专用网络」），手机同网段直连时需要。幂等：已存在则不重复加。

.EXAMPLE
  pwsh -File scripts/install-autostart.ps1

.EXAMPLE
  pwsh -File scripts/install-autostart.ps1 -Home "$env:USERPROFILE\.dsh-remote" -AddFirewallRule -StartNow

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  查看状态：Get-ScheduledTask -TaskName DshRemoteGateway | Get-ScheduledTaskInfo
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [string]$TaskName = 'DshRemoteGateway',
    [int]$Port = 0,
    [string]$PowerShellPath,
    [switch]$StartNow,
    [switch]$AddFirewallRule,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner -Title 'dsh-remote 安装开机自启（install-autostart.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
$startScript = Join-Path $PSScriptRoot 'start-gateway.ps1'
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) { throw "缺少启动脚本：$startScript" }
$psHint = 'pwsh'
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) { $psHint = 'powershell' }

Write-Section '1/4 解析运行参数'
Write-Kv -Key '运行目录' -Value $remoteHome
Write-Kv -Key '启动脚本' -Value $startScript

if (-not $PowerShellPath) {
    $pwshCmd = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pwshCmd -and $pwshCmd.Source) {
        $PowerShellPath = $pwshCmd.Source
    } else {
        $PowerShellPath = Join-Path $PSHOME 'powershell.exe'
    }
}
if (-not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf)) { throw "找不到 PowerShell 可执行文件：$PowerShellPath" }
Write-Kv -Key 'PowerShell' -Value $PowerShellPath

if (-not (Test-Path -LiteralPath (Join-Path $remoteHome 'config.json') -PathType Leaf)) {
    Write-Warn "运行目录里没有 config.json：$remoteHome"
    Write-Info '建议先执行：pwsh -File scripts/setup-pc.ps1（否则自启后网关也没有可用配置）'
}

try { Import-Module ScheduledTasks -ErrorAction Stop } catch { throw "无法加载 ScheduledTasks 模块：$($_.Exception.Message)" }
$currentUser = "$env:USERDOMAIN\$env:USERNAME"
if (-not $env:USERDOMAIN) { $currentUser = $env:USERNAME }
Write-Kv -Key '运行账户' -Value $currentUser

# 提权预检：注册计划任务需要管理员权限；未提权时提前说清楚，避免用户对着 Access is denied 猜。
$isElevated = $false
try {
    $principalCheck = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    $isElevated = $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
Write-Kv -Key '当前会话' -Value $(if ($isElevated) { '已提权（管理员）' } else { '未提权' })
if (-not $isElevated -and -not $DryRun) {
    Write-Warn '当前 PowerShell 未以管理员身份运行：注册计划任务很可能被系统拒绝（Access is denied）。'
    Write-Info '请用「以管理员身份运行」的 PowerShell 重新执行本脚本；或先加 -DryRun 只查看将要注册的内容。'
}

Write-Section '2/4 注册计划任务（登录时触发）'
$arguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'
    '-File', ('"' + $startScript + '"')
    '-Home', ('"' + $remoteHome + '"')
)
if ($Port -gt 0) { $arguments += @('-Port', [string]$Port) }
$argumentLine = ($arguments -join ' ')

$action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $argumentLine -WorkingDirectory (Get-RepoRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$description = 'dsh-remote 网关：用户登录后自动后台启动（由 scripts/install-autostart.ps1 注册）'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Info "已存在同名任务，将更新其定义（幂等，不会产生重复任务）。"
} else {
    Write-Info '未发现同名任务，准备新建。'
}

Write-Kv -Key '任务名' -Value $TaskName
Write-Kv -Key '执行命令' -Value ("$PowerShellPath $argumentLine")
Write-Kv -Key '触发器' -Value "登录时（用户 $currentUser）"
Write-Kv -Key '权限级别' -Value 'Limited（不需要常驻管理员）'
Write-Kv -Key '执行时限' -Value '无限制（网关需要长期驻留）'

if ($DryRun) {
    Write-Section '演练模式（-DryRun）'
    Write-Skip '未写入系统：以上即为将要注册的计划任务定义。去掉 -DryRun 即真正注册。'
    Write-Info "如需立刻验证：用管理员 PowerShell 执行 $psHint -File scripts/install-autostart.ps1 -StartNow"
    exit 0
}

try {
    $registered = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description $description -Force
} catch {
    Write-Fail "注册计划任务失败：$($_.Exception.Message)"
    if (-not $isElevated) {
        Write-Info '当前会话未提权：请用「以管理员身份运行」的 PowerShell 重新执行本脚本。'
    } else {
        Write-Info '已是管理员仍失败时，请检查组策略是否禁止创建计划任务，或改用「任务计划程序」图形界面导入。'
    }
    Write-Info "也可以用 -DryRun 先查看将要注册的定义：$psHint -File scripts/install-autostart.ps1 -DryRun"
    exit 1
}
Write-Ok "计划任务已注册：$($registered.TaskName)（状态：$($registered.State)）"

Write-Section '3/4 防火墙（可选）'
if ($AddFirewallRule) {
    $effectivePort = $Port
    if ($effectivePort -le 0) {
        $config = Get-ConfigDefaults -Home $remoteHome
        $effectivePort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultPort)
    }
    $ruleName = "DSH Remote $effectivePort"
    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($rule) {
        Write-Ok "防火墙规则已存在，保持不变：$ruleName"
    } else {
        try {
            [void](New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
                    -LocalPort $effectivePort -Action Allow -Profile Private -Description 'dsh-remote 网关（仅专用网络）')
            Write-Ok "已添加入站规则：$ruleName（TCP $effectivePort，仅专用网络）"
        } catch {
            Write-Warn "添加防火墙规则失败（可用管理员 PowerShell 手工加）：$($_.Exception.Message)"
        }
    }
    Write-Info "安全提示：只对「专用网络」放行；公网暴露必须走 TLS 隧道（见部署手册 §7）。"
} else {
    Write-Skip '未指定 -AddFirewallRule：跳过防火墙配置（同网段直连需自行放行端口）'
}

Write-Section '4/4 生效验证'
$verify = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($verify) {
    Write-Ok "任务存在：$($verify.TaskName) / 状态 $($verify.State)"
    if ($StartNow) {
        Write-Info '立刻启动一次任务…'
        Start-ScheduledTask -TaskName $TaskName
        Start-Sleep -Seconds 3
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Kv -Key '上次运行时间' -Value ([string]$info.LastRunTime)
        Write-Kv -Key '上次结果码' -Value ([string]$info.LastTaskResult)
        Write-Info '结果码 0 表示启动成功；若网关已在运行，start-gateway.ps1 会直接判重并返回 0。'
    } else {
        Write-Info '未指定 -StartNow：下次登录会自动启动；也可用 Start-ScheduledTask -TaskName <名字> 立即测试。'
    }
    Write-Kv -Key '状态查询' -Value "Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
    Write-Kv -Key '卸载' -Value 'pwsh -File scripts/uninstall-autostart.ps1'
} else {
    Write-Fail '注册后未查到任务，请手工检查计划任务库。'
    exit 1
}
exit 0
