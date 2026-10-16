#Requires -Version 5.1
<#
.SYNOPSIS
  dsh-remote PC 侧一键初始化：探测 DSH 环境 → 建运行目录 → 写凭据（UTF-8 无 BOM）→ 生成 config.json。

.DESCRIPTION
  幂等设计（重复执行不会破坏已有状态）：
    * 已存在的 .credentials.yaml 默认保持不动；只有显式 -Force 或给了新的 -ApiKey/-ApiKeyFile 才覆盖，
      覆盖前自动备份为 .credentials.yaml.bak-<yyyyMMddHHmmss>。
    * config.json 只有「显式传了配置类参数」或 -Force 时才重写，重写前备份为 config.json.bak-<时间戳>。
    * 如果什么都没显式传、文件又已存在，则只做校验并打印现状。

  安全红线：
    * 真实 API Key 只写入运行目录（默认 %USERPROFILE%\.dsh-remote\.credentials.yaml），
      绝不写入仓库内任何文件（config.json / README / 脚本里都只有占位符）。
    * 控制台只打印掩码（sk-a****56），不打印完整 Key。

.PARAMETER DshRemoteHome
  运行目录（别名 -Home）。默认 %USERPROFILE%\.dsh-remote。
  注意：PowerShell 的 $remoteHome 是只读自动变量，脚本内部用 [Alias('Home')] 实现，
  命令行仍按文档写 -Home 即可。

.PARAMETER ApiKey
  直接给出 API Key（会出现在命令历史里，慎用）。更推荐 -ApiKeyFile 或交互式输入。

.PARAMETER ApiKeyFile
  从已有的凭据文件导入 Key（单行 "DEEPSEEK_API_KEY: sk-xxx" 或多行 yaml 均可）。

.EXAMPLE
  pwsh -File scripts/setup-pc.ps1

.EXAMPLE
  # 用测试运行目录，避免污染默认目录
  pwsh -File scripts/setup-pc.ps1 -Home "$env:TEMP\dshr-test" -ApiKeyFile "$env:USERPROFILE\.dsh-remote\.credentials.yaml"

.NOTES
  执行策略：若提示「无法加载文件，因为在此系统上禁止运行脚本」，先临时放行：
      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [string]$DshRoot,
    [string]$Node,
    [string]$DshBin,
    [string]$Launcher,
    [int]$Port = 0,
    [int]$MaxConcurrent = 2,
    [int]$MaxQueue = 100,
    [int]$TimeoutSec = 3600,
    [int]$MaxTimeoutSec = 86400,
    [string]$BindHost = '0.0.0.0',
    [string[]]$Workspace,
    [string]$ServerName,
    [string]$ApiKey,
    [string]$ApiKeyFile,
    [string]$GatewayDir,
    [switch]$Force,
    [switch]$NoInteractive,
    [switch]$SkipProbe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

# ── 小工具 ────────────────────────────────────────────────────────────────────

function Get-CredentialKeyFromFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $text = Read-TextFileUtf8 -Path $Path
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match '^\s*DEEPSEEK_API_KEY\s*:\s*(.+?)\s*$') {
            return $matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

function Test-CredentialFile {
    <#
      校验凭据文件是否符合 headless profile 要求：
        单行、UTF-8 无 BOM、形如 DEEPSEEK_API_KEY: <key>
      返回 [pscustomobject]@{ Ok; Reasons; Key; HasBom; LineCount }
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $reasons = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{ Ok = $false; Reasons = @('文件不存在'); Key = $null; HasBom = $false; LineCount = 0 }
    }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    if ($hasBom) { [void]$reasons.Add('文件带 UTF-8 BOM（必须无 BOM，否则 headless profile 启动失败）') }
    $text = Read-TextFileUtf8 -Path $Path
    $lines = @($text -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    if ($lines.Count -ne 1) { [void]$reasons.Add("应为单行旧格式，实际有 $($lines.Count) 行非空内容") }
    if ($lines.Count -ge 1 -and $lines[0] -notmatch '^\s*DEEPSEEK_API_KEY\s*:\s*\S') {
        [void]$reasons.Add('首行不是 "DEEPSEEK_API_KEY: <key>" 形式')
    }
    $key = Get-CredentialKeyFromFile -Path $Path
    if (-not $key) { [void]$reasons.Add('未解析出 DEEPSEEK_API_KEY 的值') }
    return [pscustomobject]@{
        Ok        = ($reasons.Count -eq 0)
        Reasons   = @($reasons)
        Key       = $key
        HasBom    = $hasBom
        LineCount = $lines.Count
    }
}

function Write-CredentialFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Key
    )
    $content = "DEEPSEEK_API_KEY: $Key"
    Write-TextFileUtf8NoBom -Path $Path -Content $content
    # 写后立刻回读校验（编码、BOM、可解析性）
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw "凭据文件写成了带 BOM 的 UTF-8（$Path），headless profile 会解析失败。"
    }
    $back = Read-TextFileUtf8 -Path $Path
    if ($back -ne $content) {
        throw "凭据文件回读不一致（$Path）：写入与回读内容不同。"
    }
    $parsed = Get-CredentialKeyFromFile -Path $Path
    if ($parsed -ne $Key) {
        throw "凭据文件回读校验失败（$Path）：解析出的 Key 与写入值不一致。"
    }
    return [pscustomobject]@{ Bytes = $bytes.Length; HasBom = $false; RoundTrip = $true }
}

# ── 主流程 ────────────────────────────────────────────────────────────────────

Write-Banner -Title 'dsh-remote PC 侧初始化（setup-pc.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
if (-not $GatewayDir) { $GatewayDir = Get-DefaultGatewayDir }
Write-Section '1/6 环境探测'
Write-Kv -Key '运行目录' -Value $remoteHome
Write-Kv -Key '网关源码' -Value $GatewayDir
Write-Kv -Key 'PowerShell' -Value (Test-PowerShellEdition)

$gatewayEntry = $null
try {
    $gatewayEntry = Assert-GatewaySource -GatewayDir $GatewayDir
    Write-Kv -Key '网关入口' -Value $gatewayEntry
} catch {
    Write-Warn $_.Exception.Message
}

if (-not $SkipProbe) {
    $foundRoot = $null
    try { $foundRoot = Find-DshRoot -DshRoot $DshRoot } catch { $foundRoot = $null }
    if ($foundRoot) {
        Write-Kv -Key 'DSH 安装目录' -Value $foundRoot
    } else {
        Write-Kv -Key 'DSH 安装目录' -Value '(未探测到)'
        Write-Warn '未探测到 DSH 安装目录。若 DSH 装在非默认位置，请用 -DshRoot "<安装目录>\resources" 指定。'
    }

    $foundNode = $null
    try { $foundNode = Find-NodeExe -Node $Node -DshRoot $foundRoot -DshHome $env:DSH_HOME } catch { $foundNode = $null }
    if ($foundNode) {
        $nodeVersion = '（版本探测失败）'
        try {
            $nodeRun = Invoke-NativeCommand -FilePath $foundNode -ArgumentList @('--version') -TimeoutSec 30
            if ($nodeRun.StdOut.Trim()) { $nodeVersion = $nodeRun.StdOut.Trim() }
        } catch { }
        Write-Kv -Key 'node.exe' -Value "$foundNode   [$nodeVersion]"
    } else {
        Write-Kv -Key 'node.exe' -Value '(未找到)'
        Write-Warn '未找到 node.exe：请安装 Node.js 18+，或用 -Node "<node.exe 绝对路径>" 指定。'
    }

    $foundBin = $null
    try { $foundBin = Find-DshBin -DshBin $DshBin -DshHome $env:DSH_HOME } catch { $foundBin = $null }
    if ($foundBin) {
        $dshVersion = '（版本探测失败）'
        if ($foundNode) {
            try {
                $dshRun = Invoke-NativeCommand -FilePath $foundNode -ArgumentList @($foundBin, '--version') -TimeoutSec 60
                if ($dshRun.StdOut.Trim()) { $dshVersion = $dshRun.StdOut.Trim() }
            } catch { }
        }
        Write-Kv -Key 'dsh CLI' -Value "$foundBin   [$dshVersion]"
    } else {
        Write-Kv -Key 'dsh CLI' -Value '(未找到)'
        Write-Warn '未找到 dsh CLI（bin.js）。请确认已登录 DSH 桌面端，或用 -DshBin "<bin.js 绝对路径>" 指定。'
    }
} else {
    Write-Info '（-SkipProbe：跳过 DSH/node/CLI 探测）'
    $foundRoot = Find-DshRoot -DshRoot $DshRoot
    $foundNode = $null
    $foundBin = $null
    try { $foundNode = Find-NodeExe -Node $Node -DshRoot $foundRoot -DshHome $env:DSH_HOME } catch { }
    try { $foundBin = Find-DshBin -DshBin $DshBin -DshHome $env:DSH_HOME } catch { }
}

# ── DSH 启动器解析（契约 §8.2：旧版 bin.js 不支持 --json/--session-id）─────────
$launcherInfo = $null
try { $launcherInfo = Find-DshLauncher -Launcher $Launcher -DshRoot $foundRoot -Node $foundNode } catch { $launcherInfo = $null }
if ($launcherInfo -and $launcherInfo.Mode -eq 'desktop-host') {
    Write-Kv -Key 'DSH 启动器' -Value $launcherInfo.Launcher
    Write-Kv -Key 'Harness exe' -Value $launcherInfo.Exe
    Write-Kv -Key 'cli.js' -Value $launcherInfo.CliJs
} elseif ($launcherInfo -and $launcherInfo.Mode -eq 'legacy-node') {
    Write-Warn '只探测到旧版 CLI（bin.js）：它不支持 --json / --session-id，v2 续聊会失败（契约 §8.2）。'
    Write-Info "旧版路径：$($launcherInfo.LegacyBinPath)"
    Write-Info '修复：安装/定位 dsh.cmd，然后用 -Launcher "<...>\runtime\cli\bin\dsh.cmd" 重新运行本脚本。'
} else {
    Write-Warn '未探测到 DSH 启动器（dsh.cmd/dsh.exe）；v2 续聊需要在 config.json 里补 dsh.launcher（或用 -Launcher 指定）。'
}

Write-Section '2/6 创建运行目录'
$tasksDir = Join-Path $remoteHome 'tasks'
$logsDir = Join-Path $remoteHome 'logs'
foreach ($dir in @($remoteHome, $tasksDir, $logsDir)) {
    if (Test-Path -LiteralPath $dir -PathType Container) {
        Write-Info "已存在：$dir"
    } else {
        [void](New-Item -ItemType Directory -Force -Path $dir)
        Write-Ok "已创建：$dir"
    }
}

Write-Section '3/6 写入 API 凭据（UTF-8 无 BOM）'
$credPath = Join-Path $remoteHome '.credentials.yaml'
$credState = Test-CredentialFile -Path $credPath
$incomingKey = $null
$keySource = ''
if ($ApiKey) {
    $incomingKey = $ApiKey.Trim()
    $keySource = '-ApiKey 参数'
} elseif ($ApiKeyFile) {
    if (-not (Test-Path -LiteralPath $ApiKeyFile -PathType Leaf)) { throw "指定的 Key 文件不存在：$ApiKeyFile" }
    $incomingKey = Get-CredentialKeyFromFile -Path $ApiKeyFile
    if (-not $incomingKey) { throw "无法从 $ApiKeyFile 解析出 DEEPSEEK_API_KEY（期望单行 " + 'DEEPSEEK_API_KEY: <key>' + "）" }
    $keySource = "-ApiKeyFile $ApiKeyFile"
}
if ($incomingKey) {
    if ($incomingKey.Length -lt 8) { throw "API Key 过短（$($incomingKey.Length) 字符），疑似复制不完整。" }
    if ($incomingKey -match '\s') { throw 'API Key 含空白字符，疑似复制了多余内容（请只保留 sk-xxx 一段）。' }
}

if ($incomingKey) {
    if (Test-Path -LiteralPath $credPath -PathType Leaf) {
        $backup = Backup-ExistingFile -Path $credPath
        Write-Info "已备份旧凭据：$backup"
    }
    $result = Write-CredentialFile -Path $credPath -Key $incomingKey
    Write-Ok "凭据已写入并回读校验通过：$credPath"
    Write-Kv -Key '来源' -Value $keySource
    Write-Kv -Key '编码' -Value ("UTF-8 无 BOM（$($result.Bytes) 字节，回读一致）")
    Write-Kv -Key 'Key' -Value (Mask-Secret $incomingKey)
} elseif ($credState.Ok) {
    Write-Ok "凭据已存在且格式正确，保持不变：$credPath"
    Write-Kv -Key 'Key' -Value ((Mask-Secret $credState.Key) + '（来自已有文件）')
    Write-Info '如需更换 Key：重新运行并加 -ApiKey 或 -ApiKeyFile（旧文件会自动备份）。'
} else {
    if ($credState.Reasons.Count -gt 0) {
        Write-Warn ("已有凭据文件不合规：" + ($credState.Reasons -join '；'))
        Write-Info "文件：$credPath"
    } else {
        Write-Info "尚未配置凭据：$credPath"
    }
    $written = $false
    if (-not $NoInteractive -and [Environment]::UserInteractive) {
        try {
            Write-Host ''
            Write-Host '  请输入 DEEPSEEK_API_KEY（输入不回显；直接回车跳过）：' -ForegroundColor Cyan
            $secure = Read-Host -AsSecureString
            $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            try { $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
            finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
            if ($plain -and $plain.Trim()) {
                $plain = $plain.Trim()
                if (Test-Path -LiteralPath $credPath -PathType Leaf) {
                    $backup = Backup-ExistingFile -Path $credPath
                    Write-Info "已备份旧凭据：$backup"
                }
                $result = Write-CredentialFile -Path $credPath -Key $plain
                Write-Ok "凭据已写入并回读校验通过：$credPath"
                Write-Kv -Key 'Key' -Value (Mask-Secret $plain)
                $written = $true
            }
        } catch {
            Write-Warn "交互式输入失败：$($_.Exception.Message)"
        }
    }
    if (-not $written) {
        Write-Fail '凭据未配置（后续任务会因缺少 API Key 失败）。'
        Write-Info '请任选一种方式补上，然后重新运行本脚本：'
        Write-Info "  a) pwsh -File scripts/setup-pc.ps1 -ApiKey `"sk-你的Key`""
        Write-Info "  b) pwsh -File scripts/setup-pc.ps1 -ApiKeyFile <已有凭据文件路径>"
        Write-Info "  c) 手工新建 $credPath，内容一行：DEEPSEEK_API_KEY: <key>，保存为 UTF-8 无 BOM"
    }
}

Write-Section '4/6 生成 config.json'
$configPath = Join-Path $remoteHome 'config.json'
$existingConfig = Get-ConfigDefaults -Home $remoteHome
$configParams = @('Port', 'BindHost', 'MaxConcurrent', 'MaxQueue', 'TimeoutSec', 'MaxTimeoutSec', 'Workspace', 'ServerName', 'Node', 'DshBin', 'DshRoot', 'Launcher')
$boundConfigParams = @($configParams | Where-Object { $PSBoundParameters.ContainsKey($_) })
$effectivePort = $script:DefaultPort
if ($Port -gt 0) { $effectivePort = $Port }
elseif ($existingConfig) {
    $existingPort = Get-JsonProp -Object $existingConfig -Name 'port'
    if ($existingPort) { $effectivePort = [int]$existingPort }
}

$existingAllowlist = @()
if ($existingConfig) {
    $rawList = Get-JsonProp -Object $existingConfig -Name 'workspaceAllowlist'
    if ($rawList) { $existingAllowlist = @($rawList | ForEach-Object { [string]$_ }) }
}

$workspaces = @()
if ($Workspace -and $Workspace.Count -gt 0) {
    $workspaces = @($Workspace | ForEach-Object { [System.IO.Path]::GetFullPath($_) })
} elseif ($existingAllowlist.Count -gt 0) {
    $workspaces = $existingAllowlist
} else {
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if (-not $userProfile) { $userProfile = $env:USERPROFILE }
    $workspaces = @(Join-Path $userProfile 'dsh-workspace')
}
foreach ($ws in $workspaces) {
    if (-not (Test-Path -LiteralPath $ws -PathType Container)) {
        [void](New-Item -ItemType Directory -Force -Path $ws)
        Write-Ok "已创建工作区：$ws"
    } else {
        Write-Info "工作区已存在：$ws"
    }
}

$effectiveServerName = $ServerName
if (-not $effectiveServerName) {
    $effectiveServerName = Get-JsonProp -Object $existingConfig -Name 'serverName'
}
if (-not $effectiveServerName) { $effectiveServerName = $env:COMPUTERNAME }

$shouldWriteConfig = $true
$configReason = '首次生成'
if ($existingConfig -and -not $Force -and $boundConfigParams.Count -eq 0) {
    $shouldWriteConfig = $false
    $configReason = '已存在且本次未显式传配置参数，保持不变（如需重写：加 -Force）'
} elseif ($existingConfig) {
    if ($Force) { $configReason = '按 -Force 重写' }
    else { $configReason = '按显式参数重写（' + ($boundConfigParams -join '/') + '）' }
}

if ($shouldWriteConfig) {
    $configObject = [ordered]@{
        _readme               = @(
            'dsh-remote 网关配置（由 scripts/setup-pc.ps1 生成，可手工修改后重启网关生效）。',
            '本文件不含任何密钥：API Key 只放在同目录的 .credentials.yaml（单行 UTF-8 无 BOM）。',
            'workspaceAllowlist 为空表示拒绝所有任务（默认拒绝，避免误开放整盘）。'
        )
        host                  = $BindHost
        port                  = $effectivePort
        dshHome               = $remoteHome
        serverName            = $effectiveServerName
        gatewayVersion        = '1.0.0'
        authRequired          = $true
        maxConcurrent         = $MaxConcurrent
        maxQueue              = $MaxQueue
        defaultTimeoutSec     = $TimeoutSec
        maxTimeoutSec         = $MaxTimeoutSec
        workspaceAllowlist    = @($workspaces)
        defaultWorkspace      = $workspaces[0]
        # 电脑端通道（审批/提问，契约 §7.7）。**缺省即启用**，只有 enabled=false 才关闭；
        # 这里显式写全是为了：①dshHome 指到真实桌面端 home（凭据 client-connection/browser-session
        # 就在那里），避免指成网关自己的 home 后只能得到一句「找不到电脑端凭据」；
        # ②把"审批从哪来"写进配置，排查时不必再猜默认值。
        desktop               = [ordered]@{
            enabled = $true
            host    = '127.0.0.1'
            port    = 19387
            dshHome = $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.dsh' } else { $null })
        }
        dsh                   = [ordered]@{
            # v2（契约 §7.2/§8.2）：续聊必须用 desktop-host 启动器形状，而不是旧版 bin.js
            launcher          = $(if ($launcherInfo) { $launcherInfo.Launcher } else { $null })
            exe               = $(if ($launcherInfo) { $launcherInfo.Exe } else { $null })
            cliJs             = $(if ($launcherInfo) { $launcherInfo.CliJs } else { $null })
            env               = $(if ($launcherInfo -and $launcherInfo.Env) { $launcherInfo.Env } else { @{} })
            # v1 兼容键：保持原行为（网关 v2 会优先用 launcher/exe/cliJs）
            node              = $foundNode
            binPath           = $foundBin
            profile           = 'headless'
            version           = '0.1.0-rc.7'
            discoverSessionId = $true
            launcherArgs      = @()
        }
        tasks                 = [ordered]@{ dirName = 'tasks' }
        log                   = [ordered]@{ dirName = 'logs'; filePrefix = 'gateway'; toConsole = $true }
        # 键名与 tools/dsh-remote/config.example.json 保持同构（缺键虽然会被网关默认值补齐，
        # 但保持同构能让用户对照模板理解每一项）
        limits                = [ordered]@{
            maxBodyBytes        = 1048576
            maxOutputBytes      = 1048576
            pairClaimPerMinute  = 10
            authFailPerMinute   = 30
            pairCodeTtlMs       = 300000
            maxSseClients       = 16
            requestTimeoutMs    = 30000
            headersTimeoutMs    = 20000
            outputFlushMs       = 200
            outputFlushBytes    = 8192
        }
        events                = [ordered]@{ bufferSize = 2000; heartbeatMs = 15000 }
    }
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $backup = Backup-ExistingFile -Path $configPath
        Write-Info "已备份旧配置：$backup"
    }
    Write-JsonFileNoBom -Path $configPath -Object $configObject
    # 回读校验：JSON 必须可解析，关键字段必须一致
    $reloaded = Read-JsonFile -Path $configPath
    $reloadPort = Get-JsonProp -Object $reloaded -Name 'port'
    if ([int]$reloadPort -ne $effectivePort) { throw "config.json 回读校验失败：port 期望 $effectivePort，实际 $reloadPort" }
    $reloadHome = [string](Get-JsonProp -Object $reloaded -Name 'dshHome')
    if ($reloadHome -ne $remoteHome) { throw "config.json 回读校验失败：dshHome 期望 $remoteHome，实际 $reloadHome" }
    Write-Ok "config.json 已生成并通过回读校验：$configPath（$configReason）"
} else {
    Write-Ok "config.json 保持原样：$configPath"
    Write-Info $configReason
}

$finalConfig = Read-JsonFile -Path $configPath
Write-Kv -Key 'port' -Value ([string](Get-JsonProp -Object $finalConfig -Name 'port'))
Write-Kv -Key 'dshHome' -Value ([string](Get-JsonProp -Object $finalConfig -Name 'dshHome'))
Write-Kv -Key '并发/队列' -Value ("$([string](Get-JsonProp -Object $finalConfig -Name 'maxConcurrent')) / $([string](Get-JsonProp -Object $finalConfig -Name 'maxQueue'))")
Write-Kv -Key '默认超时' -Value ("$([string](Get-JsonProp -Object $finalConfig -Name 'defaultTimeoutSec')) 秒")
Write-Kv -Key '工作区白名单' -Value ((@(Get-JsonProp -Object $finalConfig -Name 'workspaceAllowlist') | ForEach-Object { [string]$_ }) -join ' | ')

Write-Section '5/6 一致性检查'
$failCount = 0
if ($gatewayEntry) { Write-Ok '网关源码就绪（tools/dsh-remote/gateway.mjs）' } else { Write-Fail '网关源码缺失：请先完成 task-1'; $failCount++ }
if ($foundNode) { Write-Ok "node.exe 可用：$foundNode" } else { Write-Fail 'node.exe 不可用'; $failCount++ }
if ($foundBin) { Write-Ok "dsh CLI 就绪：$foundBin" } else { Write-Fail 'dsh CLI 缺失'; $failCount++ }
if ($launcherInfo -and $launcherInfo.Mode -eq 'desktop-host') {
    Write-Ok "DSH 启动器就绪（desktop-host）：$($launcherInfo.Launcher)"
} elseif (Test-LegacyDshBinPath -Path $foundBin) {
    Write-Warn 'dsh.binPath 指向旧版 CLI：v1 任务可用，但 v2 续聊需要 dsh.launcher（见契约 §8.2）。'
    Write-Info '修复：powershell -File scripts/setup-pc.ps1 -Launcher "<DSH 安装>\resources\runtime\cli\bin\dsh.cmd"'
}
$credFinal = Test-CredentialFile -Path $credPath
if ($credFinal.Ok) { Write-Ok '凭据文件合规（单行 / UTF-8 无 BOM / 可解析）' } else { Write-Fail ('凭据文件不合规：' + ($credFinal.Reasons -join '；')); $failCount++ }
if (Test-Path -LiteralPath $configPath -PathType Leaf) { Write-Ok 'config.json 存在且可解析' } else { Write-Fail 'config.json 缺失'; $failCount++ }

Write-Section '6/6 完成'
$psHint = 'pwsh'
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) { $psHint = 'powershell' }
$homeArg = ''
if ($DshRemoteHome) { $homeArg = " -Home `"$remoteHome`"" }
Write-Host ("  运行目录：$remoteHome") -ForegroundColor White
if ($failCount -eq 0) {
    Write-Ok '初始化完成：全部检查通过（0 项失败）。'
    Write-NextStep -Steps @(
        "$psHint -File scripts/start-gateway.ps1$homeArg",
        "$psHint -File scripts/pair.ps1$homeArg",
        "$psHint -File scripts/selftest.ps1$homeArg",
        "$psHint -File scripts/install-autostart.ps1$homeArg    # 可选：开机自启"
    )
    exit 0
} else {
    Write-Fail "初始化完成，但有 $failCount 项未通过，请先按上面的提示修复。"
    exit 1
}
