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

.PARAMETER WithWatchdog
  额外注册一个「看门狗」计划任务：按 -WatchdogIntervalMinutes 的间隔重复调用
  scripts\watchdog-gateway.ps1 -Once —— 网关进程中途死掉也能自动拉回来（不需要等到下次登录）。
  仍需要管理员权限（和主任务一样）。

.PARAMETER WatchdogIntervalMinutes
  看门狗计划任务的重复间隔（分钟），默认 2。

.PARAMETER StartupFolder
  **不需要管理员权限的路线**：不注册计划任务，改为在「当前用户的启动文件夹」写一个
  DshRemoteGateway.cmd；登录时它会拉起「网关 + 看门狗」，因此网关崩溃后同样能自愈。
  权限不足、或不想动计划任务时用这个。

.PARAMETER AddFirewallRule
  顺带放行入站 TCP 端口（仅「专用网络」），手机同网段直连时需要。幂等：已存在则不重复加。

.EXAMPLE
  pwsh -File scripts/install-autostart.ps1

.EXAMPLE
  pwsh -File scripts/install-autostart.ps1 -Home "$env:USERPROFILE\.dsh-remote" -AddFirewallRule -StartNow

.EXAMPLE
  # 需要管理员：主任务 + 看门狗任务（每 2 分钟体检一次）
  pwsh -File scripts/install-autostart.ps1 -WithWatchdog -StartNow

.EXAMPLE
  # 不需要管理员：只在启动文件夹放一个 cmd（登录时拉起网关 + 看门狗）
  pwsh -File scripts/install-autostart.ps1 -StartupFolder

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  查看状态：Get-ScheduledTask -TaskName DshRemoteGateway | Get-ScheduledTaskInfo
            Get-ScheduledTask -TaskName DshRemoteGatewayWatchdog | Get-ScheduledTaskInfo
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [string]$TaskName = 'DshRemoteGateway',
    [int]$Port = 0,
    [string]$PowerShellPath,
    [switch]$StartNow,
    [switch]$WithWatchdog,
    [int]$WatchdogIntervalMinutes = 2,
    [switch]$StartupFolder,
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

# ── 无管理员路线：写「启动文件夹」启动器 ──────────────────────────────────────
# 为什么需要这条路线：注册计划任务必须有管理员权限（非提权会话直接 Access is denied），
# 而「网关中途崩掉没人拉起来」这件事必须有个不依赖管理员的兜底。
if ($StartupFolder) {
    Write-Section '2/2 写启动文件夹启动器（-StartupFolder，不需要管理员）'
    $watchdogScript = Join-Path $PSScriptRoot 'watchdog-gateway.ps1'
    if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) { throw "缺少看门狗脚本：$watchdogScript" }
    $startupDir = [Environment]::GetFolderPath('Startup')
    if (-not $startupDir) { throw '取不到当前用户的「启动」文件夹路径。' }
    if (-not (Test-Path -LiteralPath $startupDir -PathType Container)) {
        [void](New-Item -ItemType Directory -Force -Path $startupDir)
    }
    $launcherPath = Join-Path $startupDir 'DshRemoteGateway.cmd'
    $intervalSeconds = [int]([Math]::Max(30, $WatchdogIntervalMinutes * 60))
    $portArg = ''
    if ($Port -gt 0) { $portArg = ' -Port ' + [string]$Port }

    $cmdLines = @(
        '@echo off'
        'rem Generated by dsh_android\scripts\install-autostart.ps1 -StartupFolder (runs at logon, no admin needed).'
        ('rem Starts the gateway plus a watchdog; the watchdog checks every ' + [string]$intervalSeconds + 's and restarts the gateway if the process is gone.')
        'rem This file is intentionally ASCII-only: cmd.exe reads it in the OEM code page.'
        'set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"'
        'if not exist "%PS%" set "PS=powershell.exe"'
        ('start "DSH gateway" /min "%PS%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $startScript + '" -Home "' + $remoteHome + '"' + $portArg)
        ('start "DSH watchdog" /min "%PS%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $watchdogScript + '" -Home "' + $remoteHome + '"' + $portArg + ' -IntervalSeconds ' + [string]$intervalSeconds + ' -Quiet')
        'exit /b 0'
    )

    Write-Kv -Key '启动文件夹' -Value $startupDir
    Write-Kv -Key '启动器' -Value $launcherPath
    Write-Kv -Key '看门狗间隔' -Value ([string]$intervalSeconds + ' 秒')
    if ($DryRun) {
        Write-Skip '演练模式（-DryRun）：未写文件。将要写入的内容：'
        foreach ($line in $cmdLines) { Write-Host ('    ' + $line) -ForegroundColor DarkGray }
        exit 0
    }
    Set-Content -LiteralPath $launcherPath -Value $cmdLines -Encoding ASCII
    Write-Ok "已写入启动器：$launcherPath"
    Write-Info '登录时会自动执行（也可双击它立刻拉起网关 + 看门狗）。'
    Write-Info '卸载：删除该文件，或跑 scripts/uninstall-autostart.ps1（它会一起清理）。'
    Write-Section '校验'
    if (Test-Path -LiteralPath $launcherPath -PathType Leaf) {
        foreach ($line in (Get-Content -LiteralPath $launcherPath)) { Write-Host ('    ' + $line) -ForegroundColor DarkGray }
        Write-Ok '启动器已就位。'
        exit 0
    }
    Write-Fail "启动器写入失败：$launcherPath"
    exit 1
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

# ── 可选：注册看门狗计划任务（网关中途崩掉也能自愈）───────────────────────────
$watchTaskName = $TaskName + 'Watchdog'
if ($WithWatchdog) {
    Write-Section '2b/4 注册看门狗计划任务（-WithWatchdog）'
    $watchdogScript = Join-Path $PSScriptRoot 'watchdog-gateway.ps1'
    if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) { throw "缺少看门狗脚本：$watchdogScript" }
    if ($WatchdogIntervalMinutes -lt 1) { throw "-WatchdogIntervalMinutes 至少为 1 分钟（收到 $WatchdogIntervalMinutes）。" }

    $watchArguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'
        '-File', ('"' + $watchdogScript + '"')
        '-Home', ('"' + $remoteHome + '"')
        '-Once', '-Quiet'
    )
    if ($Port -gt 0) { $watchArguments += @('-Port', [string]$Port) }
    $watchArgumentLine = ($watchArguments -join ' ')

    $watchAction = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $watchArgumentLine -WorkingDirectory (Get-RepoRoot)
    $watchTrigger = $null
    try {
        $watchTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
            -RepetitionInterval (New-TimeSpan -Minutes $WatchdogIntervalMinutes) -RepetitionDuration ([TimeSpan]::MaxValue)
    } catch {
        Write-Warn "按「无限重复」构造触发器失败（$($_.Exception.Message)）；改为单次触发器，请在任务计划程序里手工勾选『重复任务间隔』。"
        $watchTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1))
    }
    $watchSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    $watchPrincipal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $watchDescription = "dsh-remote 网关看门狗：每 $WatchdogIntervalMinutes 分钟体检一次，网关进程没了就自动拉起（由 scripts/install-autostart.ps1 -WithWatchdog 注册）"

    Write-Kv -Key '看门狗任务名' -Value $watchTaskName
    Write-Kv -Key '执行命令' -Value ("$PowerShellPath $watchArgumentLine")
    Write-Kv -Key '重复间隔' -Value ([string]$WatchdogIntervalMinutes + ' 分钟')
    Write-Kv -Key '看门狗日志' -Value (Join-Path $remoteHome 'logs\watchdog.log')
    try {
        $watchRegistered = Register-ScheduledTask -TaskName $watchTaskName -Action $watchAction -Trigger $watchTrigger `
            -Settings $watchSettings -Principal $watchPrincipal -Description $watchDescription -Force
        Write-Ok "看门狗任务已注册：$($watchRegistered.TaskName)（状态：$($watchRegistered.State)）"
    } catch {
        Write-Warn "看门狗任务注册失败（主任务不受影响）：$($_.Exception.Message)"
        Write-Info '可稍后用管理员 PowerShell 重跑本命令，或改用 -StartupFolder 路线（不需要管理员）。'
    }
    if ($StartNow) {
        try {
            Start-ScheduledTask -TaskName $watchTaskName
            Write-Ok '已立刻跑一次看门狗任务。'
        } catch {
            Write-Warn "立刻运行看门狗任务失败：$($_.Exception.Message)"
        }
    }
}

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
    if ($WithWatchdog) {
        $watchVerify = Get-ScheduledTask -TaskName $watchTaskName -ErrorAction SilentlyContinue
        if ($watchVerify) {
            Write-Ok "看门狗任务存在：$($watchVerify.TaskName) / 状态 $($watchVerify.State)"
            $watchInfo = Get-ScheduledTaskInfo -TaskName $watchTaskName
            Write-Kv -Key '看门狗下次运行' -Value ([string]$watchInfo.NextRunTime)
            Write-Kv -Key '看门狗上次结果码' -Value ([string]$watchInfo.LastTaskResult)
            Write-Kv -Key '看门狗状态查询' -Value "Get-ScheduledTask -TaskName $watchTaskName | Get-ScheduledTaskInfo"
        } else {
            Write-Warn '看门狗任务未查到：请用管理员 PowerShell 重跑，或改用 -StartupFolder 路线。'
        }
    } else {
        Write-Info '未启用看门狗（-WithWatchdog）：网关中途崩掉需要人工或登录时才会恢复。'
    }
    Write-Kv -Key '卸载' -Value 'pwsh -File scripts/uninstall-autostart.ps1'
} else {
    Write-Fail '注册后未查到任务，请手工检查计划任务库。'
    exit 1
}
exit 0
