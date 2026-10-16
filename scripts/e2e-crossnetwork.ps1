#Requires -Version 5.1
<#
.SYNOPSIS
  跨网络等价拓扑端到端验证（契约 §6 判据 A~E）：每条判据打印「实测命令 + 真实输出 + PASS/FAIL」。

.DESCRIPTION
  为什么要这个脚本：本轮没有公网 VPS，跨网络语义只能用「等价拓扑」证明 ——
  手机（纯 Node 模拟器）只经中继隧道访问 PC 网关，网关只出站、只绑回环。

  拓扑（三个真实进程，互不共享内存）：
    phone-sim.mjs  --ws://127.0.0.1:<RelayPort>/api/v2/tunnel/device-->  中继 relay.mjs
    中继 <--wss/ws 出站长连接（home 隧道）--  网关 gateway.mjs（只绑 127.0.0.1:<Port>）
    网关 --SDK profile 子进程-->  dsh（隔离 DSH_HOME，绝不写真实 ~/.dsh）

  判据（严格按 docs/01-设计/协议契约-v2.md §6）：
    A. 手机无法直连 PC   —— 网关只绑 127.0.0.1；打本机局域网 IP / 10.0.2.2 的 <Port> 必须失败，
                            同时 127.0.0.1:<Port> 必须成功（正向对照，证明不是「网关没起来」）。
    B. 手机只经中继可达 —— 经隧道：pair/claim → /api/v2/sessions → /transcript →
                            /workspaces/files → /workspaces/changes → 越界被拒 →
                            POST /turns 真实续聊（网关自己 DSH_HOME 里的「手机任务」会话，
                            契约 §7.2 SDK profile；镜像的桌面会话必须被拒，契约 §7.3）。
    C. PC 只出站         —— netstat -ano -p tcp：网关只有 127.0.0.1:<Port> LISTENING，
                            中继在 0.0.0.0:<RelayPort>（或 [::]）LISTENING。
    D. PC 掉线可见       —— stop-gateway → 手机侧收到 notice{home_offline}，请求得到 503 home_offline；
                            重启网关 → notice{home_online} + 请求恢复。
    E. 中继重启自愈      —— 重启中继进程 → 网关自动重连（relay/status.reconnects 增长），
                            手机侧自动重连并把请求跑通，无需人工干预。

  诚实性要求：
    * 任一条 FAIL/BLOCKED → 退出码非 0；实现未就绪时记 BLOCKED 并写明原因，**绝不伪造**。
    * 所有输出同时进 transcript 日志与 JSON 报告，落到 .runtime\acceptance\。

.PARAMETER Home
  E2E 运行根目录（默认 <仓库>\.runtime\e2e-crossnetwork）。子目录：
    relay\（中继运行目录）、home\（网关运行目录）、mirror\（镜像用隔离 DSH home）、
    ws\（隔离工作区）、phone\（手机模拟器令牌与事件）。

.PARAMETER Port
  被测网关端口（默认 8787，与契约一致）。被别的进程占用时脚本会明确失败并提示 -Port。

.PARAMETER Criteria
  只跑指定判据（默认 A,B,C,D,E）。

.EXAMPLE
  powershell -File scripts/e2e-crossnetwork.ps1 -ReportFile ".runtime\acceptance\e2e-crossnetwork.json"

.EXAMPLE
  # 只验证 A/C（网关 v2 未就绪时也能跑）
  powershell -File scripts/e2e-crossnetwork.ps1 -Criteria A,C

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1；脚本文件必须 UTF-8 带 BOM。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$E2eHome,
    [int]$Port = 8787,
    [int]$RelayPort = 9443,
    [string]$Criteria = 'A,B,C,D,E',
    [string]$GatewayDir,
    [string]$RelayDir,
    [string]$Node,
    [string]$Launcher,
    [string]$MirrorSessionId,
    [int]$TurnTimeoutSec = 420,
    [int]$SeedTimeoutSec = 300,
    [switch]$SkipSeed,
    [switch]$WithInterop,
    [int]$InteropTimeoutSec = 300,
    [switch]$KeepProcesses,
    [switch]$Json,
    [string]$ReportFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

$repoRoot = Get-RepoRoot
# 判据选择：接受 "A,C" / "A C" / "a;c" 等写法（-File 调用时数组参数不方便，统一用字符串解析）
$criteriaList = @($Criteria -split '[,;\s]+' | Where-Object { $_ -ne '' } | ForEach-Object { $_.ToUpperInvariant() } | Select-Object -Unique)
if ($criteriaList.Count -eq 0) { throw '-Criteria 不能为空（可选 A/B/C/D/E，逗号分隔）' }
foreach ($c in $criteriaList) {
    if (@('A', 'B', 'C', 'D', 'E') -notcontains $c) { throw "-Criteria 只支持 A~E，收到：$c" }
}
$runWanted = { param([string]$c) return ($criteriaList -contains $c) }

# ── 证据收集 ──────────────────────────────────────────────────────────────────
$script:Results = New-Object System.Collections.ArrayList
$script:StartedWatch = $null
$script:GatewayOwned = $false
$script:RelayOwned = $false
$script:SeedSessionId = $null
$script:MirrorSessionIdFound = $null
$script:TokenFile = $null
$script:PhoneEvents = $null
$script:Stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$script:AcceptanceDir = Get-AcceptanceDir
$script:TranscriptPath = Join-Path $script:AcceptanceDir "e2e-crossnetwork-$($script:Stamp).log"
if (-not $ReportFile) { $ReportFile = Join-Path $script:AcceptanceDir "e2e-crossnetwork-$($script:Stamp).json" }

function Add-Criterion {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL', 'BLOCKED', 'SKIP')][string]$Status,
        [string]$Evidence = ''
    )
    [void]$script:Results.Add([pscustomobject]@{ 判据 = $Name; 结果 = $Status; 证据 = $Evidence })
    $color = 'Red'
    if ($Status -eq 'PASS') { $color = 'Green' } elseif ($Status -eq 'BLOCKED') { $color = 'DarkYellow' } elseif ($Status -eq 'SKIP') { $color = 'Gray' }
    Write-Host ("  [$Status] $Name —— $Evidence") -ForegroundColor $color
}

function Write-CommandEvidence {
    <#
      打印「实测命令」+ 真实输出（截断到 -MaxLines 行），并原样返回输出文本。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$CommandLine,
        [string]$Output = '',
        [int]$MaxLines = 12
    )
    Write-Host ("  $ " + $CommandLine) -ForegroundColor DarkGray
    if ($Output) {
        $lines = @($Output -split "`r?`n")
        $shown = 0
        foreach ($line in $lines) {
            if ($shown -ge $MaxLines) { Write-Host ("    …（省略 " + ($lines.Count - $MaxLines) + " 行）") -ForegroundColor DarkGray; break }
            Write-Host ("    " + $line) -ForegroundColor Gray
            $shown += 1
        }
    } else {
        Write-Host '    （无输出）' -ForegroundColor DarkGray
    }
    return $Output
}

function Invoke-ChildScript {
    <#
      调用子脚本（start/stop/setup），把 stdout + stderr 都作为证据打印出来。
      stderr 很关键：脚本抛异常时错误只在 stderr 里，漏掉它排障会瞎猜。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 180,
        [int]$MaxLines = 18
    )
    Write-Host ("  $ powershell -File " + (Split-Path -Leaf $ScriptPath) + ' ' +
        ((@($Arguments) | ForEach-Object { if ([string]$_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')) -ForegroundColor DarkGray
    $run = Invoke-DshScript -ScriptPath $ScriptPath -Arguments $Arguments -TimeoutSec $TimeoutSec
    if ($run.StdOut) {
        $lines = @($run.StdOut -split "`r?`n")
        $shown = 0
        foreach ($line in $lines) {
            if ($shown -ge $MaxLines) { Write-Host ("    …（省略 " + ($lines.Count - $MaxLines) + " 行）") -ForegroundColor DarkGray; break }
            Write-Host ("    " + $line) -ForegroundColor Gray
            $shown += 1
        }
    } else {
        Write-Host '    （stdout 为空）' -ForegroundColor DarkGray
    }
    if ($run.StdErr -and $run.StdErr.Trim()) {
        Write-Host '    ── stderr ──' -ForegroundColor DarkYellow
        foreach ($line in @($run.StdErr -split "`r?`n" | Select-Object -First 20)) { Write-Host ("    " + $line) -ForegroundColor DarkYellow }
    }
    if ($run.TimedOut) { Write-Warn "子脚本超时（$TimeoutSec 秒）：$(Split-Path -Leaf $ScriptPath)" }
    Write-Host ("    → 退出码 " + [string]$run.ExitCode) -ForegroundColor DarkGray
    return $run
}

function Stop-StartedProcesses {
    if ($script:StartedWatch -and $script:StartedWatch.Pid -gt 0) {
        [void](Stop-ProcessTree -ProcessId $script:StartedWatch.Pid)
        $script:StartedWatch = $null
    }
}

Write-Banner -Title 'DSH Remote 跨网络等价拓扑验证（e2e-crossnetwork.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))
try { Start-Transcript -Path $script:TranscriptPath -Force | Out-Null } catch { Write-Warn "无法开启 transcript：$($_.Exception.Message)" }

$e2eRoot = $E2eHome
if (-not $e2eRoot) { $e2eRoot = Join-Path (Join-Path $repoRoot '.runtime') 'e2e-crossnetwork' }
$e2eRoot = [System.IO.Path]::GetFullPath($e2eRoot)
$relayHome = Join-Path $e2eRoot 'relay'
$gatewayHome = Join-Path $e2eRoot 'home'
$mirrorHome = Join-Path $e2eRoot 'mirror'
$workspace = Join-Path $e2eRoot 'ws'
$phoneDir = Join-Path $e2eRoot 'phone'
$script:TokenFile = Join-Path $phoneDir 'token.json'
$script:PhoneEvents = Join-Path $phoneDir 'events.jsonl'
$tunnelArg = @()   # 手机模拟器的 --tunnel-url 覆盖参数（仅当中继返回的地址在本机不可解析时使用）

$nodeExe = Find-NodeExe -Node $Node
if (-not $nodeExe) { throw '找不到 node.exe：请安装 Node.js 18+，或用 -Node 指定。' }
if (-not $GatewayDir) { $GatewayDir = Get-DefaultGatewayDir }
if (-not $RelayDir) { $RelayDir = Get-DefaultRelayDir }
$gatewayEntry = Assert-GatewaySource -GatewayDir $GatewayDir
$relayEntry = Get-RelayEntryPath -RelayDir $RelayDir
$relayReady = Test-RelaySourceReady -RelayDir $RelayDir
$phoneSim = Join-Path (Join-Path $PSScriptRoot 'tests') 'phone-sim.mjs'
$startGateway = Join-Path $PSScriptRoot 'start-gateway.ps1'
$stopGateway = Join-Path $PSScriptRoot 'stop-gateway.ps1'
$startRelay = Join-Path $PSScriptRoot 'start-relay.ps1'
$stopRelay = Join-Path $PSScriptRoot 'stop-relay.ps1'
foreach ($f in @($phoneSim, $startGateway, $stopGateway, $startRelay, $stopRelay)) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "缺少依赖文件：$f" }
}

# ── 0. 预检与环境隔离 ────────────────────────────────────────────────────────
Write-Section '0/9 预检：进程、端口、隔离环境'
Write-Kv -Key 'E2E 根目录' -Value $e2eRoot
Write-Kv -Key '中继源码' -Value $(if ($relayReady) { $relayEntry } else { "缺失（$relayEntry）" })
Write-Kv -Key '网关源码' -Value $gatewayEntry
Write-Kv -Key 'node.exe' -Value $nodeExe
Write-Kv -Key '网关端口' -Value ([string]$Port)
Write-Kv -Key '中继端口' -Value ([string]$RelayPort)
Write-Kv -Key '判据' -Value ($criteriaList -join ', ')

$portOwner = Get-PortOwnerProcessId -Port $Port
if ($portOwner -gt 0) {
    Write-Fail "端口 $Port 已被 PID $portOwner 占用，无法建立干净的等价拓扑。"
    Write-Info "处理：停止该进程（例如 powershell -File scripts/stop-gateway.ps1），或改用 -Port <其它端口>。"
    Write-Info "查看：netstat -ano | findstr :$Port"
    Add-Criterion -Name '预检：端口可用' -Status 'FAIL' -Evidence "端口 $Port 被 PID $portOwner 占用"
    if ($Json) { Write-Host (ConvertTo-JsonText -InputObject ([ordered]@{ ok = $false; reason = "port $Port busy (pid $portOwner)" }) -Compress) }
    exit 1
}
$relayPortOwner = Get-PortOwnerProcessId -Port $RelayPort
if ($relayPortOwner -gt 0) {
    Write-Fail "端口 $RelayPort 已被 PID $relayPortOwner 占用（中继端口必须空闲）。"
    Write-Info "处理：powershell -File scripts/stop-relay.ps1 -Port $RelayPort，或改用 -RelayPort <其它端口>。"
    Add-Criterion -Name '预检：端口可用' -Status 'FAIL' -Evidence "中继端口 $RelayPort 被 PID $relayPortOwner 占用"
    exit 1
}
Add-Criterion -Name '预检：端口可用' -Status 'PASS' -Evidence "网关 $Port 与中继 $RelayPort 均空闲"

foreach ($dir in @($e2eRoot, $relayHome, $gatewayHome, $mirrorHome, $workspace, $phoneDir)) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
}
foreach ($stale in @((Get-PidFilePath -Home $gatewayHome), (Get-RelayPidFilePath -Home $relayHome))) {
    if (Test-Path -LiteralPath $stale -PathType Leaf) { Remove-Item -LiteralPath $stale -Force }
}
if (Test-Path -LiteralPath $script:PhoneEvents -PathType Leaf) { Remove-Item -LiteralPath $script:PhoneEvents -Force }

# 凭据：优先用既有网关运行目录的 .credentials.yaml，其次 %USERPROFILE%\.dsh\.credentials.yaml
$credSource = $null
foreach ($candidate in @((Join-Path (Resolve-DshRemoteHome) '.credentials.yaml'),
        (Join-Path (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) '.dsh') '.credentials.yaml'))) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $credSource = $candidate; break }
}
if (-not $credSource) { throw '找不到 .credentials.yaml（先运行 scripts/setup-pc.ps1 配置 API Key）。' }
$credTargets = @((Join-Path $gatewayHome '.credentials.yaml'), (Join-Path $mirrorHome '.credentials.yaml'),
    (Join-Path (Join-Path $gatewayHome 'dsh-home') '.credentials.yaml'))
foreach ($target in $credTargets) {
    $dir = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
    Copy-Item -LiteralPath $credSource -Destination $target -Force
}
$credBytes = [System.IO.File]::ReadAllBytes((Join-Path $gatewayHome '.credentials.yaml'))
$credHasBom = ($credBytes.Length -ge 3 -and $credBytes[0] -eq 0xEF)
Write-Kv -Key '凭据来源' -Value $credSource
Write-Kv -Key '凭据隔离' -Value "$($credTargets.Count) 份（网关 home / 镜像 home / 网关自有 dsh-home；均无 BOM=$(-not $credHasBom)）"

# 隔离工作区：git init + 一次提交 + 一处未提交改动（让 /workspaces/changes 有真实内容）
$gitExe = (Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
if ($gitExe) {
    $gitExe = $gitExe.Source
    if (-not (Test-Path -LiteralPath (Join-Path $workspace '.git') -PathType Container)) {
        [void](Invoke-NativeCommand -FilePath $gitExe -ArgumentList @('-C', $workspace, 'init') -TimeoutSec 60)
        [void](Invoke-NativeCommand -FilePath $gitExe -ArgumentList @('-C', $workspace, 'config', 'user.email', 'e2e@local') -TimeoutSec 60)
        [void](Invoke-NativeCommand -FilePath $gitExe -ArgumentList @('-C', $workspace, 'config', 'user.name', 'e2e') -TimeoutSec 60)
    }
    Write-TextFileUtf8NoBom -Path (Join-Path $workspace 'README.md') -Content "# e2e 隔离工作区`n`n本目录由 scripts/e2e-crossnetwork.ps1 创建，用于跨网络验证。`n"
    [void](Invoke-NativeCommand -FilePath $gitExe -ArgumentList @('-C', $workspace, 'add', '-A') -TimeoutSec 60)
    [void](Invoke-NativeCommand -FilePath $gitExe -ArgumentList @('-C', $workspace, 'commit', '-m', 'e2e: 初始提交') -TimeoutSec 60)
    Write-TextFileUtf8NoBom -Path (Join-Path $workspace 'changed.txt') -Content "未提交的改动（用于 /api/v2/workspaces/changes 的真实输出）`n"
    Write-Kv -Key '隔离工作区' -Value "$workspace（git 仓库，含 1 处未跟踪改动）"
}

# 镜像 home：复制一份真实桌面会话（只读镜像 + 「不可续聊」断言用）
$mirrorSlugDir = $null
$desktopSessions = Join-Path (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) '.dsh') 'sessions'
if (Test-Path -LiteralPath $desktopSessions -PathType Container) {
    $candidates = New-Object System.Collections.ArrayList
    foreach ($sessionFile in @(Get-ChildItem -LiteralPath $desktopSessions -Recurse -Filter 'session.v4.jsonl.zstd' -File -ErrorAction SilentlyContinue)) {
        if ($sessionFile.Length -gt 400KB) { continue }
        [void]$candidates.Add($sessionFile)
    }
    $picked = $null
    if ($MirrorSessionId) {
        $picked = @($candidates | Where-Object { $_.Directory.Name -eq $MirrorSessionId } | Select-Object -First 1)
        if ($picked.Count -eq 0) { $picked = $null } else { $picked = $picked[0] }
    }
    if (-not $picked -and $candidates.Count -gt 0) { $picked = @($candidates | Sort-Object Length | Select-Object -First 1)[0] }
    if ($picked) {
        # $picked 是 <slug>\<session-id>\session.v4.jsonl.zstd 这个文件
        $sessionDir = $picked.Directory                 # …\<session-id>
        $slug = $sessionDir.Parent.Name                 # …\<slug>（工作区 slug）
        $script:MirrorSessionIdFound = $sessionDir.Name
        $mirrorSlugDir = Join-Path (Join-Path $mirrorHome 'sessions') $slug
        $destDir = Join-Path $mirrorSlugDir $sessionDir.Name
        if (-not (Test-Path -LiteralPath $destDir -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $destDir) }
        Copy-Item -Path (Join-Path $sessionDir.FullName '*') -Destination $destDir -Recurse -Force
        Write-Kv -Key '镜像会话' -Value "$($script:MirrorSessionIdFound)（源 $($sessionDir.FullName)，$([Math]::Round($picked.Length / 1KB, 1)) KiB）"
        Write-Kv -Key '镜像 home' -Value "$mirrorHome（只读镜像源；网关不得写入）"
    } else {
        Write-Warn '未在 ~/.dsh/sessions 下找到 ≤400KiB 的会话用于镜像；镜像相关断言将记为 BLOCKED。'
    }
} else {
    Write-Warn "找不到真实桌面会话目录：$desktopSessions（镜像相关断言将记为 BLOCKED）"
}

# ── 1. 启动中继 ──────────────────────────────────────────────────────────────
Write-Section '1/9 启动中继（scripts/start-relay.ps1 -Home <relay>）'
$relayBaseUrl = "http://127.0.0.1:$RelayPort"
$relayAvailable = $false
if (-not $relayReady) {
    Write-Fail "中继源码尚未实现：$relayEntry"
    Write-Info '按契约 §2/§3 由 task-1 交付；实现就绪前判据 B/D/E 记为 BLOCKED。'
    Add-Criterion -Name '中继可用' -Status 'BLOCKED' -Evidence "tools/dsh-relay/relay.mjs 不存在"
} else {
    $setupRun = Invoke-ChildScript -ScriptPath (Join-Path $PSScriptRoot 'setup-relay.ps1') -Arguments @(
        '-Home', $relayHome, '-Port', [string]$RelayPort, '-TlsMode', 'off', '-Force', '-PublicUrl', "ws://127.0.0.1:$RelayPort") -TimeoutSec 180 -MaxLines 14
    if ($setupRun.ExitCode -ne 0) {
        Add-Criterion -Name '中继可用' -Status 'FAIL' -Evidence "setup-relay.ps1 退出码 $($setupRun.ExitCode)"
    } else {
        $startRun = Invoke-ChildScript -ScriptPath $startRelay -Arguments @('-Home', $relayHome, '-WaitSeconds', '30') -TimeoutSec 120 -MaxLines 16
        if ($startRun.ExitCode -ne 0) {
            Add-Criterion -Name '中继可用' -Status 'FAIL' -Evidence "start-relay.ps1 退出码 $($startRun.ExitCode)"
        } else {
            $relayHealth = Get-RelayHealth -BaseUrl $relayBaseUrl -TimeoutSec 5
            if ($relayHealth) {
                $script:RelayOwned = $true
                $relayAvailable = $true
                Add-Criterion -Name '中继可用' -Status 'PASS' -Evidence ("GET " + $relayBaseUrl + "/health → " + (ConvertTo-JsonText -InputObject $relayHealth -Compress))
            } else {
                Add-Criterion -Name '中继可用' -Status 'FAIL' -Evidence "start-relay 成功但 /health 无响应"
            }
        }
    }
}

# ── 2. 写隔离网关配置并启动网关 ─────────────────────────────────────────────
Write-Section '2/9 启动网关（隔离 DSH_HOME，只绑 127.0.0.1）'
$gatewayConfigPath = Join-Path $gatewayHome 'config.json'
$relaySecret = ''
if ($relayAvailable) {
    $relayCfg = Get-ConfigDefaults -Home $relayHome
    $relaySecret = [string](Get-JsonProp -Object $relayCfg -Name 'relaySecret' -Default '')
}
$launcherInfo = $null
try { $launcherInfo = Find-DshLauncher -Launcher $Launcher } catch { $launcherInfo = $null }
$dshNode = $nodeExe
$dshBinPath = $null
try { $dshBinPath = Find-DshBin } catch { $dshBinPath = $null }

$gatewayConfig = [ordered]@{
    _readme               = @(
        'E2E 隔离配置（由 scripts/e2e-crossnetwork.ps1 生成，每次运行覆盖）。',
        '只看：网关只绑 127.0.0.1；mirror.dshHome 指向隔离镜像目录；网关自有会话在自己的 DSH_HOME。'
    )
    host                  = '127.0.0.1'
    port                  = $Port
    dshHome               = $gatewayHome
    serverName            = "E2E-$($env:COMPUTERNAME)"
    gatewayVersion        = '2.0.0'
    authRequired          = $true
    maxConcurrent         = 2
    maxQueue              = 20
    defaultTimeoutSec     = 3600
    maxTimeoutSec         = 86400
    workspaceAllowlist    = @($workspace, $repoRoot)
    defaultWorkspace      = $workspace
    dsh                   = [ordered]@{
        launcher          = $(if ($launcherInfo) { $launcherInfo.Launcher } else { $null })
        exe               = $(if ($launcherInfo) { $launcherInfo.Exe } else { $null })
        cliJs             = $(if ($launcherInfo) { $launcherInfo.CliJs } else { $null })
        env               = $(if ($launcherInfo -and $launcherInfo.Env) { $launcherInfo.Env } else { @{} })
        node              = $dshNode
        binPath           = $dshBinPath
        profile           = 'headless'
        version           = '0.1.0-rc.7'
        discoverSessionId = $true
        launcherArgs      = @()
    }
    mirror                = [ordered]@{
        enabled                    = $true
        dshHome                    = $mirrorHome
        onlyAllowlistedWorkspaces  = $false
    }
    relay                 = [ordered]@{
        enabled          = [bool]$relayAvailable
        url              = "ws://127.0.0.1:$RelayPort"
        homeName         = "e2e-$($env:COMPUTERNAME)"
        homeToken        = $null
        relaySecret      = $relaySecret
        relayName        = $null
        gatewayVersion   = '2.0.0'
        reconnect        = [ordered]@{ minMs = 1000; maxMs = 30000; factor = 2; jitter = 0.2 }
        requestTimeoutMs = 60000
        maxStreams       = 64
    }
    tasks                 = [ordered]@{ dirName = 'tasks' }
    log                   = [ordered]@{ dirName = 'logs'; filePrefix = 'gateway'; toConsole = $true }
    limits                = [ordered]@{
        maxBodyBytes       = 1048576
        maxOutputBytes     = 1048576
        pairClaimPerMinute = 20
        authFailPerMinute  = 30
        pairCodeTtlMs      = 300000
        maxSseClients      = 16
        requestTimeoutMs   = 30000
        headersTimeoutMs   = 20000
        outputFlushMs      = 200
        outputFlushBytes   = 8192
    }
    events                = [ordered]@{ bufferSize = 2000; heartbeatMs = 15000 }
}
Write-JsonFileNoBom -Path $gatewayConfigPath -Object $gatewayConfig
Write-Kv -Key '网关配置' -Value $gatewayConfigPath
Write-Kv -Key 'DSH 启动器' -Value $(if ($launcherInfo) { "$($launcherInfo.Mode) → $($launcherInfo.Launcher)" } else { '(未探测到)' })
Write-Kv -Key '镜像会话源' -Value "$mirrorHome（mirror.dshHome）"
Write-Kv -Key '中继配置' -Value ("enabled=$([bool]$relayAvailable) url=ws://127.0.0.1:$RelayPort")

$isoDshHome = Join-Path $gatewayHome 'dsh-home'
if (-not (Test-Path -LiteralPath $isoDshHome -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $isoDshHome) }

$gatewayBaseUrl = "http://127.0.0.1:$Port"
$dshHomeEnvArg = "DSH_HOME=$isoDshHome"
$startGwRun = Invoke-ChildScript -ScriptPath $startGateway -Arguments @(
    '-Home', $gatewayHome, '-Port', [string]$Port, '-Env', $dshHomeEnvArg) -TimeoutSec 180 -MaxLines 16

$gatewayHealth = $null
if ($startGwRun.ExitCode -eq 0) {
    $script:GatewayOwned = $true
    $gatewayHealth = Get-GatewayHealth -BaseUrl $gatewayBaseUrl -TimeoutSec 6
}
if ($gatewayHealth) {
    Add-Criterion -Name '网关可用（隔离 DSH_HOME）' -Status 'PASS' -Evidence (
        "GET /api/v1/health → serverName=$([string](Get-JsonProp -Object $gatewayHealth -Name 'serverName')) " +
        "gatewayVersion=$([string](Get-JsonProp -Object $gatewayHealth -Name 'gatewayVersion')) " +
        "dshVersion=$([string](Get-JsonProp -Object $gatewayHealth -Name 'dshVersion'))")
} else {
    Add-Criterion -Name '网关可用（隔离 DSH_HOME）' -Status 'FAIL' -Evidence "start-gateway.ps1 退出码 $($startGwRun.ExitCode)"
    Write-Host ''
    Write-Fail '网关未能启动：后续判据无法继续。'
    Stop-StartedProcesses
    if ($script:RelayOwned -and -not $KeepProcesses) { [void](Invoke-DshScript -ScriptPath $stopRelay -Arguments @('-Home', $relayHome) -TimeoutSec 60) }
    try { Stop-Transcript | Out-Null } catch { }
    exit 1
}

# 探测网关 v2 是否就绪
$v2Status = $null
try { $v2Status = Get-GatewayRelayStatus -BaseUrl $gatewayBaseUrl -TimeoutSec 6 } catch { $v2Status = $null }
$v2Ready = ($null -ne $v2Status)
if ($v2Ready) {
    Add-Criterion -Name '网关 v2 路由就绪' -Status 'PASS' -Evidence ("GET /api/v2/relay/status → " + (ConvertTo-JsonText -InputObject $v2Status -Compress))
} else {
    $probe = Invoke-DshV2Api -BaseUrl $gatewayBaseUrl -Path '/api/v2/relay/status' -TimeoutSec 6
    Add-Criterion -Name '网关 v2 路由就绪' -Status 'BLOCKED' -Evidence ("GET /api/v2/relay/status → HTTP $($probe.Status)（网关 v2 路由尚未实现；判据 B/D/E 记 BLOCKED）")
}

# ── 3. 判据 A ────────────────────────────────────────────────────────────────
Write-Section '3/9 判据 A：手机无法直连 PC（网关只绑 127.0.0.1）'
if (-not (& $runWanted 'A')) {
    Add-Criterion -Name 'A. 手机无法直连 PC' -Status 'SKIP' -Evidence '未在本轮 -Criteria 中'
} else {
    $lanIps = @(Get-LanIPv4Addresses)
    $aProblems = New-Object System.Collections.ArrayList
    $aEvidence = New-Object System.Collections.ArrayList

    # 正向对照：127.0.0.1 必须可达
    $loopHealth = Invoke-DshApi -Url "$gatewayBaseUrl/api/v1/health" -Method GET -TimeoutSec 4
    if ($loopHealth.Ok) {
        [void]$aEvidence.Add("正向对照 127.0.0.1:$Port → HTTP $($loopHealth.Status)（网关确实在跑）")
        Write-CommandEvidence -CommandLine "Invoke-WebRequest http://127.0.0.1:$Port/api/v1/health" -Output "HTTP $($loopHealth.Status) $($loopHealth.Text)" -MaxLines 3 | Out-Null
    } else {
        [void]$aProblems.Add("正向对照失败：127.0.0.1:$Port 不可达（HTTP $($loopHealth.Status)）")
    }

    $targets = New-Object System.Collections.ArrayList
    foreach ($ip in $lanIps) { [void]$targets.Add($ip) }
    [void]$targets.Add('10.0.2.2')            # Android 模拟器里宿主机的固定别名
    [void]$targets.Add([System.Net.Dns]::GetHostName())
    foreach ($target in @($targets | Select-Object -Unique)) {
        $tcp = Test-TcpConnect -TargetHost $target -Port $Port -TimeoutMs 2500
        $httpText = ''
        $httpOk = $false
        try {
            $r = Invoke-DshApi -Url "http://$target`:$Port/api/v1/health" -Method GET -TimeoutSec 3
            $httpOk = $r.Ok
            $httpText = "HTTP $($r.Status)"
        } catch {
            $httpText = '连接失败（' + ($_.Exception.Message -split "`n")[0] + '）'
        }
        $expectedFail = (-not $tcp.Connected) -and (-not $httpOk)
        if (-not $expectedFail) { [void]$aProblems.Add("$target`:$Port 竟然可达（TCP=$($tcp.Connected) HTTP=$httpText）") }
        Write-CommandEvidence -CommandLine ("Test-NetConnection -ComputerName $target -Port $Port   /   Invoke-WebRequest http://$target`:$Port/api/v1/health") `
            -Output ("TCP connected=$($tcp.Connected) elapsed=$($tcp.ElapsedMs)ms error=$($tcp.Error)`nHTTP $httpText") -MaxLines 4 | Out-Null
        [void]$aEvidence.Add("$target`:$Port TCP=$($tcp.Connected)/HTTP=$httpText")
    }
    if ($lanIps.Count -eq 0) { [void]$aEvidence.Add('（本机未探测到非回环 IPv4，仅测试 10.0.2.2 与主机名）') }
    if ($aProblems.Count -eq 0) {
        Add-Criterion -Name 'A. 手机无法直连 PC' -Status 'PASS' -Evidence (($aEvidence -join '；'))
    } else {
        Add-Criterion -Name 'A. 手机无法直连 PC' -Status 'FAIL' -Evidence (($aProblems -join '；'))
    }
}

# ── 4. 判据 C ────────────────────────────────────────────────────────────────
Write-Section '4/9 判据 C：PC 只出站（netstat 监听地址断言）'
if (-not (& $runWanted 'C')) {
    Add-Criterion -Name 'C. PC 只出站（netstat）' -Status 'SKIP' -Evidence '未在本轮 -Criteria 中'
} else {
    $snap = Get-NetstatTcpSnapshot
    $gwLines = @($snap.Entries | Where-Object { $_.LocalPort -eq $Port -and $_.State -eq 'LISTENING' })
    $relayLines = @($snap.Entries | Where-Object { $_.LocalPort -eq $RelayPort -and $_.State -eq 'LISTENING' })
    $cProblems = New-Object System.Collections.ArrayList

    Write-CommandEvidence -CommandLine "$($snap.CommandLine) | findstr :$Port" -Output (($gwLines | ForEach-Object { $_.Line }) -join "`n") -MaxLines 6 | Out-Null
    if ($gwLines.Count -eq 0) {
        [void]$cProblems.Add("网关端口 $Port 没有任何 LISTENING")
    } else {
        $bad = @($gwLines | Where-Object { $_.LocalAddress -ne '127.0.0.1' })
        if ($bad.Count -gt 0) {
            [void]$cProblems.Add("网关监听在非回环地址：" + (($bad | ForEach-Object { $_.Line }) -join ' / '))
        }
    }
    if ($relayAvailable) {
        Write-CommandEvidence -CommandLine "$($snap.CommandLine) | findstr :$RelayPort" -Output (($relayLines | ForEach-Object { $_.Line }) -join "`n") -MaxLines 6 | Out-Null
        if ($relayLines.Count -eq 0) {
            [void]$cProblems.Add("中继端口 $RelayPort 没有任何 LISTENING")
        } else {
            $wildcard = @($relayLines | Where-Object { $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '[::]' })
            if ($wildcard.Count -eq 0) { [void]$cProblems.Add("中继未监听通配地址（契约 §6 判据 C 期望 0.0.0.0）") }
        }
    } else {
        [void]$cProblems.Add('中继未运行（判据 C 的中继侧断言无法完成）')
    }
    $gwDesc = ($gwLines | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid=$($_.Pid)" }) -join ' , '
    $relayDesc = ($relayLines | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid=$($_.Pid)" }) -join ' , '
    if ($cProblems.Count -eq 0) {
        Add-Criterion -Name 'C. PC 只出站（netstat）' -Status 'PASS' -Evidence ("网关 LISTEN: $gwDesc；中继 LISTEN: $relayDesc；netstat -ano -p tcp 实测")
    } else {
        Add-Criterion -Name 'C. PC 只出站（netstat）' -Status 'FAIL' -Evidence (($cProblems -join '；') + "（网关:$gwDesc 中继:$relayDesc）")
    }
}

# ── 5. 判据 B ────────────────────────────────────────────────────────────────
Write-Section '5/9 判据 B：手机只经中继可达（会话镜像 / 续聊 / 工作区）'
$phoneToken = $null
if (-not (& $runWanted 'B')) {
    Add-Criterion -Name 'B. 手机只经中继可达' -Status 'SKIP' -Evidence '未在本轮 -Criteria 中'
} elseif (-not $relayAvailable -or -not $v2Ready) {
    $reason = @()
    if (-not $relayAvailable) { $reason += '中继未运行/未实现' }
    if (-not $v2Ready) { $reason += '网关 v2 路由未实现' }
    Add-Criterion -Name 'B. 手机只经中继可达' -Status 'BLOCKED' -Evidence ($reason -join '；')
} else {
    # 5.1 让网关连上中继
    $connectRun = $null
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        $connectRun = Invoke-DshV2Api -BaseUrl $gatewayBaseUrl -Path '/api/v2/relay/connect' -Method POST -TimeoutSec 20
        if ($connectRun.Ok) { break }
        Start-Sleep -Seconds 2
    }
    Write-CommandEvidence -CommandLine "POST http://127.0.0.1:$Port/api/v2/relay/connect" -Output ("HTTP $($connectRun.Status) $($connectRun.Text)") -MaxLines 4 | Out-Null
    $relayStatus = Get-GatewayRelayStatus -BaseUrl $gatewayBaseUrl -TimeoutSec 8
    if (-not $relayStatus -or (Get-JsonProp -Object $relayStatus -Name 'connected') -ne $true) {
        Add-Criterion -Name 'B. 手机只经中继可达' -Status 'FAIL' -Evidence ("网关未能连上中继：relay/status=" + (ConvertTo-JsonText -InputObject $relayStatus -Compress))
    } else {
        # 5.2 播种一个「手机任务」会话（网关自己的 DSH_HOME，SDK profile 可续聊）
        $pairV1 = $null
        $seedOk = $false
        $seedTurnId = $null
        if (-not $SkipSeed) {
            try {
                # 播种走 v2 的「手机新建任务」入口（契约 §4.2 裁定新增）：
                # 网关自己生成 session-<uuid> 并在**网关自有 DSH_HOME** 用 SDK profile 起会话，
                # 只有这样产生的会话才能被 /turns 真实续聊（桌面端会话走 headless 会报 preset 错误，§7.1）。
                $pairV1 = Invoke-DshPairAndClaim -BaseUrl $gatewayBaseUrl -DeviceName 'e2e-seed'
                $seedPrompt = '请只回答两个字：就绪。不要调用任何工具。'
                $seedBody = ConvertTo-JsonText -InputObject ([ordered]@{ prompt = $seedPrompt; workspace = $workspace }) -Compress
                $seedRun = Invoke-DshV2Api -BaseUrl $gatewayBaseUrl -Path '/api/v2/tasks' -Method POST -Token $pairV1.Token -Body $seedBody -TimeoutSec 60
                Write-CommandEvidence -CommandLine ("POST http://127.0.0.1:$Port/api/v2/tasks  {prompt, workspace}") -Output ("HTTP $($seedRun.Status) $($seedRun.Text)") -MaxLines 4 | Out-Null
                if ($seedRun.Ok) {
                    $script:SeedSessionId = [string](Get-JsonProp -Object $seedRun.Json -Name 'sessionId')
                    $seedTurnId = [string](Get-JsonProp -Object $seedRun.Json -Name 'turnId')
                    $seedSource = [string](Get-JsonProp -Object $seedRun.Json -Name 'source')
                    Write-Info "已创建手机任务 sessionId=$($script:SeedSessionId)（等待首轮结束，最多 $SeedTimeoutSec 秒）…"
                    $deadline = (Get-Date).AddSeconds($SeedTimeoutSec)
                    $lastLive = $null
                    while ((Get-Date) -lt $deadline) {
                        Start-Sleep -Seconds 2
                        $one = Invoke-DshV2Api -BaseUrl $gatewayBaseUrl -Path ("/api/v2/sessions/" + $script:SeedSessionId) -Token $pairV1.Token -TimeoutSec 20
                        if ($one.Ok) {
                            $lastLive = Get-JsonProp -Object $one.Json -Name 'live'
                            if ($lastLive -ne $true) { break }
                        }
                    }
                    $seedTr = Invoke-DshV2Api -BaseUrl $gatewayBaseUrl -Path ("/api/v2/sessions/" + $script:SeedSessionId + "/transcript?tail=3") -Token $pairV1.Token -TimeoutSec 30
                    $seedMsgs = 0
                    try { $seedMsgs = @((($seedTr.Text | ConvertFrom-Json).messages)).Count } catch { $seedMsgs = 0 }
                    $seedOk = ($script:SeedSessionId -and $seedRun.Ok -and $seedMsgs -gt 0)
                    Write-CommandEvidence -CommandLine ("GET /api/v2/sessions/" + $script:SeedSessionId + "（等待 live=false）→ GET …/transcript?tail=3") `
                        -Output ("source=$seedSource turnId=$seedTurnId live=$lastLive transcript 消息数=$seedMsgs writable=" + [string](Get-JsonProp -Object $one.Json -Name 'writable')) -MaxLines 4 | Out-Null
                }
            } catch {
                Write-Warn ("播种手机任务失败：" + $_.Exception.Message)
            }
        }
        if (-not $seedOk) {
            Add-Criterion -Name 'B. 手机只经中继可达' -Status 'FAIL' -Evidence (
                "无法通过 POST /api/v2/tasks 在网关自有 DSH_HOME 里创建可续聊的手机任务（契约 §7.2 SDK profile）：" +
                $(if ($SkipSeed) { '已指定 -SkipSeed' } else { "sessionId=$($script:SeedSessionId)" }))
        } else {
            Add-Criterion -Name 'B0. 播种「手机任务」会话' -Status 'PASS' -Evidence "sessionId=$($script:SeedSessionId)（网关自有 DSH_HOME，SDK profile 可续聊）"

            # 5.3 配对码 → 手机 claim（经中继 HTTP）
            $pairOpen = Invoke-DshV2Api -BaseUrl $gatewayBaseUrl -Path '/api/v2/pair/open' -Method POST -TimeoutSec 15
            $code = ''
            if ($pairOpen.Ok) { $code = [string](Get-JsonProp -Object $pairOpen.Json -Name 'code') }
            Write-CommandEvidence -CommandLine "POST http://127.0.0.1:$Port/api/v2/pair/open" -Output ("HTTP $($pairOpen.Status) $($pairOpen.Text)") -MaxLines 4 | Out-Null
            $claimEvents = Join-Path $phoneDir 'claim-events.jsonl'
            if (Test-Path -LiteralPath $claimEvents -PathType Leaf) { Remove-Item -LiteralPath $claimEvents -Force }
            if ($code -notmatch '^\d{6}$') {
                Add-Criterion -Name 'B. 手机只经中继可达' -Status 'FAIL' -Evidence "配对码生成失败：HTTP $($pairOpen.Status) $($pairOpen.Text)"
            } else {
                $claimRun = Invoke-NativeCommand -FilePath $nodeExe -ArgumentList @(
                    $phoneSim, 'claim', '--relay', $relayBaseUrl, '--code', $code,
                    '--device-name', 'phone-sim-e2e', '--token-file', $script:TokenFile, '--events', $claimEvents) -TimeoutSec 120
                Write-CommandEvidence -CommandLine ("node scripts/tests/phone-sim.mjs claim --relay $relayBaseUrl --code $code --token-file <phone>\token.json") `
                    -Output $claimRun.StdOut -MaxLines 6 | Out-Null
                if ($claimRun.ExitCode -ne 0) {
                    Add-Criterion -Name 'B. 手机只经中继可达' -Status 'FAIL' -Evidence "phone-sim claim 退出码 $($claimRun.ExitCode)"
                } else {
                    $phoneToken = Read-JsonFile -Path $script:TokenFile
                    # 中继返回的 tunnelUrl 用 relayName/publicUrl 拼装；本机等价拓扑里 relayName
                    # 可能是不可解析的名字（如 relay.local），此时显式覆盖为回环地址并给出警告。
                    $claimedTunnel = [string](Get-JsonProp -Object $phoneToken -Name 'tunnelUrl' -Default '')
                    $loopbackTunnel = "ws://127.0.0.1:$RelayPort/api/v2/tunnel/device"
                    $tunnelResolvable = $false
                    if ($claimedTunnel) {
                        $tunnelHostName = ''
                        try { $tunnelHostName = ([Uri]$claimedTunnel).Host } catch { $tunnelHostName = '' }
                        if ($tunnelHostName -eq '127.0.0.1' -or $tunnelHostName -ieq 'localhost') { $tunnelResolvable = $true }
                        elseif ($tunnelHostName) {
                            try { [void][System.Net.Dns]::GetHostAddresses($tunnelHostName); $tunnelResolvable = $true } catch { $tunnelResolvable = $false }
                        }
                    }
                    if (-not $tunnelResolvable) {
                        Write-Warn ("claim 返回的隧道地址不可用：'" + $claimedTunnel + "'（主机不可解析）→ 本机等价拓扑改用 " + $loopbackTunnel)
                        $tunnelArg = @('--tunnel-url', $loopbackTunnel)
                    } else {
                        Write-Info "claim 返回的隧道地址：$claimedTunnel"
                    }
                    $probeEvents = Join-Path $phoneDir 'probe-events.jsonl'
                    if (Test-Path -LiteralPath $probeEvents -PathType Leaf) { Remove-Item -LiteralPath $probeEvents -Force }
                    $probeArgs = @($phoneSim, 'probe', '--relay', $relayBaseUrl, '--token-file', $script:TokenFile,
                        '--session', $script:SeedSessionId, '--turn-timeout', [string]$TurnTimeoutSec, '--events', $probeEvents) + $tunnelArg
                    $probeRun = Invoke-NativeCommand -FilePath $nodeExe -ArgumentList $probeArgs -TimeoutSec ($TurnTimeoutSec + 240)
                    Write-CommandEvidence -CommandLine ("node scripts/tests/phone-sim.mjs probe --session $($script:SeedSessionId)（经中继隧道完成列表/记录/工作区/续聊）") `
                        -Output $probeRun.StdOut -MaxLines 22 | Out-Null
                    $probeItems = @(Read-JsonLinesFile -Path $probeEvents | Where-Object { $_.kind -eq 'assert' })
                    $probeFailed = @($probeItems | Where-Object { $_.ok -ne $true })
                    $assertSummary = (@($probeItems | ForEach-Object { "$($_.name)=$(if ($_.ok) { 'ok' } else { 'FAIL' })" }) -join ', ')
                    if ($probeRun.ExitCode -eq 0 -and $probeFailed.Count -eq 0) {
                        Add-Criterion -Name 'B. 手机只经中继可达' -Status 'PASS' -Evidence ("经隧道断言 $($probeItems.Count) 项全通过：$assertSummary")
                    } else {
                        Add-Criterion -Name 'B. 手机只经中继可达' -Status 'FAIL' -Evidence (
                            "退出码 $($probeRun.ExitCode)；失败项：" + (($probeFailed | ForEach-Object { "$($_.name) —— $($_.message)" }) -join '；'))
                    }

                    # 5.4 镜像的桌面会话必须被拒绝续聊（契约 §7.3）
                    if ($script:MirrorSessionIdFound) {
                        $mirrorEvents = Join-Path $phoneDir 'mirror-events.jsonl'
                        if (Test-Path -LiteralPath $mirrorEvents -PathType Leaf) { Remove-Item -LiteralPath $mirrorEvents -Force }
                        $mirrorArgs = @($phoneSim, 'http', '--relay', $relayBaseUrl, '--token-file', $script:TokenFile,
                            '--method', 'POST', '--path', "/api/v2/sessions/$($script:MirrorSessionIdFound)/turns",
                            '--body', '{"prompt":"e2e：桌面会话不应可续聊"}', '--events', $mirrorEvents) + $tunnelArg
                        $mirrorRun = Invoke-NativeCommand -FilePath $nodeExe -ArgumentList $mirrorArgs -TimeoutSec 90
                        $mirrorText = ($mirrorRun.StdOut -join "`n")
                        Write-CommandEvidence -CommandLine ("node scripts/tests/phone-sim.mjs http --method POST --path /api/v2/sessions/$($script:MirrorSessionIdFound)/turns") `
                            -Output $mirrorText -MaxLines 6 | Out-Null
                        $is409 = ($mirrorText -match 'HTTP 409')
                        $isBusy = ($mirrorText -match 'session_busy')
                        Add-Criterion -Name 'B1. 镜像桌面会话拒绝续聊（§7.3）' -Status $(if ($is409 -and $isBusy) { 'PASS' } else { 'FAIL' }) `
                            -Evidence $(if ($is409 -and $isBusy) { "网关返回 409 session_busy（该会话正由电脑端驱动）：$($mirrorText.Trim())" } else { "期望 409 session_busy，实际：$($mirrorText.Trim())" })
                    } else {
                        Add-Criterion -Name 'B1. 镜像桌面会话拒绝续聊（§7.3）' -Status 'BLOCKED' -Evidence '未找到可复制的桌面会话（~/.dsh/sessions 为空或会话过大）'
                    }
                }
            }
        }
    }
}

# ── 6. 判据 D ────────────────────────────────────────────────────────────────
Write-Section '6/9 判据 D：PC 掉线可见（home_offline → 恢复）'
if (-not (& $runWanted 'D')) {
    Add-Criterion -Name 'D. PC 掉线可见' -Status 'SKIP' -Evidence '未在本轮 -Criteria 中'
} elseif (-not $relayAvailable -or -not $v2Ready) {
    Add-Criterion -Name 'D. PC 掉线可见' -Status 'BLOCKED' -Evidence '需要中继 + 网关 v2 路由'
} elseif (-not (Test-Path -LiteralPath $script:TokenFile -PathType Leaf)) {
    Add-Criterion -Name 'D. PC 掉线可见' -Status 'BLOCKED' -Evidence '没有设备令牌（判据 B 未完成 claim）'
} else {
    $watchEvents = Join-Path $phoneDir 'watch-events.jsonl'
    if (Test-Path -LiteralPath $watchEvents -PathType Leaf) { Remove-Item -LiteralPath $watchEvents -Force }
    foreach ($staleLog in @((Join-Path $phoneDir 'watch.log'), (Join-Path $phoneDir 'watch.err.log'))) {
        if (Test-Path -LiteralPath $staleLog -PathType Leaf) { Remove-Item -LiteralPath $staleLog -Force }
    }
    $watchArgs = @($phoneSim, 'watch', '--relay', $relayBaseUrl, '--token-file', $script:TokenFile,
        '--seconds', '600', '--poll-ms', '2000', '--events', $watchEvents) + $tunnelArg
    $script:StartedWatch = Start-DetachedCommand -FilePath $nodeExe -ArgumentList $watchArgs `
        -WorkingDirectory $repoRoot -StdOutLog (Join-Path $phoneDir 'watch.log') -StdErrLog (Join-Path $phoneDir 'watch.err.log') -WaitSeconds 20
    Write-Info "手机模拟器 watch 已启动（PID $($script:StartedWatch.Pid)），事件流：$watchEvents"
    $firstOk = Wait-JsonLineMatch -Path $watchEvents -Kind 'http' -Pattern '"ok":true' -TimeoutSec 40
    if (-not $firstOk) {
        Add-Criterion -Name 'D. PC 掉线可见' -Status 'FAIL' -Evidence 'watch 启动后 40s 内没有任何成功请求（隧道/鉴权有问题）'
    } else {
        Write-CommandEvidence -CommandLine "node scripts/tests/phone-sim.mjs watch --seconds 600（后台）" -Output ("首个成功请求：" + $firstOk.message) -MaxLines 2 | Out-Null
        $skipD = @(Read-JsonLinesFile -Path $watchEvents).Count

        # 停网关
        $stopGwRun = Invoke-ChildScript -ScriptPath $stopGateway -Arguments @('-Home', $gatewayHome, '-WaitSeconds', '20') -TimeoutSec 120 -MaxLines 10
        $offlineNotice = Wait-JsonLineMatch -Path $watchEvents -Kind 'notice' -Name 'home_offline' -Skip $skipD -TimeoutSec 45
        $offlineHttp = Wait-JsonLineMatch -Path $watchEvents -Kind 'http' -Pattern '"status":503' -Skip $skipD -TimeoutSec 45
        $dEvidence = New-Object System.Collections.ArrayList
        if ($offlineNotice) { [void]$dEvidence.Add('手机侧收到 notice{home_offline}：' + $offlineNotice.message) }
        if ($offlineHttp) { [void]$dEvidence.Add('掉线期间请求 → ' + $offlineHttp.message) }

        # 重启网关
        $skipD2 = @(Read-JsonLinesFile -Path $watchEvents).Count
        $restartRun = Invoke-ChildScript -ScriptPath $startGateway -Arguments @(
            '-Home', $gatewayHome, '-Port', [string]$Port, '-Env', $dshHomeEnvArg) -TimeoutSec 180 -MaxLines 8
        $onlineNotice = Wait-JsonLineMatch -Path $watchEvents -Kind 'notice' -Name 'home_online' -Skip $skipD2 -TimeoutSec 60
        $recovered = Wait-JsonLineMatch -Path $watchEvents -Kind 'http' -Pattern '"ok":true' -Skip $skipD2 -TimeoutSec 60
        if ($onlineNotice) { [void]$dEvidence.Add('重启后收到 notice{home_online}：' + $onlineNotice.message) }
        if ($recovered) { [void]$dEvidence.Add('恢复后请求 → ' + $recovered.message) }

        $dProblems = New-Object System.Collections.ArrayList
        if (-not $offlineNotice) { [void]$dProblems.Add('未收到 notice{home_offline}') }
        if (-not $onlineNotice) { [void]$dProblems.Add('重启后未收到 notice{home_online}') }
        if (-not $recovered) { [void]$dProblems.Add('重启后手机侧请求未恢复成功') }
        if ($dProblems.Count -eq 0) {
            Add-Criterion -Name 'D. PC 掉线可见' -Status 'PASS' -Evidence ($dEvidence -join '；')
        } else {
            Add-Criterion -Name 'D. PC 掉线可见' -Status 'FAIL' -Evidence (($dProblems -join '；') + '（已观测：' + ($dEvidence -join '；') + '）')
        }
    }
}

# ── 7. 判据 E ────────────────────────────────────────────────────────────────
Write-Section '7/9 判据 E：中继重启自愈（网关/手机自动重连）'
if (-not (& $runWanted 'E')) {
    Add-Criterion -Name 'E. 中继重启自愈' -Status 'SKIP' -Evidence '未在本轮 -Criteria 中'
} elseif (-not $relayAvailable -or -not $v2Ready) {
    Add-Criterion -Name 'E. 中继重启自愈' -Status 'BLOCKED' -Evidence '需要中继 + 网关 v2 路由'
} elseif (-not $script:StartedWatch) {
    Add-Criterion -Name 'E. 中继重启自愈' -Status 'BLOCKED' -Evidence '判据 D 的 watch 进程不在运行（E 需要它观测手机侧重连）'
} else {
    $watchEvents = Join-Path $phoneDir 'watch-events.jsonl'
    $statusBefore = Get-GatewayRelayStatus -BaseUrl $gatewayBaseUrl -TimeoutSec 8
    $reconnectsBefore = [int](Get-JsonProp -Object $statusBefore -Name 'reconnects' -Default 0)
    $skipE = @(Read-JsonLinesFile -Path $watchEvents).Count

    $stopRelayRun = Invoke-ChildScript -ScriptPath $stopRelay -Arguments @('-Home', $relayHome, '-WaitSeconds', '20') -TimeoutSec 120 -MaxLines 8
    if (Get-RelayHealth -BaseUrl $relayBaseUrl -TimeoutSec 3) {
        Add-Criterion -Name 'E. 中继重启自愈' -Status 'FAIL' -Evidence 'stop-relay 后 /health 仍有响应'
    } else {
        $startRelayRun = Invoke-ChildScript -ScriptPath $startRelay -Arguments @('-Home', $relayHome, '-WaitSeconds', '30') -TimeoutSec 120 -MaxLines 8
        $relayBack = Wait-RelayHealth -BaseUrl $relayBaseUrl -TimeoutSec 30
        # 网关自动重连（指数退避 1s→30s）
        $gwReconnected = $false
        $statusAfter = $null
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline) {
            $statusAfter = Get-GatewayRelayStatus -BaseUrl $gatewayBaseUrl -TimeoutSec 8
            if ($statusAfter -and (Get-JsonProp -Object $statusAfter -Name 'connected') -eq $true) { $gwReconnected = $true; break }
            Start-Sleep -Seconds 3
        }
        $reconnectsAfter = [int](Get-JsonProp -Object $statusAfter -Name 'reconnects' -Default 0)
        # 手机侧自动重连 + 请求恢复
        $phoneReconnect = Wait-JsonLineMatch -Path $watchEvents -Kind 'reconnecting' -Skip $skipE -TimeoutSec 60
        $phoneRecovered = Wait-JsonLineMatch -Path $watchEvents -Kind 'http' -Pattern '"ok":true' -Skip $skipE -TimeoutSec 90

        $eEvidence = New-Object System.Collections.ArrayList
        [void]$eEvidence.Add("relay/status: connected $([bool](Get-JsonProp -Object $statusBefore -Name 'connected')) → $([bool](Get-JsonProp -Object $statusAfter -Name 'connected'))；reconnects $reconnectsBefore → $reconnectsAfter")
        if ($phoneReconnect) { [void]$eEvidence.Add('手机侧重连事件：' + $phoneReconnect.message) }
        if ($phoneRecovered) { [void]$eEvidence.Add('手机侧请求恢复：' + $phoneRecovered.message) }
        $eProblems = New-Object System.Collections.ArrayList
        if (-not $relayBack) { [void]$eProblems.Add('中继重启后 /health 未恢复') }
        if (-not $gwReconnected) { [void]$eProblems.Add('网关未在 90s 内自动重连') }
        if ($reconnectsAfter -le $reconnectsBefore) { [void]$eProblems.Add("网关 reconnects 未增长（$reconnectsBefore → $reconnectsAfter）") }
        if (-not $phoneRecovered) { [void]$eProblems.Add('手机侧请求未恢复（无 ok:true 事件）') }
        if ($eProblems.Count -eq 0) {
            Add-Criterion -Name 'E. 中继重启自愈' -Status 'PASS' -Evidence ($eEvidence -join '；')
        } else {
            Add-Criterion -Name 'E. 中继重启自愈' -Status 'FAIL' -Evidence (($eProblems -join '；') + '（已观测：' + ($eEvidence -join '；') + '）')
        }
    }
}

# ── 附加：relay-dev 的真实链路互操作套件（可选，-WithInterop 开启）───────────────
# 映射（契约 §6 判据 ↔ 脚本，由 relay-dev 整理）：
#   判据 A/C —— 无对应脚本（A 由本脚本的 TCP/HTTP + 局域网 IP 断言覆盖，C 由 netstat 覆盖）；
#              套件内的 gateway 一律 host:127.0.0.1 + port:0，从不对外绑定（支撑事实）
#   判据 B   —— interop-smoke.mjs off|selfsigned（33/33）、off --with-task（37/37，真起 SDK 子进程）
#   判据 B 对抗面 —— interop-boundary.mjs off|selfsigned（51/51）
#   判据 D   —— interop-boundary.mjs 的 §7 段（SIGKILL 强杀网关 → notice{home_offline} + 503）
#   判据 E   —— interop-boundary.mjs 的 §8 段（同端口重启 relay → reconnects 递增、homeId 不变、业务恢复）
#   附加回归 —— hello-handshake(9/9)、heartbeat-liveness(7/7)、audit-path-bypass(9/9)、audit-headers(证据型)
# 这些脚本真起 relay+gateway（relay 端口 19100/19300/19500/19600/19700/19750，gateway 全部 port:0），
# 与本脚本的 18787/19443 无交集；退出码 0=全过、1=有失败、2=参数/环境错误（可直接判 $LASTEXITCODE）。
if ($WithInterop) {
    Write-Section '附加：relay-dev 互操作套件（真起 relay+gateway，端口段独立）'
    $interopDir = Join-Path (Join-Path $PSScriptRoot 'tests') ''
    $interopRunDir = Join-Path $script:AcceptanceDir ("interop-" + $script:Stamp)
    [void](New-Item -ItemType Directory -Force -Path $interopRunDir)
    $interopCases = @(
        @{ Script = 'interop-smoke.mjs';                 Args = @('off'); Expect = '33/33'; Desc = '判据 B：握手/隧道/配对/会话/工作区（明文）' },
        @{ Script = 'interop-boundary.mjs';              Args = @('off'); Expect = '51/51'; Desc = '判据 B 对抗面 + D + E：边界/强杀/中继重启' },
        @{ Script = 'interop-hello-handshake.mjs';       Args = @();      Expect = '9/9';   Desc = 'hello/ready 时序专项' },
        @{ Script = 'interop-heartbeat-liveness.mjs';    Args = @('5');   Expect = '7/7';   Desc = '心跳回归：压缩心跳跑 5 周期，零重连' },
        @{ Script = 'interop-audit-path-bypass.mjs';     Args = @();      Expect = '9/9';   Desc = '路径绕过回归（安全级）' }
    )
    $interopEnv = @{ DSH_INTEROP_RUNDIR = $interopRunDir }
    foreach ($case in $interopCases) {
        $interopScript = Join-Path $interopDir $case.Script
        if (-not (Test-Path -LiteralPath $interopScript -PathType Leaf)) {
            Add-Criterion -Name ("互操作：" + $case.Script) -Status 'BLOCKED' -Evidence ("找不到脚本：$interopScript")
            continue
        }
        Write-Info ("运行：" + $case.Script + " " + ($case.Args -join ' ') + "（期望 " + $case.Expect + "）")
        $runArgs = @($interopScript) + @($case.Args)
        $run = Invoke-NativeCommand -FilePath $nodeExe -ArgumentList $runArgs -WorkingDirectory $repoRoot `
            -TimeoutSec $InteropTimeoutSec -EnvironmentVariables $interopEnv
        $tailLine = @($run.StdOut -split "`r?`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1)
        $summaryLine = @($run.StdOut -split "`r?`n" | Where-Object { $_ -match '总体：|通过 ===' } | Select-Object -Last 1)
        $evidenceText = "$($case.Desc)；退出码 $($run.ExitCode)；$($summaryLine)"
        Write-CommandEvidence -CommandLine ("node scripts/tests/" + $case.Script + " " + ($case.Args -join ' ')) -Output ($run.StdOut) -MaxLines 8 | Out-Null
        if ($run.ExitCode -eq 0) {
            Add-Criterion -Name ("互操作：" + $case.Script) -Status 'PASS' -Evidence $evidenceText
        } else {
            Add-Criterion -Name ("互操作：" + $case.Script) -Status 'FAIL' -Evidence ($evidenceText + "；末行：" + $tailLine)
        }
    }
    Write-Kv -Key '互操作证据目录' -Value $interopRunDir
}

# ── 8. 清理与汇总 ────────────────────────────────────────────────────────────
Write-Section '8/9 清理'
Stop-StartedProcesses
if (-not $KeepProcesses) {
    if ($script:GatewayOwned) {
        $r = Invoke-DshScript -ScriptPath $stopGateway -Arguments @('-Home', $gatewayHome, '-WaitSeconds', '20') -TimeoutSec 120
        Write-Info "已停止被测网关（退出码 $($r.ExitCode)）"
    }
    if ($script:RelayOwned) {
        $r = Invoke-DshScript -ScriptPath $stopRelay -Arguments @('-Home', $relayHome, '-WaitSeconds', '20') -TimeoutSec 120
        Write-Info "已停止被测中继（退出码 $($r.ExitCode)）"
    }
} else {
    Write-Info '已指定 -KeepProcesses：保留网关/中继进程（便于人工查看）。'
}

Write-Section '9/9 汇总'
$passCount = @($script:Results | Where-Object { $_.结果 -eq 'PASS' }).Count
$failCount = @($script:Results | Where-Object { $_.结果 -eq 'FAIL' }).Count
$blockedCount = @($script:Results | Where-Object { $_.结果 -eq 'BLOCKED' }).Count
$skipCount = @($script:Results | Where-Object { $_.结果 -eq 'SKIP' }).Count
$script:Results | Format-Table -AutoSize -Property 判据, 结果, 证据 | Out-String -Width 220 | Write-Host

$report = [ordered]@{
    generatedAt     = (Get-Date).ToString('o')
    repoRoot        = $repoRoot
    e2eHome         = $e2eRoot
    powerShell      = (Test-PowerShellEdition)
    node            = $nodeExe
    gateway         = [ordered]@{ entry = $gatewayEntry; home = $gatewayHome; port = $Port; baseUrl = $gatewayBaseUrl }
    relay           = [ordered]@{ entry = $(if ($relayReady) { $relayEntry } else { $null }); home = $relayHome; port = $RelayPort; baseUrl = $relayBaseUrl }
    workspace       = $workspace
    mirrorHome      = $mirrorHome
    seedSessionId   = $script:SeedSessionId
    mirrorSessionId = $script:MirrorSessionIdFound
    criteria        = $criteriaList
    withInterop     = [bool]$WithInterop
    pass            = $passCount
    fail            = $failCount
    blocked         = $blockedCount
    skip            = $skipCount
    items           = @($script:Results)
    transcript      = $script:TranscriptPath
}
Write-JsonFileNoBom -Path $ReportFile -Object $report
Write-Kv -Key 'transcript' -Value $script:TranscriptPath
Write-Kv -Key 'JSON 报告' -Value $ReportFile

try { Stop-Transcript | Out-Null } catch { }

if ($failCount -gt 0) {
    Write-Fail "跨网络验证未通过：PASS=$passCount FAIL=$failCount BLOCKED=$blockedCount SKIP=$skipCount"
    exit 1
}
if ($blockedCount -gt 0) {
    Write-Warn "跨网络验证未完成：PASS=$passCount BLOCKED=$blockedCount（阻塞项已写明原因，不得当作通过）"
    exit 2
}
if ($skipCount -gt 0) {
    Write-Warn "跨网络验证部分完成：PASS=$passCount SKIP=$skipCount（-Criteria 显式跳过）"
    exit 0
}
Write-Ok "跨网络等价拓扑验证通过（契约 §6 判据 A~E）：PASS=$passCount FAIL=0"
exit 0
